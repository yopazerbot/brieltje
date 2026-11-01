"""Build the street Molenhoek round its portal in Blender: its houses and the rebuilt street. The same builder
makes the houses of Kapellenhoek (tools/kapellenhoek_survey.py): the place's plan is data/<place>.json.

Run (Blender 5, no window), from the project root, after the place's survey:
  blender -b -P tools/molenhoek.py -- <out.glb> [molenhoek | kapellenhoek]

Our own model of the forty-seven houses along Molenhoek, from the church square to the junction where
the map ends, and of the street in front of them, from data/molenhoek.json (the plan from the open data,
the survey from Street View; see tools/molenhoek_survey.py). Each house stands on its GRB outline with
the heights of the village's blocks (past the edge of the village data, the GRB's outline on the
relief, with blocks of its own for walking into): its front as the survey describes it (brick and
colour, plinth and bands, blocks of another brick laid into the wall and soldier courses, windows with
frames, top lights, sills, lintels, stone arches, shutters and net curtains, french balconies, doors with
their steps, aluminium doors with frosted panes, sectional garage doors, letterboxes and bell plates, an
oriel, a balcony, a porch, a round window, a canopy), plainer windows on the sides and back, the roof with its tiles, ridge, fascia, gutters and
downpipes, chimneys, roof windows, a dormer and solar panels, the lower parts behind under flat roofs,
and in the front gardens the low walls, fences, clipped hedges, box balls and conifers. The street: west of the traffic island the old concrete road (the
village draws it) gets its gutters, kerbs and pavements; from the island to 45 m past the junction, and
along the whole branch that turns off there to its end at Oordegemkouter, dark asphalt, a concrete gutter with drains, the
raised red cycle lanes, a kerb, the pavements in grey concrete pavers, and grey pavers on the forecourts
where the GRB's road surface reaches past the pavement; the island with its keep-left sign, a fire
hydrant, an electricity cabinet, a warning sign, a bread vending machine; tall conifers along the empty
plot where the portal stands. No people, no house numbers, no lettering.

Frame: the GLB is in the game's own axes (x, y up, z), its origin on the ground at ORIGIN on the
street by the portal (y = 0 is the relief there, tools/terrain.py); everything else stands on the
relief where it is, with the browser's formula (web/shared/terrain.json). The root node's extras
carry the origin, the landmark name, each house's outline (the game hides the village's blocks
inside them, which stay for walking into), the new solid things for walking into and the new street's
surfaces for walking on, the street's outline (the old pavings inside it give way), the village's trees
that give way to the conifers, and the stretch whose concrete poles became steel lamp posts.

Output: one GLB, one mesh per material, every mesh coloured per vertex, packed small (16-bit positions):
- mh_brick, mh_render, mh_stone, mh_roof, mh_asphalt, mh_pavers, mh_foliage: UVs in metres; their
  glTF extras name a shared game texture, which the game multiplies by the vertex colour, so one
  draw call carries every tint and they add no graphics memory but the asphalt;
- mh_glass: the panes (dark, or light where net curtains hang behind them) and the solar panels;
- mh_panel: doors, garage doors, roller shutters, surrounds; mh_detail: frames, sills' edges,
  gutters, downpipes, railings, ridge caps, posts and signs (drawn only within 200 m).
- mh_gravel: round a house newer than the village data (`site`), its drive's gravel and a building site's bare earth,
  in cells on the relief (drawn only within 200 m). The root's extras then also carry the buildings that stood there
  (`gone`: the village's blocks, roofs and windows go, for walking into too) and the village's ground covers cut away
  round it (`cuts`, `cleared`).
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
PLACE = argv[1] if len(argv) > 1 else "molenhoek"
MOLENHOEK = PLACE == "molenhoek"  # its rebuilt street, the island, the hydrant and the conifers by the portal are its own
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = json.load(open(os.path.join(ROOT, "data", PLACE + ".json"), encoding="utf-8"))
ORIGIN = tuple(DATA.get("origin", (758.0, -719.0)))  # Molenhoek's: on the street by the portal (model x, z)
# Which way a front runs: from its west end (Molenhoek's houses face an east-west street) or, "view", from its left
# end as seen from the street.
VIEW = DATA.get("order") == "view"
# `lean`: no windows on walls that face away from the street, sills and steps among the small things (no texture,
# drawn near only): fewer triangles for a long street seen from the street.
LEAN = bool(DATA.get("lean"))


def left_first(p, q, o):
    """Whether the wall from p to q (outward o) already runs the way fronts run."""
    if VIEW:
        return (q[0] - p[0]) * o[1] - (q[1] - p[1]) * o[0] >= 0
    return p[0] <= q[0]
GROUND = -0.1                 # the main house's ground in the game (the relief is measured from it)
WEST_END, EAST_END = 689.0, 936.0  # the rebuilt stretch: the island at its west end, 45 m past the junction where the map ends
CURTAIN = "#8e9290"           # a pane with net curtains behind it


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


Y0 = terrain(*ORIGIN)


def V(x, z, y):
    """A point in the game's frame (y above the plot's ground, as the relief) in Blender's (z up)."""
    return Vector((x - ORIGIN[0], -(z - ORIGIN[1]), y - Y0))


