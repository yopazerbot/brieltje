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
    house = Roof([(-8.29 - ov, -ov), (.36, -ov), (.36, D + ov), (-8.29 - ov, D + ov)],
                 [eave((0, -ov), (0, 1), E - k * ov, k), eave((0, D + ov), (0, -1), E - k * ov, k)], under="#cfccc5", edge="#232426", board=.2)
    # The barn and the link beside the house under one roof, u 0.24 to 8.29, d 0 to 7.73; lower.
    EB, RB, DB = 4.4 + lift, 8.0 + lift, 7.73
    kb = (RB - EB) / (DB / 2)
    barn = Roof([(.24, -ov), (8.29 + .25, -ov), (8.29 + .25, DB + ov), (.24, DB + ov)],
                [eave((0, -ov), (0, 1), EB - kb * ov, kb), eave((0, DB + ov), (0, -1), EB - kb * ov, kb)], under="#cfccc5", edge="#232426", board=.2)
    # The wing behind, u 2.78 to 6.82, d 17.5 to 34.4: low walls, a steep roof, its ridge away from the street.
    EW, RW = 2.7 + lift, 6.2 + lift
    kw = (RW - EW) / 2.02
    wing = Roof([(2.78 - .3, 17.5), (6.82 + .3, 17.5), (6.82 + .3, 34.4 + .3), (2.78 - .3, 34.4 + .3)],
                [eave((2.78 - .3, 0), (1, 0), EW - kw * .3, kw), eave((6.82 + .3, 0), (-1, 0), EW - kw * .3, kw)], under="#cfccc5", edge="#232426", board=.18)
    roofs = [house, barn, wing]
    # Between the barn and the wing a low part under a flat roof.
    FL = 2.91 + lift
    flat = [(3.1, 7.01), (8.29, 7.01), (8.29, 19.43), (6.82, 19.58), (6.82, 17.5), (2.95, 17.5), (3.1, 7.74)]
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
    h.wall((2.95, 17.5), (6.82, 17.5), top_over([wing], (2.95, 17.5), (6.82, 17.5)), bottom=FL - .1, out=(0, -1))
    # The barn's back over the flat roof.
    h.wall((3.1, 7.01), (8.29, 7.01), top_over([barn], (3.1, 7.01), (8.29, 7.01)), bottom=FL - .1, out=(0, 1))
    flat_roof(h, flat, FL)
    draw_roofs(h, roofs)
    # Gutters and downpipes on the street front, the house's back and the barn.
    for R, kk, EE, u0, u1, dd, out, pipes in ((house, k, E, -8.29 - ov, .36, -ov, (0, -1, 0), [(-8.15, -.08), (.12, -.08)]),
                                              (house, k, E, -8.29 - ov, .16, D + ov, (0, 1, 0), [(-8.15, D + .08)]),
                                              (barn, kb, EB, .36, 8.29 + .25, -ov, (0, -1, 0), [(8.17, -.08)])):
        ye = EE - kk * ov - .22
        h.gutter((u0, dd, ye), (u1, dd, ye), out, "#6b6e6c", down=[(u, d, gy(u, d)) for u, d in pipes])
    tile = "#202123"
    h.tile_ends((-8.29 - ov, -ov, E - k * ov), (.36, -ov, E - k * ov), (0, -1, 0), tile)
    h.tile_ends((.36, -ov, EB - kb * ov), (8.54, -ov, EB - kb * ov), (0, -1, 0), tile)
    h.chimney(-7.3, D / 2, .55, .7, RG - .8, RG + .9, "vh_brick")
    # --- the garden beyond the barn: the low wall with its railing along the street's edge, two conifers ------------------
    railing_wall(h, [(8.42, -.22), (9.6, -.25), (20.4, .55)], [3.0, 6.0, 9.0], "#a5a29b", "#1b1b1b")
    for u, d in ((12.6, 1.6), (17.4, 1.9)):
        g = gy(u, d)
        cone(h, u, d, g - .1, g + 2.0, .55)
        h.block("nb_hedge", [(u - .4, d - .4), (u + .4, d - .4), (u + .4, d + .4), (u - .4, d + .4)], g - .1, g + 1.9)
    h.export()


HOUSES = {"vh_old_farm": old_farm}
for _name, _build in HOUSES.items():
    if not ONLY or _name in ONLY:
        _build()
