import json
from pathlib import Path
import unittest
from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely.affinity import scale

ROOT = Path(__file__).resolve().parent.parent


class WindowCornerTests(unittest.TestCase):
    def test_generated_corner_frames_close_the_junction_at_eye_height(self):
        from molenhoek_end_inside import FRAME_IN, corner_frame_parts
        data = json.loads((ROOT / "web/src/data/molenhoek_end_inside.json").read_text(encoding="utf-8"))
        corners = [(p, a, b) for p, a, b in corner_frame_parts() if a < 1.65 < b]
        self.assertTrue(corners, "the ground-floor glass corner must have a post")
        for post, y0, y1 in corners:
            expected = scale(post, xfact=-1, yfact=1, origin=(0, 0))
            frames = [Polygon(p["p"][0], p["p"][1:]) for p in data["prisms"]
                      if p.get("c") == FRAME_IN and p["y0"] <= 1.65 <= p["y1"] and p.get("v", 1)]
            self.assertTrue(unary_union(frames).buffer(0.002).covers(expected), "the whole frame join must be drawn, not open to the exterior")


if __name__ == "__main__":
    unittest.main()
