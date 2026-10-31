"""Build the primary school of Smetlede and the fittings of the church square in Blender, for the walkthrough.

Run (Blender 5, no window), from the project root:
  blender -b -P tools/school.py -- <out.glb>

Our own model of the primary school east of the church and of what stands on the square, from the second
survey of the village centre (31 Oct 2026; data/smetlede.json, DECISIONS.md). Used for measuring only,
nothing of them is shipped:
- the plans: the GRB outlines of the school's five buildings (Digitaal Vlaanderen, WFS GRB:GBG), the same
  ones tools/neighbours.py tags `landmark: "school"`;
- the heights: the DHM Vlaanderen II laser scan (1 m, 2013-2015), profiles across each building: the front
  wing's eaves at 5.0 m and ridge at 7.1 m with a lean-to from 3.3 down to 2.8 m behind it, the long
  block's flat roof at 4.1 m inside a rim at 4.5 m with solar panels up to 4.3 m, the pavilion's eaves at
  2.4 m and ridge at 3.85 m, the sheds' flat roofs at 2.4 and 2.9 m, and a 3.4 m object in the middle of
  the playground where the photo shows the timber play things (the play tower here);
- the 25 cm orthophoto: the playground's pale concrete, the red and white chequered patch at its south
  end, the rows of solar panels on the long block, the dark roofs;
- Street View (August 2026), from the street and the square only: the front wing's walls in cream painted
  blocks on an anthracite plinth, its windows (dark grey frames, a mullion and a low transom), the gable
  on the square in light grey horizontal boards with the school's board on it, the gate between a brick
  pier and the long block, the long block's red-brown brick under a broad pale roof edge with a chimney,
  the fenced school garden in front of it with two arched polycarbonate bike shelters, the bench on orange
  legs, the three yellow hoop barriers and the orange egg-shaped seat on the pavement; on the square the
  low stone planter wall along the church's nave, the parking bays in front of it and their blue signs.
What the photos don't show is made up in the same style: the playground side of the buildings (windows,
doors, clerestory windows above the corridor), the play tower's details, the balance posts, the goal, the
hopscotch, the fence along the playground's south side. The school's board carries coloured squares and
grey lines, no text; no people.

Frame: the GLB is in the game's own axes (x, y up, z), its origin on the ground at ORIGIN in the playground
(y = 0 is the relief there, tools/terrain.py); everything else stands on the relief where it is, with the
same formula the browser uses (web/shared/terrain.json). The root node's extras carry the origin and the
landmark name, so the game needs no numbers of its own.

Output: one GLB, one mesh per material:
- school_render, school_brick, school_siding, school_dark, school_stone, school_yard, school_roof: UVs in
  metres; their glTF extras name a shared game texture and its tint, so they add no graphics memory;
- school_glass: dark glass; school_clear: the bike shelters' and the corridor roof's translucent sheets;
- school_fittings: frames, gutters, doors, fences, play equipment, solar panels, paint on the ground,
  coloured per vertex.
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
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SURVEY = json.load(open(os.path.join(ROOT, "data", "smetlede.json"), encoding="utf-8"))
ORIGIN = (470.0, -815.0)      # the middle of the playground (model x, z)


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


# ---------------------------------------------------------------- materials
bpy.ops.wm.read_factory_settings(use_empty=True)
# name: (shared game texture, tint, normal scale, mean colour of the result, metres per UV unit)
SHARED = {
    "school_render": ("nb_brick", "#ece4cf", 0.45, "#d8cfba", 2.4),   # painted blocks: the brick texture at 2.4 times its size
    "school_brick": ("nb_brick", "#8f5646", 1.0, "#7a4a3c", 1.0),     # the long block's red-brown brick
    "school_siding": ("plaster", "#c6cac8", 0.3, "#bfc3c1", 1.0),     # light grey boards (their edges are geometry)
    "school_dark": ("concrete", "#686b6e", 0.5, "#4f5153", 1.0),       # anthracite plinths
    "school_stone": ("nb_brick", "#b7b4ad", 0.9, "#a9a69f", 2.0),      # the square's planter wall: grey stone blocks
    "school_yard": ("terrace", "#e3e1db", 0.6, "#bfbbb4", 3.5),        # the playground's concrete: the terrace's slabs, 3.5 times bigger
    "school_roof": ("roof_tiles", "#5f6368", 1.0, "#505458", 1.0),     # dark grey roofs
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
M["school_glass"] = principled("school_glass", srgb("#1e262b"), 0.12)
M["school_fittings"] = principled("school_fittings", (1, 1, 1), 0.6)
nt = M["school_fittings"].node_tree
attr = nt.nodes.new("ShaderNodeVertexColor")
attr.layer_name = "Color"
nt.links.new(attr.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
M["school_clear"] = principled("school_clear", srgb("#e6ece9"), 0.25)
M["school_clear"].node_tree.nodes["Principled BSDF"].inputs["Alpha"].default_value = 0.42
M["school_clear"].surface_render_method = "BLENDED"
M["school_clear"].use_backface_culling = False

BM = {}
for name in M:
    BM[name] = bmesh.new()
BM["school_fittings"].loops.layers.float_color.new("Color")  # only the fittings are coloured per vertex


def paint_face(bm, f, hexcol):
    lay = bm.loops.layers.float_color.get("Color")
    if lay is not None:
        c = colour(hexcol)
        for lp in f.loops:
            lp[lay] = c


def colour(h):
    return (*srgb(h), 1.0) if h else (1.0, 1.0, 1.0, 1.0)


# ---------------------------------------------------------------- geometry helpers (game coordinates)
def face(mat, pts, out=None, paint=None):
    """A planar face through game points (x, z, y); turned to face `out` (a game direction (dx, dz, dy))."""
    bm = BM[mat]
    vs = [V(*p) for p in pts]
    if out is not None:
        n = (vs[1] - vs[0]).cross(vs[2] - vs[0])
        if len(vs) > 3 and n.length < 1e-9:
            n = (vs[2] - vs[0]).cross(vs[3] - vs[0])
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


def prism(mat, ring, y0, y1, paint=None):
    """A slab of a plan outline [(x, z)] from height y0 to y1 (any outline, not only convex ones)."""
    cx = sum(p[0] for p in ring) / len(ring)
    cz = sum(p[1] for p in ring) / len(ring)
    face(mat, [(x, z, y1) for x, z in ring], (0, 0, 1), paint)
    face(mat, [(x, z, y0) for x, z in ring], (0, 0, -1), paint)
    for a, b in zip(ring, ring[1:] + ring[:1]):
        mid = ((a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cz)
        n = (b[1] - a[1], -(b[0] - a[0]))
        out = n if n[0] * mid[0] + n[1] * mid[1] > 0 else (-n[0], -n[1])
        face(mat, [(a[0], a[1], y0), (b[0], b[1], y0), (b[0], b[1], y1), (a[0], a[1], y1)], (out[0], out[1], 0), paint)


def beam(mat, a, b, w, h, paint=None, up=(0, 0, 1)):
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
    solid(mat, pts, paint)


def tube(mat, a, b, r, paint=None, seg=8):
    a, b = Vector(a), Vector(b)
    d = (b - a).normalized()
    u = d.cross(Vector((1, 0, 0)) if abs(d.x) < 0.9 else Vector((0, 1, 0))).normalized()
    w = d.cross(u)
    pts = []
    for k in range(seg):
        t = 2 * math.pi * k / seg
        off = u * math.cos(t) * r + w * math.sin(t) * r
        pts += [tuple(a + off), tuple(b + off)]
    solid(mat, pts, paint)


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


class Frame:
    """A wall's frame on the plan: origin a, direction t along the wall, outward normal o; base is the
    floor (y above the plot's ground). p(s, y, d): s along, y up from the floor, d out of the wall."""

    def __init__(self, a, t, o, base):
        self.a, self.t, self.o, self.base = a, t, o, base

    def p(self, s, y, d=0.0):
        return (self.a[0] + self.t[0] * s + self.o[0] * d, self.a[1] + self.t[1] * s + self.o[1] * d, self.base + y)

    def out(self, k=1.0):
        return (self.o[0] * k, self.o[1] * k, 0.0)

    def along(self, k=1.0):
        return (self.t[0] * k, self.t[1] * k, 0.0)

    def box(self, mat, s0, s1, y0, y1, d0, d1, paint=None):
        solid(mat, [self.p(s, y, d) for s in (s0, s1) for y in (y0, y1) for d in (d0, d1)], paint)

    def flat(self, mat, s0, s1, y0, y1, d, paint=None):
        """A face parallel to the wall, d out from it (frames, joints: a box's other sides hardly show)."""
        face(mat, [self.p(s0, y0, d), self.p(s1, y0, d), self.p(s1, y1, d), self.p(s0, y1, d)], self.out(), paint)


class Hole:
    def __init__(self, s0, s1, y0, y1, kind="window", depth=0.16, mullion=True, transom=0.42, frame="#3b3f43", panel=None, sill=True):
        self.s0, self.s1, self.y0, self.y1 = s0, s1, y0, y1
        self.kind, self.depth, self.mullion, self.transom, self.frame, self.panel, self.sill = kind, depth, mullion, transom, frame, panel, sill


def win(sc, w, y0, y1, **kw):
    return Hole(sc - w / 2, sc + w / 2, y0, y1, **kw)


def facade(f, length, top, holes, mat, bottom=-1.2, plinth=None, sill_mat="school_dark"):
    """A wall from s = 0 to length: its surface from `bottom` up to the line `top` ([(s, y)], straight
    between), without the holes, with their reveals, glass, frames and sills; below plinth[0] in
    plinth[1]'s material."""
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
            if plinth and ya < plinth[0] and (yb is None or yb > plinth[0]):
                pieces = [(ya, plinth[0]), (plinth[0], yb)]
            for y0, y1 in pieces:
                m = plinth[1] if plinth and (y1 is not None and y1 <= plinth[0] + 1e-6) else mat
                ta = ytop(xa) if y1 is None else y1
                tb = ytop(xb) if y1 is None else y1
                if max(ta, tb) - y0 < 1e-4:
                    continue
                face(m, [f.p(xa, y0), f.p(xb, y0), f.p(xb, tb), f.p(xa, ta)], f.out())
    for h in holes:
        hole(f, h, mat, sill_mat)


def hole(f, h, mat, sill_mat):
    d = -h.depth
    # Reveals, facing into the opening.
    face(mat, [f.p(h.s0, h.y0), f.p(h.s0, h.y1), f.p(h.s0, h.y1, d), f.p(h.s0, h.y0, d)], f.along(1))
    face(mat, [f.p(h.s1, h.y0), f.p(h.s1, h.y1), f.p(h.s1, h.y1, d), f.p(h.s1, h.y0, d)], f.along(-1))
    face(mat, [f.p(h.s0, h.y1), f.p(h.s1, h.y1), f.p(h.s1, h.y1, d), f.p(h.s0, h.y1, d)], (0, 0, -1))
    if h.kind != "door":
        face(mat, [f.p(h.s0, h.y0), f.p(h.s1, h.y0), f.p(h.s1, h.y0, d), f.p(h.s0, h.y0, d)], (0, 0, 1))
    pane = [f.p(h.s0, h.y0, d), f.p(h.s1, h.y0, d), f.p(h.s1, h.y1, d), f.p(h.s0, h.y1, d)]
    if h.panel:  # a solid door leaf
        face("school_fittings", pane, f.out(), h.panel)
    else:
        face("school_glass", pane, f.out())
    fw, fd = 0.065, 0.045
    c = h.frame
    f.flat("school_fittings", h.s0, h.s0 + fw, h.y0, h.y1, d + fd, c)
    f.flat("school_fittings", h.s1 - fw, h.s1, h.y0, h.y1, d + fd, c)
    f.flat("school_fittings", h.s0 + fw, h.s1 - fw, h.y1 - fw, h.y1, d + fd, c)
    f.flat("school_fittings", h.s0 + fw, h.s1 - fw, h.y0, h.y0 + fw, d + fd, c)
    if h.mullion and h.s1 - h.s0 > 0.9:
        m = (h.s0 + h.s1) / 2
        f.flat("school_fittings", m - 0.035, m + 0.035, h.y0 + fw, h.y1 - fw, d + fd + 0.002, c)
    if h.transom and h.y1 - h.y0 > 1.2:
        t = h.y0 + h.transom
        f.flat("school_fittings", h.s0 + fw, h.s1 - fw, t - 0.03, t + 0.03, d + fd + 0.004, c)
    if h.kind == "door" and not h.panel and h.s1 - h.s0 < 1.3:
        f.flat("school_fittings", h.s0 + fw, h.s1 - fw, 0.95, 1.05, d + fd + 0.006, c)
    if h.sill and h.kind != "door":
        f.box(sill_mat, h.s0 - 0.04, h.s1 + 0.04, h.y0 - 0.06, h.y0, d, 0.05)


def gable_roof(a, t, n, length, depth, eave, ridge, base, over=0.35, verge=(0.0, 0.3), th=0.14, mat="school_roof"):
    """A gable roof on a rectangle (corner a, t along the ridge, n across): eaves at `eave` above `base`
    on both long walls, the ridge in the middle; `over` out past the eaves, `verge` past each end."""
    slope = (ridge - eave) / (depth / 2)
    s0, s1 = -verge[0], length + verge[1]
    P = lambda s, k, y: (a[0] + t[0] * s + n[0] * k, a[1] + t[1] * s + n[1] * k, base + y)
    for k0, k1 in ((-over, depth / 2), (depth + over, depth / 2)):
        y0 = eave - over * slope
        pts = []
        for s in (s0, s1):
            for k, y in ((k0, y0), (k1, ridge)):
                pts += [P(s, k, y + th), P(s, k, y)]
        solid(mat, pts)
    beam("school_fittings", P(s0, depth / 2, ridge + th + 0.02), P(s1, depth / 2, ridge + th + 0.02), 0.26, 0.08, "#3c3f43")
    return slope


def drape(mat, ring, lift, paint=None, extra_planes=(), colour_of=None):
    """A flat shape on the relief (game outline [(x, z)]): cut along the relief's grid and diagonals so
    every piece lies in one of its triangles, each corner `lift` above the ground (plus any extra cuts,
    (point, normal) in game plan coordinates); colour_of(x, z) can colour each piece."""
    tmp = bmesh.new()
    vs = [tmp.verts.new(V(x, z, 0.0)) for x, z in ring]
    tmp.faces.new(vs)
    xs, zs = [p[0] for p in ring], [p[1] for p in ring]
    step, x0, z0 = TD["step"], TD["x0"], TD["z0"]
    planes = []
    for i in range(math.floor((min(xs) - x0) / step), math.ceil((max(xs) - x0) / step) + 1):
        planes.append(((x0 + i * step, 0.0), (1.0, 0.0)))
    for j in range(math.floor((min(zs) - z0) / step), math.ceil((max(zs) - z0) / step) + 1):
        planes.append(((0.0, z0 + j * step), (0.0, 1.0)))
    c0 = min(xs) - max(zs) - step
    for k in range(int((max(xs) - min(zs) - c0) / step) + 2):
        c = x0 - z0 + step * (math.floor((c0 - (x0 - z0)) / step) + k)  # the lines x - z = c
        planes.append(((c, 0.0), (1 / math.sqrt(2), -1 / math.sqrt(2))))
    planes += list(extra_planes)
    for (px, pz), (nx, nz) in planes:
        co = V(px, pz, Y0)
        no = Vector((nx, -nz, 0.0))
        geom = tmp.verts[:] + tmp.edges[:] + tmp.faces[:]
        bmesh.ops.bisect_plane(tmp, geom=geom, plane_co=co, plane_no=no, dist=1e-5)
    bm = BM[mat]
    for f in tmp.faces:
        pts = []
        for v in f.verts:
            gx, gz = v.co.x + ORIGIN[0], -v.co.y + ORIGIN[1]
            pts.append(V(gx, gz, terrain(gx, gz) + lift))
        if len(pts) < 3:
            continue
        n = (pts[1] - pts[0]).cross(pts[2] - pts[0])
        if n.z < 0:
            pts = pts[::-1]
        c = f.calc_center_median()
        paint_face(bm, bm.faces.new([bm.verts.new(p) for p in pts]), colour_of(c.x + ORIGIN[0], -c.y + ORIGIN[1]) if colour_of else paint)
    tmp.free()


def ground_mean(points):
    return sum(terrain(x, z) for x, z in points) / len(points)


def unit(a, b):
    d = (b[0] - a[0], b[1] - a[1])
    n = math.hypot(*d)
    return (d[0] / n, d[1] / n), n


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


# ---------------------------------------------------------------- the front wing (GRB 1852114)
# A rectangle 23.89 x 13.1 m: the classrooms under a gable along Smetlededorp (8.7 m deep) and a corridor
# under a lean-to on the playground side. A: the corner against the red-brick house to the east.
A1 = (446.99, -793.26)
U1, L1 = unit(A1, (470.45, -788.73))
N1 = (U1[1], -U1[0])                        # into the playground
D1, DL = 8.7, 13.1
E1, R1, LH, LL = 4.95, 7.1, 3.3, 2.8        # eaves, ridge; the lean-to's high and low side
P1 = lambda u, n: (A1[0] + U1[0] * u + N1[0] * n, A1[1] + U1[1] * u + N1[1] * n)
base1 = ground_mean([P1(u, DL) for u in np.linspace(0.5, L1 - 0.5, 8)]) + 0.04
street = Frame(P1(0, 0), U1, (-N1[0], -N1[1]), base1)
W = dict(mullion=True, transom=0.42)
holes = [win(u, 1.62, 1.15, 3.05, **W) for u in (2.0, 9.9, 13.2, 16.1, 18.9, 21.65)]
holes += [win(u, 0.5, 1.0, 3.3, mullion=False, transom=0) for u in (5.05, 5.75)]
facade(street, L1, [(0, E1), (L1, E1)], holes, "school_render", plinth=(0.9, "school_dark"))
street.box("school_fittings", 5.1, 5.7, 0.35, 0.8, 0.0, 0.03, "#c9c6bd")          # a plaque under the narrow windows
street.box("school_fittings", L1 - 1.1, L1 - 0.72, 0.95, 1.4, 0.0, 0.2, "#c3312b")  # the red letter box
# The gable on the square: light grey boards over a low plinth, the school's board and the defibrillator box.
gab = Frame(P1(L1, 0), N1, U1, base1)
slope1 = (R1 - E1) / (D1 / 2)
face("school_dark", [gab.p(0, -1.2), gab.p(D1, -1.2), gab.p(D1, 0.25), gab.p(0, 0.25)], gab.out())
y, board = 0.25, 0.23
while y < R1:
    ya, yb = y, y + board
    s_in = lambda yy: 0.0 if yy <= E1 else (yy - E1) / slope1
    a0, a1 = s_in(ya), s_in(yb)
    if a1 >= D1 / 2:
        break
    # Each board leans out at its foot, so every course throws a thin shadow line.
    face("school_siding", [gab.p(a0, ya, 0.04), gab.p(D1 - a0, ya, 0.04), gab.p(D1 - a1, yb, 0.0), gab.p(a1, yb, 0.0)], gab.out(1.0))
    face("school_siding", [gab.p(a0, ya, 0.0), gab.p(D1 - a0, ya, 0.0), gab.p(D1 - a0, ya, 0.04), gab.p(a0, ya, 0.04)], (0, 0, -1))
    y = yb
top_y = y
face("school_siding", [gab.p((top_y - E1) / slope1, top_y), gab.p(D1 - (top_y - E1) / slope1, top_y), gab.p(D1 / 2, R1)], gab.out())
gab.box("school_fittings", 2.4, 4.8, 1.55, 2.95, 0.03, 0.06, "#f3f2ee")             # the school's board
gab.box("school_fittings", 2.37, 4.83, 1.52, 2.98, 0.02, 0.04, "#2f3a4a")
for k, c in enumerate(("#3f6fb0", "#e0a020", "#c03a3a", "#3a9a5a", "#7a4ab0")):
    s = 2.75 + k * 0.38
    gab.box("school_fittings", s, s + 0.28, 2.25 + 0.06 * (k % 2), 2.53 + 0.06 * (k % 2), 0.06, 0.075, c)
for yy, w in ((1.98, 1.7), (1.78, 1.2)):
    gab.box("school_fittings", 3.6 - w / 2, 3.6 + w / 2, yy, yy + 0.07, 0.06, 0.07, "#59606a")
gab.box("school_fittings", 6.25, 6.6, 1.2, 1.6, 0.03, 0.15, "#2f8f4f")              # defibrillator box
gab.box("school_fittings", 7.15, 7.55, 0.9, 1.4, 0.03, 0.2, "#8d9091")              # meter cupboard
# The east end against the red-brick house (only the corridor's end shows).
east = Frame(P1(0, DL), (-N1[0], -N1[1]), (-U1[0], -U1[1]), base1)
facade(east, DL - D1, [(0, LL), (DL - D1, LH)], [], "school_render", plinth=(0.5, "school_dark"))
face("school_render", [P1(0, 0) + (base1 - 1.2,), P1(0, D1) + (base1 - 1.2,), P1(0, D1) + (base1 + E1,), P1(0, D1 / 2) + (base1 + R1 - 0.1,), P1(0, 0) + (base1 + E1,)],
     (-U1[0], -U1[1], 0))
# The corridor along the playground: windows above a low plinth, two glazed doors, its end wall by the gate.
yard_side = Frame(P1(0, DL), U1, N1, base1)
hs = []
for u in np.arange(1.45, L1 - 1.0, 2.45):
    if abs(u - 7.3) < 1.2 or abs(u - 16.85) < 1.2:
        continue
    hs.append(win(u, 1.95, 0.95, 2.35, mullion=True, transom=0))
hs += [win(u, 1.15, 0.0, 2.3, kind="door", mullion=False, transom=1.9, depth=0.12) for u in (7.3, 16.85)]
facade(yard_side, L1, [(0, LL), (L1, LL)], hs, "school_render", plinth=(0.5, "school_dark"))
gate_end = Frame(P1(L1, D1), N1, U1, base1)
facade(gate_end, DL - D1, [(0, LH), (DL - D1, LL)], [win(2.4, 1.05, 0.0, 2.25, kind="door", mullion=False, transom=1.85, depth=0.12)],
       "school_render", plinth=(0.5, "school_dark"))
# The classrooms' back wall above the corridor's roof: clerestory windows.
back = Frame(P1(0, D1), U1, N1, base1)
facade(back, L1, [(0, E1), (L1, E1)], [win(u, 1.35, 3.6, 4.45, mullion=True, transom=0, depth=0.12) for u in (2.4, 6.4, 10.4, 14.4, 18.4, 22.0)],
       "school_render", bottom=LH - 0.25)
gable_roof(A1, U1, N1, L1, D1, E1, R1, base1, over=0.35, verge=(0.0, 0.32))
lean_slope = (LH - LL) / (DL - D1)
pts = []
for u in (0.0, L1 + 0.15):
    for n, yy in ((D1 - 0.05, LH + 0.05), (DL + 0.3, LL - 0.3 * lean_slope)):
        pts += [P1(u, n) + (base1 + yy,), P1(u, n) + (base1 + yy + 0.1,)]
solid("school_fittings", pts, "#cbc5b6")                                               # the corridor's light roof
for n_, yy, out in ((-0.42, E1 - 0.35 * slope1 - 0.05, -1), (DL + 0.38, LL - 0.3 * lean_slope - 0.03, 1)):
    beam("school_fittings", P1(0, n_) + (base1 + yy,), P1(L1 + (0.3 if out < 0 else 0.15), n_) + (base1 + yy,), 0.13, 0.13, "#45484c")
for u in (12.15, L1 - 0.3):
    tube("school_fittings", P1(u, -0.35) + (base1 - 0.1,), P1(u, -0.35) + (base1 + E1 - 0.3,), 0.045, "#45484c")
for u in (0.6, L1 - 0.4):
    tube("school_fittings", P1(u, DL + 0.32) + (base1 - 0.1,), P1(u, DL + 0.32) + (base1 + LL - 0.35,), 0.04, "#45484c")


# ---------------------------------------------------------------- the long block (GRB 9796774)
# Red-brown brick under a flat roof with a broad pale rim; the hall's end on the street with its
# chimney, classrooms along the playground; solar panels in rows on the roof.
C2 = (475.4, -796.68)
V2, L2 = unit(C2, (481.64, -840.06))
W2 = (-V2[1], V2[0])                        # across, towards the car park
D2 = 8.68
P2 = lambda v, w: (C2[0] + V2[0] * v + W2[0] * w, C2[1] + V2[1] * v + W2[1] * w)
base2 = ground_mean([P2(v, -0.3) for v in np.linspace(3, L2 - 1, 8)]) + 0.04
WALL2, RIM0, RIM1, ROOF2 = 4.0, 3.95, 4.5, 4.08
north = Frame(P2(0, D2), (-W2[0], -W2[1]), (-V2[0], -V2[1]), base2)
facade(north, D2, [(0, WALL2), (D2, WALL2)], [win(s, 1.25, 1.1, 2.5, transom=0) for s in (2.2, 6.6)], "school_brick", plinth=(0.3, "school_dark"))
west = Frame(P2(0, 0), V2, (-W2[0], -W2[1]), base2)
hs = []
for v in (3.6, 7.0, 10.4, 16.2, 19.6, 23.0, 28.8, 32.2, 35.6, 41.2):
    hs.append(win(v, 2.4, 0.9, 2.6, transom=0.45))
hs += [win(v, 1.05, 0.0, 2.25, kind="door", mullion=False, transom=1.85, depth=0.12, frame="#2e3236") for v in (13.3, 25.9, 38.4)]
facade(west, L2, [(0, WALL2), (L2, WALL2)], hs, "school_brick", plinth=(0.3, "school_dark"))
east2 = Frame(P2(L2, D2), (-V2[0], -V2[1]), W2, base2)
hs = [win(s, 1.6, 1.3, 2.5, transom=0) for s in (3.0, 7.5, 12.0, 20.5, 25.0, 29.5, 34.0, 38.5)]
hs.append(win(16.4, 1.0, 0.0, 2.2, kind="door", mullion=False, transom=0, panel="#5a5f63", depth=0.1))
facade(east2, L2, [(0, WALL2), (L2, WALL2)], hs, "school_brick", plinth=(0.3, "school_dark"))
south = Frame(P2(L2, 0), W2, V2, base2)
facade(south, D2, [(0, WALL2), (D2, WALL2)], [win(4.3, 1.7, 0.0, 2.25, kind="door", mullion=True, transom=0, panel="#5a5f63", depth=0.1),
                                              win(7.2, 0.9, 1.4, 2.4, mullion=False, transom=0)], "school_brick", plinth=(0.3, "school_dark"))
# The rim: a pale band all round, 0.35 m out past the walls, its soffit underneath; the roof inside it.
O = 0.35
for (v0, w0), (v1, w1) in (((-O, -O), (L2 + O, -O)), ((L2 + O, -O), (L2 + O, D2 + O)), ((L2 + O, D2 + O), (-O, D2 + O)), ((-O, D2 + O), (-O, -O))):
    (dv, dw), n = (v1 - v0, w1 - w0), math.hypot(v1 - v0, w1 - w0)
    inv, inw = -dw / n * 0.6, dv / n * 0.6               # inwards, 0.6 m
    a, b = P2(v0, w0), P2(v1, w1)
    ai, bi = P2(v0 + inv + dv / n * 0.6, w0 + inw + dw / n * 0.6), P2(v1 + inv - dv / n * 0.6, w1 + inw - dw / n * 0.6)
    solid("school_fittings", [q + (base2 + y,) for q in (a, b, ai, bi) for y in (RIM0, RIM1)], "#e4e0d6")
solid("school_fittings", [P2(v, w) + (base2 + y,) for v in (0.2, L2 - 0.2) for w in (0.2, D2 - 0.2) for y in (WALL2 - 0.1, ROOF2)], "#4a4b4d")
north.box("school_brick", 3.0, 3.65, WALL2 - 0.2, 5.75, -1.5, -0.85)                   # the chimney, near the street end
north.box("school_dark", 2.92, 3.73, 5.75, 5.85, -1.58, -0.77)
# Solar panels: 28 rows of four, each panel 1.7 m across the roof and 1 m up its 12 degree slope.
tilt = math.radians(12)
for r in range(28):
    v0 = 2.4 + r * 1.45
    for c in range(4):
        w0 = 0.65 + c * 1.83
        lo, hi = ROOF2 + 0.08, ROOF2 + 0.08 + math.sin(tilt) * 1.0
        q = [P2(v0, w0), P2(v0, w0 + 1.7), P2(v0 + math.cos(tilt), w0), P2(v0 + math.cos(tilt), w0 + 1.7)]
        face("school_fittings", [q[0] + (base2 + hi,), q[1] + (base2 + hi,), q[3] + (base2 + lo,), q[2] + (base2 + lo,)], (V2[0], V2[1], 4), "#273041")
        face("school_fittings", [q[2] + (base2 + lo,), q[3] + (base2 + lo,), q[3] + (base2 + lo - 0.06,), q[2] + (base2 + lo - 0.06,)], (V2[0], V2[1], 0), "#8a8f94")
        face("school_fittings", [q[0] + (base2 + hi,), q[1] + (base2 + hi,), q[1] + (base2 + ROOF2,), q[0] + (base2 + ROOF2,)], (-V2[0], -V2[1], 0), "#5b5f63")
tube("school_fittings", P2(0.5, -0.38) + (base2 - 0.1,), P2(0.5, -0.38) + (base2 + RIM0,), 0.045, "#3d4044")
tube("school_fittings", P2(L2 - 0.5, -0.38) + (base2 - 0.1,), P2(L2 - 0.5, -0.38) + (base2 + RIM0,), 0.045, "#3d4044")


# ---------------------------------------------------------------- the pavilion (GRB 9758237)
# A low single storey under a shallow gable with wide eaves, a newer glazed entrance at its north end
# (the GRB has it, the laser scan of 2013-2015 doesn't).
F3 = (452.56, -810.06)
V3, _ = unit(F3, (455.68, -830.85))
W3 = (-V3[1], V3[0])                        # across, towards the playground
L3, D3, A3 = 21.02, 6.85, 3.4               # length, width, the entrance's depth
E3, R3 = 2.45, 3.85
P3 = lambda v, w: (F3[0] + V3[0] * v + W3[0] * w, F3[1] + V3[1] * v + W3[1] * w)
base3 = ground_mean([P3(v, D3 + 0.3) for v in np.linspace(1, L3 - 1, 6)]) + 0.04
yard3 = Frame(P3(A3, D3), V3, W3, base3)
hs = [win(v, 2.0, 0.8, 2.2, transom=0) for v in (2.1, 4.9, 7.7, 12.8, 15.6)]
hs.append(win(10.25, 1.1, 0.0, 2.2, kind="door", mullion=False, transom=0, depth=0.12))
facade(yard3, L3 - A3, [(0, E3), (L3 - A3, E3)], hs, "school_render", plinth=(0.35, "school_dark"))
garden3 = Frame(P3(L3, 0), (-V3[0], -V3[1]), (-W3[0], -W3[1]), base3)
facade(garden3, L3 - A3, [(0, E3), (L3 - A3, E3)], [win(s, 1.4, 1.0, 2.15, transom=0) for s in (2.5, 6.5, 10.5, 14.5)], "school_render",
       plinth=(0.35, "school_dark"))
end3 = Frame(P3(L3, D3), (-W3[0], -W3[1]), V3, base3)
facade(end3, D3, [(0, E3), (D3 / 2, R3 - 0.12), (D3, E3)], [win(2.0, 1.0, 0.0, 2.2, kind="door", mullion=False, transom=0, panel="#4f6a5c", depth=0.1),
                                                          win(4.8, 1.2, 1.0, 2.1, transom=0)], "school_render", plinth=(0.35, "school_dark"))
north3 = Frame(P3(A3, 0), W3, (-V3[0], -V3[1]), base3)
facade(north3, D3, [(0, E3), (D3 / 2, R3 - 0.12), (D3, E3)], [], "school_render", bottom=2.0)
gable_roof(P3(A3, 0), V3, W3, L3 - A3, D3, E3, R3, base3, over=0.6, verge=(0.35, 0.35), th=0.12)
# The entrance: glass in dark frames on a low plinth, a flat roof with a dark edge.
ent = [P3(0, 0), P3(0, D3), P3(A3, D3), P3(A3, 0)]
for (a, b) in ((ent[0], ent[1]), (ent[1], ent[2]), (ent[3], ent[0])):
    t, n = unit(a, b)
    o = (t[1], -t[0])
    cx, cz = sum(p[0] for p in ent) / 4, sum(p[1] for p in ent) / 4
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    if (mid[0] - cx) * o[0] + (mid[1] - cz) * o[1] < 0:
        o = (-o[0], -o[1])
    fr = Frame(a, t, o, base3)
    panels = max(1, int(n / 1.2))
    hs = [Hole(i * n / panels + 0.04, (i + 1) * n / panels - 0.04, 0.35, 2.45, mullion=False, transom=0, frame="#2b2e31", sill=False, depth=0.05)
          for i in range(panels)]
    if abs(n - D3) < 0.1 and o[0] * W3[0] + o[1] * W3[1] < 0.5:  # the doors face north, towards the street side
        hs[panels // 2] = Hole(hs[panels // 2].s0, hs[panels // 2].s1, 0.0, 2.45, kind="door", mullion=False, transom=2.15, frame="#2b2e31", depth=0.05)
    facade(fr, n, [(0, 2.55), (n, 2.55)], hs, "school_dark")
solid("school_fittings", [P3(v, w) + (base3 + y,) for v in (-0.15, A3) for w in (-0.15, D3 + 0.15) for y in (2.55, 2.75)], "#34373a")


# ---------------------------------------------------------------- the sheds (GRB 1852643, 5565555)
def shed(ring, top, batten, door_edge, door_w):
    """A timber shed on its GRB outline: boards of one colour with battens over the joints, a flat dark roof,
    double doors on one wall."""
    base = min(terrain(x, z) for x, z in ring) + 0.04
    cx, cz = sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)
    for k, (a, b) in enumerate(zip(ring, ring[1:] + ring[:1])):
        t, n = unit(a, b)
        o = (t[1], -t[0])
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        if (mid[0] - cx) * o[0] + (mid[1] - cz) * o[1] < 0:
            o = (-o[0], -o[1])
        fr = Frame(a, t, o, base)
        hs = [win(n / 2, door_w, 0.0, 2.05, kind="door", mullion=True, transom=0, panel="#4b4f52", frame="#2e3134", depth=0.06)] if k == door_edge else []
        facade(fr, n, [(0, top), (n, top)], hs, "school_fittings")
        for s in np.arange(0.16, n - 0.05, 0.32):  # battens over the boards' joints
            if not any(h.s0 - 0.08 < s < h.s1 + 0.08 for h in hs):
                fr.flat("school_fittings", s, s + 0.05, 0.0, top - 0.02, 0.02, batten)
    sc = 1.04
    roof = [(cx + (x - cx) * sc, cz + (z - cz) * sc) for x, z in ring]
    prism("school_fittings", roof, base + top, base + top + 0.22, "#2f3133")
    return base


S1 = [(462.98, -835.74), (462.27, -831.11), (467.12, -830.27), (468.83, -841.7), (464.02, -842.49), (463.84, -841.3)]
S2 = [(463.84, -841.3), (460.58, -841.7), (459.79, -836.2), (462.98, -835.74)]
n_before = len(BM["school_fittings"].faces)
shed(S1, 2.62, "#566a70", 2, 1.8)
shed(S2, 2.12, "#4f4035", 0, 1.0)
lay = BM["school_fittings"].loops.layers.float_color["Color"]
BM["school_fittings"].faces.ensure_lookup_table()
for i, f in enumerate(BM["school_fittings"].faces[n_before:]):
    c = f.loops[0][lay]
    if tuple(round(v, 3) for v in c) == (1.0, 1.0, 1.0, 1.0):   # the sheds' boards: blue-grey on the big one, brown on the small one
        cen = f.calc_center_median()
        gx, gz = cen.x + ORIGIN[0], -cen.y + ORIGIN[1]
        col = colour("#6f878e") if gx > 463.2 or gz > -835.5 else colour("#6a5545")
        for lp in f.loops:
            lp[lay] = col


# ---------------------------------------------------------------- the playground
YARD = [tuple(p) for p in SURVEY["yard"]["p"]]
drape("school_yard", YARD, 0.03)
# Frames on the long block's axes for what stands and is painted on the playground.
Q = lambda v, w: P2(v, w)                     # w < 0: out on the playground
# The red and white chequered patch at the south end (orthophoto): diamonds, 1.2 m from point to point.
chk = [Q(34.0, -11.0), Q(34.0, -2.0), Q(45.0, -2.0), Q(45.0, -11.0)]
CHK = 1.2
cuts = []
r2 = math.sqrt(2)
for k in range(int(22 / CHK), int(45 / CHK) + 2):     # the lines v + w = k CHK and v - w = k CHK cross the patch
    cuts.append((P2(k * CHK / 2, k * CHK / 2), ((V2[0] + W2[0]) / r2, (V2[1] + W2[1]) / r2)))
for k in range(int(35 / CHK), int(58 / CHK) + 2):
    cuts.append((P2(k * CHK / 2, -k * CHK / 2), ((V2[0] - W2[0]) / r2, (V2[1] - W2[1]) / r2)))


def checker(x, z):
    dx, dz = x - C2[0], z - C2[1]
    v, w = dx * V2[0] + dz * V2[1], dx * W2[0] + dz * W2[1]
    return "#c98a82" if (math.floor((v + w) / CHK) + math.floor((v - w) / CHK)) % 2 else "#dfdad2"


drape("school_fittings", chk, 0.045, extra_planes=cuts, colour_of=checker)
# A hopscotch in white paint along the long block (made up).
for v0, cells in ((14.0, 1), (14.62, 1), (15.24, 2), (15.86, 1), (16.48, 2), (17.1, 1)):
    for c in range(cells):
        w0 = -4.3 - 0.31 * cells + c * 0.62
        sq = [(v0, w0), (v0 + 0.62, w0), (v0 + 0.62, w0 + 0.62), (v0, w0 + 0.62)]
        for (va, wa), (vb, wb) in zip(sq, sq[1:] + sq[:1]):
            (dv, dw) = (vb - va, wb - wa)
            nv, nw = -dw / 0.62 * 0.03, dv / 0.62 * 0.03
            drape("school_fittings", [Q(va - nv, wa - nw), Q(vb - nv, wb - nw), Q(vb + nv, wb + nw), Q(va + nv, wa + nw)], 0.048, "#efede6")
# The play tower where the laser scan has its 3.4 m: four posts, a platform, a little roof, a slide and a ladder.
tv, tw = 28.4, -8.06                          # (471.5, -825.9): the scan's 3.4 m
pv = lambda dv, dw: Q(tv + dv, tw + dw)
gy = terrain(*pv(0, 0)) + 0.03
wood, wood_dark = "#8d6c4a", "#6b5038"
for dv in (-0.75, 0.75):
    for dw in (-0.75, 0.75):
        beam("school_fittings", pv(dv, dw) + (gy - 0.3,), pv(dv, dw) + (gy + 2.62,), 0.1, 0.1, wood_dark)
solid("school_fittings", [pv(dv, dw) + (gy + y,) for dv in (-0.8, 0.8) for dw in (-0.8, 0.8) for y in (1.25, 1.33)], wood)
for dv0, dv1, dw0, dw1 in ((-0.8, -0.76, -0.8, 0.8), (0.76, 0.8, -0.8, 0.8)):  # boards on two sides: the ladder and the slide in the others
    solid("school_fittings", [pv(dv, dw) + (gy + y,) for dv in (dv0, dv1) for dw in (dw0, dw1) for y in (1.33, 2.05)], wood)
for dw in (-0.95, 0.95):  # the roof: two boards in red
    solid("school_fittings", [pv(dv, w) + (gy + y,) for dv in (-0.95, 0.95) for w, y in ((dw, 2.62), (0.0, 3.38)) for y in (y, y + 0.05)], "#b4473a")
solid("school_fittings", [pv(dv, dw) + (gy + y,) for dv in (-0.95, 0.95) for dw in (-0.03, 0.03) for y in (3.36, 3.44)], wood_dark)
# The slide, down towards the long block.
s0, s1 = pv(0.0, 0.8), pv(0.0, 3.6)
beam("school_fittings", s0 + (gy + 1.3,), s1 + (gy + 0.25,), 0.52, 0.05, "#2f6db5")
for side in (-0.27, 0.27):
    beam("school_fittings", pv(side, 0.8) + (gy + 1.45,), pv(side, 3.6) + (gy + 0.4,), 0.04, 0.22, "#2f6db5")
beam("school_fittings", pv(0.0, 3.6) + (gy + 0.25,), pv(0.0, 4.1) + (gy + 0.2,), 0.52, 0.05, "#2f6db5")
for side in (-0.3, 0.3):  # the ladder on the other side: its foot out on the playground, its top at the platform
    beam("school_fittings", pv(side, -1.5) + (gy,), pv(side, -0.8) + (gy + 1.3,), 0.06, 0.06, wood_dark)
for k in range(1, 5):
    t = k / 5
    a, b = lerp(pv(-0.3, -1.5), pv(-0.3, -0.8), t), lerp(pv(0.3, -1.5), pv(0.3, -0.8), t)
    beam("school_fittings", a + (gy + 1.3 * t,), b + (gy + 1.3 * t,), 0.05, 0.05, wood)
# A row of balance posts and a beam, where the photo shows low dark timber things in rows.
for k, h in enumerate((0.3, 0.45, 0.6, 0.75, 0.6, 0.45, 0.3)):
    x, z = Q(24.5 + k * 0.55, -11.0)
    tube("school_fittings", (x, z, terrain(x, z) - 0.2), (x, z, terrain(x, z) + h), 0.11, wood, seg=8)
a, b = Q(24.0, -12.6), Q(28.0, -12.6)
for p in (a, b):
    beam("school_fittings", p + (terrain(*p) - 0.2,), p + (terrain(*p) + 0.32,), 0.12, 0.12, wood_dark)
beam("school_fittings", a + (terrain(*a) + 0.38,), b + (terrain(*b) + 0.38,), 0.13, 0.12, wood)
# A small goal at the south end, facing the playground.
g = lambda dw, dv: Q(44.9 + dv, -6.5 + dw)
gg = terrain(*g(0, 0)) + 0.03
green = "#2d4b37"
for dw in (-1.5, 1.5):
    beam("school_fittings", g(dw, 0) + (gg,), g(dw, 0) + (gg + 1.6,), 0.08, 0.08, green)
    beam("school_fittings", g(dw, 0) + (gg + 1.6,), g(dw, 0.9) + (gg,), 0.05, 0.05, green)
    beam("school_fittings", g(dw, 0) + (gg + 0.02,), g(dw, 0.9) + (gg + 0.02,), 0.05, 0.05, green)
beam("school_fittings", g(-1.54, 0) + (gg + 1.6,), g(1.54, 0) + (gg + 1.6,), 0.08, 0.08, green)
beam("school_fittings", g(-1.5, 0.9) + (gg + 0.02,), g(1.5, 0.9) + (gg + 0.02,), 0.05, 0.05, green)
for k in range(1, 10):  # the net: thin cords
    dw = -1.5 + 3.0 * k / 10
    beam("school_fittings", g(dw, 0.02) + (gg + 1.58,), g(dw, 0.9) + (gg + 0.03,), 0.015, 0.015, "#d9dcd8")
for y in (0.4, 0.8, 1.2):
    t = y / 1.6
    beam("school_fittings", g(-1.5, 0.9 * (1 - t)) + (gg + y,), g(1.5, 0.9 * (1 - t)) + (gg + y,), 0.015, 0.015, "#d9dcd8")
# Two benches along the corridor, a bin by the gate.
for u in (18.2, 21.0):
    yb = base1
    for du in (-0.75, 0.75):  # concrete feet, a timber seat
        p = P1(u + du, DL + 0.55)
        solid("school_dark", [(p[0] + U1[0] * dx + N1[0] * dn, p[1] + U1[1] * dx + N1[1] * dn, yb + y) for dx in (-0.06, 0.06) for dn in (-0.2, 0.2) for y in (-0.1, 0.42)])
    a, b = P1(u - 0.9, DL + 0.55), P1(u + 0.9, DL + 0.55)
    solid("school_fittings", [(q[0] + N1[0] * dn, q[1] + N1[1] * dn, yb + y) for q in (a, b) for dn in (-0.22, 0.22) for y in (0.42, 0.48)], wood)
x, z = P2(2.6, -0.45)
tube("school_fittings", (x, z, terrain(x, z)), (x, z, terrain(x, z) + 0.95), 0.27, "#2f4f3a", seg=10)
tube("school_fittings", (x, z, terrain(x, z) + 0.95), (x, z, terrain(x, z) + 1.0), 0.3, "#263f2f", seg=10)


# ---------------------------------------------------------------- the gate, the fences and the school garden
def mesh_fence(a, b, h, paint, post_every=2.5, wire=0.2):
    """A welded mesh fence from a to b (plan points): posts, a top and bottom rail, upright wires."""
    t, n = unit(a, b)
    ga, gb = terrain(*a), terrain(*b)
    yat = lambda s: ga + (gb - ga) * s / n
    for s in np.linspace(0, n, max(2, int(round(n / post_every)) + 1)):
        p = lerp(a, b, s / n)
        beam("school_fittings", p + (yat(s) - 0.3,), p + (yat(s) + h + 0.05,), 0.06, 0.06, paint)
    for y in (0.08, h - 0.04):
        beam("school_fittings", a + (ga + y,), b + (gb + y,), 0.03, 0.05, paint)
    o = (t[1], -t[0])
    for s in np.arange(wire / 2, n, wire):  # each wire a thin strip, seen from both sides
        p0, p1 = lerp(a, b, (s - 0.007) / n), lerp(a, b, (s + 0.007) / n)
        q = [p0 + (yat(s) + 0.05,), p1 + (yat(s) + 0.05,), p1 + (yat(s) + h - 0.02,), p0 + (yat(s) + h - 0.02,)]
        face("school_fittings", q, (o[0], o[1], 0), paint)
        face("school_fittings", q, (-o[0], -o[1], 0), paint)


black = "#1f2224"
pier = P1(L1 + 0.24, D1 - 0.02)
pg = terrain(*pier)
solid("school_brick", [(pier[0] + U1[0] * du + N1[0] * dn, pier[1] + U1[1] * du + N1[1] * dn, pg + y)
                       for du in (-0.21, 0.21) for dn in (-0.21, 0.21) for y in (-0.3, 2.3)])
solid("school_stone", [(pier[0] + U1[0] * du + N1[0] * dn, pier[1] + U1[1] * du + N1[1] * dn, pg + y)
                       for du in (-0.25, 0.25) for dn in (-0.25, 0.25) for y in (2.3, 2.4)])
# The gate's two leaves, open: swung in against the corridor's end and the long block.
for hinge, direction in ((P1(L1 + 0.5, D1 + 0.15), N1), (P2(0.85, -0.12), V2)):
    end = (hinge[0] + direction[0] * 1.42, hinge[1] + direction[1] * 1.42)
    hy = terrain(*hinge) + 0.06
    for y in (0.0, 1.95):
        beam("school_fittings", hinge + (hy + y,), end + (hy + y,), 0.04, 0.05, black)
    for k in range(13):
        p = lerp(hinge, end, k / 12)
        beam("school_fittings", p + (hy,), p + (hy + 1.95,), 0.025, 0.025, black)
# The fences (data/smetlede.json, `barriers`: the build keeps them as blocks to walk into): black round the
# school garden, dark green along the playground's south and west sides (made up).
for k, (fa, fb) in enumerate(SURVEY["barriers"]["fences"]):
    mesh_fence(tuple(fa), tuple(fb), 1.8, black if k < 3 else "#2e4a38")


def shelter(cx, cz, length, r=1.12, spring=0.95):
    """An arched bike shelter: a half-cylinder of clear sheets on steel ribs, its axis along the long block's W."""
    ax = W2
    side = V2
    hs = 10
    for k in range(hs):
        a0, a1 = math.pi * k / hs, math.pi * (k + 1) / hs
        pts = []
        for s in (-length / 2, length / 2):
            for a in (a0, a1):
                x = cx + ax[0] * s + side[0] * r * math.cos(a)
                z = cz + ax[1] * s + side[1] * r * math.cos(a)
                pts.append((x, z, terrain(cx, cz) + spring + r * math.sin(a)))
        face("school_clear", [pts[0], pts[2], pts[3], pts[1]], (0, 0, 1))
    for s in np.linspace(-length / 2, length / 2, 3):
        prev = None
        for k in range(6):
            a = math.pi * k / 5
            x = cx + ax[0] * s + side[0] * (r + 0.01) * math.cos(a)
            z = cz + ax[1] * s + side[1] * (r + 0.01) * math.cos(a)
            p = (x, z, terrain(cx, cz) + spring + (r + 0.01) * math.sin(a))
            if prev:
                beam("school_fittings", prev, p, 0.05, 0.05, "#55595c")
            prev = p
        for sg in (-1, 1):
            x = cx + ax[0] * s + side[0] * r * sg
            z = cz + ax[1] * s + side[1] * r * sg
            beam("school_fittings", (x, z, terrain(x, z) - 0.2), (x, z, terrain(cx, cz) + spring), 0.05, 0.05, "#55595c")
    for k in range(4):  # bike stands
        s = -length / 2 + 0.7 + k * (length - 1.4) / 3
        x0, z0 = cx + ax[0] * s - side[0] * 0.5, cz + ax[1] * s - side[1] * 0.5
        x1, z1 = cx + ax[0] * s + side[0] * 0.5, cz + ax[1] * s + side[1] * 0.5
        g0 = terrain(cx, cz)
        beam("school_fittings", (x0, z0, g0), (x0, z0, g0 + 0.75), 0.04, 0.04, "#8e9294")
        beam("school_fittings", (x1, z1, g0), (x1, z1, g0 + 0.75), 0.04, 0.04, "#8e9294")
        beam("school_fittings", (x0, z0, g0 + 0.75), (x1, z1, g0 + 0.75), 0.04, 0.04, "#8e9294")


shelter(478.95, -793.1, 4.6)
shelter(484.25, -792.3, 4.6)
for k, (x, z, r, h) in enumerate(((476.6, -790.4, 0.5, 0.55), (478.0, -790.25, 0.45, 0.4), (480.2, -789.85, 0.55, 0.65), (482.5, -789.55, 0.5, 0.5),
                                  (485.6, -789.15, 0.6, 0.7), (486.3, -791.9, 0.5, 0.45), (476.0, -795.6, 0.45, 0.5))):
    blob("school_fittings", x, z, terrain(x, z) - 0.05, r, h, ("#5f7d45", "#6d8a4c", "#55733f")[k % 3], seed=k)
# On the pavement: the bench on orange legs in front of the garden, three yellow hoop barriers, the egg seat.
bc = (480.45, -788.25)
for dw in (-0.75, 0.75):
    p = (bc[0] + W2[0] * dw, bc[1] + W2[1] * dw)
    for dv in (-0.2, 0.2):
        q = (p[0] + V2[0] * dv, p[1] + V2[1] * dv)
        beam("school_fittings", q + (terrain(*q) - 0.05,), q + (terrain(*q) + 0.44,), 0.06, 0.06, "#e07a22")
    beam("school_fittings", (p[0] - V2[0] * 0.22, p[1] - V2[1] * 0.22, terrain(*p) + 0.42), (p[0] + V2[0] * 0.22, p[1] + V2[1] * 0.22, terrain(*p) + 0.42),
         0.07, 0.05, "#e07a22")
solid("school_fittings", [(bc[0] + W2[0] * dw + V2[0] * dv, bc[1] + W2[1] * dw + V2[1] * dv, terrain(*bc) + y)
                          for dw in (-0.95, 0.95) for dv in (-0.24, 0.24) for y in (0.44, 0.5)], "#6d625a")
for x, z in ((474.0, -786.4), (476.4, -786.05), (478.8, -785.7)):
    a, b = (x - W2[0] * 0.5, z - W2[1] * 0.5), (x + W2[0] * 0.5, z + W2[1] * 0.5)
    for p in (a, b):
        beam("school_fittings", p + (terrain(*p) - 0.1,), p + (terrain(*p) + 0.95,), 0.06, 0.06, "#e8b51f")
    beam("school_fittings", a + (terrain(*a) + 0.95,), b + (terrain(*b) + 0.95,), 0.06, 0.06, "#e8b51f")
ex, ez = P1(22.4, -1.0)
eg = terrain(ex, ez)
pts = []
for i in range(7):
    t = math.pi * i / 6
    for k in range(10):
        a = 2 * math.pi * k / 10
        pts.append((ex + 0.48 * math.sin(t) * math.cos(a) * U1[0] - 0.27 * math.sin(t) * math.sin(a) * N1[0],
                    ez + 0.48 * math.sin(t) * math.cos(a) * U1[1] - 0.27 * math.sin(t) * math.sin(a) * N1[1],
                    eg + 0.24 - 0.26 * math.cos(t)))
solid("school_fittings", [p for p in pts if p[2] >= eg - 0.02] + [(ex, ez, eg)], "#e3892b")


# ---------------------------------------------------------------- the church square
# The church's own frame (tools/church.py): local x along its axis to the choir, y to the north.
CO, CT = (521.51, -744.15), 2.525
ch = lambda lx, ly: (CO[0] + lx * math.cos(CT) - ly * math.sin(CT), CO[1] - lx * math.sin(CT) - ly * math.cos(CT))
# The low planter wall in grey stone along the nave's south side, the bed behind it, its shrubs.
LX0, LX1, WALL_Y, NAVE_FACE = -16.0, 0.1, -6.6, -5.42
for lx0, lx1, y0, y1 in ((LX0, LX1, WALL_Y - 0.18, WALL_Y + 0.18), (LX0 - 0.18, LX0 + 0.18, WALL_Y, NAVE_FACE), (LX1 - 0.18, LX1 + 0.18, WALL_Y, NAVE_FACE)):
    xs = np.linspace(lx0, lx1, max(2, int((lx1 - lx0) / 2.0) + 1))
    for xa, xb in zip(xs, xs[1:]):
        corners = [ch(x, y) for x in (xa, xb) for y in (y0, y1)]
        solid("school_stone", [c + (terrain(*c) + h,) for c in corners for h in (-0.25, 0.5)])
bed = [ch(LX0 + 0.18, WALL_Y + 0.18), ch(LX1 - 0.18, WALL_Y + 0.18), ch(LX1 - 0.18, NAVE_FACE - 0.02), ch(LX0 + 0.18, NAVE_FACE - 0.02)]
drape("school_fittings", bed, 0.36, "#4a3c30")
for k, lx in enumerate(np.arange(LX0 + 0.8, LX1 - 0.4, 1.15)):
    x, z = ch(lx, (WALL_Y + NAVE_FACE) / 2 + 0.05 * ((k % 3) - 1))
    blob("school_fittings", x, z, terrain(x, z) + 0.3, 0.42, 0.5 + 0.12 * (k % 2), ("#58763f", "#6b8a4a", "#4f6e3d")[k % 3], seed=20 + k)
# Parking bays in front of it, nose to the church, painted white; the two by the tower for disabled drivers.
for lx in (-16.2, -12.7, -9.2, -6.8, -4.4, -2.0, 0.4):
    a, b = ch(lx - 0.05, WALL_Y - 0.25), ch(lx + 0.05, WALL_Y - 0.25)
    c, d = ch(lx + 0.05, WALL_Y - 5.2), ch(lx - 0.05, WALL_Y - 5.2)
    drape("school_fittings", [a, b, c, d], 0.045, "#eeece6")
# Their blue signs in front of the wall, and a bin by the chapel.
for lx in (-14.45, -10.95):
    x, z = ch(lx, WALL_Y - 0.3)
    g0 = terrain(x, z)
    tube("school_fittings", (x, z, g0 - 0.2), (x, z, g0 + 2.35), 0.035, "#8f9395", seg=6)
    t = ch(lx + 1, WALL_Y - 0.3)
    d = ((t[0] - x), (t[1] - z))
    o = ch(lx, WALL_Y - 1.3)
    out = (o[0] - x, o[1] - z)
    sign = Frame((x - d[0] * 0.3, z - d[1] * 0.3), d, out, g0)
    sign.box("school_fittings", 0, 0.6, 1.75, 2.35, 0.04, 0.07, "#1f5fa8")
    sign.box("school_fittings", 0.0, 0.6, 1.42, 1.72, 0.04, 0.07, "#f2f2ef")
    sign.box("school_fittings", 0.2, 0.28, 1.88, 2.24, 0.07, 0.08, "#f4f4f2")          # the P
    sign.box("school_fittings", 0.28, 0.4, 2.15, 2.24, 0.07, 0.08, "#f4f4f2")
    sign.box("school_fittings", 0.28, 0.4, 2.01, 2.09, 0.07, 0.08, "#f4f4f2")
    sign.box("school_fittings", 0.37, 0.43, 2.05, 2.2, 0.07, 0.08, "#f4f4f2")
    sign.box("school_fittings", 0.25, 0.35, 1.5, 1.64, 0.07, 0.08, "#1f5fa8")
x, z = ch(-16.75, -6.35)
tube("school_fittings", (x, z, terrain(x, z)), (x, z, terrain(x, z) + 0.9), 0.25, "#2f4f3a", seg=10)
tube("school_fittings", (x, z, terrain(x, z) + 0.9), (x, z, terrain(x, z) + 0.96), 0.28, "#263f2f", seg=10)


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


root = bpy.data.objects.new("smetlede_school", None)
bpy.context.scene.collection.objects.link(root)
root["origin"] = [ORIGIN[0], ORIGIN[1]]
root["landmark"] = "school"
tris = 0
objs = []
for name, bm in BM.items():
    if not bm.faces:
        continue
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
    bm.normal_update()
    if name in SHARED:  # only the textured materials need UVs
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
print(f"school: {tris} triangles in {len(objs)} meshes; origin {ORIGIN} at {Y0:.2f} m")
bpy.ops.object.select_all(action="DESELECT")
root.select_set(True)
for o in objs:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=True, export_normals=True, export_extras=True, export_vertex_color="MATERIAL",
                          export_cameras=False, export_lights=False)
print("written", OUT, os.path.getsize(OUT), "bytes")
