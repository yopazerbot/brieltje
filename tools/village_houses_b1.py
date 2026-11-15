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
Mesh names follow world/villageHouses.ts: `vh_glass` gets a room behind it (world/glassLook.ts); `vh_roof`, `vh_stone`
(sills, steps, copings, and the flat and low roofs), `vh_paving` and `vh_gravel` take the snow (world/snowCover.ts);
`vh_paving` and `vh_gravel` the wet (world/wetGround.ts); the `_small` meshes are drawn within 120 m. What stands on
the plot and should stop a player (piers, gates, fences, posts) goes into the root's `blocks`, over the ground at
the origin (`blocksOnGround`), for walking into; the server holds the village's own blocks, not these.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from village_houses_kit import *  # noqa: E402,F403  (House, Opening, the materials, Vector, math, ONLY)


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
             down=[(-6.25, -.08, h.ground(-6.25, -.08)), (6.5, -.08, h.ground(6.5, -.08))])
    # The lean-to's corrugated sheets, from under the tiles' eaves to over its own back wall (in vh_stone: they take the snow).
    top = lambda u: 4.41 + (u + 5.31) / 8.74 * .71 - .05  # along the main back wall
    bot = lambda u: 8.07 + (u - 3.46) / 8.65 * .53 + .3  # beyond the lean-to's back wall
    u, w = -5.45, .18
    sheet = "#77736c"
    while u < 3.68 - 1e-6:
        u1 = min(u + w, 3.68)
        um = (u + u1) / 2
        for p, q, lp, lq in ((u, um, 0, .035), (um, u1, .035, 0)):
            h.poly("vh_stone", [(p, top(p), lean(top(p)) + lp), (q, top(q), lean(top(q)) + lq), (q, bot(q), lean(bot(q)) + lq), (p, bot(p), lean(bot(p)) + lp)], (0, 0, 1), sheet)
        u = u1
    h.poly("vh_trim", [(-5.45, top(-5.45), lean(top(-5.45)) - .03), (3.68, top(3.68), lean(top(3.68)) - .03), (3.68, bot(3.68), lean(bot(3.68)) - .03), (-5.45, bot(-5.45), lean(bot(-5.45)) - .03)], (0, 0, -1), "#7a7a76")
    h.poly("vh_stone", [(-5.45, bot(-5.45), lean(bot(-5.45)) - .03), (3.68, bot(3.68), lean(bot(3.68)) - .03), (3.68, bot(3.68), lean(bot(3.68)) + .035), (-5.45, bot(-5.45), lean(bot(-5.45)) + .035)], (0, 1, 0), sheet)
    # The yard: grey concrete pavers from the house to the gate, between this house and the brick one beside it, and on
    # at its far end to the door of the small garage there.
    h.pave([(-6.78, -.02), (6.75, -.02), (6.9, -1.75), (8.62, -2.02), (7.66, -5.16), (6.75, -5.4), (1.4, -5.9), (.85, -5.4), (-7.62, -3.1)])
    # The gate at the yard's mouth: two black piers with flat caps, a double gate of plain flat bars standing open a
    # quarter, into the yard. The piers and the open leaves stop a player; the way between them stays open.
    p1, p2 = Vector((-6.72, 0)), Vector((-7.72, -3.22))
    g = (p2 - p1).normalized()
    c1, c2 = p1 + g * .3, p2 - g * .3
    for c in (c1, c2):
        gy = h.ground(c.x, c.y)
        h.box("vh_trim", c.x - .225, c.x + .225, c.y - .225, c.y + .225, gy - .1, gy + 1.52, "#1c1c1c")
        h.box("vh_trim", c.x - .26, c.x + .26, c.y - .26, c.y + .26, gy + 1.52, gy + 1.6, "#1c1c1c")
        h.block("nb_dark", [(c.x - .225, c.y - .225), (c.x + .225, c.y - .225), (c.x + .225, c.y + .225), (c.x - .225, c.y + .225)], gy - .1, gy + 1.6)
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
        for k in range(1, 10):  # plain uprights, a hand apart, through the middle rail
            s = leaf * k / 10
            bar(s, .08, s, 1.25, .02)
        end = hinge + dirv * leaf
        h.seg_block("steel", tuple(hinge), tuple(end), .08, gy - .1, gy + 1.3)
    h.export()


