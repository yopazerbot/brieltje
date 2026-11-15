"""The café at the church (In de Oude Keet, the name on its sign board): the public shell and the bare rooms to walk into.

  python tools/keet.py

writes two public data files, the same bytes for the same input:
- web/src/data/keet_shell.json: what world/walkIn.ts reads of a house to walk into (its frame, outline and floor, the
  front and back doors, the four windows' panes, the ground cut out under it, its dip, and `solids`: the house as a lump
  for walking into until the rooms come, the shut upstairs and the roof);
- web/src/data/keet_rooms.json: the rooms (an `EndInside` of world/walkIn.ts, as the homes' packs are, but public on
  purpose: web/shared/publicClean.test.mjs allows this one file and checks it): walls, panelling, floors, ceiling and
  beams as blocks, the inner doors, and what tools/keet_fittings.py adds when it is there (the fittings: package B).

The café is public: everyone walks in, without a code. Its rooms are not a home's inside and are in no homes list
(shared/homes.mjs); its door ids start with `keet-` and its panes are numbered from 8000 (shared/keet.mjs).

Everything is read from tools/town/houses.json (the house `cafe`: its outline, floor and openings, so the rooms fit the
model to the centimetre) and from web/shared/terrain.json (the relief). The layout follows Yoshi's rough sketch, fitted to
the real building; it is held here as numbers only.

The frame: origin O, the front's west corner outside; u runs along the front to the east, v into the house; y is metres
over the floor. World = O + u U + v V. The files use world/walkIn.ts's frame: x = u, z = v, turned by `a` round O.

Standard library only, no Blender.
"""
import importlib.util
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHELL_OUT = ROOT / "web/src/data/keet_shell.json"
ROOMS_OUT = ROOT / "web/src/data/keet_rooms.json"
SPEC = json.loads((ROOT / "tools/town/houses.json").read_text(encoding="utf-8"))
GROUND = json.loads((ROOT / "web/src/data/house_shell.json").read_text(encoding="utf-8"))["ground"]  # the game's flat ground

# --- the relief, as the browser has it (shared/terrain.mjs) ------------------------------------------------------------
GRID = json.loads((ROOT / "web/shared/terrain.json").read_text(encoding="utf-8"))
_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
_H = []
_at = 0
for _j in range(GRID["nz"]):
    for _i in range(GRID["nx"]):
        if GRID["d"][_at] == "~":
            _r = sum(_DIGITS.index(GRID["d"][_at + k]) << (6 * (3 - k)) for k in (1, 2, 3)) - (1 << 17)
            _at += 4
        else:
            _r = _DIGITS.index(GRID["d"][_at]) - 32
            _at += 1
        _n, _nx = len(_H), GRID["nx"]
        _g = _H[_n - 1] + _H[_n - _nx] - _H[_n - _nx - 1] if _i and _j else _H[_n - 1] if _i else _H[_n - _nx] if _j else 0
        _H.append(_g + _r)


def terrain(x, z):
    gx = max(0, min((x - GRID["x0"]) / GRID["step"], GRID["nx"] - 1.000001))
    gz = max(0, min((z - GRID["z0"]) / GRID["step"], GRID["nz"] - 1.000001))
    i, j = int(gx), int(gz)
    u, v = gx - i, gz - j
    n, nx = j * GRID["nx"] + i, GRID["nx"]
    a, b = _H[n], _H[n + nx + 1]
    return (a + u * (_H[n + 1] - a) + v * (b - _H[n + 1]) if u >= v else a + v * (_H[n + nx] - a) + u * (b - _H[n + nx])) / 100


# --- the house, as the town model has it -------------------------------------------------------------------------------
HOUSE = next(h for h in SPEC["houses"] if h["id"] == "cafe")
VOL = HOUSE["vols"][0]
P = VOL["p"]  # 0 back-west, 1 front-west, 2 front-east, 3 back-east (faces: 0 west, 1 front, 2 east, 3 back)
if not HOUSE.get("walkin"):
    raise SystemExit("tools/town/houses.json: the café is not `walkin`; its doors and panes would show twice")
O = P[1]
_dx, _dz = P[2][0] - O[0], P[2][1] - O[1]
_len = math.hypot(_dx, _dz)
U = (_dx / _len, _dz / _len)
V = (-U[1], U[0])
_cx, _cz = sum(p[0] for p in P) / 4, sum(p[1] for p in P) / 4
if (_cx - O[0]) * V[0] + (_cz - O[1]) * V[1] < 0:
    raise SystemExit("the café's frame points out of the house; review its outline")


def local(x, z):
    return ((x - O[0]) * U[0] + (z - O[1]) * U[1], (x - O[0]) * V[0] + (z - O[1]) * V[1])


def world(u, v):
    return (O[0] + U[0] * u + V[0] * v, O[1] + U[1] * u + V[1] * v)


WIDTH = local(*P[2])[0]  # outside, along the front
DEPTH = (local(*P[0])[1] + local(*P[3])[1]) / 2  # outside, front to back
if abs(WIDTH - 5.73) > .05 or abs(DEPTH - 17.44) > .05:
    raise SystemExit(f"the café's outline is {WIDTH:.2f} x {DEPTH:.2f} m now; the data changed, review the rooms")
