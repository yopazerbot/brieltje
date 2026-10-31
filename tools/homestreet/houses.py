"""The houses round the two portals at home, our own Blender models, for the walkthrough.

Run (Blender 5, no window), from the project root:
  blender -b -P tools/homestreet/houses.py -- web/public/models/homestreet.glb web/src/data/homestreet.json

Until now the neighbours' houses near the main house and the bungalow were drawn from the open data:
outlines (GRB) pushed up to the laser scan's heights, with made-up windows. Here the ones a player sees
from the two portals are built as they are, from a survey of 31 October 2026. Used for measuring only,
nothing of them is shipped:
- the outlines: the GRB footprints of each building (Digitaal Vlaanderen), the same ones the game had;
- the heights: the DHM Vlaanderen II laser scan (2013-2015), as tools/neighbours.py fitted them, checked
  against Street View;
- the 25 cm orthophoto: roof colours, solar panels, paving, the glass roof of a conservatory;
- Street View (April 2023), from the lane only: walls (brick colour and bond, render, timber cladding), the
  windows and doors (sizes, frame colours, bluestone sills), garage doors, chimneys and flues, gutters,
  fences, gates and pillars.
What the photos don't show (the back of each house, the inner yards) is made up in the same style. The
houses are named by where they stand, never by their numbers; no people, no names, no images kept.

Frame: every cluster is a root node in the game's own axes (x, y up, z) with its origin on the ground at
ORIGIN (y = 0 is the relief there); everything stands on the relief where it is (web/shared/terrain.json,
the browser's formula). Heights below are model heights (the plot's ground is at y = -0.1).

Output:
- one GLB with a node per cluster (home, bungalow), one mesh per material in each:
  hs_brick_red, hs_brick_buff, hs_wood, hs_tiles (our textures, tools/homestreet/textures.py; UVs in texture
  tiles), hs_render, hs_pave (the game's plaster and pavers, UVs in metres), hs_glass, and hs_trim (frames,
  sills, gutters, flues, fences: no texture). Every mesh carries a colour per corner: its tint times ambient
  occlusion baked in Cycles, so window reveals, eaves and wall feet are shaded without any cost in the game.
  hs_trim is the part the game hides beyond 150 m.
- a small JSON for the game: per cluster the GRB outlines the models replace (the game stops drawing those
  buildings, but keeps them for walking into), and the blocks of the garden walls, pillars and fences added
  here (for walking and driving into).
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
OUT_JSON = argv[1]
NO_BAKE = "--no-bake" in argv
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GROUND = -0.1  # the plot's ground in the model


# ---------------------------------------------------------------- the relief, as the browser has it
def load_terrain():
    d = json.load(open(os.path.join(ROOT, "web", "shared", "terrain.json"), encoding="utf-8"))
    digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    value = {c: k for k, c in enumerate(digits)}
    s, rest, k = d["d"], [], 0
    while k < len(s):
        if s[k] == "~":
            rest.append(((value[s[k + 1]] << 12) | (value[s[k + 2]] << 6) | value[s[k + 3]]) - (1 << 17))
            k += 4
        else:
            rest.append(value[s[k]] - 32)
            k += 1
    grid = np.array(rest, np.int64).reshape(d["nz"], d["nx"]).cumsum(1).cumsum(0) / 100.0
    return d, grid


TD, TG = load_terrain()


def terrain(x, z):
    """Metres above the plot's ground at (x, z): two flat triangles per square of the grid (terrain.mjs)."""
    fx = min(max((x - TD["x0"]) / TD["step"], 0.0), TD["nx"] - 1.000001)
    fz = min(max((z - TD["z0"]) / TD["step"], 0.0), TD["nz"] - 1.000001)
    i, j = int(fx), int(fz)
    u, v = fx - i, fz - j
    h00, h11 = TG[j, i], TG[j + 1, i + 1]
    if u >= v:
        h10 = TG[j, i + 1]
        return float(h00 + u * (h10 - h00) + v * (h11 - h10))
    h01 = TG[j + 1, i]
    return float(h00 + v * (h01 - h00) + u * (h11 - h01))


def gy(x, z):
    """The ground's model height at (x, z)."""
    return GROUND + terrain(x, z)


CLUSTERS = {"home": (10.0, 28.0), "bungalow": (75.0, 180.0)}


class Cur:
    name = None
    origin = (0.0, 0.0)
    y0 = 0.0


def use(cluster):
    Cur.name = cluster
    Cur.origin = CLUSTERS[cluster]
    Cur.y0 = gy(*Cur.origin)


def V(x, z, y):
    """A game point (x, z, model height y) in Blender's frame of the current cluster (z up)."""
    return Vector((x - Cur.origin[0], -(z - Cur.origin[1]), y - Cur.y0))


def srgb(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


# ---------------------------------------------------------------- materials
bpy.ops.wm.read_factory_settings(use_empty=True)
# name: (texture for the game, tile size in metres (u, v): UVs are divided by it, mean colour for the bake)
MATS = {
    "hs_brick_red": ("hs_brick_red", (1.105, 1.064), "#a8553c"),
    "hs_brick_buff": ("hs_brick_buff", (1.105, 1.064), "#cfc7bd"),
    "hs_wood": ("hs_wood", (1.12, 1.12), "#c8c2b8"),
    "hs_tiles": ("hs_tiles", (1.2, 1.2), "#c8c6c4"),
    "hs_render": ("plaster", (1.0, 1.0), "#f2efe9"),   # the game's plaster texture: UVs in metres
    "hs_pave": ("pavers", (1.0, 1.0), "#c9c6c0"),      # the game's pavers: UVs in metres
    "hs_slab": ("terrace", (1.0, 1.0), "#d7d5d0"),     # the game's light concrete slabs: UVs in metres
    "hs_glass": (None, None, "#ffffff"),
    "hs_trim": (None, None, "#ffffff"),
}
M = {}
for name, (tex, size, mean) in MATS.items():
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*srgb(mean), 1)
    p.inputs["Roughness"].default_value = 0.85
    attr = m.node_tree.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Color"
    m.node_tree.links.new(attr.outputs["Color"], p.inputs["Base Color"])  # so the exporter writes it as COLOR_0
    m.use_backface_culling = True
    if tex:
        m["texture"] = tex
    M[name] = m
DETAIL = {"hs_trim"}  # hidden far away

BM = {}


def bm_for(mat):
    key = (Cur.name, mat)
    if key not in BM:
        bm = bmesh.new()
        bm.loops.layers.float_color.new("Color")
        BM[key] = bm
    return BM[key]


def colour(h):
    return (*srgb(h), 1.0)


# ---------------------------------------------------------------- geometry helpers (game coordinates)
def _new_face(bm, vs, col):
    f = bm.faces.new([bm.verts.new(v) for v in vs])
    lay = bm.loops.layers.float_color["Color"]
    c = colour(col)
    for lp in f.loops:
        lp[lay] = c
    return f


def face(mat, pts, out=None, col="#ffffff", grid=None):
    """A planar face through game points (x, z, y), turned to face `out` (a game direction (dx, dz, dy)); cut
    into cells of about `grid` metres (so the baked occlusion has corners to sit on)."""
    vs = [V(*p) for p in pts]
    if out is not None:
        n = (vs[1] - vs[0]).cross(vs[2] - vs[0])
        if len(vs) > 3 and n.length < 1e-9:
            n = (vs[2] - vs[0]).cross(vs[3] - vs[0])
        o = Vector((out[0], -out[1], out[2]))
        if n.dot(o) < 0:
            vs = vs[::-1]
    bm = bm_for(mat)
    if not grid:
        return _new_face(bm, vs, col)
    tmp = bmesh.new()
    tmp.faces.new([tmp.verts.new(v) for v in vs])
    n = (vs[1] - vs[0]).cross(vs[2] - vs[0])
    if n.length < 1e-9 and len(vs) > 3:
        n = (vs[2] - vs[0]).cross(vs[3] - vs[0])
    n.normalize()
    t = Vector((0, 0, 1)).cross(n)
    if t.length < 1e-6:
        t = Vector((1, 0, 0))
    t.normalize()
    b = n.cross(t).normalized()
    for axis in (t, b):
        ds = [v.dot(axis) for v in vs]
        lo, hi = min(ds), max(ds)
        k = int((hi - lo) / grid)
        for i in range(1, k + 1):
            d = lo + (hi - lo) * i / (k + 1)
            geom = tmp.verts[:] + tmp.edges[:] + tmp.faces[:]
            bmesh.ops.bisect_plane(tmp, geom=geom, plane_co=axis * d, plane_no=axis, dist=1e-5)
    for f in tmp.faces:
        g = [v.co.copy() for v in f.verts]
        if (g[1] - g[0]).cross(g[2] - g[0]).dot(n) < 0:
            g = g[::-1]
        _new_face(bm, g, col)
    tmp.free()


def solid(mat, pts, col="#ffffff"):
    """The convex solid round game points (x, z, y)."""
    tmp = bmesh.new()
    for p in pts:
        tmp.verts.new(V(*p))
    res = bmesh.ops.convex_hull(tmp, input=tmp.verts[:])
    dead = {g for g in res["geom_interior"] + res["geom_unused"] if isinstance(g, bmesh.types.BMVert)}
    bmesh.ops.delete(tmp, geom=list(dead), context="VERTS")
    bmesh.ops.dissolve_limit(tmp, angle_limit=math.radians(0.5), verts=tmp.verts[:], edges=tmp.edges[:])
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces[:])
    bm = bm_for(mat)
    for f in tmp.faces:
        _new_face(bm, [v.co.copy() for v in f.verts], col)
    tmp.free()


def box_along(mat, a, b, w, h, col, up=(0, 0, 1)):
    """A box from game point a to b (x, z, y), w wide across and h high (across `up`)."""
    a, b = Vector(a), Vector(b)
    d = (b - a).normalized()
    u = Vector(up)
    side = d.cross(u)
    if side.length < 1e-6:
        side = d.cross(Vector((1, 0, 0)))
    side.normalize()
    upn = side.cross(d).normalized()
    pts = []
    for p in (a, b):
        for sx in (-w / 2, w / 2):
            for sy in (-h / 2, h / 2):
                q = p + side * sx + upn * sy
                pts.append((q.x, q.y, q.z))
    solid(mat, pts, col)


