"""Overlay the extracted walls on a newer plan set to spot what changed.

The newer sheets draw walls as hatched outlines, which the extractor
can't read reliably. Instead, this script lines the extracted walls up with
the newer sheet (matching wall corners to the sheet's line ends) and draws
them on top, so differences are easy to see. Output: data/debug/compare_<level>.png

Run from the project root:
    tools/.venv/Scripts/python.exe tools/compare_plans.py lichtplan-2026-07-07
"""
import json
import sys
from pathlib import Path

import pymupdf
from shapely.geometry import Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_plan import PLANS, ROOT, vote_shift  # noqa: E402

EXTRACTED = ROOT / "data/extracted.json"
DEBUG = ROOT / "data/debug"


def line_ends(page, pt):
    """End points of straight lines on the sheet, in metres (sheet frame)."""
    pts = []
    for d in page.get_drawings():
        for it in d["items"]:
            if it[0] == "l" and abs(it[1] - it[2]) * pt > 0.3:
                pts += [(it[1].x * pt, it[1].y * pt), (it[2].x * pt, it[2].y * pt)]
    return pts


def main(plan_name):
    plan = PLANS[plan_name]
    doc = pymupdf.open(ROOT / plan["pdf"])
    pt = 25.4 / 72 / 1000 * plan["scale"]
    ext = json.loads(EXTRACTED.read_text(encoding="utf-8"))
    for level, index in plan["pages"].items():
        page = doc[index]
        walls = [Polygon(w[0], w[1:]) for w in ext["levels"][level]["walls"]]
        corners = [c for w in walls for c in w.exterior.coords]
        (dx, dz), votes = vote_shift(line_ends(page, pt), corners, 0.02)
        print(f"{level}: {votes} wall corners match the newer sheet, shift ({dx:.3f}, {dz:.3f}) m")
        shape = page.new_shape()
        for w in walls:
            shape.draw_polyline([((x + dx) / pt, (z + dz) / pt) for x, z in w.exterior.coords])
            shape.finish(color=(1, 0, 0), fill=(1, 0, 0), fill_opacity=0.35, width=0.4)
        shape.commit()
        xs = [x for x, _ in corners]
        zs = [z for _, z in corners]
        clip = pymupdf.Rect((min(xs) + dx) / pt - 40, (min(zs) + dz) / pt - 40, (max(xs) + dx) / pt + 40, (max(zs) + dz) / pt + 40)
        page.get_pixmap(dpi=110, clip=clip).save(DEBUG / f"compare_{level}.png")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "lichtplan-2026-07-07")
