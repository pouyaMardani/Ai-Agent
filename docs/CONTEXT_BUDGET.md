# Context Budget, Actual Usage and Compaction

This document explains the numbers the chat UI shows beside every answer, how the
context budget works, and - most importantly - the rule this version is built on:

> **The agent runtime does no local token counting.** It never estimates the size of a
> request. Conversation compaction is triggered only by the provider's *actual*
> reported input usage, and every size the UI shows is either that reported usage or a
> configured value.

The runtime pieces live in `agent/context_budget.py`, `agent/compaction.py`,
`agent/tool_result_manager.py`, `agent/context_priority.py` and `agent/token_usage.py`;
`app.py` only wires those functions to the routes.

---

## 1. Two kinds of number, never mixed

| | Number | Where it comes from |
| --- | --- | --- |
| **A** | Provider **actual** input tokens | The `usage` block of the provider's response (`prompt_tokens` / `input_tokens`). |
| **B** | Configured budget values | `.env`, or the documented defaults: context window, output allowance, safety margin. |

There is no third number. The app used to compute a local estimate (a tokenizer count
plus offset rules) and show it beside the provider's count; that estimate is gone.
Token estimation was removed entirely: the tokenizer module and its dependencies are
deleted, no part of the runtime can count tokens, and the UI no longer displays any
estimate.

## 2. The context budget

The budget is read once per turn and is a *configured* value, not a provider fact:

```
context_window_tokens          # CONTEXT_WINDOW_TOKENS, default 8192
max_output_tokens              # MAX_OUTPUT_TOKENS, default 1024
context_safety_margin_tokens   # CONTEXT_SAFETY_MARGIN_TOKENS, default 512

max_input_budget_tokens        = context_window_tokens
                                 - max_output_tokens
                                 - context_safety_margin_tokens
```

It has exactly two jobs now:

1. It documents the **capacity** this app budgets with, and it is what the **413
   message** quotes when a provider refuses a request for being too long.
2. It is *not* used to judge a request before it is sent, because this app cannot count
   a request's tokens, and it is **not** the basis of the compaction threshold any more.

## 3. No local preflight, and how a too-long request is handled

Without local estimation, or a provider that offers a token-count endpoint, the app
**cannot guarantee that a request is within the provider's context limit before
sending it.** The budget settings above do not change that. When the provider refuses a
request because it is too long:

* the attempt is recorded as a **provider-reported context failure** (with no invented
  token count);
* `retry_compaction()` may fold the older saved messages and re-send **once**, but only
  while no tool has run yet in the turn, so a retry cannot repeat a side effect, and
  never more than `MAX_CONTEXT_RETRIES` times - it can never loop;
* if folding is impossible, or the retry was already used, the route answers `413` with
  `context_limit_message()`, which quotes the configured budget and suggests shortening
  the message or starting a new chat;
* the conversation is left exactly as it was - history is never destroyed or silently
  truncated to recover.

## 4. Conversation compaction (post-response, actual-usage-driven)

Conversation compaction is decided **after** a model response, from the actual input
token count the provider reported for that response.

```text
COMPACTION_ENABLED=true               # true | 1 | yes | on  /  false | 0 | no | off
ACTUAL_INPUT_TOKEN_THRESHOLD=4659     # provider ACTUAL input at or above which compaction runs
COMPACTION_TARGET_RATIO=0.50          # share of the saved history that stays verbatim
```

* **The threshold is an absolute actual count.** `ACTUAL_INPUT_TOKEN_THRESHOLD` is the
  provider's *reported* input token number at or above which a completed response is
  compacted. It is not an estimate and not a share of anything this app measured. The
  default 4659 is the previously derived value (70% of 8192 - 1024 - 512), kept so the
  behaviour is unchanged: 4200 does not compact; 5000 and 6000 do.
* **Missing usage means no decision.** A response with no `usage` block, no input field
  or a negative value cannot trigger compaction. No estimate is substituted, the
  conversation is kept, and the missing usage is recorded in the turn's report.
