"""Download the traffic signs and the bus stops of the area into source/geo/ (not in git).

- The traffic signs: Verkeersborden.Vlaanderen, the register of every sign on the Flemish roads, kept by
  the road agency (Agentschap Wegen en Verkeer) and the towns, via the agency's open WFS
  (https://opendata.apps.mow.vlaanderen.be/opendata-geoserver/awv/wfs). Two layers: the signs
  (Verkeersborden.Vlaanderen_Borden: the sign code, its size and how high it hangs, and which pole and
  which side of it) and the poles with their faces (Verkeersborden.Vlaanderen_OpstellingenAanzichten:
  where the pole stands and which way each face looks). Licence: Modellicentie Gratis Hergebruik v1.0,
  credit "Bron: MOW - AWV".
- The bus stops: OpenStreetMap (ODbL 1.0, credit "© OpenStreetMap contributors") via the public Overpass
  API: highway=bus_stop and the platforms, with their names and whether they have a shelter. OSM gives
  degrees (WGS84); they are turned into Lambert 72 by an affine fitted to the GRB's poles along the
  roads (WPI), fetched in both systems from geo.api.vlaanderen.be (over 2.4 km exact to a few centimetres).

The area: the rectangle round EXTENT and every strip (tools/geodata.py). Writes
source/geo/Verkeersborden_l72.json, source/geo/VerkeersbordenOpstellingen_l72.json and
source/geo/Bushaltes_l72.json. Run from the project root:
    tools/.venv/Scripts/python.exe tools/signs_data.py
"""
import json
import urllib.parse

import numpy as np

from geodata import EXTENT, GEO, STRIPS, get

AWV = "https://opendata.apps.mow.vlaanderen.be/opendata-geoserver/awv/wfs"
OVERPASS = "https://overpass-api.de/api/interpreter"
PAGE = 5000


def area():
    boxes = [EXTENT] + list(STRIPS.values())
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def wfs(layer, srs, bbox):
    """Every feature of an AWV layer in `bbox` (Lambert 72), in `srs`, page by page."""
    x0, y0, x1, y1 = bbox
    out, start = [], 0
    order = "UUID" if layer.endswith("Borden") else "id_aanzicht"  # a fixed order, so the pages don't overlap
    while True:
        url = (f"{AWV}?service=WFS&version=2.0.0&request=GetFeature&typeNames=awv:{layer}&srsName={srs}"
               f"&bbox={x0},{y0},{x1},{y1},EPSG:31370&outputFormat=application/json&count={PAGE}&startIndex={start}&sortBy={order}")
        page = json.loads(get(url))["features"]
        out += page
        if len(page) < PAGE:
            return out
        start += PAGE


def grb_poles(srs, bbox):
    x0, y0, x1, y1 = bbox
    url = (f"https://geo.api.vlaanderen.be/GRB/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=GRB:WPI&srsName={srs}"
           f"&bbox={x0},{y0},{x1},{y1},EPSG:31370&outputFormat=application/json&count=10000")
    return json.loads(get(url))["features"]


def terms(lon, lat, at):
    """The terms of a second-order fit round `at` (the projection's convergence makes a plain affine 0.3 m off)."""
    u, v = (lon - at[0]) * 100, (lat - at[1]) * 100
    return [1.0, u, v, u * u, u * v, v * v]


