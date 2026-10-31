"""An older bungalow on Briel, after a set of hand-drawn plans Yoshi shared (28 Oct 2026):
"Plan - gevels - snede" with foundation plan, ground plan, four elevations and a section.

Single storey, 9.30 x 14.00 m (the front facade's dimension chain: 1.10 + 1.10 + 1.80 + 1.10 +
1.80 + 1.10 + 1.30), a gable roof along the length (tiles, about 32 degrees), pale facade brick on a
dark brick plinth, light stone around the windows, double casement windows and a front door with a
fanlight on the long side. Floor 0.45 m above the ground, ceiling at 2.50 m. Both gable elevations
put the eaves 2.95 m and the ridge 5.9 m above the floor (checked again on 30 Oct 2026 against new
photos of the sheets). Windows are 1.10 wide and 1.45 high with the sill 0.70 above the floor
("70 boven vloer"), the three in the front gable 2.15 high down to the floor, the one in the back
gable 1.00 wide. Rooms as on the ground plan: two bedrooms at the back, storeroom, kitchen with a
side door, hall, bathroom and WC, and the living room across the front. Sizes are read from photos
of the sheets, so they are close, not exact. The arched fanlight over the front door is a model
(tools/fanlight.py) set into a 1.0 x 0.5 m opening above the door.

Added for Yoshi (30 Oct 2026), not on the old plans: the garage beside it is gone; a glass veranda
with a jacuzzi against the left facade, from the back corner to the living room, the kitchen door
opening into it and a sliding door to the garden; a paved parking place beside the right facade over the path
to the front door, with a drive to the road (the hedge on the plot line makes way for it); and a
book wall from floor to ceiling in the living room. The book wall and the jacuzzi are drawn by the
game like the planner's furniture (fixtures, web/src/world/furnishing.ts), but can't be moved.

Where: on the GRB outline (Digitaal Vlaanderen) Yoshi pointed out on the map on 30 Oct 2026,
about 200 m from his plot; before that it stood on the neighbouring outline about 21 m east. The
outline is L-shaped: a main block of 10.0 x 15.1 m with a narrower wing on its left side. The
plan's house stands in the main block, centred, front edge on the outline's front edge, facing
the road; the glass veranda takes the place of the wing.

Upper floor ("bovenverdieping", Yoshi's sketch in a spreadsheet, about 0.47 m a cell), under the
roof: knee walls 2.3 m in from each long facade; roof windows, four in one slope and one in the
other, each in a small well in the knee wall; a window in each gable; a front room with the
chimney and a back room. A steep stair (12 risers) reaches it from the corridor beside the WC,
in a strip taken from the bathroom; its top is where the sketch has the stair opening.

Plan coordinates: u from the left facade to the right one, v from the back to the front
(towards the road). Everything uses its own materials (old_*), so the light bake of Yoshi's
house stays valid.
"""
import math

from shapely.geometry import Polygon
from shapely.ops import unary_union

ORIGIN = (83.343, 197.185)      # plan (0, 0): back corner of the left facade
E = (-0.7684, -0.64)          # plan u in the world
S = (0.64, -0.7684)           # plan v in the world (towards the road)
ROAD_V = 21.5                   # the road's edge in front of the house
W, L, T = 9.3, 14.0, 0.3        # width, length, outer wall
G = -0.10                       # ground (site)
FL = G + 0.45                   # floor
CEIL = FL + 2.50
EAVES = FL + 2.95
RIDGE = FL + 5.9
ATTIC = CEIL + 0.12             # upper floor: boards on the ceiling slab
INNER = 0.12                    # inner walls
DOUBLE = [[1, "turn"], [1, "turn"]]  # double casement window

# Additions (Yoshi, 30 Oct 2026). Plan rectangles: u0, v0, u1, v1.
VERANDA = (-3.0, 0.0, 0.0, 9.5)  # left facade, from the back corner to the living room
VERANDA_TOP = FL + 2.55          # its flat glass roof, under the eaves
SLIDER = (4.6, 6.9)              # sliding door to the garden, across from the kitchen door
PARKING = (9.75, 0.6, 16.0, 14.6)  # right facade: paved, for the blue Model 3 (no carport roof: Yoshi)
DRIVE = (11.6, 15.8)             # parking to the road, across u

