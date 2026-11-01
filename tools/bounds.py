"""The edge of the game: where you can walk, ride, drive and fly (web/shared/bounds.json).

Run: tools/.venv/Scripts/python.exe tools/bounds.py  ->  web/shared/bounds.json, and check images
data/debug/bounds.png (the whole area) and data/debug/bounds_party.png (round the two houses)

Yoshi (1 Nov 2026): nobody should roam the empty fields for ever. So the game has an invisible wall
round the built-up area, and a ceiling above it (web/shared/bounds.mjs; the game stops you at it,
the server puts a position outside back in).

`map`, the outline for normal play, is the union of
- a band of STREET metres either side of every road's centre line (web/src/data/streets.json `graph`,
  and the street models' lines in data/molenhoek*.json and data/kapellenhoek.json),
- BUILDING metres round every building: Yoshi's house with its plot and the bungalow
  (web/src/data/house.json `prisms`), the neighbours (house.json `surroundings`: roofs and walls),
  the village and Molenhoek (web/src/data/village.json: roofs, walls, the church and the school)
  and the street models' houses (their `outline`),
- REACH metres round everything the game puts somewhere to be reached: the portals (their pads and
  where you come out on foot and in a car), the spawns, the cars' parking spots, the horses' walks,
  the cats, the clowns and strongmen, the weapons lying around and the school grounds,
the first two cut to the area the world is built in (village.json `area`, EDGE metres in), and
AROUND metres round every building whole, so a house on the area's edge (the end of Molenhoek) keeps
its garden. Pieces closer than 2 x JOIN metres are joined (a closing: out JOIN and back), the holes
are filled (a field inside the village stays walkable), and the outline is rounded (SMOOTH metres)
and simplified (SIMPLIFY metres) to a few hundred points. Only the piece with the house in it is
kept; every portal and spawn must be in it, at least INSIDE metres from the edge, and every building
at least AROUND - SIMPLIFY - 1 metres, or the tool stops.

`party`, the outline while a game in the house runs (hide and seek, tag, the treasure hunt, house
against bungalow: web/server/modes.mjs), is Briel round the two houses: HOME metres round Yoshi's
house and its plot, BUNGALOW metres round the bungalow, and LANE metres either side of the way
along the roads between the two (the shortest along the graph). The house's outside spawns, the
coins' outside spots (modes.mjs OUTSIDE), the two home cars and the two portals must be inside it,
PARTY_INSIDE metres from the edge.

`ceiling`: how high you can fly, in metres above the ground under you (the relief, not a roof).

Points are the model's (x, z) to the centimetre, each ring counter-clockwise with x to the right and
z up (web/shared/bounds.mjs works out the inward side itself, so either way round would do).
"""
import json
import math
import re
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
OUT = WEB / "shared" / "bounds.json"
DEBUG = ROOT / "data" / "debug" / "bounds.png"

STREET = 50     # m either side of a road's centre line
BUILDING = 40   # m round a building: its garden and the field behind it
AROUND = 15     # m round every building even past the area's edge: a garden at least
REACH = 30      # m round a place the game sends you to
EDGE = 3        # m inside the area the world is built in
JOIN = 30       # m: pieces closer than twice this are joined
SMOOTH = 12     # m: the radius the corners are rounded to
SIMPLIFY = 3    # m: the most the simplified outline is off the smooth one
INSIDE = 15     # m: every portal and spawn at least this far from the edge
CEILING = 120   # m above the ground under you

HOME = 22       # m round Yoshi's house and plot during a game
BUNGALOW = 20   # m round the bungalow and its garden
LANE = 14       # m either side of the road between them
PARTY_INSIDE = 8
PARTY_JOIN = 8  # m: only the corners where the three pieces meet are filled
PARTY_SMOOTH = 6


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def node_json(module, expr):
    """A value from one of the shared .mjs modules, through node (they are the game's own data)."""
    code = f"import * as m from {json.dumps(module.as_uri())}; process.stdout.write(JSON.stringify({expr}));"
    return json.loads(subprocess.run(["node", "--input-type=module", "-e", code], check=True, capture_output=True, text=True).stdout)


