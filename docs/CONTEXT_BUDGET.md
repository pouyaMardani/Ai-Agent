# Context Estimation and the Context Budget

This document explains the features that sit next to the token usage card in the
chat UI: a **context estimate** made *before* every model call, the **tokenizer
layer** that produces that estimate and says how far it can be trusted, the
**context budget** that decides whether a request may be sent at all, and the
**analytics panel** that shows all of it side by side with provider-reported usage.

All of the counting lives in `agent/tokenizer.py` and `agent/context_budget.py`;
`app.py` only wires those functions to the routes. Each assistant response carries
a compact `Context & Budget` indicator beside `Token Usage`, and the same numbers
are shown in full in the analytics panel.

---

## 0. The tokenizer layer in one paragraph

Every estimate is produced by a *tokenizer descriptor*: a small object holding a
`counter` function plus metadata saying which backend produced the number, whether
this app has evidence that the tokenizer matches the configured model, and how the
result should be labelled (`exact`, `estimated` or `heuristic`). A descriptor is
always available - the last resort is the documented character heuristic - so no
caller ever has to handle "no tokenizer". Nothing in this layer downloads a model
or a tokenizer at request time.

```
backend            auto | huggingface | tiktoken | heuristic
compatibility      compatible | unverified | unsupported
status             exact | estimated | heuristic
```

---

## 1. Context window vs. context budget

| Idea | Meaning | Where it comes from |
| --- | --- | --- |
| **Context window** | How many tokens a model can consider in one request, input *and* output together. | A property of the model, decided by its provider. |
| **Context budget** | How many tokens *this app* is willing to send in one request. | A setting in `.env`, or a documented default. |

The app cannot see the real context window of the model behind an
OpenAI-compatible endpoint, so it never pretends to know it. Instead it works with
a configured budget and says so in the UI: the panel labels the value
`Configured default ...` or `Read from CONTEXT_WINDOW_TOKENS in .env`. A budget
that fits is therefore **not** proof that the provider will accept the request; it
is proof that this app stayed inside the limits you gave it.

Three numbers form the budget:

```
context_window_tokens          # capacity we budget for
max_output_tokens              # reserved for the model's answer
context_safety_margin_tokens   # reserve for estimation error and provider overhead

max_input_budget_tokens       = context_window_tokens
                                - max_output_tokens
                                - context_safety_margin_tokens

remaining_input_budget_tokens = max_input_budget_tokens - estimated_input_tokens
```

The remaining budget is clamped at zero for readability, but an over-budget
request still shows exactly how far over it is (`over_budget_tokens`), because a
negative number would otherwise be hidden or look like zero.

## 2. Estimated input tokens vs. actual input tokens

* **Estimated input tokens** - produced by `estimate_context()` from the exact
  messages and tool definitions that are about to be sent. This is a *guess made
  before* the call, clearly labelled as an estimate in the UI.
* **Actual input tokens** - reported by the provider in the response
  (`usage.prompt_tokens` and friends). This is a *measurement made after* the call.

They are kept in separate fields on purpose:

* `context.calls[i].estimate` - pre-request estimate and its breakdown.
* `context.calls[i].actual` - provider-reported usage for that call, with missing
  values left as `null` (shown as `N/A`, never as `0`).
* `context.calls[i].discrepancy` - the difference between the two, labelled in the
  UI as an *estimation discrepancy*. It is not an extra cost and not a token
  category of its own.

Both cards can be open at the same time for the same answer, and they never share
numbers: the usage card stays exactly what it always was, and the context card
never replaces a missing provider value with an estimate. The analytics panel
(section 9) shows the same two cards for the selected turn, widened into tables,
and adds no number the compact cards do not already have.

## 3. How the estimate is produced

`estimate_context()` walks the prepared message list **once** and adds up:

| Component | Field | What it covers |
| --- | --- | --- |
| System/developer instructions | `system_prompt_tokens` | The app's system prompt (its text is never sent to the browser). |
| Saved conversation | `history_tokens` | The earlier user/assistant turns sent with this request. |
| Tool definitions | `tool_definitions_tokens` | The JSON schemas of the tools offered with *this* call, when tools are offered. |
| This turn | `other_input_tokens` | The newest user message, assistant tool-call messages, tool results and the loop's reminder. |

Plus a small documented overhead per message (role and delimiters) and per tool
schema (name and wrapper). Every message is converted to text exactly once, so
nothing is counted twice.

A component that is genuinely absent (for example tool schemas on a call that may
not use tools) is reported as `null`, which means "not present", not "0 tokens".

