import unittest

from app.client import BeliAPIError, BeliClient
from app.config import Settings


def _score_payload(value: float) -> dict:
    return {"count": 1, "results": [{"value": value}]}


class WarmAverageScoresTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.client = BeliClient(Settings(beli_user_id="u", beli_refresh_token="t"))
        self.calls: list[int] = []

    async def asyncTearDown(self) -> None:
        await self.client.close()

    async def test_first_throttle_stops_the_run_and_nothing_is_retried(self):
        """A 429 means stand down. Retrying after being told to stop is what
        gets an account flagged, so one throttle ends the whole run."""

        async def always_throttled(business_id: int, field_name: str) -> dict:
            self.calls.append(business_id)
            raise BeliAPIError("Beli API error (429): rate limited")

        self.client.data_business_float = always_throttled

        await self.client.warm_average_scores([1, 2, 3, 4, 5], pace_seconds=0)

        self.assertEqual(len(self.calls), 1, "should stop at the first 429, not keep knocking")
        self.assertEqual(self.client._avg_pending, set(), "queue should be dropped, not retried")
        for business_id in [1, 2, 3, 4, 5]:
            self.assertFalse(self.client.has_cached_average(business_id))

    async def test_successful_scores_are_cached_and_not_refetched(self):
        async def resolves(business_id: int, field_name: str) -> dict:
            self.calls.append(business_id)
            return _score_payload(8.5)

        self.client.data_business_float = resolves

        await self.client.warm_average_scores([1, 2, 3], pace_seconds=0)
        self.assertEqual(sorted(self.calls), [1, 2, 3])
        self.assertEqual(self.client.cached_average_score(2), 8.5)

        # A second pass over the same ids must not hit the endpoint again.
        await self.client.warm_average_scores([1, 2, 3], pace_seconds=0)
        self.assertEqual(len(self.calls), 3)

    async def test_non_throttle_error_drops_one_id_but_continues(self):
        async def one_bad(business_id: int, field_name: str) -> dict:
            self.calls.append(business_id)
            if business_id == 2:
                raise BeliAPIError("Beli API error (500): server error")
            return _score_payload(7.0)

        self.client.data_business_float = one_bad

        await self.client.warm_average_scores([1, 2, 3], pace_seconds=0)

        self.assertEqual(sorted(self.calls), [1, 2, 3])
        self.assertFalse(self.client.has_cached_average(2))
        self.assertEqual(self.client.cached_average_score(1), 7.0)
        self.assertEqual(self.client.cached_average_score(3), 7.0)


if __name__ == "__main__":
    unittest.main()