def srgb(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def shade(h, k):
    """A colour made lighter (k > 1) or darker (k < 1)."""
    c = [min(255, int(int(h[i:i + 2], 16) * k)) for i in (1, 3, 5)]
    return "#%02x%02x%02x" % tuple(c)


# ---------------------------------------------------------------- materials
bpy.ops.wm.read_factory_settings(use_empty=True)
# name: (shared game texture, normal scale)
SHARED = {"mh_brick": ("nb_brick", 1.0), "mh_render": ("plaster", 0.35), "mh_cladding": ("cladding", 0.9), "mh_stone": ("concrete", 0.5),
          "mh_roof": ("roof_tiles", 1.0), "mh_asphalt": ("asphalt", 0.8), "mh_pavers": ("pavers", 0.8), "mh_foliage": ("hedge", 1.0),
          "mh_tiles": ("floor_tile", 0.6), "mh_gravel": ("gravel", 0.8)}
# Long thin bricks (a house's `long_brick`): its brick faces take the shared brick texture stretched along and squeezed
# up, so its bricks are twice as long and a fifth thinner, in the same mesh and draw call.
LONG_UV = (0.5, 1.25)
LONG = [False]
M = {}


def principled(name, rough, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Color"
    nt.links.new(attr.outputs["Color"], p.inputs["Base Color"])
    m.use_backface_culling = True
    return m


for name, (tex, ns) in SHARED.items():
    M[name] = principled(name, 0.9)
    M[name]["texture"], M[name]["normalScale"] = tex, ns
M["mh_glass"] = principled("mh_glass", 0.06, 0.3)
M["mh_panel"] = principled("mh_panel", 0.5)
M["mh_detail"] = principled("mh_detail", 0.55, 0.1)
M["mh_detail"]["lod"] = 200  # metres: drawn only nearer than this (web/src/world/streetModel.ts)
M["mh_gravel"]["lod"], M["mh_gravel"]["flat"] = 200, 1  # a drive's gravel and rough ground: near only, its texture's colour alone
# A house you can walk into (`inside`): its panes and its front door's leaf in meshes of their own, which the game
# shows only from afar; near it the house's own glass you see through and doors that open take their place
# (web/src/world/walkIn.ts).
M["mh_glass_in"] = principled("mh_glass_in", 0.06, 0.3)
M["mh_panel_in"] = principled("mh_panel_in", 0.5)
M["mh_glass_in"]["shut"] = M["mh_panel_in"]["shut"] = 1
# A house's own garden (`yard`): its things in meshes of their own (`_g`, the terrace's tiles anyway), drawn only near,
# as the small things are, and before the street's walls (`order`), in front of which they mostly stand: what lies
# behind a shed or a fence is then not shaded for nothing. Its boards, logs, tiles, concrete and ivy take their
# texture's colour alone (`flat`), without its relief and sheen, as they fill the view close by.
for name in ("mh_render", "mh_stone", "mh_foliage", "mh_panel", "mh_detail", "mh_tiles"):
    g = M[name] if name == "mh_tiles" else M[name].copy()
    if name != "mh_tiles":
        g.name = name + "_g"
        M[name + "_g"] = g
    g["lod"], g["order"] = 200, -0.5
    if name in ("mh_render", "mh_stone", "mh_foliage", "mh_tiles"):
        g["flat"] = 1
IN_YARD = [False]  # whether a garden is being built (its faces go into its own meshes)
INSIDE = [False]  # whether the house being built is one you can walk into
DETAIL_SPLIT = tuple(DATA["detail_split"]["at"]) if DATA.get("detail_split") else (705.0, 815.0)  # where the small things go into the next part
DETAIL_AXIS = DATA["detail_split"]["axis"] if DATA.get("detail_split") else "x"

BM = {}
for name in M:
    BM[name] = bmesh.new()
    BM[name].loops.layers.float_color.new("Color")


def colour(h):
    return (*srgb(h), 1.0) if h else (1.0, 1.0, 1.0, 1.0)


def paint_face(bm, f, hexcol):
    lay = bm.loops.layers.float_color["Color"]
    c = colour(hexcol)
    for lp in f.loops:
        lp[lay] = c


# ---------------------------------------------------------------- geometry helpers (game coordinates)
def yard_mat(mat):
    """The mesh a face goes into: a garden's own while one is being built."""
    return mat + "_g" if IN_YARD[0] and mat + "_g" in BM else mat


def mark_long(bm, mat, f):
    """While a house of long thin bricks is built, its brick faces are marked (metre_uvs stretches their texture)."""
    if LONG[0] and mat == "mh_brick" and f is not None:
        f[bm.faces.layers.int["long"]] = 1  # the layer is made before the house is built (house())


def face(mat, pts, out=None, col=None):
    """A planar face through game points (x, z, y); turned to face `out` (a game direction (dx, dz, dy))."""
    bm = BM[yard_mat(mat)]
    vs = [V(*p) for p in pts]
    if out is not None:
        n = Vector((0, 0, 0))
        for i in range(len(vs)):  # Newell's normal: works for any planar polygon
            a, b = vs[i], vs[(i + 1) % len(vs)]
            n += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
        o = Vector((out[0], -out[1], out[2]))
        if n.dot(o) < 0:
            vs = vs[::-1]
    try:
        f = bm.faces.new([bm.verts.new(v) for v in vs])
    except ValueError:
        return None
    paint_face(bm, f, col)
    mark_long(bm, mat, f)
    return f


def solid(mat, pts, col=None):
    """The convex solid round game points (x, z, y)."""
    tmp = bmesh.new()
    for p in pts:
        tmp.verts.new(V(*p))
    res = bmesh.ops.convex_hull(tmp, input=tmp.verts[:])
    dead = {g for g in res["geom_interior"] + res["geom_unused"] if isinstance(g, bmesh.types.BMVert)}
    bmesh.ops.delete(tmp, geom=list(dead), context="VERTS")
    bmesh.ops.dissolve_limit(tmp, angle_limit=math.radians(0.5), verts=tmp.verts[:], edges=tmp.edges[:])
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces[:])
    bm = BM[yard_mat(mat)]
    for f in tmp.faces:
        nf = bm.faces.new([bm.verts.new(v.co) for v in f.verts])
        paint_face(bm, nf, col)
        mark_long(bm, mat, nf)
    tmp.free()


def beam(mat, a, b, w, h, col=None, up=(0, 0, 1)):
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


def tube(mat, a, b, r, col=None, seg=6):
    a, b = Vector(a), Vector(b)
    d = (b - a).normalized()
    u = d.cross(Vector((1, 0, 0)) if abs(d.x) < 0.9 else Vector((0, 1, 0))).normalized()
    w = d.cross(u)
    pts = []
    for k in range(seg):
        t = 2 * math.pi * k / seg
        off = u * math.cos(t) * r + w * math.sin(t) * r
        pts += [tuple(a + off), tuple(b + off)]
    solid(mat, pts, col)


def unit(a, b):
    d = (b[0] - a[0], b[1] - a[1])
    n = math.hypot(*d)
    return (d[0] / n, d[1] / n), n


class Frame:
    """A wall's frame on the plan: origin a, direction t along the wall, outward normal o; base is the
    floor (y above the plot's ground). p(s, y, d): s along, y up from the floor, d out of the wall."""

    def __init__(self, a, t, o, base):
        self.a, self.t, self.o, self.base = a, t, o, base

    def p(self, s, y, d=0.0):
        return (self.a[0] + self.t[0] * s + self.o[0] * d, self.a[1] + self.t[1] * s + self.o[1] * d, self.base + y)

    def xz(self, s, d=0.0):
        return (self.a[0] + self.t[0] * s + self.o[0] * d, self.a[1] + self.t[1] * s + self.o[1] * d)

    def out(self, k=1.0):
        return (self.o[0] * k, self.o[1] * k, 0.0)

    def along(self, k=1.0):
        return (self.t[0] * k, self.t[1] * k, 0.0)

    def box(self, mat, s0, s1, y0, y1, d0, d1, col=None):
        solid(mat, [self.p(s, y, d) for s in (s0, s1) for y in (y0, y1) for d in (d0, d1)], col)

    def flat(self, mat, s0, s1, y0, y1, d, col=None):
        """A face parallel to the wall, d out from it."""
        face(mat, [self.p(s0, y0, d), self.p(s1, y0, d), self.p(s1, y1, d), self.p(s0, y1, d)], self.out(), col)


# ---------------------------------------------------------------- walls, windows and doors
class Hole:
    def __init__(self, s0, s1, y0, y1, kind="w", depth=0.13, opt=None):
        self.s0, self.s1, self.y0, self.y1, self.kind, self.depth = s0, s1, y0, y1, kind, depth
        self.opt = opt or {}


def layer_at(layers, y):
    cur = layers[0]
    for L in layers:
        if y >= L[0]:
            cur = L
    return cur


def facade(f, length, top, holes, layers, bottom=-1.2, patches=()):
    """A wall from s = 0 to length: its surface from `bottom` up to the line `top` ([(s, y)], straight
    between; two points at one s make a step), without the holes. `layers`: [(from y, material, colour)]
    up the wall (a plinth, an upper floor in another finish). `patches`: [(s0, s1, y0, y1, material, colour)],
    rectangles of another brick laid into the wall itself (a band that stops short of the corners, soldier
    courses over the openings); a later one lies over an earlier one."""
    def ytop(s):
        for (s0, y0), (s1, y1) in zip(top, top[1:]):
            if s1 - s0 > 1e-9 and s0 - 1e-6 <= s <= s1 + 1e-6:
                return y0 + (y1 - y0) * (s - s0) / (s1 - s0)
        return top[-1][1]
    xs = sorted({0.0, length, *[s for h in holes for s in (h.s0, h.s1)], *[s for s, _ in top], *[s for p in patches for s in p[:2]]})
    xs = [s for s in xs if -1e-6 <= s <= length + 1e-6]
    bounds = [L[0] for L in layers[1:]]
    for xa, xb in zip(xs, xs[1:]):
        if xb - xa < 1e-4:
            continue
        xm = (xa + xb) / 2
        ta_top, tb_top = ytop(xa + 1e-4), ytop(xb - 1e-4)
        cuts = sorted((h.y0, h.y1) for h in holes if h.s0 <= xm <= h.s1)
        here = [p for p in patches if p[0] <= xm <= p[1]]
        strip_bounds = sorted(set(bounds) | {y for p in here for y in p[2:4]}) if here else bounds
        spans, y = [], bottom
        for y0, y1 in cuts:
            spans.append((y, y0))
            y = y1
        spans.append((y, None))
        for ya, yb in spans:
            ys = [ya] + [b for b in strip_bounds if b > ya + 1e-4 and (yb is None or b < yb - 1e-4)] + [yb]
            for y0, y1 in zip(ys, ys[1:]):
                _, mat, col = layer_at(layers, y0 + 1e-3)
                ym = y0 + 1e-3 if y1 is None else (y0 + y1) / 2
                for p in here:
                    if p[2] <= ym <= p[3]:
                        mat, col = p[4], p[5]
                if y1 is None:
                    ta, tb = ta_top, tb_top
                else:
                    ta, tb = min(y1, ta_top), min(y1, tb_top)
                if max(ta, tb) - y0 < 1e-4:
                    continue
                ta, tb = max(ta, y0), max(tb, y0)
                face(mat, [f.p(xa, y0), f.p(xb, y0), f.p(xb, tb), f.p(xa, ta)], f.out(), col)
    for h in holes:
        hole(f, h, layers)


def wall_at(layers, y):
    _, mat, col = layer_at(layers, y)
    return mat, col


SMALL_STONE = "mh_detail" if LEAN else "mh_stone"  # sills and steps
FROST = "#c4ccc7"  # frosted glass


def door_step(f, h, d):
    """The step at a door, or steps up to a raised ground floor. `down`: the floor stands above the pavement, and the
    step reaches down into it."""
    if h.y0 > 0.25:
        n = max(2, int(round(h.y0 / 0.17)))
        for k in range(n):
            f.box(SMALL_STONE, h.s0 - 0.15, h.s1 + 0.15, -0.12, h.y0 - k * h.y0 / n, d, 0.3 * (k + 1), "#8d8f8f")
    else:
        low = -0.12
        if h.opt.get("down"):
            low = min(low, min(terrain(*f.xz(s, e)) for s in (h.s0 - 0.08, h.s1 + 0.08) for e in (0.0, 0.28)) - f.base - 0.05)
        f.box(SMALL_STONE, h.s0 - 0.08, h.s1 + 0.08, low, 0.0, d, 0.28, "#5f6468")


def garage_ramp(f, h, depth):
    """A ramp of grey pavers in front of a garage door whose floor stands above the drive: from the door's sill down
    to the ground `depth` m out (into the paving there), square at its sides."""
    s0, s1 = h.s0 - 0.1, h.s1 + 0.1
    low = lambda s, e: terrain(*f.xz(s, e)) - f.base - 0.01  # the ground, from the floor
    a, b = f.p(s0, 0.0, 0.0), f.p(s1, 0.0, 0.0)
    c, d = f.p(s1, low(s1, depth), depth), f.p(s0, low(s0, depth), depth)
    up, grey = (0, 0, 1), "#bfbab2"  # as the forecourts
    face("mh_pavers", [a, d, c], up, grey)
    face("mh_pavers", [a, c, b], up, grey)
    for s, out, top, foot in ((s0, -1, a, d), (s1, 1, b, c)):
        face("mh_pavers", [top, foot, f.p(s, low(s, 0.0), 0.0)], f.along(out), shade(grey, 0.9))


def hole(f, h, layers):
    o = h.opt
    glass_m, leaf_m = ("mh_glass_in", "mh_panel_in") if INSIDE[0] else ("mh_glass", "mh_panel")
    d = -h.depth
    mat, col = wall_at(layers, (h.y0 + h.y1) / 2)
    # Reveals, facing into the opening.
    face(mat, [f.p(h.s0, h.y0), f.p(h.s0, h.y1), f.p(h.s0, h.y1, d), f.p(h.s0, h.y0, d)], f.along(1), col)
    face(mat, [f.p(h.s1, h.y0), f.p(h.s1, h.y1), f.p(h.s1, h.y1, d), f.p(h.s1, h.y0, d)], f.along(-1), col)
    face(mat, [f.p(h.s0, h.y1), f.p(h.s1, h.y1), f.p(h.s1, h.y1, d), f.p(h.s0, h.y1, d)], (0, 0, -1), col)
    if h.kind in ("w", "a"):
        face("mh_stone", [f.p(h.s0, h.y0), f.p(h.s1, h.y0), f.p(h.s1, h.y0, d), f.p(h.s0, h.y0, d)], (0, 0, 1), "#6b7075")
    elif h.kind == "porch":
        face("mh_pavers", [f.p(h.s0, h.y0 + 0.02), f.p(h.s1, h.y0 + 0.02), f.p(h.s1, h.y0 + 0.02, d), f.p(h.s0, h.y0 + 0.02, d)], (0, 0, 1), "#bdb6aa")
        return
    else:
        face(mat, [f.p(h.s0, h.y0), f.p(h.s1, h.y0), f.p(h.s1, h.y0, d), f.p(h.s0, h.y0, d)], (0, 0, 1), col)
    frame_c = o.get("f", o.get("frame", "#f1f0ec"))
    pane = [f.p(h.s0, h.y0, d), f.p(h.s1, h.y0, d), f.p(h.s1, h.y1, d), f.p(h.s0, h.y1, d)]
    fw, fd = 0.065, 0.04
    if h.kind == "d" and o.get("frost"):  # an aluminium door: frosted panes between broad rails, a side light, a long bar handle
        face(leaf_m, pane, f.out(), o.get("c", "#3a3c3f"))
        l0, l1 = h.s0, h.s1  # the leaf
        side = o.get("side")  # (width, "l" or "r"): a fixed frosted light beside the leaf
        if side:
            if side[1] == "r":
                l1 = h.s1 - side[0]
                f.flat(leaf_m, l1 + 0.05, h.s1 - 0.07, h.y0 + 0.09, h.y1 - 0.09, d + 0.004, FROST)
            else:
                l0 = h.s0 + side[0]
                f.flat(leaf_m, h.s0 + 0.07, l0 - 0.05, h.y0 + 0.09, h.y1 - 0.09, d + 0.004, FROST)
        n, stile, rail, foot = o["frost"], 0.1, 0.07, 0.13
        ph = (h.y1 - h.y0 - foot - 0.11 - rail * (n - 1)) / n
        for k in range(n):
            y = h.y0 + foot + k * (ph + rail)
            f.flat(leaf_m, l0 + stile, l1 - stile, y, y + ph, d + 0.004, FROST)
        hs = l1 - 0.12 if o.get("hand") == "r" else l0 + 0.12  # the handle, on the side away from the hinges
        f.box("mh_panel_in" if INSIDE[0] else "mh_detail", hs - 0.016, hs + 0.016, h.y0 + 0.75, h.y0 + 1.45, d + 0.03, d + 0.075, "#c9cbcc")
        door_step(f, h, d)
    elif h.kind in ("d", "ad") and o.get("c"):  # a solid door leaf
        leaf = o["c"]
        face("mh_panel", pane, f.out(), leaf)
        w = h.s1 - h.s0
        if o.get("glass_strip"):
            f.flat("mh_glass", h.s0 + w * 0.62, h.s0 + w * 0.8, 0.25, h.y1 - h.y0 - 0.3, d + 0.004, "#3a4448")
        if o.get("lights"):
            for k in range(o["lights"]):
                y = 0.55 + k * 0.38
                f.flat("mh_glass", h.s0 + w * 0.42, h.s0 + w * 0.58, h.y0 + y, h.y0 + y + 0.16, d + 0.004, "#3a4448")
        if o.get("bar"):  # a long bar handle, the leaf's colour a shade lighter
            f.box("mh_detail", h.s0 + 0.1, h.s0 + 0.13, h.y0 + 0.75, h.y0 + 1.95, d + 0.01, d + 0.06, shade(leaf, 1.9))
        else:
            f.flat("mh_detail", h.s0 + w * 0.12, h.s0 + w * 0.16, h.y0 + 0.9, h.y0 + 1.25, d + 0.03, "#c9cbcc")  # the handle bar
        door_step(f, h, d)
    elif h.kind == "g":
        face("mh_panel", pane, f.out(), o.get("c", "#e9e8e4"))
        n = o.get("sections")  # a sectional door in this many panels; else a joint every half metre
        joints = [h.y0 + (h.y1 - h.y0) * k / n for k in range(1, n)] if n else [h.y0 + k * 0.5 for k in range(1, int((h.y1 - h.y0) / 0.5))]
        for y in joints:
            f.flat("mh_detail", h.s0 + 0.03, h.s1 - 0.03, y - 0.012, y + 0.012, d + 0.004, shade(o.get("c", "#e9e8e4"), 0.82))
        if o.get("ramp"):
            garage_ramp(f, h, o["ramp"])
        return
    else:
        glass = CURTAIN if o.get("cu") else "#252c30"
        face(glass_m, pane, f.out(), glass)
    c = frame_c
    f.flat("mh_detail", h.s0, h.s0 + fw, h.y0, h.y1, d + fd, c)
    f.flat("mh_detail", h.s1 - fw, h.s1, h.y0, h.y1, d + fd, c)
    f.flat("mh_detail", h.s0 + fw, h.s1 - fw, h.y1 - fw, h.y1, d + fd, c)
    f.flat("mh_detail", h.s0 + fw, h.s1 - fw, h.y0, h.y0 + fw, d + fd, c)
    if h.kind in ("w", "a") or (h.kind in ("d", "ad") and not o.get("c")):
        w = h.s1 - h.s0
        n = o.get("n") or (1 if w < 0.95 else (2 if w < 2.0 else 3))  # `n`: lights side by side, as given
        parts = [h.s0 + w * k for k in o["div"]] if o.get("div") else [h.s0 + w * k / n for k in range(1, n)]  # `div`: where the lights part, as parts of the width
        for m in parts:
            f.flat("mh_detail", m - 0.035, m + 0.035, h.y0 + fw, h.y1 - fw, d + fd + 0.002, c)
        for k in o.get("blind", []):  # `blind`: these lights (0 from the left) with a blind down behind the glass, in two panes
            a, b = h.s0 + w * k / n, h.s0 + w * (k + 1) / n
            f.flat("mh_panel", a + 0.03, b - 0.03, h.y0 + fw, h.y1 - fw, d + 0.004, "#8a8680")
            f.flat("mh_detail", (a + b) / 2 - 0.022, (a + b) / 2 + 0.022, h.y0 + fw, h.y1 - fw, d + fd + 0.002, c)
        if o.get("corner") and h.s0 < 0.01:  # `corner`: glass round the wall's corner, its frames meeting in a slim post
            f.box("mh_detail", -0.005, 0.135, h.y0 - 0.005, h.y1 + 0.005, -h.depth - 0.005, 0.005, c)
        if h.kind == "w" and (o.get("tr") or (h.y1 - h.y0 > 1.75 and n > 1)):  # a transom: a top light
            t = h.y1 - (0.38 if o.get("tr") else 0.45)
            f.flat("mh_detail", h.s0 + fw, h.s1 - fw, t - 0.03, t + 0.03, d + fd + 0.004, c)
        sh = o.get("sh", 0.0)
        if sh > 0:  # a roller shutter, down this far
            y = h.y1 - (h.y1 - h.y0) * sh
            shc = o.get("shc", "#e7e6e1")
            f.flat("mh_panel", h.s0 + 0.02, h.s1 - 0.02, y, h.y1, d + 0.025, shc)
            for k in range(int((h.y1 - y) / 0.25)):
                yy = h.y1 - 0.25 * (k + 1)
                f.flat("mh_detail", h.s0 + 0.03, h.s1 - 0.03, yy - 0.006, yy + 0.006, d + 0.03, shade(shc, 0.85))
    if o.get("box"):  # the shutter box under the lintel
        f.flat("mh_panel", h.s0 + 0.01, h.s1 - 0.01, h.y1 - 0.2, h.y1, d + 0.045, "#e9e8e3")
    if h.kind in ("w", "a"):  # the sill (`sill`: its colour, a pale stone)
        over = 0.07 if o.get("sill") else 0.05
        f.box(SMALL_STONE, h.s0 - over, h.s1 + over, h.y0 - 0.07, h.y0, d, 0.05, o.get("sill", "#5d6266"))
    if o.get("fb"):  # a french balcony: a railing across the lower part of the window, just in front of the wall
        rc = o.get("rail", "#262829")
        top = h.y0 + 0.95
        f.box("mh_detail", h.s0 - 0.05, h.s1 + 0.05, top - 0.04, top, 0.03, 0.08, rc)
        f.box("mh_detail", h.s0 - 0.05, h.s1 + 0.05, h.y0 + 0.06, h.y0 + 0.1, 0.03, 0.08, rc)
        nb = max(4, int((h.s1 - h.s0) / 0.12))
        for k in range(1, nb):
            sb = h.s0 + (h.s1 - h.s0) * k / nb
            f.flat("mh_detail", sb - 0.012, sb + 0.012, h.y0 + 0.1, top - 0.04, 0.055, rc)
        for sb in (h.s0 - 0.05, h.s1 + 0.03):
            f.box("mh_detail", sb, sb + 0.02, h.y0 + 0.06, top, 0.0, 0.08, rc)
    if o.get("seg"):  # a segmental arch over the opening in a pale stone, with a keystone
        sc = o.get("segc", "#cfc6b6")
        cx, half = (h.s0 + h.s1) / 2, (h.s1 - h.s0) / 2 + 0.12
        rise, band, nseg = 0.2, 0.16, 8
        for k in range(nseg):
            a, b = -half + 2 * half * k / nseg, -half + 2 * half * (k + 1) / nseg
            ya, yb = h.y1 + rise * (1 - (a / half) ** 2), h.y1 + rise * (1 - (b / half) ** 2)
            face("mh_stone", [f.p(cx + a, ya, 0.012), f.p(cx + b, yb, 0.012), f.p(cx + b, yb + band, 0.012), f.p(cx + a, ya + band, 0.012)], f.out(), sc)
        f.box("mh_stone", cx - 0.1, cx + 0.1, h.y1 + rise - 0.03, h.y1 + rise + band + 0.07, 0.0, 0.03, shade(sc, 0.93))


def arch_top(f, h, wall_col, frame_c, glass):
    """A round top over an opening: the pane and frame as a half disc on the wall, a brick arch round it."""
    cx, r = (h.s0 + h.s1) / 2, (h.s1 - h.s0) / 2
    seg = 10
    pts = [f.p(cx + r * math.cos(math.pi * k / seg), h.y1 + r * math.sin(math.pi * k / seg), 0.012) for k in range(seg + 1)]
    face("mh_glass", pts, f.out(), glass)
    for k in range(seg):
        a0, a1 = math.pi * k / seg, math.pi * (k + 1) / seg
        ring = [(cx + rr * math.cos(a), h.y1 + rr * math.sin(a)) for rr, a in ((r, a0), (r, a1), (r + 0.16, a1), (r + 0.16, a0))]
        face("mh_brick", [f.p(s, y, 0.014) for s, y in ring], f.out(), shade(wall_col, 0.82))
        fr = [(cx + rr * math.cos(a), h.y1 + rr * math.sin(a)) for rr, a in ((r - 0.06, a0), (r - 0.06, a1), (r, a1), (r, a0))]
        face("mh_detail", [f.p(s, y, 0.016) for s, y in fr], f.out(), frame_c)
    f.flat("mh_detail", h.s0 + 0.03, h.s1 - 0.03, h.y1 - 0.02, h.y1 + 0.03, 0.017, frame_c)


def surround(f, h, width, col):
    """A flat surround round an opening, standing a little out of the wall."""
    w, d = width, 0.035
    f.box("mh_panel", h.s0 - w, h.s1 + w, h.y1, h.y1 + w, 0, d, col)
    f.box("mh_panel", h.s0 - w, h.s1 + w, h.y0 - w, h.y0, 0, d, col)
    f.box("mh_panel", h.s0 - w, h.s0, h.y0, h.y1, 0, d, col)
    f.box("mh_panel", h.s1, h.s1 + w, h.y0, h.y1, 0, d, col)


def oriel(f, s, w, y0, h, cu, frame_c):
    """A three-sided bay of white stone on a corbel, windows round it, a cap on top."""
    dep, cut = 0.55, 0.45
    stone = "#ece9e2"
    base, top = y0 - 0.6, y0 + h + 0.35
    plan = [(s - w / 2, 0), (s - w / 2 + cut, dep), (s + w / 2 - cut, dep), (s + w / 2, 0)]
    # the corbel and the cap
    solid("mh_stone", [f.p(a, y, d + (0.08 if y > base + 0.3 else 0)) for a, d in plan for y in (base, y0)], stone)
    solid("mh_stone", [f.p(a, y, d * 1.12 + 0.05) for a, d in plan for y in (y0 + h, top)], stone)
    for (a0, d0), (a1, d1) in zip(plan, plan[1:]):
        L = math.hypot(a1 - a0, d1 - d0)
        t = ((a1 - a0) / L, (d1 - d0) / L)
        o = (t[1], -t[0])
        # a frame along this side of the bay, in the wall's frame
        p0 = f.xz(a0, d0)
        tt = (f.t[0] * t[0] + f.o[0] * t[1], f.t[1] * t[0] + f.o[1] * t[1])
        oo = (f.t[0] * o[0] + f.o[0] * o[1], f.t[1] * o[0] + f.o[1] * o[1])
        if (oo[0] * f.o[0] + oo[1] * f.o[1]) < 0:
            oo = (-oo[0], -oo[1])
        g = Frame(p0, tt, oo, f.base)
        g.box("mh_stone", 0, L, y0, y0 + 0.12, -0.02, 0.02, stone)
        face("mh_glass", [g.p(0.08, y0 + 0.12), g.p(L - 0.08, y0 + 0.12), g.p(L - 0.08, y0 + h), g.p(0.08, y0 + h)], g.out(), CURTAIN if cu else "#252c30")
        for a, b in ((0, 0.08), (L - 0.08, L)):
            g.box("mh_stone", a, b, y0 + 0.12, y0 + h, -0.02, 0.02, stone)
        g.flat("mh_detail", 0.08, L - 0.08, y0 + h - 0.06, y0 + h, 0.01, frame_c)
        g.flat("mh_detail", 0.08, L - 0.08, y0 + 0.12, y0 + 0.18, 0.01, frame_c)
        if L > 1.0:
            g.flat("mh_detail", L / 2 - 0.03, L / 2 + 0.03, y0 + 0.12, y0 + h, 0.012, frame_c)
    f.flat("mh_brick", s - 0.35, s + 0.35, base - 0.55, base - 0.05, 0.004, "#a64e3a")


# ---------------------------------------------------------------- roofs
def slab(bottom, up, th, top_col, edge_col, under_col=None):
    """A roof plane as a slab: `bottom` its underside (game points), the top `th` higher along `up`."""
    upv = Vector(up)
    top = [tuple(Vector(p) + upv * th) for p in bottom]
    face("mh_roof", top, up, top_col)
    face("mh_detail", bottom, (-up[0], -up[1], -up[2]), under_col or edge_col)
    n = len(bottom)
    cx = sum(p[0] for p in bottom) / n
    cz = sum(p[1] for p in bottom) / n
    for i in range(n):
        a, b = bottom[i], bottom[(i + 1) % n]
        at, bt = top[i], top[(i + 1) % n]
        mid = ((a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cz, 0)
        face("mh_detail", [a, b, bt, at], mid, edge_col)


def plane_up(p0, p1, p2):
    a, b, c = Vector(p0), Vector(p1), Vector(p2)
    n = (b - a).cross(c - a).normalized()
    if n.z < 0:
        n = -n
    return (n.x, n.y, n.z)


def pitched(A, B, C, D, base, E, R, H, ridge_cap=True, party_ends=(False, False)):
    """A gable roof on the rectangle A B C D (game x, z): eaves along A-B and D-C at E, the ridge
    halfway at R (heights above `base`); it overhangs the eaves and the gables. Returns the slope."""
    t, L = unit(A, B)
    n, Dp = unit(A, D)
    over, verge, th = H.get("over", 0.3), H.get("verge_over", 0.18), 0.14
    half = Dp / 2
    k = (R - E) / half
    P = lambda s, q, y: (A[0] + t[0] * s + n[0] * q, A[1] + t[1] * s + n[1] * q, base + y)
    roof_c, fascia = H["roof_tint"], H["fascia_c"]
    soffit = H.get("soffit_c", fascia)
    v0, v1 = (0.0 if party_ends[0] else verge), (0.0 if party_ends[1] else verge)
    for q0, q1 in ((-over, half), (Dp + over, half)):
        y0 = E - over * k
        bottom = [P(-v0, q0, y0), P(L + v1, q0, y0), P(L + v1, q1, R), P(-v0, q1, R)]
        slab(bottom, plane_up(*bottom[:3]), th, roof_c, fascia, soffit)
    if ridge_cap:
        beam("mh_detail", P(-v0, half, R + th + 0.03), P(L + v1, half, R + th + 0.03), 0.24, 0.1, shade(roof_c, 0.75))
    gutter = H.get("gutter", "#8f9498")
    for q in (-over - 0.06, Dp + over + 0.06):
        yg = E - over * k - 0.04
        beam("mh_detail", P(-v0, q, yg), P(L + v1, q, yg), 0.12, 0.1, gutter)
    return k


def hipped(A, B, C, D, base, E, R, H):
    """A hipped roof on the rectangle A B C D, every side sloping at the same pitch."""
    t, L = unit(A, B)
    n, Dp = unit(A, D)
    if L < Dp:  # the ridge along the longer side
        A, B, C, D = B, C, D, A
        t, L = unit(A, B)
        n, Dp = unit(A, D)
    over, th = H.get("over", 0.3), 0.14
    half = Dp / 2
    k = (R - E) / half
    P = lambda s, q, y: (A[0] + t[0] * s + n[0] * q, A[1] + t[1] * s + n[1] * q, base + y)
    y0 = E - over * k
    e = [(-over, -over), (L + over, -over), (L + over, Dp + over), (-over, Dp + over)]
    r0, r1 = (half, half), (L - half, half)
    roof_c, fascia = H["roof_tint"], H.get("fascia_c", "#3b3d40")
    soffit = H.get("soffit_c", fascia)
    sides = [(e[0], e[1], r1, r0), (e[2], e[3], r0, r1), (e[1], e[2], r1), (e[3], e[0], r0)]
    for poly in sides:
        pts = []
        for idx, (s, q) in enumerate(poly):
            is_eave = (s, q) in e
            pts.append(P(s, q, y0 if is_eave else R))
        # drop a zero-length ridge (a pyramid)
        clean = []
        for p in pts:
            if not clean or Vector(p) - Vector(clean[-1]) != Vector((0, 0, 0)) and (Vector(p) - Vector(clean[-1])).length > 1e-4:
                clean.append(p)
        if len(clean) >= 3:
            slab(clean, plane_up(*clean[:3]), th, roof_c, fascia, soffit)
    cap = shade(roof_c, 0.75)
    if L - Dp > 0.05:
        beam("mh_detail", P(r0[0], half, R + th + 0.03), P(r1[0], half, R + th + 0.03), 0.22, 0.1, cap)
    for (s, q), r in ((e[0], r0), (e[3], r0), (e[1], r1), (e[2], r1)):
        beam("mh_detail", P(s, q, y0 + th + 0.03), P(r[0], r[1], R + th + 0.03), 0.18, 0.08, cap)
    gutter = H.get("gutter", "#8f9498")
    yg = y0 - 0.04
    g = [(-over - 0.06, -over - 0.06), (L + over + 0.06, -over - 0.06), (L + over + 0.06, Dp + over + 0.06), (-over - 0.06, Dp + over + 0.06)]
    for i in range(4):
        a, b = g[i], g[(i + 1) % 4]
        beam("mh_detail", P(a[0], a[1], yg), P(b[0], b[1], yg), 0.12, 0.1, gutter)
    return k


def flat_roof(ring, base, E, H):
    """A flat roof on any outline: the dark roofing, a coping or a broad fascia round it."""
    fascia = H.get("fascia")
    if fascia:
        over, hh, col = fascia["over"], fascia["h"], fascia["tint"]
        grown = offset_ring(ring, over)
        face("mh_stone", [(x, z, base + E + 0.02) for x, z in grown], (0, 0, 1), "#55575a")
        face("mh_detail", [(x, z, base + E - hh + 0.1) for x, z in grown], (0, 0, -1), col)
        n = len(grown)
        for i in range(n):
            a, b = grown[i], grown[(i + 1) % n]
            face("mh_detail", [(a[0], a[1], base + E - hh + 0.1), (b[0], b[1], base + E - hh + 0.1), (b[0], b[1], base + E + 0.12), (a[0], a[1], base + E + 0.12)],
                 outward(grown, i), col)
    else:
        face("mh_stone", [(x, z, base + E - 0.05) for x, z in ring], (0, 0, 1), "#4f5154")
        col = H.get("coping", "#7c7f82")
        ch = H.get("coping_h", 0.1)  # how far it stands above the wall: a thin aluminium coping less
        n = len(ring)
        for i in range(n):
            a, b = ring[i], ring[(i + 1) % n]
            o = outward(ring, i)
            t, L = unit(a, b)
            f = Frame(a, t, (o[0], o[1]), base)
            f.box("mh_stone", -0.03, L + 0.03, E - 0.02, E + ch, -0.25, 0.04, col)


def offset_ring(ring, d):
    """The outline grown by d (a simple miter offset, for convex-ish outlines)."""
    n = len(ring)
    area = sum(ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1] for i in range(n))
    sgn = 1 if area > 0 else -1
    out = []
    for i in range(n):
        p0, p1, p2 = ring[i - 1], ring[i], ring[(i + 1) % n]
        (t0x, t0z), _ = unit(p0, p1)
        (t1x, t1z), _ = unit(p1, p2)
        n0 = (t0z * sgn, -t0x * sgn)
        n1 = (t1z * sgn, -t1x * sgn)
        m = (n0[0] + n1[0], n0[1] + n1[1])
        ml = math.hypot(*m) or 1
        m = (m[0] / ml, m[1] / ml)
        cos = max(0.3, m[0] * n1[0] + m[1] * n1[1])
        out.append((p1[0] - m[0] * d / cos, p1[1] - m[1] * d / cos))
    # grow outwards: the sign above points inwards for one winding; check with the area
    test = sum(out[i][0] * out[(i + 1) % n][1] - out[(i + 1) % n][0] * out[i][1] for i in range(n))
    if abs(test) < abs(area):
        out = []
        for i in range(n):
            p0, p1, p2 = ring[i - 1], ring[i], ring[(i + 1) % n]
            (t0x, t0z), _ = unit(p0, p1)
            (t1x, t1z), _ = unit(p1, p2)
            n0 = (t0z * sgn, -t0x * sgn)
            n1 = (t1z * sgn, -t1x * sgn)
            m = (n0[0] + n1[0], n0[1] + n1[1])
            ml = math.hypot(*m) or 1
            m = (m[0] / ml, m[1] / ml)
            cos = max(0.3, m[0] * n1[0] + m[1] * n1[1])
            out.append((p1[0] + m[0] * d / cos, p1[1] + m[1] * d / cos))
    return out


def outward(ring, i):
    """The outward normal (x, z, 0) of edge i of an outline."""
    n = len(ring)
    a, b = ring[i], ring[(i + 1) % n]
    (tx, tz), L = unit(a, b)
    area = sum(ring[k][0] * ring[(k + 1) % n][1] - ring[(k + 1) % n][0] * ring[k][1] for k in range(n))
    # for a counter-clockwise outline in (x, z) the outside is to the right of each edge
    o = (tz, -tx) if area > 0 else (-tz, tx)
    return (o[0], o[1], 0.0)


# ---------------------------------------------------------------- the street
def make_stations(line, left, right):
    """A centre line's points, each with its tangent, normal (+z side) and free widths."""
    out = []
    for k, (x, z) in enumerate(line):
        a, b = line[max(0, k - 1)], line[min(len(line) - 1, k + 1)]
        (tx, tz), _ = unit(a, b)
        out.append(dict(x=x, z=z, t=(tx, tz), n=(-tz, tx), L=left[k], R=right[k]))
    return out


LINE = DATA["line"]
ST = make_stations(LINE, DATA["left"], DATA["right"])
for _extra in DATA.get("lines", []):  # other streets the houses face (each its own stations, one list to search)
    ST += make_stations(_extra["line"], _extra["left"], _extra["right"])
# The branch that turns off at the junction where the map ends (its first stretch).
STUB = make_stations(DATA["stub"]["line"], DATA["stub"]["left"], DATA["stub"]["right"]) if DATA.get("stub") else []
ASPH, GUT, LANE, KERB = 2.5, 2.85, 4.45, 4.6
OLD_GUT, OLD_KERB, OLD_WALK = 2.75, 3.05, 3.2  # west of the island: the old concrete road's gutter, kerb and pavement
# Heights above the lawn: the asphalt, the raised cycle lane, the kerb and the pavement (the game measures a block
# out on the relief from 0.1 m above the lawn, the lawn being at GROUND, so its blocks for walking on add GROUND)
Y_ROAD, Y_LANE, Y_KERB, Y_WALK = 0.06, 0.10, 0.15, 0.13
ASPHALT, RED, CONC, KERB_C, PAVE = "#535558", "#b9766f", "#b3b9c0", "#bcc2c8", "#c9c5be"


def walk_edge(k, side, st=None):
    """How far the pavement reaches from the centre line at station k on one side (+1: +z), as street() draws it."""
    s = (st or ST)[k]
    return min(6.8, max(KERB + 0.9, s["L"] if side == 1 else s["R"]))


def nearest_station(x, z):
    return min(range(len(ST)), key=lambda k: (ST[k]["x"] - x) ** 2 + (ST[k]["z"] - z) ** 2)


def band_point(k, d, side, st=None):
    s = (st or ST)[k]
    return (s["x"] + s["n"][0] * d * side, s["z"] + s["n"][1] * d * side)


def ribbon(mat, ks, d0f, d1f, lift0, lift1, col, side=1, st=None):
    """A strip along the stations ks between offsets d0f(k) and d1f(k) on one side (+1: +z), lifted above the relief."""
    rows = [(band_point(k, d0f(k), side, st), band_point(k, d1f(k), side, st)) for k in ks]
    for (a0, a1), (b0, b1), ka, kb in zip(rows, rows[1:], ks, ks[1:]):
        if kb != ka + 1:  # not next to each other: a gap in the run
            continue
        pts = [a0, a1, b1, b0]
        face(mat, [(x, z, terrain(x, z) + (lift0 if i in (0, 3) else lift1)) for i, (x, z) in enumerate(pts)], (0, 0, 1), col)


def riser(mat, ks, df, y_lo, y_hi, col, side, facing, st=None):
    """An upright edge along offset df(k): from y_lo to y_hi above the relief, facing out (+1) or in (-1)."""
    st = st or ST
    for ka, kb in zip(ks, ks[1:]):
        if kb != ka + 1:
            continue
        a, b = band_point(ka, df(ka), side, st), band_point(kb, df(kb), side, st)
        s = st[ka]
        out = (s["n"][0] * side * facing, s["n"][1] * side * facing, 0)
        face(mat, [(a[0], a[1], terrain(*a) + y_lo), (b[0], b[1], terrain(*b) + y_lo), (b[0], b[1], terrain(*b) + y_hi), (a[0], a[1], terrain(*a) + y_hi)], out, col)


def walk_blocks(ks, d0f, d1f, side, y, m, st=None):
    """Blocks for walking and driving on, a little above the relief, in pieces of 20 m."""
    runs, cur = [], []
    for k in ks:
        if cur and k != cur[-1] + 1:
            runs.append(cur)
            cur = []
        cur.append(k)
    if cur:
        runs.append(cur)
    for run in runs:
        for i in range(0, len(run) - 1, 10):
            part = run[i:i + 11]
            if len(part) < 2:
                continue
            ring = [band_point(k, d0f(k), side, st) for k in part] + [band_point(k, d1f(k), side, st) for k in part[::-1]]
            SOLIDS.append({"p": [[round(x, 3), round(z, 3)] for x, z in ring], "y0": -0.3 + GROUND, "y1": y + GROUND, "m": m, "lift": True})


def end_cap(st, k, back, d0, d1):
    s = st[k]
    a = (s["x"] + s["n"][0] * d0, s["z"] + s["n"][1] * d0)
    b = (s["x"] + s["n"][0] * d1, s["z"] + s["n"][1] * d1)
    face("mh_asphalt", [(a[0], a[1], terrain(*a) - 0.06), (b[0], b[1], terrain(*b) - 0.06), (b[0], b[1], terrain(*b) + Y_ROAD), (a[0], a[1], terrain(*a) + Y_ROAD)],
         (s["t"][0] * back, s["t"][1] * back, 0), ASPHALT)


def dist_to_line(p, st):
    best = 1e9
    for a, b in zip(st, st[1:]):
        (tx, tz), L = unit((a["x"], a["z"]), (b["x"], b["z"]))
        t = max(0, min(L, (p[0] - a["x"]) * tx + (p[1] - a["z"]) * tz))
        best = min(best, math.hypot(a["x"] + tx * t - p[0], a["z"] + tz * t - p[1]))
    return best


def new_layout(st, ks, mouth=()):
    """The rebuilt street on stations ks: the asphalt, and either side the gutter with its drains, the raised red
    cycle lane, the kerb and the pavement; where a side road leaves (`mouth`, stations on the +z side) asphalt instead."""
    ribbon("mh_asphalt", ks, lambda k: -ASPH, lambda k: ASPH, Y_ROAD, Y_ROAD, ASPHALT, st=st)
    end_cap(st, ks[-1], 1, -ASPH, ASPH)
    walk_blocks(ks, lambda k: -ASPH, lambda k: ASPH, 1, Y_ROAD, "road", st)
    for side in (1, -1):
        W = lambda k, side=side: walk_edge(k, side, st)
        lanes = [k for k in ks if not (side == 1 and k in mouth)]
        ribbon("mh_stone", lanes, lambda k: ASPH, lambda k: GUT, Y_ROAD + 0.002, Y_ROAD + 0.002, CONC, side, st)
        ribbon("mh_asphalt", lanes, lambda k: GUT, lambda k: LANE, Y_LANE, Y_LANE, RED, side, st)
        riser("mh_stone", lanes, lambda k: GUT, Y_ROAD, Y_LANE, CONC, side, -1, st)
        ribbon("mh_stone", lanes, lambda k: LANE, lambda k: KERB, Y_KERB, Y_KERB, KERB_C, side, st)
        riser("mh_stone", lanes, lambda k: LANE, Y_LANE, Y_KERB, KERB_C, side, -1, st)
        ribbon("mh_pavers", lanes, lambda k: KERB, W, Y_WALK, Y_WALK, PAVE, side, st)
        riser("mh_pavers", lanes, W, -0.06, Y_WALK, PAVE, side, 1, st)
        riser("mh_stone", lanes, lambda k: KERB, Y_WALK, Y_KERB, KERB_C, side, 1, st)
        walk_blocks(lanes, lambda k: GUT, W, side, Y_WALK, "pave_light", st)
        for k in lanes[3::10]:  # the drains in the gutter, every 20 m or so
            s = st[k]
            x, z = band_point(k, (ASPH + GUT) / 2, side, st)
            f = Frame((x - s["t"][0] * 0.25, z - s["t"][1] * 0.25), s["t"], (s["n"][0] * side, s["n"][1] * side), terrain(x, z))
            f.box("mh_detail", 0, 0.5, Y_ROAD - 0.005, Y_ROAD + 0.006, -0.16, 0.16, "#2e3032")
        if side == 1 and mouth:  # the side road's mouth: asphalt up to the pavement's line
            m = sorted(mouth)
            ribbon("mh_asphalt", m, lambda k: ASPH, W, Y_ROAD, Y_ROAD, ASPHALT, 1, st)
            walk_blocks(m, lambda k: ASPH, W, 1, Y_ROAD, "road", st)


# The village's road surface round the street (the GRB's, web/src/data/village.json): its forecourts.
_VILLAGE = json.load(open(os.path.join(ROOT, "web", "src", "data", "village.json"), encoding="utf-8"))
ROADS = [q["p"][0] for q in _VILLAGE["prisms"] if q["m"] == "road" and any(600 < x < 960 and -780 < z < -650 for x, z in q["p"][0])]
del _VILLAGE
Y_FORE = 0.06


def in_road(x, z):
    for ring in ROADS:
        hit = False
        for i in range(len(ring)):
            (xi, zi), (xj, zj) = ring[i], ring[i - 1]
            if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
                hit = not hit
        if hit:
            return True
    return False


def forecourts():
    """Where the old road surface reaches on past the pavement's back edge, as far as 4 m: grey pavers a little
    lower than the pavement, up to where it stops."""
    for side in (1, -1):
        reach = {}
        for k in range(len(ST)):
            W = walk_edge(k, side)
            d = W
            while d < W + 4.0 and in_road(*band_point(k, d + 0.25, side)):
                d += 0.25
            if d > W + 0.3:
                reach[k] = d
        ks = sorted(reach)
        W = lambda k, side=side: walk_edge(k, side)
        ribbon("mh_pavers", ks, W, lambda k: reach[k], Y_FORE, Y_FORE, "#bfbab2", side)
        riser("mh_pavers", ks, lambda k: reach[k], -0.06, Y_FORE, "#bfbab2", side, 1)
        walk_blocks(ks, W, lambda k: reach[k], side, Y_FORE, "pave_light")


def street():
    # West of the island: the old concrete road stays (the village draws it); a concrete gutter, a kerb and the
    # pavements of grey pavers either side, as Street View shows them in 2026.
    old = [k for k, s in enumerate(ST) if s["x"] < WEST_END + 4.0]
    for side in (1, -1):
        W = lambda k, side=side: walk_edge(k, side)
        ribbon("mh_stone", old, lambda k: OLD_GUT, lambda k: OLD_KERB, Y_ROAD - 0.02, Y_ROAD - 0.02, CONC, side)
        ribbon("mh_stone", old, lambda k: OLD_KERB, lambda k: OLD_WALK, Y_KERB, Y_KERB, KERB_C, side)
        riser("mh_stone", old, lambda k: OLD_KERB, Y_ROAD - 0.02, Y_KERB, KERB_C, side, -1)
        ribbon("mh_pavers", old, lambda k: OLD_WALK, W, Y_WALK, Y_WALK, PAVE, side)
        riser("mh_pavers", old, W, -0.06, Y_WALK, PAVE, side, 1)
        riser("mh_stone", old, lambda k: OLD_WALK, Y_WALK, Y_KERB, KERB_C, side, 1)
        walk_blocks(old, lambda k: OLD_KERB, W, side, Y_WALK, "pave_light")
    # From the island to the junction and on: the rebuilt street. Where the branch turns off at the junction,
    # the main line's +z side gives way to the branch's mouth.
    ks = [k for k, s in enumerate(ST) if WEST_END <= s["x"] <= EAST_END]
    mouth = set()
    if STUB:
        for k in ks:
            if dist_to_line(band_point(k, walk_edge(k, 1), 1), STUB) < walk_edge(0, 1, STUB) + 0.4:
                mouth.add(k)
    new_layout(ST, ks, mouth)
    end_cap(ST, ks[0], -1, -ASPH, ASPH)
    forecourts()
    if STUB:
        first = next(k for k in range(len(STUB)) if dist_to_line((STUB[k]["x"], STUB[k]["z"]), ST) >= walk_edge(ks[0], 1) + 1.2)
        sk = list(range(first, len(STUB)))
        new_layout(STUB, sk)
        if mouth:  # between the main line's mouth and where the branch's own layout starts: asphalt
            m = sorted(mouth)
            pts = [band_point(m[0], walk_edge(m[0], 1), 1), band_point(m[-1], walk_edge(m[-1], 1), 1),
                   band_point(first, walk_edge(first, 1, STUB), 1, STUB), band_point(first, walk_edge(first, -1, STUB), -1, STUB)]
            cx, cz = sum(p[0] for p in pts) / 4, sum(p[1] for p in pts) / 4
            pts.sort(key=lambda p: math.atan2(p[1] - cz, p[0] - cx))
            face("mh_asphalt", [(x, z, terrain(x, z) + Y_ROAD - 0.003) for x, z in pts], (0, 0, 1), ASPHALT)
            SOLIDS.append({"p": [[round(x, 3), round(z, 3)] for x, z in pts], "y0": -0.3 + GROUND, "y1": Y_ROAD + GROUND, "m": "road", "lift": True})


def street_outline():
    """The street's outline (the pavements' outer edges), from the church square to the end of the main line, for
    the game to hide what lay on the old one and to keep posts and signs off it: one edge west to east, the other back."""
    left, right = [], []
    for k, s in enumerate(ST):
        wl, wr = walk_edge(k, 1), walk_edge(k, -1)
        left.append([round(s["x"] + s["n"][0] * wl, 2), round(s["z"] + s["n"][1] * wl, 2)])
        right.append([round(s["x"] - s["n"][0] * wr, 2), round(s["z"] - s["n"][1] * wr, 2)])
    if not STUB:
        return left + right[::-1]
    # The branch (its whole length since the band along it): the +z edge turns into its mouth, runs out along the
    # branch's west edge and back along its east edge, and carries on east of the mouth.
    mouth = [k for k in range(len(ST)) if dist_to_line(band_point(k, walk_edge(k, 1), 1), STUB) < walk_edge(0, 1, STUB) + 0.4]
    first = next(k for k in range(len(STUB)) if dist_to_line((STUB[k]["x"], STUB[k]["z"]), ST) >= walk_edge(mouth[0] if mouth else 0, 1) + 1.2)
    edge = lambda k, side: [round(STUB[k]["x"] + STUB[k]["n"][0] * walk_edge(k, side, STUB) * side, 2),
                            round(STUB[k]["z"] + STUB[k]["n"][1] * walk_edge(k, side, STUB) * side, 2)]
    branch = [edge(k, 1) for k in range(first, len(STUB))] + [edge(k, -1) for k in range(len(STUB) - 1, first - 1, -1)]
    m0, m1 = (min(mouth), max(mouth)) if mouth else (len(ST), len(ST) - 1)
    return left[:m0] + branch + left[m1 + 1:] + right[::-1]


def s_ok(k):
    """Stations with the cycle lanes and pavements (the island ends them at the west)."""
    return ST[k]["x"] >= WEST_END + 4.0


# ---------------------------------------------------------------- houses
def house(key, H):
    INSIDE[0] = bool(H.get("inside"))
    LONG[0] = bool(H.get("long_brick"))
    if LONG[0] and "long" not in BM["mh_brick"].faces.layers.int:  # made now: a new layer would lose the faces held
        BM["mh_brick"].faces.layers.int.new("long")
    try:
        build_house(key, H)
        if H.get("site"):
            site(H)
    finally:
        INSIDE[0] = False
        LONG[0] = False


def build_house(key, H):
    (ax, az), (bx, bz) = H["front"]
    a, b = (ax, az), (bx, bz)
    t, L = unit(a, b)
    o = tuple(H["out"])
    base = H["y0"] + 0.05
    E = H["eaves"]
    roof = H["roof"]
    wall_mat = {"brick": "mh_brick", "render": "mh_render", "cladding": "mh_cladding"}[H["wall"]]
    tint = H["tint"]
    layers = [(-99, wall_mat, tint)]
    pl = H.get("plinth")
    if pl:
        kind = pl[2] if len(pl) > 2 else "stone"
        layers = [(-99, {"brick": "mh_brick", "render": "mh_render"}.get(kind, "mh_stone"), pl[1]), (pl[0], wall_mat, tint)]
    fo = H.get("footing")  # (top, colour): the concrete footing under the plinth, showing where the ground falls away
    if fo:
        layers = [(-99, "mh_stone", fo[1]), (fo[0], *layers[0][1:])] + layers[1:]
    up = H.get("upper")
    if up:
        layers.append((up["y"], {"brick": "mh_brick", "render": "mh_render", "cladding": "mh_render"}[up["wall"]], up["tint"]))
    frame_c = H.get("frame", "#f1f0ec")
    H.setdefault("fascia_c", "#f0efeb" if H.get("eave_board") or H.get("verge") else "#3b3d40")
    if H.get("eave_board"):
        H["over"] = H["eave_board"]
    main = H["main"]
    party = H["main_party"]
    # The main body: walls on its outline, the front one (nearest the front wall found) with the survey's openings.
    n_edges = len(main)
    fi = min(range(n_edges), key=lambda i: math.dist(((main[i][0] + main[(i + 1) % n_edges][0]) / 2, (main[i][1] + main[(i + 1) % n_edges][1]) / 2),
                                                       ((ax + bx) / 2, (az + bz) / 2)))
    rect = len(main) == 4
    # the rectangle's corners in order: front west, front east, back east, back west
    if rect:
        fa, fb = main[fi], main[(fi + 1) % 4]
        if not left_first(fa, fb, outward(main, fi)):
            order = [main[(fi + 1) % 4], main[fi], main[(fi + 3) % 4], main[(fi + 2) % 4]]
        else:
            order = [main[fi], main[(fi + 1) % 4], main[(fi + 2) % 4], main[(fi + 3) % 4]]
        A, B, C, D = order
    R = H.get("ridge", E)
    tops = {}
    if rect:
        tF, LF = unit(A, B)
        nF, DF = unit(A, D)
        if roof == "gable":
            tops = {"side": [(0, E), (DF / 2, R), (DF, E)]}
        elif roof == "front_gable":
            tops = {"front": [(0, E), (LF / 2, R), (LF, E)], "back": [(0, E), (LF / 2, R), (LF, E)]}
        fg = H.get("front_gable")
        tw = H.get("tower")
    extra = {}
    for fc in H.get("faces", []):
        j = min(range(n_edges), key=lambda i: dist_to_ring(fc["near"], [main[i], main[(i + 1) % n_edges]]))
        extra[j] = fc
    for i in range(n_edges):
        p, q = main[i], main[(i + 1) % n_edges]
        tt, LL = unit(p, q)
        oo = outward(main, i)
        is_front = i == fi
        # the front runs the way fronts run (west to east, or left to right as seen from the street)
        if is_front and not left_first(p, q, oo):
            p, q = q, p
            tt, LL = unit(p, q)
        f = Frame(p, tt, (oo[0], oo[1]), base)
        top = [(0, E), (LL, E)]
        if rect and roof != "flat":
            # which side of the rectangle is this edge?
            mid = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
            dF = abs((mid[0] - A[0]) * (-tF[1]) + (mid[1] - A[1]) * tF[0])
            along_front = abs(tt[0] * tF[0] + tt[1] * tF[1]) > 0.7
            if along_front and "front" in tops:
                top = tops["front"] if dF < 0.5 else tops["back"]
                if not is_front:  # the back runs the other way
                    top = [(LL - s, y) for s, y in top[::-1]]
            elif not along_front and "side" in tops:
                # the gable: from the front corner to the back corner
                start_front = math.dist(p, A) < 0.5 or math.dist(p, B) < 0.5
                top = tops["side"] if start_front else [(LL - s, y) for s, y in tops["side"][::-1]]
        holes = []
        if is_front:
            if rect and H.get("tower"):
                s0, s1 = H["tower"]["s"]
                top = [(0, H["tower"]["top"]), (s1, H["tower"]["top"]), (s1, E), (LL, E)] if s0 < 0.1 else [(0, E), (s0, E), (s0, H["tower"]["top"]), (LL, H["tower"]["top"])]
            if rect and H.get("front_gable"):
                g0, g1 = H["front_gable"]["s"]
                top = [(0, E), (g0, E), ((g0 + g1) / 2, H["front_gable"]["top"]), (g1, E), (LL, E)]
            for (s, w, y, hh, kind, opt) in H["openings"]:
                if kind == "bay":
                    continue
                if opt.get("recess"):
                    continue
                holes.append(Hole(s - w / 2, s + w / 2, y, y + hh, kind, 0.13, {**opt, "f": opt.get("f", frame_c)}))
            porch = H.get("porch")
            if porch:
                holes.append(Hole(porch["s"][0], porch["s"][1], 0.0, porch["h"], "porch", porch["depth"]))
        elif i in extra:
            if not left_first(p, q, oo):  # openings measured from the end fronts start at
                p, q = q, p
                tt, LL = unit(p, q)
                f = Frame(p, tt, (oo[0], oo[1]), base)
            holes = [Hole(s_ - w / 2, s_ + w / 2, y, y + hh, kind, 0.13, {**opt, "f": opt.get("f", frame_c)}) for (s_, w, y, hh, kind, opt) in extra[i]["openings"]]
        elif not party[i] and LL > 2.5 and not (LEAN and oo[0] * o[0] + oo[1] * o[1] < -0.3) and not H.get("plain"):
            holes = auto_windows(LL, E, max(y for _, y in top), frame_c, top)  # (`plain`: none, a blank end wall)
        facade(f, LL, top, holes, layers, patches=front_patches(H, LL, holes) if is_front else face_patches(H, extra.get(i), LL, holes))
        for s0, s1, y0, y1, d0, d1, col in (extra[i].get("boxes", []) if i in extra and not is_front else []):  # a box on the wall (a screen's)
            f.box("mh_detail", s0, s1, y0, y1, d0, d1, col)
        if up and up["wall"] == "cladding":
            boards(f, LL, top, holes, up)
        if is_front and up and H.get("timber"):
            timbers(f, LL, top, holes, up["y"], H["timber"])
        if is_front:
            front_details(f, LL, H, holes, layers, frame_c, base)
            FRONT[key] = (f, LL)
        for hh_ in holes:
            if hh_.kind in ("a", "ad"):
                arch_top(f, hh_, tint, frame_c, CURTAIN if hh_.opt.get("cu") else "#252c30")
            if hh_.kind == "g" and hh_.opt.get("arch"):
                arch_top(f, hh_, tint, shade(hh_.opt.get("c", "#6a442c"), 0.8), hh_.opt.get("c", "#6a442c"))
        if is_front:
            extras_on_front(f, LL, H, base)
            if H.get("steps") and roof == "front_gable":
                stepped_gable(f, LL, E, R, tint)
    # The roof.
    if roof == "flat" or not rect:
        flat_roof(main, base, E, H)
    elif roof == "gable":
        pitched(A, B, C, D, base, E, R, H, party_ends=(side_party(main, party, A, D), side_party(main, party, B, C)))
    elif roof == "front_gable":
        pitched(A, D, C, B, base, E, R, H, party_ends=(False, False))
    elif roof == "hip":
        hipped(A, B, C, D, base, E, R, H)
    if H.get("overhang"):
        overhang(H, base)
    if rect:
        roof_extras(H, A, B, C, D, base, E, R)
        downpipes(H, A, B, C, D, base, E, party, fi)
    # The lower parts: flat roofs at the village's lowest height.
    low = max(2.6, min(H["low"], E - 0.3)) if H["low"] < E - 0.2 else E
    alayers = layers
    if H.get("annex_wall"):
        alayers = [(-99, {"brick": "mh_brick", "render": "mh_render"}[H["annex_wall"][0]], H["annex_wall"][1])]
    for an in H["annex"]:
        ring = an["p"]
        for i in range(len(ring)):
            p, q = ring[i], ring[(i + 1) % len(ring)]
            mid = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
            if dist_to_ring(mid, main) < 0.2:
                continue
            tt, LL = unit(p, q)
            if LL < 0.3:
                continue
            oo = outward(ring, i)
            f = Frame(p, tt, (oo[0], oo[1]), base)
            faces_away = LEAN and oo[0] * o[0] + oo[1] * o[1] < 0.3
            holes = [] if an["party"][i] or LL < 2.4 or faces_away else [Hole(LL / 2 - 0.6, LL / 2 + 0.6, 0.9, 2.1, "w", 0.12, {"f": frame_c})]
            af = H.get("annex_front")
            if af and not an["party"][i] and oo[0] * H["out"][0] + oo[1] * H["out"][1] > 0.9 and LL > 2.4:
                if not left_first(p, q, oo):  # measured like the front
                    p, q = q, p
                    tt, LL = unit(p, q)
                    f = Frame(p, tt, (oo[0], oo[1]), base)
                holes = [Hole(s_ - w / 2, s_ + w / 2, y, y + hh, kind, 0.12, {**opt, "f": opt.get("f", frame_c)}) for (s_, w, y, hh, kind, opt) in af]
            facade(f, LL, [(0, low), (LL, low)], holes, alayers)
        flat_roof(ring, base, low, {"coping": "#6d6f72"})
        if H.get("laser"):
            SOLIDS.append(prism_xz([tuple(q) for q in ring], base - 0.3, base + low))
    if H.get("laser"):  # past the edge of the village data there are no blocks to walk into: the model brings its own
        SOLIDS.append(prism_xz([tuple(q) for q in main], base - 0.3, base + E))
    garden(key, H, base)
    if H.get("garden"):
        yard(H)


FRONT = {}


def extras_on_front(f, L, H, base):
    """A round window high in a gable, a slate canopy over the ground floor, a vending machine against the wall."""
    oc = H.get("oculus")
    if oc:
        s0, y, r = L / 2, oc["y"], oc["r"]
        seg = 14
        ring = [(s0 + r * math.cos(2 * math.pi * k / seg), y + r * math.sin(2 * math.pi * k / seg)) for k in range(seg)]
        face("mh_glass", [f.p(a, b, 0.012) for a, b in ring], f.out(), "#252c30")
        for k in range(seg):
            a0, a1 = 2 * math.pi * k / seg, 2 * math.pi * (k + 1) / seg
            q = [(s0 + rr * math.cos(a), y + rr * math.sin(a)) for rr, a in ((r, a0), (r, a1), (r + 0.14, a1), (r + 0.14, a0))]
            face("mh_stone", [f.p(a, b, 0.014) for a, b in q], f.out(), "#d8d3c8")
    cn = H.get("canopy")
    if cn:
        s0, s1 = cn["s"]
        y = cn["y"]
        bottom = [f.p(s0, y, 0.0), f.p(s1, y, 0.0), f.p(s1, y - 0.35, 0.75), f.p(s0, y - 0.35, 0.75)]
        slab(bottom, plane_up(*bottom[:3]), 0.08, H["roof_tint"], "#f0efeb", "#f0efeb")
    vd = H.get("vending")
    if vd:  # a bread vending machine against the wall: a grey cabinet with a dark glazed front (no lettering)
        f.box("mh_panel", vd - 0.55, vd + 0.55, 0.0, 2.05, 0.0, 0.75, "#d9dadb")
        f.box("mh_glass", vd - 0.42, vd + 0.2, 0.55, 1.75, 0.75, 0.77, "#2a3136")
        f.box("mh_panel", vd - 0.62, vd + 0.62, 2.05, 2.2, -0.02, 0.85, "#c73b32")


def side_party(ring, party, p, q):
    """Whether the outline's edge from p to q (either way) stands against a neighbour."""
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        if (math.dist(a, p) < 0.05 and math.dist(b, q) < 0.05) or (math.dist(a, q) < 0.05 and math.dist(b, p) < 0.05):
            return party[i]
    return False


def dist_to_ring(p, ring):
    best = 1e9
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        (tx, tz), L = unit(a, b)
        s = max(0, min(L, (p[0] - a[0]) * tx + (p[1] - a[1]) * tz))
        q = (a[0] + tx * s, a[1] + tz * s)
        best = min(best, math.dist(p, q))
    return best


def timbers(f, L, top, holes, y0, col):
    """Half-timbering over the front's upper layer: a beam along its foot, posts every 0.9 m up to the top line
    (clear of the openings), braces in the outer bays."""
    def ytop(s):
        for (s0, ya), (s1, yb) in zip(top, top[1:]):
            if s1 - s0 > 1e-9 and s0 - 1e-6 <= s <= s1 + 1e-6:
                return ya + (yb - ya) * (s - s0) / (s1 - s0)
        return top[-1][1]
    f.flat("mh_detail", 0.05, L - 0.05, y0, y0 + 0.16, 0.012, col)
    n = max(2, int(L / 0.9))
    for k in range(n + 1):
        sk = 0.12 + (L - 0.24) * k / n
        y1 = ytop(sk) - 0.12
        if y1 < y0 + 0.4 or any(hl.s0 - 0.1 < sk < hl.s1 + 0.1 and hl.y1 > y0 for hl in holes):
            continue
        f.flat("mh_detail", sk - 0.07, sk + 0.07, y0 + 0.16, y1, 0.012, col)


def boards(f, L, top, holes, up):
    """Horizontal boards on a wall above up["y"]: a thin shadow under each one every 20 cm, up to the wall's top line."""
    def ytop(s):
        for (s0, y0), (s1, y1) in zip(top, top[1:]):
            if s1 - s0 > 1e-9 and s0 - 1e-6 <= s <= s1 + 1e-6:
                return y0 + (y1 - y0) * (s - s0) / (s1 - s0)
        return top[-1][1]
    y = up["y"] + 0.2
    peak = max(yv for _, yv in top)
    while y < peak - 0.05:
        segs = [(0.0, L)]
        for hl in holes:
            if hl.y0 - 0.02 < y < hl.y1 + 0.02:
                segs = [(a, b) for a0, b0 in segs for a, b in ((a0, min(b0, hl.s0)), (max(a0, hl.s1), b0)) if b - a > 0.02]
        for a, b in segs:
            # keep under the top line (a gable): shrink the stretch to where the wall reaches above it
            xs = [a + (b - a) * i / 16 for i in range(17)]
            inside = [x for x in xs if ytop(x) > y + 0.02]
            if len(inside) < 2:
                continue
            a2, b2 = inside[0], inside[-1]
            f.flat("mh_render", a2, b2, y - 0.018, y, 0.006, shade(up["tint"], 0.72))
            f.flat("mh_render", a2, b2, y, y + 0.012, 0.004, shade(up["tint"], 1.08))
        y += 0.2
    f.box("mh_detail", -0.02, L + 0.02, up["y"] - 0.03, up["y"] + 0.03, 0.0, 0.04, "#8c8e8f")


def auto_windows(L, E, R, frame_c, top):
    """Plainer windows on a side or back wall: one or two a floor, none where a floor doesn't fit."""
    holes = []
    floors = [(0.85, 1.3)] + ([(3.55, 1.2)] if E > 4.9 else [])
    if R - E > 2.6 and L > 4:  # a window in the gable
        floors.append((E + 0.4, 1.0))
    for y, h in floors:
        n = 1 if L < 7 else 2
        w = 1.1 if y < E else 0.8
        for k in range(n):
            s = L * (k + 1) / (n + 1)
            ytop = min(yv for sv, yv in top) if y < E else None
            if y >= E:
                # only where the gable is high enough
                peak = max(yv for sv, yv in top)
                if peak < y + h + 0.6:
                    continue
                s = L / 2
                if k:
                    continue
            holes.append(Hole(s - w / 2, s + w / 2, y, y + h, "w", 0.12, {"f": frame_c, "cu": (k + int(y)) % 2 == 0}))
    return holes


def front_patches(H, L, holes):
    """The other brick laid into the front wall: `patches` [(s0, s1, y0, y1, tint)] (a negative s counts from the
    far end, an s1 of None is the far end), and `soldiers`: a soldier course in that tint over every opening (one
    that nearly reaches a corner runs on to it)."""
    fix = lambda v: v + L if v < 0 else v
    out = []
    for s0, s1, y0, y1, tint in H.get("patches", []):
        out.append((max(0.0, fix(s0)), L if s1 is None else min(L, fix(s1)), y0, y1, "mh_brick", tint))
    if H.get("soldiers"):
        out += soldier_courses(H, L, holes)
    return out


def soldier_courses(H, L, holes):
    """A soldier course in the house's `soldiers` tint over every opening (one that nearly reaches a corner runs on to it)."""
    out = []
    for hl in holes:
        if hl.kind in ("w", "d", "g"):
            a, b = hl.s0 - 0.03, hl.s1 + 0.03
            out.append((0.0 if a < 0.15 else a, L if b > L - 0.15 else b, hl.y1, hl.y1 + 0.21, "mh_brick", H["soldiers"]))
    return out


def face_patches(H, fc, L, holes):
    """The other brick in a side or back wall given in `faces`: its own `patches` (s0, s1, y0, y1, tint, along the wall
    as the builder lays it) and, with `soldiers`, the front's soldier courses over its openings."""
    if not fc:
        return ()
    out = [(max(0.0, s0), min(L, s1), y0, y1, "mh_brick", tint) for s0, s1, y0, y1, tint in fc.get("patches", [])]
    if fc.get("soldiers") and H.get("soldiers"):
        out += soldier_courses(H, L, holes)
    return out


def front_details(f, L, H, holes, layers, frame_c, base):
    """What stands on the front: bands, a strip of other brick, lintels, surrounds, shutters beside the
    windows, the oriel, a balcony, a porch's back wall and door, a tower, a carport, letterboxes and bell plates."""
    tint = H["tint"]
    for s, y, w, hh, dep, col in H.get("fixtures", []):  # small boxes on the wall: a letterbox, a bell plate
        s = s + L if s < 0 else s
        f.box("mh_detail", s - w / 2, s + w / 2, y, y + hh, 0.0, dep, col)
    for band in H.get("bands", []):
        y, hh = band[0], band[1]
        col = band[2] if len(band) > 2 else "#ece9e2"
        mat = "mh_brick" if len(band) > 2 else "mh_stone"
        s0, s1 = (0, L)
        segs = [(s0, s1)]
        for hl in holes:
            if hl.y0 < y + hh and hl.y1 > y:
                segs = [(a, b) for a0, b0 in segs for a, b in ((a0, min(b0, hl.s0)), (max(a0, hl.s1), b0)) if b - a > 0.02]
        for a, b in segs:
            f.box(mat, a - (0.02 if a == 0 else 0), b + (0.02 if b == L else 0), y, y + hh, 0.0, 0.035 if mat == "mh_stone" else 0.006, col)
    st = H.get("strip")
    if st:
        f.flat("mh_brick", st["s"][0], st["s"][1], H.get("plinth", (0,))[0], H["eaves"], 0.005, st["tint"])
    for hl in holes:
        if hl.kind in ("w", "d", "g") and H.get("lintels") == "stone":
            f.box("mh_stone", hl.s0 - 0.08, hl.s1 + 0.08, hl.y1, hl.y1 + 0.16, 0.0, 0.03, "#d6d0c4")
        elif hl.kind in ("w", "d", "g") and H.get("lintels"):
            f.flat("mh_brick", hl.s0 - 0.1, hl.s1 + 0.1, hl.y1, hl.y1 + 0.14, 0.004, shade(tint, 0.8))
        if hl.opt.get("surround"):
            surround(f, hl, hl.opt["surround"], hl.opt.get("sc", frame_c))
        if H.get("shutters") and hl.kind == "w":
            w = (hl.s1 - hl.s0) / 2
            for a, b in ((hl.s0 - w - 0.03, hl.s0 - 0.03), (hl.s1 + 0.03, hl.s1 + w + 0.03)):
                f.box("mh_panel", a, b, hl.y0 - 0.02, hl.y1 + 0.02, 0.0, 0.035, H["shutters"])
                for k in range(1, int((hl.y1 - hl.y0) / 0.12)):
                    yy = hl.y0 + 0.12 * k
                    f.flat("mh_detail", a + 0.04, b - 0.04, yy - 0.01, yy + 0.01, 0.038, shade(H["shutters"], 1.6))
    for (s, w, y, hh, kind, opt) in H["openings"]:
        if kind == "bay":
            oriel(f, s, w, y, hh, opt.get("cu"), frame_c)
    bal = H.get("balcony")
    if bal:
        s0, s1 = bal["s"]
        y, dep = bal["y"], bal["depth"]
        f.box("mh_stone", s0, s1, y - 0.16, y, -0.05, dep, "#cfcac0")
        rail = bal["rail"]
        f.box("mh_detail", s0, s1, y + 0.95, y + 1.0, dep - 0.06, dep - 0.02, rail)
        f.box("mh_detail", s0, s1, y + 0.1, y + 0.14, dep - 0.06, dep - 0.02, rail)
        for k in range(int((s1 - s0) / 0.14) + 1):
            s = s0 + 0.02 + k * 0.14
            if s > s1 - 0.02:
                break
            f.box("mh_detail", s - 0.012, s + 0.012, y + 0.1, y + 0.95, dep - 0.05, dep - 0.03, rail)
        for s in (s0, s1):
            f.box("mh_detail", s - 0.02, s + 0.02, y, y + 1.0, 0.0, dep - 0.02, rail)
    porch = H.get("porch")
    if porch:
        s0, s1 = porch["s"]
        dep = porch["depth"]
        back = Frame(f.xz(s0, -dep), f.t, f.o, f.base)
        dholes = []
        for (s, w, y, hh, kind, opt) in H["openings"]:
            if opt.get("recess"):
                dholes.append(Hole(s - s0 - w / 2, s - s0 + w / 2, y, y + hh, kind, 0.1, {**opt, "f": opt.get("f", frame_c)}))
        facade(back, s1 - s0, [(0, porch["h"]), (s1 - s0, porch["h"])], dholes, layers, bottom=-0.3)
    tw = H.get("tower")
    if tw:
        s0, s1 = tw["s"]
        top, E = tw["top"], H["eaves"]
        dep = 3.6
        mat, col = wall_at(layers, E + 0.5)
        # its side towards the rest of the front and its back, above the main eaves
        side = Frame(f.xz(s1), (-f.o[0], -f.o[1]), f.t, f.base)
        face(mat, [side.p(0, E - 0.4), side.p(dep, E - 0.4), side.p(dep, top), side.p(0, top)], side.out(), col)
        if s0 < 0.1:
            west = Frame(f.xz(s0, -dep), (f.o[0], f.o[1]), (-f.t[0], -f.t[1]), f.base)
            face(mat, [west.p(0, E - 0.4), west.p(dep, E - 0.4), west.p(dep, top), west.p(0, top)], west.out(), col)
        backf = Frame(f.xz(s1, -dep), (-f.t[0], -f.t[1]), (-f.o[0], -f.o[1]), f.base)
        face(mat, [backf.p(0, E - 0.4), backf.p(s1 - s0, E - 0.4), backf.p(s1 - s0, top), backf.p(0, top)], backf.out(), col)
        c = tw.get("cornice", 0.4)
        f.box("mh_stone", s0 - c * 0.5, s1 + c, top - 0.05, top + 0.18, -dep - 0.1, c, "#ece9e2")
    cp = H.get("carport")
    if cp:
        s0, s1 = cp["s"]
        dep, hh = cp["depth"], cp["h"]
        f.box("mh_render", s0, s1, hh, hh + 0.42, 0.0, dep, H["tint"])
        f.box("mh_render", s1 - 0.3, s1, -0.2, hh, dep - 0.3, dep, H["tint"])
        SOLIDS.append(prism_xz([f.xz(s1 - 0.3, dep - 0.3), f.xz(s1, dep - 0.3), f.xz(s1, dep), f.xz(s1 - 0.3, dep)], base - 0.2, base + hh))
    fg = H.get("front_gable")
    if fg:
        g0, g1 = fg["s"]
        gm = (g0 + g1) / 2
        top = fg["top"]
        E = H["eaves"]
        # the gable's tip in another colour, and its own small roof reaching back into the main roof
        face("mh_render", [f.p(gm - (g1 - g0) / 2 * 0.28, top - (top - E) * 0.28, 0.004), f.p(gm + (g1 - g0) / 2 * 0.28, top - (top - E) * 0.28, 0.004),
                           f.p(gm, top, 0.004)], f.out(), fg.get("apex_tint", tint))
        k = (H["ridge"] - E) / (dist_main_depth(H) / 2)
        back = (top - E) / k + 0.6
        over = 0.25
        sl = (top - E) / ((g1 - g0) / 2)
        for sa, sb in ((g0 - over, gm), (g1 + over, gm)):
            ya = E - over * sl
            bottom = [f.p(sa, ya, over), f.p(sb, top, over), f.p(sb, top, -back), f.p(sa, ya, -back)]
            slab(bottom, plane_up(*bottom[:3]), 0.14, H["roof_tint"], "#f0efeb", "#f0efeb")


def stepped_gable(f, L, E, R, tint):
    """A crow-stepped gable: brick steps up both raking edges of the front, standing above the roof line."""
    n = 5
    for side in (0, 1):
        for i in range(n):
            sa, sb = L / 2 * i / n, L / 2 * (i + 1) / n
            y1 = E + (R - E) * (i + 1) / n + 0.3
            a, b = (sa, sb) if side == 0 else (L - sb, L - sa)
            f.box("mh_brick", a - (0.05 if i == 0 else 0), b, E - 0.2, y1, -0.35, 0.04, shade(tint, 0.95))
            f.box("mh_stone", a - 0.04, b + 0.04, y1, y1 + 0.06, -0.38, 0.07, "#b9b5ad")
    f.box("mh_brick", L / 2 - 0.35, L / 2 + 0.35, R - 0.3, R + 0.75, -0.35, 0.04, shade(tint, 0.95))


def dist_main_depth(H):
    m = H["main"]
    (ax, az), (bx, bz) = H["front"]
    return min(math.dist(m[1], m[2]), math.dist(m[0], m[1])) if len(m) == 4 else 8.0


def roof_extras(H, A, B, C, D, base, E, R):
    """Chimneys, roof windows, a dormer and solar panels, on the front slope (ridge along the front)."""
    t, L = unit(A, B)
    n, Dp = unit(A, D)
    half = Dp / 2
    k = (R - E) / half if half > 0 else 0
    roof = H["roof"]
    P = lambda s, q, y: (A[0] + t[0] * s + n[0] * q, A[1] + t[1] * s + n[1] * q, base + y)
    def surf(s, q):  # the roof's top surface height above base (gable along the front, or hipped)
        if roof == "front_gable":
            hs = L / 2
            kk = (R - E) / hs
            return E + kk * min(s, L - s) + 0.16
        return E + k * min(q, Dp - q) + 0.16
    for c in H.get("chimneys", []):
        s, q, w, h = c["s"], c["d"], c["w"], c["h"]
        y_lo = surf(s, q) - 0.8
        y_hi = max(surf(s, q), (R if roof != "flat" else E)) + h
        if roof == "flat":
            y_hi = E + h
        solid("mh_brick", [P(s + a, q + b, y) for a in (-w / 2, w / 2) for b in (-0.3, 0.3) for y in (y_lo, y_hi)], shade(H["tint"], 0.85) if H["wall"] == "brick" else "#8a5040")
        solid("mh_stone", [P(s + a, q + b, y) for a in (-w / 2 - 0.05, w / 2 + 0.05) for b in (-0.35, 0.35) for y in (y_hi, y_hi + 0.07)], "#8c8d8c")
    if roof not in ("gable", "hip"):
        return
    up = Vector(plane_up(P(0, 0, E), P(1, 0, E), P(0, 1, E + k)))
    def on_slope(s, q, lift):
        p = Vector(P(s, q, E + k * q + 0.14)) + up * lift
        return tuple(p)
    for s, ud in H.get("roof_windows", []):
        q = ud * math.cos(math.atan(k))
        w, l = 0.78, 1.18
        dq = l * math.cos(math.atan(k))
        pts = [on_slope(s - w / 2, q, 0.05), on_slope(s + w / 2, q, 0.05), on_slope(s + w / 2, q + dq, 0.05), on_slope(s - w / 2, q + dq, 0.05)]
        face("mh_glass", pts, tuple(up), "#2a3338")
        fr = [on_slope(s - w / 2 - 0.06, q - 0.06, 0.03), on_slope(s + w / 2 + 0.06, q - 0.06, 0.03),
              on_slope(s + w / 2 + 0.06, q + dq + 0.06, 0.03), on_slope(s - w / 2 - 0.06, q + dq + 0.06, 0.03)]
        face("mh_detail", fr, tuple(up), "#3d4043")
    sol = H.get("solar")
    if sol:
        s0, s1 = sol["s"]
        pw, pl = 1.02, 1.7
        cosk = math.cos(math.atan(k))
        cols = int((s1 - s0 + 0.02) / (pw + 0.02))
        q0 = 0.5
        for r in range(sol["rows"]):
            for c in range(cols):
                sa = s0 + c * (pw + 0.02)
                qa = (q0 + r * (pl + 0.03)) * cosk
                qb = qa + pl * cosk
                if qb > half - 0.2:
                    continue
                pts = [on_slope(sa, qa, 0.09), on_slope(sa + pw, qa, 0.09), on_slope(sa + pw, qb, 0.09), on_slope(sa, qb, 0.09)]
                face("mh_glass", pts, tuple(up), "#1b2230")
                rim = [on_slope(sa - 0.015, qa - 0.015, 0.075), on_slope(sa + pw + 0.015, qa - 0.015, 0.075),
                       on_slope(sa + pw + 0.015, qb + 0.015, 0.075), on_slope(sa - 0.015, qb + 0.015, 0.075)]
                face("mh_detail", rim, tuple(up), "#9da3a8")
    for dm in ([H["dormer"]] if H.get("dormer") else []) + H.get("dormers", []):
        s, w, h = dm["s"] + (L if dm["s"] < 0 else 0), dm["w"], dm["h"]
        qf = 1.0
        yf = E + k * qf + 0.1
        qb = qf + (h + 0.1) / k
        yt = yf + h
        gab = dm.get("gable")
        clad = dm.get("clad", H["tint"] if gab else H["roof_tint"])
        cm = "mh_render" if gab and H["wall"] == "render" or dm.get("clad") else ("mh_brick" if gab else "mh_roof")
        # front, sides and a flat roof, or a little gable roof of its own
        face(cm, [P(s - w / 2, qf, yf - 0.1), P(s + w / 2, qf, yf - 0.1), P(s + w / 2, qf, yt), P(s - w / 2, qf, yt)], (-n[0], -n[1], 0), clad)
        if gab:
            yr = yt + w * 0.5
            qr = qf + (yr - yf + 0.1) / k  # where its ridge meets the main roof
            face(cm, [P(s - w / 2, qf, yt), P(s + w / 2, qf, yt), P(s, qf, yr)], (-n[0], -n[1], 0), clad)
            for sx, sg in ((s - w / 2, -1), (s + w / 2, 1)):
                face(cm, [P(sx, qf, yf - 0.1), P(sx, qb, yt), P(sx, qf, yt)], (t[0] * sg, t[1] * sg, 0), clad)
                eave = [P(sx + sg * 0.12, qf - 0.18, yt - 0.06), P(s, qf - 0.18, yr), P(s, qr, yr), P(sx + sg * 0.12, qb + 0.1, yt - 0.06)]
                slab(eave, plane_up(*eave[:3]), 0.08, H["roof_tint"], "#f0efeb", "#f0efeb")
        else:
            for sx, sg in ((s - w / 2, -1), (s + w / 2, 1)):
                face(cm, [P(sx, qf, yf - 0.1), P(sx, qb, yt), P(sx, qf, yt)], (t[0] * sg, t[1] * sg, 0), clad)
            solid("mh_detail", [P(s + a, q, y) for a in (-w / 2 - 0.1, w / 2 + 0.1) for q in (qf - 0.15, qb) for y in (yt, yt + 0.12)], "#55585b")
        g = Frame(P(s - 0.65, qf, 0)[:2], t, (-n[0], -n[1]), base)
        face("mh_glass", [g.p(0, yf + 0.25, 0.01), g.p(1.3, yf + 0.25, 0.01), g.p(1.3, yf + 1.25, 0.01), g.p(0, yf + 1.25, 0.01)], g.out(), "#252c30")
        for a, b, c0, c1 in ((0, 1.3, yf + 0.19, yf + 0.25), (0, 1.3, yf + 1.25, yf + 1.31), (-0.06, 0, yf + 0.19, yf + 1.31), (1.3, 1.36, yf + 0.19, yf + 1.31), (0.62, 0.68, yf + 0.25, yf + 1.25)):
            g.flat("mh_detail", a, b, c0, c1, 0.02, H.get("frame", "#232426"))
        if not gab:
            for a, b in ((-0.75, -0.06), (1.36, 2.05)):
                g.box("mh_panel", a, b, yf + 0.2, yf + 1.3, 0.0, 0.035, H.get("shutters", "#232426"))


def downpipes(H, A, B, C, D, base, E, party, fi):
    """Down from the front gutter at each end that isn't against a neighbour."""
    if H["roof"] in ("flat", "front_gable"):
        return
    t, L = unit(A, B)
    n, Dp = unit(A, D)
    k = (H.get("ridge", E) - E) / (Dp / 2) if Dp else 0
    over = H.get("over", 0.3)
    col = H.get("gutter", "#8f9498")
    n_edges = len(H["main"])
    ends = [0.12, L - 0.12]
    yg = E - over * k - 0.06
    for s in ends:
        side_party = (party[(fi + 1) % n_edges] if s > L / 2 else party[(fi - 1) % n_edges])
        if side_party:
            continue
        top = (A[0] + t[0] * s - n[0] * (over + 0.05), A[1] + t[1] * s - n[1] * (over + 0.05), base + yg)
        bend = (A[0] + t[0] * s - n[0] * 0.07, A[1] + t[1] * s - n[1] * 0.07, base + yg - 0.35)
        foot = (A[0] + t[0] * s - n[0] * 0.07, A[1] + t[1] * s - n[1] * 0.07, base - 0.1)
        tube("mh_detail", top, bend, 0.04, col)
        tube("mh_detail", bend, foot, 0.042, col)


SOLIDS = []


def prism_xz(ring, y0, y1):
    """A block for walking into, in the game's world heights."""
    return {"p": [[round(x, 3), round(z, 3)] for x, z in ring], "y0": round(y0 + GROUND, 3), "y1": round(y1 + GROUND, 3)}


def garden(key, H, base):
    """In front of a house, where the survey saw them: a low wall with piers or a white fence on the plot line,
    clipped hedges and box balls, columnar conifers."""
    if not any(H.get(k) for k in ("front_wall", "fence", "hedges", "topiary", "garden_conifers")):
        return
    fw = H.get("front_wall")
    f, L = FRONT[key]
    k = nearest_station(*f.xz(L / 2))
    s = ST[k]
    side = 1 if (f.o[0] * s["n"][0] + f.o[1] * s["n"][1]) < 0 else -1
    W = (s["L"] if side == 1 else s["R"]) - 0.12
    # the plot line in front: the line offset, between the house's ends projected onto it
    def on_line(sv):
        x, z = f.xz(sv)
        kk = nearest_station(x, z)
        st = ST[kk]
        Wk = min(6.8, max(KERB + 0.9, st["L"] if side == 1 else st["R"])) + 0.12
        along = (x - st["x"]) * st["t"][0] + (z - st["z"]) * st["t"][1]
        return (st["x"] + st["t"][0] * along + st["n"][0] * Wk * side, st["z"] + st["t"][1] * along + st["n"][1] * Wk * side)
    door = next((o[0] for o in H["openings"] if o[4] in ("d", "ad")), L / 2)
    gaps = [(door - 0.6, door + 0.6), (L - 0.1, L + 0.5)]
    pieces = [(0.0, L)]
    for g0, g1 in gaps:
        pieces = [(a, b) for a0, b0 in pieces for a, b in ((a0, min(b0, g0)), (max(a0, g1), b0)) if b - a > 0.3]
    def room(sv):  # how far in front of the wall the plot line runs at sv
        x, z = on_line(sv)
        x0, z0 = f.xz(sv)
        return (x - x0) * f.o[0] + (z - z0) * f.o[1]
    lift = 1.5  # the foliage texture is dark: the surveyed greens lifted to read as they do in the photos
    fix = lambda v: v + L if v < 0 else v  # a negative s: from the front's far end
    for (h0, h1, out, hh, col) in H.get("hedges", []):  # a clipped hedge, kept behind the plot line
        h0, h1 = fix(h0), fix(h1) if h1 != 0 or h0 >= 0 else L
        col = shade(col, lift)
        out = min(out, min(room(h0), room(h1)) - 0.45)
        if out < 0.5:
            continue
        g = Frame(f.xz(h0, out), f.t, f.o, terrain(*f.xz((h0 + h1) / 2, out)) + 0.1)
        g.box("mh_foliage", 0, h1 - h0, -0.25, hh, -0.3, 0.3, col)
        g.box("mh_foliage", 0.06, h1 - h0 - 0.06, hh, hh + 0.07, -0.24, 0.24, shade(col, 1.12))
        SOLIDS.append(prism_xz([g.xz(0, -0.3), g.xz(h1 - h0, -0.3), g.xz(h1 - h0, 0.3), g.xz(0, 0.3)], g.base - 0.25, g.base + hh))
    for (sv, out, r, col) in H.get("topiary", []):  # a clipped box ball
        sv = fix(sv)
        out = min(out, room(sv) - r - 0.2)
        if out < r + 0.1:
            continue
        x, z = f.xz(sv, out)
        ball(x, z, terrain(x, z) + 0.1 + r * 0.85, r, shade(col, lift))
    for k, (sv, out, ch, cr) in enumerate(H.get("garden_conifers", [])):
        sv = fix(sv)
        out = min(out, room(sv) - cr - 0.2)
        if out < cr:
            continue
        x, z = f.xz(sv, out)
        conifer(x, z, ch, cr, "#86a866", 300 + k + int(abs(x) * 10))
    fc = H.get("fence")
    if fc:  # white posts and two rails along the plot line
        for a, b in pieces:
            p, q = on_line(a), on_line(b)
            tt, LL = unit(p, q)
            g = Frame(p, tt, (f.o[0], f.o[1]), terrain(*p) + 0.1)
            hh = fc.get("h", 0.8)
            n = max(1, int(LL / 1.8))
            for k in range(n + 1):
                g.box("mh_panel", LL * k / n - 0.05, LL * k / n + 0.05, -0.2, hh + 0.05, -0.05, 0.05, fc["c"])
            for y in (hh * 0.45, hh - 0.06):
                g.box("mh_panel", 0, LL, y - 0.05, y + 0.05, -0.03, 0.03, fc["c"])
            SOLIDS.append(prism_xz([g.xz(0, -0.06), g.xz(LL, -0.06), g.xz(LL, 0.06), g.xz(0, 0.06)], g.base - 0.2, g.base + hh))
    if not fw:
        return
    h, col = fw["h"], fw["tint"]
    for a, b in pieces:
        p, q = on_line(a), on_line(b)
        tt, LL = unit(p, q)
        g = Frame(p, tt, (f.o[0], f.o[1]), terrain(*p) + 0.1)
        g.box("mh_brick", 0, LL, -0.3, h, -0.12, 0.12, col)
        g.box("mh_stone", -0.02, LL + 0.02, h, h + 0.06, -0.15, 0.15, "#b9b5ad")
        if fw.get("piers"):
            for sp in (0.0, LL):
                g.box("mh_brick", sp - 0.2, sp + 0.2, -0.3, h + 0.35, -0.2, 0.2, col)
                g.box("mh_stone", sp - 0.24, sp + 0.24, h + 0.35, h + 0.42, -0.24, 0.24, "#b9b5ad")
        SOLIDS.append(prism_xz([g.xz(0, -0.15), g.xz(LL, -0.15), g.xz(LL, 0.15), g.xz(0, 0.15)], g.base - 0.3, g.base + h + 0.06))


def overhang(H, base):
    """A box on the upper floor standing out of the walls (`overhang`): its outline, whose edges in `against` lie on the
    house's walls and stay open, from y0 to y1 above the floor in the wall's brick, its underside in `soffit`, a flat
    top behind the house's coping."""
    ov = H["overhang"]
    ring, (y0, y1) = ov["p"], ov["y"]
    wall = {"brick": "mh_brick", "render": "mh_render", "cladding": "mh_cladding"}[H["wall"]]
    for i in range(len(ring)):
        if i in ov.get("against", []):
            continue
        a, b = ring[i], ring[(i + 1) % len(ring)]
        o = outward(ring, i)
        face(wall, [(a[0], a[1], base + y0), (b[0], b[1], base + y0), (b[0], b[1], base + y1), (a[0], a[1], base + y1)], o, H["tint"])
        t, L = unit(a, b)
        Frame(a, t, (o[0], o[1]), base).box("mh_stone", -0.03, L + 0.03, y1 - 0.02, y1 + H.get("coping_h", 0.1), -0.25, 0.04, H.get("coping", "#7c7f82"))
    face("mh_detail", [(x, z, base + y0) for x, z in ring], (0, 0, -1), ov.get("soffit", "#2a2b2d"))
    face("mh_stone", [(x, z, base + y1 - 0.05) for x, z in ring], (0, 0, 1), "#4f5154")
    SOLIDS.append(prism_xz(ring, base + y0, base + y1))


GONE, CUTS, CLEARED = [], [], []  # round a house (`site`): the village's buildings gone, its ground covers cut, where


def site(H):
    """Round a house (`site`, tools/molenhoek_end_survey.py): its drive of gravel and the rough ground of a building site
    in cells on the relief, a concrete manhole slab, a brick garden wall with a pale coping and a steel flue pipe. What of
    the village gives way goes to the root's extras."""
    S = H["site"]
    base = H["y0"] + 0.05
    for kind, ring in S["ground"]:
        cx, cz = sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)
        k = jitter(cx, cz)
        col = shade("#8a7b6b", 0.92 + 0.16 * k) if kind == "g" else shade("#746346", 0.85 + 0.3 * k)
        face("mh_gravel", [(x, z, terrain(x, z) + 0.035) for x, z in ring], (0, 0, 1), col)
    sl = S["slab"]
    (sx, sz), t, (a, b) = sl["at"], sl["dir"], sl["size"]
    g0 = terrain(sx, sz)
    f = Frame((sx, sz), t, (t[1], -t[0]), g0)
    f.box("mh_stone", -a / 2, a / 2, -0.15, sl["top"], -b / 2, b / 2, "#a5a49e")
    f.box("mh_stone", -0.35, 0.35, sl["top"], sl["top"] + 0.006, -0.3, 0.3, "#8f8e89")  # its cover's seam
    SOLIDS.append(prism_xz([f.xz(-a / 2, -b / 2), f.xz(a / 2, -b / 2), f.xz(a / 2, b / 2), f.xz(-a / 2, b / 2)], g0 - 0.15, g0 + sl["top"]))
    w = S["wall"]
    pts = w["p"]
    for p, q in zip(pts, pts[1:]):
        tt, L = unit(p, q)
        g = Frame(p, tt, (tt[1], -tt[0]), base)
        ends = (-w["t"] / 2 if p is not pts[0] else 0.0, L + w["t"] / 2)
        low = min(terrain(*g.xz(s)) for s in (0.0, L / 2, L)) - base - 0.2
        g.box("mh_brick", ends[0], ends[1], low, w["top"], -w["t"] / 2, w["t"] / 2, w["tint"])
        g.box("mh_stone", ends[0] - 0.02, ends[1] + 0.02, w["top"], w["top"] + 0.05, -w["t"] / 2 - 0.03, w["t"] / 2 + 0.03, w["coping"])
        SOLIDS.append(prism_xz([g.xz(ends[0], -w["t"] / 2), g.xz(ends[1], -w["t"] / 2), g.xz(ends[1], w["t"] / 2), g.xz(ends[0], w["t"] / 2)], base + low, base + w["top"] + 0.05))
    fl = S["flue"]
    (fx, fz), r = fl["at"], fl["r"]
    tube("mh_detail", (fx, fz, terrain(fx, fz) - 0.1), (fx, fz, base + fl["top"]), r, "#b9bcbd", seg=8)
    tube("mh_detail", (fx, fz, base + fl["top"]), (fx, fz, base + fl["top"] + 0.08), r + 0.025, "#a7aaab", seg=8)
    SOLIDS.append({**prism_xz([(fx - r, fz - r), (fx + r, fz - r), (fx + r, fz + r), (fx - r, fz + r)], terrain(fx, fz) - 0.1, base + fl["top"]), "m": "steel"})
    GONE.extend(S["gone"])
    CUTS.extend(S["cuts"])
    CLEARED.extend(S["cleared"])


