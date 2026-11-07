"""Build Sinterklaas for the church square in December, in Blender: the saint on horseback, in separate parts.

Run (Blender 5, no window):
  blender -b -P tools/sinterklaas.py -- <out.glb> [preview_dir]

Our own model of the traditional figure, friendly and simple, for families: an old bishop with a long white beard, in
a red cope with gold borders over a white alb, white gloves, dark red boots, a tall red mitre with gold trim and a gold
cross on its front, and a golden crozier in his left hand. He sits astride; his seat is where the game's horse
(tools/horse.py, web/public/models/horse.glb, painted white by the game) has the deepest point of its saddle. No
helpers: only the saint.

Output: one GLB with three nodes for procedural animation, each mesh round its pivot:
  Body     the root, its origin at the seat (put it on the horse's Tack): the legs astride, the alb, the cope, the
           left arm holding the crozier upright
    Head   pivot at the neck: the face, beard, moustache, brows and hair, the mitre
    Arm_R  pivot at the right shoulder; in its rest pose the upper arm hangs down and the forearm points forward
           (a hand on the reins). Turned so that the upper arm points out to the side and the forearm up, it waves:
           in three.js that is the rotation taking x to z, y to x and z to y (120 degrees about (1, 1, 1)).
L/R are his own sides: his left is +x. He faces +z in the GLB (Blender -Y); metres. About 9,000 triangles.
With preview_dir it also renders him on the horse from the front three-quarter, the side and the back, his face,
waving, and from 15 m with the game's field of view.
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
HERE = os.path.dirname(os.path.abspath(__file__))
HORSE = os.path.join(HERE, "..", "web", "public", "models", "horse.glb")

NECK = Vector((0.0, 0.005, 0.655))
HEAD_C = Vector((0.0, -0.005, 0.80))
SHOULDER_R = Vector((-0.195, 0.02, 0.555))
SHOULDER_L = Vector((0.195, 0.02, 0.555))
STAFF = (0.315, -0.255)  # where the crozier stands, in x and y
SY = 0.78  # the body is flatter front to back


def material(name, hex_, rough=0.6, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    c = [int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)]  # sRGB hex to linear, as glTF expects
    p.inputs["Base Color"].default_value = (*[v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c], 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    m.use_backface_culling = True
    return m


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def from_bmesh(name, bm, mat, recalc=False):
    if recalc:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    return link(bpy.data.objects.new(name, me))


def rings_mesh(name, rings, mat, closed=True, cap_bottom=None, cap_top=None):
    """Quads between rings of points (each a list of the same length), wound outwards when the rings run
    counter-clockwise seen from above; closed: each ring a loop. A cap is a point closing the first or last ring."""
    bm = bmesh.new()
    vs = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    for a, b in zip(vs, vs[1:]):
        for k in range(n if closed else n - 1):
            k1 = (k + 1) % n
            bm.faces.new((a[k], a[k1], b[k1], b[k]))
    if cap_bottom is not None:
        c = bm.verts.new(cap_bottom)
        for k in range(n if closed else n - 1):
            bm.faces.new((vs[0][(k + 1) % n], vs[0][k], c))
    if cap_top is not None:
        c = bm.verts.new(cap_top)
        for k in range(n if closed else n - 1):
            bm.faces.new((vs[-1][k], vs[-1][(k + 1) % n], c))
    return from_bmesh(name, bm, mat, recalc=True)


def ellipsoid(name, center, radii, mat, u=16, v=8, rot=Matrix()):
    """A UV sphere scaled to radii (x, y, z), turned by rot round its centre."""
    m = Matrix.Translation(Vector(center)) @ rot.to_4x4() @ Matrix.Diagonal((*radii, 1.0))
    rings = []
    for i in range(1, v):
        a = math.pi * i / v
        rings.append([(m @ Vector((math.sin(a) * math.cos(2 * math.pi * k / u), math.sin(a) * math.sin(2 * math.pi * k / u), -math.cos(a)))).to_tuple()
                      for k in range(u)])
    return rings_mesh(name, rings, mat, cap_bottom=(m @ Vector((0, 0, -1))).to_tuple(), cap_top=(m @ Vector((0, 0, 1))).to_tuple())


def tube(name, path, radii, mat, seg=12, caps=True):
    """A round tube along a path of points, its radius at each (parallel frames, so it doesn't twist)."""
    path = [Vector(p) for p in path]
    tangents = []
    for i in range(len(path)):
        a = path[max(0, i - 1)]
        b = path[min(len(path) - 1, i + 1)]
        tangents.append((b - a).normalized())
    ref = Vector((0, 0, 1)) if abs(tangents[0].z) < 0.9 else Vector((1, 0, 0))
    n = tangents[0].cross(ref).normalized()
    rings = []
    for i, p in enumerate(path):
        t = tangents[i]
        n = (n - t * n.dot(t)).normalized()
        bnorm = t.cross(n)
        r = radii[i] if isinstance(radii, (list, tuple)) else radii
        rings.append([(p + (n * math.cos(2 * math.pi * k / seg) + bnorm * math.sin(2 * math.pi * k / seg)) * r).to_tuple() for k in range(seg)])
    return rings_mesh(name, rings, mat, cap_bottom=path[0].to_tuple() if caps else None, cap_top=path[-1].to_tuple() if caps else None)


def box(name, center, size, mat, rot=Matrix()):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(Vector(center)) @ rot.to_4x4() @ Matrix.Diagonal((*size, 1.0)), verts=bm.verts)
    return from_bmesh(name, bm, mat)


