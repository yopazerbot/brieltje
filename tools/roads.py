"""Life along the roads: the routes of the traffic, the cars parked on drives and the things by the
streets, from the GRB's road centre lines (Wegsegment, with the street names) and the model's data.

Sources: source/geo/Wegsegment_l72.json (tools/geodata.py, not in git), data/neighbours.json and
data/street.json (the buildings, the pavings, the hedges), web/src/data/house_shell.json and village.json
(the roads as drawn). Everything is in model coordinates.

- routes: the paved roads (one carriageway, a fixed surface) as a graph; each route is a list of
  legs through it, chosen below by the junctions it passes (ROUTES). A loop is one closed leg; a route
  through the village drives out past the edge of the map (150 m along the real road beyond it, where
  the haze hides it) and comes back on the other leg after a wait. The path keeps to the right of the
  centre line (LANE) and rounds the corners; every point carries the highest speed there (km/h):
  50 on the open road, 30 within 200 m of the church (the village centre, the school), less in bends
  (at most 1.8 m/s2 sideways) and 25 at a junction. The browser makes the timetable from these.
- parked: cars on the drives and yards of the houses in the road band and the outer village streets
  (`mine`): on about half the pavings big enough, clear of the buildings and the road, as near the
  house as fits; kind (0 hatchback, 1 estate, 2 van) and paint by a hash of the place, so they
  don't change when the data does elsewhere.
- plates: street name plates on a post where two named streets meet in that area (or one street
  becomes another), one per street, on the right of someone coming in along it.
- signs: the traffic signs where they really stand, from the road agency's register
  (Verkeersborden.Vlaanderen, source/geo/Verkeersborden*_l72.json from tools/signs_data.py): one pole
  each, with every face the register gives it (turned as it says) and that face's signs stacked as
  it says, at their real sizes; moved off the road, out of drives and hedges where the model needs it.
  Signs a model draws itself are left out (MODELLED).
- stops: the bus stops (OpenStreetMap, source/geo/Bushaltes_l72.json), their pole facing the traffic,
  with a shelter and a litter bin where Street View shows one (STOPS_SEEN).
- boxes: letterboxes on a post at the front of about two thirds of the houses, by the drive
  (no wheelie bins: Yoshi doesn't like them); bikes: a bike against the front wall of a few houses.
Nothing is placed within 4 m of a portal or where you come out of one (web/shared/portals.mjs).

Writes web/src/data/roads.json and a check image data/debug/roads.png. Run from the project root:
    tools/.venv/Scripts/python.exe tools/roads.py
"""
import hashlib
import json
import math
import re
from pathlib import Path

import networkx as nx
import numpy as np
from PIL import Image, ImageDraw
from shapely.affinity import affine_transform, rotate, translate
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import nearest_points, unary_union
from shapely.prepared import prep
from shapely.strtree import STRtree

from neighbours import features, model_frame, zone

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "src" / "data" / "roads.json"
PORTALS = ROOT / "web" / "shared" / "portals.mjs"
DEBUG = ROOT / "data" / "debug" / "roads.png"

HOUSE = (4.45, -3.0)      # the plot's middle
CHURCH = (521.5, -744.15)
RING = 540                # the ring round the plot (the countryside's)
HOME = 120                # the house and its street (the home's)
CENTRE = 150              # the church square and the school (the survey's)
LANE = 1.3                # m right of the centre line
BEYOND = 150              # m past the edge of the map before a car turns round unseen
A_SIDE = 1.8              # m/s2 sideways in a bend
SLOW_CENTRE = 200         # m round the church: 30 km/h

# The routes, by the junctions they pass (model coordinates near each; the shortest way between).
# `out`: the first and last points lie at the edge of the map; the car comes back the same way.
ROUTES = [
    # Round the Briel loop and past our house: Briel north, east to Kapellenhoek, back west along the
    # southern Briel, and the little loop south of the house.
    {"via": [(31, 20), (74, -110), (122, -338), (547, -235), (525, -152), (134, -159), (74, -110), (31, 20), (21, 100),
             (-35, 20), (31, 20)], "loop": True,
     "cars": [("hatch", "#8b8f94", 0.0), ("estate", "#1f3555", 0.5)]},
    # Through the band and the village: in along Kapellenhoek from the south, out along Molenhoek, and back.
    {"via": [(591, -12), (525, -152), (547, -235), (610, -400), (583, -691), (620, -748), (859, -702)], "out": True,
     "cars": [("van", "#eceeef", 0.15), ("hatch", "#7b1d1d", 0.62)]},
    # Schildekensstraat to Stefaan Glorieuxstraat through the centre, and back.
    {"via": [(247, -954), (333, -833), (473, -782), (535, -770), (549, -769), (592, -757), (615, -880), (583, -922),
             (597, -1076)], "out": True,
     "cars": [("estate", "#2b2d31", 0.3)]},
    # North to south: Stefaan Glorieuxstraat, the centre, Kapellenhoek all the way down, and back.
    {"via": [(597, -1076), (583, -922), (615, -880), (592, -757), (620, -748), (583, -691), (610, -400), (547, -235),
             (525, -152), (591, -12)], "out": True,
     "cars": [("hatch", "#e8e9eb", 0.8)]},
]

PAINTS = ["#2b2d31", "#e8e9eb", "#8b8f94", "#4a4e54", "#1f3555", "#b5b8bc", "#7b1d1d", "#2f3d33", "#5b6470", "#eceeef"]
PAINT_SHARE = [18, 17, 14, 12, 9, 9, 6, 4, 6, 5]  # roughly what drives round a Flemish village: greys, black and white
KINDS = {"hatch": (4.25, 1.79), "estate": (4.69, 1.83), "van": (5.53, 2.03)}


