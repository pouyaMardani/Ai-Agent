"""The context budget, provider limit handling, and the per-call context record.

This app does not count tokens locally: it cannot know how many tokens a provider
will charge for a serialized request before that provider reads it. So the budget
here has exactly two jobs:

* document the configured capacity (the context window minus the output allowance
  and the safety margin) that the readable 413 answer quotes; and
* turn a provider context-limit error into that readable 413 answer, because without
  local estimation or a provider preflight there is no way to know a request is too
  long before it is sent.

The compaction threshold is NOT derived here. It is an absolute provider actual-input
count read in agent/compaction.py from ACTUAL_INPUT_TOKEN_THRESHOLD.
"""

from config import (
    DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
    DEFAULT_MAX_OUTPUT_TOKENS,
    ENV_CONTEXT_SAFETY_MARGIN,
    ENV_CONTEXT_WINDOW,
    ENV_MAX_OUTPUT,
    read_positive_int_env,
)


class ContextBudgetExceeded(Exception):
    """Raised when the provider refuses a request because it is too long.

    It carries the structured context summary, so the route can answer with a
    readable message instead of a generic failure.
    """

    def __init__(self, message, context):
        super().__init__(message)
        self.message = message
        self.context = context


def context_budget_settings():
    """Read the configured context budget:

        max_input_budget_tokens = context_window_tokens
                                  - max_output_tokens
                                  - context_safety_margin_tokens

    The window here is a configured value, not a provider fact. It is not used to
    judge a request before it is sent (this app does not count tokens locally); it
    documents the capacity this app budgets with and it is what the 413 message quotes
    when a provider refuses a request for being too long. The compaction threshold is
    an absolute actual-usage count and is not derived from this budget.
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


# Provider signals that mean "this request was too long", matched case-insensitively
# against the provider's own message. Without local estimation or a provider
# preflight, a rejection like this is the only signal the app gets that a request did
# not fit, so it is turned into the same readable 413 answer as before.
CONTEXT_LIMIT_SIGNALS = (
    "context length",
    "context_length",
    "contextlimit",
    "maximum context",
    "max context",
    "context window",
    "too many tokens",
    "too long",
    "reduce the length",
    "reduce the size",
    "input is too large",
    "prompt is too long",
)


def is_context_limit_error(error):
    """True when a provider error says the request did not fit its context limit."""
    text = " ".join(str(error or "").lower().split())
    return any(signal in text for signal in CONTEXT_LIMIT_SIGNALS)


def context_limit_message(budget=None):
    """The readable 413 reason for a request the provider refused as too long.

    History is never destroyed or silently truncated to fit: the turn simply fails
    with this explanation, and the conversation stays exactly as it was.
    """
    budget = budget or context_budget_settings()
    return (
        "The model refused this request because it is longer than the model's context "
        "limit. This app does not count tokens locally, so it cannot know a request's "
        "real size before the provider reads it. The configured context window is "
        f"{budget['context_window_tokens']} tokens (output allowance "
        f"{budget['max_output_tokens']} and safety margin "
        f"{budget['context_safety_margin_tokens']} are reserved from it). Shorten your "
        "message or start a new chat. Only raise "
        f"{ENV_CONTEXT_WINDOW} in your .env file if your model really allows more."
    )


def context_call_record(call_index, rejected=False, context_failure=False):
    """Describe one model call from the provider's side only.

    There is no local estimate to store, so the record carries just the call index,
    whether the provider refused it as too long, and the provider's actual usage once
    it arrives. `context_failure` marks the refusal as a provider-reported
    context-length failure, which is the only size signal this app can get before a
    request is sent.
    """
    return {
        "call_index": int(call_index),
        "rejected": bool(rejected),
        "context_failure": bool(context_failure),
        "actual": None,
    }


def summarize_context(
    model,
    context_records,
    budget=None,
    rejected=False,
    compaction=None,
    tool_results=None,
    management_usage=None,
    context_retries=0,
):
    """Aggregate the per-call records of one assistant answer.

    Provider-reported usage stays on `calls[i].actual`; there is deliberately no
    estimated counterpart for it to be confused with. None when no model call
    happened, so the UI cannot show a call that never ran. `compaction` is the
    post-response decision and `tool_results` is the pre-request tool-result report;
    neither carries conversation text. `management_usage` is the usage of the
    summary-generation calls, kept in a section of its own so it is never mixed with
    the conversation's own usage, and `context_retries` counts the bounded re-sends
    after a provider context-length refusal.
    """
    records = [record for record in context_records if isinstance(record, dict)]
    if not records:
        return None

    return {
        "available": True,
        "model": model,
        "budget": budget or context_budget_settings(),
        # A record can describe a request the provider refused; that is not a model
        # call, so it is not counted as one.
        "model_calls": sum(1 for record in records if not record.get("rejected")),
        "context_failures": sum(1 for record in records if record.get("context_failure")),
        "context_retries": int(context_retries),
        "compaction": compaction,
        "tool_results": tool_results,
        "management_usage": management_usage,
        "rejected": bool(rejected),
        "calls": records,
    }
