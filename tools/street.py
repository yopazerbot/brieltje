"""The street in more detail: what the aerial photo and the GRB show beyond the buildings.

Sources as in tools/neighbours.py (source/geo/, not in git), plus these GRB layers (WFS, the
same service): Wegsegment (road centre lines and their surface), WPI (measured poles along the
road) and WTZ (water surfaces). From them, in model coordinates:

- poles: the GRB's poles along Briel. In the model a grey concrete pole with the low-voltage
  cables to the next pole and a street lamp on a short arm towards the road. Round Smetlede's
  church square (data/smetlede.json) they are street lamps on steel posts, without cables (`k`).
- tracks: the earth roads to the fields (Wegsegment 'aardeweg'): two wheel ruts, grass between;
  the footpaths as one gravel strip.
- water: ponds and the ditch in the field (WTZ), as dips with water in them.
- pavings: forecourts, drives, yards and terraces, wherever the orthophoto shows a light hard
  surface (bright, not green) on a plot with a building or on the verge beside one, in the
  photo's colour: light grey pavers, beige pavers or gravel.
- pools: swimming pools on the photo (light blue water).
- hedges: the stretches of the plot lines and of the plots' road side that the photo shows green
  and the laser scan (DHM II, 2013-2015) shows standing 0.6 m or more: a hedge at the height
  measured. The rest of a plot line keeps a fence or nothing (tools/facades.py).
- solar: solar panels on the neighbours' roofs: on the houses where the street survey of
  2026-10-30 (Google Maps satellite view) saw them, on the slope or flat roof where the
  orthophoto shows them; as quads in 3D (rows of tilted panels on a flat roof).
- roads: pieces of the paved road that the GRB's road surface leaves out (a strip along the
  centre line, 4.6 m wide).
- fields: the plots without a building, as the photo shows them: bare soil (light or dark),
  crops and nursery rows (mixed green and soil), or the floor of a wood (the laser scan's
  trees over most of it); grass plots stay lawn. A metre of grass is kept along their edges.

Nothing here is keyed by address: the survey's houses are model positions.
Writes data/street.json and a check image data/debug/street.png; tools/build_house.py builds them.
Run from the project root:
    tools/.venv/Scripts/python.exe tools/street.py
"""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from shapely.affinity import affine_transform
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import linemerge, nearest_points, unary_union

import old_house
from neighbours import TILE_H, TILE_W, TILE_X0, TILE_Y1, band, features, hull, model_frame, ortho_image, polygons, raster, zone

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "street.json"
DEBUG = ROOT / "data" / "debug" / "street.png"

# The model raster: 0.4 m cells over the area of the neighbour data (tools/neighbours.py, `zone`:
# the ring round the plot's middle, the village and the band between), set by `grid`.
CELL = 0.4
X0 = Z0 = X1 = Z1 = NX = NZ = 0
HALF_M = max(1, round(0.5 / CELL))  # cells in half a metre: the size of the clean-ups and the hedge window


def grid(area):
    """The model raster over the bounds of the area (model coordinates)."""
    global X0, Z0, X1, Z1, NX, NZ
    x0, z0, x1, z1 = area.bounds
    X0, Z0 = math.floor(x0) - 2.0, math.floor(z0) - 2.0
    NX, NZ = int((x1 + 2 - X0) / CELL) + 1, int((z1 + 2 - Z0) / CELL) + 1
    X1, Z1 = X0 + NX * CELL, Z0 + NZ * CELL

# Solar panels: a point on the roof slope (or flat roof) that carries them, in the model, and
# about how many panels (0: as many as fit). The houses are the survey's; the slope is the one
# the orthophoto shows them on.
SOLAR = [
    ((144.3, -124.4), 14),
    ((119.5, -122.9), 0),
    ((42.0, 65.1), 0),
    ((47.7, 65.4), 0),
    ((39.0, 72.2), 0),
    ((26.8, -112.4), 0),
    ((53.7, -81.1), 10),
    ((57.4, -34.1), 10),
]
NORTH = np.array([-0.6656, 0.7463])  # Lambert 72 grid north in the model
PANEL = (1.05, 1.75)  # m, a panel and its gap: across the slope, up the slope
O, DROP = 0.3, 0.15   # the roofs' overhang and how far it drops (web/src/world/surroundings.ts)


