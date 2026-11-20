"""Build the brook spirit, a floating creature of mist for the woods by the brook, in Blender: a sculpt, a game
model, and the sculpt's detail baked onto the game model's maps.

Run (Blender 5, no window), from the project root:
  blender -b --factory-startup -P tools/brook_spirit.py -- web/public/models/brook-spirit.glb [options]

  --preview <dir>   also write the maps as PNG there, to look at
  --samples <n>     rays per pixel of the occlusion bakes (default 48)
  --cpu             bake on the processor instead of the graphics card
  --no-ktx2         skip the KTX2 copies (they need Node and tools/basisu.mjs)

Our own design: a spirit of the brook valley in November, close to the will-o'-the-wisps of Flemish marsh
folklore. Its mist is drawn by the game from a flipbook (tools/brook_spirit_mist.py). What is modelled here:

- Heart: a ribbed, veined lantern husk, five main ribs and five lesser ones (like a winter cherry's husk), about
  0.55 m across. The game lights it from inside; its veins stay dark against the glow. What a player aims at.
- Core: a gnarled knot, about 2.3 m across, like old willow roots and river stone grown together: root strands
  twist round it from the back to the front, where their folds make the lips of a round opening over the heart.
  It is a shell with an inside: the rim rolls inward, so the opening shows a hollow the heart lights. The game
  closes the opening in the vertex shader by sliding every point towards the front along its own meridian.
- Tendrils: seven heavy living limbs of 6 to 8 m, round, 0.4 to 0.5 m across at the root with a muscular swelling
  where they leave the core, in segments of 30 to 50 cm (grooves between them, deeper on the belly), a frill along
  the back that breaks the outline, a glowing bulb 8 to 12 cm across under each segment, a paler ribbed belly, fine
  ridges and folds for the close view, a tip that thins to a point, and root-hairs hanging under the last third.
- Leaves for the ring and the storm: oak, beech, birch and alder, with a midrib and veins, in November colours
  (one curled card; the game picks the leaf), and a drawn-out drop of water.

How (the pipeline of a game's creature): every part is a surface made from a few numbers (its rings round an axis
or a profile), built twice: a sculpt of about two million triangles with all its detail (displacement from noise,
ridges, ribs, sockets, bulbs, folds), and a game model of about 48 000 triangles (4 000 far) with UVs. Cycles
bakes the sculpt onto the game model: tangent-space normals, ambient occlusion and thickness (occlusion inside the
surface). Curvature comes from the baked normals, as texture tools make it. With painted gradients (worked out at
every texel from the same numbers as the sculpt) they make the game's maps:

  <set>_color   RGB colour (sRGB); A: what glows (tendrils' nodes, the hollow, the heart's membrane) or, on the
                leaves, their outline
  <set>_normal  tangent-space normals (OpenGL, as glTF)
  <set>_orm     R occlusion, G roughness, B metal, A thinness (1 thin, 0 thick)

An alpha that carries data is stored as 0.5 + 0.5 x the value (the game reads (a - 0.5) x 2): WebP's encoder throws
away the colour under fully transparent pixels, so none of those may be transparent. The leaves' outline is 0 or 1.

for two sets: `tendril` (the seven tendrils share one texture space, so the detail is as even at the tip as at the
root) and `body` (core, heart, leaves), in web/public/models/brook-spirit/: ktx2/ at 2048 pixels and ktx2/half/ at
1024 (Low, phones), compressed for the graphics chip (Basis Universal, made with tools/basisu.mjs as tools/ktx2.py
does: ETC1S for the colours, the packed maps and the body's normals, UASTC for the tendrils' normals, which show
most), and one WebP file of each at 1024, the
fallback where KTX2 can't be transcoded. Laid out as glTF's UVs (not flipped).

The tendrils are modelled STRAIGHT, each along its own axis from its root: the game bends them in the vertex shader,
along a curve worked out from a few numbers per arm each frame. For that each arm's frame goes along as the
object's extras (`arms`, JSON, glTF axes): its root, its axis `dir`, its upper side `up`, `side`, its length and its
root's radius. Every corner of a tendril carries:
  TEXCOORD_0 (uv)  = where it lies in the tendril's maps
  TEXCOORD_1 (uv1) = (t, arm): how far along its arm it lies (0 at the root, 1 at the tip), the arm's number
and tangents (TANGENT, MikkTSpace, as the bake) so the normal map stays right while the arms bend.
The core's corners carry TEXCOORD_1 = (inside, 0): 0 on the outside, 1 on the inner wall of the hollow.

Objects: Heart, Core, Tendrils (near), HeartFar, CoreFar, TendrilsFar (far), Leaf, Drop. glTF axes: +y up, the
front +z (Blender -Y); the origin is the middle of the body. No images in the GLB: the maps are files of their own.
The same files come out of every run (fixed seeds, fixed samples).
"""
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import bmesh
import bpy
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = os.path.abspath(argv[0])


def opt(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


PREVIEW = opt("--preview", "")
SAMPLES = int(opt("--samples", "48"))
USE_CPU = "--cpu" in argv
KTX2 = "--no-ktx2" not in argv
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAPS = os.path.join(os.path.dirname(OUT), "brook-spirit")
SIZE = 2048
T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:6.1f} s]", *a, flush=True)


for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
    for item in list(coll):
        coll.remove(item)


# ---------------------------------------------------------------------------------------------- small helpers
def srgb(h):
    """'#rrggbb' to linear RGB."""
    c = np.array([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)])
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def sstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def chunked(fn, n, *arrays, size=300000):
    """fn over slices of the arrays (each of length n), its dict of results joined: keeps the memory down."""
    parts = [fn(*(a[i:i + size] for a in arrays)) for i in range(0, n, size)]
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


def wrap(a):
    """An angle into -pi..pi."""
    return (a + np.pi) % (2 * np.pi) - np.pi


def g2b(p):
    """glTF axes (x right, y up, z front) to Blender's (z up, -y front); the exporter turns them back."""
    p = np.asarray(p)
    return np.stack([p[..., 0], -p[..., 2], p[..., 1]], -1)


def norm(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


# ---------------------------------------------------------------------------------------------- noise (numpy)
_perm = np.random.RandomState(1234).permutation(256)
_P = np.concatenate([_perm, _perm]).astype(np.int64)
_G = np.array([[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
               [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]], float)


def perlin(p):
    """Gradient noise of points (..., 3), about -1..1, the same every build."""
    p = np.asarray(p, float)
    i = np.floor(p).astype(np.int64)
    f = p - i
    i &= 255
    u = f * f * f * (f * (f * 6 - 15) + 10)
    x, y, z = i[..., 0], i[..., 1], i[..., 2]
    fx, fy, fz = f[..., 0], f[..., 1], f[..., 2]

    def g(ix, iy, iz, dx, dy, dz):
        gr = _G[_P[_P[_P[ix] + iy] + iz] % 12]
        return gr[..., 0] * dx + gr[..., 1] * dy + gr[..., 2] * dz

    ux, uy, uz = u[..., 0], u[..., 1], u[..., 2]
    x1, y1, z1 = x + 1, y + 1, z + 1
    a = g(x, y, z, fx, fy, fz) + ux * (g(x1, y, z, fx - 1, fy, fz) - g(x, y, z, fx, fy, fz))
    b = g(x, y1, z, fx, fy - 1, fz) + ux * (g(x1, y1, z, fx - 1, fy - 1, fz) - g(x, y1, z, fx, fy - 1, fz))
    c = g(x, y, z1, fx, fy, fz - 1) + ux * (g(x1, y, z1, fx - 1, fy, fz - 1) - g(x, y, z1, fx, fy, fz - 1))
    d = g(x, y1, z1, fx, fy - 1, fz - 1) + ux * (g(x1, y1, z1, fx - 1, fy - 1, fz - 1) - g(x, y1, z1, fx, fy - 1, fz - 1))
    ab = a + uy * (b - a)
    cd = c + uy * (d - c)
    return (ab + uz * (cd - ab)) * 1.1


def fbm(p, octaves=4, lac=2.03, gain=0.5):
    p = np.asarray(p, float)
    total, amp, norm_ = 0.0, 1.0, 0.0
    for o in range(octaves):
        total = total + amp * perlin(p * (lac ** o) + o * 17.31)
        norm_ += amp
        amp *= gain
    return total / norm_


def ihash(*ks):
    """A repeatable integer hash of integer arrays, to 0..1."""
    h = np.zeros(np.broadcast(*ks).shape, np.uint64) + np.uint64(2166136261)
    for k in ks:
        h = (h ^ (np.asarray(k).astype(np.int64).astype(np.uint64) & np.uint64(0xFFFFFFFF))) * np.uint64(16777619)
        h &= np.uint64(0xFFFFFFFF)
        h ^= h >> np.uint64(13)
        h = (h * np.uint64(0x5BD1E995)) & np.uint64(0xFFFFFFFF)
        h ^= h >> np.uint64(15)
    return h.astype(np.float64) / 4294967296.0


def voronoi_edge(x, y, period, seed):
    """Distance to the nearest edge between cells (F2 - F1) of jittered cells; x repeats every `period` cells."""
    ix, iy = np.floor(x), np.floor(y)
    fx, fy = x - ix, y - iy
    b1 = np.full(np.shape(x), 9.0)
    b2 = np.full(np.shape(x), 9.0)
    for ox in (-1, 0, 1):
        for oy in (-1, 0, 1):
            cx = (ix + ox) % period
            cy = iy + oy
            jx = ihash(cx, cy, seed)
            jy = ihash(cx, cy, seed + 101)
            d = np.hypot(ox + 0.15 + 0.7 * jx - fx, oy + 0.15 + 0.7 * jy - fy)
            b2 = np.where(d < b1, b1, np.minimum(b2, d))
            b1 = np.minimum(b1, d)
    return b2 - b1


# ---------------------------------------------------------------------------------------------- meshes
def tube_faces(R, S, rows=None):
    """Quads between R rings of S corners (closed round): (R-1)*S faces, corners (i, j) as ring-major indices; for
    each corner also its ring and its column 0..S (S on the far side of the seam, for the UVs)."""
    i = np.arange(R - 1)[:, None]
    j = np.arange(S)[None, :]
    a = i * S + j
    b = i * S + (j + 1) % S
    c = (i + 1) * S + (j + 1) % S
    d = (i + 1) * S + j
    # Outward for rings of (cos a, sin a) round a frame whose side x up = -along: (a, d, c, b).
    faces = np.stack([a, d, c, b], -1).reshape(-1, 4)
    ring = np.stack([i + 0 * j, i + 1 + 0 * j, i + 1 + 0 * j, i + 0 * j], -1).reshape(-1, 4)
    col = np.stack([j + 0 * i, j + 0 * i, j + 1 + 0 * i, j + 1 + 0 * i], -1).reshape(-1, 4)
    return faces, ring, col


def make_mesh(name, V, groups, nuv, material):
    """One object from corners V (n, 3, glTF axes) and face groups [(faces (m, k), [uv (m, k, 2) per layer])].
    UVs in glTF's sense (v down from the top of the image); every face smooth."""
    loops = np.concatenate([f.reshape(-1) for f, _ in groups]).astype(np.int32)
    sizes = np.concatenate([np.full(len(f), f.shape[1]) for f, _ in groups]).astype(np.int32)
    starts = np.concatenate([[0], np.cumsum(sizes)[:-1]]).astype(np.int32)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(V))
    me.vertices.foreach_set("co", g2b(V).astype(np.float32).reshape(-1))
    me.loops.add(len(loops))
    me.loops.foreach_set("vertex_index", loops)
    me.polygons.add(len(sizes))
    me.polygons.foreach_set("loop_start", starts)
    me.update(calc_edges=True)
    for k in range(nuv):
        uv = np.concatenate([u[k].reshape(-1, 2) for _, u in groups]).astype(np.float64)
        uv[:, 1] = 1.0 - uv[:, 1]  # the exporter writes v as 1 - v: this keeps our numbers
        layer = me.uv_layers.new(name=f"UV{k}")
        layer.data.foreach_set("uv", uv.astype(np.float32).reshape(-1))
    me.validate(clean_customdata=False)
    me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), bool))
    if material:
        me.materials.append(material)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def signed_volume(V, faces):
    p0, p1, p2 = V[faces[:, 0]], V[faces[:, 1]], V[faces[:, 2]]
    return np.einsum("ij,ij->i", p0, np.cross(p1, p2)).sum() / 6


