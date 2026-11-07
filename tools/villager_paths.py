"""Where the villagers walk and cycle in Explore: web/src/data/villagers.json.

Run: tools/.venv/Scripts/python.exe tools/villager_paths.py

The villagers (web/src/world/villagers.ts, our own models from tools/villagers.py) keep to public ground:
- `walks`: lines people walk along. On every street of the road detail (web/src/data/roadDetail.json,
  measured on the GRB) one either side: the middle of the pavement where there is a kerb, else just off the
  carriageway's edge; a footpath's own middle. On Molenhoek's rebuilt street (data/molenhoek.json, as
  tools/molenhoek.py lays it) the middle of each pavement. A line stops where it would run onto another
  street's carriageway (a junction: people cross there, see `links`), into a wall, hedge or fence
  (web/src/data/village.json and house_shell.json, blocks 35 cm or more high with a footprint of their own,
  so lamp posts don't cut it), into a house of a street model, or into one of the three private homes
  (web/shared/homes.mjs). The lines are thinned to where they bend (20 cm). `wkind`: 0 a village pavement
  (a kerb along most of it), 1 the edge of a country road, 2 a footpath.
- `links`: [walk, point, walk, point, road] ways from one line to another: a crossing of the street to its
  other side every CROSS_EVERY m and at the zebra by the school, and from each end of a line to the
  nearest other line within JOIN m when nothing stands in the way. `road` 1: the way crosses a carriageway
  (a villager looks for cars first, and the traffic stops for one on it).
- `bikes`: lines cyclists ride along, each one way (on the right, as in Belgium): Molenhoek's red cycle
  lanes, and elsewhere the carriageway's right-hand edge. `bkind`: 0 a cycle lane, 1 the road.
  `bnext`: per line, where it may go on from its end: [line, point] pairs (another street's lane
  within BIKE_JOIN m going a way that doesn't double back; a dead end turns round onto the other side).
- `seats`: [x, z, facing, height] places to sit: the benches of the church square, the chip shop and the
  bus shelter (tools/town/houses.json). Facing is the game's heading (atan2 of the way they look).
- `hubs`: [x, z, radius, kind] busier places: 0 the church square, 1 the school, 2 the café Sparrenhof; `hubspots`, per
  hub, the spots there people stand about on (x, z, ...): public paving off the carriageways and the traffic's routes.

Nothing here comes from a person or a house: only the public road data and the benches the town model
places. Model coordinates (x, z) in metres, two decimals.
"""
import json
import math
import re
import subprocess
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "src" / "data" / "villagers.json"
DETAIL = json.loads((ROOT / "web/src/data/roadDetail.json").read_text(encoding="utf-8"))
VILLAGE = json.loads((ROOT / "web/src/data/village.json").read_text(encoding="utf-8"))
SHELL = json.loads((ROOT / "web/src/data/house_shell.json").read_text(encoding="utf-8"))
MOLEN = json.loads((ROOT / "data/molenhoek.json").read_text(encoding="utf-8"))
TOWN = json.loads((ROOT / "tools/town/houses.json").read_text(encoding="utf-8"))

CROSS_EVERY = 45.0  # m between crossings of one street
JOIN = 11.0  # m: a line's end joins the nearest other line this near
BIKE_JOIN = 12.0
MIN_PIECE = 8.0  # m: shorter bits of a line are left out
SIMPLIFY = 0.2
# Molenhoek's cross-section (tools/molenhoek.py): asphalt, gutter, cycle lane, kerb; the old road west of the island.
M_ASPH, M_GUT, M_LANE, M_KERB, M_OLD_WALK = 2.5, 2.85, 4.45, 4.6, 3.2
M_WEST, M_EAST = 689.0, 936.0
# Ground, not things one bumps into.
GROUND = {"road", "pave_light", "pave_warm", "pave_grey", "concrete", "track", "gravel", "field_crop", "field_soil", "field_dark", "forest",
          "pool_water", "grass", "nb_roof", "pole", "floor_wood", "tiles"}
HUBS = [(532.0, -762.0, 30.0, 0), (482.0, -790.0, 22.0, 1), (636.0, 945.0, 26.0, 2)]
HUB_STEP = 2.5  # m between the spots people stand about on there
HUB_GROUND = {"pave_light", "pave_warm", "pave_grey", "concrete"}
ROUTE_CLEAR = 3.5  # m from the middle of a car's route


