"""Build the game's clown in Blender: an original, friendly toy-like character in separate parts.

Run (Blender 5, no window):
  blender -b -P tools/clown.py -- <out.glb> [preview_dir]

Our own design (not any existing clown): 1.25 m tall with chunky toy proportions. A big
round head (a quarter of the height) with a white painted face, a round red nose, big black
oval eyes, dark arched brows and a wide red smile, a mop of curly lime green hair round the
back and sides, and a small dark teal top hat with an orange band and a daisy, tilted to
one side. A round teal suit with a pleated orange ruff, three big yellow buttons and orange
frills at the wrists and ankles; white four-finger gloves; short legs in big red shoes.
Facial features are geometry (raised paint, a nose sphere), no textures.

Output: one GLB with six nodes for procedural animation (a waddle walk, waving, falling
over). Body (the torso with the suit, ruff and buttons; its origin at the hips, 0.42 m up)
is the root; Head (pivot at the neck), Arm_L and Arm_R (pivot at the shoulder, hanging
down) and Leg_L and Leg_R (pivot at the hip, hanging down, with the shoe) are its
children. L/R are the clown's own sides: its left is +x. In its rest pose it stands on the
floor at y = 0 and faces +z in the GLB (Blender -Y). With preview_dir it also renders front
three-quarter, side, back, face, a mid-stride pose, a wave and a view from 15 m there.
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

HIP = Vector((0.0, 0.0, 0.42))       # Body's origin
HIP_X = 0.1                          # legs either side of it
SHOULDER = Vector((0.205, 0.0, 0.80))  # the left shoulder; the right one mirrored
ARM_OUT = math.radians(13)           # rest pose: the arms hang a little away from the round belly
NECK = Vector((0.0, 0.0, 0.865))
HC, HR = Vector((0.0, 0.0, 1.02)), 0.16  # the head's centre and radius
SY = 0.9                             # the torso is a little flatter front to back


def material(name, hex_, rough=0.6, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    c = [int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)]  # sRGB hex to linear, as glTF expects
    p.inputs["Base Color"].default_value = (*[v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c], 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    m.use_backface_culling = True  # exported single-sided
    return m


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def modify(obj, kind, **props):
    """Add a modifier with these settings and apply it."""
    mod = obj.modifiers.new(kind.lower(), kind)
    for k, v in props.items():
        setattr(mod, k, v)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)
    return obj


def from_bmesh(name, bm, mats, recalc=False):
    """A mesh object from a bmesh; mats is one material or a list (faces keep their material_index)."""
    if recalc:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats if isinstance(mats, list) else [mats]:
        me.materials.append(m)
    return link(bpy.data.objects.new(name, me))


def lathe(name, profile, mat, seg=20, matrix=Matrix(), sy=1.0):
    """A surface of revolution round z: profile (r, z) from bottom to top, r = 0 makes a pole.
    Wound outwards; matrix (no mirroring) then places it."""
    bm = bmesh.new()
    rings = []
    for r, z in profile:
        if r < 1e-6:
            rings.append(bm.verts.new((0.0, 0.0, z)))
        else:
            rings.append([bm.verts.new((r * math.cos(2 * math.pi * k / seg), sy * r * math.sin(2 * math.pi * k / seg), z))
                          for k in range(seg)])
    for a, b in zip(rings, rings[1:]):
        for k in range(seg):
            k1 = (k + 1) % seg
            if isinstance(a, list) and isinstance(b, list):
                bm.faces.new((a[k], a[k1], b[k1], b[k]))
            elif isinstance(b, list):
                bm.faces.new((a, b[k1], b[k]))
            elif isinstance(a, list):
                bm.faces.new((a[k], a[k1], b))
    bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
    return from_bmesh(name, bm, mat)


def sphere_profile(v):
    return [(math.sin(math.pi * i / v), -math.cos(math.pi * i / v)) for i in range(v + 1)]


def ellipsoid(name, center, radii, mat, u=16, v=8, rot=Matrix()):
    """A UV sphere scaled to radii (x, y, z), turned by rot round its centre (poles along its z)."""
    m = Matrix.Translation(Vector(center)) @ rot.to_4x4() @ Matrix.Diagonal((*radii, 1.0))
    return lathe(name, sphere_profile(v), mat, u, m)


def facing(normal):
    """Rotation that turns a part's -Y (its front) to face along normal."""
    return Vector((0.0, -1.0, 0.0)).rotation_difference(Vector(normal).normalized()).to_matrix()


