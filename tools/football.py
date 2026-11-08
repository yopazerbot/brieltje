"""Build FC Smetlede's ground in Blender: the goals, the rails, fences and ball-stop nets, the floodlights, the dugouts,
the clubhouse with its covered terrace and canteen, the low stand, the dressing-room block and containers.

Run (Blender 5, no window), from the project root, after tools/football_site.py:
  blender -b -P tools/football.py -- web/public/models/football.glb [preview_dir]

Our own model, built from (used for measuring only, nothing of them is shipped), all read from web/shared/football.json
(tools/football_site.py has the research):
- the plan: the GRB outlines (Digitaal Vlaanderen, open data) of the main building along the pitch (GBG OIDN 7778673),
  the low building in front of its western end (GBG OIDN 7778780) and the newer block behind that (GBG OIDN 6995671),
  in the game's frame; the clubhouse follows its outline, a few degrees off the pitch's axis;
- the heights: the DHM Vlaanderen II laser scan (2013-2015): the main building's lean-to roof 3.4 m on the pitch side
  and 2.75 m at the back, the low building 2.5 to 2.9 m;
- the orthophoto (25 cm), for measuring only: the pitch's lines (100 by 55.15 m), the spectators' rail, the fences
  along the far side and the far end, the two dugouts with red seats by the halfway line, the grey lean-to roof, the
  white roof over the low building, the red roofs of the containers, the paved yard beyond them, the four floodlight
  masts' feet;
- the usual sizes: full-size goals (7.32 by 2.44 m, round posts of 12 cm), corner flags of 1.5 m, a rail of 1.1 m,
  fences of 2 m, bucket seats 45 cm high, steps of 15 by 45 cm.
Made up in the same style, as nothing shows them: the masts' height (16 m) and their LED floodlights, the ball-stop
nets' size (6 m), the dugouts' and the stand's build, the clubhouse's doors and windows, the red fascia (the club's
colours), the dressing-room block's and the containers' doors and windows, the benches, bins, ball cage, cones and the
ticket hut. Plain red and white: no badge, no sponsors, no lettering. No people, no cars.

Frame: the GLB is in the game's own axes (x, y up, z), its origin on the ground at the centre spot (json `centre`).
Everything stands on one flat ground at y = 0 (tools/terrain.py levels the platform there). The site frame (u, w):
u along the pitch from the far end (u < 0) to the car park's end, w across it from the far side (w < 0) to the
buildings' side; a point at (u, w) is centre + u * json.u + w * json.w.

Output: one GLB:
- fb_brick, fb_plinth, fb_concrete: UVs in metres; their glTF extras name a shared game texture and its tint;
- fb_glass: dark glass;
- fb_fittings: posts, rails, goals, roofs, seats, containers and the rest, coloured per vertex;
- fb_fence (the mesh fences, the ball cage), fb_ballnet (the ball-stop nets): panels with UVs in metres, the page puts a
  cut-out mesh on them;
- fb_goalnet_far, fb_goalnet_near: the goal nets (material fb_net, UVs in metres), each with its origin at its goal
  mouth's middle on the ground, so the page can bulge them;
- fb_lamps: the floodlights' faces (material fb_lamp), which the page lights at night.
The root's custom properties: `origin`, `landmark`, `replaces` (the three GRB outlines), `clear` (open ground where
the village's trees give way), `blocks` (for walking into, heights above the ground, `blocksOnGround`) and `lamps`
([x, y, z, dx, dy, dz] per floodlight, in the game's axes from the origin).
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
PREVIEW = argv[1] if len(argv) > 1 else None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = json.load(open(os.path.join(ROOT, "web", "shared", "football.json"), encoding="utf-8"))

# ---------------------------------------------------------------- the frame
ORIGIN = (DATA["centre"][0], DATA["centre"][1])
UV_ = DATA["u"]
WV_ = DATA["w"]


def P(u, w):
    """The game point (x, z) at (u, w) in the site frame."""
    return (ORIGIN[0] + UV_[0] * u + WV_[0] * w, ORIGIN[1] + UV_[1] * u + WV_[1] * w)


def vec(du, dw):
    """A plan direction (game x, z) from one in (u, w)."""
    return (UV_[0] * du + WV_[0] * dw, UV_[1] * du + WV_[1] * dw)


def frame_of(x, z):
    """(u, w) of a game point."""
    dx, dz = x - ORIGIN[0], z - ORIGIN[1]
    return (dx * UV_[0] + dz * UV_[1], dx * WV_[0] + dz * WV_[1])


def V(x, z, y):
    """A game point (x, z, y above the ground) in Blender's frame (z up)."""
    return Vector((x - ORIGIN[0], -(z - ORIGIN[1]), y))


class Axes:
    """A plan frame in the site's (u, w): origin o, unit direction t; n is t turned towards +w."""

    def __init__(self, o, t):
        n = math.hypot(*t)
        self.o, self.t = o, (t[0] / n, t[1] / n)
        self.n = (-self.t[1], self.t[0])

    def uw(self, s, d):
        return (self.o[0] + self.t[0] * s + self.n[0] * d, self.o[1] + self.t[1] * s + self.n[1] * d)

    def P(self, s, d):
        return P(*self.uw(s, d))

    def G(self, s, d, y):
        return (*self.P(s, d), y)

    def vec(self, ds, dd):
        return vec(self.t[0] * ds + self.n[0] * dd, self.t[1] * ds + self.n[1] * dd)


SITE = Axes((0.0, 0.0), (1.0, 0.0))


def G(u, w, y):
    return (*P(u, w), y)