# ---------------------------------------------------------------- a house's own garden
GARDENS = []  # the plots of the gardens built: the village's ground covers, fences and trees inside them give way
UV_TURN = {}  # material: the direction (game x, z) its flat faces' texture runs along (the terrace's tiles along the house)
WOOD = "#857d71"  # the boards, grey with the weather
TILES = "#87898b"  # the terrace's large grey tiles (times the texture's own greys)


def inside_ring(x, z, ring):
    hit = False
    for i in range(len(ring)):
        (ax, az), (bx, bz) = ring[i - 1], ring[i]
        if (az > z) != (bz > z) and x < (bx - ax) * (z - az) / (bz - az) + ax:
            hit = not hit
    return hit


def jitter(*v):
    """A number 0..1 from a few others, the same every build."""
    h = 2166136261
    for x in v:
        h ^= int(round(x * 1000)) & 0xFFFFFFFF
        h = (h * 16777619) & 0xFFFFFFFF
        h ^= h >> 13
    return (h % 100000) / 100000


def cut_at(pts, s):
    """A polyline with a corner added s metres along it."""
    out, done = [pts[0]], 0.0
    for p, q in zip(pts, pts[1:]):
        L = math.dist(p, q)
        if done < s < done + L - 0.05 and s - done > 0.05:
            k = (s - done) / L
            out.append((p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k))
        out.append(q)
        done += L
    return out


