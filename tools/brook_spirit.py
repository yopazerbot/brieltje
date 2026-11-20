"""Build the brook spirit, a floating creature of mist for the woods by the brook, in Blender.

Run (Blender 5, no window):
  blender -b -P tools/brook_spirit.py -- <out.glb> [preview_dir]

  e.g. blender -b -P tools/brook_spirit.py -- web/public/models/brook-spirit.glb

Our own design: a spirit of the brook valley in November, close to the will-o'-the-wisps of Flemish
marsh folklore. Its mist is not modelled: the game draws it round these parts (web/src/world/brookSpirit.ts).
What is modelled:

- Heart: a ribbed lantern, like a winter cherry's husk (Physalis), about 0.4 m across. The game makes it
  glow; it is what a player aims at.
- Core: the dark mass the mist hangs on, about 1.5 m across, gnarled like roots and bark, with a round
  opening at the front over the heart. It is a shell with an inside: the rim rolls inward, so the
  opening shows a hollow the heart lights. The game closes the opening in the vertex shader by sliding
  every point towards the front along its own meridian (no bones, no second model).
- Tendrils: seven long tapering arms, two long ones at the front (4.8 m), two at the sides, three trailing
  behind, slate on top, pale underneath, with a row of small round nodes along the underside that glow.

The tendrils are modelled STRAIGHT, each along its own axis from its root: the game bends them in the
vertex shader, along a curve worked out from a few numbers per arm each frame (droop, curl at the tip,
a wave travelling from the root, a reach towards a point). For that each arm's frame goes along as the
object's extras (`arms`, JSON, glTF axes): its root, its axis `dir`, its upper side `up`, its length
and its root's radius. Every corner of a tendril carries:
  TEXCOORD_0 (uv)  = (t, arm): how far along its arm it lies (0 at the root, 1 at the tip), the arm's number
  TEXCOORD_1 (uv1) = (glow, under): 1 on the glowing nodes, and how far round to the underside it lies
Where a corner lies across its arm the game reads from its straight position: along `side` and `up`.
The core's corners carry TEXCOORD_0 = (inside, 0): 0 on the outside, 1 on the inner wall of the hollow.
Colours are on the corners (COLOR_0, linear); no image textures.

Near and far: Heart, Core, Tendrils (about 16 000 triangles) and HeartFar, CoreFar, TendrilsFar (about
2 000). glTF axes: +y up, the front +z (Blender -Y); the origin is the middle of the body.
"""
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)


def srgb(h):
    """'#rrggbb' to linear RGB."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def mix(a, b, f):
    return tuple(x + (y - x) * f for x, y in zip(a, b))


def smooth(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def g2b(p):
    """glTF axes (x right, y up, z front) to Blender's (z up, -y front); the exporter turns them back."""
    return (p[0], -p[2], p[1])


def norm(v):
    l = math.sqrt(sum(c * c for c in v))
    return tuple(c / l for c in v)


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def add(*vs):
    return tuple(sum(c) for c in zip(*vs))


def mul(v, s):
    return tuple(c * s for c in v)


_mats = {}


def mat(name, hexcol, rough=0.8, emit=0.0):
    """Materials only name the parts for the game (and colour the previews); the colours are on the corners."""
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nodes = m.node_tree.nodes
    p = nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*srgb(hexcol), 1)
    p.inputs["Roughness"].default_value = rough
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    m.node_tree.links.new(attr.outputs["Color"], p.inputs["Base Color"])
    if emit:
        p.inputs["Emission Color"].default_value = (*srgb(hexcol), 1)
        p.inputs["Emission Strength"].default_value = emit
    _mats[name] = m
    return m


HEART = mat("Heart", "#e6fff0", 0.4, emit=6.0)
CORE = mat("Core", "#2a3238", 0.9)
TENDRIL = mat("Tendril", "#3a444c", 0.6)


