"""Turn the extracted walls plus the hand-measured additions into 3D blocks.

Every solid in the walkthrough is a "prism": a flat outline (x, z) extruded
between two heights, with one material. The browser uses the same prisms for
drawing and for collision, so what you see is exactly what you bump into.

Materials: the outer 11 cm of every facade wall becomes brick and the rest
plaster; each room gets its own floor finish; roofs, terraces, stairs and the
garden get theirs.

Reads data/extracted.json and data/house.manual.json, writes web/src/data/house.json: the house,
the bungalow and the garden (`prisms`), and the surroundings within AREA of the plot
(`surroundings`), all loaded at the start. The rest of the surroundings (the band to the village
and the village itself) goes to web/src/data/village.json, which the browser loads once the start
screen is up. Ground covers, hedges and fences out there are cut along the browser's tiles (TILE
metres, web/src/world/tiles.ts), so each piece lies in one tile.
Run from the project root after extract_plan.py:
    tools/.venv/Scripts/python.exe tools/build_house.py
"""
import json
import math
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon, box
from shapely.affinity import translate
from shapely.ops import linemerge, unary_union
import shapely

import facades
import furniture
import garden
import old_house
import terrain
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parent.parent
EXTRACTED = ROOT / "data/extracted.json"
MANUAL = ROOT / "data/house.manual.json"
OUT = ROOT / "web/src/data/house.json"  # inside the app, so web/ builds on its own
VILLAGE_OUT = ROOT / "web/src/data/village.json"  # loaded later (see the module's notes)

CX, CZ = 4.45, -3.0  # the plot's middle (model)
AREA = 540           # m: the surroundings loaded at the start (tools/neighbours.py)
TILE = 200           # m: the browser's tiles, centred on the plot's middle (web/src/world/tiles.ts)
GATE = 8.0           # m: the widest drive or gateway a plot line's fence makes way for

PANE = 0.03       # glass thickness
COPING = 0.025    # how far the roof-edge copings stand out from the brick
PROFILE = 0.05    # face width of aluminium window frames
PROFILE_D = 0.07  # depth of aluminium window frames
SASH = 0.055      # face width of an opening sash, inside the frame
OPENING = ("turn", "tilt-turn", "slide", "door")
HALLS = ("hal", "inkom")  # doors swing into rooms, not into these
FRAME = 0.25      # depth of sills and headers along manual glass runs
STEP_BODY = 0.25  # thickness of an indoor stair tread block
SKIN = 0.11       # facing brick plus cavity, measured from the outer face
FINISH = 0.015    # floor finish thickness on top of the slab


def rings(geom):
    """Shapely polygon(s) to lists of [outer, *holes] coordinate rings."""
    out = []
    for g in getattr(geom, "geoms", [geom]):
        if g.is_empty or g.geom_type != "Polygon" or g.area < 1e-5:
            continue
        r = lambda ring: [[round(x, 3), round(z, 3)] for x, z in list(ring.coords)[:-1]]
        out.append([r(g.exterior), *[r(i) for i in g.interiors]])
    return out


def floor_finish(room):
    name = room.lower()
    if any(k in name for k in ("slaapkamer", "bureau")):
        return "floor_wood"
    if any(k in name for k in ("badkamer", "sanitair")):
        return "terrazzo"  # per the bathroom supplier's drawings
    if "wc" in name:
        return "floor_bath"
    if "terras" in name:
        return "terrace"
    return "floor_tile"


class Builder:
    def __init__(self):
        self.doors = []
        self.prisms = []
        self.outside = []  # the surroundings' blocks (tools/neighbours.py, street.py), apart from the house's
        self.target = self.prisms  # where add() puts blocks
        self.fixtures = []  # built-in furniture (furnishing.ts), from tools/old_house.py and tools/furniture.py
        self.props = []  # models placed by the build scripts (the bungalow's fanlight)
        self.skin_zone = None  # where walls count as facade brick, per level
        self.sills = []  # windows that get a bluestone sill: (a, d, n, length, height)

    def add(self, material, y0, y1, geom, name=None, **extra):
        if y1 - y0 < 0.005 or geom.is_empty:
            return
        for p in rings(geom):
            prism = {"m": material, "y0": round(y0, 3), "y1": round(y1, 3), "p": p, **extra}
            if name:
                prism["n"] = name  # shown in the HUD when you stand on it
            self.target.append(prism)

    def wall(self, y0, y1, geom):
        """A wall-like block: brick on the facade side, plaster inside."""
        if self.skin_zone is None:
            self.add("plaster", y0, y1, geom)
            return
        self.add("brick", y0, y1, geom.intersection(self.skin_zone))
        self.add("plaster", y0, y1, geom.difference(self.skin_zone))

    def path(self, material, y0, y1, width, points):
        geom = LineString(points).buffer(width / 2, cap_style="flat", join_style="mitre")
        if material == "wall":
            self.wall(y0, y1, geom)
        else:
            self.add(material, y0, y1, geom)


def opening_band(o, interior, d0, d1):
    """The strip of an opening between d0 and d1 metres from its middle, towards the outside."""
    (cx, cz), hw = o["center"], o["width"] / 2
    ux, uz = o["dir"]
    nx, nz = -uz, ux
    if interior.contains(Point(cx + nx * (o["thickness"] / 2 + 0.3), cz + nz * (o["thickness"] / 2 + 0.3))):
        nx, nz = -nx, -nz  # the normal pointed inside
    return Polygon([(cx + ux * s * hw + nx * d, cz + uz * s * hw + nz * d) for s, d in ((-1, d0), (1, d0), (1, d1), (-1, d1))])


def opening_rect(o):
    hw, ht = o["width"] / 2, o["thickness"] / 2
    ex, ez = (hw, ht) if o["dir"][0] else (ht, hw)
    cx, cz = o["center"]
    return box(cx - ex, cz - ez, cx + ex, cz + ez)


def pane_rect(o):
    """Thin glass pane through the middle of an opening."""
    hw = o["width"] / 2
    cx, cz = o["center"]
    return box(cx - hw, cz - PANE / 2, cx + hw, cz + PANE / 2) if o["dir"][0] else box(cx - PANE / 2, cz - hw, cx + PANE / 2, cz + hw)


def frame_box(b, a, d, n, u0, u1, y0, y1, depth=PROFILE_D, mats=("alu_out", "alu_in")):
    """One aluminium profile: u along the window from point a, across it the outer half in
    RAL 8017 brown and the inner half in RAL 9010 white (Toffly quote, colour 8017C / 9010M)."""
    for v0, v1, mat in ((0, depth / 2, mats[0]), (-depth / 2, 0, mats[1])):
        corners = ((u0, v0), (u1, v0), (u1, v1), (u0, v1))
        b.add(mat, y0, y1, Polygon([(a[0] + d[0] * u + n[0] * v, a[1] + d[1] * u + n[1] * v) for u, v in corners]))


def outward(center, d, interior, given=None):
    """Unit normal of a window line pointing outside the house."""
    if given:
        return given
    n = (-d[1], d[0])
    return (-n[0], -n[1]) if interior.contains(Point(center[0] + n[0] * 0.5, center[1] + n[1] * 0.5)) else n