_mats = {}


def mat(name, hexcol, rough=0.6):
    """Materials only name the parts for the game; the game's own materials draw them."""
    if name not in _mats:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        p = m.node_tree.nodes["Principled BSDF"]
        p.inputs["Base Color"].default_value = (*srgb(hexcol), 1)
        p.inputs["Roughness"].default_value = rough
        _mats[name] = m
    return _mats[name]


# ---------------------------------------------------------------------------------------------- texture spaces
PAD = 12 / SIZE
# The tendril's maps: the length in two strips side by side (A the root half, B the tip half), the root-hairs beside.
T_SPLIT = 0.45
STRIP_A = (PAD, 0.5 - PAD)
STRIP_B = (0.5 + PAD, 0.8 - PAD)
HAIRS = (0.8 + PAD, 1.0 - PAD)  # the root-hairs (top half) and the dorsal frill (bottom half) share this column
HAIR_V = (PAD, 0.5 - PAD)
FRILL_V = (0.5 + PAD, 1.0 - PAD)
V_SPAN = (PAD, 1.0 - PAD)
# The body's: the core across the top three quarters, the heart and four leaves under it.
CORE_V = (PAD, 0.75 - PAD)
HEART_U = (PAD, 0.5 - PAD)
LOW_V = (0.75 + PAD, 1.0 - PAD)
LEAF_W = 0.125


def tendril_uv(t, w, strip):
    """(t along, w round from the dorsal seam 0..1) on strip 0 (root half) or 1 (tip half) to its UV."""
    u0, u1 = np.where(strip == 0, STRIP_A[0], STRIP_B[0]), np.where(strip == 0, STRIP_A[1], STRIP_B[1])
    f = np.where(strip == 0, t / T_SPLIT, (t - T_SPLIT) / (1 - T_SPLIT))
    return np.stack([u0 + w * (u1 - u0), V_SPAN[0] + f * (V_SPAN[1] - V_SPAN[0])], -1)


# ---------------------------------------------------------------------------------------------- the tendrils
L0, R0 = 7.0, 0.22  # the one tendril that is sculpted and baked; each arm is it, scaled to its length and root
EX, EY = 1.04, 0.96  # round and heavy, a little wider than tall


def t_radius(t):
    """Thick at the root (0.4 to 0.5 m across), a muscular swelling just out of the core, thinning to a point."""
    # Heavy for most of its length (a boss's limb, not a whip), thinning fast over its last fifth.
    taper = ((1 - t) ** 0.5 * (1 - 0.6 * t ** 3)) * 0.96 + 0.04
    swell = 1 + 0.32 * np.exp(-((t - 0.075) / 0.055) ** 2)
    return R0 * taper * swell


# The limb in segments (knuckles), 30 to 50 cm long (longer where it is thick), with a groove between them: in the game
# model's own shape, so they read from 25 m. `seg_phase` counts segments from the root (a groove at each whole number).
_ts = np.linspace(0, 1, 8193)
_seg = 0.3 + 0.2 * np.clip(t_radius(_ts) / R0, 0, 1)
_segphase = np.concatenate([[0], np.cumsum(L0 / _seg[:-1] * np.diff(_ts))])
_segphase -= 0.5  # the first groove half a segment out of the core


def seg_phase(t):
    return np.interp(t, _ts, _segphase)


def seg_groove(t):
    """1 in a groove between two segments, 0 over a segment's middle."""
    return (0.5 + 0.5 * np.cos(2 * np.pi * seg_phase(t))) ** 6 * sstep(0.04, 0.09, t) * (1 - sstep(0.9, 0.97, t))


def under_of(a):
    """1 on the underside, 0 on the back."""
    return sstep(0.1, -0.75, np.sin(a))


def ridge_of(a, width=0.30):
    return np.exp(-(wrap(a - np.pi / 2) / width) ** 2)


# The nodes: one bulb under the middle of each segment, 8 to 12 cm across (to read and glow from afar).
NODES = np.array([np.interp(k + 0.5, _segphase, _ts) for k in range(int(_segphase[-1])) if 0.1 < np.interp(k + 0.5, _segphase, _ts) < 0.9])
NODE_R = np.minimum(0.04 + 0.02 * (1 - NODES), 0.42 * t_radius(NODES) + 0.008)

# The ribs across the underside: about three to the root's width, closer where it is thin.
_tt = np.linspace(0, 1, 8193)
_lam = np.maximum(0.011, 0.33 * t_radius(_tt))
_phase = np.concatenate([[0], np.cumsum(L0 / _lam[:-1] * np.diff(_tt))])


def rib_phase(t):
    return np.interp(t, _tt, _phase)


def tendril_low_disp(t, a):
    """What the game model keeps of the shape: the dorsal ridge, the segments (their grooves deeper on the belly)."""
    r = t_radius(t)
    under = under_of(a)
    g = seg_groove(t)
    return 0.12 * r * ridge_of(a) * (1 - 0.6 * t) - r * g * (0.08 + 0.1 * under) + 0.03 * r * (1 - g)


def tendril_detail(t, a, pos):
    """The sculpt's detail over the game model (m, outward), and the masks the maps paint from it."""
    r = t_radius(t)
    along = t * L0
    # Where the pale belly meets the dark back: a wandering line, not a ruled one.
    under = under_of(a + 0.22 * perlin(pos * np.array([3.0, 3.0, 0.8]) + 1.3))
    # Ribs across the underside, rounded crests: uneven in height, bending and breaking here and there.
    rib = (0.5 + 0.5 * np.cos(2 * np.pi * (rib_phase(t) + 0.3 * perlin(pos * np.array([2.5, 2.5, 0.6]) + 4)))) ** 2.2
    rib *= 0.45 + 0.55 * sstep(-0.35, 0.45, perlin(pos * np.array([4.0, 4.0, 2.2]) + 8))
    d_rib = under ** 1.4 * 0.06 * r * rib
    # Fine ridges along the length on the back and sides: wrinkles drawn out along the limb, not stripes.
    lon = 1 - np.abs(perlin(pos * np.array([30.0, 30.0, 1.3]) + 2))
    lon2 = 1 - np.abs(perlin(pos * np.array([60.0, 60.0, 3.0]) + 6))
    d_lon = (1 - under) * r * (0.03 * (lon ** 4 - 0.25) + 0.012 * (lon2 ** 4 - 0.25))
    # Papillae: small soft bumps scattered over the back, as on a squid's skin.
    d_pap = (1 - under) * 0.018 * r * sstep(0.35, 0.75, perlin(pos * 34 + 3))
    # A sharper crest along the dorsal ridge.
    d_crest = 0.05 * r * ridge_of(a, 0.09) * (1 - 0.5 * t)
    # Where the limb leaves the core: the skin bunched in rings of folds.
    w = sstep(0.17, 0.02, t)
    d_fold = w * r * (0.10 * np.sin(along * 52 + 3.0 * perlin(pos * 3.5)) * (0.6 + 0.4 * perlin(pos * 6 + 3))
                      + 0.05 * perlin(pos * 11))
    # The nodes: a bulb in a socket with a raised rim, on the underside's midline.
    dl = (t[..., None] - NODES) * L0
    da = r[..., None] * wrap(a + np.pi / 2)[..., None] * 0.99
    d = np.hypot(dl, da) / NODE_R
    bulb = 0.5 * NODE_R * np.sqrt(np.clip(1 - (d / 0.85) ** 2, 0, 1))
    socket = -0.2 * NODE_R * np.exp(-((d - 1.05) / 0.26) ** 2)
    rim = 0.09 * NODE_R * np.exp(-((d - 1.45) / 0.3) ** 2)
    k = np.argmin(d, axis=-1)
    pick = lambda m: np.take_along_axis(m, k[..., None], -1)[..., 0]
    dn = pick(d)
    d_node = pick(bulb + socket + rim)
    # Skin: slow swellings and fine pores.
    d_skin = 0.05 * r * fbm(pos * 5.0, 3) + 0.0022 * fbm(pos * 38.0, 3)
    # The ribs and ridges stop round the sockets.
    keep = sstep(1.0, 1.7, dn)
    disp = (d_rib + d_lon + d_pap) * keep + d_crest + d_fold + d_node + d_skin
    masks = {"under": under, "rib": rib * under, "node": sstep(0.9, 0.55, dn), "socket": sstep(1.35, 1.0, dn) * (1 - sstep(0.9, 0.55, dn)),
             "fold": w, "nodeT": NODES[k]}
    return disp, masks


