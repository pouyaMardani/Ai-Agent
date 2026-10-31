"""Context estimation and the context budget.

Every model call is estimated before it is sent and measured against a configured
budget: the system prompt, the newest user message and this turn's tool messages
are never dropped, while the oldest saved history is trimmed, and a request that
still cannot fit is refused with a readable reason instead of being sent.
"""

import json

from agent.tokenizer import build_tokenizer_metadata, load_tokenizer
from config import (
    DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
    DEFAULT_MAX_OUTPUT_TOKENS,
    ENV_CONTEXT_SAFETY_MARGIN,
    ENV_CONTEXT_WINDOW,
    ENV_MAX_OUTPUT,
    read_positive_int_env,
)

# Small documented approximations: a message costs a few tokens for its role and
# delimiters, a tool schema a few tokens for its name and wrapper. They are
# recorded as estimates, never as measurements.
MESSAGE_OVERHEAD_TOKENS = 4
TOOL_OVERHEAD_TOKENS = 8

# The rows of the token estimation breakdown, in the order the analytics panel and
# the copied report show them, each with how it was obtained:
#   "tokenizer" - text this app counted with the active tokenizer, exactly once
#   "estimated" - a documented rule (the constants above), not a measurement
#   "unknown"   - part of the request this app cannot see (provider formatting)
BREAKDOWN_COMPONENTS = (
    ("system_content", "tokenizer"),
    ("user_content", "tokenizer"),
    ("assistant_content", "tokenizer"),
    ("tool_content", "tokenizer"),
    ("other_message_content", "tokenizer"),
    ("structured_content", "tokenizer"),
    ("tool_call_arguments", "tokenizer"),
    ("tool_call_ids", "tokenizer"),
    ("role_labels", "tokenizer"),
    ("tool_definitions", "tokenizer"),
    ("message_overhead", "estimated"),
    ("tool_definition_overhead", "estimated"),
    ("provider_serialization", "unknown"),
)

# Which content component a message's content belongs to, by role.
ROLE_CONTENT_COMPONENTS = {
    "system": "system_content",
    "developer": "system_content",
    "user": "user_content",
    "assistant": "assistant_content",
    "tool": "tool_content",
}

# Where the visual states of the budget bar start.
BUDGET_APPROACHING_PERCENT = 70
BUDGET_OVER_PERCENT = 100


class ContextBudgetExceeded(Exception):
    """Raised when a request cannot be sent inside the configured context budget.

    It carries the structured context summary, so the route can answer with a
    readable message and the UI can still show the rejected call.
    """

    def __init__(self, message, context):
        super().__init__(message)
        self.message = message
        self.context = context


def message_component_texts(message):
    """Return the text parts of one prepared message, keyed by breakdown component.

    Every part is returned once, so the caller can count each of them exactly
    once, and an empty part is left out rather than counted as zero tokens.
    """
    parts = {}

    role = str(message.get("role") or "")
    if role:
        parts["role_labels"] = role

    content = message.get("content")
    if isinstance(content, str):
        if content:
            parts[ROLE_CONTENT_COMPONENTS.get(role, "other_message_content")] = content
    elif content is not None:
        # Structured content (for example a list of content parts) is sent as JSON;
        # how a provider counts images inside it is not something this app knows.
        parts["structured_content"] = json.dumps(content, ensure_ascii=False, sort_keys=True)

    tool_calls = message.get("tool_calls")
    if tool_calls:
        parts["tool_call_arguments"] = json.dumps(tool_calls, ensure_ascii=False, sort_keys=True)

    # A tool result names the call it answers, and that id travels in the request
    # too; without it the provider could not match the pair.
    tool_call_id = message.get("tool_call_id")
    if isinstance(tool_call_id, str) and tool_call_id:
        parts["tool_call_ids"] = tool_call_id

    return parts


def message_text_for_estimate(message):
    """Build the text one prepared message contributes to a model request.

    The role, the content, any tool-call arguments and the tool-call id in one
    string: all of them are part of what the provider receives. The estimator
    counts the parts separately, so a breakdown can name each of them.
    """
    return "\n".join(message_component_texts(message).values())


