"""Home 4, the fourth private home, on Kapellenhoek: its outside and its levelled plot.

  blender -b -P tools/kapellenhoek_home.py -- web/public/models/kapellenhoek_home.glb

writes the model and two public data files, both outside facts only:
- data/kapellenhoek_home.json: the frame, the floor, the storeys, the outer walls and every opening in them, so the
  inside (built elsewhere, sealed) fits the shell to the centimetre;
- web/src/data/kapellenhoek_home_shell.json: the public shell the page reads (the walk-in of
  world/walkIn.ts): the frame, the outside doors and the panes, the levelled plot (its dip,
  the ground cut out under it, its lawn) and `solids`, the house as lumps for walking into.

The house is found in web/src/data/village.json by the first corner of its wall block and is keyed by model
coordinates only, never by an address. Its sizes and openings were measured on the reference images (private source
files, not in the repository); nothing of them is stored here but the numbers below, and nothing personal is
modelled (no number, name, letterbox or plate). Materials are the game's own textures by name and tint, or flat
colours per corner: no image is in the file.

The frame (every size below is in it): origin A, the front's left end seen from the street; u runs along the front
to the right, v into the house (the street lies at negative v); y is metres over the ground floor F. A world point
is A + u T + v N. The shell file uses world/walkIn.ts's frame: x = -u, z = v, turned by `a` round `o` = A.

Mesh names follow world/villageHouses.ts (snow, wet ground and glass know them). The panes (`vh_glass`) and the
leaves of the outside doors (`vh_doors`) have `shut` in their material's extras: near the house the walk-in shows its
own glass and doors in their place. Package A of home 4 has no inside: the house is shut for everyone.
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
OUT = Path(args[0] if args else ROOT / "web/public/models/kapellenhoek_home.glb").resolve()
DATA_OUT = ROOT / "data/kapellenhoek_home.json"
SHELL_OUT = ROOT / "web/src/data/kapellenhoek_home_shell.json"
VILLAGE = json.loads((ROOT / "web/src/data/village.json").read_text(encoding="utf-8"))
SIZES = json.loads((ROOT / "web/public/textures/sizes.json").read_text(encoding="utf-8"))
GROUND = json.loads((ROOT / "web/src/data/house_shell.json").read_text(encoding="utf-8"))["ground"]  # the game's flat ground (-0.1)

# --- the looks: one constant each, so a colour changes in one line --------------------------------------------------
BRICK = "#985545"  # the brick's tint: a mixed red-brown brick (nb_brick's own joints stay pale)
ROOF = "#3a3632"  # dark brown-grey concrete tiles
FRAME = "#33363a"  # anthracite window and door frames
STONE = "#7f877e"  # grey-green stone lintels and sills
WOOD = "#6e4a32"  # the front door, the garage door and the back doors: warm brown boards
FASCIA = "#4a3528"  # the terrace canopy's timber
ZINC = "#6f7477"  # gutters and downpipes
SLEEPER = "#2e2925"  # the dark sleepers at the garden's edge

# --- the ground: the same centimetre grid and triangle diagonal as shared/terrain.mjs --------------------------------
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


# --- the spot --------------------------------------------------------------------------------------------------------
CORNER = (613.14, -361.86)
_blocks = [p for p in VILLAGE["prisms"] if p.get("d") is None and any(abs(q[0] - CORNER[0]) < .02 and abs(q[1] - CORNER[1]) < .02 for q in p["p"][0])]
if not _blocks:
    raise ValueError(f"no wall block has the corner {CORNER}; the data changed, review home 4")
OUTLINE = max((b["p"][0] for b in _blocks), key=len)
A = Vector(CORNER)
T = (Vector(OUTLINE[2]) - A).normalized()  # along the front, to its far end at the garage
N = Vector((T.y, -T.x))
if (Vector(tuple(sum(c) / len(c) for c in zip(*OUTLINE))) - A).dot(N) < 0:
    N = -N
_us = [(Vector(q) - A).dot(T) for q in OUTLINE]
_vs = [(Vector(q) - A).dot(N) for q in OUTLINE]
LENGTH, DEPTH = max(_us) - min(_us), max(_vs) - min(_vs)
if abs(LENGTH - 15.96) > .06 or abs(DEPTH - 11.47) > .06 or min(_us) < -.05 or min(_vs) < -.05:
    raise ValueError(f"home 4's outline is {LENGTH:.2f} x {DEPTH:.2f} m now; the data changed, review the house")

FT = 3.55  # the ground floor in the relief's heights: 15 cm over the ground at the front door
F = FT + GROUND  # the same in the game's heights
Z0 = FT - terrain(*A)  # the model's heights are over the ground at its origin A
LAWN = -.04  # the levelled garden, below the floor


def world(u, v):
    return A + T * u + N * v


def g(u, v):
    """The relief at (u, v), over the floor."""
    return terrain(*world(u, v)) - FT


def wpt(u, v, nd=3):
    p = world(u, v)
    return [round(p.x, nd), round(p.y, nd)]


def shell_pt(u, v, nd=3):
    """walkIn.ts's frame: x = -u, z = v."""
    return [round(-u + 0.0, nd), round(v + 0.0, nd)]


# --- sizes (metres) --------------------------------------------------------------------------------------------------
UL = LENGTH  # the wing's right wall (16.00 on the reference images: 4 cm off the garage's width to fit the outline)
VB = DEPTH  # the back of the rear part and the wing (11.52: 5 cm off to fit)
UM = 11.67  # the main block's right side on the ground floor, the wing's left
UMU = 11.91  # upstairs: its right gable stands on the garage's wall
VM = 9.00  # the main block's back
UR = 4.98  # the rear part's left side, the terrace notch's right
WALL = .36
EAVE, RIDGE, VR = 5.65, 9.5, VM / 2  # the main roof, ridge along the front
PITCH = (RIDGE - EAVE) / VR
OVER = .25  # its eaves overhang
WEAVE, WTOP = 3.5, 5.95  # the wing: eaves, and its roof's top against the main block's gable
WK = (WTOP - WEAVE) / (UL - UMU)
WOVER = .18
FLAT = 3.1  # the rear part's roof edge and the terrace canopy
STOREYS = {"ceiling": 2.60, "first": 2.90, "firstCeiling": 5.40}


def main_roof(v):
    return EAVE + PITCH * (VR - abs(v - VR) if 0 <= v <= VM else (v if v < 0 else VM - v))


def wing_roof(u, v):
    return WEAVE + WK * min(UL - u, v, VB - v)


# --- geometry helpers ------------------------------------------------------------------------------------------------
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
    """A hole in a wall: s its middle along the wall, y its bottom, w by h (over the floor).
    kind: window, door, garage, slide (sliding glass doors: leaf `move` slides, the others are fixed), glazing (fixed
    glass to the floor)."""

    def __init__(self, name, s, y, w, h, kind="window", cols=2, rows=3, reveal=.16, sill=True, lintel=True, top=0.0, leaves=2, door=None, move=None):
        self.__dict__.update(locals())
        del self.__dict__["self"]


