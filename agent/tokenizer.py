"""Tokenizer selection and input token estimation.

Counts come from a tokenizer descriptor: a dict holding a `counter` function plus
metadata saying which backend produced the number, whether it is known to match
the model, and how the count should be labelled. A descriptor is always
available, so callers never have to handle "no tokenizer": the last resort is the
documented character heuristic. Nothing is downloaded at request time.
"""

from config import (
    ENV_TOKENIZER_BACKEND,
    ENV_TOKENIZER_LOCAL_ONLY,
    ENV_TOKENIZER_NAME,
    env_text,
    read_truthy_env,
)

TOKENIZER_BACKENDS = ("auto", "huggingface", "tiktoken", "heuristic")
DEFAULT_TOKENIZER_BACKEND = "auto"
# Never download a tokenizer at request time unless the operator opts in.
DEFAULT_TOKENIZER_LOCAL_ONLY = True
# Used only when tiktoken is requested explicitly and has no encoding for the
# model. A widely used BPE encoding, not proof of compatibility.
DEFAULT_TIKTOKEN_ENCODING = "cl100k_base"

HEURISTIC_CHARS_PER_TOKEN = 4
HEURISTIC_NAME = "character-heuristic"
HEURISTIC_LIMITATION = (
    "About four characters per token: close for English prose, less accurate for "
    "Persian and other languages, code, URLs and long numbers."
)

STATUS_LABELS = {
    "exact": "exact token count",
    "estimated": "tokenizer estimate",
    "heuristic": "heuristic estimate",
}

# Loading a tokenizer is slow, so one descriptor is kept per configuration.
_TOKENIZER_CACHE = {}


