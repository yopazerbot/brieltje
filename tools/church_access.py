"""The church's tower stair and roof walk. Run: tools/.venv/bin/python tools/church_access.py.

Local coordinates are the Blender church's: x along the nave, y north, z up. The
same solids are exported in church.glb and read by the player and zombie collision.
This is a game route, not a surveyed interior of the real church.
"""
import json
import math
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web/shared/church.json"
CX = -15.93
FLOOR, ROOF = 0.30, 12.70
COUNT, TURN = 84, math.tau / 24


def build():
    cuts = [
        {"box": [-17.96, -2.02, 0.15, -13.90, 2.02, 15.40]},
        {"box": [-18.65, -1.08, 0.15, -17.90, 1.08, 2.95]},
        {"box": [-14.15, -1.02, 12.56, -13.35, 1.02, 15.05]},
    ]
    body, visible = [], []

    def add(out, shape, y0, y1, material, name):
        for p in getattr(shape, "geoms", [shape]):
            if p.geom_type != "Polygon" or p.area < 0.0001:
                continue
            rings = [[[round(x, 5), round(y, 5)] for x, y in r.coords[:-1]] for r in [p.exterior, *p.interiors]]
            out.append({"m": material, "n": name, "y0": round(y0, 5), "y1": round(y1, 5), "p": rings})

    def mass(shape, y0, y1):
        # Slice at the openings' heights, so the wall above a doorway stays solid.
        heights = sorted({y0, y1, *(c["box"][i] for c in cuts for i in (2, 5) if y0 < c["box"][i] < y1)})
        for lo, hi in zip(heights, heights[1:]):
            part = shape
            for c in cuts:
                x0, z0, bottom, x1, z1, top = c["box"]
                if bottom < hi and top > lo:
                    part = part.difference(box(x0, z0, x1, z1))
            add(body, part, lo, hi, "brick", "church-wall")

    def pitched(x0, x1, half, eaves, ridge, across=False, center=0):
        shape = box(x0, -half, x1, half) if not across else box(center-half, x0, center+half, x1)
        mass(shape, -1.2, eaves)
        # Fine bands follow the visible slate slope; the roof walk sits above its ridge.
        bands = math.ceil(half / 0.18)
        for i in range(bands):
            a, b = i * half / bands, (i + 1) * half / bands
            top = ridge - (a / half) * (ridge - eaves)
            for sign in (-1, 1):
                lo, hi = sorted((sign * a, sign * b))
                strip = box(x0, lo, x1, hi) if not across else box(center+lo, x0, center+hi, x1)
                mass(strip, eaves, top)

    pitched(-16.15, 4.43, 5.42, 7.2, 12.45)
    pitched(-8.49, 8.49, 4.05, 8.3, 12.45, True, 4.43)
    pitched(4.43, 14.62, 3.67, 8.75, 12.45)
    for sign in (-1, 1):
        a, b = sorted((sign * 3.67, sign * 8))
        mass(box(8.38, a, 14.15, b), -1.2, 5.95)
    mass(box(-18.18, -2.25, -13.68, 2.25), -1.2, 16.0)
    mass(box(-18.18, -5.42, -16.05, -2.25), -1.2, 3.3)

    add(visible, box(-18.16, -2.02, -13.90, 2.02), 0.14, FLOOR, "concrete", "church-entry")
    # A short approach blends the tower's level floor into the sloping square.
    for x0, x1, h in ((-20.5, -19.4, 0.0), (-19.4, -18.7, 0.15), (-18.7, -18.0, FLOOR)):
        add(visible, box(x0, -1.08, x1, 1.08), -0.8, h, "concrete", "church-entry")
    add(visible, box(CX-.22, -.22, CX+.22, .22), FLOOR, ROOF+0.9, "steel", "church-stair-post")
    anchors = []
    for k in range(COUNT):
        a = math.pi + k * TURN
        a0, a1 = a - TURN/2 - 0.002, a + TURN/2 + 0.002
        p = [(CX + r * math.cos(t), r * math.sin(t)) for r, t in ((.25, a0), (1.88, a0), (1.88, a1), (.25, a1))]
        top = FLOOR + (ROOF - FLOOR) * (k + 1) / COUNT
        add(visible, Polygon(p), top-.16, top, "stair", "church-stairs")
        anchors.append([round(CX + 1.25*math.cos(a), 5), round(1.25*math.sin(a), 5), round(top, 5)])

    def guard(a, b, height, post=False):
        rail = LineString([a, b]).buffer(.035, cap_style="square", join_style="mitre")
        for lo, hi in ((.56, .66), (.99, 1.09)):
            add(visible, rail, height+lo, height+hi, "steel", "church-stair-rail")
        if post:
            add(visible, Point(a).buffer(.035, cap_style="square"), height, height+1.09,
                "steel", "church-stair-rail")

    # Leave the first tread open to the entrance and the final two open to the landing.
    # Two short overlapping bars per tread follow the rise without extra draw calls.
    for k in range(1, COUNT-2):
        for half in range(2):
            t = k + half/2
            a = math.pi + (t-.5)*TURN
            b = a + TURN/2
            ends = [(CX + 1.85*math.cos(v), 1.85*math.sin(v)) for v in (a, b)]
            h = FLOOR + (ROOF-FLOOR)*(t+.5)/COUNT
            guard(*ends, h, post=half == 0 and k % 2 == 1)

    # The last treads enter from the south. Fill the old gap beside the centre post,
    # guarding the remaining landing edges while leaving that approach open.
    add(visible, box(CX+.22, -.72, -13.2, 1.0), ROOF-.15, ROOF, "steel", "church-roof")
    end = math.pi + (COUNT-2.5)*TURN
    corner = (CX + 1.85*math.cos(end), 1.85*math.sin(end))
    for a, b in ((corner, (-14.45, -.72)), ((-14.45, -.72), (-13.9, -.72)),
                 ((CX+.22, -.72), (CX+.22, 1.0)), ((CX+.22, 1.0), (-13.9, 1.0))):
        guard(a, b, ROOF, post=True)
    deck = unary_union([box(-13.65, -1.10, 8.0, 1.10),
                        *(box(x, -1.60, x+3, 1.60) for x in (-8.5, -2.0, 4.5))])
    add(visible, deck, ROOF-.15, ROOF, "steel", "church-roof")
    # Low solid screens give partial cover. The top rails and posts leave an open view.
    coords = list(deck.exterior.coords)
    for a, b in zip(coords, coords[1:]):
        if max(a[0], b[0]) < -13.4:
            continue  # clear doorway back into the tower
        line = LineString([a, b])
        rail = line.buffer(.035, cap_style="square", join_style="mitre")
        add(visible, rail, ROOF, ROOF+.60, "steel", "church-cover")
        add(visible, rail, ROOF+1.0, ROOF+1.05, "steel", "church-rail")
        for k in range(math.ceil(line.length/2)+1):
            p = line.interpolate(min(line.length, k*2))
            add(visible, Point(p).buffer(.035, cap_style="square"), ROOF, ROOF+1.05, "steel", "church-rail")
    return {"_source": "tools/church_access.py: a fictional maintenance route inside the church model",
            "origin": [521.51, -744.15], "yaw": 2.525, "cuts": cuts, "body": body, "visible": visible,
            "anchors": {"entry": [-19.8, 0, 0], "stairs": anchors, "roof": [-6.5, 0, ROOF]},
            "area": [-21.5, -9.5, 15.6, 9.5]}


def main():
    data = build()
    OUT.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{OUT}: {len(data['body'])} wall/roof solids, {len(data['visible'])} access solids")


if __name__ == "__main__":
    main()
