# Initial Setup

The primary reference for setting this project up on a fresh Windows machine:
from an empty folder to the chat app answering with **provider-reported token
usage**. Every command is PowerShell and appears once, in the order you need it,
so run the sections from top to bottom.

**What the project is.** Token Harbor Chat: a FastAPI backend (`app.py`) that
serves the static chat front end in `static/`, calls an OpenAI-compatible model
configured in `.env`, and can run two tools (`write_file`, `web_search`). Every
answer carries provider-reported token usage and this app's context-budget
numbers. The runtime does **no local token counting**: the provider's *actual*
input usage for a completed response is the only thing that decides whether the
conversation is compacted.

**Facts verified against the current code** (the source of truth, not older
notes):

| Fact | Where it comes from |
| --- | --- |
| Entry point and port | `app.py`: `uvicorn.run(app, host="127.0.0.1", port=8000)` |
| Routes | `app.py`: `/` (chat page), `/api/config`, `/api/chat` |
| Runtime packages | `requirements.txt` and the imports in `app.py`, `config.py`, `agent/`, `tools/` |
| Token estimation | Removed entirely: no tokenizer module and no local token counting; see `docs/CONTEXT_BUDGET.md` |
| `.env` keys | `config.py` (`ENV_*` names) and `tools/web_search.py` (`TAVILY_API_KEY`) |

## A. Prerequisites

* **Windows 10 or 11 with PowerShell.** Every command below is written for it.
* **Python.** This project's `.venv` was created with CPython **3.13.14** (see
  `.venv\pyvenv.cfg`), and that is the version every command in this guide is
  written against. A newer 3.x release is expected to work, but it has not been
  verified here. Check what you have:
  ```powershell
  python --version
  ```
* **Git**, only if you still need to clone the project.
* **Internet access** for the package installs and the model and search calls the
  app makes while running.
* **No other system tools.** The tools use the standard library (`urllib`), and
  the web server (`uvicorn`) is installed by pip in step F.

## B. Clone or open the project

The project is published at `https://github.com/pouyaMardani/Ai-Agent` (branch
`main`). Clone it next to nothing else, or into the folder you want to use:

```powershell
git clone https://github.com/pouyaMardani/Ai-Agent.git D:\AI\python-ai
cd D:\AI\python-ai
```

If the project is already on this machine, just open the folder instead; any
path works, and the rest of this document assumes you are in the project root.

`.env` is deliberately **not** in the repository (`.gitignore` lists it), so a
fresh clone has no secrets yet - that is what section H is for.

## C. Create the virtual environment

```powershell
cd D:\AI\python-ai
python -m venv .venv
```

This creates the `.venv` folder next to `app.py`. Nothing is installed into the
system Python.

## D. Activate the virtual environment

```powershell
.\.venv\Scripts\Activate.ps1
```

The prompt should now start with `(.venv)`. Alternatives:

```powershell
.\.venv\Scripts\activate.bat          # cmd.exe or a batch script
```

```bash
source .venv/Scripts/activate         # Git Bash
```

Troubleshooting note only: if PowerShell refuses with *"running scripts is
disabled on this system"*, allow scripts **for this window only** - no permanent
system change is needed:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

If you would rather not change anything at all, call the interpreter directly
for every command in this document, for example
`.\.venv\Scripts\python.exe app.py`.

## E. Upgrade pip

```powershell
python -m pip install --upgrade pip
```

## F. Install the project dependencies

```powershell
python -m pip install -r requirements.txt
```

`requirements.txt` is the source of truth: it pins the four core runtime packages
with the versions this project uses.

| Package | What it is for |
| --- | --- |
| `fastapi==0.150.0` | HTTP layer, the static mount and the `/api/*` routes |
| `uvicorn==0.54.0` | ASGI server that `python app.py` starts |
| `pydantic==2.14.1` | request body model for `POST /api/chat` |
| `openai==3.35.1` | OpenAI-compatible client used for the provider |

**How the project was built up.** The first install of the backend was the four
core packages, unpinned:

```powershell
python -m pip install pydantic openai fastapi uvicorn
```