def join(parts, name):
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    obj = parts[0]
    obj.name = obj.data.name = name
    obj.data.set_sharp_from_angle(angle=math.radians(60))
    return obj


bpy.ops.wm.read_factory_settings(use_empty=True)
M = {name: material(name, hex_, rough) for name, hex_, rough in (
    ("Skin", "#f2c6a0", 0.6),
    ("FacePaint", "#f8f5ef", 0.45),
    ("Nose", "#e3232c", 0.3),
    ("Mouth", "#cf1f2b", 0.45),
    ("Eyes", "#1c1a24", 0.3),
    ("Hair", "#7dc83a", 0.8),
    ("Hat", "#0e5d64", 0.55),
    ("Costume", "#12a3a0", 0.7),
    ("Costume2", "#f26a1b", 0.65),
    ("Buttons", "#ffd02e", 0.35),
    ("Gloves", "#fbfaf6", 0.55),
    ("Shoes", "#d02a2e", 0.35),
    ("Soles", "#3a2a24", 0.8),
)}

# ======== Body: a round torso (a pear from the hips to the neck), the ruff, three big buttons.
TORSO = [(0.0, 0.335), (0.09, 0.345), (0.15, 0.37), (0.19, 0.41), (0.213, 0.47), (0.222, 0.54), (0.218, 0.61),
         (0.203, 0.67), (0.18, 0.725), (0.15, 0.775), (0.115, 0.815), (0.08, 0.845), (0.045, 0.865), (0.0, 0.872)]
body_parts = [lathe("Torso", TORSO, M["Costume"], 20, sy=SY)]


def torso_r(z):
    for (r0, z0), (r1, z1) in zip(TORSO, TORSO[1:]):
        if z0 <= z <= z1:
            return r0 + (r1 - r0) * (z - z0) / (z1 - z0), (r1 - r0) / (z1 - z0)
    return 0.0, 0.0


# The ruff: a pleated collar round the neck, dipping onto the shoulders. Its folds deepen outwards
# and its edge runs in and out with them, so it reads as a ring of rounded lobes.
PLEATS, PER = 8, 8
RI, RO, RZ = 0.06, 0.2, 0.866
section = [(0.0, 1.0), (0.55, 1.0), (1.02, 0.0), (0.55, -1.0), (0.0, -1.0)]  # (u, side) round the section
bm = bmesh.new()
loops = []
for k in range(PLEATS * PER):
    t = 2 * math.pi * k / (PLEATS * PER)
    loop = []
    for u, side in section:
        r = RI + (RO - RI) * u + 0.012 * u * u * math.cos(PLEATS * t)
        z = RZ - 0.048 * u + side * (0.011 * (1 - u) + 0.006) + 0.022 * u ** 1.3 * math.sin(PLEATS * t)
        loop.append(bm.verts.new((r * math.cos(t), r * math.sin(t), z)))
    loops.append(loop)
n = len(section)
for a, b in zip(loops, loops[1:] + loops[:1]):
    for i in range(n):
        bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
body_parts.append(from_bmesh("Ruff", bm, M["Costume2"], recalc=True))

# Three big buttons down the front, on the torso's surface.
for z in (0.715, 0.6, 0.485):
    r, dr = torso_r(z)
    nrm = Vector((0.0, -1.0, -dr)).normalized()
    at = Vector((0.0, -r * SY, z)) + nrm * 0.004
    body_parts.append(ellipsoid("Button", at, (0.037, 0.014, 0.037), M["Buttons"], 12, 6, facing(nrm)))

# ======== Head: the neck, a round head painted white all over (a whiteface clown), skin-coloured ears,
# the nose, eyes, brows and smile, the hair and the hat. The ball's poles are front and back: the
# front one hides behind the nose and the top of the head stays even under the hat.
head_parts = [lathe("Neck", [(0.05, NECK.z - 0.03), (0.05, NECK.z + 0.06)], M["Skin"], 12),
              ellipsoid("HeadBall", HC, (HR, HR, HR), M["FacePaint"], 24, 12, Matrix.Rotation(math.pi / 2, 3, "X"))]


