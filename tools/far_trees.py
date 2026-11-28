"""Render the far land's trees in Blender: a sheet of pictures for world/farLand.ts's tree lines (impostors).

Run (Blender 5, no window):
  blender -b -P tools/far_trees.py -- web/public/textures [--cpu] [--size 256] [--png]

Big games draw trees far off as pictures of real trees that turn to face the eye ("impostors"); this makes those
pictures. Sixteen trees, each built here, as they stand at the end of November: seven broad-leaved crowns turning
(dull green, olive, ochre, rust, brown, two thinning), three bare ones (a haze of twigs), three spruces and three
Lombardy poplars. Each tree is a trunk, branches that fork in two levels (bare ones three), and for the leafy ones
thousands of small leaf cards in clumps round the branches' ends.

Each tree is rendered from the side with an orthographic camera into one cell of a 4 x 4 sheet: its foot at the cell's
bottom middle, its top at the cell's top (the game scales a square picture to the tree's height). Three renders a tree
(Cycles): its colour (lit by nothing), its ambient occlusion (white under an even sky, multiplied into the colour) and
its normals (the leaves' tipped out from the crown's middle, as foliage in games is, so the sun lights one side of the
crown as a whole). Written as WebP: <out_dir>/far_trees_color.webp (sRGB colour, alpha the outline) and
<out_dir>/far_trees_normal.webp (tangent space, x right, y up, z to the eye). No textures from outside.
"""
import math
import os
import random
import sys
import tempfile

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
CPU = "--cpu" in argv
SIZE = int(argv[argv.index("--size") + 1]) if "--size" in argv else 256
OUT = os.path.abspath([a for a in argv if not a.startswith("--") and not a.isdigit()][0])  # Blender saves relative paths elsewhere
GRID = 4
bpy.ops.wm.read_factory_settings(use_empty=True)


def lin(hex_):
    c = [int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c]


def l2s(c):
    """A linear colour as the sRGB values a mesh's colour layer takes (it stores sRGB and gives linear back)."""
    return tuple(v * 12.92 if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055 for v in (min(1.0, max(0.0, x)) for x in c))


# ------------------------------------------------------------------------------------------------ building
class Tree:
    """One tree's parts: bark tubes and leaf cards, each a mesh with a 'cn' normal per point and colours."""

    def __init__(self, seed):
        self.rand = random.Random(seed)
        self.bark = bmesh.new()
        self.bcol = self.bark.loops.layers.color.new("Col")
        self.leaf = bmesh.new()
        self.lcol = self.leaf.loops.layers.color.new("Col")
        self.lcn = []  # per leaf vertex: its crown normal
        self.tips = []  # branch ends (points) for the leaves

    def tube(self, pts, r0, r1, colour, sides=6):
        """A tapering tube along points (Vectors), radius r0 to r1."""
        rings = []
        n = len(pts)
        for i, p in enumerate(pts):
            d = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
            side = d.orthogonal().normalized()
            up = d.cross(side)
            r = r0 + (r1 - r0) * i / (n - 1)
            rings.append([self.bark.verts.new(p + (side * math.cos(a) + up * math.sin(a)) * r)
                          for a in (2 * math.pi * k / sides for k in range(sides))])
        c = (*l2s(colour), 1.0)
        for a, b in zip(rings, rings[1:]):
            for k in range(sides):
                f = self.bark.faces.new((a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k]))
                for lp in f.loops:
                    lp[self.bcol] = c

    def branch(self, start, direction, length, radius, depth, spread, droop=0.0, kids=4, keep_tips=True):
        """A branch from `start` along `direction` (bending up or down by droop), with `kids` branches off it
        (depth more levels); its end goes into tips."""
        R = self.rand
        pts = [start.copy()]
        d = direction.normalized()
        seg = 5
        for i in range(1, seg + 1):
            d = (d + Vector((R.uniform(-0.15, 0.15), R.uniform(-0.15, 0.15), -droop + R.uniform(-0.05, 0.1)))).normalized()
            pts.append(pts[-1] + d * (length / seg))
        self.tube(pts, radius, radius * 0.35, self.bark_colour)
        if keep_tips:
            self.tips.append((pts[-1], length))
            self.tips.append((pts[-2], length * 0.7))
        if depth <= 0:
            return
        for k in range(kids):
            t = R.uniform(0.3, 0.95)
            i = min(seg - 1, int(t * seg))
            at = pts[i].lerp(pts[i + 1], t * seg - i)
            side = d.orthogonal()
            side.rotate(Matrix.Rotation(R.uniform(0, 2 * math.pi), 3, d))
            nd = (d * R.uniform(0.4, 0.8) + side.normalized() * spread).normalized()
            self.branch(at, nd, length * R.uniform(0.35, 0.55), radius * 0.45, depth - 1, spread, droop, kids, keep_tips)

    def leaves(self, centre, count, clump, size, palette, crown_c, lift=0.0):
        """Leaf cards in clumps round the tips: each a small square, randomly turned, its colour from `palette`
        (a clump keeps one colour, a little varied), its normal tipped out from `crown_c`."""
        R = self.rand
        per = max(1, count // max(1, len(self.tips)))
        for tip, length in self.tips:
            base = Vector(palette[R.randrange(len(palette))]) * 1.25  # leaves in the light are paler than the strips' mean
            for _ in range(per):
                p = tip + Vector((R.gauss(0, clump), R.gauss(0, clump), R.gauss(lift, clump * 0.8)))
                q = Matrix.Rotation(R.uniform(0, math.pi), 3, "Z") @ Matrix.Rotation(R.uniform(0, math.pi), 3, "X")
                s = size * R.uniform(0.7, 1.3)
                vs = [self.leaf.verts.new(p + q @ Vector((x * s, y * s, 0))) for x, y in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5))]
                f = self.leaf.faces.new(vs)
                k = R.uniform(0.8, 1.15)
                c = (*l2s(base * k), 1.0)
                for lp in f.loops:
                    lp[self.lcol] = c
                out = (p - crown_c)
                out.z *= 0.7
                n = (out.normalized() * 0.75 + Vector((R.gauss(0, 0.3), R.gauss(0, 0.3), R.gauss(0, 0.3)))).normalized()
                self.lcn.extend([n] * 4)

    def objects(self):
        """The two meshes as objects, each with its 'cn' point attribute (the bark's own normals)."""
        out = []
        for name, bm, cn in (("bark", self.bark, None), ("leaves", self.leaf, self.lcn)):
            if not bm.verts:
                continue
            me = bpy.data.meshes.new(name)
            bm.to_mesh(me)
            if cn is None:
                me.update()
                cn = [v.normal.copy() for v in me.vertices]
            a = me.attributes.new("cn", "FLOAT_VECTOR", "POINT")
            a.data.foreach_set("vector", [c for v in cn for c in v])
            o = bpy.data.objects.new(name, me)
            bpy.context.scene.collection.objects.link(o)
            out.append(o)
        return out


