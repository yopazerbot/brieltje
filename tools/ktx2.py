"""GPU-compressed copies (KTX2, Basis Universal) of every surface texture in web/public/textures/.

The game loads these where the browser can transcode them (web/src/world/textureFiles.ts): they stay
compressed in graphics memory, four to eight times smaller than the WebP files decoded to plain pixels.

- Colour maps (*_color): ETC1S, sRGB. Roughness maps (*_rough): ETC1S, linear.
- Normal maps (*_normal): UASTC LDR 4x4 with RDO and Zstandard, linear, mipmaps renormalised (ETC1S
  flattens bricks and tiles). Those of plain noise (NOISY_NORMALS: grass, soil, asphalt) are ETC1S.
- Every file has its full mip chain (wrapping at the edges: the textures tile), and is flipped
  vertically: a compressed texture can't be flipped on upload as the WebP ones are (flipY).

Reads the full-size WebP files (made by tools/textures.py, tools/town/textures.py and
tools/homestreet/textures.py) and writes web/public/textures/ktx2/<name>.ktx2; with --half, the half-size
ones (web/public/textures/half/, for phones and tablets) into web/public/textures/ktx2/half/. Run it again
(both ways) whenever one of those tools changes a texture.

The encoder is basisu v2.10 (github.com/BinomialLLC/basis_universal, Apache 2.0) built for WASI, which
Node runs (tools/basisu.mjs): no native binary, nothing to install. It is fetched once into tools/.bin/
(not in git) and checked against its SHA-256.

Run from the project root:
    tools/.venv/Scripts/python.exe tools/ktx2.py
The phones' half-size set:
    tools/.venv/Scripts/python.exe tools/ktx2.py --half
Only some textures (names without .webp):
    tools/.venv/Scripts/python.exe tools/ktx2.py --only brick_color brick_normal
"""
import argparse
import hashlib
import os
import subprocess
import sys
import tempfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web/public/textures"
OUT = WEB / "ktx2"
BIN = ROOT / "tools/.bin/basisu"
RUNNER = ROOT / "tools/basisu.mjs"

TAG = "v2_1_0r"  # basisu v2.10
FILES = {
    "basisu_st.wasm": "7b8837e020e48239ab3085697a16334649c07ef121f5a6556d8b17919938a143",
    "LICENSE": None,
}

COMMON = ["-ktx2", "-mipmap", "-y_flip"]
MODES = {
    # ETC1S at quality 90: 0.05 dB under quality 100 on the facade brick, and 2 % smaller
    "color": ["-etc1s", "-quality", "90"],
    "rough": ["-etc1s", "-linear", "-quality", "90"],
    # UASTC with RDO (lambda 2) and Zstandard; -normal_map: linear metrics and mip filtering. ETC1S
    # flattens the relief of bricks and roof tiles at a grazing light (seen in the game side by side).
    "normal": ["-uastc", "-uastc_level", "2", "-uastc_rdo_l", "2", "-normal_map", "-mip_renorm",
               "-ktx2_zstandard_level", "18"],
}
# Normal maps of noise without a pattern (no joints or edges): ETC1S looks the same there in the game
# and is four times smaller to download (these six: 5.0 MB as UASTC, 1.3 MB as ETC1S).
NOISY_NORMALS = {"grass", "field", "road", "asphalt", "gravel", "hedge"}
NOISY = ["-etc1s", "-quality", "100", "-normal_map", "-mip_renorm"]


def fetch_encoder() -> Path:
    BIN.mkdir(parents=True, exist_ok=True)
    for name, sha in FILES.items():
        path = BIN / name
        if not path.exists():
            src = "bin/" + name if name.endswith(".wasm") else name
            url = f"https://raw.githubusercontent.com/BinomialLLC/basis_universal/{TAG}/{src}"
            print("fetching", url)
            with urllib.request.urlopen(url) as r:
                data = r.read()
            if sha and hashlib.sha256(data).hexdigest() != sha:
                sys.exit(f"{name}: unexpected SHA-256, not using it")
            path.write_bytes(data)
        elif sha and hashlib.sha256(path.read_bytes()).hexdigest() != sha:
            sys.exit(f"{path}: unexpected SHA-256; delete it to fetch it again")
    return BIN / "basisu_st.wasm"


def kind(name: str) -> str:
    for k in MODES:
        if name.endswith("_" + k):
            return k
    sys.exit(f"{name}: not a _color, _normal or _rough texture")


def encode(wasm: Path, name: str, tmp: Path, src: Path, dst: Path) -> tuple[str, int]:
    png = tmp / f"{name}.png"
    Image.open(src / f"{name}.webp").save(png, compress_level=1)
    noisy = kind(name) == "normal" and name.removesuffix("_normal") in NOISY_NORMALS
    args = (NOISY if noisy else MODES[kind(name)]) + COMMON + ["-file", png.name, "-output_file", f"{name}.ktx2"]
    run = subprocess.run(["node", "--no-warnings", str(RUNNER), str(wasm), str(tmp), *args],
                         capture_output=True, text=True)
    out = tmp / f"{name}.ktx2"
    if run.returncode != 0 or not out.exists():
        sys.exit(f"{name}: basisu failed\n{run.stdout[-2000:]}\n{run.stderr[-2000:]}")
    dst.mkdir(exist_ok=True, parents=True)
    (dst / f"{name}.ktx2").write_bytes(out.read_bytes())
    png.unlink()
    out.unlink()
    return name, (dst / f"{name}.ktx2").stat().st_size


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--only", nargs="+", metavar="NAME", help="these textures only (file names without .webp)")
    ap.add_argument("--half", action="store_true", help="the half-size set for phones and tablets (textures/half/)")
    ap.add_argument("--jobs", type=int, default=max(1, min(6, (os.cpu_count() or 2) // 4)),
                    help="encoders at once (default: a quarter of the processor's threads, at most 6)")
    a = ap.parse_args()
    src, dst = (WEB / "half", OUT / "half") if a.half else (WEB, OUT)
    names = a.only or sorted(p.stem for p in src.glob("*.webp"))
    wasm = fetch_encoder()
    with tempfile.TemporaryDirectory(prefix="ktx2-") as t, ThreadPoolExecutor(a.jobs) as pool:
        for name, size in pool.map(lambda n: encode(wasm, n, Path(t), src, dst), names):
            print(f"{name:28s} {size / 1024:8.0f} KB")
    if not a.only:
        known = {f"{n}.ktx2" for n in names}
        for stale in dst.glob("*.ktx2"):
            if stale.name not in known:
                print("removing", stale.name, "(no WebP file of that name)")
                stale.unlink()
    total = lambda folder, pattern: sum(p.stat().st_size for p in folder.glob(pattern))
    print(f"KTX2 {total(OUT, '*.ktx2') / 1e6:.2f} MB, half-size KTX2 {total(OUT / 'half', '*.ktx2') / 1e6:.2f} MB, WebP {total(WEB, '*.webp') / 1e6:.2f} MB, "
          f"half-size WebP {total(WEB / 'half', '*.webp') / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
