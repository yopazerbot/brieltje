"""Build the kitchen's bean-to-cup coffee machine (like a Jura E8 in Piano Black) in Blender.

Run (Blender 5, no window):
  blender -b -P tools/coffee_machine.py -- <out.glb> [preview_dir]

Our own model from the published size and product photos (used only to compare):
28.0 x 35.1 x 44.6 cm (W x H x D). It stands in a niche of 52 x 55 x 50 cm in the tall
units, so nothing may stick out of that box. As on the real machine: two tall side
columns with rounded front edges and a recessed cup bay between them; the colour
display with three buttons either side at the top of the bay; the height-adjustable
coffee spout below it (a black housing with a silver ring, two outlets on silver rails);
the milk spout on the right column; the water tank set into the left side; the bean
container's smoked lid on top behind the display and the on/off button on the right
column; a silver drip tray with a cup grid on a black plinth. No logos or text.

Output: one GLB with one mesh (CoffeeMachine). The origin is at the bottom, centred on
the footprint; the front (display, spouts) faces +z in the GLB (Blender -Y). With
preview_dir it also renders front three-quarter, front, side and close-up views there.
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

W, H, D = 0.280, 0.351, 0.446
HW = W / 2
FRONT, BACK = -D / 2, D / 2   # the drip tray's nose is the front-most point
COL_FRONT = -0.198            # front of the two side columns
BAY_HW, BAY_BACK = 0.075, -0.150  # the cup bay between the columns
BODY_Z0, TOP = 0.022, 0.3495  # body from the plinth to the top (the bean lid rises to H)
TRAY_Z = (0.024, 0.040)
BAY_TOP = 0.282               # underside of the display section


def material(name, color, rough=0.5, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
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


def bevel(obj, width, segments=3, angle=40):
    return modify(obj, "BEVEL", width=width, segments=segments, limit_method="ANGLE", angle_limit=math.radians(angle))


def cut(obj, cutter):
    props = {"operation": "DIFFERENCE", "solver": "EXACT", "object": cutter}
    modify(obj, "BOOLEAN", **props)
    bpy.data.objects.remove(cutter)


def from_bmesh(name, bm, mat, recalc=True):
    if recalc:  # closed parts; flat ones are wound to face the front
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    return link(bpy.data.objects.new(name, me))


def fillet(corners, step=math.pi / 16):
    """Closed outline through the corners (u, v, r), each rounded with radius r: a list of (u, v)."""
    pts = []
    n = len(corners)
    for i, (x, y, r) in enumerate(corners):
        if r <= 0:
            pts.append((x, y))
            continue
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


def prism(name, outline, w0, w1, mat, axis="Z"):
    """A straight extrusion of a closed outline (u, v) from w0 to w1 along an axis."""
    place = {"Z": lambda u, v, w: (u, v, w), "X": lambda u, v, w: (w, u, v), "Y": lambda u, v, w: (u, w, v)}[axis]
    bm = bmesh.new()
    lo = [bm.verts.new(place(u, v, w0)) for u, v in outline]
    hi = [bm.verts.new(place(u, v, w1)) for u, v in outline]
    n = len(outline)
    for i in range(n):
        bm.faces.new((lo[i], lo[(i + 1) % n], hi[(i + 1) % n], hi[i]))
    bm.faces.new(hi)
    bm.faces.new(lo[::-1])
    return from_bmesh(name, bm, mat)


def rrect(u0, u1, v0, v1, r):
    return fillet([(u1, v1, r), (u0, v1, r), (u0, v0, r), (u1, v0, r)])


def box(name, x0, x1, y0, y1, z0, z1, mat, round_=0.0, segments=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector(((x0 + x1) / 2 + v.co.x * (x1 - x0), (y0 + y1) / 2 + v.co.y * (y1 - y0), (z0 + z1) / 2 + v.co.z * (z1 - z0)))
    obj = from_bmesh(name, bm, mat)
    return bevel(obj, round_, segments) if round_ else obj


def cylinder(name, at, r, length, mat, axis="Z", seg=20, round_=0.0):
    """A cylinder whose base centre is at `at`, running `length` along +axis (or -Y for axis "-Y")."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=length)
    rot = {"Z": Matrix(), "-Y": Matrix.Rotation(math.pi / 2, 4, "X"), "X": Matrix.Rotation(math.pi / 2, 4, "Y")}[axis]
    d = {"Z": Vector((0, 0, 1)), "-Y": Vector((0, -1, 0)), "X": Vector((1, 0, 0))}[axis]
    bmesh.ops.transform(bm, matrix=Matrix.Translation(Vector(at) + d * length / 2) @ rot, verts=bm.verts)
    obj = from_bmesh(name, bm, mat)
    return bevel(obj, round_, 2) if round_ else obj


