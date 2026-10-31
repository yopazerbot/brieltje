"""The two textures of the town centre's houses (tools/town/town.py): brick and roof tiles, CC0 from Poly Haven.

- town_brick from Poly Haven `red_brick` (1.4 m a tile): Flemish red brick in stretcher bond with pale joints.
  The colour map keeps a third of the photo's colour and is brightened, so one texture takes every brick of
  the square from the vertex colours: orange-red, red-brown, buff yellow, and the cream and white of painted
  brick (each brick keeps its own light and dark).
- town_roof from Poly Haven `roof_tiles` (2 m a tile): interlocking roof tiles in even courses, as on most
  roofs round the square. Brightened and nearly grey, so the vertex colours make them orange
  clay or anthracite.

The 2k maps go to source/textures/<id>/ (not in git); web copies (WebP, 1024 px colour and normal, 512 px
roughness) to web/public/textures/, half-size copies for phones to web/public/textures/half/.

Run from the project root:
    tools/.venv/Scripts/python.exe tools/town/textures.py
"""
import json
import urllib.request
from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "source" / "textures"
WEB = ROOT / "web" / "public" / "textures"
AGENT = {"User-Agent": "briel-walkthrough/0.1"}
# web name -> (Poly Haven id, colour saturation kept, brightness, grey level the colour map is lifted to)
TEXTURES = {"town_brick": ("red_brick", 0.33, 1.0, 0.9), "town_roof": ("roof_tiles", 0.12, 1.0, 0.72)}
MAPS = {"color": ["Diffuse"], "normal": ["nor_gl"], "rough": ["Rough", "arm"]}


def fetch(url, dest):
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(urllib.request.Request(url, headers=AGENT), timeout=120) as r:
        dest.write_bytes(r.read())
    return dest


def api(path):
    with urllib.request.urlopen(urllib.request.Request(f"https://api.polyhaven.com/{path}", headers=AGENT), timeout=60) as r:
        return json.load(r)


def save(img, path, size, quality=84):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.resize((size, size), Image.LANCZOS).save(path, "WEBP", quality=quality, method=6)
    half = path.parent / "half" / path.name
    half.parent.mkdir(parents=True, exist_ok=True)
    img.resize((size // 2, size // 2), Image.LANCZOS).save(half, "WEBP", quality=quality, method=6)


def lift(img, sat, bright, level):
    """Less colour and a mean grey of `level`, so the game's vertex colours set the tone."""
    img = ImageEnhance.Brightness(ImageEnhance.Color(img).enhance(sat)).enhance(bright)
    grey = ImageOps.grayscale(img)
    mean = sum(i * n for i, n in enumerate(grey.histogram())) / (grey.width * grey.height) / 255
    return ImageEnhance.Brightness(img).enhance(level / max(mean, 0.05))


def main():
    for name, (asset, sat, bright, level) in TEXTURES.items():
        files = api(f"files/{asset}")
        for kind, keys in MAPS.items():
            key = next(k for k in keys if k in files)
            url = files[key]["2k"]["jpg"]["url"]
            img = Image.open(fetch(url, SRC / asset / Path(url).name))
            if key == "arm":
                img = img.split()[1]
            img = img.convert("L" if kind == "rough" else "RGB")
            if kind == "color":
                img = lift(img, sat, bright, level)
            if kind == "rough":  # weathered tiles and brick: no glossy patches (0.72 to 1)
                img = img.point(lambda v: int(184 + v * 71 / 255))
            save(img, WEB / f"{name}_{kind}.webp", 512 if kind == "rough" else 1024, 80 if kind == "normal" else 84)
        print(name, "<-", asset)
    total = sum((WEB / f"{n}_{k}.webp").stat().st_size for n in TEXTURES for k in MAPS)
    print(f"web copies: {total // 1024} KB")


if __name__ == "__main__":
    main()