BARK = lin("#5d5047")
TWIG = lin("#6e6262")


def broad(seed, palette, density=1.0):
    t = Tree(seed)
    t.bark_colour = BARK
    R = t.rand
    H = 1.0
    trunk_top = Vector((R.uniform(-0.02, 0.02), 0, 0.26))
    t.tube([Vector((0, 0, -0.02)), Vector((0, 0, 0.13)), trunk_top], 0.032, 0.024, BARK)
    for k in range(R.randint(6, 8)):
        az = 2 * math.pi * k / 7 + R.uniform(-0.4, 0.4)
        el = R.uniform(math.radians(28), math.radians(60))
        d = Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)))
        start = trunk_top + Vector((0, 0, R.uniform(-0.08, 0.05)))
        t.branch(start, d, R.uniform(0.28, 0.36) * H, 0.016, 1, 0.9, droop=0.02, kids=5)
    if density > 0:
        t.leaves(Vector((0, 0, 0.55)), int(10000 * density), 0.05, 0.026, palette, Vector((0, 0, 0.52)), lift=0.01)
    return t


def bare(seed):
    t = Tree(seed)
    t.bark_colour = TWIG
    R = t.rand
    trunk_top = Vector((0, 0, 0.27))
    t.tube([Vector((0, 0, -0.02)), Vector((0, 0, 0.14)), trunk_top], 0.032, 0.024, BARK)
    for k in range(R.randint(7, 9)):
        az = 2 * math.pi * k / 8 + R.uniform(-0.4, 0.4)
        el = R.uniform(math.radians(35), math.radians(70))
        d = Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)))
        t.branch(trunk_top, d, R.uniform(0.36, 0.46), 0.016, 2, 0.9, droop=0.0, kids=5, keep_tips=False)
    return t


def spruce(seed):
    t = Tree(seed)
    t.bark_colour = BARK
    R = t.rand
    t.tube([Vector((0, 0, -0.02)), Vector((0, 0, 0.5)), Vector((0, 0, 0.98))], 0.022, 0.003, BARK)
    z = 0.12
    while z < 0.94:
        r = 0.23 * (1 - (z - 0.1) / 0.9) ** 0.95 + 0.02
        for k in range(R.randint(6, 8)):
            az = 2 * math.pi * k / 7 + R.uniform(-0.3, 0.3)
            d = Vector((math.cos(az), math.sin(az), R.uniform(-0.15, 0.05)))
            t.branch(Vector((0, 0, z)), d, r * R.uniform(0.85, 1.1), 0.006, 0, 0.0, droop=0.06, kids=0)
        z += R.uniform(0.045, 0.06)
    palette = [lin("#3c4c34"), lin("#46583a"), lin("#384830")]
    t.leaves(Vector((0, 0, 0.5)), 9000, 0.035, 0.025, palette, Vector((0, 0, 0.45)))
    return t


