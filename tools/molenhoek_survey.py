"""The street Molenhoek round its portal: the survey, and the plan tools/molenhoek.py builds on.

Run from the project root (needs source/geo/ from tools/geodata.py):
    tools/.venv/Scripts/python.exe tools/molenhoek_survey.py

Sources, used for measuring only (nothing of them is shipped):
- GRB Wegsegment (the centre lines; past the junction where the map ends they have versions of
  February 2026, after the street was rebuilt), ADP (the plots) and GBG (the buildings, for the
  houses past the edge of the village data), Digitaal Vlaanderen, open data;
- web/src/data/village.json (tools/neighbours.py): each house's blocks, from the GRB outline and
  the laser scan's heights, so the model stands on the same plan as the blocks it replaces, which
  stay for walking into;
- Street View, from the street only (August 2026 from the church square to x = 790; east of it the
  newest images are of 2019): what each house looks like (brick and its colour, bands and plinths,
  windows, doors, shutters and frames, roof and its colour, chimneys, dormers, solar panels) and the
  street itself: since 2026 a dark asphalt carriageway with a concrete gutter, a raised red cycle
  lane on either side, a kerb and a pavement of grey concrete pavers; slim steel lamp posts, no
  overhead cables; a traffic island with a keep-left sign where the new stretch ends towards the
  church, with the old concrete road, its gutters and pavements beyond; a fire hydrant. From x = 785
  the 2026 images show the new layout carrying on to the junction.
The houses are keyed by where they stand (model x, z) and named by position, never by number.

How far: Molenhoek is Smetlede's (the cadastral division of the former municipality, 41066, the
same as the church's and the main house's plots) from the church square to well past the junction
where the map ends; the model covers every house on it from the square (where the town centre's
houses take over) to the corners of that junction, the last ones on the map.

Writes data/molenhoek.json, in model coordinates (x, z):
- line: the centre line from MIN_X to MAX_X, a point every STEP metres, west to east; left and
  right: the free width either side up to the nearest plot (left is the +z side, the portal's);
  stub: the same for the first STUB metres of the branch that turns off at the junction;
- houses: per house its plan (the front wall facing the street, the main body, the lower parts
  behind or beside it as outlines with their heights), which walls stand against a neighbour,
  its ground (as the relief: metres above the main house's ground) and the survey's description;
- props: the street furniture of the survey.
"""
import json
import math
from pathlib import Path

from shapely.affinity import affine_transform
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import linemerge, nearest_points, unary_union

from neighbours import features, model_frame, polygons

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "molenhoek.json"
MIN_X, MAX_X, STEP = 626.0, 936.0, 2.0  # the main line: from the church square to 45 m past the junction
STUB = 46.0  # m of the branch that turns off at the junction
REACH = 14.0  # m: how far to look for a plot on either side
GROUND = -0.1  # the main house's ground level in the village data
WALLS = {"nb_red", "nb_brown", "nb_yellow", "nb_white", "nb_grey", "nb_dark"}

