"""Hand-made houses among the generated ones, package B1: four houses in the north-west of the village.

  blender -b -P tools/village_houses_b1.py -- web/public/models [vh_farm vh_gable_house ...]

writes web/public/models/<name>.glb for each house, or for the ones named. Each stands in for one generated house:
it is found in web/src/data/village.json by a corner of its wall block, whose outline becomes the model's `replaces`
(the block stays in the data for walking into and for the server, so every wall here keeps within 0.15 m of it).
The root's `origin` lies on the ground at the middle of the front wall; heights are metres over the ground there.

A house is named by its spot in the model's metres, never by an address. Its kind, colours and main openings were
compared with street-level pictures by eye; nothing was copied, traced or sampled from them, and nothing personal is
modelled (no number, name, text, letterbox or window dressing). Materials are the game's own textures by name and
tint (`texture`, `tint` in the material's extras: docs/CREDITS.md) or flat colours per corner; no image is in a file.
Mesh names follow world/villageHouses.ts: `vh_glass` gets a room behind it (world/glassLook.ts), `vh_roof`,
`vh_paving`, `vh_stone` take the snow and the wet, the `_small` meshes are drawn within 120 m.
"""
import json
import math
import random
import sys
from collections import defaultdict
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(args[0] if args else ROOT / "web/public/models").resolve()
ONLY = set(args[1:])
VILLAGE = json.loads((ROOT / "web/src/data/village.json").read_text(encoding="utf-8"))
SIZES = json.loads((ROOT / "web/public/textures/sizes.json").read_text(encoding="utf-8"))

# The ground: the same centimetre grid and triangle diagonal as shared/terrain.mjs (as tools/kouter_house.py).
GRID = json.loads((ROOT / "web/shared/terrain.json").read_text(encoding="utf-8"))
_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
_H = []
_at = 0
for _j in range(GRID["nz"]):
    for _i in range(GRID["nx"]):
        if GRID["d"][_at] == "~":
            _r = sum(_DIGITS.index(GRID["d"][_at + k]) << (6 * (3 - k)) for k in (1, 2, 3)) - (1 << 17)
            _at += 4
        else:
            _r = _DIGITS.index(GRID["d"][_at]) - 32
            _at += 1
        _n, _nx = len(_H), GRID["nx"]
        _g = _H[_n - 1] + _H[_n - _nx] - _H[_n - _nx - 1] if _i and _j else _H[_n - 1] if _i else _H[_n - _nx] if _j else 0
        _H.append(_g + _r)


def terrain(x, z):
    gx = max(0, min((x - GRID["x0"]) / GRID["step"], GRID["nx"] - 1.000001))
    gz = max(0, min((z - GRID["z0"]) / GRID["step"], GRID["nz"] - 1.000001))
    i, j = int(gx), int(gz)
    u, v = gx - i, gz - j
    n, nx = j * GRID["nx"] + i, GRID["nx"]
    a, b = _H[n], _H[n + nx + 1]
    return (a + u * (_H[n + 1] - a) + v * (b - _H[n + 1]) if u >= v else a + v * (_H[n + nx] - a) + u * (b - _H[n + nx])) / 100


def linear(hexcolor):
    h = hexcolor.lstrip("#")
    out = []
    for k in (0, 2, 4):
        c = int(h[k:k + 2], 16) / 255
        out.append(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4)
    return tuple(out)


def newell(pts):
    n = [0.0, 0.0, 0.0]
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        n[0] += (a[1] - b[1]) * (a[2] + b[2])
        n[1] += (a[2] - b[2]) * (a[0] + b[0])
        n[2] += (a[0] - b[0]) * (a[1] + b[1])
    return n


def clip_half(poly, f):
    """The part of a polygon (2D points) where f(p) >= 0, f linear."""
    out = []
    for i, a in enumerate(poly):
        b = poly[(i + 1) % len(poly)]
        fa, fb = f(a), f(b)
        if fa >= 0:
            out.append(a)
        if (fa >= 0) != (fb >= 0):
            t = fa / (fa - fb)
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def area(poly):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(poly, poly[1:] + poly[:1])) / 2


def inside(ring, p):
    hit = False
    for i, a in enumerate(ring):
        b = ring[i - 1]
        if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]:
            hit = not hit
    return hit


def profile(points):
    """A piecewise linear function of s through (s, y) points (constant beyond the ends)."""
    if isinstance(points, (int, float)):
        return lambda s: points, []
    pts = sorted(points)

    def f(s):
        if s <= pts[0][0]:
            return pts[0][1]
        for (s0, y0), (s1, y1) in zip(pts, pts[1:]):
            if s <= s1:
                return y0 if s1 - s0 < 1e-9 else y0 + (y1 - y0) * (s - s0) / (s1 - s0)
        return pts[-1][1]
    return f, [s for s, _ in pts]


class Opening:
    """A hole in a wall: s its middle along the wall, y its bottom, w by h. `kind`: window, door, garage, vent."""

    def __init__(self, s, y, w, h, kind="window", arch=False, reveal=.16, frame="#3b3d3e", cols=1, transom=None,
                 sill=True, lintel=None, surround=None, door="#bfc2c0", panels="plank", header=False, step=None):
        self.__dict__.update(locals())
        del self.__dict__["self"]