def join(parts, name):
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    obj = parts[0]
    obj.name = obj.data.name = name
    obj.data.set_sharp_from_angle(angle=math.radians(50))
    return obj


bpy.ops.wm.read_factory_settings(use_empty=True)
M = {name: material(name, hex_, rough, metal) for name, hex_, rough, metal in (
    ("Robe", "#b0161d", 0.7, 0.0),      # the cope and the mitre: a deep red
    ("Lining", "#7e1015", 0.8, 0.0),
    ("Alb", "#f1eee6", 0.75, 0.0),      # the white alb
    ("Gold", "#d9a521", 0.35, 0.7),     # the borders, the cross, the crozier
    ("Skin", "#e9b994", 0.6, 0.0),
    ("Cheek", "#e49c86", 0.6, 0.0),
    ("Beard", "#f6f4ef", 0.95, 0.0),
    ("Glove", "#f7f5ef", 0.6, 0.0),
    ("Boot", "#5c1a14", 0.5, 0.0),
    ("Eye", "#2a211c", 0.3, 0.0),
)}

body_parts = []
head_parts = []
arm_parts = []

# ======== The legs astride: the alb over thighs and shins, hanging round the horse's barrel, the boots in front.
for s in (1, -1):
    hip = Vector((s * 0.115, 0.0, 0.07))
    knee = Vector((s * 0.30, -0.27, -0.24))
    ankle = Vector((s * 0.285, -0.20, -0.70))
    thigh = [hip.lerp(knee, f) for f in (0.0, 0.33, 0.66, 1.0)]
    shin = [knee.lerp(ankle, f) for f in (0.15, 0.5, 0.85, 1.0)]
    body_parts.append(tube("Thigh", thigh, [0.105, 0.098, 0.09, 0.085], M["Alb"], 14))
    body_parts.append(tube("Shin", [knee] + shin, [0.085, 0.084, 0.088, 0.095, 0.1], M["Alb"], 14, caps=False))
    body_parts.append(ellipsoid("Knee", knee, (0.088, 0.088, 0.088), M["Alb"], 14, 7))
    # The alb's hem flares a little round the ankle; the boot below it, the toe forward in the stirrup.
    body_parts.append(tube("Hem", [ankle + Vector((0, 0, 0.03)), ankle + Vector((0, 0, -0.03))], [0.1, 0.108], M["Alb"], 14))
    body_parts.append(ellipsoid("Boot", ankle + Vector((0, -0.07, -0.07)), (0.055, 0.13, 0.065), M["Boot"], 14, 8))
    body_parts.append(tube("BootLeg", [ankle + Vector((0, 0, 0.0)), ankle + Vector((0, -0.02, -0.08))], [0.06, 0.06], M["Boot"], 12))