# Openings on a front wall: (s, w, y, h, kind, options). s: the middle, in metres from the wall's west
# end; y: the bottom above the ground floor; kind: w window, d door, g garage door, a window with a
# round top, ad door with a round top, bay an oriel. Options: f frame colour, c leaf colour, sh how far
# a roller shutter is down (0..1), box a shutter box above it, cu net curtains, lin a lintel band.
WHITE, ANTH, BROWN, OAK, BLACK = "#f1f0ec", "#3a3d40", "#5a4334", "#8a6a4a", "#232426"
HOUSES = {
    # South side, the portal's (+z). From the church end.
    "sw_pair_white": dict(  # west half of a pair: rendered white, a big window in a dark surround
        at=(697.0, -705.0), depth=9.0, eaves=6.1, ridge=9.4, roof="gable", roof_tint="#6e4a3c", wall="render", tint="#f4f3ef",
        plinth=(0.35, "#4d4a47"), frame=ANTH, solar=dict(s=(0.6, 5.4), rows=2),
        front=[(1.6, 1.1, 0.0, 2.2, "d", dict(c="#2d3033")), (4.0, 2.2, 0.55, 1.6, "w", dict(surround=0.18)),
               (3.2, 1.7, 3.6, 1.2, "w", dict(surround=0.18, cu=True))],
        sides=True, chimneys=[]),
    "sw_pair_grey": dict(  # east half: taupe brick, an arched front door, white frames, solar panels
        at=(704.0, -710.0), depth=9.0, eaves=6.1, ridge=9.4, roof="gable", roof_tint="#6e4a3c", wall="brick", tint="#a09284",
        plinth=(0.45, "#5a5550"), frame=WHITE, solar=dict(s=(0.5, 6.2), rows=2), lintels=True,
        front=[(1.1, 1.05, 0.0, 2.35, "ad", dict(c=WHITE)), (2.9, 1.15, 0.75, 1.45, "w", dict(cu=True)), (4.9, 1.15, 0.75, 1.45, "w", dict(cu=True)),
               (1.4, 1.05, 3.55, 1.25, "w", {}), (3.6, 1.05, 3.55, 1.25, "w", dict(cu=True)), (5.8, 1.05, 3.55, 1.25, "w", {})],
        chimneys=[dict(s=6.6, d=3.5, w=0.7, h=1.3)], front_wall=dict(h=0.75, tint="#9d4e3c", piers=True)),
    "sw_balcony_west": dict(  # a 1960s pair in light yellow brick: this half with a balcony and brown railing
        at=(717.0, -704.0), depth=10.0, eaves=6.3, ridge=10.2, roof="gable", roof_tint="#4a4c50", wall="brick", tint="#cbb38c",
        plinth=(0.35, "#6a5a4a"), frame=WHITE, gutter=BROWN,
        front=[(2.4, 3.2, 0.0, 2.3, "w", dict(f=BROWN, sh=0.0, cu=False)), (5.0, 1.0, 0.0, 2.2, "d", dict(c=BROWN)),
               (1.4, 0.9, 3.3, 1.45, "d", dict(f=WHITE)), (2.6, 0.9, 3.3, 1.45, "w", dict(cu=True)), (3.8, 0.9, 3.3, 1.45, "w", dict(cu=True))],
        balcony=dict(s=(0.6, 4.4), y=3.15, depth=1.0, rail=BROWN), chimneys=[dict(s=3.0, d=5.0, w=0.6, h=1.1)]),
    "sw_balcony_east": dict(  # the other half: roller shutters, a strip of dark brick by the doors
        at=(724.8, -709.7), depth=10.0, eaves=6.3, ridge=10.2, roof="gable", roof_tint="#4a4c50", wall="brick", tint="#cbb38c",
        plinth=(0.35, "#6a5a4a"), frame=WHITE, gutter=BROWN, strip=dict(s=(0.0, 1.3), tint="#6b5444"),
        front=[(0.65, 0.95, 0.0, 2.2, "d", dict(c=ANTH)), (4.6, 1.8, 0.8, 1.4, "w", dict(sh=0.45, box=True, cu=True)),
               (4.6, 1.6, 3.6, 1.25, "w", dict(sh=0.35, box=True)), (0.65, 0.6, 3.9, 0.9, "w", {})],
        chimneys=[dict(s=6.8, d=5.0, w=0.6, h=1.1)]),
    "sw_tall": dict(  # the tall house west of the portal: red brick, white stone bands, an oriel, a flat cornice
        at=(744.1, -703.6), depth=9.0, eaves=7.0, ridge=10.9, roof="hip", roof_tint="#3d4144", wall="brick", tint="#b0563f",
        plinth=(0.65, "#4e3328", "brick"), frame=WHITE, bands=[(3.2, 0.24), (6.15, 0.24)], tower=dict(s=(0.0, 3.3), top=9.3, cornice=0.45),
        eave_board=0.42,
        front=[(1.6, 1.15, 0.0, 2.75, "w", dict(sh=1.0, box=True)), (4.9, 1.15, 0.85, 1.45, "w", dict(sh=0.25, box=True, cu=True)),
               (1.65, 2.2, 3.55, 1.7, "bay", dict(cu=True)), (4.9, 1.15, 3.55, 1.6, "w", dict(cu=True)),
               (1.65, 2.0, 6.75, 1.15, "w", dict(cu=True))],
        chimneys=[dict(s=0.6, d=7.0, w=0.9, h=1.6)]),
    "se_cream": dict(  # east of the portal: yellow brick below, cream boards above, a roof window
        at=(769.5, -701.0), depth=10.0, eaves=6.1, ridge=9.7, roof="gable", roof_tint="#3f4347", wall="brick", tint="#d2bb8f",
        upper=dict(y=3.05, wall="cladding", tint="#e6dcc0"), plinth=(0.3, "#7a6a55"), frame=ANTH, eave_board=0.3,
        front=[(2.3, 1.0, 0.0, 2.2, "d", dict(c="#24324a", lights=4)), (5.3, 1.6, 0.8, 1.4, "w", dict(cu=True)),
               (1.6, 1.1, 3.6, 1.2, "w", dict(cu=True)), (4.9, 2.2, 3.6, 1.2, "w", dict(cu=True))],
        roof_windows=[(2.5, 2.4)], front_wall=dict(h=0.55, tint="#cdb68e", piers=False)),
    "se_gable": dict(  # joined to it on the east: red brick under a steep gable to the street
        at=(775.5, -700.0), depth=8.5, eaves=4.6, ridge=8.9, roof="front_gable", roof_tint="#3f4347", wall="brick", tint="#b3573f",
        plinth=(0.3, "#5a4c44"), frame=WHITE, verge=WHITE,
        front=[(2.4, 1.9, 0.75, 1.35, "w", dict(cu=True)), (2.5, 1.25, 3.7, 0.95, "w", {})], chimneys=[dict(s=0.4, d=5.0, w=0.5, h=1.0)]),
    "se_pair_west": dict(  # a red brick pair with solar panels; this half anthracite frames
        at=(788.4, -696.0), depth=7.5, eaves=5.8, ridge=9.4, roof="gable", roof_tint="#3a3d41", wall="brick", tint="#b05a42",
        plinth=(0.5, "#6f6c68", "stone"), frame=ANTH, solar=dict(s=(0.4, 5.6), rows=2),
        front=[(1.9, 1.6, 0.8, 1.35, "w", dict(sh=0.2, box=True, cu=True)), (4.9, 1.0, 0.0, 2.2, "d", dict(c=ANTH)),
               (1.9, 1.4, 3.6, 1.2, "w", dict(sh=0.6, box=True)), (4.6, 0.7, 3.6, 1.2, "w", {})],
        chimneys=[dict(s=0.5, d=3.7, w=0.6, h=1.2)]),
    "se_pair_east": dict(  # the other half, white frames and a white door
        at=(793.4, -694.2), depth=7.5, eaves=5.8, ridge=9.4, roof="gable", roof_tint="#3a3d41", wall="brick", tint="#b9654a",
        plinth=(0.5, "#6f6c68", "stone"), frame=WHITE, solar=dict(s=(0.4, 5.7), rows=2),
        front=[(1.1, 1.0, 0.0, 2.2, "d", dict(c=WHITE)), (4.2, 1.6, 0.8, 1.35, "w", dict(sh=0.15, box=True, cu=True)),
               (1.5, 0.7, 3.6, 1.2, "w", {}), (4.3, 1.4, 3.6, 1.2, "w", dict(sh=0.5, box=True))],
        chimneys=[dict(s=5.6, d=3.7, w=0.6, h=1.2)]),
    # North side (-z). From the church end.
    "n_pantile": dict(  # dark red-brown brick, orange pantiles, round-headed windows upstairs
        at=(718.8, -744.2), depth=8.5, eaves=5.3, ridge=9.2, roof="gable", roof_tint="#b0583a", wall="brick", tint="#8a4a3a",
        plinth=(0.4, "#5b5752", "stone"), frame=WHITE,
        front=[(1.9, 2.0, 0.6, 1.6, "w", dict(surround=0.2, sc="#9a9792", cu=True)), (4.6, 1.0, 0.0, 2.4, "ad", dict(c=WHITE)),
               (1.9, 0.9, 3.2, 1.4, "a", dict(cu=True)), (4.4, 0.9, 3.2, 1.4, "a", dict(cu=True))],
        roof_windows=[(3.2, 2.2)]),
    "n_bands": dict(  # 1970s: light brick with a dark band, the upper floor over a porch, a low hipped roof
        at=(729.7, -744.8), depth=10.4, rect=[[725.36, -735.66], [731.18, -735.34], [731.77, -745.82], [725.95, -746.15]], eaves=6.4, ridge=8.6, roof="hip", roof_tint="#3c3e42", wall="brick", tint="#cdbb95",
        plinth=(0.3, "#5a4e44"), frame=BLACK, bands=[(2.95, 0.55, "#6e5848"), (5.6, 0.25, "#6e5848")], porch=dict(s=(2.6, 5.9), depth=1.6, h=2.85),
        front=[(1.3, 1.6, 0.6, 1.5, "w", dict(cu=True)), (4.5, 1.0, 0.0, 2.2, "d", dict(c="#3f6b4f", recess=1.6)),
               (3.5, 3.6, 3.65, 1.3, "w", dict(f=BLACK))]),
    "n_pair_west": dict(  # a red brick pair; this half darker brick and anthracite
        at=(743.3, -742.3), depth=9.0, eaves=5.9, ridge=9.9, roof="gable", roof_tint="#4b4d51", wall="brick", tint="#9e4a38",
        plinth=(0.35, "#5c5853", "stone"), frame=ANTH,
        front=[(2.2, 1.9, 0.75, 1.45, "w", dict(cu=True)), (5.4, 1.0, 0.0, 2.25, "d", dict(c=ANTH, glass_strip=True)),
               (1.9, 1.3, 3.55, 1.25, "w", {}), (4.6, 1.1, 3.55, 1.25, "w", {})],
        chimneys=[dict(s=0.5, d=4.5, w=0.6, h=1.2)]),
    "n_pair_east": dict(  # the other half: orange-red brick, white door and frames
        at=(749.3, -743.6), depth=9.0, eaves=5.9, ridge=9.9, roof="gable", roof_tint="#4b4d51", wall="brick", tint="#c06a4c",
        plinth=(0.35, "#5c5853", "stone"), frame=WHITE,
        front=[(1.3, 1.0, 0.0, 2.25, "d", dict(c=WHITE)), (2.3, 0.35, 0.6, 1.6, "w", {}), (4.1, 1.6, 0.75, 1.45, "w", dict(cu=True)),
               (1.5, 1.0, 3.55, 1.25, "w", {}), (4.0, 1.6, 3.55, 1.25, "w", dict(cu=True))],
        chimneys=[dict(s=5.1, d=4.5, w=0.6, h=1.2)]),
    "n_cube": dict(  # a white rendered cube with a flat roof and a carport
        at=(760.8, -741.1), depth=None, eaves=6.5, roof="flat", wall="render", tint="#f3f2ee", frame=BLACK, coping="#d9d8d3",
        front=[(1.7, 1.4, 3.3, 2.4, "w", {}), (1.7, 1.0, 0.0, 2.3, "d", dict(c=BLACK))],
        carport=dict(s=(0.0, 4.6), depth=4.7, h=3.0), faces=[dict(near=(758.3, -732.6), openings=[(1.7, 1.2, 0.8, 1.5, "w", {}), (1.7, 2.2, 3.6, 1.4, "w", {})])]),
    "n_bungalow_west": dict(  # a beige brick bungalow, a white fascia on its flat roof
        at=(777.5, -736.6), depth=None, eaves=3.55, roof="flat", wall="brick", tint="#d6c4a0", fascia=dict(h=0.38, over=0.45, tint="#efede8"),
        plinth=(0.45, "#5a4a3e"), frame=BROWN,
        front=[(1.5, 1.6, 0.85, 1.25, "w", dict(cu=True)), (4.0, 1.6, 0.85, 1.25, "w", dict(cu=True)), (6.5, 1.6, 0.85, 1.25, "w", dict(cu=True))],
        chimneys=[dict(s=4.5, d=6.0, w=0.6, h=0.9)]),
    "n_bungalow_east": dict(
        at=(785.6, -735.1), depth=None, eaves=3.55, roof="flat", wall="brick", tint="#d6c4a0", fascia=dict(h=0.38, over=0.45, tint="#efede8"),
        plinth=(0.45, "#5a4a3e"), frame=BROWN,
        front=[(1.5, 1.6, 0.85, 1.25, "w", dict(cu=True)), (4.0, 1.6, 0.85, 1.25, "w", dict(cu=True)), (6.5, 1.6, 0.85, 1.25, "w", dict(cu=True))],
        chimneys=[dict(s=3.5, d=6.0, w=0.6, h=0.9)]),
    "n_slate": dict(  # grey-brown brick, a steep slate roof, black frames with black shutters beside them
        at=(801.4, -733.5), depth=10.0, eaves=4.4, ridge=10.4, roof="gable", roof_tint="#4c5054", wall="brick", tint="#8f8478",
        plinth=(0.45, "#55524e"), frame=BLACK, shutters="#1f2022",
        front=[(1.8, 1.6, 0.8, 1.35, "w", dict(cu=True)), (4.6, 1.0, 0.0, 2.2, "d", dict(c=BLACK)),
               (6.0, 1.6, 0.8, 1.35, "w", dict(cu=True)), (6.0, 1.3, 3.35, 1.1, "w", {})],
        dormer=dict(s=2.2, w=2.6, h=1.6), front_gable=dict(s=(4.4, 7.7), top=9.8, apex_tint="#c98f7e")),
}