class Raster:
    """The orthophoto and the laser scan resampled onto the model grid (row = z, column = x)."""

    def __init__(self, to_model):
        a, b, d, e, xo, zo = to_model
        inv = np.linalg.inv(np.array([[a, b], [d, e]]))
        X, Z = np.meshgrid(np.float32(X0) + (np.arange(NX, dtype=np.float32) + 0.5) * np.float32(CELL),
                           np.float32(Z0) + (np.arange(NZ, dtype=np.float32) + 0.5) * np.float32(CELL))
        LX = inv[0, 0] * (X - xo) + inv[0, 1] * (Z - zo)
        LY = inv[1, 0] * (X - xo) + inv[1, 1] * (Z - zo)
        img, meta = ortho_image()  # with the strip west of the first fetch stitched on (tools/neighbours.py)
        photo = np.asarray(img)
        res = (meta["x1"] - meta["x0"]) / meta["px"]
        col = np.clip(((LX - meta["x0"]) / res).astype(int), 0, photo.shape[1] - 1)
        row = np.clip(((meta["y1"] - LY) / res).astype(int), 0, photo.shape[0] - 1)
        self.rgb = photo[row, col].astype(np.int16)  # signed: differences between channels
        dsm = raster("DSM")
        dtm = raster("DTM")
        r1 = np.clip((TILE_Y1 - LY).astype(int), 0, TILE_H - 1)
        c1 = np.clip((LX - TILE_X0).astype(int), 0, TILE_W - 1)
        self.height = np.nan_to_num(dsm[r1, c1] - dtm[r1, c1])

    @staticmethod
    def mask(polys):
        """Cells inside the given model polygons (shapely, holes respected)."""
        img = Image.new("L", (NX, NZ), 0)
        d = ImageDraw.Draw(img)
        to_px = lambda ring: [((x - X0) / CELL, (z - Z0) / CELL) for x, z in ring.coords]
        for g in polys:
            for p in getattr(g, "geoms", [g]):
                if p.is_empty or p.geom_type != "Polygon":
                    continue
                d.polygon(to_px(p.exterior), fill=1)
                for h in p.interiors:
                    d.polygon(to_px(h), fill=0)
        return np.asarray(img, dtype=bool)

    @staticmethod
    def cell(x, z):
        return int((z - Z0) / CELL), int((x - X0) / CELL)


def shift(m, dz, dx):
    out = np.zeros_like(m)
    zs, ze = max(dz, 0), NZ + min(dz, 0)
    xs, xe = max(dx, 0), NX + min(dx, 0)
    out[zs:ze, xs:xe] = m[zs - dz:ze - dz, xs - dx:xe - dx]
    return out


def dilate(m, r):
    out = m.copy()
    for dz in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if (dz or dx) and dz * dz + dx * dx <= r * r:
                out |= shift(m, dz, dx)
    return out


def erode(m, r):
    return ~dilate(~m, r)


def vectorise(m, min_area):
    """Polygons (model coordinates) of a cell mask: runs per row merged, smoothed a little."""
    boxes = []
    for i in np.flatnonzero(m.any(axis=1)):
        d = np.diff(np.concatenate([[0], m[i].astype(np.int8), [0]]))
        for s, e in zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)):
            boxes.append(box(X0 + s * CELL, Z0 + i * CELL, X0 + e * CELL, Z0 + (i + 1) * CELL))
    merged = unary_union(boxes)
    out = []
    for p in getattr(merged, "geoms", [merged]):
        p = p.buffer(0.2, join_style="mitre").buffer(-0.2, join_style="mitre").simplify(0.2)
        for q in getattr(p, "geoms", [p]):
            if q.geom_type == "Polygon" and q.area >= min_area:
                out.append(q)
    return out


