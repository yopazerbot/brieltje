"""The life of the countryside round the house: where cows and sheep graze, where crows feed on the
fields, where ducks swim and where round bales stand by the barns.

Sources as in tools/street.py (source/geo/, not in git): the GRB plots, the 25 cm orthophoto and
the laser scan, with the buildings of data/neighbours.json and the fields and ponds already in
web/src/data/house.json. Only the ring round the house counts, outside the home area (125 m round
the plot), the bungalow's garden, the strongmen's patches and the portals.

- pastures: the plots without a building that the photo shows as grass (green over nine tenths of
  the plot, the laser scan seeing no trees over it), inset 3 m from their edges. The larger ones
  get a herd of cows (one per 1,100 m2 or so, at most 8), the smaller ones a few sheep. Each
  animal gets its own loop of four spots inside the pasture, near its herd's middle, with what it
  does at each (graze or lie down and chew) and for how long; the game walks it round the loop on
  the shared clock, like the horses (web/src/world/herds.ts).
- crows: a spot on a few bare fields (light or dark soil), well inside the field.
- ducks: the ponds and the wider stretches of the ditches, as a middle and a radius of open water.
- bales: the rows of round bales that the photo shows, and the stores in two farmyards.

Nothing here is keyed by address. Writes web/src/data/countryside.json and a check image
data/debug/countryside.png. Run from the project root:
    tools/.venv/Scripts/python.exe tools/countryside.py
"""
import json
import math
import random
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from shapely.affinity import affine_transform
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import polylabel, unary_union

import street
from neighbours import AREA, model_frame
from street import Raster, classify, parts_of, plots

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "src" / "data" / "countryside.json"
DEBUG = ROOT / "data" / "debug" / "countryside.png"
HOUSE = ROOT / "web" / "src" / "data" / "house.json"
SHARED = ROOT / "web" / "shared"

CENTRE = (4.45, -3.0)    # the plot's middle (model)
HOME = 125               # m round it: the home area (the house, the garden, the horses' meadow)
BUNGALOW = ((83.5, 189.7), 45)
COW_AREA = 1100          # m2 of pasture per cow
SPEED = {"cow": 0.8, "sheep": 0.7}  # m/s between spots (web/src/world/herds.ts walks them)
# Green plots that the photo shows as winter cereals (tramlines across them), not grass: no herds.
CEREALS = [(-220, -445, -95, -290), (330, 40, 470, 110)]  # x0, z0, x1, z1 (model)
# Round bales, from the photo (model x0, z0, x1, z1, how many, wrapping, how they lie): a row of
# white bales wrapped in one long sleeve at the edge of a meadow, and the stores in two farmyards.
BALES = [
    (236.2, -100.5, 236.2, -87.5, 10, "white", "inline"),  # clear of the fence along the plot line
    (263.6, -90.1, 265.6, -78.2, 6, "hay", "hay"),
    (105.5, -391.0, 105.5, -379.0, 8, "black", "stack"),
]


def r2(v):
    return round(float(v), 2)


def keep_out():
    """Where no animal may stand: the home area, the bungalow's garden, the strongmen's patches
    and round each portal."""
    zones = [Point(CENTRE).buffer(HOME), Point(BUNGALOW[0]).buffer(BUNGALOW[1])]
    clowns = json.loads((SHARED / "clowns.json").read_text(encoding="utf-8"))
    zones += [Point(x, z).buffer(36) for x, _y, z, kind in clowns["spots"] if kind == "strongman"]
    portals = (SHARED / "portals.mjs").read_text(encoding="utf-8")
    for x, z in re.findall(r"x: (-?[\d.]+), z: (-?[\d.]+)", portals):
        zones.append(Point(float(x), float(z)).buffer(8))
    return unary_union(zones)


def loop_in(rng, area, middle, reach, n, trees):
    """n spots within `reach` of `middle` inside `area`, clear of trees, whose loop stays inside."""
    for _ in range(400):
        pts = []
        while len(pts) < n:
            a = rng.uniform(0, math.tau)
            d = reach * math.sqrt(rng.uniform(0.05, 1))
            p = Point(middle.x + math.cos(a) * d, middle.y + math.sin(a) * d)
            if area.contains(p) and not trees.contains(p):
                pts.append(p)
        ring = LineString([(p.x, p.y) for p in pts + pts[:1]])
        if area.contains(ring) and not ring.intersects(trees):
            # In walking order round their middle, so the loop doesn't cross itself.
            cx = sum(p.x for p in pts) / n
            cz = sum(p.y for p in pts) / n
            pts.sort(key=lambda p: math.atan2(p.y - cz, p.x - cx))
            return pts
    return None


