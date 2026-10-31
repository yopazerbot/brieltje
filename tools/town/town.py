"""Build the houses round Smetlede's church square and along the street to the school, in Blender.

Run (Blender 5, no window), from the project root:
  blender -b -P tools/town/town.py -- web/public/models/town.glb
and to render a still of it as well (Eevee; eye and target as game x, z and height above the ground):
  blender -b -P tools/town/town.py -- web/public/models/town.glb --preview cafe.png 547 -740 1.65 539.6 -724.8 4.6

Among them the café by the church tower, after a Street View photo of April 2023: its front is a crow-stepped
gable (`stepped`: the outline, the parapet's back, the risers and a brick cap on every step), with cream brick
courses and lozenges, a sunburst fanlight, a roller-shuttered window and its name lettered on the sign board in
Blender's own font. Flags and the hanging sign are plain colours with no brand's marks.

Our own models of the houses a player sees from the church and school portals, from the third survey of the
village centre (31 Oct 2026, tools/town/houses.json). Used for measuring only, nothing of them is shipped:
- the plans: the GRB outlines and the roof parts that tools/neighbours.py fits to the DHM Vlaanderen II laser
  scan (data/neighbours.json): each house is a few rectangular volumes with a gable, hip, shed or flat roof
  at the scanned eaves and ridge heights, where the scan is older than the house the heights come from the
  photos;
- Street View (August 2026 where the car passed, else April 2023 or older), from the street and the square:
  walls (red, red-brown or yellow brick, painted brick in cream or white, smooth render), plinths, the
  windows and doors per storey with their frames, sills, lintels and shutters, garage doors, shop windows,
  roof tiles (orange clay or anthracite), chimneys, roof windows, gutters and downpipes, wall anchors;
- the 25 cm orthophoto: roof colours and the yards.
No house numbers, names, signs or lettering; nothing is copied from the photos.

The relief: everything stands on the browser's relief (web/shared/terrain.json); a house's floor is level at
the height of the ground in the middle of its street front, and its walls reach 0.4 m below the lowest ground.

Light: ambient occlusion and the sun's shadow (the game's fixed late-afternoon sun) are worked out here per
corner with rays (mathutils' BVH: the houses, the ground and the neighbouring buildings as blocks) and baked
into the vertex colours, multiplied with each surface's own colour. The village has no real-time shadows, so
this is what puts the shade under the eaves, in the window reveals and behind the chimneys.

Frame: the game's axes (x, y up, z); origin on the ground at ORIGIN. The root node's extras carry the origin,
the GRB outlines whose open-data blocks these houses replace (`replaces`), blocks for walking into for what
is new (`solids`), and the distance beyond which the simple copy is drawn (`far`).

Output: one GLB. The near copy, one mesh per material:
- near_brick, near_render, near_roof: UVs in metres; their extras name a game texture (town_brick, plaster,
  town_roof) and the colour per vertex carries the tint and the baked light;
- near_trim: frames, doors, shutters, gutters, downpipes, sills' fronts, ridge tiles, fittings, coloured per vertex;
- near_glass: the panes (dark and glossy, net curtains lighter), coloured per vertex.
The far copy (far_brick, far_render, far_roof): the same volumes without openings, the windows as dark
patches, for beyond `far` metres from the middle.
"""
import json
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPEC = json.load(open(os.path.join(ROOT, "tools", "town", "houses.json"), encoding="utf-8"))
NB = json.load(open(os.path.join(ROOT, "data", "neighbours.json"), encoding="utf-8"))
ORIGIN = tuple(SPEC["origin"])
FAR = SPEC.get("far", 230.0)
SUN = Vector(SPEC["sun"]).normalized()      # towards the sun, game axes (x, y, z)
CELL = 0.9                                    # m: wall and roof faces are cut this fine for the baked light
COLOR_SCALE = 1.6                             # vertex colours are stored divided by this (see pack)


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
    nx, nz = d["nx"], d["nz"]
    grid = [rest[j * nx:(j + 1) * nx] for j in range(nz)]
    for j in range(nz):  # cumulative sums along rows, then down the columns
        acc = 0
        row = grid[j]
        for i in range(nx):
            acc += row[i]
            row[i] = acc
    for j in range(1, nz):
        prev, row = grid[j - 1], grid[j]
        for i in range(nx):
            row[i] += prev[i]
    return d, grid


TD, TG = load_terrain()


def terrain(x, z):
    """Metres above the plot's ground at (x, z): two flat triangles per square of the grid (terrain.mjs)."""
    fx = min(max((x - TD["x0"]) / TD["step"], 0.0), TD["nx"] - 1.000001)
    fz = min(max((z - TD["z0"]) / TD["step"], 0.0), TD["nz"] - 1.000001)
    i, j = int(fx), int(fz)
    u, v = fx - i, fz - j
    h00, h11 = TG[j][i] / 100.0, TG[j + 1][i + 1] / 100.0
    if u >= v:
        h10 = TG[j][i + 1] / 100.0
        return h00 + u * (h10 - h00) + v * (h11 - h10)
    h01 = TG[j + 1][i] / 100.0
    return h00 + v * (h01 - h00) + u * (h11 - h01)


Y0 = terrain(*ORIGIN)


def V(x, z, y):
    """A point in the game's frame (y above the plot's ground, as the relief) in Blender's (z up)."""
    return Vector((x - ORIGIN[0], -(z - ORIGIN[1]), y - Y0))


def G(v):
    """Blender's point back in the game's (x, z, y)."""
    return (v.x + ORIGIN[0], -v.y + ORIGIN[1], v.z + Y0)


def srgb(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def shade(h, k):
    """A colour k times as light (k < 1 darker), in sRGB hex."""
    c = [min(255, int(int(h[i:i + 2], 16) * k)) for i in (1, 3, 5)]
    return "#%02x%02x%02x" % tuple(c)


# ---------------------------------------------------------------- materials and meshes
bpy.ops.wm.read_factory_settings(use_empty=True)
# name: (game texture or None, mean colour for Blender's preview, roughness, normal scale)
MATS = {
    "brick": ("town_brick", "#a0604a", 0.9, 1.0),
    "render": ("plaster", "#d8d4cc", 0.9, 0.4),
    "roof": ("town_roof", "#55575a", 0.8, 1.0),
    "trim": (None, "#ffffff", 0.55, 1.0),
    "glass": (None, "#20262a", 0.08, 1.0),
}
# The mean linear colour of each game texture: a surface's colour per vertex is its wanted colour divided by
# this, so the textured surface comes out in the colour named in houses.json (measured on the WebP files).
TEXMEAN = {"brick": (0.891, 0.728, 0.626), "render": (0.896, 0.895, 0.896), "roof": (0.521, 0.494, 0.464)}
MAT = {}
BM = {}


def make_material(name, tex, mean, rough, nscale):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*srgb(mean), 1)
    p.inputs["Roughness"].default_value = rough
    attr = m.node_tree.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Color"
    m.node_tree.links.new(attr.outputs["Color"], p.inputs["Base Color"])
    m.use_backface_culling = True
    if tex:
        m["texture"], m["normalScale"] = tex, nscale
    m["roughness"] = rough
    return m


for lod in ("near", "far"):
    for name, (tex, mean, rough, nscale) in MATS.items():
        if lod == "far" and name in ("trim", "glass"):
            continue
        key = (lod, name)
        MAT[key] = make_material(f"{lod}_{name}", tex, mean, rough, nscale)
        bm = bmesh.new()
        bm.loops.layers.float_color.new("Color")
        BM[key] = bm


def colour(h, key=None):
    c = srgb(h)
    m = TEXMEAN.get(key[1]) if key else None
    if m:
        c = tuple(c[i] / m[i] for i in range(3))
    return (*c, 1.0)


def face(key, pts, out=None, paint="#ffffff"):
    """A planar face through game points (x, z, y); turned to face `out` (a game direction (dx, dz, dy))."""
    bm = BM[key]
    vs = [V(*p) for p in pts]
    if out is not None:
        n = Vector((0, 0, 0))
        for k in range(len(vs)):  # Newell's normal: robust for any planar polygon
            a, b = vs[k], vs[(k + 1) % len(vs)]
            n += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
        o = Vector((out[0], -out[1], out[2]))
        if n.dot(o) < 0:
            vs = vs[::-1]
    try:
        f = bm.faces.new([bm.verts.new(v) for v in vs])
    except ValueError:
        return None
    lay = bm.loops.layers.float_color["Color"]
    c = colour(paint, key)
    for lp in f.loops:
        lp[lay] = c
    return f


def grid(key, a, b, c, d, out, paint, cell=CELL):
    """A planar quad a-b-c-d (a, b along the bottom, d, c above them) cut into cells about `cell` across."""
    A, B, C, D = (Vector(p) for p in (a, b, c, d))
    nu = max(1, math.ceil(max((B - A).length, (C - D).length) / cell))
    nv = max(1, math.ceil(max((D - A).length, (C - B).length) / cell))
    for i in range(nu):
        for j in range(nv):
            def P(u, v):
                bot = A.lerp(B, u)
                top = D.lerp(C, u)
                q = bot.lerp(top, v)
                return (q.x, q.y, q.z)
            u0, u1, v0, v1 = i / nu, (i + 1) / nu, j / nv, (j + 1) / nv
            face(key, [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], out, paint)