* **How much is folded** is structural: `groups_to_fold()` keeps roughly
  `COMPACTION_TARGET_RATIO` of the saved-message groups verbatim (never fewer than
  `MIN_RECENT_HISTORY_MESSAGES`, never all of them) and folds the rest. Without local
  estimates there is no size to measure against, so the rule is message counts, not
  tokens.
* **What is folded** is only the saved-history block. The system prompt, the newest
  user message and this turn's tool messages are never folded. A saved tool call and
  its results are one group and are always folded whole.
* **Incremental**: the stored summary records `last_compacted_message_id`, so a later
  compaction only folds what came after it. When the request can already be reduced
  with the existing summary, it is reused without a model call.
* **Summary generation**: one dedicated model request with **no tools**, receiving the
  previous summary plus the turns being folded in. It is validated (sized, not a repeat
  of the previous summary) before it replaces anything, and it is never itself
  compacted.
* **Where it is stored**: `compaction` travels with the conversation. The browser
  stores it beside the messages, sends it back with the next request, and the server
  sanitises it on arrival. The compacted history is what the rest of the turn and the
  next user turn are built from.
* **Failure**: a summary request that fails, times out or returns something unusable
  leaves the previous summary, the stored conversation and the request exactly as they
  were, and records the reason.

### Applying the stored compaction

At the start of a turn, `apply_stored_compaction()` rebuilds the request around the
stored summary: the messages up to `last_compacted_message_id` are replaced by the
summary, and the messages after it stay verbatim. This is not a decision and calls no
model - it only applies a compaction that already happened, and it is what makes the
feature persist from one user turn to the next.

## 5. Tool-result management (pre-request, same trigger)

Tool outputs are the part of a request that grows fastest inside one turn, and a tool
message can never be removed: its `tool_call_id` must keep matching the assistant
message that asked for it. So the pass **replaces content, never structure**.

* **When**: before a model request, only when `over_trigger` is true - that is, when
  the *previous* response's actual input was at or above the compaction trigger. When
  it is false, the pass does nothing at all.
* **What is tried**: the request is walked in priority order, and the older-round
  results are reduced one by one (`manage_result()`); the newest round is never touched
  (the model has not read it yet), and neither is an unmatched or already-managed
  result.
* **Eligibility** is a byte threshold: a result is tried only at or above
  `TOOL_RESULT_LARGE_BYTES` (default 4096 UTF-8 bytes). A smaller result is kept
  verbatim. This is a direct byte measurement, not a token estimate.
* **Classification** is metadata only: `critical` when the result reports a failure
  (`ok: false` or an `error`), `normal` otherwise.
* **How a result is reduced**:
  * `critical` → a deterministic trim that keeps the tool's reported fields and its
    error text verbatim, plus the first 600 and last 200 characters of the body;
  * `normal` → one dedicated summary request with **no tools**, validated (40-4,000
    characters, not a repeat of the raw output).
* **Retention**: the raw text is stored first, in a bounded in-memory store
  (`TOOL_RESULT_STORE_MAX_BYTES`, default 5 MiB) keyed by `tool_call_id`, oldest
  evicted first. Before anything is replaced, the retained copy is read back; if it
  cannot be recovered, the result is left exactly as the tool returned it.
* **Smaller than the original**: a replacement is kept only when the managed text is
  shorter than the raw text - a direct byte comparison, never a token estimate.
  If it is not shorter, the raw result is restored.
* **Incremental**: every managed representation starts with `[managed tool result]`, so
  it is recognised and never summarised twice.
* **Management usage**: a summary request is a call of this app's own. If the provider
  reports usage for it, that usage is aggregated separately and shown in a **Summary
  Generation Usage** section; it is never added to the conversation's usage and never
  drives a compaction decision.

The knobs that remain:

```dotenv
TOOL_RESULT_MANAGEMENT_ENABLED=true
TOOL_RESULT_LARGE_BYTES=4096
TOOL_RESULT_STORE_MAX_BYTES=5242880
CONTEXT_PRIORITY_ENABLED=true
```