class House:
    def __init__(self, name, corner, front, base, meshes):
        self.name = name
        blocks = [p for p in VILLAGE["prisms"] if any(abs(q[0] - corner[0]) < .02 and abs(q[1] - corner[1]) < .02 for q in p["p"][0])]
        if not blocks:
            raise ValueError(f"{name}: no wall block has the corner {corner}; the data changed, review the house")
        self.outline = max((b["p"][0] for b in blocks), key=len)
        a, b = Vector(front[0]), Vector(front[1])
        along = (b - a).normalized()
        depth = Vector((along.y, -along.x))
        origin = (a + b) / 2
        middle = Vector(tuple(sum(c) / len(c) for c in zip(*self.outline)))
        if (middle - origin).dot(depth) < 0:
            along, depth = -along, -depth
        self.origin, self.along, self.depth = origin, along, depth
        self.ground0 = terrain(*origin)
        self.base = base - self.ground0  # the data's heights are over `base`; ours over the ground at the origin
        self.ring = [self.local(p) for p in self.outline]
        self.meshes = meshes
        self.faces = defaultdict(list)
        lows = [self.ground(*p) for p in self.ring]
        us, ds = [p[0] for p in self.ring], [p[1] for p in self.ring]
        lows += [self.ground(min(us) + (max(us) - min(us)) * i / 6, min(ds) + (max(ds) - min(ds)) * j / 6)
                 for i in range(7) for j in range(7) if inside(self.ring, (min(us) + (max(us) - min(us)) * i / 6, min(ds) + (max(ds) - min(ds)) * j / 6))]
        self.foot = min(lows) - .35  # walls go this deep: under the lowest ground round them
        self.rng = random.Random(name)

    # --- places --------------------------------------------------------------------------------------------------
    def local(self, p):
        d = Vector(p) - self.origin
        return (round(d.dot(self.along), 4), round(d.dot(self.depth), 4))

    def world(self, u, d):
        return self.origin + self.along * u + self.depth * d

    def ground(self, u, d):
        return terrain(*self.world(u, d)) - self.ground0

    def vertex(self, p):
        w = self.along * p[0] + self.depth * p[1]
        return (w.x, -w.y, p[2])

    # --- faces ---------------------------------------------------------------------------------------------------
    def poly(self, mesh, pts, facing=None, color=None):
        if len(pts) < 3:
            return
        n = newell(pts)
        if n[0] ** 2 + n[1] ** 2 + n[2] ** 2 < 1e-10:
            return  # no area
        if facing is not None:
            if n[0] * facing[0] + n[1] * facing[1] + n[2] * facing[2] < 0:
                pts = pts[::-1]
        self.faces[mesh].append(([tuple(p) for p in pts], color))

    def box(self, mesh, u0, u1, d0, d1, y0, y1, color=None, bottom=False):
        c = [(u0, d0), (u1, d0), (u1, d1), (u0, d1)]
        self.prism(mesh, c, y0, y1, color, bottom=bottom)

    def prism(self, mesh, ring, y0, y1, color=None, top=True, bottom=False):
        ring = list(ring)
        if area(ring) < 0:
            ring.reverse()
        for i, a in enumerate(ring):
            b = ring[(i + 1) % len(ring)]
            out = (b[1] - a[1], -(b[0] - a[0]), 0)
            self.poly(mesh, [(a[0], a[1], y0), (b[0], b[1], y0), (b[0], b[1], y1), (a[0], a[1], y1)], out, color)
        if top:
            self.poly(mesh, [(u, d, y1) for u, d in ring], (0, 0, 1), color)
        if bottom:
            self.poly(mesh, [(u, d, y0) for u, d in ring], (0, 0, -1), color)

    def seg(self, mesh, a, b, width, y0, y1, color=None, bottom=False):
        """A box along a plan segment a to b, `width` across it."""
        t = Vector((b[0] - a[0], b[1] - a[1])).normalized() * 1
        n = Vector((t.y, -t.x)) * (width / 2)
        self.prism(mesh, [(a[0] + n.x, a[1] + n.y), (b[0] + n.x, b[1] + n.y), (b[0] - n.x, b[1] - n.y), (a[0] - n.x, a[1] - n.y)], y0, y1, color, bottom=bottom)

    def rod(self, mesh, a, b, r, sides=6, color=None, caps=True):
        a, b = Vector(a), Vector(b)
        axis = (b - a).normalized()
        u = axis.cross(Vector((0, 0, 1)))
        if u.length < .01:
            u = axis.cross(Vector((1, 0, 0)))
        u.normalize()
        v = axis.cross(u)
        ring = lambda c: [c + r * (math.cos(i * math.tau / sides) * u + math.sin(i * math.tau / sides) * v) for i in range(sides)]
        ra, rb = ring(a), ring(b)
        for i in range(sides):
            j = (i + 1) % sides
            mid = (ra[i] + ra[j]) / 2 - a
            self.poly(mesh, [ra[i], ra[j], rb[j], rb[i]], mid, color)
        if caps:
            self.poly(mesh, ra, -axis, color)
            self.poly(mesh, rb, axis, color)

    def blob(self, mesh, u, d, y, radii, rings=4, steps=8, color=None):
        for j in range(rings):
            for i in range(steps):
                pts = []
                for x, z in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)):
                    a, b = x * math.tau / steps, z * math.pi / rings
                    pts.append((u + radii[0] * math.cos(a) * math.sin(b), d + radii[1] * math.sin(a) * math.sin(b), y + radii[2] * math.cos(b)))
                a, b = (i + .5) * math.tau / steps, (j + .5) * math.pi / rings
                self.poly(mesh, pts, (math.cos(a) * math.sin(b), math.sin(a) * math.sin(b), math.cos(b)), color)

    # --- walls ---------------------------------------------------------------------------------------------------
    def wall(self, a, b, top, openings=(), mesh="vh_brick", color=None, bottom=None, bands=(), out=None):
        """The outer face of a wall on the plan line a to b, outward away from the house (or toward `out`), cut round
        its openings. `top`, `bottom`: metres, or (s, y) points along it (s from a). `bands`: (up to y, mesh, colour)."""
        a, b = Vector(a), Vector(b)
        L = (b - a).length
        t = (b - a) / L
        n = Vector((t.y, -t.x))
        mid = (a + b) / 2
        if out is not None:
            if n.dot(Vector(out)) < 0:
                n = -n
        elif inside(self.ring, tuple(mid + n * .05)) and not inside(self.ring, tuple(mid - n * .05)):
            n = -n
        N = (n.x, n.y, 0)
        T = (t.x, t.y, 0)
        W = lambda s, y, dep=0.0: (a.x + t.x * s - n.x * dep, a.y + t.y * s - n.y * dep, y)
        topf, tops = profile(top)
        botf, bots = profile(self.foot if bottom is None else bottom)
        holes = [(o.s - o.w / 2, o.s + o.w / 2, o.y, o.y + o.h) for o in openings]
        xs = sorted({0.0, L, *[s for s in tops + bots if 0 < s < L], *[x for h in holes for x in h[:2] if 0 < x < L]})
        ys = sorted({*[y for h in holes for y in h[2:]], *[band[0] for band in bands]})
        for x0, x1 in zip(xs, xs[1:]):
            if x1 - x0 < 1e-6:
                continue
            xm = (x0 + x1) / 2
            lo, hi = botf(xm), topf(xm)
            if hi <= lo + 1e-6:
                continue
            cuts = [lo] + [y for y in ys if lo < y < hi] + [hi]
            runs = []
            for y0, y1 in zip(cuts, cuts[1:]):
                ym = (y0 + y1) / 2
                if any(h[0] <= xm <= h[1] and h[2] <= ym <= h[3] for h in holes):
                    runs.append(None)
                    continue
                look = next(((m, c) for up, m, c in sorted(bands, key=lambda z: z[0]) if ym < up), (mesh, color))
                if runs and runs[-1] and runs[-1][2] == look:
                    runs[-1][1] = y1
                else:
                    runs.append([y0, y1, look])
            for run in runs:
                if not run:
                    continue
                y0, y1, (m, c) = run
                first, last = y0 == cuts[0], y1 == cuts[-1]
                rect = [(x0, y0 if not first else min(y0, botf(x0), botf(x1)) - 1), (x1, y0 if not first else min(y0, botf(x0), botf(x1)) - 1),
                        (x1, y1 if not last else max(y1, topf(x0), topf(x1)) + 1), (x0, y1 if not last else max(y1, topf(x0), topf(x1)) + 1)]
                if first:
                    ya, yb = botf(x0), botf(x1)
                    rect = clip_half(rect, lambda p: p[1] - (ya + (yb - ya) * (p[0] - x0) / (x1 - x0)))
                if last:
                    ya, yb = topf(x0), topf(x1)
                    rect = clip_half(rect, lambda p: (ya + (yb - ya) * (p[0] - x0) / (x1 - x0)) - p[1])
                if not first:
                    rect = clip_half(rect, lambda p: p[1] - y0)
                if not last:
                    rect = clip_half(rect, lambda p: y1 - p[1])
                if len(rect) >= 3 and abs(area(rect)) > 1e-5:
                    self.poly(m, [W(x, y) for x, y in rect], N, c)
        for o in openings:
            self.opening(o, W, N, T, mesh, color, bands)
        return W, N, T

    def wbox(self, W, N, T, mesh, s0, s1, y0, y1, d0, d1, color=None, back=False):
        """A box in a wall's own measures: s along it, y up, d into it (negative: in front of it)."""
        c = lambda s, y, d: W(s, y, d)
        up, dn = (0, 0, 1), (0, 0, -1)
        out = N
        inn = (-N[0], -N[1], 0)
        self.poly(mesh, [c(s0, y0, d0), c(s1, y0, d0), c(s1, y1, d0), c(s0, y1, d0)], out, color)
        if back:
            self.poly(mesh, [c(s0, y0, d1), c(s1, y0, d1), c(s1, y1, d1), c(s0, y1, d1)], inn, color)
        self.poly(mesh, [c(s0, y1, d0), c(s1, y1, d0), c(s1, y1, d1), c(s0, y1, d1)], up, color)
        self.poly(mesh, [c(s0, y0, d0), c(s1, y0, d0), c(s1, y0, d1), c(s0, y0, d1)], dn, color)
        self.poly(mesh, [c(s0, y0, d0), c(s0, y1, d0), c(s0, y1, d1), c(s0, y0, d1)], (-T[0], -T[1], 0), color)
        self.poly(mesh, [c(s1, y0, d0), c(s1, y1, d0), c(s1, y1, d1), c(s1, y0, d1)], T, color)

    def opening(self, o, W, N, T, mesh, color, bands):
        s0, s1, y0, y1, r = o.s - o.w / 2, o.s + o.w / 2, o.y, o.y + o.h, o.reveal
        R = o.w / 2
        spring = y1 - R if o.arch else y1
        side_look = lambda y: next(((m, c) for up, m, c in sorted(bands, key=lambda z: z[0]) if y < up), (mesh, color))
        # The reveal, in the wall's own stuff (its foot where it runs through the foot)
        for s, facing in ((s0, T), (s1, (-T[0], -T[1], 0))):
            cuts = [y0] + [b[0] for b in sorted(bands) if y0 < b[0] < spring] + [spring]
            for ya, yb in zip(cuts, cuts[1:]):
                m, c = side_look((ya + yb) / 2)
                self.poly(m, [W(s, ya, 0), W(s, ya, r), W(s, yb, r), W(s, yb, 0)], facing, c)
        if not (o.sill and o.kind == "window"):
            m, c = side_look(y0 + .01)
            self.poly(m, [W(s0, y0, 0), W(s1, y0, 0), W(s1, y0, r), W(s0, y0, r)], (0, 0, 1), c)
        steps = 10
        arc = [(o.s + R * math.cos(math.pi * i / steps), spring + R * math.sin(math.pi * i / steps)) for i in range(steps + 1)]
        if o.arch:
            for (xa, ya), (xb, yb) in zip(arc, arc[1:]):
                toward = tuple(T[k] * (o.s - (xa + xb) / 2) + (0, 0, 1)[k] * (spring - (ya + yb) / 2) for k in range(3))
                self.poly(mesh, [W(xa, ya, 0), W(xb, yb, 0), W(xb, yb, r), W(xa, ya, r)], toward, color)
                self.poly(mesh, [W(xa, ya), W(xb, yb), W(xb, y1), W(xa, y1)], N, color)
                if o.header:  # a ring of headers, a little proud of the wall
                    k = .23
                    p = [(o.s + (x - o.s) * (R + k) / R, spring + (y - spring) * (R + k) / R) for x, y in ((xa, ya), (xb, yb))]
                    self.poly(mesh, [W(xa, ya, -.02), W(xb, yb, -.02), W(*p[1], -.02), W(*p[0], -.02)], N, color)
                    self.poly(mesh, [W(*p[0], -.02), W(*p[1], -.02), W(*p[1], 0), W(*p[0], 0)],
                              tuple(T[q] * ((p[0][0] + p[1][0]) / 2 - o.s) + (0, 0, 1)[q] * ((p[0][1] + p[1][1]) / 2 - spring) for q in range(3)), color)
        else:
            m, c = side_look(y1 - .01)
            self.poly(m, [W(s0, y1, 0), W(s1, y1, 0), W(s1, y1, r), W(s0, y1, r)], (0, 0, -1), c)
        shape = [(s0, y0), (s1, y0)] + ([p for p in arc] if o.arch else [(s1, y1), (s0, y1)])
        fw = .065
        fr = "vh_frames_small"
        if o.kind == "window":
            self.poly("vh_glass", [W(x, y, r) for x, y in shape], N)
            self.wbox(W, N, T, fr, s0, s0 + fw, y0, spring, r - .07, r, o.frame)
            self.wbox(W, N, T, fr, s1 - fw, s1, y0, spring, r - .07, r, o.frame)
            self.wbox(W, N, T, fr, s0 + fw, s1 - fw, y0, y0 + fw, r - .07, r, o.frame)
            if o.arch:
                inner = [(o.s + (x - o.s) * (R - fw) / R, spring + (y - spring) * (R - fw) / R) for x, y in arc]
                for i in range(steps):
                    self.poly(fr, [W(*arc[i], r - .07), W(*arc[i + 1], r - .07), W(*inner[i + 1], r - .07), W(*inner[i], r - .07)], N, o.frame)
                self.wbox(W, N, T, fr, s0 + fw, s1 - fw, spring - .03, spring + .02, r - .06, r, o.frame)
            else:
                self.wbox(W, N, T, fr, s0 + fw, s1 - fw, y1 - fw, y1, r - .07, r, o.frame)
            for k in range(1, o.cols):
                x = s0 + o.w * k / o.cols
                self.wbox(W, N, T, fr, x - .03, x + .03, y0 + fw, spring if o.arch else y1 - fw, r - .065, r, o.frame)
            if o.transom:
                y = y0 + o.h * o.transom
                self.wbox(W, N, T, fr, s0 + fw, s1 - fw, y - .03, y + .03, r - .065, r, o.frame)
            if o.sill:
                self.wbox(W, N, T, "vh_stone", s0 - .05, s1 + .05, y0 - .06, y0, -.06, r, "#a8a59f")
        elif o.kind == "door":
            self.wbox(W, N, T, "vh_trim", s0, s1, y0, y1, r - .05, r, o.door)
            if o.panels == "plank":
                k = .14
                x = s0 + k
                while x < s1 - .05:
                    self.wbox(W, N, T, fr, x - .008, x + .008, y0 + .02, y1 - .02, r - .056, r - .05, "#8f9391")
                    x += k
            else:  # a glazed upper panel and a plain lower one
                self.poly("vh_glass", [W(s0 + .18, y0 + 1.15, r - .052), W(s1 - .18, y0 + 1.15, r - .052), W(s1 - .18, y1 - .2, r - .052), W(s0 + .18, y1 - .2, r - .052)], N)
                self.wbox(W, N, T, fr, s0 + .16, s1 - .16, y0 + .2, y0 + .95, r - .07, r - .05, o.door)
            self.wbox(W, N, T, "vh_metal_small", s1 - .14, s1 - .1, y0 + .98, y0 + 1.1, r - .12, r - .05, "#9a9a96")
            self.wbox(W, N, T, fr, s0, s0 + .05, y0, y1, r - .06, r, o.frame)
            self.wbox(W, N, T, fr, s1 - .05, s1, y0, y1, r - .06, r, o.frame)
            self.wbox(W, N, T, fr, s0, s1, y1 - .05, y1, r - .06, r, o.frame)
        elif o.kind == "garage":
            self.wbox(W, N, T, "vh_trim", s0, s1, y0, y1, r - .04, r, o.door)
            k = y0 + .52
            while k < y1 - .1:
                self.wbox(W, N, T, fr, s0 + .02, s1 - .02, k - .012, k + .012, r - .046, r - .04, "#c9c9c4")
                k += .52
        elif o.kind == "vent":
            self.poly("vh_trim", [W(x, y, r) for x, y in shape], N, "#1d1d1c")
        if o.lintel:
            self.wbox(W, N, T, "vh_stone", s0 - .1, s1 + .1, y1, y1 + .16, -.02, 0, o.lintel)
        if o.surround:
            b = .12
            self.wbox(W, N, T, "vh_stone", s0 - b, s0, y0 - (b if o.kind == "window" else 0), y1, -.015, 0, o.surround)
            self.wbox(W, N, T, "vh_stone", s1, s1 + b, y0 - (b if o.kind == "window" else 0), y1, -.015, 0, o.surround)
            self.wbox(W, N, T, "vh_stone", s0 - b, s1 + b, y1, y1 + b, -.015, 0, o.surround)
        if o.step:
            ground, deep = o.step
            self.wbox(W, N, T, "vh_stone", s0 - .15, s1 + .15, ground - .15, y0, -deep, 0, "#9d9a93")

    # --- roofs ---------------------------------------------------------------------------------------------------
    def roof(self, pts, free=(), under="#d9d6cf", edge="#e6e4de", thick=.14, board=None):
        """A roof plane of tiles (3D points), its underside and, on its free edges (i: pts[i] to pts[i+1]), a board."""
        n = newell(pts)
        if n[2] < 0:
            pts = pts[::-1]
            k = len(pts)
            free = [(k - 2 - i) % k for i in free]
        self.poly("vh_roof", pts, (0, 0, 1))
        self.poly("vh_trim", [(u, d, y - thick) for u, d, y in pts], (0, 0, -1), under)
        cx = sum(p[0] for p in pts) / len(pts)
        cd = sum(p[1] for p in pts) / len(pts)
        for i in free:
            a, b = pts[i], pts[(i + 1) % len(pts)]
            out = ((a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cd, 0)
            deep = board or thick
            self.poly("vh_trim", [a, b, (b[0], b[1], b[2] - deep), (a[0], a[1], a[2] - deep)], out, edge)

    def tile_ends(self, a, b, out, color, pitch=.3, rise=.06):
        """Round tile ends along an eaves (a to b, 3D, on the roof's surface), a row of bumps that read as tiles."""
        a, b = Vector(a), Vector(b)
        L = (b - a).length
        t = (b - a) / L
        k = max(1, round(L / pitch))
        for i in range(k):
            c0 = a + t * (L * i / k)
            w = L / k
            pts = [c0 + t * (w * (.5 - .5 * math.cos(math.pi * j / 4))) + Vector((0, 0, rise * math.sin(math.pi * j / 4))) for j in range(5)]
            self.poly("vh_trim", pts, out, color)

    def gutter(self, a, b, out, color="#e8e8e4", down=()):
        """A gutter hung under an eaves edge (a to b, 3D at the board's foot), and downpipes at the points `down`."""
        o = Vector((out[0], out[1])).normalized()
        a2, b2 = Vector((a[0], a[1])) + o * .07, Vector((b[0], b[1])) + o * .07
        y = min(a[2], b[2])
        self.seg("vh_frames_small", tuple(a2), tuple(b2), .13, y - .11, y + .02, color)
        for u, d, g in down:
            p = Vector((u, d))
            self.box("vh_frames_small", p.x - .045, p.x + .045, p.y - .045, p.y + .045, g - .05, y - .1, color)

    def pave(self, ring, mesh="vh_paving", lift=.035, cell=1.0):
        """Ground of pavers inside a plan ring, on the ground's slope, in cells a metre across."""
        us, ds = [p[0] for p in ring], [p[1] for p in ring]
        u0, d0 = math.floor(min(us)), math.floor(min(ds))
        for i in range(int(math.ceil((max(us) - u0) / cell))):
            for j in range(int(math.ceil((max(ds) - d0) / cell))):
                a, b = u0 + i * cell, d0 + j * cell
                poly = list(ring)
                for f in (lambda p: p[0] - a, lambda p: a + cell - p[0], lambda p: p[1] - b, lambda p: b + cell - p[1]):
                    poly = clip_half(poly, f) if poly else poly
                if len(poly) >= 3 and abs(area(poly)) > 1e-4:
                    self.poly(mesh, [(u, d, self.ground(u, d) + lift) for u, d in poly], (0, 0, 1))

    def chimney(self, u, d, w, l, y0, y1, mesh, color=None, pots=(), cap="#8f8c86"):
        self.box(mesh, u - w / 2, u + w / 2, d - l / 2, d + l / 2, y0, y1, color)
        self.box("vh_stone", u - w / 2 - .05, u + w / 2 + .05, d - l / 2 - .05, d + l / 2 + .05, y1, y1 + .08, cap)
        for pu, pd in pots:
            self.rod("vh_stone", (u + pu, d + pd, y1 + .08), (u + pu, d + pd, y1 + .42), .1, 8, "#7d5a48")

    # --- out -----------------------------------------------------------------------------------------------------
    def export(self, extra=None):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        root = bpy.data.objects.new(self.name, None)
        bpy.context.collection.objects.link(root)
        root["origin"] = [round(self.origin.x, 4), round(self.origin.y, 4)]
        root["landmark"] = self.name
        root["replaces"] = [self.outline]
        for k, v in (extra or {}).items():
            root[k] = v
        triangles = 0
        for name in sorted(self.faces):
            polygons = self.faces[name]
            spec = self.meshes[name]
            texture, tint = spec.get("texture"), spec.get("tint", "#ffffff")
            mat = bpy.data.materials.new(name)
            rgb = linear(tint)
            mat.diffuse_color = (*rgb, 1)
            mat.use_nodes = True
            shader = mat.node_tree.nodes.get("Principled BSDF")
            shader.inputs["Base Color"].default_value = (*rgb, 1)
            shader.inputs["Roughness"].default_value = spec.get("rough", .88)
            shader.inputs["Metallic"].default_value = spec.get("metal", 0)
            if texture:
                mat["texture"], mat["tint"] = texture, tint
                if "normalScale" in spec:
                    mat["normalScale"] = spec["normalScale"]
            mesh = bpy.data.meshes.new(name)
            verts, idx = [], []
            for pts, _ in polygons:
                idx.append(list(range(len(verts), len(verts) + len(pts))))
                verts.extend(self.vertex(p) for p in pts)
            mesh.from_pydata(verts, [], idx)
            mesh.update()
            mesh.materials.append(mat)
            if texture:
                # In metres: the game's texture repeats once every SIZES[texture] metres by itself (world/houseMeshes.ts);
                # `stretch` draws it larger along (u) or up (v).
                uv = mesh.uv_layers.new(name="UVMap")
                assert texture in SIZES
                su, sv = (1 / s for s in spec.get("stretch", (1, 1)))
                for poly in mesh.polygons:
                    nrm = poly.normal
                    u = Vector((1, 0, 0)) if abs(nrm.z) > .99 else Vector((0, 0, 1)).cross(nrm).normalized()
                    v = nrm.cross(u)
                    for k in poly.loop_indices:
                        p = mesh.vertices[mesh.loops[k].vertex_index].co
                        uv.data[k].uv = (round(p.dot(u) * su, 4), round(p.dot(v) * sv, 4))
            elif any(c for _, c in polygons):
                colors = mesh.color_attributes.new(name="Color", type="FLOAT_COLOR", domain="CORNER")
                node = mat.node_tree.nodes.new("ShaderNodeVertexColor")
                node.layer_name = "Color"
                mat.node_tree.links.new(node.outputs["Color"], shader.inputs["Base Color"])
                for poly, (_, c) in zip(mesh.polygons, polygons):
                    col = (*linear(c or tint), 1)
                    for k in poly.loop_indices:
                        colors.data[k].color = col
            obj = bpy.data.objects.new(name, mesh)
            bpy.context.collection.objects.link(obj)
            obj.parent = root
            mesh.calc_loop_triangles()
            triangles += len(mesh.loop_triangles)
        out = OUT / f"{self.name}.glb"
        out.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.export_scene.gltf(filepath=str(out), export_format="GLB", export_extras=True, export_yup=True,
                                  export_vertex_color="MATERIAL", export_cameras=False, export_lights=False)
        print(f"{self.name}: {triangles} triangles, {len(self.faces)} meshes, {out.stat().st_size} bytes")


GLASS = {"tint": "#46514f", "rough": .2, "metal": .2}
TRIM = {"tint": "#ffffff", "rough": .82}
STONE = {"tint": "#a8a59f", "rough": .9}
SMALL = {"tint": "#ffffff", "rough": .6}
METAL = {"tint": "#ffffff", "rough": .5, "metal": .35}


# ======================================================================================================================
# 01. x -326.9, z -896.6: a long whitewashed farmhouse with a black foot, end-on to the street, its yard and gate.
def farm():
    h = House("vh_farm", [-319.38, -896.99], ([-319.38, -896.99], [-331.71, -902.34]), -0.61, {
        "vh_brick": {"texture": "nb_brick", "tint": "#ece8df", "normalScale": .55},
        "vh_roof": {"texture": "roof_tiles", "tint": "#4a2b24", "normalScale": .3},
        "vh_paving": {"texture": "pavers", "tint": "#a5a39d"},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,
    })
    # u runs from the street gable (u -6.7) away from the street; d from the yard front (0) to the back (8).
    lift = h.base  # data heights over the data's base, to ours
    R, E1, ridge = 5.9 + lift, 3.4 + lift, 2.56  # the ridge 2.6 m in from the yard front
    k2 = .62  # the long back slope
    yard = lambda d: R - (R - E1) * (ridge - d) / ridge
    back = lambda d: R - k2 * (d - ridge)
    roof_at = lambda d: yard(d) if d <= ridge else back(d)
    lean = lambda d: 3.9 + lift + .15 - .4 * (d - 4.41)  # the lean-to's corrugated roof, under the tiles' eaves
    verge = lambda d: -6.72 + d * 1.24 / 4.44 - .22  # the street gable runs a little askew to the yard front
    floor = .12
    black = [(.9, "vh_trim", "#2b2a29")]
    g0 = h.ground(-6.72, 0)
    frame, stone = "#c9cbc8", "#9d9c97"
    # The yard front: from the street inwards a plank door, a window, a second door, two windows.
    ops = [Opening(6.72 - 5.25, floor, .95, 2.0, "door", reveal=.14, frame=frame, door="#c4c7c5", surround=stone, step=(h.ground(-5.25, -.3), .35)),
           Opening(6.72 - 3.65, 1.05, .8, 1.0, frame=frame, surround=stone, sill=False),
           Opening(6.72 - 2.05, floor, .95, 2.0, "door", reveal=.14, frame=frame, door="#c4c7c5", surround=stone, step=(h.ground(-2.05, -.3), .35)),
           Opening(6.72 - .3, 1.05, .8, 1.0, frame=frame, surround=stone, sill=False),
           Opening(6.72 + 1.7, 1.05, .8, 1.0, frame=frame, surround=stone, sill=False)]
    h.wall((-6.72, 0), (6.72, 0), yard(0) - .06, ops, bands=black)
    # The street gable: blank, four small vents high up, its top under the two slopes.
    a, b = Vector((-6.72, 0)), Vector((-5.48, 4.44))
    L = (b - a).length
    sr = ridge / 4.44 * L
    vents = [Opening(sr + ds, y, .2, .2, "vent", reveal=.12, sill=False) for ds in (-.45, .45) for y in (4.0, 4.55)]
    h.wall(tuple(a), tuple(b), [(0, roof_at(0) - .06), (sr, R - .06), (L, back(4.44) - .06)], vents, bands=black)
    h.wall((-5.48, 4.44), (-5.31, 4.41), back(4.42) - .06, bands=black)
    # The far gable and the main back wall beside the lean-to.
    h.wall((6.72, 0), (6.62, 5.19), [(0, yard(0) - .06), (ridge, R - .06), (5.19, back(5.19) - .06)],
           [Opening(1.6, 1.05, .8, 1.0, frame=frame, surround=stone, sill=False)], bands=black)
    h.wall((6.62, 5.19), (3.43, 5.12), back(5.15) - .06, [Opening(1.6, 1.05, .8, 1.0, frame=frame, surround=stone, sill=False)], bands=black)
    a, b = Vector((3.43, 5.12)), Vector((-5.31, 4.41))
    L = (b - a).length
    h.wall(tuple(a), tuple(b), [(0, back(5.12) - .06), (L, back(4.41) - .06)], bottom=[(0, lean(5.12) - .12), (L, lean(4.41) - .12)], out=(0, 1))
    # The lean-to: white brick, the same black foot, a low wall under the corrugated roof.
    h.wall((3.43, 5.12), (3.46, 8.07), [(0, lean(5.12) - .05), (2.95, lean(8.07) - .05)], bands=black)
    h.wall((3.46, 8.07), (-5.19, 7.54), [(0, lean(8.07) - .05), (8.67, lean(7.54) - .05)],
           [Opening(4.3, 1.0, .7, .7, frame=frame, surround=stone, sill=False)], bands=black)
    h.wall((-5.19, 7.54), (-5.31, 4.41), [(0, lean(7.54) - .05), (3.13, lean(4.41) - .05)], bands=black)
    # The roof: dark red-brown pantiles, black verge boards on the gables, a white gutter on the yard side.
    y0, yr, yb, de = yard(-.35), R, back(6.0), 6.0
    dk = (-5.45 + 6.94) / .279  # past here the verge keeps clear of the lean-to's end
    E = 6.95
    h.roof([(verge(-.35), -.35, y0), (E, -.35, y0), (E, ridge, yr), (verge(ridge), ridge, yr)], free=(0, 1, 3), edge="#1f1f1f", board=.26, under="#cfcbc2")
    h.roof([(verge(ridge), ridge, yr), (E, ridge, yr), (E, de, yb), (-5.45, de, yb), (-5.45, dk, back(dk))], free=(1, 2, 3, 4), edge="#1f1f1f", board=.26, under="#cfcbc2")
    h.rod("vh_roof", (verge(ridge) + .05, ridge, R + .02), (E, ridge, R + .02), .13, 6)
    tile = "#5a3a31"
    h.tile_ends((verge(-.35), -.35, y0), (E, -.35, y0), (0, -1, 0), tile)
    h.tile_ends((-5.45, de, yb), (E, de, yb), (0, 1, 0), tile)
    h.gutter((verge(-.35) + .1, -.35, y0 - .14), (E - .1, -.35, y0 - .14), (0, -1, 0),
             down=[(-6.25, -.42, h.ground(-6.25, -.42)), (6.5, -.42, h.ground(6.5, -.42))])
    # The lean-to's corrugated sheets, from under the tiles' eaves to over its own back wall.
    top = lambda u: 4.41 + (u + 5.31) / 8.74 * .71 - .05  # along the main back wall
    bot = lambda u: 8.07 + (u - 3.46) / 8.65 * .53 + .3  # beyond the lean-to's back wall
    u, w = -5.45, .18
    sheet = "#77736c"
    while u < 3.68 - 1e-6:
        u1 = min(u + w, 3.68)
        um = (u + u1) / 2
        for p, q, lp, lq in ((u, um, 0, .035), (um, u1, .035, 0)):
            h.poly("vh_trim", [(p, top(p), lean(top(p)) + lp), (q, top(q), lean(top(q)) + lq), (q, bot(q), lean(bot(q)) + lq), (p, bot(p), lean(bot(p)) + lp)], (0, 0, 1), sheet)
        u = u1
    h.poly("vh_trim", [(-5.45, top(-5.45), lean(top(-5.45)) - .03), (3.68, top(3.68), lean(top(3.68)) - .03), (3.68, bot(3.68), lean(bot(3.68)) - .03), (-5.45, bot(-5.45), lean(bot(-5.45)) - .03)], (0, 0, -1), "#7a7a76")
    h.poly("vh_trim", [(-5.45, bot(-5.45), lean(bot(-5.45)) - .03), (3.68, bot(3.68), lean(bot(3.68)) - .03), (3.68, bot(3.68), lean(bot(3.68)) + .035), (-5.45, bot(-5.45), lean(bot(-5.45)) + .035)], (0, 1, 0), sheet)
    # The yard: grey concrete pavers from the house to the gate, between this house and the brick one beside it.
    h.pave([(-6.78, -.02), (6.75, -.02), (6.75, -5.4), (1.4, -5.9), (.85, -5.4), (-7.62, -3.1)])
    # The gate at the yard's mouth: two black piers with flat caps, a double gate of flat bars and scrolls standing
    # open a quarter, into the yard. Drawn only: nobody is shut out.
    p1, p2 = Vector((-6.72, 0)), Vector((-7.72, -3.22))
    g = (p2 - p1).normalized()
    c1, c2 = p1 + g * .3, p2 - g * .3
    for c in (c1, c2):
        gy = h.ground(c.x, c.y)
        h.box("vh_trim", c.x - .225, c.x + .225, c.y - .225, c.y + .225, gy - .1, gy + 1.52, "#1c1c1c")
        h.box("vh_trim", c.x - .26, c.x + .26, c.y - .26, c.y + .26, gy + 1.52, gy + 1.6, "#1c1c1c")
    span = (c2 - c1).length - .5
    leaf = span / 2
    inward = Vector((-g.y, g.x))  # toward the yard (u up)
    turn = math.radians(25)
    gy = h.ground(*((c1 + c2) / 2)) + .06
    for hinge, sgn in ((c1 + g * .25, 1), (c2 - g * .25, -1)):
        dirv = (g * sgn) * math.cos(turn) + inward * math.sin(turn)
        normal = Vector((dirv.y, -dirv.x))
        pt = lambda s, y: (hinge.x + dirv.x * s, hinge.y + dirv.y * s, gy + y)

        def bar(s0, y0, s1, y1, wdt=.035):
            d = Vector((s1 - s0, y1 - y0)).normalized()
            off = Vector((-d.y, d.x)) * wdt / 2
            q = [pt(s0 + off.x, y0 + off.y), pt(s1 + off.x, y1 + off.y), pt(s1 - off.x, y1 - off.y), pt(s0 - off.x, y0 - off.y)]
            h.poly("vh_metal_small", q, (normal.x, normal.y, 0), "#141414")
            h.poly("vh_metal_small", q, (-normal.x, -normal.y, 0), "#141414")
        bar(0, .08, leaf, .08)
        bar(0, 1.25, leaf, 1.25)
        bar(0, .55, leaf, .55, .025)
        bar(.02, .05, .02, 1.3, .045)
        bar(leaf - .02, .05, leaf - .02, 1.3, .045)
        for k in range(1, 9):
            s = leaf * k / 9
            bar(s, .08, s, .55, .02)
        for k in range(2):  # two scrolls a leaf
            cx, cy, rr = leaf * (.28 + .44 * k), .9, .16
            pts = [(cx + rr * math.cos(a) * (1 - a / 12), cy + rr * math.sin(a) * (1 - a / 12)) for a in [i * math.pi / 3 for i in range(8)]]
            for (sa, ya), (sb, yb2) in zip(pts, pts[1:]):
                bar(sa, ya, sb, yb2, .02)
    h.export()


# ======================================================================================================================
# 02. x -143.6, z -1092.0: a two-storey brick house of the 1930s, clipped gables, its side to the junction clad in black.
def gable_house():
    h = House("vh_gable_house", [-145.35, -1101.26], ([-142.85, -1084.6], [-136.42, -1089.34]), -3.09, {
        "vh_brick": {"texture": "nb_brick", "tint": "#7a4a3c", "normalScale": .55},
        # The game's vertical slats, drawn four times as wide (a rib every quarter metre), tinted from the wood's
        # brown to a neutral black.
        "vh_clad": {"texture": "cladding", "tint": "#2c3a52", "stretch": (4, 1), "normalScale": .8},
        "vh_roof": {"texture": "roof_tiles", "tint": "#4c2e26", "normalScale": .3},
        "vh_paving": {"texture": "pavers", "tint": "#a29d94"},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,
    })
    # u along the street front (u +4: the side to the junction), d from the front (0) to the back (12.5).
    lift = h.base
    R, E, D = 11.5 + lift, 6.3 + lift, 12.5
    k = (R - E) / (D / 2)
    main = lambda d: R - k * abs(d - D / 2)
    ov, vg = .3, 4.11  # eaves overhang; the verge's u
    Hh = R - 1.5  # where the clipped hips meet the gables
    uR = vg - 1.2  # the ridge's ends
    dA, dB = D / 2 - (R - Hh) / k, D / 2 + (R - Hh) / k
    hip_at = lambda u: Hh + (R - Hh) * (vg - abs(u)) / (vg - uR)  # the hip's height over the gable's line
    cap = hip_at(3.99)
    dc = D / 2 - (R - cap) / k
    floor, frame, lint = .08, "#3b443f", "#b9b4aa"
    gy = h.ground(-.45, -.2)
    win = lambda s, y, w, hh: Opening(s, y, w, hh, frame=frame, lintel=lint, transom=.72 if hh > 1.2 else None, cols=2 if w > .95 else 1)
    # The street front, in two planes as the data's (the door's half 0.47 m back).
    h.wall((-3.99, .44), (.4, .47), main(.45) - .06,
           [Opening(3.54, floor, 1.0, 2.2, "door", door="#c9cbc6", frame=frame, panels="glazed", step=(gy, .45), reveal=.2),
            win(1.44, .75, 1.1, 1.7), win(1.44, 3.55, 1.0, 1.5), win(3.54, 3.55, .85, 1.5)])
    h.wall((.4, .47), (.41, -.02), main(.2) - .06)
    h.wall((.41, -.02), (3.99, 0), main(0) - .06, [win(1.84, .75, 1.1, 1.7), win(1.84, 3.55, 1.0, 1.5)])
    # The other side: brick, two small windows.
    side = [(12.02 - d, y) for d, y in ((.44, main(.44) - .06), (dc, cap - .06), (D - dc, cap - .06), (12.02, main(12.02) - .06))]
    h.wall((-3.99, 12.02), (-3.99, .44), side, [win(12.02 - 4.0, 1.2, .8, 1.0), win(12.02 - 8.2, 4.0, .8, 1.0)])
    # The back, and the flat-roofed wing behind it.
    wing = 5.28 + lift
    h.wall((3.9, 11.94), (-3.99, 12.02), main(12.0) - .06, [win(3.9 + 2.3, .9, 1.1, 1.3), win(3.9 + 2.3, 3.55, 1.0, 1.2)], out=(0, 1))
    h.wall((-.63, 11.94), (-.5, 14.97), wing)
    h.wall((-.5, 14.97), (3.88, 14.89), wing, [win(2.2, .9, 1.2, 1.3), win(2.2, 3.4, 1.0, 1.2)])
    h.poly("vh_trim", [(u, d, wing - .02) for u, d in ((-.5, 12.0), (3.86, 12.0), (3.86, 14.87), (-.5, 14.95))], (0, 0, 1), "#3a3a3a")
    for a, b in (((-.5, 14.95), (3.86, 14.87)), ((3.86, 14.87), (3.86, 12.0)), ((-.5, 12.0), (-.5, 14.95))):
        h.seg("vh_stone", a, b, .3, wing - .02, wing + .06, "#a19d95")
    # The side to the junction: black profiled sheets from the ground to the ridge, a rib every quarter metre.
    a, b = Vector((3.99, 0)), Vector((3.88, 14.89))
    L = (b - a).length
    sd = lambda d: d * L / 14.89
    clad = [(sd(0), main(0) - .06), (sd(dc), cap - .06), (sd(D - dc), cap - .06), (sd(11.94), main(11.94) - .06), (sd(11.95), wing + .06), (L, wing + .06)]
    h.wall(tuple(a), tuple(b), clad, mesh="vh_clad")
    # The roof: steep dark red-brown tiles, eaves front and back, both gable tops clipped by a small hip.
    ef, eb = main(-ov), main(D + ov)
    h.roof([(-vg, -ov, ef), (vg, -ov, ef), (vg, dA, Hh), (uR, D / 2, R), (-uR, D / 2, R), (-vg, dA, Hh)], free=(0, 1, 5), edge="#5a3a30", board=.2, under="#6d4b3e")
    h.roof([(vg, D + ov, eb), (-vg, D + ov, eb), (-vg, dB, Hh), (-uR, D / 2, R), (uR, D / 2, R), (vg, dB, Hh)], free=(0, 1, 5), edge="#5a3a30", board=.2, under="#6d4b3e")
    for s in (-1, 1):
        h.roof([(s * vg, dA, Hh), (s * vg, dB, Hh), (s * uR, D / 2, R)], free=(0,), edge="#5a3a30", board=.2, under="#6d4b3e")
        h.rod("vh_roof", (s * uR, D / 2, R + .03), (s * vg, dA, Hh + .03), .1, 6)
        h.rod("vh_roof", (s * uR, D / 2, R + .03), (s * vg, dB, Hh + .03), .1, 6)
    h.rod("vh_roof", (-uR, D / 2, R + .03), (uR, D / 2, R + .03), .12, 6)
    tile = "#4f3229"
    h.tile_ends((-vg, -ov, ef), (vg, -ov, ef), (0, -1, 0), tile)
    h.tile_ends((vg, D + ov, eb), (-vg, D + ov, eb), (0, 1, 0), tile)
    h.gutter((-vg, -ov, ef - .2), (vg, -ov, ef - .2), (0, -1, 0), "#6e6f6c", down=[(-3.85, -.4, h.ground(-3.85, -.4))])
    h.gutter((-vg, D + ov, eb - .2), (vg, D + ov, eb - .2), (0, 1, 0), "#6e6f6c", down=[(-3.85, D + .4, h.ground(-3.85, D + .4))])
    h.chimney(-1.6, 7.3, .55, .75, main(7.3) - .3, R + .9, "vh_brick", pots=[(0, 0)])
    # A small tiled canopy over the door on two timber brackets.
    cy, cu0, cu1 = 2.55, -1.25, .35
    h.roof([(cu0, -.25, cy), (cu1, -.25, cy), (cu1, .47, cy + .32), (cu0, .47, cy + .32)], free=(0, 1, 3), edge="#5a3a30", board=.12, thick=.08, under="#6d4b3e")
    for u in (cu0 + .12, cu1 - .12):
        h.box("vh_frames_small", u - .04, u + .04, -.15, .47, cy - .5, cy - .02, "#5b4634")
    # The front garden: a path of pavers from the door to the pavement, one brick pier beside it.
    h.pave([(-.98, -.02), (.08, -.02), (.08, -7.1), (-.98, -7.1)])
    py = h.ground(.4, -6.6)
    h.box("vh_brick", .2, .6, -6.8, -6.4, py - .1, py + 1.1)
    h.box("vh_stone", .16, .64, -6.84, -6.36, py + 1.1, py + 1.18, "#a19d95")
    h.export()


# ======================================================================================================================
# 03. x -46.7, z -1089.5: a buff brick villa of the 1950s, its gable to the street, arched windows, a balcony.
def arch_villa():
    h = House("vh_arch_villa", [-52.4, -1092.05], ([-49.32, -1098.44], [-42.93, -1097.28]), -3.52, {
        "vh_brick": {"texture": "nb_brick", "tint": "#c7a56f", "normalScale": .5},
        "vh_roof": {"texture": "roof_tiles", "tint": "#3d4046", "normalScale": .3},
        "vh_paving": {"texture": "pavers", "tint": "#9c9a95"},
        "vh_hedge": {"texture": "hedge", "tint": "#8eab68"},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,
    })
    # u along the street gable (u -5: the drive's side), d from the gable (0) to the back (16.8).
    lift = h.base
    R, E = 8.4 + lift, 4.5 + lift
    kn, kw = (R - E) / 3.25, (R - E) / 5.13  # the gable wing's roof, the wide roof behind it
    narrow = lambda u: R - kn * abs(u)
    wide = lambda u: R - kw * abs(u)
    floor, frame, white = .3, "#2f3033", "#f0efe9"
    foot = [(.55, "vh_stone", "#8d8a84")]
    annex = 3.2
    # The street gable: two round-arched windows under brick arches, a wide glazed door onto the balcony.
    arch = lambda s: Opening(s, .95, 1.1, 1.9, arch=True, frame=frame, header=True, cols=2, reveal=.2)
    h.wall((-3.25, 0), (3.25, 0), [(0, narrow(-3.25) - .06), (3.25, R - .06), (6.5, narrow(3.25) - .06)],
           [arch(3.25 - 1.55), arch(3.25 + 1.55), Opening(3.25, 3.3, 2.4, 1.9, frame=frame, cols=3, sill=False, reveal=.2)], bands=foot)
    h.box("vh_stone", -1.6, 1.6, -.9, .02, 3.12, 3.3, "#b3b0a9", bottom=True)  # the balcony's slab
    rail = "#151515"
    for a, b in (((-1.57, -.87), (1.57, -.87)), ((-1.57, -.87), (-1.57, 0)), ((1.57, -.87), (1.57, 0))):
        h.seg("vh_metal_small", a, b, .04, 4.24, 4.3, rail)
        h.seg("vh_metal_small", a, b, .03, 3.36, 3.4, rail)
        av, bv = Vector(a), Vector(b)
        n = max(2, round((bv - av).length / .12))
        for i in range(n + 1):
            p = av + (bv - av) * (i / n)
            h.box("vh_metal_small", p.x - .012, p.x + .012, p.y - .012, p.y + .012, 3.3, 4.24, rail)
    # The gable wing's sides, under its eaves; on the right the door, round the corner, under a flat canopy.
    h.wall((-3.25, 4.33), (-3.25, 0), narrow(3.25) - .06, [Opening(2.2, 1.2, 1.4, 1.3, frame=frame, cols=2)], bands=foot)
    gy = h.ground(3.8, 5.6)
    h.wall((3.25, 0), (3.25, 6.86), [(0, narrow(3.25) - .06), (4.33, narrow(3.25) - .06), (4.331, wide(3.25) - .06), (6.86, wide(3.25) - .06)],
           [Opening(2.0, 1.2, 1.4, 1.3, frame=frame, cols=2),
            Opening(5.6, floor, 1.0, 2.15, "door", door="#6b4a35", frame=frame, panels="glazed", step=(gy, .5), reveal=.2)], bands=foot)
    h.box("vh_stone", 3.25, 4.15, 4.95, 6.25, 2.6, 2.72, "#b3b0a9", bottom=True)
    # The wide part behind: its front shoulders, its sides, its back gable over the low wing behind.
    h.wall((-5.11, 4.35), (3.25, 4.33), [(0, wide(5.11) - .06), (5.11, R - .06), (8.36, wide(3.25) - .06)],
           bottom=[(0, h.foot), (1.85, h.foot), (1.851, narrow(3.25) - .2), (5.11, R - .2), (8.36, narrow(3.25) - .2)], bands=foot,
           openings=[Opening(.95, 1.2, .9, 1.2, frame=frame)], out=(0, -1))
    h.wall((3.25, 6.86), (5.14, 6.84), [(0, wide(3.25) - .06), (1.89, wide(5.14) - .06)], bands=foot)
    h.wall((5.14, 6.84), (5.11, 12.94), wide(5.13) - .06, [Opening(1.6, 1.2, 1.4, 1.3, frame=frame, cols=2), Opening(4.5, 1.2, 1.4, 1.3, frame=frame, cols=2)], bands=foot)
    h.wall((5.11, 12.94), (-5.11, 12.92), [(0, wide(5.11) - .06), (5.11, R - .06), (10.22, wide(5.11) - .06)],
           bottom=[(0, h.foot), (5.8, h.foot), (5.801, annex - .15), (10.22, annex - .15)], bands=foot,
           openings=[Opening(2.4, 1.2, 1.2, 1.3, frame=frame, cols=2), Opening(5.11, 4.6, .9, 1.0, frame=frame)], out=(0, 1))
    h.wall((-5.11, 12.92), (-5.11, 4.35), wide(5.11) - .06, bottom=[(0, annex - .15), (3.27, annex - .15), (3.271, h.foot), (8.57, h.foot)],
           bands=foot, openings=[Opening(5.6, 1.2, 1.4, 1.3, frame=frame, cols=2)], out=(-1, 0))
    # The low wing at the back and the side, with its garage door to the drive.
    h.wall((-4.97, 9.65), (-8.07, 9.64), annex, [Opening(1.55, h.ground(-6.5, 9.4) + .02, 2.5, 2.1, "garage", door=white, reveal=.12, sill=False)], bands=foot)
    h.wall((-8.07, 9.64), (-7.96, 16.82), annex, [Opening(4.5, 1.2, 1.2, 1.1, frame=frame)], bands=foot)
    h.wall((-7.96, 16.82), (-.69, 16.7), annex, [Opening(2.2, 1.2, 1.2, 1.1, frame=frame), Opening(5.4, floor + .1, .9, 2.1, "door", door="#6b4a35", frame=frame, panels="glazed", reveal=.12)], bands=foot)
    h.wall((-.69, 16.7), (-.69, 12.89), annex, [Opening(1.8, 1.2, 1.2, 1.1, frame=frame)], bands=foot)
    ring = [(-5.11, 9.65), (-8.07, 9.64), (-7.96, 16.82), (-.69, 16.7), (-.69, 12.92), (-5.11, 12.92)]
    h.poly("vh_trim", [(u, d, annex - .02) for u, d in ring], (0, 0, 1), "#3a3a3a")
    for a, b in zip(ring[:5], ring[1:5]):
        h.seg("vh_stone", a, b, .28, annex, annex + .07, "#b3b0a9")
    # The roofs: dark grey concrete tiles, white verge and gutter boards.
    ov = .3
    yn = narrow(3.25 + ov)
    h.roof([(-3.25 - ov, -.25, yn), (-3.25 - ov, 4.43, yn), (0, 4.43, R), (0, -.25, R)], free=(0, 3), edge=white, board=.22, under=white)
    h.roof([(3.25 + ov, 4.43, yn), (3.25 + ov, -.25, yn), (0, -.25, R), (0, 4.43, R)], free=(0, 1), edge=white, board=.22, under=white)
    yw = wide(5.13 + ov)
    h.roof([(-5.13 - ov, 4.05, yw), (-5.13 - ov, 13.22, yw), (0, 13.22, R), (0, 4.05, R)], free=(0, 1, 3), edge=white, board=.22, under=white)
    h.roof([(5.13 + ov, 13.22, yw), (5.13 + ov, 4.05, yw), (0, 4.05, R), (0, 13.22, R)], free=(0, 1, 3), edge=white, board=.22, under=white)
    h.rod("vh_roof", (0, -.25, R + .02), (0, 13.22, R + .02), .12, 6)
    tile = "#34373c"
    h.tile_ends((-3.25 - ov, -.25, yn), (-3.25 - ov, 4.43, yn), (-1, 0, 0), tile)
    h.tile_ends((3.25 + ov, 4.43, yn), (3.25 + ov, -.25, yn), (1, 0, 0), tile)
    h.tile_ends((-5.13 - ov, 4.05, yw), (-5.13 - ov, 13.22, yw), (-1, 0, 0), tile)
    h.tile_ends((5.13 + ov, 13.22, yw), (5.13 + ov, 4.05, yw), (1, 0, 0), tile)
    h.gutter((-3.25 - ov, -.25, yn - .22), (-3.25 - ov, 4.43, yn - .22), (-1, 0, 0), white, down=[(-3.62, .1, h.ground(-3.62, .1))])
    h.gutter((3.25 + ov, -.25, yn - .22), (3.25 + ov, 4.43, yn - .22), (1, 0, 0), white, down=[(3.62, .1, h.ground(3.62, .1))])
    h.gutter((-5.13 - ov, 4.05, yw - .22), (-5.13 - ov, 13.22, yw - .22), (-1, 0, 0), white)
    h.gutter((5.13 + ov, 4.05, yw - .22), (5.13 + ov, 13.22, yw - .22), (1, 0, 0), white, down=[(5.5, 12.8, h.ground(5.5, 12.8))])
    h.box("vh_trim", 4.95, 5.07, 4.38, 4.5, h.ground(5, 4.44) - .1, wide(5.0) - .1, white)  # a slim post at the porch's corner
    h.chimney(-2.0, 10.4, .6, .6, wide(2.0) - .4, R + .7, "vh_brick", pots=[(-.14, 0), (.14, 0)])
    # The front garden: lawn, three low clipped shrubs, a drive of grey pavers to the side, a path to the door.
    for u, d in ((-2.6, -1.4), (2.6, -1.4), (4.6, -.9)):
        h.blob("vh_hedge", u, d, h.ground(u, d) + .25, (.45, .4, .38))
    h.pave([(-7.75, 9.5), (-5.25, 9.5), (-5.25, -9.0), (-7.75, -9.0)])
    h.pave([(3.3, 6.75), (4.6, 6.75), (4.6, -9.0), (3.3, -9.0)])
    h.export()


# ======================================================================================================================
# 04. x 39.7, z -1050.1: a long white rendered bungalow of the 1960s under a low hipped roof, a covered corner.
def white_bungalow():
    h = House("vh_white_bungalow", [42.9, -1047.67], ([39.62, -1061.58], [46.82, -1057.85]), -2.91, {
        "vh_render": {"texture": "plaster", "tint": "#ebe7df", "normalScale": .35},
        "vh_roof": {"texture": "roof_tiles", "tint": "#5e3e33", "normalScale": .3},
        "vh_paving": {"texture": "pavers", "tint": "#a29e96"},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,
    })
    # u across the house (u +4: the side seen on arriving), d from the end on the street (0) to the far end (20.1).
    lift = h.base
    R, E = 5.8 + lift, 3.0
    uL, uR_, d0, d1, ov = -5.26, 4.05, 0.0, 20.14, .5
    uc = (uL + uR_) / 2
    k = (R - E) / ((uR_ - uL) / 2)
    ye = E - k * ov
    rh = (uR_ - uL) / 2 + ov
    floor, frame, white = .32, "#2f3134", "#f2f1ec"
    foot = [(max(.3, floor), "vh_trim", "#8a8884")]
    plane = lambda u, d: min(ye + k * (u - (uL - ov)), ye + k * ((uR_ + ov) - u), ye + k * (d - (d0 - ov)), ye + k * ((d1 + ov) - d))
    M = "vh_render"
    slide = lambda s: Opening(s, floor, 3.0, 2.1, frame=frame, cols=2, sill=False, reveal=.14)
    win = lambda s, w=1.6, hh=1.3: Opening(s, floor + .8, w, hh, frame=frame, cols=2 if w > 1 else 1, reveal=.14)
    # The end on the street and the long side seen on arriving: a sliding window each side of their corner.
    h.wall((4.05, 0), (-4.05, 0), plane(0, 0) - .06, [slide(1.8), win(6.0)], mesh=M, bands=foot)
    h.wall((4.05, 20.14), (4.05, 0), plane(4.05, 10) - .06, [slide(20.14 - 2.05), win(20.14 - 8.0), win(20.14 - 12.5), win(20.14 - 16.5)], mesh=M, bands=foot)
    # The other long side: the door under the roof's covered corner, the garage at the far end.
    gy = h.ground(-4.6, 6.2)
    dcorner = (plane(-4.05, 5) - ye) / k - ov  # where the end's slope reaches the side's
    h.wall((-4.05, 0), (-4.05, 10.75), [(0, plane(-4.05, 0) - .06), (dcorner, plane(-4.05, 5) - .06), (10.75, plane(-4.05, 5) - .06)],
           [win(2.5), Opening(6.2, floor, 1.0, 2.1, "door", door="#d9d8d2", frame=frame, panels="glazed", step=(gy, .45), reveal=.14),
            Opening(7.15, floor + .1, .4, 1.9, frame=frame, sill=False, reveal=.14), win(9.4, .6, .6)], mesh=M, bands=foot)
    h.wall((-4.05, 10.75), (-5.26, 10.84), [(0, plane(-4.05, 10) - .06), (1.21, plane(-5.26, 10) - .06)], mesh=M, bands=foot)
    gg = h.ground(-5.6, 17.6)
    h.wall((-5.26, 10.84), (-5.15, 20.12), plane(-5.2, 15) - .06, [win(2.4), Opening(6.8, gg + .02, 2.5, 2.1, "garage", door=white, reveal=.12, sill=False)], mesh=M, bands=foot)
    h.wall((-5.15, 20.12), (4.05, 20.14), plane(0, 20.14) - .06, [win(6.9)], mesh=M, bands=foot)
    # The roof: hipped on all four sides, brown-red concrete tiles, a white fascia, a white chimney with a flat cap.
    ra, rb = d0 - ov + rh, d1 + ov - rh
    U0, U1, D0, D1 = uL - ov, uR_ + ov, d0 - ov, d1 + ov
    h.roof([(U1, D0, ye), (U1, D1, ye), (uc, rb, R), (uc, ra, R)], free=(0,), edge=white, board=.3, under=white)
    h.roof([(U0, D1, ye), (U0, D0, ye), (uc, ra, R), (uc, rb, R)], free=(0,), edge=white, board=.3, under=white)
    h.roof([(U0, D0, ye), (U1, D0, ye), (uc, ra, R)], free=(0,), edge=white, board=.3, under=white)
    h.roof([(U1, D1, ye), (U0, D1, ye), (uc, rb, R)], free=(0,), edge=white, board=.3, under=white)
    h.rod("vh_roof", (uc, ra, R + .02), (uc, rb, R + .02), .11, 6)
    for c in ((U0, D0), (U1, D0)):
        h.rod("vh_roof", (uc, ra, R + .02), (*c, ye + .02), .09, 6)
    for c in ((U0, D1), (U1, D1)):
        h.rod("vh_roof", (uc, rb, R + .02), (*c, ye + .02), .09, 6)
    tile = "#5c3d32"
    for a, b, out in (((U0, D0), (U1, D0), (0, -1, 0)), ((U1, D0), (U1, D1), (1, 0, 0)), ((U1, D1), (U0, D1), (0, 1, 0)), ((U0, D1), (U0, D0), (-1, 0, 0))):
        h.tile_ends((*a, ye), (*b, ye), out, tile)
        h.gutter((*a, ye - .3), (*b, ye - .3), out, white)
    for u, d in ((U1 - .15, D0 + .15), (U1 - .15, D1 - .15), (U0 + .15, D1 - .15)):
        h.box("vh_frames_small", u - .045, u + .045, d - .045, d + .045, h.ground(u, d) - .05, ye - .4, white)
    h.chimney(uc, 13.0, .5, .7, R - .6, R + .85, "vh_render", cap="#c9c7c0")
    for d in (.15, 5.4):  # slim white posts under the covered corner
        h.box("vh_trim", -5.2, -5.08, d - .06, d + .06, h.ground(-5.14, d) - .1, plane(-5.14, d) - .14, white)
    # The way in: pavers under the covered corner and down to the street.
    h.pave([(-4.03, 10.72), (-5.32, 10.72), (-5.32, -.3), (-5.42, -4.6), (-4.42, -4.6), (-4.42, -.02), (-4.03, -.02)])
    # A fence of horizontal timber slats at the side, from the house to the hedge.
    fy = h.ground(6.0, 18.6)
    for i in range(6):
        y = fy + .12 + i * .19
        h.box("vh_frames_small", 4.12, 7.8, 18.56, 18.64, y, y + .15, "#8a6a4c")
    for u in (4.2, 6.0, 7.75):
        h.box("vh_frames_small", u - .045, u + .045, 18.53, 18.67, h.ground(u, 18.6) - .1, fy + 1.25, "#6f553e")
    h.export()


HOUSES = {"vh_farm": farm, "vh_gable_house": gable_house, "vh_arch_villa": arch_villa, "vh_white_bungalow": white_bungalow}
for _name, _build in HOUSES.items():
    if not ONLY or _name in ONLY:
        _build()