# ======== The torso in the alb, from the seat to the neck.
TORSO = [(0.16, -0.02), (0.185, 0.08), (0.19, 0.2), (0.188, 0.32), (0.198, 0.44), (0.2, 0.52), (0.175, 0.585), (0.12, 0.625), (0.065, 0.65)]
rings = []
U = 24
for r, z in TORSO:
    rings.append([(r * math.sin(2 * math.pi * k / U), 0.02 - SY * r * math.cos(2 * math.pi * k / U), z) for k in range(U)])
body_parts.append(rings_mesh("Torso", rings, M["Alb"], cap_bottom=(0, 0.02, -0.02), cap_top=(0, 0.02, 0.655)))
# A red stole down the front of the alb, gold at its ends.
for s in (1, -1):
    path = [Vector((s * 0.055, 0.02 - SY * 0.205, z)) for z in (0.5, 0.35, 0.2, 0.06)]
    path = [p + Vector((s * (0.5 - p.z) * 0.03, -0.012, 0)) for p in path]
    body_parts.append(tube("Stole", path, 0.03, M["Robe"], 6))

# ======== The cope: a red cloak round the shoulders, open at the front, falling over the horse's back behind;
# gold borders down both edges of the opening, a gold clasp at the chest; a darker red lining inside.
COPE = [(0.07, 0.655, 0.0), (0.16, 0.62, 0.0), (0.25, 0.57, 0.12), (0.255, 0.47, 0.3), (0.25, 0.34, 0.44), (0.27, 0.2, 0.55),
        (0.3, 0.05, 0.66), (0.34, -0.12, 0.8), (0.37, -0.3, 0.92)]  # radius, height, half the opening (rad)
UC = 36


def cope_ring(r, z, gap, inset=0.0):
    pts = []
    for k in range(UC + 1):
        a = gap + (2 * math.pi - 2 * gap) * k / UC  # 0 is the front
        rr = r - inset
        pts.append((rr * math.sin(a), 0.02 - SY * 1.05 * rr * math.cos(a) + (0.06 * (z < 0.2) * (0.2 - z) * (1 + math.cos(a)) / 2), z))
    return pts


outer = [cope_ring(r, z, g) for r, z, g in COPE]
inner = [list(reversed(cope_ring(r, z, g, 0.012))) for r, z, g in COPE]
body_parts.append(rings_mesh("Cope", outer, M["Robe"], closed=False))
body_parts.append(rings_mesh("CopeLining", inner, M["Lining"], closed=False))
for side in (0, -1):  # the borders: down each edge of the opening, then round the hem
    path = [Vector(ring[side]) for ring in outer[1:]]
    body_parts.append(tube("Border", path, 0.013, M["Gold"], 8))
hem = [Vector(p) for p in outer[-1]]
body_parts.append(tube("Hem", hem, 0.016, M["Gold"], 8))
body_parts.append(ellipsoid("Clasp", (0.0, 0.02 - SY * 0.2 - 0.03, 0.54), (0.045, 0.02, 0.035), M["Gold"], 14, 7))
# A gold collar round the neck of the cope.
collar = [Vector(p) + Vector((0, 0, 0.005)) for p in cope_ring(0.115, 0.64, 0.0)]
body_parts.append(tube("Collar", collar, 0.022, M["Gold"], 8))


# ======== The arms: the alb's sleeve, wider at the wrist, a white glove. path: shoulder, elbow, wrist.
def arm(path, name, grip_dir):
    parts = [tube(name + "Sleeve", path, [0.07, 0.062, 0.062, 0.07][:len(path)], M["Alb"], 12)]
    wrist = Vector(path[-1])
    d = (Vector(path[-1]) - Vector(path[-2])).normalized()
    parts.append(tube(name + "Cuff", [wrist - d * 0.01, wrist + d * 0.03], [0.075, 0.08], M["Gold"], 12, caps=False))
    hand = wrist + d * 0.08
    rot = Vector((0, 0, 1)).rotation_difference(d).to_matrix()
    parts.append(ellipsoid(name + "Hand", hand, (0.045, 0.035, 0.065), M["Glove"], 12, 7, rot))
    parts.append(ellipsoid(name + "Thumb", hand + Vector(grip_dir) * 0.035 + d * -0.01, (0.016, 0.016, 0.035), M["Glove"], 8, 5, rot))
    return parts