def grid_tri(key, a, b, c, out, paint, cell=CELL):
    """A triangle a-b (base) - c (apex) cut into strips about `cell` high, each strip into cells."""
    A, B, C = (Vector(p) for p in (a, b, c))
    nv = max(1, math.ceil(max((C - A).length, (C - B).length) / cell))
    for j in range(nv):
        v0, v1 = j / nv, (j + 1) / nv
        l0, r0, l1, r1 = A.lerp(C, v0), B.lerp(C, v0), A.lerp(C, v1), B.lerp(C, v1)
        if j == nv - 1:
            nu = max(1, math.ceil((r0 - l0).length / cell))
            for i in range(nu):
                p0, p1 = l0.lerp(r0, i / nu), l0.lerp(r0, (i + 1) / nu)
                face(key, [tuple(p0), tuple(p1), tuple(C)], out, paint)
        else:
            grid(key, tuple(l0), tuple(r0), tuple(r1), tuple(l1), out, paint, cell)


def solid(key, pts, paint="#ffffff"):
    """The convex solid round game points (x, z, y)."""
    tmp = bmesh.new()
    for p in pts:
        tmp.verts.new(V(*p))
    res = bmesh.ops.convex_hull(tmp, input=tmp.verts[:])
    dead = {g for g in res["geom_interior"] + res["geom_unused"] if isinstance(g, bmesh.types.BMVert)}
    bmesh.ops.delete(tmp, geom=list(dead), context="VERTS")
    bmesh.ops.dissolve_limit(tmp, angle_limit=math.radians(0.5), verts=tmp.verts[:], edges=tmp.edges[:])
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces[:])
    bm = BM[key]
    lay = bm.loops.layers.float_color["Color"]
    c = colour(paint, key)
    for f in tmp.faces:
        nf = bm.faces.new([bm.verts.new(v.co) for v in f.verts])
        for lp in nf.loops:
            lp[lay] = c
    tmp.free()


def tube(key, a, b, r, paint, seg=6):
    a, b = Vector(a), Vector(b)
    d = (b - a).normalized()
    u = d.cross(Vector((1, 0, 0)) if abs(d.x) < 0.9 else Vector((0, 1, 0))).normalized()
    w = d.cross(u)
    pts = []
    for k in range(seg):
        t = 2 * math.pi * k / seg
        off = u * math.cos(t) * r + w * math.sin(t) * r
        pts += [tuple(a + off), tuple(b + off)]
    solid(key, pts, paint)


class Frame:
    """A wall on the plan: origin a, direction t along the wall, outward normal o; base is the floor
    (y above the plot's ground). p(s, y, d): s along, y up from the floor, d out of the wall."""

    def __init__(self, a, t, o, base):
        self.a, self.t, self.o, self.base = a, t, o, base

    def p(self, s, y, d=0.0):
        return (self.a[0] + self.t[0] * s + self.o[0] * d, self.a[1] + self.t[1] * s + self.o[1] * d, self.base + y)

    def out(self, k=1.0):
        return (self.o[0] * k, self.o[1] * k, 0.0)

    def box(self, key, s0, s1, y0, y1, d0, d1, paint):
        solid(key, [self.p(s, y, d) for s in (s0, s1) for y in (y0, y1) for d in (d0, d1)], paint)

    def flat(self, key, s0, s1, y0, y1, d, paint, cell=None):
        if cell:
            grid(key, self.p(s0, y0, d), self.p(s1, y0, d), self.p(s1, y1, d), self.p(s0, y1, d), self.out(), paint, cell)
        else:
            face(key, [self.p(s0, y0, d), self.p(s1, y0, d), self.p(s1, y1, d), self.p(s0, y1, d)], self.out(), paint)


def surface(spec):
    """'brick:#b06040' or 'render:#e8e4dc' -> (material, colour)."""
    m, c = spec.split(":")
    return m, c


# ---------------------------------------------------------------- openings
WIDTH = {"w": 1.2, "W": 2.1, "n": 0.7, "d": 1.0, "D": 1.7, "g": 2.5, "G": 3.1, "s": 2.8, "a": 1.15, "_": 1.0, "o": 0.6, "c": 3.0, "r": 1.9}


class Hole:
    def __init__(self, kind, s0, s1, y0, y1, storey=0):
        self.kind, self.s0, self.s1, self.y0, self.y1, self.storey = kind, s0, s1, y0, y1, storey


def layout(fs, length):
    """The openings of a facade spec: rows of tokens spread evenly, or explicit 'at' positions."""
    holes = []
    floors = fs.get("floors", [0.0, 2.85, 5.6, 8.3])
    margin = fs.get("margin", 0.7)
    for k, row in enumerate(fs.get("rows", [])):
        f = floors[k] if k < len(floors) else floors[-1] + 2.75 * (k - len(floors) + 1)
        items = []
        for tok in row.split():
            kind = tok[0]
            w = float(tok[1:]) if len(tok) > 1 else WIDTH[kind]
            items.append((kind, w))
        if not items:
            continue
        total = sum(w for _, w in items)
        free = length - 2 * margin - total
        if free < 0:
            scale = (length - 2 * margin) / total
            items = [(kd, w * scale) for kd, w in items]
            free = 0.0
        gap = free / (len(items) - 1) if len(items) > 1 else 0.0
        s = margin if len(items) > 1 else (length - total) / 2
        for kind, w in items:
            if kind != "_":
                holes.append(opening_heights(kind, s, s + w, f, k, fs))
            s += w + gap
    for s, tok in fs.get("at", []):
        kind = tok[0]
        w = float(tok[1:].split("@")[0]) if len(tok) > 1 and tok[1] != "@" else WIDTH[kind]
        k = int(tok.split("@")[1]) if "@" in tok else 0
        f = floors[k] if k < len(floors) else floors[-1]
        holes.append(opening_heights(kind, s - w / 2, s + w / 2, f, k, fs))
    return holes


def opening_heights(kind, s0, s1, f, storey, fs):
    head = fs.get("head", 2.2)
    sill = fs.get("sill_h", 0.85)
    if kind in "dD":
        return Hole(kind, s0, s1, f + (0.05 if storey == 0 else 0.0), f + head + 0.05, storey)
    if kind in "gG":
        return Hole(kind, s0, s1, f + 0.02, f + fs.get("garage_h", 2.25), storey)
    if kind == "c":  # a carport or passage: an open bay under the floor above
        return Hole(kind, s0, s1, f - 0.05, f + fs.get("garage_h", 2.6), storey)
    if kind == "s":
        return Hole(kind, s0, s1, f + 0.4, f + 2.55, storey)
    if kind == "o":  # small attic or toilet window
        return Hole(kind, s0, s1, f + 1.2, f + 1.9, storey)
    if kind == "a":
        return Hole(kind, s0, s1, f + sill, f + head + 0.15, storey)
    if kind == "W" and storey > 0 and fs.get("low_wide"):
        return Hole(kind, s0, s1, f + 0.25, f + head, storey)
    return Hole(kind, s0, s1, f + sill, f + head, storey)


