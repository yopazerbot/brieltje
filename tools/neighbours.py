"""Neighbouring houses, the road and trees around the plot, from Flemish open data.

Sources (downloaded once into source/geo/, not in git):
- GRB (Grootschalig Referentiebestand, Digitaal Vlaanderen) via WFS: land
  registry plots (ADP), buildings (GBG), road surface (WBN), addresses.
- DHM Vlaanderen II (laser scan, 1 m, flown 2013-2015) via WCS: terrain (DTM)
  and surface (DSM), 1.2 by 2 km (tools/geodata.py). Surface minus terrain gives building and tree heights
  (everything then stands on the model's flat ground), and the
  shape of each roof part (flat, gable either way, hip, shed: tools/roofs.py). Tree crowns over a
  roof are left out (CANOPY, crowns_over); a building the laser saw only crowns over gets usual
  heights and a gable (under_trees, shaded_parts).
- Orthophoto (Orthofotomozaïek, middenschalig, winteropnamen, kleur, meest recent,
  25 cm, WMS OMWRGBMRVL): the colour of each roof. Buildings in the GRB that are
  newer than the laser scan get usual heights (two storeys for a house, one for an
  outbuilding) and, where the photo shows it, their roof shape (NEWER below).

The plot 1061/D0 (about 40 x 15 m, street on the north-west side) is matched
to the model's plot: the front edge at model z = 17.0 (the front garden zone
on the site plan is 5 m deep and the house front is at z = 11.9), centred on
model x = 4.45. Model +z points from the garden to the street; +x is to the
left when looking at the street.

The area is `zone`: the ring of AREA round the plot, the circle of VILLAGE round the church of
Smetlede (with the school next to it) and the band between them, along the road to the village.
The church gets a tower with a spire from the laser scan's peak (`church_tower`); everything
else in the village is built as in the ring.

Also, for the facades and gardens drawn around the plot: which wall of each
building faces the road and which walls it shares with a neighbour, the lines
between residential plots (for hedges and fences), and the canopies (GBA).

Writes data/neighbours.json and a check image data/debug/neighbours.png.
"""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from roofs import corners, decompose, fit, frame, roof_parts
import shapely
from shapely.affinity import affine_transform, rotate
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import linemerge, unary_union
from shapely.prepared import prep
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
GEO = ROOT / "source" / "geo"
OUT = ROOT / "data" / "neighbours.json"
DEBUG = ROOT / "data" / "debug" / "neighbours.png"

PLOT = "1061/00D000"
FRONT_Z, CENTRE_X = 17.0, 4.45
RADIUS = 75          # m around the plot centre: trees in full
AREA = 540           # m around the plot centre: the ring loaded at the start (Yoshi, 30 Oct 2026: a ring of about 500 m)
# The centre of Smetlede (Yoshi, 30 Oct 2026): the church (Sint-Pharaïldiskerk, the middle of its GRB outline,
# Lambert 72; its GRB building) and the school next to it, within VILLAGE metres of the church.
CHURCH, CHURCH_UIDN, VILLAGE = (119018.7, 184084.2), 9757729, 340
# The primary school east of the church (GRB UIDN): the front wing on Smetlededorp, the long block, the low
# pavilion and the two sheds round the playground. Our Blender model (tools/school.py) takes their place.
SCHOOL_UIDNS = {1852114, 9796774, 9758237, 1852643, 5565555}
TILE_X0, TILE_Y1, TILE_W, TILE_H = 118300, 185600, 1200, 2000  # the height rasters: west and north edge (Lambert 72), metres across and down
OUR_GROUND = -0.1    # model ground level
# Buildings newer than the laser scan (GRB UIDN): their roof as the 2025 orthophoto shows it.
# Without an entry: a house gets a flat roof on two storeys, an outbuilding one storey.
NEWER = {7305773: {"shape": "hip", "eaves": 3.4, "ridge": 8.0}, 9422468: {"shape": "gable", "eaves": 3.0, "ridge": 5.2}}
# Tree crowns over the roofs. The laser scan measures the top of whatever is there: over a barn in
# a wood that is the crowns, 20 to 35 m up, and the barn became a block with towers. No roof here is
# higher than these (m, by GRB kind; the church and its tower are measured on their own), so points
# above are crowns.
CANOPY = {"hoofdgebouw": 14.0, "bijgebouw": 11.0}
STEEPEST = 1.75      # rise per metre: no roof here is steeper than 60 degrees (the church's spire is its own)
SHED_AREA = 20.0     # m²: below this a building is a shed or a hut, one storey, whatever the GRB calls it


