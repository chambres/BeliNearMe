from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


SortMethod = Literal["Score", "Distance", "Date added", "Recency", "Most Trending", "Number of friends"]


class Coordinates(BaseModel):
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)


class Bounds(BaseModel):
    northLatitude: float = Field(..., ge=-90, le=90)
    southLatitude: float = Field(..., ge=-90, le=90)
    eastLongitude: float = Field(..., ge=-180, le=180)
    westLongitude: float = Field(..., ge=-180, le=180)


class BeliFilter(BaseModel):
    key: str = Field(..., min_length=1)
    value: list[Any] = Field(default_factory=list)


class RecommendationQueryRequest(BaseModel):
    location: Coordinates
    radius_miles: float = Field(10.0, gt=0, le=100)
    page: int = Field(1, ge=1)
    page_size: int = Field(50, ge=1, le=200)
    sort_method: SortMethod = "Score"
    city: str | None = None
    cuisines: list[str] = Field(default_factory=list)
    excluded_cuisines: list[str] = Field(default_factory=list)
    price_levels: list[int] = Field(default_factory=list)
    open_now: bool = False
    min_score: float | None = Field(default=None, ge=0, le=10)
    exact_radius_only: bool = True
    include_filter_options: bool = False
    dedupe_businesses: bool = True
    for_map_view: bool = True
    raw_filters: list[BeliFilter] = Field(default_factory=list)

    @field_validator("cuisines", mode="after")
    @classmethod
    def normalize_cuisines(cls, cuisines: list[str]) -> list[str]:
        seen: set[str] = set()
        normalized: list[str] = []
        for cuisine in cuisines:
            cleaned = cuisine.strip()
            if cleaned and cleaned not in seen:
                seen.add(cleaned)
                normalized.append(cleaned)
        return normalized

    @field_validator("excluded_cuisines", mode="after")
    @classmethod
    def normalize_excluded_cuisines(cls, cuisines: list[str]) -> list[str]:
        seen: set[str] = set()
        normalized: list[str] = []
        for cuisine in cuisines:
            cleaned = cuisine.strip()
            lowered = cleaned.lower()
            if cleaned and lowered not in seen:
                seen.add(lowered)
                normalized.append(cleaned)
        return normalized

    @field_validator("price_levels", mode="after")
    @classmethod
    def normalize_price_levels(cls, price_levels: list[int]) -> list[int]:
        seen: set[int] = set()
        normalized: list[int] = []
        for price_level in price_levels:
            if 1 <= price_level <= 4 and price_level not in seen:
                seen.add(price_level)
                normalized.append(price_level)
        return normalized


class SearchRequest(BaseModel):
    term: str = Field(..., min_length=1)
    location: Coordinates
    city: str | None = None
    context: str | None = None


class BusinessSummary(BaseModel):
    id: int
    name: str
    address: str | None = None
    city: str | None = None
    borough: str | None = None
    neighborhood: str | None = None
    status: str | None = None
    price: int | None = None
    price_key: str | None = None
    lat: float | None = None
    lng: float | None = None
    cuisines: list[str] = Field(default_factory=list)
    place_id: str | None = None
    quick_link: str | None = None


class RestaurantResult(BaseModel):
    business: BusinessSummary
    score: float | None = None
    recommendation_score: float | None = None
    average_beli_score: float | None = None
    google_rating: float | None = None
    distance_mi: float | None = None
    within_radius: bool
    mention_count: int | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class FilterOption(BaseModel):
    field_name: str
    value: str
    count: int


class RecommendationQueryResponse(BaseModel):
    source_endpoint: str
    request_summary: dict[str, Any]
    returned_count: int
    exact_radius_count: int
    results: list[RestaurantResult]
    filter_options: list[FilterOption] = Field(default_factory=list)


class SearchPrediction(BaseModel):
    business_id: int | None = None
    place_id: str | None = None
    name: str
    secondary_text: str | None = None
    source_used: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class SearchResponse(BaseModel):
    source_endpoint: str
    term: str
    cuisines: list[dict[str, Any]] = Field(default_factory=list)
    labels: list[dict[str, Any]] = Field(default_factory=list)
    predictions: list[SearchPrediction] = Field(default_factory=list)
    raw: dict[str, Any] = Field(default_factory=dict)


class DietaryRestrictionOption(BaseModel):
    name: str
    raw: dict[str, Any] = Field(default_factory=dict)


class DietaryRestrictionResponse(BaseModel):
    options: list[DietaryRestrictionOption]