# ======================================================================================================================
# 02. x -143.6, z -1092.0: a two-storey brick house of the 1930s, clipped gables, its side to the junction clad in black.
def gable_house():
    h = House("vh_gable_house", [-145.35, -1101.26], ([-142.85, -1084.6], [-136.42, -1089.34]), -3.09, {
        "vh_brick": {"texture": "nb_brick", "tint": "#6c483c", "normalScale": .55},  # in the range of facadeLook.ts SHADES
        # The game's vertical slats, drawn four times as wide (a rib every quarter metre), tinted from the wood's
        # brown to a neutral black.
        "vh_clad": {"texture": "cladding", "tint": "#3b4a64", "stretch": (4, 1), "normalScale": .8},
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
    h.poly("vh_stone", [(u, d, wing - .02) for u, d in ((-.5, 12.0), (3.86, 12.0), (3.86, 14.87), (-.5, 14.95))], (0, 0, 1), "#3a3a3a")  # takes the snow
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
    h.gutter((-vg, -ov, ef - .2), (vg, -ov, ef - .2), (0, -1, 0), "#6e6f6c", down=[(-3.85, -.08, h.ground(-3.85, -.08))])
    h.gutter((-vg, D + ov, eb - .2), (vg, D + ov, eb - .2), (0, 1, 0), "#6e6f6c", down=[(-3.85, 12.1, h.ground(-3.85, 12.1))])
    h.chimney(-1.6, 7.3, .55, .75, main(7.3) - .3, R + .9, "vh_brick", pots=[(0, 0)])
    # A small tiled canopy over the door on two timber brackets.
    cy, cu0, cu1 = 2.55, -1.25, .35
    h.roof([(cu0, -.25, cy), (cu1, -.25, cy), (cu1, .47, cy + .32), (cu0, .47, cy + .32)], free=(0, 1, 3), edge="#5a3a30", board=.12, thick=.08, under="#6d4b3e")
    for u in (cu0 + .12, cu1 - .12):
        h.box("vh_frames_small", u - .04, u + .04, -.15, .47, cy - .5, cy - .02, "#5b4634")
    # The front garden: a path of pavers from the door to the pavement, one brick pier beside it.
    h.pave([(-.98, -.02), (.08, -.02), (.08, -7.48), (-.98, -7.48)])  # to the street's paving
    py = h.ground(.4, -6.6)
    h.box("vh_brick", .2, .6, -6.8, -6.4, py - .1, py + 1.1)
    h.box("vh_stone", .16, .64, -6.84, -6.36, py + 1.1, py + 1.18, "#a19d95")
    h.block("nb_red", [(.2, -6.8), (.6, -6.8), (.6, -6.4), (.2, -6.4)], py - .1, py + 1.18)
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
    # The data's lean-to roof at the back reaches past the wall block: its middle lies just outside it, so it goes too.
    h.replace_roof([-44.01, -1080.43])
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
    h.poly("vh_stone", [(u, d, annex - .02) for u, d in ring], (0, 0, 1), "#3a3a3a")  # takes the snow
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
    h.gutter((-3.25 - ov, -.25, yn - .22), (-3.25 - ov, 4.43, yn - .22), (-1, 0, 0), white, down=[(-3.32, .3, h.ground(-3.32, .3))])
    h.gutter((3.25 + ov, -.25, yn - .22), (3.25 + ov, 4.43, yn - .22), (1, 0, 0), white, down=[(3.32, .3, h.ground(3.32, .3))])
    h.gutter((-5.13 - ov, 4.05, yw - .22), (-5.13 - ov, 13.22, yw - .22), (-1, 0, 0), white)
    h.gutter((5.13 + ov, 4.05, yw - .22), (5.13 + ov, 13.22, yw - .22), (1, 0, 0), white, down=[(5.21, 12.6, h.ground(5.21, 12.6))])
    h.box("vh_trim", 4.95, 5.07, 4.38, 4.5, h.ground(5, 4.44) - .1, wide(5.0) - .1, white)  # a slim post at the porch's corner
    h.block("steel", [(4.95, 4.38), (5.07, 4.38), (5.07, 4.5), (4.95, 4.5)], h.ground(5, 4.44) - .1, wide(5.0) - .1)
    h.chimney(-2.0, 10.4, .6, .6, wide(2.0) - .4, R + .7, "vh_brick", pots=[(-.14, 0), (.14, 0)])
    # The front garden: lawn, three low clipped shrubs, a drive of grey pavers to the side, a path to the door.
    for u, d in ((-2.6, -1.4), (2.6, -1.4), (4.6, -.9)):
        h.blob("vh_hedge", u, d, h.ground(u, d) + .25, (.45, .4, .38))
    # Both run to the street's paving, whose edge lies askew to the house (measured in the game).
    h.pave([(-7.75, 9.5), (-5.25, 9.5), (-5.25, -11.94), (-7.75, -11.16)])
    h.pave([(3.3, 6.75), (4.6, 6.75), (4.6, -15.04), (3.3, -14.61)])
    h.export()


# ======================================================================================================================
# 04. x 39.7, z -1050.1: a long white rendered bungalow of the 1960s under a low hipped roof, a covered corner.
def white_bungalow():
    h = House("vh_white_bungalow", [42.9, -1047.67], ([39.62, -1061.58], [46.82, -1057.85]), -2.91, {
        "vh_render": {"texture": "plaster", "tint": "#ebe7df", "normalScale": .35},
        "vh_roof": {"texture": "roof_tiles", "tint": "#52352b", "normalScale": .3},
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
    foot = [(max(.3, floor), "vh_trim", "#77756f")]
    plane = lambda u, d: min(ye + k * (u - (uL - ov)), ye + k * ((uR_ + ov) - u), ye + k * (d - (d0 - ov)), ye + k * ((d1 + ov) - d))
    M = "vh_render"
    slide = lambda s: Opening(s, floor, 3.0, 2.1, frame=frame, cols=2, sill=False, reveal=.14)
    win = lambda s, w=1.6, hh=1.3: Opening(s, floor + .8, w, hh, frame=frame, cols=2 if w > 1 else 1, reveal=.14)
    # The end on the street and the long side seen on arriving: a sliding window each side of their corner.
    h.wall((4.05, 0), (-4.05, 0), plane(0, 0) - .06, [slide(1.8), win(6.0)], mesh=M, bands=foot)
    # On the same side, at the far end, the garage: a grey door set back in the wall under a lintel, the drive to it.
    gg = h.ground(4.6, 17.75)
    Ws, Ns, Ts = h.wall((4.05, 20.14), (4.05, 0), plane(4.05, 10) - .06,
                        [slide(20.14 - 2.05), win(20.14 - 8.0), win(20.14 - 12.2),
                         Opening(20.14 - 17.75, gg + .02, 2.5, 2.1, "garage", door="#a3a5a2", reveal=.22, sill=False, lintel="#8f8d88"),
                         Opening(20.14 - 14.6, 2.2, .3, .15, "vent", reveal=.06, sill=False)], mesh=M, bands=foot)
    lamp = lambda W, N, T, s, y: (h.wbox(W, N, T, "vh_metal_small", s - .07, s + .07, y, y + .22, -.12, 0, "#2f3134"),
                                  h.wbox(W, N, T, "vh_metal_small", s - .055, s + .055, y + .03, y + .17, -.125, -.12, "#d8d4c8"))
    lamp(Ws, Ns, Ts, 20.14 - 15.95, 2.0)
    # The other long side: the door under the roof's covered corner.
    gy = h.ground(-4.6, 6.2)
    dcorner = (plane(-4.05, 5) - ye) / k - ov  # where the end's slope reaches the side's
    Wd, Nd, Td = h.wall((-4.05, 0), (-4.05, 10.75), [(0, plane(-4.05, 0) - .06), (dcorner, plane(-4.05, 5) - .06), (10.75, plane(-4.05, 5) - .06)],
           [win(2.5), Opening(6.2, floor, 1.0, 2.1, "door", door="#d9d8d2", frame=frame, panels="glazed", step=(gy, .45), reveal=.14),
            Opening(7.15, floor + .1, .4, 1.9, frame=frame, sill=False, reveal=.14), win(9.4, .6, .6)], mesh=M, bands=foot)
    h.wall((-4.05, 10.75), (-5.26, 10.84), [(0, plane(-4.05, 10) - .06), (1.21, plane(-5.26, 10) - .06)], mesh=M, bands=foot)
    lamp(Wd, Nd, Td, 5.45, 2.05)  # a wall lamp beside the door
    h.wall((-5.26, 10.84), (-5.15, 20.12), plane(-5.2, 15) - .06,
           [win(2.4), win(6.8, .6, .6), Opening(8.2, 2.2, .3, .15, "vent", reveal=.06, sill=False)], mesh=M, bands=foot)
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
        pipes = {(0, -1, 0): [(4.12, .12)], (0, 1, 0): [(4.12, 20.06), (-5.22, 20.06)]}.get(out, [])
        h.gutter((*a, ye - .3), (*b, ye - .3), out, white, down=[(u, d, h.ground(u, d)) for u, d in pipes])
    h.chimney(uc, 13.0, .5, .7, R - .6, R + .85, "vh_render", cap="#c9c7c0")
    for d in (.15, 5.4):  # slim white posts under the covered corner
        h.box("vh_trim", -5.2, -5.08, d - .06, d + .06, h.ground(-5.14, d) - .1, plane(-5.14, d) - .14, white)
        h.block("steel", [(-5.2, d - .06), (-5.08, d - .06), (-5.08, d + .06), (-5.2, d + .06)], h.ground(-5.14, d) - .1, plane(-5.14, d) - .14)
    # The way in: pavers under the covered corner and down to the street's paving (its edge measured in the game).
    h.pave([(-4.03, 10.72), (-5.32, 10.72), (-5.32, -.3), (-5.42, -5.02), (-4.42, -5.02), (-4.42, -.02), (-4.03, -.02)])
    # The drive: grey pavers from the street's paving to the garage, between the house and the hedge.
    h.pave([(4.45, 19.1), (7.35, 19.1), (7.35, -5.12), (4.45, -5.12)])
    # A fence of horizontal timber slats beyond the drive, from the far corner to the hedge: the back garden behind it.
    fy = h.ground(5.6, 20.45)
    for i in range(6):
        y = fy + .12 + i * .19
        h.box("vh_frames_small", 4.12, 7.15, 20.41, 20.49, y, y + .15, "#8a6a4c")
    for u in (4.2, 5.65, 7.1):
        h.box("vh_frames_small", u - .045, u + .045, 20.38, 20.52, h.ground(u, 20.45) - .1, fy + 1.25, "#6f553e")
    h.block("old_wood", [(4.12, 20.38), (7.15, 20.38), (7.15, 20.52), (4.12, 20.52)], fy - .1, fy + 1.25)
    h.export()


HOUSES = {"vh_farm": farm, "vh_gable_house": gable_house, "vh_arch_villa": arch_villa, "vh_white_bungalow": white_bungalow}
for _name, _build in HOUSES.items():
    if not ONLY or _name in ONLY:
        _build()
