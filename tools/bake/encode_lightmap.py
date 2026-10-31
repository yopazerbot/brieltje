"""Turn the baked light (lightmap.npy from bake_lightmap.py) into a WebP for the web.

The light is scaled so the brightest areas (99.7th percentile) sit near white,
then stored with twice the sRGB curve (value ** (1 / 4.4)), so the much darker
rooms get enough of the 256 steps. The game decodes sRGB, squares the result
and multiplies by `scale` from bake.json.

  python tools/bake/encode_lightmap.py <bake_dir> <web/public/baked>
"""
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
dst.mkdir(parents=True, exist_ok=True)
px = np.load(src / "lightmap.npy")[::-1, :, :3]  # Blender stores the bottom row first
lum = px.mean(axis=2)
lit = lum[lum > 1e-4]
scale = float(np.percentile(lit, 99.7)) / 0.95
srgb = np.clip(px / scale, 0, 1) ** (1 / 4.4)
Image.fromarray((srgb * 255 + 0.5).astype(np.uint8)).save(dst / "lightmap.webp", quality=92, method=6)
shutil.copy(src / "house_baked.glb", dst / "house_baked.glb")
(dst / "bake.json").write_text(json.dumps({"scale": round(scale, 4), "size": px.shape[0], "curve": 2}), encoding="utf-8")
print(f"lightmap {px.shape[0]}px, scale {scale:.3f}, {lit.size / lum.size:.0%} of the texture used, {(dst / 'lightmap.webp').stat().st_size // 1024} KB")