def coords(g, nd=2):
    return [[round(x, nd), round(z, nd)] for x, z in g.coords]


def rings(poly):
    return [coords(poly.exterior)[:-1]] + [coords(h)[:-1] for h in poly.interiors]


def parts_of(g, kind):
    return [p for p in getattr(g, "geoms", [g]) if p.geom_type == kind and not p.is_empty]


# ---------------------------------------------------------------- poles, tracks, water

def road_lines(model, area):
    """Centre lines (model), merged: the paved roads and the earth tracks and footpaths."""
    paved, tracks, paths = [], [], []
    for f in features("Wegsegment"):
        line = model(LineString([p[:2] for p in f["geometry"]["coordinates"]])).intersection(area)
        if line.is_empty:
            continue
        kind = f["properties"]["LBLMORF"]
        (tracks if kind == "aardeweg" else paths if kind.startswith("wandel") else paved).append(line)
    def merge(ls):
        u = unary_union(ls)
        return parts_of(linemerge(u) if u.geom_type == "MultiLineString" else u, "LineString")
    return merge(paved), merge(tracks), merge(paths)


def poles(model, area, paved, road):
    """The GRB's poles next to the paved roads; each with its arm towards the road and the
    cables to the next pole along the same road (at most 60 m on)."""
    out = []
    axis = unary_union(paved)
    for f in features("WPI"):
        p = model(Point(f["geometry"]["coordinates"][:2]))
        if not area.buffer(-5).contains(p) or road.distance(p) > 6:
            continue
        at = nearest_points(axis, p)[0]
        arm = np.array([at.x - p.x, at.y - p.y])
        arm = arm / (np.linalg.norm(arm) or 1)
        out.append({"x": round(p.x, 2), "z": round(p.y, 2), "arm": [round(float(arm[0]), 3), round(float(arm[1]), 3)]})
    # In the centre of Smetlededorp the poles are street lamps on steel posts without cables (Street View,
    # data/smetlede.json): their kind `k` (post, striped or lantern), and no cables to them.
    survey = ROOT / "data" / "smetlede.json"
    lamps = json.loads(survey.read_text(encoding="utf-8")).get("lamps", {}) if survey.exists() else {}
    for q in out:
        for kind in ("post", "striped", "lantern"):
            if any(math.dist((q["x"], q["z"]), at) < 1.0 for at in lamps.get(kind, [])):
                q["k"] = kind
    # Cables: the shortest network joining the poles with spans that follow the road (Kruskal).
    pts = [(q["x"], q["z"]) for q in out]
    wired = [i for i, q in enumerate(out) if "k" not in q]
    lane = road.buffer(7)
    spans = sorted((math.dist(pts[i], pts[j]), i, j) for i in wired for j in wired
                   if i < j and math.dist(pts[i], pts[j]) < 60 and lane.contains(LineString([pts[i], pts[j]])))
    root = list(range(len(pts)))

    def find(i):
        while root[i] != i:
            i = root[i]
        return i

    wires = []
    for _, i, j in spans:
        a, b = find(i), find(j)
        if a != b:
            root[a] = b
            wires.append([i, j])
    return out, wires


def water(model, area, keep_out):
    """Ponds and ditches (WTZ) as dips: rim, bottom (same number of points) and depth, with the
    water this far below the ground."""
    from garden import resample
    out = []
    for f in features("WTZ"):
        for poly in polygons(f["geometry"]):
            m = model(poly).buffer(0).intersection(area.buffer(-8))
            for p in parts_of(m, "Polygon"):
                if p.area < 4 or p.intersects(keep_out):
                    continue
                width = 2 * p.area / p.length  # about, for a long thin ditch
                depth = round(min(1.0, max(0.5, width * 0.35)), 2)
                inner = p.buffer(-min(depth, width * 0.35), join_style="round")
                if inner.is_empty or inner.geom_type != "Polygon":
                    continue
                n = max(24, min(160, int(p.length / 1.2)))
                rim = resample([list(c) for c in p.exterior.coords[:-1]], n)
                bottom = resample([list(c) for c in inner.exterior.coords[:-1]], n, rim[0])
                out.append({"name": "pond" if width > 6 else "ditch", "rim": rim, "bottom": bottom, "depth": depth, "water": round(depth * 0.45, 2)})
    return out


