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
With preview_dir it also renders small pictures of each weapon there, from the side and as the player sees
it (<w>_hip_eye, <w>_ads_eye), and of each hand in clay.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

bpy.ops.wm.read_factory_settings(use_empty=True)


def srgb(h):
    """'#rrggbb' to linear RGB, as the Principled BSDF (and glTF) expect."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def material(name, color, rough=0.5, metal=0.0, alpha=1.0, glow=""):
    """`alpha` under 1: see-through (a sight's window). `glow`: a colour it lights up in by itself (a sight's dot)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*srgb(color), 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if alpha < 1:
        p.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    if glow:
        p.inputs["Emission Color"].default_value = (*srgb(glow), 1)
        p.inputs["Emission Strength"].default_value = 1.0
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
    "Lens": material("Lens", "#7fa6b4", 0.05, 0.0, alpha=0.16),  # the red-dot sight's window: you look through it
    "RedDot": material("RedDot", "#1a0504", 0.5, 0.0, glow="#ff2a14"),  # its dot
    "Warhead": material("Warhead", "#3f4630", 0.5, 0.2),    # the rocket's nose
    "Glove": material("Glove", "#26272a", 0.82, 0.0),
    "GloveTrim": material("GloveTrim", "#23251f", 0.8, 0.0),  # the glove's cuff and its strap: dark webbing
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
    """A tube along a centre line with a radius per point and a rounded tip: a bolt handle."""
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


# The hands are a sculpted pair of arms (tools/assets/fps_arms.blend: "FPS arms, rigged only" from
# OpenGameArt, CC0), with a skeleton down to each finger bone. Each hand is laid on its grip and its
# finger bones are turned to follow the lines the fingers take round it; what comes out is the posed
# skin from the fingertips past the elbow, at the size of a real hand: the glove, its cuff and the sleeve
# over the sculpt's own forearm.
# Its glove is painted by tools/gloves.py in the sculpt's own flat layout; that file also holds what both
# must agree on (the hand's size, which part of the sculpt is the hand, where the hands lie in the layout).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gloves  # noqa: E402

HAND_SCALE = gloves.HAND_SCALE
_arms = {}


def source_arms():
    if not _arms:
        _arms["rig"], _arms["body"] = gloves.load_arms(link)
        bpy.context.view_layer.update()
        _arms["box"] = gloves.uv_box(_arms["rig"], _arms["body"])
    return _arms["rig"], _arms["body"]


def drop_arms():
    """Take the sculpt out again before the bake and the export."""
    for o in (_arms.get("rig"), _arms.get("body")):
        if o:
            bpy.data.objects.remove(o, do_unlink=True)
    _arms.clear()


def fit(src, dst, weights, scale):
    """The turn R and the move T that lay the points `src` (scaled) best on `dst`: dst = R (scale src) + T."""
    import numpy as np
    A = np.array([list(p) for p in src]) * scale
    B = np.array([list(p) for p in dst])
    w = np.array(weights, dtype=float)[:, None]
    ca, cb = (A * w).sum(0) / w.sum(), (B * w).sum(0) / w.sum()
    U, _, Vt = np.linalg.svd(((A - ca) * w).T @ (B - cb))
    d = 1.0 if np.linalg.det(Vt.T @ U.T) > 0 else -1.0
    R = Vt.T @ np.diag([1.0, 1.0, d]) @ U.T
    T = cb - R @ ca
    err = [round(float(e) * 1000, 1) for e in np.linalg.norm(A @ R.T + T - B, axis=1)]
    return Matrix(R.tolist()), Vector(T.tolist()), err


def along(pts, run):
    """The point `run` along the line through pts (past its end: straight on)."""
    left = run
    for p, q in zip(pts, pts[1:]):
        seg = (q - p).length
        if left <= seg and seg > 0:
            return p.lerp(q, left / seg)
        left -= seg
    p, q = pts[-2], pts[-1]
    return q + (q - p).normalized() * left


def aim(rig, bone, way, limit=None):
    """Turn a pose bone, by the shortest turn (at most `limit`), so it points along `way` (world)."""
    if way.length < 1e-9:
        return
    bpy.context.view_layer.update()
    mw = rig.matrix_world
    head = mw @ bone.head
    q = (mw @ bone.tail - head).rotation_difference(way)
    if limit is not None and q.angle > limit:
        q = Quaternion(q.axis, limit)
    turn = Matrix.Translation(head) @ q.to_matrix().to_4x4() @ Matrix.Translation(-head)
    bone.matrix = mw.inverted() @ turn @ mw @ bone.matrix
    bpy.context.view_layer.update()


def reach(rig, bone, point):
    """Turn a pose bone so it points from where it starts to `point` (world)."""
    bpy.context.view_layer.update()
    aim(rig, bone, point - rig.matrix_world @ bone.head)


