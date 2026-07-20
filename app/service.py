from __future__ import annotations

import asyncio
from typing import Any

from .client import BeliAPIError, BeliClient
from .geo import haversine_miles, miles_to_bounds
from .models import (
    BeliFilter,
    BusinessSummary,
    DietaryRestrictionOption,
    DietaryRestrictionResponse,
    FilterOption,
    RecommendationQueryRequest,
    RecommendationQueryResponse,
    RestaurantResult,
    SearchPrediction,
    SearchRequest,
    SearchResponse,
)


class RestaurantDiscoveryService:
    def __init__(self, client: BeliClient) -> None:
        self._client = client
        # Only warm avg scores for the top-scored results per search, to bound
        # how much of the throttled endpoint we touch.
        self._average_score_limit = 60

    async def search_app(self, request: SearchRequest) -> SearchResponse:
        coords = f"{request.location.latitude},{request.location.longitude}"
        data = await self._client.search_app(coords=coords, term=request.term, city=request.city, context=request.context)
        return SearchResponse(
            source_endpoint="/search-app/",
            term=request.term,
            cuisines=data.get("cuisines", []),
            labels=data.get("labels", []),
            predictions=[self._normalize_prediction(item) for item in data.get("predictions", [])],
            raw=data,
        )

    async def search_businesses_full(self, request: SearchRequest) -> SearchResponse:
        coords = f"{request.location.latitude},{request.location.longitude}"
        data = await self._client.search_businesses_full(
            coords=coords,
            term=request.term,
            city=request.city,
            context=request.context,
        )
        return SearchResponse(
            source_endpoint="/search-businesses-full/",
            term=request.term,
            cuisines=[],
            labels=[],
            predictions=[self._normalize_prediction(item) for item in data.get("predictions", [])],
            raw=data,
        )

    async def dietary_restrictions(self) -> DietaryRestrictionResponse:
        data = await self._client.dietary_restriction_options()
        options = [DietaryRestrictionOption(name=str(item.get("name", "")).strip(), raw=item) for item in data if item.get("name")]
        return DietaryRestrictionResponse(options=options)

    async def nearby_recommendations(
        self,
        request: RecommendationQueryRequest,
        forced_cuisines: list[str] | None = None,
    ) -> RecommendationQueryResponse:
        cuisines = list(request.cuisines)
        if forced_cuisines:
            cuisines.extend(forced_cuisines)
        cuisines = _unique_strings(cuisines)

        bounds = miles_to_bounds(
            latitude=request.location.latitude,
            longitude=request.location.longitude,
            radius_miles=request.radius_miles,
        )
        filters = self._build_filters(request=request, cuisines=cuisines)
        payload = {
            "user": self._client.settings.beli_user_id,
            "category": "RES",
            "page": request.page,
            "page_size": request.page_size,
            "sort_method": request.sort_method,
            "coords": f"{request.location.latitude},{request.location.longitude}",
            "filters": [item.model_dump() for item in filters],
            "bounds": bounds,
            "for_map_view": request.for_map_view,
        }

        raw_response = await self._client.user_rec_scores(payload)
        raw_results = raw_response.get("results", [])
        normalized = self._normalize_restaurant_results(
            raw_results=raw_results,
            center_latitude=request.location.latitude,
            center_longitude=request.location.longitude,
            radius_miles=request.radius_miles,
            exact_radius_only=request.exact_radius_only,
            min_score=request.min_score,
            dedupe_businesses=request.dedupe_businesses,
        )
        await self._populate_average_beli_scores(normalized)
        normalized = self._apply_result_filters(
            normalized,
            excluded_cuisines=request.excluded_cuisines,
            price_levels=request.price_levels,
        )
        self._sort_results(normalized, request.sort_method)

        filter_options: list[FilterOption] = []
        if request.include_filter_options and normalized:
            business_ids = [item.business.id for item in normalized]
            raw_filter_options = await self._client.filter_options(business_ids)
            filter_options = [
                FilterOption(
                    field_name=str(item.get("field__name", "")),
                    value=str(item.get("value", "")),
                    count=int(item.get("count", 0)),
                )
                for item in raw_filter_options
                if item.get("field__name") and item.get("value") is not None
            ]

        exact_radius_count = sum(1 for item in normalized if item.within_radius)
        return RecommendationQueryResponse(
            source_endpoint="/user-rec-scores/",
            request_summary={
                "radius_miles": request.radius_miles,
                "sort_method": request.sort_method,
                "city": request.city,
                "cuisines": cuisines,
                "excluded_cuisines": request.excluded_cuisines,
                "price_levels": request.price_levels,
                "open_now": request.open_now,
                "bounds": bounds,
                "filters": [item.model_dump() for item in filters],
            },
            returned_count=len(raw_results),
            exact_radius_count=exact_radius_count,
            results=normalized,
            filter_options=filter_options,
        )

    def _build_filters(
        self,
        request: RecommendationQueryRequest,
        cuisines: list[str],
    ) -> list[BeliFilter]:
        merged: dict[str, list[Any]] = {}

        def add_filter(key: str, values: list[Any]) -> None:
            current = merged.setdefault(key, [])
            for value in values:
                if value not in current:
                    current.append(value)

        if request.city:
            add_filter("CITY", [request.city])
        if cuisines:
            add_filter("CUISINE", cuisines)
        if request.open_now:
            add_filter("OPEN_NOW", [True])
        for item in request.raw_filters:
            add_filter(item.key, item.value)

        return [BeliFilter(key=key, value=value) for key, value in merged.items()]

    def _normalize_prediction(self, item: dict[str, Any]) -> SearchPrediction:
        business = item.get("business") or {}
        formatting = item.get("structured_formatting") or {}
        return SearchPrediction(
            business_id=business.get("id") or item.get("business_id"),
            place_id=item.get("place_id"),
            name=str(formatting.get("main_text") or business.get("name") or item.get("description") or "Unknown"),
            secondary_text=formatting.get("secondary_text") or business.get("city"),
            source_used=item.get("source_used"),
            raw=item,
        )

    def _normalize_restaurant_results(
        self,
        raw_results: list[dict[str, Any]],
        center_latitude: float,
        center_longitude: float,
        radius_miles: float,
        exact_radius_only: bool,
        min_score: float | None,
        dedupe_businesses: bool,
    ) -> list[RestaurantResult]:
        seen_ids: set[int] = set()
        results: list[RestaurantResult] = []

        for item in raw_results:
            business = item.get("business") or {}
            business_id = business.get("id")
            if not isinstance(business_id, int):
                continue
            if dedupe_businesses and business_id in seen_ids:
                continue

            distance_mi = item.get("distance_mi")
            if distance_mi is None and business.get("lat") is not None and business.get("lng") is not None:
                distance_mi = haversine_miles(
                    latitude_a=center_latitude,
                    longitude_a=center_longitude,
                    latitude_b=float(business["lat"]),
                    longitude_b=float(business["lng"]),
                )

            within_radius = distance_mi is not None and float(distance_mi) <= radius_miles
            score = item.get("expected_percentile")

            if exact_radius_only and not within_radius:
                continue
            if min_score is not None and score is not None and float(score) < min_score:
                continue

            results.append(
                RestaurantResult(
                    business=BusinessSummary(
                        id=business_id,
                        name=str(business.get("name", "Unknown")),
                        address=_best_address(business),
                        city=business.get("city"),
                        borough=business.get("borough"),
                        neighborhood=business.get("neighborhood"),
                        status=business.get("status"),
                        price=business.get("price"),
                        price_key=_best_price_key(business),
                        lat=business.get("lat"),
                        lng=business.get("lng"),
                        cuisines=business.get("cuisines", []) or [],
                        place_id=business.get("place_id"),
                        quick_link=business.get("quick_link"),
                    ),
                    score=float(score) if score is not None else None,
                    recommendation_score=float(score) if score is not None else None,
                    average_beli_score=None,
                    google_rating=_best_google_rating(item, business),
                    distance_mi=float(distance_mi) if distance_mi is not None else None,
                    within_radius=within_radius,
                    mention_count=item.get("count"),
                    raw=item,
                )
            )
            seen_ids.add(business_id)

        return results

    async def _populate_average_beli_scores(self, results: list[RestaurantResult]) -> None:
        if not results:
            return

        # Fill instantly from cache; never block the response on the throttled
        # avg-score endpoint. Uncached top-scored ids are warmed in the
        # background at a safe pace and picked up by later searches / the
        # frontend's score refresh.
        for result in results:
            if self._client.has_cached_average(result.business.id):
                result.average_beli_score = self._client.cached_average_score(result.business.id)

        ranked = sorted(
            results,
            key=lambda item: item.recommendation_score if item.recommendation_score is not None else float("-inf"),
            reverse=True,
        )
        uncached = [
            result.business.id
            for result in ranked[: self._average_score_limit]
            if not self._client.has_cached_average(result.business.id)
        ]
        if uncached:
            asyncio.create_task(self._client.warm_average_scores(uncached))

    def _apply_result_filters(
        self,
        results: list[RestaurantResult],
        excluded_cuisines: list[str],
        price_levels: list[int],
    ) -> list[RestaurantResult]:
        excluded_cuisine_set = {value.strip().lower() for value in excluded_cuisines if value.strip()}
        allowed_prices = set(price_levels)
        filtered: list[RestaurantResult] = []

        for result in results:
            if allowed_prices and result.business.price not in allowed_prices:
                continue

            result_cuisines = {
                value.strip().lower()
                for value in result.business.cuisines
                if isinstance(value, str) and value.strip()
            }
            if excluded_cuisine_set and result_cuisines.intersection(excluded_cuisine_set):
                continue

            filtered.append(result)

        return filtered

    def _sort_results(self, results: list[RestaurantResult], sort_method: str) -> None:
        if sort_method != "Score":
            return

        results.sort(
            key=lambda result: (
                result.average_beli_score is not None,
                result.average_beli_score if result.average_beli_score is not None else float("-inf"),
                result.recommendation_score if result.recommendation_score is not None else float("-inf"),
                result.mention_count if result.mention_count is not None else -1,
                -(result.distance_mi if result.distance_mi is not None else float("inf")),
            ),
            reverse=True,
        )


