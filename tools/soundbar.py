"""Build the living room's soundbar (like a white Sonos Arc, wall-mounted) in Blender.

Run (Blender 5, no window):
  blender -b -P tools/soundbar.py -- <out.glb> [preview_dir]

Our own model from the published size and product photos (used only to compare):
114.2 x 8.7 x 11.6 cm (W x H x D). The bar is lofted from one cross-section along its
length: rounded at the front and bottom, a flat smooth band on top, a flat back for the
wall. Towards each end the section shrinks to the middle of the back, which rounds the
ends off like the real bar's. The perforated grille (front, ends, bottom) is a matte
material of its own; the top band carries the touch controls (volume down, play/pause,
volume up) as small marks and the status light. A slim wall bracket holds the bar about
2 cm off the wall. No logos or text.

Output: one GLB with one mesh (Soundbar). The origin is at the wall, behind the middle of
the bar and at its vertical centre; the front faces +z in the GLB (Blender -Y).
With preview_dir it also renders front three-quarter, side, front and close-up views there.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

L, H, D = 1.142, 0.087, 0.116
GAP = 0.020        # wall to the back of the bar: the bracket
END = 0.05         # length over which each end rounds off
N = 64             # points around the cross-section


def material(name, color, rough=0.5, metal=0.0, emit=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    m.use_backface_culling = True  # exported single-sided
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1)
        p.inputs["Emission Strength"].default_value = strength
    return m


def srgb(h):
    """'#rrggbb' to linear RGB, as the Principled BSDF (and glTF) expect."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def modify(obj, kind, **props):
    mod = obj.modifiers.new(kind.lower(), kind)
    for k, v in props.items():
        setattr(mod, k, v)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)
    return obj


def from_bmesh(name, bm, mats, recalc=True):
    if recalc:  # closed parts; the flat marks are wound to face up
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    return link(bpy.data.objects.new(name, me))