# The model's floor (tools/town/town.py): the ground at `floor_at` and a margin of 5 cm over it (`floor_lift`), so 6.071 m
# in the game's heights, not the bare ground's 6.02.
FLOOR_RELIEF = terrain(*HOUSE["floor_at"]) + HOUSE.get("floor_lift", 0.05)
FLOOR = FLOOR_RELIEF + GROUND  # in the game's heights
EAVES, RIDGE = VOL["eaves"], VOL["ridge"]

# --- the openings, read from houses.json the way tools/town/town.py lays them out (`at` items only: the café has no rows)
TOKEN_W = {"w": 1.2, "d": 1.0, "r": 1.9, "n": 0.7}


def openings(face):
    fs = {**HOUSE.get("style", {}), **VOL["faces"][str(face)]}
    if fs.get("rows"):
        raise SystemExit(f"face {face} of the café is laid out in rows; give its openings `at` positions")
    floors = fs.get("floors", [0.0, 2.85])
    out = []
    for item in fs.get("at", []):
        s, tok = item[0], item[1]
        opt = item[2] if len(item) > 2 else {}
        kind = tok[0]
        w = float(tok[1:].split("@")[0]) if len(tok) > 1 and tok[1] != "@" else TOKEN_W[kind]
        storey = int(tok.split("@")[1]) if "@" in tok else 0
        if storey:
            continue
        f = floors[0]
        if kind == "d":
            y0, y1 = f + 0.05, f + fs.get("head", 2.2) + 0.05
        else:
            y0, y1 = f + fs.get("sill_h", 0.85), f + fs.get("head", 2.2)
        if "y" in opt:
            y0, y1 = f + opt["y"][0], f + opt["y"][1]
        out.append({"kind": kind, "s0": s - w / 2, "s1": s + w / 2, "y0": y0, "y1": y1, "fs": {**fs, **opt}})
    return out


FRONT = openings(1)
EAST = openings(2)
WEST = openings(0)
FRONT_WINDOW = next(o for o in FRONT if o["kind"] in "rw")
FRONT_DOOR = next(o for o in FRONT if o["kind"] == "d")
EAST_WINDOWS = sorted((o for o in EAST if o["kind"] == "w"), key=lambda o: o["s0"])
BACK_DOOR = next(o for o in WEST if o["kind"] == "d")
FACE0 = math.dist(P[0], P[1])  # the west face runs from the back to the front
if len(EAST_WINDOWS) != 3 or any(o["kind"] == "d" for o in EAST):
    raise SystemExit("the café's lane side should have three ground-floor windows and no door")
# The back door's sill lies on the paving outside: the relief at the door's middle, against the wall.
_bv = FACE0 - (BACK_DOOR["s0"] + BACK_DOOR["s1"]) / 2
SILL = terrain(*world(0, _bv)) - FLOOR_RELIEF
if abs(SILL - BACK_DOOR["y0"]) > .01:
    raise SystemExit(f"the back door's sill in houses.json is {BACK_DOOR['y0']:.3f} m, the ground outside {SILL:.3f}: make them one")

# --- sizes (metres in the frame) ---------------------------------------------------------------------------------------
WALL = .30  # the outer walls
UI, VI = WIDTH - WALL, DEPTH - WALL  # the inside faces of the east and back walls
CEIL, SLAB = 2.75, 3.31  # the ceiling's underside and the slab's top (the upstairs block starts just under it)
UPSTAIRS = 3.305
BELOW = -.4  # floors and walls reach this far below the floor
SKIN = .14  # the drawn inside of an outer wall starts here (the model's reveals end at its window depth)
PANEL, RAIL = 1.35, .06  # the panelling's height and its rail
DADO = 1.5  # the tiles in the corridors and toilets

ROOMS = {  # u0, v0, u1, v1: the inside faces (Yoshi's rough sketch, fitted to the building)
    "front room": (WALL, WALL, UI, 7.55),
    "bar room": (2.80, 7.67, UI, VI),
    "behind the bar": (WALL, 7.67, 2.20, 11.70),
    "back hall": (WALL, 11.80, 2.70, 13.20),
    "toilets": (WALL, 13.30, 2.70, 14.60),
    "toilet 1": (1.55, 14.70, 2.70, VI),
    "toilet 2": (WALL, 14.70, 1.45, VI),
}
COUNTER = (2.20, 7.67, 2.80, 10.85, 1.10)
LOOK = {  # the floors' surfaces and tints (world/walkIn.ts SURFACES)
    "front room": ("cement", None), "behind the bar": ("cement", None), "bar room": ("wood", "#5c4330"),
    "back hall": ("tile", "#8f8a80"), "toilets": ("tile", "#8f8a80"), "toilet 1": ("tile", "#8f8a80"), "toilet 2": ("tile", "#8f8a80"),
}
WALL_C, CEIL_C, BEAM_C, PANEL_C, RAIL_C, TILE_C, COUNTER_C = "#d9c9a0", "#d2c296", "#3b2616", "#4a2e1c", "#3a2416", "#e6e2d6", "#3b2616"
INNER_DOOR_C, GATE_C = "#4a2e1c", "#3a2416"