def under_trees(poly, sample, limit, outside, kind):
    """Whether the laser saw tree crowns instead of this building's roof: most of its points higher
    than any roof of its kind, or one crown carrying on past its walls at the same height (a roof
    stops at its walls; outside them is a yard or a garden). A shed (an outbuilding of under 40 m²)
    as high as a house needs the crown on one side only."""
    lim, limit[0] = limit[0], None
    _, h = sample(poly)
    limit[0] = lim
    if len(h) < 2:
        return False
    if float((h <= lim).mean()) < 0.4:
        return True
    top = float(np.median(h))
    ring = outside(poly, poly)
    if top < 4.0 or len(ring) < 6:
        return False
    shed = kind != "hoofdgebouw" and poly.area < 40 and top >= 5.5
    return float(np.percentile(ring, 75 if shed else 50)) >= 0.6 * top


def crowns_over(poly, parts, outside):
    """Roof parts that stand well above the rest of the roof, bumpy as a crown is (a roof is a smooth
    slope), with crowns as high just outside the wall beside them: a tree over that end of the roof
    (a block shot up from a shed). Returns [(part, height)]: the laser points in the part higher than
    that are crowns."""
    main = max(parts, key=lambda p: p[0].intersection(poly).area)[1]
    out = []
    for rect, r in parts:
        piece = rect.intersection(poly)
        if r is main or r["eaves"] < main["ridge"] + 2.5 or piece.area > 0.4 * poly.area or r.get("rmse", 0) < 1.0:
            continue
        ring = outside(piece, poly)
        if len(ring) >= 4 and float(np.percentile(ring, 75)) >= 0.5 * r["eaves"]:
            out.append((rect.buffer(0.5), main["ridge"] + 1.0))
    return out


def shaded_parts(poly, kind):
    """Roofs for a building under trees, which the laser can't see: a gable over each part, as on
    the old farm buildings round here (eaves a storey up, a storey and a half on a house), a flat
    roof on a shed."""
    out = []
    for rect in roof_parts(poly):
        _, u, v, _, half = frame(rect)
        if poly.area < SHED_AREA:
            r = {"shape": "flat", "eaves": 2.6, "ridge": 2.6}
        else:
            eaves = 4.8 if kind == "hoofdgebouw" else 3.0
            r = {"shape": "gable", "eaves": eaves, "ridge": eaves + min(4.5, 0.8 * half)}  # about 40 degrees
        out.append((rect, {**r, "ridge_dir": u, "high": v}))
    return out


class Ortho:
    """The aerial photo around the plot: the typical colour of a roof."""

    def __init__(self):
        meta = json.loads((GEO / "ortho_025m.json").read_text(encoding="utf-8"))
        Image.MAX_IMAGE_PIXELS = None  # 4800 x 8000 px: our own download
        self.img = Image.open(GEO / "ortho_025m.jpg").convert("RGB")
        self.rgb = np.asarray(self.img)
        self.x0, self.y1, self.k = meta["x0"], meta["y1"], meta["px"] / (meta["x1"] - meta["x0"])

    def colour(self, poly):
        """The roof's colour in a Lambert 72 polygon, as a tint for the roof tile texture: the
        median of its pixels, without the haze of the photo (an offset of about 40 and paler
        colours), divided by the texture's own brightness (0.76)."""
        x0, y0, x1, y1 = poly.bounds  # only the pixels round the polygon
        c0, r0 = max(0, int((x0 - self.x0) * self.k) - 1), max(0, int((self.y1 - y1) * self.k) - 1)
        patch = self.rgb[r0:int((self.y1 - y0) * self.k) + 2, c0:int((x1 - self.x0) * self.k) + 2]
        mask = Image.new("L", (patch.shape[1], patch.shape[0]), 0)
        for part in getattr(poly, "geoms", [poly]):
            if part.geom_type == "Polygon":
                px = [((x - self.x0) * self.k - c0, (self.y1 - y) * self.k - r0) for x, y in part.exterior.coords]
                ImageDraw.Draw(mask).polygon(px, fill=255)
        rgb = patch[np.asarray(mask) > 0].astype(np.float32)
        if len(rgb) < 20:
            return None
        c = np.clip(np.median(rgb, axis=0) - 40, 0, 255)
        grey = c @ np.array([0.3, 0.59, 0.11])
        # Bluish is solar panels over the tiles: towards anthracite instead of blue tiles.
        c = np.clip((grey + (c - grey) * (0.35 if c[2] > c[0] + 8 else 1.3)) / 0.76, 0, 255)
        return "#%02x%02x%02x" % tuple(int(v) for v in c)

    def check(self, overlay, centre, path, half=110):
        """Check image: the photo around the plot with each roof part drawn on it (outline, ridge
        in red for a gable, cyan for a hip, the high side in magenta for a shed, a cross if flat)."""
        img = self.img.copy()
        g = ImageDraw.Draw(img)
        px = lambda q: ((q[0] - self.x0) * self.k, (self.y1 - q[1]) * self.k)
        for poly, parts, newer in overlay:
            g.polygon([px(q) for q in poly.exterior.coords], outline=(255, 140, 0) if newer else (255, 230, 0), width=3 if newer else 1)
            for rect, r in parts:
                p0, p1, p2, p3 = corners(rect, r["ridge_dir"], r["high"])
                if r["shape"] in ("gable", "hip"):
                    g.line([px((p0 + p3) / 2), px((p1 + p2) / 2)], fill=(255, 40, 40) if r["shape"] == "gable" else (40, 230, 255), width=3)
                elif r["shape"] == "shed":
                    g.line([px(p3), px(p2)], fill=(255, 60, 255), width=3)
                else:
                    g.line([px(p0), px(p2)], fill=(255, 255, 255), width=1)
                    g.line([px(p1), px(p3)], fill=(255, 255, 255), width=1)
        cx, cy = px((centre.x, centre.y))
        r = half * self.k
        img.crop((int(cx - r), int(cy - r), int(cx + r), int(cy + r))).save(path, quality=88)


