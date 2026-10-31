"""Build the WC rooms' toilet in Blender: a rimless wall-hung bowl and the flush plate above it.

Run (Blender 5, no window):
  blender -b -P tools/toilet.py -- <out.glb> [preview_dir]

Our own model of a modern wall-hung WC (common catalogue sizes, checked against photos):
36 cm wide, 54 cm out from the wall, the rim at 40 cm and the seat's top at 42 cm. The
bowl is lofted round its outline (straight at the wall, widest just past the middle, an
egg-shaped front): from the inside of the bowl over the rimless edge and the flat top,
down the sides as they curve in, and under the bottom, which runs low at the wall and
rises towards the front. A slim seat with its lid closed sits on the rim, on two soft-close
hinges. The flush plate of the concealed cistern (25 x 16 cm, matt black, a small and a
large button) is 1 cm proud of the wall with its centre at 1.0 m. No logos or text.

Output: one GLB with two meshes. Toilet: bowl, seat, lid and hinges, its origin on the
floor at the wall, centred on the bowl's width. FlushPlate: its origin on the wall at the
plate's centre (1.0 m up), so the game can move it. The bowl reaches out along +z in the
GLB (Blender -Y). With preview_dir it also renders front three-quarter, side and close-up
views there.
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

HALF_W, OUT_P = 0.18, 0.54   # half the width; projection from the wall
RIM, SEAT_TOP = 0.400, 0.419
N = 56                       # points round the outline
PLATE_Z = 1.0


def curve(points):
    """Smooth curve through (u, value) points without overshoot (monotone cubic)."""
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    n = len(points)
    d = [(ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) for i in range(n - 1)]
    m = [d[0]] + [0.0 if d[i - 1] * d[i] <= 0 else (d[i - 1] + d[i]) / 2 for i in range(1, n - 1)] + [d[-1]]

    def f(u):
        if u <= xs[0]:
            return ys[0]
        if u >= xs[-1]:
            return ys[-1]
        i = max(k for k in range(n - 1) if xs[k] <= u)
        h = xs[i + 1] - xs[i]
        t = (u - xs[i]) / h
        h00, h10, h01, h11 = 2 * t**3 - 3 * t**2 + 1, t**3 - 2 * t**2 + t, -2 * t**3 + 3 * t**2, t**3 - t**2
        return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1]

    return f


def material(name, color, rough=0.5, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    m.use_backface_culling = True  # exported single-sided
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


def from_bmesh(name, bm, mat):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    return link(bpy.data.objects.new(name, me))


def loft(name, rings, mat, pole_start=None, pole_end=None):
    """Quads between consecutive closed rings of 3D points, closed with a fan at either end."""
    bm = bmesh.new()
    vs = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    for a, b in zip(vs, vs[1:]):
        for k in range(n):
            bm.faces.new((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]))
    for pole, ring in ((pole_start, vs[0]), (pole_end, vs[-1])):
        if pole is not None:
            c = bm.verts.new(pole)
            for k in range(n):
                bm.faces.new((ring[k], ring[(k + 1) % n], c))
    return from_bmesh(name, bm, mat)


def fillet(corners, step=math.pi / 16):
    """Closed outline through the corners (u, v, r), each rounded with radius r: a list of (u, v)."""
    pts = []
    n = len(corners)
    for i, (x, y, r) in enumerate(corners):
        p = Vector((x, y))
        u = (Vector(corners[i - 1][:2]) - p).normalized()
        v = (Vector(corners[(i + 1) % n][:2]) - p).normalized()
        half = u.angle(v) / 2
        c = p + (u + v).normalized() * (r / math.sin(half))
        p0, p1 = p + u * (r / math.tan(half)), p + v * (r / math.tan(half))
        a0 = math.atan2(p0.y - c.y, p0.x - c.x)
        da = (math.atan2(p1.y - c.y, p1.x - c.x) - a0 + math.pi) % (2 * math.pi) - math.pi
        seg = max(2, round(abs(da) / step))
        pts += [(c.x + r * math.cos(a0 + da * k / seg), c.y + r * math.sin(a0 + da * k / seg)) for k in range(seg + 1)]
    return pts


def box(name, x0, x1, y0, y1, z0, z1, mat, round_=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector(((x0 + x1) / 2 + v.co.x * (x1 - x0), (y0 + y1) / 2 + v.co.y * (y1 - y0), (z0 + z1) / 2 + v.co.z * (z1 - z0)))
    obj = from_bmesh(name, bm, mat)
    if round_:
        modify(obj, "BEVEL", width=round_, segments=2, limit_method="ANGLE", angle_limit=math.radians(40))
    return obj


bpy.ops.wm.read_factory_settings(use_empty=True)
MAT = {
    "Ceramic": material("Ceramic", srgb("#f6f6f4"), 0.15),
    "Seat": material("Seat", srgb("#f3f3f1"), 0.3),
    "Hinge": material("Hinge", (0.80, 0.80, 0.80), 0.2, 1.0),
    "Plate": material("Plate", srgb("#1d1d1f"), 0.4),
    "PlateGap": material("PlateGap", (0.004, 0.004, 0.004), 0.9),
}


# ---- Outline of the rim in plan, as (x, p) with p the distance out from the wall.
def WIDTH(p):
    """Half the rim's width at p: flaring a little from the wall to its widest, then an elliptical front."""
    if p < 0.30:
        return HALF_W - 0.015 * ((0.30 - p) / 0.30) ** 2
    return HALF_W * math.sqrt(max(0.0, 1 - ((p - 0.30) / (OUT_P - 0.30)) ** 2))


