"""The street Kapellenhoek from the church square to past its junction with Briel, and the first stretch of
Kapelleweg: the survey, and the plan tools/molenhoek.py builds on (blender ... -- out.glb kapellenhoek).

Run from the project root (needs source/geo/ from tools/geodata.py):
    tools/.venv/Scripts/python.exe tools/kapellenhoek_survey.py

Sources, used for measuring only (nothing of them is shipped):
- the centre lines of web/src/data/streets.json (Wegenregister) and the GRB's plots (ADP), Digitaal
  Vlaanderen, open data;
- web/src/data/village.json: each house's blocks, from the GRB outline and the laser scan's heights, so the
  model stands on the same plan as the blocks it replaces, which stay for walking into; a house built since
  (`laser`) stands on the GRB's own building;
- a Street View tour, house by house from the street, with the newest images (2019 to 2026): what each house
  looks like. Four houses are blurred in Street View at their owners' request, and where the newest images
  are older than a building (two by the meadow near the square, flat-roofed in the village data), the village's
  blocks stay; so do a few houses hidden behind conifers or set far back.
The houses are keyed by where they stand: the metres along the street from the church square (k, Kapellenhoek)
or from the junction (w, Kapelleweg), and the side, l or r as seen walking away from the square; never by number.
Each front runs from its left end as seen from the street (`order` "view").

Writes data/kapellenhoek.json, in model coordinates (x, z), in the same form as data/molenhoek.json.
"""
import json
import math
from pathlib import Path

from shapely.affinity import affine_transform
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

from molenhoek_survey import (ANTH, BLACK, BROWN, CREAM, GREYBROWN, RED, RED2, REDBROWN, ROOF_DARK, ROOF_ORANGE, ROOF_SLATE,
                              TAUPE, WALLS, WHITE, Relief, plan)
from neighbours import features, model_frame, polygons

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "kapellenhoek.json"
STEP, REACH = 2.0, 14.0
# The centre lines (web/src/data/streets.json): Kapellenhoek from the church square to its second junction with
# Briel, Kapelleweg from Kapellenhoek, and the bit of Briel by the first junction (two houses face it).
KH = [(619.8, -747.8), (609.5, -722.7), (582.5, -690.6), (574.9, -676.6), (570.5, -655.7), (564.8, -578.1), (565.4, -540.8),
      (574.4, -498.8), (608.0, -413.9), (610.4, -400.4), (608.8, -385.4), (580.1, -285.2), (570.3, -265.6), (547.2, -235.2),
      (527.2, -209.1), (521.1, -194.7), (517.9, -175.7), (519.9, -162.6), (524.8, -151.7)]
KW = [(610.4, -400.4), (639.0, -397.4), (697.1, -396.4)]
KH_FROM, KH_TO, KW_TO = 12.0, 660.0, 100.0
BEIGE, YELLOWBROWN, ORANGERED, PALE = "#cdbb99", "#b8996a", "#c4623f", "#d9cdb4"
ROOF_BROWN, ROOF_RED = "#6b4a3c", "#9c4f38"
GREEN_SH, DARKRED_SH, BROWN_SH = "#3f5f45", "#6e2a26", "#5a3e2c"
HEDGE, HEDGE_DARK, BOX = "#4f6e3d", "#3f5f33", "#4a6b39"