### 3.1 Which tokenizer is used

`load_tokenizer(model)` (a thin wrapper over `select_tokenizer(model)`) picks a
tokenizer in this order, highest priority first:

1. **Hugging Face**, when `TOKENIZER_NAME` is set and that tokenizer is *already
   present locally* and the `huggingface` backend is allowed. Loading is
   `local_files_only` by default, so an identifier that is not cached simply fails
   and the next candidate is tried.
2. **tiktoken**, when this tiktoken installation recognises the configured model
   (`tiktoken.encoding_for_model`). This is the only case this app calls
   `compatible`, because it is the only case where the match is verifiable here.
   A routing suffix such as `:free` is stripped first, because it selects a
   provider tier, not a different tokenizer.
3. **tiktoken with an explicitly configured encoding** (`TOKENIZER_NAME`, or
   `cl100k_base` when the backend was requested by name), labelled `unverified`.
4. **The character heuristic**, always available and clearly labelled approximate.

Each descriptor is cached per `(model, backend, TOKENIZER_NAME, local_only)` so a
slow tokenizer load happens once per configuration, not once per call.

### 3.2 What the count is called

| Backend | Compatibility | Status | Method string |
| --- | --- | --- | --- |
| Hugging Face, id equals the model | `compatible` | `exact` | `huggingface:<id>` |
| Hugging Face, id set but unverified | `unverified` | `estimated` | `huggingface:<id>` |
| tiktoken knows the model | `compatible` | `exact` | `tiktoken:<encoding>` |
| tiktoken, encoding unverified | `unverified` | `estimated` | `tiktoken:<encoding>` |
| character heuristic | `unsupported` | `heuristic` | `heuristic` |

The status is what the UI repeats: `exact token count`, `tokenizer estimate` or
`heuristic estimate`. Only a count this app can point at evidence for is ever
called exact; everything else says so plainly.

The heuristic itself is one documented line:

```
tokens = max(1, ceil(characters / 4))   # English prose average
```

**Limitations**

* A tokenizer for one model is not the tokenizer of every provider or model, so
  even an exact count for *a* model is only an estimate for another.
* An OpenAI-compatible endpoint does **not** imply an OpenAI tokenizer, which is
  why an unverified encoding is never reported as exact.
* The heuristic is worst for non-English text (including Persian), code, long
  numbers and URLs, which usually cost more tokens per character than English
  prose.
* Estimates never include provider-side overhead that is not part of the messages
  (for example some providers add tokens per image or per tool call). The safety
  margin exists partly for exactly this.
* No extra API call and no download is ever made to estimate context size.
* `tiktoken` and `transformers` are **not** dependencies of this project; when
  neither is installed and no name is configured, the heuristic is the answer, and
  the panel says so instead of guessing which method "should" have been used.

## 4. How the safety margin works

`max_output_tokens` is reserved because a request is judged *before* the answer
exists: if the whole window were offered to the input, a long input plus a long
answer would overflow the window and the request would fail after being sent.

`context_safety_margin_tokens` covers the part of the context that cannot be
measured well: the difference between the estimate and the provider's own count,
provider-specific formatting overhead, and small count differences between
tokenizers. It is a reserve, not a measurement, so it should be larger when you
estimate with the character heuristic and smaller when you have a matching
tokenizer.

With the defaults:

```
context_window_tokens         = 8192
max_output_tokens             = 1024
context_safety_margin_tokens  =  512
max_input_budget_tokens       = 6656
```

## 5. How budgeting interacts with the tool-calling loop

`run_chat_with_tools()` asks the same three questions before **every** model call:

1. Build the exact request for that call (messages *and* tool schemas).
2. Estimate its input size with `estimate_context()`.
3. Compare it with the budget using `context_budget_for_call()`.

A tool loop therefore produces several estimates for one assistant answer:

* **Call 1 (initial)** - system prompt + history + newest user message + tool schemas.
* **Call 2 (tool-loop)** - everything from call 1 plus the assistant tool-call
  message and the tool results, and no longer counting the schemas if tools were
  dropped. This call is normally the largest, which is why input tokens can grow
  inside a single answer.
* **Call 3 (final)** - the request that produced the visible answer.

The panel lists them as `Initial model call`, `Tool-loop model call` and `Final
model call`, and shows the estimate, budget use, remaining budget and actual usage
per call. `context.context_growth_tokens` summarises how much the loop added
between the first and the last call. The existing round limit (three tool rounds)
and all tool safety rules are unchanged.

## 6. What happens when the budget is exceeded

