"""Build the village notice board on the church square, the one that shows the best Zombies runs, in Blender.

Run (Blender 5, no window):
  blender -b -P tools/town_board.py -- <out.glb> [preview_dir]

  e.g. blender -b -P tools/town_board.py -- web/public/models/town_board.glb

A notice board as Flemish villages put them on their squares (a "gemeentelijk informatiebord"): two square
steel posts on concrete feet, a lockable display case between them, a name plate above it and a small
pitched roof over the lot, all powder-coated anthracite (RAL 7016). The sizes are the usual ones for such a
board: about 2.4 m high and 1.7 m wide over the roof, posts of 80 mm, a case 13 cm deep with a glass of
1.2 x 0.9 m. No logo or coat of arms: the plate says "Smetlede" in plain white letters.

Two objects, standing on the origin (the middle between the feet, at ground level), the glass facing +z in
the GLB (Blender -Y):
- Board: everything but the glass, one material whose colour is in the vertex colours, with a soft contact
  shade baked in (the ground, the roof's overhang, the case's reveal), worked out here by casting rays, as
  tools/town/town.py does for the square's houses. One draw call in the game.
- Display: the glass with the poster behind it, one quad with UVs 0 to 1 (u to the right, v up). The game
  (web/src/world/townBoard.ts) draws the board of best runs on it, lit softly at night.

The preview renders (Eevee) show it from the front, at an angle and from the back beside a 1.6 x 2.4 m box.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)

# Sizes (m). x across, y depth (the glass towards -y), z up.
POST = 0.08            # square steel posts
POST_X = 0.74          # their centres
POST_TOP = 2.26
FOOT = 0.28            # concrete feet, 6 cm above the paving, 40 cm below
FOOT_TOP = 0.06
CASE_X = POST_X - POST / 2   # the case fills the space between the posts
CASE_Z = (0.86, 1.96)
CASE_Y = (-0.075, 0.055)     # 13 cm deep
GLASS_W, GLASS_H = 1.20, 0.90
GLASS_Z0 = 0.95
GLASS_Y = -0.057             # the glass sits 18 mm behind the frame's face
PLATE_Z = (1.975, 2.175)       # the name plate
ROOF_X = 0.86
ROOF_EAVES = 2.26
ROOF_RIDGE = 2.40
ROOF_Y = (-0.30, 0.26)
RIDGE_Y = -0.02

ANTHRACITE = "#42484c"   # RAL 7016, powder-coated
ROOF = "#30353a"
REVEAL = "#2b2f32"
CONCRETE = "#8e8b84"
LETTERS = "#efefea"
STEEL = "#b9bdc0"


def srgb(h):
    """'#rrggbb' to linear RGB, as the Principled BSDF and glTF's vertex colours expect."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


bm = bmesh.new()
COL = bm.loops.layers.float_color.new("Color")


def face(pts, col, shade=True):
    f = bm.faces.new([bm.verts.new(tuple(p)) for p in pts])
    c = (*srgb(col), 1.0)
    for lp in f.loops:
        lp[COL] = c
    f.smooth = False
    if not shade:
        f.tag = True  # left out of the bake (the letters keep their white)
    return f


def grid(p0, du, dv, nu, nv, col):
    """A flat rectangle from corner p0 along du and dv, cut in nu x nv cells (so the baked shade can vary over it)."""
    p0, du, dv = Vector(p0), Vector(du), Vector(dv)
    for i in range(nu):
        for j in range(nv):
            a = p0 + du * (i / nu) + dv * (j / nv)
            b = p0 + du * ((i + 1) / nu) + dv * (j / nv)
            c = p0 + du * ((i + 1) / nu) + dv * ((j + 1) / nv)
            d = p0 + du * (i / nu) + dv * ((j + 1) / nv)
            face([a, b, c, d], col)


def box(x0, x1, y0, y1, z0, z1, col, step=0.25, bottom=False):
    """A block; its sides cut in cells of about `step` m. The underside only when asked (most stand on something)."""
    nx = max(1, round((x1 - x0) / step))
    ny = max(1, round((y1 - y0) / step))
    nz = max(1, round((z1 - z0) / step))
    grid((x0, y0, z0), (x1 - x0, 0, 0), (0, 0, z1 - z0), nx, nz, col)          # front (-y)
    grid((x1, y1, z0), (x0 - x1, 0, 0), (0, 0, z1 - z0), nx, nz, col)          # back (+y)
    grid((x0, y1, z0), (0, y0 - y1, 0), (0, 0, z1 - z0), ny, nz, col)          # left (-x)
    grid((x1, y0, z0), (0, y1 - y0, 0), (0, 0, z1 - z0), ny, nz, col)          # right (+x)
    grid((x0, y0, z1), (x1 - x0, 0, 0), (0, y1 - y0, 0), nx, ny, col)          # top
    if bottom:
        grid((x0, y1, z0), (x1 - x0, 0, 0), (0, y0 - y1, 0), nx, ny, col)


