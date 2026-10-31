"""Street names for the big map (web/src/ui/bigmap.ts): where to write each street's name.

Run: tools/.venv/Scripts/python tools/streets.py  ->  web/src/data/streets.json

The road register (Wegenregister, source/geo/Wegsegment_l72.json, fetched by tools/geodata.py)
gives each road's centre line with its street name. A street's pieces are joined, cut to the area
the game builds (the ring round the plot and the circle round the church, with the band between
them, as `zone` in tools/neighbours.py) and its name is written along the longest stretches: at the
middle of each stretch of at least 70 m, and every 280 m along longer ones. Positions are the
model's (x, z); the angle is on the map, which has north up (radians, kept between -90 and 90
degrees so no name is upside down). Unnamed roads ("nvt") get no label.

It also writes the road network for directions on the map (`graph`): every road's centre line,
named or not, inside the area and 60 m beyond, simplified to 1.5 m, as points (model x, z, to
0.1 m) and the stretches between them (pairs of point numbers). Pieces that meet share a point.
Each stretch has its street's name (a number into `names`, -1 for none): the place line at the top
left says which street you are in.
"""
import json
import math
from pathlib import Path

from shapely.geometry import LineString, Point
from shapely.ops import linemerge, unary_union

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "source" / "geo" / "Wegsegment_l72.json"
OUT = ROOT / "web" / "src" / "data" / "streets.json"

# Lambert 72 → model (as in tools/build_house.py): x = aX + bY + xoff, z = cX + dY + zoff.
A, B, C, D, XOFF, ZOFF = -0.746292959, -0.665617623, -0.665617623, 0.746292959, 211874.050655751, -58903.965184599
PLOT = (118911.0, 184981.0)  # the plot's middle (model 4.45, -3)
AREA = 540
CHURCH, VILLAGE = (119018.7, 184084.2), 340  # as tools/neighbours.py
MIN_STRETCH = 70  # m
EVERY = 280  # m between names along a long street


def model(x, y):
    return round(A * x + B * y + XOFF, 1), round(C * x + D * y + ZOFF, 1)


def road_graph(data, area):
    """Points and stretches of every road centre line inside `area`, pieces that touch sharing a point."""
    points, index, edges = [], {}, {}  # (a, b) -> street name ("" for none)

    def point(x, y):
        key = (round(x * 2), round(y * 2))  # within half a metre: the same point
        if key not in index:
            index[key] = len(points)
            points.append(list(model(x, y)))
        return index[key]

    for f in data["features"]:
        name = f["properties"].get("LSTRNM") or f["properties"].get("RSTRNM") or ""
        if name.lower() == "nvt":
            name = ""
        line = LineString(f["geometry"]["coordinates"]).intersection(area)
        for part in [line] if line.geom_type == "LineString" else list(getattr(line, "geoms", [])):
            if part.geom_type != "LineString" or part.length < 1:
                continue
            ids = [point(x, y) for x, y in part.simplify(1.5).coords]
            for a, b in zip(ids, ids[1:]):
                if a != b and not edges.get((min(a, b), max(a, b))):
                    edges[(min(a, b), max(a, b))] = name
    stretches = sorted(edges)
    names = sorted({n for n in edges.values() if n})
    return {"points": points, "edges": stretches, "names": names,
            "street": [names.index(edges[s]) if edges[s] else -1 for s in stretches]}


def main():
    data = json.loads(SRC.read_text(encoding="utf-8"))
    zone = unary_union([Point(PLOT).buffer(AREA, 64), Point(CHURCH).buffer(VILLAGE, 64)]).convex_hull.buffer(-15)
    pieces = {}
    for f in data["features"]:
        p = f["properties"]
        name = p.get("LSTRNM") or p.get("RSTRNM")
        if not name or name.lower() == "nvt":
            continue
        pieces.setdefault(name, []).append(LineString(f["geometry"]["coordinates"]))
    streets = []
    for name, lines in sorted(pieces.items()):
        joined = unary_union(lines)
        merged = (linemerge(joined) if joined.geom_type == "MultiLineString" else joined).intersection(zone)
        parts = [merged] if merged.geom_type == "LineString" else list(getattr(merged, "geoms", []))
        labels = []
        for line in sorted((g for g in parts if g.geom_type == "LineString"), key=lambda g: -g.length):
            if line.length < MIN_STRETCH:
                continue
            n = max(1, int(line.length // EVERY))
            for k in range(n):
                at = line.length * (k + 0.5) / n
                a = line.interpolate(max(0, at - 10))
                b = line.interpolate(min(line.length, at + 10))
                angle = math.atan2(-(b.y - a.y), b.x - a.x)  # on the map: x east, y south
                if angle > math.pi / 2:
                    angle -= math.pi
                elif angle <= -math.pi / 2:
                    angle += math.pi
                p = line.interpolate(at)
                labels.append([*model(p.x, p.y), round(angle, 3)])
        if labels:
            streets.append({"name": name, "labels": labels})
    graph = road_graph(data, zone.buffer(75))
    OUT.write_text(json.dumps({"_source": "Wegenregister (Digitaal Vlaanderen, open data) via tools/streets.py", "streets": streets, "graph": graph},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(streets)} streets, {sum(len(s['labels']) for s in streets)} labels, {len(graph['points'])} road points, "
          f"{len(graph['edges'])} stretches -> {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