def on_face(x, z, lift=0.0):
    """The point on the front of the head at (x, z), lifted off it along the normal; and the normal."""
    d = Vector((x - HC.x, 0.0, z - HC.z))
    d.y = -math.sqrt(max(0.0, HR * HR - d.x * d.x - d.z * d.z))
    nrm = d.normalized()
    return HC + nrm * (HR + lift), nrm


def strip(name, top, bottom, mat, lift=0.004, sink=0.004):
    """Raised paint on the face: a band between two curves of (x, z) points, lift above the skin
    with its edges running down below it (so it never floats)."""
    bm = bmesh.new()
    rows = [[bm.verts.new(on_face(x, z, lift)[0]) for x, z in top],
            [bm.verts.new(on_face(x, z, lift)[0]) for x, z in bottom]]
    low = [[bm.verts.new(on_face(x, z, -sink)[0]) for x, z in top],
           [bm.verts.new(on_face(x, z, -sink)[0]) for x, z in bottom]]
    n = len(top)
    for k in range(n - 1):
        bm.faces.new((rows[0][k], rows[1][k], rows[1][k + 1], rows[0][k + 1]))
        bm.faces.new((low[0][k], rows[0][k], rows[0][k + 1], low[0][k + 1]))
        bm.faces.new((rows[1][k], low[1][k], low[1][k + 1], rows[1][k + 1]))
    bm.faces.new((low[1][0], rows[1][0], rows[0][0], low[0][0]))
    bm.faces.new((low[0][-1], rows[0][-1], rows[1][-1], low[1][-1]))
    obj = from_bmesh(name, bm, mat)
    # Make sure it faces out: its first face should point away from the head's centre.
    p = obj.data.polygons[0]
    if p.normal.dot(Vector(p.center) - HC) < 0:
        obj.data.flip_normals()
    return obj


# Nose: a round red ball, a little below the middle of the face.
nose_c = HC + Vector((0.0, -(HR + 0.014), -0.012))
head_parts.append(ellipsoid("Nose", nose_c, (0.046, 0.046, 0.046), M["Nose"], 16, 8))
# Smile: a wide crescent from cheek to cheek, thick in the middle, upturned at the ends.
SW = 0.105
xs = [SW * (2 * k / 20 - 1) for k in range(21)]
mid = [HC.z - 0.078 + 0.048 * (x / SW) ** 2 for x in xs]
th = [0.006 + 0.026 * max(0.0, 1 - (x / SW) ** 2) ** 0.75 for x in xs]
head_parts.append(strip("Smile", [(x, m + t * 0.35) for x, m, t in zip(xs, mid, th)],
                        [(x, m - t * 0.65) for x, m, t in zip(xs, mid, th)], M["Mouth"]))
# Eyes: tall black ovals with a white glint, dark brows arched high above them.
for s in (1, -1):
    ex, ez = s * 0.056, HC.z + 0.035
    at, nrm = on_face(ex, ez, -0.002)
    head_parts.append(ellipsoid("Eye", at, (0.021, 0.011, 0.031), M["Eyes"], 12, 6, facing(nrm)))
    at, nrm = on_face(ex - s * 0.007, ez + 0.013, 0.008)
    head_parts.append(ellipsoid("Glint", at, (0.006, 0.003, 0.007), M["FacePaint"], 6, 3, facing(nrm)))
    bx = [ex + s * 0.036 * (2 * k / 10 - 1) for k in range(11)]
    bz = [HC.z + 0.088 - 0.016 * ((x - ex) / 0.036) ** 2 for x in bx]
    head_parts.append(strip("Brow", [(x, z + 0.0045) for x, z in zip(bx, bz)], [(x, z - 0.0045) for x, z in zip(bx, bz)],
                            M["Eyes"]))
    # Ears, low on the sides, skin-coloured.
    head_parts.append(ellipsoid("Ear", HC + Vector((s * (HR - 0.004), 0.008, -0.02)), (0.02, 0.032, 0.042), M["Skin"], 10, 5))
# Hair: curly lime green puffs round the sides and back, above the ears, up to the hat.
PUFFS = [(86, 26, 0.052), (108, 24, 0.062), (128, 2, 0.06), (136, 42, 0.06), (152, 20, 0.066), (165, -6, 0.058),
         (180, 22, 0.066)]  # azimuth from the front, elevation, radius (mirrored but for the middle one)
