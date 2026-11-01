"""The streets you can go to from the chat (/location Kapellenhoek) and the menu's list: one spot on each.

Run: tools/.venv/Scripts/python.exe tools/places.py  ->  web/shared/places.json

Yoshi (1 Nov 2026): "Make /location teleports". The portals (web/shared/portals.mjs) were the only
places to go; now every named street of the road network (web/src/data/streets.json `graph`, the
road register's names) is one too. The game and the server read the same file: the server only
ever moves a player to one of these spots (server/game.mjs travel), so a forged message can't pick
its own.

Each street's spot:
- on its longest stretch inside the game's edge (web/shared/bounds.json `map`, at least MARGIN m
  in), as near its middle as a free spot is: from the middle outwards, STEP m at a time, at most
  SLIDE of the stretch's length either way;
- on foot: on the road's own surface (the flat road, pavement, track and gravel blocks of
  web/src/data/house.json and village.json, PAVED), so the place line names the street: the middle
  of the pavement, else just inside the carriageway's edge, where the road detail
  (web/src/data/roadDetail.json, measured on the GRB) has the street; else INSET in from where the
  surface ends (at most OUT_MAX out: the GRB's road surface reaches from plot to plot); else nearer
  the middle. On the right of the way you face, else on the left;
- in a car (`car`): on the right-hand lane of the same spot, facing the same way, its wheels on the
  surface (a track's ruts);
- facing along the street;
- clear of everything one bumps into: every wall, hedge, fence and other block CLEAR m or more
  high (web/src/data/house.json and village.json), the posts, poles and tree trunks, the parked
  cars and the ponds by AROUND m, the buildings (as tools/bounds.py) by BUILDING m, so you look
  down the street and not at a wall; a car by CAR_AROUND from all of them;
- not on the school grounds (web/shared/zones.mjs), nor inside the edge round the two houses for
  a game there (bounds.json `party`: the house and the bungalow have portals of their own), nor
  within PAD m of a portal;
- in the street it names: the nearest road there is that street (the place line at the top left
  says so on arriving: src/ui/route.ts streetAt).

`village`: the spot is out of the ring loaded at the start (RING m round the plot) or near a
street model's houses (data/molenhoek*.json, data/kapellenhoek.json): the village loads before
you arrive (src/main.ts travel). `sub`: the hamlet under the name on arriving, the nearest
portal's.

A street without a stretch of MIN_LENGTH m inside the edge, or without a free spot, is left out
and named. The tool stops if a spot is less than MARGIN m inside the edge, in a building or off
its street. The game's own check in the browser (briel.world.boxFree and groundAt) is in the
DECISIONS row of 1 Nov 2026.

Ids are "street:" and the name in small letters with hyphens, apart from the portals' ids
("molenhoek" is a portal and a street). Model coordinates (x, z); a yaw is the game's (0 looks
along -z).
"""
import json
import math
import re
import subprocess
import unicodedata
from pathlib import Path

from shapely.affinity import rotate, translate
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import linemerge, unary_union
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
OUT = WEB / "shared" / "places.json"

MARGIN = 10        # m: every spot (and a car's corners) at least this far inside the game's edge
MIN_LENGTH = 30    # m: the shortest stretch inside the edge that gets a spot
STEP = 1.5         # m between the spots tried along a stretch
SLIDE = 0.45       # of the stretch's length either way from its middle
PAVED = {"road", "track", "gravel", "pave_light", "pave_warm", "pave_grey", "concrete", "stone"}  # the surfaces of a road, its pavements and verges
REACH = 6.0        # m from the centre line: how far out a road's surface is looked for
SAMPLE = 0.25      # m between the points looked at across the road
GAP = 1.0          # m of grass the surface may break off for (a track's ruts)
INSET = 0.4        # m in from the surface's outer edge where there is no road detail
OUT_MAX = 4.5      # m from the centre line at most (a road surface reaching from plot to plot)
CLEAR = 0.3        # m: a block this high or more is something you bump into
AROUND = 0.8       # m kept free round where you stand
BUILDING = 2.5     # m kept free between where you stand and a building: a view down the street, not of a wall
CAR_AROUND = 0.4   # m kept free round a car
CAR = (4.8, 2.0)   # m: the biggest car's length and width (shared/car.json), rounded up
RING = 500         # m round the plot's middle: the ring loaded at the start (540 m, tools/neighbours.py), less a margin
PLOT = (4.45, -3)
NEAR_MODEL = 80    # m from a street model's house: in the village
PAD = 6            # m from a portal's middle: its pad (and the list on it) stays for those who walk onto it


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def node_json(module, expr):
    """A value from one of the shared .mjs modules, through node (as tools/bounds.py)."""
    code = f"import * as m from {json.dumps(module.as_uri())}; process.stdout.write(JSON.stringify({expr}));"
    return json.loads(subprocess.run(["node", "--input-type=module", "-e", code], check=True, capture_output=True, text=True).stdout)


