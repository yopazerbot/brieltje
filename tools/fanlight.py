"""Build the old bungalow's front door fanlight in Blender: a sunburst fanlight in a stone arch.

Run (Blender 5, no window):
  blender -b -P tools/fanlight.py -- <out.glb> [preview_dir]

Our own design of a typical Belgian front door fanlight. It fills the rectangular opening
above the 1.00 m wide front door: 1.00 m wide, 0.50 m high, in the 0.30 m outer wall. In
it a semicircular fanlight (radius 0.50 m, its springing line on the opening's bottom
edge): a white frame along the arc and the transom, a small half-hub at the bottom centre
and five glazing bars fanning out from it (the "sunburst"). The frame sits in the middle of
the wall's depth like the house's other frames. The two upper corners outside the arc
(the spandrels) are solid light stone through the full wall depth. On the outside face a
light stone arch band 0.12 m wide follows the arc, 0.02 m proud of the brick, with incised
V-joints between its voussoirs and a key stone at the crown that stands out a little further
and rises 6 cm above the band. The middle voussoir a side is a long block with a square
outer corner, so the spandrels' corners don't show as stone patches outside the band.

Output: one GLB with two meshes, which the game places as one: Fanlight (stone and frame)
and FanlightGlass (one double-sided pane, alpha blended). The origin is at the bottom
centre of the opening on the wall's outer face; x runs across the opening, y up, and the
wall runs from z = 0 into -z (the outside faces +z in the GLB, Blender -Y). With
preview_dir it also renders outside, inside and close-up views there, in a brick wall.
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

W, H, T = 1.00, 0.50, 0.30      # the opening; the wall's depth (Blender y from 0 outside to T inside)
R = 0.50                        # the arc's radius, centred on the opening's bottom edge
N = 48                          # segments along the half circle
FRAME_W, FRAME_D = 0.055, 0.07  # face width and depth of the white frame
FRAME_Y = T / 2                 # the frame's centre in the wall's depth
TRANSOM = 0.06                  # height of the bottom transom
HUB = 0.075                     # radius of the half-hub
BAR_W, BAR_D = 0.024, 0.04      # glazing bars
BAND, PROUD = 0.12, 0.02        # the arch band's width and how far it stands out
KEY_ANGLE, KEY_TOP, KEY_PROUD = math.radians(6.0), 0.68, 0.034  # half its angle, its top, how far it stands out


def material(name, color, rough=0.5, metal=0.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if alpha < 1.0:  # the exporter writes alphaMode BLEND for an alpha below 1; Eevee needs the blended method
        p.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
        m.use_backface_culling = False  # both sides show: exported double-sided
    else:
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
    """Add a modifier with these settings and apply it."""
    mod = obj.modifiers.new(kind.lower(), kind)
    for k, v in props.items():
        setattr(mod, k, v)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)
    return obj


def boolean(obj, other, operation):
    modify(obj, "BOOLEAN", operation=operation, solver="EXACT", object=other)
    bpy.data.objects.remove(other)


def from_bmesh(name, bm, mat, recalc=True):
    if recalc:  # closed parts; the flat pane is wound to face the outside
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    return link(bpy.data.objects.new(name, me))


def prism(name, outline, y0, y1, mat):
    """A closed outline (x, z) on the wall face, extruded through the wall's depth from y0 to y1."""
    bm = bmesh.new()
    a = [bm.verts.new((x, y0, z)) for x, z in outline]
    b = [bm.verts.new((x, y1, z)) for x, z in outline]
    n = len(outline)
    for i in range(n):
        bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    bm.faces.new(a)
    bm.faces.new(b[::-1])
    return from_bmesh(name, bm, mat)


def arc(r, t0, t1, n, cx=0.0, cz=0.0):
    """n + 1 points (x, z) on a circle from angle t0 to t1."""
    return [(cx + r * math.cos(t0 + (t1 - t0) * k / n), cz + r * math.sin(t0 + (t1 - t0) * k / n)) for k in range(n + 1)]


