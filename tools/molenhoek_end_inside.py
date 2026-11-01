"""The inside of the end house of the new terrace at Molenhoek, near the junction with Oordegemkouter: two floors, as
built in the game, with the doors, glass, stair, floors, ceilings and furniture, for walking into
(web/src/world/walkIn.ts). The outside is tools/molenhoek.py's (its openings: tools/molenhoek_end_survey.py), so the
walls, openings and floor level here are read from data/molenhoek_end3.json and fit it to the centimetre.

Run from the project root after tools/molenhoek_end_survey.py:
    tools/.venv/Scripts/python.exe tools/molenhoek_end_inside.py

Ground floor (the front's pavement level): the entrance with its cloakroom, the WC, the living room with the dining
corner by the glass of the cut corner, the kitchen along the party wall and the back (an L of white handleless units
with an oak worktop, tall units with the oven, an island), the stair (a straight flight up from the living room
with a quarter turn of winders at the top, open oak treads, an oak handrail on steel tubes) and the garage behind
its sectional door, empty but for a utility corner. First floor (2.90 m up): the landing round the stair, the office,
three bedrooms and the bathroom (a walk-in shower, a toilet, two basins). The terrace behind the house, 3 m deep,
wraps round the cut corner. Colours and furniture: grey floor tiles of 80 cm with grey skirting, white walls,
white flush doors, white frames inside, grey-blue curtains by the glass, a round oak table with tan shell chairs
under a white dome light, a taupe corner sofa, a white oval coffee table, a low white TV unit, a knitted cream lamp
shade.

Laid out in floor coordinates (seen from above): u along the front from the free corner towards the party wall, v from the front's
outer face inwards, metres; heights from the ground floor. Written in the house's own frame: x = -u, z = v (so the
game turns it into place without mirroring), with `frame`: the free corner in the world, the turn (radians, as
three.js turns about y) and the ground floor's height. Blocks are drawn (`v`) and walked into (`s`) unless told
otherwise: the outer 13 cm of the walls are the street model's, so the walls drawn here start behind them.
"""
import json
import math
from pathlib import Path

import shapely
from shapely.geometry import LineString, Polygon, box as sbox
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
KEY = "b712l_row_end"
GROUND = -0.1  # the main house's ground in the game (tools/molenhoek.py)
EXT, PARTY = 0.40, 0.20  # wall thicknesses: the cavity walls, this house's half of the party wall
SKIN = 0.13  # the street model's outer face to its panes: the walls drawn here start behind it
GF_CEIL, F1, F1_CEIL, ROOF = 2.60, 2.90, 5.50, 5.88  # ground floor ceiling, first floor, its ceiling, the roof slab's top
ROOF_TOP, COPING = 5.93, 6.05  # the street model's roofing and coping (tools/molenhoek.py flat_roof)
DOOR_H = 2.11  # inside doors
RISERS = 16

# Colours (as the game lights them)
WHITE, OFFWHITE, GREY_SKIRT, DARK = "#efede8", "#f4f2ee", "#8d8e8c", "#2b2b2d"
OAK, OAK_DARK, TAN, BLACK, STEEL = "#c79d6c", "#9c7a55", "#93603d", "#1c1c1e", "#a9adb1"
FRAME_IN, ANTH = "#f1f1ee", "#3a3d40"


def load_house():
    d = json.loads((ROOT / "data" / "molenhoek_end3.json").read_text(encoding="utf-8"))
    return d["houses"][KEY]


H = load_house()
RING = [tuple(p) for p in H["main"]]  # the GRB outline, world x, z
A = tuple(H["front"][0])  # the free corner, where the front starts
B = tuple(H["front"][1])
_L = math.dist(A, B)
T = ((B[0] - A[0]) / _L, (B[1] - A[1]) / _L)  # along the front, towards the party wall
N = (T[1], -T[0])  # into the house (perpendicular to the front)
assert N[0] * H["out"][0] + N[1] * H["out"][1] < -0.99
FLOOR = H["y0"] + 0.05 + GROUND  # the ground floor in the game's heights (tools/molenhoek.py: base = y0 + 0.05)


def uv(p):
    dx, dz = p[0] - A[0], p[1] - A[1]
    return (dx * T[0] + dz * T[1], dx * N[0] + dz * N[1])


def world(u, v):
    return (A[0] + u * T[0] + v * N[0], A[1] + u * T[1] + v * N[1])


def out(u, v):
    """The house's own frame: x = -u, z = v."""
    return [round(-u, 3), round(v, 3)]


# ---------------------------------------------------------------- the shell
RUV = [uv(p) for p in RING]
OUTER = Polygon(RUV)
PARTY_EDGE = H["main_party"].index(True)


def edge(i):
    return RUV[i], RUV[(i + 1) % len(RUV)]


def inward(i):
    (au, av), (bu, bv) = edge(i)
    L = math.hypot(bu - au, bv - av)
    t = ((bu - au) / L, (bv - av) / L)
    n = (-t[1], t[0])
    c = OUTER.centroid
    if (c.x - au) * n[0] + (c.y - av) * n[1] < 0:
        n = (-n[0], -n[1])
    return t, n, L


def inset(depths):
    """The outline with each edge moved inwards by its depth."""
    poly = OUTER
    for i in range(len(RUV)):
        (au, av), _ = edge(i)
        t, n, L = inward(i)
        d = depths[i]
        p0 = (au + n[0] * d - t[0] * 50, av + n[1] * d - t[1] * 50)
        p1 = (au + n[0] * d + t[0] * 50, av + n[1] * d + t[1] * 50)
        half = Polygon([p0, p1, (p1[0] + n[0] * 50, p1[1] + n[1] * 50), (p0[0] + n[0] * 50, p0[1] + n[1] * 50)])
        poly = poly.intersection(half)
    return poly


THICK = [PARTY if i == PARTY_EDGE else EXT for i in range(len(RUV))]
INNER = inset(THICK)
DRAWN = inset([0.05 if i == PARTY_EDGE else SKIN for i in range(len(RUV))])


def builder_frame(i):
    """Edge i as tools/molenhoek.py lays openings along it: from its left end as seen from outside."""
    n = len(RING)
    p, q = RING[i], RING[(i + 1) % n]
    area = sum(RING[k][0] * RING[(k + 1) % n][1] - RING[(k + 1) % n][0] * RING[k][1] for k in range(n))
    L = math.dist(p, q)
    tx, tz = (q[0] - p[0]) / L, (q[1] - p[1]) / L
    o = (tz, -tx) if area > 0 else (-tz, tx)
    if not ((q[0] - p[0]) * o[1] - (q[1] - p[1]) * o[0] >= 0):
        p, q = q, p
        tx, tz = -tx, -tz
    return p, (tx, tz), L


def nearest_edge(pt):
    best, bi = 1e9, 0
    for i in range(len(RING)):
        p, q = RING[i], RING[(i + 1) % len(RING)]
        L = math.dist(p, q)
        t = ((q[0] - p[0]) / L, (q[1] - p[1]) / L)
        s = max(0, min(L, (pt[0] - p[0]) * t[0] + (pt[1] - p[1]) * t[1]))
        d = math.dist(pt, (p[0] + t[0] * s, p[1] + t[1] * s))
        if d < best:
            best, bi = d, i
    return bi


class Opening:
    def __init__(self, i, s, w, y0, h, kind, opt):
        p, t, _ = builder_frame(i)
        wa = (p[0] + t[0] * (s - w / 2), p[1] + t[1] * (s - w / 2))
        wb = (p[0] + t[0] * (s + w / 2), p[1] + t[1] * (s + w / 2))
        self.i, self.kind, self.opt = i, kind, opt
        self.a, self.b = uv(wa), uv(wb)  # its ends on the outer face, floor coordinates
        self.y0, self.y1 = y0, y0 + h
        tt, self.n, _ = inward(i)
        L = math.dist(self.a, self.b)
        self.t = ((self.b[0] - self.a[0]) / L, (self.b[1] - self.a[1]) / L)
        self.w = L
        self.depth = THICK[i]
        near = lambda q: min(math.dist(q, r) for r in RUV) < 0.15
        self.corner_a, self.corner_b = near(self.a), near(self.b)

    def at(self, s, d):
        """A point s along the opening from its end a, d into the wall from the outer face."""
        return (self.a[0] + self.t[0] * s + self.n[0] * d, self.a[1] + self.t[1] * s + self.n[1] * d)

    def quad(self, s0, s1, d0, d1):
        return Polygon([self.at(s0, d0), self.at(s1, d0), self.at(s1, d1), self.at(s0, d1)])

    def cut(self):
        return self.quad(0, self.w, -0.05, self.depth + 0.05)

    def pane_span(self):
        """Where the glass runs: from post to post, short of the other wall's glass at a glass corner."""
        return (0.155 if self.corner_a else 0.0), self.w - (0.155 if self.corner_b else 0.0)


