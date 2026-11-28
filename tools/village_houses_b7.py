"""Hand-made houses among the generated ones, package B7: six houses on the long street from the football ground
toward the villa in farmhouse style.

  blender -b -P tools/village_houses_b7.py -- web/public/models [vh_round_villa vh_chapel_house ...]

writes web/public/models/<name>.glb for each house, or for the ones named, with the toolkit of the earlier packages
(tools/village_houses_kit.py; see tools/village_houses_b1.py for the names of the meshes and what the game does with
each). A house is named by its spot in the model's metres, never by an address. Its kind, colours and main openings
were compared with street-level pictures by eye; nothing was copied, traced or sampled from them, and nothing
personal is modelled (no number, name, text, sign, letterbox, car or window dressing). Where the pictures show no
side, the side is a plain one of the same house. These blocks are long: the walls follow the whole outline of the
data's block, and the parts behind the house get plain flat or low roofs at the heights the data gives them.
"""
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from village_houses_kit import *  # noqa: E402,F403  (Snapped, Opening, Roof, the details, the materials, ONLY)

House = Snapped  # noqa: F405  (the walls' ends drawn onto the outline's corners: village_houses_kit.py)
WHITE = "#f1f0eb"


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
        if math.dist(a, b) > .02:  # noqa: F405
            h.seg("vh_stone", a, b, .28, y, y + .07, coping)


def op(s, y, w, hh, mun=None, box=False, **kw):
    """An Opening, and what dresses it: glazing bars (rows, cols) and a roller shutter's box."""
    o = Opening(s, y, w, hh, **kw)  # noqa: F405
    o.mun, o.box = mun, box
    return o


def at(p, y, w, hh, **kw):
    """An opening on the outline's edge nearest the plan point p, centred there (w None: the edge's length less a frame)."""
    return (p, lambda s, L: op(s, y, w if w else L - .08, hh, **kw))


def dress(h, W, N, T, ops):
    for o in ops:
        if getattr(o, "mun", None):
            muntins(h, W, N, T, o, *o.mun)  # noqa: F405
        if getattr(o, "box", False):
            shutter_box(h, W, N, T, o)  # noqa: F405


def nearest_edge(ring, p):
    best = None
    for i, a in enumerate(ring):
        b = ring[(i + 1) % len(ring)]
        ab = Vector((b[0] - a[0], b[1] - a[1]))  # noqa: F405
        L = ab.length
        if L < 1e-6:
            continue
        t = max(0, min(1, ((p[0] - a[0]) * ab.x + (p[1] - a[1]) * ab.y) / (L * L)))
        dist = math.dist(p, (a[0] + ab.x * t, a[1] + ab.y * t))  # noqa: F405
        if best is None or dist < best[0]:
            best = (dist, i, t * L, L)
    return best[1:]


def shell(h, roofs, flats, ops, bands, mesh="vh_brick", edge_bands=()):
    """The outer walls along the whole outline, each up to the highest roof over it (pitched or flat), with the
    openings `ops` (from `at`) on the edges nearest their points. edge_bands: (point, bands) for the edge nearest it."""
    also = [over(r, y) for r, y in flats]
    ring = h.ring
    per = defaultdict(list)
    for p, make in ops:
        i, s, L = nearest_edge(ring, p)
        per[i].append(make(s, L))
    special = {nearest_edge(ring, p)[0]: b for p, b in edge_bands}
    walls = {}
    for i, a in enumerate(ring):
        b = ring[(i + 1) % len(ring)]
        if math.dist(a, b) < 1e-3:  # noqa: F405
            continue
        W, N, T = h.wall(a, b, top_over(roofs, a, b, also=also), per[i], mesh=mesh, bands=special.get(i, bands))  # noqa: F405
        dress(h, W, N, T, per[i])
        walls[i] = (W, N, T)
    return walls, also


def where(R, u, y, d0, step=.02):
    """How far up a roof's slope (d from d0) its height reaches y at u."""
    d = d0
    while R.height(u, d) < y and d < d0 + 30:
        d += step
    return d


def gable_dormer(h, roofs, main, uc, dfa, w, de, dg, frame, mesh="vh_brick", under="#e8e6e0", edge="#ecebe6"):
    """A pointed dormer on the main roof's front slope (the front toward -d): its window, its own small gable roof
    and its cheeks down to the tiles."""
    dk = (dg - de) / (w / 2 + .15)
    dback = where(main, uc, dg + .15, dfa)
    dorm = Roof([(uc - w / 2 - .15, dfa - .25), (uc + w / 2 + .15, dfa - .25), (uc + w / 2 + .15, dback), (uc - w / 2 - .15, dback)],  # noqa: F405
                [eave((uc - w / 2 - .15, 0), (1, 0), de, dk), eave((uc + w / 2 + .15, 0), (-1, 0), de, dk)],  # noqa: F405
                under=under, edge=edge, board=.16, thick=.1)
    roofs.append(dorm)
    sill = main.height(uc, dfa)
    o = op(w / 2, sill + .15, w - .45, de - sill - .3, frame=frame, reveal=.14, cols=2, sill=False, mun=(2, 2))
    Wd, Nd, Td = h.wall((uc + w / 2, dfa), (uc - w / 2, dfa), [(0, de - .05), (w / 2, dg - .05), (w, de - .05)], [o],
                        mesh=mesh, bottom=sill - .3, out=(0, -1))
    dress(h, Wd, Nd, Td, [o])
    for su in (uc - w / 2, uc + w / 2):
        dc = where(main, su, de, dfa)
        if dc - dfa > .05:
            h.wall((su, dfa), (su, dc), de - .05, bottom=[(0, main.height(su, dfa) - .2), (dc - dfa, de - .2)], mesh=mesh,
                   out=(1 if su > uc else -1, 0))