def srgb(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


# ---------------------------------------------------------------- materials and meshes
bpy.ops.wm.read_factory_settings(use_empty=True)
# name: (shared game texture, tint, normal scale, mean colour of the result, metres per UV unit)
SHARED = {
    "fb_brick": ("nb_brick", "#a8634c", 0.9, "#86503d", 1.0),       # red-brown brick
    "fb_plinth": ("nb_brick", "#4b4a49", 0.8, "#3a3938", 1.0),      # the dark plinth
    "fb_concrete": ("concrete", "#e6e3dd", 0.7, "#aeaaa3", 1.0),    # the apron, the yard, steps and footings
}
M = {}
UVSCALE = {}


def principled(name, color, rough, metal=0.0, cull=True):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    m.use_backface_culling = cull
    return m


for name, (tex, tint, nscale, mean, scale) in SHARED.items():
    M[name] = principled(name, srgb(mean), 0.9)
    M[name]["texture"], M[name]["tint"], M[name]["normalScale"] = tex, tint, nscale
    UVSCALE[name] = scale
M["fb_glass"] = principled("fb_glass", srgb("#1c2328"), 0.08)
M["fb_fittings"] = principled("fb_fittings", (1, 1, 1), 0.6)
nt = M["fb_fittings"].node_tree
attr = nt.nodes.new("ShaderNodeVertexColor")
attr.layer_name = "Color"
nt.links.new(attr.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
# Panels the page dresses (cut-out mesh, nets): seen from both sides.
M["fb_fence"] = principled("fb_fence", srgb("#2f4a37"), 0.7, 0.3, cull=False)
M["fb_ballnet"] = principled("fb_ballnet", srgb("#3a3f3c"), 0.9, cull=False)
M["fb_net"] = principled("fb_net", srgb("#f1f1ee"), 0.9, cull=False)
M["fb_lamp"] = principled("fb_lamp", srgb("#f4f6f8"), 0.3)
# mesh name: material name
MESHES = {"fb_brick": "fb_brick", "fb_plinth": "fb_plinth", "fb_concrete": "fb_concrete", "fb_glass": "fb_glass",
          "fb_fittings": "fb_fittings", "fb_fence": "fb_fence", "fb_ballnet": "fb_ballnet",
          "fb_goalnet_far": "fb_net", "fb_goalnet_near": "fb_net", "fb_lamps": "fb_lamp"}
METRE_UVS = {"fb_brick", "fb_plinth", "fb_concrete", "fb_fence", "fb_ballnet", "fb_goalnet_far", "fb_goalnet_near"}
BM = {name: bmesh.new() for name in MESHES}
BM["fb_fittings"].loops.layers.float_color.new("Color")

GALV = "#a9adb0"         # galvanised steel
WHITE = "#f1f1ed"
RED = "#c0262b"          # the club's red
SEAT = "#b5232a"         # the bucket seats
GREEN = "#2c4734"        # the fences' dark green
SHEET = "#3b3e43"        # the dark grey metal roof
STEEL = "#45494e"        # dark painted steel
PANEL = "#cfd2d3"        # the dugouts' light grey panels
CABIN = "#e7e8e4"        # the containers' white walls
BLOCKG = "#8c9196"       # the dressing-room block's grey
DOOR_RED = "#8d2926"
DOOR_GREY = "#5d6368"
FRAME = "#2c2e31"        # window frames


def colour(h):
    return (*srgb(h), 1.0) if h else (1.0, 1.0, 1.0, 1.0)


def paint_face(bm, f, hexcol):
    lay = bm.loops.layers.float_color.get("Color")
    if lay is not None:
        c = colour(hexcol)
        for lp in f.loops:
            lp[lay] = c


# ---------------------------------------------------------------- geometry helpers (game points (x, z, y))
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


def box(mat, s0, s1, d0, d1, y0, y1, paint=None, ax=SITE):
    """A box square to the axes `ax` (the site's by default)."""
    solid(mat, [ax.G(s, d, y) for s in (s0, s1) for d in (d0, d1) for y in (y0, y1)], paint)


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


def ubeam(mat, a, b, w, h, paint=None, ax=SITE):
    """beam() between points given in the axes' (s, d, y)."""
    beam(mat, ax.G(*a), ax.G(*b), w, h, paint)


def tube(mat, a, b, r, paint=None, seg=8, r1=None):
    """A round bar from game point a to b, radius r (r1 at b: tapered)."""
    a, b = Vector(a), Vector(b)
    dv = (b - a).normalized()
    u = dv.cross(Vector((1, 0, 0)) if abs(dv.x) < 0.9 else Vector((0, 1, 0))).normalized()
    w = dv.cross(u)
    r1 = r if r1 is None else r1
    pts = []
    for k in range(seg):
        t = 2 * math.pi * k / seg
        pts += [tuple(a + (u * math.cos(t) + w * math.sin(t)) * r), tuple(b + (u * math.cos(t) + w * math.sin(t)) * r1)]
    solid(mat, pts, paint)


def utube(mat, a, b, r, paint=None, seg=8, ax=SITE, r1=None):
    tube(mat, ax.G(*a), ax.G(*b), r, paint, seg, r1)


def slab(mat, pts, th, paint=None):
    """A sloping or flat plate on the planar convex outline pts (game points), th thick below it."""
    top = list(pts)
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


def inside(ring, x, z):
    hit = False
    for i in range(len(ring)):
        (xi, zi), (xj, zj) = ring[i], ring[i - 1]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
            hit = not hit
    return hit


def flat_area(mat, ring_plan, y, edge=0.0):
    """A flat (maybe concave) area on a ring of game plan points: its top at y, its edges down to `edge`."""
    face(mat, [(x, z, y) for x, z in ring_plan], (0, 0, 1))
    for i in range(len(ring_plan)):
        a, b = ring_plan[i], ring_plan[(i + 1) % len(ring_plan)]
        n = (b[1] - a[1], -(b[0] - a[0]))
        ln = math.hypot(*n)
        mid = ((a[0] + b[0]) / 2 + n[0] / ln * 0.01, (a[1] + b[1]) / 2 + n[1] / ln * 0.01)
        if inside(ring_plan, *mid):
            n = (-n[0], -n[1])
        face(mat, [(*a, y), (*b, y), (*b, edge), (*a, edge)], (n[0], n[1], 0))


class Frame:
    """A wall's frame on the plan: origin a, direction t along the wall, outward normal o (game plan vectors).
    p(s, y, d): s along, y up (above the ground), d out of the wall."""

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


def wall_frame(ax, s0, d0, s1, d1, out):
    """The frame of a wall from (s0, d0) to (s1, d1) in the axes `ax`, facing `out` (an (s, d) direction)."""
    a = ax.P(s0, d0)
    b = ax.P(s1, d1)
    n = math.hypot(b[0] - a[0], b[1] - a[1])
    o = ax.vec(*out)
    on = math.hypot(*o)
    return Frame(a, ((b[0] - a[0]) / n, (b[1] - a[1]) / n), (o[0] / on, o[1] / on)), n


class Hole:
    def __init__(self, s0, s1, y0, y1, kind="window", depth=0.15, frame=FRAME, cols=1, rows=1, transom=None,
                 panel=None, sill=True):
        self.s0, self.s1, self.y0, self.y1 = s0, s1, y0, y1
        self.kind, self.depth, self.frame, self.cols, self.rows = kind, depth, frame, cols, rows
        self.transom, self.panel, self.sill = transom, panel, sill


def facade(f, length, top, holes, mat="fb_brick", bottom=-0.3, plinth=0.4):
    """A wall from s = 0 to length: its surface from `bottom` up to the line `top` ([(s, y)], straight between),
    without the holes, with their reveals, glass or door panels, frames and sills; below `plinth` the dark plinth."""
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
                m = "fb_plinth" if plinth is not None and y1 is not None and y1 <= plinth + 1e-6 else mat
                ta = ytop(xa) if y1 is None else y1
                tb = ytop(xb) if y1 is None else y1
                if max(ta, tb) - y0 < 1e-4:
                    continue
                face(m, [f.p(xa, y0), f.p(xb, y0), f.p(xb, tb), f.p(xa, ta)], f.out())
    for h in holes:
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
        face("fb_fittings", pane, f.out(), h.panel)
    else:
        face("fb_glass", pane, f.out())
    fw, fd = 0.06, d + 0.04
    c = h.frame
    f.flat("fb_fittings", h.s0, h.s0 + fw, h.y0, h.y1, fd, c)
    f.flat("fb_fittings", h.s1 - fw, h.s1, h.y0, h.y1, fd, c)
    f.flat("fb_fittings", h.s0 + fw, h.s1 - fw, h.y1 - fw, h.y1, fd, c)
    if h.kind != "door" or not h.panel:
        f.flat("fb_fittings", h.s0 + fw, h.s1 - fw, h.y0, h.y0 + fw, fd, c)
    for k in range(1, h.cols):
        m = h.s0 + (h.s1 - h.s0) * k / h.cols
        f.flat("fb_fittings", m - 0.025, m + 0.025, h.y0 + fw, h.y1 - fw, fd + 0.003, c)
    for k in range(1, h.rows):
        m = h.y0 + (h.y1 - h.y0) * k / h.rows
        f.flat("fb_fittings", h.s0 + fw, h.s1 - fw, m - 0.025, m + 0.025, fd + 0.005, c)
    if h.transom:
        f.flat("fb_fittings", h.s0 + fw, h.s1 - fw, h.transom - 0.035, h.transom + 0.035, fd + 0.006, c)
    if h.panel and h.kind == "door":          # a handle
        hs = h.s1 - 0.12 if (h.s1 - h.s0) < 1.3 else (h.s0 + h.s1) / 2 + 0.08
        f.box("fb_fittings", hs - 0.015, hs + 0.015, 1.0, 1.25, d, d + 0.06, GALV)
    if h.sill and h.kind != "door":
        f.box("fb_fittings", h.s0 - 0.04, h.s1 + 0.04, h.y0 - 0.05, h.y0, d, 0.05, "#8a8c8d")


def corrugated(f, s0, s1, y0, y1, paint, pitch=0.26, depth=0.028):
    """A ribbed metal sheet on the frame f from s0 to s1, y0 to y1 (its outer ribs at d = depth)."""
    n = max(1, round((s1 - s0) / pitch))
    p = (s1 - s0) / n
    prof = []
    for k in range(n):
        s = s0 + k * p
        prof += [(s, depth), (s + 0.24 * p, depth), (s + 0.36 * p, 0.0), (s + 0.88 * p, 0.0)]
    prof.append((s1, depth))
    for (sa, da), (sb, db) in zip(prof, prof[1:]):
        face("fb_fittings", [f.p(sa, y0, da), f.p(sb, y0, db), f.p(sb, y1, db), f.p(sa, y1, da)], f.out(), paint)


blocks = []


def block(ring_sd, y0, y1, m="nb_white", ax=SITE):
    """A block for walking into: an outline in the axes' (s, d), heights above the ground."""
    blocks.append({"m": m, "p": [[[round(c, 3) for c in ax.P(s, d)] for s, d in ring_sd]], "y0": round(y0, 3), "y1": round(y1, 3)})


def rect(s0, s1, d0, d1):
    return [(s0, d0), (s1, d0), (s1, d1), (s0, d1)]


def thin(a, b, th, y0, y1, m, ax=SITE):
    """A thin block along the segment a to b (axes' (s, d)), th thick."""
    ds, dd = b[0] - a[0], b[1] - a[1]
    n = math.hypot(ds, dd)
    ns, nd = -dd / n * th / 2, ds / n * th / 2
    block([(a[0] + ns, a[1] + nd), (b[0] + ns, b[1] + nd), (b[0] - ns, b[1] - nd), (a[0] - ns, a[1] - nd)], y0, y1, m, ax)


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def posts_along(a, b, spacing):
    n = max(1, math.ceil(math.dist(a, b) / spacing - 1e-6))
    return [lerp(a, b, k / n) for k in range(n + 1)]


def seat(u, w, y, facing, ax=SITE):
    """A red bucket seat, its pan's top at y, its middle at (u, w), facing `facing` (+1 or -1 along w)."""
    b = -facing                           # towards the back
    pan = [ax.G(u + du, w + dw, yy) for du in (-0.21, 0.21) for dw, yy in ((-0.2 * b, y - 0.035), (-0.2 * b, y - 0.01),
                                                                            (0.18 * b, y - 0.05), (0.18 * b, y))]
    solid("fb_fittings", pan, SEAT)
    back = [ax.G(u + du, w + dw, yy) for du in (-0.2, 0.2) for dw, yy in ((0.17 * b, y), (0.21 * b, y), (0.25 * b, y + 0.36),
                                                                          (0.29 * b, y + 0.36))]
    solid("fb_fittings", back, SEAT)


def seat_row(u0, u1, step, w, y, facing, floor, ax=SITE):
    """A row of bucket seats from u0 to u1 with a seat every `step`, on a steel rail and legs from `floor`."""
    n = int(math.floor((u1 - u0) / step + 1e-6))
    for k in range(n + 1):
        seat(u0 + k * step, w, y, facing, ax)
    ubeam("fb_fittings", (u0 - 0.2, w + 0.02 * facing, y - 0.12), (u0 + n * step + 0.2, w + 0.02 * facing, y - 0.12), 0.06, 0.06, STEEL, ax)
    for p in posts_along((u0, w), (u0 + n * step, w), 2.4):
        ubeam("fb_fittings", (p[0], p[1], floor), (p[0], p[1], y - 0.12), 0.05, 0.05, STEEL, ax)


# ---------------------------------------------------------------- the json's numbers
HALF_L = DATA["length"] / 2
HALF_W = DATA["width"] / 2
RAIL = DATA["rail"]
FENCE = DATA["fence"]
GATE = DATA["gate"]
DUG = DATA["dugouts"]
DUG_W = DATA["dugout_w"]
TER = DATA["terrace"]
SEATS = DATA["seats"]
CONT = DATA["containers"]
YARD = DATA["yard"]
RINGS = {k: [frame_of(*p) for p in ring] for k, ring in DATA["buildings"].items()}

# ---------------------------------------------------------------- the goals and their nets
GOAL_W, GOAL_H, POST_R = 7.32, 2.44, 0.06
NET_LOW, NET_TOP = 2.0, 1.0            # the net's depth at the ground and at the top
NETS = {}
for g in DATA["goals"]:
    gu, k = g["u"], g["in"]
    wp = GOAL_W / 2 + POST_R            # the posts' middles
    yb = GOAL_H + POST_R                # the crossbar's
    for s in (-1, 1):
        utube("fb_fittings", (gu, s * wp, 0.0), (gu, s * wp, yb + POST_R), POST_R, WHITE, seg=10)
        # the back frame: a bar back from the crossbar's end, down to the ground at the back, and along the ground
        utube("fb_fittings", (gu, s * wp, yb), (gu + k * NET_TOP, s * wp, yb), 0.025, WHITE, seg=6)
        utube("fb_fittings", (gu + k * NET_TOP, s * wp, yb), (gu + k * NET_LOW, s * wp, 0.03), 0.025, WHITE, seg=6)
        utube("fb_fittings", (gu, s * wp, 0.025), (gu + k * NET_LOW, s * wp, 0.025), 0.025, WHITE, seg=6)
        block(rect(gu - 0.07, gu + 0.07, s * wp - 0.07, s * wp + 0.07), -0.1, yb + POST_R, "alu")
        thin((gu, s * wp), (gu + k * 1.5, s * wp), 0.05, 0.0, 2.3, "fence")
    utube("fb_fittings", (gu, -wp - POST_R, yb), (gu, wp + POST_R, yb), POST_R, WHITE, seg=10)
    utube("fb_fittings", (gu + k * NET_TOP, -wp, yb), (gu + k * NET_TOP, wp, yb), 0.025, WHITE, seg=6)
    utube("fb_fittings", (gu + k * NET_LOW, -wp, 0.025), (gu + k * NET_LOW, wp, 0.025), 0.025, WHITE, seg=6)
    block(rect(gu - 0.07, gu + 0.07, -wp, wp), yb - POST_R, yb + POST_R, "alu")
    for d0, d1, y0, y1 in ((1.9, 2.0, -0.1, 0.6), (1.45, 1.55, 0.6, 1.8), (1.0, 1.1, 1.8, yb)):   # the slanting back net
        block(rect(min(gu + k * d0, gu + k * d1), max(gu + k * d0, gu + k * d1), -wp, wp), y0, y1, "fence")
    # The net: roof, back and two sides, each a grid of quads the page can bulge; the mesh's own origin at the mouth.
    mesh = f"fb_goalnet_{g['id']}"
    NETS[mesh] = (gu, 0.0)
    yn = yb - 0.02

    def grid(c00, c10, c11, c01, nu, nv, out):
        for i in range(nu):
            for j in range(nv):
                q = []
                for a, b in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)):
                    fa, fb = a / nu, b / nv
                    q.append(tuple(c00[m] * (1 - fa) * (1 - fb) + c10[m] * fa * (1 - fb) + c11[m] * fa * fb + c01[m] * (1 - fa) * fb
                                   for m in range(3)))
                face(mesh, q, out)
    grid(G(gu, -wp, yn), G(gu, wp, yn), G(gu + k * NET_TOP, wp, yn), G(gu + k * NET_TOP, -wp, yn), 8, 2, (0, 0, 1))
    back_out = vec(k * GOAL_H, 0)
    grid(G(gu + k * NET_TOP, -wp, yn), G(gu + k * NET_TOP, wp, yn), G(gu + k * NET_LOW, wp, 0.02), G(gu + k * NET_LOW, -wp, 0.02), 8, 5,
         (back_out[0], back_out[1], NET_LOW - NET_TOP))
    for s in (-1, 1):
        so = vec(0, s)
        grid(G(gu, s * wp, 0.02), G(gu, s * wp, yn), G(gu + k * NET_TOP, s * wp, yn), G(gu + k * NET_LOW, s * wp, 0.02), 3, 5,
             (so[0], so[1], 0))

