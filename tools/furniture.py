"""Kitchen and bathroom fittings, from the supplier drawings (images/keuken en badkamer).

Everything is measured in the house frame (metres, see data/house.manual.json).
Each drawing is mapped onto its room by matching the room's inner walls:

- Kitchen: technical plan of 2026-08-20 (top view, wall elevation, perspective).
  Tall units from the storage-room door (x 7.64) to the wall end (x 4.72),
  2.48 m high; island attached to the right outer wall, 3.49 x 1.19 m.
- Bathroom 1 (badkamer, 2.88 x 2.87 m): plan, elevation and perspectives of
  2026-09-16/26. Drawing u (left to right) runs along -z from z 3.273,
  drawing v (top to bottom) along +x from x 0.415.
- Bathroom 2 (sanitair, 1.70 x 2.18 m): plan of 2026-09-26. u along +x from
  x 4.757, v along +z from z 9.459.
"""
import math

from shapely.geometry import Point, Polygon, box

F1 = 3.05  # 1st floor level


def ellipse(cx, cz, rx, rz, n=36):
    return Polygon([(cx + rx * math.cos(2 * math.pi * i / n), cz + rz * math.sin(2 * math.pi * i / n)) for i in range(n)])


def capsule(x0, z0, x1, z1):
    """Rounded-end rectangle (a bath seen from above)."""
    r = min(x1 - x0, z1 - z0) / 2
    return box(x0 + r, z0 + r, x1 - r, z1 - r).buffer(r, quad_segs=10)


def kitchen(b):
    f = F1
    # Tall units against the wall to the storage room (face at z 4.37), 58 cm deep.
    z0, z1 = 3.79, 4.37
    cols = [(7.22, 7.64, "tall"), (6.62, 7.22, "oven"), (6.02, 6.62, "oven"), (5.41, 6.01, "niche"), (4.72, 5.40, "fridge")]
    for x0, x1, kind in cols:
        if kind == "niche":
            # An open niche for the coffee machine, 0.52 wide, 0.55 high and 0.50 deep, lined in
            # the beige finish; the machine (Yoshi: a Jura E8, 28 x 35 x 45 cm) stands inside.
            n0, n1, back = f + 0.97, f + 1.52, z0 + 0.50
            b.add("oak", f, n0, box(x0 + 0.002, z0, x1 - 0.002, z1), "Keuken")
            b.add("oak", n1, f + 2.48, box(x0 + 0.002, z0, x1 - 0.002, z1), "Keuken")
            for sx0, sx1 in ((x0 + 0.002, x0 + 0.04), (x1 - 0.04, x1 - 0.002)):
                b.add("oak", n0, n1, box(sx0, z0, sx1, z1))
            b.add("oak", n0, n1, box(x0 + 0.04, back, x1 - 0.04, z1))
            lining = box(x0 + 0.04, z0, x1 - 0.04, back).difference(box(x0 + 0.05, z0 - 0.01, x1 - 0.05, back - 0.01))
            b.add("niche", n0, n1, lining)  # sides and back
            b.add("niche", n0, n0 + 0.01, box(x0 + 0.04, z0, x1 - 0.04, back))  # floor
            b.add("niche", n1 - 0.01, n1, box(x0 + 0.04, z0, x1 - 0.04, back))  # top
            continue
        b.add("oak", f, f + 2.48, box(x0 + 0.002, z0, x1 - 0.002, z1), "Keuken")
        if kind == "oven":
            b.add("black_glass", f + 1.07, f + 1.52, box(x0 + 0.03, z0 - 0.012, x1 - 0.03, z0 + 0.01))
    # The storeroom door beside them is hidden in the run (Yoshi): an oak leaf flush with the fronts
    # that swings both ways (data/house.manual.json, kitchen-hidden), an oak jamb against the outer
    # wall and an oak panel above the leaf, up to the top of the units.
    b.add("oak", f, f + 2.48, box(8.59, z0, 8.639, z1), "Keuken")
    b.add("oak", f + 2.10, f + 2.48, box(7.642, z0, 8.59, z0 + 0.04))
    # Island: terracotta fronts, terrazzo top, attached to the outer wall.
    ix0, ix1, iz0, iz1 = 5.13, 8.62, 1.51, 2.70
    b.add("terracotta", f, f + 0.87, box(ix0 + 0.03, iz0 + 0.03, ix1, iz1 - 0.03), "Keuken")
    b.add("terrazzo", f + 0.87, f + 0.90, box(ix0, iz0, ix1, iz1), "Keuken")
    b.add("black_glass", f + 0.90, f + 0.906, box(7.31, 2.13, 8.07, 2.64))   # hob
    b.add("steel", f + 0.895, f + 0.902, box(5.50, 2.25, 5.99, 2.65))        # sink
    # Red tap on the inner side of the sink (towards the middle of the island), spout reaching over it.
    b.add("terracotta", f + 0.90, f + 1.25, Point(5.745, 2.20).buffer(0.015, quad_segs=6))
    b.add("terracotta", f + 1.22, f + 1.25, box(5.73, 2.20, 5.76, 2.42))
    # Bar stools on the dining side: light ash counter stools from the render keuken_000, built in
    # Blender (tools/interior.py) and drawn as fixtures (web/src/world/furnishing.ts).
    for x in (5.55, 6.25, 6.95):
        b.fixtures.append({"item": "barstool", "x": x, "y": f, "z": 1.22, "yaw": 0, "size": [0.4, 0.4, 0.66]})