def tube(mat, a, b, r, col, seg=8, half=False, roll=0.0):
    """A round tube from game point a to b (or its lower half, open at the top: a gutter)."""
    a, b = Vector(a), Vector(b)
    d = (b - a).normalized()
    u = d.cross(Vector((0, 0, 1)))
    if u.length < 1e-6:
        u = d.cross(Vector((1, 0, 0)))
    u.normalize()
    w = u.cross(d).normalized()  # up for a level tube
    ks = range(seg + 1) if half else range(seg)
    ring = []
    for k in ks:
        t = (math.pi * k / seg + math.pi) if half else 2 * math.pi * k / seg + roll
        ring.append(u * math.cos(t) * r + w * math.sin(t) * r)
    n = len(ring)
    for k in range(n - 1 if half else n):
        p0, p1 = ring[k], ring[(k + 1) % n]
        pts = [a + p0, b + p0, b + p1, a + p1]
        face(mat, [tuple(p) for p in pts], tuple(((p0 + p1) / 2)), col)
        if half:  # the inside of a gutter
            face(mat, [tuple(p) for p in pts], tuple(-(p0 + p1) / 2), col)
    if not half:
        face(mat, [tuple(a + p) for p in ring], tuple(-d), col)
        face(mat, [tuple(b + p) for p in ring], tuple(d), col)