# ---------------------------------------------------------------- the corner flags
for cu in (-HALF_L, HALF_L):
    for cw in (-HALF_W, HALF_W):
        for b in range(5):
            utube("fb_fittings", (cu, cw, b * 0.3), (cu, cw, (b + 1) * 0.3), 0.015, RED if b % 2 else WHITE, seg=6)
        side = 1.0 if cw < 0 else -1.0               # the flag flies inwards along the goal line
        box("fb_fittings", cu - 0.004, cu + 0.004, cw + side * 0.015, cw + side * 0.42, 1.17, 1.47, RED)
        utube("fb_fittings", (cu, cw, 1.5), (cu, cw, 1.53), 0.02, WHITE, seg=6)

# ---------------------------------------------------------------- the spectators' rail round the pitch
RAIL_H, RAIL_LOW, RAIL_R = RAIL["height"], 0.45, 0.03
u0, u1, w0, w1 = RAIL["u0"], RAIL["u1"], RAIL["w0"], RAIL["w1"]
openings = sorted([tuple(d) for d in DUG] + [(49.0, 52.0)])
runs = [((u0, w0), (u1, w0)), ((u0, w0), (u0, w1)), ((u1, w0), (u1, w1))]
a = u0
for o0, o1 in openings:
    runs.append(((a, w1), (o0, w1)))
    a = o1
runs.append(((a, w1), (u1, w1)))
for a, b in runs:
    for p in posts_along(a, b, 2.5):
        utube("fb_fittings", (p[0], p[1], -0.05), (p[0], p[1], RAIL_H + RAIL_R), RAIL_R, GALV, seg=6)
    ln = math.dist(a, b)
    t = ((b[0] - a[0]) / ln, (b[1] - a[1]) / ln)
    utube("fb_fittings", (a[0] - t[0] * 0.03, a[1] - t[1] * 0.03, RAIL_H), (b[0] + t[0] * 0.03, b[1] + t[1] * 0.03, RAIL_H), RAIL_R, GALV, seg=6)
    utube("fb_fittings", (a[0], a[1], RAIL_LOW), (b[0], b[1], RAIL_LOW), 0.024, GALV, seg=6)
    thin(a, b, 0.07, -0.1, RAIL_H + RAIL_R, "rail")

# ---------------------------------------------------------------- the mesh fences (2 m) and the gate
FH = FENCE["height"]
fence_runs = [((FENCE["end"], FENCE["far"]), (FENCE["near_end"], FENCE["far"])),
              ((FENCE["end"], FENCE["far"]), (FENCE["end"], 30.5)),
              ((FENCE["near_end"], FENCE["far"]), (FENCE["near_end"], GATE["w0"]))]
# The far end's fence reaches w = 30.5 (the brief); past the gate a short piece closes on the clubhouse's corner.
club_corner = RINGS["clubhouse"][3]                      # the outline's front corner at the car park's end
fence_runs.append(((FENCE["near_end"], GATE["w1"]), (club_corner[0] + 0.25, club_corner[1] + 0.05)))


