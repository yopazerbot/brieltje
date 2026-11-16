"""Hand-made houses among the generated ones, package B3: four houses out east, on the way to the Sparrenhof and past
the end of Molenhoek.

  blender -b -P tools/village_houses_b3.py -- web/public/models [vh_old_farm vh_seventies ...]

writes web/public/models/<name>.glb for each house, or for the ones named, with the toolkit of the first two packages
(tools/village_houses_kit.py; see tools/village_houses_b1.py for the names of the meshes and what the game does with
each). A house is named by its spot in the model's metres, never by an address. Its kind, colours and main openings
were compared with street-level pictures by eye; nothing was copied, traced or sampled from them, and nothing
personal is modelled (no number, name, text, sign, letterbox or window dressing).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from village_houses_kit import *  # noqa: E402,F403  (Snapped, Opening, Roof, the details, the materials, ONLY)

class House(Snapped):  # noqa: F405
    """Snapped, and a house that stands in for two wall blocks of the data snaps its walls to the second's corners too."""

    def also_replaces(self, corner):
        """The wall block with this corner and the most corners is the house's too: it is hidden, its corners snap."""
        ring = max((p["p"][0] for p in VILLAGE["prisms"] if any(abs(q[0] - corner[0]) < .02 and abs(q[1] - corner[1]) < .02 for q in p["p"][0])), key=len)  # noqa: F405
        self.replaces.append(ring)
        self.extra = getattr(self, "extra", []) + [self.local(p) for p in ring]

    def snap(self, p):
        q = min(list(self.ring) + getattr(self, "extra", []), key=lambda r: (r[0] - p[0]) ** 2 + (r[1] - p[1]) ** 2)
        return tuple(q) if (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < .01 else tuple(p)


def over(ring, y, pad=.05):
    """The height of a flat roof over a plan ring, for top_over's `also`: y in the ring or within `pad` of its edges."""
    def f(u, d):
        if inside(ring, (u, d)):  # noqa: F405
            return y
        for a, b in zip(ring, ring[1:] + ring[:1]):
            t = Vector((b[0] - a[0], b[1] - a[1]))  # noqa: F405
            s = max(0, min(1, ((u - a[0]) * t.x + (d - a[1]) * t.y) / (t.length_squared or 1)))
            if math.dist((u, d), (a[0] + t.x * s, a[1] + t.y * s)) < pad:  # noqa: F405
                return y
        return -99
    return f


def flat_roof(h, ring, y, coping="#a5a29b", top="#3a3a3a"):
    """A flat roof over a plan ring at height y: its top (vh_stone takes the snow) and a coping along every edge."""
    h.poly("vh_stone", [(u, d, y - .02) for u, d in ring], (0, 0, 1), top)
    for a, b in zip(ring, ring[1:] + ring[:1]):
        h.seg("vh_stone", a, b, .28, y, y + .07, coping)


def blind(h, W, N, T, o, down=.5, color="#e9e8e4"):
    """A roller shutter let down a part of the way in a window's reveal."""
    h.wbox(W, N, T, "vh_trim", o.s - o.w / 2 + .02, o.s + o.w / 2 - .02, o.y + o.h * (1 - down), o.y + o.h - .2, o.reveal - .07, o.reveal - .05, color)


def courses(h, W, N, T, ops, y0, y1, length, mesh="vh_stone", color=None, proud=.02):
    """A band along a wall from y0 to y1, drawn in runs between the openings it would cross."""
    cuts = sorted((o.s - o.w / 2 - .02, o.s + o.w / 2 + .02) for o in ops if o.y < y1 and o.y + o.h > y0)
    s = 0.0
    for c0, c1 in cuts + [(length, length)]:
        if c0 - s > .05:
            h.wbox(W, N, T, mesh, s, c0, y0, y1, -proud, 0, color)
        s = max(s, c1)


def railing_wall(h, pts, piers, coping, metal, wall_h=.6, top=1.2):
    """A low brick wall along a plan polyline with a bar railing on it and brick piers at the distances `piers` along
    it; every bay between two piers is one block (it stops a player), every pier one more."""
    segs = list(zip(pts, pts[1:]))
    lens = [math.dist(a, b) for a, b in segs]
    total = sum(lens)

    def at(s):
        for (a, b), L in zip(segs, lens):
            if s <= L + 1e-9:
                t = s / L
                return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), Vector((b[0] - a[0], b[1] - a[1])).normalized()
            s -= L
        return pts[-1], Vector((pts[-1][0] - pts[-2][0], pts[-1][1] - pts[-2][1])).normalized()

    gy = lambda p: h.ground(*p)
    stops = sorted(set([0.0, total] + [s for s in piers if 0 < s < total]))
    for s0, s1 in zip(stops, stops[1:]):
        a, _ = at(s0 + .18)
        b, _ = at(s1 - .18)
        ga, gb = gy(a), gy(b)
        g = min(ga, gb)
        h.seg("vh_brick", a, b, .3, g - .4, g + wall_h)
        h.seg("vh_stone", a, b, .36, g + wall_h, g + wall_h + .06, coping)
        # the railing: two rails and plain bars a hand apart
        h.seg("vh_metal_small", a, b, .04, g + wall_h + .1, g + wall_h + .14, metal)
        h.seg("vh_metal_small", a, b, .04, g + top - .05, g + top, metal)
        n = max(1, int(math.dist(a, b) / .14))
        for i in range(1, n):
            t = i / n
            p = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            h.box("vh_metal_small", p[0] - .011, p[0] + .011, p[1] - .011, p[1] + .011, g + wall_h + .06, g + top - .05, metal)
        h.seg_block("concrete", a, b, .32, g - .1, g + top)
    for s in stops:
        c, t = at(s)
        g = gy(c)
        n = Vector((t.y, -t.x))
        ring = [(c[0] + (t.x * sa + n.x * sb) * .18, c[1] + (t.y * sa + n.y * sb) * .18) for sa, sb in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        cap = [(c[0] + (t.x * sa + n.x * sb) * .22, c[1] + (t.y * sa + n.y * sb) * .22) for sa, sb in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        h.prism("vh_brick", ring, g - .4, g + top + .1)
        h.prism("vh_stone", cap, g + top + .1, g + top + .17, coping)
        h.block("nb_red", ring, g - .1, g + top + .17)


def cone(h, u, d, y0, y1, r, mesh="vh_hedge", sides=9):
    """A clipped conifer: a cone of `sides` faces from its foot at y0 to its tip at y1."""
    ring = [(u + r * math.cos(math.tau * i / sides), d + r * math.sin(math.tau * i / sides)) for i in range(sides)]
    for i in range(sides):
        a, b = ring[i], ring[(i + 1) % sides]
        mid = ((a[0] + b[0]) / 2 - u, (a[1] + b[1]) / 2 - d, r / (y1 - y0) * r)
        h.poly(mesh, [(a[0], a[1], y0), (b[0], b[1], y0), (u, d, y1)], mid)


# ======================================================================================================================
# 09. x 677.6, z 308.9: an old brick farm along the street: the house of two storeys with pale arches over its windows,
# the barn beside it with a big grey door under a strip of glass, a low flat-roofed part and a long wing behind, black
# pantiles, a low brick wall with a bar railing along the garden beyond the barn and two clipped conifers behind it.
def old_farm():
    # (found by a back corner: its front corners are the street's paving's too)
    h = House("vh_old_farm", [704.73, 312.23], ([669.51, 299.78], [670.77, 316.32]), -5.92, {
        "vh_brick": {"texture": "nb_brick", "tint": "#7f4a3c", "normalScale": .6},  # old red-brown, nb_red's dark end
        "vh_roof": {"texture": "roof_tiles", "tint": "#2b2d30", "normalScale": .35, "rough": .6},  # black glazed pantiles
        "vh_hedge": {"texture": "hedge", "tint": "#5a7449"},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,
    })
    # u along the street front to the north (the house south, the barn north), d from the front (0) to the back.
    lift = h.base
    gy = lambda u, d: h.ground(u, d)
    white, pale, foot_c, grey = "#f1f0eb", "#b08a72", "#7d7b76", "#7d7f80"
    foot = [(.5, "vh_trim", foot_c)]
    # The house: u -8.29 to 0.24, d 0 to 8.96, its ridge along the street.
    E, RG, D, ov = 6.4 + lift, 10.1 + lift, 8.96, .3
    k = (RG - E) / (D / 2)
    # (its verge over the barn ends on its gable's wall, u 0.24: past it the barn's roof would be cut away under it)
    house = Roof([(-8.29 - ov, -ov), (.24, -ov), (.24, D + ov), (-8.29 - ov, D + ov)],
                 [eave((0, -ov), (0, 1), E - k * ov, k), eave((0, D + ov), (0, -1), E - k * ov, k)], under="#cfccc5", edge="#232426", board=.2)
    # The barn and the link beside the house under one roof, u 0.24 to 8.29, d 0 to 7.73; lower.
    EB, RB, DB = 4.4 + lift, 8.0 + lift, 7.73
    kb = (RB - EB) / (DB / 2)
    barn = Roof([(.24, -ov), (8.29 + .25, -ov), (8.29 + .25, DB + ov), (.24, DB + ov)],
                [eave((0, -ov), (0, 1), EB - kb * ov, kb), eave((0, DB + ov), (0, -1), EB - kb * ov, kb)], under="#cfccc5", edge="#232426", board=.2)
    # The wing behind, u 2.78 to 6.82, d 17.5 to 34.4: low walls, a steep roof, its ridge away from the street.
    EW, RW, wo = 3.2 + lift, 6.4 + lift, .15  # (the ground rises half a metre toward the wing's end: its eaves stay over a head)
    kw = (RW - EW) / 2.02
    wing = Roof([(2.78 - wo, 17.5), (6.82 + wo, 17.5), (6.82 + wo, 34.4 + .3), (2.78 - wo, 34.4 + .3)],
                [eave((2.78 - wo, 0), (1, 0), EW - kw * wo, kw), eave((6.82 + wo, 0), (-1, 0), EW - kw * wo, kw)], under="#cfccc5", edge="#232426", board=.18)
    roofs = [house, barn, wing]
    # Between the barn and the wing a low part under a flat roof.
    FL = 2.91 + lift
    flat = [(3.1, 7.01), (8.29, 7.01), (8.29, 19.43), (6.82, 19.58), (6.82, 17.5), (2.886, 17.5), (3.1, 7.74)]  # (2.886: the south wall's line)
    flat_at = over(flat, FL + .07)

    def wall(a, b, ops=(), **kw):
        top = kw.pop("top", None)
        return h.wall(a, b, top if top is not None else top_over(roofs, a, b, also=[flat_at]), ops, bands=kw.pop("bands", foot), **kw)

    def win(s, y, w=1.0, hh=1.6, cols=2):
        return Opening(s, y, w, hh, frame=white, reveal=.18, cols=cols, transom=.7 if hh > 1.2 else None)

    def dress(W, N, T, ops, arches=True, boxes=True):
        for o in ops:
            if o.kind == "window" and boxes:
                shutter_box(h, W, N, T, o, white)
            if arches and o.kind in ("window", "door"):
                seg_arch(h, W, N, T, o.s - o.w / 2 - .1, o.s + o.w / 2 + .1, o.y + o.h, .16, .24, "vh_stone", pale)

    # --- the house's street front: a window, the door, a window; three windows over them --------------------------
    g0 = gy(-4.0, -.2)
    fl = g0 + .16
    door = Opening(4.25, fl, 1.0, 2.15, "door", door="#f3f2ee", frame=white, panels="glazed", reveal=.18, sill=False, step=(g0, .25))
    light = Opening(4.25, fl + 2.2, 1.0, .45, frame=white, reveal=.18, cols=2, sill=False)
    ups = [win(1.4, 3.65), win(4.25, 3.65), win(7.1, 3.65)]
    downs = [win(1.4, .95), win(7.1, .95)]
    ops = downs + [door, light] + ups
    W, N, T = wall((-8.29, 0), (.24, 0), ops)
    dress(W, N, T, downs + ups)
    seg_arch(h, W, N, T, door.s - .6, door.s + .6, light.y + light.h, .16, .24, "vh_stone", pale)
    blind(h, W, N, T, downs[1], .55)
    blind(h, W, N, T, ups[0], .45)
    courses(h, W, N, T, ops, 3.18, 3.32, 8.53, "vh_stone", pale)  # a course of pale brick between the floors
    # --- the barn's front: the big grey door with a concrete lintel, a strip of glass over it ---------------------------
    bdoor = Opening(2.0, gy(2.2, -.3) + .02, 3.0, 3.0, "garage", door=grey, reveal=.16, sill=False)
    strip = Opening(2.0, 3.32, 2.6, .36, frame=white, reveal=.14, cols=3, sill=False)
    W, N, T = wall((.24, 0), (8.29, 0), [bdoor, strip])
    h.wbox(W, N, T, "vh_stone", .4, 3.6, bdoor.y + 3.0, bdoor.y + 3.16, -.02, 0, "#a29f98")
    # --- the barn's gable to the north (the Sparrenhof): blank brick, one small window high up; the low part beyond --
    W, N, T = wall((8.29, 0), (8.29, 7.01), [Opening(3.9, 5.4, .5, .6, frame=white, reveal=.15, sill=False)])
    wall((8.29, 7.01), (8.29, 19.43), [win(6.0, 1.35, .9, .9, 1)], top=FL)
    wall((8.29, 19.43), (6.82, 19.58), top=FL)
    # --- the wing and the low part: small windows and two plank doors to the yard, one window to the north ---------------
    wall((6.82, 19.58), (6.8, 34.17), [win(8.0, 1.2, .6, .6, 1)])
    wall((6.8, 34.17), (3.02, 34.4), [Opening(1.9, 3.5, .45, .45, "vent", reveal=.12, sill=False)])
    W, N, T = wall((3.02, 34.4), (2.78, 22.37), [win(2.5, 1.2, .6, .6, 1), Opening(6.0, gy(2.6, 28.4) + .05, 1.0, 2.0, "door", door="#6f5a44", frame="#5b4a38", reveal=.14, sill=False),
                                               win(9.5, 1.2, .6, .6, 1)])
    W, N, T = wall((2.78, 22.37), (3.1, 7.74), [win(2.5, 1.2, .6, .6, 1), Opening(10.0, gy(2.9, 12.4) + .05, 1.0, 2.0, "door", door="#6f5a44", frame="#5b4a38", reveal=.14, sill=False)])
    # --- behind the house and the link ------------------------------------------------------------------------------------
    wall((3.1, 7.74), (.24, 7.69), [win(1.4, 1.0, .9, 1.1, 1)])
    wall((.24, 7.69), (.16, 8.93))
    back = [win(2.5, .95), win(6.0, .95), win(2.5, 3.65), win(6.0, 3.65)]
    W, N, T = wall((.16, 8.93), (-8.3, 8.96), back, out=(0, 1))
    dress(W, N, T, back)
    # The house's south gable: a window on each floor.
    side = [win(4.48, .95), win(4.48, 3.65)]
    W, N, T = wall((-8.3, 8.96), (-8.29, 0), side)
    dress(W, N, T, side)
    # The house's north gable over the barn's roof, from that roof up.
    bot = [(0, barn.height(.24, 0) - .25), (DB / 2, barn.height(.24, DB / 2) - .25), (7.69, barn.height(.24, 7.69) - .25)]
    h.wall((.24, 0), (.24, 7.69), top_over([house], (.24, 0), (.24, 7.69)), bottom=bot, out=(1, 0))
    # The wing's gable over the flat roof, toward the street.
    h.wall((2.886, 17.5), (6.82, 17.5), top_over([wing], (2.886, 17.5), (6.82, 17.5)), bottom=FL - .1, out=(0, -1))
    # The barn's back over the flat roof.
    h.wall((3.1, 7.01), (8.29, 7.01), top_over([barn], (3.1, 7.01), (8.29, 7.01)), bottom=FL - .1, out=(0, 1))
    # ... and the link's side over the flat roof, where the barn's back wall steps out to the link's.
    h.wall((3.1, 7.01), (3.1, 7.74), top_over([barn], (3.1, 7.01), (3.1, 7.74)), bottom=FL - .1, out=(1, 0))
    flat_roof(h, flat, FL)
    draw_roofs(h, roofs)
    # Gutters and downpipes on the street front, the house's back and the barn.
    for R, kk, EE, u0, u1, dd, out, pipes in ((house, k, E, -8.29 - ov, .24, -ov, (0, -1, 0), [(-8.15, -.08), (.12, -.08)]),
                                              (house, k, E, -8.29 - ov, .16, D + ov, (0, 1, 0), [(-8.15, D + .08)]),
                                              (barn, kb, EB, .24, 8.29 + .25, -ov, (0, -1, 0), [(8.17, -.08)])):
        ye = EE - kk * ov - .22
        h.gutter((u0, dd, ye), (u1, dd, ye), out, "#6b6e6c", down=[(u, d, gy(u, d)) for u, d in pipes])
    tile = "#202123"
    h.tile_ends((-8.29 - ov, -ov, E - k * ov), (.24, -ov, E - k * ov), (0, -1, 0), tile)
    h.tile_ends((.24, -ov, EB - kb * ov), (8.54, -ov, EB - kb * ov), (0, -1, 0), tile)
    h.chimney(-7.3, D / 2, .55, .7, RG - .8, RG + .9, "vh_brick")
    # --- the garden beyond the barn: the low wall with its railing along the street's edge, two conifers ------------------
    railing_wall(h, [(8.42, -.22), (9.6, -.25), (20.4, .55)], [3.0, 6.0, 9.0], "#a5a29b", "#1b1b1b")
    for u, d in ((12.6, 1.6), (17.4, 1.9)):
        g = gy(u, d)
        cone(h, u, d, g - .1, g + 2.0, .55)
        h.block("nb_hedge", [(u - .4, d - .4), (u + .4, d - .4), (u + .4, d + .4), (u - .4, d + .4)], g - .1, g + 1.9)
    h.export()


# ======================================================================================================================
# 10. x 695.0, z 418.9: a dark brick house of the 1970s hard by the pavement, two storeys under a dark roof hipped to
# the north, wide windows with concrete lintels, roller shutters, a planted bed in front; and joined to its south side,
# where the data has one long low wing, a narrow house of lighter brick reaching nearer the street, its eaves along
# it, a white garage door of diagonal boards, and a low shed behind it.
def diagonal_door(h, W, N, T, o, color="#f2f1ec", lines="#cfd0cc"):
    """A garage door of boards laid on the slant, in herringbone either side of its middle."""
    s0, s1, y0, y1, r = o.s - o.w / 2, o.s + o.w / 2, o.y, o.y + o.h, o.reveal
    h.wbox(W, N, T, "vh_trim", s0, s1, y0, y1, r - .04, r, color)
    dep = r - .046
    for half, sgn in (((s0 + .04, o.s - .02), 1), ((o.s + .02, s1 - .04), -1)):
        a, b = half
        step = .3
        k = -1.0
        while k < 2.2:
            # a strip from the half's edge up across it at 45 degrees
            pts = []
            for t in (0.0, 1.0):
                x = a + (b - a) * t if sgn > 0 else b - (b - a) * t
                y = y0 + .05 + k * (y1 - y0 - .1) / 2 + (b - a) * t
                pts.append((x, y))
            (xa, ya), (xb, yb) = pts
            # clip the strip to the door
            lo, hi = y0 + .04, y1 - .04
            if yb < lo or ya > hi:
                k += step
                continue
            if ya < lo:
                xa, ya = xa + (xb - xa) * (lo - ya) / (yb - ya), lo
            if yb > hi:
                xb, yb = xa + (xb - xa) * (hi - ya) / (yb - ya), hi
            w = .018
            h.poly("vh_frames_small", [W(xa, ya - w, dep), W(xb, yb - w, dep), W(xb, yb + w, dep), W(xa, ya + w, dep)], N, lines)
            k += step
    h.wbox(W, N, T, "vh_frames_small", o.s - .02, o.s + .02, y0, y1, dep - .002, dep + .004, lines)


def seventies():
    h = House("vh_seventies", [684.6, 411.32], ([687.51, 416.89], [686.41, 425.51]), -4.47, {
        "vh_brick": {"texture": "nb_brick", "tint": "#5c3f37", "normalScale": .55},  # dark purple-brown, nb_brown's dark end
        "vh_brick2": {"texture": "nb_brick", "tint": "#8c5e52", "normalScale": .55},  # the narrow house: nb_red's light end
        "vh_roof": {"texture": "roof_tiles", "tint": "#35373b", "normalScale": .3},
        "vh_paving": {"texture": "pavers", "tint": "#8f8c86"},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,
    })
    # u along the street front to the north, d from the dark house's front (0) to the back. The wall block found by the
    # corner is the data's long wing (the narrow house and the shed); the dark house's own block is the second.
    h.also_replaces([699.89, 427.25])
    h.replace_roof([687.51, 416.89])
    lift = h.base
    gy = lambda u, d: h.ground(u, d)
    white, lint, foot_c = "#f2f1ec", "#aaa59b", "#55524e"
    # The dark house: u -4.34 to 4.34, d 0 to 10.1; eaves 6.3 along the street and the back, hipped to the north,
    # a plain gable to the south against the narrow house; a flat-roofed back room to d 13.6.
    E, RG, D, ov = 6.3 + lift, 10.1 + lift, 10.1, .4
    k = (RG - E) / (D / 2)
    main = Roof([(-4.34, -ov), (4.34 + ov, -ov), (4.34 + ov, D + ov), (-4.34, D + ov)],
                [eave((0, -ov), (0, 1), E - k * ov, k), eave((0, D + ov), (0, -1), E - k * ov, k), eave((4.34 + ov, 0), (-1, 0), E - k * ov, k * 1.4)],
                under=white, edge=white, board=.28)
    # The narrow house: u -9.58 to -4.34, d -3.59 to 10, its ridge along the street.
    NE, NR, n0, n1, no = 5.4 + lift, 9.0 + lift, -3.59, 10.0, .35
    kn = (NR - NE) / ((n1 - n0) / 2)
    # (no overhang at the back: it ends on the back wall's line, where the shed's roof begins)
    narrow = Roof([(-9.58 - no, n0 - no), (-4.34, n0 - no), (-4.34, 10.1), (-9.58 - no, 9.993)],
                  [eave((0, n0 - no), (0, 1), NE - kn * no, kn), eave((0, n1 + no), (0, -1), NE - kn * no, kn)], under=white, edge="#3a3b3e", board=.22)
    # The shed behind it: u -8.1 to -4.3, d 10 to 24.4, its ridge away from the street.
    SE, SR = 3.0 + lift, 4.9 + lift  # (the ground rises toward its end: its eaves stay over a head)
    ks = (SR - SE) / 1.9
    shed = Roof([(-8.1 - .15, 10.0), (-4.25, 10.0), (-4.25, 24.41 + .3), (-8.1 - .15, 24.41 + .3)],
                [eave((-8.1 - .15, 0), (1, 0), SE - ks * .15, ks), eave((-4.3, 0), (-1, 0), SE, ks)], under=white, edge="#3a3b3e", board=.18)
    roofs = [main, narrow, shed]
    FL = 3.1 + lift
    back = [(-4.32, 10.11), (4.25, 10.09), (4.24, 10.59), (4.36, 13.59), (-4.31, 13.55)]
    flat_at = over(back, FL + .07)
    foot = [(.3, "vh_trim", foot_c)]

    def wall(a, b, ops=(), **kw):
        top = kw.pop("top", None)
        W, N, T = h.wall(a, b, top if top is not None else top_over(roofs, a, b, also=[flat_at]), ops, bands=kw.pop("bands", foot), **kw)
        for o in ops:
            if o.kind == "window":
                shutter_box(h, W, N, T, o, white)
                if kw.get("mesh", "vh_brick") == "vh_brick":
                    h.wbox(W, N, T, "vh_stone", o.s - o.w / 2 - .1, o.s + o.w / 2 + .1, o.y + o.h, o.y + o.h + .18, -.02, 0, lint)
        return W, N, T

    win = lambda s, y, w, hh: Opening(s, y, w, hh, frame=white, reveal=.14, cols=3 if w > 2.0 else 2 if w > 1.0 else 1)
    # --- the dark house's street front: two wide windows, two over them, roller shutters half down on two -----------
    g0 = gy(0, -.3)
    downs = [win(2.25, g0 + .85, 2.4, 1.4), win(6.45, g0 + .85, 2.4, 1.4)]
    ups = [win(2.25, 3.65, 1.9, 1.3), win(6.45, 3.65, 1.9, 1.3)]
    W, N, T = wall((-4.34, 0), (4.34, 0), downs + ups, out=(0, -1))
    blind(h, W, N, T, ups[0], .5)
    blind(h, W, N, T, ups[1], .4)
    # --- its north side: the front door set back under the house, windows; the back room ---------------------------------
    gd = gy(5.0, 1.4)
    fl = gd + .18
    door = Opening(1.5, fl, 1.0, 2.2, "door", door="#4a3a2e", frame="#3b3d3e", panels="glazed", reveal=.55, sill=False, step=(gd, .4))
    nops = [door, win(4.6, fl + .75, 1.4, 1.3), win(8.2, fl + .75, 1.0, 1.3), win(1.5, 3.65, 1.0, 1.2), win(5.6, 3.65, 1.4, 1.2)]
    W, N, T = wall((4.34, 0), (4.24, 10.59), nops, out=(1, 0))
    lamp(h, W, N, T, door.s + .75, fl + 1.9)
    wall((4.24, 10.59), (4.36, 13.59), [win(1.5, fl + .75, 1.0, 1.2)], top=FL, out=(1, 0))
    wall((4.36, 13.59), (-4.31, 13.55), [Opening(3.0, gy(1.4, 13.8) + .05, 2.6, 2.15, frame=white, reveal=.14, cols=2, sill=False), win(6.6, fl + .75, 1.2, 1.2)], top=FL, out=(0, 1))
    wall((4.25, 10.09), (-4.32, 10.11), [win(2.4, 3.65, 1.2, 1.2), win(6.2, 3.65, 1.2, 1.2)], bottom=FL - .1, bands=(), out=(0, 1))
    flat_roof(h, back, FL)
    # --- the narrow house: its front with the garage door and a door, two windows over them; its south gable ---------
    gn = gy(-7.9, -3.9)
    fn = gn + .15
    garage = Opening(1.65, gn + .02, 2.4, 2.1, "leaf", reveal=.16, sill=False)
    nd = Opening(4.0, fn, .95, 2.15, "door", door="#f3f2ee", frame=white, panels="glazed", reveal=.16, sill=False, step=(gn, .3))
    nops = [garage, nd, win(1.65, 3.4, 1.4, 1.2), win(4.0, 3.4, .9, 1.2)]
    W, N, T = wall((-9.5, -3.59), (-4.34, -3.56), nops, mesh="vh_brick2", out=(0, -1))
    diagonal_door(h, W, N, T, garage)
    h.wbox(W, N, T, "vh_stone", garage.s - 1.32, garage.s + 1.32, gn + 2.12, gn + 2.3, -.02, 0, lint)
    wall((-9.58, 10), (-9.5, -3.59), [win(4.0, fn + .8, 1.2, 1.2), win(4.0, 3.4, 1.0, 1.1), win(9.0, 3.4, 1.0, 1.1)], mesh="vh_brick2", out=(-1, 0))
    wall((-9.58, 10), (-8.11, 10.02), mesh="vh_brick2", out=(0, 1))
    # Where the two houses meet: the narrow house's north wall before the dark one, and above the dark one's roof the
    # one that stands higher there.
    cut = 3.44  # d where the two roofs are as high
    hi = lambda d: max(narrow.height(-4.34, d), main.height(-4.34, d)) - .06
    lo = lambda d: min(narrow.height(-4.34, d), main.height(-4.34, d)) - .25
    h.wall((-4.34, n0), (-4.34, cut), [(d - n0, hi(d)) for d in (n0, 0, 3.2, cut)],
           [win(1.8, fn + .8, .8, 1.1)], mesh="vh_brick2", bottom=[(0, h.foot), (3.59 - .001, h.foot), (3.59, lo(0)), (cut - n0, lo(cut))], out=(1, 0), bands=foot)
    h.wall((-4.34, cut), (-4.34, D), [(0, hi(cut)), (5.05 - cut, hi(5.05)), (D - cut, hi(D))], bottom=[(0, lo(cut)), (D - cut, lo(D))], out=(-1, 0))
    h.wall((-8.11, 10.02), (-4.34, 10.1), top_over([narrow], (-8.11, 10.02), (-4.34, 10.1)), mesh="vh_brick2",
           bottom=[(0, SE - .2), (1.9, SR - .2), (3.77, SE - .2)], out=(0, 1))
    # --- the shed: low walls of the narrow house's brick, a small window and a door ----------------------------------------
    sw = lambda a, b, ops=(), **kw: wall(a, b, ops, top=top_over([shed], a, b), mesh="vh_brick2", **kw)
    sw((-8.11, 10.02), (-8.1, 16.91), [Opening(3.4, gy(-8.6, 13.4) + .05, .9, 1.95, "door", door="#6c6a64", frame="#5a5854", reveal=.12, sill=False)], out=(-1, 0))
    sw((-8.1, 16.91), (-7.87, 24.22), [win(3.6, 1.3, .7, .6)], out=(-1, 0))
    sw((-7.87, 24.22), (-4.29, 24.41), out=(0, 1))
    sw((-4.29, 24.41), (-4.31, 13.55), out=(1, 0))
    h.wall((-4.31, 13.55), (-4.32, 10.11), FL, bottom=SE - .1, out=(-1, 0))
    draw_roofs(h, roofs)
    # Gutters and downpipes; a chimney on the dark house.
    ye = E - k * ov - .3
    h.gutter((-4.34, -ov, ye), (4.34 + ov, -ov, ye), (0, -1, 0), white, down=[(4.26, -.08, gy(4.26, -.08))])
    h.gutter((4.34 + ov, D + ov, ye), (-4.34, D + ov, ye), (0, 1, 0), white)
    yn = NE - kn * no - .24
    h.gutter((-9.58 - no, n0 - no, yn), (-4.34, n0 - no, yn), (0, -1, 0), white, down=[(-9.42, n0 - .08, gy(-9.42, n0 - .08))])
    h.chimney(1.2, D / 2 + 1.2, .55, .55, main.height(1.2, D / 2 + 1.2) - .4, RG + .7, "vh_brick")
    # --- before the houses: a planted bed with a low concrete edge and two clipped shrubs; pavers to the street's edge ----
    edge = lambda u: (u, round(-3.93 + .2398 * (u - 4.37), 4))  # the street's paving begins here (its edge in the data)
    bed = [(-4.3, -1.75), (4.3, -1.75), (4.3, -.03), (-4.3, -.03)]
    for a, b in zip(bed, bed[1:] + bed[:1]):
        ga = min(gy(*a), gy(*b))
        h.seg("vh_stone", a, b, .1, ga - .1, max(gy(*a), gy(*b)) + .15, "#a7a49d")
    h.poly("vh_trim", [(u, d, gy(u, d) + .09) for u, d in ((-4.25, -1.7), (4.25, -1.7), (4.25, -.08), (-4.25, -.08))], (0, 0, 1), "#3e3329")
    for u, d, r in ((-2.4, -.9, .38), (3.1, -.85, .42)):
        h.blob("vh_trim", u, d, gy(u, d) + .5 - r * .9, (r, r, r * .9), rings=4, steps=9, color="#506b40")  # (nine meshes at most)
    h.pave([(-9.5, -3.61), (-4.34, -3.58), (-4.34, -1.8), (4.35, -1.8), (4.37, -3.93), edge(-9.5)], cell=1.2)
    h.pave([(4.37, -.02), (5.7, -.02), (5.7, 2.4), (4.36, 2.4)], cell=1.2)  # the path to the door
    h.export()


# ======================================================================================================================
# 11. x 695.4, z 590.7: a long low bungalow of the 1970s in orange-red brick, end-on to the street, its wide grey roof
# hipped toward the street with a white fascia, a sliding window in the end wall; set back behind a clipped beech
# hedge with a gap for the gravel drive, which runs along its side to the garage at the back.
def hedge_bungalow():
    h = House("vh_hedge_bungalow", [707.36, 581.63], ([707.36, 581.63], [709.9, 591.79]), -3.94, {
        "vh_brick": {"texture": "nb_brick", "tint": "#905e4e", "normalScale": .55},  # nb_red's most orange
        "vh_roof": {"texture": "roof_tiles", "tint": "#3f4144", "normalScale": .3},
        "vh_gravel": {"texture": "gravel", "tint": "#5e5c58"},
        "vh_hedge": {"texture": "hedge", "tint": "#7a6a45"},  # beech keeps its brown leaves
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,
    })
    # u along the end wall to the south (the drive's side), d from the end wall (0) away from the street.
    lift = h.base
    gy = lambda u, d: h.ground(u, d)
    white, pale = "#f2f1ec", "#c9ccc8"
    E, RG, W2, ov, D = 2.9 + lift, 6.5 + lift, 5.24, .45, 21.78
    k = (RG - E) / W2
    roof = Roof([(-W2 - ov, -ov), (W2 + ov, -ov), (W2 + ov, D + .3), (-W2 - ov, D + .3)],
                [eave((-W2 - ov, 0), (1, 0), E - k * ov, k), eave((W2 + ov, 0), (-1, 0), E - k * ov, k), eave((0, -ov), (0, 1), E - k * ov, k)],
                under=white, edge=white, board=.25)
    roofs = [roof]
    foot = [(.25, "vh_trim", "#77736d")]
    g0 = gy(0, -.3)
    fl = g0 + .15

    def wall(a, b, ops=(), **kw):
        top = kw.pop("top", None)
        return h.wall(a, b, top if top is not None else top_over(roofs, a, b), ops, bands=kw.pop("bands", foot), **kw)

    win = lambda s, w=1.8, hh=1.3, y=None: Opening(s, fl + .75 if y is None else y, w, hh, frame=white, reveal=.14, cols=2 if w > 1.0 else 1)
    # --- the end wall to the street: a sliding window from the floor, a white panel over it to the eaves ---------------
    slide = Opening(3.6, fl, 2.8, 2.0, frame=pale, reveal=.14, cols=2, sill=False)
    W, N, T = wall((-W2, 0), (W2, 0), [slide], out=(0, -1))
    h.wbox(W, N, T, "vh_trim", slide.s - slide.w / 2, slide.s + slide.w / 2, fl + 2.0, E - .02, -.02, .05, white)
    h.wbox(W, N, T, "vh_stone", slide.s - slide.w / 2 - .05, slide.s + slide.w / 2 + .05, fl - .06, fl, -.08, .14, "#a8a59f")
    # --- the long sides: windows; the garage at the back of the drive's side -------------------------------------------
    gg = gy(6.0, 17.4)
    wall((W2, 0), (5.1, 19.71), [win(3.0), win(8.0), win(12.6, 1.2, 1.1), Opening(17.4, gg + .02, 2.5, 2.1, "garage", door="#f1f0eb", reveal=.14, sill=False)], out=(1, 0))
    wall((-5.25, 19.52), (-W2, 0), [win(4.5), win(10.0), win(15.5, 1.2, 1.1)], out=(-1, 0))
    # --- the back: a glazed door and windows, a room reaching out under the roof; the gable over them -------------------
    wall((5.1, 19.71), (.08, 19.62), [Opening(1.6, fl, .95, 2.1, "door", door="#f1f0eb", frame=white, panels="glazed", reveal=.14, sill=False), win(3.6, 1.2, 1.1)], out=(0, 1))
    wall((.08, 19.62), (.03, 21.66), out=(1, 0))
    wall((.03, 21.66), (-3.86, 21.78), [win(1.95, 1.8, 1.3)], out=(0, 1))
    wall((-3.86, 21.78), (-3.88, 19.54), out=(-1, 0))
    wall((-3.88, 19.54), (-5.25, 19.52), out=(0, 1))
    gab = top_over(roofs, (W2, 21.7), (-W2, 21.7))
    h.wall((W2, 21.7), (-W2, 21.7), gab, bottom=E - .35, out=(0, 1))
    for u in (5.0, -5.15):  # posts under the gable's corners, where the back is open under the roof
        g = gy(u, 21.6)
        h.box("vh_trim", u - .08, u + .08, 21.52, 21.68, g - .1, E - .3, white)
        h.block("concrete", [(u - .08, 21.52), (u + .08, 21.52), (u + .08, 21.68), (u - .08, 21.68)], g - .1, E - .3)
    draw_roofs(h, roofs)
    ye = E - k * ov - .27
    h.gutter((W2 + ov, -ov, ye), (W2 + ov, D + .3, ye), (1, 0, 0), white, down=[(W2 + .08, .2, gy(W2, .2)), (W2 + .08, 19.5, gy(W2, 19.5))])
    h.gutter((-W2 - ov, D + .3, ye), (-W2 - ov, -ov, ye), (-1, 0, 0), white, down=[(-W2 - .08, .2, gy(-W2, .2))])
    h.gutter((-W2 - ov, -ov, ye), (W2 + ov, -ov, ye), (0, -1, 0), white)
    h.chimney(-2.6, 4.2, .5, .5, roof.height(-2.6, 4.2) - .4, roof.height(-2.6, 4.2) + .75, "vh_brick")
    # --- the hedge along the street with the drive's gap, dark gravel before it and up the drive --------------------------
    edge = lambda u: (u, round(-6.83 + (u - 23.87) * .02167, 4))  # the street's paving begins here (its edge in the data)
    hd, ht = -5.5, 1.3
    a, b = (-9.6, hd), (5.55, hd)
    L = math.dist(a, b)
    n = int(L / 2.5) + 1
    for i in range(n):  # in lengths, each on its own ground, each a block
        p = (a[0] + (b[0] - a[0]) * i / n, hd)
        q = (a[0] + (b[0] - a[0]) * (i + 1) / n, hd)
        g = min(gy(*p), gy(*q))
        h.seg("vh_hedge", p, q, .7, g - .15, g + ht - .1)
        h.seg("vh_hedge", p, q, .56, g + ht - .1, g + ht)
        h.seg_block("nb_hedge", p, q, .7, g - .15, g + ht)
    h.pave([edge(-9.6), edge(9.3), (9.3, 18.9), (5.32, 18.9), (5.32, -.02), (5.6, -.02), (5.6, hd - .36), (-9.6, hd - .36)], mesh="vh_gravel", lift=.03, cell=1.5)
    h.export()


# ======================================================================================================================
# 12. x 1629.1, z -364.2: an old cottage in weathered cream render on the road, one storey with a room in its steep slate
# roof, a round window ringed in brick high in the gable toward Molenhoek, brick quoins at that corner, small windows
# and a door in flat brick surrounds, two rendered chimneys, a flat-roofed back part; grass up to its walls.
def cottage():
    # (found by its back corner: its front corners are the street's paving's too)
    h = House("vh_cottage", [1634.93, -370.54], ([1623.96, -358.84], [1634.14, -358.19]), 9.69, {
        "vh_render": {"texture": "plaster", "tint": "#d6cab2", "normalScale": .9},
        "vh_brick": {"texture": "nb_brick", "tint": "#7f4a3c", "normalScale": .6},
        "vh_roof": {"texture": "roof_tiles", "tint": "#3f4347", "normalScale": .25},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,
    })
    # u along the road front to the east (u -5.1: the gable toward Molenhoek), d from the front (0) to the back.
    lift = h.base
    gy = lambda u, d: h.ground(u, d)
    white, red, foot_c = "#f2f1ec", "#8a5140", "#77746e"
    E, RG, D, ov, vg = 3.0 + lift, 7.0 + lift, 7.95, .3, .12
    k = (RG - E) / (D / 2)
    main = Roof([(-5.1 - vg, -ov), (5.1 + vg, -ov), (5.1 + vg, D + ov), (-5.1 - vg, D + ov)],
                [eave((0, -ov), (0, 1), E - k * ov, k), eave((0, D + ov), (0, -1), E - k * ov, k)], under="#cfc7b6", edge="#3a3c3f", board=.14)
    roofs = [main]
    FL = 2.7 + lift
    back = [(-5.09, 7.95), (5.1, 7.95), (5.1, 12.38), (2.01, 12.45), (1.97, 9.59), (-.14, 9.6), (-.18, 9.18), (-5.09, 9.32)]
    flat_at = over(back, FL + .07)
    foot = [(.4, "vh_trim", foot_c)]

    def wall(a, b, ops=(), **kw):
        top = kw.pop("top", None)
        return h.wall(a, b, top if top is not None else top_over(roofs, a, b, also=[flat_at]), ops, mesh="vh_render", bands=kw.pop("bands", foot), **kw)

    g0 = gy(.5, -.2)
    fl = g0 + .12
    win = lambda s, y=None, w=.9, hh=1.2: Opening(s, fl + .78 if y is None else y, w, hh, frame=white, reveal=.16, cols=2 if w > .8 else 1, surround=red, sill=False)
    # --- the road front: two windows, the door, a window -------------------------------------------------------------------
    ops = [win(1.4), win(3.5), Opening(5.7, fl, .9, 2.0, "door", door="#efeeea", frame=white, panels="glazed", reveal=.16, sill=False, surround=red, step=(g0, .25)), win(7.9)]
    W, N, T = wall((-5.1, 0), (5.1, 0), ops, out=(0, -1))
    # --- the gable toward Molenhoek: the round window in its brick ring, brick quoins at the road's corner --------------
    L = math.dist((-5.09, 9.32), (-5.1, 0))
    oc, oy, r0, r1 = L - D / 2, E + 1.55, .4, .55
    # (a square hole a little smaller than the glass; the brick ring covers its corners)
    Wg, Ng, Tg = wall((-5.09, 9.32), (-5.1, 0), [Opening(oc, oy - .38, .76, .76, "round", reveal=.12, sill=False)], out=(-1, 0))
    at = lambda a, r, dep: Wg(oc + math.cos(a) * r, oy + math.sin(a) * r, dep)
    for i in range(16):  # the glass set in, a white frame, the brick ring a little proud and its reveal
        a0, a1 = math.tau * i / 16, math.tau * (i + 1) / 16
        am = (a0 + a1) / 2
        h.poly("vh_glass", [Wg(oc, oy, .12), at(a0, r0, .12), at(a1, r0, .12)], Ng)
        h.poly("vh_frames_small", [at(a0, r0, .1), at(a1, r0, .1), at(a1, r0 - .06, .1), at(a0, r0 - .06, .1)], Ng, white)
        h.poly("vh_brick", [at(a0, r0, -.02), at(a1, r0, -.02), at(a1, r1, -.02), at(a0, r1, -.02)], Ng)
        h.poly("vh_brick", [at(a0, r0, -.02), at(a1, r0, -.02), at(a1, r0, .12), at(a0, r0, .12)],
               tuple(-Tg[q] * math.cos(am) - (0, 0, 1)[q] * math.sin(am) for q in range(3)))
        h.poly("vh_brick", [at(a0, r1, -.02), at(a1, r1, -.02), at(a1, r1, 0), at(a0, r1, 0)],
               tuple(Tg[q] * math.cos(am) + (0, 0, 1)[q] * math.sin(am) for q in range(3)))
    # quoins: brick blocks at the corner, long and short in turn, on both faces, from the foot to the eaves
    y = .4
    i = 0
    while y < E - .3:
        lng = .36 if i % 2 == 0 else .2
        h.wbox(Wg, Ng, Tg, "vh_brick", L - lng, L, y, y + .22, -.02, 0)
        h.wbox(W, N, T, "vh_brick", 0, .2 if i % 2 == 0 else .36, y, y + .22, -.02, 0)
        y += .26
        i += 1
    # --- the other gable, the back and the flat-roofed back part --------------------------------------------------------------
    wall((5.1, 0), (5.1, 12.38), [win(2.0), win(3.975, E + .9, .6, .8), win(10.5, None, .8, 1.0)], out=(1, 0))
    wall((5.1, 12.38), (2.01, 12.45), [Opening(1.5, gy(3.5, 12.6) + .1, .85, 1.95, "door", door="#6f6a62", frame=white, reveal=.14, sill=False)], top=FL, out=(0, 1))
    wall((2.01, 12.45), (1.97, 9.59), top=FL, out=(-1, 0))
    wall((1.97, 9.59), (-.14, 9.6), [win(1.05, None, .8, 1.0)], top=FL, out=(0, 1))
    wall((-.14, 9.6), (-.18, 9.18), top=FL, out=(-1, 0))
    wall((-.18, 9.18), (-5.09, 9.32), [win(2.4, None, .9, 1.0)], top=FL, out=(0, 1))
    h.wall((5.1, D), (-5.09, D), top_over([main], (5.1, D), (-5.09, D)), mesh="vh_render", bottom=FL - .1, out=(0, 1))
    flat_roof(h, back, FL)
    draw_roofs(h, roofs)
    ye = E - k * ov - .16
    h.gutter((-5.1 - vg, -ov, ye), (5.1 + vg, -ov, ye), (0, -1, 0), "#7c7e7c", down=[(4.98, -.08, gy(4.98, -.08))])
    h.gutter((5.1 + vg, D + ov, ye), (-5.1 - vg, D + ov, ye), (0, 1, 0), "#7c7e7c")
    for cu in (-4.75, 1.2):  # two rendered chimneys on the ridge, the first at the gable's top
        h.chimney(cu, D / 2, .55, .6, RG - .5, RG + .85, "vh_render", cap="#8c8984")
    h.export()


HOUSES = {"vh_old_farm": old_farm, "vh_seventies": seventies, "vh_hedge_bungalow": hedge_bungalow, "vh_cottage": cottage}
for _name, _build in HOUSES.items():
    if not ONLY or _name in ONLY:
        _build()