RC = 0.025  # the back corners
half = [(x, 0.0) for x in (0.0, 0.05, 0.10)]
w0 = WIDTH(0.0)
half += [(w0 - RC + RC * math.sin(a), RC - RC * math.cos(a)) for a in (math.pi / 2 * k / 6 for k in range(7))]
half += [(WIDTH(p), p) for p in (RC + (0.30 - RC) * k / 30 for k in range(1, 31))]
half += [(HALF_W * math.cos(a), 0.30 + (OUT_P - 0.30) * math.sin(a)) for a in (math.pi / 2 * k / 40 for k in range(1, 41))]
dense = half + [(-x, p) for x, p in reversed(half[1:-1])]
# Resample evenly along its length.
seglen = [math.dist(dense[i], dense[(i + 1) % len(dense)]) for i in range(len(dense))]
total = sum(seglen)
OUTLINE = []
acc, i = 0.0, 0
for k in range(N):
    target = total * k / N
    while acc + seglen[i] < target:
        acc += seglen[i]
        i += 1
    t = (target - acc) / seglen[i]
    a, b = dense[i], dense[(i + 1) % len(dense)]
    OUTLINE.append(Vector((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)))
CEN = Vector((0.0, 0.31))
NORMAL = []
for k in range(N):
    tng = OUTLINE[(k + 1) % N] - OUTLINE[k - 1]
    n = Vector((tng.y, -tng.x)).normalized()
    NORMAL.append(n if n.dot(OUTLINE[k] - CEN) > 0 else -n)
# Which way each point moves as the sides curve in: inwards round the bowl, but along the
# wall (towards the middle) on the straight edge at the back, so the back stays on the wall.
AWAY = [min(1.0, max(0.0, (p.y - 0.002) / 0.03)) for p in OUTLINE]
INWARD = [n * g + Vector((p.x / w0, 0.0)) * (1 - g) for p, n, g in zip(OUTLINE, NORMAL, AWAY)]


def ray_ellipse(c, d, e, ax, ap):
    """Where the ray from c along d leaves the ellipse with centre e and semi-axes ax, ap."""
    o = c - e
    A = (d.x / ax) ** 2 + (d.y / ap) ** 2
    B = 2 * (o.x * d.x / ax ** 2 + o.y * d.y / ap ** 2)
    C = (o.x / ax) ** 2 + (o.y / ap) ** 2 - 1
    t = (-B + math.sqrt(B * B - 4 * A * C)) / (2 * A)
    return c + d * t


def at(p2, z):
    """Plan point (x, p) and height to Blender coordinates: the bowl reaches out along -Y."""
    return (p2.x, -p2.y, z)


# ---- Bowl.
BOTTOM = curve([(0.0, 0.085), (0.15, 0.088), (0.28, 0.11), (0.40, 0.165), (0.48, 0.215), (0.54, 0.265)])
OPENING = [ray_ellipse(CEN, (p - CEN).normalized(), Vector((0, 0.335)), 0.118, 0.165) for p in OUTLINE]
BOWL_C = Vector((0.0, 0.33))
rings = []
for s, z in ((0.25, 0.257), (0.5, 0.268), (0.72, 0.298), (0.88, 0.342), (0.97, 0.379), (1.0, 0.391)):  # inside
    rings.append([at(BOWL_C + (q - BOWL_C) * s, z) for q in OPENING])
for off, z in ((0.003, RIM - 0.0015), (0.009, RIM)):  # the rimless edge, rounded over
    rings.append([at(q + (p - q).normalized() * off, z) for p, q in zip(OUTLINE, OPENING)])