def cylinder_z(cx, cy, z0, z1, r, col, segs=10):
    ring = [(cx + r * math.cos(2 * math.pi * k / segs), cy + r * math.sin(2 * math.pi * k / segs)) for k in range(segs)]
    for k in range(segs):
        (ax, ay), (bx, by) = ring[k], ring[(k + 1) % segs]
        face([(ax, ay, z0), (bx, by, z0), (bx, by, z1), (ax, ay, z1)], col)
    face([(x, y, z1) for x, y in ring], col)
    face([(x, y, z0) for x, y in reversed(ring)], col)


def cylinder_y(cx, cz, y0, y1, r, col, segs=12):
    """A short cylinder along y, its cap towards -y (the lock's barrel on the frame)."""
    ring = [(cx + r * math.cos(2 * math.pi * k / segs), cz + r * math.sin(2 * math.pi * k / segs)) for k in range(segs)]
    for k in range(segs):
        (ax, az), (bx, bz) = ring[k], ring[(k + 1) % segs]
        face([(ax, y0, az), (ax, y1, az), (bx, y1, bz), (bx, y0, bz)], col)
    face([(x, y0, z) for x, z in ring], col)


def cylinder_x(cy, cz, x0, x1, r, col, segs=8):
    ring = [(cy + r * math.cos(2 * math.pi * k / segs), cz + r * math.sin(2 * math.pi * k / segs)) for k in range(segs)]
    for k in range(segs):
        (ay, az), (by, bz) = ring[k], ring[(k + 1) % segs]
        face([(x0, ay, az), (x0, by, bz), (x1, by, bz), (x1, ay, az)], col)
    face([(x0, y, z) for y, z in reversed(ring)], col)
    face([(x1, y, z) for y, z in ring], col)


# ---------------------------------------------------------------- feet and posts
for sx in (-1, 1):
    x = sx * POST_X
    # A concrete foot, its top edge chamfered; it reaches 40 cm into the ground for a sloping square.
    h, c = FOOT / 2, 0.02
    box(x - h, x + h, -h, h, -0.40, FOOT_TOP - c, CONCRETE, step=0.2)
    top = [(x - h + c, -h + c), (x + h - c, -h + c), (x + h - c, h - c), (x - h + c, h - c)]
    low = [(x - h, -h), (x + h, -h), (x + h, h), (x - h, h)]
    for k in range(4):
        (ax, ay), (bx, by) = low[k], low[(k + 1) % 4]
        (cx, cy), (dx, dy) = top[(k + 1) % 4], top[k]
        face([(ax, ay, FOOT_TOP - c), (bx, by, FOOT_TOP - c), (cx, cy, FOOT_TOP), (dx, dy, FOOT_TOP)], CONCRETE)
    face([(px, py, FOOT_TOP) for px, py in top], CONCRETE)
    # The post, and its cap.
    p = POST / 2
    box(x - p, x + p, -p, p, FOOT_TOP, POST_TOP, ANTHRACITE, step=0.2)
    box(x - p - 0.006, x + p + 0.006, -p - 0.006, p + 0.006, FOOT_TOP, FOOT_TOP + 0.012, ANTHRACITE)  # base plate
# A rail between the posts under the case.
box(-CASE_X, CASE_X, -0.02, 0.02, 0.50, 0.56, ANTHRACITE, step=0.2, bottom=True)