# The doors: id, name, the wall it is in (`fixed` axis, its thickness w0..w1), the span along the wall (s0..s1), heights,
# the leaf's line (`at` across the wall), the hinge's end, the swing and its sign (see world/doors.ts), its look.
LEAF_TOP = FRONT_DOOR["y1"] - .07 - .45 - .04  # under the fanlight's transom (tools/town/town.py door)
DOORS = [
    dict(id="keet-front", name="front door", fixed="v", w0=0, w1=WALL, s0=FRONT_DOOR["s0"], s1=FRONT_DOOR["s1"], y0=FRONT_DOOR["y0"], y1=LEAF_TOP,
         at=.175, hinge="s1", swing=-1.6, outside=1, color=FRONT_DOOR["fs"].get("door", "#f1f0ea"), shell=True),
    dict(id="keet-mid", name="door to the bar room", fixed="v", w0=7.55, w1=7.67, s0=4.20, s1=5.20, y0=0, y1=2.05,
         at=7.61, hinge="s1", swing=-1.6, color=INNER_DOOR_C, open=True),
    dict(id="keet-gate", name="bar gate", fixed="u", w0=2.72, w1=2.78, s0=10.85, s1=11.70, y0=.05, y1=1.05,
         at=2.75, hinge="s1", swing=1.6, color=GATE_C, both=True, thickness=.04, handle=False),
    dict(id="keet-corridor", name="door to the back hall", fixed="u", w0=2.70, w1=2.80, s0=12.05, s1=12.95, y0=0, y1=2.05,
         at=2.75, hinge="s1", swing=-1.6, color=INNER_DOOR_C),
    dict(id="keet-back", name="back door", fixed="u", w0=0, w1=WALL, s0=FACE0 - BACK_DOOR["s1"], s1=FACE0 - BACK_DOOR["s0"],
         y0=BACK_DOOR["y0"], y1=BACK_DOOR["y1"], at=.175, hinge="s1", swing=1.6, outside=-1, color=BACK_DOOR["fs"].get("door", "#5a3a2a"), shell=True),
    dict(id="keet-toilets", name="door to the toilets", fixed="u", w0=2.70, w1=2.80, s0=13.50, s1=14.40, y0=0, y1=2.05,
         at=2.75, hinge="s0", swing=1.6, color=INNER_DOOR_C),
    dict(id="keet-toilet1", name="toilet door", fixed="v", w0=14.60, w1=14.70, s0=1.68, s1=2.58, y0=0, y1=2.05,
         at=14.65, hinge="s1", swing=-1.6, color=INNER_DOOR_C),
    dict(id="keet-toilet2", name="toilet door", fixed="v", w0=14.60, w1=14.70, s0=.42, s1=1.32, y0=0, y1=2.05,
         at=14.65, hinge="s0", swing=1.6, color=INNER_DOOR_C),
]
# The windows: the front one, then the lane side's from the front back (their panes' numbers follow this order).
WINDOWS = [dict(fixed="v", w0=0, w1=WALL, s0=FRONT_WINDOW["s0"], s1=FRONT_WINDOW["s1"], y0=FRONT_WINDOW["y0"], y1=FRONT_WINDOW["y1"])]
WINDOWS += [dict(fixed="u", w0=UI, w1=WIDTH, s0=o["s0"], s1=o["s1"], y0=o["y0"], y1=o["y1"]) for o in EAST_WINDOWS]
GLASS_AT = .15  # the panes, 15 cm into the wall (the model's glass: its frames' depth)
# For walking, the front door's opening reaches up to the fanlight's top (the fanlight is fixed glass there).
FANLIGHT = dict(fixed="v", w0=0, w1=WALL, s0=FRONT_DOOR["s0"], s1=FRONT_DOOR["s1"], y0=LEAF_TOP, y1=FRONT_DOOR["y1"])


def rect(o, w0=None, w1=None):
    """An opening's or door's box seen from above: (u0, v0, u1, v1)."""
    a, b = (o["w0"] if w0 is None else w0), (o["w1"] if w1 is None else w1)
    return (a, o["s0"], b, o["s1"]) if o["fixed"] == "u" else (o["s0"], a, o["s1"], b)


