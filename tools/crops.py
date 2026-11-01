"""What grows on the fields: the farmers' declared crops of this year, from Flemish open data.

The Landbouwgebruikspercelen (agricultural use parcels, Departement Landbouw en Visserij, open data
under the Modellicentie Gratis Hergebruik, "Bron: Dept. LV") give the main crop of every declared
parcel, via WFS (https://geo.api.vlaanderen.be/Landbgebrperc/wfs, the most recent declarations).
Only the crop's name is used: nothing about who farms it.

`parcels` turns them into model polygons with a kind of our own: what such a field looks like at the
end of October here, which is when the game is set (web/src/world/fields.ts draws each kind):

- grass: grassland and mown fallow, which stay grass (meadows, a little rougher than a lawn);
- maize: silage and grain maize, harvested: stubble in rows 75 cm apart;
- cereal: the summer's wheat and barley are in, the next winter cereal is just up in fine lines;
- beet: fodder beet, still in the ground, broad leaves in rows 45 cm apart (chicory root likewise);
- leek: still standing, blue-green rows 75 cm apart;
- tagetes: the nurseries' nematode crop, a dense low cover with the last orange flowers;
- cover: a green cover crop (Japanese oats, mustard); fauna: a game cover, rougher and going to seed;
- avenue, fruit, shrubs, roses, hedgeplants: the tree and shrub nurseries round Lede, in rows of
  young trees or plants (from 2 m apart for avenue trees to 60 cm for hedge plants);
- fallow: fallow land left alone, rough grass.

Farm buildings, ponds and anything not listed are left to the photo (tools/street.py).

Download once into source/geo/ (not in git), for the same area as tools/geodata.py (and its strip):
    tools/.venv/Scripts/python.exe tools/crops.py
"""
import json
import sys

from geodata import EXTENT, GEO, STRIPS, get
from neighbours import features, polygons

FILE = "LBGP"  # source/geo/LBGP_l72.json, and the strip's in source/geo/strip_<name>/

# By the crop's name (LBLHFDTLT), else by its group (GEWASGROEP). None: not a field (buildings, water).
BY_NAME = {
    "Laanbomen": "avenue",
    "Boomkweek - fruitkweek": "fruit",
    "Niet-bloeiende heesters": "shrubs",
    "Rozelaars": "roses",
    "Boomkweek - bos- en haagplanten": "hedgeplants",
    "Tagetes (Afrikaantje)": "tagetes",
    "Voederbieten": "beet",
    "Suikerbieten": "beet",
    "Witloofwortel": "beet",
    "Prei - vers": "leek",
    "Faunamengsel": "fauna",
    "Japanse haver": "cover",
    "Andere niet-vlinderbloemige groenbedekker": "cover",
    "Braakliggend land met onderhoud": "grass",
    "Braakliggend land zonder onderhoud": "fallow",
    "Witloof (forcerie) - vers": None,  # forced in sheds
}
BY_GROUP = {
    "Grasland": "grass",
    "Maïs": "maize",
    "Granen, zaden en peulvruchten": "cereal",
    "Voedergewassen": "beet",
    "Houtachtige gewassen": "shrubs",
    "Landbouwinfrastructuur": None,
    "Water": None,
}


def kind(props):
    """Our kind for a parcel's properties, or None."""
    name, group = props.get("LBLHFDTLT") or "", props.get("GEWASGROEP") or ""
    if name in BY_NAME:
        return BY_NAME[name]
    if group in BY_GROUP:
        return BY_GROUP[group]
    low = name.lower()
    for word, k in (("maïs", "maize"), ("gras", "grass"), ("biet", "beet"), ("prei", "leek"), ("tarwe", "cereal"), ("gerst", "cereal"),
                    ("rogge", "cereal"), ("haver", "cereal"), ("spelt", "cereal"), ("boom", "shrubs"), ("heester", "shrubs")):
        if word in low:
            return k
    return None


def parcels(model):
    """The declared parcels as (model polygon, kind), the ones that are a field of a kind we know."""
    if not (GEO / f"{FILE}_l72.json").exists():
        return []
    out = []
    for f in features(FILE):
        k = kind(f["properties"])
        if k is None or not f.get("geometry"):
            continue
        for p in polygons(f["geometry"]):
            m = model(p).buffer(0)
            if not m.is_empty:
                out.append((m, k))
    return out


def fetch(extent):
    """The parcels over `extent` (Lambert 72), keeping only what the game uses: the crop and the parcel's number."""
    x0, y0, x1, y1 = extent
    url = ("https://geo.api.vlaanderen.be/Landbgebrperc/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=Landbgebrperc:Lbgebrperc"
           f"&srsName=EPSG:31370&bbox={x0},{y0},{x1},{y1},EPSG:31370&outputFormat=application/json&count=10000")
    data = json.loads(get(url))
    if len(data["features"]) >= 10000:
        raise SystemExit(f"{FILE}: 10000 parcels or more, fetch it in parts")
    keep = ("OIDN", "HFDTLT", "LBLHFDTLT", "GEWASGROEP")
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": f["geometry"], "properties": {k: f["properties"].get(k) for k in keep}}
                                                       for f in data["features"]]}


def main():
    for folder, extent in [(GEO, EXTENT)] + [(GEO / f"strip_{name}", e) for name, e in STRIPS.items()]:
        if not folder.exists():
            continue
        data = fetch(extent)
        (folder / f"{FILE}_l72.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        counts = {}
        for f in data["features"]:
            k = kind(f["properties"])
            counts[k] = counts.get(k, 0) + 1
        print(f"{folder.name}: {len(data['features'])} parcels {counts}")


if __name__ == "__main__":
    sys.exit(main())