# ---------------------------------------------------------------- pavings, pools, hedges

def plots(model, area):
    """Model polygons of every plot (ADP) in the area."""
    out = []
    for f in features("ADP"):
        for p in polygons(f["geometry"]):
            m = model(p).buffer(0)
            if m.intersects(area):
                out.append(m)
    return out


def classify(ras):
    """Per cell: hard light surface, vegetation, pool water."""
    R, G, B = ras.rgb[..., 0], ras.rgb[..., 1], ras.rgb[..., 2]
    V = (R + G + B) / 3
    pool = (B - R > 25) & (G - R > 12) & (V > 105)
    hard = (V > 128) & (G - R < 2) & ~pool
    veg = (G - R > 0) & (V < 150) & ~pool
    return hard, veg, pool


def pavings(ras, hard, region, keep_out, buildings):
    m = hard & Raster.mask([region]) & ~Raster.mask([keep_out])
    m = erode(dilate(m, HALF_M), HALF_M)   # close small gaps (a car, a joint)
    m = dilate(erode(m, HALF_M), HALF_M)   # drop thin bits (a kerb, a lit lawn edge)
    out = []
    R, G, B = ras.rgb[..., 0], ras.rgb[..., 1], ras.rgb[..., 2]
    for p in vectorise(m, 4.0):
        p = p.difference(keep_out)
        for q in parts_of(p, "Polygon"):
            if q.area < 4:
                continue
            inside = Raster.mask([q.buffer(-0.3)]) & hard
            if inside.sum() < 20:
                continue
            if q.area > 40 and q.area / q.convex_hull.area < (0.5 if q.distance(buildings) < 1 else 0.75):
                continue  # a ragged patch away from the buildings: dry grass or bare earth, not a yard
            r, g, b = R[inside].mean(), G[inside].mean(), B[inside].mean()
            kind = "gravel" if r - b > 34 and (r + g + b) / 3 > 150 else "pave_warm" if r - b > 18 else "pave_light"
            # Round off the cell staircase: in and out by 0.6 m, then fewer points.
            smooth = q.buffer(0.6, quad_segs=4).buffer(-0.6, quad_segs=4).simplify(0.25)
            for r in parts_of(smooth.difference(keep_out), "Polygon"):
                if r.area >= 4:
                    out.append({"m": kind, "p": rings(r)})
    return out


def pools(pool, region):
    m = dilate(erode(pool & Raster.mask([region]), 1), 1)
    out = []
    for p in vectorise(m, 6.0):
        r = p.minimum_rotated_rectangle
        if r.area > 90 or p.area / r.area < 0.6:
            continue  # not a pool's shape
        out.append(coords(r.exterior)[:-1])
    return out


def hedge_runs(line, ras, veg, step=1.0):
    """Pieces of a line (model) where a hedge stands: [(LineString, height)]."""
    n = max(2, int(line.length / step) + 1)
    flags, heights = [], []
    for k in range(n):
        p = line.interpolate(k / (n - 1), normalized=True)
        i, j = Raster.cell(p.x, p.y)
        w = HALF_M
        if not (w <= i < NZ - w and w <= j < NX - w):
            flags.append(False)
            heights.append(0)
            continue
        win = (slice(i - w, i + w + 1), slice(j - w, j + w + 1))
        h = float(np.percentile(ras.height[win], 70))
        flags.append(veg[win].mean() > 0.45 and 0.6 <= h <= 4.5)
        heights.append(h)
    out = []
    k = 0
    while k < n:
        if not flags[k]:
            k += 1
            continue
        e = k
        while e + 1 < n and (flags[e + 1] or (e + 2 < n and flags[e + 2])):  # bridge one-sample gaps
            e += 1
        d0, d1 = k / (n - 1) * line.length, e / (n - 1) * line.length
        if d1 - d0 >= 2.5:
            seg = cut(line, d0, d1)
            h = float(np.clip(np.median(heights[k:e + 1]), 0.9, 2.8))
            out.append((seg, round(h, 1)))
        k = e + 1
    return out