# The second survey (31 Oct 2026): the rest of Molenhoek on the map, down to the church square and on to the
# junction where the map ends. West of the portal Street View has images of August 2026; east of x = 790 the
# newest are of 2009 and 2019, so those houses are described as they were then. `front` as a dict lays the
# openings out evenly along the front: per floor a list of kinds (w window, W wide window, n narrow window,
# d door, g garage door); options as above. A negative s (in `front`, `porch`, `front_gable`, `chimneys`) is
# measured from the front's east end. `laser`: a house past the edge of the village data, its outline from the
# GRB and its ground from the relief; its heights are read off Street View and checked against the laser scan.
RED, RED2, REDBROWN, BROWNBRICK, GREYBROWN, TAUPE, CREAM = "#bc6650", "#b05f48", "#a35b47", "#a18068", "#9a8f83", "#a89a8a", "#ddcca8"
ROOF_DARK, ROOF_ORANGE, ROOF_SLATE = "#474a4e", "#b45c3c", "#50555a"
MORE = {
    # West of the portal, the south side (Street View, August 2026).
    "sw_newbuild_west": dict(  # a new build: a brown-grey brick upper floor over a black ground floor, a flat roof
        at=(647.5, -720.8), depth=None, eaves=6.6, roof="flat", wall="brick", tint="#94877a", coping="#3a3c3e",
        plinth=(3.0, "#34373a", "render"), frame=BLACK,
        front=[(-3.4, 3.6, 0.0, 2.6, "w", dict(f=BLACK)), (-8.0, 1.1, 0.0, 2.3, "d", dict(c="#2b2d2f")),
               (-3.2, 1.3, 3.4, 2.4, "w", dict(f=BLACK)), (-6.2, 0.5, 3.6, 2.0, "w", dict(f=BLACK))]),
    "sw_newbuild_east": dict(  # its other half: pale cream brick, a recessed entry, a deep window band, a dark roof
        at=(655.4, -719.1), depth=9.0, eaves=6.3, ridge=9.2, roof="gable", roof_tint="#2f3235", wall="brick", tint=CREAM, frame=BLACK,
        porch=dict(s=(0.4, 3.4), depth=1.3, h=2.6), solar=dict(s=(0.4, -0.4), rows=2),
        front=[(1.9, 1.0, 0.0, 2.3, "d", dict(c="#2b2d2f", recess=1.3)), (-1.6, 1.6, 0.6, 1.6, "w", dict(f=BLACK)),
               (3.6, 5.0, 3.45, 1.35, "w", dict(f=BLACK, surround=0.25, sc="#c9b894"))]),
    "sw_older_beige": dict(  # a taupe brick house of two floors, roller shutters; a flat-roofed workshop behind it
        at=(665.4, -720.5), depth=9.0, eaves=5.9, ridge=9.1, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=TAUPE, frame=WHITE,
        plinth=(0.4, "#5f5a55"), front=dict(ground=["w", "d", "w"], first=["w", "w"], sh=0.3, door=BROWN), chimneys=[dict(s=0.6, d=4.5, w=0.6, h=1.0)]),
    "sw_white_gable": dict(  # white render under a steep dark roof with a gable to the street; a red brick garage beside it
        at=(682.9, -716.0), depth=8.5, eaves=4.4, ridge=9.4, roof="gable", roof_tint="#34373a", wall="render", tint="#f2f1ed", frame=ANTH,
        front_gable=dict(s=(0.2, 4.4), top=9.0, apex_tint="#f2f1ed"),
        front=[(1.2, 1.0, 0.0, 2.2, "d", dict(c=ANTH)), (3.1, 1.8, 0.7, 1.4, "w", {}), (2.3, 1.4, 3.3, 1.1, "w", {})]),
    # West of the portal, the north side.
    "n_tall_gable": dict(  # a narrow tall house in red brick, its pointed gable to the street, a stone band
        at=(642.5, -756.2), depth=9.5, eaves=6.6, ridge=10.6, roof="front_gable", roof_tint=ROOF_DARK, wall="brick", tint=RED, frame=WHITE,
        plinth=(0.45, "#5f5b56", "stone"), bands=[(2.95, 0.18)],
        front=[(1.2, 1.0, 0.0, 2.3, "d", dict(c=WHITE)), (-1.9, 2.0, 0.6, 1.7, "w", dict(cu=True)),
               (1.2, 1.0, 3.3, 1.4, "w", dict(sh=1.0, box=True)), (-3.0, 1.0, 3.3, 1.4, "w", dict(cu=True)), (-1.4, 1.0, 3.3, 1.4, "w", {}),
               (-2.4, 0.8, 6.6, 1.0, "w", {})]),
    "n_long_shop": dict(  # a long low red brick house and shop under a dark roof: shop windows, a roller shutter, a vending machine
        at=(654.7, -752.4), depth=8.5, eaves=3.4, ridge=6.8, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=RED2, frame=WHITE,
        plinth=(0.4, "#5f5b56", "stone"), eave_board=0.35, vending=7.0,
        front=dict(ground=["W", "d", "w", "W", "W", "d"], cu=True, sh=0.0)),
    "n_arched": dict(  # a large old house in red brick: stone surrounds, a stone band, black frames, a gate beside it
        at=(681.7, -743.1), depth=9.0, eaves=7.1, ridge=12.2, roof="gable", roof_tint=ROOF_SLATE, wall="brick", tint=RED2, frame=BLACK,
        plinth=(0.5, "#5f5b56", "stone"), bands=[(3.55, 0.22)], chimneys=[dict(s=0.7, d=4.5, w=0.7, h=1.3), dict(s=-0.7, d=4.5, w=0.7, h=1.3)],
        front=[(1.6, 1.1, 0.8, 2.0, "w", dict(surround=0.16, sc="#cbc5b8")), (-6.0, 1.3, 0.0, 2.9, "d", dict(c="#2a2b2c", surround=0.16, sc="#cbc5b8")),
               (-1.6, 1.1, 0.8, 2.0, "w", dict(surround=0.16, sc="#cbc5b8")),
               (1.6, 1.1, 4.1, 1.8, "w", dict(surround=0.16, sc="#cbc5b8")), (-6.0, 1.1, 4.1, 1.8, "w", dict(surround=0.16, sc="#cbc5b8", cu=True)),
               (-1.6, 1.1, 4.1, 1.8, "w", dict(surround=0.16, sc="#cbc5b8"))]),
    "n_brown_pantile": dict(  # brown-red brick, orange pantiles, wide windows with brown frames
        at=(700.0, -741.8), depth=8.0, eaves=5.0, ridge=8.6, roof="gable", roof_tint=ROOF_ORANGE, wall="brick", tint="#ad6a50", frame=BROWN,
        plinth=(0.4, "#5f5b56"), front=dict(ground=["W", "d", "W"], first=["w", "w", "w"], door="#4a2f24", cu=True)),
    "n_black_frames": dict(  # red brick done up: an anthracite roof, black frames; a garage in a low link beside it
        at=(711.6, -743.0), depth=8.5, eaves=6.0, ridge=9.8, roof="gable", roof_tint="#34373a", wall="brick", tint=RED, frame=BLACK,
        front=dict(ground=["w", "w", "d"], first=["w", "w", "w"], door=BLACK)),
    # East of the portal, the south side (Street View of 2019).
    "se_narrow_brown": dict(  # a narrow house in brown-beige brick, white roller shutters, a chimney at its east end
        at=(801.7, -689.8), depth=8.0, eaves=6.4, ridge=9.6, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=BROWNBRICK, frame=WHITE,
        eave_board=0.3, front=dict(ground=["d", "w"], first=["w", "w"], sh=0.5, door=BROWN), chimneys=[dict(s=-0.4, d=4.0, w=0.6, h=1.0)]),
    "se_gable_dormer": dict(  # red-brown brick, a steep gable dormer over its west half, a french balcony
        at=(823.8, -672.9), depth=9.0, eaves=6.0, ridge=10.3, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=REDBROWN, frame=WHITE,
        front_gable=dict(s=(0.3, 4.3), top=9.6, apex_tint=REDBROWN), front=dict(ground=["W", "d"], first=["w", "w"], door="#2e4a36", cu=True)),
    "se_cornice": dict(  # red brick, a white cornice along the top of its front, white frames and shutters
        at=(831.2, -687.4), depth=9.0, eaves=6.8, ridge=9.6, roof="hip", roof_tint=ROOF_DARK, wall="brick", tint=RED, frame=WHITE,
        plinth=(0.5, "#6a6762", "stone"), bands=[(6.5, 0.3)], front=dict(ground=["d", "W"], first=["w", "W"], sh=0.4, door=WHITE)),
    "se_pair2_west": dict(  # a pair under one slate roof: this half red-brown, a white door, a french balcony
        at=(845.9, -685.5), depth=9.0, eaves=6.6, ridge=10.6, roof="gable", roof_tint=ROOF_SLATE, wall="brick", tint=REDBROWN, frame=WHITE,
        front=dict(ground=["W", "d"], first=["w", "w"], sh=0.3, door=WHITE), chimneys=[dict(s=0.5, d=4.5, w=0.6, h=1.1)]),
    "se_pair2_east": dict(  # the other half, red brick with a gable dormer
        at=(852.0, -685.3), depth=9.0, eaves=6.6, ridge=10.6, roof="gable", roof_tint=ROOF_SLATE, wall="brick", tint=RED, frame=WHITE,
        front_gable=dict(s=(-4.4, -0.8), top=10.0, apex_tint=RED), front=dict(ground=["d", "W"], first=["w", "w"], sh=0.4, door=WHITE),
        chimneys=[dict(s=-0.5, d=4.5, w=0.6, h=1.1)]),
    # Past the edge of the village data, the south side, up to the junction (Street View of 2019).
    "se_bay_pair_west": dict(  # a pair: this half red-brown brick, a pointed gable in the middle, a bay with a slate canopy
        at=(864.4, -677.5), laser=True, depth=9.0, eaves=6.0, ridge=10.0, roof="gable", roof_tint=ROOF_SLATE, wall="brick", tint=REDBROWN, frame=WHITE,
        front_gable=dict(s=(1.2, 5.0), top=9.4, apex_tint=REDBROWN), canopy=dict(s=(0.8, 3.6), y=2.6),
        front=dict(ground=["W", "d"], first=["w", "w"], cu=True, door=WHITE)),
    "se_bay_pair_east": dict(  # the other half, plain red brick, white shutters
        at=(870.2, -680.1), laser=True, depth=9.0, eaves=6.0, ridge=10.0, roof="gable", roof_tint=ROOF_SLATE, wall="brick", tint=RED, frame=WHITE,
        front=dict(ground=["d", "W"], first=["w", "w"], sh=0.5, door=WHITE)),
    "se_twin_west": dict(whole=True,   # a red-brown brick pair with a steep gable at either outer end, white verges and frames
        at=(882.1, -673.7), laser=True, depth=9.0, eaves=5.4, ridge=9.6, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=REDBROWN, frame=WHITE,
        front_gable=dict(s=(0.0, 3.6), top=9.4, apex_tint=REDBROWN), verge=WHITE,
        front=dict(ground=["w", "d"], first=["w", "w"], door=ANTH, cu=True)),
    "se_twin_east": dict(whole=True, 
        at=(887.3, -673.8), laser=True, depth=9.0, eaves=5.4, ridge=9.6, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=REDBROWN, frame=WHITE,
        front_gable=dict(s=(-3.6, 0.0), top=9.4, apex_tint=REDBROWN), verge=WHITE,
        front=dict(ground=["d", "w"], first=["w", "w"], door=WHITE, cu=True)),
    "se_corner_west": dict(whole=True,   # the same kind of pair on the corner of the junction
        at=(899.6, -667.5), laser=True, depth=9.0, eaves=5.4, ridge=9.6, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=RED2, frame=WHITE,
        front_gable=dict(s=(0.0, 3.6), top=9.4, apex_tint=RED2), front=dict(ground=["w", "d"], first=["w", "w"], door=BROWN)),
    "se_corner_east": dict(whole=True, 
        at=(905.1, -669.1), laser=True, depth=9.0, eaves=5.4, ridge=9.6, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=RED2, frame=WHITE,
        front_gable=dict(s=(-3.6, 0.0), top=9.4, apex_tint=RED2), front=dict(ground=["d", "w"], first=["w", "w"], door=BROWN)),
    # East of the portal, the north side (Street View of 2019).
    "n_oculus": dict(  # red-brown brick, a steep gable to the street with a round window, an arched garage door, orange pantiles
        at=(808.5, -730.2), depth=9.5, eaves=4.2, ridge=10.2, roof="front_gable", roof_tint=ROOF_ORANGE, wall="brick", tint=REDBROWN, frame=BROWN,
        oculus=dict(y=7.6, r=0.45), front=[(-3.0, 2.6, 0.0, 2.4, "g", dict(c="#6a442c", arch=True)), (-4.2, 1.0, 3.4, 1.3, "w", dict(cu=True)),
                                          (-1.8, 1.0, 3.4, 1.3, "w", dict(cu=True)), (1.4, 1.4, 0.8, 1.4, "w", dict(cu=True))]),
    "n_orange_row": dict(  # a row of three: this one red brick under orange tiles, green frames
        at=(823.6, -728.9), depth=9.0, eaves=6.4, ridge=10.0, roof="gable", roof_tint=ROOF_ORANGE, wall="brick", tint=RED, frame="#3f6b4a",
        front=dict(ground=["W", "d"], first=["w", "w"], cu=True, door="#3f6b4a")),
    "n_farm_shop": dict(  # the middle one: red brick, a dark roof, white frames, an open garage where they sell from the farm
        at=(832.5, -723.0), depth=9.0, eaves=6.4, ridge=10.0, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=RED2, frame=WHITE,
        porch=dict(s=(-4.0, -1.0), depth=2.4, h=2.6),
        front=[(1.4, 1.0, 0.0, 2.2, "d", dict(c=WHITE)), (3.4, 1.8, 0.8, 1.4, "w", dict(cu=True)),
               (1.8, 1.3, 3.6, 1.2, "w", {}), (-2.5, 1.6, 3.6, 1.2, "w", dict(cu=True))]),
    "n_grey_unit": dict(  # the third: grey-brown brick, a white door, roller shutters
        at=(841.0, -727.5), depth=9.0, eaves=6.3, ridge=10.0, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=GREYBROWN, frame=WHITE,
        front=dict(ground=["d", "W"], first=["w", "w"], sh=0.5, door=WHITE)),
    "n_pair3_west": dict(  # a pair under one big dark roof: this half grey-brown brick, white frames
        at=(855.2, -730.3), depth=9.0, eaves=6.4, ridge=10.6, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=GREYBROWN, frame=WHITE,
        front=dict(ground=["w", "w", "d"], first=["w", "w", "w"], door=BROWN), chimneys=[dict(s=0.5, d=4.5, w=0.6, h=1.0)]),
    "n_pair3_east": dict(  # the other half: red brick, its windows framed in a darker brick, a white door
        at=(860.7, -720.7), depth=9.0, eaves=6.4, ridge=10.6, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=RED, frame=WHITE, lintels=True,
        front=dict(ground=["d", "W"], first=["w", "W"], door=WHITE, cu=True), chimneys=[dict(s=-0.5, d=4.5, w=0.6, h=1.0)]),
    # Past the edge of the village data, the north side, up to the junction.
    "n_plain_west": dict(  # blurred in Street View at the owners' request: only its brick and roof, plain windows
        at=(875.3, -716.9), laser=True, depth=9.0, eaves=6.0, ridge=9.8, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=RED, frame=WHITE,
        front=dict(ground=["w", "d", "w"], first=["w", "w"])),
    "n_plain_east": dict(  # red brick, a dark roof
        at=(881.2, -713.5), laser=True, depth=9.0, eaves=6.0, ridge=9.8, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=RED2, frame=WHITE,
        front=dict(ground=["W", "d"], first=["w", "w"], sh=0.4, door=BROWN)),
    "n_corner_west": dict(  # a pair on the corner of the junction: this half grey-brown brick, white frames
        at=(895.3, -714.5), laser=True, depth=9.0, eaves=6.0, ridge=9.8, roof="gable", roof_tint=ROOF_DARK, wall="brick", tint=GREYBROWN, frame=WHITE,
        front=dict(ground=["w", "d"], first=["w", "w"], door=WHITE)),
    "n_corner_east": dict(  # the other half: red brick, a steep gable to the street, white shutters beside the windows
        at=(901.7, -715.0), laser=True, depth=9.0, eaves=4.8, ridge=9.8, roof="front_gable", roof_tint=ROOF_DARK, wall="brick", tint=RED, frame=WHITE,
        shutters="#f0efeb", front=[(-1.8, 1.3, 0.8, 1.4, "w", {}), (1.6, 1.0, 0.0, 2.2, "d", dict(c=WHITE)), (-2.6, 1.2, 3.4, 1.2, "w", {})]),
}
HOUSES.update(MORE)

