"""Molenhoek past the junction where the map used to end, along the branch to its end at Oordegemkouter: the survey,
and the plans tools/molenhoek.py builds on, in three parts along the street (blender ... -- out.glb molenhoek_end1,
and 2 and 3), so each is drawn only near the eye.

Run from the project root (needs source/geo/ from tools/geodata.py, the strip `w` among it):
    tools/.venv/Scripts/python.exe tools/molenhoek_end_survey.py

Sources, used for measuring only (nothing of them is shipped):
- GRB Wegsegment (the branch's centre line), ADP (the plots) and GBG (the buildings), Digitaal Vlaanderen, open data;
- web/src/data/village.json (tools/neighbours.py): each house's blocks, from the GRB outline and the laser scan's
  heights, so the model stands on the same plan as the blocks it replaces, which stay for walking into;
- a Street View tour from the street (31 Oct 2026), house by house: the newest images are of August 2026 from about
  120 m past the junction to about 640 m (the rebuilt street, its red cycle lanes and kerbs, which tools/molenhoek.py
  draws along the whole branch), of 2009 nearer the junction and on the last stretch. What each house looks like is described
  below. Two houses are blurred in Street View at their owners' request and keep the village's blocks; so do a
  workshop, a feed mill's silos and a farm, the houses hidden behind others or far back from the road, and the house
  on the straight branch (its address is on another street);
- photos taken from the street (Nov 2026) of the new terrace near the junction with Oordegemkouter, which Street View
  shows only as the houses that stood there in 2009 (see `_terrace`).
The houses are keyed by where they stand: b and the metres along the branch from the junction (past the end of its
centre line, along its last direction), l or r as seen walking away from it; never by number. Each front runs from its left end as seen from the street (`order` "view"):
a negative s counts from its right end.

Writes data/molenhoek_end1.json, 2 and 3 (from the junction to 230 m, to 480 m and to the end), in the form of
data/kapellenhoek.json.
"""
import json
import math
from pathlib import Path

from shapely.affinity import affine_transform
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import linemerge, unary_union

from kapellenhoek_survey import BOX, HEDGE, HEDGE_DARK
from molenhoek_survey import ANTH, BLACK, BROWN, ROOF_DARK, ROOF_ORANGE, ROOF_SLATE, WALLS, WHITE, Relief, plan
from neighbours import features, model_frame, polygons

ROOT = Path(__file__).resolve().parents[1]
STEP, REACH = 2.0, 14.0
JUNCTION = (891.5, -693.2)  # where the branch leaves the main line (model x, z)
PARTS = [(0.0, 230.0), (230.0, 480.0), (480.0, 1000.0)]  # metres along the branch
TILES, RED_ROOF, BROWN_ROOF, PANTILE = "#7a3b2f", "#8c4a36", "#5a3e30", "#b9603f"
SHOP_GREEN, GREEN_SH = "#3f6b4a", "#2f4a3a"


