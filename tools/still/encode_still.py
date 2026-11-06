"""A rendered still as WebP for the web: a large one for wide screens and a small one for phones and
small windows (the page picks by width). The name is the slideshow's (town, house, bungalow).

  tools/.venv/Scripts/python.exe tools/still/encode_still.py <render.png> web/public/start <name>
"""
import sys
from pathlib import Path

from PIL import Image

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
name = sys.argv[3] if len(sys.argv) > 3 else "start"
dst.mkdir(parents=True, exist_ok=True)
img = Image.open(src).convert("RGB")
for width in (2560, 1280):
    out = img if img.width == width else img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    path = dst / f"{name}-{width}.webp"
    out.save(path, "WEBP", quality=84, method=6)
    print(path.name, out.size, path.stat().st_size // 1024, "KB")
