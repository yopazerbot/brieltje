"""Textures for the houses round the two portals at home (tools/homestreet/houses.py), all generated here:
no downloads, nothing to credit.

- hs_brick_red: red-orange multi-tone facing brick (as on the older bungalows along Briel), light grey joints;
- hs_brick_buff: wire-cut brick in light warm greys with darker headers here and there, neutral enough that
  the game tints it per house (the brown-grey new-build across the lane, the pale grey new-builds by the
  junction, dark plinths);
- hs_brick_normal: the shared relief of both (the same running bond, joints recessed 8 mm);
- hs_tiles_color / hs_tiles_normal: interlocking clay tiles with a shallow roll, light grey to be tinted
  anthracite, red-orange or brown, each tile a little different (real roofs are patchy);
- hs_wood_color / hs_wood_normal: vertical boards, weathered to silver-grey, for gables clad in timber.

Bricks are 21 x 6.5 cm with 1.1 cm joints in running bond; one texture tile is 5 bricks across and 14 courses
up (1.105 x 1.064 m). Tiles are 30 cm across and 30 cm a row, the texture 4 x 4 of them (1.2 m). Boards are
14 cm wide, the texture 8 of them (1.12 m) by 1.12 m. The houses' UVs are in metres divided by these sizes
(houses.py, TEXTURE_SIZE).

Writes web/public/textures/hs_*.webp, and half-size copies in web/public/textures/half/ for phones.
Run from the project root:  tools/.venv/Scripts/python.exe tools/homestreet/textures.py
"""
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web/public/textures"
N = 1024


def noise(shape, cells, rng):
    """Smooth value noise: random values on a coarse grid, interpolated (bicubic), tiling."""
    h, w = shape
    cy, cx = max(1, int(round(cells * h / w))), cells
    g = rng.random((cy, cx)).astype(np.float32)
    g = np.pad(g, ((0, 1), (0, 1)), mode="wrap")
    yy = np.linspace(0, cy, h, endpoint=False)
    xx = np.linspace(0, cx, w, endpoint=False)
    y0, x0 = yy.astype(int), xx.astype(int)
    fy, fx = (yy - y0)[:, None], (xx - x0)[None, :]
    fy, fx = fy * fy * (3 - 2 * fy), fx * fx * (3 - 2 * fx)
    a = g[y0][:, x0]
    b = g[y0][:, x0 + 1]
    c = g[y0 + 1][:, x0]
    d = g[y0 + 1][:, x0 + 1]
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy


def fbm(shape, rng, base=8, octaves=4):
    out = np.zeros(shape, np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        out += amp * noise(shape, base * 2 ** o, rng)
        tot += amp
        amp *= 0.5
    return out / tot


def normal_map(height, strength):
    """A tangent-space normal map (OpenGL convention, +y up the texture) from a tiling height field."""
    gx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * 0.5
    gy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * 0.5
    n = np.stack([-gx * strength, gy * strength, np.ones_like(gx)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8))


def save(img, name, quality=84):
    WEB.mkdir(parents=True, exist_ok=True)
    (WEB / "half").mkdir(exist_ok=True)
    img.save(WEB / f"{name}.webp", "WEBP", quality=quality, method=6)
    img.resize((img.width // 2, img.height // 2), Image.LANCZOS).save(WEB / "half" / f"{name}.webp", "WEBP", quality=quality, method=6)
    print("wrote", name, (WEB / f"{name}.webp").stat().st_size, "bytes")


def srgb(hexes):
    return np.array([[int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)] for h in hexes], np.float32)


# ------------------------------------------------------------------------------------------------ brick
def bricks(seed=11):
    """The running bond: per pixel which brick (id), whether it is joint, and the brick's relief."""
    rng = np.random.default_rng(seed)
    cols, rows = 5, 14
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    ch, bw = N / rows, N / cols
    joint_y, joint_x = ch * 0.011 / 0.076, bw * 0.011 / 0.221
    course = np.floor(yy / ch).astype(int)
    shift = (course % 2) * (bw / 2)
    u = (xx + shift) % N
    col = np.floor(u / bw).astype(int) % cols
    lx, ly = u % bw, yy % ch
    # Each brick a little irregular: its joint edges wander by a pixel or two.
    wob = (fbm((N, N), rng, 32, 2) - 0.5) * 2.2
    inx = np.minimum(lx - joint_x / 2, bw - joint_x / 2 - lx) + wob
    iny = np.minimum(ly - joint_y / 2, ch - joint_y / 2 - ly) + wob * 0.6
    edge = np.minimum(inx, iny)  # px inside the brick (negative: joint)
    ident = course * cols + col
    # Small chips on the arrises: where a fine noise is high near an edge, the brick dips.
    chips = (fbm((N, N), rng, 96, 2) > 0.66) & (edge < 3.5)
    relief = np.clip(edge / 3.0, 0, 1) ** 0.6
    relief = np.where(chips, relief * 0.45, relief)
    face = fbm((N, N), rng, 48, 3)
    height = 0.25 + 0.75 * relief + 0.06 * face * (edge > 0)
    return ident, edge, height, rng


def brick_textures():
    ident, edge, height, rng = bricks()
    ids = ident.max() + 1
    mortar_noise = fbm((N, N), rng, 40, 3)
    streak = fbm((N, 32), rng, 6, 2).repeat(N // 32, 1)  # wire-cut drag marks run along the bricks
    streak = noise((N, N), 180, rng) * 0.5 + 0.5 * np.roll(streak, 3, 0)
    fine = fbm((N, N), rng, 160, 2)

    def colour(palette, weights, mortar, spread):
        pal = srgb(palette)
        pick = rng.choice(len(pal), ids, p=np.array(weights) / sum(weights))
        tone = 1 + (rng.random(ids) - 0.5) * spread
        base = pal[pick][ident] * tone[ident][..., None]
        # A brick is lighter at its middle and burnt a little darker at one end.
        grad = 1 + (rng.random(ids)[ident] - 0.5) * 0.12 * np.clip(edge / 30, 0, 1)
        base *= (grad * (0.86 + 0.22 * fine) * (0.93 + 0.1 * streak))[..., None]
        m = srgb([mortar])[0] * (0.88 + 0.16 * mortar_noise)[..., None]
        k = np.clip((edge + 0.8) / 1.6, 0, 1)[..., None]  # soft edge between brick and joint
        out = m * (1 - k) + base * k
        return Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))

    # Red-orange multi-tone (older bungalows): mostly orange-red, some deep red and a few purple-brown.
    save(colour(["#b45434", "#c1653d", "#a2462e", "#9a3b2b", "#c87048", "#7e3328", "#ad5a3f"], [5, 4, 4, 3, 2, 1, 2], "#c3bdb2", 0.16), "hs_brick_red_color")
    # Light warm greys for tinting (wire-cut new-builds): a few darker bricks give the blend.
    save(colour(["#d8d0c6", "#cdc4b9", "#e1dad2", "#bdb3a8", "#a99f95", "#d2cbc4"], [5, 5, 3, 3, 1, 3], "#d9d6d0", 0.12), "hs_brick_buff_color")
    save(normal_map(height, 3.2), "hs_brick_normal", 88)


# ------------------------------------------------------------------------------------------------ roof tiles
def tile_textures(seed=23):
    rng = np.random.default_rng(seed)
    across, rows = 4, 4
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    tw, rh = N / across, N / rows
    row = np.floor(yy / rh).astype(int)
    shift = (row % 2) * 0.0  # interlocking tiles line up in columns
    u = ((xx + shift) % tw) / tw  # 0..1 across a tile
    v = (yy % rh) / rh  # 0 at the top of a row (up the slope), 1 at its lower edge
    col = np.floor(((xx + shift) % N) / tw).astype(int)
    ident = row * across + col
    # The profile across a tile: a wide flat pan and a rounded roll near its right edge.
    roll = np.exp(-((u - 0.78) / 0.11) ** 2)
    pan = 0.15 * np.cos((u - 0.3) * np.pi * 1.6) ** 2 * (u < 0.62)
    prof = 0.55 * roll + pan
    # Down the row each tile rises to its lower edge, where it overlaps the next row with a thick nose.
    rise = 0.35 * v + 0.25 * np.clip((v - 0.86) / 0.1, 0, 1)
    nose = np.clip((v - 0.965) / 0.035, 0, 1)
    height = prof + rise - 0.9 * nose
    # The side lock: a thin groove where one tile laps over its neighbour.
    lock = np.exp(-((u - 0.985) / 0.012) ** 2) + np.exp(-((u - 0.015) / 0.012) ** 2)
    height -= 0.18 * lock
    height += 0.025 * fbm((N, N), rng, 64, 3)
    ids = ident.max() + 1
    tone = (1 + (rng.random(ids) - 0.5) * 0.3)[ident]
    hue = (rng.random(ids) - 0.5)[ident]
    base = np.stack([0.80 + 0.02 * hue, np.full_like(hue, 0.79), 0.78 - 0.02 * hue], -1) * tone[..., None]
    shade = 0.82 + 0.25 * (prof / 0.6) - 0.10 * (1 - v)  # rolls catch the light, the top of a row is half hidden
    shadow = 1 - 0.55 * np.clip((v - 0.0) / 0.06, 0, 1) * 0 - 0.5 * np.exp(-(v / 0.05) ** 2)  # under the row above
    weather = 0.9 + 0.1 * fbm((N, N), rng, 12, 3)
    lichen = (fbm((N, N), rng, 120, 3) > 0.74) * 0.04
    out = base * (shade * shadow * weather)[..., None]
    out[..., 0] += lichen * 0.6
    out[..., 1] += lichen * 0.65
    out[..., 2] += lichen * 0.3
    save(Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8)), "hs_tiles_color")
    save(normal_map(height * 40, 1.0), "hs_tiles_normal", 88)