def world_parts(panes, d, n):
    """Window parts from the quote drawings (seen from inside, left to right) in the order
    along d. Each part is [width, kind]; kind is fixed, turn, tilt-turn, slide or door."""
    right = (-n[1], n[0])  # to the right of someone inside looking out
    parts = [tuple(p) for p in panes] if panes else [(1, "fixed")]
    return parts if right[0] * d[0] + right[1] * d[1] > 0 else parts[::-1]


def frame_window(b, a, d, n, length, sill, head, parts, jambs=(True, True), mats=("alu_out", "alu_in")):
    """Frame, mullions and sashes of one straight window from a along d (mats: outside, inside)."""
    if jambs[0]:
        frame_box(b, a, d, n, 0, PROFILE, sill, head, mats=mats)
    if jambs[1]:
        frame_box(b, a, d, n, length - PROFILE, length, sill, head, mats=mats)
    frame_box(b, a, d, n, 0, length, head - PROFILE, head, mats=mats)
    frame_box(b, a, d, n, 0, length, sill, sill + PROFILE, mats=mats)
    total = sum(w for w, _ in parts)
    u = 0.0
    for i, (w, kind) in enumerate(parts):
        u0, u1 = u, u + length * w / total
        u = u1
        if i:
            frame_box(b, a, d, n, u0 - PROFILE / 2, u0 + PROFILE / 2, sill + PROFILE, head - PROFILE, mats=mats)
        if kind in OPENING and kind != "door":  # a door part gets its own leaf (glass_doors)
            # The sash: a second, slightly shallower frame inside this part's opening.
            l0 = u0 + (PROFILE / 2 if i else (PROFILE if jambs[0] else 0))
            l1 = u1 - (PROFILE / 2 if i < len(parts) - 1 else (PROFILE if jambs[1] else 0))
            y0, y1 = sill + PROFILE, head - PROFILE
            for bu0, bu1, by0, by1 in ((l0, l0 + SASH, y0, y1), (l1 - SASH, l1, y0, y1), (l0, l1, y1 - SASH, y1), (l0, l1, y0, y0 + SASH)):
                frame_box(b, a, d, n, bu0, bu1, by0, by1, PROFILE_D * 0.8, mats=mats)


def window_frame(b, o, f, pane, interior):
    """Frame of a window opening, with the panes from the window maker's quote (o["panes"])."""
    d = o["dir"]
    cx, cz = pane.centroid.x, pane.centroid.y
    w = o["width"]
    n = outward((cx, cz), d, interior, o.get("outside"))
    a = (cx - d[0] * w / 2, cz - d[1] * w / 2)
    frame_window(b, a, d, n, w, f + o["sill"], f + o["head"], world_parts(o.get("panes"), d, n))
    if not o.get("screen"):  # every window has a sill outside, also the ones down to the floor upstairs
        b.sills.append((a, d, n, w, f + o["sill"]))


def glass_run_frame(b, g, f, interior):
    """Frames along a glass wall: one straight window per segment of the path, panes from the
    quote (g["panes"], one list per segment). A "glass" corner has no post: the panes meet."""
    path = g["path"]
    for i, ((x0, z0), (x1, z1)) in enumerate(zip(path, path[1:])):
        length = math.hypot(x1 - x0, z1 - z0)
        d = ((x1 - x0) / length, (z1 - z0) / length)
        n = outward(((x0 + x1) / 2, (z0 + z1) / 2), d, interior)
        panes = g["panes"][i] if g.get("panes") else None
        corner = g.get("corner") == "glass"
        jambs = (not (corner and i > 0), not (corner and i < len(path) - 2))
        frame_window(b, (x0, z0), d, n, length, f + g["sill"], f + g["head"], world_parts(panes, d, n), jambs)
        if g["sill"] > 0.25:
            b.sills.append(((x0, z0), d, n, length, f + g["sill"]))


def glass_doors(b, g, f, interior):
    """Door parts of a glass wall (kind "door" in its panes): a glazed aluminium leaf hinged at
    the end of the run (else at its start), swinging in like the outside doors. Returns the strips
    of the run the leaves fill, so the fixed glass leaves them out."""
    path = g["path"]
    strips = []
    for i, ((x0, z0), (x1, z1)) in enumerate(zip(path, path[1:])):
        if not g.get("panes"):
            break
        length = math.hypot(x1 - x0, z1 - z0)
        d = ((x1 - x0) / length, (z1 - z0) / length)
        n = outward(((x0 + x1) / 2, (z0 + z1) / 2), d, interior)
        parts = world_parts(g["panes"][i], d, n)
        total = sum(w for w, _ in parts)
        u = 0.0
        for k, (w, kind) in enumerate(parts):
            u0, u1 = u, u + length * w / total
            u = u1
            if kind != "door":
                continue
            l0 = u0 + (PROFILE / 2 if k else PROFILE) + 0.004
            l1 = u1 - (PROFILE / 2 if k < len(parts) - 1 else PROFILE) - 0.004
            at = lambda t: [round(x0 + d[0] * t, 3), round(z0 + d[1] * t, 3)]
            hinge, other = (l1, l0) if k == len(parts) - 1 else (l0, l1)
            a, c = at(hinge), at(other)
            dx, dz = c[0] - a[0], c[1] - a[1]
            inward = -dz * n[0] + dx * n[1] < 0  # the leaf's normal side is the inside
            b.doors.append({
                "id": f"glassdoor-{g['level']}-{len([q for q in b.doors if q['id'].startswith('glassdoor')])}",
                "name": "glass door", "level": g["level"], "y0": round(f + g["sill"] + PROFILE, 3),
                "y1": round(f + g["head"] - PROFILE - 0.005, 3), "open": False,
                "panels": [{"a": a, "b": c, "offset": 0, "thickness": 0.05, "glass": True,
                            "swing": 1.45 if inward else -1.45, "outside": -1 if inward else 1}],
            })
            strips.append(LineString([at(u0), at(u1)]).buffer(0.2, cap_style="flat"))
    return strips


def sidelight(b, o, f, interior):
    """A fixed glass panel at one end of a door opening (the front door, R0.1): glass and frame
    in that part, and the opening shrinks to the door itself for its leaf."""
    s = o["sidelight"]
    d, (cx, cz), w = o["dir"], o["center"], o["width"]
    sign = -1 if s["end"] == "low" else 1
    mid = (cx + d[0] * sign * (w - s["width"]) / 2, cz + d[1] * sign * (w - s["width"]) / 2)
    part = {**o, "center": list(mid), "width": s["width"], "sill": 0.0, "panes": None}
    pane = pane_rect(part)
    b.add("glass", f, f + o["head"], pane, **({"matte": True} if s.get("matte") else {}))
    window_frame(b, part, f, pane, interior)
    # The opening keeps its size (it closes the room); only the door leaf gets the rest.
    o["leaf_span"] = ([cx - d[0] * sign * s["width"] / 2, cz - d[1] * sign * s["width"] / 2], w - s["width"])


def inside_opening(o, interior):
    """An opening with the house on both sides (a door between rooms)."""
    (cx, cz), (ux, uz) = o["center"], o["dir"]
    reach = o["thickness"] / 2 + 0.45
    return interior.contains(Point(cx - uz * reach, cz + ux * reach)) and interior.contains(Point(cx + uz * reach, cz - ux * reach))