def fence_run(a, b, h=FH, mat="fb_fence", post=GREEN, r=0.03, spacing=2.5):
    ps = posts_along(a, b, spacing)
    for p in ps:
        utube("fb_fittings", (p[0], p[1], -0.05), (p[0], p[1], h + 0.03), r, post, seg=6)
    utube("fb_fittings", (a[0], a[1], h), (b[0], b[1], h), 0.022, post, seg=6)
    utube("fb_fittings", (a[0], a[1], 0.12), (b[0], b[1], 0.12), 0.008, post, seg=4)
    for p, q in zip(ps, ps[1:]):
        face(mat, [G(p[0], p[1], 0.04), G(q[0], q[1], 0.04), G(q[0], q[1], h - 0.02), G(p[0], p[1], h - 0.02)])
    thin(a, b, 0.06, -0.1, h, "fence")


for a, b in fence_runs:
    fence_run(a, b)
gu_ = FENCE["near_end"]
for gw in (GATE["w0"], GATE["w1"]):                       # the gate's posts, and its two leaves swung open outwards
    utube("fb_fittings", (gu_, gw, -0.05), (gu_, gw, FH + 0.1), 0.05, GREEN, seg=8)
    utube("fb_fittings", (gu_, gw, FH + 0.1), (gu_, gw, FH + 0.13), 0.06, GREEN, seg=8)
half = (GATE["w1"] - GATE["w0"]) / 2
for hinge, end in (((gu_ + 0.08, GATE["w0"]), (gu_ + 0.08, GATE["w0"] - half + 0.05)),
                   ((gu_ + 0.06, GATE["w1"]), (gu_ + half - 0.05, GATE["w1"] + 0.06))):
    for y in (0.08, FH - 0.08):
        utube("fb_fittings", (*hinge, y), (*end, y), 0.02, GREEN, seg=6)
    for p in (hinge, end):
        utube("fb_fittings", (*p, 0.08), (*p, FH - 0.08), 0.02, GREEN, seg=6)
    face("fb_fence", [G(*hinge, 0.08), G(*end, 0.08), G(*end, FH - 0.08), G(*hinge, FH - 0.08)])
    thin(hinge, end, 0.06, -0.1, FH, "fence")

# ---------------------------------------------------------------- the ball-stop nets behind the goals
for net in DATA["nets"]:
    nu = net["u"] + (-0.35 if net["u"] < 0 else 0.35)       # just outside the fence's line
    a, b = (nu, net["w0"]), (nu, net["w1"])
    nh = net["height"]
    ps = posts_along(a, b, 6.0)
    for p in ps:
        utube("fb_fittings", (p[0], p[1], -0.1), (p[0], p[1], nh + 0.05), 0.05, GALV, seg=8)
        utube("fb_fittings", (p[0], p[1], nh + 0.05), (p[0], p[1], nh + 0.08), 0.06, GALV, seg=8)
    for y in (nh, nh / 2, 0.15):
        utube("fb_fittings", (a[0], a[1], y), (b[0], b[1], y), 0.012, "#7d8184", seg=4)
    for p, q in zip(ps, ps[1:]):
        face("fb_ballnet", [G(p[0], p[1], 0.05), G(q[0], q[1], 0.05), G(q[0], q[1], nh - 0.02), G(p[0], p[1], nh - 0.02)])
    out_u = -1.0 if net["u"] < 0 else 1.0
    for p in (ps[0], ps[-1]):                                # stays at the ends, away from the pitch
        utube("fb_fittings", (p[0], p[1], nh - 0.3), (p[0] + out_u * 2.0, p[1], -0.05), 0.012, "#7d8184", seg=4)
    thin(a, b, 0.08, -0.1, nh, "fence")

# ---------------------------------------------------------------- the floodlight masts
MAST_H, TILT = 16.0, math.radians(25)
lamps = []
for mu, mw in DATA["masts"]:
    box("fb_concrete", mu - 0.3, mu + 0.3, mw - 0.3, mw + 0.3, -0.2, 0.3)
    utube("fb_fittings", (mu, mw, 0.3), (mu, mw, MAST_H), 0.16, GALV, seg=10, r1=0.08)
    utube("fb_fittings", (mu, mw, 0.3), (mu, mw, 0.55), 0.21, GALV, seg=10, r1=0.18)       # its foot flange
    block(rect(mu - 0.3, mu + 0.3, mw - 0.3, mw + 0.3), -0.2, 0.3, "concrete")
    block(rect(mu - 0.2, mu + 0.2, mw - 0.2, mw + 0.2), 0.3, MAST_H, "steel")
    # The heading to the aim point on the pitch, as a game plan direction, and the arm square to it.
    hx, hz = vec(mu * 0.5 - mu, 0.0 - mw)
    hn = math.hypot(hx, hz)
    hx, hz = hx / hn, hz / hn
    rx, rz = -hz, hx
    base = P(mu, mw)
    ya = MAST_H - 0.6
    tube("fb_fittings", (base[0] - rx * 0.85, base[1] - rz * 0.85, ya), (base[0] + rx * 0.85, base[1] + rz * 0.85, ya), 0.05, GALV, seg=6)
    tube("fb_fittings", (base[0] - rx * 0.85, base[1] - rz * 0.85, ya + 0.5), (base[0] + rx * 0.85, base[1] + rz * 0.85, ya + 0.5), 0.04,
         GALV, seg=6)
    c_, s_ = math.cos(TILT), math.sin(TILT)     # f: forward, tilted down (game x, z, y); up and r square to it
    for side in (-0.55, 0.55):
        # Each of the two fans out a little along the pitch: its aim 9 m from the mast's aim point, on its own side.
        ru = (rx * UV_[0] + rz * UV_[1]) * side
        ax_, az_ = P(mu * 0.5 + (9.0 if ru > 0 else -9.0), 0.0)
        hx, hz = ax_ - base[0], az_ - base[1]
        hn = math.hypot(hx, hz)
        hx, hz = hx / hn, hz / hn
        f = (hx * c_, hz * c_, -s_)
        up = (hx * s_, hz * s_, c_)
        r = (-hz, hx, 0.0)
        cx, cz, cy = base[0] + rx * side + hx * 0.32, base[1] + rz * side + hz * 0.32, ya + 0.25
        pt = lambda a, b, c: (cx + r[0] * a + up[0] * b + f[0] * c, cz + r[1] * a + up[1] * b + f[1] * c, cy + r[2] * a + up[2] * b + f[2] * c)
        solid("fb_fittings", [pt(a, b, c) for a in (-0.3, 0.3) for b in (-0.225, 0.225) for c in (-0.06, 0.06)], "#3a3d41")
        solid("fb_fittings", [pt(a, b, c) for a in (-0.27, 0.27) for b in (-0.19, 0.19) for c in (-0.1, -0.06)], "#2f3236")   # its fins
        face("fb_lamps", [pt(-0.27, -0.195, 0.063), pt(0.27, -0.195, 0.063), pt(0.27, 0.195, 0.063), pt(-0.27, 0.195, 0.063)],
             (f[0], f[1], f[2]))
        # the yoke: from the housing's back to the arm
        tube("fb_fittings", pt(0, 0, -0.1), (base[0] + rx * side, base[1] + rz * side, ya + 0.25), 0.03, GALV, seg=6)
        lc = pt(0, 0, 0.063)
        lamps.append([round(lc[0] - ORIGIN[0], 3), round(lc[2], 3), round(lc[1] - ORIGIN[1], 3),
                      round(f[0], 3), round(f[2], 3), round(f[1], 3)])

# ---------------------------------------------------------------- the dugouts
DW0, DW1 = DUG_W
for du0, du1 in DUG:
    y_front, y_back = 2.0, 1.9
    yr = lambda w: y_front + (y_back - y_front) * (w - DW0) / (DW1 - DW0)
    box("fb_fittings", du0, du1, DW1 - 0.05, DW1, 0.0, y_back, PANEL)                    # the back panel
    for u in (du0, du1 - 0.04):                                                          # the side panels
        solid("fb_fittings", [G(uu, w, y) for uu in (u, u + 0.04) for w, y in ((DW0 + 0.1, 0.0), (DW1, 0.0), (DW0 + 0.1, yr(DW0 + 0.1)),
                                                                                   (DW1, y_back))], PANEL)
        utube("fb_fittings", (u + 0.02, DW0 + 0.1, 0.0), (u + 0.02, DW0 + 0.1, y_front), 0.035, WHITE, seg=6)
    slab("fb_fittings", [G(du0 - 0.06, DW0 - 0.1, yr(DW0 - 0.1) + 0.07), G(du1 + 0.06, DW0 - 0.1, yr(DW0 - 0.1) + 0.07),
                         G(du1 + 0.06, DW1 + 0.05, yr(DW1 + 0.05) + 0.07), G(du0 - 0.06, DW1 + 0.05, yr(DW1 + 0.05) + 0.07)], 0.07, "#d9dcdd")
    box("fb_fittings", du0 - 0.07, du1 + 0.07, DW0 - 0.13, DW0 - 0.09, yr(DW0) - 0.04, yr(DW0) + 0.1, WHITE)   # the white roof edge
    seat_row(du0 + 0.35, du1 - 0.35, 0.5, DW1 - 0.38, 0.45, -1, 0.03)
    block(rect(du0, du1, DW1 - 0.08, DW1), -0.1, y_back, "nb_white")
    for u in (du0, du1 - 0.04):
        block(rect(u, u + 0.04, DW0 + 0.1, DW1), -0.1, y_back, "nb_white")
    block(rect(du0, du1, DW0 - 0.1, DW1), y_back, y_front + 0.07, "steel")

