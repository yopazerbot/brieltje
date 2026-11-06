"""Roof shapes of the neighbouring houses from the laser scan (tools/neighbours.py).

A footprint is split into rectangles (an L-shaped house into two). Over each rectangle the
heights of the laser scan (surface minus terrain, 1 m cells) are compared with five roof
shapes, each a simple formula fitted by least squares:

- flat:    one height
- gable:   ridge along the long side, h = ridge - k * (distance from the ridge line)
- gable_x: ridge across (along the short side)
- hip:     ridge along the long side, the ends slope as steeply as the sides (45 degrees in plan)
- shed:    one slope across or along the rectangle

The best fit wins, but a more complicated shape has to fit clearly better than a simpler one
(flat, then gable). Cells far off the fitted roof (a tree over the roof, a chimney, a dormer)
are dropped and the fit is done once more.

Where to split a footprint follows the heights too (`decompose`): an L-shaped house is cut at
an inside corner, along one of its walls, wherever the two pieces fit their own roofs clearly
better than one roof over the whole (a gabled house with a flat-roofed annex, for example).
"""
import math

import numpy as np
from shapely.affinity import rotate as rot
from shapely.geometry import Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import unary_union


def roof_parts(poly):
    """Split a (roughly right-angled) footprint into rectangles, one roof each."""
    rect = poly.minimum_rotated_rectangle
    if poly.area / rect.area > 0.88:
        return [rect]
    c = list(rect.exterior.coords)
    ang = math.atan2(c[1][1] - c[0][1], c[1][0] - c[0][0])
    flat = rot(poly.simplify(0.3), -ang, origin=c[0], use_radians=True)
    xs = sorted({round(x, 1) for x, _ in flat.exterior.coords})
    parts = []
    for x0, x1 in zip(xs, xs[1:]):
        if x1 - x0 < 1.0:
            continue
        piece = flat.intersection(box(x0, -1e3, x1, 1e3))
        for g in getattr(piece, "geoms", [piece]):
            if g.area > 4:
                parts.append(g.minimum_rotated_rectangle)
    # Join neighbouring slices of the same depth back into one rectangle.
    merged = []
    for r in sorted(parts, key=lambda r: r.bounds[0]):
        if merged and abs(merged[-1].bounds[1] - r.bounds[1]) < 0.3 and abs(merged[-1].bounds[3] - r.bounds[3]) < 0.3:
            merged[-1] = unary_union([merged[-1], r]).minimum_rotated_rectangle
        else:
            merged.append(r)
    return [rot(r, ang, origin=c[0], use_radians=True) for r in merged] or [rect]


def frame(rect):
    """Centre, unit vectors along the long (u) and short (v) side, and their half-lengths."""
    pts = np.array(rect.exterior.coords[:4], float)
    e1, e2 = pts[1] - pts[0], pts[3] - pts[0]
    if np.linalg.norm(e1) < np.linalg.norm(e2):
        e1, e2 = e2, e1
    c = pts.mean(axis=0)
    return c, e1 / np.linalg.norm(e1), e2 / np.linalg.norm(e2), np.linalg.norm(e1) / 2, np.linalg.norm(e2) / 2


def fit(rect, xy, h):
    """The roof over rectangle `rect` that fits heights h at points xy best (Lambert metres).
    Returns {shape, eaves, ridge, ridge_dir (unit vector of the ridge or of the low eave for a
    shed), high (shed: unit vector towards the high side)}, or None with too few points."""
    if len(h) < 2:
        return None
    c, u, v, A, B = frame(rect)
    if len(h) < 6:  # a small shed: too few cells for a shape, a flat roof at its height
        top = float(np.percentile(h, 85))
        return {"shape": "flat", "eaves": top, "ridge": top, "ridge_dir": u, "high": v, "rmse": float(np.std(h)), "n": len(h)}
    d = xy - c
    s, t = d @ u, d @ v

    def solve(f, mask):
        X = np.stack([np.ones(mask.sum()), f[mask]], 1)
        coef, *_ = np.linalg.lstsq(X, h[mask], rcond=None)
        res = h - (coef[0] + coef[1] * f)
        return coef, res

    models = {
        "gable": np.abs(t),
        "gable_x": np.abs(s),
        "hip": np.maximum(np.abs(t), np.abs(s) - (A - B)),
        "shed_t": t,
        "shed_s": s,
    }
    best = {}
    for name, f in models.items():
        mask = np.ones(len(h), bool)
        coef, res = solve(f, mask)
        mask = np.abs(res) < max(1.2, 2.5 * np.std(res))  # trees, chimneys, dormers out
        if mask.sum() >= 6:
            coef, res = solve(f, mask)
        best[name] = (float(np.sqrt(np.mean(res[mask] ** 2))), coef, mask)
    flat_h = h[np.abs(h - np.median(h)) < 1.5]  # for the height of a flat roof: without trees over it
    flat_rmse = float(np.std(h))

    def pitched_ok(name):
        coef = best[name][1]
        slope = -coef[1] if name in ("gable", "gable_x", "hip") else abs(coef[1])
        return slope > 0.25  # at least about 14 degrees

    # Simpler shapes first: a pitched roof has to beat flat clearly, hip and shed have to beat a gable.
    choice = "flat"
    gables = [n for n in ("gable", "gable_x") if pitched_ok(n)]
    if gables:
        g = min(gables, key=lambda n: best[n][0])
        if best[g][0] < flat_rmse * 0.7 and flat_rmse > 0.35:
            choice = g
            for other in ("hip", "shed_t", "shed_s"):
                if pitched_ok(other) and best[other][0] < best[choice][0] * 0.85:
                    choice = other
    elif any(pitched_ok(n) for n in ("shed_t", "shed_s")):
        sh = min(("shed_t", "shed_s"), key=lambda n: best[n][0])
        if pitched_ok(sh) and best[sh][0] < flat_rmse * 0.6 and flat_rmse > 0.35:
            choice = sh

    if choice == "flat":
        top = float(np.percentile(flat_h, 85)) if len(flat_h) else float(np.median(h))
        return {"shape": "flat", "eaves": top, "ridge": top, "ridge_dir": u, "high": v, "rmse": flat_rmse, "n": len(h)}
    coef = best[choice][1]
    err = {"rmse": best[choice][0], "n": len(h)}
    if choice in ("gable", "hip"):
        ridge, k = coef[0], -coef[1]
        return {"shape": choice, "eaves": ridge - k * B, "ridge": ridge, "ridge_dir": u, "high": v, **err}
    if choice == "gable_x":
        ridge, k = coef[0], -coef[1]
        return {"shape": "gable", "eaves": ridge - k * A, "ridge": ridge, "ridge_dir": v, "high": u, **err}
    across, half, along = (v, B, u) if choice == "shed_t" else (u, A, v)
    a, b = coef
    return {"shape": "shed", "eaves": a - abs(b) * half, "ridge": a + abs(b) * half, "ridge_dir": along,
            "high": across if b > 0 else -across, **err}