def build(name, verts, faces, cols, uvs, material):
    """One object: corners in glTF axes, a colour per corner (linear) and up to two (u, v) pairs per corner."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([g2b(v) for v in verts], [], faces)
    me.validate()
    ca = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    for i, c in enumerate(cols):
        ca.data[i].color = (*c, 1.0)
    me.color_attributes.active_color = ca
    for k, per_vertex in enumerate(uvs):
        layer = me.uv_layers.new(name=f"UV{k}")
        for loop in me.loops:
            u, v = per_vertex[loop.vertex_index]
            layer.data[loop.index].uv = (u, 1.0 - v)  # the exporter writes v as 1 - v: this keeps our numbers
    # The poles' coincident corners into one, and every face turned outward (each part is closed).
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(material)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def grid(rings, segs, closed=True):
    """Quads between `rings` rings of `segs` corners each (round if `closed`)."""
    faces = []
    n = segs if closed else segs - 1
    for i in range(rings - 1):
        for j in range(n):
            k = (j + 1) % segs
            a, b, c, d = i * segs + j, i * segs + k, (i + 1) * segs + k, (i + 1) * segs + j
            faces.append((a, b, c, d))
    return faces


def noise3(d, seed=0.0):
    """A smooth bumpy field on a direction: a few crossed waves, the same every build."""
    x, y, z = d
    return (math.sin(3.1 * x + 1.3 * y + seed) * math.sin(2.7 * z - 1.9 * x + 0.7 * seed)
            + 0.6 * math.sin(5.3 * y + 2.2 * z + 1.1 + seed) * math.sin(4.1 * x - 3.3 * y + 0.4)
            + 0.35 * math.sin(8.7 * z + 6.1 * x + 2.5) * math.sin(7.9 * y - 5.2 * z + seed)) / 1.95


# ---------------------------------------------------------------- the heart
def heart(rings, segs):
    """A ribbed lantern: pointed top and bottom, eight soft ribs, 0.38 m wide, 0.5 m tall, at the body's front."""
    verts, cols = [], []
    W, H, Z0 = 0.19, 0.25, 0.12
    for i in range(rings + 1):
        s = i / rings  # 0 at the bottom tip, 1 at the top
        bulge = math.sin(math.pi * s) ** 0.85 * (1 + 0.12 * math.sin(math.pi * s * 0.9))
        y = -H + 2 * H * (1 - math.cos(math.pi * s)) / 2
        for j in range(segs):
            a = 2 * math.pi * j / segs
            rib = 1 + 0.1 * math.cos(8 * a) * math.sin(math.pi * s)
            r = W * bulge * rib
            verts.append((r * math.cos(a), y, Z0 + r * math.sin(a)))
            # Lighter on the ribs, a little deeper in the grooves: the glow shows the shape.
            cols.append(mix(srgb("#bfe0d0"), (1, 1, 1), 0.5 + 0.5 * math.cos(8 * a)))
    faces = grid(rings + 1, segs)
    uvs = [[(0.0, 0.0)] * len(verts)]
    return verts, faces, cols, uvs


# ---------------------------------------------------------------- the core
CORE_R = 0.74     # its outer radius (m), before the lumps
CORE_IN = 0.56    # the hollow's radius
LIP = 0.78        # the opening's edge, in radians from the front (open as modelled)


