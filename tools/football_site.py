"""FC Smetlede's ground (Yoshi, 8 Nov 2026: "research the soccer field of the town. It is in the east"): the survey,
and the plan the game, tools/football.py (the Blender model) and tools/terrain.py build on: web/shared/football.json.

What is there (looked up on 8 November 2026):
- The club: FC Smetlede, a village club in red and white, founded in November 2009, in the provincial leagues of East
  Flanders (third provincial after winning fourth provincial in 2018-2019). Its ground, the Wellebeekstadion, is named
  after the brook along it, at the end of Schildekensstraat (nl.wikipedia.org "FC Smetlede"; OpenStreetMap: the pitch
  "FC Smetlede", way 113868973, and the canteen, way 656460936).
- The municipality's press release of 21 December 2023 (lede.be): the municipality bought the ground and the plot next
  to it in 2009; since then it replaced the ball-stop nets, the fences and the dressing-room containers, changed the
  floodlights over to LED and has a standing terrace in the works. The club asked for an artificial pitch: the pitch is
  natural grass, and there is one pitch (a second one was discussed, not built).
- The GRB (Digitaal Vlaanderen, open data, strip `e2` of tools/geodata.py): the long main building along the pitch
  (GBG OIDN 7778673, 55 by 6.5 m), the low building in front of its western end (GBG OIDN 7778780, 20.5 by 2.5 m) and
  a newer block behind that (GBG OIDN 6995671, 13 by 3 m); the paved lane from Schildekensstraat with the car park
  and the walk along the pitch's end (road surface WBN OIDN 116918, the lane is the street's last segment, Wegsegment
  OIDN 1192998); the pitch's plot (ADP OIDN 6071561); the Wellebeek beyond the far side (WTZ).
- The laser scan (DHM Vlaanderen II, 2013-2015): the main building's roof 3.3 to 3.45 m high on the pitch side and
  2.75 m at the back (a lean-to roof); the low building 2.5 to 2.9 m; the newer block and the red-roofed containers
  are not in it (built later). The pitch falls about a metre from the buildings to the far side; the meadows beyond
  fall to the brook.
- The orthophoto (25 cm, reference only): the pitch's lines measured on it: 100.0 by 55.15 m, turned 1.6 degrees off
  the game's x axis; the centre circle, penalty and goal areas at the standard sizes; a spectators' rail about 3.5 m
  outside the far touchline, a fence with a sand path outside it and a fence along the far end; two dugouts with red
  seats beside the halfway line in front of the buildings; a grey lean-to roof over the main building, a white roof
  over the low building, red roofs over containers at its far end, a paved yard beyond them; a light concrete walk
  along the pitch's end by the car park; the car park in dark asphalt, the lane in light concrete; and the
  floodlight masts, two on the far side, whose lean in the photo shows them 31.5 m either side of the halfway line,
  and two on the buildings' side.
- Not found, so made up in the same style: the buildings' fronts and doors, the masts' height (16 m, the usual for a
  village pitch), the ball-stop nets' size (6 m high behind both goals), what the dugouts and the low stand look like.
No people, no names of people, no club badge or sponsors: plain red and white.

The frame: `centre` the centre spot, `u` along the pitch from the far end (the brook's side, u < 0) to the car park's
end, `w` across it from the far side (w < 0) to the buildings' side. A point at (u, w) is centre + u * u + w * w.
Everything the model, the page and the ball share is measured in it here.

Run (from the project root, after tools/geodata.py --strip e2):
    tools/.venv/Scripts/python.exe tools/football_site.py
Then tools/terrain.py (it levels the ground's platform), tools/bounds.py and
    blender -b -P tools/football.py -- web/public/models/football.glb
"""
import json
import math
from pathlib import Path

import numpy as np
from shapely.affinity import affine_transform
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

from neighbours import (ACTIVE_STRIPS, FOOTBALL, TILE_X0, TILE_Y1, features, football, model_frame, polygons, raster)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "shared" / "football.json"

# The frame, measured on the orthophoto's lines (game x, z).
CENTRE = (-350.8, -1222.3)
ANGLE = math.atan2(0.0284, 0.9996)            # the long axis, off the game's +x
U = (math.cos(ANGLE), math.sin(ANGLE))
W = (-U[1], U[0])
LENGTH, WIDTH = 100.0, 55.15

# The GRB's features (OIDN).
CLUBHOUSE, STAND, BLOCK = 7778673, 7778780, 6995671
PAVED = 116918          # the lane, the car park and the walk along the pitch's end
STREET_END = (116802, 461063)   # Schildekensstraat's last metres and the junction where the lane leaves it
PLOT = 6071561


