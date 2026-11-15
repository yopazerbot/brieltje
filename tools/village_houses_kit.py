"""The toolkit of the hand-made village houses: `House`, `Opening`, the ground, the export to .glb. The packages'
scripts (tools/village_houses_b1.py, _b2.py, ...) import it and hold only their houses:

  blender -b -P tools/village_houses_b2.py -- web/public/models [vh_fermette ...]

The first argument after `--` is the folder the .glb files go to, the rest the houses to build (all when none).
Each house stands in for one generated house: it is found in web/src/data/village.json by a corner of its wall block,
whose outline becomes the model's `replaces` (the block stays in the data for walking into and for the server, so
every wall keeps within 0.15 m of it). The root's `origin` lies on the ground at the middle of the front wall;
heights are metres over the ground there. See tools/village_houses_b1.py for the names of the meshes and what the game
does with each.
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
        self.replaces = [self.outline]
        self.blocks = []
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
        """A gutter hung under an eaves edge (a to b, 3D at the board's foot), and downpipes at the points `down` (u, d,
        ground): each stands against the wall there and bends out under the eaves to the gutter's nearest point."""
        o = Vector((out[0], out[1])).normalized()
        a2, b2 = Vector((a[0], a[1])) + o * .07, Vector((b[0], b[1])) + o * .07
        y = min(a[2], b[2])
        self.seg("vh_frames_small", tuple(a2), tuple(b2), .13, y - .11, y + .02, color)
        for u, d, g in down:
            p = Vector((u, d))
            t = (b2 - a2).normalized()
            q = a2 + t * max(0, min((b2 - a2).length, (p - a2).dot(t)))  # the outlet under the gutter
            self.box("vh_frames_small", q.x - .04, q.x + .04, q.y - .04, q.y + .04, y - .4, y - .1, color)
            if (q - p).length > .05:
                self.seg("vh_frames_small", tuple(q), tuple(p), .08, y - .46, y - .38, color)
            self.box("vh_frames_small", p.x - .045, p.x + .045, p.y - .045, p.y + .045, g - .05, y - .4, color)

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

    # --- standing in -------------------------------------------------------------------------------------------
    def replace_roof(self, first):
        """Hide one more data roof (found by its first corner): one whose middle lies outside the wall block."""
        for r in VILLAGE["roofs"]:
            ring = r["p"][0] if isinstance(r["p"][0][0], list) else r["p"]
            if abs(ring[0][0] - first[0]) < .02 and abs(ring[0][1] - first[1]) < .02:
                self.replaces.append(ring)
                return
        raise ValueError(f"{self.name}: no data roof starts at {first}; the data changed, review the house")

    def block(self, m, ring, y0, y1):
        """Something drawn here that stops a player (a pier, a gate, a fence): a ring on the plan, heights as ours."""
        pts = [self.world(u, d) for u, d in ring]
        self.blocks.append({"m": m, "p": [[[round(p.x, 3), round(p.y, 3)] for p in pts]], "y0": round(y0, 3), "y1": round(y1, 3)})

    def seg_block(self, m, a, b, width, y0, y1):
        t = Vector((b[0] - a[0], b[1] - a[1])).normalized()
        n = Vector((t.y, -t.x)) * (width / 2)
        self.block(m, [(a[0] + n.x, a[1] + n.y), (b[0] + n.x, b[1] + n.y), (b[0] - n.x, b[1] - n.y), (a[0] - n.x, a[1] - n.y)], y0, y1)

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
        root["replaces"] = self.replaces
        if self.blocks:  # read by main.ts loadModel: heights over the ground at the origin
            root["blocks"] = self.blocks
            root["blocksOnGround"] = True
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