def runs(pts, step):
    """A polyline's segments, each cut into equal pieces of at most `step`: (start, direction, length) per piece."""
    out = []
    for p, q in zip(pts, pts[1:]):
        t, L = unit(p, q)
        if L < 0.05:
            continue
        n = max(1, math.ceil(L / step - 1e-6))
        for k in range(n):
            out.append(((p[0] + t[0] * L * k / n, p[1] + t[1] * L * k / n), t, L / n))
    return out


def yard(H):
    """A house's own garden as tools/molenhoek_end_survey.py lays it out (`garden`): the terrace, the fences round it,
    the shed, and what stands just outside it. Its lawn lies at the house's floor level inside the fences, above the
    relief where it falls away and below it where it rises (tools/molenhoek_end_inside.py cuts the relief out there,
    world/walkIn.ts draws the lawn). The fences stand on a gravel board that takes up the step to the ground outside."""
    IN_YARD[0] = True
    try:
        build_yard(H)
    finally:
        IN_YARD[0] = False


def build_yard(H):
    G = H["garden"]
    lvl, tl, lawn = G["level"], G["terrace_level"], G["lawn"]
    GARDENS.append(G["clear"])
    (ax, az), (bx, bz) = H["front"]
    UV_TURN["mh_tiles"] = unit((ax, az), (bx, bz))[0]
    main = H["main"]

    # The terrace: large grey tiles laid along the house, a slab whose edge stands 2 cm over the lawn.
    ring = G["terrace"]
    face("mh_tiles", [(x, z, tl) for x, z in ring], (0, 0, 1), TILES)
    for i in range(len(ring)):
        a, b = ring[i - 1], ring[i]
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        if dist_to_ring(mid, main) < 0.03:
            continue  # along the house
        o = outward(ring, i - 1 if i else len(ring) - 1)
        face("mh_stone", [(a[0], a[1], lvl - 0.03), (b[0], b[1], lvl - 0.03), (b[0], b[1], tl), (a[0], a[1], tl)], o, "#8e8f8f")

    # The fences: which side of each piece is the street's (away from the lawn), and the ground there.
    def outside(p, t):
        n = (t[1], -t[0])
        m = (p[0] + n[0] * 0.4, p[1] + n[1] * 0.4)
        return n if not inside_ring(m[0], m[1], lawn) else (-n[0], -n[1])

    def ground_out(p, t, L, o):
        return max(terrain(p[0] + t[0] * s + o[0] * 0.35, p[1] + t[1] * s + o[1] * 0.35) for s in (0.0, L / 2, L))

    for fence in G["fences"]:
        pts = fence["p"]
        if fence["kind"] == "boards":
            board_fence(pts, fence.get("gate"), lvl, outside, ground_out)
        else:
            ivy_fence(pts, fence.get("thick"), lvl, outside, ground_out)
    log_shed(G["shed"], lvl)
    utility_plot(G)
    garden_furniture(G, tl)