# --- blocks -----------------------------------------------------------------------------------------------------------
class Blocks:
    """Blocks in the frame as boxes (u0, v0, u1, v1, y0, y1), each with its surface `m`, tint `c`, room name `n`, and
    whether it is walked into (`s`) and drawn (`v`)."""

    def __init__(self):
        self.items = []

    def add(self, m, u0, v0, u1, v1, y0, y1, c=None, n=None, walk=True, draw=True, kind="structure"):
        if u1 - u0 < 1e-4 or v1 - v0 < 1e-4 or y1 - y0 < 1e-4:
            return
        self.items.append(dict(m=m, c=c, n=n, box=(u0, v0, u1, v1, y0, y1), walk=walk, draw=draw, kind=kind))

    def wall(self, m, fixed, w0, w1, a0, a1, y0, y1, holes, c=None, walk=True, draw=True):
        """A wall across `fixed` from w0 to w1, along the other axis from a0 to a1, from y0 to y1, round its holes (those
        in this wall: (s0, s1, y0, y1))."""
        xs = sorted({a0, a1, *[max(a0, min(a1, s)) for h in holes for s in (h[0], h[1])]})
        for xa, xb in zip(xs, xs[1:]):
            xm = (xa + xb) / 2
            y = y0
            for h0, h1 in sorted((h[2], h[3]) for h in holes if h[0] <= xm <= h[1]):
                self.box_on(m, fixed, w0, w1, xa, xb, y, min(h0, y1), c, walk, draw)
                y = max(y, h1)
            self.box_on(m, fixed, w0, w1, xa, xb, y, y1, c, walk, draw)

    def box_on(self, m, fixed, w0, w1, a, b, y0, y1, c, walk, draw):
        if fixed == "u":
            self.add(m, w0, a, w1, b, y0, y1, c, walk=walk, draw=draw)
        else:
            self.add(m, a, w0, b, w1, y0, y1, c, walk=walk, draw=draw)


def holes_in(fixed, w0, w1, items):
    """The openings (doors, windows) that cut a wall across `fixed` between w0 and w1: (s0, s1, y0, y1)."""
    return [(o["s0"], o["s1"], o["y0"], o["y1"]) for o in items if o["fixed"] == fixed and o["w0"] < w1 - 1e-6 and o["w1"] > w0 + 1e-6]


B = Blocks()
OPEN = DOORS + WINDOWS + [FANLIGHT]

# The outer walls: walked into through their whole thickness, drawn from the window depth in (the model is the outside).
for fixed, w0, w1, a0, a1 in (("v", 0, WALL, 0, WIDTH), ("v", VI, DEPTH, 0, WIDTH), ("u", 0, WALL, 0, DEPTH), ("u", UI, WIDTH, 0, DEPTH)):
    B.wall("wall", fixed, w0, w1, a0, a1, BELOW, SLAB, holes_in(fixed, w0, w1, OPEN), WALL_C, draw=False)
for fixed, w0, w1, a0, a1 in (("v", SKIN, WALL, WALL, UI), ("v", VI, DEPTH - SKIN, WALL, UI), ("u", SKIN, WALL, WALL, VI), ("u", UI, WIDTH - SKIN, WALL, VI)):
    B.wall("wall", fixed, w0, w1, a0, a1, 0, CEIL, holes_in(fixed, w0, w1, OPEN), WALL_C, walk=False)

# The partitions (the dividing wall, the corridors', the toilets'), walked into and drawn, round their doors.
PARTITIONS = [("v", 7.55, 7.67, WALL, UI), ("u", 2.70, 2.80, 11.70, VI), ("v", 11.70, 11.80, WALL, 2.70), ("v", 13.20, 13.30, WALL, 2.70),
              ("v", 14.60, 14.70, WALL, 2.70), ("u", 1.45, 1.55, 14.70, VI)]
for fixed, w0, w1, a0, a1 in PARTITIONS:
    B.wall("wall", fixed, w0, w1, a0, a1, BELOW, CEIL, holes_in(fixed, w0, w1, DOORS), WALL_C)

# The floors, each named with its room (behind the bar's reaches under the counter and the gate's way through).
for name, (u0, v0, u1, v1) in ROOMS.items():
    m, c = LOOK[name]
    if name == "behind the bar":
        u1 = 2.80
    B.add(m, u0, v0, u1, v1, BELOW, 0, c, n=name)
# Under the inner doors: the floor of the room the door opens into (the front and back doors' sills are the walls').
for d, room in (("keet-mid", "bar room"), ("keet-corridor", "back hall"), ("keet-toilets", "toilets"), ("keet-toilet1", "toilet 1"), ("keet-toilet2", "toilet 2")):
    door = next(x for x in DOORS if x["id"] == d)
    u0, v0, u1, v1 = rect(door)
    m, c = LOOK[room]
    B.add(m, u0, v0, u1, v1, BELOW, 0, c, n=room)
# The back door: its sill (the wall's), then one step down inside, and the floor.
BD = next(x for x in DOORS if x["id"] == "keet-back")
B.add("concrete", WALL, BD["s0"], WALL + .28, BD["s1"], BELOW, round(SILL / 2, 3), "#8f8a80", n="back hall")
# The front door's stone step outside, as the model draws it (tools/town/town.py: the doorstep).
B.add("concrete", FRONT_DOOR["s0"] - .08, -.28, FRONT_DOOR["s1"] + .08, 0, BELOW, FRONT_DOOR["y0"], "#5c5f62", draw=False)

# The ceiling, and its beams in the front room and the bar room (drawn only).
B.add("ceiling", WALL, WALL, UI, VI, CEIL, SLAB, CEIL_C)
for name, step in (("front room", .9), ("bar room", .9)):
    u0, v0, u1, v1 = ROOMS[name]
    v = v0 + .45
    while v + .06 < v1:
        B.add("c", u0, v - .06, u1, v + .06, CEIL - .14, CEIL, BEAM_C, walk=False)
        v += step

