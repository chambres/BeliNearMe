from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .client import BeliAPIError, BeliClient
from .config import Settings, get_settings
from .models import DietaryRestrictionResponse, RecommendationQueryRequest, RecommendationQueryResponse, SearchRequest, SearchResponse
from .service import RestaurantDiscoveryService


def _warn_if_refresh_token_expiring(client: BeliClient) -> None:
    """Print a warning at startup if the refresh token is expired or expiring soon."""
    try:
        expiry = client.refresh_token_expiry()
    except BeliAPIError:
        print("WARNING: could not read the refresh token's expiry.")
        return

    hours_left = (expiry - datetime.now(timezone.utc)).total_seconds() / 3600
    if hours_left <= 0:
        print("WARNING: refresh token has EXPIRED. Run: python -m scripts.login")
    elif hours_left <= 24:
        print(f"WARNING: refresh token expires in {hours_left:.1f}h. Run: python -m scripts.login")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    client = BeliClient(settings)
    app.state.settings = settings
    app.state.beli_client = client
    app.state.discovery_service = RestaurantDiscoveryService(client)
    _warn_if_refresh_token_expiring(client)
    try:
        yield
    finally:
        await client.close()


app = FastAPI(
    title="Beli Metadata API",
    version="1.0.0",
    description=(
        "FastAPI wrapper around Beli's recommendation and search endpoints, with exact-radius filtering, "
        "score-ranked nearby discovery, and metadata-first cuisine filtering such as Halal."
    ),
    lifespan=lifespan,
)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


def get_service() -> RestaurantDiscoveryService:
    return app.state.discovery_service  # type: ignore[return-value]


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/config")
async def config() -> dict[str, str | float]:
    settings: Settings = app.state.settings
    return {
        "beli_user_id": settings.beli_user_id,
        "beli_api_base": settings.beli_api_base,
        "request_timeout_seconds": settings.request_timeout_seconds,
    }


@app.post("/v1/search/app", response_model=SearchResponse)
async def search_app(
    request: SearchRequest,
    service: RestaurantDiscoveryService = Depends(get_service),
) -> SearchResponse:
    try:
        return await service.search_app(request)
    except BeliAPIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/v1/search/businesses-full", response_model=SearchResponse)
async def search_businesses_full(
    request: SearchRequest,
    service: RestaurantDiscoveryService = Depends(get_service),
) -> SearchResponse:
    try:
        return await service.search_businesses_full(request)
    except BeliAPIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/v1/recommendations/nearby", response_model=RecommendationQueryResponse)
async def recommendations_nearby(
    request: RecommendationQueryRequest,
    service: RestaurantDiscoveryService = Depends(get_service),
) -> RecommendationQueryResponse:
    try:
        return await service.nearby_recommendations(request)
    except BeliAPIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/v1/recommendations/halal-nearby", response_model=RecommendationQueryResponse)
async def halal_nearby(
    request: RecommendationQueryRequest,
    service: RestaurantDiscoveryService = Depends(get_service),
) -> RecommendationQueryResponse:
    try:
        return await service.nearby_recommendations(request, forced_cuisines=["Halal"])
    except BeliAPIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/v1/metadata/dietary-restrictions", response_model=DietaryRestrictionResponse)
async def dietary_restrictions(
    service: RestaurantDiscoveryService = Depends(get_service),
) -> DietaryRestrictionResponse:
    try:
        return await service.dietary_restrictions()
    except BeliAPIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
