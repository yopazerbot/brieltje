"""Hand-made houses among the generated ones, package B2: four houses in the east of the village.

  blender -b -P tools/village_houses_b2.py -- web/public/models [vh_fermette vh_red_villa ...]

writes web/public/models/<name>.glb for each house, or for the ones named, with the toolkit of the first package
(tools/village_houses_kit.py; see tools/village_houses_b1.py for the names of the meshes and what the game does with
each). A house is named by its spot in the model's metres, never by an address. Its kind, colours and main openings
were compared with street-level pictures by eye; nothing was copied, traced or sampled from them, and nothing
personal is modelled (no number, name, text, letterbox or window dressing).

The roofs here are sets of planes over a footprint (`Roof`): each plane is drawn where it is the lowest, so hips and
valleys come by themselves, and where two roofs meet each is drawn only where it is the higher one.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from village_houses_kit import *  # noqa: E402,F403  (House, Opening, the materials, Vector, math, ONLY)


class House(House):  # noqa: F405
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


# ======================================================================================================================
# 05. x 287.4, z -836.2: a large villa in farmhouse style, a steep tiled roof with dormers, a low wing toward the
# street under a dark rounded roof with two arched oak garage doors, a fan of setts to the street.
def fermette():
    h = House("vh_fermette", [283.02, -845.44], ([283.02, -845.44], [286.52, -844.26]), 1.65, {
        "vh_brick": {"texture": "nb_brick", "tint": "#7c5846", "normalScale": .6},  # rustic brown-red: the lightest of nb_brown
        "vh_roof": {"texture": "roof_tiles", "tint": "#6c3a2c", "normalScale": .35},
        "vh_paving": {"texture": "pavers", "tint": "#76736e", "stretch": (.6, .6)},
        "vh_hedge": {"texture": "hedge", "tint": "#7f9c5c"},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,
    })
    # u along the front to the west (left to right seen from the drive), d from the wing's front (0) to the back.
    lift = h.base
    E, RG = 4.0 + lift, 10.2 + lift  # the main roof's eaves and ridge
    d0, d1, u0, u1, ov = 3.75, 16.32, -13.59, 3.23, .32
    dr = (d0 + d1) / 2
    k = (RG - E) / (dr - d0)
    main = Roof([(u0 - ov, d0 - ov), (u1 + ov, d0 - ov), (u1 + ov, d1 + ov), (u0 - ov, d1 + ov)], [
        eave((0, d0 - ov), (0, 1), E - k * ov, k), eave((0, d1 + ov), (0, -1), E - k * ov, k),
        eave((u0 - ov, 0), (1, 0), E - k * ov, k * 1.25)], under="#d9d4c9", edge="#e9e6df", board=.22)
    # The wing: a lower roof over the garages, hipped at the front, dark and rounded as thatch looks from far.
    wu0, wu1, wd0, wd1, wo = -4.83, 1.85, 0.0, 9.6, .38
    WE, wk = 3.15 + lift, 1.25
    thatch = "#443c34"
    wing = Roof([(wu0 - wo, wd0 - wo), (wu1 + wo, wd0 - wo), (wu1 + wo, wd1), (wu0 - wo, wd1)], [
        eave((wu0 - wo, 0), (1, 0), WE, wk), eave((wu1 + wo, 0), (-1, 0), WE, wk), eave((0, wd0 - wo), (0, 1), WE, wk)],
        under="#2f2b28", edge=thatch, board=.32, thick=.3, mesh="vh_stone", ridge_r=.2, ridge_mesh="vh_stone")
    roofs = [main, wing]
    floor, frame, oak, shutter = .12, "#f0efe9", "#8a6a45", "#6b4a32"
    head = "#6d4536"
    gy = lambda u, d: h.ground(u, d)

    def window(s, y=.95, w=1.0, hh=1.5):
        return Opening(s, y, w, hh, frame=frame, reveal=.18)

    def dress(W, N, T, ops, arch=True, shut=True):
        for o in ops:
            if o.kind != "window":
                continue
            muntins(h, W, N, T, o, 3, 2)
            if shut:
                shutters(h, W, N, T, o, shutter)
            if arch:
                seg_arch(h, W, N, T, o.s - o.w / 2 - .06, o.s + o.w / 2 + .06, o.y + o.h, .14, .22, "vh_stone", head)

    def wall(a, b, ops=(), arch=True, shut=True, **kw):
        W, N, T = h.wall(a, b, kw.pop("top", None) or top_over(roofs, a, b), ops, **kw)
        dress(W, N, T, ops, arch, shut)
        return W, N, T

    # --- the wing's front: two arched oak garage doors, the second set back a little --------------------------------
    def leaf(W, N, T, o, split):
        """An oak door of upright planks in an arched opening (its square top hides behind the arch's brick)."""
        s0, s1, y0, y1, r = o.s - o.w / 2, o.s + o.w / 2, o.y, o.y + o.h, o.reveal
        h.wbox(W, N, T, "vh_trim", s0, s1, y0, y1, r - .06, r, oak)
        x = s0 + .16
        while x < s1 - .1:
            h.wbox(W, N, T, "vh_frames_small", x - .012, x + .012, y0 + .02, y1 - .02, r - .068, r - .06, "#6f5236")
            x += .16
        for y in (y0 + .35, y0 + 1.2):  # ledges across
            h.wbox(W, N, T, "vh_frames_small", s0 + .05, s1 - .05, y - .05, y + .05, r - .08, r - .06, "#7a5c3c")
        if split:
            h.wbox(W, N, T, "vh_frames_small", o.s - .025, o.s + .025, y0, y1, r - .085, r - .06, "#5e452d")
        h.wbox(W, N, T, "vh_metal_small", o.s + (.08 if split else o.w / 2 - .2), o.s + (.12 if split else o.w / 2 - .16), y0 + .95, y0 + 1.15, r - .1, r - .06, "#2a2a28")

    garage = lambda s: Opening(s, gy(s, -.3) + .02, 2.4, 2.35, "leaf", arch=True, reveal=.28, sill=False)
    for a, b, s in (((1.85, 0), (-1.85, 0), 1.85), ((-1.87, .73), (-4.83, .75), 1.48)):
        o = garage(s)
        W, N, T = h.wall(a, b, WE - .06, [o])
        leaf(W, N, T, o, True)
    h.wall((-1.85, 0), (-1.87, .73), WE - .06)
    h.wall((-4.83, .75), (-4.81, 3.85), top_over(roofs, (-4.83, .75), (-4.81, 3.85)))
    # The wing's west side, to the garden: one window under its eaves, then a tall wall under the main roof.
    wall((1.85, 0), (1.85, 8.95), [window(2.2, .95, .9, 1.3), window(6.6, 4.9, .9, 1.1)], arch=False, shut=False)
    h.wall((1.91, 8.95), (3.14, 8.86), top_over(roofs, (1.91, 8.95), (3.14, 8.86)))
    # --- the main front, east of the wing: two windows with shutters, and the arched oak door in its recess ---------
    wall((-4.81, 4.36), (-4.81, 3.85), out=(-1, 0))
    door = Opening(1.5, floor, 1.1, 2.3, "leaf", arch=True, reveal=.25, sill=False, step=(gy(-6.3, 4.0), .45))
    Wdr, Ndr, Tdr = wall((-4.81, 4.36), (-7.63, 4.39), [door])
    leaf(Wdr, Ndr, Tdr, door, False)
    lamp(h, Wdr, Ndr, Tdr, door.s + .85, floor + 1.9)
    wall((-7.63, 4.39), (-7.64, 3.75))
    wall((-7.64, 3.75), (-12.17, 3.8), [window(1.15), window(3.35)])
    # An oval window over the door in a stone surround, set on the wall.
    oc = Vector((-6.31, 4.375))
    for i in range(12):
        a0, a1 = math.tau * i / 12, math.tau * (i + 1) / 12
        for r0, r1, m, c, dep in ((.0, .2, "vh_glass", None, .008), (.2, .34, "vh_stone", "#b9b2a4", .02)):
            pts = [(oc.x - math.cos(a) * r, 3.2 + math.sin(a) * r * .8) for a, r in ((a0, r0), (a1, r0), (a1, r1), (a0, r1))]
            h.poly(m, [(p[0], oc.y - dep, p[1]) for p in pts], (0, -1, 0), c)
    # --- the east end (to the street), the back, the west gable --------------------------------------------------------
    wall((-12.17, 3.8), (-12.17, 9.39), [window(2.8, .95, 1.0, 1.4)])
    wall((-12.17, 9.39), (-13.59, 9.29))
    wall((-13.59, 9.29), (-13.59, 14.92), [window(2.8, .95, 1.0, 1.4)])
    wall((-13.59, 14.92), (-8.55, 15.24), [window(2.5, .95, 1.0, 1.4)], shut=False)
    wall((-8.55, 15.24), (-8.66, 14.12))
    wall((-8.66, 14.12), (-2.66, 14.07), [Opening(2.0, floor, 2.4, 2.1, frame=frame, cols=3, reveal=.18, sill=False), window(4.6, .95, 1.0, 1.4)], arch=False, shut=False)
    wall((-2.66, 14.07), (-2.71, 15.99))
    wall((-2.71, 15.99), (3.23, 16.32), [window(1.8, .95, 1.0, 1.4), window(4.6, .95, 1.0, 1.4)], shut=False)
    wall((3.23, 16.32), (3.14, 8.86), [window(3.7, .95, 1.0, 1.4), window(3.7, 5.3, .9, 1.1)], arch=False)
    # --- dormers on the main roof's front: a gabled one over the windows, a brick one over the door -----------------
    for uc, dfa, brick in ((-9.95, 4.75, False), (-6.31, 4.38, True)):
        w, de, dg = 1.5, 6.15 + lift, 6.85 + lift  # width, its eaves, its ridge
        dk = (dg - de) / (w / 2 + .15)
        dback = (dg - E + k * ov) / k + d0 - ov + .4  # where its ridge runs into the main roof, and a little more
        dorm = Roof([(uc - w / 2 - .15, dfa - .25), (uc + w / 2 + .15, dfa - .25), (uc + w / 2 + .15, dback), (uc - w / 2 - .15, dback)],
                    [eave((uc - w / 2 - .15, 0), (1, 0), de, dk), eave((uc + w / 2 + .15, 0), (-1, 0), de, dk)],
                    under="#d9d4c9", edge="#e9e6df", board=.16, thick=.1)
        roofs.append(dorm)
        sill = main.height(uc, dfa)
        top = [(0, de - .05), (w / 2, dg - .05), (w, de - .05)]
        if brick:  # the wall carries on up from the front wall, through the eaves
            main.cuts.append([(uc - w / 2, d0 - ov - .05), (uc + w / 2, d0 - ov - .05), (uc + w / 2, dfa), (uc - w / 2, dfa)])
            o = Opening(w / 2, E + .15, .9, 1.25, frame=frame, reveal=.18, cols=2, sill=False)
            Wd, Nd, Td = h.wall((uc + w / 2, dfa), (uc - w / 2, dfa), top, [o], bottom=sill - .06, out=(0, -1))
        else:
            o = Opening(w / 2, sill + .12, .9, 1.1, frame=frame, reveal=.14, cols=2, sill=False)
            Wd, Nd, Td = h.wall((uc + w / 2, dfa), (uc - w / 2, dfa), top, [o], bottom=sill - .3, out=(0, -1))
        muntins(h, Wd, Nd, Td, o, 3, 2)
        # its cheeks, from its front back to where its eaves meet the main roof (lead-grey on the tiled one)
        dc = (de - E + k * ov) / k + d0 - ov
        for su in (uc - w / 2, uc + w / 2):
            h.wall((su, dfa), (su, dc), de - .05, bottom=[(0, main.height(su, dfa) - .2), (dc - dfa, de - .2)],
                   mesh="vh_brick" if brick else "vh_trim", color=None if brick else "#5d5a55", out=(1 if su > uc else -1, 0))
    draw_roofs(h, roofs)
    # Gutters on the main roof's front either side of the brick dormer and the wing, and at the back; downpipes.
    ye = E - k * ov - .22
    h.gutter((u0 - ov, d0 - ov, ye), (-7.06, d0 - ov, ye), (0, -1, 0), "#6b6e6c", down=[(-12.25, 3.86, gy(-12.25, 3.86))])
    h.gutter((u1 + ov, d1 + ov, ye), (u0 - ov, d1 + ov, ye), (0, 1, 0), "#6b6e6c", down=[(3.15, 16.4, gy(3.15, 16.4)), (-13.5, 15.0, gy(-13.5, 15.0))])
    tile = "#5a3226"
    h.tile_ends((u0 - ov, d0 - ov, E - k * ov), (-7.06, d0 - ov, E - k * ov), (0, -1, 0), tile)
    h.tile_ends((u1 + ov, d1 + ov, E - k * ov), (u0 - ov, d1 + ov, E - k * ov), (0, 1, 0), tile)
    # Two brick chimneys on the main ridge.
    for cu in (-10.4, -.6):
        h.chimney(cu, dr + .2, .6, .7, RG - 1.0, RG + .9, "vh_brick", pots=[(0, 0)])
    # --- the drive: a fan of grey setts from the garages to the street's paving (its edge from the data) -------------
    edge = [(285.25, -875.77), (300.15, -849.93), (301.98, -845.87), (304.45, -842.344)]
    m1, m2 = edge_at(h, edge, d=-7.6), edge_at(h, edge, d=-5.2)
    corner = h.local((301.98, -845.87))
    h.pave([(2.25, -.02), (-1.86, -.02), (-1.86, .72), (-5.2, .72), (-5.4, -.4), (-8.2, -2.0), (-12.0, -3.8), m2, corner, m1,
            (-10.2, -7.0), (-6.4, -6.9), (-2.6, -6.2), (.6, -5.0), (2.25, -3.2)], cell=1.2)
    h.pave([(-6.95, 4.36), (-5.65, 4.36), (-5.65, 3.4), (-5.4, -.38), (-6.95, -1.2)], cell=1.2)  # the path to the front door
    # Low clipped hedges along the drive and box balls in the bed before the house.
    for a, b in (((-8.4, -.6), (-11.8, -2.4)), ((2.6, -3.0), (.9, -4.7))):
        L = math.dist(a, b)
        for i in range(int(L / .7) + 1):
            p = Vector(a) + (Vector(b) - Vector(a)) * (i / max(1, int(L / .7)))
            h.blob("vh_hedge", p.x, p.y, gy(p.x, p.y) + .22, (.42, .42, .3), rings=3, steps=6)
    for u, d, r in ((-8.6, 1.6, .38), (-10.3, 2.2, .45), (-11.6, 1.3, .35), (-7.6, 2.8, .3), (-12.6, -1.8, .4)):
        h.blob("vh_hedge", u, d, gy(u, d) + r * .8, (r, r, r * .85), rings=3, steps=6)
    h.export()


# ======================================================================================================================
# 06. x 316.4, z -821.9: a tall red brick villa of the 1920s, white bands, a hipped roof with a front gable over a
# canted bay window, the door up four stone steps under a small canopy, a low annex behind, gravel to the street.
def red_villa():
    h = House("vh_red_villa", [313.3, -831.97], ([321.26, -827.26], [316.47, -829.46]), 1.99, {
        "vh_brick": {"texture": "nb_brick", "tint": "#904e3e", "normalScale": .55},  # the most orange of nb_red's range
        "vh_roof": {"texture": "roof_tiles", "tint": "#3a3d42", "normalScale": .3},
        "vh_gravel": {"texture": "gravel", "tint": "#8e8b85"},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,
    })
    # u along the street front to the west (left to right seen from the street), d from the front (0) to the back.
    lift = h.base
    E, RG, ov = 7.77 + lift, 11.31 + lift, .35
    uE, uW, dB = -2.64, 6.57, 8.4
    k = (RG - E) / (dB / 2)
    white, frame, foot = "#ebe8e1", "#f2f1ec", "#8d8a84"
    main = Roof([(uE - ov, -ov), (uW + ov, -ov), (uW + ov, dB + ov), (uE - ov, dB + ov)],
                [eave((0, -ov), (0, 1), E - k * ov, k), eave((0, dB + ov), (0, -1), E - k * ov, k),
                 eave((uE - ov, 0), (1, 0), E - k * ov, k), eave((uW + ov, 0), (-1, 0), E - k * ov, k)],
                under=white, edge=white, board=.3)
    # The front gable over the bay: its own steeper roof, its ridge toward the street.
    gu0, gu1, gd0 = 2.64, 6.56, -.96
    kc = (10.05 + lift - E) / ((gu1 - gu0) / 2)
    cross = Roof([(gu0 - .25, gd0 - .3), (gu1 + .36, gd0 - .3), (gu1 + .36, 4.6), (gu0 - .25, 4.6)],
                 [eave((gu0 - .25, 0), (1, 0), E - kc * .25, kc), eave((gu1 + .36, 0), (-1, 0), E - kc * .36, kc)],
                 under=white, edge=white, board=.24)
    # The annex behind the east half: low, its gable to the street.
    aE, aW, ad0, ad1 = -6.78, -.06, 7.9, 15.0
    AE, ak, ao = 3.1 + lift, .94, .3
    annex = Roof([(aE - ao, ad0 - ao), (aW + ao, ad0 - ao), (aW + ao, ad1 + ao), (aE - ao, ad1 + ao)],
                 [eave((0, ad0 - ao), (0, 1), AE - ak * ao, ak), eave((0, ad1 + ao), (0, -1), AE - ak * ao, ak)],
                 under=white, edge=white, board=.22)
    roofs = [main, cross, annex]
    bands = [(.8, "vh_stone", foot), (.95, "vh_brick", None), (1.1, "vh_trim", white), (3.0, "vh_brick", None), (3.15, "vh_trim", white),
             (4.35, "vh_brick", None), (4.5, "vh_trim", white), (6.4, "vh_brick", None), (6.55, "vh_trim", white)]
    gy = lambda u, d: h.ground(u, d)
    win = lambda s, y=1.1, w=1.0, hh=1.9: Opening(s, y, w, hh, frame=frame, reveal=.2, cols=2, transom=.75)

    def wall(a, b, ops=(), top=None, boxes=True, **kw):
        W, N, T = h.wall(a, b, top if top is not None else top_over(roofs, a, b), ops, bands=kw.pop("bands", bands), **kw)
        for o in ops:
            if o.kind == "window" and boxes:
                shutter_box(h, W, N, T, o, frame)
        return W, N, T

    # --- the street front: a window and the door; above them two windows -------------------------------------------
    gd = gy(1.75, -.6)
    fl = gd + .62
    # (s along this wall runs from the gable's corner, u 2.64, eastward)
    door = Opening(.8, fl, 1.0, 1.95, "door", door="#f3f2ee", frame=frame, panels="glazed", reveal=.2, sill=False)
    light = Opening(.8, fl + 2.0, 1.0, .45, frame=frame, reveal=.2, cols=2, sill=False)
    Wf, Nf, Tf = wall((2.64, 0), (-2.64, 0), [door, light, win(3.8), win(3.8, 4.5), win(.8, 4.5)])
    lamp(h, Wf, Nf, Tf, door.s + .78, fl + 1.75)
    for i in range(4):  # four stone steps up to the door
        h.wbox(Wf, Nf, Tf, "vh_stone", door.s - .75, door.s + .72, gd - .3, fl - .155 * i, -.3 * (i + 1), 0, "#a7a49d")
    # A small tiled canopy on two plain iron struts.
    cy = fl + 2.6
    u0c, u1c = 2.64 - .8 - .85, 2.62
    h.roof([(u0c, -.85, cy), (u1c, -.85, cy), (u1c, 0, cy + .35), (u0c, 0, cy + .35)], free=(0, 1, 3), under=white, edge=white, thick=.08, board=.12)
    for u in (u0c + .12, u1c - .12):
        h.rod("vh_metal_small", (u, -.02, cy - .75), (u, -.75, cy - .05), .025, 4, "#2a2a28")
        h.rod("vh_metal_small", (u, -.02, cy - .02), (u, -.8, cy - .02), .02, 4, "#2a2a28")
    # --- the front gable's wall, over the bay; the bay's three sides and its flat lead top --------------------------
    bay_top = 3.35
    # Over the bay the wall starts at its top; beside it, down to the foot, a centimetre past the bay's own corners.
    ga, gb = h.snap((2.64, -.96)), h.snap((6.56, -.96))
    s0, s1 = math.dist(ga, h.snap((2.98, -.96))) + .01, math.dist(ga, h.snap((6.2, -.96))) - .01
    Wg, Ng, Tg = wall(ga, gb, [win(1.96, 4.5), Opening(1.96, 7.75, .7, .9, frame=frame, reveal=.18, cols=2)],
                      bottom=[(0, h.foot), (s0, h.foot), (s0 + .001, bay_top), (s1 - .001, bay_top), (s1, h.foot), (math.dist(ga, gb), h.foot)], out=(0, -1))
    h.wall((2.64, 0), (2.64, -.96), top_over(roofs, (2.64, 0), (2.64, -.96)), bands=bands)
    bay = [(2.98, -.96), (3.76, -1.77), (5.47, -1.77), (6.2, -.96)]
    for (a, b) in zip(bay, bay[1:]):
        L = math.dist(a, b)
        o = Opening(L / 2, 1.1, L - .34, 1.9, frame=frame, reveal=.14, cols=2 if L > 1.4 else 1, transom=.75)
        h.wall(a, b, bay_top, [o], bands=bands[:3])
    ring = [(2.94, -.92), (3.74, -1.82), (5.49, -1.82), (6.24, -.92)]
    h.prism("vh_stone", ring, bay_top - .12, bay_top + .06, "#6e7176", bottom=True)
    # --- the sides and the back ---------------------------------------------------------------------------------------
    wall((-2.64, 0), (-2.64, dB), [win(2.0, 1.1, 1.0, 1.7), win(5.8, 1.1, 1.0, 1.7), win(2.0, 4.5, 1.0, 1.7), win(5.8, 4.5, 1.0, 1.7)], out=(-1, 0))
    wall((6.56, -.96), (6.57, 8.33), [win(3.0, 1.1, 1.0, 1.7), win(6.6, 1.1, 1.0, 1.7), win(3.0, 4.5, 1.0, 1.7), win(6.6, 4.5, 1.0, 1.7)])
    wall((6.57, 8.33), (-2.64, dB), [win(1.6, 1.1, 1.0, 1.7), win(4.4, 1.1, 1.0, 1.7), win(1.6, 4.5, 1.0, 1.7), win(4.4, 4.5, 1.0, 1.7)], out=(0, 1))
    # --- the annex: its front with a side door, its gable to the street, the back and the shed behind ------------------
    ab = bands[:1]
    aw = lambda a, b, ops=(): wall(a, b, ops, top=top_over([annex], a, b), bands=ab)
    aw((-2.63, 7.9), (-6.78, 7.97), [Opening(1.2, gy(-3.8, 7.6) + .15, .9, 2.05, "door", door="#f3f2ee", frame=frame, panels="glazed", reveal=.15, sill=False),
                                     win(2.9, 1.1, 1.0, 1.3)])
    aw((-6.78, 7.97), (-6.62, 15.01), [win(1.8, 1.1, 1.0, 1.3), win(5.2, 1.1, 1.0, 1.3), Opening(3.5, 3.6, .5, .5, frame=frame, reveal=.15)])
    aw((-6.62, 15.01), (-6.43, 15.01))
    aw((-.15, 14.94), (-2.79, 14.97), [win(1.3, 1.1, .9, 1.2)])
    aw((-.06, 8.4), (-.15, 14.94), [win(3.3, 1.1, 1.0, 1.3), Opening(3.3, 3.6, .5, .5, frame=frame, reveal=.15)])
    shed = 2.85 + lift
    for a, b in (((-2.79, 14.97), (-2.69, 18.1)), ((-2.69, 18.1), (-6.32, 18.26)), ((-6.32, 18.26), (-6.43, 15.01))):
        wall(a, b, [win(math.dist(a, b) / 2, 1.2, .8, .9)] if b[1] > 18 else (), top=shed, bands=ab)
    sring = [(-2.79, 14.95), (-2.69, 18.1), (-6.32, 18.26), (-6.43, 14.95)]
    h.poly("vh_stone", [(u, d, shed - .02) for u, d in sring], (0, 0, 1), "#3a3a3a")  # takes the snow
    for a, b in zip(sring[:3], sring[1:]):
        h.seg("vh_stone", a, b, .28, shed, shed + .07, "#b3b0a9")
    draw_roofs(h, roofs)
    # The white boxed eaves carry gutters all round; downpipes at the corners.
    ye = E - k * ov - .3
    h.gutter((uE - ov, -ov, ye), (gu0 - .25, -ov, ye), (0, -1, 0), white, down=[(uE + .08, -.08, gy(uE, 0))])
    h.gutter((uW + ov, -ov, ye), (uW + ov, dB + ov, ye), (1, 0, 0), white, down=[(uW + .08, -.88, gy(uW, -.9))])
    h.gutter((uW + ov, dB + ov, ye), (uE - ov, dB + ov, ye), (0, 1, 0), white)
    h.gutter((uE - ov, dB + ov, ye), (uE - ov, -ov, ye), (-1, 0, 0), white)
    ya = AE - ak * ao - .22
    h.gutter((aE - ao, ad0 - ao, ya), (uE, ad0 - ao, ya), (0, -1, 0), white, down=[(aE + .08, ad0 - .08, gy(aE, ad0))])
    h.gutter((aW + ao, ad1 + ao, ya), (aE - ao, ad1 + ao, ya), (0, 1, 0), white)
    h.chimney(.17, 3.92, .55, .55, main.height(.17, 3.92) - .4, 12.2 + lift, "vh_brick", pots=[(0, 0)])
    # --- gravel from the house to the street's paving (its edge from the data); the lawn beyond -------------------------
    edge = [(307.56, -838.89), (312.97, -835.0), (322.75, -830.32), (331.21, -826.69)]
    h.pave([(6.56, -.98), (6.2, -.98), (5.47, -1.79), (3.76, -1.79), (2.98, -.98), (2.62, -.98), (2.62, -.02), (-2.66, -.02), (-2.66, 7.88),
            (-7.6, 7.95), (-7.6, 10.2), (-10.6, 10.2), (-10.6, 4.0), edge_at(h, edge, u=-10.6), h.local((322.75, -830.32)), edge_at(h, edge, u=7.4), (7.4, -.98)], mesh="vh_gravel", lift=.03, cell=1.5)
    h.export()


# ======================================================================================================================
# 07. x 342.7, z -838.9: an old worker's house of red brick straight on the pavement, two storeys, shallow arches of
# pale brick over its openings, a grey painted foot, its free gable in grey render.
def terrace():
    h = House("vh_terrace", [348.25, -841.08], ([344.76, -833.44], [337.16, -836.76]), 2.08, {
        "vh_brick": {"texture": "nb_brick", "tint": "#8e5442", "normalScale": .55},  # the warm end of nb_red's range
        "vh_render": {"texture": "plaster", "tint": "#8b8983", "normalScale": .9},
        "vh_roof": {"texture": "roof_tiles", "tint": "#44484f", "normalScale": .3},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,
    })
    # u along the street front to the east (the free gable), d from the front (0) to the back (8.4).
    lift = h.base
    E, RG, dB = 5.96 + lift, 9.33 + lift, 8.4
    k = (RG - E) / (dB / 2)
    ov = .25
    roof = Roof([(-4.2, -ov), (4.19, -ov), (4.36, dB + ov), (-3.86, dB + ov)],
                [eave((0, -ov), (0, 1), E - k * ov, k), eave((0, dB + ov), (0, -1), E - k * ov, k)], under="#e4e2dc", edge="#e9e8e3", board=.22)
    roofs = [roof]
    white, buff, grey = "#f2f1ec", "#c9b07c", "#7f7d79"
    foot = [(.9, "vh_trim", grey)]
    gy = lambda u, d: h.ground(u, d)
    g0 = gy(-.6, -.2)
    fl = g0 + .17

    def wall(a, b, ops=(), arches=True, **kw):
        W, N, T = h.wall(a, b, kw.pop("top", None) or top_over(roofs, a, b), ops, bands=kw.pop("bands", foot), **kw)
        for o in ops:
            if o.kind == "window":
                shutter_box(h, W, N, T, o, white)
            if arches and o.kind in ("window", "door"):
                seg_arch(h, W, N, T, o.s - o.w / 2 - .08, o.s + o.w / 2 + .08, o.y + o.h, .13, .24, "vh_stone", buff)
        return W, N, T

    win = lambda s, y, w=1.0, hh=1.5: Opening(s, y, w, hh, frame=white, reveal=.16, cols=2 if w > 1.1 else 1, transom=.7 if hh > 1.45 else None)
    # The street front, from the west: a window, the door, a wider window; three windows over them.
    door = Opening(3.55, fl, .95, 2.15, "door", door="#efeeea", frame=white, panels="glazed", reveal=.16, sill=False, step=(g0, .3))
    W, N, T = wall((-4.15, 0), (4.15, 0), [win(1.55, 1.0), door, win(6.3, 1.0, 1.3), win(1.55, 3.65, .85, 1.45), win(3.55, 3.65, .85, 1.45), win(6.3, 3.65, .85, 1.45)])
    h.wbox(W, N, T, "vh_stone", 0, 8.3, 3.38, 3.5, -.03, 0, buff)  # a band of pale brick under the upper sills
    h.wbox(W, N, T, "vh_stone", 0, 8.3, 3.08, 3.14, -.02, 0, buff)
    # The free gable to the east: grey render to the ridge, a small window high in it.
    Wr, Nr, Tr = h.wall((4.15, 0), (4.29, 8.4), top_over(roofs, (4.15, 0), (4.29, 8.4)),
                        [Opening(4.2, 6.6 + lift, .6, .6, frame=white, reveal=.14, sill=False)], mesh="vh_render", bands=[(.35, "vh_trim", "#6c6a66")])
    # The west gable toward the neighbour: brick, one small window upstairs; the back to the garden.
    wall((-3.83, 8.41), (-4.15, 0), [win(3.0, 3.8, .7, 1.0)], arches=False)
    wall((4.29, 8.4), (-3.83, 8.41), [win(2.0, 1.0, 1.2, 1.3), Opening(5.0, gy(-.8, 8.6) + .17, .9, 2.1, "door", door="#efeeea", frame=white, panels="glazed", reveal=.16, sill=False),
                                      win(6.6, 1.1, .8, 1.0), win(2.0, 3.7, 1.0, 1.3), win(6.0, 3.7, 1.0, 1.3)], arches=False, out=(0, 1))
    draw_roofs(h, roofs)
    ye = E - k * ov - .22
    h.gutter((-4.2, -ov, ye), (4.19, -ov, ye), (0, -1, 0), white, down=[(-4.07, -.08, gy(-4.07, -.08))])
    h.gutter((4.36, dB + ov, ye), (-3.86, dB + ov, ye), (0, 1, 0), "#8f918f", down=[(4.2, 8.5, gy(4.2, 8.5))])
    h.chimney(3.55, dB / 2, .5, .6, RG - .6, RG + .85, "vh_brick", pots=[(0, 0)])
    h.export()


# ======================================================================================================================
# 08. x 588.0, z -890.2: a two-storey brick house of the 1960s under a hipped roof with white boxed eaves, its garage
# in the front, a low fence of white concrete posts, a path and a drive of grey pavers.
def fork_house():
    h = House("vh_fork_house", [587.91, -898.3], ([596.83, -890.35], [587.91, -898.3]), 3.31, {
        "vh_brick": {"texture": "nb_brick", "tint": "#8c5444", "normalScale": .55},  # the warm end of nb_red's range
        "vh_roof": {"texture": "roof_tiles", "tint": "#3a3c40", "normalScale": .3},
        "vh_paving": {"texture": "pavers", "tint": "#9b9993"},
        "vh_hedge": {"texture": "hedge", "tint": "#86a064"},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,
    })
    # u along the front to the south-west (left to right seen from the street), d from the front (0) to the back.
    lift = h.base
    E, RG, ov = 6.3 + lift, 11.1 + lift, .5
    uL, uR, dB, dX = -5.97, 5.97, 9.97, 13.4
    k = (RG - E) / (dB / 2)
    white, frame = "#f1f0eb", "#f4f3ef"
    roof = Roof([(uL - ov, -ov), (uR + ov, -ov), (uR + ov, dB + ov), (uL - ov, dB + ov)],
                [eave((0, -ov), (0, 1), E - k * ov, k), eave((0, dB + ov), (0, -1), E - k * ov, k),
                 eave((uL - ov, 0), (1, 0), E - k * ov, k), eave((uR + ov, 0), (-1, 0), E - k * ov, k)], under=white, edge=white, board=.3)
    roofs = [roof]
    flat = 3.25 + lift
    gy = lambda u, d: h.ground(u, d)
    g0 = gy(.1, -.3)
    fl = g0 + .16
    foot = [(.25, "vh_trim", "#6a6764")]

    def wall(a, b, ops=(), **kw):
        W, N, T = h.wall(a, b, kw.pop("top", None) or top_over(roofs, a, b), ops, bands=kw.pop("bands", foot), **kw)
        for o in ops:
            if o.kind == "window":
                shutter_box(h, W, N, T, o, white)
        return W, N, T

    win = lambda s, y, w, hh, cols=None: Opening(s, y, w, hh, frame=frame, reveal=.14, cols=cols or (3 if w > 2.1 else 2 if w > 1.1 else 1))
    # --- the front: the three-part window, the door with a glazed strip, the garage; three windows upstairs ---------
    up = win(10.0, 3.75, 2.2, 1.3)
    ops = [win(2.4, 1.0, 2.4, 1.4), Opening(6.1, fl, 1.0, 2.2, "door", door="#f2f1ec", frame=frame, panels="glazed", reveal=.14, sill=False, step=(g0, .4)),
           Opening(6.85, fl, .4, 2.2, frame=frame, reveal=.14, sill=False),
           Opening(10.0, gy(4.03, -.3) + .02, 2.5, 2.1, "garage", door="#f0efea", reveal=.16, sill=False),
           win(2.4, 3.75, 1.8, 1.3), win(6.1, 3.75, 1.2, 1.3), up]
    W, N, T = wall((uL, 0), (uR, 0), ops)
    lamp(h, W, N, T, 5.45, fl + 1.85)
    h.wbox(W, N, T, "vh_trim", up.s - up.w / 2 + .02, up.s + up.w / 2 - .02, up.y + .45, up.y + up.h - .2, up.reveal - .07, up.reveal - .05, "#e4e2dc")  # a blind half down
    for y in (.93, 3.68):  # a course of bricks standing out under the sills of each floor
        h.wbox(W, N, T, "vh_brick", 0, uR - uL, y - .07, y, -.03, 0)
    h.wbox(W, N, T, "vh_trim", 8.65, 11.35, 2.3, 2.45, -.02, 0, "#9b9893")  # the garage's concrete lintel
    # --- the sides, split where the flat-roofed back rooms begin ------------------------------------------------------
    wall((uR, 0), (5.98, 7.45), [win(3.7, 1.0, 1.2, 1.3), win(3.7, 3.75, 1.2, 1.3)])
    wall((5.98, 7.45), (5.977, dB))
    wall((5.977, dB), (5.97, 13.28), [win(1.9, 1.1, .8, 1.0)], top=flat)
    wall((-5.99, 13.46), (-5.978, dB), [win(1.7, 1.0, 1.0, 1.3)], top=flat)
    wall((-5.978, dB), (uL, 0), [win(5.0, 1.0, 1.2, 1.3), win(5.0, 3.75, 1.2, 1.3)])
    wall((uR, dB), (uL, dB), [win(3.0, 3.75, 1.4, 1.3), win(8.6, 3.75, 1.0, 1.0)], bottom=flat - .12, bands=(), out=(0, 1))
    wall((5.97, 13.28), (4.05, 13.31), top=flat)
    wall((4.05, 13.31), (-5.99, 13.46), [Opening(3.2, fl, 3.0, 2.1, frame="#3b3d3e", reveal=.14, cols=2, sill=False), win(7.6, 1.0, 1.2, 1.3)], top=flat)
    ring = [(5.97, dB), (5.97, 13.28), (4.05, 13.31), (-5.99, 13.46), (-5.99, dB)]
    h.poly("vh_stone", [(u, d, flat - .02) for u, d in ring], (0, 0, 1), "#3a3a3a")  # takes the snow
    for a, b in zip(ring[:4], ring[1:]):
        h.seg("vh_stone", a, b, .28, flat, flat + .07, "#b3b0a9")
    draw_roofs(h, roofs)
    ye = E - k * ov - .3
    for a, b, out, pipes in (((uL - ov, -ov), (uR + ov, -ov), (0, -1, 0), [(uL + .08, -.08)]), ((uR + ov, -ov), (uR + ov, dB + ov), (1, 0, 0), []),
                             ((uR + ov, dB + ov), (uL - ov, dB + ov), (0, 1, 0), []), ((uL - ov, dB + ov), (uL - ov, -ov), (-1, 0, 0), [(uL - .08, dB - .1)])):
        h.gutter((*a, ye), (*b, ye), out, white, down=[(u, d, gy(u, d)) for u, d in pipes])
    h.chimney(-.28, 5.26, .5, .5, roof.height(-.28, 5.26) - .4, 12.0 + lift, "vh_brick", pots=[(0, 0)])
    # --- the front garden: a path and a drive of grey pavers to the street's paving (its edge from the data), a low
    # fence of white concrete posts and one rail along the pavement, shrubs behind it ------------------------------------
    edge = [(588.043, -903.0), (611.29, -880.14)]
    e = lambda u: edge_at(h, edge, u=u)
    h.pave([(-.45, -.02), (.7, -.02), e(.7), e(-.45)], cell=1.0)
    h.pave([(2.65, -.02), (5.6, -.02), e(5.6), e(2.65)], cell=1.0)
    fy = lambda u: e(u)[1] + .3
    posts = [-6.3, -4.4, -2.5, -.6]
    for u in posts:
        g = gy(u, fy(u))
        h.box("vh_trim", u - .06, u + .06, fy(u) - .06, fy(u) + .06, g - .1, g + .66, white)
    for a, b in zip(posts, posts[1:]):  # one rail between the posts' tops; each bay stops a player
        ga, gb = gy(a, fy(a)), gy(b, fy(b))
        h.seg("vh_trim", (a + .06, fy(a)), (b - .06, fy(b)), .07, min(ga, gb) + .5, max(ga, gb) + .62, white)
        h.seg_block("concrete", (a - .06, fy(a)), (b + .06, fy(b)), .14, min(ga, gb) - .1, max(ga, gb) + .66)
    for u, d, r in ((-5.4, -1.7, .45), (-3.9, -2.1, .4), (-2.3, -1.6, .5), (-1.2, -2.2, .35), (2.0, -.9, .35), (-4.6, -.8, .3)):
        h.blob("vh_hedge", u, d, gy(u, d) + r * .7, (r, r, r * .9), rings=3, steps=6)
    h.export()


HOUSES = {"vh_fermette": fermette, "vh_red_villa": red_villa, "vh_terrace": terrace, "vh_fork_house": fork_house}
for _name, _build in HOUSES.items():
    if not ONLY or _name in ONLY:
        _build()
