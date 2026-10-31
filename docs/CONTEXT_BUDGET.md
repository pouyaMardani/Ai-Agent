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

## 2. Three token numbers that must not be confused

| | Number | Where it comes from | Field |
| --- | --- | --- | --- |
| **A** | Text token count | The active tokenizer, over the exact request text | `estimate.text_token_count` |
| **B** | Request-level estimated input | A plus documented structural overhead (message delimiters, tool-schema wrapper), produced by `estimate_context()` before the call | `estimate.estimated_input_tokens` |
| **C** | Provider-reported actual input | Token Harbor, after it serialised and counted the request | `context.calls[i].actual.input_tokens` |

A measures text this app can see, B adds documented estimates on top of A so it
describes a *request* rather than a measurement of one, and C is the provider's own
measurement of its own serialization. None of them stands in for another: B is
never presented as a provider count, C never becomes an estimate, and the panel
always says which is which.

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

Within a message the parts (role, content, tool-call arguments, tool-call id) are
counted separately and exactly once, which is what the breakdown in
[3.3](#33-the-token-estimation-breakdown) reports. Those text parts make up
`text_token_count` (metric A). The documented overhead per message (role
delimiters) and per tool schema (name and wrapper) is added on top and recorded
separately, which is what makes `estimated_input_tokens` (metric B) a
request-level number instead of a measurement.

A component that is genuinely absent (for example tool schemas on a call that may
not use tools) is reported as `null`, which means "not present", not "0 tokens".

### 3.1 Which tokenizer is used

`load_tokenizer(model)` picks a tokenizer in this order, highest priority first:

1. **The verified DeepSeek V4.1 tokenizer** (backend `huggingface`): the official
   `tokenizer.json` and `tokenizer_config.json` of `deepseek-ai/DeepSeek-V4.1-Flash`,
   read from the local directory in `TOKENIZER_MODEL_PATH`. The two files are checked
   against the size and git blob id published by that repository, and only that
   combination makes the count `compatible` and `exact` for the model this app sends
   requests to. A directory holding different files is still loaded, but labelled
   `unverified` (see [7.2](#72-getting-the-deepseek-tokenizer-files)).
2. **An explicitly configured tokenizer** (`TOKENIZER_NAME`, an id or a path), from
   local files only unless `TOKENIZER_LOCAL_ONLY` is false, labelled `unverified`
   unless it is one of the verified DeepSeek V4.1 repositories.
3. **tiktoken**, when this tiktoken installation recognises the configured model
   (`tiktoken.encoding_for_model`). No tiktoken encoding is DeepSeek's tokenizer, so
   for this app's model a tiktoken count is always labelled `estimated`. A routing
   suffix such as `:free` is stripped first, because it selects a provider tier, not
   a different tokenizer.
4. **tiktoken with an explicitly configured encoding** (`TOKENIZER_NAME`, or
   `cl100k_base` when the backend was requested by name), labelled `unverified`.
5. **The character heuristic**, always available and clearly labelled approximate.

`TOKENIZER_BACKEND` narrows that list: `auto` walks it, `huggingface` allows steps
1-2 only, `tiktoken` steps 3-4 only, and `heuristic` goes straight to step 5. When
an explicitly selected backend cannot be loaded, the reason is logged and written
into `estimation_notes`, and the heuristic supplies the numbers - never a different
tokenizer presented as the one that was asked for.

Each descriptor is cached per
`(model, backend, TOKENIZER_NAME, TOKENIZER_MODEL_PATH, local_only)`, so a slow
tokenizer load happens once per process, not once per call.

### 3.2 What the count is called

| Backend | Compatibility | Status | Method string |
| --- | --- | --- | --- |
| Verified DeepSeek V4.1 files, verified model | `compatible` | `exact` | `huggingface:deepseek-ai/DeepSeek-V4.1-Flash` |
| Hugging Face, any other source | `unverified` | `estimated` | `huggingface:<name>` |
| tiktoken knows the model (not a DeepSeek V4.1 model) | `compatible` | `exact` | `tiktoken:<encoding>` |
| tiktoken used with this app's DeepSeek model | `unverified` | `estimated` | `tiktoken:<encoding>` |
| tiktoken, encoding unverified | `unverified` | `estimated` | `tiktoken:<encoding>` |
| character heuristic | `unsupported` | `heuristic` | `heuristic` |

The status is what the UI repeats: `exact token count`, `tokenizer estimate` or
`heuristic estimate`. Only a count this app can point at evidence for is ever
called exact; everything else says so plainly.

An exact count of the *text* is still not an exact count of the *request*: the
per-message and per-tool overhead added on top is a small approximation, and the
provider's own measurement covers its own serialisation of the request as well.
`estimation_notes` says this in words, and `discrepancy` compares the estimate with
what the provider reported once the call is done.

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
* No extra API call is ever made to estimate context size, and tokenizer files are
  fetched once, by hand, during the setup in
  [7.2](#72-getting-the-deepseek-tokenizer-files).
* tiktoken has no DeepSeek encoding, so a tiktoken count for this app's model is an
  approximation: OpenAI API compatibility does not imply an OpenAI tokenizer.
* `tiktoken`, `transformers` and `tokenizers` are **not** dependencies of this
  project. When none of them is installed and no tokenizer files are present, the
  heuristic is the answer, and the panel says so instead of guessing which method
  "should" have been used.

### 3.3 The token estimation breakdown

Every call stores `estimate.breakdown`, the decomposition behind metrics A and B:

```json
"breakdown": {
  "rows": [
    { "key": "system_content", "tokens": 348, "measurement": "tokenizer" },
    { "key": "user_content", "tokens": 41, "measurement": "tokenizer" },
    { "key": "tool_call_arguments", "tokens": 0, "measurement": "tokenizer" },
    { "key": "tool_call_ids", "tokens": 0, "measurement": "tokenizer" },
    { "key": "role_labels", "tokens": 6, "measurement": "tokenizer" },
    { "key": "tool_definitions", "tokens": 394, "measurement": "tokenizer" },
    { "key": "message_overhead", "tokens": 8, "measurement": "estimated" },
    { "key": "tool_definition_overhead", "tokens": 16, "measurement": "estimated" },
    { "key": "provider_serialization", "tokens": null, "measurement": "unknown" }
  ],
  "estimated_overhead_tokens": 24,
  "tool_schema_count": 2
}
```

| Row | Measurement | What it is |
| --- | --- | --- |
| `system_content`, `user_content`, `assistant_content`, `tool_content`, `other_message_content` | `tokenizer` | The content text of each message, grouped by the role that carried it. |
| `structured_content` | `tokenizer` | Content that is not a string, counted as the JSON this app sends; how a provider counts images inside it is not something this app knows. |
| `tool_call_arguments` | `tokenizer` | The serialised `tool_calls` of an assistant message. |
| `tool_call_ids` | `tokenizer` | The id that ties a tool result to the call it answers. |
| `role_labels` | `tokenizer` | The role strings (`system`, `user`, `tool`, ...) sent with each message. |
| `tool_definitions` | `tokenizer` | The JSON schema of every tool offered with this call. |
| `message_overhead` | `estimated` | `MESSAGE_OVERHEAD_TOKENS` (4) per message, for role delimiters. |
| `tool_definition_overhead` | `estimated` | `TOOL_OVERHEAD_TOKENS` (8) per schema, for the function wrapper. |
| `provider_serialization` | `unknown` | The provider's chat template, separators and special tokens. Not visible from this app, so it carries no number rather than a guess. |

The rows always add up: the `tokenizer` rows sum to `text_token_count` (A) and the
`estimated` rows to `breakdown.estimated_overhead_tokens`, so A + overhead = B. The
panel shows the same rows under **Token Estimation Breakdown**, with a totals table
for A, the overhead, B, C, and the *unaccounted difference* (`C - B`). That
difference is reported as a number only: it is never assigned to a component,
because doing so would mean guessing what Token Harbor does internally.

Cached input is an informational metric of its own. When the provider reports it,
the panel and the copied report show it on its own line and never add it to the
actual input, because it is already inside it.

A turn with several model requests keeps one breakdown per request, and
`context.estimate_totals` adds those requests up once each - a request the budget
refused is not a model call and is left out - so no breakdown is counted twice.

### 3.4 Adaptive context management (compaction and tool results)

When the estimate above grows past a share of the input budget, context management
reduces what is sent - it never touches the stored conversation. It runs before
**every** model request, including between tool rounds, and it has two jobs in a
fixed order: fold older *conversation* messages into the summary, then manage the
*tool results* that dominate the rest of the request.

```text
COMPACTION_TRIGGER_RATIO           0.70   share of the input budget that starts a pass
COMPACTION_TARGET_RATIO            0.50   share the reduced request should come back to
TOOL_RESULT_SUMMARY_THRESHOLD_RATIO 0.15  share at which a single result counts as large
```

| Step | What happens |
| --- | --- |
| 1 | The prepared request (messages *and* the tool schemas of that call) is estimated with the same estimator the budget uses. Below the trigger the pass ends here: no summary request, no tool-result summary, no change. |
| 2 | Older saved conversation messages are folded into the summary first ([3.4.1](#341-conversation-compaction)). The saved-history block is grouped so an assistant tool-call message plus the tool results answering it stay one group, the system prompt and the newest user message are never eligible, and a group is always folded whole. |
| 3 | Folding stops when the projected request fits the target, or when one more group would leave fewer than 512 tokens of verbatim recent history. |
| 4 | If the request is still above the target, tool results are reduced next ([3.5](#35-tool-result-management)) - least important first, so the newest round, relevant results and critical failures are reduced last. |
| 5 | The request context is rebuilt from the system prompt plus the summary, the newest saved messages verbatim, this turn, and the managed tool results. It is estimated again, and the existing enforcement decides whether it may be sent. |
| 6 | If it still cannot fit, nothing is claimed and nothing is invented: `enforce_context_budget()` trims the oldest remaining history or refuses with the usual `413`. |

#### 3.4.1 Conversation compaction

* **What is eligible**: only the saved-history block. Tool results are never folded
  into the conversation summary - they are managed separately, which is what keeps a
  tool call and its result a valid pair.
* **How**: one dedicated model request with **no tools**, receiving the previous
  summary plus the turns being folded in, and returning a structured summary (facts,
  decisions, user requirements, current task, technical details, unresolved
  questions) that separates confirmed facts from uncertainty. The reply is validated
  - non-empty, sized, not a verbatim repeat of the previous summary - before it
  replaces anything.
* **Never twice for the same content**: the stored summary records the newest message
  it covers, so a later pass only folds what came after it. When the request can
  already be reduced with the existing summary, that summary is reused without a
  model call; when the boundary message has left the browser's history window, the
  folded range is summarised again with an explicit "some of this may already be
  described" instruction.
* **Where it is stored**: `compaction` travels with the conversation, exactly like
  the messages do: the browser stores it, sends it back with the next request, and
  the server sanitises it again on arrival.

The turn reports, and the panel shows, every pass: how many ran, how many changed
something, how many found nothing left to reduce, the estimate before and after, and
- for tool results - what was classified, replaced and saved. A pass that cannot get
the request under the budget does not claim success: the normal trimming and refusal
behaviour still applies, which is what stops a failed reduction from silently
bypassing the budget.

### 3.5 Tool-result management

Tool output is where a tool-calling request usually gets into trouble: one turn can
accumulate several thousand tokens of results across three rounds. Tool results are
therefore managed on their own, with their own classification, their own summary
request and their own retention - and never by deleting or reordering a tool message,
because its `tool_call_id` has to keep matching the assistant message that asked for
it.

| Class | Rule (deterministic) | Treatment |
| --- | --- | --- |
| `critical` | The result reports a failure (`ok: false` or an `error`) | Reduced only by deterministic trimming: reported fields and error text verbatim, plus the first 600 and last 200 characters of the body, with the sizes stated. A failure's exact words are never paraphrased. |
| `small` | At or below 200 tokens | Kept exactly as the tool returned it. |
| `large` | At or above `TOOL_RESULT_SUMMARY_THRESHOLD_RATIO` (0.15) of the input budget | Summarised by a dedicated no-tools request when the request needs the room. |
| `normal` | Everything else | Kept unless the request needs the room; then summarised like a large result. |

What a replacement looks like: the tool message keeps its `role` and its
`tool_call_id`, and its content becomes a marked managed representation -
`[managed tool result]`, the tool name, the tool's status, the original token count,
the id of the retained raw result, the mode (`summarized` or `trimmed`), the
condensed text, and a closing line saying that this is data, never instructions. The
model can therefore tell a condensed result from a complete one.

Retention and retrieval:

* Raw content is kept in a bounded in-memory store keyed by `tool_call_id`
  (`TOOL_RESULT_STORE_MAX_BYTES`, default 5 MiB), oldest entries evicted first. A
  turn's own results are its newest entries, so eviction can only reach older turns,
  and an entry larger than the whole budget is refused rather than stored.
* Before anything is replaced, the retained copy is read back: a result whose raw
  content cannot be recovered is left in full. That read-back is counted in the
  analytics as a retrieval, together with any other internal read of a retained
  result.
* Retrieval is internal (`tool_result_manager.retrieve_raw`). This phase adds no
  endpoint and no user-facing tool; it makes the original recoverable for the turn
  and for the code paths that need it.
* The store is process memory, so it starts empty after a restart. That is safe here:
  this app keeps no server-side conversation, and tool results only ever exist inside
  a turn.

Order of reduction: least important first, using the priority model documented in
`docs/ARCHITECTURE.md` (Priority scoring). Older and unrelated results go before
recent ones, a result that shares a term with the current request is kept longer, a
large result is preferred over a small one, and a critical failure is reduced last. A
result that is already a managed representation is never summarised again.

Honest limits:

* The provider's own serialization is still invisible, so a managed request keeps the
  same estimate-versus-actual difference as any other request.
* Only the history the browser sent (the newest 40 messages) can be folded, so a
  conversation whose stored history sits mostly outside that window compacts less
  than it could.
* The conversation summary is model-written text carried by the client. The server
  bounds its type and length, but its content is only ever as good as the summary
  request.
* A tool summary is model-written too, and it is written once: a later pass does not
  re-summarise a managed result.
* The store is bounded, so a managed representation can outlive its raw copy. The
  representation still states the original size, but that original is then no longer
  retrievable.
* Tool results are only ever managed inside a turn, because the browser never sends
  tool messages back to the server.
* Summaries and management requests cost tokens of their own. They are reported
  separately (`compaction` and `tool_results` in the context payload) and are never
  counted as agent model calls in the provider usage.

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

Before the first of those calls, the request is also offered to compaction
([3.4](#34-summary-based-compaction)), which may rebuild it around the stored
summary. Compaction runs once per turn, so the calls below always describe the same
request context they were sent with.

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

These are optional. Without them the app looks for the verified DeepSeek V4.1
tokenizer in the default directory, and otherwise falls back to the documented
heuristic.

```dotenv
# auto | huggingface | tiktoken | heuristic
TOKENIZER_BACKEND=auto

# Local directory holding the verified DeepSeek V4.1 tokenizer files.
TOKENIZER_MODEL_PATH=./tokenizers/deepseek-v4.1

# A second, explicit source: a Hugging Face tokenizer id or path. With the
# tiktoken backend, this is the encoding name (for example o200k_base).
TOKENIZER_NAME=

# Never download a tokenizer at request time.
TOKENIZER_LOCAL_ONLY=true
```

| Setting | Default | Notes |
| --- | --- | --- |
| `TOKENIZER_BACKEND` | `auto` | `auto` prefers the verified DeepSeek V4.1 tokenizer, then an explicitly named one, then tiktoken, then the heuristic. `huggingface` and `tiktoken` restrict the app to that one backend. Any unrecognised value falls back to the default, so a typo cannot disable estimation. |
| `TOKENIZER_MODEL_PATH` | `./tokenizers/deepseek-v4.1` | Directory holding `tokenizer.json` and `tokenizer_config.json`. A relative path is resolved against the folder that contains `app.py`, so no machine-specific path is needed. Missing files are named in the error and in `estimation_notes`. |
| `TOKENIZER_NAME` | unset | A Hugging Face tokenizer id, tried after `TOKENIZER_MODEL_PATH`. With `tiktoken`, it is the encoding name. When it cannot be used, the failure is recorded in `estimation_notes` rather than hidden. |
| `TOKENIZER_LOCAL_ONLY` | `true` | `true`, `1`, `yes`, `on` and `false`, `0`, `no`, `off` are recognised. Anything else keeps the default. `false` allows a Hugging Face id to be fetched once and then reused from the Hugging Face cache. |

Installing `transformers` (its `AutoTokenizer` is the integration used first) or the
smaller `tokenizers` package is enough to read `tokenizer.json`; `tiktoken` is a
separate backend. The verified DeepSeek V4.1 files are the only path this app
describes as an exact token count for its configured model.

### 7.2 Getting the DeepSeek tokenizer files

This is a one-time, manual setup: the app never downloads a tokenizer while it is
answering a request. The tokenizer that ships with the configured model is the
official one in the Hugging Face repository `deepseek-ai/DeepSeek-V4.1-Flash`;
`deepseek-ai/DeepSeek-V4.1-Flash-1017` ships byte-identical files (same sizes and
same git blob ids, checked against both repositories), so either gives the same
tokenizer.

```bash
pip install huggingface_hub transformers
hf download deepseek-ai/DeepSeek-V4.1-Flash tokenizer.json tokenizer_config.json --local-dir ./tokenizers/deepseek-v4.1
```

`pip install huggingface_hub tokenizers` does the same job with a smaller loader if
`transformers` is not wanted: both packages read the same `tokenizer.json`. Older
`huggingface_hub` releases spell that second command `huggingface-cli`, and the two
files can also be downloaded by hand from the repository's *Files and versions*
page. Only these two files are needed (about 6.4 MB); the model weights are not.

Restart the app afterwards. If the files are the official ones, the panel shows
`Hugging Face (deepseek-ai/DeepSeek-V4.1-Flash)`, `Matches this model` and `Exact
token count`, and the console prints the active backend once per process. If the
files are missing or different, the reason appears in `estimation_notes` and the
counts stay labelled approximate.

The active model (`MODEL_ID`) and every budget value are shown in the panel, so you
can confirm what was actually in force for a response. Changing `.env` requires
restarting the app (or reloading with `uvicorn --reload`); the budget is read once
per assistant turn, so every call inside one answer is judged by the same numbers.

### 7.3 Compaction settings

Compaction is part of the budget: it is expressed as shares of the input budget the
settings above produce, and it never replaces enforcement.

```dotenv
# Fold older saved messages into a summary when the request reaches this share
# of the input budget, and aim to come back down to this one.
COMPACTION_ENABLED=true
COMPACTION_TRIGGER_RATIO=0.70
COMPACTION_TARGET_RATIO=0.50
```

| Setting | Default | Notes |
| --- | --- | --- |
| `COMPACTION_ENABLED` | `true` | `true`, `1`, `yes`, `on` and `false`, `0`, `no`, `off` are recognised. `false` keeps the previous behaviour exactly: no summary request is ever made. |
| `COMPACTION_TRIGGER_RATIO` | `0.70` | A share of the **input budget**, not of the context window. Anything that is not between 0 and 1 keeps the default; an input budget of zero disables compaction, because there is nothing to measure against. |
| `COMPACTION_TARGET_RATIO` | `0.50` | The goal for the compacted request. If it is not below the trigger, both ratios fall back to their defaults, so a typo cannot make every request compact. |

The summary itself is not configured here: it belongs to each conversation, stored
by the browser beside its messages, sent back with the request and sanitised by the
server. Editing it outside the app is not supported, and clearing a conversation
clears its summary with it.

### 7.4 Context management settings

Adaptive management and tool-result management are part of the budget too: their
thresholds are shares of the same input budget, and they never replace enforcement.

```dotenv
# Manage context before every model request, not only the first one.
ADAPTIVE_COMPACTION_ENABLED=true
CONTEXT_PRIORITY_ENABLED=true

# Manage tool results on their own: classify them, and summarise the ones that
# outgrow this share of the input budget.
TOOL_RESULT_MANAGEMENT_ENABLED=true
TOOL_RESULT_SUMMARY_THRESHOLD_RATIO=0.15

# Bounded in-memory store for the original tool output (5 MiB).
TOOL_RESULT_STORE_MAX_BYTES=5242880
```

| Setting | Default | Notes |
| --- | --- | --- |
| `ADAPTIVE_COMPACTION_ENABLED` | `true` | When `false`, context is managed only before the first model call of a turn, exactly as in the previous phase. |
| `CONTEXT_PRIORITY_ENABLED` | `true` | When `false`, the reduction order still follows the documented base weights and age decay, and the analytics say scoring was disabled. |
| `TOOL_RESULT_MANAGEMENT_ENABLED` | `true` | `false` keeps every tool result exactly as the tool returned it. An input budget of zero also switches management off, because there is nothing to measure against. |
| `TOOL_RESULT_SUMMARY_THRESHOLD_RATIO` | `0.15` | The share of the input budget at or above which a single result counts as *large*. Must be between 0 and 1; anything else keeps the default. With the defaults (input budget 6,656) that is 998 tokens. |
| `TOOL_RESULT_STORE_MAX_BYTES` | `5242880` | Size of the in-memory store of raw tool results. A single result larger than this is never retained, and is therefore never replaced. |

## 8. Data shape (short reference)

`POST /api/chat` keeps its old fields (`reply`, `model`, `steps`, `usage`) and adds
an optional `context`, plus an optional `compaction` that is present only when the
conversation's stored summary changed during that turn:

```jsonc
{
  "reply": "...",
  "model": "...",
  "compaction": { "summary": "Project / Conversation Context\n...",
                  "summary_version": 1, "last_compacted_message_id": "m_ab12...",
                  "compaction_count": 2, "last_compacted_at": 1761234567890 }
}
```

The request body may carry the same `compaction` object back, next to the message
and the history (each history entry may name its message id). Anything that is not
that shape is ignored, so a conversation saved before compaction existed keeps
working:

```jsonc
{
  "message": "...",
  "history": [ { "role": "user", "content": "...", "id": "m_ab12..." } ],
  "compaction": null
}
```

Inside `context`, the turn also reports what compaction did before its first call:

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
    "compaction": { "attempted": true, "applied": true, "reused": false, "reason": null,
                    "compacted_messages": 24, "estimate_before": 6100,
                    "estimate_after": 3120, "met_target": true,
                    "trigger_tokens": 4659, "target_tokens": 3328, "attempts": 2 },
    "tool_results": {
      "available": true, "results": 9,
      "classified": { "small": 2, "normal": 5, "large": 1, "critical": 1 },
      "managed_results": 3, "managed_this_turn": 3, "summarized": 2, "trimmed": 1,
      "unchanged": 6, "original_tokens": 7414, "managed_tokens": 1204,
      "saved_tokens": 6210, "retrievals": 3,
      "priority": { "enabled": true, "reducible": 4,
                    "decisions": [ { "index": 6, "kind": "tool_older", "score": 42,
                                     "tokens": 812, "reason": "tool_older base (+150); large tool result (-100); 4 message(s) from the newest (-8)" } ] },
      "adaptive": { "passes": 2, "changed": 1, "blocked": 1 },
      "management_requests": { "calls": 2, "failures": 0 },
      "store": { "entries": 4, "bytes": 51234, "max_bytes": 5242880,
                 "evictions": 0, "refused": 0, "retrievals": 3 },
      "skipped_reasons": { "small enough to keep as it is": 2 },
      "notes": [ "1 result(s) report a failure: they are kept, and reduced only by deterministic trimming when the request needs it" ]
    },
    "rejected": false,
    "context_growth_tokens": 412,
    "calls": [
      {
        "call_index": 1,
        "estimate": { "estimated_input_tokens": 812, "text_token_count": 784,
                      "breakdown": { "rows": [ { "key": "system_content", "tokens": 348,
                                                 "measurement": "tokenizer" }, "..." ],
                                     "estimated_overhead_tokens": 28, "tool_schema_count": 2 },
                      "system_prompt_tokens": 348,
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
* `text_token_count` (A) and `estimated_input_tokens` (B) are different numbers:
  the `breakdown.rows` marked `tokenizer` add up to A, the rows marked `estimated`
  add up to `breakdown.estimated_overhead_tokens`, and A plus that overhead is B.
  `context.estimate_totals` adds a turn's requests up once each, leaving out a
  request the budget refused.
* `context_growth_tokens` is the difference between the first and the last estimate
  of the answer, which is how much the tool loop grew the request.
* `context.compaction` is the report of the compaction attempt for that turn, and
  the top-level `compaction` is the *metadata to store*: the summary itself, the
  message it covers, its version, how many times it has been updated and when. The
  report never carries conversation text, so storing it with the analytics does not
  duplicate the summary. A turn where compaction never ran has `compaction: null`.
* `context.tool_results` is the tool-result management report: how many results the
  request carried, their classes, what was replaced, the original and managed sizes,
  the estimate saved, the raw-result retrievals, the adaptive pass counts, the
  management request counts and the priority decisions with their reasons. Every
  number in it is this app's tokenizer estimate, and it never mixes with `usage`,
  which stays provider-reported only. A management request (a conversation summary
  or a tool-result summary) is counted there and never appears in `usage.model_calls`.

A refused turn answers `413` with `{"detail": "...", "rejected": true, "model":
"...", "context": { ... "rejected": true ... }, "compaction": { ... }}` and no
`usage`, because no model call happened. The `compaction` entry is there only when
a summary was generated before the request was refused, so the browser can keep it
instead of building the same summary again on the next message.

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
* a collapsible **Token Estimation Breakdown** for the selected request: one row
  per component with its token count and how it was measured (`Tokenizer`,
  `Estimated` or `Unknown`), followed by the totals for the measured text, the
  estimated overhead, the request-level estimate, the provider's actual input and
  the unaccounted difference. When the turn had several model requests, the
  summary names the call the breakdown belongs to and the notes carry the
  turn-wide sum, so two calls can never be read as one.
* a **Context compaction** row when compaction ran for that turn, saying whether the
  older messages were summarised, whether the stored summary was reused, or why
  nothing was compacted (the reason is the row's tooltip), plus an **Input after
  compaction** row with the re-measured estimate.
* a **Tool result management** row - how many tool results were replaced and roughly
  how many tokens that saved - and, underneath it, a collapsible **Tool Result
  Management** section: the classification table (small, normal, large, critical),
  the totals for original and managed size, the estimated tokens saved, the summaries
  written, the deterministic trims, the raw-result retrievals, the adaptive pass
  counts, the retained store (entries and bytes) and the priority order with the
  reasons behind each score.

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

**Copy Analysis** sits in the panel header, beside the close button. It copies one
plain-text report for the whole selected turn: every value the two cards hold, all
the model calls of the turn, the tool counts, the context-management numbers and
the warnings, so the numbers can be pasted into ChatGPT or another model for
analysis. The report is built from the same snapshot the panel renders, so it
cannot disagree with what is on screen; a value that is not in that snapshot reads
`N/A`, estimates are always labelled as estimates, and no message text, prompt or
`.env` value is included. The button is disabled when the turn has no token or
context data, and copying is refused with a short message while a request is in
flight, so a stale snapshot never reaches the clipboard. `Copied!` replaces the
label for a moment after a success, and a browser that blocks the clipboard is
reported rather than failing silently.

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
| `heuristic_text_tokens()`, `memoized_counter()` | The documented fallback counter (`ceil(characters / 4)`), and the per-text count cache that stops the same text being encoded twice. |
| `read_tokenizer_backend()`, `read_tokenizer_name()`, `read_tokenizer_model_path()` | Read the tokenizer settings, with documented defaults. |
| `model_base_name()`, `is_deepseek_v41_model()` | Strip a provider routing suffix, and recognise the model the verified tokenizer was checked against. |
| `missing_tokenizer_files()`, `git_blob_oid()`, `verified_tokenizer_files()` | Check that the configured directory holds the official DeepSeek V4.1 tokenizer files. |
| `load_huggingface_tokenizer()`, `huggingface_descriptor()` | Load one directory or id, and describe honestly what the result is worth. |
| `try_tiktoken_tokenizer()`, `try_huggingface_tokenizer()` | Try one backend and return a descriptor, or a reason why nothing was loaded. |
| `heuristic_descriptor()`, `load_tokenizer()` | Choose the tokenizer (with caching) and always return a usable descriptor. |
| `build_tokenizer_metadata()`, `tokenizer_label()`, `estimation_status_label()` | Turn a descriptor into JSON-safe metadata and human labels. |
| `message_component_texts()`, `message_text_for_estimate()` | Split one prepared message into the text parts that are counted, or join them into the single text form. |
| `build_token_breakdown()`, `estimate_totals()` | Label every component with how it was measured, and add a turn's requests up once each. |
| `estimate_context()` | Turn one prepared request into the estimates, the text token count and the breakdown, plus tokenizer metadata. |
| `read_positive_int_env()`, `context_budget_settings()` | Read the budget from `.env`, with documented defaults. |
| `context_budget_for_call()` | Compare an estimate with the budget and label its state. |
| `enforce_context_budget()` | Reduce the history safely, or explain why the request cannot be sent. |
| `context_call_record()`, `estimation_discrepancy()`, `summarize_context()` | Describe each call and the answer as a whole. |
| `read_compaction_settings()`, `stored_compaction()`, `compact_request()` | Read the compaction ratios from the existing budget, sanitise the stored summary, and decide whether older saved messages should be folded into it. |
| `manage_context()`, `tool_results_report()`, `merge_history_report()` | Run one adaptive pass: estimate first, fold history, manage tool results, and report what the pass did and why. |
| `classify_result()`, `collect_tool_results()`, `classify_counts()` | Classify every tool result in a request from its size and its own metadata, with the reason for the class. |
| `manage_result()`, `managed_content()`, `trimmed_detail()`, `summarise_result()` | Replace one result with a marked managed representation, or leave it exactly as it was. |
| `ToolResultStore`, `store()`, `retrieve_raw()` | Retain raw tool results within a byte budget, evicting the oldest first, and retrieve an original again. |
| `rank_context_items()`, `score_item()`, `decision_summary()` | Score the items of a request deterministically and explain every score. |
| `message_groups()`, `groups_to_fold()`, `boundary_index()` | Keep a tool call with its tool results, choose how much history to fold with the existing estimates, and find where the stored summary ends. |
| `summary_request_messages()`, `generate_summary()`, `validate_summary()`, `request_context()` | Build the dedicated no-tools summary request, accept only a usable summary, and rebuild the request around it. |
| `run_chat_with_tools()` | Run the check before every model call and collect the records. |
| `buildContextPanel()`, `buildUsagePanel()` in `static/js/app.js` | Render the compact `Context & Budget` and `Token Usage` cards. |
| `renderAnalytics()`, `analyticsCallTable()`, `analyticsTokenCard()`, `analyticsBudgetCard()`, `analyticsCallsSelector()` in `static/js/app.js` | Build the analytics dashboard for the selected turn. |
| `analyticsBreakdownRows()`, `analyticsBreakdownTable()`, `analyticsBreakdownTotals()`, `analyticsBreakdownDetails()` in `static/js/app.js` | Render the per-request token estimation breakdown, its totals and its notes. |
| `selectAnalyticsTurn()`, `syncSelectedTurn()`, `openAnalytics()`, `closeAnalytics()`, `onAnalyticsClick()` in `static/js/app.js` | Keep the panel and the selected turn in agreement, and drive the overlay on narrow screens. |
| `analyticsSnapshot()`, `analyticsReportText()`, `analyticsCopyButton()`, `copyAnalyticsReport()` in `static/js/app.js` | Read the same snapshot the panel renders, turn it into the plain-text report, and copy it for sharing. |
| `analyticsCompactionState()`, `storedSummaryLabel()` in `static/js/app.js` | Turn the compaction report and the stored summary into the short labels the panel and the copied report show. |
| `cleanCompaction()`, `cleanCompactionReport()` in `static/js/store.js` | Keep the stored summary and the per-turn compaction report trustworthy when a conversation is saved or reloaded. |
| `cleanEstimate()`, `cleanBudgetVerdict()`, `cleanContext()`, `cleanEnum()` in `static/js/store.js` | Keep the stored data - including every new tokenizer field - trustworthy when a conversation is reloaded. |
| `.workspace`, `.analytics*`, `.topbar__analytics` in `static/app.css` | Lay out the three-part workspace and the overlay behaviour below 1080px. |