def tendril_point(t, a, disp):
    """The tendril's surface in its own frame (x side, y up, z along), with `disp` along the cross-section's normal."""
    r = t_radius(t)
    ca, sa = np.cos(a), np.sin(a)
    nx, ny = ca / EX, sa / EY
    nl = np.hypot(nx, ny)
    return np.stack([r * EX * ca + disp * nx / nl, r * EY * sa + disp * ny / nl, t * L0], -1)


def tendril_rings(spacing, t_min=0.0, per_segment=0):
    """Ring positions t from the root, spaced as a share of the radius (closer at the thin tip), with T_SPLIT exact.
    `per_segment`: instead, that many rings to a segment (one in each groove), and close ones near the tip."""
    if per_segment:
        ph = np.arange(0, _segphase[-1] + 0.5, 1 / per_segment)
        ts = np.interp(ph, _segphase, _ts)
        ts = np.unique(np.concatenate([[0.0, 0.025, 0.05], ts[ts > 0.06], np.linspace(0.93, 1.0, 6)]))
    else:
        ts = [t_min]
        while ts[-1] < 1:
            ts.append(min(1.0, ts[-1] + max(spacing[1], spacing[0] * t_radius(ts[-1])) / L0))
        ts = np.array(ts)
    k = np.argmin(abs(ts - T_SPLIT))
    ts[k] = T_SPLIT
    return ts


def tendril_mesh(ts, S, detail):
    """One tendril (its own frame): rings at ts, S corners round, a tip point; corners, faces with their UVs."""
    R = len(ts)
    a = np.pi / 2 + 2 * np.pi * np.arange(S) / S  # from the dorsal seam round
    T, A = np.meshgrid(ts, a, indexing="ij")
    base = tendril_point(T, A, tendril_low_disp(T, A))
    if detail:
        disp = chunked(lambda t, a, p: {"d": tendril_detail(t, a, p)[0]}, T.size, T.ravel(), A.ravel(), base.reshape(-1, 3))["d"]
        P = tendril_point(T, A, tendril_low_disp(T, A) + disp.reshape(T.shape))
    else:
        P = base
    V = P.reshape(-1, 3)
    faces, ring, col = tube_faces(R, S)
    # Each face on its strip; its corners' UVs from (t, w).
    t_face = ts[ring[:, 0]]
    strip = (t_face >= T_SPLIT - 1e-9).astype(int)[:, None] * np.ones((1, 4), int)
    uv = tendril_uv(ts[ring], col / S, strip)
    # The tip: one point a little beyond the last ring; the root's end closed inside the core.
    tip = len(V)
    root = tip + 1
    V = np.concatenate([V, [[0, 0, L0 * 1.002], [0, 0, -0.01]]])
    last = (R - 1) * S
    j = np.arange(S)
    tip_f = np.stack([last + j, np.full(S, tip), last + (j + 1) % S], -1)
    tip_uv = tendril_uv(np.ones((S, 3)), np.stack([j / S, (j + 0.5) / S, (j + 1) / S], -1), np.ones((S, 3), int))
    root_f = np.stack([(j + 1) % S, np.full(S, root), j], -1)
    root_uv = tendril_uv(np.zeros((S, 3)), np.stack([(j + 1) / S, (j + 0.5) / S, j / S], -1), np.zeros((S, 3), int))
    groups = [(faces, [uv]), (tip_f, [tip_uv]), (root_f, [root_uv])]
    if signed_volume(V, np.concatenate([faces[:, :3], tip_f, root_f])) < 0:
        groups = [(f[:, ::-1], [u[:, ::-1]]) for f, (u,) in groups]
    return V, groups


def hair_mesh(seed):
    """Root-hairs under the last third: thin three-sided strands hanging down and back, a little curled."""
    rnd = np.random.RandomState(seed)
    V, groups = [], []
    n = 0
    for h in range(8):
        t0 = 0.64 + 0.04 * h + 0.012 * rnd.rand()
        side = 1 if h % 2 else -1
        a0 = -np.pi / 2 + side * (0.55 + 0.3 * rnd.rand())
        r = t_radius(t0)
        base = tendril_point(np.array(t0), np.array(a0), np.array(-0.15 * r))
        length = (0.22 + 0.22 * rnd.rand()) * (1.4 - t0)
        thick = 0.005 * (1.25 - t0) + 0.0015
        segs, sides = 5, 3
        pts = []
        for i in range(segs + 1):
            f = i / segs
            # Trailing back along the limb towards the tip, drooping a little, curling sideways at the end.
            c = base + np.array([side * 0.3 * length * f * f, -0.4 * length * f, 0.9 * length * f])
            rr = thick * (1 - f) ** 0.8 + 0.0008
            for k in range(sides):
                ang = 2 * np.pi * k / sides
                pts.append(c + rr * np.array([np.cos(ang), 0.35 * np.sin(ang), np.sin(ang)]))
        pts.append(base + np.array([side * 0.3 * length, -0.41 * length, 0.93 * length]))
        pts = np.array(pts)
        faces, ring, col = tube_faces(segs + 1, sides)
        uv = np.stack([HAIRS[0] + (HAIRS[1] - HAIRS[0]) * col / sides, HAIR_V[0] + (HAIR_V[1] - HAIR_V[0]) * ring / segs], -1)
        last = segs * sides
        j = np.arange(sides)
        tf = np.stack([last + j, np.full(sides, len(pts) - 1), last + (j + 1) % sides], -1)
        tuv = np.stack([HAIRS[0] + (HAIRS[1] - HAIRS[0]) * np.stack([j / sides, (j + 0.5) / sides, (j + 1) / sides], -1),
                        np.full((sides, 3), HAIR_V[1])], -1)
        # Hair winding: its rings run (cos, sin) round x-z: check and flip to face outward.
        if np.dot(np.cross(pts[faces[0, 1]] - pts[faces[0, 0]], pts[faces[0, 3]] - pts[faces[0, 0]]), pts[faces[0, 0]] - (base)) < 0:
            faces, uv = faces[:, ::-1], uv[:, ::-1]
            tf, tuv = tf[:, ::-1], tuv[:, ::-1]
        groups += [(faces + n, [uv]), (tf + n, [tuv])]
        V.append(pts)
        n += len(pts)
    return np.concatenate(V), groups


def bulb_mesh(lat=3, lon=8):
    """The nodes as real bulbs on the belly, set a little into it: domes that catch the light and glow (their UVs on
    the node painted in the tendril's maps, so they share its glow and its pulse)."""
    V, groups, n = [], [], 0
    for tk, rb in zip(NODES, NODE_R):
        c = tendril_point(np.array(tk), np.array(-np.pi / 2), np.array(tendril_low_disp(np.array(tk), np.array(-np.pi / 2)) - 0.35 * rb))
        pts = []
        for i in range(lat):
            th = (np.pi / 2) * (i + 1) / lat  # from near the dome's top (down, away from the limb) to its rim
            for j in range(lon):
                ph = 2 * np.pi * j / lon
                pts.append(c + rb * np.array([np.sin(th) * np.cos(ph), -np.cos(th) * 1.0, np.sin(th) * np.sin(ph)]))
        pts.append(c + rb * np.array([0.0, -1.0, 0.0]))  # the top: one point, a fan round it (no degenerate faces)
        pts = np.array(pts)
        # Each corner's UV: where it lies on the limb (t, round), on the painted node.
        t = np.clip(pts[:, 2] / L0, 0, 1)
        a = np.arctan2(pts[:, 1] / EY, pts[:, 0] / EX)
        w = ((a - np.pi / 2) % (2 * np.pi)) / (2 * np.pi)
        faces, ring, col = tube_faces(lat, lon)
        j = np.arange(lon)
        fan = np.stack([np.full(lon, len(pts) - 1), j, (j + 1) % lon], -1)
        strip = (tk >= T_SPLIT).astype(int)
        uv = tendril_uv(t[faces], w[faces], strip * np.ones(faces.shape, int))
        fan_uv = tendril_uv(t[fan], w[fan], strip * np.ones(fan.shape, int))
        if np.dot(np.cross(pts[faces[0, 1]] - pts[faces[0, 0]], pts[faces[0, 3]] - pts[faces[0, 0]]), pts[faces[0, 0]] - c) < 0:
            faces, uv = faces[:, ::-1], uv[:, ::-1]
        if np.dot(np.cross(pts[fan[0, 1]] - pts[fan[0, 0]], pts[fan[0, 2]] - pts[fan[0, 0]]), pts[fan[0, 0]] - c) < 0:
            fan, fan_uv = fan[:, ::-1], fan_uv[:, ::-1]
        groups += [(faces + n, [uv]), (fan + n, [fan_uv])]
        V.append(pts)
        n += len(pts)
    return np.concatenate(V), groups