def ring_prism(mat, ring, y0, y1, col, top=True):
    """A slab of a plan outline [(x, z)] from model height y0 to y1."""
    cx = sum(p[0] for p in ring) / len(ring)
    cz = sum(p[1] for p in ring) / len(ring)
    if top:
        face(mat, [(x, z, y1) for x, z in ring], (0, 0, 1), col)
    for a, b in zip(ring, ring[1:] + ring[:1]):
        mid = ((a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cz)
        n = (b[1] - a[1], -(b[0] - a[0]))
        out = n if n[0] * mid[0] + n[1] * mid[1] > 0 else (-n[0], -n[1])
        face(mat, [(a[0], a[1], y0), (b[0], b[1], y0), (b[0], b[1], y1), (a[0], a[1], y1)], (out[0], out[1], 0), col)


def drape(mat, ring, lift, col):
    """A flat shape on the relief (game outline [(x, z)]): cut along the relief's grid so each piece lies in one
    of its triangles, each corner `lift` above the ground."""
    tmp = bmesh.new()
    tmp.faces.new([tmp.verts.new(V(x, z, 0.0)) for x, z in ring])
    xs, zs = [p[0] for p in ring], [p[1] for p in ring]
    step, x0, z0 = TD["step"], TD["x0"], TD["z0"]
    planes = []
    for i in range(math.floor((min(xs) - x0) / step), math.ceil((max(xs) - x0) / step) + 1):
        planes.append(((x0 + i * step, 0.0), (1.0, 0.0)))
    for j in range(math.floor((min(zs) - z0) / step), math.ceil((max(zs) - z0) / step) + 1):
        planes.append(((0.0, z0 + j * step), (0.0, 1.0)))
    c0 = min(xs) - max(zs) - step
    for k in range(int((max(xs) - min(zs) - c0) / step) + 2):
        c = x0 - z0 + step * (math.floor((c0 - (x0 - z0)) / step) + k)
        planes.append(((c, 0.0), (1 / math.sqrt(2), -1 / math.sqrt(2))))
    for (px, pz), (nx, nz) in planes:
        co = V(px, pz, Cur.y0)
        no = Vector((nx, -nz, 0.0))
        geom = tmp.verts[:] + tmp.edges[:] + tmp.faces[:]
        bmesh.ops.bisect_plane(tmp, geom=geom, plane_co=co, plane_no=no, dist=1e-5)
    bm = bm_for(mat)
    for f in tmp.faces:
        pts = []
        for v in f.verts:
            gx, gz = v.co.x + Cur.origin[0], -v.co.y + Cur.origin[1]
            pts.append(V(gx, gz, gy(gx, gz) + lift))
        if len(pts) < 3:
            continue
        if (pts[1] - pts[0]).cross(pts[2] - pts[0]).z < 0:
            pts = pts[::-1]
        _new_face(bm, pts, col)
    tmp.free()


# ---------------------------------------------------------------- walls, openings
class Frame:
    """A wall on the plan: from a, along unit t, outward unit o; y is measured from `base` (the ground at
    the wall). p(s, y, d): s along, y up, d out of the wall."""

    def __init__(self, a, b, centre, base=None):
        self.a = a
        L = math.dist(a, b)
        self.L = L
        self.t = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
        o = (self.t[1], -self.t[0])
        mid = ((a[0] + b[0]) / 2 - centre[0], (a[1] + b[1]) / 2 - centre[1])
        if o[0] * mid[0] + o[1] * mid[1] < 0:
            o = (-o[0], -o[1])
        self.o = o
        self.base = base if base is not None else (gy(*a) + gy(*b)) / 2

    def p(self, s, y, d=0.0):
        return (self.a[0] + self.t[0] * s + self.o[0] * d, self.a[1] + self.t[1] * s + self.o[1] * d, self.base + y)

    def out(self, k=1.0):
        return (self.o[0] * k, self.o[1] * k, 0.0)

    def along(self, k=1.0):
        return (self.t[0] * k, self.t[1] * k, 0.0)

    def box(self, mat, s0, s1, y0, y1, d0, d1, col):
        solid(mat, [self.p(s, y, d) for s in (s0, s1) for y in (y0, y1) for d in (d0, d1)], col)

    def flat(self, mat, s0, s1, y0, y1, d, col, out=None):
        face(mat, [self.p(s0, y0, d), self.p(s1, y0, d), self.p(s1, y1, d), self.p(s0, y1, d)], out or self.out(), col)


class Hole:
    """An opening in a wall: s0..s1 along, y0..y1 above the ground at the wall.
    kind: window, door (a leaf with a glass strip), glazed (a door all glass), garage (a sectional door)."""

    def __init__(self, s0, s1, y0, y1, kind="window", frame="#383b3e", cols=None, transom=None, depth=0.13,
                 leaf="#3c3f42", sill=True, arch=False, surround=None):
        self.s0, self.s1, self.y0, self.y1 = s0, s1, y0, y1
        self.kind, self.frame, self.transom, self.depth, self.leaf, self.sill = kind, frame, transom, depth, leaf, sill
        self.cols = cols if cols is not None else (2 if s1 - s0 > 1.25 and kind == "window" else 1)
        self.arch, self.surround = arch, surround


def W(sc, w, y0, y1, **kw):
    """A window centred at sc."""
    return Hole(sc - w / 2, sc + w / 2, y0, y1, **kw)


SILL = "#50565b"  # Belgian bluestone


def facade(f, top, holes, mat, col, bottom=-0.35, plinth=None, grid=0.6, from_y=None):
    """A wall from s = 0 to f.L: its surface from `bottom` (or from_y) up to the line `top` ([(s, y)]),
    without the holes, with their reveals, frames, glass and sills. plinth = (height, material, colour)."""
    if not isinstance(top, (list, tuple)):
        top = [(0.0, top), (f.L, top)]
    bottom = from_y if from_y is not None else bottom

    def ytop(s):
        for (s0, y0), (s1, y1) in zip(top, top[1:]):
            if s0 - 1e-6 <= s <= s1 + 1e-6:
                return y0 + (y1 - y0) * (s - s0) / max(s1 - s0, 1e-9)
        return top[-1][1]
    xs = sorted({0.0, f.L, *[s for h in holes for s in (h.s0, h.s1)], *[s for s, _ in top]})
    xs = [s for s in xs if -1e-6 <= s <= f.L + 1e-6]
    for xa, xb in zip(xs, xs[1:]):
        if xb - xa < 1e-4:
            continue
        xm = (xa + xb) / 2
        cuts = sorted((h.y0, h.y1) for h in holes if h.s0 <= xm <= h.s1)
        spans, y = [], bottom
        for y0, y1 in cuts:
            spans.append((y, y0))
            y = y1
        spans.append((y, None))
        for ya, yb in spans:
            pieces = [(ya, yb)]
            if plinth and ya < plinth[0] and (yb is None or yb > plinth[0]):
                pieces = [(ya, plinth[0]), (plinth[0], yb)]
            for y0, y1 in pieces:
                low = plinth and y1 is not None and y1 <= plinth[0] + 1e-6
                m, c = (plinth[1], plinth[2]) if low else (mat, col)
                ta = ytop(xa) if y1 is None else y1
                tb = ytop(xb) if y1 is None else y1
                if max(ta, tb) - y0 < 1e-4:
                    continue
                pts = [f.p(xa, y0), f.p(xb, y0), f.p(xb, tb), f.p(xa, ta)]
                if tb - y0 < 1e-4:
                    pts = [f.p(xa, y0), f.p(xb, y0), f.p(xa, ta)]
                elif ta - y0 < 1e-4:
                    pts = [f.p(xa, y0), f.p(xb, y0), f.p(xb, tb)]
                face(m, pts, f.out(), c, grid)
    for h in holes:
        opening(f, h, mat, col)


def opening(f, h, mat, col):
    d = -h.depth
    s0, s1, y0, y1 = h.s0, h.s1, h.y0, h.y1
    # Reveals in the wall's own material, facing into the opening.
    face(mat, [f.p(s0, y0), f.p(s0, y1), f.p(s0, y1, d), f.p(s0, y0, d)], f.along(1), col)
    face(mat, [f.p(s1, y0), f.p(s1, y1), f.p(s1, y1, d), f.p(s1, y0, d)], f.along(-1), col)
    face(mat, [f.p(s0, y1), f.p(s1, y1), f.p(s1, y1, d), f.p(s0, y1, d)], (0, 0, -1), col)
    if h.kind not in ("door", "glazed", "garage"):
        face(mat, [f.p(s0, y0), f.p(s1, y0), f.p(s1, y0, d), f.p(s0, y0, d)], (0, 0, 1), col)
    fw, fd = 0.065, 0.07
    c = h.frame
    T = "hs_trim"
    if h.kind == "garage":
        # A sectional door: five panels with a dark groove between them, set in a thin frame.
        f.flat(T, s0, s1, y0, y1, d - 0.01, "#202224")
        k = 5
        for i in range(k):
            a = y0 + (y1 - y0) * i / k + 0.012
            b = y0 + (y1 - y0) * (i + 1) / k - 0.012
            f.box(T, s0 + 0.03, s1 - 0.03, a, b, d, d + 0.035, h.leaf)
        for s in (s0, s1 - 0.05):
            f.box(T, s, s + 0.05, y0, y1, d, d + 0.06, c)
        f.box(T, s0, s1, y1 - 0.05, y1, d, d + 0.06, c)
        return
    # The glass set back in the reveal, the frame round it standing out a little from the glass.
    if h.kind == "door":
        f.flat(T, s0 + fw, s1 - fw, y0, y1 - fw, d + 0.02, h.leaf)
        g0, g1 = s0 + fw + 0.12, min(s1 - fw - 0.12, s0 + fw + 0.32)
        f.flat("hs_glass", g0, g1, y0 + 0.35, y1 - fw - 0.2, d + 0.025, "#26303a")
        f.box(T, s1 - fw - 0.16, s1 - fw - 0.13, y0 + 0.9, y0 + 1.25, d + 0.02, d + 0.07, "#9da1a4")  # the bar handle
        f.box(SILL_MAT, s0 - 0.03, s1 + 0.03, -0.12, 0.03, d, 0.12, SILL)  # the doorstep
    else:
        f.flat("hs_glass", s0, s1, y0, y1, d, "#2a333b")
    if h.arch:
        # A round-headed door or window: the glass in the arch, a stone surround with a keystone.
        r = (s1 - s0) / 2
        sc = (s0 + s1) / 2
        n = 10
        for i in range(n):
            a0, a1 = math.pi * i / n, math.pi * (i + 1) / n
            for rr, dd, cc in ((r + 0.16, 0.05, h.surround or "#e9e5dc"),):
                pa = (sc + math.cos(a0) * r, y1 + math.sin(a0) * r)
                pb = (sc + math.cos(a1) * r, y1 + math.sin(a1) * r)
                qa = (sc + math.cos(a0) * rr, y1 + math.sin(a0) * rr)
                qb = (sc + math.cos(a1) * rr, y1 + math.sin(a1) * rr)
                face(T, [f.p(pa[0], pa[1], dd), f.p(pb[0], pb[1], dd), f.p(qb[0], qb[1], dd), f.p(qa[0], qa[1], dd)], f.out(), cc)
            pa = (sc + math.cos(a0) * r, y1 + math.sin(a0) * r)
            pb = (sc + math.cos(a1) * r, y1 + math.sin(a1) * r)
            face("hs_glass", [f.p(sc, y1, d), f.p(pa[0], pa[1], d), f.p(pb[0], pb[1], d)], f.out(), "#2a333b")
            face(mat, [f.p(pa[0], pa[1], 0), f.p(pb[0], pb[1], 0), f.p(pb[0], pb[1], d), f.p(pa[0], pa[1], d)], (0, 0, -1), col)
        f.box(T, sc - 0.09, sc + 0.09, y1 + r - 0.02, y1 + r + 0.2, 0.0, 0.07, h.surround or "#e9e5dc")
        for s in (s0 - 0.16, s1):
            f.box(T, s, s + 0.16, y0, y1, 0.0, 0.05, h.surround or "#e9e5dc")
    # Frame: four bars round the opening.
    f.box(T, s0, s0 + fw, y0, y1, d, d + fd, c)
    f.box(T, s1 - fw, s1, y0, y1, d, d + fd, c)
    f.box(T, s0, s1, y1 - fw, y1, d, d + fd, c)
    if h.kind != "door" or True:
        f.box(T, s0, s1, y0, y0 + fw, d, d + fd, c)
    if h.kind in ("window", "glazed"):
        for i in range(1, h.cols):
            s = s0 + (s1 - s0) * i / h.cols
            f.box(T, s - 0.045, s + 0.045, y0 + fw, y1 - fw, d, d + fd + 0.005, c)
        if h.transom:
            t = y0 + h.transom
            f.box(T, s0 + fw, s1 - fw, t - 0.04, t + 0.04, d, d + fd + 0.005, c)
        # The opening sashes: a thin inner outline in each column, as the frames have.
        if h.kind == "window" and (s1 - s0) / h.cols > 0.5:
            for i in range(h.cols):
                a = s0 + (s1 - s0) * i / h.cols + (fw if i == 0 else 0.045)
                b = s0 + (s1 - s0) * (i + 1) / h.cols - (fw if i == h.cols - 1 else 0.045)
                top = (y0 + h.transom - 0.04) if h.transom else y1 - fw
                for (q0, q1, r0, r1) in ((a, a + 0.045, y0 + fw, top), (b - 0.045, b, y0 + fw, top), (a, b, top - 0.045, top), (a, b, y0 + fw, y0 + fw + 0.045)):
                    f.box(T, q0, q1, r0, r1, d, d + fd - 0.02, c)
    if h.sill and h.kind == "window":
        # A bluestone sill under the frame, sloping out, with a drip past the wall.
        f.box(SILL_MAT, s0 - 0.03, s1 + 0.03, y0 - 0.055, y0, d + 0.02, 0.05, SILL)


SILL_MAT = "hs_trim"


# ---------------------------------------------------------------- roofs
def quad_tile_slope(pts, col, grid=1.0):
    face("hs_tiles", pts, (0, 0, 1), col, grid)


def gutter_run(a, b, out, eave_y, col="#8a8e90"):
    """A half-round zinc gutter just outside the eave line from a to b (plan points), with end caps."""
    ox, oz = out
    pa = (a[0] + ox * 0.08, a[1] + oz * 0.08, eave_y - 0.07)
    pb = (b[0] + ox * 0.08, b[1] + oz * 0.08, eave_y - 0.07)
    tube("hs_trim", pa, pb, 0.065, col, seg=5, half=True)
    box_along("hs_trim", (pa[0] + ox * 0.065, pa[1] + oz * 0.065, pa[2] + 0.01), (pb[0] + ox * 0.065, pb[1] + oz * 0.065, pb[2] + 0.01), 0.018, 0.03, col)


def downpipe(x, z, top_y, out, col="#8a8e90", wall=0.06):
    """A round downpipe against the wall at (x, z), from the gutter (top_y) down to the ground, with a swan neck
    out to the gutter and two clamps."""
    ox, oz = out
    bx, bz = x + ox * wall, z + oz * wall
    base = gy(x, z)
    tube("hs_trim", (bx, bz, base + 0.02), (bx, bz, top_y - 0.45), 0.04, col, seg=7)
    gx_, gz_ = x + ox * 0.32, z + oz * 0.32
    tube("hs_trim", (bx, bz, top_y - 0.45), (gx_, gz_, top_y - 0.2), 0.04, col, seg=7)
    tube("hs_trim", (gx_, gz_, top_y - 0.2), (gx_, gz_, top_y - 0.07), 0.04, col, seg=7)
    tube("hs_trim", (bx, bz, base + 0.02), (bx + ox * 0.12, bz + oz * 0.12, base + 0.02), 0.042, col, seg=7)  # the shoe
    for y in (base + 0.9, top_y - 1.4):
        if y < top_y - 0.6:
            box_along("hs_trim", (bx - ox * 0.06, bz - oz * 0.06, y), (bx + ox * 0.045, bz + oz * 0.045, y), 0.1, 0.03, col)


def gable_roof(c0, c1, c2, c3, eave, ridge, tiles, over=0.3, verge=0.18, th=0.18, fascia="#3a3c3f",
               soffit="#e8e6e1", gutter="#8a8e90", pipes=(), ridge_col=None, verge_col=None, skip_gutter=()):
    """A gable roof over the quad c0 c1 c2 c3 (plan points), the ridge along c0-c1 (and c3-c2): eaves at model
    height `eave` along c0-c1 and c2-c3, the ridge at `ridge`; `over` beyond the eave walls, `verge` past the
    gables. Tiles on top, a fascia and a soffit, verge boards, ridge tiles, gutters and downpipes (`pipes`:
    (side 0 or 1, s along)). Returns a function giving the roof's surface (s along, k across) as a game point."""
    c0, c1, c2, c3 = map(Vector, (c0, c1, c2, c3))
    L = (c1 - c0).length
    Wd = (c3 - c0).length
    t = (c1 - c0).normalized()
    n = (c3 - c0).normalized()
    slope = (ridge - eave) / (Wd / 2)

    def P(s, k, lift=0.0):
        q = c0 + t * s + n * k
        y = eave + (k if k <= Wd / 2 else Wd - k) * slope
        return (q.x, q.y, y + lift)
    s0, s1 = -verge, L + verge
    for k0, k1, side in ((-over, Wd / 2, 0), (Wd + over, Wd / 2, 1)):
        # Top (tiles), from the eave edge up to the ridge.
        top = [P(s0, k0, th), P(s1, k0, th), P(s1, k1, th), P(s0, k1, th)]
        quad_tile_slope(top, tiles)
        bot = [P(s0, k0), P(s1, k0), P(s1, k1), P(s0, k1)]
        face("hs_trim", bot, (0, 0, -1), soffit)
        # The fascia board along the eave, the verge boards along both rakes.
        ox, oz = (-n.x, -n.y) if side == 0 else (n.x, n.y)
        face("hs_trim", [P(s0, k0, -0.04), P(s1, k0, -0.04), P(s1, k0, th + 0.02), P(s0, k0, th + 0.02)], (ox, oz, 0), fascia)
        for s, sgn in ((s0, -1), (s1, 1)):
            face("hs_trim", [P(s, k0, -0.04), P(s, k1, -0.04), P(s, k1, th + 0.04), P(s, k0, th + 0.04)], (t.x * sgn, t.y * sgn, 0), verge_col or fascia)
            face("hs_trim", [P(s, k0, th + 0.04), P(s, k1, th + 0.04), P(s - sgn * 0.03, k1, th + 0.04), P(s - sgn * 0.03, k0, th + 0.04)], (0, 0, 1), verge_col or fascia)
        if side not in skip_gutter:
            ea = c0 + n * k0 + t * s0 if side == 0 else c0 + n * k0 + t * s0
            eb = c0 + n * k0 + t * s1
            gutter_run((ea.x, ea.y), (eb.x, eb.y), (ox, oz), eave - over * slope, gutter)
            for sd, s in pipes:
                if sd != side:
                    continue
                w = c0 + t * s + (n * 0 if side == 0 else n * Wd)
                downpipe(w.x, w.y, eave - over * slope, (ox, oz), gutter)
    # Ridge tiles: a rounded cap along the ridge.
    a = P(s0 - 0.02, Wd / 2, th + 0.02)
    b = P(s1 + 0.02, Wd / 2, th + 0.02)
    tube("hs_tiles", a, b, 0.13, ridge_col or tiles, seg=8, half=False, roll=0.0)
    return P


def hip_roof(c0, c1, c2, c3, eave, ridge, tiles, over=0.35, th=0.16, fascia="#e8e6e1", soffit="#efede8",
             gutter="#8a8e90", pipes=(), ridge_col=None):
    """A hip roof over the quad (the ridge along c0-c1, the longer side): four slopes at the same pitch, ridge
    and hip tiles, fascia, soffits, gutters on all four eaves; `pipes`: corner numbers (0..3) for downpipes."""
    c0, c1, c2, c3 = map(Vector, (c0, c1, c2, c3))
    L = (c1 - c0).length
    Wd = (c3 - c0).length
    t = (c1 - c0).normalized()
    n = (c3 - c0).normalized()
    slope = (ridge - eave) / (Wd / 2)
    half = Wd / 2
    e0 = eave - over * slope

    def Q(s, k, y):
        q = c0 + t * s + n * k
        return (q.x, q.y, y)
    E = [Q(-over, -over, e0), Q(L + over, -over, e0), Q(L + over, Wd + over, e0), Q(-over, Wd + over, e0)]
    R0, R1 = Q(half, half, ridge), Q(L - half, half, ridge)
    lift = lambda p, d=th: (p[0], p[1], p[2] + d)
    slopes = [([E[0], E[1], R1, R0], (-n.x, -n.y)), ([E[2], E[3], R0, R1], (n.x, n.y)), ([E[3], E[0], R0], (-t.x, -t.y)), ([E[1], E[2], R1], (t.x, t.y))]
    for pts, o in slopes:
        quad_tile_slope([lift(p) for p in pts], tiles)
        face("hs_trim", pts, (0, 0, -1), soffit)
        a, b = pts[0], pts[1]
        face("hs_trim", [lift(a, -0.04), lift(b, -0.04), lift(b, th + 0.02), lift(a, th + 0.02)], (o[0], o[1], 0), fascia)
        ox, oz = o
        gutter_run((a[0], a[1]), (b[0], b[1]), (ox, oz), e0, gutter)
    rc = ridge_col or tiles
    tube("hs_tiles", lift(R0, 0.02), lift(R1, 0.02), 0.12, rc, seg=8)
    for e, r in ((E[0], R0), (E[3], R0), (E[1], R1), (E[2], R1)):
        tube("hs_tiles", lift(e, 0.02), lift(r, 0.02), 0.1, rc, seg=6)
    corners = [c0, c1, c2, c3]
    outs = [(-t - n), (t - n), (t + n), (-t + n)]
    for i in pipes:
        o = outs[i].normalized()
        cn = corners[i]
        # Beside the corner, on the long side.
        side = -n if i in (0, 1) else n
        along = t if i in (0, 3) else -t
        p = cn + along * 0.35
        downpipe(p.x, p.y, e0, (side.x, side.y), gutter)

    def surface(s, k):
        """Height of the slope at (s along, k across) for things on the roof (on the long slopes)."""
        kk = k if k <= half else Wd - k
        return eave + kk * slope + th
    return surface


def flat_roof(ring, y, coping="#9a9da0", deck="#3a3a3a", w=0.3, h=0.08):
    """A flat roof over an outline: the deck a little below the coping, the coping proud of the walls."""
    cx = sum(p[0] for p in ring) / len(ring)
    cz = sum(p[1] for p in ring) / len(ring)
    face("hs_trim", [(x, z, y - 0.05) for x, z in ring], (0, 0, 1), deck)
    for a, b in zip(ring, ring[1:] + ring[:1]):
        f = Frame(a, b, (cx, cz), base=0.0)
        f.box("hs_trim", -0.03, f.L + 0.03, y - h, y + 0.02, -w + 0.03, 0.04, coping)


def solar(P, s0, k0, cols, rows, side, pw=1.03, ph=1.72, gap=0.03, frame="#22252a"):
    """Solar panels on a gable roof's slope (P from gable_roof: s along, k across from the eave of side 0 or
    side 1), lifted 10 cm, in a grid of cols x rows, k0 from the eave, s0 from the roof's start."""
    for i in range(cols):
        for j in range(rows):
            a = s0 + i * (pw + gap)
            b = a + pw
            k_a = k0 + j * (ph + gap)
            k_b = k_a + ph
            if side == 1:  # measured from the other eave
                k_a, k_b = WD_CUR[0] - k_b, WD_CUR[0] - k_a
            pts = [P(a, k_a, 0.28), P(b, k_a, 0.28), P(b, k_b, 0.28), P(a, k_b, 0.28)]
            face("hs_glass", pts, (0, 0, 1), "#141a24")
            # The frame round it and its edge down towards the tiles.
            for (q0, q1) in ((0, 1), (1, 2), (2, 3), (3, 0)):
                p0, p1 = Vector(pts[q0]), Vector(pts[q1])
                box_along("hs_trim", tuple(p0 - Vector((0, 0, 0.02))), tuple(p1 - Vector((0, 0, 0.02))), 0.035, 0.05, frame)


WD_CUR = [0.0]


def rooflight(P, s0, k0, w=0.78, h=1.18, side=0):
    k_a, k_b = k0, k0 + h
    if side == 1:
        k_a, k_b = WD_CUR[0] - k_b, WD_CUR[0] - k_a
    pts = [P(s0, k_a, 0.24), P(s0 + w, k_a, 0.24), P(s0 + w, k_b, 0.24), P(s0, k_b, 0.24)]
    face("hs_glass", pts, (0, 0, 1), "#202a33")
    for (q0, q1) in ((0, 1), (1, 2), (2, 3), (3, 0)):
        p0, p1 = Vector(pts[q0]), Vector(pts[q1])
        box_along("hs_trim", tuple(p0), tuple(p1), 0.07, 0.07, "#4d5054")


def chimney(x, z, w, d, y0, y1, mat, col, cap="#9b9894", yaw=0.0):
    """A brick chimney stack with a concrete cap and a flue pot."""
    c, s = math.cos(yaw), math.sin(yaw)
    ring = [(x + c * a - s * b, z + s * a + c * b) for a, b in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2))]
    for a, b in zip(ring, ring[1:] + ring[:1]):
        f = Frame(a, b, (x, z), base=0.0)
        face(mat, [f.p(0, y0), f.p(f.L, y0), f.p(f.L, y1), f.p(0, y1)], f.out(), col, 0.5)
    big = [(x + c * a - s * b, z + s * a + c * b) for a, b in ((-w / 2 - 0.05, -d / 2 - 0.05), (w / 2 + 0.05, -d / 2 - 0.05), (w / 2 + 0.05, d / 2 + 0.05), (-w / 2 - 0.05, d / 2 + 0.05))]
    ring_prism("hs_trim", big, y1, y1 + 0.08, cap)
    tube("hs_trim", (x, z, y1 + 0.08), (x, z, y1 + 0.32), 0.09, "#8c4a35", seg=8)