def core(n_out, n_rim, n_in, segs):
    """A gnarled shell with a round opening at the front (+z) and a hollow inside it.

    Its profile runs from the back (angle pi from the front) forward along the outside to the opening's
    edge at LIP, rolls inward round the rim, and runs back along the inside of the hollow. Each point of the
    profile turns round the front axis in `segs` steps. The game closes the opening by squeezing the angles
    between LIP and the back (brookSpirit.ts), so nothing here may lie nearer the front axis than LIP - 0.08.
    """
    prof = []  # (angle from the front, radius scale, inside 0..1)
    for i in range(n_out):
        f = i / (n_out - 1)
        prof.append((math.pi - 0.04 - (math.pi - 0.04 - LIP) * f, 1.0, 0.0))
    for i in range(1, n_rim):
        f = i / n_rim
        a = math.pi * f
        r = (1 + CORE_IN / CORE_R) / 2 + (1 - CORE_IN / CORE_R) / 2 * math.cos(a)
        prof.append((LIP - 0.07 * math.sin(a), r, f))
    for i in range(n_in):
        f = i / (n_in - 1)
        prof.append((LIP + (math.pi - 0.3 - LIP) * f, CORE_IN / CORE_R, 1.0))
    verts, cols, uvs = [], [], []
    for th, rs, inside in prof:
        for j in range(segs):
            ph = 2 * math.pi * j / segs
            d = (math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th))
            # Lumps, and root-like ridges that twist round it; smaller on the inside and round the rim.
            lump = 0.13 * noise3(d) + 0.05 * abs(math.sin(5 * ph + 3.2 * th)) ** 1.5
            lump *= 1 - 0.55 * inside
            body = (1.12, 0.92, 1.0)  # a little wider than tall
            r = CORE_R * rs * (1 + lump)
            verts.append((d[0] * r * body[0], d[1] * r * body[1], d[2] * r * body[2]))
            crease = smooth(0.02, 0.12, lump)
            outside = mix(srgb("#1b2127"), srgb("#3b4650"), crease)
            hollow = mix(srgb("#4c5a58"), srgb("#7d8f88"), 0.5 + 0.5 * noise3(d, 2.0))
            cols.append(mix(outside, hollow, inside))
            uvs.append((inside, 0.0))
    faces = grid(len(prof), segs)
    # Close the back: a fan on the outside's first ring and on the inside's last.
    nv = len(verts)
    verts.append((0.0, 0.0, -CORE_R * (1 + 0.05)))
    cols.append(srgb("#1b2127"))
    uvs.append((0.0, 0.0))
    for j in range(segs):
        faces.append((nv, (j + 1) % segs, j))
    last = (len(prof) - 1) * segs
    verts.append((0.0, 0.0, -CORE_IN * 0.98))
    cols.append(srgb("#4c5a58"))
    uvs.append((1.0, 0.0))
    for j in range(segs):
        faces.append((nv + 1, last + j, last + (j + 1) % segs))
    return verts, faces, cols, [uvs]


# ---------------------------------------------------------------- the tendrils
def arm_frame(root, d):
    d = norm(d)
    up = norm(add((0, 1, 0), mul(d, -d[1])))
    return {"root": root, "dir": d, "up": up, "side": cross(d, up)}


ARMS = []
for root, d, length, radius in (
    ((-0.46, -0.36, 0.30), (-0.30, -0.25, 1.0), 4.8, 0.14),   # 0, 1: the long ones at the front, that reach
    ((0.46, -0.36, 0.30), (0.30, -0.25, 1.0), 4.8, 0.14),     # (either side of the opening, never across it)
    ((-0.55, -0.38, 0.02), (-0.85, -0.55, 0.15), 4.0, 0.12),  # 2, 3: at the sides
    ((0.55, -0.38, 0.02), (0.85, -0.55, 0.15), 4.0, 0.12),
    ((-0.30, -0.50, -0.38), (-0.35, -0.80, -0.50), 3.3, 0.10),  # 4, 5, 6: trailing behind
    ((0.30, -0.50, -0.38), (0.35, -0.80, -0.50), 3.3, 0.10),
    ((0.0, -0.45, -0.50), (0.0, -0.62, -0.80), 3.7, 0.105),
):
    f = arm_frame(root, d)
    f["length"] = length
    f["radius"] = radius
    ARMS.append(f)


def radius_at(arm, t):
    """Thick at the root, a swelling just out of the core, tapering to a fine tip."""
    r0 = arm["radius"]
    taper = (1 - t) ** 0.8 * 0.93 + 0.07
    swell = 1 + 0.22 * math.exp(-((t - 0.07) / 0.06) ** 2)
    ringed = 1 + 0.035 * math.sin(t * arm["length"] * 11)  # faint growth rings, like a root's
    return r0 * taper * swell * ringed


