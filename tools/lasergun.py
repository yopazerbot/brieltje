"""Build the laser rifle in Blender, with the gloved hands that hold it in first person.

Run (Blender 5, no window):
  blender -b -P tools/lasergun.py -- <out.glb> [preview_dir]
It writes the GLB (web/public/models/lasergun.glb in the repository); the game loads it beside weapons.glb.
With preview_dir it also renders small pictures there: each view once in clay (one grey material, to judge
the shapes) and once in the final materials, the player's views with the hands, and each hand alone in clay.

Our own design, no brand, maker or marking on it. A near-future tool held like the game's carbine,
84 cm long. It reads from back to front: the energy cell where a magazine would sit, the receiver that
holds the capacitor (the round housing on its left side, with the charge read-out above it), a power
junction on top with two armoured cables, the beam tube in the fore-end (a lit core inside a copper
coil, seen through three windows), the finned heat shroud with a collar on its face, and the ringed
emitter with its lens deep inside (dark glass, a lit point behind it). A skeleton stock with a cheek
rest, a ribbed rubber butt pad, a hinge at the receiver and a sling loop; a slim eight-sided sight on two
clamps. Bevelled edges, a few materials, no textures, under 18 000 triangles.

Frame in the GLB, as tools/weapons.py: the barrel along -z, up +y, right +x, metres, the origin where
the web of the right hand sits on the grip. Nodes:
  laser             the weapon (an empty at the origin)
    laser_body      the parts that never move
    laser_cell      the energy cell, which leaves the gun to reload; extras "out": the way it leaves
                    (unit, the GLB's frame), as the magazines have
    laser_muzzle    where the beam leaves (the emitter's front face, on the bore's axis)
    laser_sight     a point on the line of sight (the sight's reticle)
    laser_hands     first person only, as in weapons.glb:
      laser_handR, laser_handL   glove, cuff and sleeve; each origin at its wrist; extras "grip": where it
                                 holds, from the wrist
The lit parts have materials of their own, so the game can light them: LaserLens (the lit point behind the
emitter's glass), LaserGlow (the beam tube's core, the cell's windows and charge marks), LaserBar0 to
LaserBar4 (the charge read-out's five bars, back to front: the game lights as many as the cell has charge)
and LaserReticle (the sight's dot); LaserGlass is the emitter's dark glass. LaserFin is the shroud's fins
(bright metal that glows as the gun heats up and vents). LaserAccent is the one accent colour: the copper
coil, the selector, the cell's latch, a band on the emitter. The two big surfaces have names of their own,
LaserAnodised (the dark, glossy upper, shroud, emitter and sight) and LaserPolymer (the paler, matt lower,
grip, handguard, stock and cell), each with its finish in the game (web/src/world/gunSurface.ts). The small
parts carry the names tools/weapons.py uses (Steel, Dark, Grip, Lens), so that finish takes them as it does
for the other guns; the shading per corner it reads is baked here the same way (bake_shade).
The hands are fitted by tools/weapons.py's own helper (real_hand: the sculpted arms posed on the grip and the
handguard), read from that file as it is, so both files' hands are made the same way and weapons.glb stays as it is.
Inside Blender the barrel runs along +y and up is +z; the exporter turns that into the above.
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
scene = bpy.context.scene


def srgb(h):
    """'#rrggbb' to linear RGB, as the Principled BSDF (and glTF) expect."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def material(name, color, rough=0.5, metal=0.0, alpha=1.0, glow="", strength=1.0):
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
        p.inputs["Emission Strength"].default_value = strength
    m.use_backface_culling = True
    return m


# The shared names take the game's finish for them (gunSurface.ts LOOKS); the colours here are that finish.
# The two big surfaces have names of their own, so the split between them shows: a dark, glossy anodised
# upper against a paler, matt polymer (the game's finish has no entry for them yet; it keeps these values).
# The emissive strengths stay small: the game keeps everything in half-float targets and adds its own bloom.
M = {
    "Anod": material("LaserAnodised", "#23272e", 0.2, 0.9),     # the upper, the shroud, the emitter, the sight
    "Steel": material("Steel", "#4d5056", 0.3, 1.0),            # bright metal: the capacitor, fins, ferrules, knobs, the trigger
    "Dark": material("Dark", "#2a2c30", 0.42, 0.7),             # rails, the bore, small hardware, the stock's joint
    "Polymer": material("LaserPolymer", "#35373a", 0.82, 0.0),  # lower receiver, grip, handguard, stock, the cell's body
    "Grip": material("Grip", "#202123", 0.88, 0.0),             # rubber: grip panels, pads, the butt pad, the cables' sleeves
    "Lens": material("Lens", "#7fa6b4", 0.05, 0.0, alpha=0.16),  # the sight's window: you look through it
    "LaserAccent": material("LaserAccent", "#b4642c", 0.32, 0.9),  # anodised copper: the coil, selector, latch, a band
    "LaserGlass": material("LaserGlass", "#0a1c26", 0.03, 0.0, alpha=0.5),  # the emitter's lens: dark glass you see into
    "LaserLens": material("LaserLens", "#0b2a36", 0.3, 0.0, glow="#3fc8ff", strength=4.0),  # the lit point deep behind it
    "LaserGlow": material("LaserGlow", "#5fd4ff", 0.3, 0.0, glow="#52ccff", strength=2.0),
    "LaserReticle": material("LaserReticle", "#06141a", 0.5, 0.0, glow="#7fe8ff", strength=3.0),
    "Fin": material("LaserFin", "#4d5056", 0.3, 1.0),  # the shroud's fins: the game makes them glow with the heat
    # The hands' materials, as tools/weapons.py makes them (the game finds them by these names).
    "Glove": material("Glove", "#26272a", 0.82, 0.0),
    "GloveTrim": material("GloveTrim", "#23251f", 0.8, 0.0),
    "Sleeve": material("Sleeve", "#4b4c3b", 0.9, 0.0),
}
for _k in range(5):  # the read-out's bars, each its own so the game can light them one by one
    M[f"Bar{_k}"] = material(f"LaserBar{_k}", "#5fd4ff", 0.3, 0.0, glow="#52ccff", strength=2.0)


def link(obj):
    scene.collection.objects.link(obj)
    return obj


def mesh_obj(name, bm, mats):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    return link(bpy.data.objects.new(name, me))


def apply_mod(obj, kind, **props):
    mod = obj.modifiers.new(kind.lower(), kind)
    for k, v in props.items():
        setattr(mod, k, v)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)


def shade(obj, angle=35):
    """Smooth faces, hard edges past `angle`: round parts look round, flats stay flat."""
    for p in obj.data.polygons:
        p.use_smooth = True
    obj.data.set_sharp_from_angle(angle=math.radians(angle))
    return obj


def bevel(obj, width, segments=2, angle=35):
    """Bevel the hard edges; the flats keep normals square to them (harden), so the bevels catch the light
    in a clean line and the faces beside them don't smear."""
    shade(obj)
    if width > 0:
        apply_mod(obj, "BEVEL", width=width, segments=segments, limit_method="ANGLE", angle_limit=math.radians(angle),
                  harden_normals=True)
    return obj


def cut(obj, cutters):
    """Cut the cutters (closed shapes) out of obj one by one (cutters that overlap each other would confuse a
    single cut), then throw them away. The faces a cut makes take obj's own material, or the dark finish for
    a cutter marked with dark() (the inside of a window, a vent, a seam)."""
    for c in cutters:
        if not c.get("dark"):
            c.data.materials[0] = obj.data.materials[0]
        apply_mod(obj, "BOOLEAN", operation="DIFFERENCE", object=c, solver="EXACT", material_mode="TRANSFER")
        bpy.data.objects.remove(c, do_unlink=True)
    if cutters and not obj.data.polygons:
        raise RuntimeError(f"{obj.name}: the cuts left nothing")
    return obj