def flue(x, z, y0, y1, col="#b9bcbe"):
    """A stainless steel flue through the roof with a rain cap."""
    tube("hs_trim", (x, z, y0), (x, z, y1), 0.1, col, seg=10)
    tube("hs_trim", (x, z, y1 + 0.06), (x, z, y1 + 0.14), 0.17, col, seg=10)
    tube("hs_trim", (x, z, y0 - 0.02), (x, z, y0 + 0.05), 0.2, "#3b3d40", seg=10)  # the flashing collar


# ---------------------------------------------------------------- garden things
BLOCKS = {}  # cluster -> solid blocks for the game's collision


def block(kind, ring, y0, y1):
    BLOCKS.setdefault(Cur.name, []).append({"m": kind, "y0": round(y0, 3), "y1": round(y1, 3), "p": [[[round(x, 3), round(z, 3)] for x, z in ring]]})


def rect(cx, cz, w, d, yaw):
    c, s = math.cos(yaw), math.sin(yaw)
    return [(cx + c * a - s * b, cz + s * a + c * b) for a, b in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2))]


def pillar(x, z, w, h, yaw, mat, col, cap=SILL, solid_block=True):
    base = gy(x, z)
    r = rect(x, z, w, w, yaw)
    ring_prism(mat, r, base - 0.2, base + h, col, top=False)
    ring_prism("hs_trim", rect(x, z, w + 0.08, w + 0.08, yaw), base + h, base + h + 0.08, cap)
    if solid_block:
        block("stone", r, base - 0.2, base + h + 0.08)


def bar_fence(a, b, h=1.1, col="#5f6366", plinth=0.25, spacing=0.12, post=2.4, solid_block=True):
    """A steel bar fence on a low concrete plinth from plan point a to b: posts, top and bottom rails, bars."""
    f = Frame(a, b, (a[0] - (b[1] - a[1]), a[1] + (b[0] - a[0])), base=None)
    base = min(gy(*a), gy(*b))
    f.base = base
    if plinth:
        f.box("hs_trim", 0, f.L, -0.15, plinth, -0.05, 0.05, "#a19e97")
    n = max(1, int(f.L / post))
    for i in range(n + 1):
        s = f.L * i / n
        f.box("hs_trim", s - 0.035, s + 0.035, plinth, plinth + h + 0.05, -0.035, 0.035, col)
    for y in (plinth + 0.1, plinth + h - 0.06):
        f.box("hs_trim", 0, f.L, y - 0.02, y + 0.02, -0.02, 0.02, col)
    k = int(f.L / spacing)
    for i in range(1, k):
        s = f.L * i / k
        f.box("hs_trim", s - 0.009, s + 0.009, plinth + 0.08, plinth + h - 0.04, -0.009, 0.009, col)
    if solid_block:
        o = f.out(0.08)
        ring = [(a[0] - o[0], a[1] - o[1]), (b[0] - o[0], b[1] - o[1]), (b[0] + o[0], b[1] + o[1]), (a[0] + o[0], a[1] + o[1])]
        block("fence", ring, base - 0.15, base + plinth + h)


def letterbox(x, z, yaw, col="#33373b"):
    base = gy(x, z)
    ring_prism("hs_trim", rect(x, z, 0.07, 0.07, yaw), base, base + 1.0, col)
    ring_prism("hs_trim", rect(x, z + 0.0, 0.36, 0.3, yaw), base + 0.98, base + 1.36, col)
    ring_prism("hs_trim", rect(x, z, 0.4, 0.34, yaw), base + 1.36, base + 1.4, "#2a2d30")


def wall_lamp(f, s, y, col="#2b2d30"):
    f.box("hs_trim", s - 0.07, s + 0.07, y - 0.12, y + 0.12, 0, 0.03, col)
    f.box("hs_trim", s - 0.06, s + 0.06, y - 0.1, y + 0.1, 0.03, 0.15, "#d9d4c4")
    f.box("hs_trim", s - 0.075, s + 0.075, y + 0.1, y + 0.14, 0.02, 0.17, col)


REPLACE = {}  # cluster -> GRB outlines (the game stops drawing what stands inside them)
CLEAR = {}  # cluster -> outlines of open-data paving the game stops drawing (a terrace of ours lies there)


def replaces(*rings):
    REPLACE.setdefault(Cur.name, []).extend([[[round(x, 3), round(z, 3)] for x, z in r] for r in rings])


def clears(*rings):
    CLEAR.setdefault(Cur.name, []).extend([[[round(x, 3), round(z, 3)] for x, z in r] for r in rings])


def shrub(x, z, r, h, col, seed):
    """A clipped shrub: a squashed, slightly irregular ball on the ground."""
    rng = np.random.default_rng(seed)
    base = gy(x, z)
    pts = []
    for i in range(1, 4):
        t = math.pi * i / 4
        for k in range(7):
            a = 2 * math.pi * (k + 0.5 * i) / 7
            f = 1 + rng.normal(0, 0.07)
            pts.append((x + r * f * math.sin(t) * math.cos(a), z + r * f * math.sin(t) * math.sin(a), base + h / 2 - h / 2 * math.cos(t)))
    pts += [(x, z, base - 0.02), (x, z, base + h)]
    solid("hs_trim", pts, col)