def board_fence(pts, gate, lvl, outside, ground_out):
    """A fence of vertical boards with narrow gaps between them, in panels of up to 1.85 m between square posts, on a
    concrete gravel board, 1.8 m above the ground outside; two rails on the garden side; `gate`: from and to (metres
    along the fence) a gate of the same boards with a brace, hinges and a black handle."""
    if gate:
        pts = cut_at(pts, gate[1])
    total = sum(math.dist(p, q) for p, q in zip(pts, pts[1:]))
    s_at = 0.0
    for p, t, L in runs(pts, 1.85):
        o = outside(p, t)
        g = ground_out(p, t, L, o)
        f = Frame(p, t, o, 0.0)
        top, foot, plinth = g + 1.8, min(lvl, g) - 0.12, max(lvl, g) + 0.12
        f.box("mh_stone", 0.0, L, foot, plinth, -0.02, 0.02, "#727370")  # the gravel board, both sides' grounds
        is_gate = bool(gate) and s_at + L <= gate[1] + 1e-6
        b0, b1 = (0.06, L - 0.06) if is_gate else (0.045, L - 0.045)
        n = max(1, int((b1 - b0) / 0.127))
        w = (b1 - b0) / n
        for k in range(n):
            tint = shade(WOOD, 0.9 + 0.17 * jitter(p[0], p[1], k))
            f.box("mh_render", b0 + k * w + 0.006, b0 + (k + 1) * w - 0.006, plinth, top - 0.02 * jitter(k, p[0]), -0.011, 0.011, tint)
        rail = shade(WOOD, 0.82)
        for y in (plinth + 0.3, top - 0.28):
            f.box("mh_render", b0, b1, y - 0.035, y + 0.035, -0.046, -0.011, rail)
        if is_gate:  # the brace on the garden side, the handle and the hinges outside
            for (s0, y0), (s1, y1) in (((b0 + 0.05, plinth + 0.3), (b1 - 0.05, top - 0.28)),):
                beam("mh_render", f.p(s0, y0, -0.03), f.p(s1, y1, -0.03), 0.07, 0.03, rail, up=(o[0], o[1], 0))
            f.box("mh_detail", b1 - 0.12, b1 - 0.06, g + 0.95, g + 1.12, 0.011, 0.03, "#1c1d1f")
            for y in (plinth + 0.3, top - 0.28):
                f.box("mh_detail", b0 - 0.02, b0 + 0.25, y - 0.025, y + 0.025, 0.011, 0.018, "#202123")
        for s in ((0.0, L) if s_at + L >= total - 1e-6 else (0.0,)):  # the posts
            f.box("mh_render", s - 0.045, s + 0.045, foot, top + 0.03, -0.045, 0.045, shade(WOOD, 0.78))
        SOLIDS.append({**prism_xz([f.xz(0, -0.06), f.xz(L, -0.06), f.xz(L, 0.06), f.xz(0, 0.06)], foot, top), "m": "cladding"})
        s_at += L


