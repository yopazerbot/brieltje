"""Hand-made houses among the generated ones, package B5: six houses on the street that runs from behind the church
north-west toward the cemetery.

  blender -b -P tools/village_houses_b5.py -- web/public/models [vh_hip_single vh_ivy_cottage ...]

writes web/public/models/<name>.glb for each house, or for the ones named, with the toolkit of the earlier packages
(tools/village_houses_kit.py; see tools/village_houses_b1.py for the names of the meshes and what the game does with
each). A house is named by its spot in the model's metres, never by an address. Its kind, colours and main openings
were compared with street-level pictures by eye; nothing was copied, traced or sampled from them, and nothing
personal is modelled (no number, name, text, sign, letterbox, car or window dressing). The houses round the church
square and at the street's fork are the town's (tools/town/town.py) and stay so.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from village_houses_kit import *  # noqa: E402,F403  (Snapped, Opening, Roof, the details, the materials, ONLY)

House = Snapped  # noqa: F405  (the walls' ends drawn onto the outline's corners: village_houses_kit.py)


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


def ivy(h, W, N, T, s0, s1, y0, top, holes=(), step=.32, mesh="vh_hedge"):
    """Ivy over a wall, in its own measures: upright strips a little proud of it from y0 to under `top(s)`, each a
    little higher or lower than the next so the edge reads as leaves, and clear of the openings (s0, s1, y0, y1)."""
    rng = h.rng
    n = max(1, round((s1 - s0) / step))
    w = (s1 - s0) / n
    for i in range(n):
        a, b = s0 + i * w, s0 + (i + 1) * w
        m = (a + b) / 2
        hi = top(m) - rng.uniform(.05, .45)
        lo = y0 + rng.uniform(0, .25)
        spans = [(lo, hi)]
        for p0, p1, q0, q1 in holes:
            if b > p0 - .08 and a < p1 + .08:
                spans = [piece for lo2, hi2 in spans for piece in ((lo2, min(hi2, q0 - .08)), (max(lo2, q1 + .08), hi2)) if piece[1] - piece[0] > .15]
        dep = -.07 - rng.uniform(0, .07)
        for lo2, hi2 in spans:
            if hi2 > lo2:
                h.wbox(W, N, T, mesh, a, b + .02, lo2, hi2, dep, 0)


def gable_top(a0, a1, y_eave, y_ridge):
    """A symmetric gable's top along a wall from s a0 to a1: y_eave at the ends, y_ridge in the middle."""
    mid = (a0 + a1) / 2
    return lambda s: y_ridge - (y_ridge - y_eave) * abs(s - mid) / (mid - a0)


