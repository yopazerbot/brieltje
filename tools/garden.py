"""The garden (data/garden.json
sets): paving and paths, stepping slabs in the lawn, planted borders, and the wadi, a shallow grassy basin in the front garden that rain soaks into.

The model keeps its flat ground (the plans' levels vary by a few centimetres); the wadi is the one
dip in it: 0.30 m deep with 1:1 sides, drawn and walked on in the game (house.json "dips").
"""
import json
import random
from pathlib import Path

from shapely.geometry import LinearRing, Point, Polygon
from shapely.geometry.polygon import orient

GARDEN = Path(__file__).resolve().parent.parent / "data/garden.json"
PAVING_TOP = -0.05   # the same as the terraces
SLAB_TOP = -0.07     # stepping slabs: just proud of the lawn
RIM_POINTS = 72      # the wadi's rim and bottom, resampled to the same count (its sides join them)


def octagon(x, z, r):
    return Point(x, z).buffer(r, quad_segs=2)


def resample(ring, n, start=None):
    """n points evenly along a closed outline (counter-clockwise), from the point nearest `start`."""
    line = LinearRing(orient(Polygon(ring)).exterior.coords)
    s0 = line.project(Point(start)) if start else 0.0
    return [[round(c, 3) for c in line.interpolate((s0 + line.length * k / n) % line.length).coords[0]] for k in range(n)]


def build(b, ground):
    """Adds the garden to the builder; returns the dips in the ground (the wadi)."""
    g = json.loads(GARDEN.read_text(encoding="utf-8"))
    for p in g["paths"]:
        poly = Polygon(p["poly"]).buffer(0)
        slab = p.get("material") == "stepping"
        top = SLAB_TOP if slab else (p["y"] if p.get("y") is not None else PAVING_TOP)
        # The terraces in grey stone tiles, the drive and paths in light concrete.
        b.add("terrace" if p.get("material") == "terrace" else "paving", ground - 0.05, top, poly, p["name"])

    # Planted borders: bark mulch with shrubs about a metre apart (the plans give no species).
    for k, bed in enumerate(g["beds"]):
        poly = Polygon(bed["poly"]).buffer(0)
        b.add("bed", ground - 0.05, ground + 0.04, poly, "planting")
        rng = random.Random(k + 1)
        x0, z0, x1, z1 = poly.bounds
        core = poly.buffer(-0.3)
        z = z0 + 0.45
        while z < z1:
            x = x0 + 0.45 + rng.uniform(0, 0.3)
            while x < x1:
                at = Point(x + rng.uniform(-0.2, 0.2), z + rng.uniform(-0.2, 0.2))
                if core.contains(at):
                    b.add("hedge", ground + 0.04, ground + rng.uniform(0.45, 0.9), octagon(at.x, at.y, rng.uniform(0.28, 0.45)))
                x += rng.uniform(0.85, 1.15)
            z += rng.uniform(0.85, 1.05)

    w = g["wadi"]
    rim = resample(w["outline"], RIM_POINTS)
    return [{"name": "wadi", "rim": rim, "bottom": resample(w["bottom"], RIM_POINTS, rim[0]), "depth": w["depth"]}]
