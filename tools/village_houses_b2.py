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


HOUSES = {"vh_fermette": fermette}
for _name, _build in HOUSES.items():
    if not ONLY or _name in ONLY:
        _build()