def ring_poly(ring):
    if len(ring) < 3:
        return None
    p = Polygon(ring)
    return p if p.is_valid else p.buffer(0)


def street_lines(streets, models):
    g = streets["graph"]
    pts = g["points"]
    lines = [LineString([pts[a], pts[b]]) for a, b in g["edges"]]
    for m in models:
        lines.append(LineString(m["line"]))
        for extra in m.get("lines", []):
            lines.append(LineString(extra["line"]))
    return lines


def buildings(house, village, models):
    """Footprints: the house data's blocks (the house, its plot, the bungalow), the neighbours' and the village's buildings."""
    out = []
    for p in house["prisms"]:
        q = ring_poly(p["p"][0])
        if q is not None:
            out.append(q)
    walls = lambda p: p["m"].startswith("nb_") and p["m"] not in ("nb_hedge", "nb_roof")
    for data in (house["surroundings"], village):
        for r in data["roofs"]:
            out.append(ring_poly(r["p"]))
        for p in data["prisms"]:
            if walls(p):
                out.append(ring_poly(p["p"][0]))
    for lm in village.get("landmarks", []):
        out.append(ring_poly(lm["p"]))
    for m in models:
        for h in m["houses"].values():
            if h.get("outline"):
                out.append(ring_poly(h["outline"]))
    return [q for q in out if q is not None and not q.is_empty]


def places(portals, spawns, cars, horses, cats, clowns, pickups):
    """Everything the game puts somewhere to be reached: (name, x, z, must be INSIDE from the edge)."""
    out = []
    for p in portals:
        out += [(f"portal {p['id']}", p["x"], p["z"], True), (f"portal {p['id']} out", *p["out"][:2], True), (f"portal {p['id']} car", *p["car"][:2], True)]
    out += [(f"spawn {s['name']}", s["x"], s["z"], True) for s in spawns]
    out += [(f"car {k}", c["park"]["x"], c["park"]["z"], False) for k, c in cars["cars"].items()]
    out += [(f"horse {i}", x, z, False) for i, h in enumerate(horses["herd"]) for x, z in h["loop"]]
    out += [(f"cat {i}", x, z, False) for i, loop in enumerate(cats["cats"]) for x, z in loop]
    out += [(f"{s[3]} {i}", s[0], s[2], False) for i, s in enumerate(clowns["spots"])]
    out += [(f"weapon {w['where']}", w["x"], w["z"], False) for w in pickups]
    return out


def biggest_with(geom, point):
    parts = list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]
    for q in parts:
        if q.contains(point):
            return q
    return max(parts, key=lambda q: q.area)


def outline(shapes, area, keep, extra=(), join=JOIN, smooth=SMOOTH):
    """Union (cut to `area`, then `extra` added whole), joined, holes filled, rounded, simplified: one polygon without holes."""
    u = unary_union([unary_union(shapes).intersection(area), *extra])
    u = u.buffer(join, 24).buffer(-join, 24)
    u = biggest_with(u, keep)
    u = Polygon(u.exterior)
    u = u.buffer(-smooth, 24).buffer(2 * smooth, 24).buffer(-smooth, 24)  # convex corners, then concave ones
    u = biggest_with(u, keep)
    u = Polygon(u.exterior).simplify(SIMPLIFY, preserve_topology=True)
    return orient(Polygon(u.exterior), 1.0)