def unit(ax, az, bx, bz):
    dx, dz = bx - ax, bz - az
    L = math.hypot(dx, dz) or 1.0
    return dx / L, dz / L


def stations(pts):
    """Points with their tangent and normal (+ side: (-tz, tx), the right of the way the stations run)."""
    out = []
    for i, (x, z) in enumerate(pts):
        a, b = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
        tx, tz = unit(a[0], a[1], b[0], b[1])
        out.append((x, z, tx, tz, -tz, tx))
    return out


def pairs(flat):
    return [(flat[i], flat[i + 1]) for i in range(0, len(flat), 2)]


# ---- The carriageways (where people don't walk along), and what stands in the way.
RUNS = []
for r in DETAIL["runs"]:
    st = stations(pairs(r["p"]))
    RUNS.append(dict(name=r["name"], pf=r["pf"], st=st, w=pairs(r["w"]), k=r["k"], q=pairs(r["q"])))


def strip(st, wf):
    """The polygons between stations from -w to +w (wf(i) -> (w+, w-))."""
    polys = []
    for i in range(len(st) - 1):
        (x0, z0, _, _, nx0, nz0), (x1, z1, _, _, nx1, nz1) = st[i], st[i + 1]
        (p0, m0), (p1, m1) = wf(i), wf(i + 1)
        poly = Polygon([(x0 + nx0 * p0, z0 + nz0 * p0), (x1 + nx1 * p1, z1 + nz1 * p1), (x1 - nx1 * m1, z1 - nz1 * m1), (x0 - nx0 * m0, z0 - nz0 * m0)])
        if poly.is_valid and poly.area > 0:
            polys.append(poly)
    return polys


carriage = []
for r in RUNS:
    if r["pf"].startswith("path_"):
        continue
    carriage += strip(r["st"], lambda i, r=r: r["w"][i])
M_ST = stations(MOLEN["line"])
M_LR = list(zip(MOLEN["left"], MOLEN["right"]))
S_ST = stations(MOLEN["stub"]["line"]) if MOLEN.get("stub") else []
S_LR = list(zip(MOLEN["stub"]["left"], MOLEN["stub"]["right"])) if MOLEN.get("stub") else []
carriage += strip(M_ST, lambda i: (M_ASPH, M_ASPH))
carriage += strip(S_ST, lambda i: (M_ASPH, M_ASPH))
CARRIAGE = unary_union(carriage)

blocks = []
for pr in VILLAGE["prisms"] + SHELL["prisms"] + SHELL["surroundings"]["prisms"]:
    if pr["m"] in GROUND or pr["y1"] - pr["y0"] < 0.35:
        continue
    for ring_ in pr["p"][:1]:
        if len(ring_) < 3:
            continue
        poly = Polygon(ring_)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.area > 0.6 or poly.length > 6.0:
            blocks.append(poly)
for h in MOLEN["houses"].values():
    blocks.append(Polygon(h["outline"]))
homes = json.loads(subprocess.run(["node", "-e", "import('./web/shared/homes.mjs').then(m=>console.log(JSON.stringify(m.HOMES)))"], cwd=ROOT, capture_output=True,
                                  text=True, check=True).stdout)
private = [Polygon(b["ring"]).buffer(1.0) for h in homes for b in h["bands"]]
# The end house's garden (homes.mjs keeps its ring to itself: read from the file).
_g = re.search(r"END_GARDEN = \{[^}]*ring: (\[\[.*?\]\])", (ROOT / "web/shared/homes.mjs").read_text(encoding="utf-8"))
if _g:
    private.append(Polygon(json.loads(_g.group(1))).buffer(1.0))
blocks += private
BLOCKS = STRtree(blocks)


def blocked_at(x, z, r=0.25):
    p = Point(x, z)
    for i in BLOCKS.query(p.buffer(r)):
        if blocks[i].distance(p) < r:
            return True
    return False


def on_road(x, z):
    return CARRIAGE.contains(Point(x, z))


def way_clear(a, b):
    line = LineString([a, b])
    return not any(blocks[i].intersects(line) for i in BLOCKS.query(line))


# ---- Walks.
walks, wkind = [], []
sides = {}  # (run, side) -> {station: (walk, point)} before thinning, for the crossings