def hashed(*v):
    """A number 0..1 from a place, the same every run."""
    h = hashlib.sha1(",".join(f"{x:.1f}" if isinstance(x, float) else str(x) for x in v).encode()).digest()
    return int.from_bytes(h[:4], "big") / 2**32


def pick(share, r):
    t = r * sum(share)
    for i, s in enumerate(share):
        t -= s
        if t < 0:
            return i
    return len(share) - 1


def portal_spots():
    """Where the portals stand and where you come out of them, on foot and by car
    (web/shared/portals.mjs): nothing is placed within 4 m of these."""
    text = PORTALS.read_text(encoding="utf-8")
    spots = []
    for m in re.finditer(r"x: (-?[\d.]+), z: (-?[\d.]+), yaw: [^,]+, out: \[(-?[\d.]+), (-?[\d.]+),[^\]]*\], car: \[(-?[\d.]+), (-?[\d.]+)", text):
        v = [float(g) for g in m.groups()]
        spots += [(v[0], v[1]), (v[2], v[3]), (v[4], v[5])]
    return spots


def clear_of(spots, items, reach=4.0):
    """The items ([x, z, ...]) that stand at least `reach` from every spot."""
    return [it for it in items if all(math.dist((it[0], it[1]), s) >= reach for s in spots)]


def mine(x, z):
    """The road band and the outer village streets: beyond the ring round the plot and the house's
    street, and out of the church square and the school."""
    return math.dist((x, z), HOUSE) > RING and math.dist((x, z), CHURCH) > CENTRE


# ---------------------------------------------------------------- the road graph and the routes

def road_graph(model, area):
    """Paved roads with one carriageway as a graph: nodes where segments meet (within 1.5 m),
    edges with their line and street name. Out to BEYOND past the edge of the map."""
    reach = area.buffer(BEYOND + 30)
    g = nx.Graph()
    nodes = []

    def node(p):
        for i, q in enumerate(nodes):
            if math.dist(p, q) < 1.5:
                return i
        nodes.append(p)
        return len(nodes) - 1

    for f in features("Wegsegment"):
        pr = f["properties"]
        if pr["MORF"] != 103 or "losse" in pr["LBLVERH"] and "vaste" not in pr["LBLVERH"]:
            continue
        line = model(LineString([p[:2] for p in f["geometry"]["coordinates"]])).intersection(reach)
        for part in getattr(line, "geoms", [line]):
            if part.is_empty or part.length < 1 or part.geom_type != "LineString":
                continue
            pts = list(part.coords)
            a, b = node(pts[0]), node(pts[-1])
            if a == b:
                continue
            g.add_edge(a, b, line=pts if a < b else pts[::-1], name=pr["LSTRNM"], length=part.length)
    return g, nodes


def onward(g, nodes, a, b, area):
    """From node b (reached from a), on along the road away from the map for BEYOND metres: the
    edge that turns least, until that far outside."""
    pts = []
    prev, at = a, b
    while True:
        h = math.atan2(nodes[at][1] - nodes[prev][1], nodes[at][0] - nodes[prev][0])
        nexts = [n for n in g.neighbors(at) if n != prev]
        if not nexts:
            return pts
        turn = lambda n: abs(math.atan2(math.sin(math.atan2(nodes[n][1] - nodes[at][1], nodes[n][0] - nodes[at][0]) - h),
                                        math.cos(math.atan2(nodes[n][1] - nodes[at][1], nodes[n][0] - nodes[at][0]) - h)))
        n = min(nexts, key=turn)
        e = g.edges[at, n]
        line = e["line"] if at < n else e["line"][::-1]
        pts.extend(line[1:])
        if area.exterior.distance(Point(pts[-1])) >= BEYOND and not area.contains(Point(pts[-1])):
            for k in range(len(pts)):  # stop at the first point that far out
                if area.exterior.distance(Point(pts[k])) >= BEYOND:
                    return pts[:k + 1]
            return pts
        prev, at = at, n


def route_line(g, nodes, via, area, out):
    """The centre line through the junctions nearest to `via`, the shortest way between each two;
    a route out of the map goes on past both ends (`onward`)."""
    near = lambda p: min(range(len(nodes)), key=lambda i: math.dist(nodes[i], p) if i in g else 1e9)
    stops = [near(p) for p in via]
    pts, passed, path_all = [], [], [stops[0]]
    for a, b in zip(stops, stops[1:]):
        path = nx.shortest_path(g, a, b, weight="length")
        for u, v in zip(path, path[1:]):
            e = g.edges[u, v]
            line = e["line"] if u < v else e["line"][::-1]
            pts.extend(line if not pts else line[1:])
            passed.append(v)
            path_all.append(v)
    if out:
        head = onward(g, nodes, path_all[1], path_all[0], area)
        tail = onward(g, nodes, path_all[-2], path_all[-1], area)
        pts = head[::-1] + pts + tail
    return pts, [nodes[i] for i in passed if g.degree(i) >= 3]


def resample(pts, step, closed=False):
    line = LineString(pts + ([pts[0]] if closed else []))
    n = max(2, round(line.length / step))
    return np.array([line.interpolate(i / n, normalized=True).coords[0] for i in range(n + (0 if closed else 1))])


def smooth(p, window, closed):
    """Moving average over `window` points either side (twice): the corners become bends."""
    for _ in range(2):
        k = np.ones(2 * window + 1) / (2 * window + 1)
        if closed:
            q = np.concatenate([p[-window:], p, p[:window]])
            p = np.stack([np.convolve(q[:, i], k, mode="valid") for i in range(2)], axis=1)
        else:
            q = np.concatenate([np.repeat(p[:1], window, 0), p, np.repeat(p[-1:], window, 0)])
            p = np.stack([np.convolve(q[:, i], k, mode="valid") for i in range(2)], axis=1)
    return p