# ---- Shapes ----------------------------------------------------------------------------------

def prism(name, pts, half, mat, bev=0.0012, seg=2, x=0.0, cuts=None):
    """A side profile (points (y, z), either winding) pushed out sideways: `half` the half-width, a number
    or a function of y. Centred on `x`. `cuts`: shapes cut out of it before the bevel."""
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
    o = mesh_obj(name, bm, [mat])
    cut(o, cuts or [])
    return bevel(o, bev, seg)


def block(name, x0, x1, y0, y1, z0, z1, mat, bev=0.0008, seg=1):
    return prism(name, [(y0, z0), (y1, z0), (y1, z1), (y0, z1)], (x1 - x0) / 2, mat, bev, seg, x=(x0 + x1) / 2)


def box(x0, x1, y0, y1, z0, z1):
    """A plain box to cut with."""
    return prism("cutbox", [(y0, z0), (y1, z0), (y1, z1), (y0, z1)], (x1 - x0) / 2, M["Dark"], 0, x=(x0 + x1) / 2)


def dark(o):
    """Mark a cutter: the faces it cuts get the dark finish."""
    o["dark"] = 1
    return o


def rbox(cx, cz, w, h, y0, y1, ang):
    """A box to cut with, w across (x) and h high (z), centred on (cx, cz), turned by `ang` round the barrel's axis."""
    o = prism("cutbox", [(y0, cz - h / 2), (y1, cz - h / 2), (y1, cz + h / 2), (y0, cz + h / 2)], w / 2, M["Dark"], 0, x=cx)
    o.data.transform(Matrix.Translation((cx, 0, cz)) @ Matrix.Rotation(ang, 4, "Y") @ Matrix.Translation((-cx, 0, -cz)))
    return o


def zbox(cx, cy, w, d, z0, z1, ang):
    """A box to cut with, w across (x) and d long (y), centred on (cx, cy), turned by `ang` round the upright."""
    o = prism("cutbox", [(cy - d / 2, z0), (cy + d / 2, z0), (cy + d / 2, z1), (cy - d / 2, z1)], w / 2, M["Dark"], 0, x=cx)
    o.data.transform(Matrix.Translation((cx, cy, 0)) @ Matrix.Rotation(ang, 4, "Z") @ Matrix.Translation((-cx, -cy, 0)))
    return o


def chamfers(half, ztop, zbot, top, bot, y0, y1):
    """Cutters that chamfer the long edges of a part `half` wide between zbot and ztop: `top` and `bot` the
    chamfers' legs on the upper and lower edges (0: none). A part reads far less like a box with them."""
    out = []
    for s in (-1, 1):
        for c, z in ((top, ztop), (bot, zbot)):
            if c > 0:
                out.append(rbox(s * half, z, c * math.sqrt(2), c * math.sqrt(2), y0, y1, math.radians(45)))
    return out


def lathe(name, prof, mats, sides=24, at=(0.0, 0.0, 0.0), axis="y", turn=0.0, seg_mat=None, smooth_angle=35, loop=False):
    """Turn a profile [(t, r), ...] round an axis through `at` ('y' along the barrel, 'x' across, 'z' up).
    The solid lies to the right of the profile as it is walked (walk the outside from back to front, the
    inside from front to back), and each face is turned to face away from it. A point with r = 0 closes the
    surface there; `loop` joins the last point back to the first (a tube with a wall). `seg_mat`: the
    material index of each step of the profile (all 0 without)."""
    if loop:
        prof = list(prof) + [prof[0]]
    ax = {"y": (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))),
          "x": (Vector((0, 1, 0)), Vector((1, 0, 0)), Vector((0, 0, 1))),
          "z": (Vector((1, 0, 0)), Vector((0, 0, 1)), Vector((0, 1, 0)))}[axis]
    U, A, V = ax
    c0 = Vector(at)
    bm = bmesh.new()
    rings = []
    for i, (t, r) in enumerate(prof):
        if loop and i == len(prof) - 1:
            rings.append(rings[0])
            continue
        if r <= 0:
            rings.append([bm.verts.new(c0 + A * t)])
            continue
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides + turn
            ring.append(bm.verts.new(c0 + A * t + (U * math.cos(a) + V * math.sin(a)) * r))
        rings.append(ring)
    for i, (ra, rb) in enumerate(zip(rings, rings[1:])):
        (t0, r0), (t1, r1) = prof[i], prof[i + 1]
        dt, dr = t1 - t0, r1 - r0
        for k in range(sides):
            if len(ra) == 1 and len(rb) == 1:
                continue
            if len(ra) == 1:
                f = bm.faces.new((ra[0], rb[k], rb[(k + 1) % sides]))
            elif len(rb) == 1:
                f = bm.faces.new((ra[k], ra[(k + 1) % sides], rb[0]))
            else:
                f = bm.faces.new((ra[k], ra[(k + 1) % sides], rb[(k + 1) % sides], rb[k]))
            a = 2 * math.pi * (k + 0.5) / sides + turn
            radial = U * math.cos(a) + V * math.sin(a)
            want = A * (-dr) + radial * dt  # the profile's step turned a quarter: away from the solid
            f.normal_update()
            if f.normal.dot(want) < 0:
                f.normal_flip()
            if seg_mat:
                f.material_index = seg_mat[i]
    o = mesh_obj(name, bm, mats if isinstance(mats, list) else [mats])
    return shade(o, smooth_angle)


def ring(name, t0, t1, r, mat, at, sides=24, axis="y", chamfer=0.0004):
    """A short closed cylinder with chamfered ends: a band, a collar, a screw head."""
    c = min(chamfer, (t1 - t0) / 3, r / 3)
    if c <= 0:
        return lathe(name, [(t0, 0), (t0, r), (t1, r), (t1, 0)], mat, sides, at, axis)
    return lathe(name, [(t0, 0), (t0, r - c), (t0 + c, r), (t1 - c, r), (t1, r - c), (t1, 0)], mat, sides, at, axis)


