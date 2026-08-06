from __future__ import annotations

import asyncio
import base64
import json
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

import httpx

from .config import Settings


class BeliAPIError(RuntimeError):
    pass


# Headers that get past Beli's app-only permission gate on the auth endpoints.
_APP_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Origin": "http://localhost",
    "Referer": "http://localhost/",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/136.0.0.0 Safari/537.36"
    ),
    "X-Requested-With": "com.beliapp.myapp",
    "Content-Type": "application/json",
}


async def login(email: str, password: str, api_base: str, timeout_seconds: float = 30.0) -> dict[str, str]:
    """Exchange Beli credentials for a fresh access/refresh token pair.

    Hits POST /token/ (Django SimpleJWT TokenObtainPairView). Returns the raw
    response dict, which contains ``access`` and ``refresh`` on success.
    """
    url = f"{api_base.rstrip('/')}/token/"
    async with httpx.AsyncClient(timeout=timeout_seconds, headers=_APP_HEADERS) as http:
        response = await http.post(url, json={"email": email, "password": password})

    if "No active account" in response.text:
        raise BeliAPIError("Login failed: no active account found with the given credentials.")
    if response.status_code >= 400:
        raise BeliAPIError(f"Login failed ({response.status_code}): {response.text}")

    try:
        data = response.json()
    except json.JSONDecodeError as exc:
        raise BeliAPIError("Login response was not valid JSON.") from exc

    refresh = data.get("refresh")
    if not isinstance(refresh, str) or not refresh:
        raise BeliAPIError("Login response did not contain a refresh token.")
    return data


