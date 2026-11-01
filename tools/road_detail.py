"""The streets' surfaces in detail: carriageways in concrete slabs or asphalt, the gutters, kerbs and pavements
beside them, the verges where there are none, the footpaths, the school's plateau with its zebra crossing and the
give-way line, for web/src/world/roadDetail.ts, which draws them in place of the plain road surface of the village
data.

Run from the project root (needs source/geo/ from tools/geodata.py):
    tools/.venv/Scripts/python.exe tools/road_detail.py

Sources, for measuring only (nothing of them is shipped):
- the road surface as the game draws it: the 'road' blocks of web/src/data/house.json and village.json (the GRB's
  Wegbaan, which reaches from plot to plot, pavements and all, and tools/street.py's pieces where it has none);
- the GRB (Digitaal Vlaanderen, open data): the road centre lines with their street names and surface
  (Wegsegment); the lines that divide the road surface (WGO): the carriageway's edge, the edge of the pavement
  ("zone zwakke weggebruiker", where the kerb stands) and of an unpaved verge; the bottom edge of the school's
  plateau (WTI; its other plateaus lie on Molenhoek's junction, which isn't drawn here); the drives and forecourts
  of data/street.json;
- a Street View tour of the streets on 31 Oct 2026 (the newest images: 2023 on Kapellenhoek and Kapelleweg's
  houses, 2026 round the school, 2009 on most of Briel) and the 25 cm orthophoto: what each street is made of,
  written down in PROFILES and below; no images.

What the tour showed (the browser's profiles draw it):
- Kapellenhoek, from the church square to Briel: a concrete road in slabs, pale grey and worn, a sealed joint
  down the middle and across every five metres or so, cracks sealed in black. Where houses stand, a gutter of
  grey concrete setts with cast-iron gullies, a raised concrete kerb and a narrow pavement of grey concrete pavers
  or tiles; drives meet it over a lowered kerb. A dashed white centre line on the bends by the church square.
  Elsewhere gravel or grass up to the slabs.
- Kapelleweg: a narrow concrete lane between grass and gravel verges, drives flush with it.
- Briel: a narrow concrete road, widened with dark asphalt along both edges where it is wider, grass verges; the
  lane by the house is old cracked concrete, three metres wide, grass up to it.
- Kerkhofstraat: dark asphalt between gutters of light grey setts, low kerbs, grey paver pavements.
- Smetlededorp through the centre: grey concrete pavers (the village data has them); at the school's gate a
  plateau of red-brown pavers with a zebra crossing.
- The footpaths: Smetledekouterwegel a path of grey concrete tiles through the grass, Pastorijwegel a lane of
  grey pavers, Kosterstraatje and Processewijkweg gravel.
- The church square (data/smetlede.json, `bays`): parking bays in darker clinkers, each edged with a row of light
  ones where it meets the square and its neighbours (no paint): nose to the planter walls along the nave and the
  transept, and a block of five in the middle of the square. The chip shop's forecourt by the school in the
  square's grey clinkers (`forecourt`). Both are laid over the village data's paving (`patches`).
Kapelleweg's last stretch, from its junction with Oordegemkouter past the new terrace at Molenhoek's end, has been
rebuilt since: a lane of two pale concrete strips with a strip of dark brick pavers down the middle, and beside it, up
to the gardens, a verge of bare earth not yet finished (`STRETCHES`).

How it is measured: each street's centre line is cut into stations every STEP metres; from each, a ray either
side finds the carriageway's edge on the GRB's lines (or, where it has none, the road surface's own edge) and,
where that edge is a pavement's, the pavement's back edge. A street gives way to the streets before it in
PRIORITY where they meet: its stations stop where its carriageway would run into theirs, and the junction is
filled in. Whatever of the road surface the streets don't cover (junctions, widenings, forecourts) is drawn as
it is, in the carriageway's material or, beyond a pavement, in pavers (`fills`). Molenhoek's street (tools/
molenhoek.py, its own model) is left as the village draws it: its road surface comes back as plain `road`.

Writes web/src/data/roadDetail.json and a check image data/debug/road_detail.png. Model coordinates (x, z).
"""
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw
from shapely.affinity import affine_transform
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import linemerge, unary_union
from shapely.prepared import prep
from shapely.strtree import STRtree

from neighbours import features, model_frame

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "src" / "data" / "roadDetail.json"
DEBUG = ROOT / "data" / "debug" / "road_detail.png"

STEP = 2.5           # m between stations
REACH = 9.0          # m: how far a ray looks for an edge
KERB = 0.12          # m: the kerb's width (the browser draws it the same)
CX, CZ, TILE = 4.45, -3.0, 200  # the browser's tiles (web/src/world/tiles.ts)