def box(name, x0, x1, y0, y1, z0, z1, mat, round_=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector(((x0 + x1) / 2 + v.co.x * (x1 - x0), (y0 + y1) / 2 + v.co.y * (y1 - y0), (z0 + z1) / 2 + v.co.z * (z1 - z0)))
    obj = from_bmesh(name, bm, [mat])
    if round_:
        modify(obj, "BEVEL", width=round_, segments=2, limit_method="ANGLE", angle_limit=math.radians(40))
    return obj


bpy.ops.wm.read_factory_settings(use_empty=True)
MAT = {
    "White": material("White", srgb("#f2f2f0"), 0.6),
    "Grille": material("Grille", srgb("#e8e8e5"), 0.75),
    "Bracket": material("Bracket", srgb("#e0e0de"), 0.5),
    "Controls": material("Controls", srgb("#c4c4c1"), 0.45),
    "StatusLight": material("StatusLight", (0.9, 0.9, 0.88), 0.3, emit=(1.0, 1.0, 0.95), strength=1.0),
}
ORDER = list(MAT)


# ---- Cross-section (d forward from the bar's back, h up from its centre), by the angle t
# round it from the front: a squarish ellipse at the front, nearly square at the back so
# the back is flat against the bracket. The smooth part runs from the top band's front
# edge over the back to the bottom's back edge; a fine groove marks where the grille starts.
BAND = (math.radians(66.5), math.radians(240.0))
GROOVE = 0.0007


def profile(t):
    c, s = math.cos(t), math.sin(t)
    n = 2.3 if c >= 0 else 6.0
    return Vector((D / 2 + D / 2 * math.copysign(abs(c) ** (2 / n), c), (H / 2 - 0.0001) * math.copysign(abs(s) ** (2 / n), s)))


def section():
    """Points round the section, and for each the material of the segment after it."""
    ts = [2 * math.pi * k / N for k in range(N)]
    ts = [t for t in ts if min(abs(t - b) for b in BAND) > 0.03] + [b + o for b in BAND for o in (-0.012, 0.0, 0.012)]
    pts = []
    for t in sorted(ts):
        p = profile(t)
        if t in BAND:
            p += (Vector((D / 2, 0)) - p).normalized() * GROOVE
        pts.append(p)
    ts = sorted(ts)
    mats = ["White" if BAND[0] <= (t0 + t1) / 2 <= BAND[1] else "Grille" for t0, t1 in zip(ts, ts[1:] + [2 * math.pi])]
    return [(p.x, p.y) for p in pts], mats


SECTION, SECTION_MAT = section()
NS = len(SECTION)


# ---- Body: stations along the bar; each end shrinks to a point in the middle of the back.
ends = [0.0015, 0.005, 0.0105, 0.018, 0.027, 0.037, END]
xs = [-(L / 2 - e) for e in ends] + [L / 2 - e for e in reversed(ends)]


def shrink(x):
    e = min(L / 2 - abs(x), END) / END
    return (1 - (1 - e) ** 2.2) ** (1 / 2.2)


bm = bmesh.new()
rings = []
for x in xs:
    s = shrink(x)
    rings.append([bm.verts.new((x, -GAP - d * s, h * s)) for d, h in SECTION])
for a, b in zip(rings, rings[1:]):
    for k in range(NS):
        bm.faces.new((a[k], a[(k + 1) % NS], b[(k + 1) % NS], b[k])).material_index = ORDER.index(SECTION_MAT[k])
for ring, x in ((rings[0], -L / 2), (rings[-1], L / 2)):
    pole = bm.verts.new((x, -GAP, 0.0))
    for k in range(NS):
        bm.faces.new((ring[k], ring[(k + 1) % NS], pole)).material_index = ORDER.index(SECTION_MAT[k])
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
me = bpy.data.meshes.new("Soundbar")
bm.to_mesh(me)
bm.free()
for m in MAT.values():
    me.materials.append(m)
bar = link(bpy.data.objects.new("Soundbar", me))
parts = [bar]


# ---- Touch controls and the status light, laid on the flat of the top band.
def top_at(d):
    """Height of the top surface at depth d, from the section."""
    top = [(pd, ph) for pd, ph in SECTION if ph > 0]
    top.sort()
    for (d0, h0), (d1, h1) in zip(top, top[1:]):
        if d0 <= d <= d1:
            return h0 + (h1 - h0) * (d - d0) / (d1 - d0)
    return H / 2


def mark(name, x0, x1, d0, d1, mat):
    """A thin flat mark on the top band, between x0..x1 and depths d0..d1."""
    z = max(top_at(d0), top_at(d1)) + 0.0001
    bm = bmesh.new()
    bm.faces.new([bm.verts.new(p) for p in ((x0, -GAP - d1, z), (x1, -GAP - d1, z), (x1, -GAP - d0, z), (x0, -GAP - d0, z))])
    return from_bmesh(name, bm, [mat], recalc=False)


CD = 0.050  # depth of the controls' row
parts.append(mark("VolumeDown", -0.0405, -0.0335, CD - 0.0006, CD + 0.0006, MAT["Controls"]))
parts.append(mark("VolumeUp", 0.0335, 0.0405, CD - 0.0006, CD + 0.0006, MAT["Controls"]))
parts.append(mark("VolumeUp", 0.0364, 0.0376, CD - 0.0035, CD + 0.0035, MAT["Controls"]))
for x in (-0.0022, 0.0022):  # play/pause: two short bars
    parts.append(mark("PlayPause", x - 0.0007, x + 0.0007, CD - 0.0035, CD + 0.0035, MAT["Controls"]))
bm = bmesh.new()  # the status light, a small dot in front of the controls
z = top_at(0.068) + 0.0001
bm.faces.new([bm.verts.new((0.0018 * math.cos(2 * math.pi * k / 10), -GAP - 0.068 + 0.0018 * math.sin(2 * math.pi * k / 10), z))
              for k in range(10)])
parts.append(from_bmesh("StatusLight", bm, [MAT["StatusLight"]], recalc=False))

# ---- Wall bracket: a plate on the wall and two arms that hold the bar.
parts.append(box("BracketPlate", -0.19, 0.19, -0.006, 0.0, -0.022, 0.022, MAT["Bracket"], 0.002))
for x in (-0.13, 0.13):
    parts.append(box("BracketArm", x - 0.022, x + 0.022, -GAP - 0.002, -0.005, -0.015, 0.015, MAT["Bracket"], 0.0015))

bpy.ops.object.select_all(action="DESELECT")
for p in parts:
    p.select_set(True)
bpy.context.view_layer.objects.active = bar
bpy.ops.object.join()
bar.data.set_sharp_from_angle(angle=math.radians(40))
bar.data.calc_loop_triangles()
print(f"soundbar: {len(bar.data.loop_triangles)} triangles")

bpy.ops.object.select_all(action="DESELECT")
bar.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_cameras=False, export_lights=False)

# ---- Preview renders: on a wall, front three-quarter, side, front and a close-up of the controls.
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 1200, 600
    world = bpy.data.worlds.new("Room")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.25, 0.25, 0.26, 1)
    scene.world = world
    bpy.ops.object.light_add(type="AREA", location=(-1.0, -2.0, 1.5))
    key = bpy.context.active_object
    key.data.energy, key.data.size = 120, 1.5
    key.rotation_euler = (Vector((0, 0, 0)) - key.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.mesh.primitive_plane_add(size=6, location=(0, 0.0, 0), rotation=(math.pi / 2, 0, 0))
    bpy.context.active_object.data.materials.append(material("Wall", (0.32, 0.30, 0.27), 0.9))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    for label, at, target, lens, res in (("soundbar_front34", (0.9, -1.2, 0.35), (0, -0.07, 0), 50, (1200, 600)),
                                         ("soundbar_below", (-0.75, -0.9, -0.38), (-0.25, -0.07, 0), 50, (1200, 600)),
                                         ("soundbar_side", (1.8, -0.09, 0.0), (0.0, -0.09, 0), 135, (800, 600)),
                                         ("soundbar_close", (0.12, -0.32, 0.20), (0.0, -0.07, 0.03), 50, (1000, 700))):
        scene.render.resolution_x, scene.render.resolution_y = res
        cam.location = at
        cam.data.lens = lens
        cam.rotation_euler = (Vector(target) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