# ======================================================================================================================
# 17. x 494.5, z -657.1: a long bungalow of buff brick under a hipped roof of orange-red tiles, a chimney on its ridge,
# its garage at the church end of its long front, windows with brown shutters; a flat-roofed room at its far end.
def hip_single():
    h = House("vh_hip_single", [489.0, -645.08], ([492.03, -669.99], [489.0, -645.08]), 7.667, {
        "vh_brick": {"texture": "nb_brick", "tint": "#c4b294", "normalScale": .5},
        "vh_roof": {"texture": "roof_tiles", "tint": "#a9553b", "normalScale": .3},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,  # noqa: F405
    })
    # u along the long front to the north (away from the church), d from the front (0) to the back (8).
    lift = h.base
    gy = lambda u, d: h.ground(u, d)
    white, brown, zinc = "#f1f0eb", "#6e4733", "#8d9194"
    E, ov, k = 2.95 + lift, .45, .78
    uw, un, D = -12.55, 6.96, 7.99
    Ee = E - k * ov
    FA = 3.07 + lift  # the far room's flat roof
    main = Roof([(uw - ov, -ov), (un, -ov), (un, D + ov), (uw - ov, D + ov)],
                [eave((0, -ov), (0, 1), Ee, k), eave((0, D + ov), (0, -1), Ee, k),  # noqa: F405
                 eave((uw - ov, 0), (1, 0), Ee, k), eave((un, 0), (-1, 0), FA + .12, k)], under=white, edge=white, board=.24)  # noqa: F405
    roofs = [main]
    g0 = gy(0, -.3)
    fl = g0 + .2
    foot = [(g0 + .35, "vh_trim", "#77736c")]
    win = lambda s, w=1.6, hh=1.25, cols=2: Opening(s, fl + .85, w, hh, frame=white, reveal=.15, cols=cols)

    def wall(a, b, ops=(), top=None, **kw):
        return h.wall(a, b, top if top is not None else top_over(roofs, a, b), ops, bands=foot, **kw)  # noqa: F405

    # --- the long front: the garage at the church end, the door, three windows with shutters ----------------------
    fw = [win(8.55), win(12.05), win(15.75)]
    W, N, T = wall((uw, 0), (un, 0), [Opening(1.95, gy(-10.6, -.3) + .02, 2.5, 2.1, "garage", door=brown, frame=white, reveal=.15, sill=False),
                                      Opening(5.65, fl, 1.0, 2.1, "door", door=brown, frame=white, panels="glazed", reveal=.15, sill=False, step=(g0, .35))] + fw)
    for o in fw:
        shutters(h, W, N, T, o, brown)  # noqa: F405
    wall((un, 0), (12.55, 0), [win(2.8, 1.2, 1.2, 1)], top=FA - .02)
    # --- the far room's end and back, the back of the house, the church end with the side door ----------------------
    wall((12.55, 0), (12.5, 7.98), [win(4.0, 1.2, 1.2, 1)], top=FA - .02)
    wall((12.5, 7.98), (un, 7.98), [win(2.8, 1.2, 1.2, 1)], top=FA - .02)
    wall((un, 7.98), (uw, D), [win(2.2), win(6.0, 1.0, 1.0, 1), win(10.0, 2.4, 1.3, 3), win(14.5), win(17.6, 1.0, 1.0, 1)])
    wall((uw, D), (uw, 0), [win(2.0, 1.0, 1.25, 1), Opening(5.2, fl, 1.0, 2.1, "door", door=brown, frame=white, panels="glazed", reveal=.15, sill=False, step=(gy(uw - .3, 2.8), .35))])
    flat_roof(h, [(un, 0), (12.55, 0), (12.5, 7.98), (un, 7.98)], FA, "#b7ad9c")
    draw_roofs(h, roofs)  # noqa: F405
    ye = Ee - .26
    h.gutter((uw - ov, -ov, ye), (un, -ov, ye), (0, -1, 0), zinc, down=[(uw + .1, -.08, gy(uw, -.08)), (6.6, -.08, gy(6.6, -.08))])
    h.gutter((un, D + ov, ye), (uw - ov, D + ov, ye), (0, 1, 0), zinc, down=[(uw + .1, D + .08, gy(uw, D + .08))])
    h.chimney(-3.0, D / 2, .55, .55, main.height(-3.0, D / 2) - .4, main.height(-3.0, D / 2) + .85, "vh_brick", pots=[(0, 0)])
    h.export()


