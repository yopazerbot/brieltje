import json
from pathlib import Path
import struct
import unittest

ROOT = Path(__file__).resolve().parent.parent


class HouseLocationTests(unittest.TestCase):
    def test_detailed_house_occupies_the_marked_plot_only(self):
        from molenhoek_end_survey import HOUSES
        self.assertNotIn("b555l_cube", HOUSES)
        house = HOUSES["b377l_cube"]
        x, z = house["at"]
        self.assertTrue(1179 < x < 1189 and -453 < z < -442)
        self.assertTrue(house["long_brick"])
        self.assertEqual(house["threshold"], 0.3)
        for name in ("molenhoek_end2", "molenhoek_end3"):
            data = json.loads((ROOT / "data" / (name + ".json")).read_text(encoding="utf-8"))
            self.assertNotIn("b555l_cube", data["houses"])
        self.assertIn("b377l_cube", json.loads((ROOT / "data/molenhoek_end2.json").read_text(encoding="utf-8"))["houses"])
        raw = (ROOT / "web/public/models/molenhoek_end3.glb").read_bytes()
        length = struct.unpack_from('<I', raw, 12)[0]
        model = json.loads(raw[20:20 + length])
        extras = next(n['extras'] for n in model['nodes'] if n.get('extras', {}).get('landmark') == 'molenhoek_end3')
        self.assertFalse(extras.get('gone'), 'the wrong site must no longer hide the original village buildings')


if __name__ == "__main__":
    unittest.main()