def P(u, w):
    return (CENTRE[0] + U[0] * u + W[0] * w, CENTRE[1] + U[1] * u + W[1] * w)


def frame(x, z):
    """(u, w) of a game point."""
    dx, dz = x - CENTRE[0], z - CENTRE[1]
    return (dx * U[0] + dz * U[1], dx * W[0] + dz * W[1])


def rect(u0, u1, w0, w1):
    return Polygon([P(u0, w0), P(u1, w0), P(u1, w1), P(u0, w1)])


def ring(poly, nd=2):
    return [[round(x, nd), round(z, nd)] for x, z in list(poly.exterior.coords)[:-1]]


def feature(layer, oidn, to_model):
    for f in features(layer):
        if f["properties"].get("OIDN") == oidn:
            return unary_union([affine_transform(p, to_model) for p in polygons(f["geometry"])])
    raise SystemExit(f"{layer} OIDN {oidn} not in the data: run tools/geodata.py --strip e2")


def main():
    if "e2" not in ACTIVE_STRIPS:
        raise SystemExit("the strip e2 is missing: tools/geodata.py --strip e2")
    plot, _, to_model = model_frame()
    model = lambda g: affine_transform(g, to_model)
    c = model(Point(FOOTBALL))
    if math.dist((c.x, c.y), CENTRE) > 2.0:
        raise SystemExit(f"FOOTBALL in tools/neighbours.py ({c.x:.1f}, {c.y:.1f}) is not the centre spot {CENTRE}")

    clubhouse = feature("GBG", CLUBHOUSE, to_model)
    stand = feature("GBG", STAND, to_model)
    block = feature("GBG", BLOCK, to_model)
    paved = feature("WBN", PAVED, to_model)
    pitch_plot = feature("ADP", PLOT, to_model)
    # The old area's edge (village.json `area`): the street's last metres only where the village's own road detail ends.
    village = json.loads((ROOT / "web" / "src" / "data" / "village.json").read_text(encoding="utf-8"))
    old_area = Polygon(village["area"]).buffer(-0.5)
    street_end = unary_union([feature("WBN", oid, to_model) for oid in STREET_END]).difference(old_area)

    # The car park: the paved surface west of the lane's bend; the walk along the pitch's end: its strip by the pitch.
    walk = paved.intersection(rect(53.4, 56.6, -33.0, 33.0))
    lane_cut = box(-266.0, -1200.0, -100.0, -1170.0)
    lane = paved.intersection(lane_cut).difference(walk)
    car_park = paved.difference(lane_cut).difference(walk)
    lane = unary_union([lane, street_end])
    # The lane's centre line: the street's last segment (Wegsegment OIDN 1192998), from the car park to the junction.
    seg = next(f for f in features("Wegsegment") if f["properties"].get("OIDN") == 1192998)
    lane_line = [[round(x, 2), round(z, 2)] for x, z in model(LineString([p[:2] for p in seg["geometry"]["coordinates"]])).coords]

    # The level platform (tools/terrain.py): the fenced pitch, the buildings and the car park, as one flat ground
    # (the real pitch falls a metre across; a level one lets the ball and the players behave), blended into the
    # real relief over `blend` metres round it.
    platform = unary_union([rect(-57.5, 58.0, -37.0, 38.5), car_park.buffer(2.5, 4)]).simplify(0.5)

    # The trees round the ground from the laser scan (as tools/neighbours.py picks them): outside the fences, the
    # buildings, the car park and the lane, at least 7 m apart.
    ndsm = raster("DSM") - raster("DTM")
    zone_l72 = football(plot)
    keep_out =unary_union([rect(-56.0, 58.5, -36.0, 37.0), car_park.buffer(3), lane.buffer(3), clubhouse.buffer(2)])
    inv = np.linalg.inv(np.array([[to_model[0], to_model[1]], [to_model[2], to_model[3]]]))
    bx0, by0, bx1, by1 = zone_l72.intersection(Point(FOOTBALL).buffer(110)).bounds
    r0, c0 = int(TILE_Y1 - by1), int(bx0 - TILE_X0)
    window = ndsm[r0:int(TILE_Y1 - by0), c0:int(bx1 - TILE_X0)]
    order = np.dstack(np.unravel_index(np.argsort(-window, axis=None), window.shape))[0]
    trees = []
    for row, col in order:
        h = float(window[row, col])
        if h < 5.0 or len(trees) >= 40:
            break
        x, y = TILE_X0 + c0 + col + 0.5, TILE_Y1 - (r0 + row) - 0.5
        if not zone_l72.contains(Point(x, y)):
            continue
        g = model(Point(x, y))
        if keep_out.contains(g) or any(math.dist((g.x, g.y), (t["x"], t["z"])) < 7.0 for t in trees):
            continue
        patch = window[max(0, row - 4):row + 5, max(0, col - 4):col + 5]
        crown = max(1.5, min(4.5, math.sqrt(float((patch > h * 0.5).sum()) / math.pi)))
        trees.append({"x": round(g.x, 2), "z": round(g.y, 2), "y": -0.1, "h": round(min(h, 22.0), 1), "r": round(crown, 1)})

    # What stands round the pitch, in the frame (u, w), from the photo and the usual sizes (tools/football.py draws it).
    goals = [{"id": "far", "u": -LENGTH / 2, "in": -1}, {"id": "near", "u": LENGTH / 2, "in": 1}]
    rail = {"u0": -52.8, "u1": 53.2, "w0": -31.1, "w1": 29.9, "height": 1.1}      # the spectators' rail round the pitch
    fence = {"far": -34.3, "end": -54.4, "near_end": 56.6, "height": 2.0}       # the mesh fence: far side, far end, car park end
    nets = [{"u": -54.4, "w0": -34.3, "w1": 30.5, "height": 6.0}, {"u": 56.6, "w0": -34.3, "w1": 27.5, "height": 6.0}]
    masts = [[-31.5, -33.2], [31.5, -33.2], [-31.5, 35.2], [31.0, 31.2]]          # (u, w): far side, then the buildings' side
    dugouts = [[2.0, 7.5], [10.5, 16.0]]                                           # u from, to; w 28.5..30.0 (inside the rail)
    containers = {"u0": -35.6, "u1": -23.6, "w0": 31.2, "w1": 34.0}                # the red-roofed dressing-room containers
    yard = {"u0": -48.0, "u1": -35.6, "w0": 30.0, "w1": 37.0}                      # paved, beyond them
    gate = {"u": 54.95, "w0": 27.6, "w1": 30.6}                                     # the way in from the car park to the rail
    dugout_w = [29.9, 31.4]                                                         # behind the rail's line, open to the pitch
    # The low stand in front of the western end (GBG OIDN 7778780): two rows of seats facing the pitch, a seat every
    # `step` metres from u0 to u1; `w` the seat's middle, `y` its height over the ground.
    seats = {"u0": -20.9, "u1": -1.6, "step": 0.55, "rows": [{"w": 31.75, "y": 0.45}, {"w": 32.65, "y": 0.85}]}
    # The covered standing terrace along the main building's front (its western 40 m; the canteen's glass front east of
    # it): three concrete steps up from the apron, each `rise` higher and `going` deep, under the lean-to roof.
    terrace = {"u0": -0.6, "u1": 40.0, "steps": 3, "rise": 0.15, "going": 0.45}

    out = {
        "_source": "tools/football_site.py: GRB and DHM Vlaanderen II (Digitaal Vlaanderen, open data), the orthophoto for "
                   "measuring only, OpenStreetMap (ODbL) and public pages for what is where; the rest made up",
        "centre": list(CENTRE), "u": [round(v, 5) for v in U], "w": [round(v, 5) for v in W],
        "length": LENGTH, "width": WIDTH,
        "platform": {"ring": ring(platform, 1), "blend": 12.0},
        "buildings": {"clubhouse": ring(clubhouse), "stand": ring(stand), "block": ring(block)},
        "surfaces": {
            "asphalt": [ring(p) for p in getattr(car_park, "geoms", [car_park]) if p.area > 1],
            "concrete": [ring(p) for g in (lane, walk) for p in getattr(g, "geoms", [g]) if p.area > 1],
        },
        "plot": ring(pitch_plot),
        "goals": goals, "rail": rail, "fence": fence, "nets": nets, "masts": masts, "dugouts": dugouts,
        "containers": containers, "yard": yard, "gate": gate, "dugout_w": dugout_w, "seats": seats, "terrace": terrace,
        "lane": lane_line,
        "trees": trees,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)}: platform {platform.area:.0f} m2, car park {car_park.area:.0f} m2, "
          f"lane {lane.area:.0f} m2, walk {walk.area:.0f} m2, {len(trees)} trees")
    for name, poly in (("clubhouse", clubhouse), ("stand", stand), ("block", block)):
        us = [frame(x, z) for x, z in poly.exterior.coords]
        print(f"  {name}: u {min(a for a, _ in us):.1f}..{max(a for a, _ in us):.1f}, w {min(b for _, b in us):.1f}..{max(b for _, b in us):.1f}")


if __name__ == "__main__":
    main()