rings.append([at(p - n * 0.008, RIM) for p, n in zip(OUTLINE, NORMAL)])
rings.append([at(p - n * 0.0024, RIM - 0.0024) for p, n in zip(OUTLINE, NORMAL)])
rings.append([at(p, RIM - 0.008) for p in OUTLINE])
TUCK = 0.03  # how far the sides curve in towards the bottom
# Each point's round under the bottom (radius rb) turns from the side until it runs along the
# underside, which climbs towards the front: so it turns less at the front than at the wall.
LOWER = []
for p, v in zip(OUTLINE, INWARD):
    rb = min(0.06, 0.45 * (RIM - 0.008 - BOTTOM(p.y)))
    e = p - v * (TUCK + rb)
    slope = max(0.0, (BOTTOM(e.y) - BOTTOM((e - v.normalized() * 0.01).y)) / 0.01)
    turn = math.atan2(1.0, slope)
    e = p - v * (TUCK + rb * (1 - math.cos(turn)))
    LOWER.append((rb, turn, BOTTOM(e.y) + rb * math.sin(turn)))
for f in (0.2, 0.4, 0.6, 0.8, 1.0):  # down the sides
    rings.append([at(p - v * TUCK * f ** 1.6, RIM - 0.008 - f * (RIM - 0.008 - zs))
                  for p, v, (rb, turn, zs) in zip(OUTLINE, INWARD, LOWER)])
for j in (1, 2, 3):  # the round under the bottom
    rings.append([at(p - v * (TUCK + rb * (1 - math.cos(turn * j / 3))), zs - rb * math.sin(turn * j / 3))
                  for p, v, (rb, turn, zs) in zip(OUTLINE, INWARD, LOWER)])
UNDER_C = Vector((0.0, 0.22))
edge = [Vector((r[0], -r[1])) for r in rings[-1]]
for s in (0.66, 0.33):  # the underside
    rings.append([at(UNDER_C + (e - UNDER_C) * s, BOTTOM((UNDER_C + (e - UNDER_C) * s).y)) for e in edge])
bowl = loft("Bowl", rings, MAT["Ceramic"], pole_start=at(BOWL_C, 0.255), pole_end=at(UNDER_C, BOTTOM(UNDER_C.y)))

# ---- Seat and lid: the rim's outline drawn in to start at the hinges, a slim rounded ring, the lid closed on it.
SEAT_BACK = 0.085
SEAT_OUT = [Vector((p.x, SEAT_BACK + p.y * (OUT_P + 0.001 - SEAT_BACK) / OUT_P)) - n * 0.003 for p, n in zip(OUTLINE, NORMAL)]
SEAT_C = Vector((0.0, 0.335))
SEAT_IN = [ray_ellipse(SEAT_C, (p - SEAT_C).normalized(), SEAT_C, 0.108, 0.148) for p in SEAT_OUT]
z0, z1 = RIM + 0.0012, SEAT_TOP
section = [(0.0, z0 + 0.005), (0.0015, z0 + 0.0013), (0.005, z0), (-0.005, z0), (-0.0015, z0 + 0.0013), (0.0, z0 + 0.005),
           (0.0, z1 - 0.006), (-0.002, z1 - 0.0016), (-0.007, z1), (0.006, z1), (0.0017, z1 - 0.0017), (0.0, z1 - 0.005)]
seat_rings = []
for j, (u, z) in enumerate(section):
    outer = 3 <= j <= 8  # the first three points sit on the inside edge, then the outside, then the inside again
    ring = []
    for so, si in zip(SEAT_OUT, SEAT_IN):
        d = (so - si).normalized()
        ring.append(at((so if outer else si) + d * u, z))
    seat_rings.append(ring)
seat = loft("Seat", seat_rings + [seat_rings[0]], MAT["Seat"])
# The lid: the same outline, closed, a little domed.
LID_C = Vector((0.0, 0.32))
l0, l1 = SEAT_TOP + 0.0015, SEAT_TOP + 0.0165
lid_rings = []
for s, off, z in ((0.85, 0.0, l0), (1.0, 0.004, l0), (1.0, 0.001, l0 + 0.0014), (1.0, 0.0, l0 + 0.005), (1.0, 0.0, l1 - 0.006),
                  (1.0, 0.0018, l1 - 0.0016), (1.0, 0.007, l1), (0.6, 0.0, l1 + 0.0032), (0.3, 0.0, l1 + 0.0045)):
    lid_rings.append([at(LID_C + (p - n * off - LID_C) * s, z) for p, n in zip(SEAT_OUT, NORMAL)])