def sweep(name, pts, radii, mat, sides=8):
    """A tube along a centre line with a radius per point, closed at both ends: cables, the coil."""
    pts = [Vector(p) for p in pts]
    n = len(pts)
    tang = [(pts[min(n - 1, i + 1)] - pts[max(0, i - 1)]).normalized() for i in range(n)]
    up = Vector((0, 0, 1)) if abs(tang[0].z) < 0.9 else Vector((1, 0, 0))
    normal = tang[0].cross(up).normalized()
    frames = []
    for i in range(n):
        if i:
            axis = tang[i - 1].cross(tang[i])
            if axis.length > 1e-6:
                normal = (Matrix.Rotation(tang[i - 1].angle(tang[i]), 3, axis.normalized()) @ normal).normalized()
        frames.append((normal.copy(), tang[i].cross(normal).normalized()))
    bm = bmesh.new()
    rings = [[bm.verts.new(c + (f[0] * math.cos(2 * math.pi * k / sides) + f[1] * math.sin(2 * math.pi * k / sides)) * r)
              for k in range(sides)] for c, r, f in zip(pts, radii, frames)]
    for a, b in zip(rings, rings[1:]):
        for k in range(sides):
            bm.faces.new((a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k]))
    bm.faces.new(rings[-1])
    bm.faces.new(list(reversed(rings[0])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, [mat])
    return shade(o, 60)


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


def pivot(obj, at):
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


def screw(x, y, z, s, r=0.0021):
    """A socket-head screw on a side face at x (s: which side, -1 left, +1 right), its head standing 1 mm proud."""
    h = 0.0011 * s
    return lathe("screw", [(0, 0), (0, r), (h, r * 0.8), (h, 0)] if s > 0 else [(h, 0), (h, r * 0.8), (0, r), (0, 0)], M["Dark"], 6, (x, y, z), "x")


# ---- The laser rifle -------------------------------------------------------------------------
# Drawn in its own design frame, then moved so the grip point (the web of the right hand) is the origin.
# The grip, the trigger group and the receiver's lower line are the carbine's (tools/weapons.py), so the
# carbine's hands fit them.

B = 0.058   # the beam's axis: the tube, the bore, the lens
GRIP = Vector((0, -0.042, 0.006))
SIGHT = Vector((0, 0.036, 0.1125))
body = []

SLANT = 0.375  # the design's one slant: windows, fins and vents lean forward by this much per unit of height

# The upper: anodised metal from the stock to the shroud. The receiver's part, and over the handguard a wider part
# that starts in a slanted shoulder and holds the beam tube behind three slanted windows. Long top edges chamfered,
# a groove along each side of the receiver, slanted vents on its right, a slanted panel seam on each side.
CAP = (-0.0145, 0, 0.053)  # the capacitor's axis
upper_cuts = [dark(box(s * 0.0165 - 0.004, s * 0.0165 + 0.004, -0.088, 0.128, 0.0335, 0.0365)) for s in (-1, 1)]
upper_cuts += chamfers(0.0165, 0.080, 0.030, 0.0040, 0.0, -0.2, 0.2)
upper_cuts.append(dark(lathe("cradle", [(-0.087, 0), (-0.087, 0.0113), (0.066, 0.0113), (0.066, 0)], M["Dark"], 20, CAP)))
for k in range(4):
    y = 0.0 + k * 0.014
    upper_cuts.append(dark(prism("vent", [(y, 0.043), (y + 0.006, 0.043), (y + 0.006 + 0.022 * SLANT, 0.065), (y + 0.022 * SLANT, 0.065)], 0.003, M["Dark"], 0,
                                 x=0.0165)))
for s in (-1, 1):  # panel seams, 1 mm wide and deep: one behind the capacitor, one ahead of the read-out's end
    for y0 in (-0.100, 0.104):
        upper_cuts.append(dark(prism("seam", [(y0, 0.029), (y0 + 0.001, 0.029), (y0 + 0.001 + 0.052 * SLANT, 0.081), (y0 + 0.052 * SLANT, 0.081)], 0.001,
                                     M["Dark"], 0, x=s * 0.0165)))
body.append(prism("upper", [(-0.112, 0.030), (0.152, 0.030), (0.152, 0.080), (-0.104, 0.080), (-0.112, 0.073)], 0.0165, M["Anod"], 0.0016, 2,
                  cuts=upper_cuts))
fore_cuts = chamfers(0.023, 0.080, 0.044, 0.0048, 0.0, 0.1, 0.35)
for y0, y1 in ((0.175, 0.203), (0.211, 0.239), (0.247, 0.275)):
    fore_cuts.append(dark(prism("win", [(y0, 0.0495), (y1, 0.0495), (y1 + 0.023 * SLANT, 0.0725), (y0 + 0.023 * SLANT, 0.0725)], 0.05, M["Dark"], 0)))
body.append(prism("upperfore", [(0.140, 0.044), (0.300, 0.044), (0.300, 0.080), (0.140 + 0.036 * SLANT, 0.080)], 0.023, M["Anod"], 0.0016, 1,
                  cuts=fore_cuts))
# The capacitor on the left side (the side the player sees): a long round housing in a cradle cut into the
# receiver, its end cap and three bands; above it the charge read-out, five lit bars in a dark frame.
body.append(lathe("capacitor", [(-0.080, 0), (-0.080, 0.0084), (-0.0785, 0.0101), (0.058, 0.0101), (0.0595, 0.0084), (0.0595, 0)],
                  M["Steel"], 20, CAP))
for y in (-0.062, -0.012, 0.038):
    body.append(ring("cband", y, y + 0.0045, 0.0107, M["Dark"], CAP, 20, chamfer=0))
body.append(ring("ccap", -0.085, -0.080, 0.0072, M["Dark"], CAP, 16))
body.append(block("readframe", -0.0178, -0.0150, -0.072, -0.018, 0.0655, 0.0755, M["Dark"], 0.0006))
for k in range(5):
    y = -0.0685 + k * 0.0097
    body.append(prism("readbar", [(y, 0.0675), (y + 0.0062, 0.0675), (y + 0.0062 + 0.006 * SLANT, 0.0735), (y + 0.006 * SLANT, 0.0735)], 0.0007,
                      M[f"Bar{k}"], 0.0002, 1, x=-0.0179))
for y, z in ((-0.095, 0.072), (0.150, 0.072), (0.150, 0.041), (-0.095, 0.041)):
    body.append(screw(0.0165, y, z, 1))
for y, z in ((-0.095, 0.072), (0.150, 0.072), (0.072, 0.0715), (0.094, 0.0715), (0.072, 0.041), (0.094, 0.041), (0.150, 0.041)):
    body.append(screw(-0.0165, y, z, -1))

# Lower receiver with the cell's well and its flared lip; the grip, trigger guard and trigger.
body.append(prism("lower", [(-0.095, 0.03), (0.166, 0.03), (0.166, 0.022), (0.114, 0.0), (0.114, -0.03), (0.108, -0.036),
                            (0.036, -0.036), (0.032, -0.03), (0.032, 0.0), (-0.004, 0.0), (-0.06, 0.004), (-0.095, 0.012)], 0.0155, M["Polymer"], 0.0022, 2,
                  cuts=[prism("inset", [(0.042, 0.004), (0.100, 0.004), (0.100 + 0.019 * SLANT, 0.024), (0.042 + 0.019 * SLANT, 0.024)], 0.0008, M["Dark"], 0,
                              x=s * 0.0155) for s in (-1, 1)]))
body.append(prism("lip", [(0.029, -0.027), (0.117, -0.027), (0.119, -0.039), (0.027, -0.039)], 0.0172, M["Polymer"], 0.0018, 2,
                  cuts=[box(-0.0138, 0.0138, 0.037, 0.112, -0.05, -0.02)]))


def trigger_guard(name, y0, y1, ztop, zbot, half, t=0.004):
    pts = [(y0 - 0.006, ztop - 0.012), (y0, zbot + 0.004), (y0 + 0.006, zbot), (y1 - 0.006, zbot), (y1, zbot + 0.006), (y1, ztop),
           (y1 - t, ztop), (y1 - t, zbot + t + 0.003), (y1 - t - 0.004, zbot + t), (y0 + 0.007, zbot + t), (y0 + t, zbot + t + 0.004), (y0 - 0.006 + t, ztop - 0.012)]
    return prism(name, pts, half, M["Polymer"], 0.0008, 1)


body.append(trigger_guard("guard", -0.004, 0.03, 0.002, -0.026, 0.006))
body.append(prism("trigger", [(0.016, 0.0), (0.019, -0.008), (0.016, -0.016), (0.012, -0.016), (0.015, -0.008), (0.012, 0.0)], 0.003, M["Steel"], 0.0005, 1))
grip = [(-0.004, 0.002), (-0.012, -0.03), (-0.022, -0.065), (-0.03, -0.105), (-0.07, -0.108), (-0.068, -0.08), (-0.058, -0.04),
        (-0.048, -0.008), (-0.05, 0.004)]
body.append(prism("grip", grip, 0.0145, M["Polymer"], 0.003, 2))
body.append(prism("panel", [(-0.012, -0.02), (-0.025, -0.095), (-0.063, -0.097), (-0.052, -0.02)], 0.015, M["Grip"], 0.0008, 2))
# The selector, both sides, in the accent colour, on a round boss.
for s in (-1, 1):
    body.append(ring("selboss", *((0.0, 0.001) if s > 0 else (-0.001, 0.0)), 0.0048, M["Dark"], (s * 0.0155, -0.03, 0.019), 14, "x"))
    body.append(prism("selector", [(-0.031, 0.016), (-0.012, 0.0205), (-0.011, 0.0245), (-0.031, 0.0235)], 0.0009, M["LaserAccent"], 0.0004, 1,
                      x=s * 0.0172))

# Skeleton stock, 2 cm shorter than the carbine's so the weight sits forward: a slim top bar with a rubber cheek
# rest, a strut down to the toe, a butt bar with three slanted lightening slots, a ribbed rubber butt pad, a
# sling loop under the toe. At the receiver a dark joint block with a hinge on the right (its knuckles and pin)
# and a screw on the left. Each bar is recessed 1 mm on both sides inside a rim, as a moulded beam is.
SH = 0.0135  # the stock's half width
body.append(block("joint", -0.0165, 0.0165, -0.124, -0.106, 0.024, 0.076, M["Dark"], 0.0018, 2))
for z0, z1 in ((0.026, 0.040), (0.060, 0.074)):
    body.append(ring("knuckle", z0, z1, 0.0052, M["Dark"], (0.0168, -0.115, 0), 16, "z", 0.0006))
body.append(ring("hingepin", 0.022, 0.078, 0.0028, M["Steel"], (0.0168, -0.115, 0), 12, "z", 0.0005))
body.append(screw(-0.0165, -0.115, 0.050, -1, 0.0026))
lo = lambda y: 0.016 + 0.4455 * (y + 0.108)    # the strut's lower edge
hi = lambda y: lo(y) + 0.020                   # its upper edge (the hole's)
hole = [(-0.146, 0.062), (-0.299, 0.062), (-0.306, 0.055), (-0.306, hi(-0.306) + 0.005), (-0.300, hi(-0.300)), (-0.146, hi(-0.146)),
        (-0.140, hi(-0.140) + 0.007), (-0.140, 0.056)]
stock_cuts = [prism("cuthole", hole, 0.05, M["Dark"], 0)]
for z0 in (-0.050, -0.018, 0.014):  # lightening slots through the butt bar, in the design's slant
    stock_cuts.append(prism("slot", [(-0.331, z0), (-0.3255, z0), (-0.3255 + 0.022 * SLANT, z0 + 0.022), (-0.331 + 0.022 * SLANT, z0 + 0.022)], 0.05, M["Dark"], 0))
for s in (-1, 1):
    for pts in ([(-0.150, 0.0655), (-0.296, 0.0655), (-0.296, 0.0745), (-0.150, 0.0745)],
                [(-0.168, lo(-0.168) + 0.005), (-0.284, lo(-0.284) + 0.005), (-0.284, hi(-0.284) - 0.005), (-0.168, hi(-0.168) - 0.005)]):
        stock_cuts.append(prism("inset", pts, 0.001, M["Dark"], 0, x=s * SH))
body.append(prism("stock", [(-0.108, 0.078), (-0.330, 0.078), (-0.338, 0.071), (-0.338, -0.066), (-0.331, -0.074), (-0.310, -0.074),
                            (-0.108, 0.016)], SH, M["Polymer"], 0.0028, 2, cuts=stock_cuts))
body.append(prism("cheek", [(-0.172, 0.0772), (-0.300, 0.0772), (-0.300, 0.0815), (-0.292, 0.0848), (-0.205, 0.0848), (-0.172 - 0.006, 0.0812)],
                  0.0118, M["Grip"], 0.0014, 1,  # three slanted grooves across its top, where the player looks down on it
                  cuts=[dark(zbox(0, y, 0.032, 0.0014, 0.0838, 0.09, math.radians(-22))) for y in (-0.264, -0.246, -0.228)]))
body.append(prism("pad", [(-0.3375, 0.0765), (-0.3500, 0.0750), (-0.3530, 0.0650), (-0.3530, -0.0640), (-0.3500, -0.0740), (-0.3375, -0.0770)], 0.0160,
                  M["Grip"], 0.0025, 1, cuts=[dark(box(-0.02, 0.02, -0.356, -0.3515, z, z + 0.0028)) for z in (-0.044, -0.018, 0.008, 0.034)]))
loop_pts = [(0, -0.286 + 0.0075 * math.sin(2 * math.pi * k / 16), lo(-0.286) - 0.0068 - 0.0075 * math.cos(2 * math.pi * k / 16)) for k in range(17)]
body.append(sweep("sling", loop_pts, [0.0016] * len(loop_pts), M["Steel"], 6))
body.append(block("slingbase", -0.006, 0.006, -0.296, -0.276, lo(-0.276) - 0.004, lo(-0.276) + 0.002, M["Dark"], 0.001, 1))

# The rail over the receiver, and the sight on it: a clamp, a deck, a hood with a window, the dot.
rail = [block("rail", -0.0105, 0.0105, -0.098, 0.100, 0.080, 0.084, M["Dark"], 0.0005, 1)]
y = -0.095
while y + 0.005 < 0.100:
    rail.append(block("rail", -0.0105, 0.0105, y, y + 0.0052, 0.084, 0.0875, M["Dark"], 0))
    y += 0.010
body += rail
# The sight: a base plate on the rail held by two clamps (each with its bolt on the right), a riser, and a slim
# eight-sided tube with a bright bezel at each end, a sunshade over its front in the design's slant, an
# adjustment turret on top and a battery cap on the left. The window you look through sits near its front,
# the lit dot on it.
SZ = SIGHT.z
body.append(block("obase", -0.0112, 0.0112, -0.016, 0.046, 0.0875, 0.0905, M["Dark"], 0.0008, 1))
for y0 in (-0.013, 0.032):
    body.append(block("oclamp", -0.0138, 0.0138, y0, y0 + 0.011, 0.0815, 0.0925, M["Dark"], 0.0012, 2))
    body.append(ring("obolt", 0.0, 0.0032, 0.0029, M["Steel"], (0.0138, y0 + 0.0055, 0.0868), 12, "x", 0.0005))
body.append(prism("oriser", [(-0.008, 0.0905), (0.040, 0.0905), (0.040, 0.0965), (0.034, SZ - 0.0150), (-0.002, SZ - 0.0150), (-0.008, 0.0965)],
                  0.0085, M["Anod"], 0.0012, 2))
OT = (0, 0, SZ)
body.append(lathe("otube", [(-0.012, 0.0158), (-0.012, 0.0176), (0.044, 0.0176), (0.044, 0.0158)], M["Anod"], 8, OT, turn=math.pi / 8, loop=True))
for t0 in (-0.0135, 0.0425):
    body.append(lathe("obezel", [(t0, 0.0156), (t0, 0.0181), (t0 + 0.0030, 0.0181), (t0 + 0.0030, 0.0156)], M["Steel"], 8, OT, turn=math.pi / 8, loop=True))
body.append(prism("oshade", [(0.030, SZ + 0.0150), (0.046, SZ + 0.0150), (0.046 + 0.006 * SLANT, SZ + 0.0190), (0.030, SZ + 0.0190)], 0.0105, M["Anod"], 0.0008, 1))
body.append(ring("oturret", SZ + 0.0150, SZ + 0.0215, 0.0050, M["Steel"], (0, 0.012, 0), 16, "z", 0.0008))
body.append(ring("ocap", -0.0215, -0.0150, 0.0048, M["Steel"], (0, 0.014, SZ - 0.002), 16, "x", 0.0008))
body.append(lathe("owindow", [(SIGHT.y, 0), (SIGHT.y, 0.0157), (SIGHT.y + 0.0006, 0.0157), (SIGHT.y + 0.0006, 0)], M["Lens"], 8, OT, turn=math.pi / 8))
body.append(lathe("odot", [(0.0, 0), (0.0, 0.0008), (0.0003, 0)], M["LaserReticle"], 10, (SIGHT.x, SIGHT.y - 0.0001, SIGHT.z)))
# The power junction on the receiver's top, ahead of the rail: two armoured cables run from it along the
# fore-end's top, a few millimetres clear of it, into the shroud: rubber sleeves, metal ferrules, a clamp halfway.
CZ = 0.0900  # the cables' axis height
body.append(prism("junction", [(0.104, 0.080), (0.142, 0.080), (0.142, 0.0965), (0.112, 0.0965), (0.104, 0.090)], 0.0185, M["Dark"], 0.0014, 2,
                  cuts=chamfers(0.0185, 0.0965, 0.080, 0.0035, 0, 0.09, 0.15)))
body.append(screw(0.0185, 0.123, 0.0862, 1, 0.0018))
body.append(screw(-0.0185, 0.123, 0.0862, -1, 0.0018))
sag = lambda y: CZ - 0.0012 * math.sin(math.pi * (y - 0.150) / 0.138)
for s in (-1, 1):
    x = s * 0.0118
    n = 10
    pts = [(x, 0.150 + 0.138 * i / n, sag(0.150 + 0.138 * i / n)) for i in range(n + 1)]
    body.append(sweep("cable", pts, [0.0045] * len(pts), M["Grip"], 8))
    body.append(ring("ferrule", 0.141, 0.153, 0.0057, M["Steel"], (x, 0, CZ), 12))
    body.append(ring("ferrule", 0.2865, 0.2985, 0.0057, M["Steel"], (x, 0, CZ), 12))
    for y in (0.1545, 0.2830):
        body.append(lathe("crimp", [(y, 0), (y, 0.0051), (y + 0.0018, 0.0051), (y + 0.0018, 0)], M["Dark"], 9, (x, 0, sag(y))))
body.append(block("clamp", -0.0186, 0.0186, 0.215, 0.225, sag(0.22) - 0.0052, sag(0.22) + 0.0052, M["Dark"], 0.0014, 2))
body.append(block("clamppost", -0.004, 0.004, 0.2165, 0.2235, 0.081, sag(0.22) - 0.004, M["Dark"], 0.0006, 1))
body.append(block("spine", -0.0050, 0.0050, 0.168, 0.296, 0.0795, 0.0830, M["Dark"], 0.0008, 1))

# The handguard: polymer under the upper, the part the left hand holds, chamfered underneath, a hand stop at its
# front, rubber pads on its sides. In the upper over it, the beam tube: a lit core in a copper coil.
body.append(prism("fore", [(0.150, 0.030), (0.160, 0.016), (0.270, 0.016), (0.281, 0.005), (0.295, 0.005), (0.300, 0.016),
                           (0.300, 0.0445), (0.150, 0.0445)], 0.0222, M["Polymer"], 0.0018, 2,
                  cuts=chamfers(0.0222, 0.0445, 0.016, 0.0, 0.0075, 0.1, 0.271)))
for s in (-1, 1):
    body.append(prism("forepad", [(0.180, 0.0255), (0.262, 0.0255), (0.266, 0.0285), (0.266, 0.041), (0.262, 0.044), (0.180, 0.044), (0.176, 0.041), (0.176, 0.0285)],
                      0.0012, M["Grip"], 0.0005, 1, x=s * 0.0222))
    for y in (0.168, 0.291):
        body.append(screw(s * 0.0222, y, 0.030, s))
body.append(lathe("core", [(0.162, 0), (0.162, 0.0040), (0.298, 0.0040), (0.298, 0)], M["LaserGlow"], 12, (0, 0, B)))
turns, per = 10, 8
coil = []
for i in range(turns * per + 1):
    a = 2 * math.pi * i / per
    yy = 0.172 + (0.290 - 0.172) * i / (turns * per)
    coil.append((0.0074 * math.cos(a), yy, B + 0.0074 * math.sin(a)))
body.append(sweep("coil", coil, [0.00125] * len(coil), M["LaserAccent"], 5))

# The heat shroud: anodised metal, a wedge underneath, a little narrower to the front, its long edges and its
# front corners chamfered wide. Open on both sides in one slanted window and slotted on top; inside, slanted
# fins round the beam's core tube, set 5 mm back from the sides so the window's edges throw shadow on them.
SHW = lambda y: 0.027 - 0.0025 * (y - 0.298) / 0.12  # the shroud's half width
shroud_cuts = [dark(prism("win", [(0.310, 0.030), (0.366, 0.030), (0.366 + 0.046 * SLANT, 0.076), (0.310 + 0.046 * SLANT, 0.076)], 0.05, M["Dark"], 0))]
shroud_cuts += [dark(box(x - 0.0028, x + 0.0028, 0.318, 0.382, 0.07, 0.12)) for x in (-0.0095, 0.0, 0.0095)]
shroud_cuts += chamfers(0.027, 0.093, 0.010, 0.0110, 0.0080, 0.28, 0.44)
shroud_cuts += [zbox(s * SHW(0.418), 0.418, 0.007 * math.sqrt(2), 0.007 * math.sqrt(2), 0.0, 0.12, math.radians(45)) for s in (-1, 1)]
body.append(prism("shroud", [(0.298, 0.010), (0.348, 0.010), (0.418, 0.029), (0.418, 0.087), (0.404, 0.094), (0.298, 0.096)],
                  SHW, M["Anod"], 0.0020, 2, cuts=shroud_cuts))
body.append(lathe("shcore", [(0.300, 0), (0.300, 0.0115), (0.418, 0.0115), (0.418, 0)], M["Dark"], 20, (0, 0, B)))
for k in range(9):
    y = 0.3075 + k * 0.0074
    body.append(prism("fin", [(y, 0.024), (y + 0.0024, 0.024), (y + 0.0024 + 0.060 * SLANT, 0.084), (y + 0.060 * SLANT, 0.084)], 0.0226,
                      M["Fin"], 0.0005, 1))
for s in (-1, 1):
    body.append(screw(s * SHW(0.304), 0.304, 0.020, s))
    body.append(screw(s * SHW(0.402), 0.402, 0.062, s))
# A collar round the emitter on the shroud's face: a dark flange, then a bright lip.
body.append(lathe("collar", [(0.4170, 0), (0.4170, 0.0236), (0.4196, 0.0236), (0.4212, 0.0222), (0.4226, 0.0222), (0.4226, 0)], M["Dark"], 36, (0, 0, B)))
body.append(ring("collarlip", 0.4224, 0.4246, 0.0204, M["Steel"], (0, 0, B), 36, chamfer=0.0005))

# The emitter: a dark neck out of the collar, two grooves, a copper band, a body that flares a little to its
# crown (48 sides: it reads round close up). Inside, the bore (32 sides) steps down in four focusing rings to the
# lens 3 cm deep: dark glass in a bright retaining ring, and behind the glass the lit point the beam comes from.
EM = [(0.416, 0), (0.416, 0.0180), (0.4255, 0.0180), (0.4255, 0.0212), (0.4275, 0.0220),
      (0.4330, 0.0220), (0.4330, 0.0209), (0.4355, 0.0209), (0.4355, 0.0220),
      (0.4420, 0.0220), (0.4420, 0.0224), (0.4460, 0.0224), (0.4460, 0.0220), (0.4700, 0.0233), (0.4820, 0.0244), (0.4860, 0.0238), (0.4885, 0.0220),
      (0.4885, 0.0190)]
EMM = [1, 1, 0, 0, 0, 1, 1, 1, 0, 2, 2, 2, 0, 0, 0, 0, 0]  # per step: 0 anodised, 1 dark, 2 the copper band
BORE = [(0.4885, 0.0190), (0.4810, 0.0190), (0.4810, 0.0163), (0.4735, 0.0163), (0.4735, 0.0136), (0.4660, 0.0136), (0.4660, 0.0110),
        (0.4520, 0.0110), (0.4520, 0)]
BOREM = [1, 0, 1, 0, 1, 0, 1, 1]  # walls dark, the focusing rings' faces bright
MUZZLE = (0, 0.4885, B)
body.append(lathe("emitter", EM, [M["Anod"], M["Dark"], M["LaserAccent"]], 40, (0, 0, B), seg_mat=EMM))
body.append(lathe("bore", BORE, [M["Steel"], M["Dark"]], 32, (0, 0, B), seg_mat=BOREM))
body.append(lathe("lensring", [(0.4586, 0.0093), (0.4586, 0.0110), (0.4600, 0.0110), (0.4600, 0.0093)], M["Steel"], 32, (0, 0, B), loop=True))
body.append(lathe("lens", [(0.4588, 0.0094), (0.4600, 0.0086), (0.4610, 0.0066), (0.4616, 0.0034), (0.4618, 0)], M["LaserGlass"], 32, (0, 0, B),
                  smooth_angle=80))
body.append(lathe("lenspoint", [(0.4522, 0), (0.4522, 0.0036), (0.4542, 0.0040), (0.4560, 0.0026), (0.4567, 0)], M["LaserLens"], 16, (0, 0, B),
                  smooth_angle=80))

# The energy cell: a squat polymer block raked a little forward, a metal collar where it leaves the well, its
# latch in the accent colour, a lit window on each side and four charge marks on its back, a rubber base.
yf = lambda z: 0.1055 + (0.026 - z) * (0.008 / 0.124)  # its front edge at height z
yr = lambda z: 0.0385 + (0.026 - z) * (0.008 / 0.124)  # its back edge
cell = []
cell.append(prism("cell", [(yf(0.026), 0.026), (yf(-0.098), -0.098), (yf(-0.098) - 0.003, -0.1015), (yr(-0.098) + 0.003, -0.1015), (yr(-0.098), -0.098),
                           (yr(0.026), 0.026)], 0.0134, M["Polymer"], 0.0025, 2,
                  cuts=[dark(box(s * 0.0134 - 0.003, s * 0.0134 + 0.003, 0.0655, 0.0775, -0.088, -0.054)) for s in (-1, 1)]))
cell.append(prism("cellcollar", [(yr(-0.040) - 0.0008, -0.040), (yf(-0.040) + 0.0008, -0.040), (yf(-0.0475) + 0.0008, -0.0475), (yr(-0.0475) - 0.0008, -0.0475)],
                  0.0142, M["Steel"], 0.0008, 1))
for s in (-1, 1):
    cell.append(block("cellglow", s * 0.0118 - 0.0012, s * 0.0118 + 0.0012, 0.0665, 0.0765, -0.087, -0.055, M["LaserGlow"], 0.0003, 1))
for k in range(4):
    z = -0.056 - k * 0.0098
    cell.append(block("cellmark", -0.0042, 0.0042, yr(z) - 0.0009, yr(z) + 0.002, z - 0.0052, z, M["LaserGlow"], 0.0003, 1))
cell.append(prism("latch", [(yf(-0.050) - 0.001, -0.050), (yf(-0.050) + 0.0035, -0.050), (yf(-0.064) + 0.0035, -0.064), (yf(-0.064) - 0.001, -0.064)],
                  0.0075, M["LaserAccent"], 0.0008, 1))
cell.append(prism("cellbase", [(yf(-0.096) + 0.0012, -0.096), (yf(-0.108) + 0.002, -0.108), (yf(-0.108) - 0.002, -0.1125), (yr(-0.108) + 0.002, -0.1125),
                               (yr(-0.108) - 0.002, -0.108), (yr(-0.096) - 0.0012, -0.096)], 0.0150, M["Grip"], 0.003, 2))

# ---- The hands -------------------------------------------------------------------------------
# tools/weapons.py's hands (its "Hands" part: the sculpted arms, real_hand and hand), read from that file and run
# here with the few helpers it uses, so the laser's hands are fitted exactly as the other guns' are, and weapons.py
# and weapons.glb stay as they are. That part needs these names; mesh_obj with its `smooth`.
def weapons_hands():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "weapons.py")
    src = open(path, encoding="utf-8").read()
    part = src[src.index("# ---- Hands ---"):src.index("# ---- The weapons ---")]

    def mesh_obj_smooth(name, bm, mats, smooth=False):
        o = mesh_obj(name, bm, mats)
        if smooth:
            for p in o.data.polygons:
                p.use_smooth = True
        return o

    ns = {"__file__": path, "__name__": "weapons_hands", "math": math, "os": os, "sys": sys, "bmesh": bmesh, "bpy": bpy,
          "Matrix": Matrix, "Quaternion": Quaternion, "Vector": Vector, "M": M, "link": link, "mesh_obj": mesh_obj_smooth,
          "join": join, "pivot": pivot, "gl": gl}
    exec(compile(part, path, "exec"), ns)
    return ns