def frill_mesh():
    """A frill along the dorsal ridge that breaks the outline: a thin membrane, high over each segment's middle and
    notched at its grooves, lower towards the tip; two faces a centimetre apart so it shows from both sides."""
    ph = np.arange(np.ceil(seg_phase(0.08) * 4) / 4, seg_phase(0.86), 0.25)
    ts = np.interp(ph, _segphase, _ts)
    N = len(ts)
    top = np.pi / 2
    base = tendril_point(ts, np.full(N, top), tendril_low_disp(ts, np.full(N, top)) - 0.02 * t_radius(ts))
    env = np.sin(np.pi * np.clip((ts - 0.08) / 0.78, 0, 1)) ** 0.6
    h = (0.06 + 0.12 * env) * (0.35 + 0.65 * np.sin(np.pi * (ph % 1)) ** 0.7) * np.clip(t_radius(ts) / R0 * 1.4, 0.3, 1)
    # Each station: base left, base right, top (leaning a little back towards the tip).
    left = base + np.array([-0.008, 0, 0])
    right = base + np.array([0.008, 0, 0])
    tip = base + np.stack([np.zeros(N), h, h * 0.25], -1)
    V = np.concatenate([left, right, tip])
    i = np.arange(N - 1)
    L, R_, T = i, N + i, 2 * N + i
    side_l = np.stack([L, L + 1, T + 1, T], -1)
    side_r = np.stack([R_, T, T + 1, R_ + 1], -1)
    fu = lambda k: FRILL_V[0] + (FRILL_V[1] - FRILL_V[0]) * (ts[k] - 0.08) / 0.78
    hu = lambda f: HAIRS[0] + (HAIRS[1] - HAIRS[0]) * f
    uv_l = np.stack([np.stack([hu(0 * i), hu(0 * i), hu(0 * i + 1), hu(0 * i + 1)], -1), np.stack([fu(i), fu(i + 1), fu(i + 1), fu(i)], -1)], -1)
    uv_r = np.stack([np.stack([hu(0 * i), hu(0 * i + 1), hu(0 * i + 1), hu(0 * i)], -1), np.stack([fu(i), fu(i), fu(i + 1), fu(i + 1)], -1)], -1)
    # Facing out on both sides: the left face's normal towards -x, the right's towards +x.
    n_l = np.cross(V[side_l[0, 1]] - V[side_l[0, 0]], V[side_l[0, 3]] - V[side_l[0, 0]])
    if n_l[0] > 0:
        side_l, uv_l = side_l[:, ::-1], uv_l[:, ::-1]
    n_r = np.cross(V[side_r[0, 1]] - V[side_r[0, 0]], V[side_r[0, 3]] - V[side_r[0, 0]])
    if n_r[0] < 0:
        side_r, uv_r = side_r[:, ::-1], uv_r[:, ::-1]
    return V, [(side_l, [uv_l]), (side_r, [uv_r])]


def arm_frame(root, d):
    d = norm(d)
    up = norm(np.array([0, 1, 0]) - d * d[1])
    return {"root": np.array(root, float), "dir": d, "up": up, "side": np.cross(d, up)}


ARMS = []
# Each arm leaves the core sideways, nearly level, round the body (its turn from the front in degrees, +x to the
# right); the game raises it in an arch out of the mist and lets it curve down and curl. Lengths and heights differ,
# so the outline is uneven.
for az, el, y, length, radius in (
    (-30, 6, -0.30, 8.0, 0.25),    # 0, 1: the long ones at the front, raised to reach (either side of the opening)
    (30, 6, -0.30, 8.0, 0.25),
    (-82, 0, -0.18, 7.0, 0.23),    # 2, 3: at the sides
    (86, -4, -0.36, 6.5, 0.22),
    (-138, -4, -0.40, 6.0, 0.21),  # 4, 5, 6: behind
    (142, 2, -0.22, 6.8, 0.22),
    (180, -8, -0.48, 7.2, 0.22),
):
    az_, el_ = math.radians(az), math.radians(el)
    f = arm_frame((math.sin(az_) * 0.82, y, math.cos(az_) * 0.72), (math.sin(az_) * math.cos(el_), math.sin(el_), math.cos(az_) * math.cos(el_)))
    f["length"] = length
    f["radius"] = radius
    ARMS.append(f)


def place_arms(V, groups, ai_list):
    """The one tendril, scaled and set on each arm; every corner also gets (t, arm)."""
    allV, allG, n = [], [], 0
    for ai in ai_list:
        arm = ARMS[ai]
        sx = arm["radius"] / R0
        sz = arm["length"] / L0
        W = arm["root"] + np.outer(V[:, 0] * sx, arm["side"]) + np.outer(V[:, 1] * sx, arm["up"]) + np.outer(V[:, 2] * sz, arm["dir"])
        t = np.clip(V[:, 2] / L0, 0, 1)
        for faces, uvs in groups:
            ta = np.stack([t[faces], np.full(faces.shape, float(ai))], -1)
            allG.append((faces + n, [uvs[0], ta]))
        allV.append(W)
        n += len(W)
    return np.concatenate(allV), allG


# ---------------------------------------------------------------------------------------------- the core
CORE_R = 1.05     # its outer radius (m), before the lumps
CORE_IN = 0.8     # the hollow's radius
LIP = 0.78        # the opening's edge, in radians from the front (open as modelled)
BODY = np.array([1.12, 0.92, 1.0])  # a little wider than tall
S_OUT, S_RIM = 0.58, 0.70


def core_profile(s):
    """Along the profile s 0..1: back to the opening's edge outside, round the rim, back along the hollow inside.
    Returns (angle from the front, radius scale, inside 0..1)."""
    s = np.asarray(s, float)
    ci = CORE_IN / CORE_R
    f1 = np.clip(s / S_OUT, 0, 1)
    f2 = np.clip((s - S_OUT) / (S_RIM - S_OUT), 0, 1)
    f3 = np.clip((s - S_RIM) / (1 - S_RIM), 0, 1)
    th_out = np.pi - 0.04 - (np.pi - 0.04 - LIP) * f1
    th_rim = LIP - 0.07 * np.sin(np.pi * f2)
    th_in = LIP + (np.pi - 0.3 - LIP) * f3
    rs_rim = (1 + ci) / 2 + (1 - ci) / 2 * np.cos(np.pi * f2)
    th = np.where(s < S_OUT, th_out, np.where(s < S_RIM, th_rim, th_in))
    rs = np.where(s < S_OUT, 1.0, np.where(s < S_RIM, rs_rim, ci))
    inside = np.where(s < S_OUT, 0.0, np.where(s < S_RIM, f2, 1.0))
    return th, rs, inside


def core_dirs(th, ph):
    return np.stack([np.sin(th) * np.cos(ph), np.sin(th) * np.sin(ph), np.cos(th)], -1)


ROOT_STRANDS = 9


def core_shape(th, ph, inside, s, detail):
    """The core's radius as a share of its own (1 + this): what the game model keeps, and with `detail` the sculpt's."""
    d = core_dirs(th, ph)
    out = 1 - inside
    lumps = 0.12 * fbm(d * 1.5, 4)
    # Root strands twisting round from the back to the front, raised and rounded, the folds between them deep.
    roots = np.zeros(np.shape(th))
    for k in range(ROOT_STRANDS):
        tw = (0.9 if k % 2 == 0 else -0.6)
        phk = 2 * np.pi * k / ROOT_STRANDS + tw * (np.pi - th) + 0.3 * np.sin(3 * th + k)
        dang = wrap(ph - phk) * np.sin(th)
        wk = 0.10 + 0.04 * np.sin(k * 1.7)
        roots = np.maximum(roots, (0.085 + 0.025 * np.sin(k * 2.3)) * np.clip(1 - (dang / wk) ** 2, 0, 1) ** 1.5)
    # Round the opening the strands gather into lips, folded like a drawn-up bag (soft, rounded folds).
    rim = sstep(0.42, 0.56, s) * (1 - sstep(0.74, 0.82, s))
    lip_folds = 0.045 * np.sin(ph * 13 + 1.5 * perlin(d * 3)) * rim
    shape = (lumps + roots * (1 - 0.6 * rim)) * out * (1 - 0.3 * rim) + lip_folds + 0.05 * fbm(d * 2.2 + 5, 3) * inside
    masks = {"root": sstep(0.01, 0.06, roots) * out, "rim": rim}
    if not detail:
        return shape, masks
    # Deep, narrow folds between the strands; smooth river stones grown in between; bark grain along the strands.
    crease = -0.05 * (1 - np.abs(perlin(d * 4.0 + 2))) ** 5 * (1 - masks["root"]) * out
    stone = sstep(0.05, 0.45, fbm(d * 2.6 + 11, 2)) * (1 - masks["root"]) * out
    d_stone = 0.035 * stone * (0.6 + 0.4 * perlin(d * 7))
    grain = 0.0085 * fbm(d * np.array([26.0, 26.0, 6.0]), 3) * (1 - stone) * out
    pores = 0.003 * fbm(d * 70, 2)
    # Inside, the hollow's wall: soft folds and raised veins the heart's light runs along.
    veins = 0.012 * sstep(0.88, 0.98, 1 - np.abs(perlin(d * 6 + 9))) * inside
    shape = shape + crease + d_stone + grain + pores + veins
    masks.update({"stone": stone, "vein": sstep(0.86, 0.97, 1 - np.abs(perlin(d * 6 + 9))) * inside})
    return shape, masks