def lane(p, closed):
    """The path LANE to the right of the centre line (right is (-dz, dx) for a heading (dx, dz))."""
    d = (np.roll(p, -1, 0) - np.roll(p, 1, 0)) if closed else np.gradient(p, axis=0)
    d /= np.linalg.norm(d, axis=1, keepdims=True) + 1e-9
    return p + LANE * np.stack([-d[:, 1], d[:, 0]], axis=1)


def speeds(p, closed, junctions, area):
    """The highest speed at each point (km/h): the road's limit, bends, junctions."""
    n = len(p)
    out = []
    for i in range(n):
        a, b = (p[(i - 2) % n], p[(i + 2) % n]) if closed else (p[max(0, i - 2)], p[min(n - 1, i + 2)])
        c = p[i]
        h1 = math.atan2(c[1] - a[1], c[0] - a[0])
        h2 = math.atan2(b[1] - c[1], b[0] - c[0])
        turn = abs(math.atan2(math.sin(h2 - h1), math.cos(h2 - h1)))
        ds = math.dist(a, c) / 2 + math.dist(c, b) / 2
        curv = turn / max(ds, 0.1)
        v = 30 if math.dist(c, CHURCH) < SLOW_CENTRE else 50
        if curv > 1e-4:
            v = min(v, math.sqrt(A_SIDE / curv) * 3.6)
        if any(math.dist(c, j) < 12 for j in junctions):
            v = min(v, 25)
        if not area.contains(Point(c)):
            v = min(v, 40)
        out.append(max(8, round(v)))
    return out


def routes(g, nodes, area):
    out = []
    for r in ROUTES:
        closed = r.get("loop", False)
        centre, junctions = route_line(g, nodes, r["via"], area, not closed)
        legs = []
        for k in range(1 if closed else 2):
            pts = centre if k == 0 else centre[::-1]
            p = resample(pts, 1.0, closed)
            p = lane(smooth(p, 5, closed), closed)
            p = resample([tuple(q) for q in p], 2.5, closed)
            legs.append({"p": [round(float(v), 2) for q in p for v in q], "v": speeds(p, closed, junctions, area)})
        out.append({"loop": closed, "legs": legs, "gap": 0 if closed else 40,
                    "cars": [[kind, paint, phase] for kind, paint, phase in r["cars"]]})
    return out


# ---------------------------------------------------------------- parked cars

def car_box(x, z, ang, length, width):
    """A car's outline at (x, z), its length along the angle `ang` (radians from +x towards +z)."""
    b = box(-length / 2, -width / 2, length / 2, width / 2)
    return translate(rotate(b, ang, origin=(0, 0), use_radians=True), x, z)


def parked(pavings, buildings, road, hedges):
    """Cars on the drives: per paving in `mine` of at least 14 m2, a car where one fits (0.15 m in
    from its edges, 0.4 m from walls and hedges, off the road), nearest a building; about half of
    them get one, a big yard sometimes two."""
    out = []
    blocked = unary_union([buildings.buffer(0.4), road.buffer(0.2), hedges.buffer(0.35)])
    for q in pavings:
        poly = Polygon(q["p"][0]).buffer(0)
        c = poly.representative_point()
        if poly.area < 14 or not mine(c.x, c.y):
            continue
        r = hashed("park", round(c.x, 1), round(c.y, 1))
        want = 2 if poly.area > 70 and r < 0.25 else 1 if r < 0.55 else 0
        if not want:
            continue
        inner = poly.buffer(-0.15)
        rect = poly.minimum_rotated_rectangle
        rc = list(rect.exterior.coords)
        e1 = (rc[1][0] - rc[0][0], rc[1][1] - rc[0][1])
        e2 = (rc[2][0] - rc[1][0], rc[2][1] - rc[1][1])
        axes = [math.atan2(e1[1], e1[0]), math.atan2(e2[1], e2[0])]
        near_wall = buildings.distance
        placed = []
        x0, z0, x1, z1 = poly.bounds
        kind = pick([50, 40, 10], hashed("kind", round(c.x, 1), round(c.y, 1)))
        length, width = list(KINDS.values())[kind]
        cands = []
        for xi in np.arange(x0, x1, 0.5):
            for zi in np.arange(z0, z1, 0.5):
                for ang in axes:
                    b = car_box(xi, zi, ang, length + 0.2, width + 0.3)
                    if not inner.contains(b) or b.intersects(blocked):
                        continue
                    cands.append((near_wall(Point(xi, zi)), xi, zi, ang))
        cands.sort()
        for d, xi, zi, ang in cands:
            b = car_box(xi, zi, ang, length + 0.6, width + 0.6)
            if any(b.intersects(p) for p in placed):
                continue
            placed.append(b)
            # Nose towards the nearer building (parked forwards), as the game's yaw (0: nose along -z).
            nb = nearest_points(buildings, Point(xi, zi))[0]
            fx, fz = math.cos(ang), math.sin(ang)
            if (nb.x - xi) * fx + (nb.y - zi) * fz < 0:
                fx, fz = -fx, -fz
            if hashed("rev", round(xi, 1), round(zi, 1)) < 0.25:
                fx, fz = -fx, -fz  # reversed in
            yaw = math.atan2(-fx, -fz)
            paint = pick(PAINT_SHARE, hashed("paint", round(xi, 1), round(zi, 1)))
            out.append([round(xi, 2), round(zi, 2), round(yaw, 3), kind if len(placed) == 1 else pick([55, 45], hashed("k2", xi)), paint])
            if len(placed) >= want:
                break
    return out