H = weapons_hands()
# The right hand round the grip, its web at GRIP (the origin in the GLB): the carbine's grip, trigger and lower line,
# so the carbine's hand (tools/weapons.py build_rifle), its thumb 4 mm further out over this wider lower and the
# selector. The left hand under the handguard, palm up, the middle of the palm under (0, 0.225, 0.016) behind the hand
# stop, the fingers up the right side over the rubber pad, the thumb along the left; its forearm goes down and out
# to the left, clear of the energy cell under the receiver.
gw = H["Wrap"]((0, -0.027, -0.001), (0, -0.026, -0.1), (0, 1, 0), 0.0215, 0.0148)
handR = H["hand"]("laser_handR", gw,
                  [(0.034, 70, -1, 0.09, 0.0098, 0.0), (0.054, 72, -1, 0.086, 0.0094, 0.0), (0.073, 76, -1, 0.07, 0.0086, 0.0)],
                  [], (0.012, -0.10, -0.035), (0.25, -0.82, -0.5),
                  ([(-0.006, -0.05, 0.004), (-0.024, -0.03, 0.012), (-0.028, -0.008, 0.02), (-0.027, 0.014, 0.026), (-0.024, 0.03, 0.029)], 0.0105),
                  ([gw.at(0.01, 72, 0.01), (0.02, 0.0, -0.004), (0.016, 0.014, -0.006), (0.009, 0.017, -0.008), (0.004, 0.015, -0.01)], 0.0095))