KNEE = 2.3                      # upper floor: knee walls this far in from each long facade
WELL = 1.4                      # roof-window wells reach out to here
PARTITION_V = 4.2               # upper floor: back room behind this
SKYLIGHTS = [(0, 1.40, 2.80), (0, 4.20, 5.60), (0, 7.93, 9.33), (0, 11.67, 13.07), (1, 6.07, 7.47)]  # slope, v range
STAIR_U = (5.82, 6.72)
STAIR_TOP_V, TREAD, RISERS = 4.26, 0.24, 12
OPENING = (5.82, 4.26, 6.72, 6.75)  # in the upper floor above the stair

# side, from, to (along the facade), sill, head (above the floor), kind, extras
OPENINGS = [
    # Left facade: bedroom 1, storeroom, kitchen door and the low wide kitchen window
    ("w", 1.20, 2.30, 0.70, 2.15, "window", {}),
    ("w", 3.90, 4.80, 0.70, 2.15, "window", {}),
    ("w", 5.35, 6.15, 0.0, 2.10, "door", {"glass": True}),
    ("w", 6.70, 8.70, 1.20, 2.15, "window", {"panes": [[1, "turn"], [1, "fixed"], [1, "turn"]]}),
    # Right facade (its dimension chain): bedroom 2, bathroom, WC, front door, living room
    ("e", 0.80, 1.90, 0.70, 2.15, "window", {}),
    ("e", 2.70, 3.80, 0.70, 2.15, "window", {}),
    ("e", 5.30, 6.40, 0.70, 2.15, "window", {"matte": True}),
    ("e", 7.00, 7.50, 1.40, 2.15, "window", {"matte": True, "panes": [[1, "tilt-turn"]]}),
    ("e", 8.00, 9.00, 0.0, 2.60, "door", {"fanlight": True}),
    ("e", 10.10, 11.20, 0.70, 2.15, "window", {}),
    ("e", 12.00, 13.10, 0.70, 2.15, "window", {}),
    # Front (gable to the road): three tall living room windows down to the floor; back: the corridor window
    ("s", 1.10, 2.20, 0.0, 2.15, "window", {}),
    ("s", 4.00, 5.10, 0.0, 2.15, "window", {}),
    ("s", 6.90, 8.00, 0.0, 2.15, "window", {}),
    ("n", 4.65, 5.65, 0.70, 2.15, "window", {"panes": [[1, "turn"]]}),
]

ROOMS = {
    "Slaapkamer 1": [(0.3, 0.3, 4.49, 3.69)],
    "Bergplaats": [(0.3, 3.81, 4.49, 5.14)],
    "Keuken": [(0.3, 5.26, 4.49, 9.44)],
    "Gang": [(4.61, 0.3, 5.70, 7.9)],
    "Slaapkamer 2": [(6.84, 0.3, 9.0, 4.74), (5.82, 0.3, 6.84, 4.14)],
    "Badkamer": [(6.84, 4.86, 9.0, 6.9)],
    "Zoldertrap": [(5.82, 4.26, 6.72, 7.02)],
    "WC": [(7.7, 7.02, 9.0, 7.84)],
    "Hal": [(5.70, 7.02, 7.58, 7.9), (4.61, 7.9, 9.0, 9.44)],
    "Woonkamer": [(0.3, 9.56, 9.0, 13.7)],
}

INNER_WALLS = [
    (0.3, 3.69, 4.49, 3.81),    # bedroom 1 | storeroom
    (0.3, 5.14, 4.49, 5.26),    # storeroom | kitchen
    (0.3, 9.44, 9.0, 9.56),     # kitchen, hall | living room
    (4.49, 0.3, 4.61, 9.44),    # left rooms | corridor
    (5.70, 0.3, 5.82, 7.02),    # corridor | bedroom 2, stair
    (5.82, 4.14, 6.84, 4.26),   # bedroom 2 | top of the stair
    (6.72, 4.26, 6.84, 7.02),   # stair | bathroom
    (6.84, 4.74, 9.0, 4.86),    # bedroom 2 | bathroom
    (6.84, 6.90, 9.0, 7.02),    # bathroom | WC, hall
    (7.58, 7.02, 7.70, 7.96),   # WC side
    (7.70, 7.84, 9.0, 7.96),    # WC | hall
]