# ---------------------------------------------------------------- along the streets

def name_graph(model, area):
    """Every named road, track and path in the area as a graph (for the name plates)."""
    g = nx.Graph()
    nodes = []

    def node(p):
        for i, q in enumerate(nodes):
            if math.dist(p, q) < 1.5:
                return i
        nodes.append(p)
        return len(nodes) - 1

    for f in features("Wegsegment"):
        pr = f["properties"]
        line = model(LineString([p[:2] for p in f["geometry"]["coordinates"]])).intersection(area)
        for part in getattr(line, "geoms", [line]):
            if part.is_empty or part.length < 1 or part.geom_type != "LineString" or pr["LSTRNM"] == "nvt":
                continue
            pts = list(part.coords)
            a, b = node(pts[0]), node(pts[-1])
            if a != b:
                g.add_edge(a, b, line=pts if a < b else pts[::-1], name=pr["LSTRNM"], paved=pr["MORF"] == 103)
    return g, nodes


def plates(model, area, road, buildings):
    """A street name plate per street where two streets meet in `mine` (or one street becomes
    another): 12 m along it from the corner, on the right of someone coming in along it, a metre
    off the road's edge."""
    g, nodes = name_graph(model, area)
    out = []
    for i in g.nodes:
        names = {}
        for j in g.neighbors(i):
            e = g.edges[i, j]
            line = e["line"] if math.dist(e["line"][0], nodes[i]) < 2 else e["line"][::-1]
            if e["name"] not in names or e["paved"] and not names[e["name"]][1]:
                names[e["name"]] = (LineString(line), e["paved"])
        if len(names) < 2 or not any(p for _, p in names.values()) or not area.buffer(-20).contains(Point(nodes[i])) or not mine(*nodes[i]):
            continue
        for name, (line, _) in names.items():
            if line.length < 16:
                continue
            a = line.interpolate(12)
            b = line.interpolate(13)
            dx, dz = a.x - b.x, a.y - b.y  # heading in, towards the corner
            n = math.hypot(dx, dz)
            rx, rz = -dz / n, dx / n
            spot = None
            for off in np.arange(1.0, 14.0, 0.25):
                p = Point(a.x + rx * off, a.y + rz * off)
                if not road.contains(p) and road.distance(p) > 0.7:
                    spot = p
                    break
            if spot is None or buildings.distance(spot) < 0.5 or BLOCK.contains(spot):
                continue
            # The plate along the street it names (read from the road it meets): the street's direction.
            out.append([round(spot.x, 2), round(spot.y, 2), round(math.atan2(dz, dx), 3), name])
    return out