def cut(line, d0, d1):
    """The piece of a line between two distances along it."""
    pts = [line.interpolate(d0)]
    acc = 0.0
    cs = list(line.coords)
    for a, b in zip(cs, cs[1:]):
        acc += math.dist(a, b)
        if d0 < acc < d1:
            pts.append(Point(b))
    pts.append(line.interpolate(d1))
    return LineString(pts)


def fields(ras, veg, plots, homes, keep_out, area):
    """The surface of every plot without a building, by what the photo and the laser scan show."""
    out = []
    R, G, B = ras.rgb[..., 0], ras.rgb[..., 1], ras.rgb[..., 2]
    V = (R + G + B) / 3
    home = unary_union(homes)
    for p in plots:
        if p.area < 600 or p.intersection(home).area > 5:
            continue
        rest = p.intersection(area).difference(keep_out).buffer(-1.0, join_style="mitre")
        for q in parts_of(rest, "Polygon"):
            if q.area < 300:
                continue
            inside = Raster.mask([q])
            if inside.sum() < 400:
                continue
            green = float(veg[inside].mean())
            tall = float((ras.height[inside] > 3).mean())
            if tall > 0.4:
                kind = "forest"
            elif green > 0.65:
                continue  # grass: the lawn
            elif green < 0.3:
                kind = "field_soil" if float(V[inside].mean()) > 140 else "field_dark"
            else:
                kind = "field_crop"
            out.append({"m": kind, "p": rings(q.simplify(0.4))})
    return out


# ---------------------------------------------------------------- solar panels

def lift(c, along, across, a, v, y):
    q = c[0] + along * a + across * v
    return [round(float(q[0]), 2), round(float(y), 2), round(float(q[1]), 2)]