LC = (0, 0.225, 0.046)  # the left hand's wrap: the handguard and the upper over it, 3 cm down to the bottom, 23 mm to a side
LR1, LR2 = 0.030, 0.0232
hw = H["Wrap"](LC, (0, 1, 0), (0, 0, -1), LR1, LR2)
handL = H["hand"]("laser_handL", H["Wrap"](LC, (0, -1, 0), (0, 0, -1), LR1, LR2),
                  [(-0.03, 13, 1, 0.062, 0.0098, -0.6), (-0.009, 38, 1, 0.064, 0.0096, -0.6), (0.012, 50, 1, 0.058, 0.009, -0.6),
                   (0.031, 59, 1, 0.048, 0.0084, -0.6)],
                  [], (-0.012, LC[1] - 0.075, LC[2] - 0.059), (-0.45, -0.3, -0.84),
                  ([hw.at(-0.03, 40, 0.016), hw.at(0.0, 65, 0.012), hw.at(0.025, 80, 0.011), hw.at(0.048, 88, 0.011), hw.at(0.066, 92, 0.011)], 0.0108),
                  side=-1)


def finish():
    g = GRIP
    sizes = {}
    for o in body + cell:
        o.data.calc_loop_triangles()
        sizes[o.name.split(".")[0]] = sizes.get(o.name.split(".")[0], 0) + len(o.data.loop_triangles)
    print("largest parts:", sorted(sizes.items(), key=lambda kv: -kv[1])[:12])
    b = join("laser_body", body)
    c = join("laser_cell", cell)
    piv = Vector((0, 0.075, 0.0))
    pivot(c, piv)
    c["out"] = gl(Vector((0, 0.065, -1)).normalized())
    objs = [b, c, empty("laser_muzzle", MUZZLE), empty("laser_sight", SIGHT)]
    for o in objs:
        o.location -= g
    hand_root = empty("laser_hands", (0, 0, 0))  # as tools/weapons.py finish(): the hands under their own node
    for h in (handR, handL):
        h.location -= g
        h.parent = hand_root
    objs.append(hand_root)
    root = empty("laser", (0, 0, 0))
    for o in objs:
        o.parent = root
    tris = 0
    for o in [*objs, handR, handL]:
        if o.type == "MESH":
            o.data.calc_loop_triangles()
            if o not in (handR, handL):
                tris += len(o.data.loop_triangles)
            print(f"{o.name}: {len(o.data.loop_triangles)} triangles")
    print(f"laser: gun {tris} triangles")
    return root