def build_opening(F, h, fs, wallkey, wallcol, rng):
    """Reveals, frame, glass, sill, lintel, door or garage door and shutters for one hole in a facade."""
    depth = fs.get("depth", 0.14)
    rows_f, rows_s = fs.get("frame_rows"), fs.get("style_rows")  # per storey, from the ground up
    frame = rows_f[min(h.storey, len(rows_f) - 1)] if rows_f else fs.get("frame", "#f2f0ea")
    style = rows_s[min(h.storey, len(rows_s) - 1)] if rows_s else fs.get("style", "classic")
    fs = {**fs, "frame": frame, "style": style}
    s0, s1, y0, y1 = h.s0, h.s1, h.y0, h.y1
    w = s1 - s0
    N = ("near", "trim")
    GL = ("near", "glass")
    if h.kind == "c":
        # The bay: its sides, ceiling and back wall in the wall's surface, the back in shade.
        dd = fs.get("bay_depth", 2.5)
        for sx, sgn in ((s0, 1), (s1, -1)):
            face(wallkey, [F.p(sx, y0, 0), F.p(sx, y0, -dd), F.p(sx, y1, -dd), F.p(sx, y1, 0)], (F.t[0] * sgn, F.t[1] * sgn, 0), shade(wallcol, 0.8))
        face(("near", "render"), [F.p(s0, y1, 0), F.p(s1, y1, 0), F.p(s1, y1, -dd), F.p(s0, y1, -dd)], (0, 0, -1), "#d9d7d2")
        F.flat(wallkey, s0, s1, y0, y1, -dd, shade(wallcol, 0.75))
        face(("near", "render"), [F.p(s0, y0 + 0.04, 0), F.p(s1, y0 + 0.04, 0), F.p(s1, y0 + 0.04, -dd), F.p(s0, y0 + 0.04, -dd)], (0, 0, 1), "#8d8b86")
        return
    # A painted band round the opening (the blue or sandstone surrounds of older houses).
    if fs.get("surround"):
        sc, bw = fs["surround"], 0.14
        F.flat(wallkey, s0 - bw, s1 + bw, y1, y1 + bw, 0.006, sc)
        F.flat(wallkey, s0 - bw, s0, y0 - (0.07 if h.kind not in "dDgG" else 0), y1, 0.006, sc)
        F.flat(wallkey, s1, s1 + bw, y0 - (0.07 if h.kind not in "dDgG" else 0), y1, 0.006, sc)
    # Reveals: the wall's own surface turned into the opening.
    F_in = -depth
    for sx, sgn in ((s0, 1), (s1, -1)):  # the side reveals face into the opening
        face(wallkey, [F.p(sx, y0, 0), F.p(sx, y0, F_in), F.p(sx, y1, F_in), F.p(sx, y1, 0)], (F.t[0] * sgn, F.t[1] * sgn, 0), wallcol)
    face(wallkey, [F.p(s0, y1, 0), F.p(s1, y1, 0), F.p(s1, y1, F_in), F.p(s0, y1, F_in)], (0, 0, -1), shade(wallcol, 0.9))
    if h.kind not in "dDgG":
        face(wallkey, [F.p(s0, y0, 0), F.p(s1, y0, 0), F.p(s1, y0, F_in), F.p(s0, y0, F_in)], (0, 0, 1), wallcol)
    # Lintel: a course of bricks on end over the opening (brick walls), or a stone lintel.
    lintel = fs.get("lintel")
    if lintel and h.kind != "s":
        if h.kind == "a":  # a segmental arch of bricks on end: a few short pieces round the head
            n = 7
            for i in range(n):
                a0, a1 = math.pi * i / n, math.pi * (i + 1) / n
                r0, r1 = w / 2 + 0.02, w / 2 + 0.24
                cx, cy = (s0 + s1) / 2, y1 - w * 0.2
                pts = []
                for a in (a0, a1):
                    for r in (r0, r1):
                        pts.append((cx - math.cos(a) * r, cy + math.sin(a) * r * 0.45 + w * 0.2))
                face(wallkey, [F.p(pts[0][0], pts[0][1], 0.012), F.p(pts[2][0], pts[2][1], 0.012),
                               F.p(pts[3][0], pts[3][1], 0.012), F.p(pts[1][0], pts[1][1], 0.012)], F.out(), lintel)
        else:
            F.flat(wallkey, s0 - 0.06, s1 + 0.06, y1, y1 + 0.2, 0.008, lintel)
    # Sill: stone (blue stone or concrete) under windows, sloping out a little.
    if h.kind not in "dDgGs" and fs.get("sill", "#8f8f8a") != "none":
        sc = fs.get("sill", "#8f8f8a")
        F.box(("near", "render"), s0 - 0.05, s1 + 0.05, y0 - 0.07, y0, -depth + 0.02, 0.05, sc)
    if h.kind in "dD":
        # Doorstep of blue stone, then the leaf.
        F.box(("near", "render"), s0 - 0.08, s1 + 0.08, y0 - 0.25, y0, -depth, 0.28, fs.get("step", "#5c5f62"))
        door(F, h, fs, depth, frame)
        return
    if h.kind in "gG":
        garage(F, h, fs, depth)
        return
    if h.kind == "r":
        # A window behind a closed roller shutter: the frame, the slatted shutter and its box at the head.
        sc = fs.get("roller", "#e9e9e6")
        F.box(N, s0, s1, y0, y1, -depth + 0.02, -depth + 0.06, sc)
        for k in range(1, 14):
            y = y0 + (y1 - y0) * k / 14
            F.box(N, s0 + 0.02, s1 - 0.02, y - 0.006, y + 0.006, -depth + 0.06, -depth + 0.068, shade(sc, 0.8))
        F.box(N, s0, s1, y1 - 0.2, y1, -depth + 0.02, -depth + 0.1, shade(sc, 0.95))
        return
    # Frame round the glass and the glass.
    fd = -depth + 0.02            # the frame's front, just behind the wall
    fw = 0.065 if style != "modern" else 0.05
    gd = fd - 0.03                # the glass, behind the frame's front
    F.box(N, s0, s1, y0, y0 + fw, fd - 0.05, fd, frame)
    F.box(N, s0, s1, y1 - fw, y1, fd - 0.05, fd, frame)
    F.box(N, s0, s0 + fw, y0, y1, fd - 0.05, fd, frame)
    F.box(N, s1 - fw, s1, y0, y1, fd - 0.05, fd, frame)
    curtains = fs.get("curtains", 0.5) > rng.random() and h.kind != "s"
    top_dark = "#283035"
    if curtains:
        ym = y0 + fw + (y1 - y0 - 2 * fw) * rng.uniform(0.45, 0.62)
        F.flat(GL, s0 + fw, s1 - fw, y0 + fw, ym, gd, rng.choice(["#9f998d", "#aaa497", "#938d82"]))  # net curtains, in the room's shade
        F.flat(GL, s0 + fw, s1 - fw, ym, y1 - fw, gd, top_dark)
    else:
        F.flat(GL, s0 + fw, s1 - fw, y0 + fw, y1 - fw, gd, rng.choice(["#283035", "#2c3338", "#252b2f"]))
    # Mullions and transoms.
    cols, rows = fs.get("panes", [2 if w > 0.9 else 1, 1])
    if h.kind == "s":
        cols, rows = max(1, round(w / 1.4)), 1
    if h.kind == "W" and style == "modern":
        cols = 2
    bar = 0.05 if style != "old" else 0.035
    for i in range(1, cols):
        s = s0 + w * i / cols
        F.box(N, s - bar / 2, s + bar / 2, y0, y1, fd - 0.04, fd - 0.005, frame)
    for j in range(1, rows):
        y = y0 + (y1 - y0) * j / rows
        F.box(N, s0, s1, y - bar / 2, y + bar / 2, fd - 0.04, fd - 0.005, frame)
    if style == "classic" and rows == 1 and h.kind in "wWa" and fs.get("transom", True):
        y = y0 + (y1 - y0) * 0.72
        F.box(N, s0, s1, y - 0.03, y + 0.03, fd - 0.04, fd - 0.005, frame)
    if h.kind == "s":
        F.box(N, s0, s1, y0 - 0.4, y0, -depth + 0.03, 0.0, fs.get("riser", "#2e3134"))
        if fs.get("sign"):
            F.box(N, s0 - 0.1, s1 + 0.1, y1 + 0.12, y1 + 0.55, 0.0, 0.06, fs["sign"])
    # Shutters: a leaf each side, against the wall.
    if fs.get("shutters") and h.kind in "wa" and y0 < 2.5:
        sc = fs["shutters"]
        for a, b in ((s0 - w / 2 - 0.03, s0 - 0.03), (s1 + 0.03, s1 + w / 2 + 0.03)):
            F.box(N, a, b, y0 - 0.02, y1 + 0.02, 0.0, 0.035, sc)
            for k in range(1, 4):  # the boards' lines
                y = y0 + (y1 - y0) * k / 4
                F.box(N, a + 0.03, b - 0.03, y - 0.012, y + 0.012, 0.035, 0.045, shade(sc, 0.75))


def door(F, h, fs, depth, frame):
    N = ("near", "trim")
    s0, s1, y0, y1 = h.s0, h.s1, h.y0, h.y1
    c = fs.get("door", "#4a3426")
    fd = -depth + 0.02
    fw = 0.07
    F.box(N, s0, s1, y1 - fw, y1, fd - 0.06, fd, frame)
    F.box(N, s0, s0 + fw, y0, y1, fd - 0.06, fd, frame)
    F.box(N, s1 - fw, s1, y0, y1, fd - 0.06, fd, frame)
    leaves = 2 if h.kind == "D" else 1
    lw = (s1 - s0 - 2 * fw) / leaves
    top = y1 - fw
    fan = fs.get("fanlight", False)
    if fan:  # a glazed fanlight over the door
        top = y1 - fw - 0.45
        F.box(N, s0, s1, top - 0.04, top + 0.02, fd - 0.06, fd, frame)
        F.flat(("near", "glass"), s0 + fw, s1 - fw, top + 0.02, y1 - fw, fd - 0.04, "#283035")
        if fan == "sun":  # glazing bars fanning out from the middle of the transom, as on older doors
            cx, cy = (s0 + s1) / 2, top + 0.02
            r = y1 - fw - cy
            for k in range(1, 6):
                a = math.pi * k / 6
                ex = max(s0 + fw, min(s1 - fw, cx - math.cos(a) * (s1 - s0) / 2))
                ey = cy + math.sin(a) * r
                d = Vector((ex - cx, ey - cy))
                n = Vector((-d.y, d.x)).normalized() * 0.012
                face(N, [F.p(cx + n.x, cy + n.y, fd - 0.035), F.p(cx - n.x, cy - n.y, fd - 0.035),
                         F.p(ex - n.x, ey - n.y, fd - 0.035), F.p(ex + n.x, ey + n.y, fd - 0.035)], F.out(), frame)
            F.box(N, cx - 0.09, cx + 0.09, cy, cy + 0.07, fd - 0.04, fd - 0.03, frame)
    for i in range(leaves):
        a, b = s0 + fw + lw * i, s0 + fw + lw * (i + 1)
        F.box(N, a + 0.005, b - 0.005, y0, top, fd - 0.08, fd - 0.03, c)
        if fs.get("door_glass", True):
            F.flat(("near", "glass"), a + 0.14, b - 0.14, y0 + (top - y0) * 0.55, top - 0.14, fd - 0.025, "#2a3034")
            F.box(N, a + 0.1, b - 0.1, y0 + 0.18, y0 + (top - y0) * 0.45, fd - 0.03, fd - 0.015, shade(c, 0.85))
        else:
            for (q0, q1) in ((0.12, 0.45), (0.55, 0.9)):
                F.box(N, a + 0.1, b - 0.1, y0 + (top - y0) * q0, y0 + (top - y0) * q1, fd - 0.03, fd - 0.015, shade(c, 0.85))
        hs = b - 0.1 if i == 0 else a + 0.1
        F.box(N, hs - 0.02, hs + 0.02, y0 + 1.0, y0 + 1.25, fd - 0.03, fd + 0.01, "#9a9c9e")


