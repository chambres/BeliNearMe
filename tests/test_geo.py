from __future__ import annotations

import unittest

from app.geo import haversine_miles, miles_to_bounds


class GeoTests(unittest.TestCase):
    def test_haversine_zero_distance(self) -> None:
        self.assertAlmostEqual(haversine_miles(29.7604, -95.3698, 29.7604, -95.3698), 0.0, places=6)

    def test_bounds_expand_around_center(self) -> None:
        bounds = miles_to_bounds(29.7604, -95.3698, 10.0)
        self.assertGreater(bounds["northLatitude"], 29.7604)
        self.assertLess(bounds["southLatitude"], 29.7604)
        self.assertGreater(bounds["eastLongitude"], -95.3698)
        self.assertLess(bounds["westLongitude"], -95.3698)

    def test_houston_distance_is_reasonable(self) -> None:
        downtown_houston = (29.7604, -95.3698)
        nearby_point = (29.7787, -95.4180)
        distance = haversine_miles(*downtown_houston, *nearby_point)
        self.assertGreater(distance, 2.0)
        self.assertLess(distance, 5.0)


if __name__ == "__main__":
    unittest.main()