def degrees_to_l72(bbox):
    """(lon, lat) -> Lambert 72, fitted to the GRB's poles fetched in both systems: the fit, the degrees' box and
    the worst error (m). (The road agency's WFS rounds degrees to 3 decimals; the GRB's keeps 8.)"""
    deg = {f["id"]: f["geometry"]["coordinates"][:2] for f in grb_poles("EPSG:4326", bbox)}
    pairs = [(deg[f["id"]], f["geometry"]["coordinates"][:2]) for f in grb_poles("EPSG:31370", bbox) if f["id"] in deg]
    assert len(pairs) > 20 and all(2 < lon < 6 and 49 < lat < 52 for (lon, lat), _ in pairs), "degrees: unexpected axis order"
    at = np.mean([d for d, _ in pairs], axis=0)
    a = np.array([terms(lon, lat, at) for (lon, lat), _ in pairs])
    b = np.array([xy for _, xy in pairs])
    m, *_ = np.linalg.lstsq(a, b, rcond=None)
    err = float(np.max(np.hypot(*(a @ m - b).T)))
    # The degrees' box round bbox, from the linear part (a margin of 0.001 degree, about 70 to 110 m).
    lin = np.linalg.inv(m[1:3].T * 100)  # metres per degree, inverted
    corners = [at + lin @ (np.array([x, y]) - m[0]) for x in (bbox[0], bbox[2]) for y in (bbox[1], bbox[3])]
    box = (min(c[1] for c in corners) - 0.001, min(c[0] for c in corners) - 0.001, max(c[1] for c in corners) + 0.001, max(c[0] for c in corners) + 0.001)
    return (lambda lon, lat: np.array(terms(lon, lat, at)) @ m), box, err


def bus_stops(bbox, to_l72, box):
    """The bus stops in OpenStreetMap inside `bbox` (Lambert 72), each with its name, a shelter or not, and its spot."""
    s, w, n, e = box
    q = (f'[out:json][timeout:60];(node["highway"="bus_stop"]({s},{w},{n},{e});'
         f'node["public_transport"="platform"]["bus"="yes"]({s},{w},{n},{e}););out body;')
    data = json.loads(get(OVERPASS + "?" + urllib.parse.urlencode({"data": q})))
    feats = []
    for el in data["elements"]:
        x, y = to_l72(el["lon"], el["lat"])
        if not (bbox[0] <= x <= bbox[2] and bbox[1] <= y <= bbox[3]):
            continue
        t = el.get("tags", {})
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(float(x), 3), round(float(y), 3)]},
                      "properties": {"osm_id": el["id"], "lat": el["lat"], "lon": el["lon"], "name": t.get("name"), "shelter": t.get("shelter"), "bench": t.get("bench"),
                                     "bin": t.get("bin"), "highway": t.get("highway"), "public_transport": t.get("public_transport")}})
    return feats


def main():
    bbox = area()
    GEO.mkdir(parents=True, exist_ok=True)
    signs = wfs("Verkeersborden.Vlaanderen_Borden", "EPSG:31370", bbox)
    poles = wfs("Verkeersborden.Vlaanderen_OpstellingenAanzichten", "EPSG:31370", bbox)
    meta = {"source": "Verkeersborden.Vlaanderen (Agentschap Wegen en Verkeer), " + AWV, "licence": "Modellicentie Gratis Hergebruik v1.0",
            "credit": "Bron: MOW - AWV", "bbox": bbox}
    (GEO / "Verkeersborden_l72.json").write_text(json.dumps({"type": "FeatureCollection", "meta": meta, "features": signs}, separators=(",", ":")), encoding="utf-8")
    (GEO / "VerkeersbordenOpstellingen_l72.json").write_text(json.dumps({"type": "FeatureCollection", "meta": meta, "features": poles}, separators=(",", ":")), encoding="utf-8")
    print(f"signs: {len(signs)}, pole faces: {len(poles)}")
    to_l72, box, err = degrees_to_l72(bbox)
    print(f"degrees -> Lambert 72: worst error {err:.3f} m")
    stops = bus_stops(bbox, to_l72, box)
    (GEO / "Bushaltes_l72.json").write_text(json.dumps({"type": "FeatureCollection", "meta": {
        "source": "OpenStreetMap via " + OVERPASS, "licence": "ODbL 1.0", "credit": "© OpenStreetMap contributors", "bbox": bbox,
        "fit_error_m": err}, "features": stops}, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"bus stops: {len(stops)}")


if __name__ == "__main__":
    main()