def _unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        cleaned = value.strip()
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            result.append(cleaned)
    return result


def _best_address(business: dict[str, Any]) -> str | None:
    direct_candidates = [
        business.get("formatted_address"),
        business.get("street_address"),
        business.get("address"),
        business.get("display_address"),
    ]
    for candidate in direct_candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()

    parts: list[str] = []
    for candidate in [business.get("neighborhood"), business.get("borough"), business.get("city")]:
        if isinstance(candidate, str) and candidate.strip() and candidate.strip() not in parts:
            parts.append(candidate.strip())
    return ", ".join(parts) if parts else None


def _best_google_rating(item: dict[str, Any], business: dict[str, Any]) -> float | None:
    candidates = [
        business.get("google_rating"),
        business.get("googleRating"),
        business.get("rating"),
        item.get("google_rating"),
        item.get("googleRating"),
    ]
    for candidate in candidates:
        if candidate is None:
            continue
        try:
            return float(candidate)
        except (TypeError, ValueError):
            continue
    return None


def _best_price_key(business: dict[str, Any]) -> str | None:
    price = business.get("price")
    if isinstance(price, int) and price > 0:
        return "$" * price

    try:
        numeric_price = int(price)
    except (TypeError, ValueError):
        numeric_price = None

    if numeric_price is not None and numeric_price > 0:
        return "$" * numeric_price

    direct_candidates = [
        business.get("price_key"),
        business.get("priceKey"),
    ]
    for candidate in direct_candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()

    return None
