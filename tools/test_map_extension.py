"""Checks for joining the geographic strips. Run: python -m unittest discover -s tools -p 'test_*.py'."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image
from shapely.geometry import LineString, Point, Polygon

import neighbours as nb


class MapExtensionTests(unittest.TestCase):
    def setUp(self):
        # Two streets going east and a lane joining them; leave the open land between them out.
        roads = [[(118900, 184981), (119900, 184981)], [(119000, 184084), (119900, 184084)],
                 [(119650, 184084), (119650, 184981)]]
        features = [{"geometry": {"type": "LineString", "coordinates": line},
                     "properties": {"LBLMORF": "weg bestaande uit één rijbaan"}} for line in roads]
        real_features = nb.features
        self.geo = patch.object(nb, "features", side_effect=lambda name, **kw:
                                features if name == "Wegsegment" else [] if name == "GBG" else real_features(name, **kw))
        self.geo.start()
        self.addCleanup(self.geo.stop)

    def test_partial_download_does_not_activate_strip(self):
        with tempfile.TemporaryDirectory() as folder:
            geo = Path(folder)
            side = geo / "strip_e"
            side.mkdir()
            for file in nb.STRIP_FILES[:-1]:
                (side / file).touch()
            with patch.object(nb, "GEO", geo):
                self.assertNotIn("e", nb.available_strips())
                (side / nb.STRIP_FILES[-1]).touch()
                self.assertIn("e", nb.available_strips())

    def test_expands_geographic_east_only(self):
        plot = Point(118911, 184981)
        old = nb.hull(plot)
        with patch.object(nb, "ACTIVE_STRIPS", {"e": (119500, 183600, 119900, 185600)}), \
                patch.object(nb, "band", return_value=Polygon()):
            expanded = nb.zone(plot)
            self.assertTrue(expanded.is_valid)
            self.assertEqual(expanded.geom_type, "Polygon")
            self.assertLess(old.difference(expanded).area, 1e-6)
            self.assertAlmostEqual(expanded.bounds[2] - old.bounds[2], 400)
            for i in (0, 1, 3):
                self.assertAlmostEqual(expanded.bounds[i], old.bounds[i])
            self.assertLess(nb.east(plot).intersection(old).area, 1e-6)

    def test_without_east_download_keeps_original_area(self):
        plot = Point(118911, 184981)
        with patch.object(nb, "ACTIVE_STRIPS", {}), patch.object(nb, "band", return_value=Polygon()):
            self.assertTrue(nb.east(plot).is_empty)
            self.assertTrue(nb.zone(plot).equals(nb.hull(plot)))

    def test_western_band_remains_in_expanded_area(self):
        plot = Point(118911, 184981)
        band = Point(118400, 184100).buffer(100)
        with patch.object(nb, "ACTIVE_STRIPS", {"e": ()}), patch.object(nb, "band", return_value=band):
            self.assertLess(band.difference(nb.zone(plot)).area, 1e-6)

    def test_open_fields_between_roads_stay_out(self):
        plot = Point(118911, 184981)
        with patch.object(nb, "ACTIVE_STRIPS", {"e": ()}):
            extension = nb.east(plot)
            self.assertTrue(extension.contains(Point(119600, 184981)))
            self.assertFalse(extension.contains(Point(119550, 184550)))

    def test_without_sparrenhof_download_keeps_area(self):
        plot = Point(118911, 184981)
        with patch.object(nb, "ACTIVE_STRIPS", {"e": ()}), patch.object(nb, "band", return_value=Polygon()):
            self.assertTrue(nb.sparrenhof(plot).is_empty)
            self.assertTrue(nb.zone(plot).equals(nb.before(plot)))

    def test_way_to_sparrenhof_follows_the_street(self):
        # A street from the plot west and on north-west to the café, a track beside it that is shorter, and a street
        # that goes elsewhere.
        cafe = nb.SPARRENHOF
        bend = (118300, 184700)
        street = {"LBLMORF": "weg bestaande uit één rijbaan", "LSTRNM": "Oud-Smetlede"}
        roads = [([(118911, 184981), (118500, 184800), bend], street), ([bend, (cafe[0] + 5, cafe[1])], street),
                 ([(118911, 184981), (cafe[0] + 5, cafe[1])], {"LBLMORF": "aardeweg", "LSTRNM": "nvt"}),
                 ([bend, (118300, 184200)], {"LBLMORF": "weg bestaande uit één rijbaan", "LSTRNM": "Elders"})]
        features = [{"geometry": {"type": "LineString", "coordinates": line}, "properties": props} for line, props in roads]
        plot = Point(118911, 184981)
        with patch.object(nb, "features", side_effect=lambda name, **kw: features if name == "Wegsegment" else []), \
                patch.object(nb, "ACTIVE_STRIPS", {"w2": ()}), patch.object(nb, "band", return_value=Polygon()):
            way = nb.way_to((plot.x, plot.y), cafe)
            self.assertEqual({name for _, name in way}, {"Oud-Smetlede"})
            extension = nb.sparrenhof(plot)
            old = nb.hull(plot)
            self.assertLess(extension.intersection(old).area, 1e-6)
            self.assertTrue(extension.contains(Point(cafe)))
            self.assertTrue(extension.contains(Point(cafe[0] - 140, cafe[1])))  # the wood round the café
            mid = LineString([bend, cafe]).interpolate(0.5, normalized=True)
            self.assertTrue(extension.contains(Point(mid.x + 50 * 0.6, mid.y + 50 * 0.8)))  # beside the street
            self.assertFalse(extension.contains(Point(118300, 184150)))  # the street that goes elsewhere
            self.assertFalse(extension.contains(Point(118137, 185181)))  # the field beside the shorter track

    def test_rasters_and_photos_align_west_base_east(self):
        with tempfile.TemporaryDirectory() as folder:
            sources = []
            for i, name in enumerate(("west", "base", "east")):
                path = Path(folder) / name
                path.mkdir()
                extent = (i * 2, 0, i * 2 + 2, 2)
                sources.append((path, extent))
                Image.fromarray(np.full((2, 2), i + 1, np.float32)).save(path / "DHMVII_DTM_1m_clean.tif")
                Image.new("RGB", (4, 4), (i * 80, 0, 0)).save(path / "ortho_025m.jpg", quality=100, subsampling=0)
                (path / "ortho_025m.json").write_text(json.dumps(dict(zip(
                    ("x0", "y0", "x1", "y1", "px", "py"), (*extent, 4, 4)))))
            with patch.object(nb, "SOURCES", sources):
                heights = nb.raster("DTM")
                self.assertEqual(heights.shape, (2, 6))
                np.testing.assert_array_equal(heights[0], [1, 1, 2, 2, 3, 3])
                image, frame = nb.ortho_image()
                self.assertEqual(image.size, (12, 4))
                self.assertEqual((frame["x0"], frame["x1"], frame["px"]), (0, 6, 12))
                for x, expected in ((1, 0), (5, 80), (9, 160)):
                    self.assertLessEqual(abs(image.getpixel((x, 1))[0] - expected), 1)

    def test_bad_raster_size_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            Image.fromarray(np.zeros((2, 3), np.float32)).save(path / "DHMVII_DTM_1m_clean.tif")
            with patch.object(nb, "SOURCES", [(path, (0, 0, 2, 2))]):
                with self.assertRaisesRegex(ValueError, "raster does not match"):
                    nb.raster("DTM")

    def test_features_keep_base_priority_and_deduplicate_both_strips(self):
        self.geo.stop()
        with tempfile.TemporaryDirectory() as folder:
            geo = Path(folder)
            for name, ids in (("", [1, 2]), ("strip_w", [2, 3]), ("strip_e", [1, 3, 4, 4])):
                path = geo / name
                path.mkdir(exist_ok=True)
                features = [{"properties": {"OIDN": oid, "from": name}} for oid in ids]
                (path / "GBG_l72.json").write_text(json.dumps({"features": features}))
            with patch.object(nb, "GEO", geo), patch.object(nb, "ACTIVE_STRIPS", {"w": (), "e": ()}):
                merged = nb.features("GBG")
                self.assertEqual([f["properties"]["OIDN"] for f in merged], [1, 2, 3, 4])
                self.assertEqual(merged[0]["properties"]["from"], "")
                self.assertEqual(len(nb.features("GBG", strip=False)), 2)


if __name__ == "__main__":
    unittest.main()
