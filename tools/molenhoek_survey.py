"""The street Molenhoek round its portal: the survey, and the plan tools/molenhoek.py builds on.

Run from the project root (needs source/geo/ from tools/geodata.py):
    tools/.venv/Scripts/python.exe tools/molenhoek_survey.py

Sources, used for measuring only (nothing of them is shipped):
- GRB Wegsegment (the centre line; the stretch past the portal has a version of February 2026,
  when the street was rebuilt) and ADP (the plots), Digitaal Vlaanderen, open data;
- web/src/data/village.json (tools/neighbours.py): each house's blocks, from the GRB outline and
  the laser scan's heights, so the model stands on the same plan as the blocks it replaces, which
  stay for walking into;
- Street View (August 2026), from the street only: what each house looks like (brick and its
  colour, bands and plinths, windows, doors, shutters and frames, roof and its colour, chimneys,
  dormers, solar panels) and the street itself: since 2026 a dark asphalt carriageway with a
  concrete gutter, a raised red cycle lane on either side, a kerb and a pavement of grey concrete
  pavers; slim steel lamp posts, no overhead cables; a traffic island with a keep-left sign where
  the new stretch ends towards the church; a fire hydrant on the pavement. Street View has no
  2026 images east of about x = 790, where the street looks the same as far as can be seen.
The houses are keyed by where they stand (model x, z) and named by position, never by number.

Writes data/molenhoek.json, in model coordinates (x, z):
- line: the centre line from MIN_X to MAX_X, a point every STEP metres, west to east; left and
  right: the free width either side up to the nearest plot (left is the +z side, the portal's);
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
from shapely.ops import linemerge, unary_union

from neighbours import features, model_frame, polygons

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "molenhoek.json"
MIN_X, MAX_X, STEP = 640.0, 900.0, 2.0
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

# The street's furniture (model x, z), from the survey: the island where the new stretch ends towards
# the church, the hydrant, the electricity cabinet, the warning sign for a school route.
PROPS = [
    {"k": "island", "x": 691.5, "d": -3.55, "len": 6.0, "w": 1.3},  # on the north side, where the cycle lane ends: clear of the carriageway
    {"k": "cabinet", "at": [764.0, -728.0]},
    {"k": "sign_children", "x": 742.2, "side": -1, "behind": 0.35},  # just behind the pavement, clear of the walking line
]


def main():
    _, _, to_model = model_frame()
    model = lambda g: affine_transform(g, to_model)
    # The centre line: Molenhoek's pieces merged, cut to the stretch, west to east, resampled.
    pieces = [model(LineString(f["geometry"]["coordinates"])) for f in features("Wegsegment")
              if f["properties"]["LSTRNM"] == "Molenhoek" and f["geometry"]["type"] == "LineString"]
    merged = linemerge(unary_union(pieces))
    lines = list(getattr(merged, "geoms", [merged]))
    box = Polygon([(MIN_X, -900), (MAX_X, -900), (MAX_X, -500), (MIN_X, -500)])
    line = max(lines, key=lambda l: l.intersection(box).length)
    if line.coords[0][0] > line.coords[-1][0]:
        line = LineString(line.coords[::-1])
    pts = []
    s = 0.0
    while s <= line.length:
        p = line.interpolate(s)
        if MIN_X <= p.x <= MAX_X:
            pts.append(p)
        s += STEP
    plots = unary_union([model(p) for f in features("ADP") for p in polygons(f["geometry"])])
    left, right = [], []
    for k, p in enumerate(pts):
        a, b = pts[max(0, k - 1)], pts[min(len(pts) - 1, k + 1)]
        n = math.hypot(b.x - a.x, b.y - a.y)
        nx, nz = -(b.y - a.y) / n, (b.x - a.x) / n  # the +z side when the line runs to +x
        for side, out in ((1, left), (-1, right)):
            ray = LineString([(p.x, p.y), (p.x + nx * side * REACH, p.y + nz * side * REACH)])
            hit = ray.intersection(plots)
            out.append(round(min((Point(p.x, p.y).distance(g) for g in getattr(hit, "geoms", [hit]) if not g.is_empty), default=REACH), 2))
    centre = LineString([(p.x, p.y) for p in pts])

    village = json.loads((ROOT / "web" / "src" / "data" / "village.json").read_text(encoding="utf-8"))
    walls = [(p, Polygon(p["p"][0])) for p in village["prisms"] if p["m"] in WALLS and "d" not in p]
    feet = {}
    for key, h in HOUSES.items():
        at = Point(*h["at"])
        base = [(p, poly) for p, poly in walls if poly.contains(at)]
        if not base:
            raise SystemExit(f"{key}: no block at {h['at']}")
        feet[key] = min(base, key=lambda b: b[0]["y0"])
    others = [poly for p, poly in walls]  # every building, for the walls against a neighbour
    houses = {}
    for key, h in HOUSES.items():
        foot, poly = feet[key]
        poly = poly.buffer(0)
        ring = list(poly.exterior.coords)[:-1]
        # The front wall: the longest edge facing the street, within 22 m of the centre line.
        best = None
        for i in range(len(ring)):
            a, b = ring[i], ring[(i + 1) % len(ring)]
            L = math.dist(a, b)
            if L < 2.5:
                continue
            mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            nx, nz = (b[1] - a[1]) / L, -(b[0] - a[0]) / L
            if poly.contains(Point(mx + nx * 0.2, mz + nz * 0.2)):
                nx, nz = -nx, -nz
            q = centre.interpolate(centre.project(Point(mx, mz)))
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
        houses[key] = {
            **{k: v for k, v in h.items() if k not in ("at",)},
            "at": list(h["at"]), "y0": round(y0, 3), "low": round(low, 2),
            "front": [[round(a[0], 3), round(a[1], 3)], [round(b[0], 3), round(b[1], 3)]], "out": [round(o[0], 4), round(o[1], 4)],
            "outline": [[round(x, 3), round(z, 3)] for x, z in ring],
            "main": main_ring, "main_party": against(main_ring),
            "annex": [{"p": [[round(x, 3), round(z, 3)] for x, z in list(g.exterior.coords)[:-1]],
                       "party": against(list(g.exterior.coords)[:-1])} for g in annex],
            "openings": [list(o_) for o_ in h["front"]],
        }
        houses[key].pop("front", None)
        houses[key]["front"] = [[round(a[0], 3), round(a[1], 3)], [round(b[0], 3), round(b[1], 3)]]
    OUT.write_text(json.dumps({
        "_source": "GRB Wegsegment and ADP (Digitaal Vlaanderen, open data); the houses' plans from web/src/data/village.json; "
                   "their looks from a Street View survey (August 2026), described here, no images",
        "line": [[round(p.x, 2), round(p.y, 2)] for p in pts], "left": left, "right": right, "houses": houses, "props": PROPS,
    }, indent=None, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(pts)} points, {len(houses)} houses")
    for key, h in houses.items():
        L = math.dist(*h["front"])
        print(f"  {key:16s} front {L:5.2f} m  y0 {h['y0']:5.2f}  low {h['low']:4.2f}  annexes {len(h['annex'])}  party {h['main_party']}")


if __name__ == "__main__":
    main()