for az, el, r in PUFFS:
    for s in ((1, -1) if az < 180 else (1,)):
        a, e = math.radians(az), math.radians(el)
        d = Vector((s * math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))
        head_parts.append(ellipsoid("Puff", HC + d * (HR + r * 0.35), (r, r, r * 0.92), M["Hair"], 10, 6))
# Hat: a small top hat tilted to the clown's left, an orange band and a daisy on it.
hat_m = Matrix.Translation(HC + Vector((0.033, 0.012, HR - 0.027))) @ Matrix.Rotation(math.radians(14), 4, "Y") \
    @ Matrix.Rotation(math.radians(-6), 4, "X")
head_parts.append(lathe("Brim", [(0.0, -0.004), (0.102, -0.004), (0.108, 0.0), (0.104, 0.006), (0.0, 0.006)], M["Hat"], 28, hat_m))
head_parts.append(lathe("Crown", [(0.0, 0.0), (0.066, 0.0), (0.064, 0.046), (0.068, 0.096), (0.0, 0.096)], M["Hat"], 24, hat_m))
head_parts.append(lathe("Band", [(0.0675, 0.004), (0.0675, 0.03)], M["Costume2"], 24, hat_m))
flower = hat_m @ Vector((-0.045, -0.052, 0.018))  # on the band, front right
fn = (hat_m.to_3x3() @ Vector((-0.65, -0.76, 0.0))).normalized()  # its facing
side = fn.cross(Vector((0.0, 0.0, 1.0))).normalized()
up = side.cross(fn).normalized()
for k in range(5):
    t = 2 * math.pi * k / 5 + 0.3
    d = side * math.cos(t) + up * math.sin(t)  # the petal's length; thin along fn
    rot = Matrix((fn.cross(d), fn, d)).transposed()  # columns: a right-handed frame
    head_parts.append(ellipsoid("Petal", flower + d * 0.021 + fn * 0.003, (0.012, 0.005, 0.02), M["Gloves"], 6, 3, rot))
head_parts.append(ellipsoid("FlowerHeart", flower + fn * 0.008, (0.012, 0.012, 0.012), M["Buttons"], 8, 4))


# ======== Arms and legs: hanging from their pivots, each with a rounded cap round the pivot so
# they turn cleanly against the body, and an orange frill at the wrist or ankle.
def cap(r, z=0.0):
    """Profile of a half sphere of radius r on top of a sleeve or trouser leg, round the pivot."""
    return [(r * math.cos(math.radians(a)), z + r * math.sin(math.radians(a))) for a in (0, 30, 60)] + [(0.0, z + r)]


def frill(section, waves=6, n=24, wave=0.008):
    """A pleated ring: section is (r, z, f) round its cross-section, f how much each point waves."""
    bm = bmesh.new()
    loops = []
    for k in range(n):
        t = 2 * math.pi * k / n
        w = wave * math.sin(waves * t)
        loops.append([bm.verts.new((r * math.cos(t), r * math.sin(t), z + w * f)) for r, z, f in section])
    m = len(section)
    for a, b in zip(loops, loops[1:] + loops[:1]):
        for i in range(m):
            bm.faces.new((a[i], a[(i + 1) % m], b[(i + 1) % m], b[i]))
    return from_bmesh("Frill", bm, M["Costume2"], recalc=True)