def auto_doors(b, lv, openings, named_rooms, man, interior):
    """A swinging door leaf in every door opening that has no door yet, hung and swinging as the
    plan draws it (`swing`, from tools/extract_plan.py); where the plan draws no swing, inside
    doors swing into the room (not into a hall) and doors to the outside swing in. Inside doors
    stand open (the toilets' shut); doors to the outside start closed."""
    f = lv["floor"]
    manual = [LineString([p["a"], p["b"]]) for d in man.get("doors", []) if d["level"] == lv["id"] for p in d["panels"]]
    # A manual door that stands elsewhere than its opening (the hidden kitchen door) names it.
    manual += [Point(d["replaces"]) for d in man.get("doors", []) if d["level"] == lv["id"] and "replaces" in d]
    def room_at(x, z):
        return next((n for n, poly in named_rooms if poly.contains(Point(x, z))), None)
    for o in openings:
        (cx, cz), width = o.get("leaf_span", (o["center"], o["width"]))
        if o["type"] != "door" or width > 1.25 or any(m.distance(Point(cx, cz)) < 0.4 for m in manual):
            continue
        ux, uz = o["dir"]
        nx, nz = -uz, ux
        half = width / 2 - 0.01
        reach = o["thickness"] / 2 + 0.45
        plus, minus = (cx + nx * reach, cz + nz * reach), (cx - nx * reach, cz - nz * reach)
        outside_plus = not interior.contains(Point(plus))
        outside_minus = not interior.contains(Point(minus))
        rp, rm = room_at(*plus), room_at(*minus)
        if outside_plus or outside_minus:
            side, into, name, start_open = (-1 if outside_plus else 1), (rm if outside_plus else rp), "outside door", False
        else:
            hall_p = rp is not None and rp.lower().startswith(HALLS) or (rp or "").lower().endswith("hal")
            hall_m = rm is not None and rm.lower().startswith(HALLS) or (rm or "").lower().endswith("hal")
            side = -1 if hall_p and not hall_m else 1
            into = rm if side < 0 else rp
            name = f"door to {into}" if into else "door"
            start_open = not (into or "").lower().startswith("wc")  # toilets: door shut
        plan = o.get("swing") if not o.get("leaf", {}).get("hinge") else None
        if plan:  # the plan's swing (the name stays the room it leads to, not the side it opens to)
            side = plan["side"]
        if o.get("into"):  # a room the plan leaves unnamed
            into, name = o["into"], f"door to {o['into']}"
        ends = [[cx - ux * half, cz - uz * half], [cx + ux * half, cz + uz * half]]
        outside = 1 if outside_plus else -1
        if o.get("leaf", {}).get("hinge") == "high" or (plan and plan["hinge"] == "high"):
            # Hinged at the other end: the leaf runs the other way, so its normal and swing flip.
            ends, side, outside = ends[::-1], -side, -outside
        b.doors.append({
            "id": f"door-{lv['id']}-{len([d for d in b.doors if d['level'] == lv['id']])}",
            "name": name, "level": lv["id"], "y0": f, "y1": f + o["head"] - 0.01, "open": start_open,
            "panels": [{"a": ends[0], "b": ends[1],
                        "offset": 0, "thickness": 0.04, "glass": bool(o.get("leaf", {}).get("glass")),
                        "swing": round(side * 1.45, 3),
                        # Outside doors are aluminium (Toffly quote): which face is outside, frosted glass.
                        **({"outside": outside} if outside_plus or outside_minus else {}),
                        **({"matte": True} if o.get("leaf", {}).get("matte") else {}),
                        **({"surface": o["leaf"]["surface"]} if o.get("leaf", {}).get("surface") else {})}],
        })


def manual_opening(e):
    x0, z0, x1, z1 = e["rect"]
    along_x = e["dir"][0] == 1
    o = {"center": [(x0 + x1) / 2, (z0 + z1) / 2], "dir": e["dir"], "width": (x1 - x0) if along_x else (z1 - z0),
         "thickness": (z1 - z0) if along_x else (x1 - x0), "type": e["type"], "sill": e.get("sill", 0.0), "head": e["head"]}
    for key in ("lintel", "leaf", "swing", "into"):  # the wall above it if not brick; the door leaf's finish; how it hangs; the room behind it
        if key in e:
            o[key] = e[key]
    return o