def garage(F, h, fs, depth):
    N = ("near", "trim")
    s0, s1, y0, y1 = h.s0, h.s1, h.y0, h.y1
    c = fs.get("garage", "#ece9e2")
    fd = -depth + 0.02
    F.box(N, s0, s1, y0, y1, fd - 0.08, fd - 0.04, c)
    n = 5
    for k in range(1, n):
        y = y0 + (y1 - y0) * k / n
        F.box(N, s0 + 0.03, s1 - 0.03, y - 0.012, y + 0.012, fd - 0.04, fd - 0.03, shade(c, 0.78))
    F.box(N, (s0 + s1) / 2 - 0.12, (s0 + s1) / 2 + 0.12, y0 + 0.35, y0 + 0.4, fd - 0.04, fd - 0.02, "#7d7f81")


# ---------------------------------------------------------------- walls
def facade(F, length, top, holes, spec, fs, bottom, rng, far_key=None, far_col=None):
    """A wall from s = 0 to `length`, from `bottom` up to the line `top` ([(s, y)]), with its holes; below the
    plinth in the plinth's surface. Cut into cells for the baked light."""
    wm, wc = surface(fs.get("wall", spec["wall"]))
    pl = fs.get("plinth", spec.get("plinth"))
    pm, pc, ph = (surface(pl[1]) + (pl[0],)) if pl else (wm, wc, -99)
    key = ("near", wm)

    def ytop(s):
        for (sa, ya), (sb, yb) in zip(top, top[1:]):
            if sa - 1e-6 <= s <= sb + 1e-6:
                return ya + (yb - ya) * (s - sa) / max(sb - sa, 1e-9)
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
            if ya < ph and (yb is None or yb > ph):
                pieces = [(ya, ph), (ph, yb)]
            for y0, y1 in pieces:
                in_plinth = y1 is not None and y1 <= ph + 1e-6
                k, c = (("near", pm), pc) if in_plinth else (key, wc)
                ta = ytop(xa) if y1 is None else y1
                tb = ytop(xb) if y1 is None else y1
                if max(ta, tb) - y0 < 1e-4:
                    continue
                grid(k, F.p(xa, y0), F.p(xb, y0), F.p(xb, tb), F.p(xa, ta), F.out(), c)
    for h in holes:
        build_opening(F, h, fs, key, wc, rng)
    for k in range(fs.get("anchors", 0)):  # wall anchors: iron crosses at the upper floor
        s = length * (k + 0.5) / fs["anchors"]
        y = fs.get("anchor_y", 4.6)
        F.box(("near", "trim"), s - 0.03, s + 0.03, y - 0.28, y + 0.28, 0.0, 0.03, "#2a2a2a")
        F.box(("near", "trim"), s - 0.2, s + 0.2, y - 0.025, y + 0.025, 0.0, 0.03, "#2a2a2a")
        F.box(("near", "trim"), s - 0.09, s + 0.09, y + 0.12, y + 0.16, 0.0, 0.03, "#2a2a2a")
        F.box(("near", "trim"), s - 0.09, s + 0.09, y - 0.16, y - 0.12, 0.0, 0.03, "#2a2a2a")
    for s, y, w, h, d, c in fs.get("boxes", []):  # things on the wall: air conditioning units, letterboxes, lamps
        F.box(("near", "trim"), s - w / 2, s + w / 2, y, y + h, 0.0, d, c)
    if fs.get("band"):  # a band across the facade: a shop's sign board, a painted cornice
        c, y0, y1 = fs["band"][:3]
        d = fs["band"][3] if len(fs["band"]) > 3 else 0.06
        b0, b1 = (fs["band"][4], fs["band"][5]) if len(fs["band"]) > 5 else (0.05, length - 0.05)
        F.box(("near", "trim"), b0, b1, y0, y1, 0.0, d, c)
    for s0, s1, y0, y1, c in fs.get("strips", []):  # courses of another brick laid in the wall (light bands)
        F.flat(key, max(0.0, s0), min(length, s1), y0, y1, 0.006, c)
    for s, y, w, h, c in fs.get("diamonds", []):  # lozenges of light brick
        face(key, [F.p(s, y - h / 2, 0.007), F.p(s + w / 2, y, 0.007), F.p(s, y + h / 2, 0.007), F.p(s - w / 2, y, 0.007)], F.out(), c)
        face(key, [F.p(s, y - h / 4, 0.009), F.p(s + w / 4, y, 0.009), F.p(s, y + h / 4, 0.009), F.p(s - w / 4, y, 0.009)], F.out(), shade(c, 0.86))
    for tx in fs.get("text", []):  # painted lettering on a sign board
        lettering(F, tx)
    # The far copy: the whole wall, the windows as dark patches.
    fk = ("far", wm)
    face(fk, [F.p(0, bottom), F.p(length, bottom)] + [F.p(s, y) for s, y in reversed(top)], F.out(), shade(wc, 0.85))
    for h in holes:
        face(("far", "render"), [F.p(h.s0, h.y0, 0.03), F.p(h.s1, h.y0, 0.03), F.p(h.s1, h.y1, 0.03), F.p(h.s0, h.y1, 0.03)],
             F.out(), "#2b3134" if h.kind not in "dDgG" else shade(fs.get("garage" if h.kind in "gG" else "door", "#4a3426"), 0.8))


def lettering(F, tx):
    """Letters on a wall or board: Blender's own font (DejaVu Sans) turned into flat shapes, `h` m high, centred
    on s along the wall, bottom at y, d out from the wall; read the right way round from outside."""
    cu = bpy.data.curves.new("lettering", "FONT")
    cu.body = tx["t"]
    cu.size = tx["h"] / 0.72          # the font's capitals are about 0.72 of its size
    cu.space_character = tx.get("spacing", 1.05)
    cu.fill_mode = "FRONT"
    ob = bpy.data.objects.new("lettering", cu)
    bpy.context.scene.collection.objects.link(ob)
    me = ob.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    xs = [v.co.x for v in me.vertices]
    x0, x1 = min(xs), max(xs)
    # The viewer outside looks along -o; their right is (o.z, -o.x) in the plan. Mirror if that isn't +t.
    right = (F.o[1], -F.o[0])
    flip = right[0] * F.t[0] + right[1] * F.t[1] < 0
    w = x1 - x0
    for poly in me.polygons:
        pts = []
        for i in poly.vertices:
            v = me.vertices[i].co
            u = (v.x - x0) if not flip else (w - (v.x - x0))
            pts.append(F.p(tx["s"] - w / 2 + u, tx["y"] + v.y, tx.get("d", 0.07)))
        face(("near", "trim"), pts, F.out(), tx.get("c", "#222222"))
    ob.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)


def stepped_top(length, st):
    """A crow-stepped gable's outline [(s, y)]: from the foot at both edges, n steps up to a flat top."""
    n, gf, gt, wt = st["steps"], st["foot"], st["top"], st["flat"]
    sw, sh = (length - wt) / (2 * n), (gt - gf) / n
    pts = [(0.0, gf)]
    for k in range(n):
        s = sw * (k + 1)
        pts += [(s, gf + sh * k), (s + 0.001, gf + sh * (k + 1))]
    for k in range(n):
        s = length - sw * (n - k)
        pts += [(s - 0.001, gf + sh * (n - k)), (s, gf + sh * (n - k - 1))]
    pts.append((length, gf))
    return pts


def parapet(F, length, top, st, eaves, ridge):
    """The stepped gable stands above the roof as a wall `thick` thick: its back down to the roof, the risers'
    sides, and a brick cap on every step."""
    th = st.get("thick", 0.3)
    wm, wc = surface(st["wall"])
    key = ("near", wm)
    cap = st.get("cap", wc)

    def roof_y(s):
        return eaves + (ridge - eaves) * min(s, length - s) / (length / 2)

    runs = [(a, b) for a, b in zip(top, top[1:]) if abs(a[1] - b[1]) < 1e-6 and b[0] - a[0] > 0.01]
    for (sa, y), (sb, _) in runs:
        cuts = [sa, sb] if not (sa < length / 2 < sb) else [sa, length / 2, sb]
        for s0, s1 in zip(cuts, cuts[1:]):
            face(key, [F.p(s1, roof_y(s1) - 0.2, -th), F.p(s0, roof_y(s0) - 0.2, -th), F.p(s0, y, -th), F.p(s1, y, -th)], F.out(-1), shade(wc, 0.9))
        F.box(key, sa - 0.02, sb + 0.02, y, y + 0.07, -th - 0.03, 0.035, cap)
    for (sa, ya), (sb, yb) in zip(top, top[1:]):
        if sb - sa < 0.01 and abs(yb - ya) > 0.01:  # a riser: its side, facing along the wall
            lo, hi = min(ya, yb), max(ya, yb)
            sgn = 1 if yb < ya else -1
            face(key, [F.p(sa, lo, 0), F.p(sa, lo, -th), F.p(sa, hi, -th), F.p(sa, hi, 0)], (F.t[0] * sgn, F.t[1] * sgn, 0), shade(wc, 0.85))
    for s, sgn in ((0.0, -1), (length, 1)):  # the gable's ends above the side walls' eaves
        face(key, [F.p(s, eaves - 0.2, 0), F.p(s, eaves - 0.2, -th), F.p(s, top[0][1], -th), F.p(s, top[0][1], 0)],
             (F.t[0] * sgn, F.t[1] * sgn, 0), shade(wc, 0.85))