def add_walk(pts, kind, key=None, idx=None):
    """Keep the stretches of pts that are free; record each kept station's place (for crossings)."""
    piece, pidx = [], []

    def flush():
        if len(piece) >= 2 and LineString(piece).length >= MIN_PIECE:
            walks.append(list(piece))
            wkind.append(kind)
            if key is not None:
                for j, s in enumerate(pidx):
                    sides.setdefault(key, {})[s] = (len(walks) - 1, j)
        piece.clear()
        pidx.clear()

    for j, (x, z) in enumerate(pts):
        if on_road(x, z) or blocked_at(x, z):
            flush()
            continue
        piece.append((x, z))
        pidx.append(idx[j] if idx else j)
    flush()


for ri, r in enumerate(RUNS):
    st = r["st"]
    if r["pf"].startswith("path_"):
        add_walk([(s[0], s[1]) for s in st], 2)
        continue
    kerbs = sum(1 for k in r["k"] if k & 3) / max(1, len(r["k"]))
    for side, sign, bit in ((0, 1, 1), (1, -1, 2)):
        off = []
        for i in range(len(st)):
            w, q = r["w"][i][side], r["q"][i][side]
            off.append(w + min(q, 2.6) * 0.5 if (r["k"][i] & bit) and q > 0.8 else w + max(0.3, min(0.8, q * 0.35)))
        off = [sum(off[max(0, i - 1):i + 2]) / len(off[max(0, i - 1):i + 2]) for i in range(len(off))]
        pts = [(s[0] + s[4] * o * sign, s[1] + s[5] * o * sign) for s, o in zip(st, off)]
        add_walk(pts, 0 if kerbs > 0.3 else 1, (ri, side), list(range(len(st))))


def molen_walks(st, lr, idxs, key):
    for side, sign in ((0, 1), (1, -1)):
        pts = []
        for i in idxs:
            x, z, _, _, nx, nz = st[i]
            edge = min(6.8, max(M_KERB + 0.9, lr[i][side]))
            inner = M_KERB if x >= M_WEST + 4 else M_OLD_WALK
            o = (inner + edge) / 2
            pts.append((x + nx * o * sign, z + nz * o * sign))
        add_walk(pts, 0, (key, side), idxs)


m_idx = [i for i, s in enumerate(M_ST) if s[0] <= M_EAST]
molen_walks(M_ST, M_LR, m_idx, "molenhoek")
if S_ST:
    first = next(i for i, s in enumerate(S_ST) if LineString([(p[0], p[1]) for p in M_ST]).distance(Point(s[0], s[1])) >= 7.0)
    molen_walks(S_ST, S_LR, list(range(first, len(S_ST))), "stub")

# Crossings within a street, at the zebra and every CROSS_EVERY m.
links = []
zebras = [(zb["x"], zb["z"]) for zb in DETAIL["zebras"]]
for key, side0 in sides.items():
    if key[1] != 0 or (key[0], 1) not in sides:
        continue
    side1 = sides[(key[0], 1)]
    last = -1e9
    st = RUNS[key[0]]["st"] if isinstance(key[0], int) else (M_ST if key[0] == "molenhoek" else S_ST)
    along = 0.0
    for i in range(len(st)):
        if i:
            along += math.hypot(st[i][0] - st[i - 1][0], st[i][1] - st[i - 1][1])
        if i not in side0 or i not in side1:
            continue
        zebra = any(math.hypot(st[i][0] - zx, st[i][1] - zz) < 3.0 for zx, zz in zebras)
        if along - last >= CROSS_EVERY or zebra:
            (a, ai), (b, bi) = side0[i], side1[i]
            if way_clear(walks[a][ai], walks[b][bi]):
                links.append([a, ai, b, bi, 1])
                last = along

# Thin the lines (keeping the points the crossings use) and renumber those points.
keep_pts = {}
for a, ai, b, bi, _ in links:
    keep_pts.setdefault(a, set()).add(ai)
    keep_pts.setdefault(b, set()).add(bi)
