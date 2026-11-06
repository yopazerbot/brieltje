import unittest
import json
from pathlib import Path
from building_ground import frontage_base, wall_bottom


class Relief:
    def height(self, x, z):
        return x * 0.1 + z * 0.02


class BuildingGroundTests(unittest.TestCase):
    def setUp(self):
        self.house = {"y0": -1, "front": [[0, 0], [10, 0]], "out": [0, 1],
                      "openings": [[2, 1, 0, 2, "d", {}], [8, 1, 0, 2, "d", {}]]}

    def test_level_floor_clears_both_entrances_on_a_slope(self):
        self.assertEqual(frontage_base(self.house, Relief()), 0.81)

    def test_garage_and_midpoint_fallbacks(self):
        self.house["openings"] = [[3, 2, 0, 2, "g", {}]]
        self.assertEqual(frontage_base(self.house, Relief()), 0.31)
        self.house["openings"] = []
        self.assertEqual(frontage_base(self.house, Relief()), 0.51)

    def test_explicit_raised_and_walk_in_floors_are_preserved(self):
        for flag, value in (("raise", 0.65), ("inside", True)):
            house = {**self.house, flag: value}
            self.assertEqual(frontage_base(house, Relief()), -1)

    def test_standalone_threshold_follows_its_entrance(self):
        self.assertEqual(frontage_base({**self.house, "threshold": 0.3}, Relief()), 1.06)

    def test_foundation_reaches_a_dip_between_wall_ends(self):
        bottom = wall_bottom((0, 0), (10, 0), 1, lambda x, z: -2 if 4 <= x <= 6 else 0)
        self.assertEqual(bottom, -3.25)

    def test_built_street_data_has_no_buried_ordinary_front_doors(self):
        from molenhoek_survey import Relief as MapRelief, door_grounds
        root = Path(__file__).resolve().parent.parent
        relief = MapRelief()
        checked = 0
        for name in ("molenhoek", "molenhoek_end1", "molenhoek_end2", "molenhoek_end3", "kapellenhoek"):
            houses = json.loads((root / "data" / (name + ".json")).read_text(encoding="utf-8"))["houses"]
            for house in houses.values():
                if "raise" in house or house.get("inside") or house.get("threshold") is not None:
                    continue
                for ground in door_grounds(house, relief):
                    self.assertGreaterEqual(house["y0"] + 0.05, ground - 0.001)
                    checked += 1
        self.assertGreater(checked, 100)


if __name__ == "__main__":
    unittest.main()