def ivy_fence(pts, thick, lvl, outside, ground_out):
    """A black wire fence on a concrete base, 1.75 m above the ground outside, overgrown with ivy: one thick green wall
    (`thick`), or in patches with the fence's posts and rail showing between them."""
    for p, t, L in runs(pts, 2.5):
        o = outside(p, t)
        g = ground_out(p, t, L, o)
        f = Frame(p, t, o, 0.0)
        foot = min(lvl, g) - 0.12
        f.box("mh_stone", 0.0, L, foot, max(lvl, g) + 0.06, -0.02, 0.02, "#6c6d6a")  # the base plate, both sides' grounds
        f.box("mh_detail", -0.025, 0.025, foot, g + 1.78, -0.025, 0.025, "#1d2022")  # a post
        f.box("mh_detail", 0.0, L, g + 1.72, g + 1.745, -0.012, 0.012, "#1d2022")  # the top rail
        for y in (g + 0.45, g + 1.0):
            f.box("mh_detail", 0.0, L, y - 0.004, y + 0.004, -0.004, 0.004, "#26292b")  # line wires
        s = 0.0
        while s < L - 0.05:
            j = jitter(p[0], p[1], s)
            if thick:
                seg, gap, h, d = 0.9 + 0.5 * j, 0.0, 1.78 + 0.18 * jitter(s, p[1]), 0.21 + 0.06 * j
            else:
                seg, gap, h, d = 0.5 + 1.1 * j, 0.15 + 0.7 * jitter(p[1], s), 0.7 + 1.0 * jitter(s, p[0]), 0.12 + 0.06 * j
            s1 = min(L, s + seg)
            col = shade("#3f6a33", 1.35 * (0.86 + 0.24 * jitter(j, s)))
            f.box("mh_foliage", s, s1, foot, g + h - 0.06, -d, d + 0.04, col)
            f.box("mh_foliage", s + 0.05, s1 - 0.05, g + h - 0.06, g + h, -d + 0.05, d - 0.01, shade(col, 1.12))
            s = s1 + gap
        SOLIDS.append({**prism_xz([f.xz(0, -0.08), f.xz(L, -0.08), f.xz(L, 0.08), f.xz(0, 0.08)], foot, g + 1.78), "m": "hedge"})
    if pts:  # the last post
        q = pts[-1]
        t, _ = unit(pts[-2], q)
        Frame(q, t, outside(q, t), 0.0).box("mh_detail", -0.025, 0.025, min(lvl, terrain(*q)) - 0.12, terrain(*q) + 1.78, -0.025, 0.025, "#1d2022")