def main():
    rng = random.Random(1031)
    plot, _roads, to_model = model_frame()
    model = lambda g: affine_transform(g, to_model)
    ring = Point(CENTRE).buffer(AREA - 8, 64)
    street.CELL = 0.8  # coarse enough for whole plots
    street.grid(ring)
    ras = Raster(to_model)
    _hard, veg, _pool = classify(ras)
    house = json.loads(HOUSE.read_text(encoding="utf-8"))
    nb = json.loads((ROOT / "data" / "neighbours.json").read_text(encoding="utf-8"))
    buildings = unary_union([Polygon(b["p"]).buffer(0) for b in nb["buildings"]])
    prisms = house["surroundings"]["prisms"]
    covered = unary_union([Polygon(p["p"][0]).buffer(0) for p in prisms if p["m"] in
                           ("road", "track", "gravel", "pave_light", "pave_warm", "field_soil", "field_dark", "field_crop", "forest", "pool_water", "concrete")])
    water = unary_union([Polygon(d["rim"]).buffer(1.5) for d in house.get("dips", [])])
    out_zone = keep_out()
    tall = ras.height > 2.5
    # Trees and bushes: the laser scan's tall cells, as shapes to keep the animals out of.
    ys, xs = np.nonzero(tall[::2, ::2])
    trees = unary_union([Point(street.X0 + (x * 2 + 1) * street.CELL, street.Z0 + (y * 2 + 1) * street.CELL).buffer(2.2, 4) for y, x in zip(ys, xs)]) if len(xs) else Polygon()

    # Pastures.
    pastures = []
    for p in plots(model, ring):
        if p.intersection(buildings).area > 5:
            continue
        rest = p.intersection(ring).difference(out_zone).difference(covered.buffer(1.0)).difference(water).buffer(-3.0, join_style="mitre")
        for q in parts_of(rest, "Polygon"):
            if q.area < 700:
                continue
            inside = Raster.mask([q])
            if inside.sum() < 300:
                continue
            green = float(veg[inside].mean())
            treed = float(tall[inside].mean())
            c = q.centroid
            if any(x0 <= c.x <= x1 and z0 <= c.y <= z1 for x0, z0, x1, z1 in CEREALS):
                continue
            if green > 0.9 and treed < 0.08:
                pastures.append(q)
    pastures.sort(key=lambda q: -q.area)

    herds = []
    cows = sheep = 0
    for q in pastures:
        kind = "cow" if q.area >= 2500 else "sheep"
        if kind == "cow" and cows >= 40 or kind == "sheep" and (sheep >= 24 or q.area < 900):
            continue
        n = max(3, min(8, round(q.area / COW_AREA))) if kind == "cow" else max(3, min(6, round(q.area / 300)))
        open_q = q.difference(trees)
        middle = polylabel(open_q if open_q.geom_type == "Polygon" else max(open_q.geoms, key=lambda g: g.area), 0.5)
        reach = min(32.0, math.sqrt(q.area) * 0.45)
        animals = []
        for _ in range(n):
            pts = loop_in(rng, q, middle, reach, 4, trees)
            if not pts:
                continue
            spots = []
            for k, pt in enumerate(pts):
                lie = kind == "cow" and k == 2 and rng.random() < 0.55
                spots.append([r2(pt.x), r2(pt.y), "lie" if lie else "graze", round(rng.uniform(120, 260) if lie else rng.uniform(35, 90))])
            animals.append({"spots": spots, "shift": round(rng.uniform(0, 400)), "size": round(rng.uniform(0.92, 1.08), 2)})
        if len(animals) < 2:
            continue
        coat = rng.choice(["blue", "blue", "holstein", "holstein", "red"]) if kind == "cow" else rng.choice(["white", "suffolk"])
        herds.append({"kind": kind, "coat": coat, "speed": SPEED[kind], "animals": animals, "area": round(q.area)})
        if kind == "cow":
            cows += len(animals)
        else:
            sheep += len(animals)

    # Crows on bare fields: a spot well inside a few of them, not by the houses.
    crows = []
    bare = [Polygon(p["p"][0]).buffer(0) for p in prisms if p["m"] in ("field_soil", "field_dark")]
    bare = [f for f in bare if f.area > 3000 and f.centroid.within(ring) and not f.centroid.within(out_zone)]
    rng.shuffle(bare)
    for f in bare:
        if len(crows) >= 6:
            break
        c = polylabel(f.buffer(-8) if f.buffer(-8).geom_type == "Polygon" else f, 1.0)
        if any(math.dist((c.x, c.y), (o[0], o[1])) < 120 for o in crows):
            continue
        crows.append([r2(c.x), r2(c.y), rng.randint(6, 11)])

    # Ducks: open water far enough out, as a middle and a radius.
    ducks = []
    for d in house.get("dips", []):
        if not d.get("water"):
            continue
        t = d["water"] / d["depth"]
        wet = Polygon([(x + (bx - x) * t, z + (bz - z) * t) for (x, z), (bx, bz) in zip(d["rim"], d["bottom"])]).buffer(0)
        if wet.centroid.within(out_zone) or Point(CENTRE).distance(wet.centroid) > AREA - 10:
            continue
        mid = polylabel(wet, 0.1)
        room = wet.exterior.distance(mid)
        if room < 1.6:
            continue
        ducks.append([r2(mid.x), r2(mid.y), r2(room - 0.6), r2(house["ground"] + (d.get("low") or 0) - d["water"]), 2 if room < 3 else 4])

    # Bales: the rows the photo shows, and the two farmyards' (checked to stand clear of buildings).
    bales = []
    for x0, z0, x1, z1, n, wrap, style in BALES:
        clear = LineString([(x0, z0), (x1, z1)]).buffer(0.7)
        if clear.intersects(buildings):
            print("  bales: a row stands in a building at", (x0, z0))
            continue
        bales.append([x0, z0, x1, z1, n, wrap, style])

    out = {
        "_source": "GRB plots, the orthophoto and the laser scan (Digitaal Vlaanderen, open data) through tools/countryside.py; "
                   "herds, crows, ducks and bales are placed where the photo shows pasture, bare fields, open water and barns",
        "herds": herds, "crows": crows, "ducks": ducks, "bales": bales,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB): {len(pastures)} pastures, "
          f"{len(herds)} herds ({cows} cows, {sheep} sheep), {len(crows)} crow spots, {len(ducks)} duck ponds, {len(bales)} bale rows")
    for h in herds:
        print(f"  {h['kind']:5} {h['coat']:8} x{len(h['animals'])} in {h['area']} m2 at", h["animals"][0]["spots"][0][:2])
    debug(ras, pastures, out)