def build_token_breakdown(measured, overhead, schema_count):
    """Shape the measured parts and the documented overhead into breakdown rows.

    A row carries a token count and how it was obtained. A row that cannot be
    measured here carries no number at all instead of a guess, and the rows always
    add up to the estimate the budget used, so the table can never disagree with
    the total it is meant to explain.
    """
    rows = []
    for key, measurement in BREAKDOWN_COMPONENTS:
        if measurement == "unknown":
            rows.append({"key": key, "tokens": None, "measurement": measurement})
            continue
        source = overhead if measurement == "estimated" else measured
        rows.append({"key": key, "tokens": int(source.get(key, 0)), "measurement": measurement})

    return {
        "rows": rows,
        "estimated_overhead_tokens": sum(
            row["tokens"] for row in rows if row["measurement"] == "estimated"
        ),
        "tool_schema_count": int(schema_count),
    }


def estimate_context(messages, tool_schemas=None, history_count=0, model=None):
    """Estimate the input size of one prepared model request.

    `messages` is the exact list about to be sent, and `history_count` says how
    many of those came from the saved conversation, so the breakdown can separate
    the saved conversation from this turn. Every part of a message is counted on
    its own and exactly once, which keeps the text-only count (`text_token_count`)
    and the request-level estimate (`estimated_input_tokens`) distinguishable. A
    component that is not part of the request is reported as None ("not present"),
    never as zero tokens.
    """
    tokenizer = load_tokenizer(model)
    counter = tokenizer["counter"]

    first = messages[0] if messages else None
    has_system = isinstance(first, dict) and str(first.get("role") or "") in ("system", "developer")
    boundary = (1 if has_system else 0) + max(0, int(history_count or 0))

    total = 0
    system_tokens = 0
    history_tokens = 0
    other_tokens = 0
    latest_user_tokens = 0
    counted = 0
    # Text that the active tokenizer counted, and the documented structural
    # estimates kept apart from it, both keyed by breakdown component.
    measured = {}
    overhead = {"message_overhead": 0}

    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            continue
        tokens = MESSAGE_OVERHEAD_TOKENS
        overhead["message_overhead"] += MESSAGE_OVERHEAD_TOKENS

        for key, text in message_component_texts(message).items():
            part = counter(text)
            measured[key] = measured.get(key, 0) + part
            tokens += part

        counted += 1
        total += tokens

        role = str(message.get("role") or "")
        if role in ("system", "developer"):
            system_tokens += tokens
        elif index < boundary:
            history_tokens += tokens
        else:
            other_tokens += tokens

        # The first user message after the saved conversation is this turn's new
        # message. The tool loop's own reminder also has the user role, but it
        # comes later and is deliberately not the one counted here.
        if latest_user_tokens == 0 and role == "user" and index >= boundary:
            latest_user_tokens = tokens

    schemas = list(tool_schemas or [])
    schema_tokens = 0
    for schema in schemas:
        schema_tokens += counter(json.dumps(schema, ensure_ascii=False, sort_keys=True))
    measured["tool_definitions"] = measured.get("tool_definitions", 0) + schema_tokens
    overhead["tool_definition_overhead"] = TOOL_OVERHEAD_TOKENS * len(schemas)
    tool_tokens = schema_tokens + overhead["tool_definition_overhead"]
    total += tool_tokens

    notes = []
    if tokenizer["limitations"]:
        notes.append(tokenizer["limitations"])
    if tool_tokens > 0:
        notes.append(
            "Tool definitions are counted from the JSON schemas sent with this request, "
            "plus a small estimated wrapper."
        )
    notes.append("This covers the input only, and the provider's own count can differ.")
    if tokenizer["is_exact"]:
        notes.append(
            "Text is counted with this model's own tokenizer; the per-message and "
            "per-tool overhead added on top of it is an approximation, so this describes "
            "the request rather than the provider's measurement of it."
        )
    else:
        notes.append(
            "The count is not exact, so any budget decision derived from it is an "
            "approximation rather than a measurement."
        )

    return {
        "estimated_input_tokens": total,
        # What the active tokenizer counted in the request text, kept next to the
        # request-level total above: the two are different numbers, and neither
        # stands in for the provider's own count.
        "text_token_count": sum(measured.values()),
        "breakdown": build_token_breakdown(measured, overhead, len(schemas)),
        "estimation_method": tokenizer["method"],
        "is_exact": bool(tokenizer["is_exact"]),
        "system_prompt_tokens": system_tokens or None,
        "history_tokens": history_tokens or None,
        "tool_definitions_tokens": tool_tokens or None,
        "other_input_tokens": other_tokens or None,
        # The newest user message is part of other_input_tokens, but it is broken
        # out separately because it is what the person just typed.
        "latest_user_message_tokens": latest_user_tokens or None,
        "message_count": counted,
        "tool_definition_count": len(schemas),
        "estimation_notes": " ".join(notes) or None,
        **build_tokenizer_metadata(tokenizer),
    }