lid = loft("Lid", lid_rings, MAT["Seat"], pole_start=at(LID_C, l0), pole_end=at(LID_C, l1 + 0.005))
# Soft-close hinges: a chrome foot on the bowl, a white barrel at the back of the seat and lid.
parts = [bowl, seat, lid]
for side in (-1, 1):
    x = side * 0.088
    parts.append(box("HingeFoot", x - 0.014, x + 0.014, -0.083, -0.050, RIM - 0.001, RIM + 0.009, MAT["Hinge"], 0.003))
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.0095, depth=0.036, location=(x, -0.074, RIM + 0.021),
                                        rotation=(0, math.pi / 2, 0))
    barrel = bpy.context.active_object
    barrel.data.materials.append(MAT["Seat"])
    parts.append(modify(barrel, "BEVEL", width=0.002, segments=2, limit_method="ANGLE", angle_limit=math.radians(40)))
bpy.ops.object.select_all(action="DESELECT")
for p in parts:
    p.select_set(True)
bpy.context.view_layer.objects.active = bowl
bpy.ops.object.join()
bowl.name = bowl.data.name = "Toilet"
bowl.data.set_sharp_from_angle(angle=math.radians(40))

# ---- Flush plate: a matt black frame 1 cm proud of the wall, two buttons in its recess.
PW, PH, PT = 0.25, 0.16, 0.010
outline = fillet([(PW / 2, PH / 2, 0.008), (-PW / 2, PH / 2, 0.008), (-PW / 2, -PH / 2, 0.008), (PW / 2, -PH / 2, 0.008)],
                 math.pi / 8)
bm = bmesh.new()
back = [bm.verts.new((x, 0.0, z)) for x, z in outline]
front = [bm.verts.new((x, -PT, z)) for x, z in outline]
for k in range(len(outline)):
    bm.faces.new((back[k], back[(k + 1) % len(outline)], front[(k + 1) % len(outline)], front[k]))
bm.faces.new(back)
bm.faces.new(front[::-1])
frame = from_bmesh("FlushPlate", bm, MAT["Plate"])
modify(frame, "BEVEL", width=0.0015, segments=2, limit_method="ANGLE", angle_limit=math.radians(40))
recess = box("Recess", -0.1035, 0.1035, -PT - 0.01, -PT + 0.0025, -0.0585, 0.0585, MAT["PlateGap"], 0.002)
modify(frame, "BOOLEAN", operation="DIFFERENCE", solver="EXACT", object=recess, material_mode="TRANSFER")
bpy.data.objects.remove(recess)
buttons = [box("Button", x0, x1, -PT + 0.0002, -PT + 0.003, -0.056, 0.056, MAT["Plate"], 0.0009)
           for x0, x1 in ((-0.1015, -0.0385), (-0.0355, 0.1015))]  # half flush (small), full flush (large)
bpy.ops.object.select_all(action="DESELECT")
for p in [frame, *buttons]:
    p.select_set(True)
bpy.context.view_layer.objects.active = frame
bpy.ops.object.join()
frame.data.name = "FlushPlate"
frame.data.set_sharp_from_angle(angle=math.radians(40))
frame.location = (0.0, 0.0, PLATE_Z)

tris = 0
for o in (bowl, frame):
    o.data.calc_loop_triangles()
    tris += len(o.data.loop_triangles)
print(f"toilet: {tris} triangles")

bpy.ops.object.select_all(action="DESELECT")
for o in (bowl, frame):
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_cameras=False, export_lights=False)

# ---- Preview renders in a small tiled corner: front three-quarter, side, the plate up close.
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    world = bpy.data.worlds.new("Room")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.3, 0.3, 0.31, 1)
    scene.world = world
    bpy.ops.object.light_add(type="AREA", location=(0.6, -1.4, 2.2))
    key = bpy.context.active_object
    key.data.energy, key.data.size = 250, 1.2
    key.rotation_euler = (Vector((0, -0.3, 0.4)) - key.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.mesh.primitive_plane_add(size=4, location=(0, -2.0, 0))
    bpy.context.active_object.data.materials.append(material("Floor", (0.08, 0.08, 0.085), 0.6))
    bpy.ops.mesh.primitive_plane_add(size=4, location=(0, 0, 2.0), rotation=(math.pi / 2, 0, 0))
    bpy.context.active_object.data.materials.append(material("Wall", (0.45, 0.44, 0.42), 0.8))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    for label, loc, target, lens, res in (("toilet_front34", (1.1, -1.6, 1.25), (0, -0.25, 0.55), 35, (900, 1100)),
                                         ("toilet_side", (2.4, -0.30, 0.55), (0, -0.30, 0.55), 50, (1000, 1000)),
                                         ("toilet_close", (0.22, -0.62, 1.12), (0.0, 0.0, 0.99), 50, (1000, 800))):
        scene.render.resolution_x, scene.render.resolution_y = res
        cam.location = loc
        cam.data.lens = lens
        cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