# ---------------------------------------------------------------- roofs
def roof(vol, floor, P, L, W, rng):
    """The roof over a volume: planes with their tiles, a slab edge, ridge tiles, gutters and downpipes."""
    shape = vol["roof"]
    e, r = vol["eaves"], vol.get("ridge", vol["eaves"])
    rc = vol.get("roofc", "#4e5054")
    oe, ov = vol.get("overhang", 0.3), vol.get("verge", 0.18)
    ov0, ov1 = vol.get("verge0", ov), vol.get("verge1", ov)  # at the p0 end and the p1 end (a parapet gable: behind it)
    th = 0.16
    fascia = vol.get("fascia", "#f0eee8")
    gut = vol.get("gutter", "#8e9396")
    RK, NT = ("near", "roof"), ("near", "trim")
    planes = []  # (points (s, t, y) of the top, edges that get a fascia)
    if shape == "gable":
        k = (r - e) / (W / 2)
        ye = e - k * oe
        planes = [([(-ov0, -oe, ye), (L + ov1, -oe, ye), (L + ov1, W / 2, r), (-ov0, W / 2, r)], (0, 1, 3)),
                  ([(L + ov1, W + oe, ye), (-ov0, W + oe, ye), (-ov0, W / 2, r), (L + ov1, W / 2, r)], (0, 1, 3))]
        ridge = [((-ov0, W / 2, r), (L + ov1, W / 2, r))]
        eaves = [((-ov0, -oe, ye), (L + ov1, -oe, ye), 0), ((-ov0, W + oe, ye), (L + ov1, W + oe, ye), 2)]
    elif shape == "hip":
        k = (r - e) / (W / 2)
        ye = e - k * oe
        h = min(L, W) / 2
        a, b = h, max(h, L - h)
        planes = [([(-oe, -oe, ye), (L + oe, -oe, ye), (b, W / 2, r), (a, W / 2, r)], (0,)),
                  ([(L + oe, W + oe, ye), (-oe, W + oe, ye), (a, W / 2, r), (b, W / 2, r)], (0,)),
                  ([(-oe, W + oe, ye), (-oe, -oe, ye), (a, W / 2, r)], (0,)),
                  ([(L + oe, -oe, ye), (L + oe, W + oe, ye), (b, W / 2, r)], (0,))]
        ridge = [((a, W / 2, r), (b, W / 2, r)), ((-oe, -oe, ye), (a, W / 2, r)), ((-oe, W + oe, ye), (a, W / 2, r)),
                 ((L + oe, -oe, ye), (b, W / 2, r)), ((L + oe, W + oe, ye), (b, W / 2, r))]
        eaves = [((-oe, -oe, ye), (L + oe, -oe, ye), 0), ((-oe, W + oe, ye), (L + oe, W + oe, ye), 2),
                 ((-oe, -oe, ye), (-oe, W + oe, ye), 3), ((L + oe, -oe, ye), (L + oe, W + oe, ye), 1)]
    elif shape == "shed":
        k = (r - e) / W
        ye, yr = e - k * oe, r + k * 0.15
        planes = [([(-ov0, -oe, ye), (L + ov1, -oe, ye), (L + ov1, W + 0.15, yr), (-ov0, W + 0.15, yr)], (0, 1, 2, 3))]
        ridge = []
        eaves = [((-ov0, -oe, ye), (L + ov1, -oe, ye), 0)]
    else:  # flat: a bitumen roof inside a parapet with an aluminium coping
        cop = vol.get("coping", "#b9bcbe")
        face(("near", "render"), [P(0, 0, e + 0.12), P(L, 0, e + 0.12), P(L, W, e + 0.12), P(0, W, e + 0.12)], (0, 0, 1), "#4a4b4d")
        face(("far", "render"), [P(0, 0, e + 0.12), P(L, 0, e + 0.12), P(L, W, e + 0.12), P(0, W, e + 0.12)], (0, 0, 1), "#4a4b4d")
        for edge, (s0, t0, s1, t1, ds, dt) in enumerate(((0, 0, L, 0, 0, 1), (L, 0, L, W, -1, 0), (L, W, 0, W, 0, -1), (0, W, 0, 0, 1, 0))):
            # inward (ds, dt): the coping laps 3 cm outside the wall and 25 cm in, on top of the parapet
            solid(NT, [P(s + ds * k, t + dt * k, y) for s, t in ((s0, t0), (s1, t1)) for k in (-0.03, 0.25) for y in (e + 0.27, e + 0.33)], cop)
            if edge in vol.get("railing", []):  # a glass railing round a roof terrace: posts, panes, a rail
                n = max(1, round(math.hypot(s1 - s0, t1 - t0) / 1.5))
                for i in range(n + 1):
                    f = i / n
                    s, t = s0 + (s1 - s0) * f + ds * 0.12, t0 + (t1 - t0) * f + dt * 0.12
                    solid(NT, [P(s + a, t + c, y) for a in (-0.03, 0.03) for c in (-0.03, 0.03) for y in (e + 0.33, e + 1.35)], "#2c2e30")
                a, b = P(s0 + ds * 0.12, t0 + dt * 0.12, e + 0.4), P(s1 + ds * 0.12, t1 + dt * 0.12, e + 0.4)
                pane = [a, b, (b[0], b[1], b[2] + 0.9), (a[0], a[1], a[2] + 0.9)]
                face(("near", "glass"), pane, None, "#9fb0b5")          # both sides: seen from the street and the terrace
                face(("near", "glass"), [(q[0], q[1], q[2] + 0.002) for q in pane[::-1]], None, "#9fb0b5")
                solid(NT, [P(s + ds * k, t + dt * k, e + y) for s, t in ((s0, t0), (s1, t1)) for k in (0.09, 0.15) for y in (1.33, 1.38)], "#2c2e30")
        return
    for pts, fascia_edges in planes:
        top = [P(*q) for q in pts]
        out = (0, 0, 1)
        if len(top) == 4:
            grid(RK, top[0], top[1], top[2], top[3], out, rc, 1.2)
        else:
            grid_tri(RK, top[0], top[1], top[2], out, rc, 1.2)
        face(("far", "roof"), top, out, shade(rc, 0.9))
        # The slab: underside and edges in the fascia colour, the edges facing out from the plane's middle.
        bot = [(q[0], q[1], q[2] - th) for q in top]
        face(NT, bot, (0, 0, -1), shade(fascia, 0.8))
        cx, cz = sum(q[0] for q in top) / len(top), sum(q[1] for q in top) / len(top)
        for i in fascia_edges:
            a, b = i, (i + 1) % len(top)
            mx, mz = (top[a][0] + top[b][0]) / 2, (top[a][1] + top[b][1]) / 2
            face(NT, [bot[a], bot[b], top[b], top[a]], (mx - cx, mz - cz, 0), fascia)
    for (a, b) in ridge:
        A, B = Vector(P(*a)), Vector(P(*b))
        d = (B - A)
        plan = Vector((d.x, d.y, 0))
        if plan.length < 0.05:
            continue
        side = Vector((plan.y, -plan.x, 0)).normalized() * 0.11
        up = Vector((0, 0, 0.09))
        solid(NT, [tuple(A + side), tuple(B + side), tuple(A - side), tuple(B - side), tuple(A + up), tuple(B + up),
                   tuple(A - up * 0.6), tuple(B - up * 0.6)], shade(rc, 0.8))
    for (a, b, edge) in eaves:
        if edge in vol.get("no_gutter", []):
            continue
        A, B = Vector(P(*a)), Vector(P(*b))
        d = (B - A).normalized()
        o = Vector((d.y, -d.x, 0))
        mid = (A + B) / 2
        cen = Vector(P(L / 2, W / 2, e))
        if o.dot(mid - cen) < 0:
            o = -o
        g0 = A + o * 0.07 - Vector((0, 0, 0.12))
        g1 = B + o * 0.07 - Vector((0, 0, 0.12))
        solid(NT, [tuple(g0 + o * 0.07), tuple(g1 + o * 0.07), tuple(g0 - o * 0.06), tuple(g1 - o * 0.06),
                   tuple(g0 + o * 0.07 + Vector((0, 0, 0.12))), tuple(g1 + o * 0.07 + Vector((0, 0, 0.12))),
                   tuple(g0 - o * 0.06 + Vector((0, 0, 0.1))), tuple(g1 - o * 0.06 + Vector((0, 0, 0.1)))], gut)
        if vol.get("downpipes", True):
            pipes = vol.get("downpipes", True)
            ts = (0.35, (B - A).length - 0.35) if pipes is True else [(B - A).length * f for f in pipes]
            for t in ts:
                q = A + d * t
                wall_pt = q - o * (oe - 0.1)
                ground = terrain(wall_pt.x, wall_pt.y) - 0.05
                top_p = wall_pt.copy()
                top_p.z = q.z - 0.15
                bot_p = wall_pt.copy()
                bot_p.z = ground
                tube(NT, tuple(top_p), tuple(bot_p), 0.045, gut)
                tube(NT, tuple(q - Vector((0, 0, 0.12))), tuple(top_p + Vector((0, 0, 0.02))), 0.04, gut)
    for c in vol.get("chimneys", []):
        a = c[0] * L
        t = c[1] if len(c) > 1 else W / 2
        cw, cd, ch = (c[2], c[3], c[4]) if len(c) > 4 else (0.55, 0.45, 0.9)
        cc = vol.get("chimney", "#9b4f3a")
        base = e
        topy = r + ch if shape != "shed" else max(e, r) + ch
        solid(("near", "brick"), [P(a + sa, t + ta, y) for sa in (-cw / 2, cw / 2) for ta in (-cd / 2, cd / 2) for y in (base, topy)], cc)
        solid(("far", "brick"), [P(a + sa, t + ta, y) for sa in (-cw / 2, cw / 2) for ta in (-cd / 2, cd / 2) for y in (base, topy)], cc)
        solid(("near", "render"), [P(a + sa, t + ta, y) for sa in (-cw / 2 - 0.05, cw / 2 + 0.05) for ta in (-cd / 2 - 0.05, cd / 2 + 0.05)
                                   for y in (topy, topy + 0.08)], "#8a8884")
    for rw in vol.get("roofwin", []):
        # A roof window: side 0 (the p0-p1 slope) or 1, at a (along, m) and t (up the slope, 0..1), w by h m.
        side, a, t, w, hgt = rw
        k = (r - e) / (W / 2)
        def onroof(s, f, lift):
            if side == 0:
                tt = -oe + (W / 2 + oe) * f
            else:
                tt = W + oe - (W / 2 + oe) * f
            y = e + k * (min(tt, W - tt))
            return P(s, tt, y + lift)
        f0 = t
        f1 = t + hgt / math.hypot(W / 2 + oe, (r - e) + k * oe)
        pts = [onroof(a - w / 2, f0, 0.02), onroof(a + w / 2, f0, 0.02), onroof(a + w / 2, f1, 0.02), onroof(a - w / 2, f1, 0.02)]
        hi = [(p[0], p[1], p[2] + 0.08) for p in pts]
        solid(NT, pts + hi, "#3a3d40")
        inner = [onroof(a - w / 2 + 0.07, f0 + 0.02, 0.105), onroof(a + w / 2 - 0.07, f0 + 0.02, 0.105),
                 onroof(a + w / 2 - 0.07, f1 - 0.02, 0.105), onroof(a - w / 2 + 0.07, f1 - 0.02, 0.105)]
        face(("near", "glass"), inner, (0, 0, 1), "#30383d")