# The counter: its plain block, so the bar is closed off from the start (package B dresses it).
cu0, cv0, cu1, cv1, ch = COUNTER
B.add("oak", cu0, cv0, cu1, cv1, 0, ch, COUNTER_C, kind="furniture")


def lining(name, sides, height, m, c, rail=None, depth=.02):
    """Slabs against a room's walls, drawn only: panelling (with its rail) or tiles. `sides`: which of the room's sides
    ('u0', 'u1', 'v0', 'v1', or (side, from, to) for part of one), each cut round the doors and windows in it."""
    u0, v0, u1, v1 = ROOMS[name]
    for side in sides:
        side, a0, a1 = side if isinstance(side, tuple) else (side, None, None)
        fixed = side[0]
        at = {"u0": u0, "u1": u1, "v0": v0, "v1": v1}[side]
        if a0 is None:
            a0, a1 = (v0, v1) if fixed == "u" else (u0, u1)
        sign = 1 if side.endswith("0") else -1
        w0, w1 = (at, at + depth) if sign > 0 else (at - depth, at)
        holes = holes_in(fixed, at - .01, at + .01, OPEN)
        before = len(B.items)
        B.wall(m, fixed, w0, w1, a0, a1, 0, height, holes, c, walk=False)
        if rail:
            rw0, rw1 = (at, at + .04) if sign > 0 else (at - .04, at)
            for it in B.items[before:]:
                bu0, bv0, bu1, bv1, by0, by1 = it["box"]
                if by0 > .01:
                    continue  # over a door or window: no panelling there
                s0, s1 = (bv0, bv1) if fixed == "u" else (bu0, bu1)
                B.box_on("c", fixed, rw0, rw1, s0, s1, by1, by1 + RAIL, rail, False, True)  # on its top (under a window: its sill)


lining("front room", ("u0", "u1", "v0", "v1"), PANEL, "oak", PANEL_C, RAIL_C)
# The bar room's west side is the counter's back and the way behind the bar as far as the partition.
lining("bar room", (("u0", 11.70, VI), "u1", "v0", "v1"), PANEL, "oak", PANEL_C, RAIL_C)
lining("behind the bar", ("u0", "v0", "v1"), PANEL, "oak", PANEL_C, RAIL_C)
for name in ("back hall", "toilets", "toilet 1", "toilet 2"):
    lining(name, ("u0", "u1", "v0", "v1"), DADO, "bath", TILE_C, depth=.01)

# The fanlight over the front door: fixed glass, as the model's (walked into as glass; its picture is the model's).
B.add("glassfix", FANLIGHT["s0"], GLASS_AT - .01, FANLIGHT["s1"], GLASS_AT + .01, FANLIGHT["y0"], FANLIGHT["y1"])


# --- the part shapes, for the fittings (world/walkIn.ts part(): box, rod, lathe, oval, beam, curtain) -------------------
class Api:
    """What tools/keet_fittings.py gets: points in the frame, the part shapes (in the frame: x = u, z = v, y over the
    floor), and blocks. Every part is drawn only; a block walked into but not drawn stands for its shape (`solid`)."""

    def __init__(self, blocks):
        self.blocks = blocks
        self.parts, self.fixtures, self.props = [], [], []
        self.rooms = ROOMS
        self.doors = DOORS
        self.windows = WINDOWS
        self.floor = FLOOR

    @staticmethod
    def at(u, v):
        """The house frame's coordinates (x, z) of a point (u, v): the same numbers in this frame."""
        return (u, v)

    def box(self, x, y, z, w, h, d, color, yaw=0.0, surface=None):
        """A box standing on (x, y, z): w across x, h up, d across z, turned by yaw; `surface` e.g. 'oak'."""
        self.parts.append(["b", x, y, z, w, h, d, yaw, color] + ([surface] if surface else []))

    def rod(self, a, b, r, color, sides=8):
        """A round rod from a to b (x, y, z), radius r, open at its ends."""
        self.parts.append(["r", *a, *b, r, color, sides])

    def lathe(self, x, y, z, profile, color, segments=16):
        """A turned shape round a vertical axis at (x, y, z): `profile` [(radius, height)...]."""
        self.parts.append(["l", x, y, z, [list(p) for p in profile], color, segments])

    def oval(self, x, y, z, rx, rz, h, color):
        """An oval slab standing on (x, y, z), radii rx and rz, h high."""
        self.parts.append(["e", x, y, z, rx, rz, h, color])

    def beam(self, a, b, w, h, color):
        """A square beam from a to b (x, y, z), w across and h high."""
        self.parts.append(["k", *a, *b, w, h, color])

    def curtain(self, x0, z0, x1, z1, y0, y1, amp, folds, color):
        """A hanging curtain from (x0, z0) to (x1, z1), y0 to y1, folds `amp` deep."""
        self.parts.append(["s", x0, z0, x1, z1, y0, y1, amp, folds, color])

    def solid(self, u0, v0, u1, v1, y0, y1, name=None):
        """A block walked into but not drawn: furniture's room in the way (checked against the doorways)."""
        self.blocks.add("c", u0, v0, u1, v1, y0, y1, n=name, draw=False, kind="furniture")

    def block(self, m, u0, v0, u1, v1, y0, y1, c=None, walk=True, draw=True, name=None):
        """A block of the inside's own surfaces (world/walkIn.ts SURFACES), walked into or drawn or both."""
        self.blocks.add(m, u0, v0, u1, v1, y0, y1, c, n=name, walk=walk, draw=draw, kind="furniture" if walk else "structure")