# ======================================================================================================================
# 18. x 451.5, z -692.3: an old cottage under orange pantiles, its gable to the street and its chimney grown over with
# ivy; behind it and higher, a whitewashed farm building under the same tiles; a low white room with a flat roof
# beside them.
def ivy_cottage():
    h = House("vh_ivy_cottage", [447.88, -700.68], ([445.82, -684.44], [451.69, -683.71]), 6.399, {
        "vh_brick": {"texture": "nb_brick", "tint": "#8d5c46", "normalScale": .6},
        "vh_render": {"texture": "plaster", "tint": "#efede6", "normalScale": .5},
        "vh_roof": {"texture": "roof_tiles", "tint": "#b0613f", "normalScale": .35},
        "vh_hedge": {"texture": "hedge", "tint": "#56703f"},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,  # noqa: F405
    })
    # u along the street gable to the east (toward the church), d from the gable (0) back from the street.
    lift = h.base
    gy = lambda u, d: h.ground(u, d)
    white, green, dark = "#eeede8", "#4c5a48", "#2f2f2e"
    # The cottage: 5.9 m wide, low eaves, its ridge running back from the street gable.
    Ec, kc, vg = 2.6 + lift, .82, .25
    cot = Roof([(-3.26, -vg), (3.26, -vg), (3.26, 5.49), (-3.26, 5.49)],
               [eave((-3.26, 0), (1, 0), Ec - kc * .3, kc), eave((3.26, 0), (-1, 0), Ec - kc * .3, kc)],  # noqa: F405
               under="#cfc9bd", edge=dark, board=.22)
    # The farm building behind it: narrower, higher, its own ridge the same way.
    Ef, kf = 4.3 + lift, 1.0
    farm = Roof([(-3.24, 5.49), (2.09, 5.49), (2.09, 16.64), (-3.24, 16.64)],
                [eave((-3.24, 0), (1, 0), Ef - kf * .3, kf), eave((2.09, 0), (-1, 0), Ef - kf * .3, kf)],  # noqa: F405
                under="#d8d3c8", edge=white, board=.22)
    roofs = [cot, farm]
    FA = 2.75 + lift  # the low room's flat roof
    side = [(2.96, 1.49), (5.35, 1.49), (5.37, 12.08), (1.78, 12.08), (1.77, 5.49), (2.96, 5.49)]
    g0 = gy(0, -.3)
    fl = g0 + .1
    tar = [(g0 + .45, "vh_trim", "#3a3937")]  # the farm's tarred foot
    win = lambda s, y, w, hh, f=green: Opening(s, y, w, hh, frame=f, reveal=.2)

    # --- the street gable, its ivy and its chimney ----------------------------------------------------------------
    gw, att = win(1.6, fl + .85, .9, 1.05), win(2.96, fl + 2.85, .5, .6)
    W, N, T = h.wall((-2.96, 0), (2.96, 0), top_over(roofs, (-2.96, 0), (2.96, 0)), [gw, att], bands=[(g0 + .3, "vh_trim", "#6a645c")])  # noqa: F405
    ridge_c = cot.height(0, 0)
    top = gable_top(0, 5.92, Ec - .05, ridge_c - .1)
    ivy(h, W, N, T, -.05, 5.97, g0 - .05, top, [(o.s - o.w / 2, o.s + o.w / 2, o.y, o.y + o.h) for o in (gw, att)])
    h.chimney(0, .3, .55, .5, ridge_c - .6, ridge_c + .95, "vh_brick", pots=[(0, 0)])
    for dy, du in ((.2, -.05), (.65, .08), (1.0, -.02)):  # the ivy up the chimney
        h.box("vh_hedge", -.33 + du, .33 + du, .0, .06 + .04, ridge_c - .2 + dy * .5, ridge_c + dy, None)
    # --- the cottage's sides: the ivy runs on along the west side ------------------------------------------------
    sw = win(2.7, fl + .85, .9, 1.05)
    W, N, T = h.wall((-2.94, 5.49), (-2.96, 0), top_over(roofs, (-2.94, 5.49), (-2.96, 0)), [sw], mesh="vh_brick")  # noqa: F405
    ivy(h, W, N, T, 3.2, 5.49, g0 - .05, lambda s: Ec - .1 - (s - 3.2) * .15, [(sw.s - .45, sw.s + .45, sw.y, sw.y + sw.h)])
    h.wall((2.96, 0), (2.95, 1.49), top_over(roofs, (2.96, 0), (2.95, 1.49)), mesh="vh_brick")  # noqa: F405
    h.wall((2.96, 5.49), (1.77, 5.49), top_over([cot], (2.96, 5.49), (1.77, 5.49)), mesh="vh_brick", bottom=FA - .1, out=(0, 1))  # noqa: F405
    # --- the farm building: whitewashed, a tarred foot, small windows, a plank door in its far gable --------------
    rw = lambda a, b, ops=(), **kw: h.wall(a, b, top_over([farm], a, b), ops, mesh="vh_render", **{"bands": tar, **kw})  # noqa: F405
    rw((-2.92, 16.37), (-2.94, 5.49), [win(1.6, fl + 1.2, .8, .8), win(4.7, fl + 1.2, .8, .8), win(8.4, fl + 1.2, .8, .8)])
    rw((-2.94, 5.49), (1.77, 5.49), bottom=top_over([cot], (-2.94, 5.49), (1.77, 5.49), drop=-.04), out=(0, -1), bands=())  # noqa: F405
    rw((1.77, 5.49), (1.78, 12.08), [win(3.4, FA + .4, .7, .6)], bottom=FA - .1, out=(1, 0), bands=())
    rw((1.78, 12.08), (1.79, 16.36), [win(2.2, fl + 1.2, .8, .8)])
    rw((1.79, 16.36), (-2.92, 16.37), [Opening(2.4, fl, 1.5, 2.2, "door", door="#7b5a40", frame="#5b4434", reveal=.18, sill=False),
                                        win(2.36, fl + 3.3, .55, .55)])
    # --- the low white room beside them, under its flat roof -----------------------------------------------------
    lw = lambda a, b, ops=(): h.wall(a, b, FA - .02, ops, mesh="vh_render", bands=[(g0 + .3, "vh_trim", "#6a645c")])
    lw((2.95, 1.49), (5.35, 1.49), [Opening(1.3, fl, .95, 2.05, "door", door=green, frame=green, panels="glazed", reveal=.16, sill=False, step=(gy(4.2, 1.2), .3))])
    lw((5.35, 1.49), (5.37, 12.08), [win(2.0, fl + .9, 1.0, 1.0, white), win(5.5, fl + .9, 1.0, 1.0, white), win(8.8, fl + .9, 1.0, 1.0, white)])
    lw((5.37, 12.08), (1.78, 12.08), [win(1.8, fl + .9, .9, .9, white)])
    flat_roof(h, side, FA, "#a5a29b")
    draw_roofs(h, roofs)  # noqa: F405
    h.gutter((-3.26, -vg, Ec - kc * .3 - .25), (-3.26, 5.4, Ec - kc * .3 - .25), (-1, 0, 0), "#77726b", down=[(-3.05, .25, gy(-3.05, .25))])
    h.gutter((-3.24, 5.6, Ef - kf * .3 - .25), (-3.24, 16.64, Ef - kf * .3 - .25), (-1, 0, 0), "#77726b", down=[(-3.03, 16.2, gy(-3.03, 16.2))])
    h.export()