def arm(s):
    """The arm on side s (1 = the clown's left, +x): a sleeve from the shoulder, a white four-finger
    glove (palm towards the body, three fat fingers, the thumb in front), then turned out a little."""
    W = -0.255  # the wrist, below the shoulder pivot
    parts = [lathe("Sleeve", [(0.0, W), (0.05, W), (0.057, W + 0.02), (0.052, W + 0.09), (0.056, -0.1)] + cap(0.062),
                   M["Costume"], 14),
             frill([(0.045, W + 0.014, 0.0), (0.074, W - 0.001, 1.0), (0.045, W - 0.014, 0.0)]),
             lathe("GloveCuff", [(0.0, W - 0.045), (0.041, W - 0.045), (0.048, W - 0.02), (0.06, W + 0.008), (0.0, W + 0.008)],
                   M["Gloves"], 14)]
    hand = []
    palm = Vector((0.0, -0.004, -0.045))  # from the bottom of the cuff
    hand.append(ellipsoid("Palm", palm, (0.034, 0.053, 0.05), M["Gloves"], 12, 6))
    for k, y in enumerate((-0.03, 0.0, 0.029)):
        tilt = Matrix.Rotation(s * math.radians(12), 3, "Y") @ Matrix.Rotation(math.radians(8 * (k - 1)), 3, "X")
        hand.append(ellipsoid("Finger", palm + Vector((-s * 0.004, y, -0.05)), (0.019, 0.017, 0.038), M["Gloves"], 8, 5, tilt))
    thumb = Matrix.Rotation(math.radians(-50), 3, "X") @ Matrix.Rotation(s * math.radians(-15), 3, "Y")
    hand.append(ellipsoid("Thumb", palm + Vector((-s * 0.012, -0.05, -0.012)), (0.017, 0.017, 0.035), M["Gloves"], 8, 5, thumb))
    for p in hand:  # cartoon-sized: a fifth bigger than the arm would have it
        p.data.transform(Matrix.Translation((0.0, 0.0, W - 0.035)) @ Matrix.Scale(1.2, 4))
    obj = join(parts + hand, "Arm_L" if s > 0 else "Arm_R")
    obj.data.transform(Matrix.Rotation(-s * ARM_OUT, 4, "Y"))  # hang a little away from the belly
    return obj


def leg(s):
    """The leg on side s: a baggy trouser leg from the hip (its pivot), the frill, a big red shoe
    whose sole is on the floor 0.42 below the pivot."""
    floor = -HIP.z
    parts = [lathe("Trouser", [(0.0, floor + 0.13), (0.07, floor + 0.13), (0.084, floor + 0.15), (0.082, floor + 0.22),
                               (0.076, -0.12)] + cap(0.075), M["Costume"], 14),
             frill([(0.06, floor + 0.155, 0.0), (0.095, floor + 0.138, 1.0), (0.06, floor + 0.122, 0.0)], wave=0.009)]
    # Shoe: a big round toe box and a heel, cut flat on a dark sole; the toes turned out a little.
    shoe = []
    sole_top = floor + 0.026
    for c, r in (((0.0, -0.115, floor + 0.062), (0.083, 0.135, 0.07)), ((0.0, 0.018, floor + 0.066), (0.066, 0.08, 0.072))):
        e = ellipsoid("ShoeUpper", c, r, M["Shoes"], 14, 8)
        bm = bmesh.new()
        bm.from_mesh(e.data)
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, sole_top), plane_no=(0, 0, 1),
                               clear_inner=True)
        bm.to_mesh(e.data)
        bm.free()
        shoe.append(e)
    # The sole: the shoe's footprint, a little wider than the upper, with rounded edges.
    outline = []
    for k in range(20):
        t = 2 * math.pi * k / 20
        u = math.cos(t)  # +1 at the toe, -1 at the heel
        half = 0.074 + 0.016 * max(0.0, u) - 0.004 * max(0.0, -u)
        outline.append((half * math.sin(t), -0.072 - 0.178 * u))
    bm = bmesh.new()
    lo = [bm.verts.new((x, y, floor)) for x, y in outline]
    hi = [bm.verts.new((x, y, sole_top + 0.004)) for x, y in outline]
    for i in range(len(outline)):
        j = (i + 1) % len(outline)
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bm.faces.new(lo)
    bm.faces.new(hi[::-1])
    sole = from_bmesh("Sole", bm, M["Soles"], recalc=True)
    modify(sole, "BEVEL", width=0.008, segments=2, limit_method="ANGLE", angle_limit=math.radians(50))
    shoe.append(sole)
    for p in shoe:
        p.data.transform(Matrix.Rotation(s * math.radians(8), 4, "Z"))
    return join(parts + shoe, "Leg_L" if s > 0 else "Leg_R")


# ======== Assemble: each part's mesh round its pivot, the head, arms and legs parented to the body.
body = join(body_parts, "Body")
body.data.transform(Matrix.Translation(-HIP))
body.location = HIP
head = join(head_parts, "Head")
head.data.transform(Matrix.Translation(-NECK))
nodes = {"Body": body, "Head": head}
pivots = {"Head": NECK}
for s in (1, -1):
    a = arm(s)
    nodes[a.name] = a
    pivots[a.name] = Vector((s * SHOULDER.x, SHOULDER.y, SHOULDER.z))
    g = leg(s)
    nodes[g.name] = g
    pivots[g.name] = Vector((s * HIP_X, 0.0, HIP.z))