def features(name):
    return json.loads((GEO / f"{name}_l72.json").read_text(encoding="utf-8"))["features"]


def polygons(geom):
    coords = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return [Polygon(c[0], c[1:]) for c in coords]


def zone(plot):
    """The area of the surroundings (Lambert 72): the ring of AREA round the plot, the circle of
    VILLAGE round the church, and the band between them (the two circles' convex hull)."""
    return unary_union([plot.centroid.buffer(AREA, 64), Point(CHURCH).buffer(VILLAGE, 64)]).convex_hull


def church_tower(poly, ndsm):
    """The church tower from the laser scan: the cells round the church's highest point that stand
    more than half as high (the spire and the top of the tower), as a square lined up with the
    church's walls; its walls up to their lower quarter, the spire up to the peak (Lambert 72).
    A model of the church made in Blender can take its place later."""
    x0, y0, x1, y1 = poly.bounds
    r0, c0 = int(TILE_Y1 - y1), int(x0 - TILE_X0)
    win = ndsm[r0:int(TILE_Y1 - y0) + 1, c0:int(x1 - TILE_X0) + 1]
    pr, pc = np.unravel_index(np.argmax(win), win.shape)
    peak = float(win[pr, pc])
    rows, cols = np.nonzero(win > peak * 0.55)
    near = np.hypot(rows - pr, cols - pc) <= 4
    xy = np.stack([TILE_X0 + c0 + cols[near] + 0.5, TILE_Y1 - r0 - rows[near] - 0.5], 1)
    hs = win[rows[near], cols[near]]
    side = float(np.clip(np.sqrt(len(hs)), 4.0, 8.0))
    c = list(poly.minimum_rotated_rectangle.exterior.coords)
    u = max((np.subtract(c[i + 1], c[i]) for i in range(2)), key=np.linalg.norm)
    u = u / np.linalg.norm(u)
    v = np.array([-u[1], u[0]])
    m = xy.mean(0)
    square = [m + (u * a + v * b) * side / 2 for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    top = float(np.percentile(hs, 25))
    return square, top, max(peak, top + 4)


def church_parts(poly, sample, tower):
    """The church's roofs (Lambert 72), [(rectangle, fit)] as `decompose` gives them: the nave's
    gable over the whole length at the width of its narrow part, the transept's gable across where
    the wide part stands as high as the nave, lower roofs over the rest of the wide part (the
    sacristies beside the choir). The tower's laser points are left out."""
    c = list(poly.minimum_rotated_rectangle.exterior.coords)
    u = max((np.subtract(c[i + 1], c[i]) for i in range(2)), key=np.linalg.norm)
    ang, origin = math.atan2(u[1], u[0]), c[0]
    flat = rotate(poly.simplify(0.3), -ang, origin=origin, use_radians=True)
    back = lambda x0, y0, x1, y1: rotate(box(x0, y0, x1, y1), ang, origin=origin, use_radians=True)
    xs = sorted({round(x * 2) / 2 for x, _ in flat.exterior.coords})
    pieces = []  # [x0, x1, y0, y1] along the church, merged where the width stays the same
    for x0, x1 in zip(xs, xs[1:]):
        _, y0, _, y1 = flat.intersection(box(x0, -1e7, x1, 1e7)).bounds
        if pieces and abs(pieces[-1][2] - y0) < 0.8 and abs(pieces[-1][3] - y1) < 0.8:
            pieces[-1][1] = x1
        else:
            pieces.append([x0, x1, y0, y1])
    nave = max(pieces, key=lambda q: q[1] - q[0])
    ny0, ny1 = nave[2], nave[3]
    nave_rect = back(xs[0], ny0, xs[-1], ny1)
    parts = [(nave_rect, fit(nave_rect, *sample(nave_rect.intersection(poly).difference(tower))))]
    nave_top = parts[0][1]["ridge"] if parts[0][1] else 10.0
    for x0, x1, y0, y1 in pieces:
        sides = [(y0, ny0), (ny1, y1)]
        if min(b - a for a, b in sides) < 1.5:
            continue  # no wider than the nave
        # Along the wide piece in metre steps: as high as the nave (the transept) or lower.
        high = []
        for x in np.arange(x0, x1, 1.0):
            h = np.concatenate([sample(back(x, a, min(x + 1, x1), b).intersection(poly))[1] for a, b in sides])
            high.append(len(h) > 0 and float(np.median(h)) > nave_top * 0.6)
        runs, k = [], 0
        while k < len(high):  # runs of the same kind, as [from, to, high]
            e = k
            while e + 1 < len(high) and high[e + 1] == high[k]:
                e += 1
            runs.append([x0 + k, min(x1, x0 + e + 1), high[k]])
            k = e + 1
        for a, b, tall in runs:
            if tall:  # the transept: one gable across, fitted on its arms
                rect = back(a, y0, b, y1)
                arms = rect.intersection(poly).difference(nave_rect)
                parts.append((rect, fit(rect, *sample(arms))))
            else:
                for lo, hi in sides:
                    rect = back(a, lo, b, hi)
                    parts.append((rect, fit(rect, *sample(rect.intersection(poly)))))
    return [(rect, r) for rect, r in parts if r]

def model_frame():
    """Our plot, the road surface (both Lambert 72) and the affine matrix from Lambert 72 to the
    model (for shapely's affine_transform), from the plot's front and back edges."""
    plot = next(polygons(f["geometry"])[0] for f in features("ADP") if f["properties"]["CAPAKEY"].endswith(PLOT))
    roads = unary_union([p for f in features("WBN") for p in polygons(f["geometry"])])

    # Front edge: the plot side touching the road. Back edge: the opposite short side.
    pts = list(plot.minimum_rotated_rectangle.exterior.coords)[:4]
    edges = [(pts[i], pts[(i + 1) % 4]) for i in range(4)]
    short = sorted(edges, key=lambda e: math.dist(*e))[:2]
    front = min(short, key=lambda e: roads.distance(Point((e[0][0] + e[1][0]) / 2, (e[0][1] + e[1][1]) / 2)))
    back = short[1] if front is short[0] else short[0]
    F = np.array([(front[0][0] + front[1][0]) / 2, (front[0][1] + front[1][1]) / 2])
    B = np.array([(back[0][0] + back[1][0]) / 2, (back[0][1] + back[1][1]) / 2])
    uz = (F - B) / np.linalg.norm(F - B)          # model +z: towards the street
    ux = np.array([-uz[1], uz[0]])                 # model +x
    # Lambert 72 -> model: x = 4.45 + (P - F).ux, z = 17 + (P - F).uz
    to_model = [ux[0], ux[1], uz[0], uz[1], CENTRE_X - F @ ux, FRONT_Z - F @ uz]
    return plot, roads, to_model


def main():
    plot, roads, to_model = model_frame()
    model = lambda g: affine_transform(g, to_model)

    dsm = np.array(Image.open(GEO / "DHMVII_DSM_1m_clean.tif"), dtype=np.float32)
    dtm = np.array(Image.open(GEO / "DHMVII_DTM_1m_clean.tif"), dtype=np.float32)
    ndsm = dsm - dtm

    def cells(poly):
        """Raster cells (row, col) whose centres fall in a Lambert 72 polygon."""
        x0, y0, x1, y1 = poly.bounds
        r0, r1 = max(0, int(TILE_Y1 - y1)), min(TILE_H - 1, int(TILE_Y1 - y0))
        c0, c1 = max(0, int(x0 - TILE_X0)), min(TILE_W - 1, int(x1 - TILE_X0))
        if r1 < r0 or c1 < c0:
            return []
        rows, cols = np.mgrid[r0:r1 + 1, c0:c1 + 1]
        hit = shapely.contains_xy(poly, TILE_X0 + cols + 0.5, TILE_Y1 - rows - 0.5)
        return list(zip(rows[hit].tolist(), cols[hit].tolist()))

    centre = plot.centroid
    area = zone(plot)
    within = prep(area)
    # Everything that is not open ground next to a wall: the buildings and the road, for the ring of
    # laser points just outside a building (`under_trees`).
    built = unary_union([p for f in features("GBG") for p in polygons(f["geometry"]) if within.contains(p.centroid)])
    not_open = prep(unary_union([built.buffer(0.5), roads]))

    def outside(piece, footprint):
        """Laser heights in a band 1 to 3 m outside a footprint, beside `piece` of it, on open ground."""
        band = piece.buffer(3.0).difference(footprint.buffer(1.0))
        pc = [(r, c) for r, c in cells(band) if not not_open.contains(Point(TILE_X0 + c + 0.5, TILE_Y1 - r - 0.5))] if not band.is_empty else []
        return np.array([ndsm[r, c] for r, c in pc], np.float32)

    ortho = Ortho()
    overlay = []  # (footprint, roof parts) in Lambert 72, for the check image on the photo
    rnd = lambda q: [round(float(q[0]), 2), round(float(q[1]), 2)]
    buildings = []
    footprints = []
    newer = shaded = 0
    for f in features("GBG"):
        for poly in polygons(f["geometry"]):
            if not within.contains(poly.centroid) or poly.intersects(plot.buffer(-0.5)):
                continue
            footprints.append(poly)
            # On the model's flat ground: the terrain within the area rises and falls by up to 6 m,
            # and a house on a slope would float or sink. Heights are measured from its own ground.
            base = OUR_GROUND
            kind = f["properties"]["LBLTYPE"]
            church = f["properties"]["UIDN"] == CHURCH_UIDN
            # Tree crowns over a roof: the laser sees the crown, not the roof under it. Points higher
            # than any roof of its kind (CANOPY) are crowns, and so are those over a part that
            # crowns_over finds (`zones`: the part and the height above which its points are dropped).
            limit = [None if church else CANOPY.get(kind, CANOPY["bijgebouw"])]
            zones = []

            # A roof per rectangular part, its shape and heights fitted to the laser heights in it.
            def sample(piece):
                """Laser points in a piece of the footprint, half a metre in from its walls (all of
                a building too small for that), without the tree crowns over it."""
                inner = piece.buffer(-0.5)
                pc = cells(inner) if not inner.is_empty else []
                if not pc or (len(pc) < 3 and piece.area > 0.95 * poly.area):
                    pc = cells(piece) if not piece.is_empty else []  # a hut of a few square metres: up to its walls
                xy = np.array([(TILE_X0 + col + 0.5, TILE_Y1 - row - 0.5) for row, col in pc]).reshape(-1, 2)
                h = np.array([ndsm[row, col] for row, col in pc], np.float32)
                if limit[0] is None:
                    return xy, h
                keep = h <= limit[0]
                for zone_, top_ in zones:
                    if len(h):
                        keep &= ~(shapely.contains_xy(zone_, xy[:, 0], xy[:, 1]) & (h > top_))
                return xy[keep], h[keep]

            if church:
                square, top, peak = church_tower(poly, ndsm)
                parts = church_parts(poly, sample, Polygon(square))
                trees = False
            else:
                trees = under_trees(poly, sample, limit, outside, kind)
                parts = [] if trees else decompose(poly, sample)
                if parts:
                    zones = crowns_over(poly, parts, outside)
                    if zones:
                        parts = decompose(poly, sample)  # again, without the crown
            # Scanned if the laser saw its main roof: a building newer than the scan is bare ground there,
            # with at most a tree from beside it over one end.
            scanned = parts and max(parts, key=lambda p: p[0].intersection(poly).area)[1]["ridge"] >= 2.0
            if trees:
                shaded += 1
                parts = shaded_parts(poly, kind)
            elif not scanned:
                # Newer than the laser scan (the GRB has it, the scan doesn't): usual heights.
                newer += 1
                look = NEWER.get(f["properties"]["UIDN"])
                main = kind == "hoofdgebouw" and poly.area >= SHED_AREA  # a hut is one storey whatever the GRB calls it
                parts = []
                for i, rect in enumerate(roof_parts(poly)):
                    _, u, v, _, _ = frame(rect)
                    if look and i == 0:
                        r = {**look}
                    else:
                        top = 6.2 if main else 2.8
                        r = {"shape": "flat", "eaves": top, "ridge": top}
                    parts.append((rect, {**r, "ridge_dir": u, "high": v}))
            overlay.append((poly, parts, not scanned and not trees))
            out_parts = []
            for rect, r in parts:
                eaves = max(2.3, r["eaves"])
                ridge = min(max(eaves, r["ridge"]), eaves + 9)
                if scanned and limit[0] is not None:
                    # A slope fitted to what the crowns leave stays under them, and no steeper than
                    # STEEPEST (a spike there is the edge of a crown, not a roof).
                    _, u, _, half_u, half_v = frame(rect)
                    run = (half_v if abs(r["ridge_dir"] @ u) > 0.5 else half_u) * (2 if r["shape"] == "shed" else 1)
                    ridge = max(eaves, min(ridge, limit[0], eaves + STEEPEST * run))
                ring = [rnd(model(Point(*q)).coords[0]) for q in corners(rect, r["ridge_dir"], r["high"])]
                out_parts.append({"p": ring, "shape": r["shape"], "eaves": round(eaves, 2), "ridge": round(ridge, 2),
                                  "color": ortho.colour(rect.intersection(poly)) if rect.intersection(poly).area > 2 else None})
            main_part = max(out_parts, key=lambda q: Polygon(q["p"]).area)
            ring = [[round(x, 2), round(z, 2)] for x, z in model(poly).exterior.coords[:-1]]
            pitched = [q for q in out_parts if q["shape"] != "flat"]
            buildings.append({
                "kind": kind, "p": ring, "base": round(base, 2), "eaves": main_part["eaves"], "ridge": main_part["ridge"],
                "flat": not pitched, "parts": out_parts, "newer": not scanned and not trees,
                "roof": (max(pitched, key=lambda q: Polygon(q["p"]).area)["color"] if pitched else main_part["color"]),
            })
            if trees:
                buildings[-1]["trees"] = True  # under tree crowns: usual heights (shaded_parts)
            if church:
                buildings[-1].update({"landmark": "church", "tower": {
                    "p": [rnd(model(Point(*q)).coords[0]) for q in square], "top": round(top, 2), "peak": round(peak, 2)}})
                print(f"  church: tower walls to {top:.1f} m, spire to {peak:.1f} m")
            elif f["properties"]["UIDN"] in SCHOOL_UIDNS:
                buildings[-1]["landmark"] = "school"
    walls(buildings, [model(p) for p in footprints], model(roads))

    # Trees: tall vegetation (surface 3 m or more above the terrain) away from buildings and
    # outside our plot; one tree per local high point. Near the plot every tree (4 m apart, up
    # to 60); out to 240 m up to 320 in all, the tallest first; in the outer ring (the woods,
    # tree rows) one per 7 m and 5 m tall or more, up to 1700 in all. Then the village: within
    # 160 m of the church as near the plot (up to 260 more), the rest of the zone as the outer
    # ring (up to 1400 more).
    keep_out = prep(unary_union([p.buffer(1.5) for p in footprints] + [plot, roads.buffer(0.5)]))
    trees = []
    near = {}  # 8 m grid square -> trees in it, for the spacing check

    def room(x, y, gap):
        i, j = int(x // 8), int(y // 8)
        return all(math.dist((x, y), t[0]) >= gap for di in (-1, 0, 1) for dj in (-1, 0, 1) for t in near.get((i + di, j + dj), ()))

    cx, cy = centre.x, centre.y
    beyond = prep(area.difference(centre.buffer(AREA, 64)))
    # (centre, radius or None for the zone beyond the ring, cap in all or None, more on top, gap, lowest)
    tiers = [((cx, cy), RADIUS, 60, 0, 4.0, 3.0), ((cx, cy), 240, 320, 0, 4.0, 3.0), ((cx, cy), AREA, 1700, 0, 7.0, 5.0),
             (CHURCH, 160, None, 260, 4.0, 3.0), (None, None, None, 1400, 7.0, 5.0)]
    for at, radius, cap, more, gap, low in tiers:
        cap = cap or len(trees) + more
        if radius is None:  # the zone beyond the ring
            bx0, by0, bx1, by1 = area.bounds
            r0, c0 = max(0, int(TILE_Y1 - by1)), max(0, int(bx0 - TILE_X0))
            window = ndsm[r0:int(TILE_Y1 - by0), c0:int(bx1 - TILE_X0)]
        else:
            r0, c0 = max(0, int(TILE_Y1 - at[1] - radius)), max(0, int(at[0] - TILE_X0 - radius))
            window = ndsm[r0:r0 + 2 * radius, c0:c0 + 2 * radius]
        order = np.dstack(np.unravel_index(np.argsort(-window, axis=None), window.shape))[0]
        for row, col in order:
            h = float(window[row, col])
            if h < low or len(trees) >= cap:
                break
            x, y = TILE_X0 + c0 + col + 0.5, TILE_Y1 - (r0 + row) - 0.5
            outside = not beyond.contains(Point(x, y)) if radius is None else math.dist((x, y), at) > radius
            if outside or not room(x, y, gap) or keep_out.contains(Point(x, y)):
                continue
            patch = window[max(0, row - 4):row + 5, max(0, col - 4):col + 5]
            crown = max(1.2, min(4.5, math.sqrt(float((patch > h * 0.5).sum()) / math.pi)))
            trees.append(((x, y), h, crown))
            near.setdefault((int(x // 8), int(y // 8)), []).append(trees[-1])
    tree_out = []
    for (x, y), h, crown in trees:
        p = model(Point(x, y))
        base = OUR_GROUND  # on the flat ground, as the houses
        tree_out.append({"x": round(p.x, 2), "z": round(p.y, 2), "y": round(base, 2), "h": round(min(h, 25), 1), "r": round(crown, 1)})

    road_out = []
    for poly in getattr(roads, "geoms", [roads]):
        clipped = poly.intersection(area.buffer(20))
        for part in getattr(clipped, "geoms", [clipped]):
            if part.area > 2:
                m = model(part.simplify(0.2))
                road_out.append([[[round(x, 2), round(z, 2)] for x, z in ring.coords[:-1]] for ring in [m.exterior, *m.interiors]])

    plot_ring = [[round(x, 2), round(z, 2)] for x, z in model(plot).exterior.coords[:-1]]
    bounds = boundaries(plot, within, footprints, roads, model)
    canopies = []
    for f in features("GBA"):
        if f["properties"]["LBLTYPE"] != "afdak":
            continue
        for poly in polygons(f["geometry"]):
            if not within.contains(poly.centroid) or poly.intersects(plot):
                continue
            cs = cells(poly)
            base = OUR_GROUND
            top = float(np.percentile([ndsm[r, c] for r, c in cs], 60)) if cs else 2.6
            canopies.append({"p": [[round(x, 2), round(z, 2)] for x, z in model(poly).exterior.coords[:-1]],
                             "base": round(base, 2), "top": round(min(3.5, max(2.3, top)), 2)})
    # A handful of roof colours (the photo's colours grouped, k-means), the ring's and the
    # village's each on their own (the ring keeps the colours it had before the village came).
    in_ring = [f.centroid.distance(centre) <= AREA for f in footprints]
    for group in (True, False):
        roofs_rgb = [(b, q) for b, r in zip(buildings, in_ring) if r == group for q in b["parts"] if q["color"]]
        if len(roofs_rgb) <= 8:
            continue
        rgb = np.array([[int(q["color"][i:i + 2], 16) for i in (1, 3, 5)] for _, q in roofs_rgb], np.float32)
        centres = rgb[np.linspace(0, len(rgb) - 1, 8).astype(int)].copy()
        for _ in range(20):
            label = np.argmin(((rgb[:, None] - centres[None]) ** 2).sum(-1), 1)
            for k in range(len(centres)):
                if (label == k).any():
                    centres[k] = rgb[label == k].mean(0)
        for (b, q), k in zip(roofs_rgb, label):
            q["color"] = "#%02x%02x%02x" % tuple(int(v) for v in centres[k])
    if buildings:
        for b in buildings:
            pitched = [q for q in b["parts"] if q["shape"] != "flat"]
            b["roof"] = max(pitched or b["parts"], key=lambda q: Polygon(q["p"]).area)["color"]
    OUT.write_text(json.dumps({
        "_source": "GRB and DHM Vlaanderen II (Digitaal Vlaanderen, open data); laser scan 2013-2015",
        "plot": plot_ring, "buildings": buildings, "roads": road_out, "trees": tree_out,
        "boundaries": bounds, "canopies": canopies,
    }, separators=(",", ":")), encoding="utf-8")
    shapes = {}
    for b in buildings:
        for q in b["parts"]:
            shapes[q["shape"]] = shapes.get(q["shape"], 0) + 1
    print(f"  roof parts: {shapes}; {newer} buildings newer than the laser scan, {shaded} under trees")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(buildings)} buildings, {len(road_out)} road pieces, {len(tree_out)} trees, "
          f"{len(bounds)} plot boundary lines ({sum(LineString(b['path']).length for b in bounds):.0f} m), {len(canopies)} canopies")
    print("  plot in model coordinates:", plot_ring)
    for b in sorted(buildings, key=lambda b: Polygon(b["p"]).centroid.distance(Point(4.45, 0)))[:6]:
        c = Polygon(b["p"]).centroid
        print(f"  {b['kind']:12s} at ({c.x:6.1f}, {c.y:6.1f})  base {b['base']:5.2f}  eaves {b['eaves']:5.2f}  ridge {b['ridge']:5.2f}  "
              f"{', '.join(q['shape'] for q in b['parts'])}  roof {b['roof']}")

    # Check image: top view (x right, z down, as seen from above), 2 px per m; our plot and house in
    # yellow, the zone's edge in white.
    s = 2
    mx0, mz0, mx1, mz1 = model(area).bounds
    img = Image.new("RGB", (int((mx1 - mx0 + 40) * s), int((mz1 - mz0 + 40) * s)), (40, 60, 35))
    g = ImageDraw.Draw(img)
    px = lambda x, z: ((x - mx0 + 20) * s, (z - mz0 + 20) * s)
    for r in road_out:
        g.polygon([px(*v) for v in r[0]], fill=(110, 110, 110))
        for hole in r[1:]:  # the road rings a field: draw its inside as grass again
            g.polygon([px(*v) for v in hole], fill=(40, 60, 35))
    for b in bounds:
        g.line([px(*v) for v in b["path"]], fill=(200, 200, 120) if b["low"] else (230, 230, 230), width=1)
    for b in buildings:
        g.polygon([px(*v) for v in b["p"]], fill=(170, 90, 70) if not b["flat"] else (140, 120, 110), outline=(0, 0, 0))
        for q in b["parts"]:  # the ridge of each pitched part (shed: its high side)
            a, c1, c2, c3 = q["p"]
            if q["shape"] in ("gable", "hip"):
                m0 = ((a[0] + c3[0]) / 2, (a[1] + c3[1]) / 2)
                m1 = ((c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2)
                g.line([px(*m0), px(*m1)], fill=(255, 240, 120) if q["shape"] == "gable" else (120, 220, 255), width=2)
            elif q["shape"] == "shed":
                g.line([px(*c3), px(*c2)], fill=(255, 120, 220), width=2)
    for t in tree_out:
        g.ellipse([px(t["x"] - t["r"], t["z"] - t["r"]), px(t["x"] + t["r"], t["z"] + t["r"])], fill=(30, 110, 40))
    g.polygon([px(*v) for v in plot_ring], outline=(240, 200, 60), width=3)
    g.polygon([px(*v) for v in model(area).exterior.coords], outline=(240, 240, 240), width=2)
    ortho.check(overlay, centre, DEBUG.parent / "roofs_on_photo.jpg")
    ortho.check(overlay, Point(CHURCH), DEBUG.parent / "village_on_photo.jpg", half=180)
    g.rectangle([px(0.11, 0.11), px(8.91, 11.91)], outline=(240, 200, 60), width=3)
    DEBUG.parent.mkdir(parents=True, exist_ok=True)
    img.save(DEBUG)


def walls(buildings, footprints, roads):
    """For each building (model coordinates): the wall facing the road (`front`, an edge index
    of `p`, edge i runs from p[i] to p[i+1]) and the walls against another building (`shared`)."""
    index = STRtree(footprints)
    road_edge = roads.boundary
    for b in buildings:
        poly = Polygon(b["p"])
        if not poly.is_valid:
            poly = poly.buffer(0)
        others = [footprints[k] for k in index.query(poly.buffer(0.5))]
        others = [f for f in others if not f.equals(poly) and f.distance(poly) < 0.5 and f.centroid.distance(poly.centroid) > 0.5]
        n = len(b["p"])
        best, best_d = -1, 40.0
        shared = []
        for i in range(n):
            a, c = np.array(b["p"][i]), np.array(b["p"][(i + 1) % n])
            edge = LineString([a, c])
            if edge.length < 0.5:
                continue
            if any(edge.buffer(0.35).intersection(o).area > 0.3 * edge.length * 0.35 for o in others):
                shared.append(i)
                continue
            mid = (a + c) / 2
            d = (c - a) / np.linalg.norm(c - a)
            out = np.array([d[1], -d[0]])
            if poly.contains(Point(*(mid + out * 0.2))):
                out = -out
            near = road_edge.interpolate(road_edge.project(Point(*mid)))
            to_road = np.array([near.x, near.y]) - mid
            dist = float(np.linalg.norm(to_road))
            if dist < best_d and to_road @ out > 0.5 * dist:
                best, best_d = i, dist
        b["front"] = best
        b["shared"] = shared


def boundaries(plot, within, footprints, roads, model):
    """Lines between residential plots (a plot with a building on it), in model coordinates:
    not along the road, not through buildings, not around our own plot (it has its own
    hedges), and only in the gardens (within 35 m of a building; deep plots end in meadow).
    `low`: within 7 m of the road (front gardens); `line`: pieces of one boundary share it (the
    model position of the boundary's middle)."""
    plots = [p for f in features("ADP") for p in polygons(f["geometry"]) if within.contains(p.centroid)]
    homes = [p for p in plots if any(p.buffer(-0.5).contains(b.centroid) for b in footprints) and not p.equals(plot)]
    lines = unary_union([p.exterior for p in homes])
    lines = lines.difference(roads.buffer(1.5)).difference(unary_union([b.buffer(0.4) for b in footprints])).difference(plot.buffer(0.6))
    lines = lines.intersection(unary_union([b.buffer(35) for b in footprints]))
    front = roads.buffer(7)
    out = []
    merged = linemerge(lines) if lines.geom_type == "MultiLineString" else lines
    for line in getattr(merged, "geoms", [merged]):
        mid = model(line.interpolate(0.5, normalized=True))
        k = [round(mid.x, 1), round(mid.y, 1)]  # the whole line's middle: the same choice for its pieces, whatever else is in the data
        for piece, low in ((line.intersection(front), True), (line.difference(front), False)):
            for seg in getattr(piece, "geoms", [piece]):
                if seg.is_empty or seg.geom_type != "LineString" or seg.length < 3:
                    continue
                m = model(seg.simplify(0.15))
                out.append({"path": [[round(x, 2), round(z, 2)] for x, z in m.coords], "low": low, "line": k})
    return out


if __name__ == "__main__":
    main()