# His left arm holds the crozier upright, the hand in front of the hip; part of the body.
lw = Vector((STAFF[0] - 0.01, STAFF[1] + 0.07, 0.28))
body_parts += arm([SHOULDER_L, Vector((0.275, -0.02, 0.33)), lw], "ArmL", (-1, 0, 0))
# The right arm on the reins: the upper arm hanging down, the forearm forward (the waving turn needs exactly that).
rw = SHOULDER_R + Vector((0.0, -0.21, -0.24))
arm_parts += arm([SHOULDER_R, SHOULDER_R + Vector((0.0, 0.0, -0.24)), rw], "ArmR", (1, 0, 0))
# The cope's shoulder over the top of the right arm, so it turns with it.
arm_parts.append(ellipsoid("Shoulder", SHOULDER_R + Vector((-0.012, 0.0, -0.008)), (0.078, 0.085, 0.07), M["Robe"], 14, 7))
body_parts.append(ellipsoid("Shoulder", SHOULDER_L + Vector((0.012, 0.0, -0.008)), (0.078, 0.085, 0.07), M["Robe"], 14, 7))

# ======== The crozier: a gold staff with a knop and a crook curling forward at the top.
sx, sy_ = STAFF
body_parts.append(tube("Staff", [(sx, sy_, -0.62), (sx, sy_, 1.12)], 0.014, M["Gold"], 10))
body_parts.append(ellipsoid("Knop", (sx, sy_, 1.13), (0.03, 0.03, 0.04), M["Gold"], 12, 6))
crook = []
for i in range(31):
    t = i / 30
    a = t * math.radians(330)  # from the top of the staff up and over, curling in
    r = 0.105 * (1 - 0.38 * t)
    crook.append((sx, sy_ - (r - r * math.cos(a)) - 0.0 * t, 1.16 + r * math.sin(a) + 0.08 * (1 - t) * 0 + (0.0 if i else 0)))
crook = [(sx, sy_, 1.15)] + [(x, y, z + 0.04) for x, y, z in crook]
body_parts.append(tube("Crook", crook, [0.016] * (len(crook) - 3) + [0.018, 0.02, 0.022], M["Gold"], 10))

# ======== The head: neck, face, nose, eyes, the long white beard and moustache, brows and hair, and the mitre.
head_parts.append(tube("Neck", [(0, 0.01, 0.6), (0, 0.0, 0.72)], 0.055, M["Skin"], 12))
head_parts.append(ellipsoid("Face", HEAD_C, (0.093, 0.105, 0.118), M["Skin"], 20, 12))
head_parts.append(ellipsoid("Nose", HEAD_C + Vector((0, -0.105, -0.005)), (0.02, 0.026, 0.026), M["Cheek"], 10, 6))
for s in (1, -1):
    head_parts.append(ellipsoid("Eye", HEAD_C + Vector((s * 0.034, -0.088, 0.03)), (0.012, 0.008, 0.012), M["Eye"], 8, 5))
    head_parts.append(ellipsoid("Brow", HEAD_C + Vector((s * 0.037, -0.093, 0.055)), (0.032, 0.014, 0.013), M["Beard"], 8, 5,
                                Matrix.Rotation(s * math.radians(-12), 3, "Y")))
    head_parts.append(ellipsoid("Cheek", HEAD_C + Vector((s * 0.052, -0.072, -0.012)), (0.03, 0.02, 0.022), M["Cheek"], 8, 5))
    head_parts.append(ellipsoid("Moustache", HEAD_C + Vector((s * 0.036, -0.1, -0.038)), (0.05, 0.022, 0.02), M["Beard"], 10, 6,
                                Matrix.Rotation(s * math.radians(-18), 3, "Y")))
    head_parts.append(ellipsoid("Ear", HEAD_C + Vector((s * 0.092, 0.005, 0.0)), (0.014, 0.03, 0.04), M["Skin"], 8, 5))
