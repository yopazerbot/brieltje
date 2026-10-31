"""Download the CC0 textures and sky, generate the facade brick, and write
web-sized versions for the walkthrough.

- Poly Haven textures (CC0) go to source/textures/<id>/ at 2k (not in git)
- The facade brick is generated to match the real brick: "gevelsteen lichtbeige
  genuanceerd" (light beige, blended) per the plan legend, long format of about
  29 x 5 cm with thin recessed joints (size from the site photo of 2026-08-25)
- The neighbours' brick (standard 21 x 5 cm format) and roof tiles are generated
  too, in neutral light tones: the game tints them per house
- The floor tiles (grey stone-look, 60 x 120 cm) and the
  wood cladding (vertical slats) are generated too
- Web copies (WebP) go to web/public/textures/, the sky to web/public/env/, and
  half-size copies for phones and tablets to web/public/textures/half/

Run from the project root:
    tools/.venv/Scripts/python.exe tools/textures.py
Only the generated textures and the colour corrections (no downloads):
    tools/.venv/Scripts/python.exe tools/textures.py --generated
Only the half-size copies:
    tools/.venv/Scripts/python.exe tools/textures.py --halves
One generated surface (and the half-size copies):
    tools/.venv/Scripts/python.exe tools/textures.py --only floor_tile
"""
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "source/textures"
WEB = ROOT / "web/public/textures"
ENV = ROOT / "web/public/env"
HDRI = "kloofendal_48d_partly_cloudy_puresky"

# Colour corrections so the textures match the house: (saturation, brightness). The target
# walls are white paint (about 80 % reflectance), the paving light concrete, the wood floors greige.
GRADE = {"terrace": (0.35, 1.6), "plaster": (0.0, 1.75), "stair": (0.75, 1.3), "floor_wood": (0.55, 1.1),
         "road": (0.3, 1.25), "pavers": (0.25, 1.35), "gravel": (0.6, 1.2), "field": (0.8, 1.1)}

# material name in the app -> (Poly Haven id, web size in pixels)
TEXTURES = {
    "plaster": ("plastered_wall_04", 1024),
    "floor_wood": ("laminate_floor_02", 1024),
    "floor_bath": ("long_white_tiles", 1024),
    "terrace": ("concrete_pavement", 1024),
    "road": ("concrete_floor_02", 1024),  # Briel is a pale concrete road (orthophoto)
    "pavers": ("patterned_concrete_pavers", 1024),  # the forecourts and drives
    "gravel": ("gravel_floor", 512),  # gravel yards, field tracks, footpaths
    "field": ("dry_mud_field_001", 1024),  # ploughed fields, crops, the floor of the woods
    "grass": ("leafy_grass", 1024),
    "concrete": ("concrete_wall_008", 1024),
    "stair": ("oak_veneer_01", 1024),
    "hedge": ("forest_leaves_02", 512),
}
MAPS = {"color": ["Diffuse"], "normal": ["nor_gl"], "rough": ["Rough", "arm"]}


def fetch(url, dest):
    if dest.exists():  # already downloaded
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "briel-walkthrough/0.1"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        f.write(r.read())
    return dest