thin, remap = [], []
for wi, pts in enumerate(walks):
    simple = LineString(pts).simplify(SIMPLIFY, preserve_topology=False)
    sp = [tuple(c) for c in simple.coords]
    keepi = set()
    j = 0
    for i, p in enumerate(pts):  # simplify keeps some of the points, in order: find them
        if j < len(sp) and abs(sp[j][0] - p[0]) < 1e-9 and abs(sp[j][1] - p[1]) < 1e-9:
            keepi.add(i)
            j += 1
    keepi |= keep_pts.get(wi, set())
    keepi |= {0, len(pts) - 1}
    order = sorted(keepi)
    thin.append([pts[i] for i in order])
    remap.append({o: n for n, o in enumerate(order)})
walks = thin
links = [[a, remap[a][ai], b, remap[b][bi], road] for a, ai, b, bi, road in links]

# Each end of a line to the nearest other line.
segs = []
for wi, pts in enumerate(walks):
    for j in range(len(pts) - 1):
        segs.append((wi, j, LineString([pts[j], pts[j + 1]])))
SEGS = STRtree([s[2] for s in segs])
seen_join = set()
for wi, pts in enumerate(walks):
    for end, ei in ((pts[0], 0), (pts[-1], len(pts) - 1)):
        p = Point(end)
        best = None
        for si in SEGS.query(p.buffer(JOIN)):
            wj, j, seg = segs[si]
            if wj == wi:
                continue
            d = seg.distance(p)
            if d > JOIN or (best and d >= best[0]):
                continue
            # The nearer of the segment's two points.
            a, b = walks[wj][j], walks[wj][j + 1]
            k = j if math.hypot(a[0] - end[0], a[1] - end[1]) <= math.hypot(b[0] - end[0], b[1] - end[1]) else j + 1
            best = (d, wj, k)
        if not best:
            continue
        _, wj, k = best
        key = (min((wi, ei), (wj, k)), max((wi, ei), (wj, k)))
        if key in seen_join or not way_clear(end, walks[wj][k]):
            continue
        seen_join.add(key)
        mid = LineString([end, walks[wj][k]])
        links.append([wi, ei, wj, k, 1 if mid.intersects(CARRIAGE) else 0])

# ---- Bikes: one way each, on the right.
bikes, bkind, partner = [], [], {}


def add_bike(pts, kind):
    if len(pts) >= 2 and LineString(pts).length >= 20:
        bikes.append(LineString(pts).simplify(SIMPLIFY).coords[:])
        bkind.append(kind)
        return len(bikes) - 1
    return -1


def bike_pair(st, off, kind):
    plus = add_bike([(s[0] + s[4] * o, s[1] + s[5] * o) for s, o in zip(st, off)], kind)
    minus = add_bike([(s[0] - s[4] * o, s[1] - s[5] * o) for s, o in zip(st, off)][::-1], kind)
    for me, other in ((plus, minus), (minus, plus)):
        if me >= 0:
            partner[me] = other


for r in RUNS:
    if r["pf"].startswith("path_"):
        continue
    off = [max(0.9, (w0 + w1) / 2 - 0.65) for w0, w1 in r["w"]]
    bike_pair(r["st"], off, 1)
mk = [i for i, s in enumerate(M_ST) if M_WEST + 4 <= s[0] <= M_EAST]
bike_pair([M_ST[i] for i in mk], [(M_GUT + M_LANE) / 2] * len(mk), 0)
if S_ST:
    bike_pair(S_ST[first:], [(M_GUT + M_LANE) / 2] * (len(S_ST) - first), 0)


def heading(pts, i, back=False):
    a, b = (pts[max(0, i - 1)], pts[i]) if back else (pts[i], pts[min(len(pts) - 1, i + 1)])
    return unit(a[0], a[1], b[0], b[1])


bnext = []
for bi, pts in enumerate(bikes):
    end = pts[-1]
    hx, hz = heading(pts, len(pts) - 1, True)
    found = []
    for bj, other in enumerate(bikes):
        if bj == bi or bj == partner[bi]:
            continue
        for k, q in enumerate(other[:-1]):
            d = math.hypot(q[0] - end[0], q[1] - end[1])
            if d > BIKE_JOIN:
                continue
            ox, oz = heading(other, k)
            ahead = (q[0] - end[0]) * hx + (q[1] - end[1]) * hz
            if ox * hx + oz * hz > -0.3 and ahead > -2.0:
                found.append([bj, k, d])
    best = {}
    for bj, k, d in found:
        if bj not in best or d < best[bj][2]:
            best[bj] = [bj, k, d]
    nxt = [[b_, k] for b_, k, _ in sorted(best.values(), key=lambda v: v[2])[:4]]
    if not nxt and partner[bi] >= 0:
        nxt = [[partner[bi], 0]]
    bnext.append(nxt)