# Inside doors: wall rectangle they cut, hinge end, other end (plan, door line), a point to swing into.
INNER_DOORS = [
    ("bedroom 1", (4.49, 2.60, 4.61, 3.40), (4.55, 2.60), (4.55, 3.40), (3.0, 3.0)),
    ("storeroom", (1.30, 5.14, 2.10, 5.26), (1.30, 5.20), (2.10, 5.20), (1.7, 4.5)),
    ("kitchen", (4.49, 7.00, 4.61, 7.80), (4.55, 7.80), (4.55, 7.00), (3.0, 7.4)),
    ("kitchen to living room", (3.20, 9.44, 4.00, 9.56), (3.20, 9.50), (4.00, 9.50), (3.6, 8.6)),
    ("bedroom 2", (5.70, 3.00, 5.82, 3.80), (5.76, 3.80), (5.76, 3.00), (7.0, 3.4)),
    ("bathroom", (6.88, 6.90, 7.56, 7.02), (6.88, 6.96), (7.56, 6.96), (7.2, 6.0)),
    ("WC", (7.95, 7.84, 8.65, 7.96), (8.65, 7.90), (7.95, 7.90), (8.3, 7.4)),
    ("living room", (6.40, 9.44, 7.30, 9.56), (6.40, 9.50), (7.30, 9.50), (6.8, 10.5)),
]


def P(u, v):
    return (ORIGIN[0] + u * E[0] + v * S[0], ORIGIN[1] + u * E[1] + v * S[1])


def V(du, dv):
    return (du * E[0] + dv * S[0], du * E[1] + dv * S[1])


def R(u0, v0, u1, v1):
    return Polygon([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)])


def face(side, d0, d1, a, b):
    """A rectangle at depth d0..d1 behind the outer face of a facade (negative: in front of
    it), running a..b along that facade."""
    if side == "w":
        return R(d0, a, d1, b)
    if side == "e":
        return R(W - d1, a, W - d0, b)
    if side == "n":
        return R(a, d0, b, d1)
    return R(a, L - d1, b, L - d0)


def window_line(side, a):
    """Start, direction and outward normal of a window along a facade (middle of the wall)."""
    return {"w": (P(T / 2, a), V(0, 1), V(-1, 0)), "e": (P(W - T / 2, a), V(0, 1), V(1, 0)),
            "n": (P(a, T / 2), V(1, 0), V(0, -1)), "s": (P(a, L - T / 2), V(1, 0), V(0, 1))}[side]


def roof_at(b):
    """Height of the roof b metres in from a long facade (as surroundings.ts draws it)."""
    eave = EAVES - 0.15
    return eave + (b + 0.3) / (W / 2 + 0.3) * (RIDGE - eave)


def outside_door(b, door_id, name, start, d, n, length, y0, y1, glass=False):
    """A door leaf in an outside wall, swinging in; brown outside, white inside (doors.ts)."""
    normal = (-d[1], d[0])  # the side a door panel's normal points to (see doors.ts)
    inward = normal[0] * n[0] + normal[1] * n[1] < 0
    b.doors.append({
        "id": door_id, "name": name, "level": "gf", "y0": y0, "y1": y1, "open": False,
        "panels": [{"a": list(start), "b": [start[0] + d[0] * length, start[1] + d[1] * length], "offset": 0,
                    "thickness": 0.05, "glass": glass, "swing": 1.45 if inward else -1.45, "outside": -1 if inward else 1}],
    })


