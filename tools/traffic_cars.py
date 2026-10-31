"""The village's everyday cars in Blender: a compact hatchback, an estate and a panel van, simple and low on
triangles, for the traffic on the roads and the cars parked on drives (web/src/world/traffic.ts).

Run (Blender 5, no window):
  blender -b -P tools/traffic_cars.py -- <out.glb> [preview_dir]

Generic shapes, no make or model: the sizes are the usual ones of their class (a compact hatchback
4.25 x 1.79 x 1.46 m on a 2.63 m wheelbase, a family estate 4.69 x 1.83 x 1.47 m on 2.69 m, a mid-roof
panel van 5.53 x 2.03 x 2.50 m on 3.30 m). Each body is lofted from cross-sections along its length, as in
tools/model_3.py but with far fewer of them: the side profile (nose, hood, windscreen, roof, rear glass or
doors, tail), the plan and the window line give each section; wheel arches are cut out. Lamps, the grille,
the blank plates and the mirrors are small blocks laid on the surface. No logos, badges or lettering.

Output: one GLB with the three bodies ("hatch", "estate", "van"), a simpler copy of each for seeing them
from afar ("hatch_far" ...: a third of the triangles), and one wheel ("wheel", radius 0.32 m, its axle
along x through its origin), which the game places, scales and turns itself. Each body's extras
give its axles (y, m from the middle; the nose is at +y in Blender, -z in the game), track and wheel
radius. Materials: Paint (white: the game tints it per car), Glass, Trim, Lamp, Tail, Plate, Tyre, Rim.
With preview_dir it also renders a few views there.
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
PREVIEW = os.path.abspath(argv[1]) if len(argv) > 1 else ""


def curve(points):
    """Smooth curve through (u, value) points without overshoot (monotone cubic)."""
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    n = len(points)
    d = [(ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) for i in range(n - 1)]
    m = [d[0]] + [0.0 if d[i - 1] * d[i] <= 0 else (d[i - 1] + d[i]) / 2 for i in range(1, n - 1)] + [d[-1]]
    for i in range(n - 1):
        if d[i] == 0:
            m[i] = m[i + 1] = 0
        else:
            a, b = m[i] / d[i], m[i + 1] / d[i]
            s = a * a + b * b
            if s > 9:
                t = 3 / math.sqrt(s)
                m[i], m[i + 1] = t * a * d[i], t * b * d[i]

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


# Each kind, measured from the front bumper (u, m): the top of the side profile, the underside, half the
# width, half the width of the roof or hood top, the bottom edge of the side windows, where the windscreen
# and the rear glass are, where the side glass starts and ends, the pillars between (painted, or black for
# the B-pillar), the axles, the wheel and the track.
KINDS = {
    "hatch": dict(
        L=4.25,
        top=[(0, 0.50), (0.03, 0.60), (0.08, 0.68), (0.2, 0.75), (0.5, 0.83), (0.85, 0.89), (1.12, 0.925), (1.4, 1.10),
             (1.7, 1.30), (1.95, 1.415), (2.3, 1.46), (3.0, 1.46), (3.5, 1.435), (3.8, 1.40), (3.86, 1.37), (4.0, 1.20),
             (4.12, 1.04), (4.18, 0.97), (4.22, 0.86), (4.25, 0.55)],
        bottom=[(0, 0.32), (0.15, 0.24), (0.45, 0.19), (3.8, 0.19), (4.1, 0.24), (4.25, 0.34)],
        width=[(0, 0.56), (0.05, 0.72), (0.15, 0.82), (0.35, 0.875), (0.6, 0.895), (3.6, 0.895), (3.9, 0.88), (4.1, 0.84),
               (4.25, 0.70)],
        roof=[(0, 0.40), (0.3, 0.62), (1.12, 0.70), (1.95, 0.64), (3.6, 0.63), (4.25, 0.56)],
        belt=[(1.12, 0.925), (1.6, 0.95), (3.2, 0.99), (3.75, 1.04), (4.18, 0.97)],
        screen=(1.12, 1.95), rear=(3.86, 4.18), glass=(1.32, 3.52), pillars=[(2.52, 2.62, "Trim")],
        axles=(0.88, 3.51), wheel=0.315, track=1.54, lamps=0.70, tails=0.98, tail_h=0.12,
    ),
    "estate": dict(
        L=4.69,
        top=[(0, 0.52), (0.04, 0.63), (0.1, 0.70), (0.3, 0.775), (0.6, 0.84), (1.0, 0.905), (1.2, 0.935), (1.5, 1.12),
             (1.8, 1.32), (2.05, 1.43), (2.4, 1.47), (3.8, 1.465), (4.35, 1.44), (4.5, 1.415), (4.56, 1.36), (4.63, 1.15),
             (4.665, 1.0), (4.68, 0.92), (4.69, 0.60)],
        bottom=[(0, 0.33), (0.15, 0.24), (0.45, 0.19), (4.2, 0.19), (4.5, 0.25), (4.69, 0.36)],
        width=[(0, 0.57), (0.05, 0.74), (0.15, 0.84), (0.35, 0.895), (0.6, 0.915), (4.1, 0.915), (4.4, 0.90), (4.6, 0.86),
               (4.69, 0.74)],
        roof=[(0, 0.42), (0.3, 0.64), (1.2, 0.72), (2.05, 0.66), (4.3, 0.64), (4.69, 0.60)],
        belt=[(1.2, 0.935), (1.7, 0.955), (3.4, 0.985), (4.3, 1.0), (4.6, 1.0)],
        screen=(1.2, 2.05), rear=(4.56, 4.665), glass=(1.4, 4.42), pillars=[(2.58, 2.68, "Trim"), (3.56, 3.66, "Paint")],
        axles=(0.92, 3.61), wheel=0.32, track=1.56, lamps=0.72, tails=1.02, tail_h=0.13,
    ),
    "van": dict(
        L=5.53,
        top=[(0, 0.56), (0.05, 0.74), (0.2, 0.92), (0.45, 1.03), (0.72, 1.10), (1.0, 1.42), (1.3, 1.80), (1.55, 2.12),
             (1.8, 2.36), (2.1, 2.47), (2.5, 2.50), (5.35, 2.50), (5.48, 2.47), (5.53, 2.40)],
        bottom=[(0, 0.40), (0.2, 0.32), (0.6, 0.29), (5.2, 0.31), (5.45, 0.36), (5.53, 0.42)],
        width=[(0, 0.80), (0.06, 0.92), (0.25, 0.98), (0.6, 1.0), (5.4, 1.0), (5.53, 0.985)],
        roof=[(0, 0.70), (0.72, 0.88), (1.8, 0.93), (5.53, 0.95)],
        belt=[(0.72, 1.10), (1.2, 1.16), (2.25, 1.20)],
        screen=(0.72, 1.62), rear=(9, 9), glass=(1.08, 2.18), pillars=[],
        axles=(0.95, 4.25), wheel=0.35, track=1.72, lamps=0.95, tails=0.95, tail_h=0.55,
    ),
}


def srgb(hexcode):
    c = [int(hexcode[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def material(name, color, rough=0.5, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    return m


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def apply(obj, mod):
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)


bpy.ops.wm.read_factory_settings(use_empty=True)
MAT = {
    "Paint": material("Paint", (0.8, 0.8, 0.8), 0.35, 0.3),
    "Glass": material("Glass", srgb("1b2229"), 0.12, 0.0),
    "Trim": material("Trim", srgb("1c1d1f"), 0.6),
    "Lamp": material("Lamp", srgb("d9dde2"), 0.15),
    "Tail": material("Tail", srgb("8a1414"), 0.25),
    "Plate": material("Plate", srgb("e6e6e0"), 0.45),
    "Tyre": material("Tyre", srgb("1a1a1a"), 0.85),
    "Rim": material("Rim", srgb("a8abb0"), 0.35, 0.6),
}
ORDER = list(MAT)


def build(name, k):
    L = k["L"]
    TOP, BOTTOM, WIDTH, ROOF, BELT = (curve(k[n]) for n in ("top", "bottom", "width", "roof", "belt"))
    gh = (k["screen"][0], k["rear"][1] if k["rear"][0] < 9 else k["glass"][1] + 0.08)

    def belt(u):
        zt = TOP(u)
        return min(BELT(u), zt) if gh[0] <= u <= gh[1] else zt - 0.035

    def section(u):
        """Half a cross-section at u, from the bottom middle round to the top middle, as (x, z)."""
        zb, zt, w = BOTTOM(u), TOP(u), WIDTH(u)
        bl = belt(u)
        wr = min(ROOF(u), w - 0.05)
        box = name == "van"
        inset = 0.03 if box else 0.075  # the glass's foot in from the side
        zw = zb + 0.55 * max(0.0, bl - zb)
        lx = w - inset
        crown = (0.012 if box else 0.045) * min(1.0, (zt - bl) / 0.2 + 0.4)
        tz = zt - crown * 0.8
        pts = [(0.0, zb), (w - 0.04, zb + 0.012), (w, zw), (w - 0.02, bl - 0.01), (lx, bl + 0.005),
               ((lx + wr + 0.03) / 2, (bl + tz) / 2), (wr + 0.03, tz), (wr * 0.55, zt - crown * 0.17), (0.0, zt)]
        return pts, bl, lx, wr

    # Stations: closer at the ends, and on the edges of the windows and pillars.
    us = [L * (1 - math.cos(math.pi * i / 19)) / 2 for i in range(20)]
    edges = [*k["screen"], *k["glass"], *(k["rear"] if k["rear"][0] < 9 else ())] + [e for p in k["pillars"] for e in p[:2]]
    for e in edges:
        us = [u for u in us if abs(u - e) > 0.07] + [e]
    us = sorted(u for u in us if 0 <= u <= L)
    bm = bmesh.new()
    rings = []
    for u in us:
        half, _, _, _ = section(u)
        full = half + [(-x, z) for x, z in reversed(half[1:-1])]
        rings.append([bm.verts.new((x, L / 2 - u, z)) for x, z in full])
    n = len(rings[0])
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    for ring, flip in ((rings[0], True), (rings[-1], False)):
        mid = bm.verts.new(sum((v.co for v in ring), Vector()) / n)
        for i in range(n):
            f = (ring[i], ring[(i + 1) % n], mid)
            bm.faces.new(f[::-1] if flip else f)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        c = f.calc_center_median()
        u = L / 2 - c.y
        x, z = abs(c.x), c.z
        _, bl, lx, wr = section(min(max(u, 0), L))
        m = "Paint"
        if gh[0] < u < gh[1] and z > bl + 0.012 and TOP(u) - bl > 0.05:
            top = f.normal.z > 0.55  # the windscreen, the roof and the rear glass; the sides lean in less
            if top and (k["screen"][0] < u < k["screen"][1] or k["rear"][0] < u < k["rear"][1]):
                m = "Glass"  # windscreen and rear glass
            elif not top and k["glass"][0] < u < k["glass"][1]:
                m = next((p[2] for p in k["pillars"] if p[0] < u < p[1]), "Glass")
        elif f.normal.z < -0.6 or z < BOTTOM(min(max(u, 0), L)) + 0.07:
            m = "Trim"  # the underside and a black strip along the sills and bumpers
        elif name == "van" and u > L - 0.02 and z < 0.75:
            m = "Trim"
        f.material_index = ORDER.index(m)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    body = link(bpy.data.objects.new(name, mesh))
    for m in MAT.values():
        mesh.materials.append(m)
    for p in mesh.polygons:
        p.use_smooth = True

    # Wheel arches, their inside black.
    r_arch = k["wheel"] + 0.055
    for u in k["axles"]:
        bpy.ops.mesh.primitive_cylinder_add(vertices=14, radius=r_arch, depth=2.6, location=(0, L / 2 - u, k["wheel"]),
                                            rotation=(0, math.pi / 2, 0))
        cut = bpy.context.active_object
        cut.data.materials.append(MAT["Trim"])
        # The well: the arch goes in 0.3 m from each side; between, a block keeps the body closed.
        mod = body.modifiers.new("arch", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.solver = "EXACT"
        mod.object = cut
        if hasattr(mod, "material_mode"):
            mod.material_mode = "TRANSFER"
        apply(body, mod)
        bpy.data.objects.remove(cut)
    # A dark block inside, so the arches don't show the empty body.
    bm = bmesh.new()
    bm.from_mesh(body.data)
    w_in = WIDTH(L / 2) - 0.2
    inner = bmesh.ops.create_cube(bm, size=1.0)["verts"]
    for v in inner:
        v.co = Vector((v.co.x * 2 * w_in, v.co.y * (k["axles"][1] - k["axles"][0] + 2 * r_arch + 0.1), 0.2 + (v.co.z + 0.5) * 0.48))
        v.co.y += L / 2 - (k["axles"][0] + k["axles"][1]) / 2
    for f in {f for v in inner for f in v.link_faces}:
        f.material_index = ORDER.index("Trim")
        f.smooth = False
    bm.to_mesh(body.data)
    bm.free()
    body.data.set_sharp_from_angle(angle=math.radians(38))

    # Small parts laid on the surface (ray cast from outside along y, at the given x and z).
    tree = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())

    def on_face(x, z, front, depth=0.03):
        o = Vector((x, (L / 2 + 1) * (1 if front else -1), z))
        hit = tree.ray_cast(o, Vector((0, -1 if front else 1, 0)), 3)
        return hit[0].y if hit[0] else (L / 2 if front else -L / 2)

    parts = bmesh.new()

    def block(c, size, m):
        vs = bmesh.ops.create_cube(parts, size=1.0)["verts"]
        for v in vs:
            v.co = Vector((c[0] + v.co.x * size[0], c[1] + v.co.y * size[1], c[2] + v.co.z * size[2]))
        for f in {f for v in vs for f in v.link_faces}:
            f.material_index = ORDER.index(m)

    w = WIDTH(0.3)
    van = name == "van"
    for s in (-1, 1):
        # Headlights at the front corners, tail lights at the back corners.
        x = s * (w - (0.3 if not van else 0.24))
        y = on_face(x, k["lamps"], True)
        block((x, y - 0.012, k["lamps"]), (0.24 if not van else 0.26, 0.04, 0.09 if not van else 0.15), "Lamp")
        wt = WIDTH(L - 0.2)
        x = s * (wt - (0.24 if not van else 0.07))
        y = on_face(x, k["tails"], False)
        block((x, y + 0.012, k["tails"]), (0.22 if not van else 0.1, 0.04, k["tail_h"]), "Tail")
        # Mirrors on the doors, by the windscreen's foot.
        u = k["glass"][0] + 0.08
        bl = belt(u)
        block((s * (WIDTH(u) + 0.05), L / 2 - u, bl + 0.07), (0.13, 0.07, 0.1 if not van else 0.2), "Trim" if van else "Paint")
    # Grille and plates (blank).
    gz = 0.52 if not van else 0.7
    block((0, on_face(0, gz, True) - 0.005, gz), (0.62 if not van else 1.1, 0.04, 0.16 if not van else 0.3), "Trim")
    block((0, on_face(0, 0.38 if not van else 0.48, True) + 0.004, 0.38 if not van else 0.48), (0.52, 0.02, 0.11), "Plate")
    pz = 0.62 if not van else 0.48
    block((0, on_face(0, pz, False) - 0.004, pz), (0.52, 0.02, 0.11), "Plate")
    if van:
        # The van's rear doors: a black seam down the middle and handles; a step bumper under them.
        block((0, -L / 2 + 0.005, 1.4), (0.02, 0.02, 1.7), "Trim")
        block((0, -L / 2 + 0.06, 0.38), (1.9, 0.18, 0.12), "Trim")
        # The sliding door's rail along the right side.
        block((WIDTH(3.0) - 0.01, L / 2 - 3.1, 1.24), (0.03, 1.5, 0.035), "Trim")
    pm = bpy.data.meshes.new(name + "_parts")
    parts.to_mesh(pm)
    parts.free()
    po = link(bpy.data.objects.new(name + "_parts", pm))
    for m in MAT.values():
        pm.materials.append(m)
    bpy.ops.object.select_all(action="DESELECT")
    po.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    body["axles"] = [round(L / 2 - u, 3) for u in k["axles"]]
    body["track"] = k["track"]
    body["wheel"] = k["wheel"]
    body["length"] = L
    body["width"] = round(2 * WIDTH(L / 2), 3)
    body["height"] = round(max(p[1] for p in k["top"]), 3)
    return body


def wheel():
    """One wheel, radius 0.32 m and 0.21 m wide, its axle along x: tyre, sidewalls and a plain rim."""
    bm = bmesh.new()
    n = 12
    r, rr, hw = 0.32, 0.205, 0.105
    rings = []
    for x, rad in ((-hw * 0.85, rr), (-hw, r * 0.94), (hw, r * 0.94), (hw * 0.85, rr)):
        rings.append([bm.verts.new((x, rad * math.cos(2 * math.pi * i / n), rad * math.sin(2 * math.pi * i / n))) for i in range(n)])
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            f = bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
            f.material_index = ORDER.index("Tyre")
    for ring, x, flip in ((rings[0], -hw * 0.7, True), (rings[-1], hw * 0.7, False)):
        mid = bm.verts.new((x, 0, 0))
        for i in range(n):
            f = (ring[i], ring[(i + 1) % n], mid)
            f = bm.faces.new(f[::-1] if flip else f)
            f.material_index = ORDER.index("Rim")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("wheel")
    bm.to_mesh(me)
    bm.free()
    for m in MAT.values():
        me.materials.append(m)
    me.set_sharp_from_angle(angle=math.radians(50))
    return link(bpy.data.objects.new("wheel", me))


objs = []
for i, (name, k) in enumerate(KINDS.items()):
    objs.append(build(name, k))
objs.append(wheel())
# Seen from afar (parked cars over about 70 m away): a quarter of the triangles, no wheels.
for o in list(objs[:3]):
    far = link(bpy.data.objects.new(o.name + "_far", o.data.copy()))
    mod = far.modifiers.new("fewer", "DECIMATE")
    mod.ratio = 0.3
    mod.use_collapse_triangulate = True
    apply(far, mod)
    objs.append(far)
for o in objs:
    tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
    print(f"traffic_cars: {o.name} {tris} triangles")

bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=False, export_cameras=False, export_lights=False, export_extras=True)

if PREVIEW:
    # The three side by side on a grey ground with their wheels, in a few colours, from the front and back.
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 32
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.45, 0.55, 0.7, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    scene.world = world
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(50), 0, math.radians(35)))
    bpy.context.active_object.data.energy = 3.5
    bpy.ops.mesh.primitive_plane_add(size=200)
    bpy.context.active_object.data.materials.append(material("Ground", (0.2, 0.2, 0.19), 0.85))
    paints = [srgb("7b1d1d"), srgb("1f3555"), srgb("e8e9eb")]
    wheel_obj = objs[3]
    for o in objs[4:]:
        o.location.z = -10
    for i, o in enumerate(objs[:3]):
        o.location.x = (i - 1) * 3.2
        pm = material(f"Paint{i}", paints[i], 0.35, 0.3)
        o.data.materials[ORDER.index("Paint")] = pm
        for y in o["axles"]:
            for s in (-1, 1):
                w = bpy.data.objects.new("w", wheel_obj.data)
                link(w)
                sc = o["wheel"] / 0.32
                w.scale = (sc, sc, sc)
                w.location = (o.location.x + s * (o["track"] / 2), y, o["wheel"])
    wheel_obj.location.z = -5
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    for label, at, look in (("front3q", (7.5, 9.0, 3.0), (0, 0, 0.8)), ("rear3q", (-7.5, -9.0, 3.0), (0, 0, 0.9)),
                            ("side", (16, 0.5, 1.2), (0, 0, 1.0)), ("low", (4.0, 6.5, 0.9), (1.0, 0, 0.7))):
        cam.location = at
        d = Vector(look) - Vector(at)
        cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        cam.data.lens = 35
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