def build_level(b, lv, data, man):
    f, c = lv["floor"], lv["ceiling"]
    interior = Polygon(man["interiors"][lv["id"]])
    b.skin_zone = box(-50, -50, 50, 50).difference(interior.buffer(-SKIN, join_style="mitre"))

    walls = unary_union([Polygon(w[0], w[1:]) for w in data["walls"]])
    removed = unary_union([Polygon(e["remove"]) for e in man["wallEdits"] if e["level"] == lv["id"] and "remove" in e])
    walls = walls.difference(removed)
    for e in man["wallEdits"]:
        if e["level"] == lv["id"] and "add" in e and e.get("material", "wall") == "wall":
            walls = walls.union(Polygon(e["add"]))

    rest = walls
    for zone in [h for h in man["wallHeights"] if h["level"] == lv["id"]]:
        region = Polygon(zone["region"])
        b.wall(f, zone["top"], walls.intersection(region))
        rest = rest.difference(region)
    b.wall(f, c, rest)
    for e in man["wallEdits"]:
        if e["level"] == lv["id"] and e.get("material", "wall") != "wall":
            b.add(e["material"], f, c, Polygon(e["add"]))

    openings = [o for o in data["openings"] if not removed.contains(Point(o["center"]))]
    openings += [manual_opening(e) for e in man["extraOpenings"] if e["level"] == lv["id"]]
    # Doors that stand elsewhere than their opening (the hidden kitchen door keeps its own height).
    moved = [Point(d["replaces"]) for d in man.get("doors", []) if d["level"] == lv["id"] and "replaces" in d]
    for o in openings:
        rect = opening_rect(o)
        if o["type"] == "fill":
            b.wall(f, c, rect)
            continue
        if o["type"] == "door" and inside_opening(o, interior) and not any(m.distance(Point(o["center"])) < 0.4 for m in moved):
            o["head"] = round(c - f, 3)  # doors inside the house go up to the ceiling (Yoshi)
        if o["head"] < c - f - 0.01:
            if o.get("lintel"):
                b.add(o["lintel"], f + o["head"], c, rect)
            else:
                b.wall(f + o["head"], c, rect)
        if o["type"] == "window":
            b.wall(f, f + o["sill"], rect)
            if o.get("panel"):
                # Not glass: a panel of this finish (the garden shed's wood), set 4 cm back from the
                # brick, with plastered wall behind it.
                half = o["thickness"] / 2
                b.add(o["panel"], f + o["sill"], f + o["head"], opening_band(o, interior, half - 0.10, half - 0.04))
                b.add("plaster", f + o["sill"], f + o["head"], opening_band(o, interior, -half, half - 0.10))
                continue
            pane = pane_rect(o)
            if o.get("screen") == "claustra":
                # Open brickwork fills the opening; the glass sits just behind it.
                b.add("claustra", f + o["sill"], f + o["head"], rect)
                shift = o["thickness"] / 2 + 0.03
                pane = translate(pane, -o["outside"][0] * shift, -o["outside"][1] * shift)
            b.add("glass", f + o["sill"], f + o["head"], pane, **({"matte": True} if o.get("matte") else {}))
            window_frame(b, o, f, pane, interior)
        elif o.get("sidelight"):
            sidelight(b, o, f, interior)

    for g in [g for g in man["glass"] if g["level"] == lv["id"]]:
        line = LineString(g["path"])
        frame = line.buffer(FRAME / 2, cap_style="flat", join_style="mitre")
        b.wall(f + g["head"], c, frame)
        if not g.get("door"):
            b.wall(f, f + g["sill"], frame)
            pane = line.buffer(PANE / 2, cap_style="flat", join_style="mitre")
            for leaf in glass_doors(b, g, f, interior):
                pane = pane.difference(leaf)
            b.add("glass", f + g["sill"], f + g["head"], pane)
            glass_run_frame(b, g, f, interior)

    # Rooms: the spaces enclosed by walls, with door and window openings closed.
    closed = unary_union([walls, *[opening_rect(o) for o in openings],
                          *[LineString(g["path"]).buffer(0.12) for g in man["glass"] if g["level"] == lv["id"]]])
    closed = closed.buffer(0.06, join_style="mitre").buffer(-0.06, join_style="mitre")  # seal hairline gaps
    spaces = [Polygon(r) for g in getattr(closed, "geoms", [closed]) for r in g.interiors]
    labels = data["rooms"] + [r for r in man.get("extraRooms", []) if r["level"] == lv["id"]]
    # Stair holes in this floor's slab stay open: no floor finish there.
    holes = unary_union([Polygon(h) for s in man["slabs"] if abs(s["y1"] - f) < 0.01 for h in s.get("holes", [])])
    rooms = []
    named = []
    for space in spaces:
        inside = [r for r in labels if space.contains(Point(r["at"]))]
        if not inside or space.area < 0.8:
            continue
        # An open plan holds several labels: split it between them (nearest label wins).
        for r in inside:
            others = [o for o in inside if o is not r]
            part = space
            for o in others:
                mid = ((r["at"][0] + o["at"][0]) / 2, (r["at"][1] + o["at"][1]) / 2)
                dx, dz = o["at"][0] - r["at"][0], o["at"][1] - r["at"][1]
                # keep the half-plane on r's side of the perpendicular bisector
                far = 100
                nx, nz = -dz, dx
                half = Polygon([(mid[0] + nx * far, mid[1] + nz * far), (mid[0] - nx * far, mid[1] - nz * far),
                                (mid[0] - nx * far - dx * far, mid[1] - nz * far - dz * far),
                                (mid[0] + nx * far - dx * far, mid[1] + nz * far - dz * far)])
                part = part.intersection(half)
            part = part.difference(holes)
            b.add(floor_finish(r["name"]), f - 0.02, f + FINISH - 0.01, part, r["name"])
            named.append((r["name"], part))
            rooms.append({"level": lv["id"], "name": r["name"], "p": rings(part.simplify(0.02))[0] if rings(part) else []})
    b.skin_zone = None
    auto_doors(b, lv, openings, named, man, interior)
    return rooms


def build_slab(b, s, all_slabs):
    holes = unary_union([Polygon(h) for h in s.get("holes", [])])
    outline = Polygon(s["poly"])
    # Cut holes out (rather than storing them as holes) so a hole that
    # touches the slab edge becomes a notch in the outline.
    geom = outline.difference(holes)
    # Facade band: only where the slab meets the outside, not where it joins a
    # neighbouring slab at the same height.
    level = unary_union([Polygon(o["poly"]) for o in all_slabs if o["y0"] < s["y1"] and o["y1"] > s["y0"]])
    shells = [Polygon(g.exterior) for g in getattr(level, "geoms", [level])]
    inner = unary_union([g.buffer(-SKIN, join_style="mitre") for g in shells])
    edge = geom.difference(inner)
    body = geom.difference(edge)
    b.add("brick", s["y0"], s["y1"], edge, s["name"])
    if s.get("material") == "roof":
        # Plastered ceiling below, roofing only on top.
        b.add("ceiling", s["y0"], s["y1"] - 0.04, body)
        b.add("roof", s["y1"] - 0.04, s["y1"], body, s["name"])
    else:
        b.add("ceiling", s["y0"], s["y1"], body, s["name"])


def build_quarter_turn(b, spec, y_from, y_to, name):
    """Indoor stair: 3 straight steps, 4 winders around the corner, 8 straight steps."""
    rise = (y_to - y_from) / 16
    x0, x1 = spec["bottom"]["x"]
    zs = spec["bottom"]["risers_z"] + [spec["winders"][0][0][1]]
    treads = [box(x0, zs[i + 1], x1, zs[i]) for i in range(3)]
    treads += [Polygon(w) for w in spec["winders"]]
    xs = spec["top"]["risers_x"]
    z0, z1 = spec["top"]["z"]
    top = [box(xs[i + 1], z0, xs[i], z1) for i in range(len(xs) - 1)]
    treads += top
    for i, t in enumerate(treads, start=1):
        y = y_from + i * rise
        b.add("stair", y - STEP_BODY, y, t, name)
    # Handrail on the open side of the upper flight.
    for i, t in enumerate(top, start=len(treads) - len(top) + 1):
        y = y_from + i * rise
        x_a, _, x_b, _ = t.bounds
        b.add("rail", y, y + spec["rail"]["height"], box(x_a, spec["rail"]["z"] - 0.025, x_b, spec["rail"]["z"] + 0.025))


def snap_facades(prisms, planes):
    """The walls extracted from the plans have their outer faces up to 5 cm apart along one
    facade, which showed as thin dark seams between the pieces. Brick within 4.5 cm of a facade
    plane (planes: {"x": [...], "z": [...]}, the slab edges) is moved onto it."""
    tol = 0.045
    def snap(v, targets):
        near = min(targets, key=lambda t: abs(t - v))
        return near if abs(near - v) <= tol else v
    for p in prisms:
        if p["m"] not in ("brick", "claustra", "cladding"):
            continue
        ring = p["p"][0]
        if min(x for x, _ in ring) < -0.5 or max(x for x, _ in ring) > 9.6 or min(z for _, z in ring) < -3.5 or max(z for _, z in ring) > 12.6:
            continue  # not the house (the bungalow and the neighbours have their own materials anyway)
        moved = [[round(snap(x, planes["x"]), 3), round(snap(z, planes["z"]), 3)] for x, z in ring]
        poly = Polygon(moved)
        if poly.is_valid and poly.area > 1e-4:
            p["p"] = [moved] + p["p"][1:]


