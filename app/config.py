from __future__ import annotations

import os
from dataclasses import dataclass


DEFAULT_BELI_API_BASE = "https://backoffice-service-split-t57o3dxfca-nn.a.run.app/api"


@dataclass(frozen=True)
class Settings:
    beli_user_id: str
    beli_refresh_token: str
    beli_api_base: str = DEFAULT_BELI_API_BASE
    request_timeout_seconds: float = 30.0


def get_settings() -> Settings:
    user_id = os.getenv("BELI_USER_ID", "").strip()
    refresh_token = os.getenv("BELI_REFRESH_TOKEN", "").strip()
    api_base = os.getenv("BELI_API_BASE", DEFAULT_BELI_API_BASE).rstrip("/")
    timeout_text = os.getenv("BELI_REQUEST_TIMEOUT_SECONDS", "30").strip()

    if not user_id:
        raise RuntimeError("BELI_USER_ID is required.")
    if not refresh_token:
        raise RuntimeError("BELI_REFRESH_TOKEN is required.")

    try:
        timeout_seconds = float(timeout_text)
    except ValueError as exc:
        raise RuntimeError("BELI_REQUEST_TIMEOUT_SECONDS must be numeric.") from exc

    return Settings(
        beli_user_id=user_id,
        beli_refresh_token=refresh_token,
        beli_api_base=api_base,
        request_timeout_seconds=timeout_seconds,
    )
