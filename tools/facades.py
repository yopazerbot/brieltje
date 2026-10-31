"""Facades and gardens of the neighbouring houses (the data has only their outlines and heights).

The open data gives each building's outline, eaves and ridge height, which wall faces the road
and which walls are shared with a neighbour (tools/neighbours.py). It says nothing about bricks,
windows or hedges, so those are made up here in the style of the street, the same every run
(seeded by position):

- A look per house: brick (red, red-brown, yellow, white-painted or grey), roof tiles (red clay,
  orange, anthracite, black or brown) and window frames (white, anthracite, brown or oak).
  An outbuilding takes the look of the main house beside it.
- Openings: a front door and wide windows on the wall facing the road, smaller windows on the
  sides, wider ones at the back; an upper row when the walls are tall enough; a window in each
  gable of a house with rooms under the roof. Shared walls stay blind. An outbuilding facing
  the road gets a garage door.
- Plot lines between gardens: a clipped hedge, a green wire fence on concrete posts, or nothing;
  lower in front gardens.

Where Street View showed a house (data/facades.json, by the house's middle in the model), its
real look replaces the made-up one: wall material, window frames, front door, an integrated
garage door (left, right or in the middle of the front), a chimney and a darker plinth.

All sizes in metres. Openings are drawn in the browser (web/src/world/surroundings.ts).
"""
import math

import numpy as np
from shapely.geometry import LineString, Point, Polygon

BRICKS = [("nb_red", 0.3), ("nb_brown", 0.25), ("nb_yellow", 0.2), ("nb_white", 0.15), ("nb_grey", 0.1)]
TILES = [("#9e4a33", 0.35), ("#b0603f", 0.1), ("#3b3c3e", 0.3), ("#28292b", 0.12), ("#5e3c30", 0.13)]
FRAMES = [("#f1efe9", 0.45), ("#3a3c3f", 0.3), ("#4c3427", 0.15), ("#9b7653", 0.1)]
DOORS = ["#6b4a32", "#2f3134", "#ece8df", "#2f4a3a", "#6a2e25"]
GARAGES = ["#ece8df", "#3a3c3f", "#7a5a3e"]


def rng_at(x, z, salt=0):
    """A random generator fixed by a position, so a house keeps its look between runs."""
    return np.random.default_rng(((int(round(x * 10)) * 73856093) ^ (int(round(z * 10)) * 19349663) ^ salt) & 0x7FFFFFFF)


def pick(rng, table):
    names, weights = zip(*table)
    return names[rng.choice(len(names), p=np.array(weights) / sum(weights))]


def looks(buildings, seen=()):
    """One look per building; an outbuilding within 12 m of a main house shares its look (and
    its walls and frames where Street View saw the house: `seen`, from data/facades.json)."""
    out = []
    mains = [(Polygon(b["p"]).buffer(0), i) for i, b in enumerate(buildings) if b["kind"] == "hoofdgebouw"]
    real = {}
    for s in seen:  # the main house that holds each surveyed point (or the nearest within 3 m)
        here = Point(*s["at"])
        poly, i = min(mains, key=lambda m: m[0].distance(here))
        if poly.distance(here) < 3:
            real[i] = s
    for k, b in enumerate(buildings):
        poly = Polygon(b["p"])
        owner, who = poly, k
        if b["kind"] != "hoofdgebouw" and mains:
            near, i = min(mains, key=lambda m: m[0].distance(poly))
            if near.distance(poly) < 12:
                owner, who = near, i
        c = owner.centroid
        rng = rng_at(c.x, c.y, 1)
        look = {"brick": pick(rng, BRICKS), "tiles": pick(rng, TILES), "frame": pick(rng, FRAMES), "door": DOORS[rng.integers(len(DOORS))]}
        s = real.get(who)
        if s:
            look.update({key: s[key] for key in ("brick", "frame", "door") if key in s})
            if who == k:  # the house itself: the parts only it has
                look.update({key: s[key] for key in ("garage", "chimney", "plinth") if key in s})
        out.append(look)
    return out