def slug(name):
    plain = unicodedata.normalize("NFD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")


def ring_poly(ring):
    if len(ring) < 3:
        return None
    p = Polygon(ring)
    return p if p.is_valid else p.buffer(0)


def footprints(house, village, models):
    """The buildings, as tools/bounds.py buildings(): the house data's blocks, the neighbours' and the village's, the street models' houses."""
    out = [ring_poly(p["p"][0]) for p in house["prisms"]]
    walls = lambda p: p["m"].startswith("nb_") and p["m"] not in ("nb_hedge", "nb_roof")
    for data in (house["surroundings"], village):
        out += [ring_poly(r["p"]) for r in data["roofs"]]
        out += [ring_poly(p["p"][0]) for p in data["prisms"] if walls(p)]
    out += [ring_poly(lm["p"]) for lm in village.get("landmarks", [])]
    out += [ring_poly(h["outline"]) for m in models for h in m["houses"].values() if h.get("outline")]
    return [q for q in out if q is not None and not q.is_empty]


def car_box(x, z, yaw, length, width):
    """A car's outline on the plan: its middle, the game's yaw (0 nose along -z)."""
    b = box(-width / 2, -length / 2, width / 2, length / 2)
    # The nose at -z for yaw 0; turning by yaw: forward (-sin, -cos). A box symmetric about its middle needs only the angle.
    return translate(rotate(b, -yaw, origin=(0, 0), use_radians=True), x, z)


def obstacles(house, village, roads, models):
    """Everything you bump into but the buildings, grown by its own size where it is a point."""
    shapes = []
    for data in (house["surroundings"], village):
        for p in data["prisms"]:
            if p["m"] == "nb_roof" or p["y1"] - p["y0"] < CLEAR:
                continue
            q = ring_poly(p["p"][0])
            if q is not None and not q.is_empty:
                shapes.append(q)
        shapes += [Point(x, z).buffer(0.12, 8) for x, z, *_ in data["posts"]]
        shapes += [Point(p["x"], p["z"]).buffer(0.2, 8) for p in data["poles"]]
        shapes += [Point(t["x"], t["z"]).buffer(0.4, 8) for t in data["trees"]]
        shapes += [ring_poly(d["rim"]) for d in data.get("dips", []) if d.get("rim")]
    for p in house["prisms"]:  # the house's hedges, fences and walls (its plot is in the footprints)
        q = ring_poly(p["p"][0])
        if q is not None and not q.is_empty and p["y1"] - p["y0"] >= CLEAR:
            shapes.append(q)
    shapes += [car_box(x, z, yaw, 4.8, 2.0) for x, z, yaw, *_ in roads["parked"]]
    shapes += [Point(x, z).buffer(0.6, 8) for x, z, *_ in roads["boxes"]]
    shapes += [Point(x, z).buffer(1.0, 8) for x, z, *_ in roads["bikes"]]
    shapes += [Point(x, z).buffer(0.25, 8) for x, z, *_ in roads["signs"]]
    return [s for s in shapes if s is not None and not s.is_empty]


def detail_stations(detail):
    """Per street: the road detail's stations, each with its normal, the carriageway's half width and the pavement's width either side."""
    out = {}
    for run in detail["runs"]:
        name = run["name"].split("~")[0]
        p = run["p"]
        n = len(p) // 2
        xs, zs = p[0::2], p[1::2]
        for k in range(n):
            a, b = max(0, k - 2), min(n - 1, k + 2)
            tx, tz = xs[b] - xs[a], zs[b] - zs[a]
            L = math.hypot(tx, tz) or 1
            w, q = run["w"][2 * k: 2 * k + 2], run["q"][2 * k: 2 * k + 2]
            out.setdefault(name, []).append((xs[k], zs[k], -tz / L, tx / L, w, q))
    return out


def detail_at(stations, x, z, sx, sz):
    """The road detail on side (sx, sz) at (x, z): the carriageway's half width and the pavement's width there, or None."""
    best = min(stations, key=lambda s: (s[0] - x) ** 2 + (s[1] - z) ** 2, default=None)
    if not best or math.hypot(best[0] - x, best[1] - z) > 4:
        return None
    _x, _z, nx, nz, w, q = best
    i = 0 if nx * sx + nz * sz > 0 else 1
    return w[i], q[i]