# ================================================================ the houses
# Colours (sRGB): the tints multiply our textures, which are light.
BRICK_BROWN = "#9d9188"     # the new-build across the lane: brown-grey wire-cut
BRICK_DARK = "#575859"      # dark plinths
RENDER_CREAM = "#f3e7c9"
RENDER_LIGHT = "#efe9da"
TIMBER = "#bdb4a8"          # weathered vertical boards
TILES_DARK = "#4a4d52"
ANTHRACITE = "#35383b"
FRAME_GREY = "#7a7e76"


def corner_across():
    """The corner house across the lane from the main house: a new two-storey house of brown-grey brick with
    its gable to the lane rendered cream and clad in timber at the top, a garage wing behind it, a flat-roofed
    link in cream render along the lane, and an older barn of red-brown brick with solar panels next to the
    house portal (GRB outlines; Street View, April 2023)."""
    # The main house: x 13.1 to 21.6, z 21.0 to 30.2, eaves 5.99, ridge 10.25 (the ridge runs away from the lane).
    a, b, c, d = (13.15, 20.98), (13.10, 30.17), (21.59, 30.22), (21.65, 21.03)
    centre = (17.37, 25.6)
    E, R = 5.99, 10.25
    base = gy(*centre)
    lane = Frame(a, d, centre, base)        # the gable to the lane, facing -z
    east = Frame(d, c, centre, base)        # the long side to the side road, facing +x
    back = Frame(c, b, centre, base)        # the gable behind (mostly against the garage wing)
    west = Frame(b, a, centre, base)        # facing the inner yard and the link
    eh = E - base
    rh = R - base
    plinth = (0.45, "hs_brick_buff", BRICK_DARK)
    # The lane gable: cream render up to the eaves, timber boards in the gable triangle.
    facade(lane, eh, [W(1.55, 1.15, 0.95, 1.75, frame=FRAME_GREY), W(6.6, 0.9, 3.55, 4.75, frame=FRAME_GREY)], "hs_render", RENDER_CREAM)
    tri = Frame(a, d, centre, base)
    facade(tri, [(0, eh), (tri.L / 2, rh), (tri.L, eh)], [W(tri.L / 2, 0.7, eh + 1.0, eh + 2.25, frame=ANTHRACITE, sill=False)], "hs_wood", TIMBER, from_y=eh)
    # The side road's facade: brick on a dark plinth; ground floor a window, the front door, a narrow window;
    # three windows upstairs.
    facade(east, eh, [
        W(1.75, 1.6, 0.85, 2.25, frame=ANTHRACITE, transom=None),
        Hole(3.35, 4.35, 0.0, 2.3, kind="door", frame=ANTHRACITE, leaf="#4a4d50"),
        W(5.45, 0.8, 0.55, 2.25, frame=ANTHRACITE),
        W(7.75, 1.2, 0.85, 2.25, frame=ANTHRACITE),
        W(1.75, 1.3, 3.45, 4.95, frame=ANTHRACITE),
        W(4.75, 0.9, 3.65, 4.95, frame=ANTHRACITE),
        W(7.25, 0.9, 3.65, 4.95, frame=ANTHRACITE),
    ], "hs_brick_buff", BRICK_BROWN, plinth=plinth)
    wall_lamp(east, 4.6, 2.1)
    # The back gable: brick, the lower part hidden by the garage wing (its roof reaches 7.95).
    facade(back, [(0, eh), (back.L / 2, rh), (back.L, eh)], [], "hs_brick_buff", BRICK_BROWN, from_y=3.8)
    # Towards the yard: render above the link's roof, a window upstairs and one downstairs past the link.
    facade(west, eh, [W(3.2, 1.0, 3.6, 4.8, frame=FRAME_GREY), W(1.6, 1.2, 0.9, 2.1, frame=FRAME_GREY)], "hs_render", RENDER_CREAM, from_y=None)
    P = gable_roof(a, b, c, d, E, R, TILES_DARK, over=0.35, verge=0.12, fascia="#3b3e41", soffit="#3b3e41", pipes=((1, 0.4), (0, 8.8)), verge_col="#3b3e41")
    WD_CUR[0] = math.dist(a, d)
    # Solar panels and a roof window on the slope to the side road (side 1, x > 17.4), a steel flue at the ridge.
    solar(P, 2.6, 0.5, 5, 2, side=1)
    rooflight(P, 0.6, 1.1, side=1)
    rooflight(P, 6.0, 1.4, side=0)
    flue(17.3, 23.8, R - 0.05, R + 1.0)

    # The garage wing behind: x 13.1 to 21.6, z 30.2 to 37.7, eaves 3.98, ridge 7.95, the same brick.
    a2, b2, c2, d2 = (13.10, 30.17), (13.05, 37.68), (21.55, 37.73), (21.59, 30.22)
    centre2 = (17.32, 33.95)
    base2 = gy(*centre2)
    E2, R2 = 3.98, 7.95
    e2, r2 = E2 - base2, R2 - base2
    east2 = Frame(d2, c2, centre2, base2)
    back2 = Frame(c2, b2, centre2, base2)
    west2 = Frame(b2, a2, centre2, base2)
    facade(east2, e2, [Hole(0.7, 3.2, 0.0, 2.25, kind="garage", frame=ANTHRACITE, leaf="#3a3d40"), W(5.2, 0.9, 1.0, 2.1, frame=ANTHRACITE)], "hs_brick_buff", BRICK_BROWN, plinth=plinth)
    facade(back2, [(0, e2), (back2.L / 2, r2), (back2.L, e2)], [W(2.2, 1.4, 0.9, 2.1, frame=ANTHRACITE), W(back2.L / 2, 0.8, 4.4, 5.4, frame=ANTHRACITE)], "hs_brick_buff", BRICK_BROWN, plinth=plinth)
    facade(west2, e2, [Hole(1.4, 2.4, 0.0, 2.2, kind="door", frame=ANTHRACITE, leaf="#4a4d50"), W(4.6, 1.6, 0.9, 2.1, frame=ANTHRACITE)], "hs_brick_buff", BRICK_BROWN, plinth=plinth)
    gable_roof(a2, b2, c2, d2, E2, R2, "#55585c", over=0.3, verge=0.12, fascia="#3b3e41", soffit="#3b3e41", pipes=((1, 7.0), (0, 7.0)), verge_col="#3b3e41")
    east.box("hs_trim", 2.75, 3.15, 0.95, 1.3, 0.0, 0.12, "#3a3d40")  # a letterbox in the wall by the door

    # The link along the lane: x 6.9 to 13.1, z 21.0 to 26.1, a flat roof at 2.87 with an aluminium coping.
    ring = [(6.86, 20.953), (13.15, 20.986), (13.12, 26.13), (6.86, 26.12)]
    cl = (10.0, 23.5)
    bl = gy(*cl)
    top = 2.87 + 0.25 - bl
    lane_l = Frame(ring[0], ring[1], cl, bl)
    yard_l = Frame(ring[2], ring[3], cl, bl)
    facade(lane_l, top, [W(3.15, 0.95, 1.0, 2.15, frame=FRAME_GREY, depth=0.2)], "hs_render", RENDER_LIGHT, plinth=(0.3, "hs_render", "#d9d2c0"))
    facade(yard_l, top, [Hole(1.0, 3.6, 0.0, 2.3, kind="glazed", frame=ANTHRACITE, cols=3)], "hs_render", RENDER_LIGHT)
    flat_roof(ring, 2.87 + 0.25, coping="#8e9294")
    # The outdoor unit of a heat pump on the roof by the house, and a downpipe from the roof to the lane.
    ring_prism("hs_trim", rect(12.55, 21.75, 0.85, 0.35, 0.0), 3.12, 3.72, "#e6e6e2")
    downpipe(7.4, 20.953, 3.0, (0, -1), "#e9e8e4")

    # The barn: x 2.3 to 6.9, z 20.9 to 31.1, eaves 3.81, ridge 6.09 (the ridge runs away from the lane).
    a3, b3, c3, d3 = (6.86, 20.95), (6.81, 31.16), (2.31, 31.13), (2.36, 20.93)
    centre3 = (4.58, 26.04)
    base3 = gy(*centre3)
    E3, R3 = 3.81, 6.09
    e3, r3 = E3 - base3, R3 - base3
    lane3 = Frame(d3, a3, centre3, base3)
    west3 = Frame(c3, d3, centre3, base3)
    back3 = Frame(b3, c3, centre3, base3)
    east3 = Frame(a3, b3, centre3, base3)
    facade(lane3, e3, [], "hs_render", RENDER_CREAM, plinth=(0.3, "hs_render", "#d8ccae"))
    facade(Frame(d3, a3, centre3, base3), [(0, e3), (lane3.L / 2, r3), (lane3.L, e3)], [], "hs_wood", TIMBER, from_y=e3)
    BRICK_OLD = "#9c8279"
    facade(west3, e3, [W(2.4, 0.8, 1.15, 2.0, frame="#6d6f6c"), Hole(5.0, 5.95, 0.0, 2.1, kind="door", frame="#5c5f61", leaf="#8a8d8f"), W(8.0, 0.8, 1.15, 2.0, frame="#6d6f6c")], "hs_brick_red", BRICK_OLD)
    facade(back3, [(0, e3), (back3.L / 2, r3), (back3.L, e3)], [W(back3.L / 2, 0.7, 1.2, 2.0, frame="#6d6f6c")], "hs_brick_red", BRICK_OLD)
    facade(east3, e3, [Hole(6.2, 7.1, 0.0, 2.1, kind="door", frame="#5c5f61", leaf="#8a8d8f")], "hs_brick_red", BRICK_OLD, from_y=None)
    P3 = gable_roof(a3, b3, c3, d3, E3, R3, "#3f4246", over=0.3, verge=0.15, fascia="#2f3134", soffit="#2f3134", gutter="#e9e8e4", pipes=((1, 9.6),), verge_col="#2f3134")
    WD_CUR[0] = math.dist(a3, d3)
    solar(P3, 0.5, 0.35, 5, 1, side=0, pw=1.72, ph=1.03)
    solar(P3, 0.5, 1.45, 5, 1, side=0, pw=1.72, ph=1.03)
    solar(P3, 0.5, 0.35, 5, 1, side=1, pw=1.72, ph=1.03)
    replaces(
        [(2.36, 21.53), (2.31, 31.13), (6.85, 31.14), (6.86, 26.12), (12.84, 26.13), (12.73, 37.67), (21.55, 37.73), (21.58, 32.96), (21.65, 21.03), (19.65, 21.02), (2.36, 20.93)],
    )


