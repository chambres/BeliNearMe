from __future__ import annotations

import unittest

from app.models import Coordinates, RecommendationQueryRequest
from app.service import RestaurantDiscoveryService


class _FakeSettings:
    beli_user_id = "user-123"


class _FakeClient:
    def __init__(self) -> None:
        self.settings = _FakeSettings()
        self.avg_score_requests: list[int] = []

    async def user_rec_scores(self, payload):
        return {
            "results": [
                {
                    "expected_percentile": 8.97289637089619,
                    "distance_mi": 7.25,
                    "count": 125,
                    "business": {
                        "id": 228347,
                        "name": "Bundu Khan Kabab House",
                        "formatted_address": "Jones Square Shopping Center, Houston, TX",
                        "city": "Houston",
                        "status": "OPEN",
                        "price": 1,
                        "price_key": "$",
                        "cuisines": ["Pakistani", "Halal"],
                    },
                },
                {
                    "expected_percentile": 9.1,
                    "distance_mi": 18.0,
                    "count": 90,
                    "business": {
                        "id": 555555,
                        "name": "Aga's Restaurant & Catering",
                        "formatted_address": "Houston, TX",
                        "city": "Houston",
                        "status": "OPEN",
                        "price": 2,
                        "price_key": "$",
                        "cuisines": ["Indian", "Pakistani"],
                    },
                },
            ]
        }

    async def average_business_score(self, business_id: int):
        self.avg_score_requests.append(business_id)
        if business_id == 228347:
            return 8.1
        if business_id == 555555:
            return 8.8
        return None


class RestaurantDiscoveryServiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_nearby_recommendations_exposes_average_and_recommendation_scores(self):
        client = _FakeClient()
        service = RestaurantDiscoveryService(client)

        request = RecommendationQueryRequest(
            location=Coordinates(latitude=29.7604, longitude=-95.3698),
            radius_miles=25,
            cuisines=["Halal"],
        )

        response = await service.nearby_recommendations(request)

        self.assertEqual(response.returned_count, 2)
        self.assertEqual(len(response.results), 2)
        self.assertCountEqual(client.avg_score_requests, [228347, 555555])

        result = response.results[0]
        self.assertEqual(result.business.name, "Aga's Restaurant & Catering")
        self.assertAlmostEqual(result.score, 9.1)
        self.assertAlmostEqual(result.recommendation_score, 9.1)
        self.assertAlmostEqual(result.average_beli_score, 8.8)
        self.assertEqual(result.business.price, 2)
        self.assertEqual(result.business.price_key, "$$")
        self.assertTrue(result.within_radius)

    async def test_score_sort_orders_by_average_beli_score_desc(self):
        client = _FakeClient()
        service = RestaurantDiscoveryService(client)

        request = RecommendationQueryRequest(
            location=Coordinates(latitude=29.7604, longitude=-95.3698),
            radius_miles=25,
            cuisines=["Halal"],
            sort_method="Score",
        )

        response = await service.nearby_recommendations(request)

        self.assertEqual(
            [result.business.name for result in response.results],
            ["Aga's Restaurant & Catering", "Bundu Khan Kabab House"],
        )

    async def test_filters_can_exclude_cuisines_and_limit_price_levels(self):
        client = _FakeClient()
        service = RestaurantDiscoveryService(client)

        request = RecommendationQueryRequest(
            location=Coordinates(latitude=29.7604, longitude=-95.3698),
            radius_miles=25,
            excluded_cuisines=["Pakistani"],
            price_levels=[2],
        )

        response = await service.nearby_recommendations(request)

        self.assertEqual(response.results, [])


if __name__ == "__main__":
    unittest.main()