ROOT = finish()
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "guns"))
__import__("farcopy").far(ROOT)  # the light copy the others' figures and the pickups use (tools/guns/farcopy.py)


def bake_shade():
    """The gun's own shading per face corner, as tools/weapons.py bakes it for the other guns (gunSurface.ts reads it):
    red: how closed in the spot is, from a fixed set of rays over the gun's own parts; green: 1 on the thin bevels of the
    hard edges, where the finish wears first."""
    from mathutils.bvhtree import BVHTree
    rays, reach = 24, 0.02
    dirs = []
    for i in range(rays):
        u, a = (i + 0.5) / rays, 2 * math.pi * ((i * 0.61803398875) % 1.0)
        dirs.append((math.sqrt(u) * math.cos(a), math.sqrt(u) * math.sin(a), math.sqrt(1 - u)))
    bpy.context.view_layer.update()
    hands = [h for e in ROOT.children if e.name == "laser_hands" for h in e.children if h.type == "MESH"]
    meshes = [o for o in ROOT.children if o.type == "MESH"] + hands
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
            strip = width < 0.0032 and longest > 2.5 * width
            worn.append(1.0 if strip and angles and sum(a > math.radians(18) for a in angles) >= 2 and min(angles) > -0.02 else 0.0)
        bm.free()
        attr = me.color_attributes.new("shade", "FLOAT_COLOR", "CORNER")
        mw, rot = o.matrix_world, o.matrix_world.to_3x3()
        if o in hands:
            # As tools/weapons.py bakes the hands: one value per point from its own normal (no point split in the file),
            # the shade between the fingers and under the cuffs, no worn edges.
            per = {}
            for v in me.vertices:
                n = (rot @ v.normal).normalized()
                t = n.orthogonal().normalized()
                bi = n.cross(t)
                start = mw @ v.co + n * 0.0006
                closed = 0.0
                for d in dirs:
                    hit = tree.ray_cast(start, t * d[0] + bi * d[1] + n * d[2], reach)
                    if hit[0] is not None:
                        closed += 1 - hit[3] / reach
                per[v.index] = min(1.0, closed / rays)
            for lp in me.loops:
                attr.data[lp.index].color = (per[lp.vertex_index], 0.0, 0.0, 1.0)
            me.color_attributes.active_color = attr
            me.color_attributes.render_color_index = me.color_attributes.find("shade")
            continue
        for p in me.polygons:
            n = (rot @ p.normal).normalized()
            t = n.orthogonal().normalized()
            bi = n.cross(t)
            mid = mw @ p.center
            for li in p.loop_indices:
                co = mw @ me.vertices[me.loops[li].vertex_index].co
                start = co + (mid - co) * 0.08 + n * 0.0005
                closed = 0.0
                for d in dirs:
                    hit = tree.ray_cast(start, t * d[0] + bi * d[1] + n * d[2], reach)
                    if hit[0] is not None:
                        closed += 1 - hit[3] / reach
                # In steps of 1/32: neighbouring corners that come out alike share one point in the file (it stays small).
                attr.data[li].color = (round(min(1.0, closed / rays) * 32) / 32, worn[p.index], 0.0, 1.0)
        me.color_attributes.active_color = attr
        me.color_attributes.render_color_index = me.color_attributes.find("shade")