def graph_path(streets, a, b):
    """The shortest way along the road graph between the points nearest to a and b."""
    import heapq
    g = streets["graph"]
    pts = g["points"]
    adj = {}
    for i, j in g["edges"]:
        d = math.dist(pts[i], pts[j])
        adj.setdefault(i, []).append((j, d))
        adj.setdefault(j, []).append((i, d))
    near = lambda p: min(adj, key=lambda k: math.dist(pts[k], p))
    s, t = near(a), near(b)
    dist, prev, todo = {s: 0}, {}, [(0, s)]
    while todo:
        d, k = heapq.heappop(todo)
        if k == t:
            break
        if d > dist[k]:
            continue
        for j, w in adj[k]:
            if d + w < dist.get(j, math.inf):
                dist[j] = d + w
                prev[j] = k
                heapq.heappush(todo, (d + w, j))
    path = [t]
    while path[-1] != s:
        path.append(prev[path[-1]])
    return LineString([a] + [pts[k] for k in reversed(path)] + [b])


def check(poly, named, margin, what):
    edge = poly.exterior
    bad = []
    for name, x, z, strict in named:
        p = Point(x, z)
        d = edge.distance(p) if poly.contains(p) else -edge.distance(p)
        if d < (margin if strict else 2):
            bad.append(f"{name} ({x:.1f}, {z:.1f}) is {d:.1f} m inside")
    if bad:
        raise SystemExit(f"{what}: too close to the edge or outside:\n  " + "\n  ".join(bad))


def ring_out(poly):
    return [[round(x, 2), round(z, 2)] for x, z in list(poly.exterior.coords)[:-1]]