ARM_KEEP = 0.42     # m of the sculpt's arm kept behind the wrist, along the forearm and on up the upper arm
SLEEVE_FROM = 0.05  # m up the forearm where the sleeve starts; the glove's cuff ends under it
WRIST_MAX = math.radians(35)  # the most the wrist bends to send the forearm the way it should go
ELBOW = math.radians(15)      # how far the upper arm stays off the forearm's line (the sculpt rests at 47 degrees)
SLEEVE_FINE = 0.25  # m: the sleeve is made finer up to here, where it can be in view
ARM_GROUPS = ("forearm", "upper_arm", "deltoid", "clavicle")


def arm_points(rig, body, side):
    """The sculpt's points that are this hand and its arm, up to ARM_KEEP from the wrist (none of the shoulder),
    each with how far up the arm it lies (m, negative on the hand), its share of the arm's weights (it turns with
    the forearm at the wrist) and its share of the upper arm's (it turns at the elbow)."""
    X = ".R" if side > 0 else ".L"
    mw, bw = rig.matrix_world, body.matrix_world
    fore, upper = rig.data.bones["forearm" + X], rig.data.bones["upper_arm" + X]
    wr, elbow = mw @ fore.tail_local, mw @ fore.head_local
    f_way = (elbow - wr).normalized()
    u_way = (mw @ upper.head_local - elbow).normalized()
    length = (elbow - wr).length
    names = {g.index: g.name for g in body.vertex_groups}
    out = {}
    for v in body.data.vertices:
        p = bw @ v.co
        if p.x * side <= 0:
            continue
        w = {}
        for g in v.groups:
            n = names[g.group]
            if n.endswith(X) and n[:-2] in ARM_GROUPS:
                w[n[:-2]] = w.get(n[:-2], 0.0) + g.weight
        total = sum(g.weight for g in v.groups)
        armw = sum(w.values())
        if total and (w.get("deltoid", 0) + w.get("clavicle", 0)) / total >= 0.5:
            continue
        up_s = (armw - w.get("forearm", 0)) / armw if armw else 0.0
        run = (p - wr).dot(f_way) * (1 - up_s) + (length + (p - elbow).dot(u_way)) * up_s
        if run * HAND_SCALE < ARM_KEEP:
            out[v.index] = (run * HAND_SCALE, armw / total if total else 0.0, up_s * armw / total if total else 0.0)
    return out, elbow, f_way, u_way