def api(path):
    req = urllib.request.Request(f"https://api.polyhaven.com/{path}", headers={"User-Agent": "briel-walkthrough/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def save_webp(img, path, size, quality=86):
    path.parent.mkdir(parents=True, exist_ok=True)
    if img.size != (size, size):
        img = img.resize((size, size), Image.LANCZOS)
    img.save(path, "WEBP", quality=quality, method=6)


def poly_haven(meta):
    """Download 2k maps for each texture and write web versions. Returns real-world sizes in metres."""
    sizes = {}
    for name, (asset, size) in TEXTURES.items():
        files = api(f"files/{asset}")
        for kind, keys in MAPS.items():
            key = next(k for k in keys if k in files)
            url = files[key]["2k"]["jpg"]["url"]
            src = fetch(url, SRC / asset / Path(url).name)
            img = Image.open(src)
            if key == "arm":  # packed AO/roughness/metal: roughness is green
                img = img.split()[1]
            img = img.convert("L" if kind == "rough" else "RGB")
            if kind == "color" and name in GRADE:
                sat, bright = GRADE[name]
                img = ImageEnhance.Brightness(ImageEnhance.Color(img).enhance(sat)).enhance(bright)
            save_webp(img, WEB / f"{name}_{kind}.webp", size)
        dims = meta[asset].get("dimensions") or [2000, 2000]
        sizes[name] = round(dims[0] / 1000, 3)
        print(f"{name:11s} <- {asset} ({sizes[name]} m)")
    return sizes


def value_noise(shape, cell, rng):
    """Smooth random noise, tileable, values 0..1."""
    h, w = shape
    gh, gw = max(1, h // cell), max(1, w // cell)
    grid = rng.random((gh, gw))
    ys = np.arange(h) / cell
    xs = np.arange(w) / cell
    y0 = np.floor(ys).astype(int) % gh
    x0 = np.floor(xs).astype(int) % gw
    ty = (ys - np.floor(ys))[:, None]
    tx = (xs - np.floor(xs))[None, :]
    ty, tx = ty * ty * (3 - 2 * ty), tx * tx * (3 - 2 * tx)
    a = grid[y0][:, x0]
    b = grid[y0][:, (x0 + 1) % gw]
    c = grid[(y0 + 1) % gh][:, x0]
    d = grid[(y0 + 1) % gh][:, (x0 + 1) % gw]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


def brick(size=2048, seed=7):
    """Light grey long brick in running bond. Tile = 1.80 m x 1.80 m:
    6 bricks of 29 cm + 1 cm joint across, 30 courses of 5 cm + 1 cm joint up."""
    rng = np.random.default_rng(seed)
    px = size / 1.80  # pixels per metre
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    course_h, brick_w, joint = 0.06 * px, 0.30 * px, 0.01 * px
    course = np.floor(yy / course_h).astype(int)
    shift = rng.random(31)[course] * brick_w  # wild bond: every course starts elsewhere
    col = np.floor(((xx + shift) % size) / brick_w).astype(int)
    in_y = (yy % course_h) < (course_h - joint)
    in_x = ((xx + shift) % brick_w) < (brick_w - joint)
    is_brick = in_y & in_x

    # Per-brick colour: light beige, blended ("genuanceerd"): most bricks pale sand
    # to cream (paler and less yellow), some warmer, some paler,
    # a few with a greyish cast.
    ids = course * 64 + col
    uniq = rng.random(30 * 64 + 64)
    tone = uniq[ids]
    base = np.stack([0.83 + 0.07 * tone, 0.79 + 0.07 * tone, 0.72 + 0.07 * tone], -1)
    pick = rng.random(uniq.shape)[ids][..., None]
    base = np.where(pick < 0.15, base * np.array([1.0, 0.95, 0.88]), base)          # warmer sand
    base = np.where((pick >= 0.15) & (pick < 0.30), base * np.array([1.04, 1.04, 1.07]), base)  # pale cream
    base = np.where((pick >= 0.30) & (pick < 0.38), base * np.array([0.95, 0.95, 0.97]), base)  # greyish beige

    # Hand-made surface: mottling plus dark specks, as on the photos.
    mottle = 0.6 * value_noise((size, size), 24, rng) + 0.4 * value_noise((size, size), 6, rng)
    specks = (value_noise((size, size), 3, rng) > 0.88).astype(np.float32) * 0.25
    shade = 1 - 0.12 * mottle[..., None] - specks[..., None]
    color = base * shade
    mortar = np.array([0.73, 0.64, 0.47]) * (0.9 + 0.2 * value_noise((size, size), 4, rng))[..., None]  # sandy ochre joints
    color = np.where(is_brick[..., None], color, mortar)
    albedo = Image.fromarray((np.clip(color, 0, 1) * 255).astype(np.uint8))

    # Height: brick faces stand 8 mm proud of the joints, with rough bumps.
    height = is_brick.astype(np.float32) * 1.0 + 0.15 * mottle
    gy, gx = np.gradient(height)
    strength = 3.0
    n = np.stack([-gx * strength, gy * strength, np.ones_like(gx)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    normal = Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8))
    rough = Image.fromarray((np.where(is_brick, 0.86 + 0.1 * mottle, 0.97) * 255).astype(np.uint8))

    # Claustra: open brickwork. Every other brick in every other course is left out.
    open_cell = (course % 2 == 1) & (col % 2 == 0)
    alpha = np.where(open_cell, 0, 255).astype(np.uint8)
    claustra = albedo.copy()
    claustra.putalpha(Image.fromarray(alpha))
    return albedo, normal, rough, claustra


def large_tile(size=2048, seed=11):
    """Grey stone-look tiles of 60 x 120 cm with 3 mm joints (inside and on the
    roof terrace): a honed grey stone, clouded light and dark, with darker specks, every tile a
    shade of its own, from pale to mid grey; each row starts at a random point. Tile = 4.80 m
    (4 tiles across, 8 rows up), large enough that the mix of light and dark tiles doesn't
    visibly repeat across a room."""
    rng = np.random.default_rng(seed)
    px = size / 4.80
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    row = np.floor(yy / (0.6 * px)).astype(int)
    shift = (rng.random(8) * 1.2 * px)[row]
    col = np.floor(((xx + shift) % size) / (1.2 * px)).astype(int)
    joint = 0.003 * px + 1.0
    is_tile = ((yy % (0.6 * px)) > joint) & (((xx + shift) % (1.2 * px)) > joint)
    ids = row * 4 + col
    tone = rng.random(32)[ids][..., None]
    warmth = (rng.random(32) - 0.5)[ids][..., None] * 0.02  # a few tiles a touch warmer, some cooler
    base = 0.70 + 0.16 * tone + warmth * np.array([1.0, 0.4, -0.6])
    base = base * np.array([0.99, 0.996, 1.0])  # a cool grey
    # The stone: big soft clouds, smaller blotches, paler weathered patches, a fine grain and dark
    # specks. How strongly they show differs per tile, as from one block of stone to the next.
    noise = lambda *cells: sum(w * value_noise((size, size), c, rng) for c, w in cells)
    cloud = noise((128, 0.45), (64, 0.25), (32, 0.18), (16, 0.12))
    pale = np.clip((noise((64, 0.5), (32, 0.3), (16, 0.2)) - 0.55) * 2.5, 0, 1) ** 1.5
    grain = noise((4, 0.6), (2, 0.4))
    specks = np.clip((value_noise((size, size), 2, rng) - 0.88) * 8, 0, 1) * 0.12
    strength = (0.6 + 0.8 * rng.random(32))[ids]
    shade = 1 - strength * (0.18 * (cloud - 0.5) + 0.04) + strength * 0.09 * pale + 0.05 * (grain - 0.5) - specks
    color = base * shade[..., None]
    color = np.where(is_tile[..., None], color, np.array([0.56, 0.56, 0.55]))
    height = is_tile.astype(np.float32) + 0.04 * cloud - 0.02 * specks
    rough = np.where(is_tile, 0.5 + 0.18 * cloud, 0.9)
    return (Image.fromarray((np.clip(color, 0, 1) * 255).astype(np.uint8)), normal_map(height, 1.5),
            Image.fromarray((rough * 255).astype(np.uint8)))


def slats(size=1024, seed=13):
    """Vertical wood slats for the cladding: 3.5 cm slats on a 4.5 cm pitch over dark gaps, each
    slat a little lighter or darker, with a fine grain along it. Tile = 1.80 m (40 slats)."""
    rng = np.random.default_rng(seed)
    px = size / 1.80
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    pitch = 0.045 * px
    k = np.floor(xx / pitch).astype(int)
    is_slat = (xx % pitch) < 0.035 * px
    tone = (0.92 + 0.16 * rng.random(41))[k][..., None]
    grain = value_noise((size, size), 3, rng)
    fine = (value_noise((size // 32, size), 1, rng) * 255).astype(np.uint8)  # long streaks along the slats
    streaks = np.asarray(Image.fromarray(fine).resize((size, size), Image.BILINEAR), np.float32) / 255
    wood = np.array([0.66, 0.50, 0.37]) * tone * (0.9 + 0.1 * grain[..., None] + 0.08 * streaks[..., None])
    color = np.where(is_slat[..., None], wood, np.array([0.17, 0.12, 0.09]))
    height = is_slat.astype(np.float32) + 0.05 * grain
    rough = np.where(is_slat, 0.62 + 0.1 * grain, 0.95)
    return (Image.fromarray((np.clip(color, 0, 1) * 255).astype(np.uint8)), normal_map(height, 2.0),
            Image.fromarray((rough * 255).astype(np.uint8)))


def regrade():
    """Colour corrections (GRADE) again from the downloaded originals, without asking Poly Haven."""
    for name, (asset, size) in TEXTURES.items():
        src = next((SRC / asset).glob("*_diff_2k.jpg"), None)
        if name not in GRADE or not src:
            continue
        sat, bright = GRADE[name]
        img = ImageEnhance.Brightness(ImageEnhance.Color(Image.open(src).convert("RGB")).enhance(sat)).enhance(bright)
        save_webp(img, WEB / f"{name}_color.webp", size)


def terrazzo(size=1024, seed=3):
    """Light terrazzo with small chips in terracotta, grey, black and white. Tile = 1 m."""
    rng = np.random.default_rng(seed)
    base = np.ones((size, size, 3)) * np.array([0.86, 0.84, 0.80])
    base *= (0.97 + 0.06 * value_noise((size, size), 32, rng))[..., None]
    colors = np.array([[0.70, 0.40, 0.30], [0.55, 0.55, 0.55], [0.15, 0.15, 0.15], [0.97, 0.96, 0.94], [0.80, 0.62, 0.50]])
    yy, xx = np.mgrid[0:size, 0:size]
    for _ in range(2600):
        cx, cy = rng.integers(0, size, 2)
        r = rng.uniform(1.5, 7.0)
        c = colors[rng.integers(0, len(colors))]
        x0, x1, y0, y1 = int(cx - r - 1), int(cx + r + 2), int(cy - r - 1), int(cy + r + 2)
        sub = (slice(max(0, y0), min(size, y1)), slice(max(0, x0), min(size, x1)))
        d = (xx[sub] - cx) ** 2 / (r * rng.uniform(0.6, 1.4)) ** 2 + (yy[sub] - cy) ** 2 / r ** 2
        base[sub][d < 1] = c
    return Image.fromarray((np.clip(base, 0, 1) * 255).astype(np.uint8))


def rust_tile(size=1024, seed=5):
    """Rust-red vertical strip tiles (shower walls in bathroom 1). Tile = 0.6 m: 12 strips of 5 cm."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:size, 0:size]
    strip = np.minimum(xx // (size // 12), 11).astype(int)
    tone = rng.uniform(0.85, 1.12, 12)[strip]
    base = np.stack([0.66 * tone, 0.36 * tone, 0.26 * tone], -1)
    base *= (0.92 + 0.12 * value_noise((size, size), 20, rng))[..., None]
    grout = ((xx % (size // 12)) < 3) | ((yy % (size // 4)) < 3)
    base[grout] = [0.78, 0.74, 0.70]
    return Image.fromarray((np.clip(base, 0, 1) * 255).astype(np.uint8))


def normal_map(height, strength):
    gy, gx = np.gradient(height)
    n = np.stack([-gx * strength, gy * strength, np.ones_like(gx)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8))


def standard_brick(size=1024, seed=17):
    """Neighbours' facades: standard bricks (21 x 5 cm, 1 cm joints) in running bond, light and
    fairly neutral so one texture can be tinted red, brown, yellow, white or grey.
    Tile = 1.76 m: 8 bricks of 22 cm across, 27 courses of 6.5 cm up (1.755 m)."""
    rng = np.random.default_rng(seed)
    px = size / 1.76
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    course_h, brick_w, joint = 0.065 * px * (1.76 / 1.755), 0.22 * px, 0.01 * px
    course = np.floor(yy / course_h).astype(int)
    shift = (course % 2) * (brick_w / 2)
    col = np.floor(((xx + shift) % size) / brick_w).astype(int)
    is_brick = ((yy % course_h) < (course_h - joint)) & (((xx + shift) % brick_w) < (brick_w - joint))
    tone = rng.random(28 * 16)[course * 16 + col]
    base = 0.78 + 0.16 * tone[..., None] * np.array([1.0, 0.97, 0.94])
    mottle = 0.6 * value_noise((size, size), 20, rng) + 0.4 * value_noise((size, size), 5, rng)
    color = base * (1 - 0.14 * mottle[..., None])
    mortar = np.array([0.86, 0.85, 0.82]) * (0.92 + 0.12 * value_noise((size, size), 4, rng))[..., None]
    color = np.where(is_brick[..., None], color, mortar)
    albedo = Image.fromarray((np.clip(color, 0, 1) * 255).astype(np.uint8))
    normal = normal_map(is_brick.astype(np.float32) + 0.15 * mottle, 2.5)
    rough = Image.fromarray((np.where(is_brick, 0.85 + 0.1 * mottle, 0.97) * 255).astype(np.uint8))
    return albedo, normal, rough


def roof_tiles(size=1024, seed=29):
    """Interlocking roof tiles with a rounded roll (as on most Flemish roofs), light grey so the
    game can tint them clay red, anthracite or brown. Tile = 1.2 m: 4 tiles of 30 cm across,
    4 rows of 30 cm down the slope; each row overlaps the one below and casts a dark lip."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    cell = size / 4
    u = (xx % cell) / cell  # across one tile, 0..1
    v = (yy % cell) / cell  # down one tile, 0..1 (the row's lower edge at 1)
    row = np.floor(yy / cell).astype(int)
    colm = np.floor(xx / cell).astype(int)
    roll = np.sin(np.pi * np.clip((u - 0.55) / 0.45, 0, 1)) * 0.6 + np.sin(np.pi * u) * 0.25
    height = roll + v * 0.5
    tone = rng.random(16)[(row % 4) * 4 + colm % 4]
    shade = 0.68 + 0.12 * tone + 0.3 * roll
    lip = np.clip((v - 0.9) / 0.1, 0, 1)  # the overlap: the row below lies in its shadow
    shade = shade * (1 - 0.45 * lip) * (1 - 0.1 * value_noise((size, size), 16, rng))
    albedo = Image.fromarray((np.clip(np.stack([shade] * 3, -1) * np.array([1.0, 0.98, 0.96]), 0, 1) * 255).astype(np.uint8))
    normal = normal_map(height * 6, 1.5)
    rough = Image.fromarray(((0.7 + 0.2 * value_noise((size, size), 8, rng)) * 255).astype(np.uint8))
    return albedo, normal, rough


def asphalt(size=1024, seed=41):
    """Asphalt (Molenhoek's carriageway and its red cycle lanes): fine stone in dark binder, light and
    neutral so the game can tint it dark grey or red. Tile = 2 m: about 2 mm a pixel, the stones 4 to
    12 mm, a faint mottle of wear over it."""
    rng = np.random.default_rng(seed)
    fine = 0.6 * value_noise((size, size), 4, rng) + 0.4 * value_noise((size, size), 7, rng)
    stones = np.clip((fine - 0.5) * 3.2, -1, 1)
    grit = rng.random((size, size)) - 0.5
    mottle = 0.6 * value_noise((size, size), 96, rng) + 0.4 * value_noise((size, size), 24, rng)
    tone = 0.7 + 0.1 * stones + 0.04 * grit - 0.08 * (mottle - 0.5)
    albedo = Image.fromarray((np.clip(np.stack([tone * 1.0, tone * 0.99, tone * 0.98], -1), 0, 1) * 255).astype(np.uint8))
    normal = normal_map(0.5 * stones, 2.0)
    rough = Image.fromarray(((0.86 + 0.08 * (0.5 - fine) + 0.04 * (mottle - 0.5)) * 255).clip(0, 255).astype(np.uint8))
    return albedo, normal, rough


def road_concrete(size=1024, seed=53):
    """Concrete road slabs as Kapellenhoek, Kapelleweg and Briel have them (Street View, Oct 2026): a brushed,
    worn surface with the coarse aggregate showing through in places, small pores and grit, and only a faint
    mottle: the slabs, joints, cracks and the darker wheel tracks come from the game (web/src/world/roadDetail.ts),
    so they don't repeat with the texture. Light and neutral, for the game to tint. Tile = 2 m: 2 mm a pixel."""
    rng = np.random.default_rng(seed)
    noise = lambda *cells: sum(w * value_noise((size, size), c, rng) for c, w in cells)
    # The stones: patches where the cement skin has worn off show grey-brown and light chips, 3 to 10 mm.
    chips = noise((3, 0.55), (5, 0.45))
    worn = np.clip((noise((48, 0.6), (16, 0.4)) - 0.45) * 2.2, 0, 1)
    stones = np.clip((chips - 0.56) * 5, 0, 1) * (0.35 + 0.65 * worn)
    tint = (rng.random(64)[(np.floor(chips * 63)).astype(int)] - 0.5)[..., None] * np.array([0.10, 0.09, 0.07])
    # Brushed across the slab (the finish of a concrete road): faint streaks along v.
    streaks = np.asarray(Image.fromarray((value_noise((size, size // 64), 1, rng) * 255).astype(np.uint8)).resize((size, size), Image.BILINEAR), np.float32) / 255
    pores = np.clip((value_noise((size, size), 2, rng) - 0.9) * 10, 0, 1)
    grit = rng.random((size, size)) - 0.5
    mottle = noise((128, 0.6), (64, 0.4))
    tone = 0.78 + 0.04 * (streaks - 0.5) + 0.05 * grit - 0.1 * (mottle - 0.5) - 0.25 * pores
    color = tone[..., None] * np.array([1.0, 0.995, 0.975]) - stones[..., None] * (0.17 - tint)
    height = 0.6 * stones - 0.8 * pores + 0.08 * streaks + 0.015 * grit
    rough = 0.9 - 0.08 * stones + 0.05 * (mottle - 0.5) + 0.05 * pores
    return (Image.fromarray((np.clip(color, 0, 1) * 255).astype(np.uint8)), normal_map(height, 1.6),
            Image.fromarray((np.clip(rough, 0, 1) * 255).astype(np.uint8)))


def generated(sizes):
    """The textures made here (no downloads); adds their real sizes in metres to `sizes`."""
    albedo, normal, rough, claustra = brick()
    save_webp(albedo, WEB / "brick_color.webp", 2048, 88)
    save_webp(normal, WEB / "brick_normal.webp", 2048, 90)
    save_webp(rough, WEB / "brick_rough.webp", 1024)
    claustra.save(WEB / "claustra_color.webp", "WEBP", quality=88, method=6)
    sizes["brick"] = sizes["claustra"] = 1.8
    save_webp(terrazzo(), WEB / "terrazzo_color.webp", 1024)
    save_webp(rust_tile(), WEB / "rust_tile_color.webp", 1024)
    sizes["terrazzo"] = 1.0
    sizes["rust_tile"] = 0.6
    for name in SURFACES:
        surface(name, sizes)


# Generated surfaces with a colour, normal and roughness map: how they are made, the real size of
# one texture tile in metres and the colour map's size in pixels (the floor tiles' 4.8 m need 2048);
# a fourth number is the normal map's size where 1024 would only add download (the road's fine grit).
SURFACES = {"nb_brick": (standard_brick, 1.76, 1024), "roof_tiles": (roof_tiles, 1.2, 1024),
            "floor_tile": (large_tile, 4.8, 2048), "cladding": (slats, 1.8, 1024), "asphalt": (asphalt, 2.0, 1024),
            "road_concrete": (road_concrete, 2.0, 1024, 512)}


def surface(name, sizes):
    make, tile, px, *normal_px = SURFACES[name]
    albedo, normal, rough = make()
    save_webp(albedo, WEB / f"{name}_color.webp", px, 86)
    save_webp(normal, WEB / f"{name}_normal.webp", normal_px[0] if normal_px else 1024, 88)
    save_webp(rough, WEB / f"{name}_rough.webp", 512)
    sizes[name] = tile


def sky():
    files = api(f"files/{HDRI}")
    url = files["hdri"]["2k"]["hdr"]["url"]
    src = fetch(url, SRC / "hdri" / Path(url).name)
    ENV.mkdir(parents=True, exist_ok=True)
    (ENV / "sky_2k.hdr").write_bytes(src.read_bytes())
    print("sky        <-", HDRI, f"({src.stat().st_size // 1024} KB)")


def halves():
    """Every web texture again at half size in textures/half/, for phones and tablets: a quarter of
    the graphics memory and of the download. Made here rather than in the browser, where shrinking
    them through a canvas is the one step only phones took (and iPhones showed black walls)."""
    (WEB / "half").mkdir(exist_ok=True)
    for src in sorted(WEB.glob("*.webp")):
        img = Image.open(src)
        img.load()
        half = img.resize((max(1, img.width // 2), max(1, img.height // 2)), Image.LANCZOS)
        half.save(WEB / "half" / src.name, "WEBP", quality=86, method=6, exact=True)
    total = sum(p.stat().st_size for p in (WEB / "half").glob("*.webp")) // 1024
    print(f"half-size textures: {total} KB")


def main():
    WEB.mkdir(parents=True, exist_ok=True)
    if "--halves" in sys.argv:  # only remake the half-size copies
        halves()
        return
    if "--only" in sys.argv:  # one generated surface, e.g. --only floor_tile
        sizes = json.loads((WEB / "sizes.json").read_text(encoding="utf-8"))
        surface(sys.argv[sys.argv.index("--only") + 1], sizes)
        (WEB / "sizes.json").write_text(json.dumps(sizes, indent=1), encoding="utf-8")
        halves()
        return
    if "--generated" in sys.argv:
        sizes = json.loads((WEB / "sizes.json").read_text(encoding="utf-8"))
        regrade()
    else:
        meta = api("assets?t=textures")
        sizes = poly_haven(meta)
    generated(sizes)
    if "--generated" not in sys.argv:
        sky()
    (WEB / "sizes.json").write_text(json.dumps(sizes, indent=1), encoding="utf-8")
    total = sum(p.stat().st_size for p in WEB.glob("*.webp")) // 1024
    print(f"web textures: {total} KB")
    halves()


if __name__ == "__main__":
    main()