def ring(name, at, r_out, r_in, depth, mat, seg=28):
    """A flat ring facing the front (-Y), its back at `at`."""
    bm = bmesh.new()
    x, y, z = at
    loops = [[bm.verts.new((x + r * math.cos(2 * math.pi * k / seg), y + dy, z + r * math.sin(2 * math.pi * k / seg)))
              for k in range(seg)] for r, dy in ((r_out, 0), (r_out, -depth), (r_in, -depth), (r_in, 0))]
    for a, b in zip(loops, loops[1:] + loops[:1]):
        for k in range(seg):
            bm.faces.new((a[k], a[(k + 1) % seg], b[(k + 1) % seg], b[k]))
    return from_bmesh(name, bm, mat)


def plate(name, x0, x1, z0, z1, y, mat):
    """A flat rectangle facing the front at depth y."""
    bm = bmesh.new()
    bm.faces.new([bm.verts.new(p) for p in ((x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1))])
    return from_bmesh(name, bm, mat, recalc=False)


def disc(name, x, y, z, r, mat, seg=10):
    bm = bmesh.new()
    bm.faces.new([bm.verts.new((x + r * math.cos(2 * math.pi * k / seg), y, z + r * math.sin(2 * math.pi * k / seg)))
                  for k in range(seg)])
    return from_bmesh(name, bm, mat, recalc=False)


bpy.ops.wm.read_factory_settings(use_empty=True)
M = {  # materials
    "PianoBlack": material("PianoBlack", (0.006, 0.006, 0.007), 0.08),
    "DisplayGlass": material("DisplayGlass", (0.004, 0.004, 0.005), 0.05),
    "Screen": material("Screen", (0.006, 0.008, 0.016), 0.05),
    "ScreenUI": material("ScreenUI", (0.05, 0.05, 0.056), 0.3),
    "Silver": material("Silver", (0.80, 0.80, 0.80), 0.2, 1.0),
    "MatteBlack": material("MatteBlack", (0.012, 0.012, 0.012), 0.55),
    "Smoke": material("Smoke", (0.016, 0.016, 0.018), 0.1),
    "Icon": material("Icon", (0.42, 0.42, 0.43), 0.4),
}
parts = []

# ---- Body: one block with rounded corners in plan, then the cup bay and the tank recess cut out.
plan = fillet([(HW, BACK, 0.025), (-HW, BACK, 0.025), (-HW, COL_FRONT, 0.06), (HW, COL_FRONT, 0.06)])
body = bevel(prism("Body", plan, BODY_Z0, TOP, M["PianoBlack"]), 0.007, 4, 30)
bay = fillet([(0.12, -0.30, 0), (0.12, COL_FRONT - 0.0002, 0), (BAY_HW, COL_FRONT - 0.0002, 0.005),
              (BAY_HW, BAY_BACK, 0.016), (-BAY_HW, BAY_BACK, 0.016), (-BAY_HW, COL_FRONT - 0.0002, 0.005),
              (-0.12, COL_FRONT - 0.0002, 0), (-0.12, -0.30, 0)])
cut(body, prism("BayCut", bay, 0.030, BAY_TOP, M["PianoBlack"]))
# The water tank sits in a shallow recess in the left side, from behind the front column to the back.
TANK = (-0.132, 0.188, 0.046, 0.334)  # y0, y1, z0, z1
cut(body, prism("TankCut", rrect(*TANK, 0.016), -0.17, -HW + 0.0028, M["Smoke"], axis="X"))
parts.append(body)
parts.append(bevel(prism("Tank", rrect(TANK[0] + 0.001, TANK[1] - 0.001, TANK[2] + 0.001, TANK[3] - 0.001, 0.015),
                         -HW, -HW + 0.0045, M["Smoke"], axis="X"), 0.0012, 2))
# A seam across the back wall of the bay, where the cup area's panel meets the spout's.
parts.append(box("Seam", -BAY_HW + 0.004, BAY_HW - 0.004, BAY_BACK - 0.0006, BAY_BACK + 0.001, 0.1445, 0.1455,
                 M["MatteBlack"]))

# ---- Plinth: black, set in, its front sloping back under the drip tray.
bm = bmesh.new()
rings = []
for z, inset, front in ((0.0, 0.016, -0.168), (0.006, 0.010, -0.180), (TRAY_Z[0] + 0.002, 0.006, -0.186)):
    rings.append([bm.verts.new((x, y, z)) for x, y in fillet([(HW - inset, BACK - 0.012, 0.02), (-HW + inset, BACK - 0.012, 0.02),
                                                              (-HW + inset, front, 0.03), (HW - inset, front, 0.03)])])