def estimate_totals(records):
    """Add up the per-request estimates of one turn, each request counted once.

    A request the budget refused is not a model call, so it is left out rather
    than counted as input the provider never saw. Every request that was sent
    contributes its own numbers exactly once, which is what keeps a turn total
    from counting a breakdown twice.
    """
    estimates = [
        record["estimate"]
        for record in records
        if not record.get("rejected") and isinstance(record.get("estimate"), dict)
    ]
    if not estimates:
        return None

    def total(key):
        numbers = [
            estimate.get(key)
            for estimate in estimates
            if isinstance(estimate.get(key), int) and not isinstance(estimate.get(key), bool)
        ]
        return sum(numbers) if numbers else None

    overheads = [
        (estimate.get("breakdown") or {}).get("estimated_overhead_tokens")
        for estimate in estimates
    ]
    overheads = [value for value in overheads if isinstance(value, int) and not isinstance(value, bool)]

    return {
        "requests": len(estimates),
        "estimated_input_tokens": total("estimated_input_tokens"),
        # The tokenizer's own text counts, added up the same way: no overhead and
        # no provider measurement is mixed into this number.
        "text_token_count": total("text_token_count"),
        "estimated_overhead_tokens": sum(overheads) if overheads else None,
    }


def context_budget_settings():
    """Read the context budget that every model request will be sent with:

        max_input_budget_tokens = context_window_tokens
                                  - max_output_tokens
                                  - context_safety_margin_tokens

    The context window here is a configured budget, not a provider fact: it is
    whatever .env says, or a documented conservative default. Reserving the output
    allowance and the safety margin before each request is what keeps a long
    conversation from squeezing the answer out of the window.
    """
    window, window_source = read_positive_int_env(ENV_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW_TOKENS)
    max_output, output_source = read_positive_int_env(ENV_MAX_OUTPUT, DEFAULT_MAX_OUTPUT_TOKENS)
    margin, margin_source = read_positive_int_env(
        ENV_CONTEXT_SAFETY_MARGIN, DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS
    )
    # This app never fetches model metadata, so a window here is always a configured
    # value; "verified" is reserved for a future metadata source.
    window_origin = "configured" if window > 0 else "unknown"

    max_input = window - max_output - margin
    problem = None
    if max_input <= 0:
        problem = (
            "The output allowance and the safety margin use up the whole context window, so no "
            f"input can be sent at all. Lower {ENV_MAX_OUTPUT} or "
            f"{ENV_CONTEXT_SAFETY_MARGIN}, or raise {ENV_CONTEXT_WINDOW}."
        )
        max_input = 0

    if window_source == "environment":
        window_note = (
            f"Read from {ENV_CONTEXT_WINDOW} in .env. The provider's real context limit is not "
            "visible to this app, so treat this as a budget rather than a verified limit."
        )
    else:
        window_note = (
            f"Configured default of {DEFAULT_CONTEXT_WINDOW_TOKENS} tokens - a conservative "
            f"budget for this project, not a verified provider limit. Set {ENV_CONTEXT_WINDOW} "
            "in .env to match your model."
        )

    return {
        "context_window_tokens": window,
        "context_window_source": window_source,
        "context_window_origin": window_origin,
        "context_window_note": window_note,
        "max_output_tokens": max_output,
        "max_output_source": output_source,
        "context_safety_margin_tokens": margin,
        "context_safety_margin_source": margin_source,
        "max_input_budget_tokens": max_input,
        "configuration_problem": problem,
    }