def bung_west():
    """The bungalow's neighbour on its west side: a red brick bungalow under a hip roof of orange-red clay
    pantiles with its chimney at the ridge, a round-headed front door in a white stone surround, light grey
    frames on bluestone sills, a conservatory on the side towards the field, flat-roofed rooms behind, and in
    front a lawn behind a steel bar fence on a low plinth with brick pillars at the gate (Street View, April
    2023; GRB; the orthophoto shows the conservatory's glass roof)."""
    c0, c1, c2, c3 = (70.13, 167.91), (60.22, 179.70), (67.30, 185.65), (77.21, 173.86)
    centre = (68.715, 176.78)
    base = gy(*centre)
    E, R = 3.25, 6.28
    eh = E - base - 0.05
    FR = "#b9b6ae"
    BR = "#e9dcd6"   # a touch lighter than the texture: the photo's brick is orange-red
    front = Frame(c3, c0, centre, base)     # to the road (9.25 m)
    side_w = Frame(c0, c1, centre, base)    # towards the conservatory and the field (15.4 m)
    back = Frame(c1, c2, centre, base)
    side_e = Frame(c2, c3, centre, base)    # towards the bungalow's parking, behind the hedge
    facade(front, eh, [
        W(0.8, 0.55, 1.15, 1.85, frame=FR),
        Hole(1.65, 2.55, 0.0, 2.05, kind="door", frame="#6f7275", leaf="#6f7275", arch=True, surround="#ece8df"),
        W(3.3, 0.5, 1.0, 1.85, frame=FR),
        W(4.95, 1.45, 0.9, 2.2, frame=FR),
        W(7.15, 1.45, 0.9, 2.2, frame=FR),
    ], "hs_brick_red", BR, plinth=(0.3, "hs_brick_red", "#b9a29b"))
    wall_lamp(front, 1.25, 1.95, "#2a2b2d")
    wall_lamp(front, 2.95, 1.95, "#2a2b2d")
    facade(side_w, eh, [W(5.2, 1.2, 0.9, 2.2, frame=FR), W(9.0, 1.2, 0.9, 2.2, frame=FR)], "hs_brick_red", BR, plinth=(0.3, "hs_brick_red", "#b9a29b"))
    facade(back, eh, [W(3.0, 1.2, 0.9, 2.1, frame=FR)], "hs_brick_red", BR, from_y=2.3 - base)
    facade(side_e, eh, [W(3.0, 1.0, 1.0, 2.1, frame=FR), W(7.5, 1.4, 0.9, 2.2, frame=FR), W(11.6, 0.6, 1.4, 2.0, frame=FR)], "hs_brick_red", BR, plinth=(0.3, "hs_brick_red", "#b9a29b"))
    TILE_RED = "#b5532f"
    hip_roof(c0, c1, c2, c3, E, R, TILE_RED, over=0.35, fascia="#f0eeea", soffit="#f2f0ec", pipes=(0, 3), ridge_col="#b85d3c")
    chimney(68.715, 176.78, 0.55, 0.55, R - 0.6, R + 0.75, "hs_brick_red", BR)
    # The conservatory on the field side: aluminium posts, glass walls, a glass roof sloping out.
    cons = [(64.997, 174.019), (61.66, 172.63), (58.5, 176.31), (58.72, 177.88), (60.17, 179.02)]
    cb = gy(62, 176)
    ALU = "#4a4d50"
    cc = (62.0, 176.4)
    for p, q in zip(cons, cons[1:]):
        f = Frame(p, q, cc, cb)
        f.flat("hs_glass", 0, f.L, 0.25, 2.25, 0.0, "#7d8c96")
        f.box("hs_trim", 0, f.L, 0.0, 0.25, -0.04, 0.02, "#d8d4cc")
        n = max(1, round(f.L / 1.0))
        for i in range(n + 1):
            s = f.L * i / n
            f.box("hs_trim", max(0, s - 0.03), min(f.L, s + 0.03), 0.25, 2.3, -0.03, 0.03, ALU)
        f.box("hs_trim", 0, f.L, 2.22, 2.32, -0.05, 0.03, ALU)
        f.box("hs_trim", 0, f.L, 1.0, 1.04, -0.02, 0.02, ALU)
    face("hs_glass", [(x, z, cb + 2.36) for x, z in cons], (0, 0, 1), "#8c9aa2")
    # The flat-roofed rooms behind, in the same brick (GRB, roof at 2.2 to 2.4).
    rear = [(60.09, 179.787), (56.449, 184.118), (63.638, 190.242), (67.511, 185.631)]
    rc = (61.9, 185.0)
    rb = gy(*rc)
    for p, q, holes in ((rear[0], rear[1], [W(2.2, 1.2, 0.9, 2.0, frame=FR)]), (rear[1], rear[2], [Hole(2.0, 2.9, 0.0, 2.1, kind="door", frame=FR, leaf="#d6d3cc"), W(5.4, 1.6, 0.9, 2.1, frame=FR)]), (rear[2], rear[3], [W(3.0, 1.0, 1.0, 2.0, frame=FR)])):
        facade(Frame(p, q, rc, rb), 2.42 - rb, holes, "hs_brick_red", BR)
    flat_roof(rear, 2.45, coping="#c9c6bf")
    # In front: a lawn behind a steel bar fence on a plinth, two brick pillars with bluestone caps at the gate,
    # the gate itself, a paved path to the door (the paving round the house is the game's own).
    # The road's edge runs through (69.5, 158.5) along (0.774, 0.633); the fence stands 0.7 m in from it.
    fp = lambda s: (69.06 + 0.774 * s, 159.04 + 0.633 * s)
    bar_fence(fp(1.2), fp(10.25))
    bar_fence(fp(12.05), fp(13.0))
    yaw = math.atan2(0.633, 0.774)
    for s in (10.45, 11.85):
        pillar(*fp(s), 0.38, 1.25, yaw, "hs_brick_red", BR)
    gate = Frame(fp(10.65), fp(11.65), (70.0, 172.0), None)
    gate.base = gy(*fp(11.15))
    for y in (0.12, 1.08):
        gate.box("hs_trim", 0.03, gate.L - 0.03, y - 0.025, y + 0.025, -0.02, 0.02, "#5f6366")
    for i in range(8):
        s = 0.06 + (gate.L - 0.12) * i / 7
        gate.box("hs_trim", s - 0.012, s + 0.012, 0.1, 1.1, -0.012, 0.012, "#5f6366")
    # The letterbox built into the gate's right pillar, its flap to the road.
    px, pz = fp(11.85)
    ring_prism("hs_trim", rect(px + 0.633 * 0.2, pz - 0.774 * 0.2, 0.3, 0.06, yaw), gy(px, pz) + 0.75, gy(px, pz) + 1.05, "#2f3236")
    replaces([(60.22, 179.7), (70.13, 167.91), (77.21, 173.86), (67.3, 185.65)], cons, rear,
             [(67.4, 185.53), (77.21, 173.86), (70.15, 167.92), (65.01, 174.03), (63.52, 172.71), (61.66, 172.63), (58.5, 176.31),
              (58.72, 177.88), (60.17, 179.02), (59.86, 179.39), (60.3, 179.77), (56.66, 184.1), (63.62, 190.03)])


def beyond_hedge():
    """The house across the side road from the main house's garden, seen over the hedge from the house portal:
    one and a half storeys of light yellow-beige brick on a dark plinth, its gable to the lane, anthracite
    frames, a dark tiled roof; a small cross-gabled wing on the far side and a long lean-to shed behind
    (GRB outlines, the laser scan's heights; Street View, April 2023)."""
    YB = "#e2d2ad"
    c0, c1, c2, c3 = (39.31, 2.79), (37.26, -5.46), (29.98, -3.65), (32.04, 4.6)
    centre = (34.65, -0.43)
    base = gy(*centre)
    E, R = 3.45, 7.87
    eh, rh = E - base, R - base
    plinth = (0.4, "hs_brick_buff", BRICK_DARK)
    front = Frame(c3, c0, centre, base)   # the gable to the lane (+z)
    west = Frame(c2, c3, centre, base)    # along the side road (-x)
    east = Frame(c0, c1, centre, base)
    back = Frame(c1, c2, centre, base)
    facade(front, eh, [W(1.55, 1.5, 0.85, 2.25, frame=ANTHRACITE), Hole(3.3, 4.3, 0.0, 2.3, kind="door", frame=ANTHRACITE, leaf="#3f4245"),
                       W(5.9, 1.5, 0.85, 2.25, frame=ANTHRACITE)], "hs_brick_buff", YB, plinth=plinth)
    facade(Frame(c3, c0, centre, base), [(0, eh), (front.L / 2, rh), (front.L, eh)],
           [W(2.6, 0.9, eh + 0.5, eh + 1.6, frame=ANTHRACITE), W(front.L - 2.6, 0.9, eh + 0.5, eh + 1.6, frame=ANTHRACITE)], "hs_brick_buff", YB, from_y=eh)
    facade(west, eh, [W(1.6, 1.2, 0.85, 2.25, frame=ANTHRACITE), W(4.4, 1.2, 0.85, 2.25, frame=ANTHRACITE), W(7.0, 0.9, 1.1, 2.25, frame=ANTHRACITE)],
           "hs_brick_buff", YB, plinth=plinth)
    facade(east, eh, [W(1.7, 1.2, 0.85, 2.25, frame=ANTHRACITE)], "hs_brick_buff", YB, plinth=plinth)
    facade(back, [(0, eh), (back.L / 2, rh), (back.L, eh)], [W(back.L / 2, 0.9, eh + 0.5, eh + 1.5, frame=ANTHRACITE)], "hs_brick_buff", YB, from_y=2.2 - base)
    P = gable_roof(c0, c1, c2, c3, E, R, "#4d5056", over=0.3, verge=0.15, fascia="#34373a", soffit="#34373a", pipes=((0, 0.5), (1, 0.5)), verge_col="#34373a")
    WD_CUR[0] = math.dist(c0, c3)
    rooflight(P, 2.0, 1.2, side=1)
    rooflight(P, 5.0, 1.2, side=1)
    # The wing on the far side: a cross gable, eaves 3.8, ridge 6.92.
    w0, w1, w2, w3 = (40.29, -6.22), (37.26, -5.46), (38.5, -0.49), (41.53, -1.24)
    wc = (39.4, -3.35)
    wb = gy(*wc)
    for a, b, holes, top in (
        (w3, w0, [W(2.55, 1.4, 0.85, 2.2, frame=ANTHRACITE)], "gable"),
        (w0, w1, [], 3.8 - wb),
        (w2, w3, [W(1.5, 0.9, 1.0, 2.2, frame=ANTHRACITE)], 3.8 - wb),
    ):
        f = Frame(a, b, wc, wb)
        if top == "gable":
            facade(f, [(0, 3.8 - wb), (f.L / 2, 6.92 - wb), (f.L, 3.8 - wb)], holes, "hs_brick_buff", YB, plinth=plinth)
        else:
            facade(f, top, holes, "hs_brick_buff", YB, plinth=plinth)
    gable_roof(w1, w0, w3, w2, 3.8, 6.92, "#4d5056", over=0.3, verge=0.15, fascia="#34373a", soffit="#34373a", pipes=(), verge_col="#34373a")
    # The lean-to shed behind: low eaves (2.2) against the house, high (6.44) at the back, the same brick.
    s0, s1, s2, s3 = (29.98, -3.65), (44.33, -7.22), (41.67, -17.94), (27.32, -14.37)
    sc = (35.8, -10.8)
    sb = gy(*sc)
    low, high = 2.2 - sb, 6.44 - sb
    Ls = math.dist(s1, s2)
    for a, b, top, holes in (
        (s1, s2, [(0, low), (Ls, high)], [Hole(1.5, 4.5, 0.0, 2.6, kind="garage", frame="#5b5e60", leaf="#8d9093")]),
        (s2, s3, high, [W(3.0, 1.0, 2.6, 3.4, frame=ANTHRACITE), W(10.0, 1.0, 2.6, 3.4, frame=ANTHRACITE)]),
        (s3, s0, [(0, high), (Ls, low)], []),
        (s0, s1, low, []),
    ):
        facade(Frame(a, b, sc, sb), top, holes, "hs_brick_buff", "#d2c6aa", plinth=plinth)
    # Its roof: one slope, a little overhang, tiles.
    o = 0.25
    t = Vector((s1[0] - s0[0], s1[1] - s0[1])).normalized()
    n = Vector((s3[0] - s0[0], s3[1] - s0[1])).normalized()
    D = math.dist(s0, s3)
    k = (6.44 - 2.2) / D
    q = lambda a, b, y: (s0[0] + t.x * a + n.x * b, s0[1] + t.y * a + n.y * b, y)
    Lr = math.dist(s0, s1)
    quad_tile_slope([q(-o, -o, 2.2 - k * o + 0.14), q(Lr + o, -o, 2.2 - k * o + 0.14), q(Lr + o, D + o, 6.44 + k * o + 0.14), q(-o, D + o, 6.44 + k * o + 0.14)], "#6d6a6e")
    face("hs_trim", [q(-o, -o, 2.2 - k * o), q(Lr + o, -o, 2.2 - k * o), q(Lr + o, D + o, 6.44 + k * o), q(-o, D + o, 6.44 + k * o)], (0, 0, -1), "#3a3b3d")
    gutter_run(q(-o, -o, 0)[:2], q(Lr + o, -o, 0)[:2], (-n.x, -n.y), 2.2 - k * o)
    replaces([(28.51, -9.57), (32.04, 4.6), (32.13, 4.57), (39.14, 2.83), (38.33, -0.44), (41.53, -1.24), (40.15, -6.71), (34.82, -5.34),
              (33.55, -10.3), (42.97, -12.71), (41.66, -17.94), (28.57, -14.57), (29.67, -9.84), (28.9, -9.66)],
             [s0, s1, s2, s3], [c0, c1, c2, c3], [w0, w1, w2, w3])