# Who gives way to whom where streets meet: a street's carriageway stops at those before it.
PRIORITY = ["Kapellenhoek", "Smetlededorp", "Molenhoek", "Briel", "Kapelleweg", "Kerkhofstraat", "Stefaan Glorieuxstraat",
            "Schildekensstraat", "Serskampstraat", "Oud-Smetlede", "Diepestraat", "Blekte", "Wolfgat"]

# Each street's profile (web/src/world/roadDetail.ts, PROFILES), from the Street View tour. Narrow stretches of
# Briel (under NARROW m of carriageway) are its old lanes; other streets not named here are asphalt.
PROFILES = {"Kapellenhoek": "kh", "Kapelleweg": "kw", "Briel": "briel", "Kerkhofstraat": "kerkhof", "Smetlededorp": "asphalt"}
NARROW = 3.6
LOOSE = "~loose"  # marks a street's pieces with a loose surface (Wegsegment)
# Stretches with a profile of their own: (street, from, to metres along its centre line from its first end, profile).
# Kapellenhoek's centre line starts at the church square.
STRETCHES = [("Kapellenhoek", 0.0, 165.0, "kh_dash"),
             ("Kapelleweg", 10.0, 72.0, "kw_path")]  # Kapelleweg's from its junction with Oordegemkouter
# The footpaths ("trage wegen") by name: profile and width (m). Unnamed paths and the earth tracks stay as they are.
PATHS = {"Smetledekouterwegel": ("path_tiles", 1.0), "Pastorijwegel": ("path_pavers", 2.2), "Kosterstraatje": ("path_gravel", 1.8),
         "Processewijkweg": ("path_gravel", 1.2), "Meentochtwegel": ("path_gravel", 1.2), "Moeyweedreef": ("path_gravel", 1.6)}

# The plateau at the school's gate (Street View, Aug 2026): red-brown pavers across Smetlededorp with a zebra
# crossing, from the GRB's bottom edge to the west to just past the gate. Ends in model metres along x.
SCHOOL_PLATEAU = {"street": "Smetlededorp", "x": (442.9, 481.5), "red": (469.5, 480.0), "zebra": 474.8}
# The give-way lines: where a street meets one with priority and the sign says so (data/kapellenhoek.json's props).
GIVE_WAY = [{"street": "Kapelleweg", "at": (614.6, -404.6)}]


def model_lines(feature_name):
    _, _, to_model = model_frame()
    out = []
    for f in features(feature_name):
        g = f["geometry"]
        lines = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        for coords in lines:
            out.append((f["properties"], affine_transform(LineString([q[:2] for q in coords]), to_model)))
    return out


def load():
    """The road surface and the footpaths' gravel as drawn, with each block's key (as the browser makes it)."""
    house = json.loads((ROOT / "web" / "src" / "data" / "house.json").read_text(encoding="utf-8"))
    village = json.loads((ROOT / "web" / "src" / "data" / "village.json").read_text(encoding="utf-8"))
    roads, gravel = [], []
    for p in house["surroundings"]["prisms"] + village["prisms"]:
        if p["m"] == "road":
            roads.append(p)
        elif p["m"] == "gravel" and p.get("d"):
            gravel.append(p)
    return roads, gravel


def js(v):
    """A number as JavaScript writes it (520 for 520.0, else the shortest form, as Python's repr)."""
    return str(int(v)) if float(v).is_integer() else repr(float(v))


def key(p):
    """A block's key: material, first corner and corner count, as web/src/world/roadDetail.ts makes it."""
    x, z = p["p"][0][0]
    return f"{p['m']}|{js(x)}|{js(z)}|{len(p['p'][0])}"


def poly(p):
    return Polygon(p["p"][0], p["p"][1:]).buffer(0)


def resample(line, step=STEP):
    n = max(1, round(line.length / step))
    return [line.interpolate(i * line.length / n) for i in range(n + 1)]


def normals(pts):
    """Each station's unit normal (+: to the right of the way the line runs, as tools/roads.py's `lane`)."""
    out = []
    for k in range(len(pts)):
        a, b = pts[max(0, k - 2)], pts[min(len(pts) - 1, k + 2)]
        tx, tz = b.x - a.x, b.y - a.y
        n = math.hypot(tx, tz) or 1
        out.append((-tz / n, tx / n))
    return out