def flat_dormer(h, main, u0, u1, dfa, yt, ops, mesh, edge="#2f3134", top="#3b3d40"):
    """A long dormer with a flat roof on the main roof's front slope: its front wall with `ops`, cheeks, the flat top."""
    sill = main.height((u0 + u1) / 2, dfa)
    W, N, T = h.wall((u1, dfa), (u0, dfa), yt, ops, mesh=mesh, bottom=sill - .3, out=(0, -1))
    dress(h, W, N, T, ops)
    dc = where(main, u0, yt, dfa)
    for su in (u0, u1):
        h.wall((su, dfa), (su, dc), yt, bottom=[(0, main.height(su, dfa) - .2), (dc - dfa, yt - .2)], mesh=mesh,
               out=(1 if su > u0 else -1, 0))
    h.poly("vh_stone", [(u0 - .12, dfa - .15, yt + .1), (u1 + .12, dfa - .15, yt + .1), (u1 + .12, dc + .1, yt + .1), (u0 - .12, dc + .1, yt + .1)], (0, 0, 1), top)
    h.box("vh_trim", u0 - .12, u1 + .12, dfa - .2, dfa - .12, yt - .14, yt + .12, edge)
    for su, sg in ((u0 - .12, -1), (u1 + .12, 1)):
        h.box("vh_trim", su - (.08 if sg > 0 else 0), su + (0 if sg > 0 else .08), dfa - .2, dc + .1, yt - .14, yt + .12, edge)


def hip(F, E, k, ov):
    """The four eave planes of a hipped roof over the plan rectangle F (u0, d0, u1, d1), its eaves ov out at height E."""
    u0, d0, u1, d1 = F
    y = E - k * ov
    return Roof([(u0 - ov, d0 - ov), (u1 + ov, d0 - ov), (u1 + ov, d1 + ov), (u0 - ov, d1 + ov)],  # noqa: F405
                [eave((u0 - ov, 0), (1, 0), y, k), eave((u1 + ov, 0), (-1, 0), y, k), eave((0, d0 - ov), (0, 1), y, k), eave((0, d1 + ov), (0, -1), y, k)])  # noqa: F405