def drop_faces(obj, test):
    """Delete the faces whose centre and normal pass the test (those hidden against the wall)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if test(f.calc_center_median(), f.normal)], context="FACES")
    bm.to_mesh(obj.data)
    bm.free()


def join(parts, name):
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    obj = parts[0]
    obj.name = obj.data.name = name
    return obj


bpy.ops.wm.read_factory_settings(use_empty=True)
M = {
    "Stone": material("Stone", srgb("#e6e1d6"), 0.85),
    "Frame": material("Frame", srgb("#f3f1ec"), 0.5),
    "Glass": material("Glass", srgb("#cfe3ea"), 0.05, 0.1, alpha=0.35),
}

# ---- Spandrels: the opening's two upper corners outside the arc, stone through the wall.
# Each runs from its corner to the top or side and down the arc (its curved face is the arch's soffit).
parts = []
for t0, t1, corner in ((math.pi / 2, 0.0, (W / 2, H)), (math.pi, math.pi / 2, (-W / 2, H))):
    parts.append(prism("Spandrel", [corner] + arc(R, t0, t1, N // 2), 0.0, T, M["Stone"]))

# ---- Arch band on the outside face: three voussoirs a side of the key stone, split by V-joints. The
# middle one (30 to 60 degrees) is a long block with a square outer corner: it covers the spandrel's
# corner, which would otherwise show as a patch of stone outside the band (a Gibbs-like rhythm).
band = prism("Band", arc(R, 0.0, math.pi, N) + arc(R + BAND, math.pi, 0.0, N), -PROUD, 0.0, M["Stone"])
LONG = (math.radians(30), math.radians(60), 0.57)  # its joints and its square corner (x = z)
for s in (1, -1):
    a0, a1, sq = LONG
    outline = arc(R, a0, a1, 8) + [(sq / math.tan(a1), sq), (sq, sq), (sq, sq * math.tan(a0))]
    boolean(band, prism("Long", [(s * x, z) for x, z in outline], -PROUD, 0.0, M["Stone"]), "UNION")
modify(band, "BEVEL", width=0.003, segments=1, limit_method="ANGLE", angle_limit=math.radians(40))  # arrised edges
JOINT_W, JOINT_D = 0.007, 0.007  # half the V's width at the face, and its depth
V = [(-JOINT_W, -PROUD - 0.01), (JOINT_W, -PROUD - 0.01), (JOINT_W, -PROUD), (0.0, -PROUD + JOINT_D), (-JOINT_W, -PROUD)]
for t0 in LONG[:2]:
    for t in (t0, math.pi - t0):
        bm = bmesh.new()  # the V's section (x, y) run up z through the band, then turned to the joint's angle
        lo = [bm.verts.new((u, y, R - 0.03)) for u, y in V]
        hi = [bm.verts.new((u, y, 0.75)) for u, y in V]
        for i in range(len(V)):
            bm.faces.new((lo[i], lo[(i + 1) % len(V)], hi[(i + 1) % len(V)], hi[i]))
        bm.faces.new(lo)
        bm.faces.new(hi[::-1])
        bmesh.ops.transform(bm, matrix=Matrix.Rotation(math.pi / 2 - t, 4, "Y"), verts=bm.verts)
        boolean(band, from_bmesh("Joint", bm, M["Stone"]), "DIFFERENCE")
# The key stone: radial sides, a flat top, standing out further than the band.
key_half = KEY_TOP * math.tan(KEY_ANGLE)
key = prism("KeyStone", arc(R, math.pi / 2 + KEY_ANGLE, math.pi / 2 - KEY_ANGLE, 4) + [(key_half, KEY_TOP), (-key_half, KEY_TOP)],
            -KEY_PROUD, 0.0, M["Stone"])
modify(key, "BEVEL", width=0.004, segments=1, limit_method="ANGLE", angle_limit=math.radians(40))
for part in (band, key):  # their backs lie on the brick and on the spandrels' face
    drop_faces(part, lambda c, n: n.y > 0.9 and abs(c.y) < 1e-4)
parts += [band, key]

# ---- Frame: the arc and the transom, then the half-hub and five glazing bars, all one white piece.
y0, y1 = FRAME_Y - FRAME_D / 2, FRAME_Y + FRAME_D / 2
frame = prism("Frame", arc(R - FRAME_W, 0.0, math.pi, N) + arc(R, math.pi, 0.0, N), y0, y1, M["Frame"])
boolean(frame, prism("Transom", [(-W / 2, 0.0), (W / 2, 0.0), (W / 2, TRANSOM), (-W / 2, TRANSOM)], y0, y1, M["Frame"]), "UNION")
HC = Vector((0.0, TRANSOM))  # the hub's centre, on the transom
hub = arc(HUB, 0.0, math.pi, 12, 0.0, TRANSOM) + [(-HUB, TRANSOM - 0.02), (HUB, TRANSOM - 0.02)]
boolean(frame, prism("Hub", hub, FRAME_Y - 0.025, FRAME_Y + 0.025, M["Frame"]), "UNION")
for k in range(1, 6):  # every 30 degrees, out from inside the hub to the middle of the arc frame
    d = Vector((math.cos(math.pi * k / 6), math.sin(math.pi * k / 6)))
    rr = R - FRAME_W / 2
    s = -HC.dot(d) + math.sqrt(HC.dot(d) ** 2 - HC.length_squared + rr * rr)  # |HC + s d| = rr
    w = Vector((-d.y, d.x)) * BAR_W / 2
    a, b = HC + d * HUB * 0.5, HC + d * s
    boolean(frame, prism("Bar", [tuple(a - w), tuple(b - w), tuple(b + w), tuple(a + w)], FRAME_Y - BAR_D / 2,
                         FRAME_Y + BAR_D / 2, M["Frame"]), "UNION")
modify(frame, "BEVEL", width=0.003, segments=1, limit_method="ANGLE", angle_limit=math.radians(40))
# The frame's outer face lies on the soffit and its ends on the reveals: hidden.
drop_faces(frame, lambda c, n: (c.z > 0.01 and Vector((c.x, c.z)).length > R - 1e-3 and Vector((n.x, n.z)).dot(Vector((c.x, c.z))) > 0.9 * R)
           or abs(abs(c.x) - W / 2) < 1e-4)
parts.append(frame)

fanlight = join(parts, "Fanlight")
fanlight.data.set_sharp_from_angle(angle=math.radians(35))

# ---- Glass: one pane in the frame's middle, from the transom into the arc frame's rebate.
bm = bmesh.new()
gz = TRANSOM - 0.01
gx = math.sqrt((R - 0.03) ** 2 - gz * gz)
t0 = math.atan2(gz, gx)
pane = arc(R - 0.03, t0, math.pi - t0, N)
bm.faces.new([bm.verts.new((x, FRAME_Y, z)) for x, z in pane][::-1])  # wound to face the outside (-Y)
glass = from_bmesh("FanlightGlass", bm, M["Glass"], recalc=False)
if glass.data.polygons[0].normal.y > 0:
    glass.data.flip_normals()

tris = 0
for o in (fanlight, glass):
    o.data.calc_loop_triangles()
    tris += len(o.data.loop_triangles)
    print(f"{o.name}: {len(o.data.loop_triangles)} triangles")
print(f"fanlight: {tris} triangles")

bpy.ops.object.select_all(action="DESELECT")
for o in (fanlight, glass):
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=False, export_cameras=False, export_lights=False)

# ---- Preview renders in a pale brick wall with the door below: outside three-quarter, front, inside, close-up.
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.view_settings.view_transform = "ACES 1.3"  # the game renders with ACES filmic tone mapping
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.62, 0.72, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    scene.world = world
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(50), 0, math.radians(-30)))
    bpy.context.active_object.data.energy = 3.0
    brick = material("PreviewBrick", srgb("#d9cbb0"), 0.9)
    wall = prism("Wall", [(-1.6, -2.1), (1.6, -2.1), (1.6, 1.2), (-1.6, 1.2)], 0.0, T, brick)
    boolean(wall, prism("Opening", [(-W / 2, -2.2), (W / 2, -2.2), (W / 2, H), (-W / 2, H)], -0.1, T + 0.1, brick), "DIFFERENCE")
    door = material("PreviewDoor", srgb("#5a3a2a"), 0.6)
    prism("Door", [(-W / 2, -2.1), (W / 2, -2.1), (W / 2, 0.0), (-W / 2, 0.0)], FRAME_Y - 0.025, FRAME_Y + 0.025, door)
    bpy.ops.mesh.primitive_plane_add(size=8, location=(0, -2.0, -2.1))
    bpy.context.active_object.data.materials.append(material("PreviewGround", (0.12, 0.12, 0.11), 0.9))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    for label, loc, target, lens, res in (("fanlight_front34", (1.5, -2.6, -0.4), (0, 0, 0.25), 45, (1000, 900)),
                                         ("fanlight_front", (0, -3.2, 0.3), (0, 0, 0.3), 50, (1000, 800)),
                                         ("fanlight_inside", (-0.9, 2.4, -0.2), (0, T, 0.25), 45, (1000, 900)),
                                         ("fanlight_inside_close", (0.35, 1.25, 0.05), (0, T, 0.2), 40, (1000, 800)),
                                         ("fanlight_close", (0.55, -1.05, -0.05), (0.05, 0.1, 0.3), 40, (1000, 900)),
                                         ("fanlight_below", (0.15, -0.9, -1.0), (0, 0.15, 0.35), 35, (900, 900))):
        scene.render.resolution_x, scene.render.resolution_y = res
        cam.location = loc
        cam.data.lens = lens
        cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