def tendrils(rings, segs, nodes):
    verts, faces, cols, uv0, uv1 = [], [], [], [], []
    top, under, node_col = srgb("#323c45"), srgb("#a5b4ae"), srgb("#d6f5e4")
    for ai, arm in enumerate(ARMS):
        R, D, U, S, L = arm["root"], arm["dir"], arm["up"], arm["side"], arm["length"]
        base = len(verts)
        for i in range(rings):
            t = i / (rings - 1)
            t = 1 - (1 - t) ** 1.25  # a little closer together towards the tip, where it curls
            r = radius_at(arm, t)
            for j in range(segs):
                a = 2 * math.pi * j / segs
                ca, sa = math.cos(a), math.sin(a)
                x, y = r * 1.12 * ca, r * 0.86 * sa  # flatter than round, as an eel's
                verts.append(add(R, mul(D, L * t), mul(S, x), mul(U, y)))
                u = smooth(0.1, -0.75, sa)  # 1 on the underside
                cols.append(mix(top, under, u))
                uv0.append((t, float(ai)))
                uv1.append((0.0, u))
        faces += [(a + base, b + base, c + base, d + base) for a, b, c, d in grid(rings, segs)]
        # The tip: one point a little beyond the last ring.
        tip = len(verts)
        verts.append(add(R, mul(D, L * 1.004)))
        cols.append(top)
        uv0.append((1.0, float(ai)))
        uv1.append((0.0, 0.5))
        last = base + (rings - 1) * segs
        for j in range(segs):
            faces.append((last + j, last + (j + 1) % segs, tip))
        # The root's end, inside the core: closed too.
        rootc = len(verts)
        verts.append(add(R, mul(D, -0.01)))
        cols.append(top)
        uv0.append((0.0, float(ai)))
        uv1.append((0.0, 0.5))
        for j in range(segs):
            faces.append((base + (j + 1) % segs, base + j, rootc))
        if not nodes:
            continue
        # The nodes: small round lights in a row along the underside, smaller towards the tip.
        t = 0.13
        while t < 0.93:
            r = radius_at(arm, t)
            rn = 0.3 * r + 0.007
            c = add(R, mul(D, L * t), mul(U, -0.8 * r))
            nb = len(verts)
            lat, lon = 4, 6
            for i in range(lat + 1):
                th = math.pi * i / lat
                for j in range(lon):
                    ph = 2 * math.pi * j / lon
                    p = add(c, mul(D, rn * math.cos(th)), mul(S, rn * math.sin(th) * math.cos(ph)), mul(U, -rn * math.sin(th) * math.sin(ph)))
                    verts.append(p)
                    cols.append(node_col)
                    tt = dot(add(p, mul(R, -1)), D) / L
                    uv0.append((min(1.0, max(0.0, tt)), float(ai)))
                    uv1.append((1.0, 1.0))
            for i in range(lat):
                for j in range(lon):
                    k = (j + 1) % lon
                    a, b = nb + i * lon + j, nb + i * lon + k
                    cc, dd = nb + (i + 1) * lon + k, nb + (i + 1) * lon + j
                    if i == 0:
                        faces.append((a, dd, cc))
                    elif i == lat - 1:
                        faces.append((a, b, dd))
                    else:
                        faces.append((a, dd, cc, b))
            t += 0.072 * (1 - 0.35 * t)
    return verts, faces, cols, [uv0, uv1]


objs = [
    build("Heart", *heart(16, 20), HEART),
    build("Core", *core(24, 6, 10, 40), CORE),
    build("Tendrils", *tendrils(46, 10, True), TENDRIL),
    build("HeartFar", *heart(6, 8), HEART),
    build("CoreFar", *core(9, 3, 4, 14), CORE),
    build("TendrilsFar", *tendrils(16, 5, False), TENDRIL),
]
# The game's bending reads each arm's frame from here (glTF axes).
arms_json = json.dumps([{k: ([round(c, 5) for c in v] if isinstance(v, tuple) else round(v, 5)) for k, v in a.items()} for a in ARMS])
for o in objs:
    if o.name.startswith("Tendrils"):
        o["arms"] = arms_json