class BeliClient:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._http = httpx.AsyncClient(
            timeout=settings.request_timeout_seconds,
            headers={
                "Accept": "application/json, text/plain, */*",
                "Origin": "http://localhost",
                "Referer": "http://localhost/",
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/136.0.0.0 Safari/537.36"
                ),
            },
        )
        self._access_token: str | None = None
        self._access_token_expiry: datetime | None = None
        self._refresh_lock = asyncio.Lock()
        # Cache resolved average scores for the process lifetime so overlapping
        # searches don't re-hit the (heavily throttled) databusinessfloat endpoint.
        self._avg_score_cache: dict[int, float | None] = {}
        self._avg_pending: set[int] = set()
        self._avg_warming = False

    @property
    def settings(self) -> Settings:
        return self._settings

    def refresh_token_expiry(self) -> datetime:
        """When the configured refresh token stops working."""
        return _decode_jwt_expiry(self._settings.beli_refresh_token)

    async def close(self) -> None:
        await self._http.aclose()

    async def search_app(self, coords: str, term: str, city: str | None = None, context: str | None = None) -> dict[str, Any]:
        encoded_term = quote(term, safe="")
        path = f"/search-app/?coords={coords}&term={encoded_term}&user={self._settings.beli_user_id}"
        if city:
            path += f"&city={quote(city, safe='')}"
        if context:
            path += f"&context={quote(context, safe='')}"
        return await self._get(path)

    async def search_businesses_full(
        self,
        coords: str,
        term: str,
        city: str | None = None,
        context: str | None = None,
    ) -> dict[str, Any]:
        encoded_term = quote(term, safe="")
        path = f"/search-businesses-full/?coords={coords}&term={encoded_term}&user={self._settings.beli_user_id}"
        if city:
            path += f"&city={quote(city, safe='')}"
        if context:
            path += f"&context={quote(context, safe='')}"
        return await self._get(path)

    async def user_rec_scores(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._post("/user-rec-scores/", payload)

    async def data_business_float(self, business_id: int | None = None, field_name: str | None = None) -> dict[str, Any]:
        path = "/databusinessfloat-sparse/?"
        if business_id is not None:
            path += f"&business={business_id}"
        if field_name:
            path += f"&field__name={quote(field_name, safe='')}"

        data = await self._get(path)
        if not isinstance(data, dict):
            raise BeliAPIError("Unexpected databusinessfloat-sparse response.")
        return data

    async def average_business_score(self, business_id: int) -> float | None:
        """Single fetch of one business's average score. Caches a genuine result
        (number or "no score"); raises BeliAPIError on throttle so the caller can
        decide how to back off. Pacing and backoff are owned by
        warm_average_scores."""
        if business_id in self._avg_score_cache:
            return self._avg_score_cache[business_id]

        data = await self.data_business_float(business_id=business_id, field_name="AVGBUSINESSSCORE")
        value = self._extract_avg_score(data)
        self._avg_score_cache[business_id] = value
        return value

    def has_cached_average(self, business_id: int) -> bool:
        return business_id in self._avg_score_cache

    def cached_average_score(self, business_id: int) -> float | None:
        return self._avg_score_cache.get(business_id)

    async def warm_average_scores(
        self,
        business_ids: list[int],
        pace_seconds: float = 0.5,
    ) -> None:
        """Fill the average-score cache in the background at a slow, serial pace.
        Beli's endpoint allows a short burst and then blocks, so the first 429
        ends the run and drops the rest of the queue: we never retry a throttled
        id. Knocking repeatedly after being told to stop is what gets an account
        flagged, and an unresolved score is only a missing number. Ids left
        unwarmed stay uncached until some later search asks for them again."""
        self._avg_pending.update(bid for bid in business_ids if bid not in self._avg_score_cache)
        if self._avg_warming:
            return

        self._avg_warming = True
        try:
            while self._avg_pending:
                business_id = self._avg_pending.pop()
                if business_id in self._avg_score_cache:
                    continue
                try:
                    await self.average_business_score(business_id)
                except BeliAPIError as exc:
                    if "(429)" in str(exc):
                        self._avg_pending.clear()  # throttled: stand down, don't retry
                        break
                    continue  # a non-throttle error just drops this id
                await asyncio.sleep(pace_seconds)
        finally:
            self._avg_warming = False

    @staticmethod
    def _extract_avg_score(data: dict[str, Any]) -> float | None:
        results = data.get("results")
        if not data.get("count") or not isinstance(results, list) or not results:
            return None
        value = results[0].get("value")
        if value is None:
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    async def filter_options(self, business_ids: list[int]) -> list[dict[str, Any]]:
        path = f"/filter-options/?user={self._settings.beli_user_id}&list=PLAYLISTS&category=RES"
        data = await self._post(path, {"ids": business_ids})
        if not isinstance(data, list):
            raise BeliAPIError("Unexpected filter-options response.")
        return data

    async def dietary_restriction_options(self) -> list[dict[str, Any]]:
        data = await self._get("/dietary-restriction-options/")
        if not isinstance(data, list):
            raise BeliAPIError("Unexpected dietary-restriction-options response.")
        return data

    async def _get(self, path: str) -> dict[str, Any]:
        return await self._request_json("GET", path)

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any] | list[dict[str, Any]]:
        return await self._request_json("POST", path, json_body=payload)

    async def _request_json(
        self,
        method: str,
        path: str,
        json_body: dict[str, Any] | None = None,
        retried: bool = False,
    ) -> dict[str, Any] | list[dict[str, Any]]:
        token = await self._get_access_token()
        url = f"{self._settings.beli_api_base}{path}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-Requested-With": "com.beliapp.myapp",
        }

        response = await self._http.request(method, url, headers=headers, json=json_body)
        if response.status_code == 401 and not retried:
            await self._refresh_access_token(force=True)
            return await self._request_json(method, path, json_body=json_body, retried=True)
        if response.status_code >= 400:
            raise BeliAPIError(f"Beli request failed ({response.status_code}): {response.text}")

        try:
            return response.json()
        except json.JSONDecodeError as exc:
            raise BeliAPIError("Beli response was not valid JSON.") from exc

    async def _get_access_token(self) -> str:
        if self._access_token and self._access_token_expiry:
            if datetime.now(timezone.utc) + timedelta(seconds=60) < self._access_token_expiry:
                return self._access_token
        await self._refresh_access_token()
        if not self._access_token:
            raise BeliAPIError("Unable to obtain an access token.")
        return self._access_token

    async def _refresh_access_token(self, force: bool = False) -> None:
        async with self._refresh_lock:
            if not force and self._access_token and self._access_token_expiry:
                if datetime.now(timezone.utc) + timedelta(seconds=60) < self._access_token_expiry:
                    return

            url = f"{self._settings.beli_api_base}/token/refresh/"
            response = await self._http.post(
                url,
                json={"refresh": self._settings.beli_refresh_token},
                headers={"Content-Type": "application/json"},
            )
            if response.status_code >= 400:
                raise BeliAPIError(f"Token refresh failed ({response.status_code}): {response.text}")

            data = response.json()
            access_token = data.get("access")
            if not isinstance(access_token, str) or not access_token:
                raise BeliAPIError("Token refresh response did not contain an access token.")

            self._access_token = access_token
            self._access_token_expiry = _decode_jwt_expiry(access_token)


def _decode_jwt_expiry(token: str) -> datetime:
    try:
        payload_segment = token.split(".")[1]
        padding = "=" * (-len(payload_segment) % 4)
        payload_bytes = base64.urlsafe_b64decode(payload_segment + padding)
        payload = json.loads(payload_bytes.decode("utf-8"))
        exp = int(payload["exp"])
    except (IndexError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise BeliAPIError("Unable to decode JWT expiry.") from exc

    return datetime.fromtimestamp(exp, tz=timezone.utc)