class Rays:
    """First hits along rays from a station: on the GRB's dividing lines (by kind) and on the road surface's edge."""

    def __init__(self, road):
        self.road = road
        self.edge = road.boundary
        self.inside = prep(road.buffer(0.3))
        self.covers = prep(road)
        self.lines = {"kerb": [], "edge": [], "verge": []}
        kinds = {"grens zone zwakke weggebruiker (wcz)": "kerb", "rand van de rijbaan (wrb)": "edge", "grens onverharde zone (woz)": "verge"}
        for props, line in model_lines("WGO"):
            k = kinds.get(props.get("LBLTYPE"))
            if k:
                self.lines[k].append(line)
        self.trees = {k: STRtree(v) for k, v in self.lines.items()}

    def first(self, kind, p, n, side, start=0.3, reach=REACH):
        ray = LineString([(p.x + n[0] * side * start, p.y + n[1] * side * start), (p.x + n[0] * side * reach, p.y + n[1] * side * reach)])
        best = None
        tree = self.trees[kind]
        for i in tree.query(ray):
            hit = ray.intersection(self.lines[kind][i])
            for g in getattr(hit, "geoms", [hit]):
                if g.is_empty:
                    continue
                for q in (g.coords if g.geom_type != "Point" else [g.coords[0]]):
                    d = math.hypot(q[0] - p.x, q[1] - p.y)
                    best = d if best is None else min(best, d)
        return best

    def out(self, p, n, side, reach=REACH):
        """Where a ray from inside the road surface first leaves it."""
        ray = LineString([(p.x, p.y), (p.x + n[0] * side * reach, p.y + n[1] * side * reach)])
        hit = ray.intersection(self.edge)
        ds = [math.hypot(q[0] - p.x, q[1] - p.y) for g in getattr(hit, "geoms", [hit]) if not g.is_empty
              for q in (g.coords if g.geom_type != "Point" else [g.coords[0]])]
        ds = [d for d in ds if d > 0.05]
        return min(ds) if ds else reach


def fill_gaps(vals, span):
    """None values bridged by straight lines between the neighbours, up to `span` stations; longer gaps stay None."""
    out = list(vals)
    k = 0
    while k < len(out):
        if out[k] is not None:
            k += 1
            continue
        j = k
        while j < len(out) and out[j] is None:
            j += 1
        if k > 0 and j < len(out) and j - k <= span:
            a, b = out[k - 1], out[j]
            for i in range(k, j):
                out[i] = a + (b - a) * (i - k + 1) / (j - k + 1)
        k = j
    return out