# ---------------------------------------------------------------- the clubhouse (the GRB outline's own axes)
cr = RINGS["clubhouse"]
CA = cr[5]                                   # its front corner at the west end (u, w)
CB = cr[3]                                   # and at the car park's end
CLUB = Axes(CA, (CB[0] - CA[0], CB[1] - CA[1]))
CL_L = math.dist(CA, CB)
CL_D = sum((cr[1][i] - CA[i]) * CLUB.n[i] for i in (0, 1))            # its depth, front to back
Y_FRONT, Y_BACK = 3.4, 2.75                                            # the roof's top over the front and back lines
ROOF_TH = 0.15


def roof_top(d):
    return Y_FRONT + (Y_BACK - Y_FRONT) * d / CL_D


def under(d):
    return roof_top(d) - ROOF_TH


def s_of(u):
    return (u - CA[0]) / CLUB.t[0]


S_T0, S_T1 = max(0.0, s_of(TER["u0"])), s_of(TER["u1"])    # the covered terrace's ends
TD = 2.4                                                     # its depth under the roof
END = 0.25                                                   # the west end wall's thickness
# The terrace: a floor along the front, then the steps up away from the pitch to the wall.
box("fb_concrete", END + 0.01, S_T1 - 0.02, 0.0, 0.3, -0.1, 0.03, ax=CLUB)
for k in range(TER["steps"]):
    d0 = 0.3 + k * TER["going"]
    d1 = TD if k == TER["steps"] - 1 else d0 + TER["going"]
    top = TER["rise"] * (k + 1)
    box("fb_concrete", END + 0.01, S_T1 - 0.02, d0, d1, -0.1, top, ax=CLUB)
    block(rect(END, S_T1, d0, d1), -0.1, top, "concrete", CLUB)
STEP_TOP = TER["rise"] * TER["steps"]
# The building's wall behind the terrace: dressing-room doors (red), the referee's, storage and toilet doors (grey),
# small high windows between them.
fw, n = wall_frame(CLUB, END, TD, S_T1, TD, (0, -1))
holes = []
DOORS = [(2.3, 1.0, DOOR_RED), (7.3, 1.0, DOOR_RED), (12.3, 1.0, DOOR_RED), (17.3, 1.0, DOOR_RED), (22.3, 0.9, DOOR_GREY),
         (27.0, 2.0, DOOR_GREY), (33.6, 1.0, DOOR_GREY), (38.2, 1.0, DOOR_GREY)]
for s, wd, col in DOORS:
    if s + wd < n - 0.3:
        holes.append(Hole(s, s + wd, STEP_TOP, STEP_TOP + 2.1, kind="door", panel=col, depth=0.1, cols=2 if wd > 1.5 else 1))
for s in (4.4, 9.4, 14.4, 19.4, 24.3, 30.4, 35.6):
    if s + 1.2 < n - 0.3:
        holes.append(Hole(s, s + 1.2, 2.05, 2.55, cols=2, depth=0.12))
facade(fw, n, [(0, under(TD)), (n, under(TD))], holes, bottom=STEP_TOP - 0.1, plinth=STEP_TOP + 0.3)
# The terrace's posts and the beam along the front under the roof.
for s in [END + 0.2 + k * (S_T1 - END - 0.4) / 8 for k in range(9)]:
    ubeam("fb_fittings", (s, 0.12, 0.03), (s, 0.12, under(0.12) - 0.2), 0.1, 0.1, STEEL, CLUB)
    block(rect(s - 0.06, s + 0.06, 0.06, 0.18), -0.1, under(0.12), "steel", CLUB)
ubeam("fb_fittings", (END, 0.12, under(0.12) - 0.1), (S_T1, 0.12, under(0.12) - 0.1), 0.12, 0.2, STEEL, CLUB)
for s in (8.0, 20.0, 32.0):                                  # lamps under the roof
    box("fb_fittings", s - 0.6, s + 0.6, 1.1, 1.22, under(1.16) - 0.06, under(1.16), "#e9ebec", CLUB)
    face("fb_lamps", [CLUB.G(s - 0.55, 1.12, under(1.16) - 0.061), CLUB.G(s + 0.55, 1.12, under(1.16) - 0.061),
                      CLUB.G(s + 0.55, 1.2, under(1.16) - 0.061), CLUB.G(s - 0.55, 1.2, under(1.16) - 0.061)], (0, 0, -1))
# The west end wall: solid brick beside the terrace, then the closed part's end.
solid("fb_brick", [CLUB.G(s, d, y) for s in (0.0, END) for d, y in ((0.0, -0.3), (TD, -0.3), (0.0, under(0.0)), (TD, under(TD)))])
solid("fb_plinth", [CLUB.G(s, d, y) for s in (-0.01, END + 0.01) for d in (-0.01, TD) for y in (-0.3, 0.4)])
fwest, n = wall_frame(CLUB, 0.0, CL_D, 0.0, TD, (-1, 0))
facade(fwest, n, [(0, under(CL_D)), (n, under(TD))], [Hole(1.6, 2.4, 1.9, 2.4, cols=1, depth=0.12)])
# The canteen at the car park's end: a large glass front to the pitch, a glass door, its side to the terrace.
CN = CL_L - S_T1
fc, n = wall_frame(CLUB, S_T1, 0.0, CL_L, 0.0, (0, -1))
facade(fc, n, [(0, under(0.0)), (n, under(0.0))],
       [Hole(0.5, 5.7, 0.55, 2.7, cols=4, rows=1, depth=0.12, transom=2.2),
        Hole(6.2, 7.8, 0.03, 2.7, kind="door", cols=2, rows=1, transom=2.2, depth=0.12),
        Hole(8.3, n - 0.5, 0.55, 2.7, cols=4, rows=1, depth=0.12, transom=2.2)])
fc.box("fb_concrete", 6.0, 8.0, -0.1, 0.06, 0.0, 0.5)                                  # the step at the door
fs, n = wall_frame(CLUB, S_T1, TD, S_T1, 0.0, (-1, 0))
facade(fs, n, [(0, under(TD)), (n, under(0.0))], [Hole(0.5, 1.7, 1.0, 2.5, cols=1, depth=0.12)])
# The end wall facing the car park: a door and a window.
fe, n = wall_frame(CLUB, CL_L, 0.0, CL_L, CL_D, (1, 0))
facade(fe, n, [(0, under(0.0)), (n, under(CL_D))],
       [Hole(1.0, 2.0, 0.03, 2.15, kind="door", panel=DOOR_GREY, depth=0.1), Hole(3.1, 5.0, 1.0, 2.2, cols=2, depth=0.12)])
fe.box("fb_concrete", 0.8, 2.2, -0.1, 0.06, 0.0, 0.6)
# The back: plain, with a few small windows and a door.
fb, n = wall_frame(CLUB, CL_L, CL_D, 0.0, CL_D, (0, 1))
back_holes = [Hole(n - s - 0.4, n - s + 0.4, 1.85, 2.35, cols=1, depth=0.12) for s in (5.0, 13.0, 21.0, 29.0, 37.0)]
back_holes += [Hole(n - 46.0 - 0.6, n - 46.0 + 0.6, 1.3, 2.25, cols=2, depth=0.12), Hole(n - 51.0 - 0.6, n - 51.0 + 0.6, 1.3, 2.25, cols=2, depth=0.12),
               Hole(n - 43.0 - 0.5, n - 43.0 + 0.5, 0.03, 2.1, kind="door", panel=DOOR_GREY, depth=0.1)]
facade(fb, n, [(0, under(CL_D)), (n, under(CL_D))], back_holes)
# The lean-to roof of dark grey sheet: ribs down the slope, a red fascia along the front, a gutter and downpipes at the back.
R_S0, R_S1, R_D0, R_D1 = -0.15, CL_L + 0.15, -0.12, CL_D + 0.25
slab("fb_fittings", [CLUB.G(R_S0, R_D0, roof_top(R_D0)), CLUB.G(R_S1, R_D0, roof_top(R_D0)), CLUB.G(R_S1, R_D1, roof_top(R_D1)),
                     CLUB.G(R_S0, R_D1, roof_top(R_D1))], ROOF_TH, SHEET)
nrib = int(CL_L / 0.9)
for k in range(nrib + 1):
    s = R_S0 + 0.1 + k * (R_S1 - R_S0 - 0.2) / nrib
    ubeam("fb_fittings", (s, R_D0, roof_top(R_D0) + 0.015), (s, R_D1, roof_top(R_D1) + 0.015), 0.04, 0.035, "#33363a", CLUB)
