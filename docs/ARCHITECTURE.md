# Architecture

Token Harbor Chat is a single-page chat front end served by a small FastAPI
backend. The backend answers one message at a time, may call two tools while doing
so, and reports both the provider's real token usage and the app's own estimates of
the context it sent.

## Files and responsibilities

| Path | Responsibility |
| --- | --- |
| `app.py` | HTTP layer only: the `ChatRequest` model, the static mount, the `/`, `/api/config` and `/api/chat` routes, the 413/502 mapping, and `uvicorn` startup. |
| `config.py` | `.env` loading, the environment variable names and defaults, `get_settings()`, `create_client()`, and the safe error messages (`friendly_error`). |
| `agent/chat.py` | `SYSTEM_PROMPT`, the tool registry, `execute_tool_call()`, browser history filtering (`keep_history`) and `run_chat_with_tools()`, the model request loop. |
| `agent/tokenizer.py` | Choosing a tokenizer (tiktoken, Hugging Face, or the character heuristic), counting text, and describing how far the count can be trusted. |
| `agent/token_usage.py` | Reading the usage block of a completion, aggregating it across calls, and keeping "not reported" different from `0`. |
| `agent/context_budget.py` | Estimating a prepared request, comparing it with the configured budget, trimming history safely, and building the per-call and per-answer context records. |
| `tools/write_file.py` | The `write_file` tool: workspace-only paths, suffix and size rules, no overwrite without `overwrite=true`, atomic write. |
| `tools/web_search.py` | The `web_search` tool: Tavily search, result truncation, and results marked as untrusted data. |
| `static/` | The front end (`index.html`, `app.css`, `js/app.js`, `js/store.js`, `js/icons.js`). It renders usage, estimates and the analytics panel from the JSON the API returns. |
| `docs/` | This file, the context-budget deep dive (`CONTEXT_BUDGET.md`) and the earlier backend report. |

`config.py` imports nothing from the project; `agent/tokenizer.py` imports
`config`; `agent/context_budget.py` imports both; `agent/chat.py` imports the
agent modules and the tools; `app.py` imports the rest. That order has no cycles,
so any module can be read or tested on its own.

## One message, end to end

1. The browser posts `{message, history}` to `/api/chat`. `history` is a list of
   `{role, content}` objects the browser kept on its side.
2. `chat()` in `app.py` reads the settings and builds the client. The model comes
   from `.env` (`MODEL_ID`) and is never taken from the request body, so the
   browser cannot choose the model.
3. `keep_history()` keeps at most the newest 40 entries, and only plain
   `user`/`assistant` pairs. Anything else the browser sends never reaches the
   model. The message list is then the system prompt, that filtered history, and
   the trimmed newest user message.
4. `run_chat_with_tools()` runs the loop described below, and returns
   `(reply, steps)`.
5. The response is `{reply, model}` plus `steps` when a tool ran, `usage` for the
   provider-reported counts, and `context` for the pre-call estimates and the
   active budget. A request that cannot fit the budget is refused locally with
   `413` and the same `context` summary; a provider or tool failure becomes `502`
   with a message from `friendly_error()` and the raw error only in the console.

## The model request loop

`run_chat_with_tools()` alternates between measuring, calling the model, and
running the tools it asks for:

1. `enforce_context_budget()` prepares the exact message list for the next call
   (system prompt, kept history, this turn so far) plus the tool schemas when
   tools are still allowed.
2. If the prepared request is still too large, `ContextBudgetExceeded` is raised
   with a readable reason and the rejected call's record; `app.py` turns that into
   the `413` answer.
3. Otherwise the model is called, with `tools` and `tool_choice="auto"` on the
   first rounds. If the provider rejects tools with a `BadRequestError`, the
   record for that attempt is dropped (no model answer happened), a `tools /
   unsupported` step is added, and the call is retried without tools.
4. The usage the model reported is stored on that call's context record, next to
   the estimate made before it.
5. If the model answered with text, the loop ends and returns the reply.
6. If the model asked for tools, an assistant message carrying those tool calls is
   appended, each tool runs, and one `tool` message per result is appended. Up to
   three calls per round are executed; further calls in the same round are refused
   with "Too many tool calls in one round." so a single round cannot fan out.
7. After three tool rounds the tools are dropped and a final user message asks the
   model to answer with what it already has, so the turn cannot loop forever.

## Token usage (what the provider measured)

