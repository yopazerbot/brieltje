"""The toolkit of the hand-made village houses: `House`, `Opening`, the ground, the export to .glb. The packages'
scripts (tools/village_houses_b1.py, _b2.py, ...) import it and hold only their houses:

  blender -b -P tools/village_houses_b2.py -- web/public/models [vh_fermette ...]

The first argument after `--` is the folder the .glb files go to, the rest the houses to build (all when none).
Each house stands in for one generated house: it is found in web/src/data/village.json by a corner of its wall block,
whose outline becomes the model's `replaces` (the block stays in the data for walking into and for the server, so
every wall keeps within 0.15 m of it). The root's `origin` lies on the ground at the middle of the front wall;
heights are metres over the ground there. See tools/village_houses_b1.py for the names of the meshes and what the game
does with each. Below the export: `Snapped` (a House whose walls end on the outline's corners), roofs as sets of
planes over a footprint (`Roof`, `draw_roofs`, `top_over`) and details on a wall (`muntins`, `seg_arch`, ...), first
written for the second package (tools/village_houses_b2.py).
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
                if isinstance(color, list):  # a value per corner (the streaks'): turned with them
                    color = color[::-1]
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
        self.streaks(openings, W, N, color or self.meshes.get(mesh, {}).get("tint", "#ffffff"), botf)
        return W, N, T

    def streaks(self, openings, W, N, wallcol, bottom):
        """Faint streaks where rain runs off the windows' sills and down the wall (as tools/town/town.py `streaks`):
        one from each end of the sill and a wash under its middle, fading out downwards, into the mesh vh_streaks_small
        that the game draws as a multiply over the wall (web/src/world/rainStreaks.ts). None reaches the foot of the
        wall (`bottom`: its foot along it, or the ground) or the head of an opening below. Darker on a light wall,
        where the game's tone curve flattens a multiply. Seeded by the house and the window's place, so they stay."""
        h = wallcol.lstrip("#")
        light = max(0.0, min(1.0, (sum(int(h[i:i + 2], 16) for i in (0, 2, 4)) / 765 - 0.45) / 0.4))
        for o in openings:
            if o.kind != "window" or o.w < .3:
                continue
            s0, s1 = o.s - o.w / 2, o.s + o.w / 2
            yt = o.y - (.06 if o.sill else 0)
            p = W(o.s, 0)
            ground = self.ground(p[0], p[1])
            if yt - ground < .9:
                continue
            r = random.Random(f"streak:{self.name}:{p[0]:.2f}:{p[1]:.2f}:{o.y:.2f}")

            def floor_of(a, b):
                lim = max(ground + .45, bottom(a) + .3, bottom(b) + .3)
                for g in openings:
                    if g is o or g.s + g.w / 2 + .1 < a or g.s - g.w / 2 - .1 > b:
                        continue
                    if g.y + g.h <= yt + 1e-6:
                        lim = max(lim, g.y + g.h + .28)
                return lim

            def face(pts, ks):
                self.poly("vh_streaks_small", [W(s, y, -.012) for s, y in pts], N, list(ks))

            for sc in (s0 - .03, s1 + .03):  # from the sill's ends
                if r.random() > .85:
                    continue
                wd = r.uniform(.12, .2)
                k = r.uniform(.56, .68) - .22 * light
                L = min(r.uniform(.5, 1.1), yt - floor_of(sc - wd / 2, sc + wd / 2))
                if L < .25:
                    continue
                ym, yb, km = yt - .4 * L, yt - L, 1 - (1 - k) * .55
                top = [sc - wd * .3, sc, sc + wd * .3]
                mid = [sc - wd * .45, sc, sc + wd * .45]
                bot = [sc - wd / 2, sc, sc + wd / 2]
                for i in range(2):
                    face([(top[i], yt), (top[i + 1], yt), (mid[i + 1], ym), (mid[i], ym)], [1.0 if i == 0 else k, k if i == 0 else 1.0, km if i == 0 else 1.0, 1.0 if i == 0 else km])
                    face([(mid[i], ym), (mid[i + 1], ym), (bot[i + 1], yb), (bot[i], yb)], [1.0 if i == 0 else km, km if i == 0 else 1.0, 1.0, 1.0])
            if r.random() < .7 and o.w > .5:  # the wash under the sill's middle
                k = r.uniform(.78, .86) - .14 * light
                a, b = s0 + .12, s1 - .12
                L = min(r.uniform(.2, .4), yt - floor_of(a, b))
                if L >= .15:
                    cols, kt = [s0 - .04, a, b, s1 + .04], [1.0, k, k, 1.0]
                    for i in range(3):
                        face([(cols[i], yt), (cols[i + 1], yt), (cols[i + 1], yt - L), (cols[i], yt - L)], [kt[i], kt[i + 1], 1.0, 1.0])

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
            spec = self.meshes[name] if name in self.meshes else KIT_MESHES[name]
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
            if spec.get("streaks"):
                mat["streaks"] = True  # drawn by the game as a multiply over the walls (web/src/world/rainStreaks.ts)
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
            elif spec.get("streaks"):
                # How much each corner darkens the wall behind it (1: not at all), as it is: no colour space.
                colors = mesh.color_attributes.new(name="Color", type="FLOAT_COLOR", domain="CORNER")
                for poly, (_, ks) in zip(mesh.polygons, polygons):
                    for k, li in zip(ks, poly.loop_indices):
                        colors.data[li].color = (k, k, k, 1)
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


# Meshes every house may have without naming them: the rain's streaks under the sills (House.streaks).
KIT_MESHES = {"vh_streaks_small": {"tint": "#ffffff", "streaks": True}}

GLASS = {"tint": "#46514f", "rough": .2, "metal": .2}
TRIM = {"tint": "#ffffff", "rough": .82}
STONE = {"tint": "#a8a59f", "rough": .9}
SMALL = {"tint": "#ffffff", "rough": .6}
METAL = {"tint": "#ffffff", "rough": .5, "metal": .35}


class Snapped(House):
    """The toolkit's House, its walls' ends drawn onto the outline's corners where they lie within 10 cm of one,
    so two walls meeting at a corner leave no slit (the measures here are rounded to the centimetre)."""

    def snap(self, p):
        q = min(self.ring, key=lambda r: (r[0] - p[0]) ** 2 + (r[1] - p[1]) ** 2)
        return tuple(q) if (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < .01 else tuple(p)

    def wall(self, a, b, *args, **kw):
        return super().wall(self.snap(a), self.snap(b), *args, **kw)


# ======================================================================================================================
# Roofs as planes over a footprint.
def lefts(poly):
    """The polygon counter-clockwise (positive area), and for each edge a function >= 0 on its inner side."""
    poly = list(poly)
    if area(poly) < 0:
        poly.reverse()
    fs = []
    for i, a in enumerate(poly):
        b = poly[(i + 1) % len(poly)]
        fs.append(lambda p, a=a, b=b: (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]))
    return poly, fs


def clip_convex(poly, convex):
    _, fs = lefts(convex)
    for f in fs:
        if len(poly) < 3:
            return []
        poly = clip_half(poly, f)
    return poly if len(poly) >= 3 and abs(area(poly)) > 1e-6 else []


def minus_convex(poly, convex):
    """The parts of a convex polygon outside a convex one, as convex pieces."""
    _, fs = lefts(convex)
    pieces, rest = [], poly
    for f in fs:
        out = clip_half(rest, lambda p, f=f: -f(p))
        if len(out) >= 3 and abs(area(out)) > 1e-6:
            pieces.append(out)
        rest = clip_half(rest, f)
        if len(rest) < 3:
            break
    return pieces


def at(pl, u, d):
    return pl[0] + pl[1] * u + pl[2] * d


def eave(a, inward, y, k):
    """A roof plane through the eaves line at point a (u, d), height y, rising k per metre toward `inward`."""
    n = Vector(inward).normalized()
    return (y - k * (a[0] * n.x + a[1] * n.y), k * n.x, k * n.y)


class Roof:
    def __init__(self, footprint, planes, under="#e8e6e0", edge="#ecebe6", thick=.14, board=.2, mesh="vh_roof", ridge_r=.11, ridge_mesh="vh_roof"):
        self.F, self.Ffs = lefts(footprint)
        self.planes = planes
        self.under, self.edge, self.thick, self.board, self.mesh = under, edge, thick, board, mesh
        self.ridge_r, self.ridge_mesh = ridge_r, ridge_mesh
        self.regions = []
        for i, pl in enumerate(planes):
            poly = list(self.F)
            for j, q in enumerate(planes):
                if j != i and len(poly) >= 3:
                    poly = clip_half(poly, lambda p, pl=pl, q=q: at(q, *p) - at(pl, *p))
            self.regions.append(poly if len(poly) >= 3 and abs(area(poly)) > 1e-6 else [])
        self.cuts = []  # convex holes (a wall dormer's notch in the eaves)

    def height(self, u, d):
        return min(at(pl, u, d) for pl in self.planes)

    def covers(self, u, d, pad=1e-6):
        return all(f((u, d)) >= -pad for f in self.Ffs)

    def on_edge(self, p, q):
        """The edge p-q lies on the footprint's outline (a free edge: it gets a board)."""
        for i, a in enumerate(self.F):
            b = self.F[(i + 1) % len(self.F)]
            L = math.hypot(b[0] - a[0], b[1] - a[1])
            if all(abs((b[0] - a[0]) * (r[1] - a[1]) - (b[1] - a[1]) * (r[0] - a[0])) / L < 1e-4 for r in (p, q)):
                return True
        return False