# ---------------------------------------------------------------- houses
solids = []      # [ring, height above the ground] for walking into (new things only)
replaces = []
for b in SPEC["houses"]:
    rng = random.Random(b["id"])
    for gi in b.get("grb", []):
        replaces.append(NB["buildings"][gi]["p"])
    fx, fz = b["floor_at"]
    floor = terrain(fx, fz) + b.get("floor_lift", 0.05)
    for vol in b["vols"]:
        p = vol["p"]
        lowest = min(terrain(x, z) for x, z in p) - 0.4 - floor
        # The volume's plan may be any four-sided shape (the GRB's are seldom square): s along p0-p1, t across
        # towards p3, bilinear between the corners (and straight on beyond them, for the overhangs).
        L = (math.dist(p[0], p[1]) + math.dist(p[3], p[2])) / 2
        W = (math.dist(p[0], p[3]) + math.dist(p[1], p[2])) / 2

        def P(s, t, y, p=p, L=L, W=W, floor=floor):
            fu, fv = s / L, t / W
            w = ((1 - fu) * (1 - fv), fu * (1 - fv), fu * fv, (1 - fu) * fv)
            return (sum(w[i] * p[i][0] for i in range(4)), sum(w[i] * p[i][1] for i in range(4)), floor + y)

        shape = vol["roof"]
        e, r = vol["eaves"], vol.get("ridge", vol["eaves"])
        cen = (sum(x for x, _ in p) / 4, sum(z for _, z in p) / 4)
        for i in range(4):
            if i in vol.get("skip", []):
                continue
            a, bb = p[i], p[(i + 1) % 4]
            t = Vector((bb[0] - a[0], bb[1] - a[1], 0))
            length = t.length
            t.normalize()
            o = Vector((t.y, -t.x, 0))
            mid = ((a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2)
            if o.x * (mid[0] - cen[0]) + o.y * (mid[1] - cen[1]) < 0:
                o = -o
            F = Frame(a, (t.x, t.y), (o.x, o.y), floor)
            par = 0.3 if shape == "flat" else 0.0
            if shape == "gable" and i in (1, 3):
                top = [(0, e), (length / 2, r), (length, e)]
            elif shape == "shed" and i == 1:
                top = [(0, e), (length, r)]
            elif shape == "shed" and i == 3:
                top = [(0, r), (length, e)]
            elif shape == "shed" and i == 2:
                top = [(0, r), (length, r)]
            else:
                top = [(0, e + par), (length, e + par)]
            fs = dict(b.get("style", {}))
            fs.update(vol.get("style", {}))
            fs.update(vol.get("faces", {}).get(str(i), {}))
            if shape == "gable" and i in (1, 3) and "gablewall" in vol and "wall" not in vol.get("faces", {}).get(str(i), {}):
                fs["wall"] = vol["gablewall"]
            st = vol.get("stepped")
            if st and st["face"] == i:
                top = stepped_top(length, st)
            holes = layout(fs, length) if str(i) in vol.get("faces", {}) else []
            spec = {"wall": vol.get("wall", b.get("wall", "brick:#a85a42")), "plinth": vol.get("plinth", b.get("plinth"))}
            facade(F, length, top, holes, spec, fs, lowest, rng)
            if st and st["face"] == i:
                parapet(F, length, top, {"wall": fs.get("wall", spec["wall"]), **st}, e, r)
        roof({**b.get("roofstyle", {}), **vol}, floor, P, L, W, rng)

# ---------------------------------------------------------------- fittings on the square and the street
FITTINGS = []
for fit in SPEC.get("fittings", []):
    if fit["k"] == "bollards":  # a row of n bollards from p to q
        (ax, az), (bx, bz), n = fit["p"], fit["q"], fit["n"]
        FITTINGS += [{"k": "bollard", "p": [ax + (bx - ax) * i / (n - 1), az + (bz - az) * i / (n - 1)]} for i in range(n)]
    else:
        FITTINGS.append(fit)
for fit in FITTINGS:
    k = fit["k"]
    x, z = fit["p"]
    g = terrain(x, z)
    if k == "bollard":
        tube(("near", "trim"), (x, z, g - 0.1), (x, z, g + 0.85), 0.07, "#3b3e41", seg=8)
        tube(("near", "trim"), (x, z, g + 0.85), (x, z, g + 0.92), 0.05, "#3b3e41", seg=8)
        solids.append(([[x - 0.1, z - 0.1], [x + 0.1, z - 0.1], [x + 0.1, z + 0.1], [x - 0.1, z + 0.1]], 0.95))
    elif k == "planter":
        w, d, yaw = fit.get("w", 1.2), fit.get("d", 1.2), fit.get("yaw", 0.0)
        cu, su = math.cos(yaw), math.sin(yaw)
        ring = [(x + cu * a - su * c, z + su * a + cu * c) for a, c in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2))]
        solid(("near", "render"), [(px, pz, y) for px, pz in ring for y in (g - 0.1, g + 0.55)], "#8d8c88")
        rng = random.Random(f"{x},{z}")
        for n in range(5):
            bx, bz = x + rng.uniform(-w / 3, w / 3), z + rng.uniform(-d / 3, d / 3)
            r = rng.uniform(0.25, 0.4)
            pts = []
            for i in range(1, 3):
                th = math.pi * i / 3
                for kk in range(6):
                    a = 2 * math.pi * (kk + 0.5 * i) / 6
                    pts.append((bx + r * math.sin(th) * math.cos(a), bz + r * math.sin(th) * math.sin(a), g + 0.5 + r * (1 - math.cos(th))))
            pts.append((bx, bz, g + 0.5 + 2 * r))
            solid(("near", "trim"), pts, rng.choice(["#4f6b3a", "#5a7642", "#47603a"]))
        solids.append(([list(q) for q in ring], 0.6))
    elif k == "bench":
        yaw = fit.get("yaw", 0.0)
        cu, su = math.cos(yaw), math.sin(yaw)
        def B(a, c, y):
            return (x + cu * a - su * c, z + su * a + cu * c, g + y)
        for a in (-0.7, 0.7):
            solid(("near", "trim"), [B(a + da, c, y) for da in (-0.04, 0.04) for c in (-0.22, 0.22) for y in (0, 0.42)], "#3a3c3e")
        for c in (-0.18, -0.06, 0.06, 0.18):
            solid(("near", "trim"), [B(a, c + dc, y) for a in (-0.9, 0.9) for dc in (-0.05, 0.05) for y in (0.42, 0.46)], "#8a6a4a")
        for y in (0.6, 0.75):
            solid(("near", "trim"), [B(a, 0.24 + dc, y + dy) for a in (-0.9, 0.9) for dc in (-0.02, 0.02) for dy in (-0.05, 0.05)], "#8a6a4a")
        solids.append(([list(B(a, c, 0)[:2]) for a, c in ((-0.9, -0.25), (0.9, -0.25), (0.9, 0.28), (-0.9, 0.28))], 0.8))
    elif k == "flag":  # a feather flag in one plain colour (no lettering): pole, cloth curved at the top, cross foot
        yaw, c, h = fit.get("yaw", 0.0), fit["c"], fit.get("h", 2.6)
        ux, uz = math.cos(yaw), math.sin(yaw)        # the cloth hangs out this way from the pole
        tube(("near", "trim"), (x, z, g + 0.05), (x, z, g + h), 0.02, "#3a3c3e", seg=6)
        for a in (0.0, math.pi / 2):
            ca, sa = math.cos(a), math.sin(a)
            solid(("near", "trim"), [(x + ca * dx - sa * dw, z + sa * dx + ca * dw, g + y)
                                     for dx in (-0.35, 0.35) for dw in (-0.03, 0.03) for y in (0.0, 0.05)], "#2a2b2d")
        pts = []
        for i in range(7):  # the cloth's outer edge: straight, then curving in to the top of the pole
            t = i / 6
            y = g + 0.35 + (h - 0.5) * t
            w = 0.55 * (1 - max(0.0, t - 0.6) ** 2 / 0.16 * 0.6)
            pts.append((x + ux * w, z + uz * w, y))
        cloth = [(x, z, g + 0.35)] + pts + [(x, z, g + h - 0.05)]
        face(("near", "trim"), cloth, (-uz, ux, 0), c)
        face(("near", "trim"), [(q[0] - uz * 0.004, q[1] + ux * 0.004, q[2]) for q in cloth][::-1], (uz, -ux, 0), shade(c, 0.9))
        solids.append(([[x - 0.12, z - 0.12], [x + 0.12, z - 0.12], [x + 0.12, z + 0.12], [x - 0.12, z + 0.12]], 2.0))
    elif k == "hangsign":  # a sign hanging from a wrought bracket on a wall: plain blue with a white disc
        yaw, c, y0 = fit.get("yaw", 0.0), fit["c"], fit.get("y", 2.6)
        ux, uz = math.cos(yaw), math.sin(yaw)        # out from the wall
        solid(("near", "trim"), [(x + ux * t + uz * s, z + uz * t - ux * s, g + y0 + yy) for t in (0.0, 0.85) for s in (-0.015, 0.015) for yy in (0.0, 0.035)], "#262626")
        solid(("near", "trim"), [(x + ux * t + uz * s, z + uz * t - ux * s, g + y0 - 0.35 + yy + t * 0.38) for t in (0.0, 0.6) for s in (-0.012, 0.012) for yy in (0.0, 0.03)], "#262626")
        sx0, sx1 = 0.15, 0.8
        solid(("near", "trim"), [(x + ux * t + uz * s, z + uz * t - ux * s, g + y0 + yy) for t in (sx0, sx1) for s in (-0.03, 0.03) for yy in (-0.62, -0.1)], c)
        for side in (1, -1):  # the mark on both faces: a white disc
            cx, cy = (sx0 + sx1) / 2, y0 - 0.36
            ring = [(x + ux * (cx + math.cos(a) * 0.15) + uz * side * 0.033, z + uz * (cx + math.cos(a) * 0.15) - ux * side * 0.033,
                     g + cy + math.sin(a) * 0.15) for a in [2 * math.pi * k / 12 for k in range(12)]]
            face(("near", "trim"), ring, (uz * side, -ux * side, 0), "#f2f2f0")
    elif k == "letterbox":  # a small letterbox on a wall
        yaw, c = fit.get("yaw", 0.0), fit.get("c", "#2f4a35")
        ux, uz = math.cos(yaw), math.sin(yaw)
        y0 = fit.get("y", 1.0)
        solid(("near", "trim"), [(x + ux * t + uz * s, z + uz * t - ux * s, g + y0 + yy) for t in (0.0, 0.16) for s in (-0.16, 0.16) for yy in (0.0, 0.32)], c)
    elif k == "line":  # paint on the paving: a white line from p to q, 12 cm wide
        x2, z2 = fit["q"]
        d = Vector((x2 - x, z2 - z, 0))
        n = max(1, math.ceil(d.length / 1.0))
        o = Vector((-d.y, d.x, 0)).normalized() * fit.get("w", 0.12) / 2
        for i in range(n):
            a, c = Vector((x, z, 0)) + d * (i / n), Vector((x, z, 0)) + d * ((i + 1) / n)
            pts = [a - o, c - o, c + o, a + o]
            face(("near", "trim"), [(q.x, q.y, terrain(q.x, q.y) + 0.035) for q in pts], (0, 0, 1), fit.get("c", "#e6e6e2"))