def slope_panels(part, base, at, count):
    """Panels on the slope of a pitched roof part that holds the point `at`, as one quad of
    `cols` x `rows` panels."""
    c = [np.array(p, float) for p in part["p"]]
    L, W = np.linalg.norm(c[1] - c[0]), np.linalg.norm(c[3] - c[0])
    along, across = (c[1] - c[0]) / L, (c[3] - c[0]) / W
    top, ridge = base + part["eaves"], base + part["ridge"]
    eave = top - DROP
    shape = part["shape"]
    if shape == "shed":
        faces = [(-across, 0.0, W)]  # rises towards +across, faces -across
    else:
        faces = [(-across, 0.0, W / 2), (across, W, W / 2)]
    v_at = float((np.array(at) - c[0]) @ across)
    normal, edge, run = faces[0] if len(faces) == 1 or v_at < W / 2 else faces[1]
    rise = ridge - (top if shape == "shed" else eave)
    if shape == "shed":
        height = lambda v: top + (ridge - top) / max(0.5, W) * v
    else:
        height = lambda v: eave + rise * ((v + O) / (W / 2 + O) if edge == 0 else (W - v + O) / (W / 2 + O))
    stretch = math.hypot(run, rise) / max(run, 0.01)
    v_lo, v_hi = 0.35, run - 0.45  # from the eaves wall line up to below the ridge (in plan)
    rows = int((v_hi - v_lo) * stretch // PANEL[1])
    a_room = L - 1.0 - (2 * (v_lo + rows * PANEL[1] / stretch) if shape == "hip" else 0)
    cols = int(a_room // PANEL[0])
    if count:
        while rows > 1 and math.ceil(count / rows) * rows - count >= rows - 1 and (rows - 1) * cols >= count:
            rows -= 1
        cols = min(cols, math.ceil(count / max(rows, 1)))
    if rows < 1 or cols < 2:
        return None
    depth = rows * PANEL[1] / stretch
    span = cols * PANEL[0]
    a0 = (L - span) / 2
    vs = (v_lo, v_lo + depth) if edge == 0 else (W - v_lo, W - v_lo - depth)
    q = [lift(c, along, across, a0, vs[0], height(vs[0]) + 0.12), lift(c, along, across, a0 + span, vs[0], height(vs[0]) + 0.12),
         lift(c, along, across, a0 + span, vs[1], height(vs[1]) + 0.12), lift(c, along, across, a0, vs[1], height(vs[1]) + 0.12)]
    return {"q": q, "n": [cols, rows]}


def flat_panels(part, base):
    """Rows of panels tilted 12 degrees to the south on a flat roof."""
    c = [np.array(p, float) for p in part["p"]]
    L, W = np.linalg.norm(c[1] - c[0]), np.linalg.norm(c[3] - c[0])
    along, across = (c[1] - c[0]) / L, (c[3] - c[0]) / W
    if abs(float(along @ NORTH)) > abs(float(across @ NORTH)):  # rows run east-west
        c = [c[1], c[2], c[3], c[0]]
        L, W, along, across = W, L, across, -along
    south_low = float(across @ NORTH) > 0  # the low edge of each row on the south side
    y = base + part["eaves"] + 0.2
    depth, rise, pitch = 1.05, 1.05 * math.sin(math.radians(12)), 2.0
    cols = int((L - 1.0) // PANEL[0])
    out = []
    v = 0.6
    while v + depth <= W - 0.6 and cols >= 2:
        lo, hi = (v, v + depth) if south_low else (v + depth, v)
        a0 = (L - cols * PANEL[0]) / 2
        out.append({"q": [lift(c, along, across, a0, lo, y), lift(c, along, across, a0 + cols * PANEL[0], lo, y),
                          lift(c, along, across, a0 + cols * PANEL[0], hi, y + rise), lift(c, along, across, a0, hi, y + rise)],
                    "n": [cols, 1], "flat": True})
        v += pitch
    return out


def solar(buildings):
    out = []
    for at, count in SOLAR:
        here = Point(at)
        found = [(b, q) for b in buildings for q in b["parts"] if Polygon(q["p"]).buffer(0).contains(here)]
        if not found:
            print("  solar: no roof at", at)
            continue
        b, q = found[0]
        if q["shape"] == "flat":
            out += flat_panels(q, b["base"])
        else:
            s = slope_panels(q, b["base"], at, count)
            if s:
                out.append(s)
            else:
                print("  solar: no room on the slope at", at)
    return out


# ---------------------------------------------------------------- main

def main():
    """The area of before (`hull`) as it was, then the band along the rest of Molenhoek on its own (its own raster),
    so nothing chosen over the whole area changes what the area of before had."""
    plot, roads_l72, to_model = model_frame()
    model = lambda g: affine_transform(g, to_model)
    nb = json.loads((ROOT / "data" / "neighbours.json").read_text(encoding="utf-8"))
    old = model(hull(plot))
    rest = model(band()).difference(old.buffer(0.5)) if not band().is_empty else Polygon()  # no slivers along the old edge
    touches = lambda line: not rest.is_empty and LineString(line["path"]).intersects(rest)  # a plot line into the band goes with the band
    out, ras, road = build(old, plot, roads_l72, to_model, nb, lambda line: not touches(line))
    if not rest.is_empty:
        more, _, _ = build(rest, plot, roads_l72, to_model, nb, touches)
        offset = len(out["poles"])
        for k in ("roads", "poles", "tracks", "water", "pavings", "pools", "hedges", "fields"):
            out[k] = out[k] + more[k]
        out["wires"] = out["wires"] + [[a + offset, b + offset] for a, b in more["wires"]]
        grid(old)  # the check image shows the area of before
        ras = Raster(to_model)
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    pave, field_list = out["pavings"], out["fields"]
    counts = {}
    for q in pave:
        counts[q["m"]] = counts.get(q["m"], 0) + 1
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB): {len(out['roads'])} road pieces, {len(out['poles'])} poles, {len(out['wires'])} spans of cable, "
          f"{len(out['tracks'])} tracks and paths, {len(out['water'])} ponds and ditches, {len(pave)} pavings {counts}, "
          f"{len(out['pools'])} pools, {len(out['hedges'])} hedges, {len(out['solar'])} panel arrays, "
          f"{len(field_list)} fields {dict((k, sum(f['m'] == k for f in field_list)) for k in {f['m'] for f in field_list})}")
    debug(ras, out, road)


def build(area, plot, roads_l72, to_model, nb, mine):
    """Everything in `area` (model): out (as written), the raster and the road. `mine`: the plot lines it takes."""
    model = lambda g: affine_transform(g, to_model)
    grid(area)
    road = model(roads_l72).buffer(0).intersection(area)
    ras = Raster(to_model)
    hard, veg, pool = classify(ras)

    footprints = [Polygon(b["p"]).buffer(0) for b in nb["buildings"]]
    buildings = unary_union(footprints)
    ours = unary_union([model(plot).buffer(0.5), old_house.site().buffer(0.5), old_house.clear().buffer(0.3)])  # our plot, the bungalow and its drive

    paved, tracks, paths = road_lines(model, area)
    # The paved road where the GRB's road surface has none (it stops at the edge of the old survey).
    extra = unary_union([line.buffer(2.3, cap_style="flat") for line in paved]).difference(road.buffer(0.05)).intersection(area)
    extra_roads = [rings(p.simplify(0.1)) for p in parts_of(extra, "Polygon") if p.buffer(-1.2).area > 10]  # not the slivers along its edge
    road = unary_union([road] + [Polygon(r[0]) for r in extra_roads])
    pole_list, wires = poles(model, area, paved, road)
    ponds = water(model, area, ours.buffer(5))
    wet = unary_union([Polygon(d["rim"]).buffer(0.5) for d in ponds]) if ponds else Polygon()

    all_plots = plots(model, area)
    homes = [p for p in all_plots if any(p.intersection(f).area > 4 for f in footprints)]
    verge = road.buffer(6).difference(road).difference(unary_union(all_plots))
    region = unary_union(homes + [verge]).intersection(buildings.buffer(25)).intersection(area.buffer(-2))
    keep_out = unary_union([road, buildings.buffer(0.25), ours, wet])
    pave = pavings(ras, hard, region, keep_out, buildings)
    pool_list = pools(pool, unary_union(homes).difference(buildings.buffer(0.5)).difference(ours))
    pool_area = unary_union([Polygon(p).buffer(0.6) for p in pool_list]) if pool_list else Polygon()
    pave = [q for q in pave if not Polygon(q["p"][0]).within(pool_area)]

    # Tracks: clear of the road, the yards and the water; the ruts are drawn either side.
    hardened = unary_union([road.buffer(0.5), wet, ours] + [Polygon(q["p"][0]) for q in pave])
    track_list = []
    for kind, lines in (("track", tracks), ("path", paths)):
        for line in lines:
            for seg in parts_of(line.difference(hardened), "LineString"):
                if seg.length >= 4:
                    track_list.append({"k": kind, "path": coords(seg.simplify(0.3))})

    # Hedges along the plot lines between gardens, and along the plots' road side.
    hedges = []
    for k, line in enumerate(nb.get("boundaries", [])):
        if not mine(line):
            continue
        for seg, h in hedge_runs(LineString(line["path"]), ras, veg):
            hedges.append({"b": k, "path": coords(seg), "h": h})
    fronts = unary_union([p.exterior for p in homes]).intersection(road.buffer(4)).difference(road.buffer(0.3)).difference(buildings.buffer(0.5)).difference(ours)
    for line in parts_of(linemerge(fronts) if fronts.geom_type == "MultiLineString" else fronts, "LineString"):
        if line.length < 3:
            continue
        for seg, h in hedge_runs(line.simplify(0.15), ras, veg):
            hedges.append({"b": -1, "path": coords(seg), "h": min(h, 1.8)})

    panels = solar(nb["buildings"]) if mine({"path": [[4.45, -3.0], [4.45, -2.0]]}) else []  # the survey's panels: all in the area of before
    meadow = unary_union([Polygon(a["poly"]) for a in json.loads((ROOT / "data" / "house.manual.json").read_text(encoding="utf-8"))["site"].get("noBoundaries", [])])
    yards = unary_union([Polygon(q["p"][0]).buffer(0) for q in pave] + [Polygon(p).buffer(0.6) for p in pool_list])
    tracks_area = unary_union([LineString(t["path"]).buffer(1.2) for t in track_list]) if track_list else Polygon()
    field_list = fields(ras, veg, all_plots, homes, unary_union([keep_out, meadow, yards, tracks_area, road.buffer(1.0)]), area)

    out = {
        "_source": "GRB (Wegsegment, WPI, WTZ, ADP) and the orthophoto (Digitaal Vlaanderen, open data); laser scan DHM II 2013-2015; "
                   "solar panels from a look at the Google Maps satellite view, 2026-10-30 (reference only)",
        "roads": extra_roads, "poles": pole_list, "wires": wires, "tracks": track_list, "water": ponds,
        "pavings": pave, "pools": pool_list, "hedges": hedges, "solar": panels, "fields": field_list,
    }
    return out, ras, road


def debug(ras, out, road):
    """The photo with what was found drawn on it, at 0.8 m a pixel."""
    img = Image.fromarray((ras.rgb[::2, ::2] * 0.75).astype(np.uint8))
    d = ImageDraw.Draw(img)
    px = lambda x, z: ((x - X0) / (CELL * 2), (z - Z0) / (CELL * 2))
    for f in out["fields"]:
        col = {"field_soil": (230, 200, 150), "field_dark": (140, 100, 60), "field_crop": (120, 200, 60), "forest": (20, 90, 30)}[f["m"]]
        d.polygon([px(x, z) for x, z in f["p"][0]], outline=col)
    for r in out["roads"]:
        d.polygon([px(x, z) for x, z in r[0]], outline=(255, 60, 60))
    for q in out["pavings"]:
        col = {"pave_light": (255, 0, 255), "pave_warm": (255, 140, 0), "gravel": (255, 255, 0)}[q["m"]]
        d.polygon([px(x, z) for x, z in q["p"][0]], outline=col)
    for h in out["hedges"]:
        d.line([px(x, z) for x, z in h["path"]], fill=(0, 255, 0), width=2)
    for t in out["tracks"]:
        d.line([px(x, z) for x, z in t["path"]], fill=(160, 90, 30), width=2)
    for w in out["water"]:
        d.polygon([px(x, z) for x, z in w["rim"]], outline=(0, 120, 255))
    for p in out["pools"]:
        d.polygon([px(x, z) for x, z in p], outline=(0, 255, 255))
    for i, j in out["wires"]:
        a, b = out["poles"][i], out["poles"][j]
        d.line([px(a["x"], a["z"]), px(b["x"], b["z"])], fill=(255, 255, 255))
    for p in out["poles"]:
        x, z = px(p["x"], p["z"])
        d.ellipse([x - 3, z - 3, x + 3, z + 3], outline=(255, 0, 0), width=2)
    for s in out["solar"]:
        d.polygon([px(q[0], q[2]) for q in s["q"]], outline=(0, 200, 255))
    DEBUG.parent.mkdir(parents=True, exist_ok=True)
    img.save(DEBUG)


if __name__ == "__main__":
    main()
