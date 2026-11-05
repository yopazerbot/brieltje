"""Build the café Sparrenhof in Blender, with its forecourt and the terrace behind it.

Run (Blender 5, no window), from the project root:
  blender -b -P tools/sparrenhof.py -- <out.glb> [preview_dir]

Our own model, built from (used for measuring only, nothing of them is shipped):
- the plan: GRB building outline OIDN 1205294 (UIDN 10739922, Digitaal Vlaanderen, WFS GRB:GBG, Lambert 72) and
  the canopy in front of it, GBA OIDN 787572; both in the game's frame below (tools/neighbours.py model_frame);
- the heights: the DHM Vlaanderen II laser scan (1 m, 2013-2015), profiles across each part: the main block's
  eaves at 3.9 m and ridge at 7.35 m, its ridge square to the front; the cross gable on its south-east side
  with its ridge at 6.2 m; the right wing's eaves at 3.15 m and ridge at 6.15 m along the front; a flat annex
  at 2.6 m behind the main block; the hall at the back with its ridge at 5.7 m, eaves at 2.9 and 2.4 m; low
  flat sheds at 2.7 m; the ground within half a metre of level over the whole plot;
- the orthophoto (25 cm): the forecourt's gravel, the light veranda roof in the middle, the red-brown roof of
  the hall, the terrace with its tables on the north-west side;
- the photos Yoshi took on 5 November 2026 from the street: the white painted brick on a black plinth, the
  steep gable on the forecourt with a slit vent and three upper windows in white frames, the dark verge
  trims, the anthracite tiles, the stainless flue, the display window and the round-arched entrance, the
  black lettering SPARRENHOF (put in at Yoshi's request), the side door, the right wing's window band and
  roof window, the boarded shed under a metal roof on posts with white braces, the bicycle racks, the
  hedge, the grey gate and the white screen beside it, the band of old setts in the gravel;
- public photos of the café on its map page (seen only, nothing copied): the terrace on the north-west
  side, a path of light slabs along the wall, gravel with black tables, closed parasols, timber posts with
  string lights.
What these don't show is made up in the same style: the back of the building, the hall's windows, the
sheds in the wood. The signs are plain red or black panels: no logos, no brand names. No people, no cars.

Frame: the GLB is in the game's own axes (x, y up, z), its origin on the ground in the middle of the main
gable's foot (ORIGIN). Heights are above the ground there: the browser puts the origin on its relief, and the
`blocks` (for walking into) are lifted the same way (`blocksOnGround`). `replaces` names the GRB outlines
whose open-data blocks the model stands in for.

Output: one GLB, one mesh per material:
- caf_wall, caf_plinth, caf_roof, caf_hall_roof, caf_boards, caf_gravel, caf_setts, caf_slabs, caf_hedge: UVs
  in metres; their glTF extras name a shared game texture and its tint, so they add no graphics memory;
- caf_glass: dark glass;
- caf_fittings: frames, trims, gutters, letters, signs, posts, the metal roofs, furniture, coloured per vertex.
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

# ---------------------------------------------------------------- the plan, in the game's frame
# The GRB outline (OIDN 1205294) and the canopy in front of it (GBA OIDN 787572), game (x, z).
OUTLINE = [(656.41, 962.08), (656.39, 962.3), (670.27, 963.35), (670.18, 964.63), (681.53, 965.63), (682.63, 952.21),
           (687.24, 952.5), (687.1, 953.78), (694.26, 954.55), (695.22, 945.67), (687.83, 944.87), (687.69, 946.16),
           (672.45, 944.52), (671.97, 948.95), (660.12, 947.68), (660.04, 948.71), (655.86, 948.38), (655.5, 952.91),
           (656.62, 952.99), (656.46, 954.99), (656.96, 955.03), (656.74, 957.87)]
CANOPY = [(656.41, 962.08), (656.74, 957.87), (652.79, 957.56), (652.46, 961.77)]
# The café's own axes: u along the front, from its south-east corner (the outline's corner (655.86, 948.38)) to
# the right as seen from the forecourt; d from the main gable's front into the building (the forecourt is d < 0).
CORNER = (655.86, 948.38)
UVEC = (-0.0773, 0.9970)
_n = math.hypot(*UVEC)
UVEC = (UVEC[0] / _n, UVEC[1] / _n)
DVEC = (UVEC[1], -UVEC[0])


def P(u, d):
    """The game point (x, z) at u along the front and d into the building."""
    return (CORNER[0] + UVEC[0] * u + DVEC[0] * d, CORNER[1] + UVEC[1] * u + DVEC[1] * d)


def G(u, d, y):
    return (*P(u, d), y)


def vec(du, dd):
    """A plan direction (game x, z) from one in (u, d)."""
    return (UVEC[0] * du + DVEC[0] * dd, UVEC[1] * du + DVEC[1] * dd)


ORIGIN = tuple(round(c, 2) for c in P(3.27, 0.0))   # the middle of the main gable's foot


def ground(u, d):
    """The ground (laser scan), metres above the origin's: the forecourt falls 0.3 m towards the street, the
    back rises 0.3 m into the wood."""
    return -0.03 + (0.016 if d < 0 else 0.01) * d - 0.004 * u


def V(x, z, y):
    """A game point (x, z, y above the origin's ground) in Blender's frame (z up)."""
    return Vector((x - ORIGIN[0], -(z - ORIGIN[1]), y))


def srgb(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


# ---------------------------------------------------------------- materials
bpy.ops.wm.read_factory_settings(use_empty=True)
# name: (shared game texture, tint, normal scale, mean colour of the result, metres per UV unit)
SHARED = {
    "caf_wall": ("nb_brick", "#f3f0ea", 0.6, "#e8e4dc", 1.0),       # white painted brick
    "caf_plinth": ("nb_brick", "#3c3c3d", 0.6, "#2f2f30", 1.0),     # the black painted plinth
    "caf_roof": ("roof_tiles", "#56595e", 1.0, "#404347", 1.0),     # anthracite tiles
    "caf_hall_roof": ("roof_tiles", "#8e5a48", 1.0, "#6d4538", 1.0),  # the hall's red-brown tiles
    "caf_boards": ("cladding", "#88bdff", 0.8, "#4a4e52", 1.0),     # dark grey vertical boards (the texture is brown wood)
    "caf_gravel": ("gravel", "#eef8ff", 1.0, "#aea38e", 1.0),       # the forecourt's light gravel, less yellow
    "caf_setts": ("clinker", "#aaa196", 1.0, "#8f897e", 1.15),      # old setts, brownish grey
    "caf_slabs": ("terrace", "#d2cfc9", 0.8, "#bcb9b3", 1.0),       # light slabs along the walls
    "caf_hedge": ("hedge", "#7fa06a", 1.5, "#56704a", 1.0),         # as the game's hedges
}
M = {}
UVSCALE = {}


def principled(name, color, rough, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    m.use_backface_culling = True
    return m


for name, (tex, tint, nscale, mean, scale) in SHARED.items():
    M[name] = principled(name, srgb(mean), 0.9)
    M[name]["texture"], M[name]["tint"], M[name]["normalScale"] = tex, tint, nscale
    UVSCALE[name] = scale
M["caf_glass"] = principled("caf_glass", srgb("#1c2226"), 0.1)
M["caf_fittings"] = principled("caf_fittings", (1, 1, 1), 0.6)
nt = M["caf_fittings"].node_tree
attr = nt.nodes.new("ShaderNodeVertexColor")
attr.layer_name = "Color"
nt.links.new(attr.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])

BM = {name: bmesh.new() for name in M}
BM["caf_fittings"].loops.layers.float_color.new("Color")

DARK = "#2c2e31"        # window frames, verge trims, gutters
WHITE = "#eeeeea"       # the upper windows' frames
LETTER = "#161617"
METAL = "#3b3e42"       # the carport's metal roof
GALV = "#a9adb0"        # galvanised steel


def colour(h):
    return (*srgb(h), 1.0) if h else (1.0, 1.0, 1.0, 1.0)


def paint_face(bm, f, hexcol):
    lay = bm.loops.layers.float_color.get("Color")
    if lay is not None:
        c = colour(hexcol)
        for lp in f.loops:
            lp[lay] = c


# ---------------------------------------------------------------- geometry helpers (game coordinates)
def face(mat, pts, out=None, paint=None):
    """A planar face through game points (x, z, y); turned to face `out` (a game direction (dx, dz, dy))."""
    bm = BM[mat]
    vs = [V(*p) for p in pts]
    if out is not None:
        n = Vector((0, 0, 0))
        for i in range(len(vs)):
            n += vs[i].cross(vs[(i + 1) % len(vs)])
        o = Vector((out[0], -out[1], out[2]))
        if n.dot(o) < 0:
            vs = vs[::-1]
    f = bm.faces.new([bm.verts.new(v) for v in vs])
    paint_face(bm, f, paint)
    return f


def solid(mat, pts, paint=None):
    """The convex solid round game points (x, z, y)."""
    tmp = bmesh.new()
    for p in pts:
        tmp.verts.new(V(*p))
    res = bmesh.ops.convex_hull(tmp, input=tmp.verts[:])
    dead = {g for g in res["geom_interior"] + res["geom_unused"] if isinstance(g, bmesh.types.BMVert)}
    bmesh.ops.delete(tmp, geom=list(dead), context="VERTS")
    bmesh.ops.dissolve_limit(tmp, angle_limit=math.radians(0.5), verts=tmp.verts[:], edges=tmp.edges[:])
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces[:])
    bm = BM[mat]
    for f in tmp.faces:
        paint_face(bm, bm.faces.new([bm.verts.new(v.co) for v in f.verts]), paint)
    tmp.free()


def box(mat, u0, u1, d0, d1, y0, y1, paint=None):
    """A box square to the café's axes."""
    solid(mat, [G(u, d, y) for u in (u0, u1) for d in (d0, d1) for y in (y0, y1)], paint)


def beam(mat, a, b, w, h, paint=None):
    """A box from game point a to b (x, z, y), w wide across and h high."""
    a, b = Vector(a), Vector(b)
    dvec = (b - a).normalized()
    side = dvec.cross(Vector((0, 0, 1)))
    if side.length < 1e-6:
        side = dvec.cross(Vector((1, 0, 0)))
    side.normalize()
    upn = side.cross(dvec).normalized()
    pts = []
    for p in (a, b):
        for sx in (-w / 2, w / 2):
            for sy in (-h / 2, h / 2):
                q = p + side * sx + upn * sy
                pts.append((q.x, q.y, q.z))
    solid(mat, pts, paint)


def ubeam(mat, a, b, w, h, paint=None):
    """beam() between points given in (u, d, y)."""
    beam(mat, G(*a), G(*b), w, h, paint)


def tube(mat, a, b, r, paint=None, seg=8):
    a, b = Vector(a), Vector(b)
    dv = (b - a).normalized()
    u = dv.cross(Vector((1, 0, 0)) if abs(dv.x) < 0.9 else Vector((0, 1, 0))).normalized()
    w = dv.cross(u)
    pts = []
    for k in range(seg):
        t = 2 * math.pi * k / seg
        off = u * math.cos(t) * r + w * math.sin(t) * r
        pts += [tuple(a + off), tuple(b + off)]
    solid(mat, pts, paint)


def utube(mat, a, b, r, paint=None, seg=8):
    tube(mat, G(*a), G(*b), r, paint, seg)


def blob(mat, x, z, y, r, h, paint, seed=0):
    """A shrub: a squashed, slightly irregular ball."""
    rng = np.random.default_rng(seed)
    pts = []
    for i in range(1, 3):
        t = math.pi * i / 3
        for k in range(6):
            a = 2 * math.pi * (k + 0.5 * i) / 6
            f = 1 + rng.normal(0, 0.08)
            pts.append((x + r * f * math.sin(t) * math.cos(a), z + r * f * math.sin(t) * math.sin(a), y + h / 2 - h / 2 * math.cos(t)))
    pts += [(x, z, y), (x, z, y + h)]
    solid(mat, pts, paint)


def slab(mat, pts, th, paint=None):
    """A sloping or flat plate on the planar outline pts (game points), th thick below it: its top facing up."""
    top = [p for p in pts]
    bot = [(p[0], p[1], p[2] - th) for p in pts]
    face(mat, top, (0, 0, 1), paint)
    face(mat, bot, (0, 0, -1), paint)
    cx = sum(p[0] for p in pts) / len(pts)
    cz = sum(p[1] for p in pts) / len(pts)
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        mid = ((a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cz)
        n = (b[1] - a[1], -(b[0] - a[0]))
        out = n if n[0] * mid[0] + n[1] * mid[1] > 0 else (-n[0], -n[1])
        face(mat, [a, b, bot[(i + 1) % len(pts)], bot[i]], (out[0], out[1], 0), paint)


class Frame:
    """A wall's frame on the plan: origin a, direction t along the wall, outward normal o (game plan vectors).
    p(s, y, d): s along, y up (above the origin's ground), d out of the wall."""

    def __init__(self, a, t, o):
        self.a, self.t, self.o = a, t, o

    def p(self, s, y, d=0.0):
        return (self.a[0] + self.t[0] * s + self.o[0] * d, self.a[1] + self.t[1] * s + self.o[1] * d, y)

    def out(self, k=1.0):
        return (self.o[0] * k, self.o[1] * k, 0.0)

    def along(self, k=1.0):
        return (self.t[0] * k, self.t[1] * k, 0.0)

    def box(self, mat, s0, s1, y0, y1, d0, d1, paint=None):
        solid(mat, [self.p(s, y, d) for s in (s0, s1) for y in (y0, y1) for d in (d0, d1)], paint)

    def flat(self, mat, s0, s1, y0, y1, d, paint=None):
        """A face parallel to the wall, d out from it."""
        face(mat, [self.p(s0, y0, d), self.p(s1, y0, d), self.p(s1, y1, d), self.p(s0, y1, d)], self.out(), paint)

    def stroke(self, mat, a, b, w, d0, d1, paint=None):
        """A bar in the wall's plane from (s, y) a to b, w wide, standing out from d0 to d1."""
        ds, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(ds, dy)
        ns, ny = -dy / n * w / 2, ds / n * w / 2
        es, ey = ds / n * w * 0.3, dy / n * w * 0.3      # a little past each end: the joints close
        pts = []
        for (s, y) in ((a[0] - es, a[1] - ey), (b[0] + es, b[1] + ey)):
            for k in (-1, 1):
                for d in (d0, d1):
                    pts.append(self.p(s + ns * k, y + ny * k, d))
        solid(mat, pts, paint)


def wall_frame(u0, d0, u1, d1, out):
    """The frame of a wall from (u0, d0) to (u1, d1), facing `out` (a (du, dd) direction)."""
    a = P(u0, d0)
    b = P(u1, d1)
    n = math.hypot(b[0] - a[0], b[1] - a[1])
    return Frame(a, ((b[0] - a[0]) / n, (b[1] - a[1]) / n), vec(*out)), n


class Hole:
    def __init__(self, s0, s1, y0, y1, kind="window", depth=0.15, frame=DARK, cols=1, rows=1, transom=None,
                 panel=None, sill=True, manual=False):
        self.s0, self.s1, self.y0, self.y1 = s0, s1, y0, y1
        self.kind, self.depth, self.frame, self.cols, self.rows = kind, depth, frame, cols, rows
        self.transom, self.panel, self.sill, self.manual = transom, panel, sill, manual


def win(sc, w, y0, y1, **kw):
    return Hole(sc - w / 2, sc + w / 2, y0, y1, **kw)


PLINTH = 0.5          # the black plinth's top (the floor is 0.1 above the origin's ground)
BOTTOM = -0.8         # walls reach this far down, for the slope of the ground


def facade(f, length, top, holes, mat="caf_wall", bottom=BOTTOM, plinth=PLINTH):
    """A wall from s = 0 to length: its surface from `bottom` up to the line `top` ([(s, y)], straight
    between), without the holes, with their reveals, glass, frames and sills; below `plinth` black."""
    def ytop(s):
        for (s0, y0), (s1, y1) in zip(top, top[1:]):
            if s0 - 1e-6 <= s <= s1 + 1e-6:
                return y0 + (y1 - y0) * (s - s0) / max(s1 - s0, 1e-9)
        return top[-1][1]
    xs = sorted({0.0, length, *[s for h in holes for s in (h.s0, h.s1)], *[s for s, _ in top]})
    xs = [s for s in xs if -1e-6 <= s <= length + 1e-6]
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
            if plinth is not None and ya < plinth and (yb is None or yb > plinth):
                pieces = [(ya, plinth), (plinth, yb)]
            for y0, y1 in pieces:
                m = "caf_plinth" if plinth is not None and y1 is not None and y1 <= plinth + 1e-6 else mat
                ta = ytop(xa) if y1 is None else y1
                tb = ytop(xb) if y1 is None else y1
                if max(ta, tb) - y0 < 1e-4:
                    continue
                face(m, [f.p(xa, y0), f.p(xb, y0), f.p(xb, tb), f.p(xa, ta)], f.out())
    for h in holes:
        if not h.manual:
            hole(f, h, mat)


def hole(f, h, mat):
    d = -h.depth
    face(mat, [f.p(h.s0, h.y0), f.p(h.s0, h.y1), f.p(h.s0, h.y1, d), f.p(h.s0, h.y0, d)], f.along(1))
    face(mat, [f.p(h.s1, h.y0), f.p(h.s1, h.y1), f.p(h.s1, h.y1, d), f.p(h.s1, h.y0, d)], f.along(-1))
    face(mat, [f.p(h.s0, h.y1), f.p(h.s1, h.y1), f.p(h.s1, h.y1, d), f.p(h.s0, h.y1, d)], (0, 0, -1))
    if h.kind != "door":
        face(mat, [f.p(h.s0, h.y0), f.p(h.s1, h.y0), f.p(h.s1, h.y0, d), f.p(h.s0, h.y0, d)], (0, 0, 1))
    pane = [f.p(h.s0, h.y0, d), f.p(h.s1, h.y0, d), f.p(h.s1, h.y1, d), f.p(h.s0, h.y1, d)]
    if h.panel:
        face("caf_fittings", pane, f.out(), h.panel)
    else:
        face("caf_glass", pane, f.out())
    fw, fd = 0.06, d + 0.04
    c = h.frame
    f.flat("caf_fittings", h.s0, h.s0 + fw, h.y0, h.y1, fd, c)
    f.flat("caf_fittings", h.s1 - fw, h.s1, h.y0, h.y1, fd, c)
    f.flat("caf_fittings", h.s0 + fw, h.s1 - fw, h.y1 - fw, h.y1, fd, c)
    f.flat("caf_fittings", h.s0 + fw, h.s1 - fw, h.y0, h.y0 + fw, fd, c)
    for k in range(1, h.cols):
        m = h.s0 + (h.s1 - h.s0) * k / h.cols
        f.flat("caf_fittings", m - 0.022, m + 0.022, h.y0 + fw, h.y1 - fw, fd + 0.003, c)
    y_top = h.transom if h.transom else h.y1
    for k in range(1, h.rows):
        m = h.y0 + (y_top - h.y0) * k / h.rows
        f.flat("caf_fittings", h.s0 + fw, h.s1 - fw, m - 0.022, m + 0.022, fd + 0.005, c)
    if h.transom:
        f.flat("caf_fittings", h.s0 + fw, h.s1 - fw, h.transom - 0.035, h.transom + 0.035, fd + 0.006, c)
    if h.sill and h.kind != "door":
        f.box("caf_fittings", h.s0 - 0.04, h.s1 + 0.04, h.y0 - 0.05, h.y0, d, 0.05, "#7d7f80")


def verge(a, b, paint=DARK, w=0.24, t=0.05):
    """A verge trim board along a gable's rake, from game point a to b (x, z, y)."""
    beam("caf_fittings", a, b, t, w, paint)


def gutter(a, b):
    tube("caf_fittings", a, b, 0.065, DARK, seg=6)


def downpipe(u, d, y0, y1):
    utube("caf_fittings", (u, d, y0), (u, d, y1), 0.045, DARK, seg=6)


blocks = []


def block(ring_ud, y0, y1, m="nb_white"):
    """A block for walking into: an outline in (u, d), heights above the origin's ground."""
    blocks.append({"m": m, "p": [[[round(c, 3) for c in P(u, d)] for u, d in ring_ud]], "y0": round(y0, 3), "y1": round(y1, 3)})


def rect(u0, u1, d0, d1):
    return [(u0, d0), (u1, d0), (u1, d1), (u0, d1)]


FLOOR = 0.1

# ---------------------------------------------------------------- A: the main block (gable on the forecourt)
AW, AD = 6.54, 9.3                 # width along the front, depth
AE, AR = 3.9, 7.35                 # eaves, ridge
AK = (AR - AE) / (AW / 2)          # rise per metre of the slopes
front, _ = wall_frame(0, 0, AW, 0, (0, -1))
ARCH0, ARCH1, SPRING = 4.74, 6.34, 1.95
ARCH_R = (ARCH1 - ARCH0) / 2
TOP_ARCH = SPRING + ARCH_R
PORCH = 1.12                       # the entrance's depth (the GRB outline's step)
holes = [
    Hole(1.28, 3.67, 1.06, 2.66, cols=1, rows=1),                               # the display window (its bars below)
    Hole(ARCH0, ARCH1, FLOOR, TOP_ARCH, kind="door", manual=True),            # the arched entrance
    win(1.76, 0.56, 3.88, 4.92, frame=WHITE, cols=2, rows=3),                  # the three upper windows
    win(3.27, 1.18, 3.88, 4.92, frame=WHITE, cols=2, rows=3),
    win(4.78, 0.56, 3.88, 4.92, frame=WHITE, cols=2, rows=3),
    Hole(3.22, 3.32, 6.05, 6.55, panel="#1d1e20", sill=False, depth=0.08),     # the slit vent at the top
]
facade(front, AW, [(0, AE), (AW / 2, AR), (AW, AE)], holes)
# The display window: narrow side lights with a cross of bars either side of the big pane.
for s0, s1 in ((1.28, 1.86), (3.09, 3.67)):
    front.flat("caf_fittings", s1 - 0.035 if s0 < 2 else s0 - 0.0, s1 if s0 < 2 else s0 + 0.035, 1.06, 2.66, -0.105, DARK)
    front.flat("caf_fittings", s0 + 0.03, s1 - 0.03, 1.84, 1.88, -0.1, DARK)
    m = (s0 + s1) / 2
    front.flat("caf_fittings", m - 0.02, m + 0.02, 1.08, 2.64, -0.1, DARK)
front.flat("caf_fittings", 1.86, 3.09, 2.3, 2.34, -0.1, DARK)                # a bar under the top lights
# The arched entrance: the spandrels above the opening, the reveals and the vault into the porch, the door
# with its fanlight at the back, a bluestone floor and step.
arc = [(ARCH0 + ARCH_R - ARCH_R * math.cos(math.pi * k / 12), SPRING + ARCH_R * math.sin(math.pi * k / 12)) for k in range(13)]
for half in (arc[:7], arc[6:]):
    corner = (ARCH0, TOP_ARCH) if half[0][0] < ARCH0 + 0.01 else (ARCH1, TOP_ARCH)
    for (s0, y0), (s1, y1) in zip(half, half[1:]):
        face("caf_wall", [front.p(s0, y0), front.p(s1, y1), front.p(*corner)], front.out())
for s, sign in ((ARCH0, 1), (ARCH1, -1)):
    face("caf_wall", [front.p(s, FLOOR), front.p(s, SPRING), front.p(s, SPRING, -PORCH), front.p(s, FLOOR, -PORCH)], front.along(sign))
for (s0, y0), (s1, y1) in zip(arc, arc[1:]):
    face("caf_wall", [front.p(s0, y0), front.p(s1, y1), front.p(s1, y1, -PORCH), front.p(s0, y0, -PORCH)], (0, 0, -1))
back_of_porch = [front.p(ARCH0, FLOOR, -PORCH), front.p(ARCH1, FLOOR, -PORCH)] + [front.p(s, y, -PORCH) for s, y in arc[::-1]]
face("caf_glass", back_of_porch, front.out())
D0, D1, DT = 5.04, 6.04, 2.3       # the door leaf and the transom under the fanlight
for s0, s1, y0, y1 in ((ARCH0, D0, FLOOR, DT), (D1, ARCH1, FLOOR, DT)):
    front.flat("caf_fittings", s0, s1, y0, y1, -PORCH + 0.01, "#26282a")
for s0, s1, y0, y1 in ((D0, D0 + 0.09, FLOOR + 0.15, DT), (D1 - 0.09, D1, FLOOR + 0.15, DT), (D0, D1, DT - 0.06, DT + 0.03),
                       (D0, D1, FLOOR + 0.15, FLOOR + 0.33), (D0 + 0.09, D1 - 0.09, 1.18, 1.24), (ARCH0, ARCH1, DT, DT + 0.05)):
    front.flat("caf_fittings", s0, s1, y0, y1, -PORCH + 0.02, "#2a2c2f")
front.flat("caf_fittings", D1 - 0.2, D1 - 0.17, 0.95, 1.35, -PORCH + 0.04, GALV)    # the handle bar
for (s0, y0), (s1, y1) in zip(arc[::2], arc[2::2]):                                       # the fanlight's frame
    front.stroke("caf_fittings", (s0, y0 - 0.03), (s1, y1 - 0.03), 0.06, -PORCH + 0.01, -PORCH + 0.03, "#2a2c2f")
front.stroke("caf_fittings", (ARCH0 + ARCH_R, DT), (ARCH0 + ARCH_R, TOP_ARCH - 0.04), 0.04, -PORCH + 0.01, -PORCH + 0.03, "#2a2c2f")
front.box("caf_fittings", ARCH0, ARCH1, FLOOR - 0.1, FLOOR + 0.15, -PORCH, 0.0, "#55595c")      # bluestone floor
front.box("caf_fittings", ARCH0 - 0.1, ARCH1 + 0.1, FLOOR - 0.25, FLOOR, 0.0, 0.32, "#5d6164")   # the step
for (s0, y0), (s1, y1) in zip(arc[::2], arc[2::2]):                                        # a raised band round the arch
    front.stroke("caf_wall", (s0 + (s0 - ARCH0 - ARCH_R) * 0.08, y0 + (y0 - SPRING) * 0.08), (s1 + (s1 - ARCH0 - ARCH_R) * 0.08, y1 + (y1 - SPRING) * 0.08),
                 0.12, 0.0, 0.035)
# The right corner's battered pier beside the entrance.
solid("caf_wall", [front.p(s, y, dd) for s in (6.34, AW) for y, dd in ((BOTTOM, 0.0), (BOTTOM, 0.28), (FLOOR, 0.0), (FLOOR, 0.26), (2.35, 0.0))])
# The south-east side wall up to the cross gable: a narrow window by the corner, the side door.
se, _ = wall_frame(0, 0, 0, 4.2, (-1, 0))
facade(se, 4.2, [(0, AE), (4.2, AE)], [win(0.4, 0.36, 1.0, 2.55, cols=1, rows=2),
                                       Hole(2.55, 3.45, FLOOR, 2.25, kind="door", cols=2, rows=3, transom=None, depth=0.12)])
se.flat("caf_fittings", 2.55, 3.45, FLOOR, 0.9, -0.1, "#26282a")                    # the side door's lower panel
se.box("caf_fittings", 2.45, 3.55, FLOOR - 0.2, FLOOR + 0.02, 0.0, 0.35, "#5d6164")
# The north-west side above the right wing's roof, and the back gable over the annex.
nw, _ = wall_frame(AW, 0, AW, AD, (1, 0))
facade(nw, AD, [(0, AE), (AD, AE)], [])
back, _ = wall_frame(AW, AD, 0, AD, (0, 1))
facade(back, AW, [(0, AE), (AW / 2, AR), (AW, AE)], [win(AW / 2, 0.5, 4.6, 5.4, frame=WHITE, cols=1, rows=2)], bottom=2.5, plinth=None)
# The roof: two slopes 0.3 m past the eaves, 0.25 m past the front gable, 0.2 m past the back one.
OV, VF, VB, TH = 0.3, 0.25, 0.2, 0.16
for side in (0, 1):
    e_u = -OV if side == 0 else AW + OV
    pts = [G(e_u, -VF, AE - OV * AK), G(e_u, AD + VB, AE - OV * AK), G(AW / 2, AD + VB, AR), G(AW / 2, -VF, AR)]
    slab("caf_roof", [(p[0], p[1], p[2] + TH) for p in pts], TH)
ubeam("caf_fittings", (AW / 2, -VF - 0.02, AR + TH + 0.04), (AW / 2, AD + VB + 0.02, AR + TH + 0.04), 0.26, 0.09, "#34363a")  # ridge tiles
for dv in (-VF - 0.03, AD + VB + 0.03):                                          # the dark verge trims
    for e_u in (-OV - 0.02, AW + OV + 0.02):
        verge(G(e_u, dv, AE - OV * AK + 0.02), G(AW / 2, dv, AR + TH + 0.06))
gutter(G(-OV, -VF, AE - OV * AK - 0.02), G(-OV, 4.2 - OV, AE - OV * AK - 0.02))
gutter(G(AW + OV, -VF, AE - OV * AK - 0.02), G(AW + OV, 1.3, AE - OV * AK - 0.02))
downpipe(-0.05, 0.75, FLOOR - 0.1, AE - OV * AK - 0.05)
ubeam("caf_fittings", (-0.05, 0.75, AE - OV * AK - 0.05), (-OV, 0.75, AE - OV * AK - 0.05), 0.08, 0.08, DARK)
# The stainless flue on the south-east slope, near the eaves, with its cap.
flue_base = AE + 0.35 * AK - 0.1
utube("caf_fittings", (0.35, 3.4, flue_base), (0.35, 3.4, 6.6), 0.1, "#c4c7c9", seg=10)
utube("caf_fittings", (0.35, 3.4, 6.6), (0.35, 3.4, 6.75), 0.15, "#b3b6b8", seg=10)
# The lettering, raised black letters over the entrance.
T = 0.2


def glyph(ch, W):
    """A letter's strokes in a box W wide and 1 high, as polylines."""
    a, b, c = T / 2, W - T / 2, 1 - T / 2
    if ch == "S":
        return [[(W, c), (0.24 * W, c), (a, 0.82), (a, 0.68), (0.24 * W, 0.5), (0.76 * W, 0.5), (b, 0.32), (b, 0.18), (0.76 * W, a), (0, a)]]
    if ch == "P":
        return [[(a, 0), (a, c)], [(0, c), (0.7 * W, c), (b, 0.84), (b, 0.62), (0.7 * W, 0.46), (a, 0.46)]]
    if ch == "R":
        return glyph("P", W) + [[(0.5 * W, 0.46), (b, 0)]]
    if ch == "A":
        return [[(a, 0), (W / 2, c)], [(W / 2, c), (b, 0)], [(0.27 * W, 0.32), (0.73 * W, 0.32)]]
    if ch == "E":
        return [[(a, 0), (a, c)], [(0, c), (W, c)], [(0, 0.5), (0.85 * W, 0.5)], [(0, a), (W, a)]]
    if ch == "N":
        return [[(a, 0), (a, c + a)], [(b, 0), (b, c + a)], [(a, c), (b, a)]]
    if ch == "H":
        return [[(a, 0), (a, 1)], [(b, 0), (b, 1)], [(a, 0.5), (b, 0.5)]]
    if ch == "O":
        return [[(0.24 * W, a), (0.76 * W, a), (b, 0.2), (b, 0.8), (0.76 * W, c), (0.24 * W, c), (a, 0.8), (a, 0.2), (0.24 * W, a)]]
    if ch == "F":
        return [[(a, 0), (a, c)], [(0, c), (W, c)], [(0, 0.52), (0.82 * W, 0.52)]]
    return []


LH, L0, L1 = 0.36, 3.36, 6.1       # letter height; the word from s = L0 to L1
word = "SPARRENHOF"
pitch = (L1 - L0) / len(word)
for i, ch in enumerate(word):
    W = 0.8 if ch in "AO" else 0.72
    w = W * LH
    s0 = L0 + i * pitch + (pitch - w) / 2
    for line in glyph(ch, W):
        for (x0, y0), (x1, y1) in zip(line, line[1:]):
            front.stroke("caf_fittings", (s0 + x0 * LH, 3.05 + y0 * LH), (s0 + x1 * LH, 3.05 + y1 * LH), T * LH, 0.0, 0.045, LETTER)
# The red sign at the left corner (a plain panel: no logo), the letter box, a cable with three spotlights.
front.box("caf_fittings", 0.25, 0.95, 2.65, 3.35, 0.0, 0.12, "#f1efea")
front.box("caf_fittings", 0.3, 0.9, 2.7, 3.3, 0.0, 0.125, "#c62a26")
front.box("caf_fittings", 0.42, 0.78, 2.84, 3.16, 0.0, 0.13, "#9b1d1b")
front.box("caf_fittings", 4.06, 4.4, 1.2, 1.5, 0.0, 0.1, "#8b8e91")
front.box("caf_fittings", 4.1, 4.36, 1.42, 1.44, 0.1, 0.105, "#2a2c2e")
front.stroke("caf_fittings", (0.1, 3.72), (AW - 0.1, 3.72), 0.02, 0.0, 0.03, "#1f2022")
for s in (3.55, 4.75, 5.95):
    front.box("caf_fittings", s - 0.04, s + 0.04, 3.62, 3.75, 0.0, 0.25, "#3a3c3f")
    front.box("caf_fittings", s - 0.05, s + 0.05, 3.55, 3.63, 0.2, 0.3, "#2a2b2d")
# Bicycle racks along the plinth under the display window: galvanised hoops.
for k in range(7):
    s = 1.2 + k * 0.45
    a, b = (s, -0.22), (s + 0.26, -0.22)
    ubeam("caf_fittings", (*a, FLOOR - 0.15), (*a, 0.5), 0.035, 0.035, GALV)
    ubeam("caf_fittings", (*b, FLOOR - 0.15), (*b, 0.5), 0.035, 0.035, GALV)
    ubeam("caf_fittings", (a[0] - 0.015, a[1], 0.5), (b[0] + 0.015, b[1], 0.5), 0.035, 0.035, GALV)
block([(0, 0), (ARCH0, 0), (ARCH0, PORCH), (ARCH1, PORCH), (ARCH1, 0), (AW, 0), (AW, AD), (0, AD)], BOTTOM, AE)
for k, inset in enumerate((1.0, 2.0, 2.85)):
    block(rect(inset, AW - inset, 0, AD), AE, AE + inset * AK)

# ---------------------------------------------------------------- B: the cross gable on the south-east side
BU = -1.0                          # its gable wall
B0, B1 = 4.2, 9.3
BR = 6.2
BK = (BR - AE) / ((B1 - B0) / 2)
BM_ = (B0 + B1) / 2
side_b, _ = wall_frame(BU, B0, BU, B1, (-1, 0))
facade(side_b, B1 - B0, [(0, AE), (BM_ - B0, BR), (B1 - B0, AE)],
       [win(1.3, 0.95, 1.0, 2.2, cols=2, rows=2), win(BM_ - B0 + 0.05, 0.5, 4.3, 5.1, frame=WHITE, cols=1, rows=2)])
ne_b, _ = wall_frame(BU, B0, 0, B0, (0, -1))
facade(ne_b, -BU, [(0, AE), (-BU, AE)], [])
sw_b, _ = wall_frame(0, B1, BU, B1, (0, 1))
facade(sw_b, -BU, [(0, AE), (-BU, AE)], [], bottom=2.5, plinth=None)
# Its two slopes run into the main roof's south-east slope along the valleys.
ye = AE - OV * BK
u_eave = (ye - AE) / AK            # where the eave line meets the main slope
u_ridge = (BR - AE) / AK
for dv in (B0 - OV, B1 + OV):
    pts = [G(BU - VF, dv, ye), G(u_eave, dv, ye), G(u_ridge, BM_, BR), G(BU - VF, BM_, BR)]
    slab("caf_roof", [(p[0], p[1], p[2] + TH) for p in pts], TH)
    gutter(G(BU - VF, dv, ye - 0.02), G(u_eave - 0.1, dv, ye - 0.02))
    verge(G(BU - VF - 0.02, dv, ye + 0.02), G(BU - VF - 0.02, BM_, BR + TH + 0.06))
ubeam("caf_fittings", (BU - VF - 0.02, BM_, BR + TH + 0.04), (u_ridge, BM_, BR + TH + 0.04), 0.26, 0.09, "#34363a")
downpipe(BU - 0.05, B0 + 0.12, FLOOR - 0.1, ye - 0.05)
block(rect(BU, 0, B0, B1), BOTTOM, AE)
block(rect(BU, 0.5, B0 + 0.9, B1 - 0.9), AE, AE + 0.8)

# ---------------------------------------------------------------- C: the right wing (ridge along the front)
C0, C1, CD0, CD1 = AW, 13.84, 1.61, 8.89
CE, CR = 3.15, 6.15
CM = (CD0 + CD1) / 2
CK = (CR - CE) / (CM - CD0)
fc, _ = wall_frame(C0, CD0, C1, CD0, (0, -1))
facade(fc, C1 - C0, [(0, CE), (C1 - C0, CE)], [Hole(0.76, 2.76, 1.55, 2.85, cols=2, rows=1)])
fc.box("caf_fittings", 0.2, 0.45, 1.2, 1.56, 0.0, 0.05, "#c7302b")                 # the red soda sign, plain
fc.box("caf_fittings", 0.24, 0.41, 1.25, 1.51, 0.0, 0.055, "#e7e3dc")
fc.box("caf_fittings", 0.15, 0.4, 2.8, 2.98, 0.0, 0.2, "#8e9194")                   # a lamp over the door
ec, _ = wall_frame(C1, CD0, C1, CD1, (1, 0))
facade(ec, CD1 - CD0, [(0, CE), (CM - CD0, CR), (CD1 - CD0, CE)],
       [Hole(1.0, 2.0, FLOOR, 2.25, kind="door", cols=1, rows=2, depth=0.12), win(4.6, 1.3, 1.0, 2.3, cols=2, rows=1),
        win(CM - CD0, 0.6, 3.8, 4.8, frame=WHITE, cols=1, rows=2)])
yc = CE - OV * CK
d_in = CD0 - OV + (AE - yc) / CK   # where the front slope rises past the main block's eaves
u_top = AW - (CR - AE) / AK        # and where its ridge meets the main roof
for sgn in (1, -1):
    dv = CM - sgn * (CM - CD0 + OV)
    di = CM - sgn * (CM - d_in)
    pts = [G(C0, dv, yc), G(C0, di, AE), G(u_top, CM, CR), G(C1 + VF, CM, CR), G(C1 + VF, dv, yc)]
    slab("caf_roof", [(p[0], p[1], p[2] + TH) for p in pts], TH)
    gutter(G(C0 + 0.05, dv, yc - 0.02), G(C1 + VF, dv, yc - 0.02))
    verge(G(C1 + VF + 0.02, dv, yc + 0.02), G(C1 + VF + 0.02, CM, CR + TH + 0.06))
ubeam("caf_fittings", (u_top, CM, CR + TH + 0.04), (C1 + VF + 0.02, CM, CR + TH + 0.04), 0.26, 0.09, "#34363a")
# The roof window on its front slope, and a short vent pipe by the main block.
rw = lambda u, d, lift: G(u, d, CE + (d - CD0) * CK + TH + lift)
face("caf_fittings", [rw(7.45, 2.55, 0.06), rw(8.35, 2.55, 0.06), rw(8.35, 3.65, 0.06), rw(7.45, 3.65, 0.06)], (0, 0, 1), "#2b2d30")
face("caf_glass", [rw(7.52, 2.62, 0.07), rw(8.28, 2.62, 0.07), rw(8.28, 3.58, 0.07), rw(7.52, 3.58, 0.07)], (0, 0, 1))
for u0, u1, d0, d1 in ((7.45, 8.35, 2.55, 2.55), (7.45, 8.35, 3.65, 3.65), (7.45, 7.45, 2.55, 3.65), (8.35, 8.35, 2.55, 3.65)):
    face("caf_fittings", [rw(u0, d0, 0.0), rw(u1, d1, 0.0), rw(u1, d1, 0.06), rw(u0, d0, 0.06)], None, "#2b2d30")
utube("caf_fittings", (6.95, 2.3, CE + (2.3 - CD0) * CK), (6.95, 2.3, 4.45), 0.06, "#b9bcbe", seg=8)
downpipe(C0 + 0.12, CD0 - 0.08, FLOOR - 0.1, yc - 0.05)
ubeam("caf_fittings", (C0 + 0.12, CD0 - 0.08, yc - 0.05), (C0 + 0.12, CD0 - OV, yc - 0.05), 0.08, 0.08, DARK)
block(rect(C0, C1, CD0, CD1), BOTTOM, CE)
block(rect(C0, C1, CD0 + 1.0, CD1 - 1.0), CE, CE + 1.0 * CK)
block(rect(C0, C1, CD0 + 2.2, CD1 - 2.2), CE + 1.0 * CK, CE + 2.2 * CK)

# ---------------------------------------------------------------- D: the flat annex behind the main block
D_TOP = 2.75
sd, _ = wall_frame(BU, B1, BU, 15.53, (-1, 0))
facade(sd, 15.53 - B1, [(0, D_TOP), (15.53 - B1, D_TOP)], [win(2.4, 1.0, 1.05, 2.05, cols=2, rows=1),
                                                         Hole(4.6, 5.5, FLOOR + 0.15, 2.2, kind="door", panel="#e9e7e2", depth=0.1)])
# (it stops under the hall's eaves)
slab("caf_fittings", [G(BU - 0.08, B1, D_TOP + 0.08), G(AW, B1, D_TOP + 0.08), G(AW, 15.2, D_TOP + 0.08), G(BU - 0.08, 15.2, D_TOP + 0.08)], 0.2, "#3d3e40")
box("caf_fittings", BU - 0.1, BU + 0.05, B1, 15.2, D_TOP - 0.1, D_TOP + 0.14, "#e6e4df")           # the coping
block(rect(BU, AW, B1, 15.53), BOTTOM, D_TOP + 0.08)

# ---------------------------------------------------------------- E: the veranda between the wing and the hall
E0, E1 = CD1, 15.53
ee, _ = wall_frame(C1, E0, C1, E1, (1, 0))
E_HI, E_LO = 2.85, 2.55           # its roof, from under the wing's eaves down to the hall
facade(ee, E1 - E0, [(0, E_HI - 0.05), (E1 - E0, E_LO - 0.05)],
       [Hole(0.6, 2.8, FLOOR, 2.3, kind="door", cols=3, rows=1, transom=2.0, depth=0.1),
        Hole(3.5, 5.7, FLOOR, 2.3, kind="door", cols=3, rows=1, transom=2.0, depth=0.1)])
slab("caf_fittings", [G(AW, E0, E_HI), G(C1 + 0.2, E0, E_HI), G(C1 + 0.2, E1, E_LO), G(AW, E1, E_LO)], 0.06, "#dcddd9")
for k in range(8):                                                                # the ribs of its light sheets
    u = AW + 0.4 + k * (C1 - AW) / 8
    ubeam("caf_fittings", (u, E0, E_HI + 0.02), (u, E1, E_LO + 0.02), 0.04, 0.04, "#c9cac6")
block(rect(AW, C1, E0, E1), BOTTOM, E_HI)

# ---------------------------------------------------------------- F: the hall at the back (red-brown tiles)
F_U0, F_U1, F0, F1 = -0.67, 15.15, 15.53, 26.95
FE0, FR, FE1, F_RD = 2.9, 5.7, 2.4, 20.3
fk0, fk1 = (FR - FE0) / (F_RD - F0), (FR - FE1) / (F1 - F_RD)
f_floor = 0.2
for u, out in ((F_U0, -1), (F_U1, 1)):
    fr, _ = wall_frame(u, F0, u, F1, (out, 0))
    holes = []
    if out > 0:                     # the side on the terrace: glazed doors and windows
        holes = [Hole(2.0, 3.8, f_floor, 2.3, kind="door", cols=2, rows=1, transom=1.95, depth=0.12),
                 win(5.4, 1.4, 1.0, 2.2, cols=2, rows=1),
                 Hole(7.0, 8.8, f_floor, 2.3, kind="door", cols=2, rows=1, transom=1.95, depth=0.12),
                 win(10.0, 1.0, 1.0, 2.0, cols=1, rows=1)]
    facade(fr, F1 - F0, [(0, FE0), (F1 - F0, FE1)], holes, plinth=0.55)
    pts = [fr.p(0, FE0, 0.03), fr.p(F_RD - F0, FR, 0.03), fr.p(F1 - F0, FE1, 0.03)]
    face("caf_boards", pts, fr.out())
    for s0, y0, s1, y1 in ((-0.3, FE0 - 0.3 * fk0, F_RD - F0, FR + 0.2), (F1 - F0 + 0.3, FE1 - 0.3 * fk1, F_RD - F0, FR + 0.2)):
        verge(fr.p(s0, y0, 0.3), fr.p(s1, y1, 0.3))
fn, _ = wall_frame(13.84, F0, F_U1, F0, (0, -1))
facade(fn, F_U1 - 13.84, [(0, FE0), (F_U1 - 13.84, FE0)], [], plinth=0.55)
fb, _ = wall_frame(F_U1, F1, F_U0, F1, (0, 1))
facade(fb, F_U1 - F_U0, [(0, FE1), (F_U1 - F_U0, FE1)], [Hole(6.0, 7.6, f_floor, 2.15, kind="door", panel="#4a4d50", cols=2, depth=0.1)], plinth=0.55)
for d0, y0, d1, y1 in ((F0 - 0.3, FE0 - 0.3 * fk0, F_RD, FR), (F1 + 0.3, FE1 - 0.3 * fk1, F_RD, FR)):
    pts = [G(F_U0 - 0.3, d0, y0), G(F_U1 + 0.3, d0, y0), G(F_U1 + 0.3, d1, y1), G(F_U0 - 0.3, d1, y1)]
    slab("caf_hall_roof", [(p[0], p[1], p[2] + TH) for p in pts], TH)
    gutter(G(F_U0 - 0.3, d0, y0 - 0.02), G(F_U1 + 0.3, d0, y0 - 0.02))
ubeam("caf_fittings", (F_U0 - 0.32, F_RD, FR + TH + 0.04), (F_U1 + 0.32, F_RD, FR + TH + 0.04), 0.26, 0.09, "#6a4134")
downpipe(F_U1 + 0.1, F0 + 0.15, FLOOR, FE0 - 0.25)
block(rect(F_U0, F_U1, F0, F1), BOTTOM, 2.65)
block(rect(F_U0, F_U1, F0 + 1.5, F1 - 2.2), 2.65, 3.75)
block(rect(F_U0, F_U1, F_RD - 1.4, F_RD + 1.6), 3.75, 4.9)

# ---------------------------------------------------------------- G: the lean-to and the sheds in the wood
# (under the hall's eaves on its gable, 2.4 m at the lowest)
for d in (16.6, 20.0, 23.4, 26.6):
    ubeam("caf_fittings", (-4.95, d, ground(-4.95, d) - 0.2), (-4.95, d, 2.02), 0.12, 0.12, "#3e3a36")
slab("caf_fittings", [G(F_U0, 16.1, 2.36), G(F_U0, 26.97, 2.36), G(-5.25, 26.97, 2.1), G(-5.25, 16.1, 2.1)], 0.08, "#3a3c3f")
ubeam("caf_fittings", (-4.95, 16.1, 1.97), (-4.95, 26.97, 1.97), 0.1, 0.16, "#3e3a36")
SHED = [(1.75, 26.97), (1.69, 31.6), (2.97, 31.56), (3.19, 38.77), (-5.74, 39.03), (-5.96, 31.61), (-4.67, 31.57), (-4.82, 26.97)]
g_top = 2.7
cu_ = sum(u for u, _ in SHED) / len(SHED)
cd_ = sum(d for _, d in SHED) / len(SHED)
for (ua, da), (ub, db) in zip(SHED, SHED[1:] + SHED[:1]):
    if da == db == 26.97:
        continue                    # against the hall
    out = (db - da, -(ub - ua))
    if out[0] * ((ua + ub) / 2 - cu_) + out[1] * ((da + db) / 2 - cd_) < 0:
        out = (-out[0], -out[1])
    sf, n = wall_frame(ua, da, ub, db, out)
    facade(sf, n, [(0, g_top), (n, g_top)], [], mat="caf_boards", bottom=-0.5, plinth=None)
slab("caf_fittings", [G(u, d, g_top + 0.12) for u, d in SHED], 0.16, "#38393b")
block(SHED, -0.5, g_top + 0.12)
block(rect(-5.2, -4.7, 16.3, 26.9), -0.5, 2.02, "oak")

# ---------------------------------------------------------------- the boarded shed and the carport roof (GBA)
S_U0, S_U1, S_D0, S_D1 = 9.39, 13.61, -2.34, CD0
S_TOP = 2.62
for (ua, da), (ub, db), out in (((S_U0, S_D0), (S_U1, S_D0), (0, -1)), ((S_U0, S_D1), (S_U0, S_D0), (-1, 0)), ((S_U1, S_D0), (S_U1, S_D1), (1, 0))):
    sf, n = wall_frame(ua, da, ub, db, out)
    facade(sf, n, [(0, S_TOP), (n, S_TOP)], [], mat="caf_boards", bottom=-0.4, plinth=None)
    sf.box("caf_fittings", -0.04, n + 0.04, -0.4, 0.05, -0.02, 0.03, "#2e3033")     # the plinth board
# The roof: dark ribbed metal from under the wing's gutter down to the front, past the shed on both sides.
R_U0, R_U1, R_D0, R_D1 = 8.95, 14.95, -2.62, CD0 - 0.22
r_hi, r_lo = 2.93, 2.66
slab("caf_fittings", [G(R_U0, R_D0, r_lo), G(R_U1, R_D0, r_lo), G(R_U1, R_D1, r_hi), G(R_U0, R_D1, r_hi)], 0.05, METAL)
k = 0
u = R_U0 + 0.12
while u < R_U1 - 0.05:
    ubeam("caf_fittings", (u, R_D0, r_lo + 0.025), (u, R_D1, r_hi + 0.025), 0.05, 0.035, "#43464a")
    u += 0.6
ubeam("caf_fittings", (R_U0, R_D0 + 0.02, r_lo - 0.03), (R_U1, R_D0 + 0.02, r_lo - 0.03), 0.06, 0.14, "#303235")     # the fascia
ubeam("caf_fittings", (R_U0, R_D0 + 0.25, r_lo - 0.16), (R_U1, R_D0 + 0.25, r_lo - 0.1), 0.12, 0.16, "#3a3c3f")   # the front beam
for u, d in ((S_U0, S_D0), (14.6, S_D0 - 0.05), (14.6, 1.2)):
    ubeam("caf_fittings", (u, d, ground(u, d) - 0.2), (u, d, r_lo - 0.1 + (d - R_D0) / (R_D1 - R_D0) * (r_hi - r_lo)), 0.12, 0.12, "#2f3134")
# The white knee braces: at the shed's front corner, at the free post on both its sides.
for a, b in (((S_U0, S_D0 - 0.08, 1.95), (S_U0 + 0.85, S_D0 - 0.08, 2.48)), ((14.6, S_D0 - 0.12, 1.95), (13.75, S_D0 - 0.12, 2.48)),
             ((14.66, S_D0, 1.95), (14.66, S_D0 + 0.85, 2.5))):
    ubeam("caf_fittings", a, b, 0.09, 0.09, "#efefeb")
block(rect(S_U0, S_U1, S_D0, S_D1), -0.4, S_TOP, "cladding")
block(rect(R_U0, R_U1, R_D0, R_D1), r_lo - 0.1, r_hi + 0.05, "steel")
block(rect(14.54, 14.66, S_D0 - 0.11, S_D0 + 0.01), -0.4, r_lo, "steel")

# ---------------------------------------------------------------- what stands on the forecourt
# The crowd barrier in front of the wing with a plain black panel on top, a planter by the entrance.
bu0, bu1, bd = 7.55, 9.05, 1.05
for u in (bu0, bu1):
    ubeam("caf_fittings", (u, bd, -0.03), (u, bd, 1.08), 0.04, 0.04, GALV)
    ubeam("caf_fittings", (u - 0.12, bd - 0.25, -0.02), (u + 0.12, bd + 0.25, -0.02), 0.05, 0.03, GALV)
for y in (0.12, 0.9):
    ubeam("caf_fittings", (bu0, bd, y), (bu1, bd, y), 0.03, 0.03, GALV)
for k in range(1, 9):
    u = bu0 + (bu1 - bu0) * k / 9
    ubeam("caf_fittings", (u, bd, 0.12), (u, bd, 0.9), 0.018, 0.018, GALV)
box("caf_fittings", bu0 + 0.05, bu1 - 0.05, bd - 0.015, bd + 0.015, 0.9, 1.2, "#1b1c1e")
block(rect(bu0, bu1, bd - 0.1, bd + 0.1), -0.1, 1.1, "steel")
box("caf_fittings", 6.75, 7.1, 1.15, 1.5, -0.05, 0.42, "#2b2c2e")
blob("caf_fittings", *P(6.925, 1.33), 0.4, 0.22, 0.45, "#4d6a3c", seed=3)
# The sign for the hall at the street: a black board on two white posts, a white arrow.
sg, _ = wall_frame(15.0, -15.0, 16.5, -15.6, (0, -1))
for s in (0.1, 1.4):
    sg.box("caf_fittings", s - 0.05, s + 0.05, ground(15.5, -15.3) - 0.3, 1.75, -0.05, 0.05, "#ecebe7")
sg.box("caf_fittings", -0.05, 1.55, 1.0, 1.7, 0.05, 0.1, "#18191a")
sg.box("caf_fittings", 0.45, 1.05, 1.17, 1.21, 0.1, 0.11, "#e9e7e2")
sg.stroke("caf_fittings", (0.45, 1.19), (0.62, 1.3), 0.04, 0.1, 0.11, "#e9e7e2")
sg.stroke("caf_fittings", (0.45, 1.19), (0.62, 1.08), 0.04, 0.1, 0.11, "#e9e7e2")

# ---------------------------------------------------------------- the ground: gravel, setts, slabs
def cover(mat, ring_ud, lift=0.03, skirt=0.25, paint=None):
    """A flat cover on the ground (an outline in (u, d)), `lift` above it, with a skirt down at its edges."""
    tmp = bmesh.new()
    vs = [tmp.verts.new((u, d, 0)) for u, d in ring_ud]
    f = tmp.faces.new(vs)
    bmesh.ops.triangulate(tmp, faces=[f], quad_method="BEAUTY", ngon_method="BEAUTY")
    for t in tmp.faces:
        pts = [G(v.co.x, v.co.y, ground(v.co.x, v.co.y) + lift) for v in t.verts]
        face(mat, pts, (0, 0, 1), paint)
    tmp.free()
    if skirt:
        n = len(ring_ud)
        area = sum(ring_ud[i][0] * ring_ud[(i + 1) % n][1] - ring_ud[(i + 1) % n][0] * ring_ud[i][1] for i in range(n))
        for i in range(n):
            (ua, da), (ub, db) = ring_ud[i], ring_ud[(i + 1) % n]
            out = (db - da, -(ub - ua)) if area > 0 else (-(db - da), ub - ua)
            face(mat, [G(ua, da, ground(ua, da) + lift), G(ub, db, ground(ub, db) + lift), G(ub, db, ground(ub, db) - skirt),
                       G(ua, da, ground(ua, da) - skirt)], (*vec(*out), 0), paint)


cover("caf_gravel", [(-3.2, -13.7), (15.12, -21.27), (15.6, -19.46), (15.6, -2.9), (14.95, -2.9), (14.95, 1.61), (S_U1, 1.61),
                     (S_U1, S_D0), (S_U0, S_D0), (S_U0, -1.3), (0.6, -1.3)], lift=0.03)
cover("caf_setts", [(-11.2, -10.4), (-3.2, -13.7), (0.6, -1.3), (-0.3, -1.3), (-0.3, B0 - 0.05), (BU - 0.3, B0 - 0.05), (BU - 0.3, 9.4),
                    (-5.5, 9.4), (-6.3, 3.9), (-8.6, -1.6)], lift=0.04)
cover("caf_slabs", [(-0.3, -1.3), (S_U0, -1.3), (S_U0, CD0), (AW, CD0), (AW, 0.0), (ARCH1 + 0.1, 0.0), (ARCH1 + 0.1, 0.32),
                    (ARCH0 - 0.1, 0.32), (ARCH0 - 0.1, 0.0), (-0.3, 0.0)], lift=0.06, skirt=0.2)
# The terrace on the north-west side: a path of light slabs along the walls with a dark kerb, gravel beyond.
path = [(C1, CD0), (15.45, CD0), (15.45, F0), (16.75, F0), (16.75, F1), (F_U1, F1), (F_U1, F0), (C1, F0)]
cover("caf_slabs", path, lift=0.05, skirt=0.15)
for a, b in (((15.5, CD0), (15.5, F0)), ((16.8, F0), (16.8, F1))):
    ubeam("caf_fittings", (*a, ground(*a) + 0.05), (*b, ground(*b) + 0.05), 0.1, 0.12, "#3b3c3e")
cover("caf_gravel", [(14.95, -2.9), (15.6, -2.9), (24.5, -4.6), (26.5, 13.5), (16.75, 15.4), (15.45, 15.4), (15.45, CD0), (14.95, CD0)], lift=0.03)
# Its furniture: black tables with chairs, closed black parasols, timber posts with a string of lights.
rng = np.random.default_rng(7)
for k, (u, d) in enumerate(((18.0, -0.5), (21.2, 0.4), (18.3, 3.6), (21.6, 4.6), (18.6, 7.8), (21.8, 8.8))):
    y0 = ground(u, d) + 0.03
    box("caf_fittings", u - 0.4, u + 0.4, d - 0.4, d + 0.4, y0 + 0.72, y0 + 0.76, "#1d1e20")
    box("caf_fittings", u - 0.04, u + 0.04, d - 0.04, d + 0.04, y0, y0 + 0.72, "#1d1e20")
    for cu, cd, bu_, bd_ in ((0, -0.62, 0, -0.82), (0, 0.62, 0, 0.82)):
        box("caf_fittings", u + cu - 0.22, u + cu + 0.22, d + cd - 0.2, d + cd + 0.2, y0 + 0.43, y0 + 0.47, "#232427")
        box("caf_fittings", u + cu - 0.22, u + cu + 0.22, d + bd_ - 0.02, d + bd_ + 0.02, y0, y0 + 0.88, "#232427")
for u, d in ((19.3, 1.8), (22.3, 2.7), (19.6, 6.1), (22.5, 7.1)):
    y0 = ground(u, d)
    utube("caf_fittings", (u, d, y0 - 0.2), (u, d, 2.4), 0.025, "#bfb7a8", seg=6)
    solid("caf_fittings", [G(u, d, 2.55)] + [G(u + 0.17 * math.cos(a), d + 0.17 * math.sin(a), 1.0) for a in np.linspace(0, 2 * math.pi, 9)[:-1]], "#1f2022")
    solid("caf_fittings", [G(u, d, 2.62)] + [G(u + 0.07 * math.cos(a), d + 0.07 * math.sin(a), 2.5) for a in np.linspace(0, 2 * math.pi, 7)[:-1]], "#1f2022")
posts = [(17.2, -2.4), (25.0, -1.0), (17.4, 11.2), (25.6, 11.8)]
for u, d in posts:
    ubeam("caf_fittings", (u, d, ground(u, d) - 0.3), (u, d, 3.3), 0.12, 0.12, "#8a7b66")
    block(rect(u - 0.08, u + 0.08, d - 0.08, d + 0.08), -0.5, 3.3, "oak")


def string(a, b, sag=0.35, n=4):
    """A string of lights from (u, d, y) a to b, hanging a little: the cable, a pale bulb at each bend."""
    pts = [(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t - sag * 4 * t * (1 - t)) for t in np.linspace(0, 1, n + 1)]
    for p, q in zip(pts, pts[1:]):
        ubeam("caf_fittings", p, q, 0.015, 0.015, "#1a1a1a")
    for p in pts[1:-1]:
        ubeam("caf_fittings", (p[0], p[1], p[2] - 0.02), (p[0], p[1], p[2] - 0.1), 0.06, 0.06, "#f4e7c4")


string((17.2, -2.4, 3.2), (25.0, -1.0, 3.2))
string((17.2, -2.4, 3.2), (17.4, 11.2, 3.2), n=5)
string((25.0, -1.0, 3.2), (25.6, 11.8, 3.2), n=5)
string((17.4, 11.2, 3.2), (25.6, 11.8, 3.2))
string((C1 + VF, 4.0, 3.3), (25.0, -1.0, 3.2), sag=0.5, n=5)


# ---------------------------------------------------------------- hedges, the gate and the screen
def hedge(path_ud, width, height, seed):
    """A clipped hedge along a path (u, d): a block per stretch with a rounded top."""
    for (ua, da), (ub, db) in zip(path_ud, path_ud[1:]):
        L = math.hypot(ub - ua, db - da)
        tu, td = (ub - ua) / L, (db - da) / L
        nu, nd = -td, tu
        pts = []
        for (u, d) in ((ua - tu * width / 2, da - td * width / 2), (ub + tu * width / 2, db + td * width / 2)):
            g = ground(u, d)
            for k, (off, y) in enumerate(((-1.0, -0.2), (1.0, -0.2), (-1.0, height - 0.25), (1.0, height - 0.25), (-0.6, height), (0.6, height))):
                pts.append(G(u + nu * off * width / 2, d + nd * off * width / 2, g + y))
        solid("caf_hedge", pts)
        block([(ua + nu * width / 2, da + nd * width / 2), (ub + nu * width / 2, db + nd * width / 2),
               (ub - nu * width / 2, db - nd * width / 2), (ua - nu * width / 2, da - nd * width / 2)], -0.5, height, "hedge")


hedge([(-15.0, 2.2), (-6.3, 3.5), (-5.6, 9.2)], 0.85, 1.6, 1)
hedge([(15.75, -3.3), (24.5, -4.9)], 0.7, 1.15, 2)
# The grey timber gate between the cross gable and the screen, and the white screen on its frame.
gf, _ = wall_frame(BU - 0.05, 9.45, -3.25, 9.45, (0, -1))
for s in (0.0, 2.2):
    gf.box("caf_fittings", s - 0.06, s + 0.06, -0.4, 1.95, -0.06, 0.06, "#7f7d77")
k = 0.1
while k < 2.12:
    gf.flat("caf_fittings", k, k + 0.11, 0.05, 1.82, 0.02, "#9b9890" if int(k * 10) % 2 else "#a39f97")   # a board, both faces
    face("caf_fittings", [gf.p(k, 0.05, -0.02), gf.p(k + 0.11, 0.05, -0.02), gf.p(k + 0.11, 1.82, -0.02), gf.p(k, 1.82, -0.02)], gf.out(-1), "#9b9890")
    k += 0.13
gf.box("caf_fittings", 0.08, 2.12, 0.35, 0.47, 0.02, 0.06, "#8c8981")
gf.box("caf_fittings", 0.08, 2.12, 1.45, 1.57, 0.02, 0.06, "#8c8981")
sc, _ = wall_frame(-3.25, 9.45, -5.6, 9.3, (0, -1))
for s in (0.0, 2.35):
    sc.box("caf_fittings", s - 0.03, s + 0.03, -0.3, 1.85, -0.03, 0.03, "#5a5c5e")
sc.box("caf_fittings", 0.03, 2.32, 0.1, 1.78, -0.01, 0.01, "#e8eae7")
block(rect(-5.6, BU - 0.05, 9.37, 9.53), -0.5, 1.9, "fence")

# ---------------------------------------------------------------- UVs, objects, export
def metre_uvs(bm, scale):
    uv = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        n = f.normal
        if abs(n.z) > 0.97:
            t, b = Vector((1, 0, 0)), Vector((0, 1, 0))
        else:
            t = Vector((0, 0, 1)).cross(n).normalized()
            b = n.cross(t).normalized()
        for lp in f.loops:
            p = lp.vert.co
            lp[uv].uv = ((p.dot(t)) / scale, (p.dot(b)) / scale)


root = bpy.data.objects.new("sparrenhof", None)
bpy.context.scene.collection.objects.link(root)
root["origin"] = [ORIGIN[0], ORIGIN[1]]
root["landmark"] = "sparrenhof"
root["replaces"] = [[list(p) for p in OUTLINE], [list(p) for p in CANOPY]]
root["blocks"] = blocks
root["blocksOnGround"] = True
tris = 0
objs = []
for name, bm in BM.items():
    if not bm.faces:
        continue
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
    bm.normal_update()
    if name in SHARED:
        metre_uvs(bm, UVSCALE[name])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    me.materials.append(M[name])
    me.set_sharp_from_angle(angle=math.radians(30))
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = root
    me.calc_loop_triangles()
    tris += len(me.loop_triangles)
    print(f"{name}: {len(me.loop_triangles)} triangles")
    objs.append(ob)
print(f"sparrenhof: {tris} triangles in {len(objs)} meshes, {len(blocks)} blocks; origin {ORIGIN}")
bpy.ops.object.select_all(action="DESELECT")
root.select_set(True)
for o in objs:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=True, export_normals=True, export_extras=True, export_vertex_color="MATERIAL",
                          export_cameras=False, export_lights=False)
print("written", OUT, os.path.getsize(OUT), "bytes")

# ---------------------------------------------------------------- preview renders (from the photos' spots)
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 32
    try:
        scene.view_settings.view_transform = "AgX"
    except TypeError:
        scene.view_settings.view_transform = "Filmic"
    sizes = json.load(open(os.path.join(ROOT, "web", "public", "textures", "sizes.json")))

    def textured(mat, tex, tint, nscale):
        """The game's look in Blender: its texture at its size in metres, times the tint."""
        nt = mat.node_tree
        p = nt.nodes["Principled BSDF"]
        uv = nt.nodes.new("ShaderNodeUVMap")
        mp = nt.nodes.new("ShaderNodeMapping")
        s = 1 / sizes.get(tex, 2.0)
        mp.inputs["Scale"].default_value = (s, s, 1)
        nt.links.new(uv.outputs["UV"], mp.inputs["Vector"])

        def image(kind, colour):
            t = nt.nodes.new("ShaderNodeTexImage")
            t.image = bpy.data.images.load(os.path.join(ROOT, "web", "public", "textures", f"{tex}_{kind}.webp"), check_existing=True)
            t.image.colorspace_settings.name = "sRGB" if colour else "Non-Color"
            nt.links.new(mp.outputs["Vector"], t.inputs["Vector"])
            return t

        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        nt.links.new(image("color", True).outputs["Color"], mix.inputs["A"])
        mix.inputs["B"].default_value = (*srgb(tint), 1)
        nt.links.new(mix.outputs["Result"], p.inputs["Base Color"])
        if os.path.exists(os.path.join(ROOT, "web", "public", "textures", f"{tex}_normal.webp")):
            nm = nt.nodes.new("ShaderNodeNormalMap")
            nm.inputs["Strength"].default_value = nscale
            nt.links.new(image("normal", False).outputs["Color"], nm.inputs["Color"])
            nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])

    for name, (tex, tint, nscale, _, _) in SHARED.items():
        textured(M[name], tex, tint, nscale)
    # An overcast November sky: soft light from everywhere, a weak sun from the south.
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.62, 0.68, 0.78, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.1
    scene.world = world
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(55), 0, math.radians(200)))
    bpy.context.active_object.data.energy = 1.5
    # The ground round it, and the wood behind as a dark green wall.
    bpy.ops.mesh.primitive_plane_add(size=300, location=(0, 0, -0.35))
    gm = principled("PreviewGround", srgb("#6d6a5c"), 0.95)
    bpy.context.active_object.data.materials.append(gm)
    wx, wz = P(5.0, 48.0)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(wx - ORIGIN[0], -(wz - ORIGIN[1]), 9), scale=(120, 2, 18))
    bpy.context.active_object.rotation_euler.z = math.atan2(-UVEC[1], UVEC[0])
    bpy.context.active_object.data.materials.append(principled("PreviewWood", srgb("#2f3a2a"), 1.0))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    cam.data.sensor_fit = "HORIZONTAL"
    cam.data.sensor_width = 36.0
    os.makedirs(PREVIEW, exist_ok=True)

    def shoot(label, eye, target, f_px=576, w=600, h=800):
        """A render from eye (u, d, y) towards target (u, d, y), with the focal length in pixels."""
        scene.render.resolution_x, scene.render.resolution_y = w, h
        e, t = V(*G(*eye)), V(*G(*target))
        cam.location = e
        cam.rotation_euler = (t - e).to_track_quat("-Z", "Y").to_euler()
        cam.data.lens = f_px / w * 36.0
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)

    shoot("front", (4.5, -27.0, 1.4), (5.5, 0.0, 3.0))          # photos 2, 4 and 6: from the street, straight on
    shoot("left", (-7.5, -19.0, 1.5), (5.0, 2.0, 2.8))          # photos 1, 3, 5 and 7: from the street, to the left
    shoot("terrace", (27.0, -6.0, 1.7), (12.0, 10.0, 2.0))      # the terrace side the photos don't show
    shoot("back", (-14.0, 40.0, 4.0), (6.0, 15.0, 2.0))         # the back, from the wood
    shoot("aerial", (-25.0, -45.0, 30.0), (6.0, 8.0, 0.0), f_px=700, w=900, h=700)