# ---------------------------------------------------------------- the display case
x0, x1 = -CASE_X, CASE_X
z0, z1 = CASE_Z
y0, y1 = CASE_Y
gx0, gx1 = -GLASS_W / 2, GLASS_W / 2
gz0, gz1 = GLASS_Z0, GLASS_Z0 + GLASS_H
# Its back, top, bottom and sides (the front is the frame round the glass).
grid((x1, y1, z0), (x0 - x1, 0, 0), (0, 0, z1 - z0), 6, 4, ANTHRACITE)
grid((x0, y0, z1), (x1 - x0, 0, 0), (0, y1 - y0, 0), 6, 1, ANTHRACITE)
grid((x0, y1, z0), (x1 - x0, 0, 0), (0, y0 - y1, 0), 6, 1, ANTHRACITE)
grid((x0, y1, z0), (0, y0 - y1, 0), (0, 0, z1 - z0), 1, 4, ANTHRACITE)
grid((x1, y0, z0), (0, y1 - y0, 0), (0, 0, z1 - z0), 1, 4, ANTHRACITE)
# The frame's face: four strips round the glass.
grid((x0, y0, z0), (x1 - x0, 0, 0), (0, 0, gz0 - z0), 6, 1, ANTHRACITE)
grid((x0, y0, gz1), (x1 - x0, 0, 0), (0, 0, z1 - gz1), 6, 1, ANTHRACITE)
grid((x0, y0, gz0), (gx0 - x0, 0, 0), (0, 0, gz1 - gz0), 1, 4, ANTHRACITE)
grid((gx1, y0, gz0), (x1 - gx1, 0, 0), (0, 0, gz1 - gz0), 1, 4, ANTHRACITE)
# The reveal from the frame's face back to the glass.
grid((gx0, y0, gz0), (gx1 - gx0, 0, 0), (0, GLASS_Y - y0, 0), 6, 1, REVEAL)            # sill, facing up
grid((gx0, GLASS_Y, gz1), (gx1 - gx0, 0, 0), (0, y0 - GLASS_Y, 0), 6, 1, REVEAL)       # head, facing down
grid((gx0, GLASS_Y, gz0), (0, 0, gz1 - gz0), (0, y0 - GLASS_Y, 0), 4, 1, REVEAL)       # left, facing +x
grid((gx1, y0, gz0), (0, 0, gz1 - gz0), (0, GLASS_Y - y0, 0), 4, 1, REVEAL)            # right, facing -x
# A thin bead round the glass, a shade lighter (the rubber seal's metal lip).
b = 0.012
for (ax, az, bx, bz) in ((gx0, gz0, gx1, gz0 + b), (gx0, gz1 - b, gx1, gz1), (gx0, gz0 + b, gx0 + b, gz1 - b), (gx1 - b, gz0 + b, gx1, gz1 - b)):
    face([(ax, GLASS_Y - 0.002, az), (bx, GLASS_Y - 0.002, az), (bx, GLASS_Y - 0.002, bz), (ax, GLASS_Y - 0.002, bz)], "#4a5054")
# The lock on the right of the frame, and two hinges on the left side.
cylinder_y(x1 - 0.05, (z0 + z1) / 2, y0 - 0.008, y0, 0.013, STEEL)
for hz in (z0 + 0.16, z1 - 0.16):
    cylinder_z(x0 + 0.02, y0 - 0.007, hz - 0.05, hz + 0.05, 0.008, ANTHRACITE, segs=8)

# ---------------------------------------------------------------- the name plate and its letters
pz0, pz1 = PLATE_Z
box(-CASE_X, CASE_X, -0.03, 0.02, pz0, pz1, ANTHRACITE, step=0.25, bottom=True)