They are pinned in `requirements.txt` now, which is why the command above is the
one to use today; the four names are listed only once as a live command.

Two commands from the project history are **no longer needed** - do not run them
and do not add them to `requirements.txt`:

| Historical command | Verdict | Why |
| --- | --- | --- |
| `python -m pip install python-dotenv` | not required | `config.py` reads `.env` itself in `load_env_file()` and imports only `os` and `pathlib`. Nothing in the project imports `dotenv`. |
| `python -m pip install pytest` | optional tooling | `tests/` are `unittest`-style suites and run on the standard library (see *Optional checks*). Nothing references pytest; install it only if you prefer its output. |

The tokenizer packages (`huggingface_hub`, `transformers`) are **gone**:
token estimation was removed, so the runtime no longer needs them and they are not
in `requirements.txt`. If an older environment still has them installed, they are
inert; there is nothing to load them.

## G. Token estimation (removed)

There is no tokenizer step any more. Token estimation was removed from the project
entirely: `agent/tokenizer.py`, its Hugging Face / tiktoken / heuristic backends, its
`TOKENIZER_*` settings and its downloaded files were all deleted. The provider's
reported usage is the only token measurement, and the app never loads a local
tokenizer while answering a request. Skip straight to section H.

## H. Environment configuration (`.env`)

`config.py` loads `.env` from the project root itself (in `load_env_file()`), so
no extra package is needed, and a variable that already exists in the environment
wins over the file. Create `D:\AI\python-ai\.env` with your own values. The file
is in `.gitignore`: never commit it, and never paste its contents anywhere else.

```env
# --- Model provider (OpenAI-compatible) -----------------------------------
OPENAI_API_KEY=<your provider API key>
BASE_URL=<your provider base URL, ending in /v1>
MODEL_ID=deepseek-v4.1-flash:free

# --- Optional: internet search used by the web_search tool ----------------
TAVILY_API_KEY=<your Tavily API key>

# --- Context compaction (optional: these are the defaults) ----------------
# Fold the oldest saved messages into a summary once the provider's ACTUAL input
# for a completed response reaches this absolute token threshold.
COMPACTION_ENABLED=true
ACTUAL_INPUT_TOKEN_THRESHOLD=4659
COMPACTION_TARGET_RATIO=0.50

# --- Context management inside a turn (optional: these are the defaults) ---
# Manage large tool results before a model request once the provider's actual
# input for the previous response reached the compaction threshold: a result at
# or above the byte threshold becomes a marked managed representation whose raw
# content stays in a bounded in-memory store.
CONTEXT_PRIORITY_ENABLED=true
TOOL_RESULT_MANAGEMENT_ENABLED=true
TOOL_RESULT_LARGE_BYTES=4096
TOOL_RESULT_STORE_MAX_BYTES=5242880
```

| Key | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | yes | - | The provider key. Read in `config.py`, used only on the server. |
| `BASE_URL` | yes | - | OpenAI-compatible base URL of the provider. |
| `MODEL_ID` | yes | - | The model for every request; it is never taken from the browser. A `:free` suffix is a provider routing tier and is ignored by the app. |
| `TAVILY_API_KEY` | no | - | Only for the `web_search` tool; without it the tool reports that search is not configured. |
| `CONTEXT_WINDOW_TOKENS` | no | `8192` | Capacity the app budgets for, in tokens. Documented capacity and the basis of the 413 message; **not** a preflight. |
| `MAX_OUTPUT_TOKENS` | no | `1024` | Reserved for the model's answer. |
| `CONTEXT_SAFETY_MARGIN_TOKENS` | no | `512` | Slack kept free for provider overhead. |
| `COMPACTION_ENABLED` | no | `true` | Summary-based compaction of older messages. `false` never asks for a summary. |
| `ACTUAL_INPUT_TOKEN_THRESHOLD` | no | `4659` | The provider's **actual** input token count at or above which a completed response is compacted. An absolute count, not an estimate. |
| `COMPACTION_TARGET_RATIO` | no | `0.50` | Share of the saved history kept **verbatim** when the threshold is exceeded. Must be between 0 and 1; anything else keeps the default. |
| `CONTEXT_PRIORITY_ENABLED` | no | `true` | Order the reduction by the documented priority model. `false` keeps the base weights and the age decay, and says so in the analytics. |
| `TOOL_RESULT_MANAGEMENT_ENABLED` | no | `true` | Classify tool results and replace the expensive ones with a managed representation. `false` keeps every result exactly as the tool returned it. |
| `TOOL_RESULT_LARGE_BYTES` | no | `4096` | The UTF-8 byte size at or above which one tool result is large enough to manage. A byte measurement, not a token estimate. |
| `TOOL_RESULT_STORE_MAX_BYTES` | no | `5242880` | Size of the in-memory store holding the raw tool results behind managed representations (5 MiB). |