def context_budget_for_call(estimate, budget=None):
    """Compare one prepared request with the active budget.

    `remaining_input_budget_tokens` is clamped at zero, because "negative room
    left" is not a usable number for a reader; the overage is kept separately as
    `over_budget_tokens` next to the `over_budget` flag. `budget_state` is the
    internal tone and `budget_status` the same judgement in the vocabulary the UI
    shows, and `budget_caveat` records that the decision rests on an approximate
    count whenever the estimate is not exact.
    """
    budget = budget or context_budget_settings()
    max_input = int(budget.get("max_input_budget_tokens") or 0)
    estimated = int(estimate.get("estimated_input_tokens") or 0)

    raw_remaining = max_input - estimated
    utilization = round(estimated * 100 / max_input, 1) if max_input > 0 else None

    if raw_remaining < 0 or (utilization is not None and utilization >= BUDGET_OVER_PERCENT):
        state = "over"
    elif utilization is not None and utilization >= BUDGET_APPROACHING_PERCENT:
        state = "approaching"
    else:
        state = "comfortable"

    if utilization is None:
        status = "unknown"
    elif state == "over":
        status = "over"
    elif state == "approaching":
        status = "approaching"
    else:
        status = "within"

    confidence = str(estimate.get("estimation_confidence") or "unknown")
    caveat = None
    if confidence != "exact token count":
        caveat = (
            "This budget decision is based on an approximate input count, so the "
            "provider may measure the request differently."
        )

    return {
        **budget,
        "estimated_input_tokens": estimated,
        "remaining_input_budget_tokens": max(0, raw_remaining),
        "over_budget_tokens": max(0, -raw_remaining),
        "over_budget": raw_remaining < 0,
        "budget_utilization_percent": utilization,
        "budget_state": state,
        "budget_status": status,
        "budget_caveat": caveat,
        "estimation_confidence": confidence,
        "accepted": raw_remaining >= 0,
    }


def enforce_context_budget(messages, history_count=0, tool_schemas=None, model=None, budget=None):
    """Prepare one model request so it fits the budget, or explain why it cannot.

    The system prompt, the newest user message and this turn's tool messages are
    never dropped: they are what the user asked for and what the tools returned.
    Only the oldest saved-conversation messages are removed, one at a time from the
    front, which keeps the newest context and cannot break a tool-call /
    tool-result pair, because those pairs are created inside the tool loop and
    always sit after the conversation block.
    """
    budget = budget or context_budget_settings()
    ordered = list(messages)

    first = ordered[0] if ordered else None
    has_system = isinstance(first, dict) and str(first.get("role") or "") in ("system", "developer")

    system_block = ordered[:1] if has_system else []
    rest = ordered[1:] if has_system else ordered
    history_block = rest[: max(0, int(history_count or 0))]
    turn_block = rest[len(history_block) :]

    keep = len(history_block)
    dropped = 0
    attempt = ordered
    estimate = estimate_context(attempt, tool_schemas, keep, model)
    verdict = context_budget_for_call(estimate, budget)

    while not verdict["accepted"] and keep > 0:
        # Drop the oldest saved message, then measure the whole request again.
        keep -= 1
        dropped += 1
        attempt = system_block + history_block[len(history_block) - keep :] + turn_block
        estimate = estimate_context(attempt, tool_schemas, keep, model)
        verdict = context_budget_for_call(estimate, budget)

    reduction_note = None
    if dropped:
        plural = "message" if dropped == 1 else "messages"
        reduction_note = (
            f"{dropped} of the oldest saved conversation {plural} were left out of this request to "
            "stay inside the context budget. The system prompt, your newest message and the tool "
            "results for this turn were kept."
        )

    reason = None
    if not verdict["accepted"]:
        window = verdict["context_window_tokens"]
        reserve = verdict["max_output_tokens"] + verdict["context_safety_margin_tokens"]
        reason = (
            f"This request is too large for the configured context budget: the estimated input is "
            f"{estimate['estimated_input_tokens']} tokens and only "
            f"{verdict['max_input_budget_tokens']} tokens of input are allowed (context window "
            f"{window} - output allowance {verdict['max_output_tokens']} - safety margin "
            f"{verdict['context_safety_margin_tokens']} = {window - reserve}). Nothing was sent to "
            "the model. Try a shorter message or start a new chat, or raise "
            f"{ENV_CONTEXT_WINDOW} in your .env file."
        )

    return {
        "messages": attempt,
        "history_count": keep,
        "dropped_messages": dropped,
        "reduced": dropped > 0,
        "reduction_note": reduction_note,
        "estimate": estimate,
        "budget": verdict,
        "accepted": bool(verdict["accepted"]),
        "reason": reason,
    }