box("fb_fittings", R_S0 - 0.03, R_S1 + 0.03, R_D0 - 0.04, R_D0, roof_top(R_D0) - 0.24, roof_top(R_D0) + 0.06, RED, CLUB)
for s in (R_S0 - 0.03, R_S1 - 0.01):
    solid("fb_fittings", [CLUB.G(ss, d, y) for ss in (s, s + 0.04) for d, y in ((R_D0, roof_top(R_D0) - 0.24), (R_D0, roof_top(R_D0) + 0.06),
                                                                                (R_D1, roof_top(R_D1) - 0.2), (R_D1, roof_top(R_D1) + 0.06))], SHEET)
utube("fb_fittings", (R_S0, R_D1 + 0.06, roof_top(R_D1) - 0.16), (R_S1, R_D1 + 0.06, roof_top(R_D1) - 0.16), 0.065, "#2e3033", seg=6, ax=CLUB)
for s in (6.0, 27.5, CL_L - 4.5):
    utube("fb_fittings", (s, CL_D + 0.07, 0.0), (s, CL_D + 0.07, roof_top(R_D1) - 0.4), 0.045, "#2e3033", seg=6, ax=CLUB)
    ubeam("fb_fittings", (s, CL_D + 0.07, roof_top(R_D1) - 0.42), (s, R_D1 + 0.06, roof_top(R_D1) - 0.2), 0.07, 0.07, "#2e3033", CLUB)
# Blocks: the closed parts, the end wall, the roof in strips.
block(rect(END, S_T1, TD, CL_D), -0.3, under(TD), "nb_red", CLUB)
block(rect(S_T1, CL_L, 0.0, CL_D), -0.3, under(0.0), "nb_red", CLUB)
block(rect(0.0, END, 0.0, TD), -0.3, under(0.0), "nb_red", CLUB)
block(rect(0.0, END, TD, CL_D), -0.3, under(TD), "nb_red", CLUB)
for k in range(3):
    da, db = R_D0 + (R_D1 - R_D0) * k / 3, R_D0 + (R_D1 - R_D0) * (k + 1) / 3
    block(rect(R_S0, R_S1, da, db), roof_top(db) - ROOF_TH, roof_top((da + db) / 2), "steel", CLUB)

# ---------------------------------------------------------------- the low stand in front of the clubhouse's west end
sr = RINGS["stand"]
SU0, SU1 = min(p[0] for p in sr) + 0.05, max(p[0] for p in sr) - 0.1      # (its east end against the clubhouse)
SW0 = min(p[1] for p in sr)
SW1 = max(p[1] for p in sr) - 0.1                       # its back wall's outer face
S_FRONT, S_BACK = 2.75, 2.45                            # the roof's top at the front and the back


def s_roof(w):
    return S_FRONT + (S_BACK - S_FRONT) * (w - SW0) / (SW1 - SW0)


rows = SEATS["rows"]
TIER_W = (rows[0]["w"] + rows[1]["w"]) / 2 - 0.0       # where the upper tier starts
tier2 = rows[1]["y"] - rows[0]["y"]
box("fb_concrete", SU0, SU1, SW0, TIER_W, -0.1, 0.06)
box("fb_concrete", SU0, SU1, TIER_W, SW1 - 0.1, -0.1, tier2)
block(rect(SU0, SU1, SW0, TIER_W), -0.1, 0.06, "concrete")
block(rect(SU0, SU1, TIER_W, SW1), -0.1, tier2, "concrete")
for row, floor in zip(rows, (0.06, tier2)):
    seat_row(SEATS["u0"], SEATS["u1"], SEATS["step"], row["w"], row["y"], -1, floor)
box("fb_fittings", SU0, SU1, SW1 - 0.1, SW1, -0.05, s_roof(SW1) - 0.08, "#d4d6d4")            # the pale grey back wall
for u in (SU0, SU1 - 0.06):                                                                      # its end panels
    solid("fb_fittings", [G(uu, w, y) for uu in (u, u + 0.06) for w, y in ((SW0 + 0.6, -0.05), (SW1, -0.05), (SW0 + 0.6, s_roof(SW0 + 0.6) - 0.08),
                                                                               (SW1, s_roof(SW1) - 0.08))], "#d4d6d4")
    block(rect(u, u + 0.06, SW0 + 0.6, SW1), -0.1, s_roof(SW1), "nb_white")
block(rect(SU0, SU1, SW1 - 0.1, SW1), -0.1, s_roof(SW1), "nb_white")
slab("fb_fittings", [G(SU0 - 0.1, SW0 - 0.2, s_roof(SW0 - 0.2)), G(SU1 + 0.05, SW0 - 0.2, s_roof(SW0 - 0.2)), G(SU1 + 0.05, SW1 + 0.12, s_roof(SW1 + 0.12)),
                     G(SU0 - 0.1, SW1 + 0.12, s_roof(SW1 + 0.12))], 0.08, "#eeeeea")
for k in range(int((SU1 - SU0) / 0.9) + 1):
    u = SU0 + 0.05 + k * 0.9
    ubeam("fb_fittings", (u, SW0 - 0.2, s_roof(SW0 - 0.2) + 0.012), (u, SW1 + 0.12, s_roof(SW1 + 0.12) + 0.012), 0.035, 0.03, "#e2e2de")
box("fb_fittings", SU0 - 0.12, SU1 + 0.07, SW0 - 0.24, SW0 - 0.2, s_roof(SW0) - 0.2, s_roof(SW0 - 0.2) + 0.03, RED)       # a red fascia
for u in [SU0 + 0.15 + k * (SU1 - SU0 - 0.3) / 5 for k in range(6)]:
    utube("fb_fittings", (u, SW0 + 0.1, 0.06), (u, SW0 + 0.1, s_roof(SW0 + 0.1) - 0.08), 0.045, WHITE, seg=8)
    block(rect(u - 0.05, u + 0.05, SW0 + 0.05, SW0 + 0.15), -0.1, s_roof(SW0), "steel")
ubeam("fb_fittings", (SU0, SW0 + 0.1, s_roof(SW0 + 0.1) - 0.14), (SU1, SW0 + 0.1, s_roof(SW0 + 0.1) - 0.14), 0.08, 0.12, WHITE)
block(rect(SU0, SU1, SW0 - 0.2, SW1 + 0.12), s_roof(SW1) - 0.08, s_roof(SW0), "steel")

# ---------------------------------------------------------------- the grey dressing-room block behind the stand
br = RINGS["block"]
BU0, BU1 = min(p[0] for p in br), max(p[0] for p in br)
BW0, BW1 = min(p[1] for p in br) + 0.03, max(p[1] for p in br) - 0.03
B_H = 2.8


def cabin(u0, u1, w0, w1, h, wall, roof, edge, doors, windows, back_windows=()):
    """A container-built cabin: ribbed walls on a base frame, corner posts, a flat roof with its edge band;
    doors and windows on the front (towards -w) as (u0, u1) spans, proud of the ribs."""
    for (sa, da), (sb, db), out in (((u0, w0), (u1, w0), (0, -1)), ((u1, w1), (u0, w1), (0, 1)), ((u0, w1), (u0, w0), (-1, 0)),
                                    ((u1, w0), (u1, w1), (1, 0))):
        f, n = wall_frame(SITE, sa, da, sb, db, out)
        corrugated(f, 0.0, n, 0.16, h - 0.16, wall)
        f.box("fb_fittings", -0.02, n + 0.02, -0.1, 0.16, -0.02, 0.05, "#55595d")                 # the base frame
        f.box("fb_fittings", -0.02, n + 0.02, h - 0.17, h, -0.02, 0.05, edge)                    # the roof's edge band
        if out == (0, -1):                      # the front runs from u0: s = u - u0
            doors = [(a - u0, b - u0) for a, b in doors]
            windows = [(a - u0, b - u0) for a, b in windows]
            for a, b in doors:
                f.box("fb_fittings", a - 0.05, b + 0.05, 0.12, 2.12, 0.0, 0.05, "#5a5f63")
                f.box("fb_fittings", a, b, 0.16, 2.06, 0.0, 0.06, DOOR_GREY if wall != CABIN else "#d7d9d6")
                f.box("fb_fittings", b - 0.14, b - 0.1, 0.95, 1.15, 0.0, 0.09, GALV)
                f.box("fb_concrete", a - 0.3, b + 0.3, -0.1, 0.12, 0.0, 0.5)                   # a step
            for a, b in windows:
                f.box("fb_fittings", a - 0.04, b + 0.04, 1.36, 2.04, 0.0, 0.05, "#e9e9e6")
                f.flat("fb_glass", a, b, 1.4, 2.0, 0.055)
                f.box("fb_fittings", (a + b) / 2 - 0.02, (a + b) / 2 + 0.02, 1.4, 2.0, 0.0, 0.06, "#e9e9e6")
        if out == (0, 1):
            for a, b in back_windows:
                f.box("fb_fittings", n - b - 0.04, n - a + 0.04, 1.56, 2.04, 0.0, 0.05, "#e9e9e6")
                f.flat("fb_glass", n - b, n - a, 1.6, 2.0, 0.055)
    for u in (u0, u1):
        for w in (w0, w1):
            box("fb_fittings", u - 0.06, u + 0.06, w - 0.06, w + 0.06, -0.1, h, "#cfd1cf" if wall == CABIN else "#6b7075")
    slab("fb_fittings", [G(u0 + 0.02, w0 + 0.02, h + 0.02), G(u1 - 0.02, w0 + 0.02, h + 0.02), G(u1 - 0.02, w1 - 0.02, h + 0.02),
                         G(u0 + 0.02, w1 - 0.02, h + 0.02)], 0.06, roof)
    block(rect(u0 - 0.06, u1 + 0.06, w0 - 0.06, w1 + 0.06), -0.1, h + 0.02, "steel")


