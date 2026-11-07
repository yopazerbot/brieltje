"""Build the weapons for Action and Paintball in Blender: pistol, rifle, shotgun, sniper rifle and
bazooka, with the gloved hands and sleeves that hold them in first person.

Run (Blender 5, no window):
  blender -b -P tools/weapons.py -- <out.glb> [preview_dir]

Our own generic designs at believable real sizes, no brand, maker or marking on any of them:
a polymer-framed pistol (19 cm), a carbine with a free-float handguard (93 cm), a pump shotgun
with a wooden stock and fore-end (1.0 m), a bolt-action rifle with a scope (1.13 m) and an
olive tube launcher (1.4 m). Bevelled edges, a few materials (steel, polymer, wood, rubber,
glass, olive paint), no textures. Each weapon is a few thousand triangles.

Frame of each weapon in the GLB: the barrel along -z, up +y, right +x, metres, the origin where
the web of the right hand sits on the grip. Nodes per weapon `w`:
  w                 the weapon (an empty at the origin)
    w_body          the parts that never move
    w_mag, w_slide, w_pump, w_bolt, w_rocket   the parts that move (those it has);
                    extras "out": the way the magazine leaves the gun (unit, the GLB's frame);
                    "knob": the bolt handle's knob from the bolt's pivot
    w_muzzle        where the shot leaves (the flash goes here)
    w_sight         a point on the line of sight (the iron sights' top, the scope's axis)
    w_kit           Paintball's hopper and air tank (the game shows them in Paintball only)
    w_hands         first person only:
      w_handR, w_handL   glove, cuff and sleeve; each origin at its wrist (a pivot);
                         extras "grip": where it holds, from the wrist
        shotgun_shell    (in the left hand: the shell it loads)
Inside Blender the barrel runs along +y and up is +z; the exporter turns that into the above.
With preview_dir it also renders a small picture of each weapon there.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

bpy.ops.wm.read_factory_settings(use_empty=True)


def srgb(h):
    """'#rrggbb' to linear RGB, as the Principled BSDF (and glTF) expect."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def material(name, color, rough=0.5, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*srgb(color), 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    m.use_backface_culling = True
    return m


# The game finds the materials by these names (weapon.ts): their finish, and their colour in Paintball.
M = {
    "Steel": material("Steel", "#3c3e42", 0.4, 0.75),       # blued and nitrided steel: slides, barrels, bolts
    "Polymer": material("Polymer", "#232426", 0.6, 0.0),   # frames, stocks, handguards
    "Grip": material("Grip", "#202123", 0.85, 0.0),         # textured grip panels, rubber pads
    "Dark": material("Dark", "#151617", 0.55, 0.2),         # magazines, bores, ports, sight bases
    "Wood": material("Wood", "#7a4a2b", 0.5, 0.0),          # the shotgun's walnut
    "Olive": material("Olive", "#4c5236", 0.6, 0.15),       # the launcher's painted tube
    "Brass": material("Brass", "#b08a3e", 0.3, 0.9),        # the shotgun's bead and shells
    "Dot": material("Dot", "#e8e4d0", 0.4, 0.0),            # the sights' white dots
    "Glass": material("Glass", "#1d3a4c", 0.05, 0.6),       # the scope's lenses
    "Warhead": material("Warhead", "#3f4630", 0.5, 0.2),    # the rocket's nose
    "Glove": material("Glove", "#26272a", 0.82, 0.0),
    "GloveTrim": material("GloveTrim", "#3a3c40", 0.6, 0.0),  # knuckle guard, cuff strap
    "Sleeve": material("Sleeve", "#4b4c3b", 0.9, 0.0),      # recoloured in the game to the player's suit
    "Hopper": material("Hopper", "#2f8cff", 0.15, 0.0),     # Paintball's kit: coloured per gun in the game
    "KitTrim": material("KitTrim", "#ffd23f", 0.4, 0.0),
    "Tank": material("Tank", "#dfe3e8", 0.3, 0.5),
}

scene = bpy.context.scene


def link(obj):
    scene.collection.objects.link(obj)
    return obj


def mesh_obj(name, bm, mats, smooth=False):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    return link(bpy.data.objects.new(name, me))


def apply_mod(obj, kind, **props):
    mod = obj.modifiers.new(kind.lower(), kind)
    for k, v in props.items():
        setattr(mod, k, v)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)


def bevel(obj, width, segments=1, angle=35):
    if width > 0:
        apply_mod(obj, "BEVEL", width=width, segments=segments, limit_method="ANGLE", angle_limit=math.radians(angle))
    return obj


# ---- Shapes ----------------------------------------------------------------------------------