# ======================================================================================================================
# 19. x 412.0, z -667.0: a modern house of white brick, two storeys with a flat-topped front, a hipped roof of dark
# tiles behind it; across its ground floor a band of dark grey brick with the entrance and the garage under a thin
# canopy; flat-roofed rooms at the side and the back; dark grey frames.
def white_modern():
    h = House("vh_white_modern", [414.0, -675.43], ([410.91, -657.64], [416.89, -662.4]), 7.494, {
        "vh_brick": {"texture": "nb_brick", "tint": "#ecebe6", "normalScale": .4},
        "vh_dark": {"texture": "nb_brick", "tint": "#56585b", "normalScale": .5},
        "vh_roof": {"texture": "roof_tiles", "tint": "#3a3c40", "normalScale": .3},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,  # noqa: F405
    })
    # u along the front to the south-east (the garage at u -2.3), d from the front back.
    lift = h.base
    gy = lambda u, d: h.ground(u, d)
    grey, coping = "#4b4e52", "#c9c6bf"
    E, ov, k = 6.0 + lift, .4, .6
    P = 6.45 + lift  # the flat-topped front
    G = 3.2 + lift  # the garage, the band and the back room
    uw, ue = -.82, 9.68
    d0, d1 = 1.2, 12.9
    main = Roof([(uw - ov, d0), (ue + ov, d0), (ue + ov, d1), (uw - ov, d1)],
                [eave((0, d0), (0, 1), E, k), eave((0, d1), (0, -1), E - k * ov, k),  # noqa: F405
                 eave((uw - ov, 0), (1, 0), E - k * ov, k), eave((ue + ov, 0), (-1, 0), E - k * ov, k)], under="#dedbd4", edge=grey, board=.3)  # noqa: F405
    roofs = [main]
    front = [(uw, 0), (3.82, 0), (3.8, 1.0), (ue - .05, .99), (ue, d0), (uw, d0)]
    head = over(front, P + .06)
    g0 = gy(0, -.3)
    fl = g0 + .15
    fu = fl + 2.95
    foot = [(g0 + .1, "vh_trim", "#3d3f41")]
    win = lambda s, y, w, hh, cols=1: Opening(s, y, w, hh, frame=grey, reveal=.22, cols=cols, sill=False)

    def wall(a, b, ops=(), top=None, mesh="vh_brick", **kw):
        return h.wall(a, b, top if top is not None else top_over(roofs, a, b, also=[head]), ops, mesh=mesh, bands=kw.pop("bands", foot), **kw)  # noqa: F405

    # --- the garage beside the house, dark brick under a flat roof -------------------------------------------------
    garage = [(-3.82, 0), (uw, 0), (uw, 16.63), (-3.81, 16.62)]
    wall((-3.82, 0), (uw, 0), [Opening(1.5, gy(-2.3, -.3) + .02, 2.6, 2.3, "garage", door="#7b7e82", reveal=.2, sill=False)], top=G - .02, mesh="vh_dark")
    wall((-3.81, 16.62), (-3.82, 0), [win(9.0, fl + .9, .9, 1.2)], top=G - .02, mesh="vh_dark")
    wall((uw, 16.63), (-3.81, 16.62), [Opening(1.5, fl, .95, 2.2, "door", door=grey, frame=grey, panels="glazed", reveal=.2, sill=False)], top=G - .02, mesh="vh_dark")
    # --- the front: the dark band with the entrance, white brick over it to the flat top -----------------------------
    door = Opening(2.6, fl, 1.1, 2.4, "door", door=grey, frame=grey, panels="glazed", reveal=.25, sill=False, step=(g0, .25))
    up = [win(1.0, fu + .35, .8, 1.3), win(2.4, fu + .35, .8, 1.3), win(3.85, fu + .35, .8, 1.3)]
    W, N, T = wall((uw, 0), (3.82, 0), [door, win(.85, fl + .2, .5, 2.2)] + up, top=P)
    band = G - .25
    h.wbox(W, N, T, "vh_dark", -.05, door.s - .7, g0 - .05, band, -.05, 0)
    h.wbox(W, N, T, "vh_dark", door.s + .7, 4.7, g0 - .05, band, -.05, 0)
    h.wbox(W, N, T, "vh_dark", door.s - .7, door.s + .7, fl + 2.4, band, -.05, 0)
    h.wbox(W, N, T, "vh_dark", 1.1, 1.3, g0 - .05, band, -.05, 0)  # the pier between the narrow light and the door
    h.box("vh_stone", -3.95, 3.82, -.45, 0, G - .08, G + .06, "#3f4144")  # the canopy over the band and the garage
    wall((3.82, 0), (3.8, 1.0), top=P)
    W, N, T = wall((3.8, 1.0), (ue - .05, .99), [win(2.9, fl, 3.2, 2.3, 3), win(1.4, fu + .35, .8, 1.3), win(3.0, fu + .35, .8, 1.3), win(4.6, fu + .35, .8, 1.3)], top=P)
    for a, b in ((front[0], front[1]), (front[1], front[2]), (front[2], front[3])):
        h.seg("vh_stone", a, b, .3, P, P + .07, coping)
    h.poly("vh_stone", [(u, d, E - .02) for u, d in [(uw + .1, .1), (3.7, .1), (3.7, 1.1), (ue - .1, 1.1), (ue - .1, d0), (uw + .1, d0)]], (0, 0, 1), "#4a4a4a")
    # --- the sides and the back ------------------------------------------------------------------------------------
    wall((ue - .05, .99), (9.68, 11.99), [win(2.6, fl + .9, 1.0, 1.4), win(7.2, fl + .9, 1.0, 1.4), win(2.6, fu + .4, 1.0, 1.4), win(5.0, fu + .4, 1.0, 1.4), win(9.1, fu + .4, 1.0, 1.4)])
    wall((9.68, 11.99), (3.66, 11.89), [win(3.2, fl, 3.8, 2.3, 3), win(1.6, fu + .4, 1.2, 1.4), win(4.5, fu + .4, 1.2, 1.4)])
    h.wall((3.66, 11.89), (3.68, 12.49), top_over(roofs, (3.66, 11.89), (3.68, 12.49)), bottom=G - .1, out=(1, 0))  # noqa: F405
    h.wall((3.68, 12.49), (uw, 12.5), top_over(roofs, (3.68, 12.49), (uw, 12.5)), [win(2.2, fu + .4, 1.2, 1.4)], bottom=G - .1, out=(0, 1))  # noqa: F405
    h.wall((uw, 12.5), (uw, 0), top_over(roofs, (uw, 12.5), (uw, 0), also=[head]), [win(6.0, fu + .4, .8, 1.3)], bottom=G - .1, out=(-1, 0))  # noqa: F405
    back = [(uw, 12.5), (3.68, 12.49), (3.66, 11.89), (3.8, 16.64), (uw, 16.63)]
    wall((3.66, 11.89), (3.8, 16.64), [win(2.4, fl + .9, 1.0, 1.2)], top=G - .02)
    wall((3.8, 16.64), (uw, 16.63), [win(2.3, fl, 2.6, 2.2, 2)], top=G - .02)
    flat_roof(h, garage, G, coping)
    flat_roof(h, [(uw, 12.5), (3.68, 12.49), (3.8, 16.64), (uw, 16.63)], G, coping)
    del back
    draw_roofs(h, roofs)  # noqa: F405
    ye = E - k * ov - .3
    h.gutter((ue + ov, d1, ye), (uw - ov, d1, ye), (0, 1, 0), grey, down=[(9.55, 12.1, gy(9.55, 12.1))])
    h.export()