Obsolete variables that a `.env` may still carry but the app no longer reads:
`TOKENIZER_BACKEND`, `TOKENIZER_NAME`, `TOKENIZER_LOCAL_ONLY`, `TOKENIZER_MODEL_PATH`
(the tokenizer was removed), `COMPACTION_TRIGGER_RATIO` (replaced by
`ACTUAL_INPUT_TOKEN_THRESHOLD`), `ADAPTIVE_COMPACTION_ENABLED` and
`TOOL_RESULT_SUMMARY_THRESHOLD_RATIO` (the last estimation-era tool-result switches).
They are harmless; remove them at your convenience.

The values above are placeholders. Real key values are never repeated in this
document, are read on the server only, and never appear in the browser (not even
in `/api/config`, which returns just `{"ok": true}`), in a log line, or in a
model message.

## I. Run the application

The entry point is `app.py`, which starts uvicorn itself on `127.0.0.1:8000`:

```powershell
cd D:\AI\python-ai
.\.venv\Scripts\Activate.ps1
python app.py
```

Open **http://127.0.0.1:8000** in a browser. The routes are `/` (the chat page),
`/api/config` (a health check returning `{"ok": true}`) and `/api/chat` (one
message per request).

With the auto-reloader, which is convenient while editing:

```powershell
uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

Stop the server with `Ctrl`+`C`. Watch the console: `[tool] ...` lines appear
whenever a tool runs, and `[compaction] ...` / `[tool-results] ...` lines appear
when the provider's reported usage drives a change.

## J. Troubleshooting

**`pip` is not recognized.** Always use the module form, which works whatever the
PATH looks like: `python -m pip install ...`. If `python` itself is not
recognized either, Python is not on PATH: reinstall it from python.org with
"Add python.exe to PATH" checked, or call the interpreter by full path.

**`ModuleNotFoundError: No module named 'fastapi'`** (or `openai`, `pydantic`,
`uvicorn`). The virtual environment is not active, or step F was skipped. Run
`.\.venv\Scripts\Activate.ps1` (the prompt shows `(.venv)`), then
`python -m pip install -r requirements.txt`.

**Tokenizer messages.** There are none any more: token estimation was removed, so the
app never loads a tokenizer and cannot report a missing one. Any `[tokenizer] ...`
line in an old log comes from a previous build.

**Invalid `.env`.** The file is read as plain `KEY=VALUE` lines; there is no
validation layer. An unreadable number in `CONTEXT_WINDOW_TOKENS`,
`MAX_OUTPUT_TOKENS`, `CONTEXT_SAFETY_MARGIN_TOKENS`, `ACTUAL_INPUT_TOKEN_THRESHOLD` or
`TOOL_RESULT_LARGE_BYTES` falls back to the documented default, so a typo cannot
disable the app. If `OPENAI_API_KEY` is missing, the API answers `502` with a friendly
message and no key is ever printed. Keep the file in the project root next to `app.py`;
`load_env_file()` reads it from there.

**Port 8000 already in use** (`WinError 10048`, "address already in use"). Find
what holds the port and stop it, or run on another port:

```powershell
Get-NetTCPConnection -LocalPort 8000 | Select-Object OwningProcess
Stop-Process -Id <the pid you just saw>
```

```powershell
uvicorn app:app --host 127.0.0.1 --port 8001
```

**PowerShell refuses to activate the environment.** The message is
*"running scripts is disabled on this system"*. Allow it for the current window
only, which needs no administrator rights and changes nothing permanently:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

Otherwise use `.\.venv\Scripts\activate.bat` from `cmd.exe`, or skip activation
and call `.\.venv\Scripts\python.exe` directly.

**Compaction never seems to run.** It is decided after a response, and only starts
when the provider's **actual input** for that response reaches
`ACTUAL_INPUT_TOKEN_THRESHOLD` (4659 by default), so a short chat never compacts. A
response that reports no usage cannot trigger it at all, and no local estimate is used
in its place. Watch for the `[compaction] ...` console line and for the `Context
compaction` row in the analytics panel. A reason such as "too little saved history to
fold" means the saved history is too small to fold safely, which is the intended
behaviour. `COMPACTION_ENABLED=false` turns the feature off completely.

**Tool results are not being reduced.** Tool-result management only runs when the
provider's **actual input** for the previous response reached the compaction threshold,
so a turn that fits is left alone. A result is only replaced when it is at or above
`TOOL_RESULT_LARGE_BYTES` (4096 by default), has a matching tool call, is not already a
managed representation, and its raw content could be retained. The console says which of
those applied: `[tool-results] pass N: ... tool results managed this turn: X`, and the
analytics panel's `Tool Result Management` section lists the classification, the byte
sizes, the skipped reasons and the priority order.
`TOOL_RESULT_MANAGEMENT_ENABLED=false` turns the whole thing off.

**The model or the provider answers with an error.** The API returns `413` when the
provider refuses a request for being longer than its context limit. After such a refusal
the loop may fold history and re-send **once** (only while no tool has run yet); when it
cannot recover, the `413` explains it (nothing was measured locally beforehand) and the
conversation is left untouched. A provider or tool failure gives `502`, with a short
message in the browser and the raw error only in the server console. Check
`OPENAI_API_KEY`, `BASE_URL` and `MODEL_ID`, and the `usage`/`context` cards beside the
answer.

## K. Updating dependencies

Install the package into the active environment, then record it deliberately:

```powershell
python -m pip install <package>
python -m pip freeze > requirements.txt
```

`pip freeze` lists **every** installed package, including transitive ones that no
project file imports (`numpy` and `packaging`, for example, arrive with a package you
once installed), plus anything else you happen to have installed in the same
environment. It also rewrites `requirements.txt`, dropping its comments. So freeze is
something to do after a review, not after every install:

* Check `git diff requirements.txt` and keep only the four core packages the project
  really needs, with `==` pins.
* Keep the file's comment header.
* Confirm the result by installing from scratch in a throwaway environment:
  `python -m venv .venv-check; .\.venv-check\Scripts\python.exe -m pip install -r requirements.txt`.
* Do not add `python-dotenv` or `pytest` unless the code starts using them (see
  step F).

### Optional checks

The suites in `tests/` are `unittest`-style and mock every network call, so they
run offline:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -t .
```

### You are done when

1. `python app.py` prints the uvicorn line for `http://127.0.0.1:8000`.
2. The chat page loads there, and `/api/config` answers `{"ok": true}`.
3. A message gets an answer, and the `usage` card beside it shows the
   provider-reported input/output counts (no local estimate appears anywhere).
4. The analytics panel beside the chat shows the provider's actual tokens, the
   compaction threshold and the actual-vs-threshold comparison, and its
   **Copy Analysis** button copies the turn's full report.
5. Once a conversation grows large enough, the console prints a
   `[compaction] folded N of M saved-message group(s) after actual provider input
   X tokens (threshold T): ...` line, and the analytics panel shows a
   `Context compaction` row - while the chat itself still lists every message,
   because compaction only changes what is sent, and the compacted history is reused
   on the next request and the next user turn.

### Where to read more

* `docs/ARCHITECTURE.md` - the layout, the request flow and the safety rules.
* `docs/CONTEXT_BUDGET.md` - the context budget, post-response actual-usage
  compaction and the analytics panel field by field.
* `.agents/skills/python-ai-agent/SKILL.md` - the working conventions for changes
  to this project.



