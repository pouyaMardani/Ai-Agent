"""Tokenizer selection and input token estimation.

Counts come from a tokenizer descriptor: a dict holding a `counter` function plus
metadata saying which backend produced the number, whether it is known to match
the model, and how the count should be labelled. A descriptor is always
available, so callers never have to handle "no tokenizer": the last resort is the
documented character heuristic. Nothing is downloaded at request time.

The tokenizer this app verifies against is the official DeepSeek V4.1 tokenizer
shipped with the configured model (`deepseek-v4.1-flash`): the `tokenizer.json`
and `tokenizer_config.json` of Hugging Face `deepseek-ai/DeepSeek-V4.1-Flash`,
which are byte-identical to the same files in
`deepseek-ai/DeepSeek-V4.1-Flash-1017`. It is loaded from a local directory, and
the files are hash-checked before a count is allowed to call itself exact. See
docs/CONTEXT_BUDGET.md for the one-time setup.
"""

import hashlib
from pathlib import Path

from config import (
    BASE_DIR,
    ENV_TOKENIZER_BACKEND,
    ENV_TOKENIZER_LOCAL_ONLY,
    ENV_TOKENIZER_MODEL_PATH,
    ENV_TOKENIZER_NAME,
    env_text,
    read_truthy_env,
)

TOKENIZER_BACKENDS = ("auto", "huggingface", "tiktoken", "heuristic")
DEFAULT_TOKENIZER_BACKEND = "auto"
# Never download a tokenizer at request time unless the operator opts in.
DEFAULT_TOKENIZER_LOCAL_ONLY = True
# Where the verified DeepSeek V4.1 tokenizer files are expected, relative to app.py.
DEFAULT_TOKENIZER_MODEL_PATH = "tokenizers/deepseek-v4.1"

# The verified tokenizer: the official repository the files come from, the
# repositories that ship the same files, and the model ids this app has verified
# them against. A provider routing suffix such as ':free' is stripped first.
DEEPSEEK_V41_TOKENIZER_ID = "deepseek-ai/DeepSeek-V4.1-Flash"
DEEPSEEK_V41_TOKENIZER_SOURCES = (
    "deepseek-ai/DeepSeek-V4.1-Flash",
    "deepseek-ai/DeepSeek-V4.1-Flash-1017",
)
DEEPSEEK_V41_MODEL_IDS = ("deepseek-v4.1-flash", "deepseek-v4.1-flash-1017")
# Git blob id and size of each required file, as published by those repositories.
# Checked before the count may call itself exact, so a differently tokenized copy
# in the same directory cannot be mistaken for the official one.
DEEPSEEK_V41_TOKENIZER_FILES = {
    "tokenizer.json": (6367257, "6a15814dd25c934028034531da744c689f87ff21"),
    "tokenizer_config.json": (801, "f3dad388a2bbfd6a8605bd02754acd86d9ca5112"),
}

# Used only when tiktoken is requested explicitly and has no encoding for the
# model. A widely used BPE encoding, not proof of compatibility.
DEFAULT_TIKTOKEN_ENCODING = "cl100k_base"
TIKTOKEN_NOT_DEEPSEEK = (
    "tiktoken is not DeepSeek's tokenizer, so these are approximate token counts "
    "for the model, not the model's own counts."
)