H["drop_arms"]()  # the sculpt out again before the bake and the export
bake_shade()

bpy.ops.object.select_all(action="SELECT")
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_extras=True, export_texcoords=True, export_cameras=False, export_lights=False,
                          export_vertex_color="ACTIVE", export_active_vertex_color_when_no_material=True)


def pack(path):
    """Make the GLB small, as tools/weapons.py does: positions as 16-bit integers (KHR_mesh_quantization), normals
    as signed bytes, the baked shading as two bytes (_SHADE), 16-bit indices."""
    import json
    import struct
    import numpy as np
    raw = open(path, "rb").read()
    jlen = struct.unpack("<I", raw[12:16])[0]
    g = json.loads(raw[20:20 + jlen])
    bin_ = raw[20 + jlen + 8:]
    comps = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
    dtypes = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}

    def read(i):
        a = g["accessors"][i]
        bv = g["bufferViews"][a["bufferView"]]
        dt = np.dtype(dtypes[a["componentType"]])
        c = comps[a["type"]]
        start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = bv.get("byteStride", dt.itemsize * c)
        return np.ndarray((a["count"], c), dtype=dt, buffer=bin_, offset=start, strides=(stride, dt.itemsize)).copy()

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

    for mesh in g["meshes"]:
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
                col = read(at["COLOR_0"]).astype(np.float64)
                col /= {5123: 65535.0, 5121: 255.0}.get(g["accessors"][at["COLOR_0"]]["componentType"], 1.0)
                s4 = np.zeros((len(col), 4), np.uint8)
                s4[:, :2] = np.clip(np.round(col[:, :2] * 255), 0, 255).astype(np.uint8)
                new["_SHADE"] = put(s4, 5121, "VEC2", 34962, True, 4)
            if "TEXCOORD_0" in at and g["materials"][prim["material"]]["name"] == "Glove":
                # The gloves' place in their painted pictures, as in weapons.glb: two 16-bit numbers.
                uvs = read(at["TEXCOORD_0"]).astype(np.float64)
                new["TEXCOORD_0"] = put(np.clip(np.round(uvs * 65535), 0, 65535).astype(np.uint16), 5123, "VEC2", 34962, True, 4)
            idx = read(prim["indices"]).reshape(-1)
            assert idx.max() < 65536, f"{mesh['name']} has too many points for 16-bit indices"
            prim["indices"] = put(idx.astype(np.uint16), 5123, "SCALAR", 34963)
            prim["attributes"] = new
    g["accessors"], g["bufferViews"] = accs, views
    g["buffers"] = [{"byteLength": len(out)}]
    for k in ("extensionsUsed", "extensionsRequired"):
        g[k] = sorted(set(g.get(k, [])) | {"KHR_mesh_quantization"})
    js = json.dumps(g, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    while len(out) % 4:
        out.append(0)
    glb = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(out)) + struct.pack("<II", len(js), 0x4E4F534A) + js + \
        struct.pack("<II", len(out), 0x004E4942) + bytes(out)
    open(path, "wb").write(glb)