def roadside(road, buildings_list, buildings, pavings, hedges, area):
    """Letterboxes and bikes at the houses in `mine` whose front faces the road."""
    boxes, bikes = [], []
    paved = unary_union([Polygon(q["p"][0]).buffer(0) for q in pavings])
    taken = []
    for b in buildings_list:
        if b["kind"] != "hoofdgebouw" or b.get("front", -1) < 0:
            continue
        ring = b["p"]
        poly = Polygon(ring).buffer(0)
        c = poly.centroid
        if not mine(c.x, c.y) or not area.buffer(-10).contains(c):
            continue
        a, bb = ring[b["front"]], ring[(b["front"] + 1) % len(ring)]
        mid = Point((a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2)
        if road.distance(mid) > 40:
            continue
        on_road = nearest_points(road, mid)[0]
        dx, dz = mid.x - on_road.x, mid.y - on_road.y
        n = math.hypot(dx, dz) or 1
        ux, uz = dx / n, dz / n  # from the road to the house
        r = hashed("box", round(c.x, 1), round(c.y, 1))
        # Letterbox: 0.9 m in from the road's edge, beside the drive (left or right of the house's middle).
        if r < 0.68:
            for side in (1.6, -1.6, 3.0, -3.0, 0.0):
                p = Point(on_road.x + ux * 0.9 - uz * side, on_road.y + uz * 0.9 + ux * side)
                if road.distance(p) < 0.6 or buildings.distance(p) < 0.6 or hedges.distance(p) < 0.4 or paved.contains(p):
                    continue
                if any(p.distance(t) < 1.2 for t in taken):
                    continue
                taken.append(p)
                boxes.append([round(p.x, 2), round(p.y, 2), round(math.atan2(-ux, -uz), 3)])  # its slot faces the road
                break
        # A bike against the front wall now and then.
        if hashed("bike", round(c.x, 1), round(c.y, 1)) < 0.12:
            fx, fz = bb[0] - a[0], bb[1] - a[1]
            fl = math.hypot(fx, fz)
            if fl > 4:
                t = 0.25 + 0.5 * hashed("bt", round(c.x, 1))
                px, pz = a[0] + fx * t, a[1] + fz * t
                ox, oz = -fz / fl, fx / fl  # the wall's outward side: towards the road
                if (mid.x + ox - on_road.x) ** 2 + (mid.y + oz - on_road.y) ** 2 > (mid.x - ox - on_road.x) ** 2 + (mid.y - oz - on_road.y) ** 2:
                    ox, oz = -ox, -oz
                p = Point(px + ox * 0.35, pz + oz * 0.35)
                if buildings.distance(p) > 0.15 and hedges.distance(p) > 0.5 and all(math.hypot(p.x - nx, p.y - nz) > 3 for nx, nz in NO_BIKE):
                    bikes.append([round(p.x, 2), round(p.y, 2), round(math.atan2(-ox, oz), 3)])  # along the wall: its right side out
    return boxes, bikes


GEO = ROOT / "source" / "geo"
# Signs that a model draws itself already, so the register's are left out there (model x, z; sign codes; within m):
MODELLED = [
    ((CHURCH[0], CHURCH[1]), ("E9a",), 30),  # tools/school.py: the parking signs for disabled drivers in the bed against the nave
    ((742.2, -725.0), ("A23", "GIa"), 35),  # tools/molenhoek_survey.py: the warning for a school route on Molenhoek's new stretch
    ((614.6, -404.6), ("B1",), 15),  # tools/kapellenhoek_survey.py: the give-way sign where Kapelleweg meets Kapellenhoek
    ((691.5, -748.0), ("D1",), 20),  # tools/molenhoek_survey.py: the keep-left sign on the island
]
# The bus stops as Street View showed them (reference only; checked 8 Nov 2026), by OpenStreetMap node: a shelter and
# a yellow litter bin, or the stop's pole alone. Not in the list: not drawn (Molenhoek's two, along the rebuilt
# stretch, aren't there in the pictures taken after the works).
STOPS_SEEN = {
    2243035144: {"shelter": True, "bin": True},  # Smetlede Kerk, on the church square's side, towards Lede
    2243035142: {"shelter": False, "bin": False},  # Smetlede Kerk, across the street: a yellow pole against a front wall
    2243034970: {"shelter": True, "bin": True},  # Smetlede Serskampstraat, on the verge by the fields
    2243034974: {"shelter": False, "bin": False},  # Smetlede Serskampstraat, across the street
}
WALKED = 25.0  # m from a house: where people walk under a sign, its lower edge 2.2 m up; elsewhere 1.5 m
HALF_STREET = 2.9  # m: half the width of Smetlededorp through the centre, where no kerb marks the carriageway


def geo_json(name):
    path = GEO / name
    if not path.exists():
        raise SystemExit(f"{path.relative_to(ROOT)} is missing: run tools/signs_data.py first")
    return json.loads(path.read_text(encoding="utf-8"))["features"]


def sign_text(code, text):
    """What a sign says (the register's parameters), without the old bank's advertising on the village name signs (F43)."""
    parts = [t.strip() for t in (text or "").split(",") if t.strip()]
    if code.startswith("F43"):
        parts = [t for t in parts if not re.search(r"KREDIET|sparen", t, re.I)]
    return "|".join(parts)


def carriageways():
    """The carriageways as the game draws them (web/src/data/roadDetail.json, tools/road_detail.py): each street's
    half widths either side of its line, kerb to kerb, without the pavements. And the lines, to tell where they hold."""
    detail = json.loads((ROOT / "web" / "src" / "data" / "roadDetail.json").read_text(encoding="utf-8"))
    polys, lines = [], []
    for run in detail["runs"] + [detail["school"]]:  # and the stretch past the school, with its plateau
        p, w = run["p"], run["w"]
        pts = [(p[k], p[k + 1]) for k in range(0, len(p), 2)]
        if len(pts) < 2:
            continue
        left, right = [], []
        for k, (x, z) in enumerate(pts):
            a, b = pts[max(0, k - 2)], pts[min(len(pts) - 1, k + 2)]
            n = math.hypot(b[0] - a[0], b[1] - a[1]) or 1
            nx, nz = -(b[1] - a[1]) / n, (b[0] - a[0]) / n  # to the right of the way the line runs (as road_detail.py)
            left.append((x + nx * w[2 * k], z + nz * w[2 * k]))
            right.append((x - nx * w[2 * k + 1], z - nz * w[2 * k + 1]))
        polys.append(Polygon(left + right[::-1]).buffer(0))
        lines.append(LineString(pts))
    return unary_union(polys), unary_union(lines)


class Spots:
    """Where a pole may stand: off the carriageway (as the game draws it; behind Molenhoek's new pavements; off the
    GRB's road surface away from the drawn streets), clear of the buildings, the hedges, the drives and yards, and of
    the other things along the street. On a pavement is fine: that is where most signs stand."""

    def __init__(self, road, centre, buildings, taken):
        self.road, self.centre, self.buildings, self.taken = road, centre, buildings, list(taken)
        self.carriage, self.streets = carriageways()
        self.carriage_in = prep(self.carriage)
        self.portals = portal_spots()

    def free(self, p, gap):
        return (self.buildings.distance(p) >= 0.45 and not BLOCK.contains(p)
                and all(p.distance(t) >= gap for t in self.taken)
                and all(math.dist((p.x, p.y), s) >= 4.0 for s in self.portals))

    def off_road(self, p, margin):
        if NEW_STREET.distance(p) < 8:
            # Along Molenhoek's new stretch the GRB's road surface takes in the forecourts: go by the street's own outline.
            return NEW_STREET.distance(p) >= 0.25
        if self.streets.distance(p) < 10:
            return not self.carriage_in.contains(p) and self.carriage.distance(p) >= margin
        if math.dist((p.x, p.y), CHURCH) < CENTRE:
            # The church square and the street through it are one paved floor (data/smetlede.json): keep clear of the
            # traffic by the distance from the centre line, half a street's width and a margin.
            return self.centre.distance(p) >= HALF_STREET + margin
        return not self.road.contains(p) and self.road.distance(p) >= margin

    def find(self, x, z, margin=0.3, gap=0.9):
        """The spot nearest (x, z) that is off the road and free: pushed straight out from the centre line, and a little
        along the road where a drive or a hedge is in the way. (spot, how far it moved) or None."""
        p0 = Point(x, z)
        on = nearest_points(self.centre, p0)[0]
        ox, oz = p0.x - on.x, p0.y - on.y
        n = math.hypot(ox, oz)
        if n < 0.05:
            return None
        ox, oz = ox / n, oz / n  # away from the centre line
        ax, az = -oz, ox  # along the road
        best = None
        alongs = (0.0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5, 2.0, -2.0, 3.0, -3.0, 4.0, -4.0, 5.0, -5.0)
        for along in alongs:
            if best and best[1] <= abs(along):
                break  # nothing further along can be nearer
            for out in np.arange(0.0, 6.01, 0.1):
                p = Point(x + ax * along + ox * out, z + az * along + oz * out)
                if self.off_road(p, margin) and self.free(p, gap):
                    moved = math.hypot(along, out)
                    if best is None or moved < best[1]:
                        best = (p, moved)
                    break
        if best:
            self.taken.append(best[0])
        return best

    def facing_traffic(self, p):
        """The way a face looks at the traffic on the near side of the road at p (the traffic keeps right)."""
        on = nearest_points(self.centre, p)[0]
        line = min(getattr(self.centre, "geoms", [self.centre]), key=lambda l: l.distance(on))
        d = line.project(on)
        a, b = line.interpolate(max(0.0, d - 2)), line.interpolate(min(line.length, d + 2))
        tx, tz = b.x - a.x, b.y - a.y
        n = math.hypot(tx, tz)
        tx, tz = tx / n, tz / n
        ox, oz = p.x - on.x, p.y - on.y
        # Driving along t, the right is (-tz, tx) in the model's frame (x, z; seen from above, as the yaw turns).
        if ox * -tz + oz * tx < 0:
            tx, tz = -tx, -tz  # the traffic on this side goes the other way
        return -tx, -tz, (-ox, -oz)


def street_signs(to_model, area, road, centre, buildings, taken):
    """The traffic signs of the register (Verkeersborden.Vlaanderen, tools/signs_data.py) inside the area, one pole each:
    [x, z, lower edge (m), [[yaw, [[code, shape, w, h, dy, text], ...]], ...]], each face's signs from the bottom up
    (dy: m above the lowest one's lower edge). And the bus stops (OpenStreetMap, STOPS_SEEN):
    [x, z, yaw, name, bin [x, z, yaw] or None, shelter [x, z, yaw] or None]. Also a list of what moved or was left out."""
    a, b, d, e, xo, zo = to_model
    model_pt = lambda x, y: (a * x + b * y + xo, d * x + e * y + zo)
    by_face = {}
    for f in geo_json("Verkeersborden_l72.json"):
        by_face.setdefault(f["properties"]["id_aanzicht"], []).append(f["properties"])
    poles = {}
    for f in geo_json("VerkeersbordenOpstellingen_l72.json"):
        poles.setdefault(f["properties"]["id_opstelling"], []).append(f)
    spots = Spots(road, centre, buildings, taken)
    inner = area.buffer(-5)
    out, notes = [], []
    for pid in sorted(poles):
        faces = poles[pid]
        x, z = model_pt(*faces[0]["geometry"]["coordinates"][:2])
        if not inner.contains(Point(x, z)):
            continue
        made = []
        for fa in sorted(faces, key=lambda f: f["properties"]["id_aanzicht"]):
            pr = fa["properties"]
            signs = by_face.get(pr["id_aanzicht"], [])
            if pr["status"] != "ACTUEEL" or not signs:
                continue
            if any(math.dist((x, z), at) < reach and any(s["bordcode"].startswith(c) for s in signs for c in codes)
                   for at, codes, reach in MODELLED):
                notes.append(f"pole {pid}: {'+'.join(s['bordcode'] for s in signs)} drawn by a model already")
                continue
            # The way the face looks (Lambert 72 east, north): (sin h, -cos h). Checked against the road: of the faces
            # along a road, 68 stand on the right of the traffic they face and 5 on its left (zijde_van_rijweg RECHTS).
            fx, fy = math.sin(pr["hoek"]), -math.cos(pr["hoek"])
            yaw = math.atan2(a * fx + b * fy, d * fx + e * fy)
            low = min(s["opstelhoogte"] for s in signs)
            rows = sorted(([s["bordcode"], s["vorm"], round(s["breedte"] / 1000, 3), round(s["hoogte"] / 1000, 3),
                            round((s["opstelhoogte"] - low) / 1000, 3), sign_text(s["bordcode"], s["parameters"])] for s in signs),
                          key=lambda r: r[4])
            made.append([round(yaw, 3), rows])
        if not made:
            continue
        spot = spots.find(x, z)
        if spot is None:
            notes.append(f"pole {pid} ({x:.1f}, {z:.1f}): no free spot off the road")
            continue
        p, moved = spot
        if moved > 0.05:
            notes.append(f"pole {pid}: moved {moved:.1f} m (off the road or out of a drive, a hedge)")
        lower = 2.2 if buildings.distance(p) < WALKED else 1.5
        out.append([round(p.x, 2), round(p.y, 2), lower, made])
    stops = []
    for f in geo_json("Bushaltes_l72.json"):
        pr = f["properties"]
        seen = STOPS_SEEN.get(pr["osm_id"])
        x, z = model_pt(*f["geometry"]["coordinates"][:2])
        if not inner.contains(Point(x, z)):
            continue
        if seen is None:
            notes.append(f"bus stop {pr['name']} (node {pr['osm_id']}): not seen in Street View, left out")
            continue
        spot = spots.find(x, z, margin=0.4)
        if spot is None:
            notes.append(f"bus stop {pr['name']}: no free spot")
            continue
        p = spot[0]
        fx, fz, to_road = spots.facing_traffic(p)
        yaw = round(math.atan2(fx, fz), 3)
        n = math.hypot(*to_road)
        rx, rz = to_road[0] / n, to_road[1] / n  # towards the road
        bin_at = shelter_at = None
        if seen["bin"]:
            # The bin on its own post beside the stop's, a little further back, on the side the bus comes from.
            for s in (0.7, -0.7, 1.1, -1.1):
                q = Point(p.x - fx * s - rx * 0.25, p.y - fz * s - rz * 0.25)
                if spots.off_road(q, 0.4) and spots.free(q, 0.5):
                    bin_at = [round(q.x, 2), round(q.y, 2), round(math.atan2(rx, rz), 3)]
                    spots.taken.append(q)
                    break
        if seen["shelter"]:
            # The shelter (3.4 x 1.7 m) beside the pole, its open side to the road, clear of the road, the houses, drives, hedges.
            ang = math.atan2(-fz, -fx)  # its length along the road
            for along in (-2.6, 2.6, -3.2, 3.2, -4.0, 4.0):
                done = False
                for back in np.arange(0.9, 3.01, 0.15):
                    cx, cz = p.x - fx * along - rx * back, p.y - fz * along - rz * back
                    foot = car_box(cx, cz, ang, 3.4, 1.7)
                    if foot.distance(spots.carriage) < 0.5 or not all(spots.off_road(Point(c), 0.5) for c in foot.exterior.coords) \
                            or foot.distance(buildings) < 0.4 or foot.intersects(BLOCK) or any(foot.distance(Point(s)) < 4.0 for s in spots.portals) \
                            or foot.distance(NEW_STREET) < 0.25 or any(foot.distance(t) < 0.3 for t in spots.taken):
                        continue
                    shelter_at = [round(cx, 2), round(cz, 2), round(math.atan2(rx, rz), 3)]
                    done = True
                    break
                if done:
                    break
            if shelter_at is None:
                notes.append(f"bus stop {pr['name']}: no room for its shelter")
        stops.append([round(p.x, 2), round(p.y, 2), yaw, pr["name"], bin_at, shelter_at])
    return out, stops, notes


MOLENHOEK = None
BLOCK = None  # hedges and pavings
# No bike against these front walls (Yoshi): the end house of the new terrace at Molenhoek, which can be walked into.
NO_BIKE = [(1508.0, -360.1)]


def new_street():
    """Molenhoek's rebuilt street with its cycle lanes and pavements (data/molenhoek.json, tools/molenhoek.py):
    its outline up to the pavements' outer edges, as the model draws it."""
    path = ROOT / "data" / "molenhoek.json"
    if not path.exists():
        return Polygon()
    d = json.loads(path.read_text(encoding="utf-8"))
    line, left, right = d["line"], d["left"], d["right"]
    out_l, out_r = [], []
    for k, (x, z) in enumerate(line):
        a, b = line[max(0, k - 1)], line[min(len(line) - 1, k + 1)]
        n = math.hypot(b[0] - a[0], b[1] - a[1])
        nx, nz = -(b[1] - a[1]) / n, (b[0] - a[0]) / n
        wl, wr = min(6.8, max(5.5, left[k])), min(6.8, max(5.5, right[k]))
        out_l.append((x + nx * wl, z + nz * wl))
        out_r.append((x - nx * wr, z - nz * wr))
    return Polygon(out_l + out_r[::-1]).buffer(0)


NEW_STREET = new_street()


def main():
    global MOLENHOEK, BLOCK
    plot, _, to_model = model_frame()
    model = lambda geom: affine_transform(geom, to_model)
    area = model(zone(plot))
    nb = json.loads((ROOT / "data" / "neighbours.json").read_text(encoding="utf-8"))
    st = json.loads((ROOT / "data" / "street.json").read_text(encoding="utf-8"))
    house = json.loads((ROOT / "web" / "src" / "data" / "house_shell.json").read_text(encoding="utf-8"))
    village = json.loads((ROOT / "web" / "src" / "data" / "village.json").read_text(encoding="utf-8"))
    road = unary_union([Polygon(p["p"][0], p["p"][1:]).buffer(0) for p in house["surroundings"]["prisms"] + village["prisms"] if p["m"] == "road"])
    buildings_list = [b for b in nb["buildings"]]
    for b in buildings_list:
        if isinstance(b["p"], str):
            b["p"] = json.loads(b["p"])
    buildings = unary_union([Polygon(b["p"]).buffer(0) for b in buildings_list])
    hedges = unary_union([LineString(h["path"]).buffer(0.4) for h in st["hedges"] if len(h["path"]) > 1])

    BLOCK = unary_union([hedges] + [Polygon(q["p"][0]).buffer(0) for q in st["pavings"]])
    g, nodes = road_graph(model, area)
    MOLENHOEK = unary_union([LineString(e["line"]) for _, _, e in g.edges(data=True) if e["name"] == "Molenhoek"])
    out = {
        "_source": "GRB Wegsegment (road centre lines and street names), buildings, pavings and hedges from tools/neighbours.py and "
                   "tools/street.py (Digitaal Vlaanderen, open data); the traffic signs from Verkeersborden.Vlaanderen (Bron: MOW - AWV, "
                   "Modellicentie Gratis Hergebruik), the bus stops from OpenStreetMap (ODbL, © OpenStreetMap contributors); "
                   "parked cars, letterboxes, bins and bikes are made up",
        "routes": routes(g, nodes, area),
        "parked": parked(st["pavings"], buildings, road, hedges),
        "plates": plates(model, area, road, buildings),
    }
    roadside_houses = buildings_list
    custom_garden = ROOT / "data/kouter_house.json"
    if custom_garden.exists():
        # This house has its own letterbox and garden fittings; don't put a guessed second one by its drive.
        own = unary_union([Polygon(p) for p in json.loads(custom_garden.read_text(encoding="utf-8"))["clear"]])
        roadside_houses = [b for b in buildings_list if not own.contains(Polygon(b["p"]).centroid)]
    out["boxes"], out["bikes"] = roadside(road, roadside_houses, buildings, st["pavings"], hedges, area)
    centre = unary_union([model(LineString([p[:2] for p in f["geometry"]["coordinates"]])) for f in features("Wegsegment")
                          if f["geometry"]["type"] == "LineString"]).intersection(area.buffer(60))
    taken = [Point(q[0], q[1]) for key in ("plates", "boxes", "bikes") for q in out[key]]
    out["signs"], out["stops"], notes = street_signs(to_model, area, road, centre, buildings, taken)
    for n in notes:
        print("  " + n)
    spots = portal_spots()
    assert len(spots) >= 15, "portals.mjs: the portals' spots weren't found"
    for key in ("parked", "plates", "signs", "stops", "boxes", "bikes"):
        kept = clear_of(spots, out[key], 4.0 + (3.0 if key == "parked" else 0.0))
        if key in ("signs", "stops") and len(kept) < len(out[key]):
            print(f"  {len(out[key]) - len(kept)} {key} left out within 4 m of a portal")
        out[key] = kept
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    total = sum(len(l["v"]) for r in out["routes"] for l in r["legs"])
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB): {len(out['routes'])} routes ({total} points), "
          f"{len(out['parked'])} parked cars, {len(out['plates'])} name plates, {len(out['signs'])} sign poles "
          f"({sum(len(s) for p in out['signs'] for _, s in p[3])} signs), {len(out['stops'])} bus stops, "
          f"{len(out['boxes'])} letterboxes, {len(out['bikes'])} bikes")
    debug(out, area, road, buildings_list, g, nodes)