def bungalow_details():
    """The bungalow's own roof (drawn by the game from its data) gets what a real one has: ridge tiles, white
    bargeboards on both gables and a fascia under the gutters, a cap and two pots on its chimney. In front of the
    living room's three tall windows a terrace of light concrete slabs with a low kerb and clipped box shrubs
    takes the place of the ragged paving the aerial photo showed there (the old house's yard)."""
    c0, c1, c2, c3 = map(Vector, ((83.343, 197.185), (92.303, 186.4274), (85.15688, 180.4754), (76.19688, 191.233)))
    L = (c1 - c0).length
    Wd = (c3 - c0).length
    along = (c1 - c0).normalized()
    across = (c3 - c0).normalized()
    o = 0.3
    y, ridge = 3.3, 6.25
    eave = y - 0.15

    def at(a, b, lift=0.0):
        q = c0 + along * a + across * b
        tt = (b + o) / (Wd / 2 + o) if b <= Wd / 2 else (Wd + o - b) / (Wd / 2 + o)
        return (q.x, q.y, eave + tt * (ridge - eave) + lift)
    WHITE = "#f1efea"
    tube("hs_tiles", at(-o - 0.03, Wd / 2, 0.05), at(L + o + 0.03, Wd / 2, 0.05), 0.12, "#7a4a3a", seg=8)
    for a, sgn in ((-o, -1), (L + o, 1)):
        for b0, b1 in ((-o, Wd / 2), (Wd / 2, Wd + o)):
            p, q = Vector(at(a, b0, -0.08)), Vector(at(a, b1, -0.08))
            off = Vector((along.x * sgn * 0.02, along.y * sgn * 0.02, 0))
            box_along("hs_trim", tuple(p + off), tuple(q + off), 0.035, 0.22, WHITE)
    for b, sgn in ((-o, -1), (Wd + o, 1)):
        p, q = Vector(at(-o, b, -0.1)), Vector(at(L + o, b, -0.1))
        off = Vector((across.x * sgn * 0.01, across.y * sgn * 0.01, 0))
        box_along("hs_trim", tuple(p + off), tuple(q + off), 0.025, 0.2, WHITE)
    # The chimney's cap and pots (the stack is the game's: 86.07, 187.55 ... up to 6.9).
    ring = [(86.072, 187.549), (85.18, 186.807), (85.628, 186.269), (86.52, 187.011)]
    cx = sum(p[0] for p in ring) / 4
    cz = sum(p[1] for p in ring) / 4
    big = [(cx + (x - cx) * 1.18, cz + (z - cz) * 1.18) for x, z in ring]
    ring_prism("hs_trim", big, 6.9, 6.98, "#a19d97")
    for dx in (-0.14, 0.14):
        px, pz = cx + along.x * dx, cz + along.y * dx
        tube("hs_trim", (px, pz, 6.98), (px, pz, 7.26), 0.085, "#8f4b35", seg=8)
    # The terrace in front of the gable to the road, 3.2 m out from the wall.
    t = (c1 - c2).normalized()
    n = Vector((t.y, -t.x))
    L2 = (c1 - c2).length
    P = lambda s, d: (c2.x + t.x * s + n.x * d, c2.y + t.y * s + n.y * d)
    ring = [P(0.0, 0.05), P(L2, 0.05), P(L2, 3.2), P(0.0, 3.2)]
    drape("hs_slab", ring, 0.045, "#e4e2dd")
    f = Frame(P(0.0, 3.2), P(L2, 3.2), (85.0, 188.0), None)
    f.base = min(gy(*P(0, 3.2)), gy(*P(L2, 3.2)))
    f.box("hs_trim", -0.06, L2 + 0.06, -0.1, 0.08, -0.06, 0.04, "#c9c6bf")
    for s_ in (0.0, L2):
        g = Frame(P(s_, 0.05), P(s_, 3.2), (85.0, 188.0), None)
        g.base = gy(*P(s_, 1.6))
        g.box("hs_trim", 0.0, g.L, -0.1, 0.08, -0.04, 0.06, "#c9c6bf")
    # Clipped box shrubs along the terrace's edge, a gap in the middle to step onto the lawn.
    k = 0
    for s_ in [0.45 + 0.55 * i for i in range(7)] + [L2 - 0.45 - 0.55 * i for i in range(7)]:
        x, z = P(s_, 3.55)
        shrub(x, z, 0.32, 0.55, "#3f5a2e" if k % 3 else "#46633a", 100 + k)
        k += 1
    clears([(86.05, 180.22), (86.86, 179.0), (91.59, 179.41), (92.39, 180.21), (92.94, 182.02), (93.82, 182.66), (94.36, 182.28), (94.41, 181.01),
            (95.2, 180.61), (96.0, 181.46), (95.64, 183.65), (96.79, 184.61), (96.79, 185.39), (96.34, 185.8), (94.55, 185.44), (93.99, 186.19), (92.97, 186.19)])