def _terrace():
    """The new terrace near the junction with Oordegemkouter, five houses from the older house they lean against to
    the neighbour's garden: two storeys under flat roofs with a thin dark coping, all on one floor level, in two
    bricks laid in large blocks. A pair in dark chocolate-brown brick with a band of light beige brick across the
    middle, from the ground floor's lintels to the first floor's sills, between the outer edges of their doors; a pair
    the other way round; the end house in the light brick with a dark band from its free corner to its garage. Soldier
    courses of the light brick over every opening, pale stone sills, anthracite frames, aluminium doors with three
    frosted panes and a long bar handle, a letterbox and a bell plate by each door. Measured on photos taken from the
    street (Nov 2026, for reference only): the heights on the end house seen square on, the widths along the pairs
    through the perspective of the photos taken at an angle, scaled by the GRB's fronts. `rect`: the GRB outline,
    its front first (the end house stands past the end of Molenhoek's centre line, which runs out in front of the
    row: its front isn't the edge facing the street's last point)."""
    dark, light = "#7e7368", "#eae0c8"  # as the game lights them (blue sky in the shade): dark chocolate brown and light beige
    on_dark, on_light = "#f2eada", "#ccc2a9"  # the soldier courses
    sill, door, garage, box = "#c2c2bc", ANTH, "#3b3f43", "#2e3033"
    head, band, first, top = 2.16, (2.37, 3.77), 3.84, 5.98  # door and window heads, the band, the first floor's windows, the wall's top
    common = dict(depth=0, eaves=top, ridge=top, roof="flat", roof_tint="#3a3c3f", wall="brick", frame=ANTH, coping="#3d4043",
                  coping_h=0.07, plain=True, level="terrace")
    win = lambda s, w=1.0, cu=False: [s, w, 0.92, round(head - 0.92, 2), "w", dict(n=1, sill=sill, cu=cu)]
    up = lambda s, w=1.0, cu=False: [s, w, first, 1.24, "w", dict(n=1, sill=sill, cu=cu)]
    fdoor = lambda s, hand: [s, 0.98, 0.0, head, "d", dict(c=door, frost=3, hand=hand)]

    def pair_house(rect, at, tint, other, soldiers, door_end, cols, cu, letterbox):
        """One of a pair: its door at the pair's outer end, `cols` the door's and the windows' middles counted from
        that end; the band from the door's outer edge to the party wall."""
        k = 1 if door_end == "l" else -1
        s = lambda v: k * v
        edge = cols[0] - 0.49
        return dict(common, rect=rect, at=at, tint=tint, soldiers=soldiers,
                    patches=[(edge, None, *band, other)] if k == 1 else [(0.0, -edge, *band, other)],
                    front=[fdoor(s(cols[0]), door_end), win(s(cols[1])), win(s(cols[2]))] + [up(s(c), cu=cu) for c in cols],
                    fixtures=[(s(letterbox[0]), 0.9, letterbox[1], 0.42, 0.13, letterbox[2]), (s(1.22), 1.25, 0.08, 0.2, 0.015, "#a7abad")])

    cols = (1.94, 3.655, 5.465)  # the door's column and the windows', from the door's end of the house
    return {
        "b683l_row": pair_house([(1475.75, -367.78), (1483.0, -365.97), (1480.13, -354.37), (1473.74, -355.95)], (1478.7, -361.4),
                                light, dark, on_light, "r", (2.0, 3.87, 5.67), True, (0.8, 0.3, "#5e5f5e")),
        "b690l_row": pair_house([(1483.0, -365.97), (1489.64, -364.31), (1486.78, -352.72), (1480.13, -354.37)], (1484.9, -359.3),
                                light, dark, on_light, "l", cols, True, (0.8, 0.3, "#5e5f5e")),
        "b697l_row": pair_house([(1489.64, -364.31), (1496.3, -362.64), (1493.43, -351.06), (1486.78, -352.72)], (1491.5, -357.7),
                                dark, light, on_dark, "r", cols, True, (0.62, 0.34, box)),
        "b704l_row": pair_house([(1496.3, -362.64), (1502.92, -360.99), (1500.07, -349.37), (1493.43, -351.06)], (1498.2, -356.0),
                                dark, light, on_dark, "l", cols, False, (0.62, 0.34, box)),
        "b712l_row_end": dict(  # the end house: a small window at its free corner, the door with a side light, the garage
            common, rect=[(1502.92, -360.99), (1510.69, -359.06), (1508.66, -351.09), (1503.89, -348.43), (1500.07, -349.37)],
            at=(1506.0, -355.0), tint=light, soldiers=on_light, patches=[(0.0, 7.47, *band, dark)],
            front=[[0.515, 0.87, 1.49, round(head - 1.49, 2), "w", dict(n=1, sill=sill)],
                   [2.15, 1.47, 0.0, head, "d", dict(c=door, frost=3, side=(0.43, "r"), hand="r")],
                   [6.16, 2.56, 0.0, head, "g", dict(c=garage, sections=4)],
                   up(0.55, 0.9), up(4.955, cu=True), up(6.96, cu=True)],
            fixtures=[(3.03, 1.3, 0.05, 0.16, 0.015, "#1f2022")]),
    }


TERRACE = _terrace()