def median(vals, r=2):
    out = []
    for k in range(len(vals)):
        win = sorted(vals[max(0, k - r):k + r + 1])
        out.append(win[len(win) // 2])
    return out


def centre_lines(road):
    """Paved streets as merged centre lines, by name (unnamed pieces each on their own), with their profile."""
    by_name = {}
    for props, line in model_lines("Wegsegment"):
        if props["MORF"] != 103:  # one carriageway
            continue
        if line.length < 3 or not line.intersects(road):
            continue
        name = props["LSTRNM"] if props["LSTRNM"] != "nvt" else f"nvt{len(by_name)}"
        if props["VERH"] == 2:  # a loose surface (the GRB's road surface has it all the same): kept apart
            name += LOOSE
        by_name.setdefault(name, []).append(line)
    out = []
    for name, lines in by_name.items():
        u = unary_union(lines)
        merged = linemerge(u) if u.geom_type == "MultiLineString" else u
        for part in getattr(merged, "geoms", [merged]):
            out.append((name, part))
    # Kapellenhoek from the church square: its stretches are measured from there.
    out = [(n, LineString(l.coords[::-1]) if n == "Kapellenhoek" and Point(l.coords[0]).distance(Point(619.8, -747.8)) > Point(l.coords[-1]).distance(Point(619.8, -747.8)) else l) for n, l in out]
    rank = lambda n: PRIORITY.index(n) if n in PRIORITY else len(PRIORITY) + (2 if n.endswith(LOOSE) else 1 if n.startswith("nvt") else 0)
    return sorted(out, key=lambda nl: (rank(nl[0]), -nl[1].length))


def molenhoek_corridor():
    """Molenhoek's rebuilt street (tools/molenhoek.py draws it, data/molenhoek.json): its centre lines widened to
    beyond its pavements. The road surface there stays the village's. Past the junction where the map used to end
    (x 960) only as far as the rebuilt street runs along the branch (the stub); the last stretch gets its detail here."""
    d = json.loads((ROOT / "data" / "molenhoek.json").read_text(encoding="utf-8"))
    lines = [LineString(d["line"])] + ([LineString(d["stub"]["line"])] if d.get("stub") else [])
    lines += [l.intersection(box(-1e4, -1e4, 960.0, 1e4)) for p, l in model_lines("Wegsegment") if p["LSTRNM"] == "Molenhoek"]
    return unary_union([l.buffer(9.0) for l in lines if not l.is_empty])


def molenhoek_rebuilt():
    """Where tools/molenhoek.py lays its new street (asphalt, cycle lanes, kerbs and pavements, at least 5.5 m either
    side of the centre line): east of the traffic island and along the whole branch. The village's road surface
    stays out of it, or it would lie over the new asphalt."""
    d = json.loads((ROOT / "data" / "molenhoek.json").read_text(encoding="utf-8"))
    east = [q for q in d["line"] if q[0] >= 693.0]
    lines = ([LineString(east)] if len(east) > 1 else []) + ([LineString(d["stub"]["line"])] if d.get("stub") else [])
    return unary_union([l.buffer(5.5, cap_style=2) for l in lines])


def measure(name, line, rays, pavings, corridor, smetlede):
    """The street's stations with their carriageway half widths, kerbs, pavements and lowered kerbs, either side."""
    pts = resample(line)
    ns = normals(pts)
    on = [rays.inside.contains(p) and not corridor.contains(p) and not smetlede.contains(p) for p in pts]
    sides = {}
    for side in (1, -1):
        hits, kinds, outs = [], [], []
        for p, n, ok in zip(pts, ns, on):
            if not ok:
                hits.append(None), kinds.append(None), outs.append(None)
                continue
            found = [(rays.first(k, p, n, side), k) for k in ("kerb", "edge", "verge")]
            found = [(d, k) for d, k in found if d is not None and 1.0 <= d <= 5.5]
            o = rays.out(p, n, side)
            d, k = min(found) if found else (None, None)
            if d is not None and d > o + 0.4:  # a line beyond the road surface's edge: not this street's
                d, k = None, None
            hits.append(d), kinds.append(k), outs.append(o)
        # Bridge short gaps in the lines (a missing bit), not junction mouths.
        w = fill_gaps(hits, 6)
        kerb = [k == "kerb" for k in kinds]
        for i in range(1, len(kerb) - 1):  # one station without a line between two with a kerb: still a kerb
            if not kerb[i] and kerb[i - 1] and kerb[i + 1] and on[i]:
                kerb[i] = True
        # No line at all: the road surface's own edge, at most a lane and a half.
        w = [x if x is not None else (min(o, 3.2) if o is not None else None) for x, o in zip(w, outs)]
        sides[side] = (w, kerb, outs)
    wa, ka, oa = sides[1]
    wb, kb, ob = sides[-1]
    # Smoothed, and kept within reason (a junction's mouth would otherwise widen it).
    good = [i for i in range(len(pts)) if on[i] and wa[i] is not None and wb[i] is not None]
    if len(good) < 3:
        return []
    wa_s = median([wa[i] for i in good])
    wb_s = median([wb[i] for i in good])
    stations = []
    for j, i in enumerate(good):
        p, n = pts[i], ns[i]
        a, b = min(4.5, max(1.2, wa_s[j])), min(4.5, max(1.2, wb_s[j]))
        st = {"i": i, "s": i * line.length / max(1, len(pts) - 1), "x": p.x, "z": p.y, "n": n, "w": [a, b], "kerb": [ka[i], kb[i]], "walk": [0.0, 0.0], "low": [False, False]}
        for si, (side, out, w) in enumerate(((1, oa[i], a), (-1, ob[i], b))):
            if not st["kerb"][si]:
                # No kerb: the road surface carries on past the carriageway (an apron) as far as its edge.
                st["walk"][si] = round(min(2.5, max(0.0, out - w)), 2) if out - w > 0.15 else 0.0
                continue
            # The pavement: from the kerb's back to the road surface's edge (or a verge line before it), within reason.
            back = out
            v = rays.first("verge", p, n, side, start=w + 0.2)
            if v is not None and v < back:
                back = v
            walk = back - w - KERB
            st["walk"][si] = round(min(2.6, walk), 2) if walk >= 0.6 else 0.0
            # A drive or a forecourt just beyond: the kerb is lowered for it.
            reach = w + KERB + st["walk"][si]
            q = Point(p.x + n[0] * side * (reach + 0.5), p.y + n[1] * side * (reach + 0.5))
            st["low"][si] = pavings.contains(q) or (rays.covers.contains(q) and out > reach + 1.2)
        stations.append(st)
    return stations


def runs_of(stations):
    """Unbroken runs of stations (consecutive numbers)."""
    out, cur = [], []
    for st in stations:
        if cur and st["i"] != cur[-1]["i"] + 1:
            out.append(cur)
            cur = []
        cur.append(st)
    if cur:
        out.append(cur)
    return [r for r in out if len(r) >= 3]


def quad(a, b, d0a, d1a, d0b, d1b):
    """The outline between offsets d0..d1 (signed, along each station's normal) from station a to station b."""
    pa = lambda st, d: (st["x"] + st["n"][0] * d, st["z"] + st["n"][1] * d)
    return Polygon([pa(a, d0a), pa(a, d1a), pa(b, d1b), pa(b, d0b)]).buffer(0)


def carriage(a, b):
    return quad(a, b, -a["w"][1], a["w"][0], -b["w"][1], b["w"][0])


def outer(st, si):
    """How far the street's own surface reaches on side si (0: +, 1: -): the kerb and pavement, or the apron."""
    return st["w"][si] + (KERB if st["kerb"][si] else 0.0) + st["walk"][si]


def whole(a, b):
    return quad(a, b, -outer(a, 1), outer(a, 0), -outer(b, 1), outer(b, 0))


def clip(streets, centres):
    """Each street stops where its carriageway would run into one before it (PRIORITY); a kerb or pavement that would
    run onto another street's carriageway, or across the mouth of a street that joins it (`centres`: each street's
    centre line widened to its carriageway, by name), is left out there. Returns the kept runs."""
    kept = []
    taken = []  # carriageways of the streets already placed
    for name, profile, stations in streets:
        index = STRtree(taken) if taken else None
        hits = lambda g: index is not None and any(taken[i].intersects(g) for i in index.query(g))
        ok = []
        for a, b in zip(stations, stations[1:]):
            if b["i"] != a["i"] + 1:
                continue
            c = carriage(a, b)
            if not c.is_valid or c.is_empty or hits(c.buffer(0.35)):
                continue
            ok.append((a, b))
        keep = {id(a) for a, b in ok} | {id(b) for a, b in ok}
        stations = [st for st in stations if id(st) in keep]
        for run in runs_of(stations):
            mine = [carriage(a, b) for a, b in zip(run, run[1:])]
            kept.append((name, profile, run))
            taken.extend(mine)
    # Kerbs and pavements onto another street's carriageway or across its mouth: dropped there (a corner's radius
    # beyond the joining street's carriageway too).
    index = STRtree(taken)
    mouths = [(zone.buffer(2.0), other) for zone, other in centres]
    owner = []
    for r, (_, _, run) in enumerate(kept):
        owner += [r] * (len(run) - 1)
    for r, (name, profile, run) in enumerate(kept):
        for k, (a, b) in enumerate(zip(run, run[1:])):
            for si in (0, 1):
                if not a["kerb"][si]:
                    continue
                sign = 1 if si == 0 else -1
                d0a, d1a = sorted((sign * a["w"][si], sign * outer(a, si)))
                d0b, d1b = sorted((sign * b["w"][si], sign * outer(b, si)))
                g = quad(a, b, d0a, d1a, d0b, d1b)
                mouth = any(other != name and zone.intersects(g) for zone, other in mouths)
                if mouth or any(owner[i] != r and taken[i].intersects(g.buffer(-0.05)) for i in index.query(g)):
                    a["kerb"][si] = False
                    a["walk"][si] = 0.0
    return kept


def tile_pieces(geom):
    """A shape cut along the browser's tiles."""
    x0, z0, x1, z1 = geom.bounds
    out = []
    for i in range(math.floor((x0 - CX) / TILE + 0.5), math.floor((x1 - CX) / TILE + 0.5) + 1):
        for j in range(math.floor((z0 - CZ) / TILE + 0.5), math.floor((z1 - CZ) / TILE + 0.5) + 1):
            cx, cz = CX + i * TILE, CZ + j * TILE
            piece = geom.intersection(box(cx - TILE / 2, cz - TILE / 2, cx + TILE / 2, cz + TILE / 2))
            for g in getattr(piece, "geoms", [piece]):
                if g.geom_type == "Polygon" and g.area > 0.05:
                    out.append(g)
    return out


def ring_out(r):
    return [round(v, 2) for q in r.coords[:-1] for v in q]


def fills(road, kept, corridor, centres, rebuilt):
    """The road surface the streets don't cover. On a street's centre line (a junction, where a street gave way)
    and beside a carriageway without kerbs (widenings, lay-bys): the nearest street's carriageway; beyond a
    pavement: pavers (forecourts); on Molenhoek: the village's own road surface. `centres`: every street's centre
    line widened to its usual carriageway. `rebuilt`: where Molenhoek's new street lies (nothing of the village's there)."""
    covered = unary_union([whole(a, b) for _, _, run in kept for a, b in zip(run, run[1:])])
    rest = road.difference(covered)
    lines = []
    for name, profile, run in kept:
        for a, b in zip(run, run[1:]):
            lines.append((LineString([(a["x"], a["z"]), (b["x"], b["z"])]), profile, a))
    index = STRtree([l for l, _, _ in lines])
    zone = unary_union([g for g, _ in centres])
    out = []

    def add(g, m):
        for piece in tile_pieces(g):
            out.append({"m": m, "r": [ring_out(piece.exterior)] + [ring_out(h) for h in piece.interiors]})

    for piece in getattr(rest, "geoms", [rest]):
        if piece.geom_type != "Polygon" or piece.area < 0.05:
            continue
        piece = piece.simplify(0.03)
        if corridor.contains(piece.representative_point()):
            for g in getattr(piece.difference(rebuilt), "geoms", [piece.difference(rebuilt)]):
                if g.geom_type == "Polygon" and g.area >= 0.05:
                    add(g, "road")
            continue
        for part, on_line in ((piece.intersection(zone), True), (piece.difference(zone), False)):
            for g in getattr(part, "geoms", [part]):
                if g.geom_type != "Polygon" or g.area < 0.05:
                    continue
                c = g.representative_point()
                line, profile, st = lines[index.nearest(c)]
                kerbed = st["kerb"][0] or st["kerb"][1]
                add(g, f"pf:{profile}" if on_line or not kerbed or line.distance(c) < max(st["w"]) + 0.6 else "forecourt")
    return out


def paths(gravel):
    """The named footpaths: their centre lines as drawn (data/street.json), the gravel blocks they replace."""
    st = json.loads((ROOT / "data" / "street.json").read_text(encoding="utf-8"))
    named = [(p["LSTRNM"], l) for p, l in model_lines("Wegsegment") if p["LSTRNM"] in PATHS]
    out, hide = [], []
    for t in st["tracks"]:
        if t["k"] != "path" or len(t["path"]) < 2:
            continue
        line = LineString(t["path"])
        mid = line.interpolate(0.5, normalized=True)
        near = [(l.distance(mid), n) for n, l in named]
        if not near or min(near)[0] > 4:
            continue
        name = min(near)[1]
        profile, width = PATHS[name]
        pts = resample(line, 2.0)
        ns = normals(pts)
        out.append({"name": name, "pf": profile, "s0": 0.0, "p": [round(v, 2) for q in pts for v in (q.x, q.y)],
                    "w": [round(width / 2, 2)] * (2 * len(pts)), "k": [0] * len(pts), "q": [0.0] * (2 * len(pts))})
        zone = line.buffer(1.0)
        hide += [key(p) for p in gravel if zone.contains(poly(p).representative_point())]
    return out, hide


def school(rays):
    """The school's plateau on Smetlededorp's paved stretch (the village data draws its pavers): its own short run
    of stations along the centre line, the carriageway's width from the GRB's lines."""
    line = [l for p, l in model_lines("Wegsegment") if p["LSTRNM"] == SCHOOL_PLATEAU["street"] and l.distance(Point(470, -785)) < 10]
    line = unary_union(line)
    line = linemerge(line) if line.geom_type == "MultiLineString" else line
    x0, x1 = SCHOOL_PLATEAU["x"]
    piece = line.intersection(box(x0, -900, x1, -700))
    piece = max(getattr(piece, "geoms", [piece]), key=lambda g: g.length)
    if piece.coords[0][0] > piece.coords[-1][0]:
        piece = LineString(piece.coords[::-1])
    pts = resample(piece, 1.0)
    ns = normals(pts)
    p, w = [], []
    for q, n in zip(pts, ns):
        ds = []
        for side in (1, -1):
            d = rays.first("kerb", q, n, side) or rays.first("edge", q, n, side) or 2.8
            ds.append(round(min(3.5, max(2.2, d)), 2))
        p += [round(q.x, 2), round(q.y, 2)]
        w += ds
    zx = SCHOOL_PLATEAU["zebra"]
    zp = min(pts, key=lambda q: abs(q.x - zx))
    k = pts.index(zp)
    n = ns[k]
    zebra = {"x": round(zp.x, 2), "z": round(zp.y, 2), "u": [round(n[1], 3), round(-n[0], 3)], "w": [w[2 * k], w[2 * k + 1]]}
    return {"p": p, "w": w, "x": [x0, x1], "red": list(SCHOOL_PLATEAU["red"])}, zebra


def give_way(kept):
    """Shark's teeth across the street that gives way, at the end of its carriageway by the junction."""
    out = []
    for g in GIVE_WAY:
        best = None
        for name, profile, run in kept:
            if name != g["street"]:
                continue
            for st in (run[0], run[-1]):
                d = math.hypot(st["x"] - g["at"][0], st["z"] - g["at"][1])
                if d < 25 and (best is None or d < best[0]):
                    best = (d, st, run)
        if best:
            _, st, run = best
            inward = run[1] if st is run[0] else run[-2]  # back along the street, away from the junction
            ux, uz = st["x"] - inward["x"], st["z"] - inward["z"]
            n = math.hypot(ux, uz)
            out.append({"x": round(st["x"], 2), "z": round(st["z"], 2), "u": [round(ux / n, 3), round(uz / n, 3)], "w": [round(st["w"][0], 2), round(st["w"][1], 2)]})
    return out


def patches(sm):
    """The church square's parking bays and the chip shop's forecourt (data/smetlede.json): pieces of clinker in a
    tint of their own, laid over the village data's paving. A row of bays: its nose line (along the wall the cars
    face), the way out from it, its depth and where the bays part along the nose line; the light edging (a row of
    pavers, LINE m wide) runs between the bays (`cuts`), along their back (`rear`) and, for a block standing free,
    along the nose too (`nose`). The fill is what the edging leaves."""
    LINE = 0.12
    bays = sm.get("bays", {})
    out = []
    for row in bays.get("rows", []):
        (ax, az), (bx, bz) = row["nose"]
        ox, oz = row["out"]
        n = math.hypot(bx - ax, bz - az)
        ux, uz = (bx - ax) / n, (bz - az) / n
        dep = row["depth"]

        def at(s, d):
            return (ax + ux * s + ox * d, az + uz * s + oz * d)
        rect = Polygon([at(0, 0), at(n, 0), at(n, dep), at(0, dep)])
        segs = [LineString([at(c, 0), at(c, dep)]) for c in row["cuts"]] if "cuts" in row["lines"] else []
        if "rear" in row["lines"]:
            segs.append(LineString([at(0, dep), at(n, dep)]))
        if "nose" in row["lines"]:
            segs.append(LineString([at(0, 0), at(n, 0)]))
        edging = unary_union([g.buffer(LINE / 2, cap_style="square", join_style="mitre") for g in segs])
        edging = edging.intersection(rect.buffer(LINE / 2, join_style="mitre"))
        for g, tint in ((rect.difference(edging), bays["fill"]), (edging, bays["edge"])):
            for piece in getattr(g, "geoms", [g]):
                if piece.geom_type == "Polygon" and piece.area > 0.01:
                    out.append({"t": tint, "r": [ring_out(piece.exterior)] + [ring_out(h) for h in piece.interiors]})
    fc = sm.get("forecourt")
    if fc:
        out.append({"t": fc["tint"], "r": [ring_out(Polygon(fc["p"]).exterior)]})
    return out


def pack(name, profile, run):
    k = [(1 if st["kerb"][0] else 0) | (2 if st["kerb"][1] else 0) | (4 if st["low"][0] else 0) | (8 if st["low"][1] else 0) for st in run]
    return {"name": name, "pf": profile, "s0": round(run[0]["s"], 1), "p": [round(v, 2) for st in run for v in (st["x"], st["z"])],
            "w": [round(v, 2) for st in run for v in st["w"]], "k": k, "q": [round(v, 2) for st in run for v in st["walk"]]}


def profile_runs(name, run):
    """A run cut where its profile changes (STRETCHES). Briel's narrow pieces (under NARROW m across, by their
    middle width) are its old lanes; a street with a loose surface is a lane of worn chippings."""
    base = PROFILES.get(name, "asphalt" if not name.startswith("nvt") else "lane_asphalt")
    if name.endswith(LOOSE):
        base = "lane_loose"
    widths = sorted(st["w"][0] + st["w"][1] for st in run)
    if base == "briel" and widths[len(widths) // 2] < NARROW:
        base = "lane"

    def pf(st):
        for street, s0, s1, p in STRETCHES:
            if street == name and s0 <= st["s"] <= s1:
                return p
        return base
    out, cur, cp = [], [], None
    for st in run:
        p = pf(st)
        if cur and p != cp:
            out.append((cp, cur + [st]))  # the next run starts where this one ends: no gap between them
            cur = []
        cur.append(st)
        cp = p
    if cur:
        out.append((cp, cur))
    return [(p, r) for p, r in out if len(r) >= 2]


def main():
    roads, gravel = load()
    road = unary_union([poly(p) for p in roads])
    rays = Rays(road)
    st = json.loads((ROOT / "data" / "street.json").read_text(encoding="utf-8"))
    pavings = prep(unary_union([Polygon(q["p"][0]).buffer(0) for q in st["pavings"]]))
    sm = json.loads((ROOT / "data" / "smetlede.json").read_text(encoding="utf-8"))
    smetlede = prep(Polygon(sm["pavers"]["p"]).buffer(0))  # the centre's grey pavers: the village data draws them
    corridor_shape = molenhoek_corridor()
    corridor = prep(corridor_shape)
    streets, centres = [], []
    for name, line in centre_lines(road):
        if name == "Molenhoek":
            continue
        stations = measure(name, line, rays, pavings, corridor, smetlede)
        if stations:
            streets.append((name, None, stations))
            half = sorted(min(st["w"]) for st in stations)[len(stations) // 2]
            centres.append((line.buffer(half + 0.2, cap_style="flat"), name))
    kept = clip(streets, centres)
    runs, named = [], []
    for name, _, run in kept:
        for profile, part in profile_runs(name, run):
            runs.append(pack(name, profile, part))
            named.append((name, profile, part))
    path_runs, hidden_paths = paths(gravel)
    school_plateau, zebra = school(rays)
    out = {
        "_source": "GRB Wegsegment, WGO, WTI (Digitaal Vlaanderen, open data) and the road surface of web/src/data/house.json and "
                   "village.json via tools/road_detail.py; each street's make-up from a Street View tour (31 Oct 2026), written "
                   "down there, no images",
        "hide": sorted({key(p) for p in roads} | set(hidden_paths)),
        "runs": runs + path_runs,
        "fills": fills(road, named, corridor, centres, molenhoek_rebuilt()),
        "school": school_plateau,
        "zebras": [zebra],
        "teeth": give_way(named),
        "patches": patches(sm),
    }
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    total = sum(len(r["p"]) // 2 for r in out["runs"])
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB): {len(out['runs'])} runs ({total} stations), "
          f"{len(out['fills'])} fills, {len(out['patches'])} patches, {len(out['hide'])} blocks replaced")
    debug(out, road)


def debug(out, road):
    """The check image: the road surface (grey), each run's carriageway in its profile's colour, kerbs and pavements
    (white and tan), the fills (blue for a carriageway's, brown for forecourts, dark grey for Molenhoek's)."""
    x0, z0, x1, z1 = -300, -1120, 900, 260
    k = 2.0
    img = Image.new("RGB", (int((x1 - x0) * k), int((z1 - z0) * k)), (236, 240, 228))
    d = ImageDraw.Draw(img)
    P = lambda x, z: ((x - x0) * k, (z - z0) * k)
    ring = lambda r: [P(r[i], r[i + 1]) for i in range(0, len(r), 2)]
    for g in getattr(road, "geoms", [road]):
        d.polygon([P(*q) for q in g.exterior.coords], fill=(205, 205, 210))
        for h in g.interiors:
            d.polygon([P(*q) for q in h.coords], fill=(236, 240, 228))
    colours = {"road": (90, 90, 90), "forecourt": (170, 130, 90)}
    for f in out["fills"]:
        d.polygon(ring(f["r"][0]), fill=colours.get(f["m"], (110, 150, 230)))
        for h in f["r"][1:]:
            d.polygon(ring(h), fill=(236, 240, 228))
    pal = {"kh": (200, 60, 60), "kh_dash": (240, 120, 0), "kw": (60, 140, 60), "briel": (60, 60, 200), "lane": (140, 60, 200),
           "kerkhof": (20, 20, 20), "asphalt": (90, 90, 90), "lane_asphalt": (120, 120, 120), "lane_loose": (180, 160, 120)}
    for r in out["runs"]:
        p, w, q = r["p"], r["w"], r["q"]
        n = len(p) // 2
        pts = [Point(p[2 * i], p[2 * i + 1]) for i in range(n)]
        ns = normals(pts)
        at = lambda i, dd: P(p[2 * i] + ns[i][0] * dd, p[2 * i + 1] + ns[i][1] * dd)
        col = pal.get(r["pf"], (0, 160, 160))
        for i in range(n - 1):
            d.polygon([at(i, -w[2 * i + 1]), at(i, w[2 * i]), at(i + 1, w[2 * i + 2]), at(i + 1, -w[2 * i + 3])], fill=col)
            for si, sign in ((0, 1), (1, -1)):
                if r["k"][i] & (1 << si):
                    a0, b0 = w[2 * i + si], w[2 * i + 2 + si]
                    d.polygon([at(i, sign * a0), at(i, sign * (a0 + KERB)), at(i + 1, sign * (b0 + KERB)), at(i + 1, sign * b0)],
                              fill=(255, 255, 255) if not r["k"][i] & (4 << si) else (255, 0, 255))
                    a1, b1 = q[2 * i + si], q[2 * i + 2 + si]
                    if a1 > 0:
                        d.polygon([at(i, sign * (a0 + KERB)), at(i, sign * (a0 + KERB + a1)), at(i + 1, sign * (b0 + KERB + b1)), at(i + 1, sign * (b0 + KERB))], fill=(225, 205, 160))
    for z in out["zebras"] + out["teeth"]:
        d.ellipse([P(z["x"] - 2, z["z"] - 2), P(z["x"] + 2, z["z"] + 2)], outline=(255, 0, 0), width=2)
    DEBUG.parent.mkdir(parents=True, exist_ok=True)
    img.save(DEBUG)


if __name__ == "__main__":
    main()