def bathroom1(b):
    def xz(u, v):
        return 0.415 + v, 3.273 - u

    def rect(u0, v0, u1, v1):
        (xa, za), (xb, zb) = xz(u0, v0), xz(u1, v1)
        return box(min(xa, xb), min(za, zb), max(xa, xb), max(za, zb))

    name = "Badkamer"
    # Floating walnut double vanity, 1.786 m x 0.54 m, light stone top.
    b.add("walnut", 0.30, 0.80, rect(0.0, 0.0, 0.54, 1.786), name)
    b.add("stone", 0.80, 0.83, rect(0.0, 0.0, 0.55, 1.786), name)
    for v in (0.368, 1.418):
        x, z = xz(0.27, v)
        bowl = Point(x, z).buffer(0.2, quad_segs=12)
        b.add("ceramic", 0.83, 0.97, bowl.difference(Point(x, z).buffer(0.17, quad_segs=12)))
        b.add("ceramic", 0.83, 0.86, Point(x, z).buffer(0.17, quad_segs=12))
        tx, tz = xz(0.02, v)
        b.add("brass", 1.05, 1.08, box(tx - 0.012, tz - 0.16, tx + 0.012, tz))  # wall tap
        mx, mz = xz(0.0, v)
        b.add("mirror", 1.15, 2.05, box(mx - 0.22, mz - 0.012, mx + 0.22, mz))  # oval mirror (as a panel)
    # Freestanding bath along the bedroom-side wall.
    (xa, za), (xb, zb) = xz(1.08, 2.05), xz(2.85, 2.83)
    outer = capsule(min(xa, xb), min(za, zb), max(xa, xb), max(za, zb))
    inner = outer.buffer(-0.07)
    b.add("ceramic", 0.0, 0.58, outer.difference(inner), name)
    b.add("ceramic", 0.0, 0.12, inner)
    b.add("brass", 0.0, 1.0, Point(*xz(2.0, 2.79)).buffer(0.018, quad_segs=6))  # floor-standing tap
    # Walk-in shower in the corner by the window wall: glass screen and rust-red tiled walls.
    sx, sz = xz(1.97, 0.0)
    b.add("glass", 0.0, 2.0, box(0.415, sz - 0.005, 0.415 + 1.2, sz + 0.005))
    b.add("rust_tile", 0.0, 2.70, box(0.415, 0.396, 0.415 + 1.2, 0.396 + 0.012))
    b.add("rust_tile", 0.0, 2.70, box(0.415, 0.396, 0.415 + 0.012, sz))
    hx, hz = xz(2.42, 0.35)
    b.add("brass", 2.25, 2.27, Point(hx, hz).buffer(0.15, quad_segs=12))       # rain shower
    b.add("brass", 2.27, 2.70, Point(hx, hz).buffer(0.012, quad_segs=6))


def bathroom2(b):
    def xz(u, v):
        return 4.757 + u, 9.459 + v

    def rect(u0, v0, u1, v1):
        (xa, za), (xb, zb) = xz(u0, v0), xz(u1, v1)
        return box(xa, za, xb, zb)

    name = "Sanitair"
    b.add("pink", 0.45, 0.80, rect(1.15, 0.20, 1.70, 1.10), name)      # floating vanity
    b.add("stone", 0.80, 0.82, rect(1.14, 0.20, 1.70, 1.10), name)
    x, z = xz(1.40, 0.65)
    b.add("ceramic", 0.82, 0.95, Point(x, z).buffer(0.19, quad_segs=12).difference(Point(x, z).buffer(0.16, quad_segs=12)))
    b.add("ceramic", 0.82, 0.85, Point(x, z).buffer(0.16, quad_segs=12))
    mx = 6.457
    b.add("mirror", 1.10, 1.95, box(mx - 0.012, z - 0.22, mx, z + 0.22))
    b.add("brass", 1.02, 1.05, box(mx - 0.16, z - 0.012, mx, z + 0.012))
    # Shower in the back half behind a glass screen, pink-beige tiles.
    _, gz = xz(0, 1.27)
    b.add("glass", 0.0, 2.0, box(xz(0.49, 0)[0], gz - 0.005, mx, gz + 0.005))
    b.add("pink_tile", 0.0, 2.70, box(mx - 0.012, gz, mx, 11.636))
    b.add("pink_tile", 0.0, 2.70, box(4.757, 11.636 - 0.012, mx, 11.636))
    hx, hz = xz(1.32, 1.74)
    b.add("brass", 2.25, 2.27, Point(hx, hz).buffer(0.13, quad_segs=12))
    b.add("brass", 2.27, 2.70, Point(hx, hz).buffer(0.012, quad_segs=6))


def dining_bench(b):
    """Built-in wooden bench along the dining room's corner window: from the glass into the room, deeper in the corner, the seat
    flush with the bottom of the window frame (R1.4 + R1.5: 1.728 m high, top at 2.28).
    It is a rosy wood veneer, like the playroom's sliding door, not oak."""
    inner = [(2.80, 3.42), (0.95, 3.60)]
    inner += [(0.95 + 0.35 * math.cos(a), 3.95 + 0.35 * math.sin(a)) for a in (math.radians(-90 - 15 * i) for i in range(1, 6))]
    inner += [(0.60, 3.95), (0.60, 5.13)]
    inner += [(0.40 + 0.2 * math.cos(a), 5.13 + 0.2 * math.sin(a)) for a in (math.radians(15 * i) for i in range(1, 7))]
    seat = Polygon([(0.23, 3.27), (2.80, 3.27)] + inner + [(0.23, 5.33)])
    # 3 mm proud of the oak bench that the light bake (tools/bake, a test setting) still has, so
    # the two don't flicker through each other there.
    b.add("veneer", F1, F1 + 0.553, seat.buffer(0.003, join_style="mitre"), "Eetplaats")


def build(b):
    dining_bench(b)
    kitchen(b)
    bathroom1(b)
    bathroom2(b)