def log_shed(S, lvl):
    """A log shed under a flat roof falling to the back: interlocking logs of 13.5 cm whose ends stand out at the
    corners, a roof of dark felt with a dark brown fascia, a door of planks on the garden side by the path."""
    c = S["p"]  # the street side's two corners (the path's first), then the garden side's
    hf, hb = S["h"]
    walls = [(c[0], c[1], hf, hf), (c[1], c[2], hf, hb), (c[2], c[3], hb, hb), (c[3], c[0], hb, hf)]
    log = 0.135
    rows = int(hf / log) + 1
    cx, cz = sum(q[0] for q in c) / 4, sum(q[1] for q in c) / 4
    for wi, (p, q, h0, h1) in enumerate(walls):
        t, L = unit(p, q)
        o = (t[1], -t[0])
        if (p[0] + o[0] - cx) ** 2 + (p[1] + o[1] - cz) ** 2 < (p[0] - cx) ** 2 + (p[1] - cz) ** 2:
            o = (-o[0], -o[1])
        f = Frame(p, t, o, lvl)
        for r in range(rows):
            y0 = -0.05 + r * log
            top = min(h0, h1) if h0 != h1 else h0
            if y0 >= max(h0, h1) - 0.01:
                break
            stick = 0.06 if (r + wi) % 2 == 0 else -0.045  # the log ends out at the corners, every other row
            tint = shade("#7a6852", 0.9 + 0.16 * jitter(wi, r))
            if y0 + log <= top + 1e-6:
                f.box("mh_render", -stick if stick > 0 else 0.045, L + stick if stick > 0 else L - 0.045, y0 + 0.012, y0 + log, -0.045, 0.0, tint)
                f.box("mh_render", 0.045, L - 0.045, y0, y0 + 0.012, -0.045, -0.012, shade(tint, 0.7))  # the joint, set back
            else:  # the side walls' last logs, cut to the roof's fall
                ya, yb = min(h0, max(y0, -0.05)), min(h1, max(y0, -0.05))
                pa = [f.p(0.045, y0, 0.0), f.p(L - 0.045, y0, 0.0), f.p(L - 0.045, max(y0, min(h1, y0 + log)), 0.0), f.p(0.045, max(y0, min(h0, y0 + log)), 0.0)]
                face("mh_render", pa, f.out(), tint)
        if wi == 2:  # the garden side: the door, near the path, its frame under the roof
            d0, d1 = L - 1.25, L - 0.4
            dt = min(1.88, h0 - 0.12)
            f.box("mh_panel", d0, d1, 0.02, dt, -0.01, 0.02, "#7a6a55")
            for k in range(1, 6):
                f.flat("mh_detail", d0 + k * (d1 - d0) / 6 - 0.006, d0 + k * (d1 - d0) / 6 + 0.006, 0.05, dt - 0.03, 0.021, "#5e5142")
            f.box("mh_detail", d0 + 0.08, d0 + 0.12, 0.95, 1.12, 0.02, 0.05, "#1e1f21")
            f.box("mh_detail", d0 - 0.04, d1 + 0.04, dt, dt + 0.07, -0.01, 0.03, "#6a5a47")
    # The roof: overhanging all round, more at the front and the back; dark felt on top, a dark brown fascia.
    t, L = unit(c[0], c[1])
    n, D = unit(c[0], c[3])
    P = lambda s, d, y: (c[0][0] + t[0] * s + n[0] * d, c[0][1] + t[1] * s + n[1] * d, lvl + y)
    y = lambda d: hf + (hb - hf) * d / D
    pts = [(-0.12, -0.12), (L + 0.12, -0.12), (L + 0.12, D + 0.22), (-0.12, D + 0.22)]
    under = [P(s, d, y(d)) for s, d in pts]
    top = [P(s, d, y(d) + 0.16) for s, d in pts]
    face("mh_stone", top, plane_up(*top[:3]), "#46484a")
    face("mh_detail", under, (0, 0, -1), "#5a4a3c")
    for i in range(4):
        a, b, at, bt = under[i], under[(i + 1) % 4], top[i], top[(i + 1) % 4]
        mid = ((a[0] + b[0]) / 2 - (c[0][0] + c[2][0]) / 2, (a[1] + b[1]) / 2 - (c[0][1] + c[2][1]) / 2, 0)
        face("mh_render", [a, b, bt, at], mid, "#4a3c30")
    SOLIDS.append({**prism_xz([tuple(q) for q in c], lvl - 0.1, lvl + hf + 0.16), "m": "cladding"})


def utility_plot(G):
    """On the utility plot at the corner, outside the fence: the concrete control cabinet with louvred panels, the
    stainless vent pipes beside it, the concrete slab of the pump well with its steel hatch; the letterbox by the gate."""
    cb = G["cabinet"]
    (x, z), t = cb["at"], tuple(cb["dir"])
    g = terrain(x, z)
    f = Frame((x, z), t, (t[1], -t[0]), g)
    f.box("mh_stone", -0.65, 0.65, -0.15, 1.1, -0.28, 0.28, "#b8b7b1")
    f.box("mh_stone", -0.68, 0.68, 1.1, 1.16, -0.31, 0.31, "#a9a8a2")
    for side in (-1, 1):
        for s0 in (-0.55, 0.05):
            d = side * 0.28
            f.box("mh_detail", s0, s0 + 0.5, 0.45, 1.0, min(d, d + side * 0.012), max(d, d + side * 0.012), "#5f6265")
            for k in range(1, 7):
                yy = 0.45 + k * 0.55 / 7
                f.box("mh_detail", s0 + 0.03, s0 + 0.47, yy - 0.012, yy + 0.004, min(d, d + side * 0.024), max(d, d + side * 0.024), "#45484b")
    SOLIDS.append({**prism_xz([f.xz(-0.68, -0.31), f.xz(0.68, -0.31), f.xz(0.68, 0.31), f.xz(-0.68, 0.31)], g - 0.15, g + 1.16), "m": "concrete"})
    for k, (vx, vz) in enumerate(G["vents"]):
        g0 = terrain(vx, vz)
        h = 0.75 + 0.12 * k
        r, steel = 0.055, "#b6b9bb"
        tube("mh_detail", (vx, vz, g0 - 0.1), (vx, vz, g0 + h), r, steel, seg=8)
        # the swan neck: over the top and down again, its mouth to the ground
        bend = [(0.0, h), (0.05, h + 0.09), (0.14, h + 0.12), (0.23, h + 0.09), (0.28, h)]
        for (a0, y0), (a1, y1) in zip(bend, bend[1:]):
            tube("mh_detail", (vx + t[0] * a0, vz + t[1] * a0, g0 + y0), (vx + t[0] * a1, vz + t[1] * a1, g0 + y1), r, steel, seg=8)
        tube("mh_detail", (vx + t[0] * 0.28, vz + t[1] * 0.28, g0 + h), (vx + t[0] * 0.28, vz + t[1] * 0.28, g0 + h - 0.14), r * 1.15, steel, seg=8)
        # (as high as a man: no stepping stones over the fence beside them)
        SOLIDS.append({**prism_xz([(vx - 0.07, vz - 0.07), (vx + 0.07, vz - 0.07), (vx + 0.07, vz + 0.07), (vx - 0.07, vz + 0.07)], g0 - 0.1, g0 + 1.7), "m": "steel"})
    pd = G["pad"]
    (x, z), t = pd["at"], tuple(pd["dir"])
    g = min(terrain(x + a * t[0] + b * t[1], z + a * t[1] - b * t[0]) for a in (-0.7, 0.7) for b in (-0.6, 0.6))
    f = Frame((x, z), t, (t[1], -t[0]), g)
    f.box("mh_stone", -0.7, 0.7, -0.2, 0.07, -0.6, 0.6, "#a9a8a3")
    f.box("mh_detail", -0.4, 0.4, 0.07, 0.076, -0.3, 0.3, "#6f7275")  # the hatch, chequer plate
    for k in range(1, 8):
        f.box("mh_detail", -0.38, 0.38, 0.076, 0.079, -0.3 + k * 0.075 - 0.01, -0.3 + k * 0.075 + 0.01, "#7c7f82")
    SOLIDS.append({**prism_xz([f.xz(-0.7, -0.6), f.xz(0.7, -0.6), f.xz(0.7, 0.6), f.xz(-0.7, 0.6)], g - 0.2, g + 0.07), "m": "concrete"})
    lb = G["letterbox"]
    (x, z), o = lb["at"], tuple(lb["face"])
    g = terrain(x, z)
    f = Frame((x, z), (-o[1], o[0]), o, g)
    f.box("mh_detail", -0.18, 0.18, -0.05, 1.12, -0.15, 0.15, "#64676a")
    f.box("mh_detail", -0.13, 0.13, 0.93, 0.96, 0.15, 0.157, "#2a2b2d")  # the slot
    SOLIDS.append({**prism_xz([f.xz(-0.18, -0.15), f.xz(0.18, -0.15), f.xz(0.18, 0.15), f.xz(-0.18, 0.15)], g - 0.05, g + 1.12), "m": "steel"})


def garden_furniture(G, tl):
    """On the terrace: a garden table with a teak top on a white frame and four chairs, and a closed parasol on its base."""
    tb = G["table"]
    (x, z), t = tb["at"], tuple(tb["dir"])
    n = (t[1], -t[0])
    f = Frame((x, z), t, n, tl)
    white, teak, sling = "#e7e7e3", "#a57d55", "#8d8f8c"
    f.box("mh_panel", -0.8, 0.8, 0.71, 0.74, -0.45, 0.45, teak)
    for s in (-0.74, 0.74):
        for d in (-0.39, 0.39):
            f.box("mh_detail", s - 0.025, s + 0.025, 0.0, 0.71, d - 0.025, d + 0.025, white)
    f.box("mh_detail", -0.76, 0.76, 0.66, 0.71, -0.41, 0.41, white)
    SOLIDS.append({**prism_xz([f.xz(-0.8, -0.45), f.xz(0.8, -0.45), f.xz(0.8, 0.45), f.xz(-0.8, 0.45)], tl, tl + 0.74), "m": "cladding"})
    for s in (-0.4, 0.4):
        for side in (-1, 1):
            cx, cz = f.xz(s, side * 0.78)
            cf = Frame((cx, cz), (-t[0] * side, -t[1] * side), (n[0] * side, n[1] * side), tl)  # facing the table
            cf.box("mh_panel", -0.22, 0.22, 0.42, 0.45, -0.22, 0.2, sling)
            cf.box("mh_panel", -0.22, 0.22, 0.45, 0.95, 0.17, 0.2, sling)
            for a in (-0.22, 0.2):
                for b in (-0.22, 0.2):
                    cf.box("mh_detail", a, a + 0.025, 0.0, 0.45 if b < 0 else 0.95, b, b + 0.025, white)
            SOLIDS.append({**prism_xz([cf.xz(-0.23, -0.23), cf.xz(0.23, -0.23), cf.xz(0.23, 0.23), cf.xz(-0.23, 0.23)], tl, tl + 0.45), "m": "steel"})
    x, z = G["parasol"]
    f = Frame((x, z), t, n, tl)
    f.box("mh_detail", -0.25, 0.25, 0.0, 0.08, -0.25, 0.25, "#3b3d3f")
    tube("mh_detail", (x, z, tl + 0.08), (x, z, tl + 2.45), 0.022, "#4a4c4e", seg=6)
    ring = lambda y, r: [(x + r * math.cos(a * math.pi / 4), z + r * math.sin(a * math.pi / 4), tl + y) for a in range(8)]
    solid("mh_panel", ring(0.95, 0.04) + ring(1.25, 0.13) + ring(2.15, 0.11) + ring(2.32, 0.03), "#7d7488")
    SOLIDS.append({**prism_xz([(x - 0.25, z - 0.25), (x + 0.25, z - 0.25), (x + 0.25, z + 0.25), (x - 0.25, z + 0.25)], tl, tl + 0.08), "m": "steel"})
    SOLIDS.append({**prism_xz([(x - 0.12, z - 0.12), (x + 0.12, z - 0.12), (x + 0.12, z + 0.12), (x - 0.12, z + 0.12)], tl + 0.08, tl + 2.4), "m": "cladding"})