# ======================================================================================================================
# 20. x 428.6, z -678.9: a detached house of buff brick, two storeys under a hipped roof of dark tiles, the garage in
# its front beside the door, dark frames, a chimney.
def buff_hip():
    h = House("vh_buff_hip", [429.29, -687.75], ([427.9, -670.14], [437.31, -677.6]), 7.381, {
        "vh_brick": {"texture": "nb_brick", "tint": "#c6a77c", "normalScale": .55},
        "vh_roof": {"texture": "roof_tiles", "tint": "#3e4044", "normalScale": .3},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,  # noqa: F405
    })
    # u along the front to the south-east, d from the front (0) back (12.9).
    lift = h.base
    gy = lambda u, d: h.ground(u, d)
    dark, under = "#3a3c3f", "#e2ded6"
    E, ov, k = 5.9 + lift, .5, .62
    uw, ue, D = -6.0, 6.03, 12.94
    Ee = E - k * ov
    main = Roof([(uw - ov, -ov), (ue + ov, -ov), (ue + ov, D + ov), (uw - ov, D + ov)],
                [eave((0, -ov), (0, 1), Ee, k), eave((0, D + ov), (0, -1), Ee, k),  # noqa: F405
                 eave((uw - ov, 0), (1, 0), Ee, k), eave((ue + ov, 0), (-1, 0), Ee, k)], under=under, edge=under, board=.3)  # noqa: F405
    roofs = [main]
    g0 = gy(0, -.3)
    fl = g0 + .2
    fu = fl + 2.85
    foot = [(g0 + .35, "vh_trim", "#5c5955")]
    win = lambda s, y, w, hh, cols=1: Opening(s, y, w, hh, frame=dark, reveal=.18, cols=cols)

    def wall(a, b, ops=()):
        return h.wall(a, b, top_over(roofs, a, b), ops, bands=foot)  # noqa: F405

    # --- the front: the garage, the door under a small canopy, a wide window; three windows over them -------------
    door = Opening(6.9, fl, 1.0, 2.2, "door", door="#5a4536", frame=dark, panels="glazed", reveal=.2, sill=False, step=(g0, .4))
    W, N, T = wall((uw, 0), (6.0, 0), [Opening(3.6, gy(-2.4, -.3) + .02, 2.5, 2.2, "garage", door="#55585c", reveal=.18, sill=False), door,
                                       win(10.0, fl + .8, 2.0, 1.4, 2), win(2.4, fu + .45, 1.5, 1.3, 2), win(6.9, fu + .45, 1.0, 1.3), win(10.0, fu + .45, 1.5, 1.3, 2)])
    h.wbox(W, N, T, "vh_stone", door.s - .75, door.s + .75, fl + 2.35, fl + 2.47, -.7, 0, "#8f8c86")
    # --- the sides and the garden front ---------------------------------------------------------------------------
    wall((6.0, 0), (ue, D), [win(2.6, fl + .8, 1.2, 1.3), win(7.0, fl + .8, 1.2, 1.3), win(10.6, fl + .8, 1.2, 1.3), win(2.6, fu + .45, 1.0, 1.2), win(7.0, fu + .45, 1.0, 1.2)])
    wall((ue, D), (-5.89, 12.77), [Opening(3.0, fl, 2.6, 2.2, "door", door=dark, frame=dark, panels="glazed", reveal=.18, sill=False),
                                   win(7.4, fl + .5, 2.4, 1.7, 3), win(3.0, fu + .45, 1.2, 1.3), win(8.4, fu + .45, 1.2, 1.3)])
    wall((-5.89, 12.77), (uw, 0), [win(2.6, fl + .8, 1.2, 1.3), win(9.6, fl + .8, 1.2, 1.3), win(4.0, fu + .45, 1.0, 1.2), win(9.6, fu + .45, 1.0, 1.2)])
    draw_roofs(h, roofs)  # noqa: F405
    ye = Ee - .3
    zinc = "#8e9295"
    h.gutter((uw - ov, -ov, ye), (ue + ov, -ov, ye), (0, -1, 0), zinc, down=[(uw + .1, -.08, gy(uw, -.08)), (5.9, -.08, gy(5.9, -.08))])
    h.gutter((ue + ov, D + ov, ye), (uw - ov, D + ov, ye), (0, 1, 0), zinc, down=[(5.9, D + .08, gy(5.9, D + .08))])
    h.chimney(-2.0, 7.6, .6, .6, main.height(-2.0, 7.6) - .4, main.height(-2.0, 7.6) + 1.0, "vh_brick", pots=[(0, 0)])
    h.export()


