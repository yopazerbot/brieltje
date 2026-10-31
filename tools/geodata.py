"""Download the open data of the surroundings into source/geo/ (not in git).

The area is the rectangle EXTENT (Lambert 72, EPSG:31370): the plot's ring of 540 m and the
centre of Smetlede with the church and the school (tools/neighbours.py, `zone`), with a margin.
All of it is open data from Digitaal Vlaanderen:

- GRB layers via WFS (https://geo.api.vlaanderen.be/GRB/wfs): plots (ADP), buildings (GBG),
  canopies and other building parts (GBA), road surface (WBN), road centre lines (Wegsegment),
  poles (WPI), water (WTZ) and the rest of what was fetched before (WLAS, WGO, WLI, ...).
- DHM Vlaanderen II, terrain (DTM) and surface (DSM) at 1 m, via WCS
  (https://geo.api.vlaanderen.be/DHMV/wcs). The answer is multipart: an XML part and the TIFF.
- The most recent orthophoto at 25 cm via WMS (https://geo.api.vlaanderen.be/OMWRGBMRVL/wms),
  which gives at most 2048 px a request: fetched in 400 m tiles and put together.

Files already there are moved to source/geo/<backup>/ first (as old230/ holds the 230 m data).
Run from the project root:
    tools/.venv/Scripts/python.exe tools/geodata.py [backup folder name]
"""
import io
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
GEO = ROOT / "source" / "geo"
EXTENT = (118300, 183600, 119500, 185600)  # x0, y0, x1, y1: 1.2 by 2 km
LAYERS = ["ADP", "GBG", "GBA", "WBN", "Wegsegment", "WPI", "WTZ", "WLAS", "WGO", "WLI", "IngeschetstGebouw", "TRN", "WGA", "WGR", "WTI"]
COVERAGES = ["DHMVII_DTM_1m", "DHMVII_DSM_1m"]
ORTHO_TILE, ORTHO_PX = 400, 1600  # m and px per WMS request: 25 cm a pixel
AGENT = {"User-Agent": "briel-walkthrough/0.1"}


def get(url, timeout=300, tries=4):
    """The answer to a GET; the services now and then answer 400 to a good request, so try again."""
    for k in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=AGENT), timeout=timeout).read()
        except urllib.error.HTTPError:
            if k == tries - 1:
                raise
            time.sleep(5 * (k + 1))


def backup(name, folder):
    path = GEO / name
    if path.exists():
        (GEO / folder).mkdir(exist_ok=True)
        if not (GEO / folder / name).exists():
            path.replace(GEO / folder / name)


def wfs(layer):
    x0, y0, x1, y1 = EXTENT
    url = (f"https://geo.api.vlaanderen.be/GRB/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=GRB:{layer}"
           f"&srsName=EPSG:31370&bbox={x0},{y0},{x1},{y1},EPSG:31370&outputFormat=application/json&count=10000")
    data = json.loads(get(url))
    if len(data["features"]) >= 10000:
        raise SystemExit(f"{layer}: 10000 features or more, fetch it in parts")
    return data


def wcs(coverage):
    """The coverage over EXTENT as TIFF bytes (the part after the XML in the multipart answer)."""
    x0, y0, x1, y1 = EXTENT
    raw = get(f"https://geo.api.vlaanderen.be/DHMV/wcs?service=WCS&version=2.0.1&request=GetCoverage&CoverageId={coverage}"
              f"&format=image/tiff&subset=x({x0},{x1})&subset=y({y0},{y1})")
    start = raw.find(b"II*\x00")
    if start < 0:
        start = raw.find(b"MM\x00*")
    end = raw.rfind(b"--wcs")
    tiff = raw[start:end].rstrip(b"\r\n")
    img = Image.open(io.BytesIO(tiff))
    if img.size != (x1 - x0, y1 - y0):
        raise SystemExit(f"{coverage}: {img.size} pixels, expected {(x1 - x0, y1 - y0)}")
    return tiff


def ortho():
    x0, y0, x1, y1 = EXTENT
    k = ORTHO_PX / ORTHO_TILE
    out = Image.new("RGB", (int((x1 - x0) * k), int((y1 - y0) * k)))
    for ty in range(y0, y1, ORTHO_TILE):
        for tx in range(x0, x1, ORTHO_TILE):
            url = (f"https://geo.api.vlaanderen.be/OMWRGBMRVL/wms?service=WMS&version=1.3.0&request=GetMap&layers=Ortho&styles="
                   f"&crs=EPSG:31370&bbox={tx},{ty},{tx + ORTHO_TILE},{ty + ORTHO_TILE}&width={ORTHO_PX}&height={ORTHO_PX}&format=image/jpeg")
            tile = Image.open(io.BytesIO(get(url))).convert("RGB")
            out.paste(tile, (int((tx - x0) * k), int((y1 - ty - ORTHO_TILE) * k)))
            print(f"  ortho tile {tx}, {ty}")
    return out


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else "old1200"
    for layer in LAYERS:
        data = wfs(layer)
        backup(f"{layer}_l72.json", folder)
        (GEO / f"{layer}_l72.json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        print(f"{layer}: {len(data['features'])} features")
    for cov in COVERAGES:
        tiff = wcs(cov)
        backup(f"{cov}_clean.tif", folder)
        (GEO / f"{cov}_clean.tif").write_bytes(tiff)
        print(f"{cov}: {len(tiff) // 1024} KB")
    img = ortho()
    backup("ortho_025m.jpg", folder)
    backup("ortho_025m.json", folder)
    img.save(GEO / "ortho_025m.jpg", quality=90)
    x0, y0, x1, y1 = EXTENT
    (GEO / "ortho_025m.json").write_text(json.dumps({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "px": img.size[0], "py": img.size[1],
        "source": "Orthofotomozaïek, middenschalig, winteropnamen, kleur, meest recent (Digitaal Vlaanderen, WMS OMWRGBMRVL, layer Ortho)"}),
        encoding="utf-8")
    print(f"ortho: {img.size[0]} x {img.size[1]} px")


if __name__ == "__main__":
    main()