# ------------------------------------------------------------------------------------------------ boards
def wood_textures(seed=31):
    rng = np.random.default_rng(seed)
    boards = 8
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    bw = N / boards
    b = np.floor(xx / bw).astype(int)
    lx = xx % bw
    # Grain: noise stretched along the boards, different per board.
    grain = np.zeros((N, N), np.float32)
    for k in range(boards):
        g = fbm((N // 16, int(bw)), rng, 3, 4).repeat(16, 0)
        g = np.roll(g, rng.integers(0, N), 0)
        fine = noise((N, int(bw)), 40, rng)
        grain[:, int(k * bw):int(k * bw) + int(bw)] = 0.6 * g[:, :int(bw)] + 0.4 * fine[:, :int(bw)]
    lines = np.sin((xx * 0.9 + grain * 40) * 0.6) * 0.5 + 0.5
    tone = (1 + (rng.random(boards) - 0.5) * 0.18)[b]
    joint = np.clip(1 - np.minimum(lx, bw - lx) / 3.0, 0, 1)
    base = np.stack([0.80, 0.78, 0.75], -1) * (tone * (0.86 + 0.12 * grain + 0.05 * lines) * (1 - 0.55 * joint))[..., None]
    # Weathering: streaks run down from the top where rain washes the boards.
    streak = fbm((32, N), rng, 30, 3).repeat(N // 32, 0)
    base *= (0.93 + 0.1 * streak)[..., None]
    save(Image.fromarray((np.clip(base, 0, 1) * 255).astype(np.uint8)), "hs_wood_color")
    height = 0.6 + 0.3 * grain - 0.8 * joint
    save(normal_map(height * 6, 1.0).resize((N // 2, N // 2), Image.LANCZOS), "hs_wood_normal", 86)  # only on a few gables: half size is plenty


if __name__ == "__main__":
    brick_textures()
    tile_textures()
    wood_textures()