def poplar(seed, palette):
    t = Tree(seed)
    t.bark_colour = BARK
    R = t.rand
    t.tube([Vector((0, 0, -0.02)), Vector((0, 0, 0.5)), Vector((0, 0, 0.9))], 0.022, 0.006, BARK)
    for k in range(40):
        z = R.uniform(0.12, 0.85)
        az = R.uniform(0, 2 * math.pi)
        el = R.uniform(math.radians(70), math.radians(84))
        d = Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)))
        t.branch(Vector((0, 0, z)), d, R.uniform(0.1, 0.18), 0.006, 0, 0.0, kids=0)
    t.leaves(Vector((0, 0, 0.55)), 8000, 0.03, 0.022, palette, Vector((0, 0, 0.55)), lift=0.01)
    return t


GREEN = [lin("#485429"), lin("#55602f"), lin("#4a5a2c")]
OLIVE = [lin("#565630"), lin("#646036"), lin("#5a5a32")]
OCHRE = [lin("#70602f"), lin("#7d6a34"), lin("#66582e")]
RUST = [lin("#6a4c2c"), lin("#7a5430"), lin("#5e4428")]
BROWN = [lin("#5a462e"), lin("#644e32"), lin("#4e3e2a")]
MIXED = [lin("#70602f"), lin("#6a4c2c"), lin("#565630"), lin("#5a462e")]
POPL = [lin("#6e6436"), lin("#5c5a34"), lin("#7a6e3a")]

# The sheet, row by row (stall.ts reads the cells by these numbers: world/farLand.ts CELLS).
TREES = [
    lambda: broad(1, GREEN), lambda: broad(2, OLIVE), lambda: broad(3, OCHRE), lambda: broad(4, OCHRE + RUST),
    lambda: broad(5, RUST), lambda: broad(6, BROWN), lambda: broad(7, MIXED, 0.55), lambda: broad(8, OCHRE + BROWN, 0.4),
    lambda: bare(9), lambda: bare(10), lambda: bare(11), lambda: spruce(12),
    lambda: spruce(13), lambda: spruce(14), lambda: poplar(15, POPL), lambda: poplar(16, POPL[1:] + OCHRE[:1]),
]

# ------------------------------------------------------------------------------------------------ materials, camera
scene = bpy.context.scene
scene.render.engine = "CYCLES"
if not CPU:
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA"):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
                if any(d.type == kind for d in prefs.devices):
                    for d in prefs.devices:
                        d.use = d.type == kind
                    scene.cycles.device = "GPU"
                    break
            except TypeError:
                continue
    except Exception:
        pass
scene.render.resolution_x = scene.render.resolution_y = SIZE
scene.render.film_transparent = True
scene.render.image_settings.file_format = "OPEN_EXR"
scene.render.image_settings.color_depth = "32"
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "Standard"
scene.cycles.use_denoising = True
world = bpy.data.worlds.new("Sky")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
scene.world = world