def heuristic_text_tokens(text):
    """Estimate tokens without a tokenizer: about four characters per token."""
    if not text:
        return 0
    return max(1, -(-len(text) // HEURISTIC_CHARS_PER_TOKEN))


def read_tokenizer_backend():
    """Return the configured tokenizer backend, or the default."""
    raw = env_text(ENV_TOKENIZER_BACKEND).lower()
    return raw if raw in TOKENIZER_BACKENDS else DEFAULT_TOKENIZER_BACKEND


def read_tokenizer_name():
    """Return the explicitly configured tokenizer id, or None when unset."""
    return env_text(ENV_TOKENIZER_NAME) or None


def model_base_name(model):
    """Drop a provider routing suffix such as ':free' from a model id."""
    return str(model or "").strip().split(":", 1)[0].strip()


def heuristic_descriptor(unavailable_reason):
    """The always-available fallback: a documented character-based estimate."""
    return {
        "counter": heuristic_text_tokens,
        "backend": "heuristic",
        "name": HEURISTIC_NAME,
        "method": "heuristic",
        "compatibility": "unsupported",
        "status": "heuristic",
        "is_exact": False,
        "available": False,
        "limitations": f"{unavailable_reason} {HEURISTIC_LIMITATION}".strip(),
    }


def try_tiktoken_tokenizer(model, requested_name, explicit):
    """Count tokens with tiktoken, labelled honestly, or return None.

    `explicit` is True only when the operator asked for tiktoken by name, which is
    the one case where an encoding that is not known to match the model is used.
    """
    try:
        import tiktoken  # imported late: the app must work without it
    except Exception:
        return None

    encoding = None
    name = requested_name
    exact = False
    limitation = None
    base = model_base_name(model)

    if name:
        try:
            encoding = tiktoken.get_encoding(name)
        except Exception:
            encoding = None
        if encoding is None:
            limitation = (
                f"The configured {ENV_TOKENIZER_NAME} '{name}' is not an encoding "
                "this tiktoken installation knows."
            )
        else:
            if base:
                try:
                    known = tiktoken.encoding_for_model(base)
                    exact = str(getattr(known, "name", "") or "") == str(name)
                except Exception:
                    exact = False
            if not exact:
                limitation = (
                    f"'{name}' was configured explicitly, but this app has not verified "
                    "that it matches the model."
                )
    else:
        if base:
            try:
                encoding = tiktoken.encoding_for_model(base)
                name = str(getattr(encoding, "name", "") or base)
                exact = True
            except Exception:
                encoding = None
        if encoding is None and explicit:
            try:
                encoding = tiktoken.get_encoding(DEFAULT_TIKTOKEN_ENCODING)
                name = DEFAULT_TIKTOKEN_ENCODING
            except Exception:
                encoding = None
        if encoding is not None and not exact:
            limitation = (
                f"tiktoken has no encoding for this model, so the count uses {name} "
                "and is only an estimate."
            )

    if encoding is None:
        return None
    try:
        encoding.encode("probe")
    except Exception:
        return None
    name = str(getattr(encoding, "name", "") or name or "unknown")

    def count(text):
        return len(encoding.encode(text)) if text else 0

    return {
        "counter": count,
        "backend": "tiktoken",
        "name": name,
        "method": f"tiktoken:{name}",
        "compatibility": "compatible" if exact else "unverified",
        "status": "exact" if exact else "estimated",
        "is_exact": exact,
        "available": True,
        "limitations": limitation,
    }


def try_huggingface_tokenizer(requested_name, model, local_only):
    """Load an explicitly configured Hugging Face tokenizer, from local files only.

    `transformers` is not a dependency here; it is used only when it happens to be
    installed and this backend was asked for.
    """
    if not requested_name:
        return None
    try:
        from transformers import AutoTokenizer
    except Exception:
        return None
    try:
        tokenizer = AutoTokenizer.from_pretrained(
            requested_name, local_files_only=bool(local_only)
        )
    except Exception:
        return None

    base = model_base_name(model)
    compatible = bool(base) and base.lower() == str(requested_name).strip().lower()

    def count(text):
        if not text:
            return 0
        return len(tokenizer.encode(text, add_special_tokens=False))

    return {
        "counter": count,
        "backend": "huggingface",
        "name": requested_name,
        "method": f"huggingface:{requested_name}",
        "compatibility": "compatible" if compatible else "unverified",
        "status": "exact" if compatible else "estimated",
        "is_exact": compatible,
        "available": True,
        "limitations": None
        if compatible
        else (
            "An explicitly configured tokenizer; this app has not verified that it "
            "matches the model."
        ),
    }


def load_tokenizer(model):
    """Choose a tokenizer for the model, from cache when possible.

    Priority: a tokenizer known to match the model (tiktoken), then an explicitly
    configured Hugging Face tokenizer already present locally, then tiktoken when
    it was asked for by name, and finally the character heuristic.
    """
    backend = read_tokenizer_backend()
    requested = read_tokenizer_name()
    local_only = read_truthy_env(ENV_TOKENIZER_LOCAL_ONLY, DEFAULT_TOKENIZER_LOCAL_ONLY)

    cache_key = (str(model or ""), backend, requested, bool(local_only))
    if cache_key in _TOKENIZER_CACHE:
        return _TOKENIZER_CACHE[cache_key]

    descriptor = None
    if backend in ("auto", "huggingface"):
        descriptor = try_huggingface_tokenizer(requested, model, local_only)
    if descriptor is None and backend in ("auto", "tiktoken"):
        descriptor = try_tiktoken_tokenizer(model, requested, explicit=backend == "tiktoken")
    if descriptor is None:
        descriptor = heuristic_descriptor(
            "No tokenizer compatible with this model was available in this environment."
        )

    _TOKENIZER_CACHE[cache_key] = descriptor
    return descriptor


def estimation_status_label(status):
    """Turn an estimation status value into a short human label."""
    return STATUS_LABELS.get(status, "unknown")


def tokenizer_label(tokenizer):
    """Turn a tokenizer descriptor into a short human label for the UI."""
    backend = tokenizer.get("backend")
    name = tokenizer.get("name") or "unknown"
    if backend == "tiktoken":
        return f"tiktoken ({name})"
    if backend == "huggingface":
        return f"Hugging Face ({name})"
    return f"Built-in character heuristic ({name})"


def build_tokenizer_metadata(tokenizer):
    """Shape the public (JSON-safe) metadata for a tokenizer descriptor."""
    return {
        "tokenizer_backend": tokenizer.get("backend"),
        "tokenizer_name": tokenizer.get("name"),
        "tokenizer_label": tokenizer_label(tokenizer),
        "tokenizer_compatibility": tokenizer.get("compatibility"),
        "tokenizer_available": bool(tokenizer.get("available")),
        "estimation_status": tokenizer.get("status"),
        "estimation_confidence": estimation_status_label(tokenizer.get("status")),
    }