class Home:
    def __init__(self, meshes):
        self.meshes = meshes
        self.faces = defaultdict(list)
        self.blocks = []
        self.walls = []
        self.openings = []
        self.panes = []
        self.doors = []
        lows = [g(u, v) for u in (0, 4, 8, 12, UL) for v in (0, 4, 8, VB)]
        self.foot = min(min(lows), LAWN) - .35

    def vertex(self, p):
        w = T * p[0] + N * p[1]
        return (w.x, -w.y, p[2] + Z0)

    # --- faces -----------------------------------------------------------------------------------------------------
    def poly(self, mesh, pts, facing=None, color=None):
        if len(pts) < 3:
            return
        n = newell(pts)
        if n[0] ** 2 + n[1] ** 2 + n[2] ** 2 < 1e-10:
            return
        if facing is not None and n[0] * facing[0] + n[1] * facing[1] + n[2] * facing[2] < 0:
            pts = pts[::-1]
        self.faces[mesh].append(([tuple(p) for p in pts], color))

    def box(self, mesh, u0, u1, d0, d1, y0, y1, color=None, bottom=False):
        self.prism(mesh, [(u0, d0), (u1, d0), (u1, d1), (u0, d1)], y0, y1, color, bottom=bottom)

    def prism(self, mesh, ring, y0, y1, color=None, top=True, bottom=False):
        ring = list(ring)
        if area(ring) < 0:
            ring.reverse()
        for i, a in enumerate(ring):
            b = ring[(i + 1) % len(ring)]
            self.poly(mesh, [(a[0], a[1], y0), (b[0], b[1], y0), (b[0], b[1], y1), (a[0], a[1], y1)], (b[1] - a[1], -(b[0] - a[0]), 0), color)
        if top:
            self.poly(mesh, [(u, d, y1) for u, d in ring], (0, 0, 1), color)
        if bottom:
            self.poly(mesh, [(u, d, y0) for u, d in ring], (0, 0, -1), color)

    def seg(self, mesh, a, b, width, y0, y1, color=None):
        t = Vector((b[0] - a[0], b[1] - a[1])).normalized()
        n = Vector((t.y, -t.x)) * (width / 2)
        self.prism(mesh, [(a[0] + n.x, a[1] + n.y), (b[0] + n.x, b[1] + n.y), (b[0] - n.x, b[1] - n.y), (a[0] - n.x, a[1] - n.y)], y0, y1, color)

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
            self.poly(mesh, [ra[i], ra[j], rb[j], rb[i]], (ra[i] + ra[j]) / 2 - a, color)
        if caps:
            self.poly(mesh, ra, -axis, color)
            self.poly(mesh, rb, axis, color)

    # --- walls -----------------------------------------------------------------------------------------------------
    def wall(self, name, a, b, out, top, openings=(), bottom=None, mesh="vh_brick", color=None):
        """The outer face of a wall on the plan line a to b, facing `out`, cut round its openings. `top`, `bottom`:
        metres over the floor, or (s, y) points along it (s from a)."""
        a, b = Vector(a), Vector(b)
        L = (b - a).length
        t = (b - a) / L
        n = Vector((t.y, -t.x))
        if n.dot(Vector(out)) < 0:
            n = -n
        N3, T3 = (n.x, n.y, 0), (t.x, t.y, 0)
        W = lambda s, y, dep=0.0: (a.x + t.x * s - n.x * dep, a.y + t.y * s - n.y * dep, y)
        topf, tops = profile(top)
        botf, bots = profile(self.foot if bottom is None else bottom)
        holes = [(o.s - o.w / 2, o.s + o.w / 2, o.y, o.y + o.h) for o in openings]
        xs = sorted({0.0, L, *[s for s in tops + bots if 0 < s < L], *[x for h in holes for x in h[:2] if 0 < x < L]})
        ys = sorted({y for h in holes for y in h[2:]})
        for x0, x1 in zip(xs, xs[1:]):
            if x1 - x0 < 1e-6:
                continue
            xm = (x0 + x1) / 2
            lo, hi = botf(xm), topf(xm)
            if hi <= lo + 1e-6:
                continue
            cuts = [lo] + [y for y in ys if lo < y < hi] + [hi]
            for y0, y1 in zip(cuts, cuts[1:]):
                ym = (y0 + y1) / 2
                if any(h[0] <= xm <= h[1] and h[2] <= ym <= h[3] for h in holes):
                    continue
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
                    self.poly(mesh, [W(x, y) for x, y in rect], N3, color)
        self.walls.append({"name": name, "a": [round(a.x, 3), round(a.y, 3)], "b": [round(b.x, 3), round(b.y, 3)], "out": [round(n.x, 3), round(n.y, 3)]})
        for o in openings:
            self.opening(name, o, a, t, n, W, N3, T3, mesh, color)

    def wbox(self, W, N3, T3, mesh, s0, s1, y0, y1, d0, d1, color=None, back=False):
        """A box in a wall's own measures: s along it, y up, d into it (negative: in front of it)."""
        inn = (-N3[0], -N3[1], 0)
        self.poly(mesh, [W(s0, y0, d0), W(s1, y0, d0), W(s1, y1, d0), W(s0, y1, d0)], N3, color)
        if back:
            self.poly(mesh, [W(s0, y0, d1), W(s1, y0, d1), W(s1, y1, d1), W(s0, y1, d1)], inn, color)
        self.poly(mesh, [W(s0, y1, d0), W(s1, y1, d0), W(s1, y1, d1), W(s0, y1, d1)], (0, 0, 1), color)
        self.poly(mesh, [W(s0, y0, d0), W(s1, y0, d0), W(s1, y0, d1), W(s0, y0, d1)], (0, 0, -1), color)
        self.poly(mesh, [W(s0, y0, d0), W(s0, y1, d0), W(s0, y1, d1), W(s0, y0, d1)], (-T3[0], -T3[1], 0), color)
        self.poly(mesh, [W(s1, y0, d0), W(s1, y1, d0), W(s1, y1, d1), W(s1, y0, d1)], T3, color)

    def opening(self, wall, o, a, t, n, W, N3, T3, mesh, color):
        s0, s1, y0, y1, r = o.s - o.w / 2, o.s + o.w / 2, o.y, o.y + o.h, o.reveal
        fw, fr = .065, "vh_frames_small"
        plan = lambda s, d: (a.x + t.x * s - n.x * d, a.y + t.y * s - n.y * d)
        self.openings.append({"id": o.name, "wall": wall, "kind": o.kind, "a": [round(x, 3) for x in plan(s0, 0)], "b": [round(x, 3) for x in plan(s1, 0)],
                              "y0": round(y0, 3), "y1": round(y1, 3), "depth": r})
        # The reveal, in the wall's own stuff
        for s, facing in ((s0, T3), (s1, (-T3[0], -T3[1], 0))):
            self.poly(mesh, [W(s, y0, 0), W(s, y0, r), W(s, y1, r), W(s, y1, 0)], facing, color)
        self.poly(mesh, [W(s0, y1, 0), W(s1, y1, 0), W(s1, y1, r), W(s0, y1, r)], (0, 0, -1), color)
        if not (o.sill and o.kind == "window"):
            self.poly(mesh, [W(s0, y0, 0), W(s1, y0, 0), W(s1, y0, r), W(s0, y0, r)], (0, 0, 1), color)

        def pane(sa, sb, ya, yb, depth=r):
            """A window's glass: drawn (shut) and listed for the shell, 2 cm thick just inside it."""
            self.poly("vh_glass", [W(sa, ya, depth), W(sb, ya, depth), W(sb, yb, depth), W(sa, yb, depth)], N3)
            self.panes.append({"p": [[plan(sa, depth - .02), plan(sb, depth - .02), plan(sb, depth), plan(sa, depth)]], "y0": round(ya, 3), "y1": round(yb, 3)})

        def frame(sa, sb, ya, yb, mesh_=fr, col=FRAME, d0=r - .07, d1=r):
            self.wbox(W, N3, T3, mesh_, sa, sa + fw, ya, yb, d0, d1, col)
            self.wbox(W, N3, T3, mesh_, sb - fw, sb, ya, yb, d0, d1, col)
            self.wbox(W, N3, T3, mesh_, sa + fw, sb - fw, ya, ya + fw, d0, d1, col)
            self.wbox(W, N3, T3, mesh_, sa + fw, sb - fw, yb - fw, yb, d0, d1, col)

        def leaf(sa, sb, depth, glass, swing=0.0, slide=0.0, color_=WOOD):
            """An outside door's leaf for the shell (walkIn.ts's frame, heights over the floor)."""
            pa, pb = plan(sa, depth), plan(sb, depth)
            # Which face is outside: the normal of a-b (doors.ts: (-dz, dx)) against the wall's outward one.
            dx, dz = (-pb[0]) - (-pa[0]), pb[1] - pa[1]
            nx, nz = -dz, dx
            outward = nx * (-n.x) + nz * n.y > 0
            panel = {"a": shell_pt(*pa), "b": shell_pt(*pb), "offset": 0, "thickness": .05 if glass else .06, "glass": glass,
                     "outside": 1 if outward else -1, "color": color_}
            if swing:
                panel["swing"] = -swing if outward else swing  # inwards
            if slide:  # along the wall, in the shell's frame
                panel["slide"] = [round(-(t.x * slide), 3), round(t.y * slide, 3)]
            if glass:
                panel["frame"] = .07
                panel["colorOut"] = color_
                if not slide:
                    panel["handle"] = False  # a fixed leaf: no handle
            else:
                panel["handle"] = swing != 0
            return panel

        if o.kind in ("window", "glazing"):
            k = o.cols
            for c in range(k):
                pane(s0 + o.w * c / k, s0 + o.w * (c + 1) / k, y0, y1)
            frame(s0, s1, y0, y1)
            for c in range(1, k):
                x = s0 + o.w * c / k
                self.wbox(W, N3, T3, fr, x - .03, x + .03, y0 + fw, y1 - fw, r - .065, r, FRAME)
            for c in range(1, o.rows):
                y = y0 + o.h * c / o.rows
                self.wbox(W, N3, T3, fr, s0 + fw, s1 - fw, y - .02, y + .02, r - .06, r, FRAME)
            if o.sill and o.kind == "window":
                self.wbox(W, N3, T3, "vh_stone", s0 - .05, s1 + .05, y0 - .07, y0, -.05, r, STONE)
        elif o.kind == "door":
            ylo, yhi = y0, y1 - o.top
            if o.top:  # a glazed top light in three panes
                for c in range(3):
                    pane(s0 + fw + (o.w - 2 * fw) * c / 3, s0 + fw + (o.w - 2 * fw) * (c + 1) / 3, yhi, y1)
                for c in (1, 2):
                    x = s0 + fw + (o.w - 2 * fw) * c / 3
                    self.wbox(W, N3, T3, fr, x - .025, x + .025, yhi, y1 - fw, r - .065, r, FRAME)
                self.wbox(W, N3, T3, fr, s0 + fw, s1 - fw, yhi - .03, yhi + .03, r - .07, r, FRAME)
            frame(s0, s1, y0 - fw, y1, d0=r - .06)
            d = r + .02
            self.wbox(W, N3, T3, "vh_doors", s0 + fw, s1 - fw, ylo, yhi - .03, d - .05, d, WOOD)
            x = s0 + fw + .12
            while x < s1 - fw - .05:  # the boards' joints
                self.poly("vh_doors", [W(x - .006, ylo + .03, d - .052), W(x + .006, ylo + .03, d - .052), W(x + .006, yhi - .06, d - .052), W(x - .006, yhi - .06, d - .052)], N3, "#3e2a1d")
                x += .12
            self.wbox(W, N3, T3, "vh_metal_small", s1 - fw - .14, s1 - fw - .1, ylo + .95, ylo + 1.15, d - .1, d - .05, "#2a2b2c")
            self.wbox(W, N3, T3, "vh_stone", s0 - .03, s1 + .03, y0 - .04, y0, -.04, r, STONE)
            self.doors.append({"id": o.door[0], "name": o.door[1], "level": "gf", "y0": round(ylo, 3), "y1": round(yhi, 3),
                               "panels": [leaf(s0 + fw, s1 - fw, d - .025, False, swing=1.6)]})
        elif o.kind == "garage":
            frame(s0, s1, y0 - fw, y1, d0=r - .06)
            d = r + .02
            self.wbox(W, N3, T3, "vh_doors", s0 + fw, s1 - fw, y0, y1 - fw, d - .05, d, WOOD)
            x = s0 + fw + .15
            while x < s1 - fw - .05:
                self.poly("vh_doors", [W(x - .007, y0 + .03, d - .052), W(x + .007, y0 + .03, d - .052), W(x + .007, y1 - fw - .03, d - .052), W(x - .007, y1 - fw - .03, d - .052)], N3, "#3e2a1d")
                x += .15
            p = leaf(s0 + fw, s1 - fw, d - .025, False)
            p["handle"] = False
            self.doors.append({"id": o.door[0], "name": o.door[1], "level": "gf", "y0": round(y0, 3), "y1": round(y1 - fw, 3), "panels": [p]})
        elif o.kind == "slide":
            frame(s0, s1, y0 - fw, y1, d0=r - .14)
            k = o.leaves
            lw = (o.w - 2 * fw) / k
            panels = []
            for c in range(k):
                sa = s0 + fw + lw * c - (.03 if c else 0)
                sb = s0 + fw + lw * (c + 1) + (.03 if c < k - 1 else 0)
                moving = c == o.move if o.move is not None else (c == k // 2 if k > 2 else c == k - 1)
                d = r - .03 if moving else r - .1  # the moving leaf runs in front of the fixed one(s)
                self.wbox(W, N3, T3, "vh_doors", sa, sb, y0, y0 + .09, d - .05, d, FRAME)
                self.wbox(W, N3, T3, "vh_doors", sa, sb, y1 - fw - .07, y1 - fw, d - .05, d, FRAME)
                self.wbox(W, N3, T3, "vh_doors", sa, sa + .07, y0 + .09, y1 - fw - .07, d - .05, d, FRAME)
                self.wbox(W, N3, T3, "vh_doors", sb - .07, sb, y0 + .09, y1 - fw - .07, d - .05, d, FRAME)
                self.poly("vh_glass", [W(sa + .07, y0 + .09, d - .025), W(sb - .07, y0 + .09, d - .025), W(sb - .07, y1 - fw - .07, d - .025), W(sa + .07, y1 - fw - .07, d - .025)], N3)
                panels.append(leaf(sa, sb, d - .025, True, slide=-(lw - .06) if moving else 0, color_=FRAME))
            self.doors.append({"id": o.door[0], "name": o.door[1], "level": "gf", "y0": round(y0, 3), "y1": round(y1 - fw, 3), "panels": panels})
            if o.sill:
                self.wbox(W, N3, T3, "vh_stone", s0 - .03, s1 + .03, y0 - .04, y0, -.04, r, STONE)
        if o.lintel:
            self.wbox(W, N3, T3, "vh_stone", s0 - .1, s1 + .1, y1, y1 + .16, -.02, 0, STONE)

    # --- roofs -----------------------------------------------------------------------------------------------------
    def roof(self, pts, free=(), under="#3a3937", edge="#2c2b29", thick=.14, board=None):
        """A roof plane of tiles (3D points), its underside and, on its free edges (i: pts[i] to pts[i+1]), a board."""
        if newell(pts)[2] < 0:
            pts = pts[::-1]
            k = len(pts)
            free = [(k - 2 - i) % k for i in free]
        self.poly("vh_roof", pts, (0, 0, 1))
        self.poly("vh_trim", [(u, d, y - thick) for u, d, y in pts], (0, 0, -1), under)
        cx = sum(p[0] for p in pts) / len(pts)
        cd = sum(p[1] for p in pts) / len(pts)
        for i in free:
            a, b = pts[i], pts[(i + 1) % len(pts)]
            deep = board or thick
            self.poly("vh_trim", [a, b, (b[0], b[1], b[2] - deep), (a[0], a[1], a[2] - deep)], ((a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cd, 0), edge)

    def gutter(self, a, b, out, down=()):
        """A gutter under an eaves edge (a to b, 3D at the board's foot), and downpipes at (u, v, foot) points."""
        o = Vector((out[0], out[1])).normalized()
        a2, b2 = Vector((a[0], a[1])) + o * .07, Vector((b[0], b[1])) + o * .07
        y = min(a[2], b[2])
        self.seg("vh_frames_small", tuple(a2), tuple(b2), .13, y - .11, y + .02, ZINC)
        for u, d, foot in down:
            p = Vector((u, d))
            t = (b2 - a2).normalized()
            q = a2 + t * max(0, min((b2 - a2).length, (p - a2).dot(t)))
            self.box("vh_frames_small", q.x - .04, q.x + .04, q.y - .04, q.y + .04, y - .4, y - .1, ZINC)
            if (q - p).length > .05:
                self.seg("vh_frames_small", tuple(q), tuple(p), .08, y - .46, y - .38, ZINC)
            self.box("vh_frames_small", p.x - .045, p.x + .045, p.y - .045, p.y + .045, foot - .05, y - .4, ZINC)

    # --- the plot --------------------------------------------------------------------------------------------------
    def surface(self, mesh, ring, height, cell=.5, color=None):
        """A surface over a plan ring at height(u, v), in cells (clipped to the ring)."""
        us, vs = [p[0] for p in ring], [p[1] for p in ring]
        u0, v0 = math.floor(min(us) / cell) * cell, math.floor(min(vs) / cell) * cell
        for i in range(int(math.ceil((max(us) - u0) / cell)) + 1):
            for j in range(int(math.ceil((max(vs) - v0) / cell)) + 1):
                a, b = u0 + i * cell, v0 + j * cell
                poly = list(ring)
                for f in (lambda p: p[0] - a, lambda p: a + cell - p[0], lambda p: p[1] - b, lambda p: b + cell - p[1]):
                    poly = clip_half(poly, f) if poly else poly
                if len(poly) >= 3 and abs(area(poly)) > 1e-4:
                    self.poly(mesh, [(u, v, height(u, v)) for u, v in poly], (0, 0, 1), color)

    def edge_faces(self, mesh, a, b, height, out, color=None, step=.5):
        """A face down from height(u, v) to below the ground along a to b, where the surface stands over the ground."""
        a, b = Vector(a), Vector(b)
        L = (b - a).length
        k = max(1, math.ceil(L / step))
        for i in range(k):
            p, q = a + (b - a) * (i / k), a + (b - a) * ((i + 1) / k)
            hp, hq = height(*p), height(*q)
            gp, gq = g(*p) - .12, g(*q) - .12
            if hp - gp < .13 and hq - gq < .13:
                continue
            self.poly(mesh, [(p.x, p.y, hp), (q.x, q.y, hq), (q.x, q.y, min(gq, hq - .05)), (p.x, p.y, min(gp, hp - .05))], (out[0], out[1], 0), color)

    def block(self, m, ring, y0, y1):
        """Something drawn here that stops a player, heights over the floor: in the model's `blocks` (over its origin's ground)."""
        self.blocks.append({"m": m, "p": [[wpt(u, v) for u, v in ring]], "y0": round(y0 + Z0, 3), "y1": round(y1 + Z0, 3)})

    # --- out -------------------------------------------------------------------------------------------------------
    def export(self, extras):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        root = bpy.data.objects.new("kapellenhoek_home", None)
        bpy.context.collection.objects.link(root)
        root["origin"] = [round(A.x, 4), round(A.y, 4)]
        for k, v in extras.items():
            root[k] = v
        triangles = 0
        report = []
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
            if spec.get("shut"):
                mat["shut"] = 1  # world/walkIn.ts shows it only from afar
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
                uv = mesh.uv_layers.new(name="UVMap")
                assert texture in SIZES
                for poly in mesh.polygons:
                    nrm = poly.normal
                    u = Vector((1, 0, 0)) if abs(nrm.z) > .99 else Vector((0, 0, 1)).cross(nrm).normalized()
                    v = nrm.cross(u)
                    for k in poly.loop_indices:
                        p = mesh.vertices[mesh.loops[k].vertex_index].co
                        uv.data[k].uv = (round(p.dot(u), 4), round(p.dot(v), 4))
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
            report.append(f"{name} {len(mesh.loop_triangles)}")
        OUT.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.export_scene.gltf(filepath=str(OUT), export_format="GLB", export_extras=True, export_yup=True,
                                  export_vertex_color="MATERIAL", export_cameras=False, export_lights=False)
        print(f"kapellenhoek_home: {triangles} triangles, {len(self.faces)} meshes, {OUT.stat().st_size} bytes; " + ", ".join(report))


# ======================================================================================================================
MESHES = {
    "vh_brick": {"texture": "nb_brick", "tint": BRICK, "normalScale": .7},
    "vh_roof": {"texture": "roof_tiles", "tint": ROOF, "normalScale": .35},
    "vh_paving": {"texture": "pavers", "tint": "#76746f"},
    "vh_gravel": {"texture": "terrace", "tint": "#d2d0ca"},  # the terrace's large pale slabs (wet and snow as gravel)
    "vh_hedge": {"texture": "hedge", "tint": "#7f9a6c", "normalScale": .8},
    "vh_trim": {"tint": "#ffffff", "rough": .82},
    "vh_stone": {"tint": "#ffffff", "rough": .9},
    "vh_glass": {"tint": "#46514f", "rough": .2, "metal": .2, "shut": True},
    "vh_doors": {"tint": "#ffffff", "rough": .6, "shut": True},
    "vh_frames_small": {"tint": "#ffffff", "rough": .6},
    "vh_metal_small": {"tint": "#ffffff", "rough": .45, "metal": .4},
    "vh_wood_small": {"tint": "#ffffff", "rough": .75},
}

h = Home(MESHES)
roof_under = lambda v: main_roof(v) - .03  # a gable's top, just under the roof's tiles

# --- the main block -----------------------------------------------------------------------------------------------
FRONT_GF = [1.07, 3.12, 8.13, 9.94]
FRONT_F1 = [1.07, 3.12, 6.37, 8.13, 9.94]
BACK_F1 = [1.04, 2.64, 5.39, 6.97, 10.06]
win = lambda name, u0, sill, head, **kw: Opening(name, u0 + .475, sill, .95, head - sill, **kw)
front = [win(f"front-gf-{i + 1}", u, 1.03, 2.16) for i, u in enumerate(FRONT_GF)]
front += [win(f"front-f1-{i + 1}", u, 3.86, 4.97) for i, u in enumerate(FRONT_F1)]
front.append(Opening("front-door", (6.37 + 7.35) / 2, 0, .98, 2.2, "door", reveal=.18, top=.25, door=("kh-home-front", "front door")))
h.wall("front", (0, 0), (UMU, 0), (0, -1), EAVE - .02, front)
h.wall("wing-front", (UMU, 0), (UL, 0), (0, -1), WEAVE - .02,
       [Opening("garage-door", (12.32 + 14.83) / 2 - UMU, 0, 2.51, 2.2, "garage", reveal=.18, door=("kh-home-garage", "garage door"))])
# A small timber panel left of the front door: vertical slats on a dark back.
h.box("vh_trim", 5.07, 5.93, -.03, 0, 1.0, 1.9, "#2b2420")
for i in range(7):
    s = 5.11 + i * .12
    h.box("vh_trim", s, s + .08, -.06, -.03, 1.0, 1.9, WOOD)
# The left gable: a tall fixed glazed opening to the side garden (it does not open), no window upstairs.
h.wall("left", (0, 0), (0, VM), (-1, 0), [(0, roof_under(0)), (VR, roof_under(VR)), (VM, roof_under(VM))],
       [Opening("side-glass", (3.30 + 5.10) / 2, 0, 1.8, 2.2, "glazing", cols=1, rows=1, sill=False)])
# The right gable upstairs, over the wing's roof.
h.wall("right-f1", (UMU, 0), (UMU, VM), (1, 0), [(0, roof_under(0)), (VR, roof_under(VR)), (VM, roof_under(VM))], bottom=3.3)
# The back: on the terrace three glass leaves, only the right-hand one (seen from inside) sliding; upstairs five windows;
# over the rear part's flat roof.
back = [win(f"back-f1-{i + 1}", u, 3.86, 4.97) for i, u in enumerate(BACK_F1)]
h.wall("back-terrace", (0, VM), (UR, VM), (0, 1), EAVE - .02,
       [Opening("terrace-door", (.95 + 4.95) / 2, 0, 4.0, 2.3, "slide", leaves=3, move=2, sill=False, lintel=False, door=("kh-home-terrace", "sliding door"))]
       + [o for o in back if o.s < UR])
h.wall("back", (UR, VM), (UMU, VM), (0, 1), EAVE - .02, [Opening(o.name, o.s - UR, o.y, o.w, o.h) for o in back if o.s > UR], bottom=FLAT - .2)
# --- the rear part (flat roof) and the terrace ---------------------------------------------------------------------
h.wall("rear-left", (UR, VM), (UR, VB), (-1, 0), FLAT,
       [Opening("terrace-glass", (9.2 + 11.45) / 2 - VM, 0, 2.25, 2.3, "glazing", cols=2, rows=1, sill=False, lintel=False)])
h.wall("rear", (UR, VB), (UM, VB), (0, 1), FLAT,
       [Opening("rear-window", (5.3 + 8.6) / 2 - UR, 1.15, 3.3, .85, cols=3, rows=1),
        Opening("back-door", (9.76 + 10.77) / 2 - UR, 0, 1.01, 2.15, "door", reveal=.18, door=("kh-home-back", "back door"))])
# Its roof: a dark membrane inside a stone coping.
h.box("vh_stone", UR, UM, VM, VB, FLAT - .2, FLAT - .15, "#3b3b3a")
h.box("vh_stone", UR - .03, UM, VB - .3, VB + .03, FLAT - .2, FLAT, "#8d8c87")
h.box("vh_stone", UR - .03, UR + .3, VM, VB - .3, FLAT - .2, FLAT, "#8d8c87")
# The terrace's canopy: timber at the flat roof's height, a dark fascia, a post at the outer corner; a slim black steel
# column where the two glass walls meet.
h.box("vh_stone", -.05, UR - .03, VM, VB, FLAT - .2, FLAT - .15, "#3b3b3a")
h.box("vh_trim", -.05, UR - .03, VM, VB, FLAT - .25, FLAT - .2, FASCIA)
h.box("vh_trim", -.08, UR - .03, VB - .03, VB + .03, FLAT - .25, FLAT, FASCIA)
h.box("vh_trim", -.08, -.02, VM, VB - .03, FLAT - .25, FLAT, FASCIA)
h.box("vh_trim", -.02, .13, VB - .2, VB - .05, LAWN, FLAT - .25, FASCIA)
h.box("vh_metal_small", UR - .05, UR + .03, VM - .03, VM + .05, 0, FLAT - .2, "#151515")
# --- the garage wing -------------------------------------------------------------------------------------------------
h.wall("wing-right", (UL, 0), (UL, VB), (1, 0), WEAVE - .02,
       [Opening("wing-window", (8.20 + 10.00) / 2, 1.2, 1.8, .9, cols=2, rows=1)])
h.wall("wing-back", (UM, VB), (UL, VB), (0, 1), WEAVE - .02,
       [Opening("store-door", (11.96 + 12.93) / 2 - UM, 0, .97, 2.15, "door", reveal=.18, door=("kh-home-store", "store door"))])
# Over the rear part's roof, the wing's side up to its back slope.
h.wall("wing-left", (UM, VM), (UM, VB), (-1, 0), [(0, wing_roof(UM, VM) - .03), (VB - VM, WEAVE - .02)], bottom=FLAT - .2)

# --- roofs -----------------------------------------------------------------------------------------------------------
ye = EAVE - OVER * PITCH
h.roof([(-.05, -OVER, ye), (UMU + .05, -OVER, ye), (UMU + .05, VR, RIDGE), (-.05, VR, RIDGE)], free=(0, 1, 3), board=.22)
h.roof([(-.05, VM + OVER, ye), (UMU + .05, VM + OVER, ye), (UMU + .05, VR, RIDGE), (-.05, VR, RIDGE)], free=(0, 1, 3), board=.22)
h.rod("vh_roof", (-.06, VR, RIDGE + .02), (UMU + .06, VR, RIDGE + .02), .1, 6)
# The verges' dark boards on the gables, a little proud.
for u, out in ((-.05, -1), (UMU + .05, 1)):
    for v0, v1 in ((-OVER, VR), (VR, VM + OVER)):
        y0, y1 = main_roof(v0), main_roof(v1)
        h.poly("vh_trim", [(u, v0, y0 + .03), (u, v1, y1 + .03), (u, v1, y1 - .25), (u, v0, y0 - .25)], (out, 0, 0), "#2c2b29")
we = WEAVE - WOVER * WK
FR, BR = (UL + WOVER, -WOVER, we), (UL + WOVER, VB + WOVER, we)
v_top0, v_top1 = UL - UMU, VB - (UL - UMU)
TF, TB = (UMU, v_top0, WTOP), (UMU, v_top1, WTOP)
h.roof([FR, BR, TB, TF], free=(0,))
h.roof([(UMU, -WOVER, we), FR, TF], free=(0,))
h.roof([BR, (UM - .1, VB + WOVER, we), (UM - .1, VM, wing_roof(UL, VM)), (UMU, VM, wing_roof(UL, VM)), TB], free=(0, 1))
for a, b in ((FR, TF), (BR, TB)):  # the hips' ridge tiles
    h.rod("vh_roof", (a[0], a[1], a[2] + .02), (b[0], b[1], b[2] + .02), .08, 6)
# Gutters, zinc-grey; downpipes at the main block's two front ends, at the wing's outer corners and at the back.
gy = ye - .2
h.gutter((-.05, -OVER, gy), (UMU + .05, -OVER, gy), (0, -1), down=[(.15, -.06, -.6), (UMU - .2, -.06, -.6)])
h.gutter((-.05, VM + OVER, gy), (UMU + .05, VM + OVER, gy), (0, 1), down=[(UM - .3, VM + .06, FLAT - .17)])
wg = we - .2
h.gutter((UMU, -WOVER, wg), (FR[0], FR[1], wg), (0, -1), down=[(UL - .12, -.06, -.6)])
h.gutter((FR[0], FR[1], wg), (BR[0], BR[1], wg), (1, 0))
h.gutter((UM - .1, BR[1], wg), (BR[0], BR[1], wg), (0, 1), down=[(UL - .12, VB + .06, LAWN - .3), (UM + .12, VB + .06, LAWN - .3)])

# --- the plot -------------------------------------------------------------------------------------------------------
LV = [(-4.5, 0.0), (17.4, 0.0), (17.4, 19.5), (-4.5, 19.5)]  # the levelled garden, at LAWN over the floor (a dip)
PLOT = [(-4.8, -3.6), (17.7, -3.6), (17.7, 20.4), (-4.8, 20.4)]  # the house's plot: the village's covers and trees in it give way
TERRACE = [(0, VM), (UR, VM), (UR, VB), (13.1, VB), (13.1, VB + 1.3), (0, VB + 1.3)]
LAWN_RING = [(-4.5, 0), (0, 0), (0, VB + 1.3), (13.1, VB + 1.3), (13.1, VB), (UL, VB), (UL, 0), (17.4, 0), (17.4, 19.5), (-4.5, 19.5)]
h.surface("vh_gravel", TERRACE, lambda u, v: -.012, cell=1.0)
h.edge_faces("vh_stone", (0, VB + 1.3), (13.1, VB + 1.3), lambda u, v: -.012, (0, 1), "#a9a7a1")

# The drive: grey pavers from the street to the garage door, as wide as the wing and on to the passage beside it,
# widening along the house to the front door; a path from the street to the door. It rises evenly from the street's
# edge (v -3.5) to the garage's sill; along the house it lies a step below the front door.
STREET_V, SILL_V = -3.5, -.8
street_edge = lambda u: g(u, STREET_V) + .1


def drive_h(u, v):
    t = max(0.0, min(1.0, (v - STREET_V) / (SILL_V - STREET_V)))
    return street_edge(u) + (0 - street_edge(u)) * t


def path_h(u, v):
    t = max(0.0, min(1.0, (v - STREET_V) / (-1.4 - STREET_V)))
    return street_edge(u) + (-.15 - street_edge(u)) * t


def paved_h(u, v):
    k = max(0.0, min(1.0, (u - 10.4) / 1.0))  # from the front door's level to the drive's over a metre
    return max(path_h(u, v) * (1 - k) + drive_h(u, v) * k, g(u, v) + .035)


PAVED = [(6.0, 0), (6.0, -1.4), (6.2, -1.4), (6.2, STREET_V), (7.5, STREET_V), (7.5, -1.4), (11.4, -1.4), (11.4, STREET_V), (17.4, STREET_V), (17.4, 0)]
h.surface("vh_paving", PAVED, paved_h)
for i, a in enumerate(PAVED):
    b = PAVED[(i + 1) % len(PAVED)]
    if a[1] == 0 and b[1] == 0:
        continue  # along the house
    if a[1] == STREET_V and b[1] == STREET_V:
        out = (0, -1)
    else:
        d = Vector((b[0] - a[0], b[1] - a[1])).normalized()
        out = (d.y, -d.x) if area(PAVED) > 0 else (-d.y, d.x)
    h.edge_faces("vh_stone", a, b, paved_h, out, "#8f8d88", step=.35)
# Its blocks for walking and driving on: strips a metre along the front and 35 cm deep, each at its middle's height.
for k in range(int(round((0 - STREET_V) / .35))):
    v0, v1 = STREET_V + k * .35, min(0, STREET_V + (k + 1) * .35)
    for u0 in [6.0 + .9 * i for i in range(13)]:
        u1 = min(u0 + .9, 17.4)
        piece = list(PAVED)
        for f in (lambda p: p[0] - u0, lambda p: u1 - p[0], lambda p: p[1] - v0, lambda p: v1 - p[1]):
            piece = clip_half(piece, f) if piece else piece
        if len(piece) < 3 or abs(area(piece)) < .02:
            continue
        cu, cv = sum(p[0] for p in piece) / len(piece), sum(p[1] for p in piece) / len(piece)
        h.block("pave_grey", [(round(u, 3), round(v, 3)) for u, v in piece], min(g(cu, cv), paved_h(cu, cv)) - .4, paved_h(cu, cv))
# The front door's step.
h.box("vh_stone", 6.25, 7.47, -.4, 0, -.2, -.02, "#9a9890")
h.block("concrete", [(6.25, -.4), (7.47, -.4), (7.47, 0), (6.25, 0)], -.4, -.02)

# The garden's edge: dark sleepers, 45 cm over the lawn (or a little over the higher ground beyond), a 1.8 m hedge
# on the back one; on the right a low kerb of them over the lower ground beside, where the passage leads out.


def sleepers(a, b, top_over, thick=.2, out=(0, 1), hedge=False):
    a, b = Vector(a), Vector(b)
    L = (b - a).length
    k = max(1, math.ceil(L / 1.0))
    t = (b - a) / L
    o = Vector(out)
    for i in range(k):
        p, q = a + t * (L * i / k), a + t * (L * (i + 1) / k)
        m = (p + q) / 2
        ground = min(g(*(m + o * .1)), g(*p), g(*q), LAWN)
        top = max(LAWN + top_over, g(*(m + o * .3)) + .05)
        ring = [tuple(p), tuple(q), tuple(q + o * thick), tuple(p + o * thick)]
        h.prism("vh_trim", ring, ground - .25, top, SLEEPER)
        for y in [LAWN + .15 * j for j in range(1, 6) if LAWN + .15 * j < top - .05]:  # the sleepers' joints
            h.poly("vh_trim", [(p.x - o.x * .002, p.y - o.y * .002, y - .006), (q.x - o.x * .002, q.y - o.y * .002, y - .006),
                               (q.x - o.x * .002, q.y - o.y * .002, y + .006), (p.x - o.x * .002, p.y - o.y * .002, y + .006)], (-o.x, -o.y, 0), "#1a1715")
        h.block("old_wood", ring, ground - .25, top)
        if hedge:
            rng = random.Random(f"{i}{a}")
            hb = [tuple(p + o * thick), tuple(q + o * thick), tuple(q + o * (thick + .65)), tuple(p + o * (thick + .65))]
            hg = min(g(*(m + o * .5)), top) - .1
            hh = LAWN + 1.8 + rng.uniform(-.06, .06)
            h.prism("vh_hedge", hb, hg, hh)
            h.block("nb_hedge", hb, hg, hh)


sleepers((-4.5, 19.5), (17.6, 19.5), .45, out=(0, 1), hedge=True)
sleepers((-4.5, 0), (-4.5, 19.5), .45, out=(-1, 0))
sleepers((0, 0), (-4.7, 0), .45, out=(0, -1))
sleepers((17.4, 0), (17.4, 19.5), .12, out=(1, 0))

# A generic wooden play tower with a slide on the lawn, and an outdoor table with four chairs on the terrace.
TU, TV = 12.4, 15.6
wood, slide_c = "#9a7652", "#3d8a4c"
for du, dv in ((0, 0), (1.2, 0), (0, 1.2), (1.2, 1.2)):
    h.box("vh_wood_small", TU + du - .05, TU + du + .05, TV + dv - .05, TV + dv + .05, LAWN - .1, LAWN + 2.6, wood)
h.box("vh_wood_small", TU - .05, TU + 1.25, TV - .05, TV + 1.25, LAWN + 1.15, LAWN + 1.22, wood)
for y in (LAWN + 1.5, LAWN + 1.85):
    h.box("vh_wood_small", TU - .05, TU + 1.25, TV + 1.2, TV + 1.26, y, y + .07, wood)
    h.box("vh_wood_small", TU + 1.2, TU + 1.26, TV - .05, TV + 1.25, y, y + .07, wood)
for v0, v1, y0, y1 in ((TV - .15, TV + .6, LAWN + 2.6, LAWN + 3.0), (TV + .6, TV + 1.35, LAWN + 3.0, LAWN + 2.6)):
    h.poly("vh_wood_small", [(TU - .15, v0, y0), (TU + 1.35, v0, y0), (TU + 1.35, v1, y1), (TU - .15, v1, y1)], (0, 0, 1), slide_c)
    h.poly("vh_wood_small", [(TU - .15, v0, y0 - .02), (TU + 1.35, v0, y0 - .02), (TU + 1.35, v1, y1 - .02), (TU - .15, v1, y1 - .02)], (0, 0, -1), slide_c)
for u in (TU - .05, TU + 1.25):
    h.poly("vh_wood_small", [(u, TV - .15, LAWN + 2.6), (u, TV + .6, LAWN + 3.0), (u, TV + 1.35, LAWN + 2.6)], (1 if u > TU else -1, 0, 0), wood)
# The slide: from the platform's left side down to the lawn.
sl = [(TU, TV + .35, LAWN + 1.22), (TU, TV + .85, LAWN + 1.22), (TU - 2.3, TV + .85, LAWN + .25), (TU - 2.3, TV + .35, LAWN + .25)]
h.poly("vh_wood_small", sl, (0, 0, 1), slide_c)
h.poly("vh_wood_small", [(p[0], p[1], p[2] - .03) for p in sl], (0, 0, -1), slide_c)
for dv in (.35, .85):
    h.poly("vh_wood_small", [(TU, TV + dv, LAWN), (TU - 2.3, TV + dv, LAWN), (TU - 2.3, TV + dv, LAWN + .4), (TU, TV + dv, LAWN + 1.37)], (0, 1 if dv > .5 else -1, 0), slide_c)  # boxed in down to the lawn
h.box("vh_wood_small", TU - 2.35, TU - 2.25, TV + .4, TV + .8, LAWN - .1, LAWN + .25, wood)
# Its blocks: the posts, the platform (one walks under it bent, as a child would) and the slide, as drawn.
for du, dv in ((0, 0), (1.2, 0), (0, 1.2), (1.2, 1.2)):
    h.block("old_wood", [(TU + du - .05, TV + dv - .05), (TU + du + .05, TV + dv - .05), (TU + du + .05, TV + dv + .05), (TU + du - .05, TV + dv + .05)], LAWN - .1, LAWN + 2.6)
h.block("old_wood", [(TU - .05, TV - .05), (TU + 1.25, TV - .05), (TU + 1.25, TV + 1.25), (TU - .05, TV + 1.25)], LAWN + 1.15, LAWN + 1.22)
for k in range(4):  # the slide in four steps down, each at its high end
    u1, u0 = TU - 2.3 * k / 4, TU - 2.3 * (k + 1) / 4
    h.block("old_wood", [(u0, TV + .35), (u1, TV + .35), (u1, TV + .85), (u0, TV + .85)], LAWN - .1, LAWN + .4 + .97 * (4 - k) / 4)
CU, CV = 2.4, 10.4
grey = "#5b5d5f"
h.box("vh_wood_small", CU - .8, CU + .8, CV - .45, CV + .45, .71, .75, "#c9c2b4")
for du in (-.72, .72):
    for dv in (-.38, .38):
        h.box("vh_wood_small", CU + du - .03, CU + du + .03, CV + dv - .03, CV + dv + .03, -.01, .71, grey)
h.block("old_wood", [(CU - .8, CV - .45), (CU + .8, CV - .45), (CU + .8, CV + .45), (CU - .8, CV + .45)], .55, .75)  # its top: one walks into it, not under it
for du in (-.4, .4):
    for side in (-1, 1):
        cv = CV + side * .72
        h.block("old_wood", [(CU + du - .22, cv - .22), (CU + du + .22, cv - .22), (CU + du + .22, cv + .22), (CU + du - .22, cv + .22)], .38, .46)
        b0, b1 = sorted((cv + side * .19, cv + side * .23))
        h.block("old_wood", [(CU + du - .22, b0), (CU + du + .22, b0), (CU + du + .22, b1), (CU + du - .22, b1)], .46, .9)
        h.box("vh_wood_small", CU + du - .22, CU + du + .22, cv - .22, cv + .22, .42, .46, grey)
        h.box("vh_wood_small", CU + du - .22, CU + du + .22, cv + side * .19, cv + side * .23, .46, .9, grey)
        for a in (-.19, .19):
            for b in (-.19, .19):
                h.box("vh_wood_small", CU + du + a - .015, CU + du + a + .015, cv + b - .015, cv + b + .015, -.01, .42, grey)

# --- the shell's solids: the house as lumps for walking into, in the game's heights ------------------------------------
FOOT = [(0, 0), (UL, 0), (UL, VB), (UR, VB), (UR, VM), (0, VM)]
solids = [{"m": "nb_red", "y0": round(F - 1, 3), "y1": round(F + FLAT, 3), "p": [[wpt(u, v) for u, v in FOOT]]},
          {"m": "nb_red", "y0": round(F + FLAT, 3), "y1": round(F + EAVE, 3), "p": [[wpt(u, v) for u, v in [(0, 0), (UMU, 0), (UMU, VM), (0, VM)]]]}]
# The roofs in bands, each at its middle's height: within a third of a metre of the tiles wherever one lands.
BANDS = 6  # a slope of the main roof
bw = (VR + OVER) / BANDS
for k in range(2 * BANDS):
    v0 = -OVER + k * bw
    top = main_roof(v0 + bw / 2)
    solids.append({"m": "nb_roof", "y0": round(F + EAVE - .4, 3), "y1": round(F + top, 3), "p": [[wpt(u, v) for u, v in [(-.05, v0), (UMU + .05, v0), (UMU + .05, v0 + bw), (-.05, v0 + bw)]]]})
WBANDS = 5  # the wing's roof, in from its three eaves
step = (UL + WOVER - UMU) / WBANDS
for j in range(WBANDS):
    inset = j * step
    top = we + WK * (inset + step / 2)  # the roof's height at the middle of this band, in from its eaves
    ring = [(UMU if j else UM, -WOVER + inset), (UL + WOVER - inset, -WOVER + inset), (UL + WOVER - inset, VB + WOVER - inset), (UMU if j else UM, VB + WOVER - inset)]
    solids.append({"m": "nb_roof", "y0": round(F + FLAT, 3), "y1": round(F + top, 3), "p": [[wpt(u, v) for u, v in ring]]})
# The terrace's canopy and post stand outside the inside: the model's blocks.
h.block("old_wood", [(-.08, VM), (UR - .03, VM), (UR - .03, VB + .03), (-.08, VB + .03)], FLAT - .25, FLAT)
h.block("old_wood", [(-.02, VB - .2), (.13, VB - .2), (.13, VB - .05), (-.02, VB - .05)], LAWN, FLAT - .25)
h.block("steel", [(UR - .05, VM - .03), (UR + .03, VM - .03), (UR + .03, VM + .05), (UR - .05, VM + .05)], 0, FLAT - .2)


# --- the ground cut out under the levelled garden, and its dip ---------------------------------------------------------
def ground_cuts(ring):
    """The relief's 4 m squares under a convex ring (world x, z): their numbers, and what is left of them outside it as
    triangles cut along each square's diagonal, as world/terrain.ts draws the ground."""
    x0, z0, st, nx = GRID["x0"], GRID["z0"], GRID["step"], GRID["nx"]
    if area(ring) < 0:
        ring = ring[::-1]
    xs, zs = [p[0] for p in ring], [p[1] for p in ring]
    cells, tris = [], []
    for j in range(int((min(zs) - z0) // st), int((max(zs) - z0) // st) + 1):
        for i in range(int((min(xs) - x0) // st), int((max(xs) - x0) // st) + 1):
            a = (x0 + i * st, z0 + j * st)
            b, c, d = (a[0] + st, a[1]), (a[0] + st, a[1] + st), (a[0], a[1] + st)
            square = [a, b, c, d]
            inner = list(square)
            for k, p in enumerate(ring):
                q = ring[(k + 1) % len(ring)]
                inner = clip_half(inner, lambda r, p=p, q=q: (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) if inner else inner
            if len(inner) < 3 or abs(area(inner)) < 1e-3:
                continue
            cells.append(j * (nx - 1) + i)
            for tri in ((a, c, b), (a, d, c)):
                rest = list(tri)
                for k, p in enumerate(ring):
                    q = ring[(k + 1) % len(ring)]
                    side = lambda r, p=p, q=q: (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
                    piece = clip_half(rest, lambda r: -side(r)) if rest else []
                    if len(piece) >= 3 and abs(area(piece)) > 1e-4:
                        for m in range(1, len(piece) - 1):
                            for r in (piece[0], piece[m], piece[m + 1]):
                                tris += [round(r[0], 3), round(r[1], 3)]
                    rest = clip_half(rest, side) if rest else []
    return {"cells": cells, "tris": tris}


lv_world = [tuple(wpt(u, v)) for u, v in LV]
cuts = ground_cuts(lv_world)
dip_ring = [list(p) for p in lv_world]
dip = {"name": "brick house garden", "rim": dip_ring, "bottom": dip_ring, "depth": .5, "low": round(FT + LAWN + .5, 3)}

# --- the files -------------------------------------------------------------------------------------------------------
centre = Vector(tuple(sum(c) / len(c) for c in zip(*OUTLINE)))
# walkIn.ts's x axis is (cos a, -sin a), its z axis (sin a, cos a): x = -u along -T, z = v along N.
a_shell = math.atan2(T.y, -T.x)
panes = [{"p": [[shell_pt(*q) for q in p["p"][0]]], "y0": p["y0"], "y1": p["y1"]} for p in h.panes]
shell = {
    "key": "kapellenhoek_home",
    "frame": {"o": [round(A.x, 3), round(A.y, 3)], "a": round(a_shell, 6), "floor": round(F, 3)},
    "centre": [round(centre.x, 3), round(centre.y, 3)],
    "outline": [[round(q[0], 3), round(q[1], 3)] for q in OUTLINE],
    "levels": [{"id": "gf", "name": "Ground floor", "floor": 0}, {"id": "f1", "name": "1st floor", "floor": STOREYS["first"]}],
    "doors": h.doors,
    "panes": panes,
    "groundCuts": cuts,
    "dip": dip,
    "lawn": {"p": [wpt(u, v) for u, v in LAWN_RING], "y": round(F + LAWN, 3)},
    "plot": [wpt(u, v) for u, v in PLOT],
    "solids": solids,
}
# Check the frame: walkIn.ts's toWorld([x, z]) = o + x (cos a, -sin a) + z (sin a, cos a) must give world(u, v).
ca, sa = math.cos(a_shell), math.sin(a_shell)
for u, v in ((0, 0), (UL, 0), (0, VB), (8, 5)):
    x, z = -u, v
    p = (A.x + x * ca + z * sa, A.y - x * sa + z * ca)
    assert (Vector(p) - world(u, v)).length < 1e-6, "the shell's frame does not match"

data = {
    "home": "kapellenhoek_home",
    "frame": {"A": [round(A.x, 4), round(A.y, 4)], "T": [round(T.x, 6), round(T.y, 6)], "N": [round(N.x, 6), round(N.y, 6)],
              "note": "world = A + u T + v N; u along the front to the right seen from the street, v into the house; y over the floor"},
    "floor": {"relief": FT, "game": round(F, 3)},
    "wall": WALL,
    "storeys": STOREYS,
    "blocks": {"main": [[0, 0], [UMU, VM]], "mainGroundFloorRight": UM, "rear": [[UR, VM], [UM, VB]], "wing": [[UM, 0], [UL, VB]], "terrace": [[0, VM], [UR, VB]]},
    "roof": {"eaves": EAVE, "ridge": RIDGE, "ridgeV": VR, "overhang": OVER, "wingEaves": WEAVE, "wingTop": WTOP, "flat": FLAT},
    "walls": h.walls,
    "openings": h.openings,
    "lawn": LAWN,
    "levelled": LV,
}
DATA_OUT.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8", newline="\n")
SHELL_OUT.write_text(json.dumps(shell, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
print(f"shell: {len(h.doors)} doors, {len(panes)} panes, {len(solids)} solids, {len(cuts['cells'])} cut squares, {len(cuts['tris']) // 6} triangles left")
print(f"blocks: {len(h.blocks)}")

h.export({
    "landmark": "kapellenhoek_home",
    "replaces": [OUTLINE],
    "blocks": h.blocks,
    "blocksOnGround": True,
    "clear": [[wpt(u, v) for u, v in PLOT]],
})