# The street's furniture (model x, z), from the survey: the island where the new stretch ends towards
# the church, the hydrant, the electricity cabinet, the warning sign for a school route.
PROPS = [
    {"k": "island", "x": 691.5, "d": -3.55, "len": 6.0, "w": 1.3},  # on the north side, where the cycle lane ends: clear of the carriageway
    {"k": "cabinet", "at": [764.0, -728.0]},
    {"k": "sign_children", "x": 742.2, "side": -1, "behind": 0.35},  # just behind the pavement, clear of the walking line
]


class Relief:
    """The relief as the browser has it (web/shared/terrain.json, tools/terrain.py): metres above the plot's ground."""

    def __init__(self):
        d = json.loads((ROOT / "web" / "shared" / "terrain.json").read_text(encoding="utf-8"))
        digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        value = {c: k for k, c in enumerate(digits)}
        s, rest, k = d["d"], [], 0
        while k < len(s):
            if s[k] == "~":
                rest.append(((value[s[k + 1]] << 12) | (value[s[k + 2]] << 6) | value[s[k + 3]]) - (1 << 17))
                k += 4
            else:
                rest.append(value[s[k]] - 32)
                k += 1
        import numpy as np
        self.d = d
        self.g = np.array(rest, np.int64).reshape(d["nz"], d["nx"]).cumsum(1).cumsum(0) / 100.0

    def height(self, x, z):
        d, g = self.d, self.g
        fx = min(max((x - d["x0"]) / d["step"], 0.0), d["nx"] - 1.000001)
        fz = min(max((z - d["z0"]) / d["step"], 0.0), d["nz"] - 1.000001)
        i, j = int(fx), int(fz)
        u, v = fx - i, fz - j
        h00, h11 = g[j, i], g[j + 1, i + 1]
        if u >= v:
            return float(h00 + u * (g[j, i + 1] - h00) + v * (h11 - g[j, i + 1]))
        return float(h00 + v * (g[j + 1, i] - h00) + u * (h11 - g[j + 1, i]))