# ---------------------------------------------------------------- baked light: ambient occlusion and the sun
def bake():
    """Per corner: occlusion of the sky in 20 directions within 3 m, and the sun's shadow (3 rays to 120 m),
    multiplied into the colour. Occluders: everything near, the ground, the neighbouring buildings as blocks."""
    verts, polys = [], []

    def add(bm):
        off = len(verts)
        verts.extend(v.co.copy() for v in bm.verts)
        for f in bm.faces:
            polys.append([off + v.index for v in f.verts])

    for key, bm in BM.items():
        if key[0] == "near":
            bm.normal_update()
            bm.verts.ensure_lookup_table()
            bm.verts.index_update()
            add(bm)
    # The ground round the square, 4 m squares on the relief.
    x0, x1, z0, z1 = ORIGIN[0] - 140, ORIGIN[0] + 140, ORIGIN[1] - 110, ORIGIN[1] + 110
    nx, nz = int((x1 - x0) / 4), int((z1 - z0) / 4)
    off = len(verts)
    for j in range(nz + 1):
        for i in range(nx + 1):
            x, z = x0 + i * 4, z0 + j * 4
            verts.append(V(x, z, terrain(x, z) - 0.02))
    for j in range(nz):
        for i in range(nx):
            a = off + j * (nx + 1) + i
            polys.append([a, a + 1, a + nx + 2, a + nx + 1])
    # The neighbours (not ours) within 160 m as blocks to their eaves, and the church and its tower.
    ours = {json.dumps(r) for r in replaces}
    for bl in NB["buildings"]:
        if json.dumps(bl["p"]) in ours:
            continue
        ring = bl["p"]
        if min(math.dist(q, ORIGIN) for q in ring) > 160:
            continue
        g = min(terrain(x, z) for x, z in ring)
        top = g + (bl["eaves"] + bl["ridge"]) / 2
        if bl.get("landmark") == "church":
            top = g + 9.5
        n = len(ring)
        off = len(verts)
        for x, z in ring:
            verts.append(V(x, z, g - 0.5))
        for x, z in ring:
            verts.append(V(x, z, top))
        for i in range(n):
            j = (i + 1) % n
            polys.append([off + i, off + j, off + n + j, off + n + i])
        polys.append([off + n + i for i in range(n)])
        if bl.get("tower"):
            tw = bl["tower"]
            off = len(verts)
            for x, z in tw["p"]:
                verts.append(V(x, z, g))
            for x, z in tw["p"]:
                verts.append(V(x, z, g + tw["top"]))
            m = len(tw["p"])
            for i in range(m):
                j = (i + 1) % m
                polys.append([off + i, off + j, off + m + j, off + m + i])
    tree = BVHTree.FromPolygons(verts, polys, all_triangles=False, epsilon=0.0)
    sun = Vector((SUN.x, -SUN.z, SUN.y)).normalized()   # game (x, y, z) -> Blender (x, -z, y)
    # Directions over the hemisphere round +z, cosine weighted (Fibonacci spiral), turned to each normal.
    dirs = []
    n_ao = 20
    for k in range(n_ao):
        r = math.sqrt((k + 0.5) / n_ao)
        a = k * 2.399963
        dirs.append(Vector((r * math.cos(a), r * math.sin(a), math.sqrt(max(0.0, 1 - r * r)))))
    jit = [Vector((0, 0, 0)), Vector((0.02, 0.01, 0)), Vector((-0.015, 0.02, 0.01))]
    cache = {}
    count = 0
    for key, bm in BM.items():
        if key[0] != "near" or key[1] == "glass":
            continue
        lay = bm.loops.layers.float_color["Color"]
        for f in bm.faces:
            n = f.normal
            if n.length < 0.5:
                continue
            t = n.orthogonal().normalized()
            b2 = n.cross(t)
            cen = f.calc_center_median()
            for lp in f.loops:
                p = lp.vert.co  # the same point and normal give the same light, so neighbouring cells share their corners
                kk = (round(p.x, 2), round(p.y, 2), round(p.z, 2), round(n.x, 1), round(n.y, 1), round(n.z, 1))
                if kk not in cache:
                    q = p + n * 0.03
                    hit = 0.0
                    for d in dirs:
                        w = t * d.x + b2 * d.y + n * d.z
                        loc, _, _, dist = tree.ray_cast(q, w, 3.0)
                        if loc is not None:
                            hit += 1.0 - 0.5 * dist / 3.0
                    ao = 1.0 - 0.72 * hit / n_ao
                    lit = 1.0
                    if n.dot(sun) > 0.02:
                        vis = 0
                        for j in jit:
                            loc, _, _, _ = tree.ray_cast(q + j, (sun + j).normalized(), 120.0)
                            vis += loc is None
                        lit = 0.6 + 0.4 * vis / len(jit)
                    cache[kk] = ao * lit
                    count += 1
                f_ = cache[kk]
                c = lp[lay]
                lp[lay] = (c[0] * f_, c[1] * f_, c[2] * f_, 1.0)
    print(f"baked light at {count} points")