# ---------------------------------------------------------------- street furniture
def props():
    for pr in DATA["props"]:
        if "at" in pr:
            x, z = pr["at"]
            k = nearest_station(x, z)
            s = ST[k]
        else:  # given along the street: at station x, d metres to the +z side, or `behind` the pavement on `side`
            k = min(range(len(ST)), key=lambda i: abs(ST[i]["x"] - pr["x"]))
            s = ST[k]
            d = pr["d"] if "d" in pr else pr["side"] * (walk_edge(k, pr["side"]) + pr["behind"])
            x, z = s["x"] + s["n"][0] * d, s["z"] + s["n"][1] * d
        g0 = terrain(x, z)
        f = Frame((x, z), s["t"], s["n"], g0)
        if pr["k"] == "island":
            Lh, w = pr["len"] / 2, pr["w"] / 2
            f.box("mh_stone", -Lh, Lh, 0.0, 0.14, -w, w, "#cfccc6")
            f.box("mh_stone", -Lh + 0.1, Lh - 0.1, 0.14, 0.15, -w + 0.1, w - 0.1, "#8d8f8f")
            # the keep-left sign on a striped post at its east end
            px = Lh - 0.5
            for kk in range(4):
                f.box("mh_detail", px - 0.05, px + 0.05, 0.15 + kk * 0.2, 0.35 + kk * 0.2, -0.05, 0.05, "#e2b320" if kk % 2 == 0 else "#1c1c1c")
            tube("mh_detail", f.p(px, 0.95), f.p(px, 1.55), 0.03, "#a3a5a5")
            g = Frame(f.xz(px), (-f.o[0], -f.o[1]), f.t, f.base)  # facing the traffic coming from the east
            disc(g, 0.0, 1.75, 0.3, "#1f5fa8", None)
            SOLIDS.append(prism_xz([f.xz(px - 0.08, -0.08), f.xz(px + 0.08, -0.08), f.xz(px + 0.08, 0.08), f.xz(px - 0.08, 0.08)], g0, g0 + 2.1))
        elif pr["k"] == "cabinet":
            f.box("mh_stone", -0.45, 0.45, -0.1, 1.15, -0.18, 0.18, "#a9aba8")
            f.box("mh_stone", -0.48, 0.48, 1.15, 1.22, -0.21, 0.21, "#949693")
            SOLIDS.append(prism_xz([f.xz(-0.45, -0.18), f.xz(0.45, -0.18), f.xz(0.45, 0.18), f.xz(-0.45, 0.18)], g0 - 0.1, g0 + 1.22))
        elif pr["k"] == "give_way":  # a give-way sign: a white triangle with a red border, point down, on a grey post
            fo = pr["face"]
            g = Frame((x, z), (fo[1], -fo[0]), (fo[0], fo[1]), g0)
            tube("mh_detail", g.p(0, -0.2), g.p(0, 2.45), 0.035, "#a3a5a5")
            tri = [(-0.45, 2.45), (0.45, 2.45), (0.0, 1.67)]
            face("mh_detail", [(g.xz(sa, 0.05)[0], g.xz(sa, 0.05)[1], g.base + y) for sa, y in tri], (fo[0], fo[1], 0), "#c8202a")
            inner = [(-0.3, 2.37), (0.3, 2.37), (0.0, 1.85)]
            face("mh_detail", [(g.xz(sa, 0.055)[0], g.xz(sa, 0.055)[1], g.base + y) for sa, y in inner], (fo[0], fo[1], 0), "#f3f1ec")
            face("mh_detail", [(g.xz(sa, -0.04)[0], g.xz(sa, -0.04)[1], g.base + y) for sa, y in tri], (-fo[0], -fo[1], 0), "#8f9395")
            SOLIDS.append(prism_xz([g.xz(-0.06, -0.06), g.xz(0.06, -0.06), g.xz(0.06, 0.06), g.xz(-0.06, 0.06)], g0, g0 + 2.45))
        elif pr["k"] == "sign_children":
            tube("mh_detail", f.p(0, -0.2), f.p(0, 2.6), 0.035, "#a3a5a5")
            tri = [(-0.45, 2.0), (0.45, 2.0), (0.0, 2.78)]
            face("mh_detail", [(f.xz(sa, 0.05)[0], f.xz(sa, 0.05)[1], f.base + y) for sa, y in tri], (s["n"][0], s["n"][1], 0), "#c8202a")
            inner = [(-0.33, 2.07), (0.33, 2.07), (0.0, 2.64)]
            face("mh_detail", [(f.xz(sa, 0.055)[0], f.xz(sa, 0.055)[1], f.base + y) for sa, y in inner], (s["n"][0], s["n"][1], 0), "#f3f1ec")
            f.box("mh_detail", -0.06, 0.06, 2.15, 2.4, 0.055, 0.06, "#1d1d1d")
            f.box("mh_detail", -0.3, 0.3, 1.66, 1.92, 0.04, 0.06, "#1f5fa8")
            f.box("mh_detail", -0.2, 0.2, 1.74, 1.84, 0.06, 0.065, "#f3f1ec")
            SOLIDS.append(prism_xz([f.xz(-0.06, -0.06), f.xz(0.06, -0.06), f.xz(0.06, 0.06), f.xz(-0.06, 0.06)], g0, g0 + 2.6))
    if not MOLENHOEK:
        return
    # The fire hydrant in front of the tall house, red-pink as the survey saw it: at the back of the pavement.
    k = min(range(len(ST)), key=lambda i: abs(ST[i]["x"] - 750.1))
    d = walk_edge(k, 1) + 0.3
    hx, hz = ST[k]["x"] + ST[k]["n"][0] * d, ST[k]["z"] + ST[k]["n"][1] * d
    g0 = terrain(hx, hz) + 0.1
    tube("mh_detail", (hx, hz, g0), (hx, hz, g0 + 0.75), 0.11, "#c8606c", seg=8)
    tube("mh_detail", (hx, hz, g0 + 0.75), (hx, hz, g0 + 0.85), 0.13, "#b5525e", seg=8)
    tube("mh_detail", (hx - 0.16, hz, g0 + 0.5), (hx + 0.16, hz, g0 + 0.5), 0.05, "#b5525e", seg=6)
    SOLIDS.append(prism_xz([(hx - 0.12, hz - 0.12), (hx + 0.12, hz - 0.12), (hx + 0.12, hz + 0.12), (hx - 0.12, hz + 0.12)], g0 - 0.1, g0 + 0.85))


def ball(x, z, y, r, col):
    """A clipped round shrub: a low sphere of 8 by 4 faces."""
    seg, rows = 8, 4
    rings = []
    for j in range(1, rows):
        a = math.pi * j / rows - math.pi / 2
        rings.append([(x + r * math.cos(a) * math.cos(2 * math.pi * i / seg), z + r * math.cos(a) * math.sin(2 * math.pi * i / seg), y + r * 0.9 * math.sin(a)) for i in range(seg)])
    bot, top = (x, z, y - r * 0.9), (x, z, y + r * 0.9)
    for i in range(seg):
        k = (i + 1) % seg
        mid = lambda p0, p1: ((p0[0] + p1[0]) / 2 - x, (p0[1] + p1[1]) / 2 - z)
        face("mh_foliage", [rings[0][k], rings[0][i], bot], (*mid(rings[0][i], rings[0][k]), -0.6), shade(col, 0.8))
        for ra, rb in zip(rings, rings[1:]):
            face("mh_foliage", [ra[i], ra[k], rb[k], rb[i]], (*mid(ra[i], ra[k]), 0.0), col)
        face("mh_foliage", [rings[-1][i], rings[-1][k], top], (*mid(rings[-1][i], rings[-1][k]), 0.6), shade(col, 1.1))


def disc(f, s, y, r, col, _):
    pts = [(s + r * math.cos(2 * math.pi * k / 12), y + r * math.sin(2 * math.pi * k / 12)) for k in range(12)]
    face("mh_detail", [(f.xz(a, 0.04)[0], f.xz(a, 0.04)[1], f.base + b) for a, b in pts], (f.o[0], f.o[1], 0), col)
    face("mh_detail", [(f.xz(a, -0.04)[0], f.xz(a, -0.04)[1], f.base + b) for a, b in pts], (-f.o[0], -f.o[1], 0), "#8f9395")
    arrow = [(-0.14, 0.12), (0.06, -0.08), (0.06, 0.02), (0.14, 0.02), (0.14, -0.16), (-0.04, -0.16), (-0.04, -0.08)]
    face("mh_detail", [(f.xz(s + a, 0.045)[0], f.xz(s + a, 0.045)[1], f.base + y + b) for a, b in arrow], (f.o[0], f.o[1], 0), "#f4f4f2")


# ---------------------------------------------------------------- trees by the portal
# The laser scan (2013-2015) saw broad trees in the front gardens round the portal; the survey sees tall
# conifers along the empty plot where the portal stands and a dying one in front of the tall house. The
# village's trees here give way (CLEAR_TREES: x, z, radius) to these: (x, z, height, radius, colour).
CLEAR_TREES = [[746.25, -714.87, 1.0], [752.89, -710.29, 1.0], [751.88, -703.15, 1.0], [738.69, -710.89, 1.0], [732.8, -714.8, 1.0]]
CONIFERS = [(752.6, -712.6, 8.6, 1.25, "#8db070"), (752.0, -707.0, 9.4, 1.35, "#86aa69"), (751.7, -701.5, 10.2, 1.4, "#93b676"),
            (751.4, -696.0, 9.0, 1.3, "#88ab6b"), (746.6, -714.1, 5.2, 0.9, "#b59a5c"), (739.0, -711.8, 6.4, 1.2, "#8fb172"),
            (734.0, -713.6, 7.2, 1.3, "#93b676"), (731.6, -712.0, 5.8, 1.1, "#8aad6d")]


def conifer(x, z, h, r, col, seed):
    """A columnar conifer (Leyland cypress, thuja): a trunk and a slightly irregular cone in tiers."""
    rng = np.random.default_rng(seed)
    g = terrain(x, z) + 0.1
    tube("mh_detail", (x, z, g - 0.2), (x, z, g + 0.9), 0.12, "#4a3b2e", seg=6)
    seg = 10
    tiers = [(0.5, 0.9), (0.18 * h, 1.0), (0.45 * h, 0.85), (0.72 * h, 0.55), (0.92 * h, 0.22)]
    rings = []
    for y, k in tiers:
        ring = []
        for i in range(seg):
            a = 2 * math.pi * (i + rng.uniform(-0.15, 0.15)) / seg
            rr = r * k * rng.uniform(0.88, 1.12)
            ring.append((x + math.cos(a) * rr, z + math.sin(a) * rr, g + y))
        rings.append(ring)
    tip = (x + rng.uniform(-0.1, 0.1), z + rng.uniform(-0.1, 0.1), g + h)
    for ra, rb in zip(rings, rings[1:]):
        for i in range(seg):
            j = (i + 1) % seg
            c = shade(col, rng.uniform(0.85, 1.12))
            face("mh_foliage", [ra[i], ra[j], rb[j], rb[i]], ((ra[i][0] + ra[j][0]) / 2 - x, (ra[i][1] + ra[j][1]) / 2 - z, 0.2), c)
    for i in range(seg):
        j = (i + 1) % seg
        face("mh_foliage", [rings[-1][i], rings[-1][j], tip], ((rings[-1][i][0] + rings[-1][j][0]) / 2 - x, (rings[-1][i][1] + rings[-1][j][1]) / 2 - z, 0.5), shade(col, 1.1))
    face("mh_foliage", rings[0][::-1], (0, 0, -1), shade(col, 0.6))
    SOLIDS.append(prism_xz([(x - 0.2, z - 0.2), (x + 0.2, z - 0.2), (x + 0.2, z + 0.2), (x - 0.2, z + 0.2)], g - 0.2, g + 2.0))


# ---------------------------------------------------------------- build it
if MOLENHOEK:
    street()
for key, H in DATA["houses"].items():
    house(key, H)
props()
for i, (x, z, h, r, col) in enumerate(CONIFERS if MOLENHOEK else []):
    conifer(x, z, h, r, col, 60 + i)


# ---------------------------------------------------------------- UVs, objects, export
def metre_uvs(bm, turn=None):
    """UVs in metres; up the wall and up the slope point to the texture's top, as on the game's own surfaces. `turn`:
    the direction (game x, z) a flat face's texture runs along (else the game's x)."""
    uv = bm.loops.layers.uv.new("UVMap")
    along = Vector((turn[0], -turn[1], 0)).normalized() if turn else Vector((1, 0, 0))
    long = bm.faces.layers.int.get("long")  # faces of long thin bricks (mark_long)
    for f in bm.faces:
        n = f.normal
        if abs(n.z) > 0.97:
            t, b = along, Vector((-along.y, along.x, 0))
        else:
            t = Vector((0, 0, 1)).cross(n).normalized()
            b = n.cross(t).normalized()
        ku, kv = LONG_UV if long is not None and f[long] else (1.0, 1.0)
        for lp in f.loops:
            p = lp.vert.co
            lp[uv].uv = (p.dot(t) * ku, -p.dot(b) * kv)
    if long is not None:
        bm.faces.layers.int.remove(long)


root = bpy.data.objects.new(PLACE, None)
bpy.context.scene.collection.objects.link(root)
root["origin"] = [ORIGIN[0], ORIGIN[1]]
root["landmark"] = PLACE
root["outlines"] = [h["outline"] for h in DATA["houses"].values()]
root["solids"] = SOLIDS
# Molenhoek's rebuilt stretch (the branch too, to its end at Oordegemkouter): its poles became steel lamp posts, its
# outline covers the old pavings; elsewhere the street stays the village's. (The jump from the main line's east end back
# to the branch's start runs along the main line.)
root["poles"] = {"line": LINE + (DATA["stub"]["line"] if DATA.get("stub") else []), "reach": 12.0} if MOLENHOEK else {"line": [], "reach": 0.0}
root["street"] = street_outline() if MOLENHOEK else []
if MOLENHOEK:
    root["newStreetFrom"] = WEST_END + 4.0  # east of the island the new asphalt covers the old road (its blocks give way)
root["clearTrees"] = CLEAR_TREES if MOLENHOEK else DATA.get("clear_trees", [])
if GARDENS:
    root["clear"] = GARDENS  # a house's own garden: the village's ground covers, fences and hedges inside it give way
if GONE:
    root["gone"] = GONE  # buildings that stood where a house (`site`) stands now: the village's blocks, roofs, windows there go
if CUTS:
    root["cuts"] = CUTS  # the village's ground covers round it: each replaced by what of it lies outside
    root["cleared"] = CLEARED  # where they were cut: the fence posts there go too
tris = 0
objs = []
def split_detail():
    """The small things in three meshes by where they stand along the street (x), so each part's level of detail
    is measured from its own middle."""
    src = BM.pop("mh_detail")
    lay = src.loops.layers.float_color["Color"]
    parts = {"mh_detail_w": bmesh.new(), "mh_detail_m": bmesh.new(), "mh_detail_e": bmesh.new()}
    for bm in parts.values():
        bm.loops.layers.float_color.new("Color")
    for fc in src.faces:
        c = fc.calc_center_median()
        gx = c.x + ORIGIN[0] if DETAIL_AXIS == "x" else -c.y + ORIGIN[1]
        key = "mh_detail_w" if gx < DETAIL_SPLIT[0] else ("mh_detail_m" if gx < DETAIL_SPLIT[1] else "mh_detail_e")
        bm = parts[key]
        nf = bm.faces.new([bm.verts.new(v.co) for v in fc.verts])
        dl = bm.loops.layers.float_color["Color"]
        for a, b in zip(fc.loops, nf.loops):
            b[dl] = a[lay]
    src.free()
    for key, bm in parts.items():
        BM[key] = bm
        M[key] = M["mh_detail"]


split_detail()
for name, bm in BM.items():
    if not bm.faces:
        continue
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
    bm.normal_update()
    if name in SHARED or name.removesuffix("_g") in SHARED:
        metre_uvs(bm, UV_TURN.get(name))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    me.materials.append(M[name])
    me.color_attributes.active_color = me.color_attributes["Color"]
    me.color_attributes.render_color_index = me.color_attributes.active_color_index
    me.set_sharp_from_angle(angle=math.radians(30))
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = root
    me.calc_loop_triangles()
    tris += len(me.loop_triangles)
    print(f"{name}: {len(me.loop_triangles)} triangles")
    objs.append(ob)
print(f"{PLACE}: {tris} triangles in {len(objs)} meshes; origin {ORIGIN} at {Y0:.2f} m; {len(SOLIDS)} solids")
bpy.ops.object.select_all(action="DESELECT")
root.select_set(True)
for o in objs:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=True, export_normals=True, export_extras=True, export_vertex_color="ACTIVE",
                          export_cameras=False, export_lights=False)


def pack(path):
    """Make the GLB small, as tools/town/town.py does: positions as 16-bit integers (KHR_mesh_quantization: the mesh
    node's scale and offset turn them back into metres, steps of a few millimetres), normals as signed bytes, colours
    as bytes. Texture coordinates stay floats (metres, far from the origin)."""
    import struct
    raw = open(path, "rb").read()
    jlen = struct.unpack("<I", raw[12:16])[0]
    gl = json.loads(raw[20:20 + jlen])
    bin_ = raw[20 + jlen + 8:]
    sizes = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
    comps = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
    dtypes = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}

    def read(i):
        a = gl["accessors"][i]
        bv = gl["bufferViews"][a["bufferView"]]
        n, c = a["count"], comps[a["type"]]
        start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = bv.get("byteStride", sizes[a["componentType"]] * c)
        buf = np.frombuffer(bin_, dtype=np.uint8, count=stride * (n - 1) + sizes[a["componentType"]] * c, offset=start)
        rows = np.lib.stride_tricks.as_strided(buf, shape=(n, sizes[a["componentType"]] * c), strides=(stride, 1))
        out_ = np.frombuffer(rows.copy().tobytes(), dtype=dtypes[a["componentType"]]).reshape(n, c)
        return out_ / 65535.0 if a.get("normalized") and a["componentType"] == 5123 else out_

    out = bytearray()
    views, accs = [], []

    def put(arr, ctype, typ, target, normalized=False, stride=None):
        while len(out) % 4:
            out.append(0)
        data = arr.tobytes()
        views.append({"buffer": 0, "byteOffset": len(out), "byteLength": len(data), **({"byteStride": stride} if stride else {}),
                      **({"target": target} if target else {})})
        out.extend(data)
        acc = {"bufferView": len(views) - 1, "componentType": ctype, "count": int(arr.shape[0]), "type": typ}
        if normalized:
            acc["normalized"] = True
        accs.append(acc)
        return len(accs) - 1

    mesh_node = {n["mesh"]: n for n in gl["nodes"] if "mesh" in n}
    for mi, mesh in enumerate(gl["meshes"]):
        node = mesh_node[mi]
        t0 = np.array(node.get("translation", [0, 0, 0]), np.float64)
        for prim in mesh["primitives"]:
            at = prim["attributes"]
            pos = read(at["POSITION"]).astype(np.float64) + t0
            lo, hi = pos.min(0), pos.max(0)
            off, half = (lo + hi) / 2, np.maximum((hi - lo) / 2, 1e-4)
            q = np.round((pos - off) / half * 32767).astype(np.int16)
            q4 = np.zeros((len(q), 4), np.int16)
            q4[:, :3] = q
            new = {"POSITION": put(q4, 5122, "VEC3", 34962, True, 8)}
            accs[new["POSITION"]]["min"] = [int(x) for x in q.min(0)]
            accs[new["POSITION"]]["max"] = [int(x) for x in q.max(0)]
            if "NORMAL" in at:
                nrm = read(at["NORMAL"]).astype(np.float64)
                n4 = np.zeros((len(nrm), 4), np.int8)
                n4[:, :3] = np.clip(np.round(nrm * 127), -127, 127).astype(np.int8)
                new["NORMAL"] = put(n4, 5120, "VEC3", 34962, True, 4)
            if "TEXCOORD_0" in at:
                new["TEXCOORD_0"] = put(read(at["TEXCOORD_0"]).astype(np.float32), 5126, "VEC2", 34962)
            if "COLOR_0" in at:
                c = read(at["COLOR_0"]).astype(np.float64)[:, :3]
                c4 = np.full((len(c), 4), 255, np.uint8)
                c4[:, :3] = np.clip(np.round(c * 255), 0, 255).astype(np.uint8)
                new["COLOR_0"] = put(c4, 5121, "VEC4", 34962, True)
            idx = read(prim["indices"]).reshape(-1)
            big = idx.max() >= 65535
            prim["indices"] = put(idx.astype(np.uint32 if big else np.uint16), 5125 if big else 5123, "SCALAR", 34963)
            prim["attributes"] = new
        node["translation"] = [float(x) for x in off]
        node["scale"] = [float(x) for x in half]  # normalized: the shader reads q / 32767
    gl["accessors"], gl["bufferViews"] = accs, views
    gl["buffers"] = [{"byteLength": len(out)}]
    for k in ("extensionsUsed", "extensionsRequired"):
        gl[k] = sorted(set(gl.get(k, [])) | {"KHR_mesh_quantization"})
    js = json.dumps(gl, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    while len(out) % 4:
        out.append(0)
    glb = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(out)) + struct.pack("<II", len(js), 0x4E4F534A) + js + \
        struct.pack("<II", len(out), 0x004E4942) + bytes(out)
    open(path, "wb").write(glb)


pack(OUT)
print("written", OUT, os.path.getsize(OUT), "bytes")