def draw_roofs(h, roofs):
    """Each roof's planes where they are its lowest and above every other roof over the same ground."""
    for A in roofs:
        for i, poly in enumerate(A.regions):
            if not poly:
                continue
            pl = A.planes[i]
            pieces = [poly]
            for B in roofs:
                if B is A:
                    continue
                nxt = []
                for piece in pieces:
                    nxt += minus_convex(piece, B.F)
                    for k, breg in enumerate(B.regions):
                        if not breg:
                            continue
                        part = clip_convex(piece, breg)
                        if part:
                            part = clip_half(part, lambda p, bq=B.planes[k]: at(pl, *p) - at(bq, *p))
                            if len(part) >= 3 and abs(area(part)) > 1e-6:
                                nxt.append(part)
                pieces = nxt
            for cut in A.cuts:
                pieces = [q for piece in pieces for q in minus_convex(piece, cut)]
            for piece in pieces:
                pts = [(u, d, at(pl, u, d)) for u, d in piece]
                free = [k for k in range(len(piece)) if A.on_edge(piece[k], piece[(k + 1) % len(piece)])]
                h.roof(pts, free=free, under=A.under, edge=A.edge, thick=A.thick, board=A.board)
                if A.mesh != "vh_roof":  # the kit draws tiles in vh_roof: move this piece's top to the roof's own mesh
                    top = h.faces["vh_roof"].pop()
                    h.faces[A.mesh].append((top[0], A.edge))
        # The ridges and hips: the edges where two of its planes meet, where this roof is drawn.
        for i, poly in enumerate(A.regions):
            for k in range(len(poly)):
                p, q = poly[k], poly[(k + 1) % len(poly)]
                for j in range(i + 1, len(A.planes)):
                    if all(abs(at(A.planes[i], *r) - at(A.planes[j], *r)) < 1e-5 for r in (p, q)) and math.dist(p, q) > .05:
                        a3 = Vector((p[0], p[1], at(A.planes[i], *p)))
                        b3 = Vector((q[0], q[1], at(A.planes[i], *q)))
                        if any(A is not B and B.covers(*((a3 + b3) / 2).xy) and B.height(*((a3 + b3) / 2).xy) > ((a3 + b3) / 2).z for B in roofs):
                            continue  # under another roof
                        if A.ridge_mesh == "vh_roof":
                            h.rod("vh_roof", tuple(a3 + Vector((0, 0, .02))), tuple(b3 + Vector((0, 0, .02))), A.ridge_r, 6)
                        else:
                            h.rod(A.ridge_mesh, tuple(a3 + Vector((0, 0, .02))), tuple(b3 + Vector((0, 0, .02))), A.ridge_r, 6, A.edge)