def context_call_record(call_index, prepared):
    """Describe one model call: the estimate before it, its budget, the decision."""
    return {
        "call_index": int(call_index),
        "estimate": prepared["estimate"],
        "budget": prepared["budget"],
        "reduced": bool(prepared["reduced"]),
        "dropped_messages": int(prepared["dropped_messages"]),
        "reduction_note": prepared["reduction_note"],
        "rejected": not bool(prepared["accepted"]),
        "actual": None,
        "discrepancy": None,
    }


def estimation_discrepancy(estimate, actual):
    """Compare a pre-request estimate with the provider's reported input tokens.

    This is the difference between two ways of measuring the same input, not an
    extra cost and not a token category of its own. Returns None when either side
    is missing, so nothing is invented.
    """
    if not actual:
        return None

    estimated = estimate.get("estimated_input_tokens")
    reported = actual.get("input_tokens")
    if not isinstance(estimated, int) or isinstance(estimated, bool):
        return None
    if not isinstance(reported, int) or isinstance(reported, bool):
        return None

    difference = reported - estimated
    return {
        "estimated_input_tokens": estimated,
        "actual_input_tokens": reported,
        "difference_tokens": difference,
        "difference_percent": round(difference * 100 / reported, 1) if reported else None,
        "direction": "under" if difference > 0 else ("over" if difference < 0 else "match"),
    }


def summarize_context(
    model, context_records, budget=None, rejected=False, compaction=None, tool_results=None
):
    """Aggregate the per-call context records of one assistant answer.

    Estimates and provider-reported usage stay in separate fields on purpose: an
    estimate is what the app expected before a call, `actual` is what the provider
    reported after it. Returns None when no model call happened, so the UI can
    never show a call that never occurred. `compaction`, when given, is the public
    report of the conversation compaction of this turn, and `tool_results` the report
    of tool-result management: neither carries conversation text.
    """
    records = [record for record in context_records if isinstance(record, dict)]
    if not records:
        return None

    budget = budget or context_budget_settings()
    first = records[0]["estimate"]
    last = records[-1]["estimate"]
    # A record can describe a request that was refused before it was sent; that is
    # not a model call, so it is not counted as one.
    model_calls = sum(1 for record in records if not record.get("rejected"))

    return {
        "available": True,
        "model": model,
        "budget": budget,
        "estimation_method": last.get("estimation_method"),
        "is_exact": bool(last.get("is_exact")),
        # Which counting method produced the numbers for this turn, so the UI can
        # name it instead of guessing from the method string.
        "tokenizer_backend": last.get("tokenizer_backend"),
        "tokenizer_name": last.get("tokenizer_name"),
        "tokenizer_label": last.get("tokenizer_label"),
        "tokenizer_compatibility": last.get("tokenizer_compatibility"),
        "tokenizer_available": bool(last.get("tokenizer_available")),
        "estimation_status": last.get("estimation_status"),
        "estimation_confidence": last.get("estimation_confidence"),
        "model_calls": model_calls,
        "reduced_calls": sum(1 for record in records if record.get("reduced")),
        # The turn's own arithmetic, added up once per request that was really
        # sent, so a per-call breakdown is never counted into two places.
        "estimate_totals": estimate_totals(records),
        # What summary-based compaction did before this turn's first call, if it
        # ran at all.
        "compaction": compaction,
        # What tool-result management and the adaptive passes did for this turn.
        "tool_results": tool_results,
        "rejected": bool(rejected),
        "first_call": first,
        "last_call": last,
        # How much the tool-calling loop added to the input of the last call.
        "context_growth_tokens": int(last.get("estimated_input_tokens") or 0)
        - int(first.get("estimated_input_tokens") or 0),
        "calls": records,
    }
