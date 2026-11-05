"""Turn the baked passes (tools/bake/bake_buildings.py) into the game's light and wear textures.

  tools/.venv/Scripts/python.exe tools/bake/encode_buildings.py <work dir> web/public/baked

Per page of a model:
- <model>_<page>.webp, the light: RGB the light from the sky and the sun's bounce (irradiance / pi), scaled
  by `scale` in <model>.json and stored as the 4.4th root (the game decodes sRGB and squares it: many more
  steps in the dark); A how much of the sun the point sees (the game dims its real-time sun by it).
- <model>_<page>_wear.webp (half the light's size), the wear: R grime (splashed dirt at the foot of walls, dust in corners and under
  sills and eaves), G green (algae low on shaded walls, moss on roofs that get little sun), B where rain runs
  down the walls (the game draws it as streaks). Patchy, from noise in the world's own coordinates, so two
  houses side by side are never dirty in the same way.
- Each also as KTX2 (Basis Universal, ETC1S, as tools/ktx2.py), which stays
  compressed on the graphics chip, and the same four at half size in half/ for phones and tablets.
- <model>.json: the layout's id (the game uses the bake only if its model has the same), the pages, the
  page size and `scale`.
Gaps between the layout's pieces are filled from their edges, so a texture's smaller mip levels don't
darken the pieces' borders.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

WORK, DST = Path(sys.argv[1]), Path(sys.argv[2])
DST.mkdir(parents=True, exist_ok=True)
(DST / "half").mkdir(exist_ok=True)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ktx2 import RUNNER, fetch_encoder  # noqa: E402  (tools/ktx2.py: the encoder, fetched once)

WASM = fetch_encoder()
# The light: ETC1S at its best quality, sRGB as the WebP (35 dB on the town's page, no difference to see, a
# third of UASTC's size); the wear: ETC1S, linear. Mip levels clamp at the edges (a page doesn't tile). Not
# flipped: the layout's v runs down the image, as the game reads it.
LIGHT_KTX2 = ["-etc1s", "-quality", "255"]
WEAR_KTX2 = ["-etc1s", "-linear", "-quality", "90"]


def save(img: Image.Image, name: str, ktx2_args: list, webp: dict):
    """Write a page as WebP and KTX2, full size and (in half/) half size."""
    for folder, im in ((DST, img), (DST / "half", img.resize((img.width // 2, img.height // 2), Image.Resampling.BOX))):
        im.save(folder / f"{name}.webp", **webp)
        with tempfile.TemporaryDirectory(prefix="bake-ktx2-") as t:
            im.save(Path(t) / "in.png", compress_level=1)
            args = ktx2_args + ["-ktx2", "-mipmap", "-mip_clamp", "-file", "in.png", "-output_file", "out.ktx2"]
            run = subprocess.run(["node", "--no-warnings", str(RUNNER), str(WASM), t, *args], capture_output=True, text=True)
            if run.returncode != 0 or not (Path(t) / "out.ktx2").exists():
                sys.exit(f"{name}: basisu failed\n{run.stdout[-1500:]}\n{run.stderr[-1500:]}")
            (folder / f"{name}.ktx2").write_bytes((Path(t) / "out.ktx2").read_bytes())
info = json.loads((WORK / "bake_info.json").read_text(encoding="utf-8"))
terrain = info["terrain"]
heights = np.array(terrain["heights"], np.float64).reshape(terrain["nz"], terrain["nx"]) / 100


def ground_at(x, z):
    """The relief's height (world metres) under points x, z, bilinear on the export's 2 m grid."""
    fx = np.clip((x - terrain["x0"]) / terrain["step"], 0, terrain["nx"] - 1.001)
    fz = np.clip((z - terrain["z0"]) / terrain["step"], 0, terrain["nz"] - 1.001)
    i, j = fx.astype(int), fz.astype(int)
    tx, tz = fx - i, fz - j
    h = heights
    return (h[j, i] * (1 - tx) + h[j, i + 1] * tx) * (1 - tz) + (h[j + 1, i] * (1 - tx) + h[j + 1, i + 1] * tx) * tz


def value_noise(p):
    """Smooth noise in 0..1 at points p (n, 3), one unit per lattice step."""
    i = np.floor(p)
    f = p - i
    f = f * f * (3 - 2 * f)
    i = i.astype(np.int64)

    def h(dx, dy, dz):
        n = (i[:, 0] + dx) * 73856093 ^ (i[:, 1] + dy) * 19349663 ^ (i[:, 2] + dz) * 83492791
        n = (n ^ (n >> 13)) * 1274126177
        return ((n ^ (n >> 16)) & 0xFFFF) / 65535.0

    x, y, z = f[:, 0], f[:, 1], f[:, 2]
    c = [[[h(a, b, c) for c in (0, 1)] for b in (0, 1)] for a in (0, 1)]
    lerp = lambda a, b, t: a + (b - a) * t
    return lerp(lerp(lerp(c[0][0][0], c[0][0][1], z), lerp(c[0][1][0], c[0][1][1], z), y),
                lerp(lerp(c[1][0][0], c[1][0][1], z), lerp(c[1][1][0], c[1][1][1], z), y), x)


def fbm(p, octaves=3):
    total, amp, norm = 0.0, 1.0, 0.0
    for k in range(octaves):
        total = total + amp * value_noise(p * (2 ** k) + k * 17.3)
        norm += amp
        amp *= 0.5
    return total / norm


def fill_gaps(img, covered, rounds=12):
    """Spread the covered texels' values into the gaps round them (a few texels each round)."""
    img = img.astype(np.float32).copy()
    have = covered.copy()
    for _ in range(rounds):
        acc = np.zeros_like(img)
        cnt = np.zeros(have.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            sh = np.roll(np.roll(have, dy, 0), dx, 1)
            acc += np.roll(np.roll(img * have[..., None], dy, 0), dx, 1)
            cnt += sh
        new = (~have) & (cnt > 0)
        img[new] = acc[new] / cnt[new][:, None]
        have = have | new
        if have.all():
            break
    rest = ~have
    if rest.any():
        img[rest] = img[have].mean(axis=0) if have.any() else 0
    return img


pages = {}
for key in info["pages"]:
    model, page = key.rsplit("_", 1)
    pages.setdefault(model, []).append(int(page))


def load(model, page, name):
    x = np.nan_to_num(np.load(WORK / f"{model}_{page}_{name}.npy").astype(np.float32), nan=0.0, posinf=0.0, neginf=0.0)
    # Shadow and occlusion passes are fractions; a few texels on the pieces' edges come out far above 1.
    return np.clip(x, 0, 1) if name in ("sun", "rain", "ao") else np.maximum(x, 0) if name in ("sky", "bounce") else x


# One scale for every model: the same light is the same number everywhere.
samples = []
for model, ps in pages.items():
    for p in ps:
        cover = load(model, p, "cover")[..., 0] > 0.5
        light = load(model, p, "sky") + load(model, p, "bounce")
        lum = light[cover] @ np.array([0.2126, 0.7152, 0.0722])
        samples.append(lum[:: max(1, lum.size // 200000)])
scale = float(np.percentile(np.concatenate(samples), 99.7)) / 0.95
print(f"scale {scale:.4f} (99.7th percentile of the light, near white)")

for model, ps in pages.items():
    out_pages = []
    for p in ps:
        cover = load(model, p, "cover")[..., 0] > 0.5
        size = cover.shape[0]
        light = load(model, p, "sky") + load(model, p, "bounce")
        sun = load(model, p, "sun")[..., 0]
        rain = load(model, p, "rain")[..., 0]
        ao = load(model, p, "ao")[..., 0]
        pos = np.load(WORK / f"{model}_{p}_position.npy").astype(np.float64)
        nrm = load(model, p, "normal")

        rgb = np.clip(light / scale, 0, 1) ** (1 / 4.4)
        lightmap = fill_gaps(np.concatenate([rgb, sun[..., None]], axis=-1), cover)
        save(Image.fromarray((lightmap * 255 + 0.5).astype(np.uint8), "RGBA"), f"{model}_{p}", LIGHT_KTX2, dict(quality=85, alpha_quality=90, method=6))

        # Wear, only where there is surface.
        idx = np.flatnonzero(cover.ravel())
        P = pos.reshape(-1, 3)[idx]
        N = nrm.reshape(-1, 3)[idx]
        S, R, A = sun.ravel()[idx], rain.ravel()[idx], ao.ravel()[idx]
        above = P[:, 1] - ground_at(P[:, 0], P[:, 2])
        upright = 1 - np.abs(N[:, 1])
        up = np.clip(N[:, 1], 0, 1)
        patch = fbm(P * 0.45)  # patches a couple of metres across
        fine = fbm(P * 2.2 + 5.1)
        splash = np.exp(-np.clip(above, 0, None) / 0.45) * upright
        corner = np.clip((1 - A) * 1.6, 0, 1)
        sheltered = (1 - R) * upright
        grime = np.clip((0.6 * splash + 0.35 * corner + 0.3 * sheltered) * (0.55 + 0.9 * patch) * (0.8 + 0.4 * fine), 0, 1)
        damp = R * (1 - S)
        green = (0.8 * np.exp(-np.clip(above, 0, None) / 0.9) * upright + 0.9 * up * (above > 2.0)) * damp
        green = np.clip(green * np.clip((patch - 0.35) * 2.5, 0, 1), 0, 1)
        runs = np.clip(upright * R * (above > 0.4) * (0.4 + 0.8 * patch), 0, 1)
        wear = np.zeros((size * size, 3), np.float32)
        wear[idx] = np.stack([grime, green, runs], axis=1)
        wear = fill_gaps(wear.reshape(size, size, 3), cover)
        # Half the light's size: wear changes slowly, and the game adds its fine pattern from noise.
        save(Image.fromarray((wear * 255 + 0.5).astype(np.uint8), "RGB").resize((size // 2, size // 2), Image.Resampling.BOX), f"{model}_{p}_wear", WEAR_KTX2, dict(quality=85, method=6))
        kb = sum((d / f"{model}_{p}{w}.ktx2").stat().st_size for d in (DST,) for w in ("", "_wear")) // 1024
        print(f"{model} page {p}: {size}px, {cover.mean():.0%} covered, {kb} KB as KTX2; grime {grime.mean():.2f}, green {green.mean():.2f}, sun {S.mean():.2f}")
        out_pages.append(p)
    t = info["targets"][model]
    (DST / f"{model}.json").write_text(json.dumps({"id": t["id"], "pages": len(out_pages), "size": t["size"], "scale": round(scale, 5)}), encoding="utf-8")
