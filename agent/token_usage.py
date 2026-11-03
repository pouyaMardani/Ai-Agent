"""Token usage reported by the provider.

A field the provider leaves out stays None ("not reported"), which is different
from a real 0, and totals are only built from numbers that were actually sent.
The reported input count is also the only source the post-response compaction
decision is allowed to use (see agent/compaction.py).
"""

USAGE_TOKEN_FIELDS = (
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cached_input_tokens",
    "reasoning_tokens",
)


def usage_field(container, name):
    """Read one field from an SDK object or a plain dict, else None."""
    if container is None:
        return None
    if isinstance(container, dict):
        return container.get(name)
    return getattr(container, name, None)


def as_token_count(value):
    """Return value as a non-negative int, or None when it is not a real count."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float) and value.is_integer():
        return int(value) if value >= 0 else None
    return None


def usage_token_count(container, *names):
    """Return the first usable token count among the given field names.

    OpenAI-compatible providers do not agree on the spelling of the usage block:
    most send `prompt_tokens` / `completion_tokens`, others send `input_tokens` /
    `output_tokens`. Reading both keeps the number the same whichever spelling
    arrives. A field that is present but unusable is skipped, so a malformed first
    spelling cannot hide a valid second one.
    """
    for name in names:
        value = as_token_count(usage_field(container, name))
        if value is not None:
            return value
    return None


def extract_call_usage(response):
    """Read the usage block of one completion in our own field names.

    Returns None when the response carried no usage block at all, so a missing
    block is never confused with a block of zeros. Cached input tokens are kept in
    their own field and never folded into the input count: the provider's input
    count already includes whatever it served from its cache.
    """
    usage = usage_field(response, "usage")
    if usage is None:
        return None

    prompt_details = usage_field(usage, "prompt_tokens_details")
    if prompt_details is None:
        prompt_details = usage_field(usage, "input_tokens_details")
    completion_details = usage_field(usage, "completion_tokens_details")
    return {
        "input_tokens": usage_token_count(usage, "prompt_tokens", "input_tokens"),
        "output_tokens": usage_token_count(usage, "completion_tokens", "output_tokens"),
        "total_tokens": usage_token_count(usage, "total_tokens"),
        "cached_input_tokens": usage_token_count(prompt_details, "cached_tokens"),
        "reasoning_tokens": usage_token_count(completion_details, "reasoning_tokens"),
    }


def sum_token_field(calls, field):
    """Add one token field across the calls that reported it, else None."""
    present = [call[field] for call in calls if call.get(field) is not None]
    return sum(present) if present else None


def summarize_usage(call_usage, tool_calls=0):
    """Aggregate the usage of every model call behind one assistant answer.

    `call_usage` holds one entry per successful model call: the dict from
    extract_call_usage(), or None when that call reported nothing. Cached and
    reasoning numbers are optional extras that never make an answer incomplete.
    """
    calls = []
    for index, raw in enumerate(call_usage, start=1):
        record = {"call_index": index, "reported": raw is not None}
        for field in USAGE_TOKEN_FIELDS:
            record[field] = raw.get(field) if raw else None
        calls.append(record)

    model_calls = len(calls)
    reported_calls = [call for call in calls if call["reported"]]
    totals = {field: sum_token_field(reported_calls, field) for field in USAGE_TOKEN_FIELDS}

    all_reported = bool(reported_calls) and len(reported_calls) == model_calls

    # Prefer the provider's own total. Only when every call reported both parts
    # is input + output used instead, and the result says it was derived.
    derived_total = False
    if totals["total_tokens"] is None and all_reported:
        if all(
            call["input_tokens"] is not None and call["output_tokens"] is not None
            for call in reported_calls
        ):
            totals["total_tokens"] = totals["input_tokens"] + totals["output_tokens"]
            derived_total = True

    complete = all_reported and all(
        call["input_tokens"] is not None
        and call["output_tokens"] is not None
        and call["total_tokens"] is not None
        for call in reported_calls
    )

    return {
        "available": bool(reported_calls),
        "complete": complete,
        "derived_total": derived_total,
        "model_calls": model_calls,
        "tool_calls": tool_calls,
        "totals": totals,
        "calls": calls,
        "unavailable": [field for field in USAGE_TOKEN_FIELDS if totals[field] is None],
    }