# ---- Seats and hubs.
seats = []
for f in TOWN["fittings"]:
    k = f["k"]
    if k not in ("bench", "stonebench", "lowbench", "shelter"):
        continue
    x, z = f["p"]
    yaw = f.get("yaw", 0.0)
    cu, su = math.cos(yaw), math.sin(yaw)

    def at(a, c):
        return (x + cu * a - su * c, z + su * a + cu * c)

    # Which way the sitter looks: away from a back (-c), towards the street from the shop's front (+c).
    look = {"bench": -1, "stonebench": -1, "lowbench": 1, "shelter": -1}[k]
    fx, fz = -su * look, cu * look
    face = math.atan2(fx, fz)
    h = {"bench": 0.46, "stonebench": 0.46, "lowbench": 0.4, "shelter": 0.5}[k]
    if k == "shelter":
        L, D = f.get("l", 4.2), f.get("d", 1.5)
        spots = [at(a, D / 2 - 0.3) for a in (-L / 4, L / 4)]
    else:
        w = f.get("w", 1.8)
        spots = [at(a, 0.0) for a in (-w / 4, w / 4)]
    for sx, sz in spots:
        seats.append([round(sx, 2), round(sz, 2), round(face, 3), h])

# Where people may stand about at the busy places: a grid of spots on public paving (the village's road surface,
# pavements and squares), off every carriageway and more than ROUTE_CLEAR m from the traffic's routes (cars cross the
# church square), clear of walls and private homes. The game keeps those free of its own models' blocks too.
ROADS = json.loads((ROOT / "web/src/data/roads.json").read_text(encoding="utf-8"))
ROUTES = unary_union([LineString(pairs(leg["p"])) for r in ROADS["routes"] for leg in r["legs"] if len(leg["p"]) >= 4]).buffer(ROUTE_CLEAR)
PAVED = [Polygon(pr["p"][0]) for pr in VILLAGE["prisms"] if pr["m"] in HUB_GROUND and len(pr["p"][0]) >= 3]
PAVED = STRtree([pg if pg.is_valid else pg.buffer(0) for pg in PAVED])
hubspots = []
for hx, hz, hr, _ in HUBS:
    pts = []
    steps = int(hr / HUB_STEP)
    for i in range(-steps, steps + 1):
        for j in range(-steps, steps + 1):
            x, z = hx + i * HUB_STEP, hz + j * HUB_STEP
            if math.hypot(x - hx, z - hz) > hr:
                continue
            pt = Point(x, z)
            if CARRIAGE.distance(pt) < 0.6 or ROUTES.contains(pt) or blocked_at(x, z, 0.4):
                continue
            if not any(PAVED.geometries[k].contains(pt) for k in PAVED.query(pt)):
                continue
            pts += [round(x, 2), round(z, 2)]
    hubspots.append(pts)

r2 = lambda pts: [round(v, 2) for p in pts for v in p]
data = {
    "_source": "tools/villager_paths.py from web/src/data/roadDetail.json (the GRB's streets), data/molenhoek.json (its rebuilt street), the walls and hedges of "
               "web/src/data/village.json and house_shell.json, web/shared/homes.mjs (kept out of) and the benches of tools/town/houses.json",
    "walks": [r2(p) for p in walks],
    "wkind": wkind,
    "links": links,
    "bikes": [r2(p) for p in bikes],
    "bkind": bkind,
    "bnext": bnext,
    "seats": seats,
    "hubs": [list(h) for h in HUBS],
    "hubspots": hubspots,
}
OUT.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
total = sum(LineString(p).length for p in walks)
btotal = sum(LineString(p).length for p in bikes)
print(f"{OUT.relative_to(ROOT)}: {len(walks)} walks ({total / 1000:.1f} km, {sum(len(p) for p in walks)} points), {len(links)} links "
      f"({sum(1 for l in links if l[4])} over a road), {len(bikes)} bike lines ({btotal / 1000:.1f} km, {sum(1 for k in bkind if k == 0)} cycle lanes), "
      f"{len(seats)} seats, {len(HUBS)} hubs with {[len(h) // 2 for h in hubspots]} spots; {OUT.stat().st_size // 1024} KB")