HOUSES = {
    "b043l_pair": dict(  # a pair under one roof: light grey-beige brick, dark red-brown tiles, two white gabled dormers, an arched door
        at=(916.69, -647.8), depth=9.0, eaves=3.2, ridge=8.4, roof="gable", roof_tint=TILES, wall="brick", tint="#b3a796", frame=WHITE,
        front=dict(ground=["w", "ad"], door=BROWN, sh=0.2), dormers=[dict(s=2.2, w=1.5, h=1.3, gable=True, clad="#f1efe9")],
        chimneys=[dict(s=-0.8, d=4.5, w=0.6, h=1.0)], hedges=[(0.3, 4.1, 3.0, 0.6, BOX)]),
    "b051l_red": dict(  # red brick, two storeys under red pantiles, a white glazed door
        at=(926.16, -650.11), depth=9.0, eaves=5.8, ridge=9.6, roof="gable", roof_tint="#9c4f38", wall="brick", tint="#a9573f", frame=WHITE,
        front=dict(ground=["d", "W"], first=["w", "w"], door=WHITE, cu=True)),
    "b059r_long": dict(  # long, 1.5 storeys: light brown brick, orange-brown pantiles, a gabled dormer in the middle, an arched door
        at=(951.31, -677.61), depth=9.0, eaves=3.2, ridge=8.0, roof="gable", roof_tint="#8a5a3c", wall="brick", tint="#9c8572", frame=WHITE,
        front=dict(ground=["g", "w", "w", "ad", "w", "w"], garage="#3a3330", door=BROWN), dormers=[dict(s=8.8, w=1.6, h=1.4, gable=True)],
        chimneys=[dict(s=-3.0, d=4.5, w=0.7, h=1.2)], hedges=[(0.5, 17.0, 3.0, 0.5, BOX)]),
    "b078r_modern": dict(  # newer: light grey render over a dark base, a steep dark roof, black frames
        at=(973.47, -671.63), depth=9.0, eaves=5.6, ridge=10.2, roof="gable", roof_tint="#3a3c3f", wall="render", tint="#d4d2cc",
        plinth=(0.6, "#4a4a4c"), frame=BLACK, front=dict(ground=["W", "d"], first=["W", "w"], door=BLACK), roof_windows=[(4.0, 1.2)]),
    "b088l_bungalow": dict(  # behind a meadow: a red brick bungalow, a dark grey roof, a chimney at one end
        at=(947.85, -630.43), depth=9.0, eaves=3.0, ridge=6.8, roof="gable", roof_tint="#45474b", wall="brick", tint="#a65a45", frame=WHITE,
        front=dict(ground=["w", "W", "d", "W", "w"], door=BROWN), chimneys=[dict(s=1.5, d=4.0, w=0.7, h=1.2)]),
    "b100r_dormers": dict(  # 1.5 storeys of brown-red brick, brown-red tiles, two gabled dormers, an arched garage door; a tall hedge
        at=(996.87, -657.91), depth=9.0, eaves=3.2, ridge=8.6, roof="gable", roof_tint="#7a4636", wall="brick", tint="#9a6a55", frame=WHITE,
        front=dict(ground=["g", "ad", "w"], garage="#5a3e2c", door=BROWN),
        dormers=[dict(s=4.0, w=1.5, h=1.3, gable=True), dict(s=-4.0, w=1.5, h=1.3, gable=True)],
        chimneys=[dict(s=6.0, d=4.5, w=0.7, h=1.3)], hedges=[(0.3, 10.0, 3.0, 1.4, HEDGE_DARK)]),
    "b123l_cottage": dict(  # small, white render under red tiles, red shutters and door
        at=(986.19, -610.77), depth=8.0, eaves=3.2, ridge=7.2, roof="gable", roof_tint="#a3503a", wall="render", tint="#efede7", frame=WHITE,
        shutters="#8e2a26", front=dict(ground=["w", "d", "w"], door="#8e2a26")),
    "b130l_beige": dict(  # beige brick, two storeys, a dark roof, white frames and roller shutters; box hedges
        at=(993.9, -610.62), depth=9.0, eaves=6.0, ridge=9.6, roof="gable", roof_tint="#3e4043", wall="brick", tint="#c7ad86", frame=WHITE,
        front=dict(ground=["W", "d"], first=["w", "w"], door=WHITE, sh=0.3), chimneys=[dict(s=-1.0, d=4.5, w=0.6, h=1.1)],
        hedges=[(0.5, 6.0, 2.0, 0.6, BOX)]),
    "b137l_gable": dict(  # brown-beige brick with a steep pointed gable to the street, an arched door
        at=(1001.22, -607.43), depth=9.0, eaves=5.6, ridge=10.0, roof="front_gable", roof_tint="#5a4a42", wall="brick", tint="#9b7b62", frame=WHITE,
        front=dict(ground=["W", "ad"], first=["w", "w"], door=BROWN)),
    "b134r_dormer": dict(  # red brick, 1.5 storeys under anthracite tiles, a big dark gabled dormer, anthracite frames
        at=(1016.32, -634.27), depth=9.0, eaves=3.4, ridge=8.6, roof="gable", roof_tint="#36383b", wall="brick", tint="#b5543f", frame=ANTH,
        front=dict(ground=["W", "d"], door=ANTH), dormers=[dict(s=3.0, w=2.4, h=1.9, gable=True, clad="#2f3134")]),
    "b136r_taupe": dict(  # taupe brick, two storeys, a dark roof, white frames
        at=(1024.01, -631.95), depth=9.0, eaves=6.0, ridge=9.6, roof="gable", roof_tint="#3e4043", wall="brick", tint="#8f7a66", frame=WHITE,
        front=dict(ground=["W", "d"], first=["w", "w", "w"], door=WHITE)),
    "b178r_ochre": dict(  # yellow-ochre brick, two storeys on the pavement, a white fascia, a white glazed door
        at=(1045.46, -603.35), depth=9.0, eaves=6.0, ridge=9.0, roof="gable", roof_tint="#3a3c3f", wall="brick", tint="#c49a52", frame=WHITE,
        eave_board=0.3, front=dict(ground=["d", "W"], first=["w", "W"], door=WHITE, cu=True)),
    "b179l_long": dict(  # long and low: white render, a dark grey roof with roof windows, a cream garage door at one end
        at=(1032.26, -582.66), depth=9.0, eaves=3.0, ridge=7.6, roof="gable", roof_tint="#4a4b4d", wall="render", tint="#ecebe5",
        plinth=(0.5, "#3e3f40"), frame=ANTH, front=dict(ground=["g", "w", "n", "w", "w", "w"], garage="#e8dfc8", door=ANTH),
        roof_windows=[(4.0, 1.2), (9.0, 1.2)], chimneys=[dict(s=5.0, d=4.0, w=0.6, h=1.0), dict(s=-3.0, d=4.0, w=0.6, h=1.0)]),
    "b207r_cream": dict(  # cream render, two storeys, a dark roof, brown frames
        at=(1067.15, -591.86), depth=9.0, eaves=6.0, ridge=10.0, roof="gable", roof_tint="#2f3134", wall="render", tint="#e3ddcf",
        plinth=(0.5, "#5a5a58"), frame=BROWN, front=dict(ground=["w", "d"], first=["w", "w"], door=BROWN)),
    "b234r_modern": dict(  # newer bungalow: light grey brick under steep dark roofs, big windows in anthracite
        at=(1085.4, -569.16), depth=9.0, eaves=3.0, ridge=7.8, roof="gable", roof_tint="#3e4043", wall="brick", tint="#b8b5b0", frame=ANTH,
        front=dict(ground=["W", "d", "n"], door=ANTH)),
    "b237r_chalet": dict(  # red-brown brick with a steep gable to the street; a white post-and-rail fence
        at=(1097.36, -566.39), depth=9.0, eaves=2.8, ridge=9.0, roof="front_gable", roof_tint="#3e4043", wall="brick", tint="#9c4a36", frame=WHITE,
        front=[(2.0, 1.4, 0.8, 1.4, "w", {}), (-2.0, 1.0, 0.0, 2.2, "d", dict(c=WHITE)), (4.0, 1.2, 3.6, 1.2, "w", {})], fence=dict(h=0.9, c="#eeede9")),
    "b252l_solar": dict(  # behind a meadow: red brick, a steep dark roof with solar panels
        at=(1072.83, -527.6), reach=30, depth=9.0, eaves=3.4, ridge=9.0, roof="gable", roof_tint="#3a3c3f", wall="brick", tint="#a94f38", frame=WHITE,
        solar=dict(s=(1.0, -1.0), rows=3), front=dict(ground=["W", "d", "w"], door=BROWN), chimneys=[dict(s=1.0, d=4.5, w=0.6, h=1.0)]),
    "b279l_shutters": dict(  # red brick, two storeys, white frames with roller shutters
        at=(1100.95, -509.29), depth=9.0, eaves=6.0, ridge=9.8, roof="gable", roof_tint="#3e4043", wall="brick", tint="#b05f48", frame=WHITE,
        front=dict(ground=["W", "d", "W"], first=["w", "w", "w"], sh=0.3, door=WHITE)),
    "b286l_solar": dict(  # 1.5 storeys of orange-red brick, solar panels, a timber-clad dormer, a pale garage door
        at=(1110.96, -504.33), depth=9.0, eaves=3.2, ridge=8.0, roof="gable", roof_tint="#3a3c3f", wall="brick", tint="#b8653f", frame=BROWN,
        solar=dict(s=(0.5, -0.5), rows=2), dormers=[dict(s=3.0, w=1.8, h=1.3, clad="#8a6a4a")],
        front=dict(ground=["d", "g"], garage="#cfc6b2", door=BROWN)),
    "b294r_hipped": dict(  # behind a tall hedge: beige-brown brick, a hipped slate roof with a chimney
        at=(1141.58, -529.94), depth=9.0, eaves=6.0, ridge=9.6, roof="hip", roof_tint=ROOF_SLATE, wall="brick", tint="#b39a7c", frame=WHITE,
        front=dict(ground=["W", "d", "W"], first=["w", "w", "w"], door=BROWN), chimneys=[dict(s=2.0, d=4.0, w=0.7, h=1.4)],
        hedges=[(0.0, 12.0, 4.0, 1.9, HEDGE_DARK)]),
    "b300r_garages": dict(  # long, two storeys of yellow-brown brick, three dark garage doors
        at=(1151.32, -533.91), reach=30, depth=9.0, eaves=5.6, ridge=9.6, roof="gable", roof_tint="#3e4043", wall="brick", tint="#b59a72", frame=WHITE,
        front=dict(ground=["g", "g", "g", "d"], first=["w", "w", "w", "w"], garage="#3a3c3e", door=WHITE)),
    "b314l_new": dict(  # new: orange-red brick, a steep dark roof with solar panels, anthracite frames
        at=(1128.42, -490.25), depth=9.0, eaves=4.6, ridge=10.0, roof="gable", roof_tint="#2f3134", wall="brick", tint="#b8653f", frame=ANTH,
        solar=dict(s=(1.0, -1.0), rows=2), front=dict(ground=["W", "d", "w"], door=ANTH)),
    "b330r_dormer": dict(  # behind a bank and hedge: brown-beige brick, dark red-brown tiles, a dormer
        at=(1172.55, -508.16), depth=9.0, eaves=3.2, ridge=8.2, roof="gable", roof_tint="#7a4636", wall="brick", tint="#a08068", frame=WHITE,
        front=dict(ground=["w", "W", "d", "w"], door=BROWN), dormers=[dict(s=-4.0, w=1.6, h=1.3, gable=True)],
        chimneys=[dict(s=2.0, d=4.5, w=0.6, h=1.1)], hedges=[(0.0, 17.0, 5.0, 1.6, HEDGE)]),
    "b377l_cube": dict(  # newer, flat-roofed: dark red-brown brick, a band of windows upstairs, black frames
        at=(1183.92, -448.19), depth=9.0, eaves=6.6, ridge=6.6, roof="flat", roof_tint="#3a3c3f", wall="brick", tint="#7c4a3a", frame=BLACK,
        front=[(2.0, 1.0, 0.0, 2.3, "d", dict(c=BLACK)), (4.6, 1.6, 0.3, 2.0, "w", {}), (4.0, 5.5, 3.9, 1.0, "w", {})]),
    "b413l_pair": dict(  # new pair: grey-beige brick, a steep dark roof with roof windows, a tall narrow stair window
        at=(1219.09, -430.77), depth=10.0, eaves=6.2, ridge=11.0, roof="gable", roof_tint="#2f3134", wall="brick", tint="#a69d8e", frame=ANTH,
        front=dict(ground=["W", "n", "d"], first=["w", "n", "w"], door=ANTH), roof_windows=[(2.0, 1.2), (4.5, 1.2)]),
    "b418l_pair": dict(  # its other half
        at=(1225.08, -430.62), depth=10.0, eaves=6.2, ridge=11.0, roof="gable", roof_tint="#2f3134", wall="brick", tint="#a69d8e", frame=ANTH,
        front=dict(ground=["d", "n", "W"], first=["w", "n", "w"], door=ANTH), roof_windows=[(2.0, 1.2), (4.5, 1.2)]),
    "b432r_banded": dict(  # half of a pair on the pavement: light beige brick in bands, white roller shutters, a black door
        at=(1245.69, -464.1), depth=9.0, eaves=6.0, ridge=9.4, roof="gable", roof_tint="#4a4c50", wall="brick", tint="#c9b9a0", frame=WHITE,
        eave_board=0.3, front=dict(ground=["W", "d"], first=["W", "w"], sh=0.5, door=BLACK)),
    "b440r_taupe": dict(  # the other half: taupe, a white door under a small canopy
        at=(1253.15, -459.41), depth=9.0, eaves=6.0, ridge=9.4, roof="gable", roof_tint="#4a4c50", wall="brick", tint="#9c8a78", frame=WHITE,
        eave_board=0.3, front=dict(ground=["d", "W"], first=["w", "w"], door=WHITE), canopy=dict(s=(0.4, 1.8), y=2.5)),
    "b466r_villa": dict(  # 1.5 storeys of brown-orange brick, dark brown tiles, a gable with a tall arched window, a wide garage door
        at=(1282.9, -458.15), depth=9.0, eaves=3.2, ridge=8.4, roof="gable", roof_tint=BROWN_ROOF, wall="brick", tint="#9a6a4e", frame=ANTH,
        front_gable=dict(s=(3.4, 5.8), top=8.4, apex_tint="#9a6a4e"), front=dict(ground=["g", "ad"], garage="#3e4246", door=BLACK)),
    "b480l_trees": dict(  # among trees, set back: brown brick, a dark roof
        at=(1279.09, -411.81), depth=9.0, eaves=3.2, ridge=7.6, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint="#8e6a52", frame=WHITE,
        front=dict(ground=["w", "d", "W"], door=BROWN)),
    "b484r_render": dict(  # behind a hedge: pale render, two storeys
        at=(1299.11, -463.0), depth=9.0, eaves=5.8, ridge=9.0, roof="gable", roof_tint="#3e4043", wall="render", tint="#d9d4cc", frame=WHITE,
        front=dict(ground=["w", "d"], first=["w", "w"])),
    "b500r_cottage": dict(  # an old cottage on the pavement: white render, orange pantiles, dark green shutters and arched door
        at=(1310.81, -441.72), depth=7.5, eaves=3.0, ridge=6.8, roof="gable", roof_tint=PANTILE, wall="render", tint="#ecebe6",
        plinth=(0.45, "#5f6163"), frame=WHITE, shutters=GREEN_SH, front=dict(ground=["w", "ad", "w"], door=GREEN_SH),
        chimneys=[dict(s=1.5, d=4.0, w=0.7, h=1.0)], roof_windows=[(4.0, 1.0)]),
    "b500r_behind": dict(  # behind it: yellow-brown brick, 1.5 storeys
        at=(1312.96, -451.78), depth=8.0, eaves=3.2, ridge=7.6, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint="#b39a72", frame=WHITE,
        front=dict(ground=["w", "d", "w"], door=BROWN)),
    "b516r_gable": dict(  # behind hedges and pleached trees: red brick with a tall pointed gable to the street
        at=(1325.5, -443.19), depth=9.0, eaves=5.2, ridge=10.5, roof="front_gable", roof_tint="#3a3c3f", wall="brick", tint="#a9573f", frame=WHITE,
        front=dict(ground=["W", "d"], first=["w", "w"], door=BROWN), hedges=[(0.0, 8.0, 3.0, 2.2, HEDGE_DARK)]),
    "b502l_villa": dict(  # c. 1900: yellow-ochre brick, a gable with a round window, stone bands, a french window with an iron railing
        at=(1309.99, -418.01), depth=9.0, eaves=6.4, ridge=10.4, roof="gable", roof_tint="#3e4043", wall="brick", tint="#c7a26b", frame=WHITE,
        front_gable=dict(s=(1.0, 5.0), top=11.0, apex_tint="#c7a26b"), bands=[(3.2, 0.15), (6.0, 0.25)],
        front=dict(ground=["W", "d"], first=["F", "w"], rail="#232425", door=ANTH), hedges=[(0.0, 10.0, 2.0, 1.0, HEDGE)]),
    "b510l_behind": dict(  # set back: red brick, 1.5 storeys
        at=(1312.5, -403.94), depth=8.0, eaves=3.2, ridge=7.4, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint="#a9573f", frame=WHITE,
        front=dict(ground=["w", "d"], door=BROWN)),
    "b516l_cottage": dict(  # a cottage: grey render on a stone base, brown-red tiles, a white gabled dormer
        at=(1318.84, -409.64), depth=8.0, eaves=3.4, ridge=8.4, roof="gable", roof_tint=RED_ROOF, wall="render", tint="#b9b6ae",
        plinth=(0.8, "#8a8a86", "stone"), frame=WHITE, front=dict(ground=["w", "d", "w"], door=BROWN),
        dormers=[dict(s=3.0, w=1.4, h=1.2, gable=True, clad="#f1efe9")], chimneys=[dict(s=1.0, d=4.5, w=0.7, h=1.4)]),
    "b529l_solar": dict(  # red-orange brick, two storeys, solar panels on a dark roof
        at=(1332.05, -410.36), depth=9.0, eaves=6.0, ridge=9.4, roof="gable", roof_tint="#3a3c3f", wall="brick", tint="#b9603f", frame=WHITE,
        solar=dict(s=(0.5, -0.5), rows=2), front=dict(ground=["W", "d"], first=["w", "w"], door=WHITE)),
    "b535l_red": dict(  # red brick, two storeys, white frames
        at=(1337.05, -405.2), depth=9.0, eaves=6.0, ridge=10.0, roof="gable", roof_tint="#3e4043", wall="brick", tint="#b05f48", frame=WHITE,
        front=dict(ground=["W", "d"], first=["w", "w"], door=WHITE)),
    "b549l_white": dict(  # white render, two storeys, roof windows, a white door
        at=(1349.82, -405.99), depth=9.0, eaves=6.0, ridge=9.6, roof="gable", roof_tint="#3e4043", wall="render", tint="#efede8", frame="#8f9396",
        front=dict(ground=["W", "d"], first=["W", "w"], door=WHITE), roof_windows=[(2.0, 1.2)]),
    "b554l_white": dict(  # white render, two storeys, a dark roof
        at=(1354.7, -398.7), depth=9.0, eaves=6.0, ridge=9.8, roof="gable", roof_tint="#3e4043", wall="render", tint="#efede8", frame=WHITE,
        front=dict(ground=["W", "d"], first=["w", "w"], door=BROWN)),
    "b562l_behind": dict(  # set back: small, red-brown brick
        at=(1356.64, -384.37), reach=30, depth=8.0, eaves=3.2, ridge=7.4, roof="gable", roof_tint="#7a4636", wall="brick", tint="#9a5a46", frame=WHITE,
        front=dict(ground=["w", "d"], door=BROWN)),
    "b578l_villa": dict(  # set back behind a lawn: white render, a dark roof with three white dormers
        at=(1373.74, -381.73), depth=10.0, eaves=3.6, ridge=9.2, roof="gable", roof_tint="#3e4043", wall="render", tint="#f0eee9", frame=WHITE,
        front=dict(ground=["W", "w", "d", "w", "W"], door=WHITE),
        dormers=[dict(s=3.5, w=1.5, h=1.3, gable=True, clad="#f1efe9"), dict(s=7.5, w=1.5, h=1.3, gable=True, clad="#f1efe9"),
                 dict(s=-3.5, w=1.5, h=1.3, gable=True, clad="#f1efe9")], chimneys=[dict(s=-2.0, d=4.5, w=0.7, h=1.3)]),
    "b611l_shop": dict(  # a shop, one storey under a flat roof: big windows in green frames
        at=(1407.78, -374.43), depth=12.0, eaves=4.0, ridge=4.0, roof="flat", roof_tint="#3a3c3f", wall="render", tint="#eceae4", frame=SHOP_GREEN,
        front=dict(ground=["W", "D", "W"], door=SHOP_GREEN)),
    "b619l_banded": dict(  # light grey brick in bands, two storeys under a flat top, a wide white garage door
        at=(1415.22, -374.27), depth=9.0, eaves=6.2, ridge=6.2, roof="flat", roof_tint="#3a3c3f", wall="brick", tint="#b9b4aa", frame=WHITE,
        front=dict(ground=["g", "d"], first=["w", "w"], garage="#efeeea", door=WHITE, sh=0.4)),
    "b625r_white": dict(  # on the pavement: white, two storeys, a dark grey roof
        at=(1428.37, -397.17), depth=8.0, eaves=5.8, ridge=9.0, roof="gable", roof_tint="#4a4c50", wall="render", tint="#efede8", frame=WHITE,
        front=dict(ground=["w", "d"], first=["w", "w"])),
    "b632r_gable": dict(  # red brick with its gable to the street, a slate roof, a brown garage door below
        at=(1433.95, -394.18), depth=9.0, eaves=5.0, ridge=9.4, roof="front_gable", roof_tint="#3a3c40", wall="brick", tint="#a95a45", frame=WHITE,
        front=dict(ground=["g", "W"], first=["w", "w"], garage="#5a3e2c")),
    "b632l_taupe": dict(  # taupe render, two storeys, white roller shutters
        at=(1428.35, -369.98), depth=9.0, eaves=6.0, ridge=9.4, roof="gable", roof_tint="#3e4043", wall="render", tint="#a39a86", frame=WHITE,
        front=dict(ground=["W", "d"], first=["w", "w"], sh=0.6, door=WHITE)),
    "b637l_white": dict(  # white render, two storeys, orange pantiles
        at=(1433.71, -370.02), depth=9.0, eaves=6.0, ridge=9.4, roof="gable", roof_tint=PANTILE, wall="render", tint="#efede8", frame=WHITE,
        front=dict(ground=["d", "w"], first=["w", "w"], door=WHITE)),
    "b649l_pair": dict(  # a red brick pair, two storeys, dark red-brown tiles, roller shutters, a white garage door
        at=(1445.72, -369.3), depth=9.0, eaves=5.8, ridge=9.4, roof="gable", roof_tint=TILES, wall="brick", tint="#a9573f", frame=WHITE,
        front=dict(ground=["W", "d", "g"], first=["w", "w", "w"], sh=0.5, door=WHITE, garage="#efeeea"),
        chimneys=[dict(s=1.5, d=4.5, w=0.6, h=1.0)]),
    "b655l_pink": dict(  # pinkish render, two storeys, a white garage door
        at=(1453.1, -368.53), depth=9.0, eaves=5.8, ridge=9.2, roof="gable", roof_tint="#3e4043", wall="render", tint="#c9b3a6", frame=WHITE,
        front=dict(ground=["g", "w"], first=["w", "w"], garage="#efeeea")),
    "b667r_bungalow": dict(  # a red brick bungalow, a dark brown roof, a chimney
        at=(1471.49, -400.43), depth=9.0, eaves=3.0, ridge=6.8, roof="gable", roof_tint=BROWN_ROOF, wall="brick", tint="#b65a46", frame=WHITE,
        front=dict(ground=["W", "d", "W", "w"], door=BROWN), chimneys=[dict(s=2.0, d=4.0, w=0.7, h=1.1)]),
    "b676l_pair": dict(  # a pair on the pavement: pale render over a grey stone base, beige shutters
        at=(1470.26, -361.86), depth=9.0, eaves=5.8, ridge=9.2, roof="gable", roof_tint="#3a3c3f", wall="render", tint="#c5c0b5",
        plinth=(1.0, "#6d6a66", "stone"), frame=WHITE, shutters="#d9cdb4",
        front=dict(ground=["g", "d", "W"], first=["w", "w", "w"], garage="#2f3134", door="#3a3c3f")),
    **TERRACE,
}