def core_point(th, ph, rs, shape):
    return core_dirs(th, ph) * (CORE_R * rs * (1 + shape))[..., None] * BODY


def core_mesh(n_s, segs, detail):
    # Closer rings round the rim, where the profile turns.
    s = np.unique(np.concatenate([np.linspace(0, S_OUT, int(n_s * 0.55)), np.linspace(S_OUT, S_RIM, int(n_s * 0.2)), np.linspace(S_RIM, 1, int(n_s * 0.25))]))
    th, rs, inside = core_profile(s)
    ph = 2 * np.pi * np.arange(segs) / segs
    TH, PH = np.meshgrid(th, ph, indexing="ij")
    RS, IN = np.meshgrid(rs, ph, indexing="ij")[0], np.meshgrid(inside, ph, indexing="ij")[0]
    SS = np.meshgrid(s, ph, indexing="ij")[0]
    shape, _ = core_shape(TH, PH, IN, SS, detail)
    V = core_point(TH, PH, RS, shape).reshape(-1, 3)
    R = len(s)
    faces, ring, col = tube_faces(R, segs)
    uv = np.stack([PAD + (1 - 2 * PAD) * col / segs, CORE_V[0] + (CORE_V[1] - CORE_V[0]) * s[ring]], -1)
    # Close the back: a fan on the outside's first ring and on the inside's last.
    nv = len(V)
    back_shape, _ = core_shape(np.array(np.pi), np.array(0.0), np.array(0.0), np.array(0.0), detail)
    V = np.concatenate([V, [[0, 0, -CORE_R * (1 + float(back_shape))]], [[0, 0, -CORE_IN * 0.98]]])
    j = np.arange(segs)
    f0 = np.stack([np.full(segs, nv), (j + 1) % segs, j], -1)
    uv0 = np.stack([PAD + (1 - 2 * PAD) * np.stack([np.full(segs, 0.5), (j + 1) / segs, j / segs], -1), np.full((segs, 3), CORE_V[0])], -1)
    last = (R - 1) * segs
    f1 = np.stack([np.full(segs, nv + 1), last + j, last + (j + 1) % segs], -1)
    uv1 = np.stack([PAD + (1 - 2 * PAD) * np.stack([np.full(segs, 0.5), j / segs, (j + 1) / segs], -1), np.full((segs, 3), CORE_V[1])], -1)
    # Which way the faces turn: the outside's normal points away from the middle.
    if signed_volume(V, np.concatenate([faces[:, :3], f0, f1])) < 0:
        faces, uv, f0, uv0, f1, uv1 = faces[:, ::-1], uv[:, ::-1], f0[:, ::-1], uv0[:, ::-1], f1[:, ::-1], uv1[:, ::-1]
    inside_all = np.concatenate([np.repeat(inside, segs), [0.0, 1.0]])
    ins = lambda f: np.stack([inside_all[f], np.zeros(f.shape)], -1)
    return V, [(faces, [uv, ins(faces)]), (f0, [uv0, ins(f0)]), (f1, [uv1, ins(f1)])]


# ---------------------------------------------------------------------------------------------- the heart
HW, HH, HZ = 0.27, 0.34, 0.18


def heart_shape(s, a):
    """The husk's radius at height s (0 bottom tip, 1 top) and angle a: five main ribs, five lesser, the faces
    between them drawn in a little, as a paper lantern's."""
    bulge = np.sin(np.pi * s) ** 0.85 * (1 + 0.12 * np.sin(np.pi * s * 0.9))
    main = np.exp(-(wrap(a * 5) / 0.55) ** 2)
    minor = np.exp(-(wrap(a * 5 + np.pi) / 0.4) ** 2)
    rib = 1 + np.sin(np.pi * s) * (0.11 * main + 0.035 * minor - 0.03)
    return HW * bulge * rib, main, minor


def heart_veins(s, a):
    """The vein net between the ribs, two sizes."""
    big = voronoi_edge(a / (2 * np.pi) * 20, s * 9, 20, 7)
    small = voronoi_edge(a / (2 * np.pi) * 48, s * 22, 48, 19)
    return np.maximum(sstep(0.13, 0.03, big), 0.55 * sstep(0.09, 0.02, small))


def heart_point(s, a, extra):
    r, _, _ = heart_shape(s, a)
    y = -HH + 2 * HH * (1 - np.cos(np.pi * s)) / 2
    r = r + extra
    return np.stack([r * np.cos(a), y + 0 * a, HZ + r * np.sin(a)], -1)


def heart_mesh(rings, segs, detail):
    s = np.linspace(0, 1, rings + 1)[1:-1]
    a = 2 * np.pi * np.arange(segs) / segs
    S_, A_ = np.meshgrid(s, a, indexing="ij")
    extra = 0.0
    if detail:
        _, main, minor = heart_shape(S_, A_)
        vein = heart_veins(S_, A_)
        wrinkle = 0.0015 * fbm(heart_point(S_, A_, 0) * 60, 2)
        extra = (0.0045 * vein + 0.004 * main * np.sin(np.pi * S_) - 0.0015 + wrinkle) * sstep(0.0, 0.06, S_) * sstep(1.0, 0.94, S_)
    V = heart_point(S_, A_, extra).reshape(-1, 3)
    R = len(s)
    faces, ring, col = tube_faces(R, segs)
    hu = lambda c: HEART_U[0] + (HEART_U[1] - HEART_U[0]) * c
    hv = lambda ss: LOW_V[0] + (LOW_V[1] - LOW_V[0]) * (1 - ss)
    uv = np.stack([hu(col / segs), hv(s[ring])], -1)
    nv = len(V)
    V = np.concatenate([V, [[0, -HH, HZ], [0, HH, HZ]]])
    j = np.arange(segs)
    fb = np.stack([np.full(segs, nv), (j + 1) % segs, j], -1)
    uvb = np.stack([hu(np.stack([np.full(segs, 0.5), (j + 1) / segs, j / segs], -1)), np.full((segs, 3), hv(0.0))], -1)
    last = (R - 1) * segs
    ft = np.stack([np.full(segs, nv + 1), last + j, last + (j + 1) % segs], -1)
    uvt = np.stack([hu(np.stack([np.full(segs, 0.5), j / segs, (j + 1) / segs], -1)), np.full((segs, 3), hv(1.0))], -1)
    if signed_volume(V, np.concatenate([faces[:, :3], fb, ft])) < 0:
        faces, uv, fb, uvb, ft, uvt = faces[:, ::-1], uv[:, ::-1], fb[:, ::-1], uvb[:, ::-1], ft[:, ::-1], uvt[:, ::-1]
    return V, [(faces, [uv]), (fb, [uvb]), (ft, [uvt])]


# ---------------------------------------------------------------------------------------------- leaves and a drop
LEAF_L, LEAF_W2 = 0.17, 0.065  # a leaf card: its length (m) and half its width


def leaf_mesh():
    """One curled card for every leaf (the game picks oak, beech, birch or alder by its maps' cell)."""
    nx, ny = 6, 9
    x = np.linspace(-1, 1, nx)
    y = np.linspace(-0.12, 1.0, ny)
    X, Y = np.meshgrid(x, y, indexing="ij")
    # Cupped across, curled down along its length, a slight twist.
    P = np.stack([X * LEAF_W2, 0.018 * X ** 2 - 0.05 * Y ** 2 + 0.008 * X * Y, (Y - 0.4) * LEAF_L], -1).reshape(-1, 3)
    i = np.arange(nx - 1)[:, None]
    j = np.arange(ny - 1)[None, :]
    a, b, c, d = i * ny + j, (i + 1) * ny + j, (i + 1) * ny + j + 1, i * ny + j + 1
    faces = np.stack([a, b, c, d], -1).reshape(-1, 4)
    if np.cross(P[faces[0, 1]] - P[faces[0, 0]], P[faces[0, 3]] - P[faces[0, 0]])[1] < 0:
        faces = faces[:, ::-1]
    u = 0.5 + PAD + (LEAF_W - 2 * PAD) * (X.ravel() + 1) / 2
    v = LOW_V[1] - (LOW_V[1] - LOW_V[0]) * (Y.ravel() + 0.12) / 1.12
    uv = np.stack([u, v], -1)[faces]
    return P, [(faces, [uv])]


def drop_mesh():
    """A drop of brook water drawn out behind as it flies (+z its way): a round bead, a long tapering tail."""
    rings, segs = 12, 8
    rb = 0.024
    z = np.concatenate([rb * np.cos(np.linspace(0.35, np.pi / 2, 4)), np.linspace(-0.012, -0.09, rings - 4)])
    r = np.where(z >= 0, np.sqrt(np.clip(rb * rb - z * z, 0, None)), rb * np.clip(1 + z / 0.092, 0, 1) ** 1.5)
    r = np.maximum(r, 0.0006)
    a = 2 * np.pi * np.arange(segs) / segs
    Z, A = np.meshgrid(z, a, indexing="ij")
    Rr = np.meshgrid(r, a, indexing="ij")[0]
    P = np.stack([Rr * np.cos(A), Rr * np.sin(A), Z], -1).reshape(-1, 3)
    faces, ring, col = tube_faces(rings, segs)
    nv = len(P)
    P = np.concatenate([P, [[0, 0, rb * 1.001], [0, 0, -0.092]]])
    j = np.arange(segs)
    f0 = np.stack([np.full(segs, nv), (j + 1) % segs, j], -1)
    f1 = np.stack([np.full(segs, nv + 1), (rings - 1) * segs + j, (rings - 1) * segs + (j + 1) % segs], -1)
    allf = [faces, f0, f1]
    if signed_volume(P, np.concatenate([faces[:, :3], f0, f1])) < 0:
        allf = [f[:, ::-1] for f in allf]
    return P, [(f, [np.zeros(f.shape + (2,))]) for f in allf]