HEURISTIC_CHARS_PER_TOKEN = 4
HEURISTIC_NAME = "character-heuristic"
HEURISTIC_LIMITATION = (
    "About four characters per token: close for English prose, less accurate for "
    "Persian and other languages, code, URLs and long numbers. These are "
    "approximate token counts, not DeepSeek token counts."
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


# A prepared request is re-estimated every time the budget trimming drops a message,
# and the system prompt and tool schemas are identical each time, so each distinct
# text is encoded once per process. The cache is dropped when it grows past the
# limit, which keeps a long conversation from holding onto old message text forever.
_TEXT_COUNT_CACHE_LIMIT = 2048


def memoized_counter(encode):
    """Wrap an encode function so each distinct text is counted once per process."""
    cache = {}

    def count(text):
        if not text:
            return 0
        if text not in cache:
            if len(cache) >= _TEXT_COUNT_CACHE_LIMIT:
                cache.clear()
            cache[text] = encode(text)
        return cache[text]

    return count


def read_tokenizer_backend():
    """Return the configured tokenizer backend, or the default."""
    raw = env_text(ENV_TOKENIZER_BACKEND).lower()
    return raw if raw in TOKENIZER_BACKENDS else DEFAULT_TOKENIZER_BACKEND


def read_tokenizer_name():
    """Return the explicitly configured tokenizer id, or None when unset."""
    return env_text(ENV_TOKENIZER_NAME) or None


def read_tokenizer_model_path():
    """Return the configured local tokenizer directory.

    A relative value is resolved against the directory that holds app.py, so no
    machine-specific path has to be stored in .env.
    """
    raw = env_text(ENV_TOKENIZER_MODEL_PATH)
    path = Path(raw) if raw else Path(DEFAULT_TOKENIZER_MODEL_PATH)
    return path if path.is_absolute() else Path(BASE_DIR) / path


def model_base_name(model):
    """Drop a provider routing suffix such as ':free' from a model id."""
    return str(model or "").strip().split(":", 1)[0].strip()


def is_deepseek_v41_model(model):
    """True when the model is one this app has verified the DeepSeek tokenizer against."""
    return model_base_name(model).lower() in DEEPSEEK_V41_MODEL_IDS


def missing_tokenizer_files(directory):
    """Names of the required tokenizer files that are not present in `directory`."""
    return [name for name in DEEPSEEK_V41_TOKENIZER_FILES if not (directory / name).is_file()]


def git_blob_oid(path):
    """Return (size, hex sha1) of a file, hashed the way git hashes a blob."""
    digest = hashlib.sha1()
    size = path.stat().st_size
    digest.update(f"blob {size}\0".encode("ascii"))
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return size, digest.hexdigest()


def verified_tokenizer_files(directory):
    """True when every file in `directory` is the official DeepSeek V4.1 tokenizer file."""
    try:
        for name, expected in DEEPSEEK_V41_TOKENIZER_FILES.items():
            if git_blob_oid(directory / name) != expected:
                return False
    except OSError:
        return False
    return True


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

    if is_deepseek_v41_model(model):
        # No tiktoken encoding is DeepSeek's tokenizer, so a tiktoken count for this
        # app's model is always an approximation, whatever encoding it uses.
        exact = False
        limitation = f"{TIKTOKEN_NOT_DEEPSEEK} {limitation or ''}".strip()
    elif not exact and limitation is None:
        limitation = (
            f"tiktoken has no encoding for this model, so the count uses {name} and is "
            "only an estimate."
        )

    return {
        "counter": memoized_counter(lambda text: len(encoding.encode(text))),
        "backend": "tiktoken",
        "name": name,
        "method": f"tiktoken:{name}",
        "compatibility": "compatible" if exact else "unverified",
        "status": "exact" if exact else "estimated",
        "is_exact": exact,
        "available": True,
        "limitations": limitation,
    }


def load_huggingface_tokenizer(source, local_only):
    """Load one source: a local tokenizer directory, or a Hugging Face tokenizer id.

    `transformers` is tried first because this project already integrates with it;
    the smaller `tokenizers` package reads the same `tokenizer.json` when that is
    what is installed. Both are optional, so raising here is expected and the
    caller turns the error into a readable reason.
    """
    path = Path(source)
    if path.is_dir():
        try:
            from transformers import AutoTokenizer
        except Exception:
            from tokenizers import Tokenizer

            return Tokenizer.from_file(str(path / "tokenizer.json"))
        return AutoTokenizer.from_pretrained(str(path), local_files_only=True)

    from transformers import AutoTokenizer

    return AutoTokenizer.from_pretrained(str(source), local_files_only=bool(local_only))


def huggingface_descriptor(tokenizer, name, verified, model):
    """Describe a loaded Hugging Face tokenizer, saying how far it can be trusted."""

    compatible = bool(verified) and is_deepseek_v41_model(model)
    if compatible:
        limitation = None
    elif verified:
        limitation = (
            "The official DeepSeek V4.1 tokenizer files are loaded, but this app has not "
            f"verified them against the model '{model_base_name(model) or 'unknown'}', so "
            "the count is an estimate for it."
        )
    else:
        limitation = (
            "A configured tokenizer is loaded, but this app has not verified that it is "
            "the official DeepSeek V4.1 tokenizer or that it matches the model."
        )

    return {
        "counter": memoized_counter(
            lambda text: len(tokenizer.encode(text, add_special_tokens=False))
        ),
        "backend": "huggingface",
        "name": name,
        "method": f"huggingface:{name}",
        "compatibility": "compatible" if compatible else "unverified",
        "status": "exact" if compatible else "estimated",
        "is_exact": compatible,
        "available": True,
        "limitations": limitation,
    }


def try_huggingface_tokenizer(model, requested_name, model_path, local_only):
    """Load the DeepSeek V4.1 tokenizer, or a configured one, from local files.

    Returns (descriptor, reason): exactly one of the two is set. The directory named
    by TOKENIZER_MODEL_PATH is the first candidate, an id or path in TOKENIZER_NAME
    the second. Nothing is downloaded unless TOKENIZER_LOCAL_ONLY is false, and a
    failure is reported in words instead of another tokenizer being substituted for
    the one that was asked for.
    """
    directory = Path(model_path)
    candidates = []
    reason = None

    if not directory.is_dir():
        reason = (
            f"No tokenizer directory was found at '{directory}'. Run the one-time setup "
            "described in docs/CONTEXT_BUDGET.md."
        )
    elif missing_tokenizer_files(directory):
        reason = (
            f"The tokenizer directory '{directory}' is missing "
            f"{', '.join(missing_tokenizer_files(directory))}."
        )
    else:
        candidates.append((str(directory), directory))

    if requested_name:
        candidates.append((str(requested_name), None))

    verified_names = {value.lower() for value in DEEPSEEK_V41_TOKENIZER_SOURCES}
    for label, path in candidates:
        try:
            tokenizer = load_huggingface_tokenizer(label, local_only)
        except Exception as error:
            reason = (
                f"Loading the tokenizer from '{label}' failed "
                f"({error.__class__.__name__}: {str(error).strip()[:200]})."
            )
            continue
        if path is None:
            verified = label.strip().lower() in verified_names
            name = label
        else:
            verified = verified_tokenizer_files(path)
            name = DEEPSEEK_V41_TOKENIZER_ID if verified else path.name
        return huggingface_descriptor(tokenizer, name, verified, model), None

    return None, reason


def load_tokenizer(model):
    """Choose a tokenizer for the model, from cache when possible.

    `auto` prefers the verified DeepSeek V4.1 tokenizer in TOKENIZER_MODEL_PATH, then
    tiktoken when this installation knows the model, then the labelled character
    heuristic. An explicitly selected backend follows its own documented policy and
    never passes a different tokenizer off as the one that was asked for.
    """
    backend = read_tokenizer_backend()
    requested = read_tokenizer_name()
    model_path = read_tokenizer_model_path()
    local_only = read_truthy_env(ENV_TOKENIZER_LOCAL_ONLY, DEFAULT_TOKENIZER_LOCAL_ONLY)

    cache_key = (str(model or ""), backend, requested, str(model_path), bool(local_only))
    if cache_key in _TOKENIZER_CACHE:
        return _TOKENIZER_CACHE[cache_key]

    reasons = []
    descriptor = None

    if backend in ("auto", "huggingface"):
        descriptor, reason = try_huggingface_tokenizer(model, requested, model_path, local_only)
        if descriptor is None:
            reasons.append(reason)

    if descriptor is None and backend in ("auto", "tiktoken"):
        descriptor = try_tiktoken_tokenizer(model, requested, explicit=backend == "tiktoken")
        if descriptor is None:
            reasons.append("tiktoken has no usable encoding for this model.")

    if descriptor is None:
        explicit = backend in ("huggingface", "tiktoken")
        if explicit:
            # The operator asked for this backend, so the substitution is stated
            # plainly rather than left to be inferred from the numbers.
            reasons.insert(
                0,
                f"{ENV_TOKENIZER_BACKEND}={backend} was requested, but that tokenizer "
                "could not be loaded, so the character heuristic is used instead: its "
                "counts are approximate and are not DeepSeek token counts.",
            )
        descriptor = heuristic_descriptor(" ".join(reasons))
        if explicit:
            print(f"[tokenizer] {backend} unavailable: {' '.join(reasons[1:])}", flush=True)

    print(
        f"[tokenizer] backend={descriptor['backend']} name={descriptor['name']} "
        f"compatibility={descriptor['compatibility']}",
        flush=True,
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