def inside_door(b, door_id, name, hinge, other, into, y0, head):
    """A door leaf in an inside wall, standing open into the room around `into`."""
    ax, az = P(*hinge)
    bx, bz = P(*other)
    ix, iz = P(*into)
    dx, dz = bx - ax, bz - az
    side = (-dz) * (ix - ax) + dx * (iz - az)  # positive: the room lies on the normal's side
    b.doors.append({
        "id": door_id, "name": name, "level": "gf", "y0": y0, "y1": y0 + head - 0.01, "open": True,
        "panels": [{"a": [ax, az], "b": [bx, bz], "offset": 0, "thickness": 0.04, "glass": False,
                    "swing": 1.45 if side > 0 else -1.45}],
    })


def site():
    """Where the bungalow stands, with the larger GRB outline of the house and the old garage's
    outline (neighbouring buildings from the open data that overlap it are left out: the garage
    is gone)."""
    return unary_union([R(-1.8, -7.2, 11.0, 14.1), R(-6.9, -10.8, -2.8, -0.7)])


def build(b, surroundings, frame_window, world_parts):
    outer = R(0, 0, W, L)
    inner = R(T, T, W - T, L - T)
    ring = outer.difference(inner)
    skin = outer.difference(outer.buffer(-0.1, join_style="mitre"))

    def wall(y0, y1, geom):
        b.add("old_brick", y0, y1, geom.intersection(skin))
        b.add("old_plaster", y0, y1, geom.difference(skin))

    cuts = unary_union([face(s, 0, T, a, c) for s, a, c, *_ in OPENINGS])
    b.add("old_plinth", G - 0.05, FL, ring)
    wall(FL, EAVES, ring.difference(cuts))
    for side, a, c, sill, head, kind, extra in OPENINGS:
        cut = face(side, 0, T, a, c)
        if sill > 0:
            wall(FL, FL + sill, cut)
        wall(FL + head, EAVES, cut)
        # Light stone around the opening on the outside: lintel (the fanlight has its own arch), sides
        # and (windows) a sill.
        if not extra.get("fanlight"):
            b.add("old_stone", FL + head, FL + head + 0.15, face(side, -0.02, 0.02, a - 0.12, c + 0.12))
        for s0, s1 in ((a - 0.12, a), (c, c + 0.12)):
            b.add("old_stone", FL + sill, FL + head, face(side, -0.02, 0.02, s0, s1))
        start, d, n = window_line(side, a)
        if kind == "window":
            b.add("old_stone", FL + sill - 0.06, FL + sill, face(side, -0.05, T / 2 - 0.02, a - 0.06, c + 0.06))
            pane = face(side, T / 2 - 0.015, T / 2 + 0.015, a, c)
            b.add("glass", FL + sill, FL + head, pane, **({"matte": True} if extra.get("matte") else {}))
            frame_window(b, start, d, n, c - a, FL + sill, FL + head, world_parts(extra.get("panes", DOUBLE), d, n),
                         mats=("old_frame", "old_frame"))
            continue
        # Doors: a leaf (brown outside), the arched fanlight above the front door, three steps up.
        top = FL + (2.10 if extra.get("fanlight") else head)
        if extra.get("fanlight"):
            # The model's origin: bottom middle of the opening on the outer face, facing out.
            m = (a + c) / 2
            x, z = {"w": P(0, m), "e": P(W, m), "n": P(m, 0), "s": P(m, L)}[side]
            b.props.append({"model": "fanlight", "x": round(x, 3), "y": round(top, 3), "z": round(z, 3),
                            "yaw": round(math.atan2(n[0], n[1]), 4), "hit": "old_stone"})
        outside_door(b, f"oldhouse-{side}-{a}", "front door" if extra.get("fanlight") else "kitchen door",
                     start, d, n, c - a, FL, top - 0.01, bool(extra.get("glass")))
        if side == "w" and VERANDA[1] <= a < VERANDA[3]:
            continue  # into the veranda, level with the floor
        for k, depth in enumerate((0.9, 0.6, 0.3)):
            b.add("old_stone", G - 0.05, G + 0.15 * (k + 1), face(side, -depth, 0, a - 0.2, c + 0.2))

    # Ground floor: floors with the room names (shown when you stand in them), the slab under
    # the walls, inner walls and doors, and the steep stair to the upper floor.
    named = []
    for name, rects in ROOMS.items():
        poly = unary_union([R(*r) for r in rects])
        named.append(poly)
        b.add("old_floor", G - 0.05, FL, poly, f"{name} (old house)")
    b.add("old_floor", G - 0.05, FL, inner.difference(unary_union(named)))
    door_cuts = unary_union([R(*cut) for _, cut, *_ in INNER_DOORS])
    b.add("old_plaster", FL, CEIL, unary_union([R(*w) for w in INNER_WALLS]).difference(door_cuts))
    for name, cut, hinge, other, into in INNER_DOORS:
        b.add("old_plaster", FL + 2.05, CEIL, R(*cut))
        inside_door(b, f"oldhouse-{name.replace(' ', '-')}", f"door ({name})", hinge, other, into, FL, 2.05)
    rise = (ATTIC - FL) / RISERS
    for i in range(1, RISERS):
        v0 = STAIR_TOP_V + (RISERS - 1 - i) * TREAD
        b.add("old_wood", FL, FL + i * rise, R(STAIR_U[0], v0, STAIR_U[1], v0 + TREAD), "Zoldertrap (old house)")

    # Upper floor: the ceiling slab with the stair hole, boards, knee walls with the roof-window
    # wells, the wall between the two rooms, and a balustrade around the stair hole.
    hole = R(*OPENING)
    b.add("old_ceiling", CEIL, CEIL + 0.1, inner.difference(hole))
    back, front = R(T, T, W - T, PARTITION_V), R(T, PARTITION_V, W - T, L - T)
    b.add("old_wood", CEIL + 0.1, ATTIC, back.difference(hole), "Zolderkamer (old house)")
    b.add("old_wood", CEIL + 0.1, ATTIC, front.difference(hole), "Zolder (old house)")
    panels = []
    for slope in (0, 1):
        def U(d, slope=slope):
            return d if slope == 0 else W - d

        def strip(d0, d1, v0, v1):
            u0, u1 = sorted((U(d0), U(d1)))
            return R(u0, v0, u1, v1)

        wells = [(v0, v1) for s, v0, v1 in SKYLIGHTS if s == slope]
        knee = strip(KNEE - 0.06, KNEE + 0.06, T, L - T)
        if wells:
            knee = knee.difference(unary_union([strip(KNEE - 0.1, KNEE + 0.1, v0, v1) for v0, v1 in wells]))
        b.add("old_plaster", ATTIC, roof_at(KNEE - 0.06) - 0.01, knee)
        low = roof_at(WELL - 0.06) - 0.01
        for v0, v1 in wells:
            b.add("old_plaster", ATTIC, low, strip(WELL - 0.06, WELL + 0.06, v0 - 0.12, v1 + 0.12))
            for s0, s1 in ((v0 - 0.12, v0), (v1, v1 + 0.12)):
                b.add("old_plaster", ATTIC, low, strip(WELL - 0.06, KNEE + 0.06, s0, s1))
                vm = (s0 + s1) / 2
                panels.append({"a": list(P(U(WELL), vm)), "b": list(P(U(KNEE + 0.06), vm)), "y0": round(low, 3),
                               "ya": round(roof_at(WELL) - 0.02, 3), "yb": round(roof_at(KNEE + 0.06) - 0.02, 3)})
    # Wall between the rooms: 2.0 m as a block (with a door), above it up to the roof.
    door = (4.2, PARTITION_V - 0.06, 5.0, PARTITION_V + 0.06)
    b.add("old_plaster", ATTIC, ATTIC + 2.0, R(KNEE + 0.06, PARTITION_V - 0.06, W - KNEE - 0.06, PARTITION_V + 0.06).difference(R(*door)))
    for u0, u1 in ((KNEE + 0.06, W / 2), (W / 2, W - KNEE - 0.06)):
        panels.append({"a": list(P(u0, PARTITION_V)), "b": list(P(u1, PARTITION_V)), "y0": round(ATTIC + 2.0, 3),
                       "ya": round(roof_at(min(u0, W - u0)) - 0.02, 3), "yb": round(roof_at(min(u1, W - u1)) - 0.02, 3)})
    inside_door(b, "oldhouse-attic", "door (back room upstairs)", (4.2, PARTITION_V), (5.0, PARTITION_V), (4.6, 2.5), ATTIC, 2.0)
    for rail in ((OPENING[0], OPENING[3] - 0.05, OPENING[2], OPENING[3]), (OPENING[0] - 0.05, 5.3, OPENING[0], OPENING[3])):
        b.add("old_frame", ATTIC, ATTIC + 1.0, R(*rail))

    # Chimney through the front room upstairs, and the tiled roof with its windows (drawn in the browser).
    b.add("old_brick", CEIL + 0.1, RIDGE + 0.65, R(W / 2 - 0.58, 9.15, W / 2 + 0.58, 9.85))  # 1.15 x 0.7 m on the ridge
    surroundings["roofs"].append({
        "p": [list(P(0, 0)), list(P(0, L)), list(P(W, L)), list(P(W, 0))], "y": round(EAVES, 2), "ridge": round(RIDGE, 2),
        "tiles": "#6e4335", "wall": "old_brick", "ceiling": "#f1ece2",  # gables in the same pale brick (elevations)
        "windows": [{"a": [v0, v1], "b": [WELL, 2.5] if s == 0 else [W - 2.5, W - WELL]} for s, v0, v1 in SKYLIGHTS],
        "gableWindows": [{"end": e, "b": [round(W / 2 - 0.27, 2), round(W / 2 + 0.27, 2)], "y": [round(ATTIC + 1.0, 2), round(ATTIC + 2.1, 2)]} for e in (0, 1)],
        "panels": panels,
    })

    veranda(b)
    parking(b)
    # A book wall from floor to ceiling across the living room's end wall (the left facade).
    depth = 0.34
    fixture(b, "bookwall", T + depth / 2, (9.56 + L - T) / 2, FL, (1, 0), [round(L - T - 9.56, 2), depth, round(CEIL - FL - 0.01, 2)])