# ---------------------------------------------------------------------------------------------- build
log("building the game models and the sculpts")
TENDRIL = mat("Tendril", "#2b363d", 0.35)
CORE = mat("Core", "#2a2620", 0.6)
HEART = mat("Heart", "#e6fff0", 0.5)
LEAF = mat("Leaf", "#8a6034", 0.7)
DROP = mat("Drop", "#9cc0d2", 0.05)

# The game's tendrils: near (five rings to a segment, 20 round, with the bulbs, the frill and the root-hairs) and far
# (about 20 rings of 8).
ts_near = tendril_rings(None, per_segment=5)
ts_far = tendril_rings((1.6, 0.25))
TV, TG = tendril_mesh(ts_near, 20, False)
TFV, TFG = tendril_mesh(ts_far, 8, False)
parts_v, parts_g, n_v = [TV], list(TG), len(TV)
for pv, pg in (hair_mesh(3), bulb_mesh(), frill_mesh()):
    parts_v.append(pv)
    parts_g += [(f + n_v, u) for f, u in pg]
    n_v += len(pv)
nearV, nearG = place_arms(np.concatenate(parts_v), parts_g, range(7))
farV, farG = place_arms(TFV, TFG, range(7))
objs = [
    make_mesh("Heart", *heart_mesh(30, 44, False), 1, HEART),
    make_mesh("Core", *core_mesh(64, 104, False), 2, CORE),
    make_mesh("Tendrils", nearV, nearG, 2, TENDRIL),
    make_mesh("HeartFar", *heart_mesh(8, 12, False), 1, HEART),
    make_mesh("CoreFar", *core_mesh(18, 22, False), 2, CORE),
    make_mesh("TendrilsFar", farV, farG, 2, TENDRIL),
    make_mesh("Leaf", *leaf_mesh(), 1, LEAF),
    make_mesh("Drop", *drop_mesh(), 1, DROP),
]
log("game models built; the sculpts next")

# What the bake reads from and bakes onto: the one tendril (its own frame), the near core and heart.
bake_tendril = make_mesh("BakeTendril", *tendril_mesh(ts_near, 20, False), 1, None)
hi_ts = tendril_rings((0.045, 0.0028))
hi_tendril = make_mesh("HiTendril", *tendril_mesh(hi_ts, 224, True), 1, None)
log(f"tendril sculpt: {len(hi_ts)} rings of 224")
hi_core = make_mesh("HiCore", *core_mesh(720, 1000, True), 2, None)
log("core sculpt")
hi_heart = make_mesh("HiHeart", *heart_mesh(420, 640, True), 1, None)
log("heart sculpt")

# ---------------------------------------------------------------------------------------------- bake
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.seed = 7
scene.cycles.use_denoising = False
if not USE_CPU:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            gpus = [d for d in prefs.devices if d.type == kind]
            if gpus:
                for d in prefs.devices:
                    d.use = d.type == kind
                scene.cycles.device = "GPU"
                log("baking on", gpus[0].name, kind)
                break
        except Exception as e:  # no such device here
            log("no", kind, e)


def bake_image(name, fill):
    img = bpy.data.images.new(name, SIZE, SIZE, alpha=True, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.tile(np.array(fill, np.float32), SIZE * SIZE))
    return img


def bake_material(obj, img):
    m = bpy.data.materials.new(f"bake_{obj.name}")
    m.use_nodes = True
    n = m.node_tree.nodes.new("ShaderNodeTexImage")
    n.image = img
    m.node_tree.nodes.active = n
    obj.data.materials.clear()
    obj.data.materials.append(m)


def thickness_material(obj, distance):
    """Emission = occlusion looking into the surface: 1 where it is thin (rays get out), 0 where thick."""
    m = bpy.data.materials.new(f"thick_{obj.name}")
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
    ao.inside = True
    ao.samples = 24
    ao.inputs["Distance"].default_value = distance
    em = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(ao.outputs["AO"], em.inputs["Strength"])
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    obj.data.materials.clear()
    obj.data.materials.append(m)


def bake(low, high, img, kind, extrusion, samples=1):
    bake_material(low, img)
    scene.cycles.samples = samples
    # Only this pair in the scene: occlusion and thickness rays see everything that renders.
    for o in scene.objects:
        o.hide_render = o not in (low, high)
    bpy.ops.object.select_all(action="DESELECT")
    high.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    bpy.ops.object.bake(type=kind, use_selected_to_active=True, cage_extrusion=extrusion, max_ray_distance=extrusion * 2.5,
                        margin=10, margin_type="EXTEND", use_clear=False, normal_space="TANGENT", target="IMAGE_TEXTURES")


def pixels(img):
    a = np.empty(SIZE * SIZE * 4, np.float32)
    img.pixels.foreach_get(a)
    return np.flipud(a.reshape(SIZE, SIZE, 4)).astype(np.float64)  # top row first, as the file and glTF's v


core_low = next(o for o in objs if o.name == "Core")
heart_low = next(o for o in objs if o.name == "Heart")
saved = {o.name: list(o.data.materials) for o in (core_low, heart_low)}

maps = {}
for set_name, pairs in (("tendril", [(bake_tendril, hi_tendril, 0.05)]),
                        ("body", [(core_low, hi_core, 0.12), (heart_low, hi_heart, 0.03)])):
    nrm = bake_image(f"{set_name}_n", (0.5, 0.5, 1.0, 1.0))
    occ = bake_image(f"{set_name}_ao", (1.0, 1.0, 1.0, 1.0))
    thk = bake_image(f"{set_name}_thk", (1.0, 1.0, 1.0, 1.0))
    for low, high, ext in pairs:
        bake(low, high, nrm, "NORMAL", ext)
        log(set_name, low.name, "normals baked")
        bake(low, high, occ, "AO", ext, SAMPLES)
        log(set_name, low.name, "occlusion baked")
        if high is not hi_heart:
            # On the processor: the occlusion node's rays came out a little different on each run on the graphics
            # card, and the same files must come out every time.
            thickness_material(high, 0.3 if high is hi_tendril else 0.35)
            device = scene.cycles.device
            scene.cycles.device = "CPU"
            bake(low, high, thk, "EMIT", ext, 8)
            scene.cycles.device = device
            log(set_name, low.name, "thickness baked")
    maps[set_name] = {"normal": pixels(nrm)[..., :3], "ao": pixels(occ)[..., 0], "thin": pixels(thk)[..., 0]}
for o in (core_low, heart_low):
    o.data.materials.clear()
    for m in saved[o.name]:
        o.data.materials.append(m)

# ---------------------------------------------------------------------------------------------- paint
log("painting the maps")
H = W = SIZE
yy, xx = np.mgrid[0:H, 0:W]
U = (xx + 0.5) / W
V = (yy + 0.5) / H


def curvature(nrm, blur=2):
    """Convex positive, concave negative, from the baked normals (as texture tools derive it)."""
    n = nrm * 2 - 1
    c = (np.roll(n[..., 0], -1, 1) - np.roll(n[..., 0], 1, 1)) - (np.roll(n[..., 1], -1, 0) - np.roll(n[..., 1], 1, 0))
    for _ in range(blur):
        c = (c + np.roll(c, 1, 0) + np.roll(c, -1, 0) + np.roll(c, 1, 1) + np.roll(c, -1, 1)) / 5
    return np.clip(c * 6, -1, 1)


def height_normal(h, k):
    """Tangent-space normals from a height field (rows down = v down; green up = v up in the image, as OpenGL)."""
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) / 2
    gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) / 2
    n = np.stack([-gx * k, gy * k, np.ones_like(h)], -1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True) * 0.5 + 0.5


def mixc(a, b, f):
    return a + (b - a) * np.asarray(f)[..., None]


# --- the tendril's maps
tm = maps["tendril"]
color = np.zeros((H, W, 4))
orm = np.zeros((H, W, 4))
orm[..., 0] = 1
orm[..., 1] = 0.5
orm[..., 3] = 0.5
normal = tm["normal"].copy()
curv = curvature(normal)
for strip, (u0, u1) in enumerate((STRIP_A, STRIP_B)):
    inside = (U >= u0 - PAD) & (U < u1 + PAD)
    w = np.clip((U - u0) / (u1 - u0), 0, 1)
    f = np.clip((V - V_SPAN[0]) / (V_SPAN[1] - V_SPAN[0]), 0, 1)
    t = f * T_SPLIT if strip == 0 else T_SPLIT + f * (1 - T_SPLIT)
    a = np.pi / 2 + 2 * np.pi * w
    sel = np.nonzero(inside)
    ts_, as_ = t[sel], a[sel]
    pos = tendril_point(ts_, as_, tendril_low_disp(ts_, as_))
    mk = chunked(lambda t_, a_, p_: tendril_detail(t_, a_, p_)[1], len(ts_), ts_, as_, pos)
    ao = tm["ao"][sel]
    cv = curv[sel]
    # Wet near-black slate on the back, mottled with a little moss-green; a clearly paler, warm grey belly; the
    # grooves between the segments darker still; the bulbs pale green-white.
    mott = fbm(pos * np.array([2.5, 2.5, 0.9]) + 3, 3)
    back = mixc(srgb("#15181a"), srgb("#2a2f30"), sstep(-0.5, 0.6, mott))
    back = mixc(back, srgb("#1f2620"), 0.5 * sstep(0.2, 0.7, fbm(pos * 1.2 + 9, 2)))
    # The ribs only hinted at in the colour: the normal map carries their relief (strong stripes alias at a distance).
    belly = mixc(srgb("#8a8f86"), srgb("#a6ab9f"), mk["rib"])
    col = mixc(back, belly, sstep(0.15, 0.85, mk["under"]))
    col = mixc(col, col * 0.45, seg_groove(ts_))
    col = mixc(col, srgb("#101314"), mk["socket"] * 0.85)
    col = mixc(col, srgb("#cfe9dc"), mk["node"])
    # The root's folds darker in their creases; edges a little lighter; crevices dark (occlusion, curvature).
    col *= (0.62 + 0.38 * ao ** 1.3 + 0.25 * mk["under"] * (1 - ao ** 1.3))[..., None]
    col *= (1 + 0.15 * np.clip(cv, 0, 1) - 0.15 * np.clip(-cv, 0, 1))[..., None]
    color[sel[0], sel[1], :3] = col
    # What glows: the bulbs, and a faint line of light along the underside from node to node.
    line = np.exp(-(wrap(as_ + np.pi / 2) / 0.05) ** 2) * (1 - mk["node"]) * 0.18 * sstep(0.1, 0.14, ts_) * (1 - sstep(0.9, 0.95, ts_))
    color[sel[0], sel[1], 3] = np.clip(mk["node"] + line, 0, 1)
    # Wet: a soft sheen on the back (not glass), duller on the belly, glassy bulbs, dull deep in the folds.
    rough = 0.4 + 0.15 * mk["under"] - 0.2 * mk["node"] + 0.3 * (1 - ao) + 0.08 * mott
    orm[sel[0], sel[1]] = np.stack([ao, np.clip(rough, 0.12, 0.9), np.zeros_like(ao), np.clip(tm["thin"][sel], 0, 1)], -1)