# The beard: round the jaw from ear to ear, full and long, down onto the chest in a soft point.
head_parts.append(ellipsoid("BeardJaw", HEAD_C + Vector((0, -0.03, -0.06)), (0.108, 0.09, 0.09), M["Beard"], 18, 10))
head_parts.append(ellipsoid("BeardLong", HEAD_C + Vector((0, -0.065, -0.17)), (0.098, 0.065, 0.15), M["Beard"], 18, 10,
                            Matrix.Rotation(math.radians(-14), 3, "X")))
head_parts.append(ellipsoid("BeardTip", HEAD_C + Vector((0, -0.09, -0.29)), (0.05, 0.04, 0.07), M["Beard"], 12, 6,
                            Matrix.Rotation(math.radians(-20), 3, "X")))
head_parts.append(ellipsoid("Hair", HEAD_C + Vector((0, 0.03, -0.01)), (0.104, 0.098, 0.11), M["Beard"], 18, 10))

# The mitre: a tall red cap whose front and back rise to a point; a gold band round its foot, gold down its sides,
# and a gold cross on its front.
MZ0, MZ1 = HEAD_C.z + 0.058, HEAD_C.z + 0.47
UM = 32


def mitre_size(f):
    """Half width (across) and half depth (front to back) at f, 0 at the foot to 1 at the point."""
    w = 0.108 * (1 + 0.16 * min(f, 0.5) * 2)
    if f > 0.45:
        w *= max(0.0, 1 - ((f - 0.45) / 0.55) ** 1.7)
    d = 0.112 * (1 - 0.8 * f)
    return w, d


mitre_rings = []
for i in range(14):
    f = i / 14
    w, d = mitre_size(f)
    z = MZ0 + (MZ1 - MZ0) * f
    mitre_rings.append([(w * math.sin(2 * math.pi * k / UM), 0.005 - d * math.cos(2 * math.pi * k / UM), z) for k in range(UM)])
head_parts.append(rings_mesh("Mitre", mitre_rings, M["Robe"], cap_bottom=(0, 0.005, MZ0), cap_top=(0, 0.005, MZ1)))
band = []
for z, grow in ((MZ0 - 0.005, 1.06), (MZ0 + 0.045, 1.06)):
    w, d = mitre_size((z - MZ0) / (MZ1 - MZ0))
    band.append([(grow * w * math.sin(2 * math.pi * k / UM), 0.005 - grow * d * math.cos(2 * math.pi * k / UM), z) for k in range(UM)])
head_parts.append(rings_mesh("MitreBand", band, M["Gold"]))
for s in (1, -1):  # gold down each side, where front and back meet
    path = []
    for i in range(14):
        f = i / 13 * 0.98
        w, d = mitre_size(f)
        path.append((s * (w + 0.006), 0.005, MZ0 + (MZ1 - MZ0) * f))
    head_parts.append(tube("MitreEdge", path, 0.011, M["Gold"], 6))
# The cross on the front, laid on its slope.
fc = 0.42
w, d = mitre_size(fc)
slope = math.atan2(0.112 * 0.8, MZ1 - MZ0)
at = Vector((0, 0.005 - d - 0.006, MZ0 + (MZ1 - MZ0) * fc))
tilt = Matrix.Rotation(-slope, 3, "X")
head_parts.append(box("CrossV", at, (0.024, 0.012, 0.15), M["Gold"], tilt))
head_parts.append(box("CrossH", at + tilt @ Vector((0, 0, 0.025)), (0.1, 0.012, 0.024), M["Gold"], tilt))

# ======== Assemble: each part's mesh round its pivot, the head and the right arm parented to the body.
body = join(body_parts, "Body")
head = join(head_parts, "Head")
head.data.transform(Matrix.Translation(-NECK))
arm_r = join(arm_parts, "Arm_R")
arm_r.data.transform(Matrix.Translation(-SHOULDER_R))
head.parent = arm_r.parent = body
head.location = NECK
arm_r.location = SHOULDER_R
nodes = {"Body": body, "Head": head, "Arm_R": arm_r}

