"""Environment loading, provider configuration and the model client.

Secrets live in .env only. They are read here, used for outgoing requests, and
never sent to the browser, written into model messages, logged, or copied into an
error message.
"""

import os
from pathlib import Path

from openai import (
    APIConnectionError,
    APIError,
    APITimeoutError,
    AuthenticationError,
    OpenAI,
    RateLimitError,
)

BASE_DIR = Path(__file__).resolve().parent

ENV_API_KEY = "OPENAI_API_KEY"
ENV_BASE_URL = "BASE_URL"
ENV_MODEL = "MODEL_ID"

REQUEST_TIMEOUT_SECONDS = 30.0

# Context budget. These are this app's settings, not verified provider limits.
ENV_CONTEXT_WINDOW = "CONTEXT_WINDOW_TOKENS"
ENV_MAX_OUTPUT = "MAX_OUTPUT_TOKENS"
ENV_CONTEXT_SAFETY_MARGIN = "CONTEXT_SAFETY_MARGIN_TOKENS"
DEFAULT_CONTEXT_WINDOW_TOKENS = 8192
DEFAULT_MAX_OUTPUT_TOKENS = 1024
DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS = 512

ENV_TOKENIZER_BACKEND = "TOKENIZER_BACKEND"
ENV_TOKENIZER_NAME = "TOKENIZER_NAME"
ENV_TOKENIZER_LOCAL_ONLY = "TOKENIZER_LOCAL_ONLY"


def load_env_file(path=None):
    """Copy KEY=VALUE lines from .env into the environment.

    Existing environment variables win, so a real deployment can override the
    file. Nothing is ever printed: two of these values are secret keys.
    """
    env_path = Path(path) if path is not None else BASE_DIR / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def env_text(name):
    """Return a trimmed environment value, or "" when it is unset."""
    return str(os.environ.get(name, "") or "").strip()


def read_truthy_env(name, default):
    """Read a yes/no setting, falling back to `default`."""
    raw = env_text(name).lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return bool(default)


def read_positive_int_env(name, default):
    """Return (value, source) for a positive whole number setting.

    `source` says whether the number came from the environment or from the
    default, so the UI can be honest about a configured budget.
    """
    raw = env_text(name)
    if raw:
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if value > 0:
            return value, "environment"
    return default, "default"


def get_settings():
    """Read the provider settings from the environment."""
    api_key = env_text(ENV_API_KEY)
    if not api_key:
        raise RuntimeError(f"{ENV_API_KEY} is missing. Add it to your .env file.")
    return {
        "api_key": api_key,
        "base_url": os.environ.get(ENV_BASE_URL),
        "model": os.environ.get(ENV_MODEL),
    }


def create_client(settings):
    """Build the OpenAI-compatible client for one request."""
    return OpenAI(
        api_key=settings["api_key"],
        base_url=settings["base_url"],
        timeout=REQUEST_TIMEOUT_SECONDS,
        max_retries=1,
    )


def friendly_error(error):
    """Turn an SDK exception into a short message that is safe for the browser."""
    if isinstance(error, AuthenticationError):
        return "The API key was rejected. Check OPENAI_API_KEY in your .env file."
    if isinstance(error, RateLimitError):
        return "Too many requests right now. Please wait a moment and try again."
    if isinstance(error, APITimeoutError):
        return "The AI took too long to answer. Please try again."
    if isinstance(error, APIConnectionError):
        return "Could not reach Token Harbor. Check your internet connection."
    if isinstance(error, APIError):
        return "The AI service returned an error. Please try again."
    return "Something went wrong while talking to the AI. Please try again."