`TOOL_RESULT_SUMMARY_THRESHOLD_RATIO`, `ADAPTIVE_COMPACTION_ENABLED`,
`COMPACTION_TRIGGER_RATIO` and the `TOKENIZER_*` variables are no longer read. The first
two were the last estimation-era tool-result switches; the trigger ratio was replaced by
`ACTUAL_INPUT_TOKEN_THRESHOLD`, and the tokenizer was removed with token estimation.
They are harmless if still present in `.env`.

## 6. Priority scoring

Reduction needs an order that is explainable, so `agent/context_priority.py` scores
every item of the request. Base weights, higher meaning "keep this":

| Kind | Base |
| --- | --- |
| `system` | 1000 |
| `tool_unmatched` | 900 |
| `current_user` | 900 |
| `turn_user` | 500 |
| `turn_assistant` | 400 |
| `tool_recent` | 350 |
| `history_user` | 300 |
| `history_assistant` | 200 |
| `tool_older` | 150 |

Modifiers, all structural or metadata-based: `critical` tool result **+200**, already
managed **-50**, shares a term with the current request **+150**, age **-2** per
message away from the newest (capped at **-200**). There is deliberately **no size
modifier**, because "large" is not a fact the runtime can know. Ties break towards the
older message, and every decision carries the reasons behind its score.


## 7. What the UI shows

The inline indicator next to every answer and the analytics panel both read the same
snapshot the API returned. Neither invents a number.

**Inline "Context & Compaction"** - the provider's actual input for the last call, the
compaction trigger it is compared with, the configured context window and input budget,
the post-response decision (applied / reused / not needed / no usage), the per-call
usage, and a note that this app does not count tokens.

**Analytics panel** - two cards for the selected turn:

* **Token Tracking** - the selected request's actual input, output, total, cached and
  reasoning tokens (all provider-reported), the compaction decision with its actual
  input and trigger, any provider context-length failures and the bounded retries after
  them, the tool-result management summary (with byte counts), usage availability, the
  turn's totals across every request, a collapsible per-request usage table, and a
  **Summary Generation Usage** section for the compaction/tool-result summary calls,
  kept apart from the conversation's usage.
* **Context Budget & Trigger** - the configured context window, its source, the output
  allowance, the safety margin and the input budget (the capacity this app budgets with,
  not a measured request size).

**Copy Analysis** copies the same snapshot as plain text. Rows that are not part of the
snapshot read `N/A` rather than `0`, and every count in the report was reported by the
provider.

## 8. Data shape (short reference)

```jsonc
{
  "reply": "...", "model": "...", "steps": [ ... ],
  "usage": { "available": true, "complete": true, "derived_total": false,
             "model_calls": 2, "tool_calls": 1,
             "totals": { "input_tokens": 500, "output_tokens": 40, "total_tokens": 540,
                         "cached_input_tokens": null, "reasoning_tokens": null },
             "calls": [ { "call_index": 1, "input_tokens": 200, "output_tokens": 25,
                          "total_tokens": 225, "cached_input_tokens": null,
                          "reasoning_tokens": null, "reported": true }, ... ] },
  "context": {
    "available": true, "model": "...",
    "budget": { "context_window_tokens": 8192, "context_window_source": "default",
                "context_window_origin": "configured", "max_output_tokens": 1024,
                "context_safety_margin_tokens": 512, "max_input_budget_tokens": 6656,
                "configuration_problem": null },
    "model_calls": 2,
    "context_failures": 0,
    "context_retries": 0,
    "management_usage": { "available": true, "complete": false, "derived_total": false,
                          "model_calls": 1, "tool_calls": 0,
                          "totals": { "input_tokens": 1800, "output_tokens": 300,
                                      "total_tokens": null, "cached_input_tokens": null,
                                      "reasoning_tokens": null },
                          "calls": [ ... ] },
    "compaction": { "post_response": true, "attempted": true, "applied": true,
                    "reused": false, "reason": null,
                    "actual_input_tokens": 5200, "usage_available": true,
                    "trigger_exceeded": true, "compacted_messages": 24,
                    "summary_requests": 1,
                    "trigger_tokens": 4659, "attempts": 1 },
    "tool_results": { "available": true, "results": 9,
                      "classified": { "normal": 8, "critical": 1 },
                      "bytes": 60123, "managed_bytes": 5400,
                      "large_candidates": 3, "large_bytes": 4096,
                      "managed_results": 2, "managed_this_turn": 2,
                      "summarized": 2, "trimmed": 0, "unchanged": 7,
                      "retrievals": 3, "passes": 1, "changed_passes": 1,
                      "blocked_passes": 0,
                      "priority": { "enabled": true, "reducible": 4, "decisions": [ ... ] },
                      "management_requests": { "calls": 2, "failures": 0 },
                      "store": { "entries": 2, "bytes": 8123, "max_bytes": 5242880,
                                 "evictions": 0, "refused": 0 },
                      "skipped_reasons": {}, "notes": [] },
    "rejected": false,
    "calls": [ { "call_index": 1, "rejected": false, "context_failure": false,
                 "actual": { "input_tokens": 200, "output_tokens": 25,
                             "total_tokens": 225, "cached_input_tokens": null,
                             "reasoning_tokens": null } }, ... ]
  },
  "compaction": { "summary": "Project / Conversation Context\n...",
                  "summary_version": 1, "last_compacted_message_id": "m_123",
                  "compaction_count": 2, "last_compacted_at": 1761234567890 }
}
```

