"""Extract walls and openings from vector floor plans.

Reads a floor plan PDF, finds the cut walls
(dark grey or black filled shapes), converts them to metres and detects the
gaps between wall ends (doors and windows). Which plan set is used, and the
opening types and heights, come from data/house.manual.json. Writes
data/extracted.json plus debug images in data/debug/.

Run from the project root:
    tools/.venv/Scripts/python.exe tools/extract_plan.py
"""
import json
import math
import re
from pathlib import Path

import pymupdf
from shapely.geometry import Point, Polygon, box, mapping
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
PLANS = {
    "house": {"pdf": "source/plans/house/*grondplannen.pdf", "label": "floor plans", "scale": 75,
              "pages": {"gf": 0, "f1": 1, "f2": 2}},
    "lichtplan-2026-07-07": {"pdf": "source/plans/lichtplan/*2026 07 07*lichtplan.pdf", "label": "lighting plan (7 Jul 2026)",
                             "scale": 50, "pages": {"gf": 0, "f1": 1, "f2": 2}},
}
MANUAL = ROOT / "data/house.manual.json"
OUT = ROOT / "data/extracted.json"
DEBUG = ROOT / "data/debug"

MARKER = 5.67  # PDF points: section marker squares are 2 mm on paper at any scale

MIN_WALL_AREA = 0.03   # m2, drops dimension ticks and section markers
MIN_WALL_THICK = 0.08  # m, drops thin lines such as glass balustrades
MAX_GAP = 6.5          # m, widest opening we look for
OUTER_LEAF = 0.12      # m, gaps this thin are in the outer brick leaf only

# Room labels on the plan show the net area under the name. Areas are unique
# per floor, so the area identifies the room. Names as on the plan.
ROOM_AREAS = {
    "gf": {"19,65": "Slaapkamer 1", "12,99": "Slaapkamer 2", "13,56": "Slaapkamer 3", "8,25": "Badkamer", "4,78": "Nachthal",
           "4,58": "Wasplaats", "5,70": "Inkom", "1,95": "WC", "3,70": "Sanitair", "4,70": "Bergruimte"},
    "f1": {"19,79": "Keuken", "16,00": "Eetplaats", "18,53": "Zithoek", "10,64": "Speelruimte", "10,00": "Hal", "1,53": "WC",
           "4,19": "Bergruimte", "26,56": "Dakterras"},
    "f2": {"12,52": "Bureau 2", "6,20": "Bureau 1", "3,58": "Hal"},
}

DEFAULTS = {
    "door": {"sill": 0.0, "head": 2.11},
    "window": {"sill": 0.9, "head": 2.2},
    "fill": {"sill": 0.0, "head": 0.0},
}