def part_triangles(p):
    """Triangles of a part as world/walkIn.ts builds it (three.js geometries)."""
    k = p[0]
    if k in ("b", "k"):
        return 12
    if k == "r":
        return 2 * int(p[9])
    if k == "l":
        return 2 * (len(p[4]) - 1) * int(p[6])
    if k == "e":
        return 32 * 4
    if k == "s":
        return 4 * 6 * int(p[8])
    raise ValueError(f"no such part: {k}")


def self_test():
    """One throwaway part of each shape: their arrays as world/walkIn.ts part() reads them (positions by index)."""
    t = Api(Blocks())
    t.box(1, 0, 2, .5, .7, .4, "#123456", .3, "oak")
    t.rod((0, 0, 0), (0, 1, 0), .02, "#111111")
    t.lathe(1, 0, 1, [(0, 0), (.2, .1), (0, .3)], "#222222", 12)
    t.oval(2, .7, 3, .4, .5, .03, "#333333")
    t.beam((0, 2, 0), (1, 2, 0), .1, .12, "#444444")
    t.curtain(0, 0, 1, 0, 1, 2, .03, 4, "#555555")
    t.solid(0, 0, 1, 1, 0, .8, "x")
    want = [["b", 1, 0, 2, .5, .7, .4, .3, "#123456", "oak"], ["r", 0, 0, 0, 0, 1, 0, .02, "#111111", 8],
            ["l", 1, 0, 1, [[0, 0], [.2, .1], [0, .3]], "#222222", 12], ["e", 2, .7, 3, .4, .5, .03, "#333333"],
            ["k", 0, 2, 0, 1, 2, 0, .1, .12, "#444444"], ["s", 0, 0, 1, 0, 1, 2, .03, 4, "#555555"]]
    assert t.parts == want, t.parts
    assert [part_triangles(p) for p in t.parts] == [12, 16, 48, 128, 12, 96]
    assert t.blocks.items[0]["walk"] and not t.blocks.items[0]["draw"] and t.blocks.items[0]["kind"] == "furniture"


self_test()

# --- the fittings (package B), when that tool is there -----------------------------------------------------------------
API = Api(B)
_fit = ROOT / "tools/keet_fittings.py"
if _fit.exists():
    _spec = importlib.util.spec_from_file_location("keet_fittings", _fit)
    _mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
    _mod.fittings(API)


# --- the checks ---------------------------------------------------------------------------------------------------------
def overlap(a, b, eps=1e-3):
    return all(a[i] < b[i + 3] - eps and b[i] < a[i + 3] - eps for i in range(3))


def as3(box2, y0, y1):
    u0, v0, u1, v1 = box2
    return (u0, y0, v0, u1, y1, v1)


def box3(it):
    u0, v0, u1, v1, y0, y1 = it["box"]
    return (u0, y0, v0, u1, y1, v1)


failed = []
walked = [it for it in B.items if it["walk"]]
for d in DOORS:
    # The opening and 5 cm either side of its wall, from 2 cm over its threshold to 2 cm under its head.
    hole = as3(rect(d, d["w0"] - .05, d["w1"] + .05), d["y0"] + .02, d["y1"] - .02)
    hit = [it for it in walked if overlap(hole, box3(it))]
    if hit:
        failed.append(f"{d['id']}: its opening is not free ({len(hit)} blocks, the first {hit[0]['box']})")
    # Its approach, half a metre on each side: no furniture in the way.
    way = as3(rect(d, d["w0"] - .5, d["w1"] + .5), max(d["y0"], 0) + .1, d["y1"] - .1)
    for it in walked:
        if it["kind"] == "furniture" and overlap(way, box3(it)):
            failed.append(f"{d['id']}: furniture {it['box']} stands in its way")
for name, (u0, v0, u1, v1) in ROOMS.items():
    if not any(it["n"] == name and abs(it["box"][5]) < 1e-6 and it["box"][0] <= u0 + 1e-6 and it["box"][1] <= v0 + 1e-6
               and it["box"][2] >= u1 - 1e-6 and it["box"][3] >= v1 - 1e-6 for it in walked):
        failed.append(f"{name}: no floor block covers it")