def debug(out, area, road, buildings_list, g, nodes):
    x0, z0, x1, z1 = -300, -1120, 900, 260
    k = 1.2
    img = Image.new("RGB", (int((x1 - x0) * k), int((z1 - z0) * k)), (246, 246, 240))
    d = ImageDraw.Draw(img)
    P = lambda q: ((q[0] - x0) * k, (q[1] - z0) * k)
    d.line([P(q) for q in area.exterior.coords], fill=(200, 60, 60))
    for poly in getattr(road, "geoms", [road]):
        d.polygon([P(q) for q in poly.exterior.coords], fill=(205, 205, 215))
    for b in buildings_list:
        d.polygon([P(q) for q in b["p"]], outline=(200, 140, 140))
    colours = [(220, 30, 30), (30, 120, 220), (30, 160, 60), (200, 120, 0)]
    for i, r in enumerate(out["routes"]):
        for leg in r["legs"]:
            p = leg["p"]
            pts = [(p[j], p[j + 1]) for j in range(0, len(p), 2)]
            d.line([P(q) for q in pts], fill=colours[i % 4], width=1)
            for j in range(0, len(pts) - 1, 12):  # arrows: which way
                a, b = pts[j], pts[j + 1]
                d.line([P(a), P((a[0] + (b[0] - a[0]) * 1.6, a[1] + (b[1] - a[1]) * 1.6))], fill=colours[i % 4], width=3)
    for x, z, yaw, kind, paint in out["parked"]:
        fx, fz = -math.sin(yaw), -math.cos(yaw)
        d.line([P((x - fx * 2, z - fz * 2)), P((x + fx * 2, z + fz * 2))], fill=(0, 0, 0), width=3)
        d.ellipse([P((x + fx * 2 - 0.7, z + fz * 2 - 0.7)), P((x + fx * 2 + 0.7, z + fz * 2 + 0.7))], fill=(255, 0, 255))
    for x, z, yaw, name in out["plates"]:
        d.rectangle([P((x - 1.5, z - 1.5)), P((x + 1.5, z + 1.5))], fill=(0, 90, 200))
        d.text(P((x + 2, z)), name, fill=(0, 60, 140))
    for x, z, _, faces in out["signs"]:
        d.rectangle([P((x - 1.5, z - 1.5)), P((x + 1.5, z + 1.5))], fill=(230, 0, 0))
        for yaw, signs in faces:
            d.line([P((x, z)), P((x + math.sin(yaw) * 5, z + math.cos(yaw) * 5))], fill=(230, 0, 0), width=2)
        d.text(P((x + 2, z - 8)), "+".join(s[0] for _, signs in faces for s in signs), fill=(200, 0, 0))
    for x, z, yaw, name, bin_at, shelter in out["stops"]:
        d.ellipse([P((x - 2, z - 2)), P((x + 2, z + 2))], fill=(240, 190, 0))
        if shelter:
            d.polygon([P(q) for q in car_box(shelter[0], shelter[1], -shelter[2], 3.4, 1.7).exterior.coords], fill=(120, 120, 120))
        d.text(P((x + 2, z + 2)), name, fill=(150, 110, 0))
    for x, z, yaw in out["boxes"]:
        d.ellipse([P((x - 1, z - 1)), P((x + 1, z + 1))], fill=(40, 40, 40))
    for x, z, yaw in out["bikes"]:
        d.ellipse([P((x - 1.2, z - 1.2)), P((x + 1.2, z + 1.2))], fill=(0, 170, 170))
    for c, r in ((HOUSE, RING), (HOUSE, HOME), (CHURCH, CENTRE), (CHURCH, 340)):
        d.ellipse([P((c[0] - r, c[1] - r)), P((c[0] + r, c[1] + r))], outline=(150, 150, 150))
    DEBUG.parent.mkdir(parents=True, exist_ok=True)
    img.save(DEBUG)


if __name__ == "__main__":
    main()