def emission_material(name, colour_from):
    """An emission material: its colour the 'Col' attribute (albedo), the 'cn' attribute as a normal (0.5 + n / 2),
    or plain white diffuse ('ao')."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    if colour_from == "ao":
        d = nt.nodes.new("ShaderNodeBsdfDiffuse")
        d.inputs["Color"].default_value = (1, 1, 1, 1)
        nt.links.new(d.outputs[0], out.inputs["Surface"])
        return m
    e = nt.nodes.new("ShaderNodeEmission")
    a = nt.nodes.new("ShaderNodeAttribute")
    if colour_from == "albedo":
        a.attribute_name = "Col"
        nt.links.new(a.outputs["Color"], e.inputs["Color"])
    else:
        a.attribute_name = "cn"
        v = nt.nodes.new("ShaderNodeVectorMath")
        v.operation = "MULTIPLY_ADD"
        v.inputs[1].default_value = (0.5, 0.5, 0.5)
        v.inputs[2].default_value = (0.5, 0.5, 0.5)
        nt.links.new(a.outputs["Vector"], v.inputs[0])
        nt.links.new(v.outputs["Vector"], e.inputs["Color"])
    nt.links.new(e.outputs[0], out.inputs["Surface"])
    return m


MAT = {k: emission_material(k, k) for k in ("albedo", "ao", "normal")}
bpy.ops.object.camera_add()
cam = bpy.context.active_object
cam.data.type = "ORTHO"
cam.data.ortho_scale = 1.0
cam.location = (0, -5, 0.5)
cam.rotation_euler = (math.radians(90), 0, 0)  # looking along +y: x right, z up in the picture
scene.camera = cam


def render(kind, path):
    scene.view_layers[0].material_override = MAT[kind]
    scene.cycles.samples = {"albedo": 16, "ao": 96, "normal": 16}[kind]
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    a = np.empty(SIZE * SIZE * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(SIZE, SIZE, 4)


# ------------------------------------------------------------------------------------------------ the sheet
os.makedirs(OUT, exist_ok=True)
tmp = tempfile.mkdtemp(prefix="far_trees_")  # the renders, outside the repository
W = SIZE * GRID
colour = np.zeros((W, W, 4), dtype=np.float32)
normal = np.zeros((W, W, 4), dtype=np.float32)
normal[..., :] = (0.5, 0.5, 1.0, 1.0)
for i, make in enumerate(TREES):
    for o in list(scene.collection.objects):
        if o.type == "MESH":
            bpy.data.objects.remove(o)
    tree = make()
    objs = tree.objects()
    tris = sum(len(o.data.polygons) for o in objs)
    alb = render("albedo", os.path.join(tmp, f"{i}_albedo.exr"))
    ao = render("ao", os.path.join(tmp, f"{i}_ao.exr"))
    nrm = render("normal", os.path.join(tmp, f"{i}_normal.exr"))
    alpha = alb[..., 3:4]
    # Emission against a transparent film is premultiplied: the colour divided back out where there is any cover.
    safe = np.maximum(alpha, 1e-4)
    c = alb[..., :3] / safe
    occ = np.clip(ao[..., :3].mean(axis=2, keepdims=True) / safe, 0, 1)
    c = c * (0.3 + 0.7 * occ ** 0.9)
    n = nrm[..., :3] / safe * 2 - 1  # world normal
    tn = np.stack([n[..., 0], n[..., 2], -n[..., 1]], axis=-1)  # picture's x right, y up, z to the eye
    tn /= np.maximum(np.linalg.norm(tn, axis=-1, keepdims=True), 1e-4)
    row, colm = divmod(i, GRID)
    y0 = (GRID - 1 - row) * SIZE  # image rows run from the bottom
    x0 = colm * SIZE
    colour[y0:y0 + SIZE, x0:x0 + SIZE, :3] = c
    colour[y0:y0 + SIZE, x0:x0 + SIZE, 3:] = alpha
    normal[y0:y0 + SIZE, x0:x0 + SIZE, :3] = np.where(alpha > 0.01, tn * 0.5 + 0.5, (0.5, 0.5, 1.0))
    print(f"far_trees: tree {i} {tris} faces, cover {float(alpha.mean()):.2f}")

# The colour bled out past each outline (the mipmaps then fade to the tree's colour, not to black).
rgb = colour[..., :3].copy()
have = colour[..., 3] > 0.05
for _ in range(16):
    acc = np.zeros_like(rgb)
    cnt = np.zeros(have.shape, dtype=np.float32)
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        acc += np.roll(np.roll(rgb * have[..., None], dy, 0), dx, 1)
        cnt += np.roll(np.roll(have.astype(np.float32), dy, 0), dx, 1)
    grow = (~have) & (cnt > 0)
    rgb[grow] = acc[grow] / cnt[grow][:, None]
    have = have | grow
colour[..., :3] = rgb


def to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def save(name, data, srgb):
    data = data.copy()
    if srgb:  # a byte image's pixels are its stored values: the colour as sRGB
        data[..., :3] = to_srgb(data[..., :3])
    im = bpy.data.images.new(name, W, W, alpha=True, float_buffer=False)
    im.colorspace_settings.name = "sRGB" if srgb else "Non-Color"
    im.alpha_mode = "STRAIGHT"
    im.pixels.foreach_set(np.ascontiguousarray(data, dtype=np.float32).ravel())
    im.filepath_raw = os.path.join(OUT, f"{name}.webp")
    im.file_format = "WEBP"
    scene.render.image_settings.quality = 90
    im.save()
    print("far_trees: written", im.filepath_raw, os.path.getsize(im.filepath_raw), "bytes")
    if "--png" in argv:  # a copy to look at
        im.filepath_raw = os.path.join(tmp, f"{name}.png")
        im.file_format = "PNG"
        im.save()


save("far_trees_color", colour, True)
save("far_trees_normal", normal, False)