def layout(h, L):
    """The openings of a front L m long: as listed (a negative s counted from the east end), or laid out evenly
    from a pattern per floor."""
    f = h["front"]
    if isinstance(f, list):
        return [[s_ + L if s_ < 0 else s_, w, y, hh, kind, opt] for s_, w, y, hh, kind, opt in f]
    out = []
    floors = [("ground", 0)] + ([("first", 1)] if h["eaves"] > 4.9 else [])
    for name, row in floors:
        kinds = f.get(name, [])
        for i, k in enumerate(kinds):
            s_ = 0.6 + (L - 1.2) * (i + 0.5) / len(kinds)
            opt = {}
            if f.get("cu") and (i + row) % 2 == 0:
                opt["cu"] = True
            if k == "d":
                out.append([s_, 1.0, 0.0, 2.2, "d", {"c": f.get("door", "#5a4334")}])
            elif k == "g":
                out.append([s_, 2.5, 0.0, 2.2, "g", {"c": f.get("garage", "#e9e8e4")}])
            else:
                w = {"W": 1.9, "n": 0.6}.get(k, 1.25)
                y, hh = (0.8, 1.4) if row == 0 else (3.6, 1.25)
                if f.get("sh") and k != "n":
                    opt.update(sh=f["sh"] * (1 if (i + row) % 2 else 0.6), box=True)
                out.append([s_, w, y, hh, "w", opt])
    return out