pack(OUT)
print("written", OUT, os.path.getsize(OUT), "bytes")

# ---- Preview renders -------------------------------------------------------------------------
# Each view twice: in clay (one grey material, the shapes alone) and in the final materials. A studio: a sky
# that fades to a dark floor (for the metal to mirror), a soft key light above, a fill and a rim.
if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    try:
        scene.eevee.taa_render_samples = 32
        scene.eevee.use_raytracing = True
    except AttributeError:
        pass
    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    nt = world.node_tree
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.46
    ramp.color_ramp.elements[0].color = (0.02, 0.02, 0.022, 1)
    ramp.color_ramp.elements[1].position = 0.80
    ramp.color_ramp.elements[1].color = (0.30, 0.32, 0.35, 1)
    band = ramp.color_ramp.elements.new(0.53)  # a bright band just over the horizon, for the metal to mirror
    band.color = (0.9, 0.92, 0.95, 1)
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = -1, 1
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], ramp.inputs["Fac"])
    # The camera itself sees a plain dark grey backdrop; the band is only for what the gun mirrors.
    path = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    a_in, b_in = [i for i in mix.inputs if i.type == "RGBA"][:2]
    out = [o for o in mix.outputs if o.type == "RGBA"][0]
    b_in.default_value = (0.055, 0.058, 0.063, 1)
    nt.links.new(path.outputs["Is Camera Ray"], mix.inputs[0])
    nt.links.new(ramp.outputs["Color"], a_in)
    nt.links.new(out, nt.nodes["Background"].inputs["Color"])
    scene.world = world

    C = Vector((0, 0.095, 0.0))  # about the middle of the gun, in the GLB's place (grip at the origin)

    def light(name, kind, at, energy, size=0.0, target=C):
        d = bpy.data.lights.new(name, kind)
        d.energy = energy
        if kind == "AREA":
            d.size = size
        o = link(bpy.data.objects.new(name, d))
        o.location = Vector(at)
        o.rotation_euler = (target - o.location).to_track_quat("-Z", "Y").to_euler()
        return o

    light("key", "AREA", C + Vector((-0.6, 0.4, 1.4)), 120, 1.2)
    light("key2", "AREA", C + Vector((0.6, 0.2, 1.3)), 70, 1.0)
    light("rim", "AREA", C + Vector((0.0, -1.4, 0.5)), 60, 0.8)
    light("fill", "AREA", C + Vector((0.0, 1.4, -0.2)), 25, 1.0)
    cam = link(bpy.data.objects.new("cam", bpy.data.cameras.new("cam")))
    scene.camera = cam

    def look(at, target, lens=50, roll=None):
        cam.location = Vector(at)
        cam.data.sensor_fit = "AUTO"
        cam.data.lens = lens
        cam.data.clip_start = 0.01
        cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()
        if roll is not None:
            cam.rotation_euler = roll

    muzzle = Vector(MUZZLE) - GRIP
    views = [
        ("left", lambda: look(C + Vector((-1.45, 0, 0.04)), C)),
        ("right", lambda: look(C + Vector((1.45, 0, 0.04)), C)),
        ("front34", lambda: look(C + Vector((-0.80, 1.00, 0.38)), C + Vector((0, 0.02, 0)))),
        ("rear34", lambda: look(C + Vector((-0.80, -1.05, 0.45)), C)),
        ("top", lambda: look(C + Vector((0, 0, 1.55)), C, 50, (0, 0, math.radians(90)))),
        ("emitter", lambda: look(muzzle + Vector((-0.075, 0.21, 0.045)), muzzle + Vector((0, -0.05, 0)), 50)),
        ("cellgrip", lambda: look(Vector((-0.42, 0.02, 0.02)), Vector((0, 0.065, -0.045)), 50)),
    ]
    # As the player sees it from the hip (weapon.ts and tools/weapons.py: the carbine's place, the grip a quarter
    # size as far again, 54 degrees high).
    hx, hy, hz = 0.05, -0.045, -0.095
    hip_far = math.tan(math.radians(36)) / math.tan(math.radians(27))

    def hip():
        cam.location = Vector((-hx / 0.25, hz * hip_far / 0.25, -hy / 0.25))
        cam.rotation_euler = (math.radians(90), 0, 0)
        cam.data.sensor_fit = "VERTICAL"
        cam.data.angle_y = math.radians(54)
        cam.data.clip_start = 0.07
    views.append(("hip_eye", hip))

    def ads():  # aimed, as the carbine is (tools/weapons.py): the eye on the line of sight, 0.352 behind the grip
        s = Vector(SIGHT) - GRIP
        cam.location = Vector((s.x, -0.352, s.z))
        cam.rotation_euler = (math.radians(90), 0, 0)
        cam.data.sensor_fit = "VERTICAL"
        cam.data.angle_y = math.radians(46.8)
        cam.data.clip_start = 0.07
    views.append(("ads_eye", ads))

    clay = bpy.data.materials.new("Clay")
    clay.use_nodes = True
    clay.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.54, 0.52, 1)
    clay.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.65
    meshes = [o for o in ROOT.children if o.type == "MESH"]
    kept = {o.name: [s.material for s in o.material_slots] for o in meshes}
    # The painted glove on the hands, as in the game (tools/gloves.py writes it next to the model).
    paint = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "public", "models", "glove_color.webp")
    if os.path.exists(paint):
        nodes = M["Glove"].node_tree.nodes
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(paint)
        M["Glove"].node_tree.links.new(tex.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
    hands = [handR, handL]
    for mode in ("clay", "final"):
        for o in meshes:
            for s, m in zip(o.material_slots, kept[o.name]):
                s.material = clay if mode == "clay" else m
        for label, setup in views:
            setup()
            for h in hands:  # the hands in the player's views only
                h.hide_render = label not in ("hip_eye", "ads_eye")
            scene.render.filepath = os.path.join(PREVIEW, f"laser_{mode}_{label}.png")
            bpy.ops.render.render(write_still=True)
    # Each hand alone and close, in clay: from the shooter's side, from the left, from below.
    kept_h = [(h, [s.material for s in h.material_slots]) for h in hands]
    for h, _ in kept_h:
        for s in h.material_slots:
            s.material = clay
    for h in hands:
        near = [h.matrix_world @ v.co for v in h.data.vertices if v.co.length < 0.13]
        centre = sum(near, Vector()) / max(1, len(near))
        for other in hands:
            other.hide_render = other is not h
        for label, off in (("back", Vector((-0.04, -0.5, 0.3))), ("left", Vector((-0.6, -0.05, 0.1))), ("right", Vector((0.6, -0.05, 0.1))),
                           ("under", Vector((-0.1, -0.1, -0.6)))):
            look(centre + off, centre, 85)
            scene.render.filepath = os.path.join(PREVIEW, f"{h.name}_{label}.png")
            bpy.ops.render.render(write_still=True)
    for h, mats in kept_h:
        for s, m in zip(h.material_slots, mats):
            s.material = m
    print("previews in", PREVIEW)