def prism(name, pts, half, mat, bev=0.0012, seg=1, x=0.0):
    """A side profile (points (y, z), either winding) pushed out sideways: `half` the half-width,
    a number or a function of y (stocks get wider towards the butt). Centred on `x`."""
    hw = half if callable(half) else (lambda y, h=half: h)
    bm = bmesh.new()
    left = [bm.verts.new((x - hw(y), y, z)) for y, z in pts]
    right = [bm.verts.new((x + hw(y), y, z)) for y, z in pts]
    bm.faces.new(left)
    bm.faces.new(list(reversed(right)))
    n = len(pts)
    for i in range(n):
        bm.faces.new((left[i], left[(i + 1) % n], right[(i + 1) % n], right[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bevel(mesh_obj(name, bm, [mat]), bev, seg)


def block(name, x0, x1, y0, y1, z0, z1, mat, bev=0.0008, seg=1):
    return prism(name, [(y0, z0), (y1, z0), (y1, z1), (y0, z1)], (x1 - x0) / 2, mat, bev, seg, x=(x0 + x1) / 2)


def lathe(name, prof, mat, sides=16, at=(0.0, 0.0, 0.0), axis="y", squash=1.0, turn=0.0, caps=(True, True), smooth=True, inside=False):
    """Turn a profile [(t, r), ...] round an axis through `at`: 'y' along the barrel, 'z' upright.
    `squash` flattens it (z for 'y', y for 'z'); `turn` rotates the ring (radians, for flats).
    `inside`: an open tube seen from within (t rising along the axis; its faces turn inwards)."""
    bm = bmesh.new()
    rings = []
    for t, r in prof:
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides + turn
            u, v = r * math.cos(a), r * math.sin(a) * squash
            if axis == "y":
                ring.append(bm.verts.new((at[0] + u, at[1] + t, at[2] + v)))
            else:
                ring.append(bm.verts.new((at[0] + u, at[1] + v, at[2] + t)))
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for k in range(sides):
            bm.faces.new((a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k]))
    if caps[0] and prof[0][1] > 0:
        bm.faces.new(list(reversed(rings[0])))
    if caps[1] and prof[-1][1] > 0:
        bm.faces.new(rings[-1])
    if not inside:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = mesh_obj(name, bm, [mat], smooth)
    return obj


def disc(name, r, mat, at, facing, sides=16):
    """A flat round face (a lens, a bore) at `at`, facing along +y (1) or -y (-1)."""
    bm = bmesh.new()
    vs = [bm.verts.new((at[0] + r * math.cos(2 * math.pi * k / sides), at[1], at[2] + r * math.sin(2 * math.pi * k / sides))) for k in range(sides)]
    f = bm.faces.new(vs)
    f.normal_update()
    if (f.normal.y > 0) != (facing > 0):
        f.normal_flip()
    return mesh_obj(name, bm, [mat])


def sweep(name, pts, radii, mat, sides=8, tip=True, base=True):
    """A tube along a centre line with a radius per point and a rounded tip: fingers, sleeves."""
    pts = [Vector(p) for p in pts]
    n = len(pts)
    tang = []
    for i in range(n):
        a, b = pts[max(0, i - 1)], pts[min(n - 1, i + 1)]
        tang.append((b - a).normalized())
    # A frame carried along the line without twisting.
    up = Vector((0, 0, 1)) if abs(tang[0].z) < 0.9 else Vector((1, 0, 0))
    normal = tang[0].cross(up).normalized()
    frames = []
    for i in range(n):
        if i:
            axis = tang[i - 1].cross(tang[i])
            if axis.length > 1e-6:
                ang = tang[i - 1].angle(tang[i])
                normal = (Matrix.Rotation(ang, 3, axis.normalized()) @ normal).normalized()
        frames.append((normal.copy(), tang[i].cross(normal).normalized()))
    bm = bmesh.new()

    def ring(c, r, f):
        nrm, bi = f
        return [bm.verts.new(c + (nrm * math.cos(2 * math.pi * k / sides) + bi * math.sin(2 * math.pi * k / sides)) * r) for k in range(sides)]

    rings = [ring(p, r, f) for p, r, f in zip(pts, radii, frames)]
    if tip:  # a rounded end: two shrinking rings and a pole
        end, t, r = pts[-1], tang[-1], radii[-1]
        for k in (1, 2):
            a = k * math.pi / 6
            rings.append(ring(end + t * r * math.sin(a), r * math.cos(a), frames[-1]))
        pole = bm.verts.new(end + t * r)
    for a, b in zip(rings, rings[1:]):
        for k in range(sides):
            bm.faces.new((a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k]))
    if tip:
        last = rings[-1]
        for k in range(sides):
            bm.faces.new((last[k], last[(k + 1) % sides], pole))
    else:
        bm.faces.new(rings[-1])
    if base:
        bm.faces.new(list(reversed(rings[0])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_obj(name, bm, [mat], smooth=True)


def hull(name, pts, mat, smooth=True, round_=False):
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in pts]
    res = bmesh.ops.convex_hull(bm, input=vs)
    loose = {v for v in res["geom_interior"] + res["geom_unused"] if isinstance(v, bmesh.types.BMVert)}
    bmesh.ops.delete(bm, geom=list(loose), context="VERTS")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = mesh_obj(name, bm, [mat], smooth)
    if round_:  # soften a hand's hull: one level of subdivision, its triangles merged into quads first
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.join_triangles(bm, faces=bm.faces, angle_face_threshold=math.radians(40), angle_shape_threshold=math.radians(60))
        bm.to_mesh(obj.data)
        bm.free()
        apply_mod(obj, "SUBSURF", levels=1, render_levels=1)
        for p in obj.data.polygons:
            p.use_smooth = True
    return obj


def join(name, objs):
    objs = [o for o in objs if o]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = objs[0]
    o.name = o.data.name = name
    o.select_set(False)
    return o


def sharpen(obj, angle=32):
    obj.data.set_sharp_from_angle(angle=math.radians(angle))
    return obj


def pivot(obj, at):
    """Put the object's origin at `at` (world), the mesh staying where it is."""
    at = Vector(at)
    obj.data.transform(Matrix.Translation(-at))
    obj.location = at
    return obj


def empty(name, at):
    e = bpy.data.objects.new(name, None)
    e.location = Vector(at)
    e.empty_display_size = 0.01
    return link(e)


def gl(v):
    """A direction from Blender's frame to the GLB's (y up, barrel along -z)."""
    return [round(v[0], 4), round(v[2], 4), round(-v[1], 4)]


# ---- Hands -------------------------------------------------------------------------------------

class Wrap:
    """An elliptic cylinder round a grip or a handguard: its axis from C along A, and E1, E2 across
    it (r1, r2 the half sizes). Angle 0 is along E1, 90 degrees along E2."""

    def __init__(self, C, A, E1, r1, r2):
        self.C, self.A = Vector(C), Vector(A).normalized()
        self.E1 = (Vector(E1) - self.A * Vector(E1).dot(self.A)).normalized()
        self.E2 = self.A.cross(self.E1).normalized()
        self.r1, self.r2 = r1, r2

    def at(self, t, deg, extra=0.0):
        a = math.radians(deg)
        return self.C + self.A * t + self.E1 * (math.cos(a) * (self.r1 + extra)) + self.E2 * (math.sin(a) * (self.r2 + extra))

    def curl(self, t, deg0, step, length, extra, slope=0.0):
        """Points every ~9 mm round the wrap from deg0 (step: +1 or -1 degree) for `length` metres;
        `slope` moves the line along the axis per metre (fingers don't wrap quite square)."""
        out = [self.at(t, deg0, extra)]
        run, deg, last = 0.0, deg0, out[0]
        while run < length:
            deg += step
            p = self.at(t + slope * run, deg, extra)
            run += (p - last).length
            if (p - out[-1]).length >= 0.009 or run >= length:
                out.append(p)
            last = p
        return out


def finger(name, line, r):
    """A gloved finger along `line` (knuckle first): a little thicker at the knuckle."""
    n = len(line)
    radii = [r * (1.08 - 0.16 * i / max(1, n - 1)) for i in range(n)]
    return sweep(name, line, radii, M["Glove"], sides=8)


def arm(name, wrist, direction, length, side):
    """The cuff of the glove and the sleeve from the wrist back along the forearm (past the view)."""
    d = Vector(direction).normalized()
    w = Vector(wrist)
    cuff = sweep(name + "Cuff", [w - d * 0.012, w + d * 0.02, w + d * 0.05], [0.026, 0.03, 0.031], M["GloveTrim"], sides=12, tip=False)
    # The sleeve: a rolled edge, then the forearm widening towards the elbow, bending a little.
    bend = Vector((side * 0.02, 0, -0.03))
    pts = [w + d * 0.035, w + d * 0.05, w + d * 0.065]
    rad = [0.034, 0.038, 0.036]
    for k in range(1, 6):
        s = k / 5
        pts.append(w + d * (0.065 + (length - 0.065) * s) + bend * s * s)
        rad.append(0.036 + 0.012 * s)
    sleeve = sweep(name + "Sleeve", pts, rad, M["Sleeve"], sides=10, tip=False)
    return [cuff, sleeve]


def hand(name, wrap, fingers, palm, wrist, fore, thumb, index=None, knuckle=True, side=1):
    """A gloved hand round `wrap`. fingers: (t, deg0, step, length, radius, slope) per finger;
    palm: points of the palm and back of the hand (the hull also takes the finger roots and the
    wrist); thumb and index: centre lines with a radius; fore: the forearm's way and length."""
    parts = []
    roots = []
    for i, (t, deg0, step, length, r, slope) in enumerate(fingers):
        line = wrap.curl(t, deg0, step, length, r * 0.95, slope)
        parts.append(finger(f"{name}F{i}", line, r))
        roots.append(line[0])
    if index:
        parts.append(finger(f"{name}Index", index[0], index[1]))
        roots.append(Vector(index[0][0]))
    parts.append(finger(f"{name}Thumb", thumb[0], thumb[1]))
    w = Vector(wrist)
    d = Vector(fore[0]).normalized()
    # The wrist: a flattened ring across the forearm.
    u = d.cross(Vector((0, 0, 1)))
    if u.length < 0.1:
        u = d.cross(Vector((1, 0, 0)))
    u.normalize()
    v = d.cross(u).normalized()
    ring = [w + u * (0.03 * math.cos(a)) + v * (0.022 * math.sin(a)) for a in [k * math.pi / 5 for k in range(10)]]
    pts = [Vector(p) for p in palm] + roots + ring + [Vector(thumb[0][0])]
    parts.append(hull(name + "Palm", pts, M["Glove"], round_=True))
    if knuckle:
        # A padded guard over the knuckles, as tactical gloves have.
        k0, k1 = roots[0], roots[-1]
        mid = (k0 + k1) / 2
        out = (mid - w).normalized()
        back = (mid - (wrap.C + wrap.A * (wrap.A.dot(mid - wrap.C)))).normalized()
        g = [p + back * 0.012 - out * s for p in (k0, k1) for s in (0.006, 0.022)]
        g += [p + back * 0.005 - out * s for p in (k0, k1) for s in (0.004, 0.026)]
        parts.append(hull(name + "Guard", g, M["GloveTrim"]))
    parts += arm(name, wrist, d, fore[1], side)
    obj = join(name, parts)
    for p in obj.data.polygons:
        p.use_smooth = True
    # Where it holds (the middle of what the fingers wrap), from the wrist: the game moves a hand by it.
    mid_t = sum(f[0] for f in fingers) / len(fingers)
    obj["grip"] = gl(wrap.C + wrap.A * mid_t - w)
    return pivot(obj, wrist)


# ---- The weapons ---------------------------------------------------------------------------------
# Each is drawn in its own design frame, then moved so the grip point is at the origin.

def finish(w, grip, body, moving, muzzle, sight, kit, hands, extras=None):
    """Join and name a weapon's parts, move it so `grip` is the origin, and hang it under an empty."""
    g = Vector(grip)
    body = sharpen(join(w + "_body", body))
    objs = [body]
    for key, parts in moving.items():
        o = sharpen(join(f"{w}_{key}", parts[0]))
        pivot(o, parts[1])
        for k, v in (parts[2] if len(parts) > 2 else {}).items():
            o[k] = gl(Vector(v) - Vector(parts[1])) if k == "knob" else gl(Vector(v).normalized())
        objs.append(o)
    objs.append(empty(w + "_muzzle", muzzle))
    objs.append(empty(w + "_sight", sight))
    if kit:
        k = join(w + "_kit", kit)
        for p in k.data.polygons:
            p.use_smooth = True
        objs.append(k)
    for o in objs:
        o.location -= g
    hand_root = empty(w + "_hands", (0, 0, 0))
    objs.append(hand_root)
    for h in hands:
        h.location -= g
        h.parent = hand_root
    root = empty(w, (0, 0, 0))
    for o in objs:
        o.parent = root
    if extras:
        for k, v in extras.items():
            root[k] = v
    tris = 0
    for o in [*objs, *hands]:
        if o.type == "MESH":
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)
    gun_tris = sum(len(o.data.loop_triangles) for o in objs if o.type == "MESH" and not o.name.endswith("_kit"))
    print(f"{w}: gun {gun_tris} triangles, with kit and hands {tris}")
    return root


def trigger_guard(name, y0, y1, ztop, zbot, half, t=0.004):
    pts = [(y0 - 0.006, ztop - 0.012), (y0, zbot + 0.004), (y0 + 0.006, zbot), (y1 - 0.006, zbot), (y1, zbot + 0.006), (y1, ztop),
           (y1 - t, ztop), (y1 - t, zbot + t + 0.003), (y1 - t - 0.004, zbot + t), (y0 + 0.007, zbot + t), (y0 + t, zbot + t + 0.004), (y0 - 0.006 + t, ztop - 0.012)]
    return prism(name, pts, half, M["Polymer"], 0.0008)


def trigger(name, y, ztop, zbot, mat="Steel"):
    pts = [(y + 0.004, ztop), (y + 0.007, (ztop + zbot) / 2), (y + 0.004, zbot), (y, zbot), (y + 0.003, (ztop + zbot) / 2), (y, ztop)]
    return prism(name, pts, 0.003, M[mat], 0.0005)


def build_pistol():
    W = "pistol"
    body = []
    # The frame: dust cover, the grip (18 degrees back) with textured panels, the trigger guard.
    body.append(prism("frame", [(-0.034, 0.009), (0.146, 0.009), (0.146, -0.001), (0.13, -0.006), (0.07, -0.008), (0.024, -0.008),
                                (0.008, -0.004), (-0.012, 0.0), (-0.034, 0.004)], 0.0122, M["Polymer"], 0.0015))
    grip = [(0.0245, -0.004), (0.020, -0.030), (0.0165, -0.052), (0.012, -0.076), (0.008, -0.098), (-0.041, -0.098), (-0.037, -0.07),
            (-0.031, -0.04), (-0.026, -0.016), (-0.029, -0.004), (-0.04, 0.004), (-0.036, 0.008), (-0.016, 0.008)]
    body.append(prism("grip", grip, 0.0142, M["Polymer"], 0.003, 2))
    panel = [(0.017, -0.022), (0.009, -0.085), (-0.032, -0.085), (-0.025, -0.022)]
    body.append(prism("panel", panel, 0.0148, M["Grip"], 0.0006))
    body.append(trigger_guard("guard", 0.022, 0.074, -0.004, -0.033, 0.0075))
    body.append(trigger("trigger", 0.040, -0.006, -0.024))
    body.append(block("rail", -0.008, 0.008, 0.10, 0.14, -0.009, -0.004, M["Polymer"], 0.0006))
    # Barrel crown and bore, inside the slide's nose.
    body.append(lathe("crown", [(0.1495, 0.0062), (0.152, 0.0062)], M["Steel"], 12, at=(0, 0, 0.024), caps=(False, False)))
    body.append(disc("bore", 0.0046, M["Dark"], (0, 0.1515, 0.024), 1, 12))
    # The slide (it moves): rounded top edges, rear serrations, the port, the sights with white dots.
    slide = [prism("slide", [(-0.035, 0.009), (0.150, 0.009), (0.150, 0.033), (0.146, 0.0395), (-0.031, 0.0395), (-0.035, 0.035)],
                   0.0122, M["Steel"], 0.0025, 2)]
    for k in range(6):
        y = -0.028 + k * 0.0045
        for s in (-1, 1):
            slide.append(block("ser", s * 0.0122 - 0.0006, s * 0.0122 + 0.0006, y, y + 0.0016, 0.012, 0.036, M["Steel"], 0))
    slide.append(block("port", 0.001, 0.0124, 0.030, 0.066, 0.034, 0.0398, M["Dark"], 0.0004))
    slide.append(block("hood", 0.001, 0.0118, 0.031, 0.065, 0.035, 0.0402, M["Steel"], 0.0004))
    for s in (-1, 1):
        slide.append(block("rear", s * 0.0105, s * 0.0028, -0.029, -0.019, 0.0395, 0.047, M["Dark"], 0.0005))
        slide.append(block("rdot", s * 0.0068 - 0.0012, s * 0.0068 + 0.0012, -0.0186, -0.0184, 0.0425, 0.0447, M["Dot"], 0))
    slide.append(block("front", -0.0016, 0.0016, 0.134, 0.143, 0.0395, 0.0472, M["Dark"], 0.0004))
    slide.append(block("fdot", -0.0011, 0.0011, 0.1338, 0.1340, 0.0428, 0.0452, M["Dot"], 0))
    # The magazine: steel body inside the grip, its polymer base plate below it.
    mag = [prism("magbody", [(0.012, -0.004), (0.0, -0.099), (-0.034, -0.099), (-0.022, -0.004)], 0.0105, M["Steel"], 0.001),
           prism("magbase", [(0.0095, -0.097), (0.009, -0.106), (-0.041, -0.106), (-0.038, -0.097)], 0.0135, M["Dark"], 0.0015)]
    ax = Vector((0, -0.017, -0.095)).normalized()
    # Paintball: a small air cartridge under the dust cover.
    kit = [lathe("tank", [(0.06, 0), (0.062, 0.006), (0.066, 0.0095), (0.072, 0.0105), (0.135, 0.0105), (0.141, 0.009), (0.145, 0.0)],
                 M["Tank"], 14, at=(0, 0, -0.022)),
           lathe("ring", [(0.07, 0.0115), (0.077, 0.0115)], M["KitTrim"], 14, at=(0, 0, -0.022))]
    # Hands: the right round the grip, the index finger on the trigger, the thumb along the frame;
    # the left cups the right from the left side, its thumb forward under the right one.
    gw = Wrap((0, -0.0005, -0.006), (0, -0.017, -0.092), (0, 1, 0), 0.0245, 0.0148)
    right = hand("pistol_handR", gw,
                 [(0.034, 70, -1, 0.092, 0.0098, 0.0), (0.054, 72, -1, 0.087, 0.0094, 0.0), (0.073, 76, -1, 0.07, 0.0086, 0.0)],
                 [gw.at(0.022, 95, 0.004), gw.at(0.085, 100, 0.004), gw.at(0.022, 150, 0.004), gw.at(0.085, 150, 0.006),
                  gw.at(0.02, 200, 0.002), gw.at(0.07, 185, 0.004), gw.at(0.03, 95, 0.026), gw.at(0.07, 100, 0.026)],
                 (0.012, -0.075, -0.042), ((0.22, -1, -0.42), 0.36),
                 ([(-0.006, -0.026, -0.0), (-0.021, -0.008, 0.0015), (-0.0255, 0.016, 0.003), (-0.025, 0.040, 0.0035), (-0.023, 0.058, 0.004)], 0.0105),
                 ([gw.at(0.012, 72, 0.01), (0.021, 0.028, -0.011), (0.017, 0.044, -0.015), (0.009, 0.0475, -0.019), (0.004, 0.045, -0.022)], 0.0095))
    lw = Wrap((0, -0.0005, -0.006), (0, -0.017, -0.092), (0, 1, 0), 0.0245 + 0.016, 0.0148 + 0.017)
    left = hand("pistol_handL", lw,
                [(0.036, -95, 1, 0.105, 0.0098, 0.0), (0.054, -98, 1, 0.1, 0.0096, 0.0), (0.071, -100, 1, 0.09, 0.009, 0.0), (0.087, -102, 1, 0.07, 0.0084, 0.0)],
                [lw.at(0.03, -100, 0.0), lw.at(0.09, -105, 0.0), lw.at(0.03, -150, 0.0), lw.at(0.09, -150, 0.0),
                 lw.at(0.035, -110, 0.024), lw.at(0.085, -115, 0.024), (-0.05, -0.05, -0.02)],
                (-0.045, -0.072, -0.068), ((-0.45, -1, -0.5), 0.36),
                ([(-0.045, -0.02, -0.035), (-0.036, 0.0, -0.02), (-0.031, 0.022, -0.017), (-0.029, 0.045, -0.016), (-0.028, 0.062, -0.016)], 0.0108),
                side=-1)
    return finish(W, (0, -0.023, -0.004), body,
                  {"slide": (slide, (0, 0.06, 0.024)), "mag": (mag, (0, -0.012, -0.004), {"out": ax})},
                  (0, 0.152, 0.024), (0, 0.139, 0.047), kit, [right, left])


def rail(name, y0, y1, z, half=0.0105):
    """A Picatinny-style rail on top: a base and its cross ridges."""
    parts = [block(name, -half, half, y0, y1, z, z + 0.004, M["Dark"], 0.0005)]
    y = y0 + 0.003
    while y + 0.005 < y1:
        parts.append(block(name, -half, half, y, y + 0.0052, z + 0.004, z + 0.0075, M["Dark"], 0))
        y += 0.010
    return parts


def build_rifle():
    W = "rifle"
    B = 0.048  # the bore's height
    body = []
    # Upper receiver, with the port on the right; lower receiver with the magazine well.
    body.append(prism("upper", [(-0.10, 0.028), (0.165, 0.028), (0.165, 0.072), (-0.098, 0.072), (-0.10, 0.068)], 0.0135, M["Polymer"], 0.0025, 2))
    body.append(block("port", 0.012, 0.0142, 0.0, 0.06, 0.04, 0.058, M["Dark"], 0.0005))
    body.append(prism("lower", [(-0.095, 0.03), (0.135, 0.03), (0.135, 0.018), (0.103, 0.0), (0.103, -0.035), (0.098, -0.042),
                                (0.034, -0.042), (0.03, -0.035), (0.03, 0.0), (-0.004, 0.0), (-0.06, 0.004), (-0.095, 0.012)], 0.0128, M["Polymer"], 0.0025, 2))
    body.append(trigger_guard("guard", -0.004, 0.03, 0.002, -0.026, 0.006))
    body.append(trigger("trigger", 0.012, 0.0, -0.016))
    grip = [(-0.004, 0.002), (-0.012, -0.03), (-0.022, -0.065), (-0.03, -0.105), (-0.07, -0.108), (-0.068, -0.08), (-0.058, -0.04),
            (-0.048, -0.008), (-0.05, 0.004)]
    body.append(prism("grip", grip, 0.0145, M["Polymer"], 0.003, 2))
    body.append(prism("panel", [(-0.012, -0.02), (-0.025, -0.095), (-0.063, -0.097), (-0.052, -0.02)], 0.015, M["Grip"], 0.0006))
    # Buffer tube and a sliding stock with a rubber pad.
    body.append(lathe("tube", [(-0.10, 0.0145), (-0.30, 0.0145)], M["Dark"], 14, at=(0, 0, 0.046)))
    body.append(prism("stock", [(-0.205, 0.066), (-0.335, 0.07), (-0.36, 0.071), (-0.362, -0.074), (-0.35, -0.082), (-0.33, -0.079),
                                (-0.29, -0.02), (-0.245, 0.02), (-0.205, 0.026)], lambda y: 0.018 if y > -0.3 else 0.021, M["Polymer"], 0.003, 2))
    body.append(prism("pad", [(-0.36, 0.071), (-0.375, 0.071), (-0.375, -0.078), (-0.36, -0.082)], 0.0215, M["Grip"], 0.003, 2))
    # Charging handle (it moves); the rail along the top; a free-float handguard with slots.
    body += rail("rail", -0.096, 0.432, 0.072)
    body.append(lathe("handguard", [(0.165, 0.0262), (0.435, 0.0262)], M["Polymer"], 8, at=(0, 0, B), turn=math.pi / 8, smooth=False))
    for y in (0.19, 0.25, 0.31, 0.37):
        for s in (-1, 1):
            body.append(block("slot", s * 0.0243 - 0.0006, s * 0.0243 + 0.0006, y, y + 0.036, B - 0.004, B + 0.004, M["Dark"], 0))
        body.append(block("slot", -0.004, 0.004, y, y + 0.036, B - 0.0248, B - 0.0236, M["Dark"], 0))
    # Barrel, a flash hider with slots, and the bore.
    body.append(lathe("barrel", [(0.435, 0.0092), (0.51, 0.0092)], M["Steel"], 12, at=(0, 0, B)))
    body.append(lathe("hider", [(0.51, 0.0112), (0.513, 0.0118), (0.562, 0.0118), (0.565, 0.011)], M["Steel"], 12, at=(0, 0, B)))
    body.append(disc("bore", 0.0078, M["Dark"], (0, 0.5652, B), 1, 12))
    # Folding sights on the rail: a front post with its guards, a rear aperture.
    body.append(block("fbase", -0.009, 0.009, 0.405, 0.428, 0.0795, 0.087, M["Dark"], 0.001))
    for s in (-1, 1):
        body.append(block("fwing", s * 0.0075, s * 0.0045, 0.41, 0.42, 0.087, 0.104, M["Dark"], 0.0006))
    body.append(block("fpost", -0.0012, 0.0012, 0.413, 0.417, 0.087, 0.0985, M["Dark"], 0.0003))
    body.append(block("rbase", -0.011, 0.011, -0.08, -0.058, 0.0795, 0.086, M["Dark"], 0.001))
    for s in (-1, 1):
        body.append(block("rear", s * 0.0075, s * 0.0028, -0.072, -0.067, 0.086, 0.106, M["Dark"], 0.0005))
    body.append(block("rear", -0.0075, 0.0075, -0.072, -0.067, 0.086, 0.0935, M["Dark"], 0.0004))
    body.append(block("rear", -0.0075, 0.0075, -0.072, -0.067, 0.1025, 0.106, M["Dark"], 0.0004))
    body += [prism("charge", [(-0.112, 0.064), (-0.092, 0.064), (-0.092, 0.071), (-0.112, 0.071)], 0.006, M["Dark"], 0.0008),
              block("chargeT", -0.017, 0.017, -0.114, -0.104, 0.064, 0.071, M["Dark"], 0.0012)]
    # A curved 30-round magazine.
    front = [(0.099, 0.0 + 0.006), (0.101, -0.04), (0.106, -0.08), (0.114, -0.12), (0.124, -0.16), (0.132, -0.185)]
    back = [(0.036, 0.006), (0.038, -0.045), (0.044, -0.09), (0.054, -0.13), (0.066, -0.17), (0.075, -0.197)]
    mag = [prism("mag", front + list(reversed(back)), 0.011, M["Dark"], 0.0015),
           prism("magbase", [(0.134, -0.18), (0.138, -0.192), (0.077, -0.207), (0.072, -0.195)], 0.0128, M["Dark"], 0.002)]
    for k in range(3):
        mag.append(prism("rib", [(0.045 + k * 0.004, -0.05 - k * 0.04), (0.097 + k * 0.005, -0.05 - k * 0.04),
                                 (0.098 + k * 0.005, -0.056 - k * 0.04), (0.046 + k * 0.004, -0.056 - k * 0.04)], 0.0114, M["Dark"], 0.0004))
    # Paintball: a hopper on the left of the receiver, its top under the sights; a tank under the barrel ahead of the hand.
    kit = hopper(-0.064, 0.12, 0.052, 0.042, side=0.0135) + tank(0.37, 0.50, 0.016, (0, B - 0.0262 - 0.018))
    # Hands: the right round the pistol grip, the left under the handguard, palm up.
    gw = Wrap((0, -0.027, -0.001), (0, -0.026, -0.1), (0, 1, 0), 0.0215, 0.0148)
    right = hand("rifle_handR", gw,
                 [(0.034, 70, -1, 0.09, 0.0098, 0.0), (0.054, 72, -1, 0.086, 0.0094, 0.0), (0.073, 76, -1, 0.07, 0.0086, 0.0)],
                 [gw.at(0.022, 95, 0.004), gw.at(0.085, 100, 0.004), gw.at(0.022, 150, 0.004), gw.at(0.085, 150, 0.006),
                  gw.at(0.02, 200, 0.002), gw.at(0.07, 185, 0.004), gw.at(0.03, 95, 0.026), gw.at(0.07, 100, 0.026)],
                 (0.012, -0.10, -0.035), ((0.22, -1, -0.4), 0.38),
                 ([(-0.006, -0.05, 0.004), (-0.02, -0.03, 0.012), (-0.024, -0.008, 0.02), (-0.023, 0.014, 0.026), (-0.02, 0.03, 0.029)], 0.0105),
                 ([gw.at(0.01, 72, 0.01), (0.02, 0.0, -0.004), (0.016, 0.014, -0.006), (0.009, 0.017, -0.008), (0.004, 0.015, -0.01)], 0.0095))
    hw = Wrap((0, 0.30, B), (0, 1, 0), (0, 0, -1), 0.0262, 0.0262)
    # Across the handguard the fingers lie one behind the other: the index the furthest forward.
    left = hand("rifle_handL", Wrap((0, 0.30, B), (0, -1, 0), (0, 0, -1), 0.0262, 0.0262),
                [(-0.03, -45, -1, 0.062, 0.0098, 0.0), (-0.009, -45, -1, 0.064, 0.0096, 0.0), (0.012, -47, -1, 0.058, 0.009, 0.0), (0.031, -50, -1, 0.048, 0.0084, 0.0)],
                [hw.at(-0.04, -10, 0.004), hw.at(0.04, -10, 0.004), hw.at(-0.04, 40, 0.004), hw.at(0.04, 40, 0.004),
                 hw.at(-0.03, 10, 0.026), hw.at(0.035, 10, 0.026), hw.at(0.0, 45, 0.02)],
                (-0.012, 0.225, B - 0.055), ((-0.95, -1, -0.75), 0.45),
                ([hw.at(-0.03, -40, 0.016), hw.at(0.0, -65, 0.012), hw.at(0.025, -80, 0.011), hw.at(0.048, -88, 0.011), hw.at(0.066, -92, 0.011)], 0.0108),
                side=-1)
    return finish(W, (0, -0.042, 0.006), body,
                  {"mag": (mag, (0, 0.068, 0.0), {"out": (0, 0.06, -1)})},
                  (0, 0.566, B), (0, 0.415, 0.098), kit, [right, left])


def hopper(x, y, ztop, r, side=0.0, top=False):
    """Paintball's hopper: a rounded tub with a lid and a feed neck. On the gun's left flank
    (`side`: the flank's half-width) with its top at `ztop`, or on top (`top`) standing on `ztop`."""
    if top:
        c = Vector((x, y, ztop + r * 1.15))
        neck = [lathe("neck", [(ztop - 0.01, r * 0.3), (ztop + r * 0.5, r * 0.3)], M["KitTrim"], 12, at=(x, y, 0), axis="z")]
    else:
        c = Vector((x, y, ztop - r * 1.15))
        neck = [block("neck", x + r * 0.7, -side + 0.002, y - r * 0.28, y + r * 0.28, c.z - r * 0.28, c.z + r * 0.28, M["KitTrim"], 0.002)]
    prof = [(-0.85, 0.35), (-0.78, 0.7), (-0.55, 0.93), (-0.2, 1.0), (0.25, 0.97), (0.6, 0.85), (0.85, 0.62)]
    tub = lathe("hopper", [(c.z + r * t, r * s) for t, s in prof], M["Hopper"], 18, at=(c.x, c.y, 0), axis="z", squash=1.25)
    lid = lathe("lid", [(c.z + r * 0.82, r * 0.66), (c.z + r * 0.95, r * 0.6), (c.z + r * 1.0, r * 0.4)], M["KitTrim"], 18, at=(c.x, c.y, 0), axis="z", squash=1.25)
    return neck + [tub, lid]


def tank(y0, y1, r, at):
    """Paintball's air tank under the barrel: domed ends, a regulator ring at the back."""
    x, z = at
    prof = [(y0, 0), (y0 + r * 0.3, r * 0.7), (y0 + r * 0.9, r), (y1 - r * 0.9, r), (y1 - r * 0.3, r * 0.7), (y1, 0)]
    return [lathe("tank", prof, M["Tank"], 14, at=(x, 0, z)),
            lathe("reg", [(y0 + r * 0.6, r * 1.08), (y0 + r * 1.6, r * 1.08)], M["KitTrim"], 14, at=(x, 0, z)),
            block("mount", x - r * 0.35, x + r * 0.35, (y0 + y1) / 2 - 0.02, (y0 + y1) / 2 + 0.02, z + r * 0.6, z + r * 1.6, M["KitTrim"], 0.001)]


def build_shotgun():
    W = "shotgun"
    B = 0.05
    body = []
    body.append(prism("receiver", [(-0.04, 0.012), (0.175, 0.012), (0.175, 0.068), (0.0, 0.0705), (-0.036, 0.066), (-0.04, 0.06)], 0.0185, M["Steel"], 0.003, 2))
    body.append(block("port", 0.017, 0.0189, 0.05, 0.12, 0.036, 0.06, M["Dark"], 0.0004))
    body.append(block("loading", -0.012, 0.012, 0.06, 0.15, 0.0085, 0.0125, M["Dark"], 0.0004))
    body.append(trigger_guard("guard", 0.0, 0.058, 0.012, -0.022, 0.006))
    body.append(trigger("trigger", 0.022, 0.012, -0.012))
    body.append(lathe("barrel", [(0.175, 0.0118), (0.72, 0.0112)], M["Steel"], 14, at=(0, 0, B)))
    body.append(disc("bore", 0.0094, M["Dark"], (0, 0.7202, B), 1, 14))
    body.append(block("rib", -0.0035, 0.0035, 0.18, 0.715, B + 0.0105, B + 0.0145, M["Steel"], 0.0005))
    bead = lathe("bead", [(0.0, 0.0), (0.0016, 0.0024), (0.0035, 0.0024), (0.005, 0.0)], M["Brass"], 8, at=(0, 0.708, B + 0.0145), axis="z")
    body.append(bead)
    body.append(lathe("magtube", [(0.175, 0.0105), (0.655, 0.0105)], M["Steel"], 14, at=(0, 0, 0.0195)))
    body.append(lathe("cap", [(0.655, 0.0118), (0.672, 0.0118), (0.675, 0.009)], M["Steel"], 14, at=(0, 0, 0.0195)))
    body.append(block("clamp", -0.008, 0.008, 0.635, 0.65, 0.02, B, M["Steel"], 0.001))
    # A walnut stock with a semi-pistol grip and a rubber recoil pad, wider towards the butt.
    stock = [(-0.04, 0.062), (-0.13, 0.057), (-0.395, 0.046), (-0.40, 0.046), (-0.405, -0.088), (-0.395, -0.09), (-0.2, -0.048),
             (-0.15, -0.052), (-0.115, -0.045), (-0.085, -0.02), (-0.06, 0.004), (-0.04, 0.012)]
    body.append(prism("stock", stock, lambda y: 0.0165 if y > -0.16 else 0.0165 + (-0.16 - y) * 0.022, M["Wood"], 0.004, 2))
    body.append(prism("pad", [(-0.4, 0.047), (-0.42, 0.047), (-0.425, -0.091), (-0.405, -0.089)], 0.0222, M["Grip"], 0.003, 2))
    # The pump: a grooved wooden fore-end round the magazine tube (it moves).
    prof = [(0.30, 0.017), (0.305, 0.0215)]
    y = 0.312
    while y < 0.47:
        prof += [(y, 0.0228), (y + 0.012, 0.0228), (y + 0.014, 0.0206), (y + 0.02, 0.0206), (y + 0.022, 0.0228)]
        y += 0.024
    prof += [(0.475, 0.0215), (0.48, 0.017)]
    pump = [lathe("pump", prof, M["Wood"], 14, at=(0, 0, 0.022), squash=0.9)]
    # A shell for the left hand to load.
    shell = [lathe("hull", [(0.0, 0.0108), (0.055, 0.0108), (0.058, 0.0)], M["Warhead"], 10, at=(0, 0, 0)),
             lathe("head", [(-0.013, 0.0112), (0.0, 0.0112)], M["Brass"], 10, at=(0, 0, 0))]
    kit = hopper(-0.068, 0.10, 0.058, 0.042, side=0.0185) + tank(0.50, 0.63, 0.015, (0, 0.0195 - 0.0105 - 0.017))
    # Hands: the right round the stock's wrist, the left round the pump.
    gw = Wrap((0, -0.062, 0.028), (0, -0.04, -0.1), (0, 1, 0.25), 0.023, 0.0165)
    right = hand("shotgun_handR", gw,
                 [(0.03, 70, -1, 0.092, 0.0098, 0.0), (0.05, 72, -1, 0.087, 0.0094, 0.0), (0.069, 76, -1, 0.074, 0.0086, 0.0)],
                 [gw.at(0.018, 95, 0.004), gw.at(0.08, 100, 0.004), gw.at(0.018, 150, 0.004), gw.at(0.08, 150, 0.006),
                  gw.at(0.012, 200, 0.002), gw.at(0.065, 185, 0.004), gw.at(0.03, 95, 0.026), gw.at(0.07, 100, 0.026)],
                 (0.012, -0.135, 0.0), ((0.22, -1, -0.45), 0.38),
                 ([(-0.006, -0.085, 0.045), (-0.02, -0.064, 0.055), (-0.024, -0.042, 0.062), (-0.022, -0.02, 0.066), (-0.02, -0.002, 0.068)], 0.0105),
                 ([gw.at(0.008, 72, 0.01), (0.02, 0.012, 0.004), (0.015, 0.025, 0.0), (0.008, 0.028, -0.004), (0.003, 0.026, -0.006)], 0.0095))
    pw = Wrap((0, 0.39, 0.022), (0, -1, 0), (0, 0, -1), 0.0228, 0.0228 * 0.95)
    hw = Wrap((0, 0.39, 0.022), (0, 1, 0), (0, 0, -1), 0.0228, 0.0228)
    left = hand("shotgun_handL", pw,
                [(-0.03, -45, -1, 0.062, 0.0098, 0.0), (-0.009, -45, -1, 0.064, 0.0096, 0.0), (0.012, -47, -1, 0.058, 0.009, 0.0), (0.031, -50, -1, 0.048, 0.0084, 0.0)],
                [hw.at(-0.04, -10, 0.004), hw.at(0.04, -10, 0.004), hw.at(-0.04, 40, 0.004), hw.at(0.04, 40, 0.004),
                 hw.at(-0.03, 10, 0.026), hw.at(0.035, 10, 0.026), hw.at(0.0, 45, 0.02)],
                (-0.012, 0.315, 0.022 - 0.055), ((-0.95, -1, -0.75), 0.45),
                ([hw.at(-0.03, -40, 0.016), hw.at(0.0, -65, 0.012), hw.at(0.025, -80, 0.011), hw.at(0.048, -88, 0.011), hw.at(0.066, -92, 0.011)], 0.0108),
                side=-1)
    sh = join("shotgun_shell", shell)
    for p in sh.data.polygons:
        p.use_smooth = True
    # In the hand's fingers, across the palm, pointing forward.
    sh.location = Vector((-0.006, 0.39, 0.022 - 0.045))
    bpy.context.view_layer.update()
    sh.parent = left
    sh.matrix_parent_inverse = left.matrix_world.inverted()
    return finish(W, (0, -0.062, 0.03), body,
                  {"pump": (pump, (0, 0.39, 0.022))},
                  (0, 0.721, B), (0, 0.70, 0.0695), kit, [right, left])


def build_sniper():
    W = "sniper"
    B = 0.045
    body = []
    # A polymer stock: fore-end, action bed, a near-upright grip, a butt with a raised cheek rest.
    body.append(prism("fore", [(0.415, 0.044), (0.42, 0.03), (0.41, 0.014), (0.06, 0.008), (0.03, 0.002), (-0.07, 0.002), (-0.07, 0.044)],
                      0.0185, M["Polymer"], 0.004, 2))
    body.append(prism("grip", [(0.0, 0.004), (-0.012, -0.04), (-0.02, -0.098), (-0.06, -0.101), (-0.06, -0.06), (-0.055, -0.02), (-0.065, 0.004)],
                      0.0145, M["Polymer"], 0.003, 2))
    body.append(prism("gpanel", [(-0.008, -0.025), (-0.016, -0.09), (-0.054, -0.092), (-0.052, -0.025)], 0.015, M["Grip"], 0.0006))
    body.append(prism("butt", [(-0.065, 0.044), (-0.14, 0.056), (-0.37, 0.056), (-0.375, 0.05), (-0.375, -0.092), (-0.36, -0.1), (-0.3, -0.07),
                               (-0.2, -0.05), (-0.14, -0.04), (-0.08, -0.02), (-0.055, -0.01)], lambda y: 0.016 if y > -0.15 else 0.02, M["Polymer"], 0.004, 2))
    body.append(prism("cheek", [(-0.16, 0.056), (-0.33, 0.056), (-0.33, 0.074), (-0.17, 0.074)], 0.016, M["Grip"], 0.004, 2))
    body.append(prism("pad", [(-0.375, 0.056), (-0.39, 0.056), (-0.39, -0.1), (-0.375, -0.1)], 0.0205, M["Grip"], 0.003, 2))
    body.append(trigger_guard("guard", -0.002, 0.045, 0.004, -0.026, 0.006))
    body.append(trigger("trigger", 0.015, 0.004, -0.014))
    # Round receiver with its port, a heavy barrel and a muzzle brake.
    body.append(lathe("receiver", [(-0.075, 0.0175), (0.13, 0.0175)], M["Steel"], 16, at=(0, 0, B)))
    body.append(block("port", 0.0108, 0.0178, 0.0, 0.06, B + 0.002, B + 0.014, M["Dark"], 0.0004))
    body.append(block("base", -0.0095, 0.0095, -0.075, 0.13, B + 0.015, B + 0.022, M["Dark"], 0.0006))
    body.append(lathe("barrel", [(0.13, 0.0128), (0.62, 0.0098)], M["Steel"], 14, at=(0, 0, B)))
    body.append(lathe("brake", [(0.62, 0.0132), (0.68, 0.0132), (0.683, 0.012)], M["Steel"], 12, at=(0, 0, B), smooth=False))
    for y in (0.632, 0.648, 0.664):
        for s in (-1, 1):
            body.append(block("bport", s * 0.0128 - 0.0008, s * 0.0128 + 0.0008, y, y + 0.009, B - 0.006, B + 0.006, M["Dark"], 0.0003))
    body.append(disc("bore", 0.0055, M["Dark"], (0, 0.6832, B), 1, 12))
    # The scope: eyecup, eyepiece, the tube with turrets, the bell, the lenses; on two rings.
    S = B + 0.05
    body.append(lathe("eyecup", [(-0.128, 0.0182), (-0.116, 0.0196), (-0.11, 0.0196)], M["Grip"], 18, at=(0, 0, S), caps=(False, True)))
    body.append(lathe("scope", [(-0.11, 0.0195), (-0.065, 0.0195), (-0.045, 0.015), (0.10, 0.015), (0.15, 0.0255), (0.19, 0.0255), (0.193, 0.024)],
                      M["Dark"], 18, at=(0, 0, S)))
    body.append(lathe("turret", [(S + 0.01, 0.0115), (S + 0.03, 0.0115), (S + 0.032, 0.009)], M["Dark"], 14, at=(0, 0.02, 0), axis="z"))
    body.append(prism("wind", [(0.008, S - 0.0115), (0.032, S - 0.0115), (0.032, S + 0.0115), (0.008, S + 0.0115)], 0.009, M["Dark"], 0.002, x=0.022))
    body.append(disc("lens", 0.0225, M["Glass"], (0, 0.1925, S), 1, 18))
    body.append(disc("eye", 0.0165, M["Glass"], (0, -0.127, S), -1, 18))
    for y in (-0.025, 0.08):
        body.append(lathe("ring", [(y, 0.0178), (y + 0.016, 0.0178)], M["Dark"], 16, at=(0, 0, S), smooth=False))
        body.append(block("rbase", -0.008, 0.008, y + 0.001, y + 0.015, B + 0.022, S - 0.012, M["Dark"], 0.0008))
    # The bolt (it moves): its body behind the receiver and the handle on the right, turned down.
    bolt = [lathe("shroud", [(-0.11, 0.0125), (-0.075, 0.0125)], M["Steel"], 12, at=(0, 0, B)),
            lathe("bolt", [(-0.075, 0.0095), (-0.02, 0.0095)], M["Steel"], 12, at=(0, 0, B)),
            sweep("handle", [(0.004, -0.058, B), (0.02, -0.06, B - 0.004), (0.036, -0.064, B - 0.016)], [0.0042, 0.0042, 0.004], M["Steel"], 8, tip=False),
            lathe("knob", [(-0.0095, 0.0), (-0.008, 0.0062), (-0.002, 0.0095), (0.004, 0.0095), (0.009, 0.006), (0.0105, 0.0)], M["Steel"], 12,
                  at=(0.04, -0.066, B - 0.02), axis="z")]
    mag = [prism("mag", [(0.02, 0.004), (0.085, 0.004), (0.083, -0.03), (0.022, -0.03)], 0.0135, M["Dark"], 0.0015),
           prism("magbase", [(0.018, -0.028), (0.087, -0.028), (0.087, -0.036), (0.018, -0.036)], 0.0148, M["Dark"], 0.0015)]
    kit = tank(0.33, 0.45, 0.016, (0, 0.008 - 0.02))
    gw = Wrap((0, -0.03, -0.0), (0, -0.018, -0.1), (0, 1, 0), 0.021, 0.0148)
    right = hand("sniper_handR", gw,
                 [(0.032, 70, -1, 0.09, 0.0098, 0.0), (0.052, 72, -1, 0.086, 0.0094, 0.0), (0.071, 76, -1, 0.07, 0.0086, 0.0)],
                 [gw.at(0.022, 95, 0.004), gw.at(0.085, 100, 0.004), gw.at(0.022, 150, 0.004), gw.at(0.085, 150, 0.006),
                  gw.at(0.02, 200, 0.002), gw.at(0.07, 185, 0.004), gw.at(0.03, 95, 0.026), gw.at(0.07, 100, 0.026)],
                 (0.012, -0.10, -0.03), ((0.22, -1, -0.4), 0.38),
                 ([(-0.006, -0.053, 0.006), (-0.02, -0.035, 0.015), (-0.024, -0.012, 0.024), (-0.023, 0.008, 0.03), (-0.02, 0.024, 0.033)], 0.0105),
                 ([gw.at(0.01, 72, 0.01), (0.02, 0.003, -0.004), (0.016, 0.018, -0.006), (0.009, 0.021, -0.008), (0.004, 0.019, -0.01)], 0.0095))
    fz = 0.026  # the fore-end's middle height
    pw = Wrap((0, 0.28, fz), (0, -1, 0), (0, 0, -1), 0.019, 0.0185)
    hw = Wrap((0, 0.28, fz), (0, 1, 0), (0, 0, -1), 0.019, 0.0185)
    left = hand("sniper_handL", pw,
                [(-0.03, -45, -1, 0.062, 0.0098, 0.0), (-0.009, -45, -1, 0.064, 0.0096, 0.0), (0.012, -47, -1, 0.058, 0.009, 0.0), (0.031, -50, -1, 0.048, 0.0084, 0.0)],
                [hw.at(-0.04, -10, 0.004), hw.at(0.04, -10, 0.004), hw.at(-0.04, 40, 0.004), hw.at(0.04, 40, 0.004),
                 hw.at(-0.03, 10, 0.026), hw.at(0.035, 10, 0.026), hw.at(0.0, 45, 0.02)],
                (-0.012, 0.205, fz - 0.052), ((-0.95, -1, -0.75), 0.45),
                ([hw.at(-0.03, -40, 0.016), hw.at(0.0, -65, 0.012), hw.at(0.025, -80, 0.011), hw.at(0.048, -88, 0.011), hw.at(0.066, -92, 0.011)], 0.0108),
                side=-1)
    return finish(W, (0, -0.046, 0.004), body,
                  {"bolt": (bolt, (0, -0.06, B), {"knob": (0.04, -0.066, B - 0.02)}), "mag": (mag, (0, 0.052, 0.0), {"out": (0, 0.0, -1)})},
                  (0, 0.684, B), (0, 0.0, S), kit, [right, left])


def build_bazooka():
    W = "bazooka"
    T = 0.075  # the tube's axis over the grip
    body = []
    body.append(lathe("tube", [(-0.46, 0.0445), (0.74, 0.0445)], M["Olive"], 20, at=(0, 0, T), caps=(False, False)))
    body.append(lathe("inner", [(-0.40, 0.0405), (0.74, 0.0405)], M["Dark"], 20, at=(0, 0, T), caps=(False, False), inside=True))
    body.append(lathe("rim", [(0.725, 0.0405), (0.728, 0.049), (0.76, 0.049), (0.762, 0.0405)], M["Dark"], 20, at=(0, 0, T), caps=(False, False)))
    body.append(lathe("venturi", [(-0.43, 0.0475), (-0.47, 0.048), (-0.56, 0.06), (-0.565, 0.057), (-0.47, 0.0405)], M["Dark"], 20, at=(0, 0, T), caps=(False, False)))
    for y in (-0.2, 0.32):
        body.append(lathe("band", [(y, 0.0465), (y + 0.03, 0.0465)], M["Steel"], 20, at=(0, 0, T), smooth=False))
    # Shoulder rest under the tube, the grip and trigger housing, a front grip, the sling loops.
    body.append(prism("rest", [(-0.27, T - 0.03), (-0.06, T - 0.03), (-0.07, T - 0.062), (-0.25, T - 0.07)], 0.028, M["Grip"], 0.006, 2))
    body.append(prism("housing", [(-0.035, T - 0.035), (0.075, T - 0.035), (0.07, -0.004), (-0.03, -0.004)], 0.016, M["Dark"], 0.003, 2))
    body.append(prism("grip", [(0.005, 0.0), (-0.003, -0.04), (-0.012, -0.095), (-0.05, -0.098), (-0.045, -0.06), (-0.036, -0.02), (-0.035, 0.0)],
                      0.0145, M["Dark"], 0.003, 2))
    body.append(trigger_guard("guard", 0.005, 0.055, 0.0, -0.03, 0.006))
    body.append(trigger("trigger", 0.022, -0.002, -0.02))
    body.append(prism("fgrip", [(0.31, T - 0.04), (0.35, T - 0.04), (0.345, -0.065), (0.315, -0.065)], 0.014, M["Dark"], 0.004, 2))
    body.append(block("fmount", -0.015, 0.015, 0.30, 0.36, T - 0.05, T - 0.035, M["Dark"], 0.002))
    # The sight on the left of the tube: a frame with a post in front, an aperture at the back.
    SX, SZ = -0.075, T + 0.055
    for y, tall in ((0.16, True), (-0.19, False)):
        body.append(block("arm", SX, -0.04, y, y + 0.014, T + 0.008, T + 0.02, M["Dark"], 0.001))
        body.append(block("leaf", SX - 0.004, SX + 0.004, y, y + 0.006, T + 0.008, SZ + (0.012 if tall else 0.016), M["Dark"], 0.0006))
    body.append(block("post", SX - 0.0013, SX + 0.0013, 0.159, 0.163, SZ - 0.004, SZ, M["Dot"], 0.0002))
    body.append(lathe("peep", [(-0.19, 0.0075), (-0.182, 0.0075)], M["Dark"], 12, at=(SX, 0, SZ), smooth=False))
    body.append(disc("peephole", 0.0035, M["Glass"], (SX, -0.1815, SZ), 1, 10))
    # The rocket's nose, seen in the front of the tube (it moves: it flies, and comes back loading).
    rocket = [lathe("warhead", [(0.62, 0.0398), (0.74, 0.0398), (0.77, 0.037), (0.80, 0.03), (0.83, 0.018), (0.845, 0.006), (0.848, 0.0)],
                    M["Warhead"], 18, at=(0, 0, T)),
              lathe("band", [(0.735, 0.0402), (0.75, 0.0402)], M["Brass"], 18, at=(0, 0, T), smooth=False)]
    kit = hopper(0.0, 0.42, T + 0.0445, 0.06, top=True)
    gw = Wrap((0, -0.015, -0.002), (0, -0.018, -0.1), (0, 1, 0), 0.021, 0.0148)
    right = hand("bazooka_handR", gw,
                 [(0.032, 70, -1, 0.09, 0.0098, 0.0), (0.052, 72, -1, 0.086, 0.0094, 0.0), (0.071, 76, -1, 0.07, 0.0086, 0.0)],
                 [gw.at(0.022, 95, 0.004), gw.at(0.085, 100, 0.004), gw.at(0.022, 150, 0.004), gw.at(0.085, 150, 0.006),
                  gw.at(0.02, 200, 0.002), gw.at(0.07, 185, 0.004), gw.at(0.03, 95, 0.026), gw.at(0.07, 100, 0.026)],
                 (0.012, -0.085, -0.03), ((0.22, -1, -0.4), 0.38),
                 ([(-0.006, -0.04, 0.004), (-0.02, -0.022, 0.01), (-0.024, 0.0, 0.016), (-0.023, 0.02, 0.02), (-0.021, 0.036, 0.022)], 0.0105),
                 ([gw.at(0.01, 72, 0.01), (0.02, 0.012, -0.006), (0.016, 0.026, -0.008), (0.009, 0.029, -0.01), (0.004, 0.027, -0.012)], 0.0095))
    fw = Wrap((0, 0.332, T - 0.045), (0, -0.01, -1), (0, 1, 0), 0.016, 0.0145)
    left = hand("bazooka_handL", fw,
                [(0.012, -60, 1, 0.07, 0.0098, 0.0), (0.032, -60, 1, 0.07, 0.0096, 0.0), (0.052, -62, 1, 0.066, 0.009, 0.0), (0.07, -64, 1, 0.055, 0.0084, 0.0)],
                [fw.at(0.012, -95, 0.004), fw.at(0.075, -100, 0.004), fw.at(0.012, -150, 0.004), fw.at(0.075, -150, 0.006),
                 fw.at(0.02, -175, 0.004), fw.at(0.07, -175, 0.004), fw.at(0.03, -110, 0.026), fw.at(0.07, -115, 0.026)],
                (-0.03, 0.285, -0.035), ((-0.8, -1, -0.6), 0.45),
                ([fw.at(0.0, -160, 0.01), fw.at(-0.004, -185, 0.011), fw.at(-0.007, -215, 0.011), fw.at(-0.009, -240, 0.011)], 0.0108),
                side=-1)
    return finish(W, (0, -0.032, 0.0), body,
                  {"rocket": (rocket, (0, 0.62, T))},
                  (0, 0.765, T), (SX, 0.16, SZ), kit, [right, left])


build_pistol()
build_rifle()
build_shotgun()
build_sniper()
build_bazooka()

bpy.ops.object.select_all(action="SELECT")
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_extras=True, export_texcoords=False, export_cameras=False, export_lights=False)