def top_over(roofs, a, b, drop=.06, also=()):
    """A wall's top on the plan line a to b: under the highest roof over it, (s, y) points where it bends."""
    a, b = Vector(a), Vector(b)
    L = (b - a).length
    n = max(2, int(L / .05))
    pts = []
    for i in range(n + 1):
        s = L * i / n
        p = a + (b - a) * (s / L)
        ys = [R.height(p.x, p.y) for R in roofs if R.covers(p.x, p.y, .02)] + [f(p.x, p.y) for f in also]
        pts.append((s, max(ys) - drop))
    keep = [pts[0]]
    for i in range(1, len(pts) - 1):
        (s0, y0), (s1, y1), (s2, y2) = keep[-1], pts[i], pts[i + 1]
        if abs(y0 + (y2 - y0) * (s1 - s0) / (s2 - s0) - y1) > 1e-4:
            keep.append(pts[i])
    keep.append(pts[-1])
    return keep


# ======================================================================================================================
# Details on a wall, in its own measures (W, N, T from House.wall).
def muntins(h, W, N, T, o, rows=2, cols=2, color=None):
    """Glazing bars over a window: small panes."""
    s0, s1, y0, y1, r = o.s - o.w / 2, o.s + o.w / 2, o.y, o.y + o.h, o.reveal
    c = color or o.frame
    for k in range(1, cols):
        x = s0 + o.w * k / cols
        h.wbox(W, N, T, "vh_frames_small", x - .018, x + .018, y0 + .06, y1 - .06, r - .06, r - .03, c)
    for k in range(1, rows):
        y = y0 + o.h * k / rows
        h.wbox(W, N, T, "vh_frames_small", s0 + .06, s1 - .06, y - .018, y + .018, r - .06, r - .03, c)