HOUSES = {
    # From the church square, the west side (l).
    "k015l_corner": dict(  # the corner house: white render, one storey under orange pantiles, a grey stone plinth
        at=(606.9, -742.2), depth=8.5, eaves=3.4, ridge=7.6, roof="gable", roof_tint=ROOF_ORANGE, wall="render", tint="#f1efe9",
        plinth=(0.6, "#7d7a74", "stone"), frame=WHITE, gutter=BROWN,
        front=dict(ground=["W", "W", "d", "w"], sh=0.15, door=WHITE), chimneys=[dict(s=1.5, d=4.2, w=0.6, h=0.9), dict(s=-1.5, d=4.2, w=0.6, h=0.9)]),
    "k089l_bungalow": dict(  # a bungalow in light beige brick, a hipped brown roof, dark red shutters, a tall hedge in front
        at=(555.2, -670.0), depth=10.0, eaves=3.0, ridge=6.8, roof="hip", roof_tint=ROOF_BROWN, wall="brick", tint="#ddd2bd",
        plinth=(0.35, "#5f5a55"), frame=WHITE, shutters=DARKRED_SH,
        front=dict(ground=["w", "W", "d", "W", "w"], door=DARKRED_SH), chimneys=[dict(s=2.5, d=5.0, w=0.7, h=1.2), dict(s=-3.0, d=5.0, w=0.7, h=1.2)],
        hedges=[(0.2, 9.0, 3.0, 1.9, HEDGE_DARK)]),
    "k128l_carport": dict(  # red brick, two storeys, a white fascia, white frames and roller shutters, a carport beside
        at=(557.2, -635.4), depth=9.0, eaves=6.0, ridge=9.4, roof="gable", roof_tint=ROOF_SLATE, wall="brick", tint=RED, frame=WHITE,
        eave_board=0.3, plinth=(0.4, "#6a6762", "stone"), front=dict(ground=["W", "d"], first=["W", "w", "W"], sh=0.4, door=WHITE)),
    "k155l_bungalow": dict(  # a bungalow in beige-white brick under red-brown tiles, a brown wooden door in the middle
        at=(552.0, -606.2), depth=9.0, eaves=3.1, ridge=7.0, roof="gable", roof_tint=ROOF_RED, wall="brick", tint="#ddd4c2",
        plinth=(0.3, "#6a625a"), frame=WHITE, front=dict(ground=["w", "w", "d", "w", "w"], door=BROWN)),
    "k167l_garage": dict(  # two storeys of beige brick under red-brown tiles, a garage with a red door under its own gable
        at=(552.7, -596.8), depth=8.5, eaves=5.8, ridge=9.0, roof="gable", roof_tint=ROOF_RED, wall="brick", tint="#d6cbb4",
        plinth=(0.3, "#6a625a"), frame=WHITE, front=dict(ground=["w", "d"], first=["w", "w"], door=BROWN)),
    "k214l_flats": dict(laser=True,  # new flats: grey brick, three floors, a dark roof with roof windows, black frames, glass balconies
        at=(549.0, -553.0), depth=12.0, eaves=8.6, ridge=12.6, roof="gable", roof_tint="#3a3c3f", wall="brick", tint="#9a9894", frame=BLACK,
        front=dict(ground=["W", "D", "W", "W"], first=["W", "F", "W", "W"], door=BLACK, rail="#cfd8dc"),
        roof_windows=[(3.0, 1.6), (6.0, 1.6), (9.0, 1.6)]),
    "k263l_cottage": dict(rect=[[560.0, -492.25], [558.58, -499.61], [549.75, -497.92], [551.16, -490.56]],  # a cottage with its gable to the street: red brick below, white render with brown timbers above
        at=(550.6, -493.5), depth=9.0, eaves=3.0, ridge=8.6, roof="front_gable", roof_tint=ROOF_DARK, wall="brick", tint=RED2,
        upper=dict(y=3.0, wall="render", tint="#f1ede4"), timber=BROWN_SH, frame=WHITE,
        front=[(2.2, 1.6, 0.7, 1.4, "bay", dict(cu=True)), (-2.0, 1.0, 0.0, 2.2, "d", dict(c=BROWN)), (2.2, 1.8, 3.4, 1.2, "w", {}),
               (-2.4, 0.8, 3.4, 1.0, "w", {}), (0.0, 0.6, 5.6, 0.6, "w", {})],
        hedges=[(0.2, 8.0, 3.2, 1.8, HEDGE_DARK)]),
    "k314l_thirties": dict(rect=[[584.44, -449.4], [581.48, -458.42], [572.93, -455.61], [575.89, -446.59]],  # 1930s: yellow-brown brick with grey stone bands, a low hipped roof with deep eaves
        at=(578.4, -452.5), depth=9.0, eaves=6.4, ridge=8.6, roof="hip", roof_tint="#5a4a42", wall="brick", tint=YELLOWBROWN,
        plinth=(0.5, "#6d6a65", "stone"), bands=[(0.75, 0.12), (2.75, 0.2), (3.45, 0.12), (6.0, 0.25)], frame="#e9e7e1", eave_board=0.5,
        front=dict(ground=["W", "d", "W"], first=["w", "W", "W"], door="#c9c3b2"), front_wall=dict(h=0.55, tint="#9e6a4e", piers=True)),
    "k343l_farmhouse": dict(  # a long low farmhouse: cream render, red-brown pantiles, three dormers, green shutters
        at=(594.1, -419.9), depth=8.0, eaves=3.2, ridge=7.8, roof="gable", roof_tint=ROOF_RED, wall="render", tint="#e8dfc8",
        plinth=(0.45, "#7a7772", "stone"), frame=WHITE, shutters=GREEN_SH,
        front=dict(ground=["w", "w", "n", "ad", "n", "w", "w"], door=WHITE, cu=True),
        dormers=[dict(s=3.0, w=1.5, h=1.3, gable=True), dict(s=7.6, w=1.5, h=1.3, gable=True), dict(s=-2.2, w=1.5, h=1.3, gable=True)]),
    "k361l_corbels": dict(  # c. 1900 red brick: a high grey stone plinth, stone arches and keystones, a corbelled cornice
        at=(597.4, -404.8), depth=9.0, eaves=6.4, ridge=10.0, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint="#b85a3e",
        plinth=(0.9, "#8a8a86", "stone"), frame=WHITE, bands=[(6.0, 0.3)],
        front=[(1.6, 1.3, 1.0, 1.5, "w", dict(sh=0.5, seg=True, segc="#a3a39d")), (4.0, 1.1, 0.3, 2.5, "d", dict(c=ANTH, glass_strip=True)),
               (6.4, 1.3, 1.0, 1.5, "w", dict(sh=0.5, seg=True, segc="#a3a39d")), (1.0, 0.9, 3.8, 1.5, "w", dict(seg=True, segc="#a3a39d")),
               (2.2, 0.9, 3.8, 1.5, "w", dict(seg=True, segc="#a3a39d")), (4.0, 0.9, 3.8, 1.5, "w", dict(seg=True, segc="#a3a39d")),
               (5.8, 0.9, 3.8, 1.5, "w", dict(seg=True, segc="#a3a39d")), (7.0, 0.9, 3.8, 1.5, "w", dict(seg=True, segc="#a3a39d"))]),
    "k409l_bungalow": dict(  # a bungalow in beige brick under brown tiles, a chimney; a concrete-plate fence and hedges in front
        at=(585.7, -365.8), depth=9.0, eaves=3.0, ridge=6.6, roof="gable", roof_tint=ROOF_BROWN, wall="brick", tint="#cdb79a",
        frame=BROWN, front=dict(ground=["W", "d", "W"], door=BROWN), chimneys=[dict(s=2.0, d=4.5, w=0.7, h=1.3)],
        hedges=[(0.5, 7.0, 3.5, 1.6, HEDGE)]),
    "k431l_solar": dict(  # brown brick under red-brown tiles almost covered in solar panels, a brown garage door; a tall hedge
        at=(580.3, -344.8), depth=9.0, eaves=3.0, ridge=7.8, roof="gable", roof_tint=ROOF_RED, wall="brick", tint="#8f6a55", frame=BROWN,
        solar=dict(s=(0.6, -0.6), rows=3), chimneys=[dict(s=4.5, d=4.5, w=0.7, h=1.0)],
        front=dict(ground=["g", "w", "w"], garage="#5a3e2c"), hedges=[(1.2, 8.0, 3.6, 1.8, HEDGE_DARK)]),
    "k471l_cottage": dict(  # an old cottage on the pavement: yellow-brown hand-made brick, red pantiles with solar panels, an arched door
        at=(575.8, -304.4), depth=7.5, eaves=3.0, ridge=7.2, roof="gable", roof_tint=ROOF_ORANGE, wall="brick", tint="#a8865e", frame=BROWN,
        solar=dict(s=(2.0, -0.6), rows=2), roof_windows=[(1.0, 1.2)],
        front=[(1.0, 1.0, 0.0, 2.2, "ad", dict(c="#6e4a30")), (3.6, 1.1, 0.8, 1.2, "w", dict(cu=True)), (5.8, 1.1, 0.8, 1.2, "w", {}),
               (8.0, 1.1, 0.8, 1.2, "w", dict(cu=True))]),
    "k501l_dormers": dict(  # small red brick house, a dark slate roof with two white gabled dormers; a low box hedge
        at=(555.6, -282.0), depth=8.0, eaves=3.1, ridge=7.8, roof="gable", roof_tint=ROOF_SLATE, wall="brick", tint=RED2, frame=WHITE,
        front=dict(ground=["w", "d", "W"], door=WHITE), chimneys=[dict(s=-0.6, d=4.0, w=0.6, h=1.0)],
        dormers=[dict(s=2.0, w=1.3, h=1.2, gable=True, clad="#f1efe9"), dict(s=-2.0, w=1.3, h=1.2, gable=True, clad="#f1efe9")],
        hedges=[(0.4, 7.0, 2.2, 0.5, BOX)], topiary=[(5.2, 1.4, 0.6, BOX)]),
    "k516l_beige": dict(  # beige-brown brick, two storeys on the pavement, white door and frames
        at=(553.4, -270.5), depth=9.0, eaves=6.0, ridge=9.6, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint="#b49a7c", frame=WHITE,
        front=dict(ground=["d", "W"], first=["w", "w"], door=WHITE), chimneys=[dict(s=0.6, d=4.5, w=0.6, h=1.1)]),
    "k538l_orange": dict(  # orange-red brick, two storeys, a white fascia, white frames, roller shutters, a dark door
        at=(541.6, -247.4), depth=9.0, eaves=6.0, ridge=9.6, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=ORANGERED, frame=WHITE,
        eave_board=0.3, front=dict(ground=["W", "d", "W"], first=["w", "w"], sh=0.4, door=ANTH), chimneys=[dict(s=-0.6, d=4.5, w=0.6, h=1.1)]),
    "k564l_roundwindow": dict(  # an old red brick building with its gable to the street, a round window, a pale garage door
        at=(515.0, -239.0), depth=10.0, eaves=3.4, ridge=8.4, roof="front_gable", roof_tint=ROOF_RED, wall="brick", tint="#a9573f", frame=WHITE,
        oculus=dict(y=5.6, r=0.45), front=dict(ground=["g"], garage="#cfd0cc")),
    "k580l_briel": dict(  # brown brick under a tiled roof, facing the street at the junction
        at=(506.9, -221.0), depth=9.0, eaves=3.4, ridge=7.8, roof="gable", roof_tint=ROOF_RED, wall="brick", tint="#9a6e56", frame=WHITE,
        front=dict(ground=["w", "d", "W"], door=BROWN)),
    # From the church square, the east side (r).
    "k090r_terrace": dict(  # terraced, on the pavement: red brick, a closed white roller shutter, a dark wooden door with a top light
        at=(588.1, -668.8), depth=8.0, eaves=5.8, ridge=9.0, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint="#a7553f", frame=WHITE,
        lintels=True, front=[(2.0, 1.9, 0.8, 1.4, "w", dict(sh=1.0, box=True)), (4.6, 1.0, 0.0, 2.4, "d", dict(c="#3d2a20", lights=2)),
                             (1.8, 1.2, 3.6, 1.2, "w", dict(cu=True)), (4.6, 1.2, 3.6, 1.2, "w", dict(cu=True))]),
    "k098r_terrace": dict(  # its neighbour: red brick, a white door with glass, wide windows with white frames, a flat front top
        at=(585.5, -663.7), depth=8.0, eaves=6.0, ridge=8.6, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint="#b25f45", frame=WHITE,
        lintels=True, eave_board=0.35,
        front=[(1.2, 1.0, 0.0, 2.3, "d", dict(f=WHITE)), (2.1, 0.4, 0.8, 1.4, "w", {}), (4.0, 2.0, 0.8, 1.4, "w", dict(cu=True)),
               (1.4, 0.7, 3.6, 1.2, "w", dict(cu=True)), (4.0, 2.0, 3.6, 1.2, "w", dict(cu=True))]),
    "k116r_gable": dict(  # grey-beige brick with its gable to the street, brown shutters upstairs; a lawn behind a low stone wall
        at=(587.8, -645.0), depth=9.0, eaves=3.4, ridge=8.4, roof="front_gable", roof_tint=ROOF_SLATE, wall="brick", tint="#a99c8c", frame=BROWN,
        shutters=BROWN_SH, front=[(2.0, 2.4, 0.7, 1.5, "w", dict(cu=True)), (4.8, 1.0, 0.0, 2.2, "d", dict(c=BROWN)), (1.9, 1.2, 3.8, 1.2, "w", {}),
                                  (4.3, 1.2, 3.8, 1.2, "w", {})],
        front_wall=dict(h=0.5, tint="#a9a49a", piers=False), topiary=[(1.2, 2.0, 0.7, HEDGE), (3.0, 2.2, 0.5, BOX)]),
    "k141r_narrow": dict(  # narrow red brick, pale concrete lintels and sills, a grey stone plinth, a closed white roller shutter
        at=(587.6, -620.4), depth=8.0, eaves=5.9, ridge=9.4, roof="gable", roof_tint=ROOF_SLATE, wall="brick", tint="#a9573f", frame=WHITE,
        plinth=(0.5, "#8a8984", "stone"), lintels="stone", chimneys=[dict(s=1.0, d=4.0, w=0.6, h=1.0)],
        front=dict(ground=["w", "d"], first=["w", "w"], sh=0.6, door=WHITE), garden_conifers=[(-0.6, 1.6, 4.5, 0.45), (-0.6, 3.2, 4.2, 0.45)]),
    "k152r_gable": dict(  # red brick, white frames; a low white metal fence in front
        at=(588.0, -606.1), depth=8.5, eaves=5.8, ridge=9.6, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint="#a8563e", frame=WHITE,
        front=dict(ground=["d", "W"], first=["w", "w"], door=WHITE), fence=dict(h=0.6, c="#efeeea")),
    "k168r_fascia": dict(  # red brick, two storeys, a white fascia; conifers along the drive
        at=(581.7, -595.5), depth=8.5, eaves=6.0, ridge=9.0, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=RED2, frame=WHITE,
        eave_board=0.35, front=dict(ground=["W", "d"], first=["w", "w"], sh=0.3, door=WHITE)),
    "k188r_workshop": dict(  # a workshop: beige brick, a big white sectional door across most of its front, flat roof
        at=(587.4, -573.9), depth=None, eaves=4.8, roof="flat", wall="brick", tint="#d4c8ad", coping="#8d8f8f", frame=WHITE,
        front=[(-5.0, 7.2, 0.0, 4.0, "g", dict(c="#f0efeb"))]),
    "k196r_flattop": dict(  # grey-beige brick, two storeys, a flat front top with a dark fascia, roller shutters, a door up two steps
        at=(587.0, -567.2), depth=9.0, eaves=6.0, ridge=8.4, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint="#b3a796", frame=WHITE,
        eave_board=0.35, plinth=(0.5, "#6a6762", "stone"),
        front=[(1.5, 1.0, 0.35, 2.2, "d", dict(c="#3a3634")), (4.2, 2.0, 0.8, 1.4, "w", dict(sh=0.5, box=True)),
               (1.6, 1.2, 3.6, 1.2, "w", dict(sh=0.3, box=True)), (4.2, 2.0, 3.6, 1.2, "w", dict(sh=0.9, box=True))]),
    "k209r_painted": dict(  # white-painted brick, two storeys, round-headed windows upstairs and a round-arched door
        at=(584.0, -553.1), depth=8.0, eaves=6.0, ridge=9.4, roof="gable", roof_tint=ROOF_SLATE, wall="render", tint="#eeece6", frame=WHITE,
        plinth=(0.5, "#6a6a6a", "render"),
        front=[(1.8, 1.0, 0.8, 1.6, "a", {}), (4.4, 1.0, 0.0, 2.3, "ad", dict(c=WHITE)), (1.8, 0.9, 3.7, 1.3, "a", {}), (4.4, 0.9, 3.7, 1.3, "a", {})]),
    "k221r_symmetric": dict(  # symmetric, two storeys in brown-grey brick, five bays, a white door with a fanlight in the middle
        at=(589.5, -543.9), depth=9.0, eaves=6.0, ridge=10.0, roof="gable", roof_tint="#5b4b45", wall="brick", tint="#8e7868", frame=WHITE,
        lintels="stone", chimneys=[dict(s=0.6, d=4.5, w=0.7, h=1.2), dict(s=-0.6, d=4.5, w=0.7, h=1.2)],
        front=dict(ground=["w", "w", "ad", "w", "w"], first=["w", "w", "w", "w", "w"], door=WHITE), hedges=[(-3.0, -0.2, 2.5, 0.6, "#8a3a2e")]),
    "k241r_gableside": dict(  # set back: grey brick, 1.5 storeys
        at=(596.4, -525.8), depth=9.0, eaves=3.2, ridge=7.8, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint="#a39d93", frame=WHITE,
        front=dict(ground=["W", "d", "w"], door=ANTH), garden_conifers=[(-1.0, 4.0, 5.0, 0.6)]),
    "k258r_bungalow": dict(  # set back: a low bungalow with a hipped roof and a garage with a dark door
        at=(596.7, -509.2), depth=9.0, eaves=2.9, ridge=6.2, roof="hip", roof_tint="#4c4e50", wall="brick", tint="#9c8f80", frame=WHITE,
        front=dict(ground=["w", "W", "d", "g"], door=ANTH, garage="#3a3c3e"), hedges=[(0.5, 8.0, 4.5, 1.0, HEDGE)]),
    "k275r_dormers": dict(  # 1.5 storeys, white render, a steep brown roof with two dormers, brown shutters, a garage beside
        at=(589.5, -494.0), depth=8.5, eaves=3.1, ridge=8.2, roof="gable", roof_tint=ROOF_BROWN, wall="render", tint="#f0eee8", frame=WHITE,
        shutters=BROWN_SH, front=dict(ground=["g", "w", "d", "w"], door=BROWN, garage="#8e9092"),
        dormers=[dict(s=-3.6, w=1.4, h=1.2, gable=True), dict(s=-1.4, w=1.4, h=1.2, gable=True)], hedges=[(1.5, 8.5, 2.0, 0.6, BOX)]),
    "k290r_redbrick": dict(  # red brick, two storeys, white frames, a roller shutter; a tall hedge beside
        at=(598.7, -481.7), depth=8.5, eaves=5.9, ridge=9.4, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint="#b0583f", frame=WHITE,
        front=dict(ground=["W", "d"], first=["w", "w"], sh=0.5, door=WHITE)),
    "k307r_pointed": dict(  # narrow dark red-brown brick with a pointed gable to the street, a brown door, a white shutter
        at=(610.2, -465.5), depth=9.0, eaves=3.6, ridge=8.6, roof="front_gable", roof_tint=ROOF_DARK, wall="brick", tint="#8a4636", frame=WHITE,
        front=dict(ground=["d", "W"], first=["w"], sh=1.0, door=BROWN)),
    "k318r_flatfront": dict(  # red brick, two storeys, a white fascia, a white door
        at=(606.9, -454.0), depth=8.0, eaves=6.0, ridge=8.8, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint="#a8523d", frame=WHITE,
        eave_board=0.35, front=dict(ground=["d", "W"], first=["w", "W"], door=WHITE)),
    "k327r_gable": dict(  # red brick with its gable to the street, white door and frames, a grey plinth
        at=(608.8, -442.9), depth=9.0, eaves=3.8, ridge=9.2, roof="front_gable", roof_tint=ROOF_DARK, wall="brick", tint="#b25a40", frame=WHITE,
        plinth=(0.5, "#8a8984", "render"), front=dict(ground=["d", "W"], first=["w", "w"], door=WHITE)),
    "k342r_newrow": dict(laser=True,  # new terrace: light grey brick, a dark roof with roof windows, big black-framed windows
        at=(619.6, -432.5), depth=10.0, eaves=6.2, ridge=10.4, roof="gable", roof_tint="#3a3c3f", wall="brick", tint="#c4c3bf", frame=BLACK,
        front=dict(ground=["W", "d", "W"], first=["W", "W"], door=BLACK), roof_windows=[(2.0, 1.4), (5.0, 1.4)]),
    "k358r_newrow": dict(laser=True,  # its other end: a carport through the row, a black-clad bay
        at=(628.2, -416.9), depth=10.0, eaves=6.2, ridge=10.4, roof="gable", roof_tint="#3a3c3f", wall="brick", tint="#c4c3bf", frame=BLACK,
        upper=dict(y=0.0, wall="brick", tint="#c4c3bf"), front=dict(ground=["d", "W"], first=["W", "W"], door=BLACK),
        roof_windows=[(2.0, 1.4), (5.0, 1.4)]),
    "k416r_meadow": dict(  # behind a meadow: pale beige brick, a dark slate-grey roof
        at=(616.4, -352.0), depth=9.0, eaves=5.8, ridge=9.6, roof="gable", roof_tint=ROOF_SLATE, wall="brick", tint="#ddd0bb", frame=WHITE,
        front=dict(ground=["W", "d", "W"], first=["w", "w", "w"], door=ANTH)),
    "k440r_bungalow": dict(  # a bungalow in light brown brick under anthracite tiles, a garage with a dark door; low planter walls
        at=(608.6, -328.9), depth=9.0, eaves=3.0, ridge=6.8, roof="gable", roof_tint="#3d3f42", wall="brick", tint="#b39478", frame=BROWN,
        front=dict(ground=["W", "d", "w", "g"], door=BROWN, garage="#3e3a36"), chimneys=[dict(s=2.0, d=4.5, w=0.6, h=1.0), dict(s=-3.5, d=4.5, w=0.6, h=1.0)],
        front_wall=dict(h=0.45, tint="#9c7a62", piers=False)),
    "k491r_dormer": dict(  # set back: 1.5 storeys, beige render, red-brown tiles and a dormer, a dark garage door
        at=(605.3, -270.0), depth=9.0, eaves=3.2, ridge=8.2, roof="gable", roof_tint=ROOF_RED, wall="render", tint="#e3d9c6", frame=WHITE,
        front=dict(ground=["g", "d", "W"], door=ANTH, garage="#3a3c3e"), dormers=[dict(s=-2.5, w=1.6, h=1.3, gable=True)],
        hedges=[(0.0, 6.0, 4.0, 1.6, HEDGE_DARK)]),
    "k511r_stepgable": dict(  # set back: grey-brown brick with a crow-stepped gable to the street
        at=(596.9, -250.1), depth=10.0, eaves=3.6, ridge=9.4, roof="front_gable", roof_tint=ROOF_DARK, wall="brick", tint="#8f8073", frame=WHITE,
        steps=True, front=dict(ground=["W", "d", "W"], first=["w"], door=ANTH), front_wall=dict(h=0.9, tint="#8f8073", piers=True)),
    "k538r_villa": dict(  # a modern villa: white render, a dark grey-brown upper part, a tall white chimney column
        at=(579.1, -232.5), depth=9.0, eaves=5.8, ridge=9.0, roof="gable", roof_tint="#3a3836", wall="render", tint="#f2f1ee",
        upper=dict(y=3.2, wall="render", tint="#5a524c"), frame=ANTH, front=dict(ground=["W", "d", "W"], first=["W", "w"], door=ANTH),
        chimneys=[dict(s=2.0, d=0.6, w=0.8, h=1.4)]),
    "k570r_bungalow": dict(  # far back: red brick bungalow, anthracite roof, a white-rendered part with a garage
        at=(557.8, -204.9), depth=9.0, eaves=3.0, ridge=6.6, roof="gable", roof_tint="#3d3f42", wall="brick", tint=RED2, frame=WHITE,
        front=dict(ground=["w", "d", "W", "g"], door=ANTH, garage="#efeeea")),
    "k610r_white": dict(  # set back: white render, 1.5 storeys under a big dark roof with low eaves, two roof windows
        at=(547.6, -184.7), depth=9.0, eaves=3.0, ridge=8.4, roof="gable", roof_tint="#3a3c3f", wall="render", tint="#f2f1ee", frame=ANTH,
        roof_windows=[(3.5, 1.5), (5.0, 1.5)], front=dict(ground=["W", "d", "W", "W"], door=ANTH)),
    "k640r_white": dict(  # set back: white 1.5 storeys with a grey roof; bamboo, shrubs and a post-and-rail fence in front
        at=(549.6, -161.5), depth=9.0, eaves=3.2, ridge=8.0, roof="gable", roof_tint="#6d7072", wall="render", tint="#f0efeb", frame=WHITE,
        front=dict(ground=["W", "d", "W"], door=ANTH)),
    # Kapelleweg, its first stretch.
    "w017r_black": dict(laser=True,  # new: the upper floor and the roof all in black slates, white-grey brick below, a black carport
        at=(627.1, -409.3), depth=9.0, eaves=6.0, ridge=10.4, roof="front_gable", roof_tint="#232425", wall="brick", tint="#d2d0cb",
        upper=dict(y=3.0, wall="render", tint="#2a2b2c"), frame=BLACK,
        front=[(1.5, 1.1, 0.0, 2.4, "d", dict(c=BLACK, recess=0.0)), (4.0, 2.2, 0.4, 2.0, "w", {}), (2.2, 2.0, 3.6, 1.3, "w", {}),
               (5.0, 0.9, 3.8, 1.0, "w", {}), (3.8, 0.9, 6.4, 0.9, "w", {})]),
    "w033l_villa": dict(  # set back: beige brick, 1.5 storeys, a dark slate roof with a dormer, a dark garage door
        at=(644.5, -372.2), depth=9.0, eaves=3.2, ridge=8.4, roof="gable", roof_tint=ROOF_SLATE, wall="brick", tint="#cdbb99", frame=WHITE,
        front=dict(ground=["W", "d", "g"], door=ANTH, garage="#3a3c3e"), dormers=[dict(s=2.5, w=1.6, h=1.3, gable=True)]),
    "w040r_slope": dict(  # beige brick under anthracite tiles, a garage half below the ground floor
        at=(652.9, -413.4), depth=9.0, eaves=4.6, ridge=8.2, roof="gable", roof_tint="#3d3f42", wall="brick", tint="#cbbc9f", frame=WHITE,
        front=dict(ground=["g", "W", "d"], door="#c9c9c4", garage="#3a3c3e")),
    "w063l_solar": dict(  # red-brown tiles with solar panels and roof windows, red brick
        at=(671.7, -368.4), depth=10.0, eaves=3.2, ridge=8.0, roof="gable", roof_tint=ROOF_RED, wall="brick", tint="#a8664c", frame=WHITE,
        solar=dict(s=(0.5, 6.0), rows=2), roof_windows=[(8.0, 1.3)], front=dict(ground=["W", "d", "W"], door=BROWN)),
}
# A give-way sign at the corner where Kapelleweg meets Kapellenhoek, for Kapelleweg's traffic.
PROPS = [{"k": "give_way", "at": [614.6, -404.6], "face": [-0.99, 0.1]}]