def lettering(text, cx, cz, height, y):
    """Plain letters in Blender's own font, flat on the plate's face (2 mm proud), centred on (cx, cz)."""
    cu = bpy.data.curves.new("Name", type="FONT")
    cu.body = text
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.size = height / 0.72  # the font's capitals stand about 0.72 of its size
    cu.fill_mode = "FRONT"
    cu.resolution_u = 3
    ob = bpy.data.objects.new("Name", cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    tmp = bmesh.new()
    tmp.from_mesh(me)
    bmesh.ops.triangulate(tmp, faces=tmp.faces[:])
    for f in tmp.faces:
        pts = [(cx + v.co.x, y, cz + v.co.y) for v in f.verts]
        # The font lies in Blender's xy plane facing +z; laid in the xz plane it faces -y, as wanted.
        face(pts, LETTERS, shade=False)
    tmp.free()
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(me)


lettering("Smetlede", 0.0, (pz0 + pz1) / 2, 0.095, -0.032)

# ---------------------------------------------------------------- the roof
ry0, ry1 = ROOF_Y
T = 0.03  # the sheet's thickness
for (ya, yb) in ((ry0, RIDGE_Y), (ry1, RIDGE_Y)):
    za, zb = ROOF_EAVES, ROOF_RIDGE
    # The slope's top, its underside and its eaves edge.
    if ya < yb:
        grid((-ROOF_X, ya, za + T), (2 * ROOF_X, 0, 0), (0, yb - ya, zb - za), 7, 2, ROOF)
        grid((ROOF_X, ya, za), (-2 * ROOF_X, 0, 0), (0, yb - ya, zb - za), 7, 2, ROOF)
        face([(-ROOF_X, ya, za), (ROOF_X, ya, za), (ROOF_X, ya, za + T), (-ROOF_X, ya, za + T)], ROOF)
    else:
        grid((ROOF_X, ya, za + T), (-2 * ROOF_X, 0, 0), (0, yb - ya, zb - za), 7, 2, ROOF)
        grid((-ROOF_X, ya, za), (2 * ROOF_X, 0, 0), (0, yb - ya, zb - za), 7, 2, ROOF)
        face([(ROOF_X, ya, za), (-ROOF_X, ya, za), (-ROOF_X, ya, za + T), (ROOF_X, ya, za + T)], ROOF)
# The gable ends, closed: a flat triangle each side (the roof's thickness round it).
for sx in (-1, 1):
    x = sx * ROOF_X
    pts = [(x, ry0, ROOF_EAVES), (x, ry1, ROOF_EAVES), (x, ry1, ROOF_EAVES + T), (x, RIDGE_Y, ROOF_RIDGE + T), (x, ry0, ROOF_EAVES + T)]
    face(pts if sx > 0 else list(reversed(pts)), ROOF)
# Under the roof, a flat soffit between the posts' tops, so the roof reads as a closed hood from below.
grid((-ROOF_X + 0.02, ry1 - 0.04, ROOF_EAVES), (2 * ROOF_X - 0.04, 0, 0), (0, ry0 - ry1 + 0.08, 0), 7, 2, ROOF)
cylinder_x(RIDGE_Y, ROOF_RIDGE + T, -ROOF_X - 0.01, ROOF_X + 0.01, 0.022, ROOF)  # the ridge cap

# ---------------------------------------------------------------- baked contact shade
bm.normal_update()
bm.verts.index_update()
verts = [v.co.copy() for v in bm.verts]
polys = [[v.index for v in f.verts] for f in bm.faces]
# The paving round it, as an occluder only.
off = len(verts)
verts += [Vector((-6, -6, 0)), Vector((6, -6, 0)), Vector((6, 6, 0)), Vector((-6, 6, 0))]
polys.append([off, off + 1, off + 2, off + 3])
tree = BVHTree.FromPolygons(verts, polys, all_triangles=False, epsilon=0.0)
N_AO = 24
dirs = []
for k in range(N_AO):
    r = math.sqrt((k + 0.5) / N_AO)
    a = k * 2.399963
    dirs.append(Vector((r * math.cos(a), r * math.sin(a), math.sqrt(max(0.0, 1 - r * r)))))
cache = {}
for f in bm.faces:
    if f.tag:
        continue
    n = f.normal
    if n.length < 0.5:
        continue
    t = n.orthogonal().normalized()
    b2 = n.cross(t)
    for lp in f.loops:
        p = lp.vert.co
        key = (round(p.x, 3), round(p.y, 3), round(p.z, 3), round(n.x, 1), round(n.y, 1), round(n.z, 1))
        if key not in cache:
            q = p + n * 0.004
            hit = 0.0
            for d in dirs:
                w = t * d.x + b2 * d.y + n * d.z
                loc, _, _, dist = tree.ray_cast(q, w, 0.8)
                if loc is not None:
                    hit += 1.0 - 0.6 * dist / 0.8
            cache[key] = 1.0 - 0.55 * hit / N_AO
        s = cache[key]
        c = lp[COL]
        lp[COL] = (c[0] * s, c[1] * s, c[2] * s, 1.0)
print(f"baked the contact shade at {len(cache)} points")


# ---------------------------------------------------------------- objects and export
def material(name, color, rough, metal, vertex_colors):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*srgb(color), 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if vertex_colors:
        attr = m.node_tree.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "Color"
        m.node_tree.links.new(attr.outputs["Color"], p.inputs["Base Color"])
    m.use_backface_culling = True
    return m


me = bpy.data.meshes.new("Board")
bm.to_mesh(me)
bm.free()
me.materials.append(material("Board", "#ffffff", 0.55, 0.25, True))
board = bpy.data.objects.new("Board", me)
bpy.context.scene.collection.objects.link(board)

dm = bpy.data.meshes.new("Display")
dbm = bmesh.new()
uv = dbm.loops.layers.uv.new("UVMap")
corners = [((gx0, GLASS_Y, gz0), (0, 0)), ((gx1, GLASS_Y, gz0), (1, 0)), ((gx1, GLASS_Y, gz1), (1, 1)), ((gx0, GLASS_Y, gz1), (0, 1))]
df = dbm.faces.new([dbm.verts.new(p) for p, _ in corners])
for lp, (_, t_) in zip(df.loops, corners):
    lp[uv].uv = t_
dbm.to_mesh(dm)
dbm.free()
dm.materials.append(material("Display", "#e8e6df", 0.12, 0.0, False))
display = bpy.data.objects.new("Display", dm)
bpy.context.scene.collection.objects.link(display)

for o in (board, display):
    o.data.calc_loop_triangles()
    print(f"{o.name}: {len(o.data.loop_triangles)} triangles, {len(o.data.vertices)} vertices")
lo = Vector([min(v.co[i] for v in board.data.vertices) for i in range(3)])
hi = Vector([max(v.co[i] for v in board.data.vertices) for i in range(3)])
print(f"board: {hi.x - lo.x:.2f} m wide, {hi.y - lo.y:.2f} m deep, {hi.z:.2f} m high above the paving; glass {GLASS_W} x {GLASS_H} m")

bpy.ops.object.select_all(action="DESELECT")
board.select_set(True)
display.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=True, export_normals=True, export_extras=False, export_vertex_color="MATERIAL",
                          export_cameras=False, export_lights=False)
