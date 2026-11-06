"""The relief of the surroundings, from the laser scan's terrain (DHM Vlaanderen II, DTM 1 m).

A grid of heights in model coordinates, every STEP metres over the area of the surroundings
(tools/neighbours.py, `zone`: the ring round the plot, the village and the band between them)
and MARGIN metres beyond it, relative to our plot's ground (TAW 24.0 m), each the mean of the
terrain over its own square (field ridges and narrow ditches smoothed away). The grid's points
stay where they were when it was a square of 1120 m round the plot (ORIGIN). Our plot and the
old bungalow keep a flat area at the model's ground: the house, the garden, the bungalow and
everything placed there were built on flat ground (and within 45 m the real ground varies by
less than half a metre); the real relief blends in round them.

Between the grid points the ground is two flat triangles per square, split along the diagonal
from its lowest x and z corner: the browser draws it that way, and `height` (here, and the same
formula in web/shared/terrain.mjs for the browser and the server) gives exactly that surface.

The heights are whole centimetres, written as one string (`d`): each point is what is left over
after guessing it from its neighbours (the one before it plus the one above minus the one above
that one: a slope continues), one character for -32 to 31 cm and four for anything more. The
grid of about 147,000 points takes 150 KB instead of the 700 KB of a list of numbers, and
compresses to a third of that.

Writes web/shared/terrain.json; tools/build_house.py places the surroundings on it.
"""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image
from shapely.affinity import affine_transform

from neighbours import TILE_H, TILE_W, TILE_X0, TILE_Y1, model_frame, raster, zone

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "shared" / "terrain.json"
CX, CZ = 4.45, -3.0     # the plot's middle (model)
ORIGIN = (CX - 560, CZ - 560)  # a grid point (model): the grid's corner when it was a square round the plot
MARGIN = 20             # m of grid beyond the zone
STEP = 4.0              # m between grid points
# Flat areas: (x, z, flat out to, real from) in metres.
FLAT = [(4.45, -3.0, 45.0, 95.0), (83.5, 189.7, 35.0, 75.0)]
# The string encoding (web/shared/terrain.mjs reads it the same way).
DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
ESCAPE, BIAS = "~", 1 << 17


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def build():
    """The grid: heights in metres relative to the plot, flat areas applied."""
    plot, _, to_model = model_frame()
    a, b, d, e, xo, zo = to_model
    inv = np.linalg.inv(np.array([[a, b], [d, e]]))
    dtm = raster("DTM")
    zx0, zz0, zx1, zz1 = affine_transform(zone(plot), to_model).bounds
    x0 = ORIGIN[0] + math.floor((zx0 - MARGIN - ORIGIN[0]) / STEP) * STEP
    z0 = ORIGIN[1] + math.floor((zz0 - MARGIN - ORIGIN[1]) / STEP) * STEP
    nx = math.ceil((zx1 + MARGIN - x0) / STEP) + 1
    nz = math.ceil((zz1 + MARGIN - z0) / STEP) + 1
    xs = x0 + np.arange(nx) * STEP
    zs = z0 + np.arange(nz) * STEP
    # The mean over each point's own square: 16 samples, a metre apart.
    offs = np.arange(-1.5, 2.0, 1.0)
    acc = np.zeros((nz, nx), np.float64)
    for ox in offs:
        for oz in offs:
            X, Z = np.meshgrid(xs + ox, zs + oz)
            LX = inv[0, 0] * (X - xo) + inv[0, 1] * (Z - zo)
            LY = inv[1, 0] * (X - xo) + inv[1, 1] * (Z - zo)
            r = np.clip((TILE_Y1 - LY).astype(int), 0, TILE_H - 1)
            c = np.clip((LX - TILE_X0).astype(int), 0, TILE_W - 1)
            acc += dtm[r, c]
    h = acc / len(offs) ** 2
    X, Z = np.meshgrid(xs, zs)
    # Relative to the plot's own ground (the mean in the plot's middle).
    i0, j0 = int(round((CX - x0) / STEP)), int(round((CZ - z0) / STEP))
    h -= h[j0 - 2:j0 + 3, i0 - 2:i0 + 3].mean()
    w = np.ones_like(h)
    for fx, fz, r0, r1 in FLAT:
        w = np.minimum(w, smoothstep(r0, r1, np.hypot(X - fx, Z - fz)))
    return {"x0": round(x0, 3), "z0": round(z0, 3), "step": STEP, "nx": nx, "nz": nz, "grid": h * w}