def debug(ras, pastures, out):
    """The photo with the pastures, the animals' loops, the crows, ducks and bales, 1.6 m a pixel."""
    img = Image.fromarray((ras.rgb[::2, ::2] * 0.8).astype(np.uint8))
    d = ImageDraw.Draw(img)
    px = lambda x, z: ((x - street.X0) / (street.CELL * 2), (z - street.Z0) / (street.CELL * 2))
    for q in pastures:
        d.polygon([px(x, z) for x, z in q.exterior.coords], outline=(255, 255, 0))
    for h in out["herds"]:
        col = (255, 60, 60) if h["kind"] == "cow" else (255, 255, 255)
        for a in h["animals"]:
            d.line([px(s[0], s[1]) for s in a["spots"] + a["spots"][:1]], fill=col, width=1)
    for x, z, _n in out["crows"]:
        cx, cz = px(x, z)
        d.ellipse([cx - 4, cz - 4, cx + 4, cz + 4], outline=(0, 0, 0), width=2)
    for x, z, r, _y, _n in out["ducks"]:
        cx, cz = px(x, z)
        d.ellipse([cx - 3, cz - 3, cx + 3, cz + 3], fill=(0, 200, 255))
    for x0, z0, x1, z1, _n, _c, _s in out["bales"]:
        d.line([px(x0, z0), px(x1, z1)], fill=(255, 0, 255), width=3)
    DEBUG.parent.mkdir(parents=True, exist_ok=True)
    img.save(DEBUG)


if __name__ == "__main__":
    main()