def build_sills(b):
    """A bluestone sill under every window above the floor (plan legend: "dorpels in blauwe
    hardsteen"): from the frame out to 3.5 cm past the brick, 3 cm into the brick at each end,
    6 cm thick, its top level with the bottom of the frame."""
    for a, d, n, length, y in b.sills:
        u0, u1, v0, v1 = -0.03, length + 0.03, PROFILE_D / 2, 0.8
        rect = Polygon([(a[0] + d[0] * u + n[0] * v, a[1] + d[1] * u + n[1] * v) for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))])
        # The wall under the window (its brick skin and the plastered inside), out to the brick face.
        under = [p for p in b.prisms if p["m"] in ("brick", "plaster") and p["y0"] <= y - 0.02 <= p["y1"]
                 and Polygon(p["p"][0]).distance(rect) < 0.05]
        if not any(p["m"] == "brick" for p in under):
            continue  # not in an outside wall
        stone = rect.intersection(unary_union([Polygon(p["p"][0]) for p in under]).buffer(0.035, join_style="mitre"))
        frame = LineString([(a[0] + n[0] * (v0 + 0.01), a[1] + n[1] * (v0 + 0.01)), (a[0] + d[0] * length + n[0] * (v0 + 0.01), a[1] + d[1] * length + n[1] * (v0 + 0.01))])
        for piece in getattr(stone, "geoms", [stone]):
            if piece.geom_type == "Polygon" and piece.intersects(frame):  # not a wall further out
                b.add("bluestone", y - 0.06, y + 0.005, piece)


def build_straight(b, s):
    rise = (s["to"] - s["from"]) / s["risers"]
    x0, x1 = s["x"]
    for i in range(1, s["risers"]):
        z0 = s["z0"] + (i - 1) * s["tread"]
        y = s["from"] + i * rise
        b.add("concrete", s["from"] if s.get("solid") else y - STEP_BODY, y, box(x0, z0, x1, z0 + s["tread"]), s["name"])