Notes:

* `null` always means *not present* or *not reported*, never `0`.
* `context.compaction` is present whenever a completed response was evaluated, even
  when nothing was compacted. The top-level `compaction` is the *metadata to store*
  (the summary and the message it covers); the report never carries summary text.
* `context.tool_results` and `context.compaction` contain counts, classes, decisions and
  byte sizes only - never a token estimate.
* `context.management_usage` is the usage of the summary-generation calls, kept in a
  section of its own so it is never mixed with the conversation's usage.
* `context.context_failures` counts provider-reported context-length refusals and
  `context.context_retries` the bounded re-sends after them.
* A `413` answer carries `{"detail", "rejected", "model", "context"}` and, when an
  earlier response in the same turn produced one, a `compaction` entry. The
  conversation is unchanged.


## 9. Where to look in the code

| Function | Responsibility |
| --- | --- |
| `read_positive_int_env()`, `context_budget_settings()` | Read the configured budget from `.env`, with documented defaults. |
| `is_context_limit_error()`, `context_limit_message()` | Recognise a provider rejection for length and turn it into the readable 413 reason. |
| `context_call_record()`, `summarize_context()` | Describe each model call from the provider's side only, and aggregate the turn. |
| `actual_input_tokens()` | Read the provider's reported input count, or `None` when it is unusable. |
| `read_compaction_settings()` | Read the absolute actual-usage threshold and the verbatim share. |
| `apply_stored_compaction()` | Apply the conversation's stored summary to a request, with no decision and no model call. |
| `compact_after_response()`, `compact_request()`, `fold_into_summary()`, `groups_to_fold()` | Decide from actual usage whether to compact, and fold the oldest saved messages structurally. |
| `retry_compaction()` | Fold history for the bounded re-send after a provider context-length refusal. |
| `manage_tool_results()`, `tool_results_report()` | Run the tool-result pass and report what it did. |
| `classify_result()`, `collect_tool_results()`, `manage_result()` | Classify a result from its own metadata and replace it with a smaller managed representation. |
| `ToolResultStore`, `retrieve_raw()` | Retain raw tool results within a byte budget and read them back. |
| `rank_context_items()`, `score_item()`, `decision_summary()` | Score the items of a request deterministically and explain every score. |
| `run_chat_with_tools()` in `agent/chat.py` | Send each request, read the provider's usage, and drive both decisions from that one number. |
| `buildContextIndicator()`, `buildContextPanel()` in `static/js/app.js` | Render the inline "Context & Compaction" indicator. |
| `renderAnalytics()`, `analyticsTokenCard()`, `analyticsBudgetCard()` in `static/js/app.js` | Build the analytics dashboard for the selected turn. |
| `analyticsReportText()` in `static/js/app.js` | Build the plain-text report that Copy Analysis writes to the clipboard. |
| `cleanContext()`, `cleanCompactionReport()`, `cleanToolResults()` in `static/js/store.js` | Keep the stored snapshot trustworthy when a conversation is saved or reloaded. |