def _edge(p, i):
    a, b = np.array(p[i], float), np.array(p[(i + 1) % len(p)], float)
    return a, b


def _outward(poly, a, b):
    d = (b - a) / np.linalg.norm(b - a)
    n = np.array([d[1], -d[0]])
    mid = (a + b) / 2
    return -n if poly.contains(Point(*(mid + n * 0.2))) else n


def _row(rng, length, widths, gap, margin, door=None):
    """Spread openings along a wall: a list of (start, width, is_door) in metres from its start."""
    slots = []
    if door is not None:
        slots.append((door, 1.0, True))
    x = margin
    while x < length - margin:
        w = float(rng.uniform(*widths))
        if x + w > length - margin:
            break
        if door is None or x + w <= door - gap or x >= door + 1.0 + gap:
            slots.append((x, w, False))
            x += w + gap * float(rng.uniform(1, 1.6))
        else:
            x = door + 1.0 + gap
    return sorted(slots)


def openings(b, look, roofs, others):
    """Windows, doors and gable windows of one building. `roofs`: its roof parts (corners p with
    p0-p1 along the ridge, shape, eaves and ridge); `others`: footprints of the buildings
    around (to keep gables against a neighbour blind)."""
    out = []
    poly = Polygon(b["p"])
    if not poly.is_valid or poly.area < 6:
        return out
    c = poly.centroid
    rng = rng_at(c.x, c.y, 2)
    base, h = b["base"], b["eaves"]
    main = b["kind"] == "hoofdgebouw"
    n = len(b["p"])
    front = b.get("front", -1)
    front_n = _outward(poly, *_edge(b["p"], front)) if front >= 0 else None

    def add(a, d, normal, x0, w, y0, y1, kind, color=None):
        p0, p1 = a + d * x0, a + d * (x0 + w)
        o = {"a": [round(float(p0[0]), 2), round(float(p0[1]), 2)], "b": [round(float(p1[0]), 2), round(float(p1[1]), 2)],
             "n": [round(float(normal[0]), 3), round(float(normal[1]), 3)], "y": [round(base + y0, 2), round(base + y1, 2)], "k": kind, "f": look["frame"]}
        if color:
            o["c"] = color
        out.append(o)

    if not main:
        # Outbuilding: a garage door facing the road, otherwise a small window and a door.
        if front >= 0 and h >= 2.2:
            a, e = _edge(b["p"], front)
            length = float(np.linalg.norm(e - a))
            if 2.8 <= length <= 8:
                w = min(2.6, length - 0.6)
                add(a, (e - a) / length, _outward(poly, a, e), (length - w) / 2, w, 0, min(2.15, h - 0.25), "g", GARAGES[rng.integers(len(GARAGES))])
                return out
        walls = sorted((i for i in range(n) if i not in b.get("shared", [])), key=lambda i: -np.linalg.norm(np.subtract(*_edge(b["p"], i))))
        for k, i in enumerate(walls[:2]):
            a, e = _edge(b["p"], i)
            length = float(np.linalg.norm(e - a))
            if length < 2.5 or rng.random() < 0.4:
                continue
            d = (e - a) / length
            if k == 0:
                add(a, d, _outward(poly, a, e), length / 2 - 0.4, 0.8, 1.2, 2.0, "w")
            else:
                add(a, d, _outward(poly, a, e), length / 2 - 0.45, 0.9, 0, min(2.05, h - 0.2), "d", look["door"])
        return out

    upper = h >= 4.8
    for i in range(n):
        if i in b.get("shared", []):
            continue
        a, e = _edge(b["p"], i)
        length = float(np.linalg.norm(e - a))
        if length < 1.8:
            continue
        d = (e - a) / length
        normal = _outward(poly, a, e)
        facing = 0 if front_n is None else float(normal @ front_n)
        head = min(2.2, h - 0.3)
        if i == front and look.get("garage") and length > 7:
            # The garage door at the side Street View showed (seen from the road), the rest as usual.
            g = look["garage"]
            gw = 2.6
            side = g["where"]
            # Seen from the road the wall runs from a to e left to right when (normal . (d_z, -d_x)) < 0.
            at = (length - gw) / 2 if side == "centre" else 0.5 if (side == "left") == (float(normal @ np.array([d[1], -d[0]])) < 0) else length - gw - 0.5
            add(a, d, normal, at, gw, 0, min(2.2, h - 0.25), "g", g.get("colour") or GARAGES[0])
            free0, free1 = (at + gw + 0.8, length) if at < length / 2 else (0.0, at - 0.8)
            door = free0 + float(rng.uniform(0.2, 0.6) * max(0.0, free1 - free0 - 1.0)) if free1 - free0 > 2 else None
            slots = [(x0 + free0, w, is_door) for x0, w, is_door in _row(rng, free1 - free0, (1.3, 1.9), 0.8, 0.5, None if door is None else door - free0)]
        elif i == front:
            door = float(rng.uniform(0.25, 0.65) * (length - 1.0)) if length > 3 else None
            slots = _row(rng, length, (1.3, 1.9), 0.8, 0.6, door)
        elif facing < -0.7:  # the back: wide windows and a garden door
            slots = _row(rng, length, (1.6, 2.6), 1.0, 0.7)
        else:
            slots = _row(rng, length, (0.9, 1.3), 1.6, 0.9)
            if length < 6 and len(slots) > 1:
                slots = slots[:1]
        for x0, w, is_door in slots:
            if is_door:
                add(a, d, normal, x0, 1.0, 0, min(2.2, h - 0.25), "d", look["door"])
            elif facing < -0.7 and w > 2.2:
                add(a, d, normal, x0, w, 0.05, head, "w")  # sliding door to the garden
            else:
                add(a, d, normal, x0, w, 0.9, head, "w")
            if upper and not is_door:
                add(a, d, normal, x0, min(w, 1.6), 3.8, min(5.0, h - 0.25), "w")
            elif upper and is_door:
                add(a, d, normal, x0 - 0.1, 1.2, 3.8, min(5.0, h - 0.25), "w")

    # Rooms under the roof: a window in each free gable (gable roofs only: p1-p2 and p3-p0 are its ends).
    for part in roofs:
        ph, pr = part["eaves"], part["ridge"]
        if part["shape"] != "gable" or pr - ph < 3.0:
            continue
        pts = [np.array(q, float) for q in part["p"]]
        for k in (1, 3):
            a, e = pts[k], pts[(k + 1) % 4]
            width = float(np.linalg.norm(e - a))
            mid = Point(*((a + e) / 2))
            if width < 3 or any(o.distance(mid) < 0.8 for o in others):
                continue
            d = (e - a) / width
            normal = _outward(Polygon(part["p"]), a, e)
            y0 = ph + 0.7
            if 1.1 + 0.4 > width * (1 - (y0 + 1.1 - ph) / (pr - ph)):
                continue  # no room in the triangle
            add(a, d, normal, width / 2 - 0.5, 1.0, y0, y0 + 1.1, "w")
    return out


def garden_lines(bounds, hedges=True):
    """Hedge, fence or nothing per plot line (the same along one whole boundary). Returns
    (hedges, fences): each a list of (path, height). Without `hedges` (the real hedges come
    from the aerial photo) a line gets a fence or nothing."""
    out_hedges, fences = [], []
    for line in bounds:
        path = line["path"]
        rng = rng_at(*line["line"], 3)
        r = rng.random()
        if hedges and r < 0.5:
            out_hedges.append((path, 0.9 if line["low"] else float(rng.uniform(1.5, 1.9))))
        elif r < 0.85 if hedges else r < 0.6:
            fences.append((path, 1.0 if line["low"] else 1.25))
    return out_hedges, fences


def posts(path, height, spacing=2.5):
    """Concrete fence posts along a path: [x, z, height] every `spacing` metres and at the ends."""
    line = LineString(path)
    count = max(1, math.ceil(line.length / spacing))
    out = []
    for k in range(count + 1):
        p = line.interpolate(k / count, normalized=True)
        out.append([round(p.x, 2), round(p.y, 2), round(height + 0.05, 2)])
    return out