n = len(rings[0])
for a, b in zip(rings, rings[1:]):
    for i in range(n):
        bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
bm.faces.new(rings[0][::-1])
bm.faces.new(rings[-1])
parts.append(from_bmesh("Plinth", bm, M["MatteBlack"]))

# ---- Drip tray: silver, its nose curved forward, with a grid of silver bars over a dark insert.
R = (HW ** 2 + 0.018 ** 2) / (2 * 0.018)  # arc through the tray's front corners and its nose at FRONT
phi = math.asin((HW - 0.0015) / R)
nose = [(R * math.sin(t), FRONT + R - R * math.cos(t)) for t in (phi * (1 - 2 * k / 16) for k in range(17))]
tray = [(HW - 0.0015, -0.14), (-HW + 0.0015, -0.14)] + nose[::-1]  # counter-clockwise, the nose left to right
parts.append(bevel(prism("DripTray", tray, *TRAY_Z, M["Silver"]), 0.003, 3, 50))


def nose_y(x):
    return FRONT + R - math.sqrt(R * R - x * x)


grid = [(0.121, BAY_BACK - 0.002), (-0.121, BAY_BACK - 0.002)] + [(x, nose_y(x) + 0.0075) for x in
                                                                  (-0.121 + 0.242 * k / 16 for k in range(17))]
parts.append(prism("GridInsert", grid, TRAY_Z[1] - 0.001, TRAY_Z[1] + 0.0004, M["MatteBlack"]))
for k in range(9):  # bars along the width, shorter towards the curved nose
    y = FRONT + 0.0125 + k * 0.0072
    hx = min(0.116, math.sqrt(max(0.0, R * R - (R + FRONT + 0.0095 - (y - 0.0018)) ** 2)))
    parts.append(box("GridBar", -hx, hx, y - 0.0018, y + 0.0018, TRAY_Z[1], TRAY_Z[1] + 0.0016, M["Silver"]))

# ---- Display section: a black glass panel across the top of the bay; the screen, three buttons either side.
GLASS_Y = COL_FRONT - 0.0035
parts.append(box("DisplayGlass", -BAY_HW + 0.003, BAY_HW - 0.003, GLASS_Y, COL_FRONT + 0.003, BAY_TOP + 0.001, TOP - 0.0015,
                 M["DisplayGlass"], 0.0015))
parts.append(plate("Screen", -0.0375, 0.0375, 0.2905, 0.3415, GLASS_Y - 0.0002, M["Screen"]))
# The lit interface, kept dim: four small product icons and a status bar, no text.
for xc in (-0.024, 0.024):
    for zc in (0.3285, 0.3095):
        parts.append(plate("ScreenIcon", xc - 0.005, xc + 0.005, zc - 0.006, zc + 0.006, GLASS_Y - 0.0004, M["ScreenUI"]))
parts.append(plate("ScreenBar", -0.031, 0.031, 0.2948, 0.2964, GLASS_Y - 0.0004, M["ScreenUI"]))
for side in (-1, 1):
    for row, z in enumerate((0.3305, 0.3145, 0.2985)):
        xc = side * 0.0565
        parts.append(box("Button", xc - 0.0095, xc + 0.0095, GLASS_Y - 0.0012, GLASS_Y + 0.001, z - 0.0068, z + 0.0068,
                         M["DisplayGlass"], 0.0008, 2))
        mark = xc + side * 0.004
        if row < 2:
            parts.append(disc("ButtonDot", mark, GLASS_Y - 0.00125, z, 0.0011, M["Icon"]))
        else:
            parts.append(plate("ButtonDash", mark - 0.0022, mark + 0.0022, z - 0.0004, z + 0.0004, GLASS_Y - 0.00125, M["Icon"]))

# ---- Coffee spout: a black housing with a plain silver ring, below it two silver outlets joined by a bridge.
SP_Y = COL_FRONT - 0.002
parts.append(box("SpoutHousing", -0.029, 0.029, SP_Y, BAY_BACK + 0.01, 0.197, 0.275, M["PianoBlack"], 0.0025, 3))
parts.append(ring("SpoutRing", (0, SP_Y + 0.0002, 0.240), 0.0125, 0.0104, 0.0014, M["Silver"]))
for side in (-1, 1):
    x = side * 0.0215
    parts.append(box("Outlet", x - 0.0045, x + 0.0045, SP_Y + 0.003, SP_Y + 0.026, 0.140, 0.2, M["Silver"], 0.0015, 2))
    parts.append(cylinder("OutletTip", (x, SP_Y + 0.0145, 0.1355), 0.0032, 0.005, M["MatteBlack"], seg=12))