def main():
    _, _, to_model = model_frame()
    model = lambda g: affine_transform(g, to_model)
    kh, kw = LineString(KH), LineString(KW)

    def sample(l, s0, s1):
        out, s = [], s0
        while s <= min(s1, l.length) + 1e-6:
            out.append(l.interpolate(s))
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

    main_pts, kw_pts = sample(kh, KH_FROM, KH_TO), sample(kw, 0.0, KW_TO)
    left, right = widths(main_pts)
    kw_left, kw_right = widths(kw_pts)
    briel = LineString([(547.2, -235.2), (520.0, -250.0), (500.0, -258.0)])  # the bit of Briel by the junction (streets.json)
    centre = unary_union([kh, kw, briel])
    village = json.loads((ROOT / "web" / "src" / "data" / "village.json").read_text(encoding="utf-8"))
    walls = [(p, Polygon(p["p"][0])) for p in village["prisms"] if p["m"] in WALLS and "d" not in p]
    grb = [Polygon(list(model(g).exterior.coords)) for f in features("GBG") for g in polygons(f["geometry"])]
    others = [poly for p, poly in walls] + grb
    houses = plan(HOUSES, centre, walls, grb, others, Relief(), order="view")
    pts = lambda ps: [[round(p.x, 2), round(p.y, 2)] for p in ps]
    OUT.write_text(json.dumps({
        "_source": "streets.json (Wegenregister) and the GRB's ADP and GBG (Digitaal Vlaanderen, open data); the houses' plans from "
                   "web/src/data/village.json; their looks from a Street View tour, described here, no images",
        "name": "kapellenhoek", "origin": [588.0, -480.0], "order": "view", "lean": True, "detail_split": {"axis": "z", "at": [-600.0, -400.0]},
        "line": pts(main_pts), "left": left, "right": right, "lines": [{"line": pts(kw_pts), "left": kw_left, "right": kw_right}],
        "houses": houses, "props": PROPS,
    }, indent=None, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(main_pts)} + {len(kw_pts)} points, {len(houses)} houses")
    for key, h in houses.items():
        L = math.dist(*h["front"])
        print(f"  {key:20s} front {L:5.2f} m  out {h['out'][0]:+.2f},{h['out'][1]:+.2f}  y0 {h['y0']:5.2f}  low {h['low']:4.2f}  annexes {len(h['annex'])}")


if __name__ == "__main__":
    main()