def real_hand(name, lines, thumb_line, wrist, side, wrap, fore):
    """The sculpted hand, its knuckles and wrist laid on the first point of each of `lines` (index or
    middle finger first, the little finger last) and on `wrist`, its fingers bent along the lines; and its
    own forearm, bent at the wrist towards `fore` (the way from the wrist to the elbow), in its sleeve."""
    rig, body = source_arms()
    X = ".R" if side > 0 else ".L"
    bones = rig.pose.bones
    for pb in bones:
        pb.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    mw = rig.matrix_world
    names = ["index", "middle", "ring", "pinky"][4 - len(lines):]
    lines = [[Vector(p) for p in line] for line in lines]
    thumb_line = [Vector(p) for p in thumb_line]
    src = [mw @ bones[f"f_{n}.01{X}"].head for n in names] + [mw @ bones["hand" + X].head, mw @ bones["thumb.01" + X].tail]
    dst = [line[0] for line in lines] + [Vector(wrist), thumb_line[0]]
    # The palm faces what it holds: a point 3 cm off the middle of the knuckles on the palm's side (the side the
    # sculpt's relaxed fingers bend to) goes 3 cm towards the middle of the grip.
    k0, k1 = mw @ bones["palm_middle" + X].head, mw @ bones["palm_middle" + X].tail
    bone_way = (k1 - k0).normalized()
    bend = mw @ bones["f_middle.03" + X].tail - k1
    bend = (bend - bone_way * bend.dot(bone_way)).normalized()
    mid_s = (src[len(lines) - 3] + src[len(lines) - 2]) / 2  # between the middle and the ring finger
    mid_t = (dst[len(lines) - 3] + dst[len(lines) - 2]) / 2
    inward = (wrap.C + wrap.A * wrap.A.dot(mid_t - wrap.C) - mid_t).normalized()
    src.append(mid_s + bend * (0.03 / HAND_SCALE))
    dst.append(mid_t + inward * 0.03)
    # The knuckles count most: they are where the hand meets the gun. The wrist follows from the hand's own size.
    R, T, err = fit(src, dst, [1.0] * len(lines) + [0.05, 0.1, 1.0], HAND_SCALE)
    place = Matrix.Translation(T) @ R.to_4x4() @ Matrix.Scale(HAND_SCALE, 4)
    back = place.inverted()
    for n, line in zip(names, lines):
        pts = [back @ p for p in line]
        palm = bones[f"palm_{n}{X}"]
        aim(rig, palm, pts[0] - mw @ palm.head, math.radians(18))
        run = 0.0
        for k in ("01", "02", "03"):
            pb = bones[f"f_{n}.{k}{X}"]
            run += pb.bone.length
            reach(rig, pb, along(pts, run))
    bpy.context.view_layer.update()
    tips = []
    for n, line in zip(names, lines):
        span = sum(bones[f"f_{n}.{k}{X}"].bone.length for k in ("01", "02", "03")) * HAND_SCALE
        tips.append(round((place @ (mw @ bones[f"f_{n}.03{X}"].tail) - along(line, span)).length * 1000, 1))
    pts = [back @ p for p in thumb_line]
    root = bones["thumb.01" + X]
    aim(rig, root, pts[0] - mw @ root.head, math.radians(35))
    run = 0.0
    for k in ("02", "03"):
        pb = bones[f"thumb.{k}{X}"]
        run += pb.bone.length
        reach(rig, pb, along(pts, run))
    # The skin of this hand and of its arm, ARM_KEEP up from the wrist: the sculpt's own forearm and the start of its
    # upper arm, never a shape made in code. Straightened at the elbow first, in the sculpt's own place, so the arm
    # runs on back past the view instead of bending into it.
    fore_b = rig.data.bones["forearm" + X]
    wr = mw @ fore_b.tail_local
    up = (mw @ fore_b.head_local - wr).normalized()
    bw = body.matrix_world
    pts, elbow, f_way, u_way = arm_points(rig, body, side)
    keep = set(pts)
    open_ = f_way.angle(u_way)
    straighten = Quaternion(f_way.cross(u_way).normalized(), ELBOW - open_)
    # The wrist: the forearm turned from the hand's own forearm line towards `fore`, every point by its share of
    # the arm's weights (the hand stays where it holds, the forearm follows, the skin between bends).
    way0 = (place.to_3x3() @ up).normalized()
    at0 = place @ wr
    q = way0.rotation_difference(Vector(fore).normalized())
    need = q.angle
    if q.angle > WRIST_MAX:
        q = Quaternion(q.axis, WRIST_MAX)
    print(f"{name}: wrist turn needed {math.degrees(need):.0f} deg, used {math.degrees(q.angle):.0f}; elbow {math.degrees(open_):.0f} to {math.degrees(ELBOW):.0f} deg")
    u0, v0, u1, v1 = _arms["box"]
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    ev = body.evaluated_get(dg)
    me = ev.to_mesh()

    def posed(i):
        run, arm_w, up_w = pts[i]
        p = bw @ me.vertices[i].co
        if up_w > 0:
            p = elbow + Quaternion(straighten.axis, straighten.angle * up_w) @ (p - elbow)
        p = place @ p
        if arm_w > 0:
            p = at0 + Quaternion(q.axis, q.angle * arm_w) @ (p - at0)
        return p

    where = {i: posed(i) for i in sorted(keep)}
    faces = [p for p in me.polygons if all(i in keep for i in p.vertices)]
    bm = bmesh.new()
    run_l = bm.verts.layers.float.new("run")
    made = {}
    for i in sorted(keep):
        made[i] = bm.verts.new(where[i])
        made[i][run_l] = pts[i][0]
    # With the sculpt's flat layout, cut to the hands' corner of it: the painted glove lies on it (tools/gloves.py).
    uv = bm.loops.layers.uv.new("UVMap")
    for p in faces:
        f = bm.faces.new([made[i] for i in p.vertices])
        # The sleeve, and its edge tucked in under the cuff: the glove's painting ends at the wrist.
        f.material_index = 1 if any(pts[i][0] > SLEEVE_FROM for i in p.vertices) else 0
        for loop, li in zip(f.loops, p.loop_indices):
            c = gloves.uv_of(me, li)
            loop[uv].uv = (min(1.0, max(0.0, (c.x - u0) / (u1 - u0))), min(1.0, max(0.0, (c.y - v0) / (v1 - v0))))
    # The glove's cuff: the same skin from just over the wrist to under the sleeve's edge, a little proud of it, and
    # prouder still over the strap.
    cm = bmesh.new()
    cmade = {}
    for p in faces:
        if all(-0.012 <= pts[i][0] <= 0.055 for i in p.vertices):
            for i in p.vertices:
                if i not in cmade:
                    cmade[i] = cm.verts.new(where[i])
            cm.faces.new([cmade[i] for i in p.vertices])
    ev.to_mesh_clear()
    cm.normal_update()
    for i, v in cmade.items():
        r = pts[i][0]
        strap = min(1.0, max(0.0, (r - 0.005) / 0.003)) * min(1.0, max(0.0, (0.017 - r) / 0.003))
        v.co += v.normal * (0.0015 + 0.0022 * strap)
    cuff = mesh_obj(name + "Cuff", cm, [M["GloveTrim"]], smooth=True)
    # The sleeve: once finer, then the cloth over the forearm, a rolled edge where it starts, a little looser up
    # the arm, and folds 3 cm apart that wind a little round it (so they don't read as rings), shallower by the elbow.
    sleeve_faces = [f for f in bm.faces if f.material_index == 1 and all(v[run_l] < SLEEVE_FINE for v in f.verts)]
    edges = list({e for f in sleeve_faces for e in f.edges})
    bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True, smooth=1.0)
    bm.normal_update()
    axis = q @ way0
    e1 = axis.orthogonal().normalized()
    e2 = axis.cross(e1)
    centre = {}
    for v in bm.verts:
        r = v[run_l]
        if r <= SLEEVE_FROM:
            continue
        s = min(1.0, (r - SLEEVE_FROM) / (0.25 - SLEEVE_FROM))
        cloth = 0.005 + 0.002 * s + 0.002 * max(0.0, 1 - (r - SLEEVE_FROM) / 0.012)
        rel = v.co - at0
        a = math.atan2(rel.dot(e2), rel.dot(e1))  # the way round the arm
        fold = 0.0025 * (1 - 0.5 * min(1.0, (r - SLEEVE_FROM) / (0.235 - SLEEVE_FROM))) * 0.5 * (1 + math.cos(2 * math.pi * r / 0.03 + a))
        centre[v] = v.normal * (cloth + fold)
    for v, d in centre.items():
        v.co += d
    bm.verts.layers.float.remove(run_l)
    skin = mesh_obj(name + "Skin", bm, [M["Glove"], M["Sleeve"]], smooth=True)
    print(f"{name}: knuckles, wrist, thumb and palm off by {err} mm, fingertips by {tips} mm, {len(skin.data.polygons)} faces, cuff {len(cuff.data.polygons)}")
    return [skin, cuff]


