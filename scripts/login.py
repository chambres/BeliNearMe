"""Refresh the stored Beli refresh token by logging in.

The Beli refresh token has a ~7 day lifetime. Once it expires, the
/token/refresh/ endpoint rejects it and you must log in again to mint a new
pair. This script does that and writes the new BELI_REFRESH_TOKEN back to .env.

Usage:
    python -m scripts.login

Credentials are read from the BELI_EMAIL / BELI_PASSWORD environment variables
if set, otherwise prompted interactively (password input is hidden). Your
password is never written to disk.
"""
from __future__ import annotations

import asyncio
import getpass
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.client import BeliAPIError, login  # noqa: E402
from app.config import DEFAULT_BELI_API_BASE  # noqa: E402

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def _load_env_file() -> None:
    """Populate os.environ from .env for any keys not already set in the shell."""
    if not ENV_PATH.exists():
        return
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def _update_env_refresh_token(refresh: str) -> None:
    lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []
    new_line = f"BELI_REFRESH_TOKEN={refresh}"
    for i, line in enumerate(lines):
        if line.startswith("BELI_REFRESH_TOKEN="):
            lines[i] = new_line
            break
    else:
        lines.append(new_line)
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


async def main() -> int:
    _load_env_file()
    email = os.getenv("BELI_EMAIL") or input("Beli email: ").strip()
    password = os.getenv("BELI_PASSWORD") or getpass.getpass("Beli password: ")
    api_base = os.getenv("BELI_API_BASE", DEFAULT_BELI_API_BASE)

    try:
        tokens = await login(email, password, api_base=api_base)
    except BeliAPIError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    _update_env_refresh_token(tokens["refresh"])
    print("Success. New BELI_REFRESH_TOKEN written to .env.")
    if tokens.get("access"):
        print("(Access token also minted and validated.)")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