# The root-hairs: dark, glossy, faint lengthwise striations, thinner and paler towards their ends.
hs = (U >= HAIRS[0] - PAD * 0.6) & (V < 0.5)
hw = np.clip((U - HAIRS[0]) / (HAIRS[1] - HAIRS[0]), 0, 1)
hf = np.clip((V - HAIR_V[0]) / (HAIR_V[1] - HAIR_V[0]), 0, 1)
stri = 0.5 + 0.5 * np.sin(hw * 2 * np.pi * 9 + 2 * perlin(np.stack([hw * 6, hf * 30, hw * 0], -1)))
hcol = mixc(srgb("#141716"), srgb("#3d433f"), hf * 0.8)
hcol *= (0.8 + 0.25 * stri)[..., None]
color[hs, :3] = hcol[hs]
color[hs, 3] = 0.0
hn = height_normal(stri * 0.6, 1.5)
normal[hs] = hn[hs]
orm[hs] = np.stack([np.full(hs.sum(), 0.9), np.full(hs.sum(), 0.4), np.zeros(hs.sum()), 0.6 + 0.4 * hf[hs]], -1)
# The frill: a dark membrane with stiff rays fanning up from its base, paler and thin at its ragged edge (the sun
# glows through it from behind); across is up the frill (base 0 .. edge 1), down the column is along the limb.
fs = (U >= HAIRS[0] - PAD * 0.6) & (V >= 0.5)
fu_ = np.clip((U - HAIRS[0]) / (HAIRS[1] - HAIRS[0]), 0, 1)
fv_ = np.clip((V - FRILL_V[0]) / (FRILL_V[1] - FRILL_V[0]), 0, 1)
rays = (0.5 + 0.5 * np.cos(2 * np.pi * (fv_ * 110 + 0.4 * perlin(np.stack([fu_ * 3, fv_ * 40, fu_ * 0 + 9], -1))))) ** 3
fcol = mixc(srgb("#121514"), srgb("#3e4640"), fu_ ** 1.5)
fcol = mixc(fcol, srgb("#5b625a"), rays * 0.5)
color[fs, :3] = fcol[fs]
color[fs, 3] = 0.0
fn = height_normal(rays * 0.8, 1.5)
normal[fs] = fn[fs]
orm[fs] = np.stack([np.full(fs.sum(), 0.95), (0.45 - 0.1 * rays)[fs], np.zeros(fs.sum()), (0.5 + 0.5 * fu_)[fs]], -1)
maps["tendril"].update(color=color, normal=normal, orm=orm)

# --- the body's maps: the core
bm = maps["body"]
color = np.zeros((H, W, 4))
orm = np.zeros((H, W, 4))
orm[..., 0] = 1
orm[..., 1] = 0.6
orm[..., 3] = 0.2
normal = bm["normal"].copy()
curv = curvature(normal)
csel = np.nonzero(V <= CORE_V[1] + PAD * 0.6)
s_ = np.clip((V[csel] - CORE_V[0]) / (CORE_V[1] - CORE_V[0]), 0, 1)
ph_ = 2 * np.pi * np.clip((U[csel] - PAD) / (1 - 2 * PAD), 0, 1)
th_, rs_, in_ = core_profile(s_)
_, mk = core_shape(th_, ph_, in_, s_, True)
d_ = core_dirs(th_, ph_)
ao = bm["ao"][csel]
cv = curv[csel]
grainc = fbm(d_ * np.array([30.0, 30.0, 7.0]) + 4, 3)
bark = mixc(srgb("#2c2621"), srgb("#55493c"), sstep(-0.4, 0.6, grainc))
bark = mixc(bark, srgb("#2b2c26"), 0.4 * sstep(0.0, 0.6, fbm(d_ * 2 + 1, 2)))
stone = mixc(srgb("#4a545a"), srgb("#76838a"), sstep(-0.5, 0.7, fbm(d_ * 5 + 2, 3)))
outside = mixc(bark, stone, mk["stone"])
outside = mixc(outside, srgb("#40382e"), 0.35 * mk["root"])
hollow = mixc(srgb("#3a4644"), srgb("#71837c"), sstep(-0.4, 0.6, fbm(d_ * 4 + 6, 3)))
hollow = mixc(hollow, srgb("#c4e6d4"), mk["vein"])
col = mixc(outside, hollow, sstep(0.2, 0.8, in_))
col *= (0.45 + 0.55 * ao ** 1.4)[..., None]
col *= (1 + 0.25 * np.clip(cv, 0, 1) - 0.25 * np.clip(-cv, 0, 1))[..., None]
color[csel[0], csel[1], :3] = col
# What glows: the hollow's veins brightly, its wall faintly, and the inner edge of the lips.
glow = mk["vein"] + 0.22 * sstep(0.5, 1.0, in_) + 0.35 * sstep(0.62, 0.72, s_) * (1 - sstep(0.72, 0.8, s_))
color[csel[0], csel[1], 3] = np.clip(glow * ao, 0, 1)
rough = np.where(mk["stone"] > 0.5, 0.3, 0.62) + 0.25 * (1 - ao) - 0.15 * in_
orm[csel[0], csel[1]] = np.stack([ao, np.clip(rough, 0.15, 0.95), np.zeros_like(ao), np.clip(bm["thin"][csel], 0, 1)], -1)

# --- the heart: the husk's colour, its membrane (what glows) between dark veins
hsel = np.nonzero((V >= LOW_V[0] - PAD * 0.6) & (U <= HEART_U[1] + PAD * 0.6))
a_ = 2 * np.pi * np.clip((U[hsel] - HEART_U[0]) / (HEART_U[1] - HEART_U[0]), 0, 1)
s_ = 1 - np.clip((V[hsel] - LOW_V[0]) / (LOW_V[1] - LOW_V[0]), 0, 1)
_, main, minor = heart_shape(s_, a_)
vein = heart_veins(s_, a_)
rib = np.clip(main * 1.0 + minor * 0.6, 0, 1) * sstep(0.04, 0.2, s_) * sstep(0.98, 0.85, s_)
membrane = (1 - vein) * (1 - 0.75 * rib)
hp = heart_point(s_, a_, 0.0)
mottle = fbm(hp * 18, 3)
col = mixc(srgb("#d8e6c4"), srgb("#f2f6e0"), sstep(-0.4, 0.6, mottle))
col = mixc(col, srgb("#4f5634"), vein)
col = mixc(col, srgb("#8d9468"), rib * 0.8)
color[hsel[0], hsel[1], :3] = col * bm["ao"][hsel][..., None] ** 0.5
color[hsel[0], hsel[1], 3] = np.clip(membrane * (0.75 + 0.25 * mottle), 0, 1)
orm[hsel[0], hsel[1]] = np.stack([bm["ao"][hsel], np.full(len(s_), 0.45), np.zeros(len(s_)), np.clip(membrane, 0, 1)], -1)