def paved_reach(paved, x, z, sx, sz):
    """How far the road's surface reaches from the centre line at (x, z) towards (sx, sz), up to REACH m:
    across gaps of up to GAP m (the grass between a track's two ruts), or None where there is none."""
    last, gap = None, 0.0
    for k in range(int(REACH / SAMPLE) + 1):
        o = k * SAMPLE
        if paved(x + sx * o, z + sz * o):
            last, gap = o, 0.0
        else:
            gap += SAMPLE
            if gap > GAP:
                break
    return last


class Edges:
    """The road network's stretches with their street names, for the street a point is in (as src/ui/route.ts streetAt)."""

    def __init__(self, graph):
        pts = graph["points"]
        self.lines = [LineString([pts[a], pts[b]]) for a, b in graph["edges"]]
        self.names = [graph["names"][s] if s >= 0 else None for s in graph["street"]]
        self.tree = STRtree(self.lines)

    def street(self, x, z):
        i = self.tree.nearest(Point(x, z))
        return self.names[i] if self.lines[i].distance(Point(x, z)) <= 40 else None


def main():
    house = read(WEB / "src" / "data" / "house.json")
    village = read(WEB / "src" / "data" / "village.json")
    streets = read(WEB / "src" / "data" / "streets.json")
    roads = read(WEB / "src" / "data" / "roads.json")
    detail = read(WEB / "src" / "data" / "roadDetail.json")
    bounds = read(WEB / "shared" / "bounds.json")
    models = [read(p) for p in sorted((ROOT / "data").glob("molenhoek*.json"))] + [read(ROOT / "data" / "kapellenhoek.json")]
    portals = node_json(WEB / "shared" / "portals.mjs", "m.PORTALS")
    zones = node_json(WEB / "shared" / "zones.mjs", "m.NO_SHOOT")

    edge = Polygon(bounds["map"])
    inner = edge.buffer(-MARGIN)
    keep_out = unary_union([Polygon(bounds["party"])] + [Polygon(z["poly"]) for z in zones] + [Point(p["x"], p["z"]).buffer(PAD, 16) for p in portals])
    things = obstacles(house, village, roads, models)
    buildings = footprints(house, village, models)
    raw = STRtree(things + buildings)  # for a car: everything by CAR_AROUND
    walk = [s.buffer(AROUND, 8) for s in things] + [b.buffer(BUILDING, 8) for b in buildings]  # on foot: grown by what it keeps free
    walk_tree = STRtree(walk)
    houses = unary_union([ring_poly(h["outline"]) for m in models for h in m["houses"].values() if h.get("outline")])
    widths = detail_stations(detail)
    # The road surfaces as the game draws them: the flat blocks of the house's surroundings and the village.
    flats = [q for data in (house["surroundings"], village) for p in data["prisms"]
             if p["m"] in PAVED and p["y1"] - p["y0"] < CLEAR and (q := ring_poly(p["p"][0])) is not None and not q.is_empty]
    flat_tree = STRtree(flats)

    def paved(x, z):
        pt = Point(x, z)
        return any(flats[i].contains(pt) for i in flat_tree.query(pt))
    roads_at = Edges(streets["graph"])
    portal_ids = {p["id"] for p in portals}

    def free_car(shape):
        near = shape.buffer(CAR_AROUND, 8)
        return not any(raw.geometries[i].intersects(near) for i in raw.query(near))

    def free_foot(spot):
        return not any(walk[i].intersects(spot) for i in walk_tree.query(spot))

    g = streets["graph"]
    pts = g["points"]
    places, left_out = [], []
    for si, name in enumerate(g["names"]):
        lines = [LineString([pts[a], pts[b]]) for (a, b), s in zip(g["edges"], g["street"]) if s == si]
        joined = unary_union(lines)
        merged = (linemerge(joined) if joined.geom_type == "MultiLineString" else joined).intersection(inner.buffer(-1))
        parts = sorted((q for q in getattr(merged, "geoms", [merged]) if q.geom_type == "LineString"), key=lambda q: -q.length)
        if not parts or parts[0].length < MIN_LENGTH:
            left_out.append(f"{name}: no stretch of {MIN_LENGTH} m inside the edge ({parts[0].length:.0f} m)" if parts else f"{name}: outside the edge")
            continue
        line = parts[0]
        found = None
        n = int(line.length * SLIDE / STEP)
        for k in [0] + [s * j for j in range(1, n + 1) for s in (1, -1)]:
            at = line.length / 2 + k * STEP
            p = line.interpolate(at)
            a, b = line.interpolate(max(0, at - 3)), line.interpolate(min(line.length, at + 3))
            fx, fz = b.x - a.x, b.y - a.y
            L = math.hypot(fx, fz) or 1
            fx, fz = fx / L, fz / L
            yaw = math.atan2(-fx, -fz)
            rx, rz = -fz, fx  # the right of the way you face (x right, z towards you)
            stations = widths.get(name, [])
            # The car: on the right-hand lane, on the road's surface.
            right = detail_at(stations, p.x, p.y, rx, rz)
            reach = paved_reach(paved, p.x, p.y, rx, rz)
            if reach is None:
                continue
            carriage = right[0] if right else min(reach, 3.0)
            lane = max(0.0, min(1.4, carriage - CAR[1] / 2 - 0.1))
            cx, cz = p.x + rx * lane, p.y + rz * lane
            car = car_box(cx, cz, yaw, *CAR)
            on_road = any(paved(cx + rx * o, cz + rz * o) for o in (0, -0.4, 0.4, -0.8, 0.8))  # a track: the wheels on its ruts
            if not on_road or not inner.contains(car) or car.intersects(keep_out) or not free_car(car) or roads_at.street(cx, cz) != name:
                continue
            # On foot: the middle of the pavement, else just inside the carriageway's edge (the road detail), else
            # INSET in from the surface's edge; then just inside that edge (a track's rut), then nearer the middle,
            # a quarter of a metre at a time. Always on the surface.
            for side in (1, -1):
                sx, sz = rx * side, rz * side
                d = detail_at(stations, p.x, p.y, sx, sz)
                reach = paved_reach(paved, p.x, p.y, sx, sz)
                if reach is None:
                    continue
                if d:
                    start = d[0] + d[1] / 2 if d[1] >= 0.8 else d[0] - 0.3
                else:
                    start = reach - INSET
                start = max(0.0, min(start, reach, OUT_MAX))
                for o in [start, max(0.0, min(reach, OUT_MAX) - 0.1)] + [start - 0.25 * j for j in range(1, int(start / 0.25) + 1)]:
                    x, z = p.x + sx * o, p.y + sz * o
                    spot = Point(x, z)
                    if paved(x, z) and inner.contains(spot) and not keep_out.contains(spot) and free_foot(spot) and roads_at.street(x, z) == name:
                        found = (x, z, yaw, cx, cz, at, side, o)
                        break
                if found:
                    break
            if found:
                break
        if not found:
            left_out.append(f"{name}: no free spot on its {line.length:.0f} m stretch")
            continue
        x, z, yaw, cx, cz, at, side, out = found
        pid = f"street:{slug(name)}"
        assert pid not in portal_ids
        near = min(portals, key=lambda q: math.hypot(q["x"] - x, q["z"] - z))
        in_village = math.hypot(x - PLOT[0], z - PLOT[1]) > RING or (not houses.is_empty and houses.distance(Point(x, z)) < NEAR_MODEL)
        place = {"id": pid, "name": name, "sub": near["sub"], "x": round(x, 2), "z": round(z, 2), "yaw": round(yaw, 3),
                 "car": [round(cx, 2), round(cz, 2), round(yaw, 3)]}
        if in_village:
            place["village"] = True
        places.append(place)
        print(f"{name:24} {x:8.1f} {z:8.1f}  {at - line.length / 2:+6.1f} m from the middle of {line.length:4.0f} m, "
              f"{'right' if side > 0 else 'left '} {out:.1f} m out, car {math.hypot(cx - line.interpolate(at).x, cz - line.interpolate(at).y):.1f} m{'  village' if in_village else ''}")

    # The checks: well inside the edge, in no building, in its street.
    for p in places:
        for x, z in ((p["x"], p["z"]), tuple(p["car"][:2])):
            d = edge.exterior.distance(Point(x, z))
            assert edge.contains(Point(x, z)) and d >= MARGIN, f"{p['name']}: {d:.1f} m from the edge"
            assert roads_at.street(x, z) == p["name"], f"{p['name']}: in {roads_at.street(x, z)}"
        assert inner.contains(car_box(*p["car"], *CAR)), f"{p['name']}: the car is too close to the edge"
        assert free_foot(Point(p["x"], p["z"])), f"{p['name']}: not free"
        assert paved(p["x"], p["z"]), f"{p['name']}: off the road's surface"
        assert free_car(car_box(*p["car"], *CAR)), f"{p['name']}: no room for the car"
    out = {"_source": "tools/places.py: a spot on every named street of web/src/data/streets.json, inside web/shared/bounds.json", "places": places}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"{len(places)} streets -> {OUT} ({OUT.stat().st_size} bytes)")
    for line in left_out:
        print(f"left out: {line}")


if __name__ == "__main__":
    main()