def main():
    _, _, to_model = model_frame()
    model = lambda g: affine_transform(g, to_model)
    # The centre lines: Molenhoek's pieces merged. The main line runs from the church square (MIN_X) past the
    # portal to the junction where the map ends and on along the branch that carries on east (to MAX_X); the
    # stub is the first STUB metres of the branch that turns off there.
    pieces = [model(LineString(f["geometry"]["coordinates"])) for f in features("Wegsegment")
              if f["properties"]["LSTRNM"] == "Molenhoek" and f["geometry"]["type"] == "LineString"]
    merged = linemerge(unary_union(pieces))
    lines = list(getattr(merged, "geoms", [merged]))
    west0 = min(lines, key=lambda l: l.distance(Point(746.0, -720.0)))
    west = west0
    if west.coords[0][0] > west.coords[-1][0]:
        west = LineString(west.coords[::-1])
    junction = Point(west.coords[-1])
    branches = [l if Point(l.coords[0]).distance(junction) < 0.5 else LineString(l.coords[::-1]) for l in lines if l is not west0]
    branches = [l for l in branches if Point(l.coords[0]).distance(junction) < 0.5]
    east = min(branches, key=lambda l: abs(l.coords[-1][1] - junction.y) / max(1.0, abs(l.coords[-1][0] - junction.x)))  # the straight one
    stub = next(l for l in branches if l is not east)
    line = LineString(list(west.coords) + list(east.coords)[1:])

    def sample(l, s0, s1):
        out, s = [], s0
        while s <= min(s1, l.length) + 1e-6:
            out.append(l.interpolate(s))
            s += STEP
        return out

    pts = [p for p in sample(line, 0.0, line.length) if MIN_X <= p.x <= MAX_X]
    stub_pts = sample(stub, 0.0, STUB)
    plots = unary_union([model(p) for f in features("ADP") for p in polygons(f["geometry"])])

    def widths(ps):
        left, right = [], []
        for k, p in enumerate(ps):
            a, b = ps[max(0, k - 1)], ps[min(len(ps) - 1, k + 1)]
            n = math.hypot(b.x - a.x, b.y - a.y)
            nx, nz = -(b.y - a.y) / n, (b.x - a.x) / n  # the +z side when the line runs to +x
            for side, out in ((1, left), (-1, right)):
                ray = LineString([(p.x, p.y), (p.x + nx * side * REACH, p.y + nz * side * REACH)])
                hit = ray.intersection(plots)
                out.append(round(min((Point(p.x, p.y).distance(g) for g in getattr(hit, "geoms", [hit]) if not g.is_empty), default=REACH), 2))
        return left, right

    left, right = widths(pts)
    stub_left, stub_right = widths(stub_pts)
    centre = unary_union([LineString([(p.x, p.y) for p in pts]), LineString([(p.x, p.y) for p in stub_pts])])

    village = json.loads((ROOT / "web" / "src" / "data" / "village.json").read_text(encoding="utf-8"))
    walls = [(p, Polygon(p["p"][0])) for p in village["prisms"] if p["m"] in WALLS and "d" not in p]
    # Past the edge of the village data: the GRB's own buildings, as blocks of the same kind.
    grb = [Polygon(list(model(g).exterior.coords)) for f in features("GBG") for g in polygons(f["geometry"])]
    relief = Relief()
    feet = {}
    for key, h in HOUSES.items():
        at = Point(*h["at"])
        if h.get("laser"):
            poly = next((g for g in grb if g.contains(at)), None)
            if poly is None:
                raise SystemExit(f"{key}: no GRB building at {h['at']}")
            ground = min(relief.height(x, z) for x, z in poly.exterior.coords) + GROUND
            feet[key] = ({"y0": ground, "y1": ground + 3.0}, poly)
            continue
        base = [(p, poly) for p, poly in walls if poly.contains(at)]
        if not base:
            raise SystemExit(f"{key}: no block at {h['at']}")
        feet[key] = min(base, key=lambda b: b[0]["y0"])
    others = [poly for p, poly in walls] + [g for g in grb if g.centroid.x > 855]  # past the edge of the village data: the GRB's
    houses = {}
    for key, h in HOUSES.items():
        foot, poly = feet[key]
        poly = poly.buffer(0)
        # `whole`: the house is the rectangle round its outline (a stepped front the GRB draws in pieces)
        shape = poly.minimum_rotated_rectangle if h.get("whole") else poly
        ring = list(shape.exterior.coords)[:-1]
        # The front wall: the longest edge facing the street, within 22 m of the centre line.
        best = None
        for i in range(len(ring)):
            a, b = ring[i], ring[(i + 1) % len(ring)]
            L = math.dist(a, b)
            if L < 2.5:
                continue
            mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            nx, nz = (b[1] - a[1]) / L, -(b[0] - a[0]) / L
            if shape.contains(Point(mx + nx * 0.2, mz + nz * 0.2)):
                nx, nz = -nx, -nz
            q = nearest_points(centre, Point(mx, mz))[0]
            dx, dz = q.x - mx, q.y - mz
            dist = math.hypot(dx, dz)
            face = (nx * dx + nz * dz) / max(dist, 1e-6)
            if dist < 24 and face > 0.55:
                score = L * face - 0.15 * dist
                if best is None or score > best[0]:
                    best = (score, a, b, (nx, nz))
        if h.get("rect"):  # given: the front wall's west and east ends, then the back corners
            r = h["rect"]
            a, b = tuple(r[0]), tuple(r[1])
            L = math.dist(a, b)
            o = ((b[1] - a[1]) / L, -(b[0] - a[0]) / L)
            if Polygon(r).contains(Point((a[0] + b[0]) / 2 + o[0] * 0.2, (a[1] + b[1]) / 2 + o[1] * 0.2)):
                o = (-o[0], -o[1])
            best = (0, a, b, o)
        if best is None:
            raise SystemExit(f"{key}: no wall facing the street")
        _, a, b, o = best
        if a[0] > b[0]:
            a, b = b, a
        n = (-o[0], -o[1])
        if h.get("rect"):
            main = Polygon(h["rect"])
        elif h.get("whole"):
            main = shape
        elif h["depth"]:
            main = Polygon([a, b, (b[0] + n[0] * h["depth"], b[1] + n[1] * h["depth"]), (a[0] + n[0] * h["depth"], a[1] + n[1] * h["depth"])])
            main = main.intersection(poly).buffer(0)
            if main.geom_type != "Polygon":
                main = max(main.geoms, key=lambda g: g.area)
            main = main.minimum_rotated_rectangle
        else:
            main = poly
        rest = poly.difference(main.buffer(0.05, join_style=2)).buffer(0)
        annex = [g for g in getattr(rest, "geoms", [rest]) if g.area > 3]
        # Heights: the village block's foot, as the relief; the lower parts as high as the village's lowest block.
        y0 = foot["y0"] - GROUND
        low = foot["y1"] - foot["y0"]
        mine = poly.buffer(0.2)
        neighbours = unary_union([q.buffer(0.3) for q in others if not mine.contains(q.representative_point()) and q.distance(poly) < 0.5])
        def against(ring):
            out = []
            for i in range(len(ring)):
                e = LineString([ring[i], ring[(i + 1) % len(ring)]])
                out.append(bool(not neighbours.is_empty and e.intersection(neighbours).length > 0.6 * e.length))
            return out
        main_ring = [list(map(lambda v: round(v, 3), c)) for c in list(main.exterior.coords)[:-1]]
        Lf = math.dist(a, b)
        fix = lambda v: v + Lf if v < 0 else v
        h = dict(h)
        for k_ in ("porch", "front_gable", "solar"):
            if h.get(k_):
                h[k_] = {**h[k_], "s": [fix(h[k_]["s"][0]), fix(h[k_]["s"][1]) if h[k_]["s"][1] != 0 or h[k_]["s"][0] >= 0 else Lf]}
        if h.get("chimneys"):
            h["chimneys"] = [{**c, "s": fix(c["s"])} for c in h["chimneys"]]
        houses[key] = {
            **{k: v for k, v in h.items() if k not in ("at",)},
            "at": list(h["at"]), "y0": round(y0, 3), "low": round(low, 2),
            "front": [[round(a[0], 3), round(a[1], 3)], [round(b[0], 3), round(b[1], 3)]], "out": [round(o[0], 4), round(o[1], 4)],
            "outline": [[round(x, 3), round(z, 3)] for x, z in ring],
            "main": main_ring, "main_party": against(main_ring),
            "annex": [{"p": [[round(x, 3), round(z, 3)] for x, z in list(g.exterior.coords)[:-1]],
                       "party": against(list(g.exterior.coords)[:-1])} for g in annex],
            "openings": layout(h, math.dist(a, b)),
        }
        houses[key].pop("front", None)
        houses[key]["front"] = [[round(a[0], 3), round(a[1], 3)], [round(b[0], 3), round(b[1], 3)]]
    OUT.write_text(json.dumps({
        "_source": "GRB Wegsegment and ADP (Digitaal Vlaanderen, open data); the houses' plans from web/src/data/village.json; "
                   "their looks from a Street View survey (August 2026), described here, no images",
        "line": [[round(p.x, 2), round(p.y, 2)] for p in pts], "left": left, "right": right, "houses": houses, "props": PROPS,
        "stub": {"line": [[round(p.x, 2), round(p.y, 2)] for p in stub_pts], "left": stub_left, "right": stub_right},
    }, indent=None, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(pts)} points, {len(houses)} houses")
    for key, h in houses.items():
        L = math.dist(*h["front"])
        print(f"  {key:16s} front {L:5.2f} m  y0 {h['y0']:5.2f}  low {h['low']:4.2f}  annexes {len(h['annex'])}  party {h['main_party']}")


if __name__ == "__main__":
    main()