FRONT_EDGE = nearest_edge(((A[0] + B[0]) / 2, (A[1] + B[1]) / 2))
OPENINGS = [Opening(FRONT_EDGE, *o) for o in H["openings"]]
for face in H.get("faces", []):
    i = nearest_edge(tuple(face["near"]))
    OPENINGS += [Opening(i, *o) for o in face["openings"]]


def find(kind, y0, near_uv):
    """The opening of a kind, starting at a height, nearest a floor point."""
    c = [o for o in OPENINGS if o.kind == kind and abs(o.y0 - y0) < 0.05]
    return min(c, key=lambda o: math.dist(((o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2), near_uv))


# ---------------------------------------------------------------- output
PRISMS, PARTS, FIXTURES, PROPS, DOORS, PANES = [], [], [], [], [], []


def rings(poly):
    polys = getattr(poly, "geoms", [poly])
    for p in polys:
        if p.is_empty or p.area < 1e-4 or p.geom_type != "Polygon":
            continue
        p = p.simplify(0.002)
        yield [[out(x, y) for x, y in list(p.exterior.coords)[:-1]]] + [[out(x, y) for x, y in list(h.coords)[:-1]] for h in p.interiors]


def prism(poly, y0, y1, m, c=None, n=None, solid=True, drawn=True):
    for r in rings(poly):
        e = {"m": m, "y0": round(y0, 3), "y1": round(y1, 3), "p": r}
        if c:
            e["c"] = c
        if n:
            e["n"] = n
        if not solid:
            e["s"] = 0
        if not drawn:
            e["v"] = 0
        PRISMS.append(e)


def rect(u0, v0, u1, v1):
    return sbox(min(u0, u1), min(v0, v1), max(u0, u1), max(v0, v1))


def p3(u, y, v):
    return [round(-u, 3), round(y, 3), round(v, 3)]


def yaw_to(du, dv):
    """The turn (three.js, about y) that points a piece's front (+z) along the floor direction (du, dv)."""
    return round(math.atan2(-du, dv), 4)


def part_box(u, v, y, w, h, d, yaw_dir, color, group="c"):
    """A box standing on y, centred on (u, v): w across, d deep along its facing (du, dv), h high."""
    PARTS.append(["b", *p3(u, y, v), round(w, 3), round(h, 3), round(d, 3), yaw_to(*yaw_dir), color, group])


def part_rod(a, b, r, color, seg=8):
    PARTS.append(["r", *p3(*a), *p3(*b), round(r, 4), color, seg])


def part_lathe(u, v, y, profile, color, seg=24):
    PARTS.append(["l", *p3(u, y, v), [[round(r, 3), round(h, 3)] for r, h in profile], color, seg])


def part_oval(u, v, y, ru, rv, h, color):
    PARTS.append(["e", *p3(u, y, v), round(ru, 3), round(rv, 3), round(h, 3), color])


def part_beam(a, b, w, h, color):
    """A box from a to b (u, y, v), w across horizontally and h high."""
    PARTS.append(["k", *p3(*a), *p3(*b), round(w, 3), round(h, 3), color])


def part_sheet(a, b, y0, y1, amp, folds, color):
    """A curtain from a to b on the floor, gathered in `folds` folds of depth amp."""
    PARTS.append(["s", *out(*a), *out(*b), round(y0, 3), round(y1, 3), round(amp, 3), folds, color])


def fixture(item, u, v, y, face, size):
    FIXTURES.append({"item": item, "x": round(-u, 3), "y": round(y, 3), "z": round(v, 3), "yaw": yaw_to(*face), "size": [round(s, 3) for s in size]})


def block(u, v, w, d, face, y0, y1, room):
    """What a piece of furniture blocks: its footprint (w across, d along `face`), walked into, not drawn."""
    fu, fv = face
    L = math.hypot(fu, fv)
    fu, fv = fu / L, fv / L
    su, sv = fv, -fu
    pts = [(u + su * a * w / 2 + fu * b * d / 2, v + sv * a * w / 2 + fv * b * d / 2) for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    prism(Polygon(pts), y0, y1, "c", n=room, drawn=False)


# ---------------------------------------------------------------- walls
def head_room(o):
    """How high an opening is for walking through: the front door 25 cm more than it shows, as the pavement in front
    of it lies about 35 cm above the floor (the street model's floor level is the village block's foot), and from
    there a head would only just clear the lintel. The closed leaf and the lintel still leave no gap between them."""
    return o.y1 + (0.25 if o.kind == "d" and o.opt.get("frost") else 0.0)


def exterior_walls():
    band_solid = OUTER.difference(INNER)
    band_drawn = DRAWN.difference(INNER)
    ys = sorted({-0.3, ROOF, COPING} | {o.y0 for o in OPENINGS} | {o.y1 for o in OPENINGS} | {head_room(o) for o in OPENINGS})
    for ya, yb in zip(ys, ys[1:]):
        shown = unary_union([o.cut() for o in OPENINGS if o.y0 <= ya + 1e-6 and o.y1 >= yb - 1e-6] or [Polygon()])
        walked = unary_union([o.cut() for o in OPENINGS if o.y0 <= ya + 1e-6 and head_room(o) >= yb - 1e-6] or [Polygon()])
        if yb <= ROOF + 1e-6:
            prism(band_drawn.difference(shown), ya, yb, "wall", solid=False)
        prism(band_solid.difference(walked), ya, yb, "c", drawn=False)


# The inside doors: where each stands (its hinge, the other end of its leaf's opening), which way it opens, and the
# gap it leaves in its wall: 0.90 m wide.
INSIDE_DOORS = [
    ("mh-end-wc", "door to WC", "gf", (1.35, 2.08), (1.35, 1.18), (-1, 0)),  # into the WC, against its back wall
    ("mh-end-living", "door to Living", "gf", (1.70, 2.15), (2.60, 2.15), (0, 1)),
    ("mh-end-garage", "door to Garage", "gf", (4.575, 0.45), (4.575, 1.35), (-1, 0)),
    ("mh-end-bedroom3", "door to Slaapkamer 3", "f1", (3.325, 3.70), (3.325, 4.60), (-1, 0)),
    ("mh-end-office", "door to Bureau", "f1", (3.325, 6.90), (3.325, 6.00), (-1, 0)),
    ("mh-end-bedroom2", "door to Slaapkamer 2", "f1", (3.50, 3.525), (4.40, 3.525), (0, -1)),
    ("mh-end-bath", "door to Badkamer", "f1", (4.575, 3.70), (4.575, 4.60), (1, 0)),
    ("mh-end-bedroom1", "door to Slaapkamer 1", "f1", (4.40, 8.075), (5.30, 8.075), (0, 1)),
]


def gap(a, b):
    """A door's gap through its wall."""
    if abs(a[0] - b[0]) < 1e-6:
        return rect(a[0] - 0.12, a[1], a[0] + 0.12, b[1])
    return rect(a[0], a[1] - 0.12, b[0], a[1] + 0.12)


GAPS = {d[0]: gap(d[3], d[4]) for d in INSIDE_DOORS}


def wall(poly, y0, y1, gaps=(), head=DOOR_H):
    """An inside wall from y0 to y1, with door gaps up to `head` above y0."""
    if gaps:
        prism(poly.difference(unary_union(gaps)), y0, y0 + head, "wall")
        prism(poly, y0 + head, y1, "wall")
    else:
        prism(poly, y0, y1, "wall")


def inside_walls():
    g, f = 0.0, F1
    # Ground floor
    wall(rect(1.30, 0.3, 1.40, 2.20), g, GF_CEIL, [GAPS["mh-end-wc"]])  # the WC's side, its door
    wall(rect(0.3, 2.10, 4.50, 2.20), g, GF_CEIL, [GAPS["mh-end-living"]])  # the WC's back and the entrance's, the living room door
    wall(rect(4.50, 0.3, 4.65, 6.05), g, GF_CEIL, [GAPS["mh-end-garage"]])  # the garage's side, its door from the entrance
    wall(rect(4.65, 5.90, 7.9, 6.05), g, GF_CEIL)  # the garage's back, the stair behind it
    # First floor
    wall(rect(3.25, 0.3, 3.40, 8.15), f, F1_CEIL, [GAPS["mh-end-bedroom3"], GAPS["mh-end-office"]])  # bedroom 3 and the office
    wall(rect(0.3, 4.70, 3.30, 4.85), f, F1_CEIL)  # bedroom 3's back
    wall(rect(3.30, 3.45, 7.9, 3.60), f, F1_CEIL, [GAPS["mh-end-bedroom2"]])  # bedroom 2's back, its door
    wall(rect(4.50, 3.55, 4.65, 6.05), f, F1_CEIL, [GAPS["mh-end-bath"]])  # the bathroom's side, its door
    wall(rect(4.60, 5.90, 7.9, 6.05), f, F1_CEIL)  # the bathroom's back, over the garage's
    wall(rect(3.25, 8.00, 7.9, 8.15), f, F1_CEIL, [GAPS["mh-end-bedroom1"]])  # bedroom 1's front, its door
    wall(PARTITION, f, F1_CEIL)  # between the office and bedroom 1, square to the cut corner
    wall(rect(4.11, 8.10, 4.21, 10.39), f, F1_CEIL)  # bedroom 1's dressing


# The office's slanted wall: from the corner of the landing square to the glass of the cut corner.
_DI = [i for i in range(len(RUV)) if i not in (PARTY_EDGE, FRONT_EDGE)]
DIAG_EDGE = max(_DI, key=lambda i: abs(inward(i)[1][0] * inward(i)[1][1]))  # the cut corner: its normal is the most slanted
_dt, _dn, _ = inward(DIAG_EDGE)
_d0 = edge(DIAG_EDGE)[0]
K = (3.325, 8.075)
_k = (K[0] - _d0[0]) * _dn[0] + (K[1] - _d0[1]) * _dn[1]
J = (K[0] - _dn[0] * (_k - EXT), K[1] - _dn[1] * (_k - EXT))
PARTITION = LineString([(K[0] + _dn[0] * 0.08, K[1] + _dn[1] * 0.08), (J[0] - _dn[0] * 0.2, J[1] - _dn[1] * 0.2)]).buffer(0.05, cap_style=2)


# ---------------------------------------------------------------- rooms and floors
def rooms():
    big = 30.0
    gf = {
        "WC": rect(-1, -1, 1.35, 2.15),
        "Inkom": rect(1.35, -1, 4.575, 2.15),
        "Garage": rect(4.575, -1, big, 5.975),
        "Keuken": rect(5.30, 6.95, big, big),
    }
    gf["Living"] = INNER.difference(unary_union(list(gf.values())))
    gf = {k: INNER.intersection(p) for k, p in gf.items()}
    well = rect(4.65, 6.05, big, 6.95)
    office_cut = Polygon([(K[0] + _dn[0] * big, K[1] + _dn[1] * big), (K[0] - _dn[0] * big, K[1] - _dn[1] * big),
                          (K[0] - _dn[0] * big - _dt[0] * big, K[1] - _dn[1] * big - _dt[1] * big),
                          (K[0] + _dn[0] * big - _dt[0] * big, K[1] + _dn[1] * big - _dt[1] * big)])  # the office's side of its slanted wall
    f1 = {
        "Slaapkamer 3": rect(-1, -1, 3.325, 4.775),
        "Bureau": rect(-1, 4.775, 3.325, big).intersection(office_cut),
        "Slaapkamer 2": rect(3.325, -1, big, 3.525),
        "Badkamer": rect(4.575, 3.525, big, 5.975),
        "Nachthall": unary_union([rect(3.325, 3.525, 4.575, 8.075), rect(3.325, 5.975, big, 8.075)]),
    }
    f1["Slaapkamer 1"] = INNER.difference(unary_union(list(f1.values())))
    f1 = {k: INNER.intersection(p).difference(well) for k, p in f1.items()}
    return gf, f1, well


GF_ROOMS, F1_ROOMS, WELL = rooms()
FLOORS = {"Inkom": "tile", "WC": "tile", "Living": "tile", "Keuken": "tile", "Garage": "concrete",
          "Slaapkamer 1": "wood", "Slaapkamer 2": "wood", "Slaapkamer 3": "wood", "Bureau": "wood", "Nachthall": "wood", "Badkamer": "bath"}
TINT = {"tile": "#b3b4b3", "concrete": "#9a9b99", "wood": "#d4cec4", "bath": "#ededeb"}


def floors():
    for name, poly in GF_ROOMS.items():
        prism(poly, -0.3, 0.0, FLOORS[name], TINT[FLOORS[name]], n=name)
    prism(INNER.difference(WELL), GF_CEIL, F1 - 0.06, "ceiling")
    for name, poly in F1_ROOMS.items():
        prism(poly, F1 - 0.06, F1, FLOORS[name], TINT[FLOORS[name]], n=name)
    prism(INNER, F1_CEIL, ROOF, "ceiling")
    prism(INNER, ROOF, ROOF_TOP, "c", drawn=False)  # the roof, to stand on


def skirting():
    """Low skirting along the walls: grey by the grey tiles downstairs, white upstairs; none at doors and glass to the floor."""
    def free(level):
        walls = [Polygon([(-x, z) for x, z in p["p"][0]]) for p in PRISMS if p["m"] == "wall" and p.get("s", 1) and level(p)]
        return INNER.difference(unary_union(walls))
    low = [o.cut().buffer(0.02) for o in OPENINGS if o.y0 < 0.05]
    doors = list(GAPS.values())
    for lv, y, col, skip in ((lambda p: p["y0"] < 1.0, 0.0, GREY_SKIRT, ("Garage",)), (lambda p: 2.8 < p["y0"] < 4.0, F1, WHITE, ("Badkamer",))):
        area = free(lv)
        if y > 1:
            area = area.difference(WELL.buffer(0.1))
        band = area.difference(area.buffer(-0.012, join_style=2)).difference(unary_union(low + doors))
        rooms_here = GF_ROOMS if y < 1 else F1_ROOMS
        band = band.difference(unary_union([rooms_here[k] for k in skip]))
        prism(band, y, y + 0.07, "c", col, solid=False)


# ---------------------------------------------------------------- windows: glass, frames, boards
def glazing():
    door_like = []
    for o in OPENINGS:
        if o.kind == "g":
            continue
        s0, s1 = o.pane_span()
        if o.kind == "d" and o.opt.get("frost"):
            door_like.append(o)
            continue
        if o.kind == "d" and o.opt.get("div"):
            door_like.append(o)
            big, _, _ = slider_layout(o)  # the large fixed pane: glass of its own (the sliding door: doors below)
            pane(o, max(big[0], s0), min(big[1], s1), o.y0, o.y1)
            mid = big[0] if big[0] > 0.1 else big[1]
            prism(o.quad(mid - 0.035, mid + 0.035, 0.12, 0.20), o.y0, o.y1, "c", FRAME_IN, solid=False)
            continue
        pane(o, s0, s1, o.y0, o.y1)
        frame(o, s0, s1)
        if o.y0 > 0.5:  # a board under it inside, dark stone
            prism(o.quad(-0.03, o.w + 0.03, 0.20, o.depth + 0.025), o.y0 - 0.03, o.y0, "c", "#3e3f41", solid=False)
    return door_like


def pane(o, s0, s1, y0, y1, matte=False, d=(0.135, 0.155)):
    e = {"p": next(rings(o.quad(s0, s1, *d))), "y0": round(y0, 3), "y1": round(y1, 3)}
    if matte:
        e["matte"] = 1
    PANES.append(e)


def frame(o, s0, s1, col=FRAME_IN, fw=0.06):
    """White frames round the glass inside (anthracite outside: the street model's)."""
    d0, d1 = 0.12, 0.20
    a0 = 0.08 if o.corner_a else 0.0
    b1 = o.w - (0.08 if o.corner_b else 0.0)
    prism(o.quad(a0, s0 + fw, d0, d1), o.y0, o.y1, "c", col, solid=False)
    prism(o.quad(s1 - fw, b1, d0, d1), o.y0, o.y1, "c", col, solid=False)
    prism(o.quad(s0, s1, d0, d1), o.y1 - fw, o.y1, "c", col, solid=False)
    prism(o.quad(s0, s1, d0, d1), o.y0, o.y0 + fw, "c", col, solid=False)


def slider_layout(o):
    """A glass wall parted by `div`: its largest part fixed glass; the two at the other end the sliding door, the one
    at the end sliding in front of its neighbour. Returns their spans along the opening."""
    cuts = [0.0] + list(o.opt["div"]) + [1.0]
    segs = [(cuts[k] * o.w, cuts[k + 1] * o.w) for k in range(len(cuts) - 1)]
    big = max(range(len(segs)), key=lambda k: segs[k][1] - segs[k][0])
    if big == len(segs) - 1:
        return segs[big], segs[1], segs[0]
    return segs[big], segs[-2], segs[-1]


def to_xz(p):
    return out(*p)


def doors(door_like):
    front = next(o for o in door_like if o.opt.get("frost"))
    slider = next(o for o in door_like if o.opt.get("div"))
    # The front door: the leaf hinged on the left as seen from the street, opening inwards; the frosted side light
    # on its right. Anthracite aluminium, three frosted panes between broad rails, a long bar handle.
    side_w = front.opt["side"][0]
    leaf = (0.0, front.w - side_w)
    d = 0.17
    hinge, tip = front.at(leaf[0], d), front.at(leaf[1], d)
    DOORS.append(door("mh-end-front", "front door", "gf", 0.0, front.y1 - 0.01, [
        panel(hinge, tip, 0.06, glass=True, matte=True, color=ANTH, frost=3, swing=into(hinge, tip, front.n, 1.6), outside=outside_side(hinge, tip, front.n)),
    ]))
    frame(front, 0.0, front.w, ANTH, 0.04)
    fixed_light(front, leaf[1], front.w, 0.0, front.y1 - 0.01, ANTH, ANTH, 0.14, 0.20, matte=True)  # the side light
    # The sliding door to the terrace: two panels of the glass along the cut corner, the one at the end sliding in
    # front of its fixed neighbour, towards the large pane; white frames inside, anthracite outside.
    _, fixed, moving = slider_layout(slider)
    lo, hi = slider.pane_span()
    end = lo if moving[0] < fixed[0] else hi  # the moving panel's free end, at the jamb
    join = moving[1] if moving[0] < fixed[0] else moving[0]
    far = fixed[1] if moving[0] < fixed[0] else fixed[0]
    d = 0.165
    a_far, a_join, a_end = slider.at(far, d), slider.at(join, d), slider.at(end, d)
    vec = (a_far[0] - a_join[0], a_far[1] - a_join[1])
    L = math.hypot(*vec)
    run = abs(join - end)
    shift = (vec[0] / L * run, vec[1] / L * run)  # as far as it is wide, over its fixed neighbour
    side = outside_side(a_join, a_end, slider.n)
    inward_off = 0.06 if normal_xz(a_join, a_end)[0] * slider.n[0] + normal_xz(a_join, a_end)[1] * slider.n[1] > 0 else -0.06
    DOORS.append(door("mh-end-terrace", "sliding door", "gf", 0.0, slider.y1 - 0.01, [
        panel(a_join, a_end, 0.05, glass=True, color=FRAME_IN, color_out=ANTH, outside=side, frame=0.07, offset=inward_off,
              slide=[round(-shift[0], 3), round(shift[1], 3)]),
    ]))
    frame(slider, lo, hi)
    fixed_light(slider, min(far, join), max(far, join), 0.0, slider.y1 - 0.01, FRAME_IN, ANTH, 0.14, 0.19)  # its fixed neighbour
    # Inside doors: white flush leaves with steel levers, 0.88 m in openings of 0.90.
    for did, name, level, a, b, towards in INSIDE_DOORS:
        y0 = 0.0 if level == "gf" else F1
        L = math.dist(a, b)
        t = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
        a = (a[0] + t[0] * 0.01, a[1] + t[1] * 0.01)
        b = (a[0] + t[0] * 0.88, a[1] + t[1] * 0.88)
        DOORS.append(door(did, name, level, y0, y0 + DOOR_H - 0.01, [panel(a, b, 0.04, swing=into(a, b, towards, 1.6))]))


def fixed_light(o, s0, s1, y0, y1, inner, outer, d0, d1, matte=False, fw=0.07):
    """A fixed glazed panel in an opening, from s0 to s1 along it: its frame (the inner half in one colour, the outer
    in another) and its pane, which breaks like the windows'."""
    dm = (d0 + d1) / 2
    for a, b, ya, yb in ((s0, s0 + fw, y0, y1), (s1 - fw, s1, y0, y1), (s0 + fw, s1 - fw, y0, y0 + fw), (s0 + fw, s1 - fw, y1 - fw, y1)):
        prism(o.quad(a, b, d0, dm), ya, yb, "c", outer)
        prism(o.quad(a, b, dm, d1), ya, yb, "c", inner)
    pane(o, s0 + fw, s1 - fw, y0 + fw, y1 - fw, matte=matte, d=(dm - 0.006, dm + 0.006))


def door(did, name, level, y0, y1, panels):
    return {"id": did, "name": name, "level": level, "y0": round(y0, 3), "y1": round(y1, 3), "panels": panels}


def panel(a, b, thick, glass=False, swing=None, slide=None, outside=None, matte=False, color=None, color_out=None, frost=None,
          handle=True, frame=None, offset=0.0):
    p = {"a": to_xz(a), "b": to_xz(b), "offset": round(offset, 3), "thickness": thick, "glass": glass}
    for k, v in (("swing", swing), ("slide", slide), ("outside", outside), ("color", color), ("colorOut", color_out), ("frost", frost), ("frame", frame)):
        if v is not None:
            p[k] = v
    if matte:
        p["matte"] = True
    if not handle:
        p["handle"] = False
    return p


def normal_xz(a, b):
    """A panel's normal in the game (doors.ts: (-dir.y, dir.x) of a to b), in floor coordinates."""
    ax, az = out(*a)
    bx, bz = out(*b)
    nx, nz = -(bz - az), bx - ax
    return (-nx, nz)  # back to floor coordinates (u = -x)


def into(a, b, towards, angle):
    """The swing that turns a leaf hinged at a towards the floor direction `towards`."""
    n = normal_xz(a, b)
    return round(angle if n[0] * towards[0] + n[1] * towards[1] > 0 else -angle, 3)


def outside_side(a, b, inward_n):
    n = normal_xz(a, b)
    return 1 if n[0] * inward_n[0] + n[1] * inward_n[1] < 0 else -1


# ---------------------------------------------------------------- the stair
def stair():
    h = F1 / RISERS
    x0, step, v0, v1 = 4.70, 0.20, 6.07, 6.93
    for k in range(1, 12):  # the straight flight: open oak treads, 4.5 cm thick with a 2 cm nosing
        top = k * h
        prism(rect(x0 + step * (k - 1) - 0.02, v0, x0 + step * k, v1), top - 0.045, top, "oak", "#e2c49b", n="ground to 1st floor")
    pivot = (6.90, 6.95)  # the winders turn round the inner corner, from heading along the front to heading back
    corner = (7.80, 6.05)
    edge_pts = [(6.90, 6.05), (6.90 + 0.9 * math.tan(math.radians(22.5)), 6.05), corner,
                (7.80, 6.95 - 0.9 * math.tan(math.radians(22.5))), (7.80, 6.95)]
    for k in range(4):
        top = (12 + k) * h
        prism(Polygon([pivot, edge_pts[k], edge_pts[k + 1]]), top - 0.045, top, "oak", "#e2c49b", n="ground to 1st floor")
    # Stringers: oak on the open side, white against the walls.
    rise = lambda u: (u - x0) / step * h
    part_beam((4.70, -0.02, 6.95), (6.92, rise(6.92) + 0.0, 6.95), 0.04, 0.26, OAK)
    part_beam((4.70, -0.02, 6.07), (6.92, rise(6.92), 6.07), 0.03, 0.26, WHITE)
    part_beam((6.92, 11 * h - 0.1, 6.07), (7.78, 2.85, 6.07), 0.03, 0.30, WHITE)
    part_beam((7.78, 11 * h - 0.1, 6.07), (7.78, 2.85, 6.93), 0.03, 0.30, WHITE)
    part_box(6.90, 6.95, 0.0, 0.08, F1 + 1.0, 0.08, (0, 1), OAK)  # the newel post at the turn
    part_box(4.73, 6.95, 0.0, 0.07, 1.05, 0.07, (0, 1), OAK)  # the post at the foot
    # The handrail (round oak) on steel tubes along the open side, then round the stair well upstairs.
    hr = 0.92
    part_rod((4.73, hr + 0.1, 6.95), (6.90, rise(6.90) + hr, 6.95), 0.024, OAK)
    for k, dy in enumerate((0.26, 0.5, 0.74)):
        part_rod((4.73, hr + 0.1 - dy, 6.95), (6.90, rise(6.90) + hr - dy, 6.95), 0.007, STEEL, 6)
    top = F1 + 0.98
    part_rod((6.90, top, 7.00), (4.55, top, 7.00), 0.024, OAK)
    part_rod((4.55, top, 7.00), (4.55, top, 6.06), 0.024, OAK)
    for dy in (0.26, 0.5, 0.74):
        part_rod((6.90, top - dy, 7.00), (4.55, top - dy, 7.00), 0.007, STEEL, 6)
        part_rod((4.55, top - dy, 7.00), (4.55, top - dy, 6.06), 0.007, STEEL, 6)
    for u, v in ((4.55, 7.00), (5.70, 7.00), (4.55, 6.06)):
        part_box(u, v, F1, 0.05, 0.98, 0.05, (0, 1), STEEL)
    # What keeps you on it: the open side up to the handrail, the stair well's edge upstairs.
    prism(rect(4.72, 6.93, 6.92, 6.98), 0.0, F1 + 1.0, "c", drawn=False)
    prism(rect(4.50, 6.98, 6.92, 7.03), F1, F1 + 1.0, "c", drawn=False)
    prism(rect(4.50, 6.05, 4.60, 7.03), F1, F1 + 1.0, "c", drawn=False)


# ---------------------------------------------------------------- the kitchen
def kitchen():
    room = "Keuken"
    iu = 7.80  # the party wall's inner face
    back = INNER.bounds[3]  # the back wall's inner face (11.56)
    # Along the back: the sink under the window.
    bu0, bv0 = 5.25, back - 0.62
    prism(rect(bu0, bv0 + 0.06, iu, back), 0.0, 0.10, "c", DARK, n=room)
    prism(rect(bu0, bv0, iu - 0.62, back), 0.10, 0.86, "c", WHITE, n=room)
    prism(rect(bu0, bv0 - 0.03, iu - 0.62, back), 0.86, 0.90, "oak", OAK, n=room)
    prism(rect(bu0, bv0 - 0.004, iu - 0.62, bv0 + 0.004), 0.79, 0.84, "c", BLACK, solid=False)  # the grip line
    win = find("w", 1.05, (6.5, 11.9))
    sink_u = (win.a[0] + win.b[0]) / 2
    prism(rect(sink_u - 0.40, bv0 + 0.10, sink_u + 0.40, back - 0.10), 0.90, 0.903, "c", "#222224", solid=False)
    prism(rect(sink_u - 0.36, bv0 + 0.13, sink_u + 0.08, back - 0.13), 0.903, 0.905, "c", "#111112", solid=False)
    part_rod((sink_u + 0.22, 0.90, back - 0.08), (sink_u + 0.22, 1.24, back - 0.08), 0.016, BLACK)
    part_rod((sink_u + 0.22, 1.24, back - 0.08), (sink_u + 0.22, 1.20, back - 0.30), 0.014, BLACK)
    for y in (1.40, 1.80):  # two dark floating shelves on the wall beside the window
        part_box(5.62, back - 0.13, y, 0.68, 0.035, 0.26, (0, -1), "#3b3532")
    # Along the party wall: tall units with the oven at eye height, then the hob, a black glass splashback and a row
    # of wall cabinets.
    tv0, tv1 = 7.10, 8.32
    prism(rect(iu - 0.62, tv0, iu, tv1), 0.0, 2.30, "c", WHITE, n=room)
    mid = (tv0 + tv1) / 2
    prism(rect(iu - 0.623, mid - 0.003, iu - 0.6, mid + 0.003), 0.02, 2.28, "c", BLACK, solid=False)
    prism(rect(iu - 0.623, tv0 + 0.02, iu - 0.6, mid - 0.02), 1.255, 1.262, "c", "#c9c7c1", solid=False)
    prism(rect(iu - 0.624, mid + 0.03, iu - 0.6, tv1 - 0.03), 1.00, 1.60, "c", "#141416", solid=False)  # the oven
    prism(rect(iu - 0.626, mid + 0.06, iu - 0.6, tv1 - 0.06), 1.52, 1.535, "c", STEEL, solid=False)
    prism(rect(iu - 0.56, tv1, iu, back - 0.62 + 0.06), 0.0, 0.10, "c", DARK, n=room)
    prism(rect(iu - 0.62, tv1, iu, back), 0.10, 0.86, "c", WHITE, n=room)
    prism(rect(iu - 0.65, tv1, iu, back), 0.86, 0.90, "oak", OAK, n=room)
    prism(rect(iu - 0.624, tv1, iu - 0.616, back - 0.62), 0.79, 0.84, "c", BLACK, solid=False)
    prism(rect(iu - 0.58, 9.30, iu - 0.06, 9.90), 0.90, 0.906, "c", "#101012", solid=False)  # the induction hob
    prism(rect(iu - 0.012, tv1, iu, back), 0.90, 1.48, "c", "#0d0d0f", solid=False)  # black glass splashback
    prism(rect(iu - 0.35, tv1, iu, back), 1.48, 2.30, "c", WHITE, n=room)
    for k in range(1, 6):
        vv = tv1 + (back - tv1) * k / 6
        prism(rect(iu - 0.353, vv - 0.003, iu - 0.34, vv + 0.003), 1.49, 2.29, "c", "#cfccc5", solid=False)
    part_box(iu - 0.25, 10.7, 0.90, 0.24, 0.36, 0.38, (-1, 0), "#1f2021")  # a coffee machine
    # The island: white below an oak top that reaches out for two stools on the dining side.
    prism(rect(5.50, 7.30, 6.22, 8.25), 0.0, 0.88, "c", WHITE, n=room)
    prism(rect(5.85, 8.25, 6.22, 9.20), 0.0, 0.88, "c", WHITE, n=room)
    prism(rect(5.53, 7.34, 6.19, 8.21), 0.0, 0.06, "c", DARK, solid=False)
    prism(rect(5.45, 7.25, 6.27, 9.25), 0.88, 0.92, "oak", OAK, n=room)
    for v in (8.55, 9.0):
        stool(5.22, v, (1, 0))
    # A white ceiling track with four spots over the kitchen.
    part_box(6.62, 9.3, GF_CEIL - 0.03, 0.04, 0.03, 1.7, (0, 1), WHITE)
    for v in (8.65, 9.1, 9.55, 10.0):
        part_rod((6.62, GF_CEIL - 0.03, v), (6.62, GF_CEIL - 0.08, v), 0.008, WHITE, 6)
        part_lathe(6.62, v + 0.02, GF_CEIL - 0.17, [(0.0, 0.0), (0.033, 0.0), (0.035, 0.03), (0.035, 0.1), (0.0, 0.1)], WHITE, 12)


def stool(u, v, face):
    fu, fv = face
    part_lathe(u, v, 0.62, [(0.0, 0.0), (0.19, 0.0), (0.2, 0.03), (0.19, 0.06), (0.0, 0.06)], TAN, 16)
    part_box(u - fu * 0.17, v - fv * 0.17, 0.66, 0.34, 0.2, 0.04, face, TAN)
    for a in (45, 135, 225, 315):
        r = math.radians(a)
        part_rod((u + 0.12 * math.cos(r), 0.62, v + 0.12 * math.sin(r)), (u + 0.2 * math.cos(r), 0.0, v + 0.2 * math.sin(r)), 0.011, BLACK, 6)
    block(u, v, 0.42, 0.42, face, 0.0, 0.67, "Keuken")


# ---------------------------------------------------------------- furniture
def chair(u, v, face, room):
    """A tan leather shell chair on black legs, facing `face`."""
    fu, fv = face
    L = math.hypot(fu, fv)
    fu, fv = fu / L, fv / L
    su, sv = fv, -fu
    part_box(u, v, 0.44, 0.46, 0.05, 0.44, face, TAN)
    part_box(u - fu * 0.22, v - fv * 0.22, 0.48, 0.44, 0.38, 0.04, face, TAN)
    for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        top = (u + su * a * 0.17 + fu * b * 0.15, 0.44, v + sv * a * 0.17 + fv * b * 0.15)
        foot = (u + su * a * 0.22 + fu * b * 0.21, 0.0, v + sv * a * 0.22 + fv * b * 0.21)
        part_rod(top, foot, 0.011, BLACK, 6)
    block(u, v, 0.46, 0.46, face, 0.0, 0.86, room)


def living():
    room = "Living"
    iu0 = INNER.bounds[0] + 0.02  # the side wall's inner face (0.40)
    # The taupe corner sofa along the side wall, its chaise end towards the room at the back.
    u0, v0, v1 = 0.45, 2.60, 5.50
    taupe, cushion, legc = "#b2a594", "#bdb1a1", "#3a3a3a"
    prism(rect(u0, v0, 1.40, v1), 0.08, 0.42, "c", taupe, solid=False)
    prism(rect(1.40, v1 - 0.95, 2.55, v1), 0.08, 0.42, "c", taupe, solid=False)
    prism(rect(u0, v0, 0.68, v1), 0.42, 0.84, "c", "#a89b8a", solid=False)
    prism(rect(u0, v0, 1.40, v0 + 0.18), 0.42, 0.60, "c", taupe, solid=False)
    prism(rect(u0, v0, 1.40, v1).union(rect(1.40, v1 - 0.95, 2.55, v1)), 0.0, 0.84, "c", n=room, drawn=False)
    for a, b in ((v0 + 0.18, 3.55), (3.55, 4.53)):
        prism(rect(0.68, a + 0.01, 1.38, b - 0.01), 0.42, 0.53, "c", cushion, solid=False)
    prism(rect(0.68, v1 - 0.94, 2.53, v1 - 0.02), 0.42, 0.53, "c", cushion, solid=False)
    for v in (3.0, 4.0, 5.0):
        part_box(0.76, v, 0.52, 0.40, 0.32, 0.12, (1, 0), "#9e9282")
    for u, v in ((u0 + 0.05, v0 + 0.05), (1.35, v0 + 0.05), (u0 + 0.05, v1 - 0.05), (2.5, v1 - 0.05), (2.5, v1 - 0.9)):
        part_lathe(u, v, 0.0, [(0.0, 0.0), (0.02, 0.0), (0.02, 0.08), (0.0, 0.08)], legc, 8)
    # A white oval coffee table on light wooden legs.
    cu, cv = 2.05, 3.95
    part_oval(cu, cv, 0.40, 0.33, 0.52, 0.03, "#f2f1ee")
    for a in (90, 210, 330):
        r = math.radians(a)
        part_rod((cu + 0.18 * math.cos(r), 0.40, cv + 0.3 * math.sin(r)), (cu + 0.26 * math.cos(r), 0.0, cv + 0.42 * math.sin(r)), 0.016, "#d6b98f", 6)
    block(cu, cv, 0.66, 1.04, (0, 1), 0.0, 0.55, room)
    # A low white TV unit with an oak top along the garage wall, a large black TV on the wall above it and a white
    # soundbar under the TV, facing the sofa.
    tw = 4.50 - 0.005  # the garage wall's face
    prism(rect(tw - 0.40, 3.20, tw, 5.00), 0.08, 0.44, "c", WHITE, solid=False)
    prism(rect(tw - 0.40, 3.20, tw, 5.00), 0.44, 0.47, "oak", OAK, solid=False)
    prism(rect(tw - 0.401, 4.095, tw - 0.39, 4.105), 0.10, 0.42, "c", "#d4d0c8", solid=False)
    for v in (3.28, 4.92):
        for u in (tw - 0.34, tw - 0.06):
            part_box(u, v, 0.0, 0.03, 0.08, 0.03, (0, 1), BLACK)
    prism(rect(tw - 0.045, 3.27, tw, 4.93), 0.86, 1.80, "c", "#151617", solid=False)  # the TV
    prism(rect(tw - 0.048, 3.30, tw - 0.044, 4.90), 0.89, 1.77, "c", "#07080a", solid=False)  # its screen
    prism(rect(tw - 0.11, 3.55, tw, 4.65), 0.70, 0.79, "c", "#f2f1ee", solid=False)  # the soundbar
    block(tw - 0.2, 4.10, 1.8, 0.4, (-1, 0), 0.0, 0.55, room)
    # A big knitted cream shade over the living room; a matte white dome over the table.
    pendant_shade(2.25, 4.15)
    dome(3.35, 9.2)
    # A grey roman blind, raised, in the living room's side window.
    win = find("w", 0.95, (0.0, 3.25))
    prism(win.quad(0.02, win.w - 0.02, 0.21, 0.24), win.y1 - 0.42, win.y1, "c", "#8d9195", solid=False)
    for k in range(3):
        y = win.y1 - 0.42 + k * 0.13
        prism(win.quad(0.02, win.w - 0.02, 0.205, 0.25), y, y + 0.03, "c", "#7f8387", solid=False)
    fixture("plant", 0.80, 6.55, 0.0, (1, 0), (0.5, 0.5, 1.85))
    block(0.80, 6.55, 0.4, 0.4, (1, 0), 0.0, 1.0, room)


def office_chair(u, v, face, f):
    """A graphite office chair: a seat and a back on a post, five spokes on castors."""
    fu, fv = face
    dark = "#2f3134"
    part_box(u, v, f + 0.44, 0.48, 0.07, 0.46, face, dark)
    part_box(u - fu * 0.24, v - fv * 0.24, f + 0.56, 0.44, 0.52, 0.05, face, dark)
    part_rod((u, f + 0.08, v), (u, f + 0.44, v), 0.025, "#8d9196", 8)
    for k in range(5):
        a = 2 * math.pi * k / 5
        part_rod((u, f + 0.08, v), (u + 0.3 * math.cos(a), f + 0.05, v + 0.3 * math.sin(a)), 0.016, dark, 6)


def pendant_shade(u, v):
    part_rod((u, GF_CEIL, v), (u, 2.38, v), 0.004, "#e8e6e1", 4)
    part_lathe(u, v, GF_CEIL - 0.01, [(0.0, 0.0), (0.05, 0.0), (0.05, -0.01), (0.0, -0.01)], WHITE, 12)
    part_lathe(u, v, 1.94, [(0.30, 0.0), (0.31, 0.06), (0.31, 0.38), (0.30, 0.44), (0.28, 0.44), (0.29, 0.38), (0.29, 0.06), (0.28, 0.0)], "#e6d2b0", 28)


def dome(u, v):
    part_rod((u, GF_CEIL, v), (u, 1.84, v), 0.003, BLACK, 4)
    part_lathe(u, v, GF_CEIL - 0.01, [(0.0, 0.0), (0.05, 0.0), (0.05, -0.01), (0.0, -0.01)], WHITE, 12)
    prof = [(0.27 * math.cos(math.radians(a)), 0.22 * math.sin(math.radians(a))) for a in range(0, 91, 10)]
    part_lathe(u, v, 1.62, prof + [(0.0, 0.225)], "#e9e6df", 28)


def dining():
    room = "Living"
    cu, cv = 3.35, 9.2
    part_lathe(cu, cv, 0.72, [(0.0, 0.0), (0.70, 0.0), (0.70, 0.03), (0.0, 0.03)], OAK, 40)
    for a in (45, 135, 225, 315):
        r = math.radians(a)
        part_rod((cu + 0.12 * math.cos(r), 0.72, cv + 0.12 * math.sin(r)), (cu + 0.5 * math.cos(r), 0.0, cv + 0.5 * math.sin(r)), 0.014, BLACK, 6)
        part_rod((cu + 0.42 * math.cos(r + 0.6), 0.72, cv + 0.42 * math.sin(r + 0.6)), (cu + 0.3 * math.cos(r), 0.3, cv + 0.3 * math.sin(r)), 0.01, BLACK, 6)
    prism(Polygon([(cu + 0.7 * math.cos(a * math.pi / 8), cv + 0.7 * math.sin(a * math.pi / 8)) for a in range(16)]), 0.0, 0.75, "c", n=room, drawn=False)
    for k in range(6):
        r = math.radians(30 + 60 * k)
        u, v = cu + 0.80 * math.cos(r), cv + 0.80 * math.sin(r)
        chair(u, v, (cu - u, cv - v), room)


def curtains():
    """Long grey-blue curtains on a ceiling track at both ends of the glass round the dining corner."""
    col = "#8797a1"
    iu0 = 0.42
    part_sheet((iu0 + 0.1, 6.92), (iu0 + 0.1, 7.90), 0.02, GF_CEIL - 0.04, 0.06, 9, col)
    part_sheet((4.72, INNER.bounds[3] - 0.12), (5.32, INNER.bounds[3] - 0.12), 0.02, GF_CEIL - 0.04, 0.06, 6, col)
    pts = [(iu0 + 0.1, 6.85)]
    dn = _dn
    pts.append(corner_in(0.1))
    pts.append(corner_in(0.1, end=True))
    pts.append((5.40, INNER.bounds[3] - 0.12))
    for a, b in zip(pts, pts[1:]):
        part_beam((a[0], GF_CEIL - 0.02, a[1]), (b[0], GF_CEIL - 0.02, b[1]), 0.04, 0.025, WHITE)


def corner_in(d, end=False):
    """The inner corner of the cut corner's glass with the side wall (or, with end, the back), d further in."""
    poly = inset([t + d if t > 0.3 else t for t in THICK])
    (du, dv), _ = edge(DIAG_EDGE)
    p0, p1 = edge(DIAG_EDGE)
    tgt = p1 if end else p0
    return min(list(poly.exterior.coords), key=lambda q: math.dist(q, tgt))


def bedrooms():
    f = F1
    # Bedroom 3, at the front by the free corner
    fixture("bed140", 2.20, 2.05, f, (-1, 0), (1.4, 2.1, 1.0))
    block(2.20, 2.05, 1.4, 2.1, (-1, 0), f, f + 0.55, "Slaapkamer 3")
    for v in (1.10, 3.00):
        fixture("nightstand", 3.02, v, f, (-1, 0), (0.45, 0.4, 0.5))
        block(3.02, v, 0.45, 0.4, (-1, 0), f, f + 0.55, "Slaapkamer 3")
    fixture("wardrobe200", 1.35, 4.40, f, (0, -1), (1.8, 0.6, 2.2))
    block(1.35, 4.40, 1.8, 0.6, (0, -1), f, f + 2.2, "Slaapkamer 3")
    # Bedroom 2, at the front by the party wall: the head of the bed against the landing's wall
    fixture("bed160", 5.95, 2.40, f, (0, -1), (1.6, 2.1, 1.0))
    block(5.95, 2.40, 1.6, 2.1, (0, -1), f, f + 0.55, "Slaapkamer 2")
    for u in (4.90, 7.00):
        fixture("nightstand", u, 3.22, f, (0, -1), (0.45, 0.4, 0.5))
        block(u, 3.22, 0.45, 0.4, (0, -1), f, f + 0.55, "Slaapkamer 2")
    fixture("wardrobe200", 3.70, 1.50, f, (1, 0), (1.8, 0.6, 2.2))
    block(3.70, 1.50, 1.8, 0.6, (1, 0), f, f + 2.2, "Slaapkamer 2")
    # Bedroom 1, at the back: the bed's head on the party wall, wardrobes in the dressing
    fixture("bed180", 6.75, 9.85, f, (-1, 0), (1.8, 2.1, 1.0))
    block(6.75, 9.85, 1.8, 2.1, (-1, 0), f, f + 0.55, "Slaapkamer 1")
    for v in (8.70, 11.0):
        fixture("nightstand", 7.55, v, f, (-1, 0), (0.45, 0.4, 0.5))
        block(7.55, v, 0.45, 0.4, (-1, 0), f, f + 0.55, "Slaapkamer 1")
    fixture("wardrobe200", 3.80, 9.30, f, (-1, 0), (1.9, 0.6, 2.2))
    block(3.80, 9.30, 1.9, 0.6, (-1, 0), f, f + 2.2, "Slaapkamer 1")
    back = INNER.bounds[3]
    prism(rect(5.27, back - 0.45, 6.02, back), f + 0.05, f + 0.80, "c", WHITE, solid=False)  # a chest of drawers
    prism(rect(5.29, back - 0.44, 6.00, back - 0.01), f, f + 0.05, "c", "#c9c4bb", solid=False)
    for k in (1, 2):
        prism(rect(5.28, back - 0.452, 6.01, back - 0.446), f + 0.05 + 0.25 * k - 0.003, f + 0.05 + 0.25 * k + 0.003, "c", "#c9c4bb", solid=False)
    prism(rect(5.36, back - 0.012, 5.93, back), f + 1.15, f + 1.85, "c", "#cfd6d9", solid=False)  # a mirror above it
    block(5.645, back - 0.225, 0.75, 0.45, (0, -1), f, f + 0.8, "Slaapkamer 1")
    # The office: the desk at the corner glass, a sofa and a bookcase
    fixture("desk", 0.78, 7.45, f, (1, 0), (1.4, 0.7, 0.75))
    block(0.78, 7.45, 1.4, 0.7, (1, 0), f, f + 0.75, "Bureau")
    office_chair(1.45, 7.45, (-1, 0), f)
    block(1.45, 7.45, 0.55, 0.55, (-1, 0), f, f + 1.08, "Bureau")
    fixture("sofa2", 1.45, 5.30, f, (0, 1), (1.6, 0.9, 0.8))
    block(1.45, 5.30, 1.6, 0.9, (0, 1), f, f + 0.8, "Bureau")
    fixture("bookcase", 3.08, 5.40, f, (-1, 0), (0.8, 0.3, 2.0))
    block(3.08, 5.40, 0.8, 0.3, (-1, 0), f, f + 2.0, "Bureau")
    # Sheer curtains in the front windows upstairs
    for o in [o for o in OPENINGS if o.i == FRONT_EDGE and o.y0 > 3]:
        mu = (o.a[0] + o.b[0]) / 2
        fixture("curtain", mu, o.depth + 0.12, f, (0, -1), (o.w + 0.1, 0.14, F1_CEIL - f - 0.02))


def bathroom():
    f, room = F1, "Badkamer"
    iu = 7.80
    # The walk-in shower in the back corner by the landing: a white tray, tiled walls, a glass screen
    prism(rect(4.65, 4.95, 5.85, 5.90), f, f + 0.03, "c", "#f4f4f2", n=room)
    prism(rect(4.65, 5.885, 5.85, 5.90), f, f + 2.2, "bath", "#f2f2f0", solid=False)
    prism(rect(4.65, 4.95, 4.665, 5.885), f, f + 2.2, "bath", "#f2f2f0", solid=False)
    prism(rect(5.25, 4.94, 5.85, 4.952), f + 0.03, f + 2.0, "glassfix")
    part_rod((4.75, f + 0.9, 5.80), (4.75, f + 2.1, 5.80), 0.012, STEEL, 8)
    part_lathe(4.95, 5.70, f + 2.1, [(0.0, 0.0), (0.12, 0.0), (0.12, 0.012), (0.0, 0.012)], STEEL, 20)
    part_rod((4.75, f + 2.12, 5.80), (4.95, f + 2.12, 5.70), 0.01, STEEL, 6)
    # The toilet against the wall to the stair, a tall narrow cupboard beside it
    PROPS.append({"model": "toilet", "x": round(-6.85, 3), "y": round(f, 3), "z": 5.90, "yaw": yaw_to(0, -1)})
    block(6.85, 5.63, 0.38, 0.55, (0, -1), f, f + 0.42, room)
    prism(rect(7.42, 5.40, iu, 5.90), f, f + 2.0, "c", WHITE, n=room)
    # Two basins on a walnut vanity along the front wall, a mirror above
    prism(rect(5.60, 3.60, 7.40, 4.08), f + 0.42, f + 0.82, "c", "#7d5d43", n=room)
    prism(rect(5.58, 3.60, 7.42, 4.10), f + 0.82, f + 0.85, "c", "#f3f2ef", n=room)
    for u in (6.05, 6.95):
        prism(rect(u - 0.22, 3.68, u + 0.22, 4.05), f + 0.85, f + 0.97, "c", "#f7f7f5", solid=False)
        prism(rect(u - 0.18, 3.72, u + 0.18, 4.01), f + 0.97, f + 0.972, "c", "#d9dcdd", solid=False)
        part_rod((u, f + 0.97, 3.66), (u, f + 1.16, 3.66), 0.01, STEEL, 6)
        part_rod((u, f + 1.16, 3.66), (u, f + 1.14, 3.80), 0.009, STEEL, 6)
    prism(rect(5.70, 3.60, 7.30, 3.612), f + 1.12, f + 1.95, "c", "#cdd6da", solid=False)
    block(6.5, 3.85, 1.8, 0.5, (0, 1), f, f + 0.85, room)


def wc():
    room = "WC"
    PROPS.append({"model": "toilet", "x": round(-0.85, 3), "y": 0.0, "z": 0.40, "yaw": yaw_to(0, 1)})
    block(0.85, 0.67, 0.38, 0.55, (0, 1), 0.0, 0.42, room)
    prism(rect(0.40, 1.12, 0.62, 1.48), 0.80, 0.92, "c", "#f6f6f4", n=room)  # a small hand basin
    part_rod((0.45, 0.92, 1.30), (0.45, 1.05, 1.30), 0.008, STEEL, 6)
    part_rod((0.45, 1.05, 1.30), (0.55, 1.04, 1.30), 0.007, STEEL, 6)


def entrance():
    fixture("wardrobe100", 3.80, 1.80, 0.0, (0, -1), (1.40, 0.60, 2.30))  # the cloakroom
    block(3.80, 1.80, 1.40, 0.60, (0, -1), 0.0, 2.30, "Inkom")


def garage():
    room = "Garage"
    g = find("g", 0.0, (6.2, 0.0))
    # The sectional door from inside: light grey panels, its joints, the rails it runs up on
    prism(g.quad(0.0, g.w, 0.16, 0.19), 0.0, g.y1, "c", "#d6d7d6", solid=False)
    prism(g.quad(-0.02, g.w + 0.02, 0.0, 0.19), -0.3, g.y1 + 0.02, "c", n="Garage", drawn=False)  # it stays shut: solid
    for k in range(1, 4):
        y = g.y1 * k / 4
        prism(g.quad(0.02, g.w - 0.02, 0.19, 0.195), y - 0.01, y + 0.01, "c", "#a9abab", solid=False)
    for s in (0.03, g.w - 0.03):
        a = g.at(s, 0.2)
        part_beam((a[0], g.y1 + 0.05, a[1]), (a[0], g.y1 + 0.05, a[1] + 2.9), 0.04, 0.05, "#7c7f82")
    # The utility corner: a deep sink on a base cupboard, washing machine and dryer, steel shelves, the boiler
    prism(rect(4.70, 5.30, 5.25, 5.88), 0.0, 0.86, "c", WHITE, n=room)
    prism(rect(4.70, 5.28, 5.25, 5.88), 0.86, 0.90, "c", "#f3f3f1", n=room)
    prism(rect(4.78, 5.36, 5.17, 5.80), 0.895, 0.902, "c", "#bfc3c5", solid=False)
    part_rod((4.97, 0.90, 5.84), (4.97, 1.12, 5.84), 0.01, STEEL, 6)
    part_rod((4.97, 1.12, 5.84), (4.97, 1.10, 5.66), 0.009, STEEL, 6)
    for u in (5.62, 6.25):
        fixture("washer", u, 5.58, 0.0, (0, -1), (0.6, 0.6, 0.85))
        block(u, 5.58, 0.6, 0.6, (0, -1), 0.0, 0.85, room)
    prism(rect(6.95, 5.62, 7.55, 5.90), 1.30, 2.20, "c", "#ecebe7", n=room)
    for k in range(4):
        prism(rect(7.38, 3.40, 7.78, 5.40), 0.15 + k * 0.6, 0.18 + k * 0.6, "c", "#9da1a4", n=room)
    for v in (3.42, 5.38):
        for u in (7.40, 7.76):
            part_box(u, v, 0.0, 0.035, 2.0, 0.035, (0, 1), "#6f7376")
    block(7.58, 4.40, 2.0, 0.4, (1, 0), 0.0, 2.0, room)
    for u in (7.66, 7.72):
        part_rod((u, 0.0, 5.82), (u, GF_CEIL, 5.82), 0.05, "#8b8f91", 10)


def terrace():
    """3 m deep behind the house and 2.1 m wide round the cut corner and along the side wall's glass, to 1.5 m past
    the side wall's line, in the same grey tiles as inside, 2 cm under the floor."""
    p0, p1 = edge(DIAG_EDGE)  # the cut corner: from the side wall's end to the back's
    t, n, _ = inward(DIAG_EDGE)
    a = (p0[0] - n[0] * 2.1, p0[1] - n[1] * 2.1)
    on_line = lambda u: (u, a[1] + (u - a[0]) * t[1] / t[0])
    party = edge(PARTY_EDGE)
    back_v = max(q[1] for q in RUV) + 3.0
    pu = party[0][0] + (back_v - party[0][1]) * (party[1][0] - party[0][0]) / (party[1][1] - party[0][1])
    behind = sorted([q for q in RUV if q[1] > 11], key=lambda q: -q[0])
    sa, sb = edge(nearest_edge(world(0.0, 4.0)))  # the side wall
    side_u = sa[0] + (sb[0] - sa[0]) * (6.8 - sa[1]) / (sb[1] - sa[1])
    poly = Polygon([(side_u, 6.8), (-1.45, 6.8), on_line(-1.45), on_line(2.55), (2.55, back_v), (pu, back_v), *behind, p0])
    poly = poly.buffer(0).difference(OUTER)
    poly = max(getattr(poly, "geoms", [poly]), key=lambda g: g.area)
    poly = Polygon([(round(x, 3), round(y, 3)) for x, y in poly.exterior.coords])
    prism(poly, -0.32, -0.02, "tile", "#b9bab9", n="Terras")
    # Its edge where the garden is higher: a concrete kerb up to the ground, a metre at a time.
    ring = list(poly.exterior.coords)
    for (ax, ay), (bx, by) in zip(ring, ring[1:]):
        if OUTER.buffer(0.02).contains(LineString([(ax, ay), (bx, by)])):
            continue  # along the house
        L = math.hypot(bx - ax, by - ay)
        k = max(1, math.ceil(L))
        for i in range(k):
            s0, s1 = i / k, (i + 1) / k
            q0 = (ax + (bx - ax) * s0, ay + (by - ay) * s0)
            q1 = (ax + (bx - ax) * s1, ay + (by - ay) * s1)
            top = max(ground_rel(*world(*q)) for q in (q0, q1)) + 0.03
            strip = LineString([q0, q1]).buffer(0.04, cap_style=2).intersection(poly.buffer(0.001))
            prism(strip, -0.32, max(top, 0.0), "c", "#a3a29d", n="Terras")
    return poly


def ground_cut(terr):
    """The relief taken out under the house and the terrace (it lies up to 40 cm above the floor there), as the
    browser cuts the ground for a pond (world/terrain.ts): the 4 m squares it touches, and what is left of them in
    triangles; and a dip for walking, its bottom under the floor (world/collision.ts)."""
    cut = unary_union([OUTER, terr]).buffer(0)
    wcut = Polygon([world(x, y) for x, y in cut.exterior.coords])
    x0, z0, step, nx = TD["x0"], TD["z0"], TD["step"], TD["nx"]
    minx, minz, maxx, maxz = wcut.bounds
    cells, tris = [], []
    for j in range(int((minz - z0) // step), int((maxz - z0) // step) + 1):
        for i in range(int((minx - x0) // step), int((maxx - x0) // step) + 1):
            xa, za = x0 + i * step, z0 + j * step
            a, b, c, d = (xa, za), (xa + step, za), (xa + step, za + step), (xa, za + step)
            if Polygon([a, b, c, d]).intersection(wcut).area < 1e-6:
                continue
            cells.append(j * (nx - 1) + i)
            for tri in (Polygon([a, c, b]), Polygon([a, d, c])):  # split along a-c, as the browser draws it
                rest = tri.difference(wcut)
                for piece in getattr(rest, "geoms", [rest]):
                    if piece.geom_type != "Polygon" or piece.area < 1e-5:
                        continue
                    for t in shapely.constrained_delaunay_triangles(piece).geoms:
                        if t.area < 1e-6:
                            continue
                        tris += [round(v, 3) for q in list(t.exterior.coords)[:3] for v in q]
    rim = [[round(x, 3), round(z, 3)] for x, z in list(wcut.exterior.coords)[:-1]]
    # The dip's bottom (world/collision.ts): GROUND + low - depth, 30 cm under the floor.
    depth = 0.5
    low = FLOOR - 0.3 + depth - GROUND
    return {"cells": cells, "tris": tris}, {"name": "end house", "rim": rim, "bottom": rim, "depth": depth, "low": round(low, 3)}


def thresholds():
    """At the openings down to the floor, the floor carried through the wall to the street model's own sill, named
    after the room it leads into (so the place doesn't read outside in the doorway)."""
    from shapely.geometry import Point
    for o in OPENINGS:
        if o.y0 > 0.05:
            continue
        col = {"g": "#8f8d88", "d": "#5f6468"}.get(o.kind, "#5f6468")
        into = Point(o.at(o.w / 2, o.depth + 0.3))
        room = next((k for k, poly in GF_ROOMS.items() if poly.contains(into)), None)
        prism(o.quad(0.0, o.w, 0.12, o.depth + 0.01), -0.3, -0.003, "c", col, n=room)


# ---------------------------------------------------------------- the relief (for the terrace's foot)
def load_terrain():
    d = json.loads((ROOT / "web" / "shared" / "terrain.json").read_text(encoding="utf-8"))
    import numpy as np
    digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    value = {c: k for k, c in enumerate(digits)}
    s, rest, k = d["d"], [], 0
    while k < len(s):
        if s[k] == "~":
            rest.append(((value[s[k + 1]] << 12) | (value[s[k + 2]] << 6) | value[s[k + 3]]) - (1 << 17))
            k += 4
        else:
            rest.append(value[s[k]] - 32)
            k += 1
    grid = np.array(rest, np.int64).reshape(d["nz"], d["nx"]).cumsum(1).cumsum(0) / 100.0
    return d, grid


TD, TG = load_terrain()


def terrain(x, z):
    fx = min(max((x - TD["x0"]) / TD["step"], 0.0), TD["nx"] - 1.000001)
    fz = min(max((z - TD["z0"]) / TD["step"], 0.0), TD["nz"] - 1.000001)
    i, j = int(fx), int(fz)
    u, v = fx - i, fz - j
    h00, h11 = TG[j, i], TG[j + 1, i + 1]
    if u >= v:
        h10 = TG[j, i + 1]
        return float(h00 + u * (h10 - h00) + v * (h11 - h10))
    h01 = TG[j + 1, i]
    return float(h00 + v * (h01 - h00) + u * (h11 - h01))


def ground_rel(x, z):
    """The relief at (x, z) relative to the ground floor."""
    return GROUND + terrain(x, z) - FLOOR


def main():
    exterior_walls()
    inside_walls()
    floors()
    door_like = glazing()
    doors(door_like)
    stair()
    kitchen()
    living()
    dining()
    curtains()
    entrance()
    wc()
    garage()
    bedrooms()
    bathroom()
    skirting()
    thresholds()
    terr = terrace()
    cuts, dip = ground_cut(terr)
    centre = world(*OUTER.centroid.coords[0])
    theta = math.atan2(T[1], -T[0])  # three.js turns local +x (= -u) onto -T
    data = {
        "_source": "data/molenhoek_end3.json (the house's outline, openings and floor level); tools/molenhoek_end_inside.py",
        "key": KEY,
        "frame": {"o": [round(A[0], 3), round(A[1], 3)], "a": round(theta, 6), "floor": round(FLOOR, 3)},
        "centre": [round(centre[0], 2), round(centre[1], 2)],
        "outline": [[round(x, 3), round(z, 3)] for x, z in RING],
        "levels": [{"id": "gf", "name": "Ground floor", "floor": 0.0}, {"id": "f1", "name": "1st floor", "floor": F1}],
        "rooms": sorted(set(GF_ROOMS) | set(F1_ROOMS)),
        "prisms": PRISMS, "parts": PARTS, "fixtures": FIXTURES, "props": PROPS, "doors": DOORS, "panes": PANES,
        "groundCuts": cuts, "dip": dip,
    }
    path = ROOT / "web" / "src" / "data" / "molenhoek_end_inside.json"
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {path.relative_to(ROOT)}: {len(PRISMS)} blocks, {len(PARTS)} parts, {len(FIXTURES)} pieces, {len(DOORS)} doors, "
          f"{len(PANES)} panes, {path.stat().st_size // 1024} KB; floor {FLOOR:.3f}; inner {INNER.bounds}")
    print("terrace ground relative to the floor:", [round(ground_rel(*world(x, y)), 2) for x, y in list(terr.exterior.coords)[:-1]])
    print(f"ground cut: {len(cuts['cells'])} squares, {len(cuts['tris']) // 6} triangles left")
    for name, poly in {**GF_ROOMS, **F1_ROOMS}.items():
        print(f"  {name:14s} {poly.area:6.2f} m2")


if __name__ == "__main__":
    main()