def ground_cuts(ter, dips, late):
    """Where the dips (the wadi, ponds, the ditch) cut the ground: the squares of the terrain grid
    they touch (j * (nx - 1) + i), and those squares minus the dips as triangles (x, z), for the
    browser's ground. Two sets: the squares that only dips loaded later (`late`, a flag per dip)
    touch, and the rest."""
    holes = [Polygon(d["rim"]).buffer(0) for d in dips]
    union = unary_union(holes)
    out = {False: {"cells": [], "tris": []}, True: {"cells": [], "tris": []}}
    done = set()
    m = ter.nx - 1
    for hole in getattr(union, "geoms", [union]):
        x0, z0, x1, z1 = hole.bounds
        for j in range(max(0, int((z0 - ter.z0) // ter.step)), min(ter.nz - 1, int((z1 - ter.z0) // ter.step) + 1)):
            for i in range(max(0, int((x0 - ter.x0) // ter.step)), min(m, int((x1 - ter.x0) // ter.step) + 1)):
                cell = box(ter.x0 + i * ter.step, ter.z0 + j * ter.step, ter.x0 + (i + 1) * ter.step, ter.z0 + (j + 1) * ter.step)
                if not cell.intersects(hole) or j * m + i in done:
                    continue
                done.add(j * m + i)
                part = out[all(flag for h, flag in zip(holes, late) if h.intersects(cell))]
                part["cells"].append(j * m + i)
                rest = cell.difference(union)
                if rest.is_empty:
                    continue
                for t in shapely.constrained_delaunay_triangles(rest).geoms:
                    part["tris"] += [round(v, 3) for x, z in list(t.exterior.coords)[:3] for v in (x, z)]
    for part in out.values():
        part["cells"].sort()
    return out[False], out[True]


def tile_pieces(geom):
    """A shape cut along the browser's tiles (TILE metres, centred on the plot's middle)."""
    x0, z0, x1, z1 = geom.bounds
    out = []
    for i in range(math.floor((x0 - CX) / TILE + 0.5), math.floor((x1 - CX) / TILE + 0.5) + 1):
        for j in range(math.floor((z0 - CZ) / TILE + 0.5), math.floor((z1 - CZ) / TILE + 0.5) + 1):
            cx, cz = CX + i * TILE, CZ + j * TILE
            piece = geom.intersection(box(cx - TILE / 2, cz - TILE / 2, cx + TILE / 2, cz + TILE / 2))
            if not piece.is_empty and piece.area > 1e-4:
                out.append(piece)
    return out


def later(x, z):
    """Whether something at (x, z) is loaded later (beyond the ring of AREA)."""
    return math.hypot(x - CX, z - CZ) > AREA


def full_height(door, spec, man):
    """A hand-placed door inside the house goes up to the ceiling, as the openings do (not the
    hidden kitchen door, which stands in front of its opening at the height of the oak units)."""
    if "replaces" in spec or any("outside" in p for p in spec["panels"]):
        return door
    ceiling = next(l["ceiling"] for l in man["levels"] if l["id"] == spec["level"])
    return {**door, "y1": round(ceiling - 0.01, 3)}


def main():
    ext = json.loads(EXTRACTED.read_text(encoding="utf-8"))
    man = json.loads(MANUAL.read_text(encoding="utf-8"))
    b = Builder()

    rooms = []
    for lv in man["levels"]:
        rooms += build_level(b, lv, ext["levels"][lv["id"]], man)
    for s in man["slabs"]:
        build_slab(b, s, man["slabs"])
    for fin in man.get("finishes", []):
        b.add(fin["material"], fin["y1"] - 0.03, fin["y1"], Polygon(fin["poly"]), fin["name"])
    for p in man["parapets"]:  # parapets are outside: facing brick unless stated otherwise
        if p.get("material", "brick") == "brick" and p["y0"] > 5:
            # A roof edge: its path runs along the edge of the roof slab, and the brick stays inside
            # it, flush with the facade below.
            # On it an aluminium coping in the joinery's grey-brown (plan legend: "dakranden in
            # aluminium"), 2.5 cm proud of the brick and 6 cm down its face: the thin dark line
            # along the top of every render.
            line = LineString(p["path"])
            roof = unary_union([Polygon(sl["poly"]) for sl in man["slabs"] if p["y0"] - 0.6 <= sl["y1"] <= p["y0"] + 0.05])
            b.add("brick", p["y0"], p["y1"], line.buffer(p["width"] / 2, cap_style="flat", join_style="mitre").intersection(roof))
            band = line.buffer(p["width"] / 2 + 0.03, cap_style="flat", join_style="mitre")
            over = roof.buffer(COPING, join_style="mitre")
            b.add("alu_out", p["y1"], p["y1"] + 0.03, band.intersection(over))
            b.add("alu_out", p["y1"] - 0.06, p["y1"], band.intersection(over.difference(roof)))
            continue
        b.path(p.get("material", "brick"), p["y0"], p["y1"], p["width"], p["path"])
        if p.get("material", "brick") == "brick":
            # A concrete coping on the roof terrace's walls, 1.5 cm over each side.
            b.path("concrete", p["y1"], p["y1"] + 0.05, p["width"] + 0.03, p["path"])
    for beam in man.get("beams", []):
        b.add("concrete", beam["y0"], beam["y1"], Polygon(beam["poly"]))
    snap_facades(b.prisms, man["facades"])
    build_sills(b)

    furniture.build(b)  # kitchen and bathrooms from the supplier drawings

    for s in man["stairs"]:
        if s["type"] == "quarter-turn":
            build_quarter_turn(b, man["quarterTurn"], s["from"], s["to"], s["name"])
        else:
            build_straight(b, s)

    # Surroundings from Flemish open data (tools/neighbours.py): the real road (pale concrete,
    # grass up to its edges), neighbouring buildings (walls here, pitched roofs and window
    # frames drawn in the browser), canopies, hedges and fences between the gardens, and trees.
    # Bricks, roof tiles, windows and the plot lines without a hedge are made up in the style of
    # the street (facades.py). What the aerial photo shows (tools/street.py): forecourts, drives
    # and yards, pools, the hedges, solar panels; and from the GRB the poles with their cables,
    # the field tracks, ponds and the ditch.
    # All of it on the real relief (tools/terrain.py; flat round our plot and the bungalow): a
    # house, pool, canopy or pole lifted whole to the ground at its middle; ground covers, hedges
    # and fences marked with a size (d) that the browser cuts them into, lifting every corner.
    ring = {"roofs": [], "trees": [], "openings": [], "posts": []}
    village = {"roofs": [], "trees": [], "openings": [], "posts": [], "landmarks": []}
    side = lambda x, z: village if later(x, z) else ring
    ground = man["site"]["ground"]
    ter = terrain.load()
    b.target = b.outside

    def lay(material, y0, y1, geom, cell, name=None):
        """Out on the relief: the browser cuts it along a grid of `cell` metres (d) and lifts each piece.
        Cut along the tiles first, so each piece lies in one."""
        geom = geom if geom.is_valid else geom.buffer(0)
        for piece in tile_pieces(geom):
            if ter.flat(piece):
                b.add(material, y0, y1, piece, name)
            else:
                b.add(material, y0, y1, piece, name, d=cell)

    def lay_path(material, y0, y1, width, points, cell=8.0):
        lay(material, y0, y1, LineString(points).buffer(width / 2, cap_style="flat", join_style="mitre"), cell)

    nb_file = ROOT / "data" / "neighbours.json"
    street_file = ROOT / "data" / "street.json"
    st = json.loads(street_file.read_text(encoding="utf-8")) if street_file.exists() else {}
    # The second survey of Smetlede's centre (data/smetlede.json): the school's playground, which our
    # model of the school draws (tools/school.py), and the grey pavers of the square and the main street.
    sm_file = ROOT / "data" / "smetlede.json"
    sm = json.loads(sm_file.read_text(encoding="utf-8")) if sm_file.exists() else {}
    yard = Polygon(sm["yard"]["p"]) if sm.get("yard") else Polygon()
    pavers = Polygon(sm["pavers"]["p"]) if sm.get("pavers") else Polygon()

    def lay_tagged(material, y0, y1, geom, cell, landmark):
        """As lay, its blocks tagged as part of a landmark: drawn by the model, kept for walking on."""
        first = len(b.outside)
        lay(material, y0, y1, geom, cell)
        for prism in b.outside[first:]:
            prism["lm"] = landmark

    if nb_file.exists():
        nb = json.loads(nb_file.read_text(encoding="utf-8"))
        for r in nb["roads"] + st.get("roads", []):
            road = Polygon(r[0], r[1:]).buffer(0)
            if not road.intersects(pavers):
                lay("road", -0.16, -0.08, road, 8.0, "street")
                continue
            for material, piece in (("road", road.difference(pavers)), ("pave_grey", road.intersection(pavers))):
                if piece.area > 0.5:
                    lay(material, -0.16, -0.08, piece, 8.0, "street")
        for q in st.get("pavings", []):
            paving = Polygon(q["p"][0], q["p"][1:]).buffer(0)
            if paving.intersects(yard):
                lay(q["m"], ground - 0.05, ground + 0.025, paving.difference(yard), 8.0)
                lay_tagged(q["m"], ground - 0.05, ground + 0.025, paving.intersection(yard), 8.0, "school")
            else:
                lay(q["m"], ground - 0.05, ground + 0.025, paving, 8.0)
        for q in st.get("fields", []):  # just above the lawn, under the tracks and the yards
            lay(q["m"], ground - 0.05, ground + 0.03, Polygon(q["p"][0], q["p"][1:]).buffer(0), 16.0)
        for p in st.get("pools", []):
            pool = Polygon(p)
            lift = ter.height(pool.centroid.x, pool.centroid.y)
            b.add("stone", ground + lift - 0.05, ground + lift + 0.07, pool.buffer(0.35, join_style="mitre").difference(pool))
            b.add("pool_water", ground + lift - 0.05, ground + lift + 0.03, pool)
        for t in st.get("tracks", []):
            line = LineString(t["path"])
            if t["k"] == "path":
                lay("gravel", ground - 0.05, ground + 0.012, line.buffer(0.7, cap_style="flat"), 10.0)
                continue
            for off in (-0.75, 0.75):  # two wheel ruts, grass between
                rut = line.offset_curve(off)
                for seg in getattr(rut, "geoms", [rut]):
                    if seg.length > 1:
                        lay("track", ground - 0.05, ground + 0.012, seg.buffer(0.28, cap_style="flat"), 10.0)
        old_site = old_house.site()
        footprints = [Polygon(n["p"]).buffer(0) for n in nb["buildings"]]
        index = STRtree(footprints)
        lifts = [ter.height(f.centroid.x, f.centroid.y) for f in footprints]  # each building on the relief at its middle
        seen_file = ROOT / "data" / "facades.json"  # what Street View showed of the houses (tools/facades.py)
        seen = json.loads(seen_file.read_text(encoding="utf-8"))["houses"] if seen_file.exists() else []
        for k, (n, look, poly, lift) in enumerate(zip(nb["buildings"], facades.looks(nb["buildings"], seen), footprints, lifts)):
            if poly.intersects(old_site):
                continue  # the old bungalow (tools/old_house.py) stands here
            out = side(poly.centroid.x, poly.centroid.y)
            first = len(b.outside)
            # A roof per part as the laser scan shows it (tools/roofs.py): flat, gable, hip or shed,
            # each at its own height, in the colour of the roof on the aerial photo. Walls go up
            # to the lowest eaves everywhere, and further under the parts that are higher.
            n = {**n, "base": n["base"] + lift}
            under = min(ter.height(x, z) for x, z in poly.exterior.coords)  # the lowest ground under its walls
            parts = n["parts"]
            low = n["base"] + min(q["eaves"] for q in parts)
            # Down to below the ground all round, on a slope too.
            b.add(look["brick"], min(n["base"], ground + under) - 0.3, low, poly)
            if look.get("plinth"):  # a darker band round the foot of the walls
                b.add(look["plinth"], min(n["base"], ground + under) - 0.3, n["base"] + 0.45, poly.buffer(0.025, join_style="mitre").difference(poly))
            if look.get("chimney"):
                pitched = [q for q in parts if q["shape"] in ("gable", "hip")]
                if pitched:
                    q = max(pitched, key=lambda q: Polygon(q["p"]).area)
                    c0, c1, c2, c3 = [Point(*v) for v in q["p"]]
                    m0 = Point((c0.x + c3.x) / 2, (c0.y + c3.y) / 2)  # the ridge runs from m0 to m1
                    m1 = Point((c1.x + c2.x) / 2, (c1.y + c2.y) / 2)
                    t = 0.5 if q["shape"] == "hip" else 0.3
                    cx, cz = m0.x + (m1.x - m0.x) * t, m0.y + (m1.y - m0.y) * t
                    ux, uz = m1.x - m0.x, m1.y - m0.y
                    ln = math.hypot(ux, uz) or 1
                    ux, uz = ux / ln, uz / ln
                    square = lambda r: Polygon([(cx + ux * a * r - uz * c * r, cz + uz * a * r + ux * c * r) for a, c in ((1, 1), (1, -1), (-1, -1), (-1, 1))])
                    top = n["base"] + q["ridge"] + 0.9
                    b.add(look["brick"], n["base"] + q["eaves"], top, square(0.28))
                    b.add("concrete", top, top + 0.08, square(0.36))  # its cap
            roofs = []
            for q in parts:
                piece = Polygon(q["p"]).buffer(0).intersection(poly)
                top = n["base"] + q["eaves"]
                if piece.area > 0.5 and top > low + 0.05:
                    b.add(look["brick"], low, top, piece)
                if q["shape"] == "flat":
                    if piece.area > 0.5:
                        b.add("nb_roof", top, top + 0.2, piece.buffer(0.15, join_style="mitre"))
                    continue
                roof = {"p": q["p"], "y": round(top, 2), "ridge": round(n["base"] + q["ridge"], 2), "fixed": True,
                        "tiles": q.get("color") or n.get("roof") or look["tiles"], "wall": look["brick"],
                        "base": round(min(n["base"], ground + under), 2)}  # the downpipes reach the ground
                if look.get("gutter"):
                    roof["gutter"] = look["gutter"]
                if q["shape"] != "gable":
                    roof["shape"] = q["shape"]
                roofs.append(roof)
            if n.get("tower"):
                # The church tower (tools/neighbours.py, church_tower): walls, and a spire up to the
                # laser scan's peak (a hip roof over a square is a pyramid).
                tw = n["tower"]
                b.add(look["brick"], min(n["base"], ground + under) - 0.3, n["base"] + tw["top"], Polygon(tw["p"]))
                roofs.append({"p": tw["p"], "y": round(n["base"] + tw["top"], 2), "ridge": round(n["base"] + tw["peak"], 2), "fixed": True,
                              "shape": "hip", "tiles": n.get("roof") or look["tiles"], "wall": look["brick"], "base": round(n["base"] + tw["top"] - 1, 2)})
            if n.get("landmark"):
                # Tagged, with its outline, so a model of it (made in Blender) can take its place.
                for prism in b.outside[first:]:
                    prism["lm"] = n["landmark"]
                for roof in roofs:
                    roof["lm"] = n["landmark"]
                out.setdefault("landmarks", []).append({"name": n["landmark"], "p": n["p"], "base": round(n["base"], 2),
                                                        "ground": round(ground + under, 2), "tower": n.get("tower")})
            else:
                others = [footprints[i] for i in index.query(poly.buffer(3)) if footprints[i] is not poly and footprints[i].distance(poly) < 3]
                out["openings"] += facades.openings(n, look, parts, others)
            out["roofs"] += roofs
        for c in nb.get("canopies", []):
            poly = Polygon(c["p"]).buffer(0)
            lift = ter.height(poly.centroid.x, poly.centroid.y)
            top = c["base"] + lift + c["top"]
            b.add("nb_roof", top - 0.12, top, poly)
            for x, z in c["p"]:  # posts at the corners that don't stand against a building
                if all(footprints[i].distance(Point(x, z)) > 0.6 for i in index.query(Point(x, z).buffer(0.6))):
                    b.add("alu", min(c["base"], ground) + lift - 0.3, top - 0.12, Point(x, z).buffer(0.06, cap_style="square"))
        # Plot lines make way for the bungalow's carport and drive, and where Yoshi wants none.
        # Hedges stand where the aerial photo shows them (street.json, by plot line); the rest of
        # a plot line gets a fence or nothing.
        clear = unary_union([old_house.clear(), *(Polygon(a["poly"]) for a in man["site"].get("noBoundaries", []))])
        # Nor does a plot line stand across a way through: the roads, the tracks and footpaths to the
        # fields (a fence keeps off their strip of land, a real hedge off the ruts or gravel) and, for the
        # fences, a drive, forecourt or yard it runs across (paved on both sides of it), where a gate
        # would stand open; along a drive's edge it stays. A plot line that crosses one stops at its edge.
        roads = [Polygon(r[0], r[1:]).buffer(0) for r in nb["roads"] + st.get("roads", [])]
        tracks = [LineString(t["path"]) for t in st.get("tracks", [])]
        ways = unary_union([r.buffer(0.2) for r in roads] + [t.buffer(1.5) for t in tracks])  # a track's own strip of land, about 3 m
        ruts = unary_union(roads + [t.buffer(1.05) for t in tracks])  # where a real hedge can't be: on the ruts or the gravel
        paved = [Polygon(q["p"][0], q["p"][1:]).buffer(0) for q in st.get("pavings", [])]
        paved_index = STRtree(paved)

        def across(line):
            """The drives and yards that `line` runs across, not along their edge (with a margin)."""
            hit = [paved[i] for i in paved_index.query(line) if line.intersects(paved[i].buffer(-0.4))]
            return unary_union(hit).buffer(0.3) if hit else Polygon()
        real = st.get("hedges")
        covered = {}
        for h in real or []:
            covered.setdefault(h["b"], []).append(LineString(h["path"]))
            rest = LineString(h["path"]).difference(clear).difference(ruts)
            for seg in getattr(rest, "geoms", [rest]):
                if seg.geom_type == "LineString" and seg.length >= 1.0:
                    lay_path("nb_hedge", ground - 0.05, ground + h["h"], 0.4 + 0.12 * h["h"], list(seg.coords))
        bounds = []
        for k, line in enumerate(nb.get("boundaries", [])):
            rest = LineString(line["path"]).difference(clear)
            if k in covered:
                rest = rest.difference(unary_union(covered[k]).buffer(0.5))
            for seg in getattr(rest, "geoms", [rest]):
                if seg.geom_type == "LineString" and seg.length >= 1.0:
                    bounds.append({**line, "path": [[round(x, 2), round(z, 2)] for x, z in seg.coords]})
        hedges, fences = facades.garden_lines(bounds, hedges=real is None)
        opened = [0.0, 0.0]  # m of plot line left open: on ways, in yards
        for kind, lines in (("nb_hedge", hedges), ("fence", fences)):
            for path, h in lines:
                line = LineString(path)
                rest = line.difference(ways)
                opened[0] += line.length - rest.length
                if kind == "fence":
                    # Across a drive or a gateway: a few metres. A longer stretch over paving runs between two
                    # paved yards, and stays.
                    over = rest.intersection(across(line))
                    over = linemerge(over) if over.geom_type == "MultiLineString" else over
                    gates = [g for g in getattr(over, "geoms", [over]) if g.geom_type == "LineString" and g.length <= GATE]
                    if gates:
                        length = rest.length
                        rest = rest.difference(unary_union(gates).buffer(0.01))
                        opened[1] += length - rest.length
                for seg in getattr(rest, "geoms", [rest]):
                    if seg.geom_type != "LineString" or seg.length < 1.5:
                        continue  # no stub left beside the opening
                    piece = [[round(x, 2), round(z, 2)] for x, z in seg.coords]
                    if kind == "nb_hedge":
                        lay_path("nb_hedge", ground - 0.05, ground + h, 0.55, piece)
                        continue
                    lay_path("fence", ground - 0.05, ground + h, 0.03, piece)
                    for post in facades.posts(piece, h):  # the browser stands each on the relief; one at each side of an opening
                        side(post[0], post[1])["posts"].append(post)
        print(f"   plot lines: {opened[0]:.0f} m left open on roads, tracks and paths, {opened[1]:.0f} m across drives and yards")
        # The school's fences and the planter wall on the church square: drawn by our model of the school
        # (tools/school.py), kept here as blocks to walk and drive into.
        barriers = sm.get("barriers", {})
        for line in barriers.get("fences", []):
            first = len(b.outside)
            lay_path("fence", ground - 0.05, ground + 1.8, 0.06, line)
            for prism in b.outside[first:]:
                prism["lm"] = "school"
        if barriers.get("planter"):
            lay_tagged("concrete", ground - 0.05, ground + 0.5, Polygon(barriers["planter"]), 8.0, "school")
        for t in nb["trees"]:
            if yard.contains(Point(t["x"], t["z"])):
                continue  # the laser scan's 3.4 m "tree" in the playground is the play tower (tools/school.py)
            side(t["x"], t["z"])["trees"].append({**t, "y": round(t["y"] + ter.height(t["x"], t["z"]), 2)})
        # The concrete poles (their lamps and cables are drawn in the browser): the ring's first, then
        # the village's; a cable is loaded with the later of its two poles.
        poles = [{**p, "y": round(ground + ter.height(p["x"], p["z"]), 2)} for p in st.get("poles", [])]
        order = sorted(range(len(poles)), key=lambda i: later(poles[i]["x"], poles[i]["z"]))
        at = {old: new for new, old in enumerate(order)}
        poles = [poles[i] for i in order]
        for p in poles:
            # A concrete pole, or the core of a street lamp's post in the centre of Smetlede (tools/street.py, `k`;
            # the browser draws the round post round it).
            top, half = {"post": (6.0, 0.05), "striped": (6.5, 0.05), "lantern": (3.3, 0.045)}.get(p.get("k"), (9.2, 0.11))
            b.add("pole", p["y"] - 0.3, p["y"] + top, Point(p["x"], p["z"]).buffer(half, cap_style="square"))
        ring_poles = sum(1 for p in poles if not later(p["x"], p["z"]))
        if poles:
            ring["poles"], village["poles"] = poles[:ring_poles], poles[ring_poles:]
            wires = [sorted([at[i], at[j]]) for i, j in st["wires"]]
            ring["wires"] = [w for w in wires if w[1] < ring_poles]
            village["wires"] = [w for w in wires if w[1] >= ring_poles]
        # Solar panels go up with the house they lie on.
        for s_ in st.get("solar", []):
            mid = Point(sum(q[0] for q in s_["q"]) / 4, sum(q[2] for q in s_["q"]) / 4)
            k = next((i for i in index.query(mid) if footprints[i].buffer(0.5).contains(mid)), None)
            lift = lifts[k] if k is not None else ter.height(mid.x, mid.y)
            side(mid.x, mid.y).setdefault("solar", []).append({**s_, "q": [[q[0], round(q[1] + lift, 2), q[2]] for q in s_["q"]]})
    b.target = b.prisms
    surroundings = ring
    old_house.build(b, surroundings, frame_window, world_parts)

    site = man["site"]
    for a in site["areas"]:
        b.add(a["material"], min(site["ground"], a["y1"]) - 0.05, a["y1"], Polygon(a["poly"]), a["name"])
    for h in site["hedges"]:
        b.path("hedge", site["ground"], h["y1"], h["width"], h["path"])
    dips = garden.build(b, site["ground"])
    # Ponds and ditches lie on the relief: their rim follows it, the bottom is below its lowest point.
    all_dips = dips + [{**w, "low": round(min(ter.height(x, z) for x, z in w["rim"]), 2)} for w in st.get("water", [])]
    late = [later(*Polygon(d["rim"]).centroid.coords[0]) for d in all_dips]
    cuts, late_cuts = ground_cuts(ter, all_dips, late)
    # The surroundings' blocks: the ring's with the house, the rest with the village.
    for prism in b.outside:
        xs = [x for x, _ in prism["p"][0]]
        zs = [z for _, z in prism["p"][0]]
        side((min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2).setdefault("prisms", []).append(prism)

    house = {
        "source": ext["source"],
        "levels": man["levels"],
        "ground": site["ground"],
        "spawn": man["spawn"],
        "sun": man.get("sun"),
        "rooms": rooms,
        "doors": [full_height({k: v for k, v in d.items() if k not in ("note", "replaces")}, d, man) for d in man.get("doors", [])] + b.doors,
        "props": [{k: v for k, v in p.items() if k != "note"} for p in man.get("props", [])] + b.props,
        "fixtures": [{k: v for k, v in f.items() if k != "note"} for f in man.get("fixtures", [])] + b.fixtures,
        "dips": [d for d, f in zip(all_dips, late) if not f],
        "groundCuts": cuts,
        "surroundings": surroundings,
        "prisms": b.prisms,
    }
    OUT.write_text(json.dumps(house, separators=(",", ":")), encoding="utf-8")
    village["dips"] = [d for d, f in zip(all_dips, late) if f]
    village["landmarks"].sort(key=lambda m: m["name"] != "church")  # the church first: the browser shades the village round it
    village["groundCuts"] = late_cuts
    nb_area = json.loads((ROOT / "data" / "neighbours.json").read_text(encoding="utf-8")).get("area")
    if nb_area:
        village["area"] = nb_area  # the outline of the area the world is built in (the big map)
    village["_source"] = "the surroundings beyond the ring (tools/build_house.py): GRB, DHM Vlaanderen II and the orthophoto (Digitaal Vlaanderen, open data)"
    VILLAGE_OUT.write_text(json.dumps(village, separators=(",", ":")), encoding="utf-8")
    counts = {}
    for p in b.prisms:
        counts[p["m"]] = counts.get(p["m"], 0) + 1
    print(f"wrote {OUT.relative_to(ROOT)}: {len(b.prisms)} prisms, {len(rooms)} rooms, {OUT.stat().st_size // 1024} KB")
    print("  ", counts)
    for name, part, path in (("ring", surroundings, OUT), ("village", village, VILLAGE_OUT)):
        print(f"   {name} ({path.name}, {path.stat().st_size // 1024} KB): {len(part.get('prisms', []))} blocks, {len(part['roofs'])} roofs, "
              f"{len(part['openings'])} windows and doors, {len(part['posts'])} fence posts, {len(part['trees'])} trees, "
              f"{len(part.get('poles', []))} poles, {len(part.get('dips', house['dips']))} dips")
    print("   rooms:", ", ".join(f"{r['level']}:{r['name']}" for r in rooms))
    print("   doors:", ", ".join(f"{d['id']} ({d['name']}{', open' if d.get('open') else ''})" for d in b.doors))


if __name__ == "__main__":
    main()