parts.append(box("SpoutCore", -0.017, 0.017, SP_Y + 0.008, SP_Y + 0.03, 0.158, 0.2, M["MatteBlack"]))
parts.append(box("SpoutBridge", -0.017, 0.017, SP_Y + 0.004, SP_Y + 0.024, 0.171, 0.178, M["Silver"], 0.001, 2))

# ---- Milk spout on the right column: a black rail, a silver sleeve, the selector dial and the nozzle.
MX, MY = 0.1125, -0.2108
parts.append(box("MilkRail", MX - 0.0095, MX + 0.0095, COL_FRONT - 0.006, COL_FRONT + 0.014, 0.178, 0.283, M["PianoBlack"],
                 0.003, 2))
parts.append(cylinder("MilkPipe", (MX - 0.0135, COL_FRONT - 0.002, 0.186), 0.0042, 0.084, M["MatteBlack"], seg=12))
parts.append(cylinder("MilkSleeve", (MX, MY, 0.236), 0.011, 0.045, M["Silver"], seg=24, round_=0.002))
parts.append(cylinder("MilkBody", (MX, MY, 0.207), 0.0085, 0.029, M["PianoBlack"]))
parts.append(cylinder("MilkDial", (MX, MY - 0.0078, 0.2215), 0.0062, 0.0032, M["Silver"], axis="-Y", round_=0.0008))
parts.append(cylinder("MilkNozzle", (MX, MY, 0.188), 0.0062, 0.019, M["Silver"]))
parts.append(cylinder("MilkTip", (MX, MY, 0.181), 0.0056, 0.007, M["Icon"]))

# ---- Top: the bean container's smoked lid behind the display, the on/off button on the right column.
parts.append(bevel(prism("BeanLid", rrect(-0.056, 0.056, -0.172, -0.058, 0.014), TOP - 0.001, H, M["Smoke"]), 0.0012, 2))
parts.append(bevel(prism("FunnelLid", rrect(-0.018, 0.018, -0.046, -0.012, 0.006), TOP - 0.001, TOP + 0.0006,
                         M["PianoBlack"]), 0.0006, 2))
parts.append(cylinder("PowerButton", (0.108, -0.168, TOP - 0.0008), 0.0055, 0.0018, M["Silver"], round_=0.0006))

# ---- Join into one mesh and smooth it.
bpy.ops.object.select_all(action="DESELECT")
for p in parts:
    p.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
body.name = body.data.name = "CoffeeMachine"
body.data.set_sharp_from_angle(angle=math.radians(35))
body.data.calc_loop_triangles()
print(f"coffee_machine: {len(body.data.loop_triangles)} triangles")

bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_cameras=False, export_lights=False)

# ---- Preview renders: front three-quarter, front, side (the water tank) and a close-up of the spouts.
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 960, 960
    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    nt = world.node_tree
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    nt.links.new(coord.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], ramp.inputs[0])
    nt.links.new(ramp.outputs["Color"], nt.nodes["Background"].inputs["Color"])
    ramp.color_ramp.elements[0].color = (0.10, 0.10, 0.10, 1)
    ramp.color_ramp.elements[1].position = 0.6
    ramp.color_ramp.elements[1].color = (0.95, 0.95, 0.95, 1)
    mid = ramp.color_ramp.elements.new(0.06)
    mid.color = (0.45, 0.45, 0.45, 1)
    scene.world = world
    bpy.ops.object.light_add(type="AREA", location=(-0.6, -0.9, 1.2))
    key = bpy.context.active_object
    key.data.energy, key.data.size = 120, 1.0
    key.rotation_euler = (Vector((0, 0, 0.2)) - key.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(55), 0, math.radians(-35)))
    bpy.context.active_object.data.energy = 1.5
    bpy.ops.mesh.primitive_plane_add(size=6)
    bpy.context.active_object.data.materials.append(material("Counter", (0.55, 0.55, 0.53), 0.5))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    for label, at, target, lens in (("coffee_front34", (0.62, -0.95, 0.52), (0, 0, 0.17), 55),
                                    ("coffee_front", (0, -1.4, 0.19), (0, 0, 0.175), 60),
                                    ("coffee_side", (-1.3, -0.15, 0.30), (0, 0, 0.17), 55),
                                    ("coffee_close", (0.17, -0.53, 0.32), (0.03, -0.2, 0.238), 45)):
        cam.location = at
        cam.data.lens = lens
        cam.rotation_euler = (Vector(target) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