`enforce_context_budget()` runs before each call and tries to make the request
fit:

1. **Reduce, safely.** The *oldest* saved-conversation messages are dropped one at
   a time, and the request is re-estimated after each removal. The system prompt,
   the newest user message, the assistant tool-call messages and the tool results
   for this turn are never removed, and a tool-call/tool-result pair is never
   split, because those messages are created inside the loop and always sit after
   the conversation block. A note in the panel states how many saved messages were
   left out.
2. **Refuse if it still does not fit.** If the estimate is over budget even with
   an empty conversation, nothing is sent. `/api/chat` answers **413** with a
   readable `detail` string containing the numbers, and a `context` object whose
   last call has `rejected: true`. The UI shows the message, marks it as the
   selected turn, and draws the same `Context & Budget` numbers in the analytics
   panel, so the refused request is inspectable instead of mysterious.

This is deliberate: an estimate that fits the configured budget is not proof that
the provider's real window fits, but an estimate that *exceeds* the budget is a
good reason not to spend a request finding out.

## 7. How to configure the budget

Add any of these lines to `.env` (next to `app.py`); `load_env_file()` reads
`KEY=VALUE` lines and never overwrites variables that already exist in the
environment. Only the model provider keys are secrets - these three are settings.

```dotenv
# Total capacity this app is willing to budget for, in tokens.
CONTEXT_WINDOW_TOKENS=16384

# Tokens reserved for the model's answer.
MAX_OUTPUT_TOKENS=2048

# Reserve for estimation error and provider overhead.
CONTEXT_SAFETY_MARGIN_TOKENS=1024
```

| Setting | Default | Notes |
| --- | --- | --- |
| `CONTEXT_WINDOW_TOKENS` | `8192` | A conservative configured budget for this educational project, not a verified provider limit. A missing, non-numeric or non-positive value keeps the default. |
| `MAX_OUTPUT_TOKENS` | `1024` | Reserved for the answer. |
| `CONTEXT_SAFETY_MARGIN_TOKENS` | `512` | Larger values are safer with the character heuristic. |

If `MAX_OUTPUT_TOKENS + CONTEXT_SAFETY_MARGIN_TOKENS` is greater than or equal to
`CONTEXT_WINDOW_TOKENS`, the input budget is zero. The panel then shows the
matching `configuration_problem` text instead of pretending the budget works.

### 7.1 Tokenizer settings

These are optional. Without them the app still works: it uses the best tokenizer it
can verify and falls back to the documented heuristic.

```dotenv
# auto | huggingface | tiktoken | heuristic
TOKENIZER_BACKEND=auto

# An encoding name (tiktoken, e.g. o200k_base) or a Hugging Face tokenizer id.
TOKENIZER_NAME=

# Never download a tokenizer at request time.
TOKENIZER_LOCAL_ONLY=true
```

| Setting | Default | Notes |
| --- | --- | --- |
| `TOKENIZER_BACKEND` | `auto` | `auto` tries Hugging Face (when a name is set), then tiktoken, then the heuristic. Any unrecognised value falls back to the default, so a typo cannot disable estimation. |
| `TOKENIZER_NAME` | unset | With `auto`, this is the Hugging Face tokenizer id that must already exist locally. With `tiktoken`, it is the encoding name. When it is set but cannot be used, the failure is recorded in `estimation_notes` rather than hidden. |
| `TOKENIZER_LOCAL_ONLY` | `true` | `true`, `1`, `yes`, `on` and `false`, `0`, `no`, `off` are recognised. Anything else keeps the default. |

Installing `tiktoken` (or `transformers` for a Hugging Face tokenizer) is enough to
activate the better backends; nothing else changes. `tiktoken` matching the
configured model is the only path this app describes as an exact count.

The active model (`MODEL_ID`) and every budget value are shown in the panel, so you
can confirm what was actually in force for a response. Changing `.env` requires
restarting the app (or reloading with `uvicorn --reload`); the budget is read once
per assistant turn, so every call inside one answer is judged by the same numbers.

## 8. Data shape (short reference)

`POST /api/chat` keeps its old fields (`reply`, `model`, `steps`, `usage`) and adds
an optional `context`:

```jsonc
{
  "reply": "...",
  "model": "...",
  "steps": [ /* unchanged */ ],
  "usage": { /* unchanged, provider-reported only */ },
  "context": {
    "available": true,
    "model": "...",
    "budget": { "context_window_tokens": 8192, "max_output_tokens": 1024,
                "context_safety_margin_tokens": 512, "max_input_budget_tokens": 6656,
                "context_window_source": "default", "context_window_origin": "configured",
                "context_window_note": "Configured default ...",
                "budget_status": "within", "budget_caveat": "Estimated from ...",
                "configuration_problem": null },
    "estimation_method": "heuristic",
    "is_exact": false,
    "tokenizer_backend": "heuristic",
    "tokenizer_name": "character-heuristic",
    "tokenizer_label": "Built-in character heuristic (character-heuristic)",
    "tokenizer_compatibility": "unsupported",
    "tokenizer_available": false,
    "estimation_status": "heuristic",
    "estimation_confidence": "heuristic estimate",
    "model_calls": 2,
    "reduced_calls": 0,
    "rejected": false,
    "context_growth_tokens": 412,
    "calls": [
      {
        "call_index": 1,
        "estimate": { "estimated_input_tokens": 812, "system_prompt_tokens": 348,
                      "history_tokens": null, "tool_definitions_tokens": 402,
                      "other_input_tokens": 62, "latest_user_message_tokens": 41,
                      "message_count": 2, "tool_definition_count": 2,
                      "estimation_notes": "...",
                      "tokenizer_backend": "heuristic", "tokenizer_name": "character-heuristic",
                      "tokenizer_label": "Built-in character heuristic (character-heuristic)",
                      "tokenizer_compatibility": "unsupported", "tokenizer_available": false,
                      "estimation_status": "heuristic",
                      "estimation_confidence": "heuristic estimate" },
        "budget": { "max_input_budget_tokens": 6656, "estimated_input_tokens": 812,
                    "remaining_input_budget_tokens": 5844, "over_budget": false,
                    "over_budget_tokens": null, "budget_utilization_percent": 12.2,
                    "budget_state": "comfortable", "budget_status": "within",
                    "accepted": true },
        "reduced": false, "dropped_messages": 0, "reduction_note": null,
        "rejected": false,
        "actual": { "input_tokens": 826, "output_tokens": 41, "total_tokens": 867,
                    "cached_input_tokens": null, "reasoning_tokens": null },
        "discrepancy": { "estimated_input_tokens": 812, "actual_input_tokens": 826,
                         "difference_tokens": 14, "difference_percent": 1.7,
                         "direction": "under" }
      }
    ]
  }
}
```

Notes on the shape:

* `tokenizer_*` and `estimation_status` appear **twice**: once per call (inside
  `estimate`) and once for the whole answer, describing the most recent call. The
  per-call copy is the ground truth; the turn level one is a convenience for the
  compact badge.
* `estimation_confidence` is the human label (`exact token count`, `tokenizer
  estimate`, `heuristic estimate`), so the UI never has to map codes itself.
* `null` always means *not present* or *not reported*, never `0`.
* `context_growth_tokens` is the difference between the first and the last estimate
  of the answer, which is how much the tool loop grew the request.

A refused turn answers `413` with `{"detail": "...", "rejected": true, "model":
"...", "context": { ... "rejected": true ... }}` and no `usage`, because no model
call happened.

## 9. The analytics panel

The chat layout is a three-part grid (`.workspace`): the conversation sidebar, the
chat column, and the analytics panel. The panel is a dashboard for the **currently
selected assistant turn**, not a separate page.

### 9.1 What it shows

The panel holds two cards for the selected turn, preceded by a model-request
selector when the turn used more than one model request.

**Token Tracking** - everything the provider reported, kept strictly apart from the
estimate:

* the selected turn, and the tokenizer used to count it;
* **Tokenizer compatibility** and **Estimation status** as labelled pills
  (`compatible` / `unverified` / `unsupported`, and `exact token count` /
  `tokenizer estimate` / `heuristic estimate`);
* the estimate for the selected request, then the provider's actual input, output
  and total (plus cached and reasoning tokens when the provider sends them);
* **Estimation discrepancy** - provider input minus the estimate, signed and
  percentage, labelled as two ways of counting the same input rather than extra
  usage;
* **Usage availability**, the number of model API calls and tool calls, and this
  turn's totals summed across every request;
* when the turn had more than one model request, a collapsible **Per-request
  breakdown** table: one row per request with its estimate, actual input, actual
  output and budget use. The row for the request being inspected is highlighted,
  and missing values read `N/A` - never `0` and never an estimate.

**Context & Budget** - the arithmetic the backend documents, for the selected
request:

* the context window, where it came from, the output reserve and the safety
  margin, the resulting input budget, the estimated input, the remaining budget,
  the amount over budget (only when it is over) and the budget used as a
  percentage;