# Nothing to stand on without room for the body (web/src/player.ts HEIGHT) under the ceiling: the walking code steps
# up and lands without asking for headroom, and a head in the ceiling throws the body into a wall. A top between
# CEIL - BODY and the ceiling needs a block over it low enough that a body high enough to step onto it (feet within
# STEP of the top) already meets that block. Glass counts as walked into (world/walkIn.ts adds every `glassfix` block).
BODY, STEP = 1.8, .5  # web/src/player.ts HEIGHT, STEP_UP
stands = [it for it in B.items if it["walk"] or it["m"] == "glassfix"]
for it in stands:
    u0, v0, u1, v1, y0, y1 = it["box"]
    if not CEIL - BODY + 1e-3 < y1 < CEIL - 1e-3:
        continue
    # The ceiling itself is no such block: a body pushed up into it is thrown out sideways.
    if not any(c is not it and y1 - 1e-6 <= c["box"][4] <= min(y1 + BODY - STEP, CEIL - .05) and c["box"][0] <= u0 + 1e-6 and c["box"][1] <= v0 + 1e-6
               and c["box"][2] >= u1 - 1e-6 and c["box"][3] >= v1 - 1e-6 for c in stands):
        failed.append(f"{[round(x, 3) for x in it['box']]}: a top {CEIL - y1:.2f} m under the ceiling with nothing over it: no room for a body there")
drawn = [it for it in B.items if it["draw"] and it["m"] != "glassfix"]
TRIS = 12 * len(drawn) + sum(part_triangles(p) for p in API.parts)

# --- the files ----------------------------------------------------------------------------------------------------------
def r3(x):
    """Rounded to the millimetre (no -0)."""
    if isinstance(x, float):
        v = round(x, 3)
        return 0.0 if v == 0 else v
    if isinstance(x, (list, tuple)):
        return [r3(y) for y in x]
    if isinstance(x, dict):
        return {k: r3(v) for k, v in x.items()}
    return x


def ring(u0, v0, u1, v1):
    return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]


def prism(it):
    u0, v0, u1, v1, y0, y1 = it["box"]
    out = {"m": it["m"]}
    if it["c"]:
        out["c"] = it["c"]
    out.update({"y0": y0, "y1": y1, "p": [ring(u0, v0, u1, v1)]})
    if it["n"]:
        out["n"] = it["n"]
    if not it["walk"]:
        out["s"] = 0
    if not it["draw"]:
        out["v"] = 0
    return out


def door_spec(d):
    a, b = (d["s1"], d["s0"]) if d["hinge"] == "s1" else (d["s0"], d["s1"])
    pa, pb = ((d["at"], a), (d["at"], b)) if d["fixed"] == "u" else ((a, d["at"]), (b, d["at"]))
    panel = {"a": list(pa), "b": list(pb), "offset": 0, "thickness": d.get("thickness", .05), "glass": False}
    if d.get("outside"):
        panel["outside"] = d["outside"]
    panel.update({"color": d["color"], "swing": d["swing"], "handle": d.get("handle", True)})
    spec = {"id": d["id"], "name": d["name"], "level": "gf", "y0": d["y0"], "y1": d["y1"], "panels": [panel]}
    if d.get("open"):
        spec["open"] = True
    if d.get("both"):
        spec["both"] = True
    return spec


def clip_half(poly, f):
    """The part of a polygon (2D points) where f(p) >= 0, f linear."""
    out = []
    for i, a in enumerate(poly):
        b = poly[(i + 1) % len(poly)]
        fa, fb = f(a), f(b)
        if fa >= 0:
            out.append(a)
        if (fa >= 0) != (fb >= 0):
            t = fa / (fa - fb)
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def area(poly):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(poly, poly[1:] + poly[:1])) / 2