print(f"wrote {OUT}: {os.path.getsize(OUT) / 1024:.0f} KB")

# ---------------------------------------------------------------- previews
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 900, 900
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.62, 0.70, 0.80, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
    scene.world = world
    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, 0))
    bpy.context.active_object.data.materials.append(material("Paving", "#8f8d87", 0.9, 0, False))
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 5))
    sun = bpy.context.active_object
    sun.data.energy = 3.2
    sun.data.angle = math.radians(2)
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
    # A stand-in poster on the glass: a light paper with dark lines, as the game draws it.
    poster = display.data.materials[0]
    tex = bpy.data.images.new("Poster", 256, 192)
    px = []
    for j in range(192):
        for i in range(256):
            line = (j % 16 < 3 and 20 < i < 236 and j < 150) or (160 < j < 180 and 60 < i < 196)
            c = 0.12 if line else 0.86
            px += [c, c, c * 0.97, 1]
    tex.pixels = px
    node = poster.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = tex
    poster.node_tree.links.new(node.outputs["Color"], poster.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
    red = material("Measure", "#d01818", 0.6, 0, False)

    def edge(a, b_, r=0.004):
        a, b_ = Vector(a), Vector(b_)
        bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=r, depth=(b_ - a).length, location=(a + b_) / 2)
        ob = bpy.context.active_object
        ob.rotation_euler = (b_ - a).to_track_quat("Z", "Y").to_euler()
        ob.data.materials.append(red)
        return ob

    # The 1.6 x 2.4 m the board should fill, as a red outline in its plane.
    outline = [edge((-0.8, -0.32, 0), (0.8, -0.32, 0)), edge((0.8, -0.32, 0), (0.8, -0.32, 2.4)),
               edge((0.8, -0.32, 2.4), (-0.8, -0.32, 2.4)), edge((-0.8, -0.32, 2.4), (-0.8, -0.32, 0))]
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    for name, at, target, ortho, show in (("board_front", (0, -8, 1.2), (0, 0, 1.2), 2.9, True),
                                          ("board_angle", (2.6, -3.6, 1.7), (0, 0, 1.25), 0, False),
                                          ("board_back", (-2.4, 3.4, 1.9), (0, 0, 1.2), 0, False),
                                          ("board_close", (0.7, -1.6, 1.6), (0, 0, 1.55), 0, False)):
        for o in outline:
            o.hide_render = not show
        cam.location = at
        cam.data.type = "ORTHO" if ortho else "PERSP"
        if ortho:
            cam.data.ortho_scale = ortho
        cam.data.lens = 35
        cam.rotation_euler = (Vector(target) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{name}.png")
        bpy.ops.render.render(write_still=True)