* **Budget status** as a pill (`within budget` / `approaching` / `over budget`),
  plus **Estimation confidence**;
* a **Context reduction** row when the history had to be trimmed, carrying the
  backend's own explanation;
* a configuration warning when the budget cannot work at all, and the budget
  caveat when the decision rests on an approximate count.

### 9.2 How selection works

There are two selections, and the panel always describes both:

* **Which turn** - the assistant answer the panel describes. Every answer has an
  `Analytics` action button (`aria-pressed`) and clicking the answer body points
  the panel at it too; on a narrow screen the `Analytics` button also opens the
  overlay.
* **Which model request** - the call inside that turn. The selector buttons set
  it, and it resets to the **last** call whenever the turn changes, so the summary
  always opens on the answer as it was finally produced.

* A **new answer is selected automatically** as soon as it is stored, including a
  refused `413` answer, which is exactly where the budget numbers matter most.
* Selecting a turn marks its row in the conversation (`.is-selected`) and sets
  that row's button to `aria-pressed="true"`; the two can never disagree because
  both are derived from the same stored id.
* If the selected turn is deleted, or a different conversation is opened, the
  selection falls back to the newest assistant turn of the active conversation,
  and to nothing at all when there is none.
* Requests are never re-sent to build the dashboard: every number shown is the one
  that was stored with that answer.

### 9.3 Responsive behaviour

| Width | Behaviour |
| --- | --- |
| `> 1080px` | Panel is a fixed grid column, always visible; no topbar button. |
| `<= 1080px` | Panel becomes a right-hand overlay opened from the topbar `gauge` button, closed by its own `×`, its scrim, or `Escape`. The chat keeps full width. |
| `<= 900px` | The conversation sidebar becomes its usual drawer (unchanged). |

The panel never replaces or hides provider usage: the compact `Token Usage` and
`Context & Budget` indicators stay in the message action row exactly as before, so
the dashboard is additive.

## 10. Where to look in the code

Backend functions live in `agent/tokenizer.py`, `agent/context_budget.py`,
`agent/chat.py` and `config.py`; frontend functions live in `static/js/`.

| Function | Responsibility |
| --- | --- |
| `heuristic_text_tokens()` | The documented fallback counter (`ceil(characters / 4)`). |
| `read_tokenizer_backend()`, `read_tokenizer_name()`, `read_truthy_env()` | Read the tokenizer settings, with documented defaults. |
| `model_base_name()` | Strip a provider routing suffix before asking tiktoken about a model. |
| `try_tiktoken_tokenizer()`, `try_huggingface_tokenizer()` | Try one backend, and describe honestly what it is worth. |
| `heuristic_descriptor()`, `load_tokenizer()` | Choose the tokenizer (with caching) and always return a usable descriptor. |
| `build_tokenizer_metadata()`, `tokenizer_label()`, `estimation_status_label()` | Turn a descriptor into JSON-safe metadata and human labels. |
| `message_text_for_estimate()`, `estimate_context()` | Turn one prepared request into a token estimate with a breakdown and tokenizer metadata. |
| `read_positive_int_env()`, `context_budget_settings()` | Read the budget from `.env`, with documented defaults. |
| `context_budget_for_call()` | Compare an estimate with the budget and label its state. |
| `enforce_context_budget()` | Reduce the history safely, or explain why the request cannot be sent. |
| `context_call_record()`, `estimation_discrepancy()`, `summarize_context()` | Describe each call and the answer as a whole. |
| `run_chat_with_tools()` | Run the check before every model call and collect the records. |
| `buildContextPanel()`, `buildUsagePanel()` in `static/js/app.js` | Render the compact `Context & Budget` and `Token Usage` cards. |
| `renderAnalytics()`, `analyticsCallTable()`, `analyticsTokenCard()`, `analyticsBudgetCard()`, `analyticsCallsSelector()` in `static/js/app.js` | Build the analytics dashboard for the selected turn. |
| `selectAnalyticsTurn()`, `syncSelectedTurn()`, `openAnalytics()`, `closeAnalytics()`, `onAnalyticsClick()` in `static/js/app.js` | Keep the panel and the selected turn in agreement, and drive the overlay on narrow screens. |
| `cleanEstimate()`, `cleanBudgetVerdict()`, `cleanContext()`, `cleanEnum()` in `static/js/store.js` | Keep the stored data - including every new tokenizer field - trustworthy when a conversation is reloaded. |
| `.workspace`, `.analytics*`, `.topbar__analytics` in `static/app.css` | Lay out the three-part workspace and the overlay behaviour below 1080px. |



