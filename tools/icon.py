"""Draw the app icon (home screen on phones and tablets): the house as a light block with its
windows on a dark ground, the accent line under it. Writes web/public/icon-512.png,
icon-192.png and apple-touch-icon.png (180).

Run from the project root:
    tools/.venv/Scripts/python.exe tools/icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web/public"


def icon(size=1024):
    im = Image.new("RGB", (size, size), (12, 14, 18))
    d = ImageDraw.Draw(im)
    u = size / 32
    d.rectangle([7 * u, 7 * u, 25 * u, 23 * u], fill=(226, 211, 186))  # the house, light beige brick
    d.rectangle([7 * u, 7 * u, 25 * u, 8 * u], fill=(60, 58, 54))  # the flat roof's dark coping
    for x0, y0, x1, y1 in ((10, 10.5, 15, 14.5), (18, 10.5, 22, 14.5), (10, 17, 13, 23), (16, 17, 22, 20.5)):
        d.rectangle([x0 * u, y0 * u, x1 * u, y1 * u], fill=(40, 46, 56))  # windows and the door
    d.rectangle([5 * u, 24.5 * u, 27 * u, 25.5 * u], fill=(242, 179, 61))  # the accent line
    return im


def main():
    big = icon()
    for name, px in (("icon-512.png", 512), ("icon-192.png", 192), ("apple-touch-icon.png", 180)):
        big.resize((px, px), Image.LANCZOS).save(OUT / name, optimize=True)
        print(name, (OUT / name).stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