def shutters(h, W, N, T, o, color):
    """Two wooden shutters standing open, flat against the wall beside the window, with a rail across each."""
    for s, sgn in ((o.s - o.w / 2, -1), (o.s + o.w / 2, 1)):
        a, b = sorted((s + sgn * .04, s + sgn * (.04 + o.w / 2)))
        h.wbox(W, N, T, "vh_frames_small", a, b, o.y, o.y + o.h, -.04, 0, color)
        for y in (o.y + .25, o.y + o.h - .25):
            h.wbox(W, N, T, "vh_frames_small", a + .03, b - .03, y - .04, y + .04, -.055, -.04, color)


def shutter_box(h, W, N, T, o, color="#f1f0ec"):
    """A roller shutter's box over a window, in the reveal's head: the blind rolled up, a white strip."""
    s0, s1, y1, r = o.s - o.w / 2, o.s + o.w / 2, o.y + o.h, o.reveal
    h.wbox(W, N, T, "vh_trim", s0, s1, y1 - .2, y1, .03, r - .05, color)


def seg_arch(h, W, N, T, s0, s1, y, rise, ring, mesh, color, steps=6, proud=.025):
    """A shallow brick arch over an opening from s0 to s1 springing at y: a band `ring` deep, a little proud."""
    c = s1 - s0
    R = (c * c / 4 + rise * rise) / (2 * rise)
    cx, cy = (s0 + s1) / 2, y + rise - R
    a0 = math.atan2(y - cy, s0 - cx)
    a1 = math.atan2(y - cy, s1 - cx)
    for i in range(steps):
        t0, t1 = a0 + (a1 - a0) * i / steps, a0 + (a1 - a0) * (i + 1) / steps
        p = [(cx + R * math.cos(t), cy + R * math.sin(t)) for t in (t0, t1)]
        q = [(cx + (R + ring) * math.cos(t), cy + (R + ring) * math.sin(t)) for t in (t0, t1)]
        h.poly(mesh, [W(*p[0], -proud), W(*p[1], -proud), W(*q[1], -proud), W(*q[0], -proud)], N, color)
        tm = (t0 + t1) / 2
        h.poly(mesh, [W(*q[0], -proud), W(*q[1], -proud), W(*q[1], 0), W(*q[0], 0)],
                tuple(T[k] * math.cos(tm) + (0, 0, 1)[k] * math.sin(tm) for k in range(3)), color)


def lamp(h, W, N, T, s, y):
    h.wbox(W, N, T, "vh_metal_small", s - .07, s + .07, y, y + .22, -.12, 0, "#2f3134")
    h.wbox(W, N, T, "vh_metal_small", s - .055, s + .055, y + .03, y + .17, -.125, -.12, "#d8d4c8")


def edge_at(h, world_pts, d=None, u=None):
    """A point on a polyline of the street's edge (world x, z), in the house's frame, where it crosses d (or u)."""
    loc = [h.local(p) for p in world_pts]
    for p, q in zip(loc, loc[1:]):
        if d is not None and (p[1] - d) * (q[1] - d) <= 0 and p[1] != q[1]:
            t = (d - p[1]) / (q[1] - p[1])
            return (round(p[0] + (q[0] - p[0]) * t, 4), d)
        if u is not None and (p[0] - u) * (q[0] - u) <= 0 and p[0] != q[0]:
            t = (u - p[0]) / (q[0] - p[0])
            return (u, round(p[1] + (q[1] - p[1]) * t, 4))
    raise ValueError(f"{h.name}: the street's edge does not cross d={d} u={u}")