# --- the leaves: oak, beech, birch, alder, side by side; A is the outline
LEAVES = [
    ("oak", "#8c5f31", "#5a3a1c", "#b0844a"),
    ("beech", "#a5532a", "#6d3317", "#c9803c"),
    ("birch", "#c7a13a", "#7a5426", "#e0c25a"),
    ("alder", "#55522c", "#33301b", "#77703d"),
]
lsel_all = (V >= LOW_V[0] - PAD * 0.6) & (U >= 0.5)
for k, (kind, base_h, dark_h, light_h) in enumerate(LEAVES):
    u0 = 0.5 + k * LEAF_W + PAD
    u1 = 0.5 + (k + 1) * LEAF_W - PAD
    cell = lsel_all & (U >= u0 - PAD * 0.9) & (U < u1 + PAD * 0.9)
    sel = np.nonzero(cell)
    x = (U[sel] - u0) / (u1 - u0) * 2 - 1
    y = (LOW_V[1] - V[sel]) / (LOW_V[1] - LOW_V[0]) * 1.12 - 0.12
    yn = np.clip(y, 0, 1)
    if kind == "oak":
        wdt = 0.62 * np.sin(np.pi * yn) ** 0.55 * (1 - 0.2 * yn) * (0.6 + 0.4 * np.abs(np.cos(np.pi * (yn * 4.3 + 0.1))) ** 0.6)
        nveins, slope = 5, 0.5
    elif kind == "beech":
        wdt = 0.6 * np.sin(np.pi * yn ** 0.85) ** 0.7 * (1 + 0.035 * np.sin(yn * 44))
        nveins, slope = 8, 0.65
    elif kind == "birch":
        wdt = 1.6 * yn ** 0.5 * (1 - yn) ** 0.9 * (1 + 0.05 * np.abs(np.sin(yn * 52)) - 0.03 * np.abs(np.sin(yn * 104)))
        nveins, slope = 7, 0.55
    else:
        wdt = 0.66 * np.sin(np.pi * yn ** 0.72) ** 0.5 * (1 - 0.3 * np.exp(-((yn - 1) / 0.07) ** 2)) * (1 + 0.025 * np.sin(yn * 60))
        nveins, slope = 7, 0.45
    blade = (y >= 0) & (np.abs(x) < wdt)
    stem = (y < 0.02) & (np.abs(x) < 0.035)
    alpha = (blade | stem).astype(float)
    # Veins: the midrib, lateral veins from it towards the tip, fine ones between.
    midrib = np.exp(-(x / (0.035 * (1.2 - yn))) ** 2)
    lat = np.cos(2 * np.pi * (yn - np.abs(x) * slope) * nveins)
    lateral = sstep(0.9, 0.99, lat) * sstep(0.02, 0.08, np.abs(x)) * (np.abs(x) < wdt * 0.95)
    fine = 0.4 * sstep(0.06, 0.0, voronoi_edge(x * 9 + 20, yn * 16, 1000, 31 + k))
    height = 0.9 * midrib + 0.5 * lateral + 0.15 * fine
    pl = np.stack([x * 3, yn * 3, np.full_like(x, k * 5.0)], -1)
    spots = sstep(0.35, 0.6, fbm(pl * 2.5, 3))
    col = mixc(srgb(base_h), srgb(light_h), sstep(-0.5, 0.6, fbm(pl, 3)))
    col = mixc(col, srgb(dark_h), 0.65 * spots + 0.5 * sstep(0.75, 1.0, np.abs(x) / np.maximum(wdt, 1e-3)))
    col = mixc(col, srgb(light_h), 0.5 * (midrib + lateral * 0.6))
    col = np.where(stem[..., None] & ~blade[..., None], srgb(dark_h), col)
    color[sel[0], sel[1], :3] = col
    color[sel[0], sel[1], 3] = alpha
    hgt = np.zeros((H, W))
    hgt[sel] = height
    nn = height_normal(hgt, 1.2)
    normal[sel] = nn[sel]
    orm[sel[0], sel[1]] = np.stack([1 - 0.25 * lateral, 0.65 + 0.1 * spots, np.zeros_like(x), np.full_like(x, 1.0)], -1)
maps["body"].update(color=color, normal=normal, orm=orm)

# Alpha that carries data (what glows, how thin) is stored as 0.5 + 0.5 * value: WebP's encoder throws away the colour
# under fully transparent pixels (and browsers may lose precision under a faint alpha), so no pixel the game reads is
# ever transparent. The game reads it back as (a - 0.5) * 2. Only the leaves keep a real outline (0 or 1).
for set_name in ("tendril", "body"):
    for kind in ("color", "orm"):
        a = maps[set_name][kind][..., 3]
        enc = 0.5 + 0.5 * np.clip(a, 0, 1)
        if set_name == "body" and kind == "color":
            enc = np.where(lsel_all, a, enc)
        maps[set_name][kind][..., 3] = enc


# ---------------------------------------------------------------------------------------------- write
def half(img):
    return (img[0::2, 0::2] + img[1::2, 0::2] + img[0::2, 1::2] + img[1::2, 1::2]) / 4


def write(path, rgba, colour, fmt):
    """An image file of `rgba` (rows top first; linear values, sRGB-encoded here if `colour`)."""
    h, w, c = rgba.shape
    data = np.ones((h, w, 4))
    data[..., :c] = rgba
    if colour:
        data[..., :3] = to_srgb(data[..., :3])
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=c == 4)
    img.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    img.pixels.foreach_set(np.flipud(np.clip(data, 0, 1)).astype(np.float32).reshape(-1))
    img.file_format = fmt
    img.filepath_raw = path
    if fmt == "WEBP":
        img.save(quality=95)
    else:
        img.save()
    bpy.data.images.remove(img)


def encoder():
    """basisu (WASI), as tools/ktx2.py fetches it: tools/.bin/basisu/, checked against its SHA-256."""
    path = os.path.join(ROOT, "tools", ".bin", "basisu", "basisu_st.wasm")
    sha = "7b8837e020e48239ab3085697a16334649c07ef121f5a6556d8b17919938a143"
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        url = "https://raw.githubusercontent.com/BinomialLLC/basis_universal/v2_1_0r/bin/basisu_st.wasm"
        log("fetching", url)
        with urllib.request.urlopen(url) as r:
            data = r.read()
        if hashlib.sha256(data).hexdigest() != sha:
            sys.exit("basisu_st.wasm: unexpected SHA-256, not using it")
        with open(path, "wb") as f:
            f.write(data)
    with open(path, "rb") as f:
        if hashlib.sha256(f.read()).hexdigest() != sha:
            sys.exit(f"{path}: unexpected SHA-256; delete it to fetch it again")
    return path


# How each kind of map is compressed for the graphics chip (as tools/ktx2.py: ETC1S for colours and the packed
# map, UASTC for normals), laid out as glTF's UVs: not flipped.
KTX2_MODES = {
    "color": ["-etc1s", "-quality", "90"],
    "orm": ["-etc1s", "-linear", "-quality", "80"],
    # The tendrils' relief is what shows at fight distance: UASTC, with strong rate-distortion (smaller to fetch).
    "tendril_normal": ["-uastc", "-uastc_level", "2", "-uastc_rdo_l", "16", "-normal_map", "-mip_renorm", "-ktx2_zstandard_level", "18"],
    # The body's hardly shows (the core lies in the mist, the heart lights itself): ETC1S, as the game's noisy normals.
    "body_normal": ["-etc1s", "-quality", "160", "-normal_map", "-mip_renorm"],
}


def ktx2(wasm, png, dst, kind):
    folder = os.path.dirname(png)
    args = KTX2_MODES[kind] + ["-ktx2", "-mipmap", "-file", os.path.basename(png), "-output_file", "out.ktx2"]
    run = subprocess.run(["node", "--no-warnings", os.path.join(ROOT, "tools", "basisu.mjs"), wasm, folder, *args], capture_output=True, text=True)
    out = os.path.join(folder, "out.ktx2")
    if run.returncode != 0 or not os.path.exists(out):
        sys.exit(f"{png}: basisu failed\n{run.stdout[-2000:]}\n{run.stderr[-2000:]}")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.move(out, dst)


log("writing the maps")
wasm = encoder() if KTX2 else None
written = []
# What this tool wrote before (older layouts too) goes first, so only what it writes now is left.
for folder in (MAPS, os.path.join(MAPS, "half"), os.path.join(MAPS, "ktx2"), os.path.join(MAPS, "ktx2", "half")):
    for f in os.listdir(folder) if os.path.isdir(folder) else []:
        if f.split("_")[0] in ("body", "tendril"):
            os.unlink(os.path.join(folder, f))
with tempfile.TemporaryDirectory(prefix="spirit-") as tmp:
    for set_name, m in maps.items():
        for kind in ("color", "normal", "orm"):
            img = m[kind]
            for sub, pic in (("", img), ("half", half(img))):
                if kind == "normal":
                    n = pic * 2 - 1
                    pic = n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6) * 0.5 + 0.5
                name = f"{set_name}_{kind}"
                # WebP only at 1024: the fallback where KTX2 can't be transcoded (world/spiritSkin.ts).
                if sub:
                    webp = os.path.join(MAPS, name + ".webp")
                    os.makedirs(os.path.dirname(webp), exist_ok=True)
                    write(webp, pic, kind == "color", "WEBP")
                    written.append(webp)
                if KTX2:
                    png = os.path.join(tmp, name + ".png")
                    write(png, pic, kind == "color", "PNG")
                    dst = os.path.join(MAPS, "ktx2", sub, name + ".ktx2")
                    ktx2(wasm, png, dst, name if name in KTX2_MODES else kind)
                    os.unlink(png)
                    written.append(dst)
                if PREVIEW and not sub:
                    os.makedirs(PREVIEW, exist_ok=True)
                    write(os.path.join(PREVIEW, name + ".png"), pic, kind == "color", "PNG")
            log("written", set_name, kind)
for p in written:
    print(f"  {os.path.relpath(p, ROOT)}: {os.path.getsize(p) / 1024:.0f} KB")

# ---------------------------------------------------------------------------------------------- export
for o in (bake_tendril, hi_tendril, hi_core, hi_heart):
    bpy.data.objects.remove(o)
arms_json = json.dumps([{k: ([round(float(c), 5) for c in v] if isinstance(v, np.ndarray) else round(v, 5)) for k, v in a.items()} for a in ARMS])
for o in objs:
    if o.name.startswith("Tendrils"):
        o["arms"] = arms_json
total = {}
for o in objs:
    o.data.calc_loop_triangles()
    n = len(o.data.loop_triangles)
    k = "far" if o.name.endswith("Far") else "near"
    total[k] = total.get(k, 0) + n
    print(f"{o.name}: {n} triangles")
print(f"near {total['near']} triangles, far {total['far']}")

bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=False, export_yup=True,
                          export_texcoords=True, export_normals=True, export_tangents=True, export_materials="EXPORT",
                          export_vertex_color="NONE", export_attributes=False, export_extras=True, export_cameras=False,
                          export_lights=False)
log(f"brook spirit: {os.path.getsize(OUT)} bytes")