def section_markers(page):
    """Centres of the small black squares at the ends of the section lines."""
    dark = [d["rect"] for d in page.get_drawings() if d["type"] in ("f", "fs") and d.get("fill") and sum(d["fill"]) / 3 < 0.4]
    out = []
    for r in dark:
        if abs(r.width - MARKER) < 0.6 and abs(r.height - MARKER) < 0.6:
            grown = r + (-2, -2, 2, 2)
            if sum(1 for o in dark if o.intersects(grown)) == 1:  # isolated, so not part of a wall
                out.append(((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2))
    return out


def wall_corners(page, scale):
    """Corner points of the dark wall shapes, in PDF points (no offset applied)."""
    sheet = Sheet(page, (0.0, 0.0), scale)
    pts = []
    for g in wall_shapes(sheet):
        for ring in [g.exterior, *g.interiors]:
            pts += [(x / sheet.pt, z / sheet.pt) for x, z in ring.coords]
    return pts


def vote_shift(base, own, tolerance):
    """The shift that makes the most points of `own` land on points of `base`."""
    counts = {}
    for a in base:
        for b in own:
            key = (round((a[0] - b[0]) / tolerance), round((a[1] - b[1]) / tolerance))
            counts[key] = counts.get(key, 0) + 1
    (kx, ky), votes = max(counts.items(), key=lambda kv: kv[1])
    return (kx * tolerance, ky * tolerance), votes


def sheet_offsets(doc, pages, scale):
    """Shift that lines each floor sheet up with the ground floor sheet.

    First choice: the section markers (small black squares at the ends of the
    section lines). Plans without them on every sheet fall back to wall corners
    that continue through the floors: facades and the stairwell.
    """
    gf = doc[pages["gf"]]
    base_markers = section_markers(gf)
    base_corners = None
    offsets = {}
    for level, index in pages.items():
        if index == pages["gf"]:
            offsets[level] = (0.0, 0.0)
            continue
        own = section_markers(doc[index])
        shift, votes = vote_shift(base_markers, own, 1.5) if base_markers and own else ((0.0, 0.0), 0)
        if votes < 3:
            base_corners = base_corners or wall_corners(gf, scale)
            shift, votes = vote_shift(base_corners, wall_corners(doc[index], scale), 0.5)
            assert votes >= 8, f"{level}: only {votes} wall corners line up with the ground floor"
            print(f"{level}: aligned on {votes} wall corners")
        offsets[level] = shift
    return offsets


class Sheet:
    """One floor sheet: converts PDF points to metres in the house's frame."""

    def __init__(self, page, offset, scale, origin=(0.0, 0.0)):
        self.page, self.offset, self.origin = page, offset, origin
        self.pt = 25.4 / 72 / 1000 * scale  # metres per PDF point

    def to_world(self, x, y):
        return (round((x + self.offset[0] - self.origin[0]) * self.pt, 4), round((y + self.offset[1] - self.origin[1]) * self.pt, 4))

    def from_world(self, x, z):
        return (x / self.pt + self.origin[0] - self.offset[0], z / self.pt + self.origin[1] - self.offset[1])


def wall_shapes(sheet):
    polys = []
    for d in sheet.page.get_drawings():
        if d["type"] not in ("f", "fs") or not d.get("fill"):
            continue
        fill = d["fill"]
        # Walls are black or dark grey. Coloured overlays (beams, lights) are not.
        if (d.get("fill_opacity") or 1) < 0.9 or sum(fill) / 3 > 0.4 or max(fill) - min(fill) > 0.08:
            continue
        pts = []
        for it in d["items"]:
            if it[0] == "l":
                pts += [it[1], it[2]]
            elif it[0] == "re":
                r = it[1]
                pts += [r.tl, r.tr, r.br, r.bl]
            elif it[0] == "c":
                p0, c1, c2, p3 = it[1:5]
                for i in range(9):
                    t = i / 8
                    pts.append(p0 * (1 - t) ** 3 + c1 * 3 * (1 - t) ** 2 * t + c2 * 3 * (1 - t) * t * t + p3 * t ** 3)
        if len(pts) >= 3:
            poly = Polygon([sheet.to_world(p.x, p.y) for p in pts]).buffer(0)
            if poly.area > 1e-4:
                polys.append(poly)
    merged = unary_union(polys).buffer(0.003, join_style="mitre").buffer(-0.003, join_style="mitre")
    keep = []
    for g in getattr(merged, "geoms", [merged]):
        thick = g.area / max(g.length / 2, 1e-6)
        if g.area >= MIN_WALL_AREA and thick >= MIN_WALL_THICK:
            keep.append(orient(g.simplify(0.004), 1.0))
    return keep


def end_faces(walls):
    """Short straight edges of the wall outlines: candidate faces of an opening.

    A face only counts when solid wall continues behind it along its whole
    length, so small notches in the outline are ignored.
    """
    solid = unary_union(walls).buffer(0.005)
    faces = []
    for w in walls:
        for ring in [w.exterior, *w.interiors]:
            c = list(ring.coords)
            for a, b in zip(c, c[1:]):
                length = math.dist(a, b)
                if not 0.07 <= length <= 0.5:
                    continue
                if min(abs(b[0] - a[0]), abs(b[1] - a[1])) > 0.01:
                    continue  # only axis-aligned wall ends; curved walls have no openings
                mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                dx, dz = (b[0] - a[0]) / length, (b[1] - a[1]) / length
                n = (dz, -dx)
                if w.contains(Point(mid[0] + n[0] * 0.01, mid[1] + n[1] * 0.01)):
                    n = (-n[0], -n[1])
                behind = [Point(a[0] + (b[0] - a[0]) * t - n[0] * 0.15, a[1] + (b[1] - a[1]) * t - n[1] * 0.15) for t in (0.1, 0.5, 0.9)]
                if not all(solid.contains(p) for p in behind):
                    continue
                faces.append({"a": a, "b": b, "mid": mid, "n": n, "len": length})
    return faces


def gap_rects(walls):
    """Axis-aligned rectangles between pairs of wall ends that face each other."""
    union = unary_union(walls)
    faces = end_faces(walls)
    rects = []
    for f in faces:
        best = None
        for g in faces:
            if f is g or f["n"][0] * g["n"][0] + f["n"][1] * g["n"][1] > -0.98:
                continue
            v = (g["mid"][0] - f["mid"][0], g["mid"][1] - f["mid"][1])
            dist = v[0] * f["n"][0] + v[1] * f["n"][1]
            if not 0.3 <= dist <= MAX_GAP:
                continue
            lateral = abs(v[0] * f["n"][1] - v[1] * f["n"][0])
            if lateral > 0.5 * min(f["len"], g["len"]) or min(f["len"], g["len"]) / max(f["len"], g["len"]) < 0.5:
                continue
            gap = box(*Polygon([f["a"], f["b"], g["a"], g["b"]]).bounds)
            if gap.intersection(union).area > 0.03 * gap.area:
                continue
            if best is None or dist < best[0]:
                best = (dist, gap)
        if best:
            # The opening runs along x when the wall end faces point along x.
            rects.append((abs(f["n"][0]) > 0.5, best[1]))
    out = []
    for along_x in (True, False):
        # Stepped reveals give several nested gaps for one opening: merge the
        # ones that overlap, but keep gaps that only touch each other apart.
        merged = unary_union([r.buffer(-0.01, join_style="mitre") for ax, r in rects if ax == along_x])
        for g in getattr(merged, "geoms", [merged]) if not merged.is_empty else []:
            x0, z0, x1, z1 = g.buffer(0.01, join_style="mitre").bounds
            # w = span along the wall, t = span across it
            out.append({"along_x": along_x, "w": (x0, x1) if along_x else (z0, z1), "t": (z0, z1) if along_x else (x0, x1)})
    return out


def merge_leaves(gaps):
    """Join the inner wall gap and the outer brick gap of one opening.

    Cavity walls show up as two gaps side by side. Parts of an outer-leaf gap
    with no inner gap behind them become "fill" (closed brick by default).
    """
    inner = [g for g in gaps if g["t"][1] - g["t"][0] > OUTER_LEAF]
    outer = [g for g in gaps if g["t"][1] - g["t"][0] <= OUTER_LEAF]
    result = []
    for g in inner:
        g = dict(g)
        for o in outer:
            touching = o["along_x"] == g["along_x"] and min(abs(o["t"][0] - g["t"][1]), abs(o["t"][1] - g["t"][0])) < 0.02
            overlap = min(o["w"][1], g["w"][1]) - max(o["w"][0], g["w"][0])
            if touching and overlap > 0.5 * min(o["w"][1] - o["w"][0], g["w"][1] - g["w"][0]):
                g["t"] = (min(g["t"][0], o["t"][0]), max(g["t"][1], o["t"][1]))
                o.setdefault("covered", []).append(g["w"])
        result.append(g)
    for o in outer:
        start = o["w"][0]
        for c0, c1 in sorted(o.get("covered", [])) + [(o["w"][1], o["w"][1])]:
            if c0 - start > 0.1:
                result.append({"along_x": o["along_x"], "w": (start, c0), "t": o["t"], "fill": True})
            start = max(start, c1)
    return result


def openings_for(level_id, walls, overrides):
    out = []
    for g in merge_leaves(gap_rects(walls)):
        (w0, w1), (t0, t1) = g["w"], g["t"]
        cx, cz = ((w0 + w1) / 2, (t0 + t1) / 2) if g["along_x"] else ((t0 + t1) / 2, (w0 + w1) / 2)
        kind = "fill" if g.get("fill") else ("window" if t1 - t0 >= 0.25 else "door")
        out.append({"center": [round(cx, 3), round(cz, 3)], "dir": [1, 0] if g["along_x"] else [0, 1],
                    "width": round(w1 - w0, 3), "thickness": round(t1 - t0, 3), "type": kind, **DEFAULTS[kind]})
    out.sort(key=lambda o: (round(o["center"][1], 1), o["center"][0]))
    for i, o in enumerate(out):
        o["id"] = f"{level_id}-{i + 1:02d}"
        hw, ht = o["width"] / 2, o["thickness"] / 2
        ex, ez = (hw, ht) if o["dir"][0] else (ht, hw)
        rect = box(o["center"][0] - ex - 0.05, o["center"][1] - ez - 0.05, o["center"][0] + ex + 0.05, o["center"][1] + ez + 0.05)
        for ov in overrides:
            if rect.contains(Point(ov["at"])):
                if ov.get("type") in DEFAULTS and ov["type"] != o["type"]:
                    o.update(DEFAULTS[ov["type"]])
                o.update({k: v for k, v in ov.items() if k not in ("at", "note")})
    return [o for o in out if o["type"] != "ignore"]


def room_labels(sheet, level_id):
    """Room name and label position, found from the "<area> m2" text on the plan."""
    words = sheet.page.get_text("words")
    rooms = []
    for w in words:
        if w[4] != "m2":
            continue
        for n in words:
            if re.fullmatch(r"\d+,\d+", n[4]) and abs(n[1] - w[1]) < 2 and 0 < w[0] - n[2] < 6 and n[4] in ROOM_AREAS[level_id]:
                x, z = sheet.to_world((n[0] + w[2]) / 2, n[1])
                rooms.append({"name": ROOM_AREAS[level_id][n[4]], "at": [round(x, 2), round(z, 2)]})
    return rooms


def door_swings(sheet, openings):
    """The swing of each door as the plan draws it (a quarter circle round the hinge, from the
    leaf's free edge when shut to where it stands open): the jamb it hangs on (`hinge`) and the
    side it opens to (`side`: +1 along the opening's normal (-dir z, dir x), -1 the other way)."""
    arcs = []
    for d in sheet.page.get_drawings():
        for it in d["items"]:
            if it[0] == "c":
                arcs.append((sheet.to_world(it[1].x, it[1].y), sheet.to_world(it[4].x, it[4].y)))
    for o in openings:
        if o["type"] != "door" or o["width"] > 1.25:
            continue
        (cx, cz), (ux, uz), w = o["center"], o["dir"], o["width"]
        jambs = [(cx - ux * w / 2, cz - uz * w / 2), (cx + ux * w / 2, cz + uz * w / 2)]
        best = None
        for p, q in arcs:
            for shut, open_ in ((p, q), (q, p)):
                for k in (0, 1):
                    hinge, free = jambs[k], jambs[1 - k]
                    miss = math.dist(shut, free) + abs(math.dist(open_, hinge) - w)
                    side = (open_[0] - hinge[0]) * -uz + (open_[1] - hinge[1]) * ux
                    if math.dist(shut, free) < 0.15 and abs(side) > 0.6 * w and (best is None or miss < best[0]):
                        best = (miss, k, 1 if side > 0 else -1)
        if best:
            o["swing"] = {"hinge": "high" if best[1] else "low", "side": best[2]}


def debug_image(sheet, level_id, walls, openings, glass):
    page = sheet.page
    shape = page.new_shape()
    for w in walls:
        shape.draw_polyline([sheet.from_world(*p) for p in w.exterior.coords])
        shape.finish(color=(1, 0, 0), fill=(1, 0.3, 0.3), fill_opacity=0.5, width=0.3)
    colors = {"door": (0, 0.6, 0), "window": (0, 0.3, 1), "glass": (0, 0.7, 0.9), "fill": (0.6, 0.3, 0)}
    for o in openings:
        cx, cz = o["center"]
        hw, ht = o["width"] / 2, o["thickness"] / 2
        ex, ez = (hw, ht) if o["dir"][0] else (ht, hw)
        shape.draw_rect(pymupdf.Rect(*sheet.from_world(cx - ex, cz - ez), *sheet.from_world(cx + ex, cz + ez)))
        c = colors.get(o["type"], (0.5, 0, 0.5))
        shape.finish(color=c, fill=c, fill_opacity=0.4, width=0.4)
    for g in glass:
        shape.draw_polyline([sheet.from_world(*p) for p in g["path"]])
        shape.finish(color=(1, 0.5, 0) if g.get("door") else (0, 0.7, 0.9), width=1.5)
    shape.commit()
    for o in openings:
        x, y = sheet.from_world(*o["center"])
        page.insert_text((x + 2, y - 2), o["id"].split("-")[1], fontsize=4, color=(0, 0, 0.6))
    house = pymupdf.Rect(*sheet.from_world(-0.8, -3.6), *sheet.from_world(9.8, 12.8))
    page.get_pixmap(dpi=200, clip=house).save(DEBUG / f"{level_id}_house.png")


def main():
    DEBUG.mkdir(parents=True, exist_ok=True)
    manual = json.loads(MANUAL.read_text(encoding="utf-8"))
    plan = PLANS[manual["plan"]]
    pdf = next(ROOT.glob(plan["pdf"]))  # the private plans in source/ (not in git), found by a pattern
    doc = pymupdf.open(pdf)
    offsets = sheet_offsets(doc, plan["pages"], plan["scale"])

    # Origin: back-left outer corner of the house, taken from the 1st floor
    # walls, which form exactly the 9 x 12 m volume.
    probe = Sheet(doc[plan["pages"]["f1"]], offsets["f1"], plan["scale"])
    x0, z0, _, _ = unary_union(wall_shapes(probe)).bounds
    origin = (x0 / probe.pt, z0 / probe.pt)

    result = {"source": plan["label"], "plan": manual["plan"], "scale": f"1:{plan['scale']}",
              "sheet_offsets_pt": {k: [round(v, 3) for v in o] for k, o in offsets.items()}, "levels": {}}
    for level_id, page_index in plan["pages"].items():
        sheet = Sheet(doc[page_index], offsets[level_id], plan["scale"], origin)
        walls = wall_shapes(sheet)
        openings = openings_for(level_id, walls, manual["openings"].get(level_id, []))
        door_swings(sheet, openings)
        result["levels"][level_id] = {
            "walls": [mapping(w)["coordinates"] for w in walls],
            "openings": openings,
            "rooms": room_labels(sheet, level_id),
        }
        glass = [g for g in manual.get("glass", []) if g["level"] == level_id]
        debug_image(sheet, level_id, walls, openings, glass)
        counts = {t: sum(o["type"] == t for o in openings) for t in ("door", "window", "fill")}
        bounds = [round(v, 2) for v in unary_union(walls).bounds]
        print(f"{level_id}: {len(walls)} wall shapes, bounds {bounds}, openings {counts}")
    OUT.write_text(json.dumps(result, indent=1), encoding="utf-8")
    print("wrote", OUT.relative_to(ROOT))


if __name__ == "__main__":
    main()