# ======================================================================================================================
# 21. x 399.5, z -651.1: a house of pale grey-buff brick, two storeys under a pitched roof of dark tiles running along
# the street, a steep front gable over its west end, white frames, a chimney on its ridge.
def pale_gable():
    h = House("vh_pale_gable", [389.0, -652.92], ([395.82, -644.52], [400.33, -648.19]), 7.614, {
        "vh_brick": {"texture": "nb_brick", "tint": "#cbc1ae", "normalScale": .55},
        "vh_roof": {"texture": "roof_tiles", "tint": "#3d3f44", "normalScale": .3},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,  # noqa: F405
    })
    # u along the street front to the south-east, d from the front (0) back (10.8).
    lift = h.base
    gy = lambda u, d: h.ground(u, d)
    white, under = "#f1f0eb", "#ebe8e1"
    E, ov, vg, k = 5.75 + lift, .4, .3, .62
    uw, ue, D = -2.9, 11.17, 10.84
    Ee = E - k * ov
    main = Roof([(uw - vg, -.14 - ov), (ue + vg, -.14 - ov), (ue + vg, D + ov), (uw - vg, D + ov)],
                [eave((0, -.14 - ov), (0, 1), Ee, k), eave((0, D + ov), (0, -1), Ee, k)], under=under, edge=white, board=.26)  # noqa: F405
    # The front gable over the west end: steep, its ridge toward the street, running into the main roof.
    kc, cu0, cu1 = 1.25, uw - vg, .9
    cross = Roof([(cu0, -.45), (cu1, -.45), (cu1, 4.5), (cu0, 4.5)],
                 [eave((cu0, 0), (1, 0), E - .35, kc), eave((cu1, 0), (-1, 0), E - .35, kc)], under=under, edge=white, board=.24)  # noqa: F405
    roofs = [main, cross]
    g0 = gy(0, -.3)
    fl = g0 + .25
    fu = fl + 2.8
    foot = [(g0 + .35, "vh_trim", "#6c6862")]
    win = lambda s, y, w, hh, cols=1: Opening(s, y, w, hh, frame=white, reveal=.16, cols=cols)

    def wall(a, b, ops=()):
        return h.wall(a, b, top_over(roofs, a, b), ops, bands=foot)  # noqa: F405

    # --- the street front: under the front gable a window and the door, a window high in the gable; then the long
    # front with its windows, the door's canopy of stone --------------------------------------------------------------
    door = Opening(4.6, fl, 1.0, 2.15, "door", door="#6b4c38", frame=white, panels="glazed", reveal=.18, sill=False, step=(g0, .45))
    W, N, T = wall((uw, 0), (2.91, 0), [win(1.6, fl + .8, 1.4, 1.4, 2), door, win(1.6, fu + .5, 1.2, 1.3, 2), win(4.6, fu + .5, 1.0, 1.3), win(1.6, E + 1.0, .7, .8)])
    h.wbox(W, N, T, "vh_stone", door.s - .7, door.s + .7, fl + 2.3, fl + 2.42, -.6, 0, "#8f8c86")
    wall((2.91, 0), (2.9, -.11))
    wall((2.9, -.11), (5.36, -.14), [win(1.23, fl + .8, 1.0, 1.4), win(1.23, fu + .5, 1.0, 1.3)])
    wall((5.36, -.14), (5.36, .35))
    wall((5.36, .35), (11.14, .34), [win(1.9, fl + .8, 2.0, 1.4, 2), win(4.6, fl + .8, 1.2, 1.4), win(1.9, fu + .5, 1.2, 1.3, 2), win(4.6, fu + .5, 1.2, 1.3, 2)])
    # --- the gable ends and the back ------------------------------------------------------------------------------
    wall((11.14, .34), (ue, D), [win(2.6, fl + .8, 1.0, 1.3), win(8.0, fl + .8, 1.0, 1.3), win(5.4, fu + .5, 1.0, 1.3), win(5.4, E + 1.3, .6, .8)])
    wall((ue, D), (uw, 10.82), [win(2.0, fl, 2.4, 2.2, 2), win(6.4, fl + .6, 2.4, 1.6, 3), win(10.6, fl + .8, 1.2, 1.3), win(2.6, fu + .5, 1.2, 1.3), win(7.0, fu + .5, 1.2, 1.3), win(10.6, fu + .5, 1.2, 1.3)])
    wall((uw, 10.82), (-2.91, 0), [win(4.0, fl + .8, 1.0, 1.3), win(7.8, fu + .5, 1.0, 1.3)])
    draw_roofs(h, roofs)  # noqa: F405
    ye = Ee - .3
    zinc = "#8e9295"
    h.gutter((cu1, -.14 - ov, ye), (ue + vg, -.14 - ov, ye), (0, -1, 0), zinc, down=[(11.0, .15, gy(11.0, .15))])
    h.gutter((ue + vg, D + ov, ye), (uw - vg, D + ov, ye), (0, 1, 0), zinc, down=[(uw + .1, D + .1, gy(uw, D + .1))])
    h.chimney(8.4, 5.0, .55, .55, main.height(8.4, 5.0) - .4, main.height(8.4, 5.0) + .9, "vh_brick", pots=[(0, 0)])
    h.export()