total = {}
for o in objs:
    o.data.calc_loop_triangles()
    n = len(o.data.loop_triangles)
    total["far" if o.name.endswith("Far") else "near"] = total.get("far" if o.name.endswith("Far") else "near", 0) + n
    print(f"{o.name}: {n} triangles")
print(f"near {total['near']} triangles, far {total['far']}")

bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=False, export_yup=True,
                          export_texcoords=True, export_normals=True, export_tangents=False, export_materials="EXPORT",
                          export_vertex_color="ACTIVE", export_all_vertex_colors=False, export_attributes=False,
                          export_extras=True, export_cameras=False, export_lights=False)
print(f"brook spirit: {os.path.getsize(OUT)} bytes")


# ---------------------------------------------------------------- previews: the arms bent as the game rests them
def bent(arm, t, a, b, alpha, beta, steps=10):
    """The game's bending (brookSpirit.ts), in Python: the spine from the root by small straight steps."""
    D, U, S, L = arm["dir"], arm["up"], arm["side"], arm["length"]

    def direction(s):
        al, be = alpha(s), beta(s)
        return add(mul(D, math.cos(al) * math.cos(be)), mul(U, -math.sin(al)), mul(S, math.cos(al) * math.sin(be)))

    p = arm["root"]
    for k in range(steps):
        p = add(p, mul(direction(t * (k + 0.5) / steps), t * L / steps))
    al, be = alpha(t), beta(t)
    up_t = add(mul(D, math.sin(al) * math.cos(be)), mul(U, math.cos(al)), mul(S, math.sin(al) * math.sin(be)))
    side_t = add(mul(D, -math.sin(be)), mul(S, math.cos(be)))
    return add(p, mul(side_t, a), mul(up_t, b))


if PREVIEW:
    scene = bpy.context.scene
    src = bpy.data.objects["Tendrils"]
    posed = src.copy()
    posed.data = src.data.copy()
    scene.collection.objects.link(posed)
    uvl = posed.data.uv_layers["UV0"]
    tv = {}
    for loop in posed.data.loops:
        u, v = uvl.data[loop.index].uv
        tv[loop.vertex_index] = (u, round(1 - v))
    for i, vx in enumerate(posed.data.vertices):
        t, ai = tv[i]
        arm = ARMS[ai]
        p = (vx.co.x, vx.co.z, -vx.co.y)
        rel = add(p, mul(arm["root"], -1))
        along = dot(rel, arm["dir"])
        tt = max(0.0, min(1.0, along / arm["length"]))
        a, b = dot(rel, arm["side"]), dot(rel, arm["up"])
        front = ai < 2
        alpha = (lambda s, f=front: (0.15 if f else 0.0) + (0.55 if f else 0.45) * s + (1.9 if f else 1.4) * smooth(0.55, 1, s))
        beta = (lambda s, k=ai: 0.25 * math.sin(2.5 * s + k) * s)
        q = bent(arm, tt, a, b, alpha, beta)
        q = add(q, mul(arm["dir"], along - tt * arm["length"]))
        vx.co = Vector(g2b(q))
    for o in objs:
        o.hide_render = o.name.endswith("Far") or o is src
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 720, 540
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.32, 0.36, 0.4, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6
    scene.world = world
    for o in objs:
        o.location = (0, 0, 3.2)
    posed.location = (0, 0, 3.2)
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
    bpy.context.active_object.data.materials.append(mat("Ground", "#4a4636", 1.0))
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 8))
    sun = bpy.context.active_object
    sun.data.energy = 2.5
    sun.rotation_euler = (math.radians(40), math.radians(10), math.radians(-35))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    cam.data.lens = 30
    os.makedirs(PREVIEW, exist_ok=True)
    for label, at in (("front", (2.0, -8.5, 3.0)), ("side", (8.5, 0.5, 3.4)), ("three", (-6.0, -6.0, 5.0))):
        cam.location = at
        cam.rotation_euler = (Vector((0, 0, 1.9)) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"spirit_{label}.png")
        bpy.ops.render.render(write_still=True)
