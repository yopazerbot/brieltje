"""Build the tree huts in the wood round the café Sparrenhof in Blender: shooting bases for the Zombies game.

Run (Blender 5, no window), from the project root:
  blender -b -P tools/tree_huts.py -- <out.glb> [preview_dir]

Yoshi, 8 Nov 2026: "think about having some tree huts in the woods around the sparrenhof as shooting bases, make sure
they look great". Four huts of our own design (made up), among the spruces 20 to 45 m from the café, each built
against or between real trees of the wood (the village data's trees, found by their place):
- the lookout, the highest (5 m): a closed hut with a porch towards the café, a jib with a pulley and a bucket on a
  rope; up a stair in two flights round a landing;
- the long deck between two spruces (3.8 m), with a half-open shelter at one end; a stair with a turn;
- the north platform (3.2 m), open, with a bench; one straight flight with a rope along its rail;
- the west hut (4.2 m), smaller, closed, with a porch; a stair with a turn.
Weathered sawn timber: deck boards, joists and beams, balusters, board-and-batten walls, plank roofs; the beams
that carry a platform clasp the trunk and are bolted through it, with knee braces down to the trunk and to posts on
concrete footings. Real steps (a rise of at most 18.5 cm, a going of 25 cm), as the café's steel stairs, so the zombies
climb them too (slowly, one by one: shared/zombies.mjs). No ladders.

Frame: the game's axes (x, y up, z), the origin on the ground at the café's origin (web/shared/sparrenhof.json), heights
above the ground there, as the café's; the relief under each post and stair foot is the game's own (web/shared/
terrain.json, the same surface the game draws). The trees' trunks are as the game draws them (world/cardTrees.ts).

Output:
- the GLB, one mesh per material: hut_planks, hut_timber and hut_roof take the game's floor_wood texture with a tint
  (glTF extras; no graphics memory of their own), UVs in metres along each board's grain and across on one of the
  texture's rows of planks; hut_fittings (bolts, plates, rope, footings) is coloured per vertex;
- web/shared/tree_huts.json: the blocks for walking into (heights above the café's origin's ground, as the café's),
  and per hut its floors and stairs, the box of the zombies' finer grid round it, its trees and its footprint (no
  undergrowth there; no zombie comes out within a few metres of it: shared/sparrenhof.mjs).
"""
import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rng = np.random.default_rng(8)