def fixture(b, item, u, v, y, front, size):
    """Built-in furniture (furnishing.ts draws it like the planner's): its centre, the way its
    front faces (plan direction) and its size (width, depth, height)."""
    x, z = P(u, v)
    fx, fz = V(*front)
    b.fixtures.append({"item": item, "x": round(x, 3), "y": round(y, 3), "z": round(z, 3),
                       "yaw": round(math.atan2(fx, fz), 4), "size": size})


def veranda(b):
    """Glass veranda against the left facade: 3 m deep, its floor level with the house, anthracite
    aluminium posts, glass from the floor up and a flat glass roof under the eaves. The kitchen
    door opens into it; a sliding door across from it leads to the garden, three steps down. A
    jacuzzi stands at the back end."""
    u0, v0, u1, v1 = VERANDA
    top = VERANDA_TOP
    beam = top - 0.18  # underside of the beams round the roof
    t = 0.1  # posts
    b.add("old_plinth", G - 0.05, FL - 0.03, R(u0, v0, u1, v1))
    b.add("old_floor", FL - 0.03, FL, R(u0, v0, u1, v1), "Veranda (old house)")

    def side(a, c, at, along_v):
        """Posts at a and c (and between them), glass between, along one face of the veranda."""
        return R(at, a, at + t, c) if along_v else R(a, at, c, at + t)

    # The long face (u = u0): posts, a sliding door, fixed glass between the posts.
    posts = [v0, 1.55, 3.05, SLIDER[0] - t, SLIDER[1], 8.2, v1 - t]
    for v in posts:
        b.add("alu", FL, beam, R(u0, v, u0 + t, v + t))
    for a, c in zip(posts, posts[1:]):
        a += t
        if a >= SLIDER[0] - 0.01 and c <= SLIDER[1] + 0.01:
            continue
        b.add("alu", FL, FL + 0.05, R(u0, a, u0 + t, c))
        b.add("glass", FL + 0.05, beam, R(u0 + t / 2 - 0.015, a, u0 + t / 2 + 0.015, c))
    # The ends (v = v0, v1): a post in the middle and a profile against the wall.
    for v, inner in ((v0, v0 + t), (v1 - t, v1)):
        cols = [u0 + t, (u0 + u1) / 2 - t / 2, u1 - 0.06]
        b.add("alu", FL, beam, R(cols[1], v, cols[1] + t, v + t))
        b.add("alu", FL, beam, R(cols[2], v, u1, v + t))
        for a, c in ((cols[0], cols[1]), (cols[1] + t, cols[2])):
            b.add("alu", FL, FL + 0.05, R(a, v, c, v + t))
            b.add("glass", FL + 0.05, beam, R(a, v + t / 2 - 0.015, c, v + t / 2 + 0.015))
    # Beams round the roof, a plate against the wall, rafters and the glass roof between them.
    b.add("alu", beam, top, R(u0, v0, u1, v1).difference(R(u0 + 0.12, v0 + 0.12, u1 - 0.08, v1 - 0.12)))
    bays = 8
    step = (v1 - v0 - 0.24) / bays
    for k in range(1, bays):
        v = v0 + 0.12 + k * step
        b.add("alu", top - 0.14, top, R(u0 + 0.12, v - 0.025, u1 - 0.08, v + 0.025))
    for k in range(bays):
        a, c = v0 + 0.12 + k * step, v0 + 0.12 + (k + 1) * step
        b.add("glass", top - 0.05, top - 0.03, R(u0 + 0.12, a + 0.025, u1 - 0.08, c - 0.025))
    # The sliding door (seen from inside the panel nearer the back slides along behind the other one).
    uc = u0 + t / 2
    s0, s1 = SLIDER
    leaf = (s1 - s0) / 2 + 0.05
    d = V(0, 1)
    normal = (-d[1], d[0])
    out = V(-1, 0)
    outside = 1 if normal[0] * out[0] + normal[1] * out[1] > 0 else -1
    b.doors.append({
        "id": "oldhouse-veranda", "name": "sliding door (veranda)", "level": "gf", "y0": FL, "y1": round(beam - 0.01, 3), "open": False,
        "panels": [
            {"a": list(P(uc, s0)), "b": list(P(uc, s0 + leaf)), "offset": -0.035 * outside, "thickness": 0.05, "glass": True,
             "outside": outside, "slide": [round(d[0] * (leaf - 0.1), 3), round(d[1] * (leaf - 0.1), 3)]},
            {"a": list(P(uc, s1 - leaf)), "b": list(P(uc, s1)), "offset": 0.035 * outside, "thickness": 0.05, "glass": True, "outside": outside},
        ],
    })
    for k, depth in enumerate((0.9, 0.6, 0.3)):
        b.add("old_stone", G - 0.05, G + 0.15 * (k + 1), R(u0 - depth, s0 - 0.2, u0, s1 + 0.2))
    # The jacuzzi at the back end, its step towards the sliding door.
    fixture(b, "jacuzzi", (u0 + t + u1) / 2 - 0.1, v0 + t + 0.15 + 1.05, FL, (0, 1), [2.1, 2.1, 0.9])


def parking(b):
    """A paved parking place beside the right facade, round the path to the front door, and a drive
    to the road (Yoshi had the carport over it taken away again). The blue Model 3 parks on it."""
    u0, v0, u1, v1 = PARKING
    floor = unary_union([R(W, v0, u1, v1), R(W + 0.9, v1, W + 1.9, ROAD_V + 0.3), R(DRIVE[0], v1, DRIVE[1], ROAD_V + 0.3)])
    b.add("paving", G - 0.05, G + 0.02, R(W + 0.9, 7.9, W + 1.9, v0).union(floor), "Driveway (old house)")
    # The blue Model 3 parks in the middle of the drive, nose towards the back of the house: it is a
    # car you can drive (web/shared/car.json, "model3"), placed by the game, not here.


def clear():
    """Where the plot-line hedges and fences make way for the parking place and its drive (world)."""
    u0, v0, u1, v1 = PARKING
    return R(u0 - 0.3, v0 - 0.5, u1 + 0.5, ROAD_V + 1.0)