bake()


# ---------------------------------------------------------------- UVs, objects, export
def metre_uvs(bm):
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
            lp[uv].uv = (p.dot(t), p.dot(b))


root = bpy.data.objects.new("smetlede_town", None)
bpy.context.scene.collection.objects.link(root)
root["origin"] = [ORIGIN[0], ORIGIN[1]]
root["far"] = FAR
root["replaces"] = json.dumps(replaces)
root["solids"] = json.dumps(solids)
tris = {"near": 0, "far": 0}
objs = []
for (lod, name), bm in BM.items():
    if not bm.faces:
        continue
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
    bm.normal_update()
    if MATS[name][0]:
        metre_uvs(bm)
    me = bpy.data.meshes.new(f"{lod}_{name}")
    bm.to_mesh(me)
    me.materials.append(MAT[(lod, name)])
    me.set_sharp_from_angle(angle=math.radians(25))
    ob = bpy.data.objects.new(f"{lod}_{name}", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = root
    me.calc_loop_triangles()
    tris[lod] += len(me.loop_triangles)
    print(f"{lod}_{name}: {len(me.loop_triangles)} triangles, {len(me.vertices)} vertices")
    objs.append(ob)
print(f"town: {tris['near']} triangles near, {tris['far']} far, {len(SPEC['houses'])} houses; origin {ORIGIN} at {Y0:.2f} m")
bpy.ops.object.select_all(action="DESELECT")
root.select_set(True)
for o in objs:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=True, export_normals=False, export_extras=True, export_vertex_color="MATERIAL",
                          export_cameras=False, export_lights=False)


def pack(path):
    """Make the GLB small: positions as 16-bit integers (KHR_mesh_quantization, the mesh node's scale and offset
    turn them back into metres, 2 mm steps), no normals (every surface is flat: the game shades it flat), colours
    as bytes divided by COLOR_SCALE (painted brick needs more than 1 over the reddish texture; the game's material
    multiplies by it again)."""
    import struct
    import numpy as np
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
        return np.frombuffer(rows.copy().tobytes(), dtype=dtypes[a["componentType"]]).reshape(n, c)

    out = bytearray()
    views, accs = [], []

    def put(arr, ctype, typ, target, normalized=False, stride=None, minmax=False):
        while len(out) % 4:
            out.append(0)
        data = arr.tobytes()
        views.append({"buffer": 0, "byteOffset": len(out), "byteLength": len(data), **({"byteStride": stride} if stride else {}),
                      **({"target": target} if target else {})})
        out.extend(data)
        acc = {"bufferView": len(views) - 1, "componentType": ctype, "count": int(arr.shape[0]), "type": typ}
        if normalized:
            acc["normalized"] = True
        if minmax:
            v = arr[:, :3] if arr.ndim > 1 else arr
            acc["min"] = [int(x) for x in v.min(0)]
            acc["max"] = [int(x) for x in v.max(0)]
        accs.append(acc)
        return len(accs) - 1

    mesh_node = {n["mesh"]: n for n in gl["nodes"] if "mesh" in n}
    for mi, mesh in enumerate(gl["meshes"]):
        for prim in mesh["primitives"]:
            at = prim["attributes"]
            pos = read(at["POSITION"]).astype(np.float64)
            lo, hi = pos.min(0), pos.max(0)
            off, half = (lo + hi) / 2, np.maximum((hi - lo) / 2, 1e-4)
            q = np.round((pos - off) / half * 32767).astype(np.int16)
            q4 = np.zeros((len(q), 4), np.int16)
            q4[:, :3] = q
            new = {"POSITION": put(q4, 5122, "VEC3", 34962, True, 8, True)}
            accs[new["POSITION"]]["min"] = [int(x) for x in q.min(0)]
            accs[new["POSITION"]]["max"] = [int(x) for x in q.max(0)]
            if "TEXCOORD_0" in at:
                new["TEXCOORD_0"] = put(read(at["TEXCOORD_0"]).astype(np.float32), 5126, "VEC2", 34962)
            if "COLOR_0" in at:
                c = read(at["COLOR_0"]).astype(np.float64)[:, :3] / COLOR_SCALE
                c4 = np.full((len(c), 4), 255, np.uint8)
                c4[:, :3] = np.clip(np.round(c * 255), 0, 255).astype(np.uint8)
                new["COLOR_0"] = put(c4, 5121, "VEC4", 34962, True)
            idx = read(prim["indices"]).reshape(-1)
            prim["indices"] = put(idx.astype(np.uint16 if idx.max() < 65535 else np.uint32), 5123 if idx.max() < 65535 else 5125, "SCALAR", 34963)
            prim["attributes"] = new
        node = mesh_node[mi]
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


def preview(path, eye, look, lens=24):
    """A still with Eevee from game point `eye` towards `look` (x, z, y): the near copy with its textures as
    the game draws them, the church model beside it, the relief as paving, the game's sun. For showing, not shipped."""
    tex_dir = os.path.join(ROOT, "web", "public", "textures")
    tiles = {"town_brick": 1.4, "town_roof": 3.6, "plaster": 3.2}
    for (lod, name), m in MAT.items():
        if lod != "near" or not MATS[name][0]:
            continue
        tex = MATS[name][0]
        nt = m.node_tree
        img = nt.nodes.new("ShaderNodeTexImage")
        img.image = bpy.data.images.load(os.path.join(tex_dir, f"{tex}_color.webp"))
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.inputs["Scale"].default_value = (1 / tiles[tex], 1 / tiles[tex], 1)
        uvn = nt.nodes.new("ShaderNodeTexCoord")
        nt.links.new(uvn.outputs["UV"], mapping.inputs["Vector"])
        nt.links.new(mapping.outputs["Vector"], img.inputs["Vector"])
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        attr = next(n for n in nt.nodes if n.type == "VERTEX_COLOR")
        nt.links.new(img.outputs["Color"], mix.inputs["A"])
        nt.links.new(attr.outputs["Color"], mix.inputs["B"])
        nt.links.new(mix.outputs["Result"], nt.nodes["Principled BSDF"].inputs["Base Color"])
    m = MAT[("near", "glass")]
    m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.05
    for o in objs:
        o.hide_render = o.name.startswith("far_")
    # The church where the game puts it (main.ts, loadChurch), in its own model's colours.
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, "web", "public", "models", "church.glb"))
    holder = bpy.data.objects.new("church_place", None)
    bpy.context.scene.collection.objects.link(holder)
    holder.location = V(521.51, -744.15, terrain(521.51, -744.15))
    holder.rotation_euler = (0, 0, 2.525)
    added = set(bpy.data.objects) - before - {holder}
    for o in added:
        if o.parent is None:
            o.parent = holder
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in added if o.type == "MESH" for c in o.bound_box]
    if pts:
        print("church in preview:", len(added), "objects, x", min(p.x for p in pts), max(p.x for p in pts),
              "y", min(p.y for p in pts), max(p.y for p in pts), "z", min(p.z for p in pts), max(p.z for p in pts))
    # The relief round the square as grey pavers.
    gm = bpy.data.meshes.new("ground")
    vs, fs_ = [], []
    n, step = 40, 4.0
    for j in range(n + 1):
        for i in range(n + 1):
            x, z = look[0] - n * step / 2 + i * step, look[1] - n * step / 2 + j * step
            vs.append(V(x, z, terrain(x, z) - 0.03))
    for j in range(n):
        for i in range(n):
            a = j * (n + 1) + i
            fs_.append((a, a + 1, a + n + 2, a + n + 1))
    gm.from_pydata(vs, [], fs_)
    gmat = bpy.data.materials.new("ground")
    gmat.use_nodes = True
    gmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*srgb("#86847f"), 1)
    gmat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
    gm.materials.append(gmat)
    gob = bpy.data.objects.new("ground", gm)
    bpy.context.scene.collection.objects.link(gob)
    if gob.data.polygons[0].normal.z < 0:
        gm.flip_normals()
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 4.0
    sun.angle = math.radians(1.5)
    so = bpy.data.objects.new("sun", sun)
    bpy.context.scene.collection.objects.link(so)
    d = Vector((SUN.x, -SUN.z, SUN.y))
    so.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    world = bpy.data.worlds.new("sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.42, 0.6, 0.92, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.1
    sc = bpy.context.scene
    sc.world = world
    cam = bpy.data.cameras.new("cam")
    cam.lens = lens
    co = bpy.data.objects.new("cam", cam)
    sc.collection.objects.link(co)
    pe = V(eye[0], eye[1], terrain(eye[0], eye[1]) + eye[2])      # heights above the ground there
    pl = V(look[0], look[1], terrain(look[0], look[1]) + look[2])
    co.location = pe
    co.rotation_euler = (pl - pe).to_track_quat("-Z", "Y").to_euler()
    sc.camera = co
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = 1600, 1000
    sc.render.filepath = path
    sc.view_settings.view_transform = "AgX"
    sc.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    print("preview", path)


if "--preview" in argv:
    i = argv.index("--preview")
    vals = [float(v) for v in argv[i + 2:i + 8]]
    preview(argv[i + 1], tuple(vals[:3]), tuple(vals[3:6]))