def _axes(poly):
    """The footprint's wall direction (angle) and a corner to turn about."""
    rect = poly.minimum_rotated_rectangle
    c = list(rect.exterior.coords)
    return math.atan2(c[1][1] - c[0][1], c[1][0] - c[0][0]), c[0]


def _box(piece, ang, origin):
    """The rectangle around a piece, lined up with the house's walls."""
    flat = rot(piece, -ang, origin=origin, use_radians=True)
    return rot(box(*flat.bounds), ang, origin=origin, use_radians=True)


def _cuts(poly, ang, origin):
    """Ways to cut a footprint in two, parallel to its walls: through each inside corner, and
    every metre across (a wing or an annex can sit inside a rectangular outline)."""
    flat = orient(rot(poly.simplify(0.3), -ang, origin=origin, use_radians=True), 1.0)
    pts = list(flat.exterior.coords)[:-1]
    n = len(pts)
    big = 1e7  # metres: past any Lambert 72 coordinate
    lines = set()
    for i in range(n):
        (ax, ay), (bx, by), (cx, cy) = pts[i - 1], pts[i], pts[(i + 1) % n]
        if (bx - ax) * (cy - by) - (by - ay) * (cx - bx) < -1e-6:  # an inside corner
            lines |= {("x", round(bx, 2)), ("y", round(by, 2))}
    x0, y0, x1, y1 = flat.bounds
    lines |= {("x", round(x, 2)) for x in np.arange(x0 + 2.5, x1 - 2.4, 1.0)}
    lines |= {("y", round(y, 2)) for y in np.arange(y0 + 2.5, y1 - 2.4, 1.0)}
    out = []
    for axis, at in sorted(lines):
        half = box(-big, -big, at, big) if axis == "x" else box(-big, -big, big, at)
        a, b = flat.intersection(half), flat.difference(half)
        if a.geom_type == b.geom_type == "Polygon" and a.area > 6 and b.area > 6:  # two whole pieces
            out.append([rot(g, ang, origin=origin, use_radians=True) for g in (a, b)])
    return out


def _cost(fits):
    n = sum(f["n"] for f in fits)
    return math.sqrt(sum(f["rmse"] ** 2 * f["n"] for f in fits) / n) if n else 9.0


def decompose(poly, sample, depth=3):
    """Roof parts for a footprint: [(rectangle, fit)], cut at inside corners where that fits the
    heights clearly better. `sample(piece)` gives the laser points (xy, h) inside a piece."""
    ang, origin = _axes(poly)
    rect = _box(poly, ang, origin)
    xy, h = sample(poly)
    whole = fit(rect, xy, h)
    if whole is None:
        return []
    if depth == 0 or whole["rmse"] < 0.35:  # nothing left to explain
        return [(rect, whole)]
    best, best_cost = None, whole["rmse"] * 0.75
    for pieces in _cuts(poly, ang, origin):
        fits = []
        for piece in pieces:
            pxy, ph = sample(piece)
            f = fit(_box(piece, ang, origin), pxy, ph)
            if f is None:
                break
            fits.append(f)
        else:
            c = _cost(fits)
            if c < best_cost:
                best, best_cost = pieces, c
    if best is None:
        return [(rect, whole)]
    return [part for piece in best for part in (decompose(piece, sample, depth - 1) or [(_box(piece, ang, origin), None)]) if part[1]]


def corners(rect, ridge_dir, high):
    """The rectangle's corners, ordered so p0-p1 runs along `ridge_dir` and p0-p3 towards `high`."""
    c, u, v, A, B = frame(rect)
    half_r = A if abs(ridge_dir @ u) > 0.5 else B
    half_q = B if abs(ridge_dir @ u) > 0.5 else A
    r, q = ridge_dir, high
    return [c - r * half_r - q * half_q, c + r * half_r - q * half_q, c + r * half_r + q * half_q, c - r * half_r + q * half_q]