def pack(path):
    """Make the GLB small: positions as 16-bit integers (KHR_mesh_quantization, normalized: every part lies
    within a metre of its node, so a step is 0.03 mm), normals as signed bytes, 16-bit indices. The nodes
    keep their places (the moving parts' pivots, the wrists)."""
    import json
    import struct
    import numpy as np
    raw = open(path, "rb").read()
    jlen = struct.unpack("<I", raw[12:16])[0]
    gl = json.loads(raw[20:20 + jlen])
    bin_ = raw[20 + jlen + 8:]
    comps = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
    dtypes = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}

    def read(i):
        a = gl["accessors"][i]
        bv = gl["bufferViews"][a["bufferView"]]
        dt = np.dtype(dtypes[a["componentType"]])
        c = comps[a["type"]]
        start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = bv.get("byteStride", dt.itemsize * c)
        rows = np.ndarray((a["count"], c), dtype=dt, buffer=bin_, offset=start, strides=(stride, dt.itemsize))
        return rows.copy()

    out = bytearray()
    views, accs = [], []

    def put(arr, ctype, typ, target, normalized=False, stride=None):
        while len(out) % 4:
            out.append(0)
        data = arr.tobytes()
        views.append({"buffer": 0, "byteOffset": len(out), "byteLength": len(data), **({"byteStride": stride} if stride else {}),
                      **({"target": target} if target else {})})
        out.extend(data)
        acc = {"bufferView": len(views) - 1, "componentType": ctype, "count": int(arr.shape[0]), "type": typ}
        if normalized:
            acc["normalized"] = True
        accs.append(acc)
        return len(accs) - 1

    for mesh in gl["meshes"]:
        for prim in mesh["primitives"]:
            at = prim["attributes"]
            pos = read(at["POSITION"]).astype(np.float64)
            assert np.abs(pos).max() < 0.999, f"{mesh['name']} reaches past a metre from its node"
            q = np.zeros((len(pos), 4), np.int16)
            q[:, :3] = np.round(pos * 32767).astype(np.int16)
            new = {"POSITION": put(q, 5122, "VEC3", 34962, True, 8)}
            accs[new["POSITION"]]["min"] = [int(x) for x in q[:, :3].min(0)]
            accs[new["POSITION"]]["max"] = [int(x) for x in q[:, :3].max(0)]
            nrm = read(at["NORMAL"]).astype(np.float64)
            n4 = np.zeros((len(nrm), 4), np.int8)
            n4[:, :3] = np.clip(np.round(nrm * 127), -127, 127).astype(np.int8)
            new["NORMAL"] = put(n4, 5120, "VEC3", 34962, True, 4)
            idx = read(prim["indices"]).reshape(-1)
            prim["indices"] = put(idx.astype(np.uint16), 5123, "SCALAR", 34963)
            prim["attributes"] = new
    gl["accessors"], gl["bufferViews"] = accs, views
    gl["buffers"] = [{"byteLength": len(out)}]
    for k in ("extensionsUsed", "extensionsRequired"):
        gl[k] = sorted(set(gl.get(k, [])) | {"KHR_mesh_quantization"})
    js = json.dumps(gl, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    while len(out) % 4:
        out.append(0)
    glb = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(out)) + struct.pack("<II", len(js), 0x4E4F534A) + js + \
        struct.pack("<II", len(out), 0x004E4942) + bytes(out)
    open(path, "wb").write(glb)