# ======================================================================================================================
# 22. x 376.8, z -590.2: a tall old house of red brick, its gable to the street, two storeys and a steep roof of dark
# tiles with two chimneys on its ridge; a low flat-roofed wing behind.
def red_chimneys():
    h = House("vh_red_chimneys", [382.81, -600.49], ([374.53, -602.35], [382.78, -600.5]), 8.712, {
        "vh_brick": {"texture": "nb_brick", "tint": "#94503b", "normalScale": .6},
        "vh_roof": {"texture": "roof_tiles", "tint": "#404247", "normalScale": .3},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,  # noqa: F405
    })
    # u across the street gable (east at u -4.26), d from the gable (0) back.
    lift = h.base
    gy = lambda u, d: h.ground(u, d)
    white, dark = "#f1f0eb", "#2f3134"
    E, ov, vg, k = 5.0 + lift, .3, .3, 1.15
    uw, ue, DB = -4.26, 4.23, 10.05
    main = Roof([(uw - ov, -vg), (ue + ov, -vg), (ue + ov, DB + .3), (uw - ov, DB + .3)],
                [eave((uw - ov, 0), (1, 0), E - k * ov, k), eave((ue + ov, 0), (-1, 0), E - k * ov, k)], under=white, edge=white, board=.26)  # noqa: F405
    roofs = [main]
    WF = 2.8 + lift
    wing = [(1.48, 10.03), (1.63, 13.98), (-1.11, 13.96), (-1.17, 18.5), (-1.69, 18.56), (-1.6, 20.12), (-4.24, 20.06), (-4.25, DB)]
    g0 = gy(0, -.3)
    fl = g0 + .3
    fu = fl + 2.75
    foot = [(g0 + .45, "vh_trim", "#5d5853")]
    win = lambda s, y, w, hh, cols=1: Opening(s, y, w, hh, frame=white, reveal=.2, cols=cols, lintel="#7a3e2f")

    def wall(a, b, ops=(), **kw):
        return h.wall(a, b, top_over(roofs, a, b), ops, bands=foot, **kw)  # noqa: F405

    # --- the street gable: the door and a wide window, two windows over them, a small one high in the gable ----------
    wall((uw, 0), (ue, 0), [Opening(2.9, fl, 1.0, 2.2, "door", door=dark, frame=white, panels="glazed", reveal=.22, sill=False, step=(g0, .45)),
                            win(5.9, fl + .7, 1.8, 1.5, 2), win(2.6, fu + .45, 1.2, 1.4, 2), win(5.9, fu + .45, 1.2, 1.4, 2), win(4.25, E + 1.5, .6, .9)])
    # --- the long sides, the back gable over the wing ---------------------------------------------------------------
    wall((ue, 0), (ue, 10.1), [win(2.2, fl + .8, 1.1, 1.4), win(6.4, fl + .8, 1.1, 1.4), win(2.2, fu + .45, 1.0, 1.3), win(6.4, fu + .45, 1.0, 1.3)])
    wall((ue, 10.1), (1.48, 10.03), [win(1.4, fu + .45, .9, 1.2)])
    h.wall((1.48, DB), (uw, DB), top_over(roofs, (1.48, DB), (uw, DB)), [win(2.9, fu + .45, .9, 1.2)], bottom=WF - .1, out=(0, 1))  # noqa: F405
    wall((uw, DB), (uw, 0), [win(3.2, fl + .8, 1.1, 1.4), win(7.4, fl + .8, 1.1, 1.4), win(3.2, fu + .45, 1.0, 1.3), win(7.4, fu + .45, 1.0, 1.3)])
    # --- the wing behind: lower, a flat roof --------------------------------------------------------------------
    ww = lambda a, b, ops=(): h.wall(a, b, WF - .02, ops, bands=foot)
    ww((1.48, 10.03), (1.63, 13.98), [win(2.0, fl + .9, 1.0, 1.0)])
    ww((1.63, 13.98), (-1.11, 13.96), [Opening(1.4, fl, .95, 2.1, "door", door=dark, frame=white, panels="glazed", reveal=.18, sill=False)])
    ww((-1.11, 13.96), (-1.17, 18.5), [win(2.3, fl + .9, 1.0, 1.0)])
    ww((-1.17, 18.5), (-1.69, 18.56))
    ww((-1.69, 18.56), (-1.6, 20.12))
    ww((-1.6, 20.12), (-4.24, 20.06), [win(1.3, fl + .9, 1.0, 1.0)])
    ww((-4.24, 20.06), (-4.25, DB), [win(4.0, fl + .9, 1.0, 1.0)])
    flat_roof(h, wing, WF, "#9b968e")
    draw_roofs(h, roofs)  # noqa: F405
    ye = E - k * ov - .28
    zinc = "#8e9295"
    h.gutter((uw - ov, -vg, ye), (uw - ov, DB + .3, ye), (-1, 0, 0), zinc, down=[(uw - .08, .2, gy(uw, .2))])
    h.gutter((ue + ov, -vg, ye), (ue + ov, DB + .3, ye), (1, 0, 0), zinc, down=[(ue + .08, .2, gy(ue, .2))])
    for d in (6.2, 8.9):
        r = main.height(0, d)
        h.chimney(0, d, .55, .7, r - .5, r + 1.1, "vh_brick", pots=[(0, 0)])
    h.export()


HOUSES = {"vh_hip_single": hip_single, "vh_ivy_cottage": ivy_cottage, "vh_white_modern": white_modern,
          "vh_buff_hip": buff_hip, "vh_pale_gable": pale_gable, "vh_red_chimneys": red_chimneys}
for _name, _build in HOUSES.items():
    if not ONLY or _name in ONLY:  # noqa: F405
        _build()