bpy.context.view_layer.update()
tris = 0
for name, o in nodes.items():
    o.data.calc_loop_triangles()
    tris += len(o.data.loop_triangles)
    print(f"{name}: {len(o.data.loop_triangles)} triangles")
print(f"sinterklaas: {tris} triangles")

bpy.ops.object.select_all(action="DESELECT")
for o in nodes.values():
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=False, export_cameras=False, export_lights=False)

# ---- Preview renders: on the white horse from the front three-quarter, side and back, the face, waving, from 15 m.
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.view_settings.view_transform = "ACES 1.3"
    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.42, 0.47, 0.55, 1)
    scene.world = world
    bpy.ops.import_scene.gltf(filepath=HORSE)
    white = {"Coat": "#ece8e1", "Dark": "#cfcac2", "Marking": "#ece8e1", "Pad": "#a3161b", "Leather": "#3b2417"}
    for m in bpy.data.materials:
        if m.name in white and m.node_tree:
            c = [int(white[m.name][i:i + 2], 16) / 255 for i in (1, 3, 5)]
            m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*[v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c], 1)
    tack = bpy.data.objects.get("Tack")
    bpy.context.view_layer.update()
    body.location = tack.matrix_world.translation if tack else Vector((0, 0, 1.64))
    seat = body.location.copy()
    bpy.ops.object.light_add(type="AREA", location=(-2.0, -3.4, 4.0))
    key = bpy.context.active_object
    key.data.energy, key.data.size = 900, 3.0
    key.rotation_euler = (seat - key.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(50), 0, math.radians(35)))
    bpy.context.active_object.data.energy = 2.0
    bpy.ops.mesh.primitive_plane_add(size=40)
    bpy.context.active_object.data.materials.append(material("Floor", "#8a8f86", 0.8))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)

    def shot(label, loc, target, lens, res=(700, 800)):
        scene.render.resolution_x, scene.render.resolution_y = res
        cam.location = loc
        cam.data.lens = lens
        cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)

    mid = seat + Vector((0, 0, -0.2))
    shot("sint_front34", seat + Vector((2.6, -4.2, 0.4)), mid, 40)
    shot("sint_side", seat + Vector((5.0, 0.3, -0.2)), mid + Vector((0, 0.2, -0.3)), 40)
    shot("sint_back", seat + Vector((-2.4, 4.0, 0.6)), mid, 40)
    shot("sint_face", seat + Vector((0.35, -1.3, 0.95)), seat + Vector((0, 0, 0.92)), 60, (600, 600))
    # Waving: the upper arm out to the side, the forearm up (x to -y, y to -z, z to x in Blender's axes).
    arm_r.matrix_basis = Matrix(((0, 0, 1, SHOULDER_R.x), (-1, 0, 0, SHOULDER_R.y), (0, -1, 0, SHOULDER_R.z), (0, 0, 0, 1)))
    head.rotation_euler.z = math.radians(-15)
    shot("sint_wave", seat + Vector((-1.2, -4.0, 0.3)), mid + Vector((0, 0, 0.3)), 40)
    shot("sint_wave_close", seat + Vector((-0.6, -1.9, 0.7)), seat + Vector((0, 0, 0.6)), 45, (600, 600))
    arm_r.matrix_basis = Matrix.Translation(SHOULDER_R)
    head.rotation_euler.z = 0
    cam.data.sensor_fit = "VERTICAL"
    scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
    cam.data.angle = math.radians(72)
    cam.location = (4.0, -14.5, 1.65)
    cam.rotation_euler = (Vector((0, 0, 1.6)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.use_border, scene.render.use_crop_to_border = True, True
    scene.render.border_min_x, scene.render.border_max_x = 0.4, 0.6
    scene.render.border_min_y, scene.render.border_max_y = 0.3, 0.7
    scene.render.filepath = os.path.join(PREVIEW, "sint_15m.png")
    bpy.ops.render.render(write_still=True)