def hand(name, wrap, fingers, palm, wrist, fore, thumb, index=None, knuckle=True, side=1):
    """A gloved hand round `wrap`: the sculpted hand (real_hand), posed. fingers: (t, deg0, step, length,
    radius, slope) per finger, the line each takes round the wrap, knuckle first; thumb and index: such
    lines given as points; wrist: about where the wrist is (the hand's own size decides, and the game
    turns the hand about this point); fore: the way the forearm goes from the wrist to the elbow, which
    leaves the view by its bottom edge. palm and knuckle are no longer used."""
    lines = [index[0]] if index else []
    lines += [wrap.curl(t, deg0, step, length, r * 0.95, slope) for (t, deg0, step, length, r, slope) in fingers]
    w = Vector(wrist)
    parts = real_hand(name, lines, thumb[0], wrist, side, wrap, fore)
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
                 [(0.034, 25, -1, 0.068, 0.0098, 0.0), (0.054, 27, -1, 0.063, 0.0094, 0.0), (0.073, 31, -1, 0.046, 0.0086, 0.0)],
                 [gw.at(0.022, 95, 0.004), gw.at(0.085, 100, 0.004), gw.at(0.022, 150, 0.004), gw.at(0.085, 150, 0.006),
                  gw.at(0.02, 200, 0.002), gw.at(0.07, 185, 0.004), gw.at(0.03, 95, 0.026), gw.at(0.07, 100, 0.026)],
                 (0.012, -0.075, -0.042), (0.45, -0.55, -0.7),
                 ([(-0.006, -0.026, -0.0), (-0.021, -0.008, 0.0015), (-0.0255, 0.016, 0.003), (-0.025, 0.040, 0.0035), (-0.023, 0.058, 0.004)], 0.0105),
                 ([gw.at(0.012, 60, 0.01), (0.021, 0.028, -0.011), (0.017, 0.044, -0.015), (0.009, 0.0475, -0.019), (0.004, 0.045, -0.022)], 0.0095))
    lw = Wrap((0, -0.0005, -0.006), (0, -0.017, -0.092), (0, 1, 0), 0.0245 + 0.016, 0.0148 + 0.017)
    left = hand("pistol_handL", lw,
                [(0.028, -53, 1, 0.09, 0.0098, 0.0), (0.051, -54, 1, 0.085, 0.0096, 0.0), (0.071, -59, 1, 0.075, 0.009, 0.0), (0.091, -69, 1, 0.055, 0.0084, 0.0)],
                [lw.at(0.03, -100, 0.0), lw.at(0.09, -105, 0.0), lw.at(0.03, -150, 0.0), lw.at(0.09, -150, 0.0),
                 lw.at(0.035, -110, 0.024), lw.at(0.085, -115, 0.024), (-0.05, -0.05, -0.02)],
                (-0.045, -0.072, -0.068), (-0.5, -0.5, -0.7),
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
    # The tube ends just inside the stock: right by the eye the game draws the stock's back flat at the camera's near
    # edge, and a tube end inside it would show through.
    body.append(lathe("tube", [(-0.10, 0.0145), (-0.21, 0.0145)], M["Dark"], 14, at=(0, 0, 0.046)))
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
    # Folding sights on the rail, folded down flat (the red-dot sight does the aiming): a front post
    # between its guards, a rear aperture, each lying back on its base.
    body.append(block("fbase", -0.009, 0.009, 0.405, 0.428, 0.0795, 0.087, M["Dark"], 0.001))
    for s in (-1, 1):
        body.append(block("fwing", s * 0.0075, s * 0.0045, 0.388, 0.405, 0.0795, 0.0855, M["Dark"], 0.0006))
    body.append(block("fpost", -0.0012, 0.0012, 0.392, 0.405, 0.0805, 0.0845, M["Dark"], 0.0003))
    body.append(block("rbase", -0.011, 0.011, -0.08, -0.058, 0.0795, 0.086, M["Dark"], 0.001))
    for s in (-1, 1):
        body.append(block("rear", s * 0.0075, s * 0.0028, -0.058, -0.038, 0.0795, 0.0845, M["Dark"], 0.0005))
    body.append(block("rear", -0.0075, 0.0075, -0.058, -0.0505, 0.0795, 0.0845, M["Dark"], 0.0004))
    body.append(block("rear", -0.0075, 0.0075, -0.0415, -0.038, 0.0795, 0.0845, M["Dark"], 0.0004))
    # A red-dot sight on the rail over the receiver: a clamp, a hooded frame, a window you look
    # through and the dot in its middle. A node of its own: the game takes it off for a found scope.
    # A large window (33 by 35 mm), and far enough back to fill a good part of the view when you aim: the
    # game can't hold the rifle nearer the eye than it does, or the camera cuts the receiver's back open.
    DOT = (0, 0.02, 0.108)
    optic = [block("oclamp", -0.0125, 0.0125, -0.030, 0.036, 0.0795, 0.0885, M["Dark"], 0.001),
             block("oknob", 0.0125, 0.018, -0.008, 0.012, 0.08, 0.088, M["Steel"], 0.001),
             block("odeck", -0.0187, 0.0187, -0.034, 0.038, 0.0885, 0.0905, M["Polymer"], 0.0008)]
    for s in (-1, 1):
        optic.append(prism("ohood", [(-0.034, 0.0905), (0.038, 0.0905), (0.038, 0.128), (0.006, 0.128), (-0.034, 0.106)], 0.0012, M["Polymer"], 0.0004, x=s * 0.0175))
    optic.append(prism("oroof", [(0.004, 0.1255), (0.038, 0.1255), (0.038, 0.128), (0.004, 0.128)], 0.0187, M["Polymer"], 0.0006))
    optic.append(block("owindow", -0.0163, 0.0163, 0.020, 0.0206, 0.0905, 0.1255, M["Lens"], 0))
    optic.append(disc("odot", 0.0009, M["RedDot"], (DOT[0], 0.0198, DOT[2]), -1, 10))
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
                 (0.012, -0.10, -0.035), (0.25, -0.82, -0.5),
                 ([(-0.006, -0.05, 0.004), (-0.02, -0.03, 0.012), (-0.024, -0.008, 0.02), (-0.023, 0.014, 0.026), (-0.02, 0.03, 0.029)], 0.0105),
                 ([gw.at(0.01, 72, 0.01), (0.02, 0.0, -0.004), (0.016, 0.014, -0.006), (0.009, 0.017, -0.008), (0.004, 0.015, -0.01)], 0.0095))
    hw = Wrap((0, 0.30, B), (0, 1, 0), (0, 0, -1), 0.0262, 0.0262)
    # Across the handguard the fingers lie one behind the other: the index the furthest forward.
    left = hand("rifle_handL", Wrap((0, 0.30, B), (0, -1, 0), (0, 0, -1), 0.0262, 0.0262),
                [(-0.03, 13, 1, 0.062, 0.0098, -0.6), (-0.009, 38, 1, 0.064, 0.0096, -0.6), (0.012, 50, 1, 0.058, 0.009, -0.6), (0.031, 59, 1, 0.048, 0.0084, -0.6)],
                [hw.at(-0.04, -10, 0.004), hw.at(0.04, -10, 0.004), hw.at(-0.04, 40, 0.004), hw.at(0.04, 40, 0.004),
                 hw.at(-0.03, 10, 0.026), hw.at(0.035, 10, 0.026), hw.at(0.0, 45, 0.02)],
                (-0.012, 0.225, B - 0.055), (-0.35, -0.5, -0.79),
                ([hw.at(-0.03, 40, 0.016), hw.at(0.0, 65, 0.012), hw.at(0.025, 80, 0.011), hw.at(0.048, 88, 0.011), hw.at(0.066, 92, 0.011)], 0.0108),
                side=-1)
    return finish(W, (0, -0.042, 0.006), body,
                  {"mag": (mag, (0, 0.068, 0.0), {"out": (0, 0.06, -1)}), "optic": (optic, (0, 0.0, 0.0795))},
                  (0, 0.566, B), DOT, kit, [right, left])


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
    # The knuckles well round to the front of the grip, the palm behind it, so the forearm can go down and back
    # (and stays low in the picture when you aim); the fingers no further round than the stock's left side: it is
    # deep there, they lie along it.
    gw = Wrap((0, -0.062, 0.028), (0, -0.04, -0.1), (0, 1, 0.25), 0.023, 0.0165)
    right = hand("shotgun_handR", gw,
                 [(0.03, 30, -1, 0.07, 0.0098, 0.0), (0.05, 34, -1, 0.07, 0.0094, 0.0), (0.069, 36, -1, 0.062, 0.0086, 0.0)],
                 [gw.at(0.018, 95, 0.004), gw.at(0.08, 100, 0.004), gw.at(0.018, 150, 0.004), gw.at(0.08, 150, 0.006),
                  gw.at(0.012, 200, 0.002), gw.at(0.065, 185, 0.004), gw.at(0.03, 95, 0.026), gw.at(0.07, 100, 0.026)],
                 (0.012, -0.135, 0.0), (0.28, -0.7, -0.66),
                 ([(-0.006, -0.085, 0.045), (-0.02, -0.064, 0.055), (-0.024, -0.042, 0.062), (-0.022, -0.02, 0.066), (-0.02, -0.002, 0.068)], 0.0105),
                 ([gw.at(0.008, 70, 0.01), (0.02, 0.012, 0.004), (0.015, 0.025, 0.0), (0.008, 0.028, -0.004), (0.003, 0.026, -0.006)], 0.0095))
    pw = Wrap((0, 0.39, 0.022), (0, -1, 0), (0, 0, -1), 0.0228, 0.0228 * 0.95)
    hw = Wrap((0, 0.39, 0.022), (0, 1, 0), (0, 0, -1), 0.0228, 0.0228)
    left = hand("shotgun_handL", pw,
                [(-0.03, 13, 1, 0.062, 0.0098, -0.6), (-0.009, 38, 1, 0.064, 0.0096, -0.6), (0.012, 50, 1, 0.058, 0.009, -0.6), (0.031, 59, 1, 0.048, 0.0084, -0.6)],
                [hw.at(-0.04, -10, 0.004), hw.at(0.04, -10, 0.004), hw.at(-0.04, 40, 0.004), hw.at(0.04, 40, 0.004),
                 hw.at(-0.03, 10, 0.026), hw.at(0.035, 10, 0.026), hw.at(0.0, 45, 0.02)],
                (-0.012, 0.315, 0.022 - 0.055), (-0.35, -0.5, -0.79),
                ([hw.at(-0.03, 40, 0.016), hw.at(0.0, 65, 0.012), hw.at(0.025, 80, 0.011), hw.at(0.048, 88, 0.011), hw.at(0.066, 92, 0.011)], 0.0108),
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
                 (0.012, -0.10, -0.03), (0.25, -0.82, -0.5),
                 ([(-0.006, -0.053, 0.006), (-0.02, -0.035, 0.015), (-0.024, -0.012, 0.024), (-0.023, 0.008, 0.03), (-0.02, 0.024, 0.033)], 0.0105),
                 ([gw.at(0.01, 72, 0.01), (0.02, 0.003, -0.004), (0.016, 0.018, -0.006), (0.009, 0.021, -0.008), (0.004, 0.019, -0.01)], 0.0095))
    fz = 0.026  # the fore-end's middle height
    pw = Wrap((0, 0.28, fz), (0, -1, 0), (0, 0, -1), 0.019, 0.0185)
    hw = Wrap((0, 0.28, fz), (0, 1, 0), (0, 0, -1), 0.019, 0.0185)
    left = hand("sniper_handL", pw,
                [(-0.03, 13, 1, 0.062, 0.0098, -0.6), (-0.009, 38, 1, 0.064, 0.0096, -0.6), (0.012, 50, 1, 0.058, 0.009, -0.6), (0.031, 59, 1, 0.048, 0.0084, -0.6)],
                [hw.at(-0.04, -10, 0.004), hw.at(0.04, -10, 0.004), hw.at(-0.04, 40, 0.004), hw.at(0.04, 40, 0.004),
                 hw.at(-0.03, 10, 0.026), hw.at(0.035, 10, 0.026), hw.at(0.0, 45, 0.02)],
                (-0.012, 0.205, fz - 0.052), (-0.35, -0.5, -0.79),
                ([hw.at(-0.03, 40, 0.016), hw.at(0.0, 65, 0.012), hw.at(0.025, 80, 0.011), hw.at(0.048, 88, 0.011), hw.at(0.066, 92, 0.011)], 0.0108),
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
                 (0.012, -0.085, -0.03), (0.25, -0.82, -0.5),
                 ([(-0.006, -0.04, 0.004), (-0.02, -0.022, 0.01), (-0.024, 0.0, 0.016), (-0.023, 0.02, 0.02), (-0.021, 0.036, 0.022)], 0.0105),
                 ([gw.at(0.01, 72, 0.01), (0.02, 0.012, -0.006), (0.016, 0.026, -0.008), (0.009, 0.029, -0.01), (0.004, 0.027, -0.012)], 0.0095))
    fw = Wrap((0, 0.332, T - 0.045), (0, -0.01, -1), (0, 1, 0), 0.016, 0.0145)
    left = hand("bazooka_handL", fw,
                [(0.012, -60, 1, 0.07, 0.0098, 0.0), (0.032, -60, 1, 0.07, 0.0096, 0.0), (0.052, -62, 1, 0.066, 0.009, 0.0), (0.07, -64, 1, 0.055, 0.0084, 0.0)],
                [fw.at(0.012, -95, 0.004), fw.at(0.075, -100, 0.004), fw.at(0.012, -150, 0.004), fw.at(0.075, -150, 0.006),
                 fw.at(0.02, -175, 0.004), fw.at(0.07, -175, 0.004), fw.at(0.03, -110, 0.026), fw.at(0.07, -115, 0.026)],
                (-0.03, 0.285, -0.035), (-0.35, -0.6, -0.72),
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


def bake_shade():
    """Each gun's own shading, stored per face corner in a colour the game reads (web/src/world/gunSurface.ts):
    red: how closed in the spot is (0 open, 1 deep in a crevice), from rays cast over the gun's own parts where
    they rest, so the seams, the ports and the gaps between parts are darker; green: 1 on the thin bevels of the
    hard edges, where paint and bluing wear off first (the game breaks that up into patches). The hands too, for
    the shade between the fingers and under the cuffs (no worn edges on them). Not Paintball's kit. The rays are a fixed set, so the file comes out the same every time."""
    from mathutils.bvhtree import BVHTree
    rays, reach = 24, 0.02
    dirs = []
    for i in range(rays):  # spread over the half sphere, more of them upright (cosine weighted)
        u, a = (i + 0.5) / rays, 2 * math.pi * ((i * 0.61803398875) % 1.0)
        dirs.append((math.sqrt(u) * math.cos(a), math.sqrt(u) * math.sin(a), math.sqrt(1 - u)))
    bpy.context.view_layer.update()
    for root in [o for o in bpy.data.objects if o.parent is None and o.type == "EMPTY"]:
        meshes = [o for o in root.children if o.type == "MESH" and not o.name.endswith("_kit")]
        hands = [h for e in root.children if e.type == "EMPTY" and e.name.endswith("_hands") for h in e.children if h.type == "MESH"]
        meshes += hands
        verts, polys = [], []
        for o in meshes:
            base = len(verts)
            verts += [o.matrix_world @ v.co for v in o.data.vertices]
            polys += [[base + i for i in p.vertices] for p in o.data.polygons]
        tree = BVHTree.FromPolygons(verts, polys)
        for o in meshes:
            me = o.data
            bm = bmesh.new()
            bm.from_mesh(me)
            worn = []
            for f in bm.faces:
                longest = max(e.calc_length() for e in f.edges)
                width = f.calc_area() / longest if longest > 0 else 1
                angles = [e.calc_face_angle_signed() for e in f.edges if len(e.link_faces) == 2]
                strip = width < 0.0032 and longest > 2.5 * width  # a bevel, or a side of a thin pin or tube
                worn.append(1.0 if strip and sum(a > math.radians(18) for a in angles) >= 2 and min(angles) > -0.02 else 0.0)
            bm.free()
            if o in hands:
                worn = [0.0] * len(worn)
            attr = me.color_attributes.new("shade", "FLOAT_COLOR", "CORNER")
            mw, rot = o.matrix_world, o.matrix_world.to_3x3()
            if o in hands:
                # Smooth shapes: one value per point (from its own normal), the same on every corner that shares
                # it, so no point is split in the file (per corner the hands tripled in size).
                per = {}
                for v in me.vertices:
                    n = (rot @ v.normal).normalized()
                    t = n.orthogonal().normalized()
                    b = n.cross(t)
                    start = mw @ v.co + n * 0.0006
                    closed = 0.0
                    for d in dirs:
                        hit = tree.ray_cast(start, t * d[0] + b * d[1] + n * d[2], reach)
                        if hit[0] is not None:
                            closed += 1 - hit[3] / reach
                    per[v.index] = min(1.0, closed / rays)
                for l in me.loops:
                    attr.data[l.index].color = (per[l.vertex_index], 0.0, 0.0, 1.0)
                me.color_attributes.active_color = attr
                me.color_attributes.render_color_index = me.color_attributes.find("shade")
                continue
            for p in me.polygons:
                n = (rot @ p.normal).normalized()
                t = n.orthogonal().normalized()
                b = n.cross(t)
                mid = mw @ p.center
                for li in p.loop_indices:
                    co = mw @ me.vertices[me.loops[li].vertex_index].co
                    start = co + (mid - co) * 0.08 + n * 0.0005  # just inside its own face, just off the surface
                    closed = 0.0
                    for d in dirs:
                        hit = tree.ray_cast(start, t * d[0] + b * d[1] + n * d[2], reach)
                        if hit[0] is not None:
                            closed += 1 - hit[3] / reach
                    attr.data[li].color = (min(1.0, closed / rays), worn[p.index], 0.0, 1.0)
            me.color_attributes.active_color = attr
            me.color_attributes.render_color_index = me.color_attributes.find("shade")


drop_arms()
bake_shade()

bpy.ops.object.select_all(action="SELECT")
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_extras=True, export_texcoords=True, export_cameras=False, export_lights=False,
                          export_vertex_color="ACTIVE", export_active_vertex_color_when_no_material=True)


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
            if "COLOR_0" in at:
                # The gun's baked shading (bake_shade): two bytes, under a name of its own so that nothing
                # takes it for a colour to paint the gun in.
                col = read(at["COLOR_0"]).astype(np.float64)
                col /= {5123: 65535.0, 5121: 255.0}.get(gl["accessors"][at["COLOR_0"]]["componentType"], 1.0)
                s4 = np.zeros((len(col), 4), np.uint8)
                s4[:, :2] = np.clip(np.round(col[:, :2] * 255), 0, 255).astype(np.uint8)
                new["_SHADE"] = put(s4, 5121, "VEC2", 34962, True, 4)
            if "TEXCOORD_0" in at and gl["materials"][prim["material"]]["name"] == "Glove":
                # The gloves' place in their painted pictures: two 16-bit numbers.
                uvs = read(at["TEXCOORD_0"]).astype(np.float64)
                new["TEXCOORD_0"] = put(np.clip(np.round(uvs * 65535), 0, 65535).astype(np.uint16), 5123, "VEC2", 34962, True, 4)
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
    clay = bpy.data.materials.new("Clay")
    clay.use_nodes = True
    clay.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.62, 0.6, 0.57, 1)
    clay.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.7
    # The painted glove on the hands, as in the game (tools/gloves.py writes it next to the model).
    paint = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "public", "models", "glove_color.webp")
    if os.path.exists(paint):
        nodes = M["Glove"].node_tree.nodes
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(paint)
        M["Glove"].node_tree.links.new(tex.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
    # From the player's eye, as the game draws it (weapon.ts): from the hip at 54 degrees (HIP, the grip a quarter
    # size, as far again), and aimed (the eye on the line of sight, the view narrowed by the gun's zoom).
    hip = {"pistol": (0.048, -0.04, -0.1), "rifle": (0.05, -0.045, -0.095), "shotgun": (0.05, -0.046, -0.095),
           "sniper": (0.05, -0.046, -0.095), "bazooka": (0.072, -0.048, -0.1)}
    ads = {"pistol": (0.5, 50.4), "rifle": (0.352, 46.8), "shotgun": (0.4, 57.6)}
    hip_far = math.tan(math.radians(36)) / math.tan(math.radians(27))
    for w, (mid, dist) in views.items():
        for name, r in roots.items():
            r.hide_render = name != w
            for c in r.children_recursive:
                c.hide_render = name != w or c.name.endswith("_kit")
        x, y, z = hip[w]
        eyes = [("hip_eye", Vector((-x / 0.25, z * hip_far / 0.25, -y / 0.25)), 54.0)]
        if w in ads:
            s = next(c for c in roots[w].children if c.name == w + "_sight").matrix_world.translation
            eyes.append(("ads_eye", Vector((s.x, -ads[w][0], s.z)), ads[w][1]))
        elif w == "bazooka":
            eyes.append(("ads_eye", Vector((-0.012 / 0.25, -0.1 / 0.25, 0.06 / 0.25)), 57.6))
        for label, at, deg in eyes:
            cam.location = at
            cam.rotation_euler = (math.radians(90), 0, 0)
            cam.data.sensor_fit = "VERTICAL"
            cam.data.angle_y = math.radians(deg)
            cam.data.clip_start = 0.07  # the game draws what lies past a third of its near edge (gunSurface.ts)
            scene.render.filepath = os.path.join(PREVIEW, f"{w}_{label}.png")
            bpy.ops.render.render(write_still=True)
        cam.data.sensor_fit = "AUTO"
        for label, at in (("left", (-dist, mid - 0.15 * dist, 0.2 * dist)), ("eye", (-0.18 * dist, -0.55 * dist, 0.25 * dist))):
            cam.location = Vector(at)
            target = Vector((0, mid, 0.0))
            cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
            cam.data.lens = 50
            scene.render.filepath = os.path.join(PREVIEW, f"{w}_{label}.png")
            bpy.ops.render.render(write_still=True)
        # The hands alone, close, in clay: from the shooter's side and from the left.
        hands = [c for c in roots[w].children_recursive if c.type == "MESH" and "_hand" in c.name]
        kept = [(h, [slot.material for slot in h.material_slots]) for h in hands]
        for h, _ in kept:
            for slot in h.material_slots:
                slot.material = clay
        for h in hands:
            # The hand itself: what lies within 13 cm of the wrist (the object's own origin), not the sleeve behind it.
            near = [h.matrix_world @ v.co for v in h.data.vertices if v.co.length < 0.13]
            centre = sum(near, Vector()) / max(1, len(near))
            for other in hands:
                other.hide_render = other is not h
            for label, off in (("back", Vector((-0.04, -0.5, 0.3))), ("left", Vector((-0.6, -0.05, 0.1))), ("right", Vector((0.6, -0.05, 0.1))),
                               ("front", Vector((0.1, 0.55, 0.15))), ("under", Vector((-0.1, -0.1, -0.6)))):
                cam.location = centre + off
                cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
                cam.data.lens = 85
                scene.render.filepath = os.path.join(PREVIEW, f"{h.name}_{label}.png")
                bpy.ops.render.render(write_still=True)
        for h, mats in kept:
            h.hide_render = False
            for slot, m in zip(h.material_slots, mats):
                slot.material = m