def junction_pair():
    """The two new-builds on the side road past the junction, seen from the corner: pale grey wire-cut brick,
    anthracite frames and garage doors, dark roofs. The nearer one has two storeys under a hip roof with a
    single-storey part behind; the farther one is the same height with flat-roofed rooms at the back
    (GRB outlines; Street View, April 2023: the house the laser scan of 2013-2015 saw there is gone)."""
    GREY = "#e3e1dd"
    plinth = (0.35, "hs_brick_buff", "#6b6c6d")
    # The nearer house: x 43.5 to 61.5, z 29.3 to 40.2; the front (10 m) faces the side road.
    a, b, c, d = (43.46, 39.31), (43.95, 29.29), (54.6, 29.81), (54.11, 39.83)
    centre = (49.0, 34.6)
    base = gy(*centre)
    E, R = 5.75, 9.2
    eh = E - base
    front = Frame(a, b, centre, base)
    north = Frame(b, c, centre, base)
    south = Frame(d, a, centre, base)
    facade(front, eh, [
        W(1.7, 1.8, 0.85, 2.3, frame=ANTHRACITE),
        Hole(3.7, 4.7, 0.0, 2.35, kind="door", frame=ANTHRACITE, leaf="#5d6064"),
        Hole(4.85, 5.15, 0.0, 2.35, kind="glazed", frame=ANTHRACITE, cols=1),
        Hole(6.6, 9.2, 0.0, 2.3, kind="garage", frame=ANTHRACITE, leaf="#35383b"),
        W(1.7, 1.4, 3.6, 5.0, frame=ANTHRACITE), W(4.4, 0.6, 3.4, 5.0, frame=ANTHRACITE), W(7.9, 1.4, 3.6, 5.0, frame=ANTHRACITE),
    ], "hs_brick_buff", GREY, plinth=plinth)
    wall_lamp(front, 3.45, 2.1)
    facade(north, eh, [W(3.0, 1.0, 1.0, 2.2, frame=ANTHRACITE), W(7.5, 1.0, 3.7, 4.9, frame=ANTHRACITE)], "hs_brick_buff", GREY, plinth=plinth)
    facade(south, eh, [W(2.5, 2.4, 0.4, 2.3, frame=ANTHRACITE, cols=3), W(8.0, 1.2, 3.6, 4.9, frame=ANTHRACITE)], "hs_brick_buff", GREY, plinth=plinth)
    facade(Frame(c, d, centre, base), eh, [], "hs_brick_buff", GREY, from_y=3.2 - base)
    hip_roof(b, c, d, a, E, R, "#45484d", over=0.4, fascia="#35383b", soffit="#35383b", pipes=(0, 3), ridge_col="#3c3f43")
    # The single storey behind, flat-roofed.
    rear = [(54.6, 29.81), (59.44, 30.05), (59.21, 34.82), (61.51, 34.93), (61.25, 40.18), (54.11, 39.83)]
    rc = (57.5, 35.0)
    rb = gy(*rc)
    for p, q in zip(rear, rear[1:]):
        facade(Frame(p, q, rc, rb), 3.25 - rb, [W(Frame(p, q, rc, rb).L / 2, 1.6, 0.6, 2.3, frame=ANTHRACITE)] if math.dist(p, q) > 4 else [], "hs_brick_buff", GREY, plinth=plinth)
    flat_roof(rear, 3.25, coping="#3a3d40")
    replaces([(43.46, 39.31), (61.25, 40.18), (61.51, 34.93), (59.21, 34.82), (59.44, 30.05), (44.94, 29.38), (44.67, 34.96), (43.68, 34.92)],
             [(44.94, 29.38), (43.94, 29.34), (43.68, 34.92), (44.67, 34.96)], [a, b, c, d], rear,
             [(61.75, 30.17), (43.95, 29.29), (43.46, 39.31), (61.25, 40.18)])

    # The farther house: two storeys under a hip roof (eaves 5.68, ridge 8.74), flat-roofed rooms behind.
    a2, b2, c2, d2 = (39.03, 55.18), (39.58, 45.16), (51.07, 45.79), (50.52, 55.81)
    centre2 = (45.05, 50.48)
    base2 = gy(*centre2)
    E2, R2 = 5.68, 8.74
    eh2 = E2 - base2
    WHITE_BRICK = "#f0efeb"
    front2 = Frame(a2, b2, centre2, base2)
    facade(front2, eh2, [
        W(1.6, 1.6, 0.85, 2.3, frame="#26282a"),
        Hole(3.9, 4.9, 0.0, 2.35, kind="door", frame="#26282a", leaf="#2f3134"),
        W(7.2, 2.6, 0.3, 2.3, frame="#26282a", cols=3),
        W(1.6, 1.2, 3.6, 4.9, frame="#26282a"), W(5.0, 1.2, 3.6, 4.9, frame="#26282a"), W(8.4, 1.2, 3.6, 4.9, frame="#26282a"),
    ], "hs_brick_buff", WHITE_BRICK, plinth=plinth)
    facade(Frame(b2, c2, centre2, base2), eh2, [W(2.5, 1.0, 1.0, 2.2, frame="#26282a"), W(6.5, 1.0, 3.6, 4.9, frame="#26282a")], "hs_brick_buff", WHITE_BRICK, plinth=plinth)
    facade(Frame(d2, a2, centre2, base2), eh2, [W(4.0, 1.2, 1.0, 2.2, frame="#26282a"), W(8.0, 1.2, 3.6, 4.9, frame="#26282a")], "hs_brick_buff", WHITE_BRICK, plinth=plinth)
    facade(Frame(c2, d2, centre2, base2), eh2, [W(5.0, 1.0, 3.6, 4.9, frame="#26282a")], "hs_brick_buff", WHITE_BRICK, from_y=3.3 - base2)
    hip_roof(b2, c2, d2, a2, E2, R2, "#3f4247", over=0.4, fascia="#26282a", soffit="#26282a", pipes=(0, 2), ridge_col="#36393d")
    rear2 = [(51.07, 45.79), (56.18, 45.93), (55.75, 52.47), (52.83, 52.49), (52.69, 56.0), (50.52, 55.81)]
    rc2 = (53.4, 50.5)
    rb2 = gy(*rc2)
    for p, q in zip(rear2, rear2[1:]):
        L = math.dist(p, q)
        holes = [Hole(L / 2 - 1.25, L / 2 + 1.25, 0.0, 2.3, kind="garage", frame="#26282a", leaf="#35383b")] if L > 6 else []
        facade(Frame(p, q, rc2, rb2), 3.3 - rb2, holes, "hs_brick_buff", WHITE_BRICK, plinth=plinth)
    flat_roof(rear2, 3.3, coping="#2f3134")
    replaces([(56.02, 46.07), (40.52, 45.21), (40.24, 51.21), (39.25, 51.16), (39.06, 55.18), (52.55, 55.84), (52.68, 52.34), (55.61, 52.32)],
             [(51.07, 45.8), (42.88, 45.34), (40.52, 45.21), (40.24, 51.21), (39.25, 51.16), (39.25, 51.25), (39.06, 55.18), (50.52, 55.74)],
             [(53.01, 52.47), (53.27, 52.49), (55.75, 52.47), (56.18, 45.93), (53.38, 45.77)],
             [(50.36, 55.88), (50.68, 55.9), (52.69, 56.0), (52.83, 52.49), (53.31, 52.49), (53.68, 45.79), (50.93, 45.64)],
             [a2, b2, c2, d2], rear2)


def portal_garden():
    """The garden by the house portal, west of the barn: a low rendered wall with a concrete coping along the
    lane, as Street View shows it (kept 3 m from the portal and where its travellers arrive), and a stack of
    split logs against the barn."""
    z0 = 21.54 + 0.35  # the lane's edge is at z 21.54 here
    x0, x1 = -18.8, -4.6
    f = Frame((x0, z0), (x1, z0), (-10.0, 30.0), None)
    f.base = min(gy(x0, z0), gy(x1, z0))
    f.box("hs_render", 0, f.L, -0.2, 0.62, -0.15, 0.15, "#ddd8cc")
    f.box("hs_trim", -0.03, f.L + 0.03, 0.62, 0.7, -0.19, 0.19, "#b4b0a8")
    block("stone", [(x0, z0 - 0.15), (x1, z0 - 0.15), (x1, z0 + 0.15), (x0, z0 + 0.15)], f.base - 0.2, f.base + 0.7)
    # The log stack: rows of round logs on two rails, ends towards the garden.
    lx, lz = 1.7, 29.4   # against the barn's west wall (x 2.31), clear of its door
    base = gy(lx, lz)
    for zz in (lz - 1.2, lz + 1.2):
        box_along("hs_trim", (lx - 0.4, zz, base + 0.06), (lx + 0.45, zz, base + 0.06), 0.08, 0.1, "#5a4a3a")
    rng = np.random.default_rng(7)
    for row in range(6):
        y = base + 0.2 + row * 0.19
        n = 13 - (row % 2)
        for i in range(n):
            zz = lz - 1.15 + (2.3 / 12) * (i + (0.5 if row % 2 else 0)) + rng.normal(0, 0.01)
            r = 0.085 + rng.random() * 0.03
            shade = ["#8a6c4c", "#9b7b58", "#7a5e42", "#a5865f"][int(rng.integers(0, 4))]
            tube("hs_trim", (lx - 0.45, zz, y), (lx + 0.5 + rng.normal(0, 0.03), zz, y), r, shade, seg=6)
    block("stone", [(lx - 0.5, lz - 1.3), (lx + 0.55, lz - 1.3), (lx + 0.55, lz + 1.3), (lx - 0.5, lz + 1.3)], base - 0.1, base + 1.35)


# ================================================================ build, bake, export
use("home")
corner_across()
beyond_hedge()
junction_pair()
portal_garden()
use("bungalow")
bung_west()
bungalow_details()


def tile_uvs(bm, size):
    uv = bm.loops.layers.uv.new("UVMap")
    su, sv = size
    for f in bm.faces:
        n = f.normal
        if abs(n.z) > 0.97:
            t, b = Vector((1, 0, 0)), Vector((0, 1, 0))
        else:
            t = Vector((0, 0, 1)).cross(n).normalized()
            b = n.cross(t).normalized()
        for lp in f.loops:
            p = lp.vert.co
            lp[uv].uv = (p.dot(t) / su, p.dot(b) / sv)


roots = {}
objs = {}
tris = 0
for (cluster, name), bm in BM.items():
    if not bm.faces:
        continue
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
    bm.normal_update()
    tex, size, _ = MATS[name]
    if tex:
        tile_uvs(bm, size)
    me = bpy.data.meshes.new(f"{cluster}_{name}")
    bm.to_mesh(me)
    me.materials.append(M[name])
    me.color_attributes.active_color = me.color_attributes["Color"]
    me.color_attributes.render_color_index = me.color_attributes.active_color_index
    me.set_sharp_from_angle(angle=math.radians(35))
    if cluster not in roots:
        use(cluster)
        root = bpy.data.objects.new(f"homestreet_{cluster}", None)
        bpy.context.scene.collection.objects.link(root)
        root["origin"] = list(CLUSTERS[cluster])
        root["cluster"] = cluster
        roots[cluster] = root
    ob = bpy.data.objects.new(f"{cluster}_{name}", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = roots[cluster]
    if name in DETAIL:
        ob["detail"] = True
    objs.setdefault(cluster, []).append(ob)
    me.calc_loop_triangles()
    tris += len(me.loop_triangles)
    print(f"{cluster} {name}: {len(me.loop_triangles)} triangles")
print(f"homestreet: {tris} triangles")


def bake_ao(cluster):
    """Ambient occlusion from Cycles into a second colour layer, then multiplied into the tint."""
    use(cluster)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 64
    if scene.world is None:
        scene.world = bpy.data.worlds.new("w")
    scene.world.light_settings.distance = 1.6
    # A ground for the walls' feet to be shaded against.
    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, -0.02))
    ground = bpy.context.active_object
    obs = objs[cluster]
    for o in bpy.data.objects:
        o.hide_render = not (o in obs or o is ground)
    for o in obs:
        me = o.data
        if "AO" not in me.color_attributes:
            me.color_attributes.new("AO", "FLOAT_COLOR", "CORNER")
        me.color_attributes.active_color = me.color_attributes["AO"]
    bpy.ops.object.select_all(action="DESELECT")
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    scene.render.bake.target = "VERTEX_COLORS"
    bpy.ops.object.bake(type="AO")
    for o in obs:
        me = o.data
        ao = me.color_attributes["AO"].data
        col = me.color_attributes["Color"].data
        for i in range(len(col)):
            a = ao[i].color[0]
            k = 0.38 + 0.62 * a  # keep some light in the deepest corners: the sky still reaches them
            c = col[i].color
            col[i].color = (c[0] * k, c[1] * k, c[2] * k, 1.0)
        me.color_attributes.remove(me.color_attributes["AO"])
        me.color_attributes.active_color = me.color_attributes["Color"]
    bpy.data.objects.remove(ground, do_unlink=True)


if not NO_BAKE:
    for cl in objs:
        bake_ao(cl)

bpy.ops.object.select_all(action="DESELECT")
for cl, root in roots.items():
    root.select_set(True)
    for o in objs[cl]:
        o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=True, export_normals=True, export_extras=True, export_vertex_color="MATERIAL",
                          export_cameras=False, export_lights=False, export_materials="EXPORT")
print("written", OUT, os.path.getsize(OUT), "bytes")
data = {
    "_note": "Written by tools/homestreet/houses.py: per cluster of our Blender models (web/public/models/homestreet.glb), "
             "the GRB outlines whose buildings they replace (no longer drawn, still solid) and the blocks of what was added "
             "round them (garden walls, pillars, fences), for walking and driving into.",
    "clusters": {cl: {"origin": list(CLUSTERS[cl]), "replace": REPLACE.get(cl, []), "clear": CLEAR.get(cl, []), "blocks": BLOCKS.get(cl, [])} for cl in CLUSTERS},
}
with open(OUT_JSON, "w", encoding="utf-8") as fh:
    json.dump(data, fh, separators=(",", ":"))
print("written", OUT_JSON)