cabin(BU0, BU1, BW0, BW1, B_H, BLOCKG, "#4a4e52", "#6b7075",
      doors=[(BU0 + 2.6, BU0 + 3.5), (BU1 - 3.8, BU1 - 2.9)],
      windows=[(BU0 + 0.8, BU0 + 1.8), (BU0 + 5.2, BU0 + 6.2), (BU0 + 7.2, BU0 + 8.2), (BU1 - 1.8, BU1 - 0.8)],
      back_windows=[(1.0, 1.8), (5.0, 5.8), (9.0, 9.8)])

# ---------------------------------------------------------------- the red-roofed dressing-room containers
NC = 4
cw_ = (CONT["u1"] - CONT["u0"]) / NC
for k in range(NC):
    a = CONT["u0"] + k * cw_ + 0.04
    b = a + cw_ - 0.08
    cabin(a, b, CONT["w0"], CONT["w1"], 2.8, CABIN, "#b3302c", RED,
          doors=[(a + 0.35, a + 1.25)], windows=[(a + 1.65, b - 0.35)], back_windows=[(0.9, 1.7)])

# ---------------------------------------------------------------- the concrete apron and the yard
cfront = [CLUB.uw(s, 0.0) for s in (CL_L, 0.0)]
APRON = [(YARD["u0"], RAIL["w1"]), (cr[3][0], RAIL["w1"]), cfront[0], cfront[1],
         (sr[4][0], sr[4][1]), (sr[0][0], SW0), (sr[0][0] - 0.05, CONT["w1"]), (CONT["u1"], CONT["w1"]), (CONT["u1"], CONT["w0"]),
         (CONT["u0"], CONT["w0"]), (YARD["u0"] + (YARD["u1"] - YARD["u0"]), YARD["w1"]), (YARD["u0"], YARD["w1"])]
flat_area("fb_concrete", [P(u, w) for u, w in APRON], 0.03)

# ---------------------------------------------------------------- small things
def bench(u, w, facing):
    """A park bench, its seat 0.45 high, facing `facing` along w."""
    b = -facing
    for du in (-0.75, 0.75):
        ubeam("fb_fittings", (u + du, w - 0.2 * b, 0.03), (u + du, w - 0.2 * b, 0.45), 0.05, 0.05, STEEL)
        ubeam("fb_fittings", (u + du, w + 0.2 * b, 0.03), (u + du, w + 0.22 * b, 0.85), 0.05, 0.05, STEEL)
    for k, dw in enumerate((-0.18, -0.05, 0.08)):
        box("fb_fittings", u - 0.9, u + 0.9, w + (dw - 0.055) * b, w + (dw + 0.055) * b, 0.43, 0.47, "#8a6a4c")
    for y in (0.6, 0.76):
        box("fb_fittings", u - 0.9, u + 0.9, w + 0.215 * b, w + 0.24 * b, y - 0.05, y + 0.05, "#8a6a4c")
    block(rect(u - 0.9, u + 0.9, w - 0.25, w + 0.25), 0.0, 0.47, "oak")


def bin_(u, w):
    utube("fb_fittings", (u, w, 0.03), (u, w, 0.25), 0.04, STEEL, seg=6)
    utube("fb_fittings", (u, w, 0.25), (u, w, 0.9), 0.22, "#2f5a3c", seg=10, r1=0.24)
    utube("fb_fittings", (u, w, 0.9), (u, w, 0.94), 0.25, "#26492f", seg=10)
    block(rect(u - 0.25, u + 0.25, w - 0.25, w + 0.25), 0.0, 0.94, "steel")


bench(YARD["u0"] + 2.5, RAIL["w1"] + 0.7, -1)
bench(YARD["u0"] + 7.0, RAIL["w1"] + 0.7, -1)
for u, w in ((YARD["u0"] + 0.8, RAIL["w1"] + 0.6), (CONT["u1"] + 1.1, RAIL["w1"] + 0.6), (DUG[1][1] + 1.2, RAIL["w1"] + 0.55),
             (47.5, RAIL["w1"] + 0.5)):
    bin_(u, w)
# The ball cage by the containers: a steel frame, mesh sides and lid, a few balls inside.
cu0, cu1, cw0, cw1, ch = CONT["u0"] - 1.6, CONT["u0"] - 0.4, CONT["w0"] + 0.9, CONT["w0"] + 1.7, 1.0
for u in (cu0, cu1):
    for w in (cw0, cw1):
        ubeam("fb_fittings", (u, w, 0.03), (u, w, ch), 0.035, 0.035, GALV)
for y in (0.08, ch):
    for (ua, wa), (ub, wb) in (((cu0, cw0), (cu1, cw0)), ((cu1, cw0), (cu1, cw1)), ((cu1, cw1), (cu0, cw1)), ((cu0, cw1), (cu0, cw0))):
        ubeam("fb_fittings", (ua, wa, y), (ub, wb, y), 0.03, 0.03, GALV)
for (ua, wa), (ub, wb) in (((cu0, cw0), (cu1, cw0)), ((cu1, cw0), (cu1, cw1)), ((cu1, cw1), (cu0, cw1)), ((cu0, cw1), (cu0, cw0))):
    face("fb_fence", [G(ua, wa, 0.08), G(ub, wb, 0.08), G(ub, wb, ch), G(ua, wa, ch)])
face("fb_fence", [G(cu0, cw0, ch), G(cu1, cw0, ch), G(cu1, cw1, ch), G(cu0, cw1, ch)])
for k, (du, dw, dy) in enumerate(((0.3, 0.25, 0.0), (0.75, 0.5, 0.0), (0.5, 0.35, 0.2), (0.95, 0.2, 0.0))):
    cx, cz = P(cu0 + du, cw0 + dw)
    pts = []
    for i in range(1, 4):
        t = math.pi * i / 4
        for j in range(6):
            a = 2 * math.pi * (j + 0.5 * i) / 6
            pts.append((cx + 0.11 * math.sin(t) * math.cos(a), cz + 0.11 * math.sin(t) * math.sin(a), 0.19 + dy - 0.11 * math.cos(t)))
    pts += [(cx, cz, 0.08 + dy), (cx, cz, 0.30 + dy)]
    solid("fb_fittings", pts, WHITE if k % 2 == 0 else "#e8e4dc")
block(rect(cu0, cu1, cw0, cw1), 0.0, ch, "steel")
# Stacks of orange training cones in the yard.
for k, (u, w, n) in enumerate(((YARD["u1"] - 2.4, CONT["w0"] + 0.6, 6), (YARD["u1"] - 2.0, CONT["w0"] + 0.9, 4), (YARD["u1"] - 2.7, CONT["w0"] + 1.0, 3))):
    utube("fb_fittings", (u, w, 0.03), (u, w, 0.06), 0.16, "#e8661f", seg=8)
    utube("fb_fittings", (u, w, 0.06), (u, w, 0.3 + 0.03 * n), 0.12, "#f07422", seg=8, r1=0.03)
    for j in range(n):
        utube("fb_fittings", (u, w, 0.07 + 0.03 * j), (u, w, 0.095 + 0.03 * j), 0.118 - 0.006 * j, "#f5f1e8" if j % 2 else "#e8661f", seg=8)
# The little white ticket hut by the gate, inside the fence: its window faces the way in.
hu0, hu1, hw0, hw1 = FENCE["near_end"] - 1.55, FENCE["near_end"] - 0.3, GATE["w0"] - 1.6, GATE["w0"] - 0.3
box("fb_fittings", hu0, hu1, hw0, hw1, -0.1, 2.3, "#efefeb")
slab("fb_fittings", [G(hu0 - 0.15, hw0 - 0.15, 2.42), G(hu1 + 0.15, hw0 - 0.15, 2.42), G(hu1 + 0.15, hw1 + 0.25, 2.42),
                     G(hu0 - 0.15, hw1 + 0.25, 2.42)], 0.12, RED)
fh, n = wall_frame(SITE, hu1, hw1, hu0, hw1, (0, 1))
fh.flat("fb_glass", 0.2, n - 0.2, 1.05, 1.9, 0.005)
fh.box("fb_fittings", 0.15, n - 0.15, 0.98, 1.05, 0.0, 0.28, "#d8d8d4")              # the counter
fh.box("fb_fittings", 0.15, n - 0.15, 1.9, 1.96, 0.0, 0.03, FRAME)
fh2, n2 = wall_frame(SITE, hu0, hw1, hu0, hw0, (-1, 0))
fh2.box("fb_fittings", 0.35, 1.1, -0.05, 2.0, 0.0, 0.03, "#bfc2c3")                  # its door, towards the pitch's end
block(rect(hu0, hu1, hw0, hw1), -0.1, 2.42, "nb_white")

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