pack(OUT)
print("written", OUT, os.path.getsize(OUT), "bytes")

# ---- Preview renders: each weapon from its left, with its hands, small.
if PREVIEW:
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 640, 360
    world = bpy.data.worlds.new("Room")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.35, 0.36, 0.38, 1)
    scene.world = world
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 3))
    sun = bpy.context.active_object
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), math.radians(-20), math.radians(30))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    roots = {o.name: o for o in bpy.data.objects if o.parent is None and o.type == "EMPTY"}
    views = {"pistol": (0.09, 0.4), "rifle": (0.2, 1.1), "shotgun": (0.2, 1.2), "sniper": (0.25, 1.3), "bazooka": (0.3, 1.6)}
    for w, (mid, dist) in views.items():
        for name, r in roots.items():
            r.hide_render = name != w
            for c in r.children_recursive:
                c.hide_render = name != w
        for label, at in (("left", (-dist, mid - 0.15 * dist, 0.2 * dist)), ("eye", (-0.18 * dist, -0.55 * dist, 0.25 * dist))):
            cam.location = Vector(at)
            target = Vector((0, mid, 0.0))
            cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
            cam.data.lens = 50
            scene.render.filepath = os.path.join(PREVIEW, f"{w}_{label}.png")
            bpy.ops.render.render(write_still=True)