`agent/token_usage.py` reads the usage block of each completion into five fields:
`input_tokens`, `output_tokens`, `total_tokens`, `cached_input_tokens` (from
`prompt_tokens_details.cached_tokens`) and `reasoning_tokens` (from
`completion_tokens_details.reasoning_tokens`).

Rules that keep the numbers honest:

* A field the provider left out stays `None`, which means "not reported" and is
  never confused with a real `0`.
* Booleans, negative numbers and non-integers are treated as not reported.
* `summarize_usage()` adds each field across the calls that reported it, so a
  missing field does not silently become zero.
* `total_tokens` prefers the provider's own total. `input + output` is used only
  when every call reported both parts, and then `derived_total` is true.
* `complete` is true only when every model call reported all three main fields.
* `cached_input_tokens` and `reasoning_tokens` are extras: they never make an
  answer incomplete, and they are never added into the totals of the others.

## Tokenizer estimation (what this app predicted)

`agent/tokenizer.py` always returns a *descriptor*: a `counter` function plus
metadata (`backend`, `name`, `method`, `compatibility`, `status`, `is_exact`,
`available`, `limitations`). `load_tokenizer()` picks one, in this order:

1. An explicitly configured Hugging Face tokenizer (`TOKENIZER_NAME`), loaded from
   local files only unless `TOKENIZER_LOCAL_ONLY` is false.
2. tiktoken: `encoding_for_model()` for the model id, which is treated as exact.
3. tiktoken with an explicitly configured or default encoding, labelled
   `estimated` because matching the model was not verified.
4. The character heuristic (about four characters per token), labelled
   `heuristic` with its limitations in words.

tiktoken and `transformers` are imported late and may be missing; the app then
falls back without failing. Descriptors are cached per model and configuration,
and nothing is downloaded while a request is being answered. `is_exact` is true
only when the app has evidence the tokenizer matches the model, and every
estimate says which method produced it.

## Context budget (what this app allowed itself to send)

`agent/context_budget.py` turns a budget into a decision:

```
context_window_tokens          # CONTEXT_WINDOW_TOKENS, default 8192
max_output_tokens              # MAX_OUTPUT_TOKENS, default 1024
context_safety_margin_tokens   # CONTEXT_SAFETY_MARGIN_TOKENS, default 512

max_input_budget_tokens        = window - max_output - margin
remaining_input_budget_tokens  = max(0, max_input_budget_tokens - estimated_input_tokens)
```

* The window is a *configured budget*, not a provider fact, and the app says so in
  `context_window_source`, `context_window_origin` and `context_window_note`.
* `estimate_context()` counts the exact messages about to be sent, plus a few
  tokens of overhead per message and per tool schema, and breaks the result into
  system prompt, saved history, tool definitions, other input, and the newest user
  message. A component that is not part of the request is `None`, not `0`.
* `enforce_context_budget()` trims from the front of the saved history only, one
  message at a time, re-estimating after each removal. The system prompt, the
  newest user message and this turn's tool messages are never dropped, which also
  cannot break a tool-call / tool-result pair because those are created after the
  history block.
* If even an empty history does not fit, the request is refused: nothing is sent
  to the provider, the reason spells out the arithmetic, and the answer is `413`.
* `context_budget_for_call()` labels the state (`comfortable`, `approaching` at
  70 %, `over` at 100 % or when nothing is left) and adds a caveat whenever the
  decision rests on an approximate count.
* `summarize_context()` aggregates the per-call records. Estimates
  (`calls[i].estimate`) and provider measurements (`calls[i].actual`) stay in
  separate fields, and a call that was refused is recorded but not counted as a
  model call.

## Safety rules and where they live

* Secrets: `.env` is read in `config.py` and never leaves the server. The system
  prompt forbids repeating them, `/api/config` returns only `{"ok": true}`, and
  error messages come from a fixed list in `friendly_error()`.
* Files: `tools/write_file.py` allows only workspace-relative paths inside the
  workspace, only `.txt/.md/.json/.csv` up to 200 KB, refuses to replace an
  existing file without `overwrite=true`, and can never rename, move or delete.
* Untrusted web content: `tools/web_search.py` marks results as untrusted data,
  and the system prompt says to ignore instructions found inside them.
* The model cannot pick itself: the configured model in `.env` is used for every
  request.
* A tool failure is reported to the model as data (`ok: false` plus a reason), and
  the system prompt requires the model to tell the user instead of inventing a
  success.