def main():
    _, _, to_model = model_frame()
    model = lambda g: affine_transform(g, to_model)
    pieces = [model(LineString([p[:2] for p in f["geometry"]["coordinates"]])) for f in features("Wegsegment")
              if f["properties"].get("LSTRNM") == "Molenhoek" and f["geometry"]["type"] == "LineString"]
    j = Point(JUNCTION)
    lines = [l if Point(l.coords[0]).distance(j) < Point(l.coords[-1]).distance(j) else LineString(l.coords[::-1])
             for l in getattr(linemerge(unary_union(pieces)), "geoms", []) if l.distance(j) < 1.0]
    branch = max(lines, key=lambda l: l.length)  # the branch to Oordegemkouter, from the junction

    def sample(s0, s1):
        out, s = [], s0
        while s <= min(s1, branch.length) + 1e-6:
            out.append(branch.interpolate(s))
            s += STEP
        return out

    plots = unary_union([model(p) for f in features("ADP") for p in polygons(f["geometry"])])

    def widths(ps):
        left, right = [], []
        for k, p in enumerate(ps):
            a, b = ps[max(0, k - 1)], ps[min(len(ps) - 1, k + 1)]
            n = math.hypot(b.x - a.x, b.y - a.y)
            nx, nz = -(b.y - a.y) / n, (b.x - a.x) / n
            for side, out in ((1, left), (-1, right)):
                ray = LineString([(p.x, p.y), (p.x + nx * side * REACH, p.y + nz * side * REACH)])
                hit = ray.intersection(plots)
                out.append(round(min((Point(p.x, p.y).distance(g) for g in getattr(hit, "geoms", [hit]) if not g.is_empty), default=REACH), 2))
        return left, right

    village = json.loads((ROOT / "web" / "src" / "data" / "village.json").read_text(encoding="utf-8"))
    walls = [(p, Polygon(p["p"][0])) for p in village["prisms"] if p["m"] in WALLS and "d" not in p]
    grb = [Polygon(list(model(g).exterior.coords)) for f in features("GBG") for g in polygons(f["geometry"])]
    others = [poly for p, poly in walls] + grb
    houses = plan(HOUSES, branch, walls, grb, others, Relief(), order="view")
    pts = lambda ps: [[round(p.x, 2), round(p.y, 2)] for p in ps]
    for i, (s0, s1) in enumerate(PARTS, 1):
        mine = {k: h for k, h in houses.items() if s0 <= branch.project(Point(h["at"])) < s1}
        line = sample(max(0.0, s0 - 10.0), min(branch.length, s1 + 10.0))
        left, right = widths(line)
        mid = branch.interpolate((s0 + min(s1, branch.length)) / 2)
        xs = sorted(h["at"][0] for h in mine.values())
        split = [round(xs[len(xs) // 3], 1), round(xs[2 * len(xs) // 3], 1)]
        out = ROOT / "data" / f"molenhoek_end{i}.json"
        out.write_text(json.dumps({
            "_source": "GRB Wegsegment, ADP and GBG (Digitaal Vlaanderen, open data); the houses' plans from web/src/data/village.json; "
                       "their looks from a Street View tour, described in tools/molenhoek_end_survey.py, no images",
            "name": f"molenhoek_end{i}", "origin": [round(mid.x, 2), round(mid.y, 2)], "order": "view", "lean": True,
            "detail_split": {"axis": "x", "at": split}, "line": pts(line), "left": left, "right": right, "houses": mine, "props": [],
        }, indent=None, separators=(",", ":")), encoding="utf-8")
        print(f"wrote {out.relative_to(ROOT)}: {len(line)} points, {len(mine)} houses, origin {mid.x:.1f} {mid.y:.1f}")
    for key, h in houses.items():
        print(f"  {key:20s} front {math.dist(*h['front']):5.2f} m  out {h['out'][0]:+.2f},{h['out'][1]:+.2f}  y0 {h['y0']:5.2f}  annexes {len(h['annex'])}")


if __name__ == "__main__":
    main()