def encode(cm):
    """Whole centimetres (nz rows of nx) as the string `d`."""
    nz, nx = cm.shape
    pred = np.zeros_like(cm)
    pred[1:, 1:] = cm[1:, :-1] + cm[:-1, 1:] - cm[:-1, :-1]
    pred[0, 1:] = cm[0, :-1]
    pred[1:, 0] = cm[:-1, 0]
    out = []
    for r in (cm - pred).flatten().tolist():
        if -32 <= r < 32:
            out.append(DIGITS[r + 32])
        else:
            v = r + BIAS
            out.append(ESCAPE + DIGITS[v >> 12] + DIGITS[(v >> 6) & 63] + DIGITS[v & 63])
    return "".join(out)


def decode(d, nx, nz):
    """The string `d` back to whole centimetres (nz rows of nx). Guessing each point from the one
    before it, the one above and the one above that one, and adding what is left over, is the
    same as summing what is left over along the rows and then down the columns."""
    value = {c: k for k, c in enumerate(DIGITS)}
    rest, k = [], 0
    while k < len(d):
        if d[k] == ESCAPE:
            rest.append((value[d[k + 1]] << 12 | value[d[k + 2]] << 6 | value[d[k + 3]]) - BIAS)
            k += 4
        else:
            rest.append(value[d[k]] - 32)
            k += 1
    return np.array(rest, np.int64).reshape(nz, nx).cumsum(1).cumsum(0)


class Terrain:
    """Heights on the model's ground, as the browser draws it (see the module's notes)."""

    def __init__(self, data):
        self.x0, self.z0, self.step, self.nx, self.nz = data["x0"], data["z0"], data["step"], data["nx"], data["nz"]
        g = data["grid"]
        self.g = np.asarray(g, np.float64).reshape(self.nz, self.nx) if not isinstance(g, np.ndarray) else g

    def height(self, x, z):
        """Metres above (or below) the model's flat ground at (x, z)."""
        fx = min(max((x - self.x0) / self.step, 0.0), self.nx - 1.000001)
        fz = min(max((z - self.z0) / self.step, 0.0), self.nz - 1.000001)
        i, j = int(fx), int(fz)
        u, v = fx - i, fz - j
        g = self.g
        h00, h10, h01, h11 = g[j, i], g[j, i + 1], g[j + 1, i], g[j + 1, i + 1]
        if u >= v:
            return float(h00 + u * (h10 - h00) + v * (h11 - h10))
        return float(h00 + v * (h01 - h00) + u * (h11 - h01))

    def flat(self, geom):
        """Whether the ground under a shape is the flat ground everywhere (no relief to follow)."""
        x0, z0, x1, z1 = geom.bounds
        i0, i1 = int((x0 - self.x0) // self.step), int((x1 - self.x0) // self.step) + 1
        j0, j1 = int((z0 - self.z0) // self.step), int((z1 - self.z0) // self.step) + 1
        i0, j0 = max(i0, 0), max(j0, 0)
        i1, j1 = min(i1, self.nx - 1), min(j1, self.nz - 1)
        return not np.any(self.g[j0:j1 + 1, i0:i1 + 1])


def load():
    """The grid as written (whole centimetres, as the browser and the server read it)."""
    d = json.loads(OUT.read_text(encoding="utf-8"))
    return Terrain({**d, "grid": decode(d["d"], d["nx"], d["nz"]) / 100})


def main():
    t = build()
    grid = np.round(t["grid"] * 100).astype(np.int64)
    d = encode(grid)
    assert np.array_equal(decode(d, t["nx"], t["nz"]), grid)
    OUT.write_text(json.dumps({"_source": "DHM Vlaanderen II, DTM 1 m (Digitaal Vlaanderen, open data): heights in cm relative to the plot's ground, "
                                          "flat round the plot and the bungalow, encoded as described in tools/terrain.py",
                               "x0": t["x0"], "z0": t["z0"], "step": t["step"], "nx": t["nx"], "nz": t["nz"], "d": d}, separators=(",", ":")),
                   encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB): {t['nx']} x {t['nz']} points from ({t['x0']}, {t['z0']}), "
          f"{grid.min() / 100:+.1f} to {grid.max() / 100:+.1f} m, {d.count(ESCAPE)} large steps")


if __name__ == "__main__":
    main()