def main():
    house = read(WEB / "src" / "data" / "house.json")
    village = read(WEB / "src" / "data" / "village.json")
    streets = read(WEB / "src" / "data" / "streets.json")
    models = [read(p) for p in sorted((ROOT / "data").glob("molenhoek*.json"))] + [read(ROOT / "data" / "kapellenhoek.json")]
    portals = node_json(WEB / "shared" / "portals.mjs", "m.PORTALS")
    zones = node_json(WEB / "shared" / "zones.mjs", "m.NO_SHOOT")
    spawns = read(WEB / "shared" / "spawns.json")
    cars = read(WEB / "shared" / "car.json")
    horses = read(WEB / "shared" / "horses.json")
    cats = read(WEB / "shared" / "cats.json")
    clowns = read(WEB / "shared" / "clowns.json")
    pickups = read(WEB / "shared" / "pickups.json")
    modes = (WEB / "server" / "modes.mjs").read_text(encoding="utf-8")
    coins = json.loads(re.search(r"const OUTSIDE = (\[.*?\]);", modes).group(1))

    area = Polygon(village["area"]).buffer(-EDGE)
    home = Point(house["spawn"]["x"], house["spawn"]["z"])
    named = places(portals, spawns, cars, horses, cats, clowns, pickups)

    lines = street_lines(streets, models)
    footprints = buildings(house, village, models)
    shapes = [line.buffer(STREET, 8) for line in lines]
    shapes += [b.buffer(BUILDING, 8) for b in footprints]
    whole = [Point(x, z).buffer(REACH, 16) for _n, x, z, _s in named] + [Polygon(z["poly"]).buffer(REACH, 16) for z in zones]
    whole += [b.buffer(AROUND, 8) for b in footprints]
    big = outline(shapes, area, home, whole)
    check(big, named, INSIDE, "map")
    # Every building with a garden round it: its corners AROUND in (less what simplifying may take).
    corners = [("building", x, z, True) for b in footprints for x, z in b.exterior.coords]
    check(big, corners, AROUND - SIMPLIFY - 1, "map (buildings)")

    # The game in the house: Yoshi's house and plot, the bungalow, the way between them.
    # The house data holds both plots: each block goes with the nearer of the two portals.
    bungalow = next(p for p in portals if p["id"] == "bungalow")
    at_house = next(p for p in portals if p["id"] == "house")
    blocks = [q for q in (ring_poly(p["p"][0]) for p in house["prisms"]) if q is not None]
    nearer = lambda q, a, b: q.centroid.distance(Point(a["x"], a["z"])) < q.centroid.distance(Point(b["x"], b["z"]))
    ours = [q for q in blocks if nearer(q, at_house, bungalow)]
    old = [q for q in blocks if not nearer(q, at_house, bungalow)]
    lane = graph_path(streets, at_house["car"][:2], bungalow["car"][:2])
    party_shapes = [unary_union(ours).convex_hull.buffer(HOME, 16), unary_union(old).convex_hull.buffer(BUNGALOW, 16),
                    lane.buffer(LANE, 8)]
    party = outline(party_shapes, big.buffer(-INSIDE), home, join=PARTY_JOIN, smooth=PARTY_SMOOTH)
    party_named = [(f"spawn {s['name']}", s["x"], s["z"], True) for s in spawns]
    party_named += [(f"coin {i}", x, z, True) for i, (x, _y, z) in enumerate(coins)]
    party_named += [(f"car {k}", c["park"]["x"], c["park"]["z"], True) for k, c in cars["cars"].items() if not c["village"]]
    party_named += [(f"portal {p['id']}", p["x"], p["z"], True) for p in (at_house, bungalow)]
    check(party, party_named, PARTY_INSIDE, "party")
    if not big.contains(party):
        raise SystemExit("party: not inside the map")

    out = {
        "_source": "tools/bounds.py: the streets, buildings and places of web/src/data and web/shared, grown, joined and rounded",
        "ceiling": CEILING,
        "map": ring_out(big),
        "party": ring_out(party),
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    nearest = min(big.exterior.distance(Point(x, z)) for _n, x, z, s in named if s)
    print(f"map: {len(out['map'])} points, {big.area / 1e6:.2f} km2, {big.length / 1000:.1f} km round, "
          f"x {big.bounds[0]:.0f}..{big.bounds[2]:.0f}, z {big.bounds[1]:.0f}..{big.bounds[3]:.0f}; nearest portal or spawn {nearest:.1f} m from the edge")
    print(f"party: {len(out['party'])} points, {party.area / 1e4:.2f} ha, x {party.bounds[0]:.0f}..{party.bounds[2]:.0f}, z {party.bounds[1]:.0f}..{party.bounds[3]:.0f}")
    print(f"-> {OUT} ({OUT.stat().st_size} bytes)")
    debug(big, party, lines, footprints, named, Polygon(village["area"]))


def debug(big, party, lines, footprints, named, area):
    """The world area, roads, buildings, the two outlines and the places, 2 m a pixel; and round the two houses, 4 pixels a metre."""
    picture(big, party, lines, footprints, named, area, area.bounds, 0.5, DEBUG)
    picture(big, party, lines, footprints, named, area, party.buffer(25).bounds, 4, DEBUG.with_name("bounds_party.png"))


def picture(big, party, lines, footprints, named, area, frame, s, path):
    x0, z0, x1, z1 = frame
    img = Image.new("RGB", (int((x1 - x0) * s) + 1, int((z1 - z0) * s) + 1), (32, 36, 30))
    d = ImageDraw.Draw(img)
    px = lambda x, z: ((x - x0) * s, (z - z0) * s)
    d.polygon([px(*c) for c in area.exterior.coords], fill=(60, 70, 52))
    d.polygon([px(*c) for c in big.exterior.coords], fill=(92, 112, 78))
    d.polygon([px(*c) for c in party.exterior.coords], fill=(120, 140, 96))
    for line in lines:
        d.line([px(*c) for c in line.coords], fill=(235, 235, 225), width=2)
    for b in footprints:
        if b.geom_type == "Polygon":
            d.polygon([px(*c) for c in b.exterior.coords], fill=(190, 120, 90))
    d.line([px(*c) for c in big.exterior.coords], fill=(255, 220, 0), width=2)
    d.line([px(*c) for c in party.exterior.coords], fill=(0, 220, 255), width=2)
    for _n, x, z, strict in named:
        cx, cz = px(x, z)
        r = 3 if strict else 2
        d.ellipse([cx - r, cz - r, cx + r, cz + r], fill=(255, 40, 160) if strict else (255, 255, 255))
    DEBUG.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)


if __name__ == "__main__":
    main()