root = bpy.data.objects.new("football", None)
bpy.context.scene.collection.objects.link(root)
root["origin"] = [ORIGIN[0], ORIGIN[1]]
root["landmark"] = "football"
root["replaces"] = [[list(p) for p in ring] for ring in DATA["buildings"].values()]
# Open ground where the village's trees give way: the pitch's plot, the fenced ground with the walk and the yard up
# to the buildings' backs, and the clubhouse with a margin.
CLEAR = [[[round(c, 2) for c in P(u, w)] for u, w in rect(FENCE["end"] - 2.0, FENCE["near_end"] + 2.0, FENCE["far"] - 2.0, YARD["w1"] + 1.0)],
         [[round(c, 2) for c in CLUB.P(s, d)] for s, d in rect(-2.0, CL_L + 2.0, -2.0, CL_D + 2.0)],
         [list(p) for p in DATA["plot"]]]
root["clear"] = CLEAR
root["blocks"] = blocks
root["blocksOnGround"] = True
root["lamps"] = lamps
tris = 0
objs = []
for name, bm in BM.items():
    if not bm.faces:
        continue
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
    bm.normal_update()
    if name in METRE_UVS:
        metre_uvs(bm, UVSCALE.get(name, 1.0))
    loc = Vector((0, 0, 0))
    if name in NETS:                      # the net's own origin: its goal mouth's middle on the ground
        loc = V(*G(*NETS[name], 0.0))
        bmesh.ops.translate(bm, vec=-loc, verts=bm.verts[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    me.materials.append(M[MESHES[name]])
    me.set_sharp_from_angle(angle=math.radians(61))      # round bars and ribbed sheet smooth, boxes sharp: fewer vertices
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = root
    me.calc_loop_triangles()
    tris += len(me.loop_triangles)
    print(f"{name}: {len(me.loop_triangles)} triangles, {len(me.vertices)} vertices")
    objs.append(ob)
print(f"football: {tris} triangles in {len(objs)} meshes, {len(blocks)} blocks, {len(lamps)} floodlights; origin {ORIGIN}")
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
    # The page's cut-out panels, seen through here.
    for name, alpha in (("fb_fence", 0.35), ("fb_ballnet", 0.22), ("fb_net", 0.4)):
        p = M[name].node_tree.nodes["Principled BSDF"]
        p.inputs["Alpha"].default_value = alpha
        try:
            M[name].surface_render_method = "BLENDED"
        except AttributeError:
            M[name].blend_method = "BLEND"

    def preview_mat(name, hexcol, rough=0.95):
        return principled(name, srgb(hexcol), rough, cull=False)

    def preview_poly(ring_plan, z, mat):
        me = bpy.data.meshes.new("pv")
        bm = bmesh.new()
        bm.faces.new([bm.verts.new(V(x, zz, z)) for x, zz in ring_plan])
        bm.to_mesh(me)
        ob = bpy.data.objects.new("pv", me)
        me.materials.append(mat)
        scene.collection.objects.link(ob)
    # The ground: grass, the pitch's lines, the car park and the walks the page drapes.
    grass = preview_mat("PvGrass", "#4f7a3a")
    preview_poly([P(u, w) for u, w in rect(-160, 180, -140, 140)], -0.004, grass)
    pitch_g = preview_mat("PvPitch", "#4a8034")
    for k in range(10):
        a = -HALF_L - 2 + k * (DATA["length"] + 4) / 10
        b = a + (DATA["length"] + 4) / 10
        preview_poly([P(u, w) for u, w in rect(a, b, -HALF_W - 2, HALF_W + 2)], 0.0, pitch_g if k % 2 else preview_mat(f"PvPitch{k}", "#558a3c"))
    line = preview_mat("PvLine", "#f2f2ee")

    def stripe(a, b, wd=0.12):
        ln = math.dist(a, b)
        t = ((b[0] - a[0]) / ln, (b[1] - a[1]) / ln)
        nn = (-t[1] * wd / 2, t[0] * wd / 2)
        preview_poly([P(a[0] + nn[0], a[1] + nn[1]), P(b[0] + nn[0], b[1] + nn[1]), P(b[0] - nn[0], b[1] - nn[1]), P(a[0] - nn[0], a[1] - nn[1])],
                     0.004, line)
    L2, W2 = HALF_L, HALF_W
    for a, b in (((-L2, -W2), (L2, -W2)), ((-L2, W2), (L2, W2)), ((-L2, -W2), (-L2, W2)), ((L2, -W2), (L2, W2)), ((0, -W2), (0, W2))):
        stripe(a, b)
    for s in (-1, 1):
        for d, half_w in ((16.5, 20.16), (5.5, 9.16)):
            stripe((s * L2, -half_w), (s * (L2 - d), -half_w))
            stripe((s * L2, half_w), (s * (L2 - d), half_w))
            stripe((s * (L2 - d), -half_w), (s * (L2 - d), half_w))
    circ = [(9.15 * math.cos(2 * math.pi * k / 40), 9.15 * math.sin(2 * math.pi * k / 40)) for k in range(41)]
    for a, b in zip(circ, circ[1:]):
        stripe(a, b)
    asph = preview_mat("PvAsphalt", "#3c3d3f")
    for ring in DATA["surfaces"]["asphalt"]:
        preview_poly(ring, 0.008, asph)
    conc = preview_mat("PvConcrete", "#a9a69f")
    for ring in DATA["surfaces"]["concrete"]:
        preview_poly(ring, 0.006, conc)
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.62, 0.68, 0.78, 1)
    bg.inputs["Strength"].default_value = 1.1
    scene.world = world
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(50), 0, math.radians(200)))
    sun = bpy.context.active_object
    sun.data.energy = 2.2
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    cam.data.sensor_fit = "HORIZONTAL"
    cam.data.sensor_width = 36.0
    cam.data.clip_end = 1000
    os.makedirs(PREVIEW, exist_ok=True)

    def shoot(label, eye, target, f_px=700, w=900, h=600):
        """A render from eye (u, w, y) towards target (u, w, y), with the focal length in pixels."""
        scene.render.resolution_x, scene.render.resolution_y = w, h
        e, t = V(*G(*eye)), V(*G(*target))
        cam.location = e
        cam.rotation_euler = (t - e).to_track_quat("-Z", "Y").to_euler()
        cam.data.lens = f_px / w * 36.0
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)

    # From straight above, the buildings' side (a check of where things stand).
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 120.0
    scene.render.resolution_x, scene.render.resolution_y = 1200, 300
    cam.location = V(*G(2.0, 33.0, 60.0))
    cam.rotation_euler = (0.0, 0.0, math.atan2(-UV_[1], UV_[0]))
    scene.render.filepath = os.path.join(PREVIEW, "plan.png")
    bpy.ops.render.render(write_still=True)
    cam.data.type = "PERSP"
    shoot("aerial", (-75.0, -95.0, 55.0), (0.0, 8.0, 0.0), f_px=620)
    shoot("gate", (66.0, 33.0, 1.7), (25.0, 29.0, 2.2), f_px=560)
    shoot("stand", (-2.5, rows[1]["w"] + 0.2, rows[1]["y"] + 1.1), (-16.0, 26.0, 0.2), f_px=430)
    shoot("goal", (-53.6, -9.5, 1.7), (-50.0, 0.0, 1.1), f_px=520)
    shoot("goalmouth", (-36.0, -9.0, 1.7), (-52.0, 0.0, 2.0), f_px=560)
    shoot("terrace", (22.0, 21.0, 1.8), (26.0, 34.0, 2.0), f_px=560)
    shoot("containers", (-30.0, 18.0, 3.0), (-24.0, 34.0, 1.6), f_px=520)
    shoot("back", (-26.0, 50.0, 4.0), (0.0, 36.0, 1.5), f_px=520)
    # Night: a dark sky, the floodlights' faces lit and real lights from them.
    bg.inputs["Color"].default_value = (0.01, 0.015, 0.03, 1)
    bg.inputs["Strength"].default_value = 0.4
    sun.data.energy = 0.0
    pl = M["fb_lamp"].node_tree.nodes["Principled BSDF"]
    pl.inputs["Emission Color"].default_value = (1.0, 0.97, 0.92, 1)
    pl.inputs["Emission Strength"].default_value = 40.0
    for x, y, z, dx, dy, dz in lamps:
        bpy.ops.object.light_add(type="SPOT", location=(x, -z, y))
        sp = bpy.context.active_object
        sp.data.energy = 60000
        sp.data.spot_size = math.radians(80)
        sp.data.spot_blend = 0.6
        sp.rotation_euler = Vector((dx, -dz, dy)).to_track_quat("-Z", "Y").to_euler()
    shoot("night", (70.0, -75.0, 28.0), (0.0, 5.0, 0.0), f_px=620)