MATS = {"vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL}  # noqa: F405


# ======================================================================================================================
# 24. x 126.0, z -1048.2: a villa of the 1930s in red brick, two storeys under a steep hipped roof of dark slate-grey
# tiles; its left part comes forward under a gable with white boards, the door in the middle under a flat canopy, the
# right corner rounded with curved windows on both floors; small-paned white windows, a grey stone foot, a low flat-
# roofed wing beside it and the lower parts behind; a path of stones across the lawn.
def round_villa():
    h = House("vh_round_villa", [119.86, -1054.34], ([120.73, -1045.02], [126.35, -1042.25]), -2.66, {
        "vh_brick": {"texture": "nb_brick", "tint": "#8a4634", "normalScale": .6},
        "vh_roof": {"texture": "roof_tiles", "tint": "#3d4045", "normalScale": .3},
        "vh_paving": {"texture": "pavers", "tint": "#9c9a94"},
        **MATS})
    # u along the front (the left wing at u -8, the rounded corner at u +4.8), d from the middle part's front (0) back.
    gy = h.ground
    g0 = gy(0, -.3)
    fl, E, k, ov = g0 + .45, g0 + 6.3, 1.3, .45
    fu = fl + 2.9
    WF = g0 + 3.3
    # The main roof: hipped, its right front corner turned round the rounded wall in facets.
    cu, cd, R = 3.13, 1.69, 1.69 + ov
    y0 = E - k * ov
    arc = [(cu + R * math.cos(math.radians(a)), cd + R * math.sin(math.radians(a))) for a in range(-90, 1, 15)]  # noqa: F405
    planes = [eave((-8.43 - ov, 0), (1, 0), y0, k), eave((4.82 + ov, 0), (-1, 0), y0, k),  # noqa: F405
              eave((0, -ov), (0, 1), y0, k), eave((0, 7.84 + ov), (0, -1), y0, k)]  # noqa: F405
    for a in range(-90, 0, 15):
        m = math.radians(a + 7.5)  # noqa: F405
        rc = R * math.cos(math.radians(7.5))  # noqa: F405
        planes.append(eave((cu + rc * math.cos(m), cd + rc * math.sin(m)), (-math.cos(m), -math.sin(m)), y0, k))  # noqa: F405
    main = Roof([(-8.43 - ov, -ov)] + arc + [(4.82 + ov, 7.84 + ov), (-8.43 - ov, 7.84 + ov)], planes, under=WHITE, edge=WHITE, board=.22)  # noqa: F405
    # The left wing's gable to the street.
    kw, ow = 1.4, .35
    wing = Roof([(-8.02 - ow, -1.15 - ow), (-3.13 + ow, -1.15 - ow), (-3.13 + ow, 4.0), (-8.02 - ow, 4.0)],  # noqa: F405
                [eave((-8.02 - ow, 0), (1, 0), E - kw * ow, kw), eave((-3.13 + ow, 0), (-1, 0), E - kw * ow, kw)], under=WHITE, edge=WHITE, board=.3)  # noqa: F405
    roofs = [main, wing]
    back = [(-8.43, 7.84), (4.82, 7.84), (4.82, 4.11), (8.81, 4.26), (8.88, 11.63), (6.95, 11.69), (4.29, 13.56), (4.31, 14.21),
            (-4.04, 14.33), (-4.13, 10.57), (-8.04, 10.56), (-8.03, 7.98), (-8.43, 7.97)]
    flats = [(back, WF)]
    foot = [(fl - .05, "vh_stone", "#8d8a84")]
    W_ = dict(frame=WHITE, reveal=.16)
    ops = [
        # the wing's gable: a wide window under small panes, two small-paned ones over it, a small one in the gable
        at((-5.575, -1.15), fl + .7, 1.9, 1.6, cols=3, transom=.7, **W_), at((-5.575, -1.15), fu + .45, 1.3, 1.35, cols=2, mun=(3, 2), **W_),
        at((-5.575, -1.15), E + 1.2, .5, .7, mun=(2, 1), **W_), at((-5.575, -1.15), g0 + .1, .45, .25, kind="vent", sill=False),
        # the middle: the door with its steps, a tall narrow window over the canopy, two small-paned windows
        at((-1.75, 0), fl, 1.05, 2.3, kind="door", door=WHITE, panels="glazed", sill=False, step=(g0, .7), **W_),
        at((-1.75, 0), fu + .1, .7, 1.6, mun=(4, 1), **W_),
        at((1.5, 0), fl + .7, 1.3, 1.6, cols=2, mun=(3, 2), **W_), at((1.5, 0), fu + .45, 1.2, 1.35, cols=2, mun=(3, 2), **W_),
        at((1.5, 0), g0 + .1, .45, .25, kind="vent", sill=False),
        # the sides and the back, plain
        at((-8.02, 1.1), fl + .7, .9, 1.5, mun=(3, 2), **W_), at((-8.02, 1.1), fu + .45, .9, 1.3, mun=(3, 2), **W_),
        at((-8.42, 5.7), fl + .7, .9, 1.5, mun=(3, 2), **W_), at((-8.42, 5.7), fu + .45, .9, 1.3, mun=(3, 2), **W_),
        at((4.82, 2.9), fl + .7, .8, 1.5, mun=(3, 2), **W_), at((4.82, 2.9), fu + .45, .8, 1.3, mun=(3, 2), **W_),
        at((6.8, 4.2), fl + .75, 1.8, 1.3, cols=2, **W_), at((8.85, 8.0), fl + .75, 1.6, 1.3, cols=2, **W_),
        at((0.0, 14.27), fl + .75, 1.6, 1.3, cols=2, **W_), at((-6.1, 10.56), fl + .75, 1.2, 1.3, **W_),
        at((-4.08, 12.4), fl, .95, 2.15, kind="door", door="#e8e6e0", panels="glazed", sill=False, **W_),
    ]
    # the rounded corner: a window in every facet on both floors, the frames between them reading as one curved window
    corner = [(3.13, 0), (3.57, .05), (3.98, .22), (4.33, .48), (4.60, .84), (4.77, 1.24), (4.82, 1.69)]
    for p, q in zip(corner, corner[1:]):
        mid = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
        ops += [at(mid, fl + .7, None, 1.6, **W_), at(mid, fu + .45, None, 1.35, **W_)]
    walls, also = shell(h, roofs, flats, ops, foot)
    # The main walls over the flat roofs behind and beside them.
    for a, b, o in (((4.82, 4.11), (4.82, 7.84), (1, 0)), ((4.82, 7.84), (-8.43, 7.84), (0, 1))):
        ups = [op(3.0, fu + .45, 1.0, 1.3, frame=WHITE, mun=(3, 2)), op(8.5, fu + .45, 1.0, 1.3, frame=WHITE, mun=(3, 2))] if o == (0, 1) else []
        W, N, T = h.wall(a, b, top_over(roofs, a, b), ups, bottom=WF - .1, out=o)  # noqa: F405
        dress(h, W, N, T, ups)
    draw_roofs(h, roofs)  # noqa: F405
    flat_roof(h, back, WF, WHITE, "#3a3a3a")
    # The canopy over the door: a thin slab of white concrete.
    W, N, T = walls[nearest_edge(h.ring, (-1.75, 0))[0]]
    s = nearest_edge(h.ring, (-1.75, 0))[1]
    h.wbox(W, N, T, "vh_stone", s - .85, s + .85, fl + 2.5, fl + 2.64, -1.0, 0, "#e9e7e1")
    # Gutters, a chimney near the ridge.
    zinc = "#8e9295"
    ye = y0 - .24
    h.gutter((-8.43 - ov, 7.84 + ov, ye), (4.82 + ov, 7.84 + ov, ye), (0, 1, 0), zinc, down=[(-8.36, 7.9, gy(-8.36, 7.9))])
    h.gutter((-3.13 + ow, -ov, ye), (3.13, -ov, ye), (0, -1, 0), zinc, down=[(-2.9, .07, gy(-2.9, .07))])
    r = main.height(-4.6, 5.2)
    h.chimney(-4.6, 5.2, .6, .75, r - .6, E + k * 3.92 + .7, "vh_brick", pots=[(0, 0)])
    # A path of stones from the steps to the street.
    for i in range(5):
        d = -1.35 - i * .8
        h.pave([(-2.15, d), (-1.35, d), (-1.35, d - .55), (-2.15, d - .55)], lift=.04)
    h.export()


# ======================================================================================================================
# 25. x 143.2, z -994.2: a house of pale brick, a storey and a half under a dark roof with two pointed dormers, set back
# behind its paved yard; by the street beside the yard a small wayside chapel of warm brick with a steep gable, a dark
# arched door and a small iron cross on top.
def chapel_house():
    h = House("vh_chapel_house", [148.72, -1001.57], ([141.32, -1006.08], [149.3, -1003.47]), -1.93, {
        "vh_brick": {"texture": "nb_brick", "tint": "#d6cab2", "normalScale": .5},
        "vh_chapel": {"texture": "nb_brick", "tint": "#b4805e", "normalScale": .6},
        "vh_roof": {"texture": "roof_tiles", "tint": "#3a3c40", "normalScale": .3},
        **MATS})
    h.replace_roof([143.33, -984.87])  # the lean-to over its back part, which reaches past the outline
    # u along the front (the chapel's side at u -6), d from the front (0) back.
    gy = h.ground
    g0 = gy(0, -.3)
    fl, E, k, ov = g0 + .15, g0 + 3.5, .82, .4
    dark = "#4a3a2e"
    WF = g0 + 3.0
    # The main roof: eaves to the street and the back, gables at both ends.
    main = Roof([(-4.26 - .3, -ov), (4.2 + .3, -ov), (3.99 + .3, 11.4 + ov), (-4.26 - .3, 11.4 + ov)],  # noqa: F405
                [eave((0, -ov), (0, 1), E - k * ov, k), eave((0, 11.4 + ov), (0, -1), E - k * ov, k)], under="#e3ddd0", edge=dark, board=.22)  # noqa: F405
    roofs = [main]
    back = [(-4.25, 11.4), (3.99, 11.4), (3.84, 19.67), (-0.62, 19.60), (-0.60, 16.81), (-4.21, 16.81)]
    W_ = dict(frame=dark, reveal=.16)
    ops = [at((-2.68, 0), fl + .75, 1.8, 1.45, cols=2, **W_), at((.68, 0), fl, 1.0, 2.2, kind="door", door=dark, panels="glazed", sill=False, step=(g0, .4), **W_),
           at((2.65, 0), fl + .75, 1.3, 1.45, cols=2, **W_),
           at((-4.24, 6.0), fl + .8, 1.0, 1.3, **W_), at((-4.24, 6.0), E + 1.0, .7, .9, **W_), at((4.1, 4.6), fl + .8, 1.0, 1.3, **W_),
           at((4.1, 4.6), E + 1.0, .7, .9, **W_), at((4.0, 9.5), fl + .8, 1.0, 1.3, **W_),
           at((3.9, 16.5), fl + .8, 1.0, 1.2, **W_), at((1.6, 19.63), fl + .8, 1.6, 1.2, cols=2, **W_), at((-2.4, 16.81), fl + .8, 1.2, 1.2, **W_),
           at((-4.23, 14.5), fl, .95, 2.1, kind="door", door=dark, sill=False, **W_)]
    for uc in (-2.1, 2.0):
        gable_dormer(h, roofs, main, uc, .95, 1.4, E + 1.75, E + 2.75, dark, edge=dark, under="#e3ddd0")
    shell(h, roofs, [(back, WF)], ops, [(g0 + .3, "vh_trim", "#7d776c")])
    W, N, T = h.wall((3.99, 11.4), (-4.25, 11.4), top_over(roofs, (3.99, 11.4), (-4.25, 11.4)), bottom=WF - .1, out=(0, 1))  # noqa: F405
    draw_roofs(h, roofs)  # noqa: F405
    flat_roof(h, back, WF, "#9c978e")
    zinc = "#7c7f80"
    ye = E - k * ov - .22
    h.gutter((-4.56, -ov, ye), (4.5, -ov, ye), (0, -1, 0), zinc, down=[(-4.12, -.08, gy(-4.12, -.08)), (4.12, -.08, gy(4.12, -.08))])
    r = main.height(-3.2, 5.7)
    h.chimney(-3.2, 5.7, .5, .6, r - .5, r + 1.0, "vh_brick", pots=[(0, 0)])
    # --- the chapel by the street: a small house of brick, its gable with the door to the street ---------------------
    cu0, cu1, cd0, cd1 = -7.5, -5.1, -4.7, -1.7
    gc = min(gy(u, d) for u in (cu0, cu1) for d in (cd0, cd1))
    Ec, kc = gc + 2.4, 1.6
    croof = Roof([(cu0 - .2, cd0 - .25), (cu1 + .2, cd0 - .25), (cu1 + .2, cd1 + .2), (cu0 - .2, cd1 + .2)],  # noqa: F405
                 [eave((cu0 - .2, 0), (1, 0), Ec - kc * .2, kc), eave((cu1 + .2, 0), (-1, 0), Ec - kc * .2, kc)], under="#d8d2c6", edge="#3a3c40", board=.18)  # noqa: F405
    cr = [croof]
    plinth = [(gc + .35, "vh_stone", "#8c8881")]
    door = Opening((cu1 - cu0) / 2, gc + .2, .9, 1.95, "leaf", arch=True, reveal=.22, sill=False, step=(gc - .05, .45))  # noqa: F405
    W, N, T = h.wall((cu1, cd0), (cu0, cd0), top_over(cr, (cu1, cd0), (cu0, cd0)), [door], mesh="vh_chapel", bands=plinth, bottom=gc - .4, out=(0, -1))  # noqa: F405
    s0, s1 = door.s - door.w / 2, door.s + door.w / 2
    h.wbox(W, N, T, "vh_trim", s0, s1, door.y, door.y + door.h, door.reveal - .06, door.reveal, "#2c2622")
    for x in (s0 + .3, s1 - .3):
        h.wbox(W, N, T, "vh_frames_small", x - .015, x + .015, door.y + .05, door.y + door.h - .05, door.reveal - .07, door.reveal - .06, "#1f1b18")
    seg_arch(h, W, N, T, s0 - .05, s1 + .05, door.y + door.h - door.w / 2, door.w / 2 + .05, .2, "vh_stone", "#c9c2b4", steps=8)  # noqa: F405
    sides = (((cu0, cd0), (cu0, cd1), (-1, 0)), ((cu0, cd1), (cu1, cd1), (0, 1)), ((cu1, cd1), (cu1, cd0), (1, 0)))
    for a, b, o in sides:
        h.wall(a, b, top_over(cr, a, b), mesh="vh_chapel", bands=plinth, bottom=gc - .4, out=o)  # noqa: F405
    draw_roofs(h, cr)  # noqa: F405
    # a small cross of black iron on the front gable's top
    cx, ct = (cu0 + cu1) / 2, croof.height((cu0 + cu1) / 2, cd0 - .2)
    h.box("vh_metal_small", cx - .03, cx + .03, cd0 - .2, cd0 - .14, ct, ct + .75, "#1d1d1c")
    h.box("vh_metal_small", cx - .2, cx + .2, cd0 - .2, cd0 - .14, ct + .45, ct + .51, "#1d1d1c")
    h.block("nb_brown", [(cu0, cd0), (cu1, cd0), (cu1, cd1), (cu0, cd1)], gc - .1, ct)
    h.export()


# ======================================================================================================================
# 26. x 200.5, z -959.4: a red brick house, its steep gable to the street rising through a dark roof whose eaves run low
# on both sides; its ground floor clad in grey stone with a wide window and a white door; two windows in the gable;
# flat-roofed rooms behind it and a two-storey back house with a flat roof.
def front_gable():
    h = House("vh_front_gable", [195.11, -958.75], ([202.56, -982.59], [208.96, -980.33]), -1.13, {
        "vh_brick": {"texture": "nb_brick", "tint": "#9a4a35", "normalScale": .6},
        "vh_roof": {"texture": "roof_tiles", "tint": "#34373c", "normalScale": .3},
        "vh_clad": {"tint": "#9a9790", "rough": .85},
        **MATS})
    # The white house's two roofs behind touch this outline at the party wall, and a lean-to of the house beyond pokes
    # a corner into it: all three go with it.
    for first in ([192.53, -950.5], [187.23, -962.11], [210.76, -951.98]):
        h.replace_roof(first)
    # u along the front (toward the white house at u +3.4, the party wall), d from the front (0) back.
    gy = h.ground
    g0 = gy(0, -.3)
    fl, E, k, ov = g0 + .2, g0 + 3.9, 1.2, .35
    fu = fl + 2.75
    dark = "#2f3134"
    main = Roof([(-3.92 - .3, -ov), (3.42, -ov), (3.09, 8.97 + ov), (-3.92 - .3, 8.97 + ov)],  # noqa: F405
                [eave((0, -ov), (0, 1), E - k * ov, k), eave((0, 8.97 + ov), (0, -1), E - k * ov, k)], under=WHITE, edge=dark, board=.22)  # noqa: F405
    kg, og, gu0, gu1 = 1.75, .35, -2.6, 2.05
    gable = Roof([(gu0 - og, -.45), (gu1 + og, -.45), (gu1 + og, 4.5), (gu0 - og, 4.5)],  # noqa: F405
                 [eave((gu0 - og, 0), (1, 0), E - kg * og, kg), eave((gu1 + og, 0), (-1, 0), E - kg * og, kg)], under=WHITE, edge=WHITE, board=.26)  # noqa: F405
    roofs = [main, gable]
    mid = [(-3.92, 8.97), (3.06, 8.97), (2.64, 20.57), (-1.779, 20.805), (-1.5685, 9.2771), (-3.92, 9.28)]
    link = [(-1.779, 20.805), (2.64, 20.57), (2.48, 24.96), (-0.31, 24.97), (-0.3584, 20.7763)]
    rear = [(2.48, 24.96), (2.30, 29.87), (2.17, 33.60), (1.71, 45.92), (-6.11, 46.16), (-6.25, 41.53), (-6.64, 29.79), (-6.80, 25.12), (-6.46, 25.0), (-0.31, 24.97)]
    YM, YL, YR = g0 + 3.2, g0 + 3.0, g0 + 5.45
    flats = [(mid, YM), (link, YL), (rear, YR)]
    W_ = dict(frame=WHITE, reveal=.18)
    clad = [(g0 + .3, "vh_trim", "#55524e"), (fl + 2.5, "vh_clad", None)]
    ops = [at((-2.1, 0), fl + .7, 2.0, 1.55, cols=3, **W_), at((1.0, 0), fl, 1.0, 2.25, kind="door", door=WHITE, panels="glazed", sill=False, step=(g0, .35), **W_),
           at((2.35, 0), fl + .1, .45, 2.1, **W_),
           at((-1.25, 0), fu + .45, 1.0, 1.3, cols=2, **W_), at((.55, 0), fu + .45, 1.0, 1.3, cols=2, **W_), at((-.27, 0), E + 2.0, .5, .6, **W_),
           at((-3.92, 4.8), fl + .8, 1.0, 1.3, **W_), at((-3.92, 7.6), fl + .8, 1.0, 1.3, **W_),
           at((-1.7, 14.5), fl + .8, 1.0, 1.2, **W_), at((-1.7, 18.0), fl + .8, 1.0, 1.2, **W_),
           at((-2.6, 25.0), fl, .95, 2.15, kind="door", door=dark, panels="glazed", sill=False, **W_),
           at((-4.6, 25.0), fl + .8, 1.2, 1.2, **W_), at((-4.6, 25.0), fl + 3.0, 1.2, 1.1, **W_)]
    for d in (30.0, 35.0, 40.0):
        ops += [at((-6.5, d), fl + .8, 1.1, 1.2, **W_), at((-6.5, d), fl + 3.0, 1.1, 1.1, **W_)]
    for u in (-0.8, -4.2):
        ops += [at((u, 46.0), fl + .8, 1.5, 1.2, cols=2, **W_), at((u, 46.0), fl + 3.0, 1.5, 1.1, cols=2, **W_)]
    walls, also = shell(h, roofs, flats, ops, [(g0 + .3, "vh_trim", "#55524e")], edge_bands=[((0, 0), clad)])
    # The walls over the lower flat roofs: the house's back, the middle's back, the back house's front over the link.
    for a, b, o, y in (((3.06, 8.97), (-3.92, 8.97), (0, 1), YM), ((-1.779, 20.805), (2.64, 20.57), (0, 1), YL),
                       ((-0.31, 24.97), (2.48, 24.96), (0, -1), YL)):
        h.wall(a, b, top_over(roofs, a, b, also=also), bottom=y - .1, out=o)  # noqa: F405
    draw_roofs(h, roofs)  # noqa: F405
    for ring, y in flats:
        flat_roof(h, ring, y, "#8f8a82")
    zinc = "#8e9295"
    ye = E - k * ov - .24
    h.gutter((-4.22, -ov, ye), (gu0 - og, -ov, ye), (0, -1, 0), zinc, down=[(-3.85, -.07, gy(-3.85, -.07))])
    h.gutter((gu1 + og, -ov, ye), (3.39, -ov, ye), (0, -1, 0), zinc, down=[(3.3, -.07, gy(3.3, -.07))])
    r = main.height(-3.0, 4.48)
    h.chimney(-3.0, 4.6, .5, .6, r - .5, r + 1.1, "vh_brick", pots=[(0, 0)])
    h.export()


# ======================================================================================================================
# 27. x 193.2, z -969.5: a white rendered house beside the red one, its long dark roof low over the ground floor and a
# band of dormer windows across it; flat-roofed rooms behind and a low barn at the back under a pitched roof.
def white_dormer():
    # Found by a corner at its side: its front corner is a corner of the street's paving too.
    h = House("vh_white_dormer", [191.86, -976.47], ([194.48, -985.31], [202.54, -982.6]), -1.14, {
        "vh_render": {"texture": "plaster", "tint": "#efede7", "normalScale": .5},
        "vh_brick": {"texture": "nb_brick", "tint": "#cfc6b8", "normalScale": .5},
        "vh_roof": {"texture": "roof_tiles", "tint": "#3f4146", "normalScale": .3},
        **MATS})
    # The red house's roof touches this outline at the party wall, and a lean-to over the strip behind reaches past it.
    for first in ([202.56, -982.59], [187.23, -962.11]):
        h.replace_roof(first)
    # u along the front (the red house's party wall at u -4.3), d from the front (0) back.
    gy = h.ground
    g0 = gy(0, -.3)
    fl, E, k, ov = g0 + .15, g0 + 3.5, 1.02, .3
    dark = "#2f3134"
    main = Roof([(-4.27, -ov), (4.38 + .3, -ov), (4.31 + .3, 9.23 + ov), (-4.47, 9.23 + ov)],  # noqa: F405
                [eave((0, -ov), (0, 1), E - k * ov, k), eave((0, 9.23 + ov), (0, -1), E - k * ov, k)], under=WHITE, edge=dark, board=.22)  # noqa: F405
    YB = g0 + 2.86
    barn = Roof([(-5.02, 24.35), (5.12 + .3, 24.35), (5.12 + .3, 33.9), (-5.02, 33.9)],  # noqa: F405
                [eave((0, 24.35), (0, 1), YB - .75 * .3, .75), eave((0, 33.9), (0, -1), YB - .75 * .3, .75)], under="#d8d2c6", edge="#3a3c40", board=.2)  # noqa: F405
    roofs = [main, barn]
    A = [(-4.47, 9.23), (4.31, 9.23), (3.92, 9.21), (3.98, 12.75), (-0.77, 12.88), (-4.6, 12.9)]
    B = [(-4.6, 12.88), (-0.77, 12.88), (-0.88, 24.67), (-4.81, 24.67)]
    YA, YBf = g0 + 3.17, g0 + 2.7
    flats = [(A, YA), (B, YBf)]
    W_ = dict(frame=WHITE, reveal=.16)
    ops = [at((-2.6, 0), fl + .6, 1.9, 1.6, cols=2, **W_), at((.4, 0), fl, 1.0, 2.2, kind="door", door=dark, frame=dark, panels="glazed", sill=False, reveal=.16, step=(g0, .35)),
           at((2.7, 0), fl + .8, 1.4, 1.4, cols=2, **W_),
           at((4.35, 4.6), fl + .8, 1.0, 1.3, **W_), at((4.35, 4.6), E + .6, .8, 1.0, **W_), at((3.95, 11.0), fl + .8, .9, 1.2, **W_),
           at((1.6, 12.8), fl + .8, 1.4, 1.2, cols=2, **W_), at((-0.8, 16.0), fl + .8, 1.0, 1.2, **W_), at((-0.85, 21.0), fl, .95, 2.1, kind="door", door=dark, frame=dark, sill=False),
           at((2.6, 24.65), fl, 2.6, 2.2, kind="garage", door="#5e5b56", sill=False), at((5.08, 29.0), fl + .8, 1.0, 1.0, **W_),
           at((0.0, 33.4), fl + .8, 1.4, 1.0, cols=2, **W_)]
    shell(h, roofs, flats, ops, [(g0 + .3, "vh_trim", "#5c5a56")], mesh="vh_render")
    also = [over(r, y) for r, y in flats]
    for a, b, o, y in (((4.31, 9.23), (-4.47, 9.23), (0, 1), YA), ((-0.77, 12.88), (-4.6, 12.88), (0, 1), YBf),
                       ((-4.81, 24.67), (-0.88, 24.67), (0, -1), YBf)):
        h.wall(a, b, top_over(roofs, a, b, also=also), mesh="vh_render", bottom=y - .1, out=o)  # noqa: F405
    # The dormer band: four windows in two pairs under a flat roof with a dark edge.
    yt = g0 + 6.3
    flat_dormer(h, main, -3.6, 3.4, 1.25, yt, [op(1.6, main.height(0, 1.25) + .35, 1.9, 1.15, cols=2, frame=WHITE, reveal=.14, sill=False),
                                               op(5.4, main.height(0, 1.25) + .35, 1.9, 1.15, cols=2, frame=WHITE, reveal=.14, sill=False)], "vh_render")
    draw_roofs(h, roofs)  # noqa: F405
    for ring, y in flats:
        flat_roof(h, ring, y, "#a19c94")
    zinc = "#8e9295"
    ye = E - k * ov - .24
    h.gutter((-4.27, -ov, ye), (4.68, -ov, ye), (0, -1, 0), zinc, down=[(4.28, -.07, gy(4.28, -.07))])
    h.export()


# ======================================================================================================================
# 28. x 246.1, z -919.5: a low bungalow of buff brick under a hipped roof of brown tiles with deep eaves and a chimney,
# its door in a porch set into the front; a flat-roofed garage at its side; a low brick wall along the street with a
# border of white-flowered shrubs behind it, and a path to the door.
def buff_bungalow():
    h = House("vh_buff_bungalow", [251.19, -917.7], ([253.56, -919.63], [245.67, -929.35]), .32, {
        "vh_brick": {"texture": "nb_brick", "tint": "#c9ab84", "normalScale": .55},
        "vh_roof": {"texture": "roof_tiles", "tint": "#6b4a3a", "normalScale": .35},
        "vh_paving": {"texture": "pavers", "tint": "#a8a49c"},
        "vh_flowers_small": {"tint": "#ffffff", "rough": .9},
        **MATS})
    # u along the front (the garage at u -5, the far end at u +6.3), d from the front (0) back.
    gy = h.ground
    g0 = gy(0, -.3)
    fl, E, k, ov = g0 + .15, g0 + 3.2, .63, .5
    frame, dark = "#5a4a3e", "#3a3c3f"
    main = hip((-3.6, 0, 6.26, 18.56), E, k, ov)
    main.under, main.edge, main.board = "#e3ddd0", "#5a4a3e", .2
    roofs = [main]
    garage = [(-3.6, 0), (-3.6, 10.11), (-6.27, 10.06), (-6.27, 8.98), (-6.26, 3.06), (-6.26, 0)]
    WG = g0 + 2.9
    W_ = dict(frame=frame, reveal=.16)
    ops = [at((-2.45, 0), fl + .6, 1.7, 1.75, cols=2, **W_),
           at((0, .74), fl, 1.0, 2.15, kind="door", door=dark, frame=WHITE, panels="glazed", sill=False, reveal=.12, surround="#e8e5dd"),
           at((3.8, 0), fl + .6, 3.0, 1.75, cols=3, **W_),
           at((-4.93, 0), gy(-4.93, -.3) + .02, 2.3, 2.1, kind="garage", door="#e5e2da", sill=False),
           at((6.26, 4.6), fl + .8, 1.2, 1.4, cols=2, **W_), at((6.26, 10.9), fl + .8, 1.0, 1.4, **W_), at((6.26, 16.0), fl + .8, 1.2, 1.4, cols=2, **W_),
           at((4.6, 18.56), fl + .8, 1.8, 1.4, cols=2, **W_), at((1.1, 18.55), fl, 2.4, 2.15, cols=3, sill=False, **W_),
           at((-3.6, 15.0), fl + .8, 1.0, 1.4, **W_), at((-6.27, 6.0), fl + .9, 1.0, 1.0, **W_)]
    shell(h, roofs, [(garage, WG)], ops, [(g0 + .25, "vh_trim", "#8a7a66")])
    draw_roofs(h, roofs)  # noqa: F405
    flat_roof(h, garage, WG, "#a49a8c")
    zinc = "#7c6a5a"
    ye = E - k * ov - .22
    h.gutter((-3.6 - ov, -ov, ye), (6.26 + ov, -ov, ye), (0, -1, 0), zinc, down=[(6.2, -.06, gy(6.2, -.06))])
    h.gutter((6.26 + ov, -ov, ye), (6.26 + ov, 18.56 + ov, ye), (1, 0, 0), zinc, down=[(6.32, 18.4, gy(6.32, 18.4))])
    r = main.height(1.33, 9.28)
    h.chimney(1.33, 9.28, .55, .6, r - .5, r + .9, "vh_brick", pots=[(0, 0)])
    # The low wall along the street, a gap for the path; the shrubs behind it; the path to the porch.
    dw = -5.0
    for u0, u1 in ((-3.3, -.6), (.6, 7.0)):
        y = min(gy(u0, dw), gy(u1, dw))
        h.seg("vh_brick", (u0, dw), (u1, dw), .24, y - .3, y + .55)
        h.seg("vh_stone", (u0 - .02, dw), (u1 + .02, dw), .3, y + .55, y + .62, "#b8b2a6")
        h.seg_block("nb_brown", (u0, dw), (u1, dw), .24, y - .1, y + .62)
    for u in [-2.9 + .62 * i for i in range(17)]:
        if -.9 < u < .9:
            continue
        y = gy(u, -4.55)
        h.blob("vh_flowers_small", u, -4.55, y + .25, (.36, .3, .3), color="#4d6a3b")
        h.blob("vh_flowers_small", u + .05, -4.6, y + .5, (.26, .22, .16), color="#eae8dc")
    h.pave([(-.6, -5.0), (.6, -5.0), (.6, .72), (-.6, .72)], lift=.04)
    h.export()


# ======================================================================================================================
# 29. x 276.6, z -875.3: a two-storey house of warm brick, its steep gable to the street, a brown door in a stone
# surround and a wide window under two windows with roller shutters; a flat-roofed garage wing with a brown door beside
# it, and flat-roofed rooms behind.
def garage_gable():
    # Found by the one corner no other block shares (its back corner is a corner of the house behind too).
    h = House("vh_garage_gable", [284.9, -877.29], ([278.71, -885.16], [284.52, -877.93]), .96, {
        "vh_brick": {"texture": "nb_brick", "tint": "#a5714c", "normalScale": .6},
        "vh_roof": {"texture": "roof_tiles", "tint": "#33363b", "normalScale": .3},
        **MATS})
    # u along the front (the garage wing at u -3, the house at u -0.9 to 4.6), d from the front (0) back.
    gy = h.ground
    g0 = gy(1.9, -.3)
    fl, E, k, ov = g0 + .2, g0 + 5.8, 1.35, .3
    fu = fl + 2.85
    frame, brown = "#3a302b", "#5b3524"
    main = Roof([(-0.86 - ov, -ov), (4.64 + ov, -ov), (4.64 + ov, 10.34 + ov), (-0.86 - ov, 10.34 + ov)],  # noqa: F405
                [eave((-0.86 - ov, 0), (1, 0), E - k * ov, k), eave((4.64 + ov, 0), (-1, 0), E - k * ov, k)], under="#dcd6cc", edge="#2c2e31", board=.26)  # noqa: F405
    roofs = [main]
    wing = [(-0.86, 0), (-0.86, 10.34), (-1.09, 10.34), (-1.116, 10.512), (-5.30, 10.398), (-5.3745, 0.1047), (-5.37, 0)]
    rear = [(-1.09, 10.34), (4.64, 10.34), (4.48, 20.845), (-1.087, 20.829), (-1.116, 10.512)]
    YW, YR = g0 + 4.0, g0 + 3.8
    flats = [(wing, YW), (rear, YR)]
    W_ = dict(frame=frame, reveal=.18)
    ops = [at((-2.9, 0), gy(-2.9, -.3) + .02, 2.6, 2.2, kind="garage", door="#6a3a26", sill=False),
           at((.95, 0), fl, 1.0, 2.25, kind="door", door=brown, panels="plank", sill=False, surround="#c9c3b6", step=(g0, .35), **W_),
           at((3.15, 0), fl + .75, 2.0, 1.45, cols=2, **W_),
           at((.95, 0), fu + .4, 1.1, 1.3, box=True, **W_), at((3.15, 0), fu + .4, 1.2, 1.3, box=True, **W_), at((1.89, 0), E + 1.3, .5, .7, **W_),
           at((4.64, 3.0), fl + .8, 1.0, 1.3, **W_), at((4.64, 3.0), fu + .4, 1.0, 1.3, box=True, **W_), at((4.62, 7.5), fl + .8, 1.0, 1.3, **W_),
           at((4.62, 7.5), fu + .4, 1.0, 1.3, box=True, **W_), at((4.55, 14.0), fl + .8, 1.2, 1.2, **W_), at((4.5, 18.5), fl + .8, 1.2, 1.2, **W_),
           at((2.9, 20.84), fl + .8, 1.6, 1.2, cols=2, **W_), at((-1.1, 16.0), fl, .95, 2.1, kind="door", door=brown, sill=False, **W_),
           at((-5.35, 5.5), fl + .9, 1.0, 1.0, **W_), at((-3.2, 10.4), fl + .9, 1.4, 1.0, cols=2, **W_)]
    walls, also = shell(h, roofs, flats, ops, [(g0 + .3, "vh_trim", "#4e4740")])
    # The house's walls over the wing and the rooms behind: its side and its back gable.
    for a, b, o, y in (((-0.86, 0), (-0.86, 10.34), (-1, 0), YW), ((4.64, 10.34), (-0.86, 10.34), (0, 1), YR)):
        ups = [op(5.0 if o == (-1, 0) else 2.75, fu + .4, .9, 1.2, frame=frame, box=True)]
        W, N, T = h.wall(a, b, top_over(roofs, a, b, also=also), ups, bottom=y - .1, out=o)  # noqa: F405
        dress(h, W, N, T, ups)
    draw_roofs(h, roofs)  # noqa: F405
    for ring, y in flats:
        flat_roof(h, ring, y, "#9a958c")
    zinc = "#8e9295"
    ye = E - k * ov - .26
    h.gutter((4.64 + ov, -ov, ye), (4.64 + ov, 10.34 + ov, ye), (1, 0, 0), zinc, down=[(4.7, .1, gy(4.7, .1))])
    h.export()


HOUSES = {"vh_round_villa": round_villa, "vh_chapel_house": chapel_house, "vh_front_gable": front_gable,
          "vh_white_dormer": white_dormer, "vh_buff_bungalow": buff_bungalow, "vh_garage_gable": garage_gable}
for _name, _build in HOUSES.items():
    if not ONLY or _name in ONLY:  # noqa: F405
        _build()