def load(*path):
    with open(os.path.join(ROOT, *path), encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- the ground and the trees, as the game has them
DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
TER = load("web", "shared", "terrain.json")


def decode(d, nx, nz):
    """web/shared/terrain.mjs decode: whole centimetres, what is left over after a guess, summed back."""
    value = {c: k for k, c in enumerate(DIGITS)}
    rest, k = [], 0
    while k < len(d):
        if d[k] == "~":
            rest.append((value[d[k + 1]] << 12 | value[d[k + 2]] << 6 | value[d[k + 3]]) - (1 << 17))
            k += 4
        else:
            rest.append(value[d[k]] - 32)
            k += 1
    return np.array(rest, np.int64).reshape(nz, nx).cumsum(1).cumsum(0) / 100


GRID = decode(TER["d"], TER["nx"], TER["nz"])


def terrain(x, z):
    """The relief at (x, z), the same two triangles per square as web/shared/terrain.mjs."""
    fx = min(max((x - TER["x0"]) / TER["step"], 0.0), TER["nx"] - 1.000001)
    fz = min(max((z - TER["z0"]) / TER["step"], 0.0), TER["nz"] - 1.000001)
    i, j = int(fx), int(fz)
    u, v = fx - i, fz - j
    h00, h11 = GRID[j, i], GRID[j + 1, i + 1]
    if u >= v:
        h10 = GRID[j, i + 1]
        return float(h00 + u * (h10 - h00) + v * (h11 - h10))
    h01 = GRID[j + 1, i]
    return float(h00 + v * (h01 - h00) + u * (h11 - h01))


CAFE = load("web", "shared", "sparrenhof.json")
ORIGIN = tuple(CAFE["origin"])
G0 = terrain(*ORIGIN)


def gy(x, z):
    """The ground at (x, z), metres above the ground at the café's origin."""
    return terrain(x, z) - G0


VILLAGE = load("web", "src", "data", "village.json")
TREES = VILLAGE["trees"]


def tree_at(x, z):
    t = min(TREES, key=lambda t: math.hypot(t["x"] - x, t["z"] - z))
    assert math.hypot(t["x"] - x, t["z"] - z) < 0.05, f"no tree at {x}, {z}"
    return t


def trunk_r(t, y):
    """A spruce's trunk's radius y m over its foot, as the game draws it (world/cardTrees.ts cardTrunk, its girth and
    length from world/surroundings.ts): 0.1 at the foot to 0.065 at the fork, times the girth."""
    girth = max(1.0, t["h"] / 6.5) * 0.85
    length = 0.4288 * t["h"] + 0.05
    f = min(max(y / length, 0.0), 1.0)
    return (0.1 - 0.035 * f) * (1 + 0.35 * (1 - f) ** 8) * girth


# ---------------------------------------------------------------- materials and meshes
bpy.ops.wm.read_factory_settings(use_empty=True)
TILE = 1.7                     # m: floor_wood's tile (web/public/textures/sizes.json)
ROW = TILE / 8                 # its eight rows of planks: a board's face lies inside one (seams at half rows)
# name: (shared game texture, tint, normal scale, mean colour of the result)
SHARED = {
    "hut_planks": ("floor_wood", "#c3c6c4", 0.9, "#8a8278"),   # deck boards, walls, balusters: weathered, silver-brown
    "hut_timber": ("floor_wood", "#a39d94", 1.0, "#6f675d"),   # posts, beams, joists, stringers: darker, damp
    "hut_roof": ("floor_wood", "#97a59a", 1.0, "#5e6359"),     # the roofs' planks: dark, greening
}


def srgb(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def principled(name, color, rough, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    m.use_backface_culling = True
    return m


M = {}
for name, (tex, tint, nscale, mean) in SHARED.items():
    M[name] = principled(name, srgb(mean), 0.9)
    M[name]["texture"], M[name]["tint"], M[name]["normalScale"] = tex, tint, nscale
M["hut_fittings"] = principled("hut_fittings", (1, 1, 1), 0.7)
nt = M["hut_fittings"].node_tree
attr = nt.nodes.new("ShaderNodeVertexColor")
attr.layer_name = "Color"
nt.links.new(attr.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
BM = {name: bmesh.new() for name in M}
UVL = {name: BM[name].loops.layers.uv.new("UVMap") for name in SHARED}
COL = BM["hut_fittings"].loops.layers.float_color.new("Color")

BOLT = "#55585a"        # galvanised bolt heads and washers, dulled
RUST = "#6b4a36"        # older iron
ROPE = "#a88f63"        # hemp
CONCRETE = "#8d8b84"
MOSS = "#5d6648"


def colour(h):
    return (*srgb(h), 1.0)


def to_b(p):
    """A game point (x, y up, z) in Blender's frame (z up), round the café's origin."""
    return Vector((p[0] - ORIGIN[0], -(p[2] - ORIGIN[1]), p[1]))


def poly(mat, pts, out, uvs=None, paint=None):
    """A planar face through game points, turned to face `out` (a game direction)."""
    bm = BM[mat]
    vs = [to_b(p) for p in pts]
    n = Vector((0, 0, 0))
    for i in range(len(vs)):
        n += vs[i].cross(vs[(i + 1) % len(vs)])
    if n.dot(Vector((out[0], -out[2], out[1]))) < 0:
        vs, uvs = vs[::-1], (uvs[::-1] if uvs else None)
    f = bm.faces.new([bm.verts.new(v) for v in vs])
    if uvs and mat in UVL:
        for lp, uv in zip(f.loops, uvs):
            lp[UVL[mat]].uv = uv
    if paint and mat == "hut_fittings":
        c = colour(paint)
        for lp in f.loops:
            lp[COL] = c


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


Y = np.array([0.0, 1.0, 0.0])


def board(mat, c, L, W, l, w, t, paint=None, row=None):
    """A sawn board or beam: middle c, its grain along L, its width along W (square to L), l long, w wide, t thick. Its
    UVs in metres along the grain from a random spot, across on one row of the texture's planks."""
    c, L = np.asarray(c, float), unit(L)
    W = unit(np.asarray(W, float) - L * np.dot(W, L))
    T = np.cross(L, W)
    row = int(rng.integers(0, 8)) if row is None else row
    shift = float(rng.uniform(0, TILE))
    vc = row * ROW

    def fit(x, size):
        return vc + x * min(1.0, 0.17 / max(size, 1e-6))

    P = lambda sl, sw, st: c + L * sl * l / 2 + W * sw * w / 2 + T * st * t / 2
    for st in (-1, 1):
        poly(mat, [P(-1, -1, st), P(1, -1, st), P(1, 1, st), P(-1, 1, st)], T * st,
             [(shift - l / 2, fit(-w / 2, w)), (shift + l / 2, fit(-w / 2, w)), (shift + l / 2, fit(w / 2, w)), (shift - l / 2, fit(w / 2, w))], paint)
    for sw in (-1, 1):
        poly(mat, [P(-1, sw, -1), P(1, sw, -1), P(1, sw, 1), P(-1, sw, 1)], W * sw,
             [(shift - l / 2, fit(-t / 2, t)), (shift + l / 2, fit(-t / 2, t)), (shift + l / 2, fit(t / 2, t)), (shift - l / 2, fit(t / 2, t))], paint)
    for sl in (-1, 1):
        poly(mat, [P(sl, -1, -1), P(sl, 1, -1), P(sl, 1, 1), P(sl, -1, 1)], L * sl,
             [(shift - w / 2, fit(-t / 2, t)), (shift + w / 2, fit(-t / 2, t)), (shift + w / 2, fit(t / 2, t)), (shift - w / 2, fit(t / 2, t))], paint)


def solid(pts, paint):
    """The convex solid round game points, coloured (the fittings)."""
    tmp = bmesh.new()
    for p in pts:
        tmp.verts.new(to_b(p))
    res = bmesh.ops.convex_hull(tmp, input=tmp.verts[:])
    dead = {g for g in res["geom_interior"] + res["geom_unused"] if isinstance(g, bmesh.types.BMVert)}
    bmesh.ops.delete(tmp, geom=list(dead), context="VERTS")
    bmesh.ops.dissolve_limit(tmp, angle_limit=math.radians(0.5), verts=tmp.verts[:], edges=tmp.edges[:])
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces[:])
    bm = BM["hut_fittings"]
    c = colour(paint)
    for f in tmp.faces:
        nf = bm.faces.new([bm.verts.new(v.co) for v in f.verts])
        for lp in nf.loops:
            lp[COL] = c
    tmp.free()


def rod(a, b, r, paint, seg=6):
    """A round bar from game point a to b."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = unit(b - a)
    u = unit(np.cross(d, [1, 0, 0] if abs(d[0]) < 0.9 else [0, 1, 0]))
    w = np.cross(d, u)
    pts = []
    for k in range(seg):
        t = 2 * math.pi * k / seg
        off = u * math.cos(t) * r + w * math.sin(t) * r
        pts += [a + off, b + off]
    solid(pts, paint)


def ring6(n, r):
    """Six points r round the axis n (offsets)."""
    u = unit(np.cross(n, [1, 0, 0] if abs(n[0]) < 0.9 else [0, 1, 0]))
    w = np.cross(n, u)
    return [u * math.cos(k * math.pi / 3) * r + w * math.sin(k * math.pi / 3) * r for k in range(6)]


def bolt(p, n, r=0.014):
    """A bolt's hex head with its washer at game point p, standing out along n: one six-sided solid, wider at the wood
    (twenty triangles: there are some hundreds of them)."""
    p, n = np.asarray(p, float), unit(n)
    solid([p + n * h + q for h, k in ((-0.002, 1.9), (0.02, 1.1)) for q in ring6(n, r * k)], BOLT)


blocks = []


def block(ring, y0, y1, m="oak"):
    """A block for walking into: an outline of game (x, z) points, heights above the café's origin's ground."""
    blocks.append({"m": m, "p": [[[round(float(x), 3), round(float(z), 3)] for x, z in ring]], "y0": round(float(y0), 3), "y1": round(float(y1), 3)})


# ---------------------------------------------------------------- a hut's frame: a and b on the plan, round its tree
RISE_MAX, GOING = 0.185, 0.25
STAIR_W = 0.9           # clear between a stair's rails
RAIL = 1.0              # a balustrade's top over its floor
TREAD, NOSE = 0.035, 0.03


class Hut:
    def __init__(self, name, tree, yaw, height, trees=()):
        self.name = name
        self.tree = tree_at(*tree)
        self.trees = [self.tree] + [tree_at(*t) for t in trees]
        self.T = (self.tree["x"], self.tree["z"])
        th = math.radians(yaw)
        self.ca, self.sa = math.cos(th), math.sin(th)
        self.A = np.array([self.ca, 0.0, self.sa])
        self.B = np.array([-self.sa, 0.0, self.ca])
        self.foot = gy(*self.T)                     # the ground at the tree
        self.F = self.foot + height                 # the platform's floor
        self.plan = []                              # every (a, b) it stands on: its footprint
        self.floors, self.stairs = [], []

    def xz(self, a, b):
        return (self.T[0] + a * self.ca - b * self.sa, self.T[1] + a * self.sa + b * self.ca)

    def p(self, a, b, y):
        x, z = self.xz(a, b)
        return np.array([x, y, z])

    def g(self, a, b):
        return gy(*self.xz(a, b))

    def local(self, x, z):
        dx, dz = x - self.T[0], z - self.T[1]
        return (dx * self.ca + dz * self.sa, -dx * self.sa + dz * self.ca)

    def d(self, da, db, dy=0.0):
        """A direction from one on the plan (a, b) and up."""
        return self.A * da + self.B * db + Y * dy

    # -- timber
    def lumber(self, mat, a0, a1, b0, b1, y0, y1, along=None, paint=None):
        """A board or beam square to the frame, between the given bounds; its grain along its longest side (or `along`:
        'a', 'b' or 'y')."""
        sizes = {"a": a1 - a0, "b": b1 - b0, "y": y1 - y0}
        along = along or max(sizes, key=sizes.get)
        axes = {"a": self.A, "b": self.B, "y": Y}
        rest = [k for k in "aby" if k != along]
        wide = max(rest, key=sizes.get)
        thin = [k for k in rest if k != wide][0]
        c = self.p((a0 + a1) / 2, (b0 + b1) / 2, (y0 + y1) / 2)
        board(mat, c, axes[along], axes[wide], sizes[along], sizes[wide], sizes[thin], paint)

    def beam(self, mat, a, b, w, h, paint=None):
        """A beam from (a, b, y) to (a, b, y): w across on the plan, h the other way."""
        pa, pb = self.p(*a), self.p(*b)
        L = unit(pb - pa)
        side = np.cross(L, Y)
        side = self.A if np.linalg.norm(side) < 1e-6 else unit(side)
        board(mat, (pa + pb) / 2, L, side, float(np.linalg.norm(pb - pa)), w, h, paint)

    def post(self, a, b, y0, y1, w=0.12, footing=True):
        self.lumber("hut_timber", a - w / 2, a + w / 2, b - w / 2, b + w / 2, y0, y1, along="y")
        self.plan.append((a, b))
        if footing:
            g = self.g(a, b)
            solid([self.p(a + sa * 0.17, b + sb * 0.17, g + y) for sa in (-1, 1) for sb in (-1, 1) for y in (-0.15, 0.12)], CONCRETE)
            for s in (-1, 1):                      # the steel shoe, bolted through
                c = self.p(a + s * (w / 2 + 0.004), b, g + 0.27)
                solid([c + self.A * s * da + self.B * db + Y * dy for da in (-0.003, 0.003) for db in (-0.05, 0.05) for dy in (-0.15, 0.15)], BOLT)
                bolt(self.p(a + s * (w / 2 + 0.008), b, g + 0.3), self.A * s, 0.011)
        self.block_box(a - w / 2, a + w / 2, b - w / 2, b + w / 2, -0.4 if footing else y0, y1, lift=footing)

    def block_box(self, a0, a1, b0, b1, y0, y1, lift=False, m="oak"):
        """A block for walking into on the frame's plan; `lift`: y0 under the ground at its middle."""
        if lift:
            y0 = self.g((a0 + a1) / 2, (b0 + b1) / 2) + y0
        block([self.xz(a0, b0), self.xz(a1, b0), self.xz(a1, b1), self.xz(a0, b1)], y0, y1, m)

    def rail_blocks(self, a, b, y, height=RAIL):
        """A railing's blocks along (a, b) a to b at floor y, in pieces of at most a metre, 12 cm thick (more than the
        10 cm a zombie's swipe is checked in), from just over the floor: nothing slips under it."""
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        m = max(1, math.ceil(L / 1.0))
        ta, tb = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        na, nb = -tb * 0.06, ta * 0.06
        for k in range(m):
            a0, b0 = a[0] + (b[0] - a[0]) * k / m, a[1] + (b[1] - a[1]) * k / m
            a1, b1 = a[0] + (b[0] - a[0]) * (k + 1) / m, a[1] + (b[1] - a[1]) * (k + 1) / m
            block([self.xz(a0 + na, b0 + nb), self.xz(a1 + na, b1 + nb), self.xz(a1 - na, b1 - nb), self.xz(a0 - na, b0 - nb)], y + 0.05, y + height)

    def balustrade(self, a, b, y, posts=(True, True), rope=False):
        """A railing on a floor's edge from (a, b) a to b at floor y: posts bolted to the rim at most 1.3 m apart, a flat
        handrail on top, a bottom rail and balusters 12 cm apart (children play here); `rope`: a hemp rope looped along
        under the handrail, for the look."""
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        ta, tb = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        n = max(1, math.ceil(L / 1.3))
        at = lambda f: (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
        for k in range(n + 1):
            if (k == 0 and not posts[0]) or (k == n and not posts[1]):
                continue
            pa, pb = at(k / n)
            self.lumber("hut_timber", pa - 0.045, pa + 0.045, pb - 0.045, pb + 0.045, y - 0.18, y + RAIL - 0.04, along="y")
            out = (tb, -ta)
            for dy in (-0.07, -0.13):
                bolt(self.p(pa + out[0] * 0.047, pb + out[1] * 0.047, y + dy), self.d(*out))
        mid = self.p((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, y + RAIL - 0.02)
        board("hut_planks", mid, self.d(ta, tb), self.d(-tb, ta), L + 0.1, 0.13, 0.04)            # the handrail, flat
        board("hut_timber", self.p((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, y + RAIL - 0.08), self.d(ta, tb), Y, L, 0.07, 0.045)
        board("hut_timber", self.p((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, y + 0.1), self.d(ta, tb), Y, L, 0.07, 0.045)
        k = 0.12
        while k < L - 0.06:
            pa, pb = at(k / L)
            if all(abs(k - L * j / n) > 0.07 for j in range(n + 1)):
                self.lumber("hut_planks", pa - 0.021 * abs(ta) - 0.011 * abs(tb), pa + 0.021 * abs(ta) + 0.011 * abs(tb),
                            pb - 0.021 * abs(tb) - 0.011 * abs(ta), pb + 0.021 * abs(tb) + 0.011 * abs(ta), y + 0.055, y + RAIL - 0.115, along="y")
            k += 0.12
        if rope:
            pts = [at(f) for f in np.linspace(0, 1, 9)]
            for (p0, q0), (p1, q1) in zip(pts, pts[1:]):
                rod(self.p(p0, q0, y + RAIL - 0.2), self.p((p0 + p1) / 2, (q0 + q1) / 2, y + RAIL - 0.27), 0.016, ROPE)
                rod(self.p((p0 + p1) / 2, (q0 + q1) / 2, y + RAIL - 0.27), self.p(p1, q1, y + RAIL - 0.2), 0.016, ROPE)
        self.rail_blocks(a, b, y)

    def deck(self, a0, a1, b0, b1, y, along="a", joists=True):
        """A floor of deck boards (14 cm, 8 mm apart) along `along` on joists the other way, 45 cm apart, in rims."""
        self.plan += [(a0, b0), (a1, b0), (a1, b1), (a0, b1)]
        T = 0.028
        if along == "a":
            b = b0
            while b < b1 - 0.01:
                bb = min(b + 0.14, b1)
                self.lumber("hut_planks", a0 - 0.02, a1 + 0.02, b, bb, y - T, y, along="a")
                b = bb + 0.008
        else:
            a = a0
            while a < a1 - 0.01:
                aa = min(a + 0.14, a1)
                self.lumber("hut_planks", a, aa, b0 - 0.02, b1 + 0.02, y - T, y, along="b")
                a = aa + 0.008
        if joists:
            J = 0.15
            if along == "a":
                n = max(2, math.ceil((a1 - a0) / 0.45))
                for k in range(n + 1):
                    a = a0 + 0.025 + (a1 - a0 - 0.05) * k / n
                    self.lumber("hut_timber", a - 0.025, a + 0.025, b0 + 0.05, b1 - 0.05, y - T - J, y - T, along="b")
                for b in (b0 + 0.025, b1 - 0.025):
                    self.lumber("hut_timber", a0, a1, b - 0.025, b + 0.025, y - T - J, y - T, along="a")
            else:
                n = max(2, math.ceil((b1 - b0) / 0.45))
                for k in range(n + 1):
                    b = b0 + 0.025 + (b1 - b0 - 0.05) * k / n
                    self.lumber("hut_timber", a0 + 0.05, a1 - 0.05, b - 0.025, b + 0.025, y - T - J, y - T, along="a")
                for a in (a0 + 0.025, a1 - 0.025):
                    self.lumber("hut_timber", a - 0.025, a + 0.025, b0, b1, y - T - J, y - T, along="b")
        self.block_box(a0, a1, b0, b1, y - 0.12, y)

    def clasp(self, tree, a, b, y, along, length, outer=1.3):
        """Two beams clasping a trunk at (a, b) on either side, bolted through it: the one on the platform's side
        `length` long, the other `outer`; their top at y. `along`: 'a' or 'b', the beams' direction."""
        r = trunk_r(tree, y - 0.11 - gy(tree["x"], tree["z"])) * 0.97
        for s, ln in ((1, length), (-1, outer)):
            if along == "a":
                self.lumber("hut_timber", a - ln / 2, a + ln / 2, b + s * r, b + s * (r + 0.075), y - 0.24, y, along="a")
                for da in (-0.16, 0.16):
                    for dy in (-0.07, -0.17):
                        bolt(self.p(a + da, b + s * (r + 0.075), y + dy), self.B * s)
            else:
                self.lumber("hut_timber", a + s * r, a + s * (r + 0.075), b - ln / 2, b + ln / 2, y - 0.24, y, along="b")
                for db in (-0.16, 0.16):
                    for dy in (-0.07, -0.17):
                        bolt(self.p(a + s * (r + 0.075), b + db, y + dy), self.A * s)
        return r

    def trunk_brace(self, tree, a, b, y_trunk, to, w=0.075, h=0.1):
        """A knee brace from a cleat bolted on the trunk at height y_trunk, towards the point `to` (a, b, y)."""
        ta, tb = tree
        da, db = to[0] - ta, to[1] - tb
        n = math.hypot(da, db)
        r = trunk_r(self.tree, y_trunk - self.foot) * 0.95
        sa, sb = ta + da / n * r, tb + db / n * r
        self.lumber("hut_timber", sa - 0.06 * abs(db / n) - 0.035 * abs(da / n), sa + 0.06 * abs(db / n) + 0.035 * abs(da / n),
                    sb - 0.06 * abs(da / n) - 0.035 * abs(db / n), sb + 0.06 * abs(da / n) + 0.035 * abs(db / n), y_trunk - 0.12, y_trunk + 0.1, along="y")
        for dy in (-0.06, 0.05):
            bolt(self.p(sa + da / n * 0.037, sb + db / n * 0.037, y_trunk + dy), self.d(da / n, db / n))
        self.beam("hut_timber", (sa + da / n * 0.03, sb + db / n * 0.03, y_trunk), to, w, h)

    # -- stairs
    def flight(self, top_at, t, top, base, n, rope=False, rails=(True, True)):
        """A straight timber stair climbing along t (a unit plan direction) to its top riser on the centreline at
        top_at, n risers from `base` up to `top`: two stringers, treads of two planks with their nosing, handrail
        posts on the stringers, a handrail and a knee rail (or a rope through eyes, `rope`). Returns its first riser."""
        G = GOING
        rise = (top - base) / n
        run = (n - 1) * G
        F = (top_at[0] - t[0] * run, top_at[1] - t[1] * run)
        w = STAIR_W / 2
        at = lambda s, x: (F[0] + t[0] * s - t[1] * x, F[1] + t[1] * s + t[0] * x)
        ring = lambda s0, s1, x0, x1: [self.xz(*at(s0, x0)), self.xz(*at(s1, x0)), self.xz(*at(s1, x1)), self.xz(*at(s0, x1))]
        nose = lambda s: base + rise + s * rise / G
        L = self.d(*t)
        across = self.d(-t[1], t[0])
        for k in range(1, n):
            y = base + k * rise
            s0, s1 = (k - 1) * G, k * G
            for (p0, p1) in ((s0 - NOSE, s0 + 0.12), (s0 + 0.13, s1)):
                c = self.p(*at((p0 + p1) / 2, 0), y - TREAD / 2)
                board("hut_planks", c, across, L, STAIR_W + 0.04, p1 - p0, TREAD)
            block(ring(s0, s1, -w, w), y - 0.06, y, "oak")
            for side in (-1, 1):
                block(ring(s0, s1, side * w, side * (w + 0.12)), y + 0.05, y + 0.95, "oak")
        for side in (-1, 1):
            x = side * (w + 0.03)
            sa, sb = -0.3, run + 0.02
            pa, pb = self.p(*at(sa, x), nose(sa) - 0.14), self.p(*at(sb, x), nose(sb) - 0.14)
            board("hut_timber", (pa + pb) / 2, unit(pb - pa), across, float(np.linalg.norm(pb - pa)), 0.05, 0.25)
            for k in range(1, n, 3):                                       # the treads' screws, a row on the stringer
                bolt(self.p(*at((k - 0.5) * G, x + side * 0.026), base + k * rise - 0.07), across * side, 0.009)
            if not rails[(side + 1) // 2]:
                continue
            xr = side * (w + 0.1)
            ss = [0.0] + [k * G for k in range(4, n - 2, 4)] + [run]
            for s in ss:
                c = at(s, xr)
                self.lumber("hut_timber", c[0] - 0.035, c[0] + 0.035, c[1] - 0.035, c[1] + 0.035, nose(s) - 0.3, nose(s) + 0.92, along="y")
                bolt(self.p(*at(s, xr + side * 0.036), nose(s) - 0.2), across * side)
            p0, p1 = self.p(*at(-0.1, xr), nose(-0.1) + 0.9), self.p(*at(run + 0.05, xr), nose(run + 0.05) + 0.9)
            if rope and side == 1:
                for s in ss:
                    rod(self.p(*at(s, xr), nose(s) + 0.86), self.p(*at(s, xr - side * 0.06), nose(s) + 0.86), 0.012, RUST)
                m = (p0 + p1) / 2 - Y * 0.04
                rod(p0 - Y * 0.04, m - Y * 0.03, 0.019, ROPE)
                rod(m - Y * 0.03, p1 - Y * 0.04, 0.019, ROPE)
            else:
                board("hut_planks", (p0 + p1) / 2, unit(p1 - p0), across, float(np.linalg.norm(p1 - p0)), 0.09, 0.045)
            q0, q1 = self.p(*at(0.0, xr), nose(0.0) + 0.45), self.p(*at(run, xr), nose(run) + 0.45)
            board("hut_timber", (q0 + q1) / 2, unit(q1 - q0), Y, float(np.linalg.norm(q1 - q0)), 0.07, 0.04)
        for s in (-0.3, run):
            self.plan += [at(s, -w - 0.15), at(s, w + 0.15)]
        return F, rise

    def stair(self, name, top_at, down, turn=None, side=1, rope=False):
        """From the platform's edge at top_at (a, b) down along `down` to the ground: one flight, or two with a landing:
        turn 'L' (the lower flight turns to the side `side` of the way down: +1 left, -1 right) or 'U' (back beside the
        upper one, on that side). The ground at the foot decides the count of risers; a few rounds settle it."""
        down = unit(down)
        left = np.array([-down[1], down[0]]) * side
        top_at = np.asarray(top_at, float)
        N = 20
        LW = STAIR_W + 0.3                                     # a landing's side
        for _ in range(4):
            if turn is None:
                n1, n2 = N, 0
                foot = top_at + down * ((n1 - 1) * GOING + 0.4)
                F1 = top_at + down * (n1 - 1) * GOING
                foot_g = self.g(*F1) + 0.03
            else:
                n1 = N - N // 2
                n2 = N // 2
                F1 = top_at + down * (n1 - 1) * GOING
                if turn == "U":
                    top2 = F1 + left * (STAIR_W + 0.32)
                    t2 = down
                else:
                    top2 = F1 + down * (LW / 2) + left * (LW / 2)
                    t2 = -left
                F2 = top2 - t2 * (n2 - 1) * GOING
                foot_g = self.g(*F2) + 0.03
            N = math.ceil((self.F - foot_g) / RISE_MAX)
        rise = (self.F - foot_g) / N
        if turn is None:
            F, _ = self.flight(top_at, -down, self.F, foot_g, N, rope=rope)
            foot = np.asarray(F) + down * 0.7
            top = [*self.xz(*(top_at - down * 0.5)), self.F]
            self.stairs.append({"id": f"{self.name}-{name}", "foot": [*self.xz(*foot), foot_g - 0.03], "top": top,
                                "risers": N, "rise": rise, "going": GOING, "path": [[*self.xz(*foot), foot_g - 0.03], top]})
            return
        land = foot_g + n2 * rise
        self.flight(top_at, -down, self.F, land, n1, rope=rope)
        F2, _ = self.flight(top2, t2, land, foot_g, n2, rope=rope)
        # The landing: square past the upper flight (and beside, for a U), on four posts.
        c0 = F1
        if turn == "U":
            corners = [c0 - left * (STAIR_W / 2 + 0.12), c0 + down * LW - left * (STAIR_W / 2 + 0.12),
                       c0 + down * LW + left * (STAIR_W * 1.5 + 0.44), c0 + left * (STAIR_W * 1.5 + 0.44)]
        else:
            corners = [c0 - left * (LW / 2), c0 + down * LW - left * (LW / 2), c0 + down * LW + left * (LW / 2), c0 + left * (LW / 2)]
        a0, a1 = min(p[0] for p in corners), max(p[0] for p in corners)
        b0, b1 = min(p[1] for p in corners), max(p[1] for p in corners)
        self.deck(a0, a1, b0, b1, land, along="a" if abs(down[1]) > 0.5 else "b")
        for (pa, pb) in ((a0 + 0.06, b0 + 0.06), (a1 - 0.06, b0 + 0.06), (a1 - 0.06, b1 - 0.06), (a0 + 0.06, b1 - 0.06)):
            self.post(pa, pb, self.g(pa, pb) - 0.15, land - 0.03, 0.1)
        for (pa, pb), (qa, qb) in (((a0 + 0.06, b0 + 0.06), (a1 - 0.06, b0 + 0.06)), ((a0 + 0.06, b1 - 0.06), (a1 - 0.06, b1 - 0.06))):
            ya = max(self.g(pa, pb), self.g(qa, qb)) + 0.4
            if land - ya > 0.9:                                              # a diagonal across its legs
                self.beam("hut_timber", (pa, pb, ya), (qa, qb, land - 0.25), 0.05, 0.1)
        # Its railing on the far side, and on the side no flight uses.
        if turn == "U":
            r0, r1 = -(STAIR_W / 2 + 0.12), STAIR_W * 1.5 + 0.44
            self.balustrade(tuple(c0 + down * LW + left * r0), tuple(c0 + down * LW + left * r1), land)
            self.balustrade(tuple(c0 + left * r0), tuple(c0 + down * LW + left * r0), land, posts=(False, False))
            self.balustrade(tuple(c0 + left * r1), tuple(c0 + down * LW + left * r1), land, posts=(False, False))
        else:
            self.balustrade(tuple(c0 + down * LW - left * (LW / 2)), tuple(c0 + down * LW + left * (LW / 2)), land)
            self.balustrade(tuple(c0 - left * (LW / 2)), tuple(c0 + down * LW - left * (LW / 2)), land, posts=(False, False))
        foot = np.asarray(F2) - t2 * 0.7
        self.floors.append([*self.xz(*(c0 + down * LW / 2 + (left * (STAIR_W / 2 + 0.16) if turn == "U" else 0))), land])
        # The way up, for walking it in a check: the foot, onto the landing, round to the upper flight, the platform.
        on = [top2 - t2 * 0.35] + ([c0 + down * LW / 2] if turn == "L" else []) + [c0 + down * 0.35]
        path = [[*self.xz(*foot), foot_g - 0.03]] + [[*self.xz(*q), land] for q in on] + [[*self.xz(*(top_at - down * 0.5)), self.F]]
        self.stairs.append({"id": f"{self.name}-{name}", "foot": path[0], "top": path[-1],
                            "risers": N, "rise": rise, "going": GOING, "landing": land, "path": path})

    # -- the hut on the platform
    def walls(self, a0, a1, b0, b1, y, front, back, door, windows, parts=None):
        """A hut of board-and-batten walls on the floor y from (a0, b0) to (a1, b1): `front` m high at b1, `back` at b0
        (a roof falling to the back); `door`: (a, width) in the front wall, or None; `windows`: (wall, at, width) with
        wall 'front' or 'back' (at: a) or 'left' (a0) or 'right' (a1) (at: b), each a shuttered opening from 1.0 to
        1.45 m over the floor. `parts`: {wall: (from, to)} a share of a wall's length only (None: none of it)."""
        top = lambda b: y + back + (front - back) * (b - b0) / (b1 - b0)
        SILL, HEAD = 1.0, 1.45
        parts = parts or {}
        sides = {
            "front": ((a0, b1), (1, 0), a1 - a0, (0, 1)), "back": ((a0, b0), (1, 0), a1 - a0, (0, -1)),
            "left": ((a0, b0), (0, 1), b1 - b0, (-1, 0)), "right": ((a1, b0), (0, 1), b1 - b0, (1, 0)),
        }
        # The frame: corner posts, as far as the walls go.
        for a, b in ((a0, b0), (a1, b0), (a1, b1), (a0, b1)):
            self.lumber("hut_timber", a - 0.045 + (0.045 if a == a0 else -0.045), a + 0.045 + (0.045 if a == a0 else -0.045),
                        b - 0.045 + (0.045 if b == b0 else -0.045), b + 0.045 + (0.045 if b == b0 else -0.045), y, top(b), along="y")
        holes = {"front": [], "back": [], "left": [], "right": []}
        if door:
            holes["front"].append((door[0] - a0 - door[1] / 2, door[0] - a0 + door[1] / 2, y, y + 1.95))
        for wall, s, wd in windows:
            s -= a0 if wall in ("front", "back") else b0
            holes[wall].append((s - wd / 2, s + wd / 2, y + SILL, y + HEAD))
        for wall, (o, t, L0, out) in sides.items():
            span = parts.get(wall, (0.0, 1.0))
            if span is None:
                continue
            L = L0 * span[1]
            o = (o[0] + t[0] * L0 * span[0], o[1] + t[1] * L0 * span[0])
            L -= L0 * span[0]
            if span != (0.0, 1.0):                             # a post where a part wall stops
                e = (o[0] + t[0] * L, o[1] + t[1] * L)
                self.lumber("hut_timber", e[0] - 0.045, e[0] + 0.045, e[1] - 0.045, e[1] + 0.045, y, top(e[1]), along="y")
            pos = lambda s, off=0.0: (o[0] + t[0] * s + out[0] * off, o[1] + t[1] * s + out[1] * off)
            # Boards 18 cm wide, a batten over each joint.
            s = 0.0
            while s < L - 0.01:
                s1 = min(s + 0.18, L)
                m = (s + s1) / 2
                ytop = top(pos(m)[1])
                spans = [(y - 0.05, ytop)]
                for h0, h1, hy0, hy1 in holes[wall]:
                    if h0 < m < h1:
                        spans = [(sy0, sy1) for sy0, sy1 in [(y - 0.05, hy0), (hy1, ytop)] if sy1 - sy0 > 0.02]
                for sy0, sy1 in spans:
                    c0, c1 = pos(s, 0.0), pos(s1, 0.022)
                    self.lumber("hut_planks", min(c0[0], c1[0]), max(c0[0], c1[0]), min(c0[1], c1[1]), max(c0[1], c1[1]), sy0, sy1, along="y")
                if s1 < L - 0.01 and not any(h0 - 0.03 < s1 < h1 + 0.03 for h0, h1, _, _ in holes[wall]):
                    c0, c1 = pos(s1 - 0.03, 0.022), pos(s1 + 0.03, 0.042)
                    self.lumber("hut_planks", min(c0[0], c1[0]), max(c0[0], c1[0]), min(c0[1], c1[1]), max(c0[1], c1[1]), y - 0.03, top(pos(s1)[1]) - 0.02, along="y")
                s = s1
            # Each opening: its frame of boards, and a window's shutter hinged at its head, propped open.
            for h0, h1, hy0, hy1 in holes[wall]:
                for (s0_, s1_, y0_, y1_) in ((h0 - 0.06, h0, hy0 - 0.06, hy1 + 0.06), (h1, h1 + 0.06, hy0 - 0.06, hy1 + 0.06), (h0, h1, hy1, hy1 + 0.06)) + (((h0 - 0.06, h1 + 0.06, hy0 - 0.06, hy0),) if hy0 > y + 0.1 else ()):
                    c0, c1 = pos(s0_, 0.02), pos(s1_, 0.05)
                    self.lumber("hut_timber", min(c0[0], c1[0]), max(c0[0], c1[0]), min(c0[1], c1[1]), max(c0[1], c1[1]), y0_, y1_)
                if hy0 > y + 0.1:
                    hinge = np.array([*pos((h0 + h1) / 2, 0.06)])
                    ang = math.radians(55)
                    dirn = self.d(out[0] * math.sin(ang), out[1] * math.sin(ang), -math.cos(ang))
                    hl = self.p(hinge[0], hinge[1], hy1 + 0.04)
                    c = hl + dirn * (hy1 - hy0 + 0.06) / 2
                    board("hut_planks", c, self.d(*t), np.cross(self.d(*t), dirn), (h1 - h0) + 0.1, 0.025, hy1 - hy0 + 0.06)
                    lo = hl + dirn * (hy1 - hy0 + 0.04)
                    rod(self.p(*pos((h0 + h1) / 2 + 0.2, 0.04), hy0 - 0.04), lo, 0.012, "#7a6d5a")      # the prop stick
                    for hs in (h0 + 0.1, h1 - 0.1):
                        rod(self.p(*pos(hs, 0.055), hy1 + 0.04), self.p(*pos(hs, 0.055), hy1 + 0.04) + dirn * 0.25, 0.008, RUST)
            # Its blocks: 12 cm, round the openings (shoot through a window, walk through the door).
            cuts = sorted(holes[wall])
            s, pieces = 0.0, []
            for h0, h1, hy0, hy1 in cuts:
                if h0 > s:
                    pieces.append((s, h0, y + 0.05, None))
                if hy0 > y + 0.1:
                    pieces.append((h0, h1, y + 0.05, hy0))
                pieces.append((h0, h1, hy1, None))
                s = h1
            if s < L:
                pieces.append((s, L, y + 0.05, None))
            for p0, p1, yy0, yy1 in pieces:
                q = [pos(p0, -0.06), pos(p1, -0.06), pos(p1, 0.06), pos(p0, 0.06)]
                ytop = min(top(pos(p0)[1]), top(pos(p1)[1])) if yy1 is None else yy1
                block([self.xz(*c) for c in q], yy0, ytop)
        return top

    def roof(self, a0, a1, b0, b1, top, over=(0.3, 0.3, 0.12, 0.35), trunk_gap=None):
        """A plank roof falling from the front (b1) to the back (b0): rafters on the walls, boards across them lapped as
        clapboard; `over`: its overhang at a0, a1, b0 and b1."""
        oa0, oa1, ob0, ob1 = over
        y0, y1 = top(b0), top(b1)
        k = (y1 - y0) / (b1 - b0)
        ry = lambda b: y0 + (b - b0) * k
        n = max(2, math.ceil((a1 - a0) / 0.6))
        for i in range(n + 1):
            a = a0 + 0.03 + (a1 - a0 - 0.06) * i / n
            self.beam("hut_timber", (a, b0 - ob0, ry(b0 - ob0) + 0.06), (a, b1 + ob1, ry(b1 + ob1) + 0.06), 0.05, 0.12)
        slope = unit(self.d(0, 1, k))
        b, i = b1 + ob1, 0
        while b > b0 - ob0 + 0.02:
            bb = max(b - 0.2, b0 - ob0)
            mid = (b + bb) / 2
            c = self.p((a0 - oa0 + a1 + oa1) / 2, mid, ry(mid) + 0.134 + 0.022 * (i % 2))      # lapped: every other one higher
            board("hut_roof", c, self.A, slope, a1 + oa1 - a0 + oa0, (b - bb) + 0.035, 0.022)
            if bb <= b0 - ob0 + 1e-6:
                break
            b, i = bb + 0.035, i + 1
        for bb, s in ((b1 + ob1, 1), (b0 - ob0, -1)):                        # the fascias
            self.lumber("hut_timber", a0 - oa0, a1 + oa1, bb - (0.025 if s > 0 else -0.0), bb + (0.0 if s > 0 else 0.025), ry(bb) - 0.02, ry(bb) + 0.16, along="a")
        for aa, s in ((a0 - oa0, -1), (a1 + oa1, 1)):                        # the barge boards
            self.beam("hut_timber", (aa + s * 0.012, b0 - ob0, ry(b0 - ob0) + 0.08), (aa + s * 0.012, b1 + ob1, ry(b1 + ob1) + 0.08), 0.025, 0.17)
        # Its blocks, in strips: shots stop on it, nobody stands under its edge in a wall.
        m = 3
        for i in range(m):
            ba, bb_ = b0 - ob0 + (b1 + ob1 - b0 + ob0) * i / m, b0 - ob0 + (b1 + ob1 - b0 + ob0) * (i + 1) / m
            self.block_box(a0 - oa0, a1 + oa1, ba, bb_, ry(ba) + 0.0, ry(bb_) + 0.17)

    def report(self):
        """Every tree near: where it stands on the frame, how far from the footprint."""
        for t in TREES:
            a, b = self.local(t["x"], t["z"])
            if math.hypot(a, b) < 9 and t not in self.trees:
                print(f"   tree {t['x']},{t['z']} h{t['h']} at a {a:5.2f} b {b:5.2f}")


HUTS = []


def footprint_hull(pts):
    """The convex hull of plan points (a monotone chain)."""
    pts = sorted(set((round(p[0], 3), round(p[1], 3)) for p in pts))
    if len(pts) < 3:
        return pts
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def one_tree_platform(h, half, b1, rail_edges):
    """A platform on one tree: a in [-half, half], b from just past the trunk's bark to b1. Its deck on joists along b;
    under them the beams clasping the trunk (the rim on the nearer one) and a beam on two posts at the far side, knee
    braces from the posts and from the trunk. `rail_edges`: the railing's runs [((a, b), (a, b), posts)], b0 for its
    near edge. Returns b0."""
    F = h.F
    BT = F - 0.028 - 0.15                                  # the beams' top, under the joists
    r = h.clasp(h.tree, 0.0, 0.0, BT, "a", 2 * half + 0.1, outer=1.1)
    b0 = round(r + 0.03, 3)                                # the rim joist on the nearer beam
    bf = b1 - 0.2
    h.lumber("hut_timber", -half - 0.05, half + 0.05, bf - 0.04, bf + 0.04, BT - 0.24, BT, along="a")
    for s in (-1, 1):
        a = s * (half - 0.2)
        h.post(a, bf, h.g(a, bf) - 0.25, BT - 0.24)
        bolt(h.p(a, bf + 0.045, BT - 0.08), h.B)
        h.beam("hut_timber", (a, bf, BT - 1.05), (a - s * 0.8, bf, BT - 0.29), 0.07, 0.1)           # knee braces
        h.beam("hut_timber", (a, bf - 0.05, BT - 1.15), (a, bf - 0.95, BT - 0.05), 0.07, 0.1)
        h.trunk_brace((0.0, 0.0), 0, 0, BT - 1.7, (s * (half - 0.5), b0 + 1.1, BT - 0.05))
    h.trunk_brace((0.0, 0.0), 0, 0, BT - 2.0, (0.0, (b0 + b1) / 2, BT - 0.05))
    h.deck(-half, half, b0, b1, F, along="a")
    for a, b, posts in rail_edges:
        h.balustrade((a[0], b0 if a[1] is None else a[1]), (b[0], b0 if b[1] is None else b[1]), F, posts)
    return b0


# ---------------------------------------------------------------- 1. the lookout (the highest)
def lookout():
    h = Hut("lookout", (685.63, 914.06), 14.5, 5.0)
    half, b1 = 1.8, 3.9
    HB1 = 2.25                                             # the hut on the back of the platform, the porch before it
    b0 = one_tree_platform(h, half, b1, [
        ((-half, HB1), (-half, 2.55), (False, True)),    # (the stair comes up on the porch's left: 2.55 to 3.55)
        ((-half, 3.55), (-half, b1), (True, True)),
        ((-half, b1), (half, b1), (False, True)),
        ((half, b1), (half, HB1), (False, False)),
    ])
    F = h.F
    HB0 = b0 + 0.06
    top = h.walls(-half + 0.05, half - 0.05, HB0, HB1, F, 2.3, 2.02, (0.0, 0.8),
                  [("front", -1.05, 0.75), ("front", 1.05, 0.75), ("left", 1.25, 0.6), ("right", 1.25, 0.6), ("back", 1.0, 0.5)])
    h.roof(-half + 0.05, half - 0.05, HB0, HB1, top, over=(0.25, 0.25, 0.04, 0.45))
    # Inside: a bench along the back wall.
    h.lumber("hut_planks", -1.4, 1.4, HB0 + 0.05, HB0 + 0.38, F + 0.42, F + 0.46)
    for a in (-1.25, 0.0, 1.25):
        h.lumber("hut_timber", a - 0.03, a + 0.03, HB0 + 0.08, HB0 + 0.35, F, F + 0.42)
    # A jib off the porch's right corner with a pulley, the rope down to a bucket on the ground.
    ja, jb = half - 0.05, b1 - 0.05
    h.lumber("hut_timber", ja - 0.05, ja + 0.05, jb - 0.05, jb + 0.05, F + RAIL - 0.04, F + 2.0, along="y")
    h.beam("hut_timber", (ja, jb, F + 1.95), (ja + 0.75, jb + 0.35, F + 1.95), 0.07, 0.1)
    h.beam("hut_timber", (ja, jb, F + 1.35), (ja + 0.55, jb + 0.26, F + 1.92), 0.05, 0.07)
    pa, pb = ja + 0.7, jb + 0.33
    rod(h.p(pa, pb - 0.03, F + 1.8), h.p(pa, pb + 0.03, F + 1.8), 0.08, RUST, seg=10)              # the pulley
    rod(h.p(pa, pb, F + 1.88), h.p(pa, pb, F + 1.9), 0.012, RUST)
    g = h.g(pa + 0.05, pb + 0.1)
    rod(h.p(pa + 0.08, pb, F + 1.8), h.p(pa + 0.06, pb + 0.04, g + 0.42), 0.011, ROPE)
    rod(h.p(pa - 0.08, pb, F + 1.8), h.p(ja + 0.1, jb + 0.05, F + 1.1), 0.011, ROPE)
    bx, bz = pa + 0.06, pb + 0.04
    solid([h.p(bx + 0.16 * math.cos(q), bz + 0.16 * math.sin(q), g + 0.02) for q in np.linspace(0, 2 * math.pi, 11)[:-1]] +
          [h.p(bx + 0.19 * math.cos(q), bz + 0.19 * math.sin(q), g + 0.3) for q in np.linspace(0, 2 * math.pi, 11)[:-1]], "#5d6a6e")   # the bucket
    rod(h.p(bx - 0.18, bz, g + 0.3), h.p(bx, bz, g + 0.42), 0.006, "#3d3f40")
    rod(h.p(bx + 0.18, bz, g + 0.3), h.p(bx, bz, g + 0.42), 0.006, "#3d3f40")
    h.plan.append((bx, bz))
    # A coil of rope on the porch.
    for k in range(3):
        rr = 0.17 - k * 0.012
        pts = [(1.2 + rr * math.cos(q), 3.5 + rr * math.sin(q)) for q in np.linspace(0, 2 * math.pi, 13)]
        for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
            rod(h.p(x0, z0, F + 0.017 + k * 0.03), h.p(x1, z1, F + 0.017 + k * 0.03), 0.017, ROPE)
    h.stair("stair", (-half, 3.05), (-1.0, 0.0), turn="U", side=-1)
    h.floors.insert(0, [*h.xz(0.3, 3.1), F])
    h.floors.insert(1, [*h.xz(-0.6, 1.4), F])
    return h


# ---------------------------------------------------------------- 2. the long deck between two spruces
def pair():
    A_, B_ = (664.62, 918.09), (669.84, 922.75)
    yaw = math.degrees(math.atan2(B_[1] - A_[1], B_[0] - A_[0]))
    h = Hut("pair", A_, yaw, 3.8, trees=[B_])
    tb = h.trees[1]
    LB = h.local(tb["x"], tb["z"])[0]                     # the other trunk, along a
    F = h.F
    BT = F - 0.028 - 0.15
    W = 1.1                                               # b from -W to W
    ra = h.clasp(h.tree, 0.0, 0.0, BT, "b", 2 * W + 0.3, outer=2 * W + 0.3)
    rb = trunk_r(tb, BT - 0.11 - gy(tb["x"], tb["z"])) * 0.97
    for s in (-1, 1):                                     # the other trunk's clasp, on this frame
        h.lumber("hut_timber", LB + s * rb - (0.075 if s < 0 else 0), LB + s * rb + (0.075 if s > 0 else 0), -W - 0.15, W + 0.15, BT - 0.24, BT, along="b")
        for db in (-0.16, 0.16):
            for dy in (-0.07, -0.17):
                bolt(h.p(LB + s * (rb + 0.075), db, BT + dy), h.A * s)
    a0, a1 = ra + 0.03, LB - rb - 0.03                    # the deck, from one clasp to the other
    for b in (-W + 0.1, W - 0.1):                         # the two long beams, double, on the clasps and a post each
        h.lumber("hut_timber", a0 + 0.04, a1 - 0.04, b - 0.04, b + 0.04, BT - 0.48, BT - 0.24, along="a")
        h.lumber("hut_timber", a0 + 0.04, a1 - 0.04, b - 0.04, b + 0.04, BT - 0.24, BT - 0.0, along="a")
        for a in (a0 + 0.08, a1 - 0.08):                  # their steel hangers on the clasps
            solid([h.p(a + da, b + db, y) for da in (-0.05, 0.05) for db in (-0.06, 0.06) for y in (BT - 0.5, BT - 0.47)], BOLT)
        am = (a0 + a1) / 2
        h.post(am, b, h.g(am, b) - 0.25, BT - 0.48)
        for s in (-1, 1):
            h.beam("hut_timber", (am, b, BT - 1.4), (am + s * 1.0, b, BT - 0.53), 0.07, 0.1)
    for s, ta in ((1, 0.0), (-1, LB)):                    # knee braces from both trunks to the beams
        tr = h.tree if s > 0 else tb
        r0 = trunk_r(tr, BT - 1.9 - gy(tr["x"], tr["z"]))
        for b in (-W + 0.1, W - 0.1):
            k = math.copysign(1, b)
            h.beam("hut_timber", (ta + s * r0 * 0.7, k * r0 * 0.7, BT - 1.9), (ta + s * 1.3, b, BT - 0.53), 0.07, 0.1)
            h.lumber("hut_timber", ta + s * r0 * 0.75 - 0.05, ta + s * r0 * 0.75 + 0.05, k * r0 * 0.75 - 0.05, k * r0 * 0.75 + 0.05, BT - 2.05, BT - 1.75, along="y")
            bolt(h.p(ta + s * (r0 * 0.75 + 0.05), k * r0 * 0.75, BT - 1.92), h.A * s)
    h.deck(a0, a1, -W, W, F, along="a")
    # The shelter on the far end: a back wall, the side walls half way, a lean-to roof high at the open front.
    sa0, sa1 = a1 - 2.3, a1 - 0.02
    top = h.walls(sa0, sa1, -W + 0.02, W - 0.02, F, 2.25, 2.0, None, [("back", sa0 + 0.6, 0.5), ("back", sa0 + 1.7, 0.5)],
                  parts={"front": None, "left": (0.0, 0.5), "right": (0.0, 0.55)})
    h.roof(sa0, sa1, -W + 0.02, W - 0.02, top, over=(0.2, 0.08, 0.25, 0.3))
    h.lumber("hut_planks", sa0 + 0.2, sa1 - 0.25, -W + 0.12, -W + 0.45, F + 0.42, F + 0.46)            # a bench
    for a in (sa0 + 0.35, sa1 - 0.4):
        h.lumber("hut_timber", a - 0.03, a + 0.03, -W + 0.15, -W + 0.42, F, F + 0.42)
    STAIR_AT = a0 + 1.1
    h.balustrade((a0, -W), (sa0, -W), F, (False, False))
    h.balustrade((a0, W), (STAIR_AT - 0.55, W), F, (False, True))
    h.balustrade((STAIR_AT + 0.55, W), (sa0 + 0.6, W), F, (True, True))
    h.balustrade((a0 + 0.06, -W), (a0 + 0.06, W), F, (True, True))
    h.stair("stair", (STAIR_AT, W), (0.0, 1.0), turn="L", side=-1)
    h.floors.insert(0, [*h.xz((a0 + a1) / 2 - 0.6, 0.0), F])
    h.floors.insert(1, [*h.xz(sa0 + 1.0, 0.2), F])
    return h


# ---------------------------------------------------------------- 3. the north platform
def north():
    h = Hut("north", (665.66, 986.02), 196.7, 3.2)
    half, b1 = 1.6, 3.2
    b0 = one_tree_platform(h, half, b1, [
        ((-half, None), (-half, b1), (True, True)),
        ((-half, b1), (half, b1), (False, True)),
        ((half, b1), (half, 2.45), (False, True)),
        ((half, 1.45), (half, None), (True, True)),
        ((-half, None), (half, None), (False, False)),
    ])
    F = h.F
    h.lumber("hut_planks", -1.25, -0.35, b0 + 0.2, b0 + 0.5, F + 0.42, F + 0.46)                 # a bench either side of the trunk
    h.lumber("hut_planks", 0.35, 1.25, b0 + 0.2, b0 + 0.5, F + 0.42, F + 0.46)
    for a in (-1.15, -0.45, 0.45, 1.15):
        h.lumber("hut_timber", a - 0.03, a + 0.03, b0 + 0.23, b0 + 0.47, F, F + 0.42)
    h.stair("stair", (half, 1.95), (1.0, 0.0), rope=True)
    h.floors.insert(0, [*h.xz(0.0, 2.2), F])
    return h


# ---------------------------------------------------------------- 4. the west hut
def west():
    h = Hut("west", (635.53, 979.25), 238.4, 4.2)
    half, b1 = 1.45, 3.4
    HB1 = 1.95
    b0 = one_tree_platform(h, half, b1, [
        ((-half, HB1), (-half, b1), (False, True)),
        ((-half, b1), (-0.07, b1), (False, True)),
        ((1.07, b1), (half, b1), (True, True)),
        ((half, b1), (half, HB1), (False, False)),
    ])
    F = h.F
    HB0 = b0 + 0.06
    top = h.walls(-half + 0.05, half - 0.05, HB0, HB1, F, 2.25, 2.02, (-0.45, 0.8),
                  [("front", 0.75, 0.7), ("left", 1.2, 0.55), ("right", 1.2, 0.55)])
    h.roof(-half + 0.05, half - 0.05, HB0, HB1, top, over=(0.25, 0.25, 0.04, 0.4))
    h.lumber("hut_planks", -1.1, 1.1, HB0 + 0.05, HB0 + 0.36, F + 0.42, F + 0.46)
    for a in (-0.95, 0.95):
        h.lumber("hut_timber", a - 0.03, a + 0.03, HB0 + 0.08, HB0 + 0.33, F, F + 0.42)
    h.stair("stair", (0.5, b1), (0.0, 1.0), turn="L", side=1)
    h.floors.insert(0, [*h.xz(0.0, 2.7), F])
    return h


for build in (lookout, pair, north, west):
    HUTS.append(build())

# ---------------------------------------------------------------- what the game needs, and checks
out = []
for h in HUTS:
    ring = footprint_hull(h.plan)
    xz = [h.xz(a, b) for a, b in ring]
    xs, zs = [p[0] for p in xz], [p[1] for p in xz]
    print(f"{h.name}: floor {h.F - h.foot:.2f} m over the ground at its tree ({h.F:.2f} over the café's origin), "
          f"{len(h.stairs)} stair(s): " + ", ".join(f"{s['risers']} risers of {s['rise'] * 100:.1f} cm" for s in h.stairs))
    h.report()
    # No tree may stand in a floor or a stair (its bearing trunks stand beside them).
    for t in TREES:
        a, b = h.local(t["x"], t["z"])
        if math.hypot(a, b) > 12:
            continue
        inside = all((ring[(i + 1) % len(ring)][0] - ring[i][0]) * (b - ring[i][1]) - (ring[(i + 1) % len(ring)][1] - ring[i][1]) * (a - ring[i][0]) >= 0
                     for i in range(len(ring)))
        if inside and t not in h.trees:
            print(f"   !! tree {t['x']},{t['z']} inside the footprint of {h.name}")
    out.append({
        "id": h.name,
        "trees": [[t["x"], t["z"]] for t in h.trees],
        "floors": [[round(float(c), 3) for c in f] for f in h.floors],
        "stairs": [{**s, "foot": [round(float(c), 3) for c in s["foot"]], "top": [round(float(c), 3) for c in s["top"]],
                    "rise": round(float(s["rise"]), 4), **({"landing": round(float(s["landing"]), 3)} if "landing" in s else {}),
                    "path": [[round(float(c), 3) for c in q] for q in s["path"]]} for s in h.stairs],
        "area": [round(min(xs) - 1.0, 2), round(min(zs) - 1.0, 2), round(max(xs) + 1.0, 2), round(max(zs) + 1.0, 2)],
        "footprint": [[round(float(x), 2), round(float(z), 2)] for x, z in xz],
    })

DATA = {
    "_source": "tools/tree_huts.py: the tree huts in the wood round the café Sparrenhof, shooting bases in Zombies",
    "origin": list(ORIGIN),
    "huts": out,
    "blocks": blocks,
}
with open(os.path.join(ROOT, "web", "shared", "tree_huts.json"), "w", encoding="utf-8", newline="\n") as f:
    f.write(json.dumps(DATA, separators=(",", ":")) + "\n")

# ---------------------------------------------------------------- objects, export
root = bpy.data.objects.new("tree_huts", None)
bpy.context.scene.collection.objects.link(root)
root["origin"] = list(ORIGIN)
root["landmark"] = "tree_huts"
tris = 0
objs = []
for name, bm in BM.items():
    if not bm.faces:
        continue
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
    bm.normal_update()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    me.materials.append(M[name])
    me.set_sharp_from_angle(angle=math.radians(30))
    ob = bpy.data.objects.new(name, me)
    ob["material"] = "oak" if name != "hut_fittings" else "steel"      # what a bullet hit looks and sounds like
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = root
    me.calc_loop_triangles()
    tris += len(me.loop_triangles)
    print(f"{name}: {len(me.loop_triangles)} triangles")
    objs.append(ob)
print(f"tree_huts: {tris} triangles in {len(objs)} meshes, {len(blocks)} blocks")
bpy.ops.object.select_all(action="DESELECT")
root.select_set(True)
for o in objs:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=True, export_normals=True, export_extras=True, export_vertex_color="MATERIAL",
                          export_cameras=False, export_lights=False)
print("written", OUT, os.path.getsize(OUT), "bytes")

# ---------------------------------------------------------------- preview renders
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 32
    try:
        scene.view_settings.view_transform = "AgX"
    except TypeError:
        scene.view_settings.view_transform = "Filmic"
    sizes = load("web", "public", "textures", "sizes.json")
    for name, (tex, tint, nscale, _) in SHARED.items():
        mat = M[name]
        nt = mat.node_tree
        p = nt.nodes["Principled BSDF"]
        uv = nt.nodes.new("ShaderNodeUVMap")
        mp = nt.nodes.new("ShaderNodeMapping")
        s = 1 / sizes.get(tex, 2.0)
        mp.inputs["Scale"].default_value = (s, s, 1)
        nt.links.new(uv.outputs["UV"], mp.inputs["Vector"])
        img = nt.nodes.new("ShaderNodeTexImage")
        img.image = bpy.data.images.load(os.path.join(ROOT, "web", "public", "textures", f"{tex}_color.webp"), check_existing=True)
        nt.links.new(mp.outputs["Vector"], img.inputs["Vector"])
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        nt.links.new(img.outputs["Color"], mix.inputs["A"])
        mix.inputs["B"].default_value = (*srgb(tint), 1)
        nt.links.new(mix.outputs["Result"], p.inputs["Base Color"])
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.62, 0.68, 0.78, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    scene.world = world
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(50), 0, math.radians(200)))
    bpy.context.active_object.data.energy = 2.0
    # The ground (the relief round each hut) and the trees' trunks as the game draws them, crowns as dark cones.
    gm = principled("PreviewGround", srgb("#4f4a3c"), 0.95)
    bark = principled("PreviewBark", srgb("#6b5546"), 0.9)
    leaf = principled("PreviewLeaf", srgb("#2c3a27"), 1.0)
    for h in HUTS:
        bm = bmesh.new()
        N = 24
        vs = {}
        for i in range(N + 1):
            for j in range(N + 1):
                a, b = -12 + 24 * i / N, -12 + 24 * j / N
                x, z = h.xz(a, b)
                vs[i, j] = bm.verts.new(to_b((x, gy(x, z) - 0.02, z)))
        for i in range(N):
            for j in range(N):
                bm.faces.new([vs[i, j], vs[i + 1, j], vs[i + 1, j + 1], vs[i, j + 1]])
        me = bpy.data.meshes.new("ground")
        bm.to_mesh(me)
        bm.free()
        me.materials.append(gm)
        o = bpy.data.objects.new("ground", me)
        scene.collection.objects.link(o)
    for t in TREES:
        if min(math.hypot(t["x"] - h.T[0], t["z"] - h.T[1]) for h in HUTS) > 14:
            continue
        y0 = gy(t["x"], t["z"])
        L = 0.4288 * t["h"]
        bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=trunk_r(t, 0.5), radius2=trunk_r(t, L), depth=L,
                                        location=to_b((t["x"], y0 + L / 2, t["z"])))
        bpy.context.active_object.data.materials.append(bark)
        bpy.ops.mesh.primitive_cone_add(vertices=12, radius1=min(4.4, t["h"] * 0.15), radius2=0.1, depth=t["h"] * 0.67,
                                        location=to_b((t["x"], y0 + t["h"] * 0.33 + t["h"] * 0.335, t["z"])))
        bpy.context.active_object.data.materials.append(leaf)
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    cam.data.sensor_fit = "HORIZONTAL"
    cam.data.sensor_width = 36.0
    os.makedirs(PREVIEW, exist_ok=True)

    def shoot(label, eye, target, f_px=600, w=800, h=600):
        scene.render.resolution_x, scene.render.resolution_y = w, h
        e, t = to_b(eye), to_b(target)
        cam.location = e
        cam.rotation_euler = (t - e).to_track_quat("-Z", "Y").to_euler()
        cam.data.lens = f_px / w * 36.0
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)

    for h in HUTS:
        mid = h.p(0.0, 2.0, h.F - 1.5)
        for k, (a, b, up) in enumerate(((5.0, 11.0, 1.7), (-9.0, 6.0, 4.0))):
            shoot(f"{h.name}_{k}", h.p(a, b, h.foot + up), mid)
        shoot(f"{h.name}_deck", h.p(-1.2, 3.6, h.F + 1.6), h.p(1.5, -6.0, h.F - 2.0))