for name, p in pivots.items():
    o = nodes[name]
    o.parent = body
    o.location = p - HIP  # local to Body; its parent inverse stays identity

bpy.context.view_layer.update()
tris = 0
for name, o in nodes.items():
    o.data.calc_loop_triangles()
    tris += len(o.data.loop_triangles)
    print(f"{name}: {len(o.data.loop_triangles)} triangles, pivot {tuple(round(v, 3) for v in o.matrix_world.translation)}")
print(f"clown: {tris} triangles")

bpy.ops.object.select_all(action="DESELECT")
for o in nodes.values():
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=False, export_cameras=False, export_lights=False)

# ---- Preview renders: front three-quarter, side, back, the face, mid-stride, waving and from 15 m.
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.view_settings.view_transform = "ACES 1.3"  # the game renders with ACES filmic tone mapping
    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.42, 0.47, 0.55, 1)
    scene.world = world
    bpy.ops.object.light_add(type="AREA", location=(-1.4, -2.2, 2.6))
    key = bpy.context.active_object
    key.data.energy, key.data.size = 450, 2.0
    key.rotation_euler = (Vector((0, 0, 0.7)) - key.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(50), 0, math.radians(35)))
    bpy.context.active_object.data.energy = 2.0
    bpy.ops.mesh.primitive_plane_add(size=40)
    bpy.context.active_object.data.materials.append(material("Floor", "#8a8f86", 0.8))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)

    def shot(label, loc, target, lens, res=(900, 1100)):
        scene.render.resolution_x, scene.render.resolution_y = res
        cam.location = loc
        cam.data.lens = lens
        cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)

    shot("clown_front34", (1.7, -3.0, 1.3), (0, 0, 0.63), 45)
    shot("clown_front", (0, -3.4, 0.7), (0, 0, 0.63), 45)
    shot("clown_side", (3.4, 0, 0.7), (0, 0, 0.63), 45)
    shot("clown_back", (-1.5, 3.0, 1.2), (0, 0, 0.63), 45)
    shot("clown_face", (0.25, -1.2, 1.08), (0, 0, 1.03), 60, (900, 900))
    # Mid-stride: the left leg forward, the right back, the arms swinging the other way, a little lean.
    nodes["Leg_L"].rotation_euler.x = math.radians(-28)
    nodes["Leg_R"].rotation_euler.x = math.radians(24)
    nodes["Arm_L"].rotation_euler.x = math.radians(32)
    nodes["Arm_R"].rotation_euler.x = math.radians(-36)
    nodes["Head"].rotation_euler.y = math.radians(6)
    body.rotation_euler.y = math.radians(-4)
    body.location.z = HIP.z + 0.0
    shot("clown_stride", (2.6, -2.2, 1.1), (0, 0, 0.6), 45)
    shot("clown_stride_side", (3.4, 0, 0.7), (0, 0, 0.6), 45)
    for n in nodes.values():
        n.rotation_euler = (0, 0, 0)
    # Waving with the right arm, the head tilted.
    nodes["Arm_R"].rotation_euler.y = math.radians(140)
    nodes["Head"].rotation_euler.y = math.radians(-10)
    shot("clown_wave", (0.8, -3.2, 1.1), (0, 0, 0.7), 42)
    for n in nodes.values():
        n.rotation_euler = (0, 0, 0)
    # From 15 m with the game's 72 degree vertical field of view (centre crop).
    cam.data.sensor_fit = "VERTICAL"
    scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
    cam.data.angle = math.radians(72)
    cam.location = (4.0, -14.5, 1.65)
    cam.rotation_euler = (Vector((0, 0, 0.9)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.use_border, scene.render.use_crop_to_border = True, True
    scene.render.border_min_x, scene.render.border_max_x = 0.42, 0.58
    scene.render.border_min_y, scene.render.border_max_y = 0.36, 0.64
    scene.render.filepath = os.path.join(PREVIEW, "clown_15m.png")
    bpy.ops.render.render(write_still=True)
