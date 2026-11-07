"""Small environment and OpenAI configuration for the educational app."""

import os
from pathlib import Path

from openai import OpenAI

BASE_DIR = Path(__file__).resolve().parent


def load_env_file(path=None):
    """Load KEY=VALUE pairs from .env without overwriting shell values."""
    env_path = Path(path) if path is not None else BASE_DIR / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def get_settings():
    """Load the provider settings from the environment."""
    load_env_file()
    api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is missing. Add it to your .env file.")
    return {
        "api_key": api_key,
        "base_url": os.environ.get("BASE_URL"),
        "model": os.environ.get("MODEL_ID") or "gpt-4o-mini",
    }


def create_client(settings):
    """Create the OpenAI-compatible client.

    ``max_retries`` is kept at 0 on purpose. The SDK would otherwise retry a
    429 automatically, which sends a second request against the very same
    per-minute / account allowance that is already exhausted. Provider-side
    rate limits and account restrictions are surfaced to the caller instead so
    the app can decide what to do without silently repeating requests.
    """
    return OpenAI(
        api_key=settings["api_key"],
        base_url=settings["base_url"],
        timeout=30.0,
        max_retries=0,
    )