def ground_cuts(ring_):
    """The relief's 4 m squares under a convex ring (world x, z): their numbers, and what is left of them outside it as
    triangles cut along each square's diagonal, as world/terrain.ts draws the ground (as tools/kapellenhoek_home.py)."""
    x0, z0, st, nx = GRID["x0"], GRID["z0"], GRID["step"], GRID["nx"]
    if area(ring_) < 0:
        ring_ = ring_[::-1]
    xs, zs = [p[0] for p in ring_], [p[1] for p in ring_]
    cells, tris = [], []
    for j in range(int((min(zs) - z0) // st), int((max(zs) - z0) // st) + 1):
        for i in range(int((min(xs) - x0) // st), int((max(xs) - x0) // st) + 1):
            a = (x0 + i * st, z0 + j * st)
            b, c, d = (a[0] + st, a[1]), (a[0] + st, a[1] + st), (a[0], a[1] + st)
            inner = [a, b, c, d]
            for k, p in enumerate(ring_):
                q = ring_[(k + 1) % len(ring_)]
                inner = clip_half(inner, lambda r, p=p, q=q: (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) if inner else inner
            if len(inner) < 3 or abs(area(inner)) < 1e-3:
                continue
            cells.append(j * (nx - 1) + i)
            for tri in ((a, c, b), (a, d, c)):
                rest = list(tri)
                for k, p in enumerate(ring_):
                    q = ring_[(k + 1) % len(ring_)]
                    side = lambda r, p=p, q=q: (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
                    piece = clip_half(rest, lambda r: -side(r)) if rest else []
                    if len(piece) >= 3 and abs(area(piece)) > 1e-4:
                        for m in range(1, len(piece) - 1):
                            for r in (piece[0], piece[m], piece[m + 1]):
                                tris += [round(r[0], 3), round(r[1], 3)]
                    rest = clip_half(rest, side) if rest else []
    return {"cells": cells, "tris": tris}


OUTLINE = [list(P[i]) for i in (1, 2, 3, 0)]  # from the front's west corner, round to the east
village = json.loads((ROOT / "web/src/data/village.json").read_text(encoding="utf-8"))
cuts = ground_cuts([tuple(p) for p in OUTLINE])
taken = set(village["groundCuts"]["cells"])
for f in ("molenhoek_end_shell.json", "kapellenhoek_home_shell.json"):
    taken |= set(json.loads((ROOT / "web/src/data" / f).read_text(encoding="utf-8"))["groundCuts"]["cells"])
if taken & set(cuts["cells"]):
    failed.append(f"the ground under the café is cut out by something else too: squares {sorted(taken & set(cuts['cells']))}")
# Inside, the ground for walking lies under the floors (the relief rises 0.33 m to the back wall).
low = FLOOR_RELIEF - .45 + .5
dip = {"name": "café floor", "rim": OUTLINE, "bottom": OUTLINE, "depth": .5, "low": low}


def wring(u0, v0, u1, v1):
    return [list(world(u, v)) for u, v in ring(u0, v0, u1, v1)]


# The house as solids, in the world and the game's heights: the lump stands in for the rooms until they come; the shut
# upstairs and the roof (three steps up to the ridge along the house's middle) stay.
solids = [{"p": [OUTLINE], "y0": FLOOR + BELOW, "y1": FLOOR + 2.95}, {"p": [OUTLINE], "y0": FLOOR + UPSTAIRS, "y1": FLOOR + EAVES}]
for k in range(3):
    h0, h1 = EAVES + (RIDGE - EAVES) * k / 3, EAVES + (RIDGE - EAVES) * (k + 1) / 3
    half = WIDTH / 2 * (1 - ((h0 + h1) / 2 - EAVES) / (RIDGE - EAVES))  # where the roof is at the step's middle height
    solids.append({"p": [wring(WIDTH / 2 - half, 0, WIDTH / 2 + half, DEPTH)], "y0": FLOOR + h0, "y1": FLOOR + h1})

panes = []
for wdw in WINDOWS:
    w0, w1 = (GLASS_AT - .01, GLASS_AT + .01) if wdw["w0"] < 1 else (WIDTH - GLASS_AT - .01, WIDTH - GLASS_AT + .01)
    panes.append({"p": [ring(*rect(wdw, w0, w1))], "y0": wdw["y0"], "y1": wdw["y1"]})
a = math.atan2(-U[1], U[0])  # walkIn.ts: its x axis (cos a, -sin a) is U, its z axis (sin a, cos a) is V
for u, v in ((0, 0), (WIDTH, 0), (0, DEPTH), (3, 7)):
    x, z = O[0] + u * math.cos(a) + v * math.sin(a), O[1] - u * math.sin(a) + v * math.cos(a)
    assert math.hypot(x - world(u, v)[0], z - world(u, v)[1]) < 1e-9, "the shell's frame does not match"
centre = [sum(p[0] for p in OUTLINE) / 4, sum(p[1] for p in OUTLINE) / 4]
shell = r3({
    "key": "keet",
    "frame": {"o": list(O), "a": round(a, 6), "floor": FLOOR},
    "centre": centre,
    "outline": OUTLINE,
    "levels": [{"id": "gf", "name": "Ground floor", "floor": 0}],
    "doors": [door_spec(d) for d in DOORS if d.get("shell")],
    "panes": panes,
    "groundCuts": cuts,
    "dip": dip,
    "lawn": {"p": [], "y": FLOOR},
    "plot": [],
    "solids": solids,
})
shell["frame"]["a"] = round(a, 6)
# An `EndInside` of world/walkIn.ts, the public café's (web/shared/publicClean.test.mjs allows this file by name).
rooms = r3({
    "rooms": list(ROOMS),
    "prisms": [prism(it) for it in B.items],
    "parts": API.parts,
    "fixtures": API.fixtures,
    "props": API.props,
    "doors": [door_spec(d) for d in DOORS if not d.get("shell")],
})

print(f"keet: {WIDTH:.2f} x {DEPTH:.2f} m, floor {FLOOR:.3f} m (relief {FLOOR_RELIEF:.3f}), back door's sill {SILL:.3f} m")
print(f"rooms: {len(B.items)} blocks ({len(walked)} walked into, {len(drawn)} drawn), {len(API.parts)} parts, {len(rooms['doors'])} inner doors")
print(f"shell: {len(shell['doors'])} doors, {len(panes)} panes, {len(solids)} solids, {len(cuts['cells'])} cut squares")
print(f"triangles: {TRIS} (at most 30,000)")
for name, (u0, v0, u1, v1) in ROOMS.items():
    print(f"  {name}: {u1 - u0:.2f} x {v1 - v0:.2f} m")
if TRIS > 30000:
    failed.append(f"{TRIS} triangles: over 30,000")
if failed:
    for f in failed:
        print("FAILED:", f)
    sys.exit(1)
SHELL_OUT.write_text(json.dumps(shell, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
ROOMS_OUT.write_text(json.dumps(rooms, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
print("written", SHELL_OUT.relative_to(ROOT).as_posix(), ROOMS_OUT.relative_to(ROOT).as_posix())
