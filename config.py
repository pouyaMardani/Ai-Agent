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

# Summary-based conversation compaction. The threshold is an ABSOLUTE provider
# ACTUAL input token count: a completed response whose reported input reaches it is
# compacted. It is not an estimate, and this app never measures a request against
# it before sending. 4659 is the previously derived trigger kept as the default
# (70% of 8192 - 1024 - 512), now expressed directly in actual tokens.
ENV_COMPACTION_ENABLED = "COMPACTION_ENABLED"
ENV_ACTUAL_INPUT_TOKEN_THRESHOLD = "ACTUAL_INPUT_TOKEN_THRESHOLD"
ENV_COMPACTION_TARGET_RATIO = "COMPACTION_TARGET_RATIO"
DEFAULT_COMPACTION_ENABLED = True
DEFAULT_ACTUAL_INPUT_TOKEN_THRESHOLD = 4659
# Share of the saved history kept verbatim when the threshold is exceeded.
DEFAULT_COMPACTION_TARGET_RATIO = 0.50

# Context management inside a turn: tool-result management and deterministic
# priority scoring. `TOOL_RESULT_LARGE_BYTES` is the UTF-8 byte size at or above
# which one tool result counts as large enough to manage - a byte measurement, not
# a token estimate.
ENV_CONTEXT_PRIORITY_ENABLED = "CONTEXT_PRIORITY_ENABLED"
ENV_TOOL_RESULT_MANAGEMENT_ENABLED = "TOOL_RESULT_MANAGEMENT_ENABLED"
ENV_TOOL_RESULT_LARGE_BYTES = "TOOL_RESULT_LARGE_BYTES"
ENV_TOOL_RESULT_STORE_MAX_BYTES = "TOOL_RESULT_STORE_MAX_BYTES"
DEFAULT_CONTEXT_PRIORITY_ENABLED = True
DEFAULT_TOOL_RESULT_MANAGEMENT_ENABLED = True
DEFAULT_TOOL_RESULT_LARGE_BYTES = 4096
DEFAULT_TOOL_RESULT_STORE_MAX_BYTES = 5242880


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


def read_ratio_env(name, default):
    """Return (ratio, source) for a setting between 0 and 1.

    Anything that is not a real fraction is ignored in favour of `default`, so a
    typo cannot turn a ratio into something that disables or loops a feature.
    """
    raw = env_text(name)
    if raw:
        try:
            value = float(raw)
        except ValueError:
            value = 0.0
        if 0.0 < value < 1.0:
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
