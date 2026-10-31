# Initial Setup

The primary reference for setting this project up on a fresh Windows machine:
from an empty folder to the chat app answering with the **verified DeepSeek V4.1
tokenizer**. Every command is PowerShell and appears once, in the order you need
it, so run the sections from top to bottom.

**What the project is.** Token Harbor Chat: a FastAPI backend (`app.py`) that
serves the static chat front end in `static/`, calls an OpenAI-compatible model
configured in `.env`, and can run two tools (`write_file`, `web_search`). Every
answer carries provider-reported token usage, this app's context-budget numbers
and a tokenizer-based estimate.

**Facts verified against the current code** (the source of truth, not older
notes):

| Fact | Where it comes from |
| --- | --- |
| Entry point and port | `app.py`: `uvicorn.run(app, host="127.0.0.1", port=8000)` |
| Routes | `app.py`: `/` (chat page), `/api/config`, `/api/chat` |
| Runtime packages | `requirements.txt` and the imports in `app.py`, `config.py`, `agent/`, `tools/` |
| Tokenizer loading | `agent/tokenizer.py`, documented in `docs/CONTEXT_BUDGET.md` section 7 |
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
* **Internet access** for the package installs, the one-time tokenizer download,
  and the model and search calls the app makes while running.
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
with the versions this project uses, plus the two packages that read the
tokenizer. Installing all six is the supported path for a working installation.

| Package | What it is for |
| --- | --- |
| `fastapi==0.150.0` | HTTP layer, the static mount and the `/api/*` routes |
| `uvicorn==0.54.0` | ASGI server that `python app.py` starts |
| `pydantic==2.14.1` | request body model for `POST /api/chat` |
| `openai==3.35.1` | OpenAI-compatible client used for the provider |
| `huggingface_hub==2.4.0` | loads the local tokenizer files, and provides the `hf` command used in step G |
| `transformers==5.22.1` | reads the verified `tokenizer.json` through `AutoTokenizer` (it already depends on `tokenizers`) |

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

If you would rather not install the larger `transformers` package, install
`huggingface_hub` and `tokenizers` instead: `agent/tokenizer.py` accepts either
loader. There is no need to install both alternatives, because `transformers`
already brings `tokenizers` with it.

## G. Download the DeepSeek V4.1 tokenizer (one time)

```powershell
cd D:\AI\python-ai
hf download deepseek-ai/DeepSeek-V4.1-Flash tokenizer.json tokenizer_config.json --local-dir ./tokenizers/deepseek-v4.1
```

* **Only the tokenizer files** are downloaded: `tokenizer.json` and
  `tokenizer_config.json`, about 6.4 MB in total.
* **The model weights are not required** and are not downloaded; the model itself
  runs at the provider behind `BASE_URL`.
* This is a **one-time** operation. The application reads the files from the
  local directory and never downloads a tokenizer while answering a request.
* Run the command from the project root, so the directory matches
  `TOKENIZER_MODEL_PATH=./tokenizers/deepseek-v4.1`. A relative path there is
  resolved against the folder that holds `app.py`.
* `deepseek-ai/DeepSeek-V4.1-Flash` is the repository of the model this project
  sends requests to. The later update `deepseek-ai/DeepSeek-V4.1-Flash-1017`
  publishes byte-identical tokenizer files, so either repository works.
* Older `huggingface_hub` releases spell the command
  `huggingface-cli download ...`, and the same two files can be downloaded by
  hand from the repository's *Files and versions* page. Either way, the two
  files must end up in the `tokenizers/deepseek-v4.1` folder in the project root.
* `tokenizers/` is in `.gitignore`, so the downloaded files stay out of the
  repository.

Confirm the two files are there, then continue:

```powershell
Get-ChildItem .\tokenizers\deepseek-v4.1
```

The app validates them: it checks the size and git blob id published by the
DeepSeek repository, and only then is a count labelled `exact`. If the files are
missing or different, the reason appears in the console and in the analytics
panel, and the counts stay labelled approximate. The console prints one line per
process describing the active backend, for example
`[tokenizer] backend=huggingface name=deepseek-ai/DeepSeek-V4.1-Flash compatibility=compatible`.

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

# --- Tokenizer (optional: these are the defaults) -------------------------
TOKENIZER_BACKEND=auto
TOKENIZER_MODEL_PATH=./tokenizers/deepseek-v4.1
TOKENIZER_LOCAL_ONLY=true

# --- Context compaction (optional: these are the defaults) ----------------
# Fold the oldest saved messages into a summary once a request reaches the
# trigger share of the input budget, aiming to come back down to the target.
COMPACTION_ENABLED=true
COMPACTION_TRIGGER_RATIO=0.70
COMPACTION_TARGET_RATIO=0.50

# --- Context management inside a turn (optional: these are the defaults) ---
# Manage context before every model request, and manage tool results on their
# own: large results become a marked managed representation whose raw content
# stays in a bounded in-memory store.
ADAPTIVE_COMPACTION_ENABLED=true
CONTEXT_PRIORITY_ENABLED=true
TOOL_RESULT_MANAGEMENT_ENABLED=true
TOOL_RESULT_SUMMARY_THRESHOLD_RATIO=0.15
TOOL_RESULT_STORE_MAX_BYTES=5242880
```

| Key | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | yes | - | The provider key. Read in `config.py`, used only on the server. |
| `BASE_URL` | yes | - | OpenAI-compatible base URL of the provider. |
| `MODEL_ID` | yes | - | The model for every request; it is never taken from the browser. Keep the DeepSeek V4.1 Flash id so the tokenizer stays the verified one (a `:free` suffix is a provider routing tier and is ignored when the app checks compatibility). |
| `TAVILY_API_KEY` | no | - | Only for the `web_search` tool; without it the tool reports that search is not configured. |
| `CONTEXT_WINDOW_TOKENS` | no | `8192` | Capacity the app budgets for, in tokens. |
| `MAX_OUTPUT_TOKENS` | no | `1024` | Reserved for the model's answer. |
| `CONTEXT_SAFETY_MARGIN_TOKENS` | no | `512` | Slack kept free for estimation error and provider overhead. |
| `TOKENIZER_BACKEND` | no | `auto` | `auto`, `huggingface`, `tiktoken` or `heuristic`; an unrecognised value falls back to `auto`. |
| `TOKENIZER_MODEL_PATH` | no | `./tokenizers/deepseek-v4.1` | Local directory holding the verified tokenizer files. |
| `TOKENIZER_NAME` | no | unset | A second source: a Hugging Face id or path; with the `tiktoken` backend, the encoding name. |
| `TOKENIZER_LOCAL_ONLY` | no | `true` | `false` lets a Hugging Face id be fetched once and then reused from the Hugging Face cache. |
| `COMPACTION_ENABLED` | no | `true` | Summary-based compaction of older messages. `false` keeps the previous behaviour and never asks for a summary. |
| `COMPACTION_TRIGGER_RATIO` | no | `0.70` | Share of the **input budget** at which compaction runs. Must be between 0 and 1; anything else keeps the default. |
| `COMPACTION_TARGET_RATIO` | no | `0.50` | Share the compacted request should come back down to. Must be below the trigger, or both ratios fall back to their defaults. |
| `ADAPTIVE_COMPACTION_ENABLED` | no | `true` | Manage context before **every** model request, not only the first one of a turn. `false` restores the previous single-pass behaviour. |
| `CONTEXT_PRIORITY_ENABLED` | no | `true` | Order the reduction by the documented priority model. `false` keeps the base weights and the age decay, and says so in the analytics. |
| `TOOL_RESULT_MANAGEMENT_ENABLED` | no | `true` | Classify tool results and replace the expensive ones with a managed representation. `false` keeps every result exactly as the tool returned it. |
| `TOOL_RESULT_SUMMARY_THRESHOLD_RATIO` | no | `0.15` | Share of the input budget at which one tool result counts as *large*. Must be between 0 and 1; anything else keeps the default. |
| `TOOL_RESULT_STORE_MAX_BYTES` | no | `5242880` | Size of the in-memory store holding the raw tool results behind managed representations (5 MiB). |

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

Stop the server with `Ctrl`+`C`. Watch the console: the `[tokenizer] ...` line
from step G appears the first time a request is measured, and `[tool] ...` lines
appear whenever a tool runs.

## J. Troubleshooting

**`pip` is not recognized.** Always use the module form, which works whatever the
PATH looks like: `python -m pip install ...`. If `python` itself is not
recognized either, Python is not on PATH: reinstall it from python.org with
"Add python.exe to PATH" checked, or call the interpreter by full path.

**`ModuleNotFoundError: No module named 'fastapi'`** (or `openai`, `pydantic`,
`uvicorn`). The virtual environment is not active, or step F was skipped. Run
`.\.venv\Scripts\Activate.ps1` (the prompt shows `(.venv)`), then
`python -m pip install -r requirements.txt`.

**Tokenizer files missing.** The app logs `No tokenizer directory was found at
...` or names the file that is missing (`tokenizer.json`, `tokenizer_config.json`)
in the console and in the analytics panel's notes; the numbers stay labelled
approximate. Re-run the step G download from the project root and check the
folder with `Get-ChildItem .\tokenizers\deepseek-v4.1`.

**Tokenizer backend falls back to the heuristic.** Look at the console reason and
at the tokenizer rows in the analytics panel. The usual causes: the two files are
not in `TOKENIZER_MODEL_PATH`; `transformers` (or `tokenizers`) is not installed
in the active environment; or `TOKENIZER_BACKEND` names a backend that cannot
load. Fixes: complete steps F and G, keep `TOKENIZER_BACKEND=auto`, and restart
the app - the tokenizer is resolved once per process and cached.

**Invalid `.env`.** The file is read as plain `KEY=VALUE` lines; there is no
validation layer. An unknown `TOKENIZER_BACKEND` value falls back to `auto`, and
an unreadable number in `CONTEXT_WINDOW_TOKENS`, `MAX_OUTPUT_TOKENS` or
`CONTEXT_SAFETY_MARGIN_TOKENS` falls back to the documented default, so a typo
cannot disable the app. If `OPENAI_API_KEY` is missing, the API answers `502`
with a friendly message and no key is ever printed. Keep the file in the project
root next to `app.py`; `load_env_file()` reads it from there.

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

**Compaction never seems to run.** It only starts when a *prepared request* reaches
`COMPACTION_TRIGGER_RATIO` of the input budget (70% by default), so a short chat
never compacts. Watch for the `[compaction] ...` console line and for the
`Context compaction` row in the analytics panel. A reason such as "folding would
leave too little verbatim context" means the saved history is too small to fold
safely, which is the intended behaviour. `COMPACTION_ENABLED=false` turns the
feature off completely.

**Tool results are not being reduced.** Tool-result management only runs when a
prepared request is above the compaction trigger, so a turn that fits is left
alone. A result is only replaced when it is big enough to be worth it (at least 250
tokens), has a matching tool call, is not already a managed representation, and its
raw content could be retained. The console says which of those applied:
`[context] pass N: ... tool results managed this turn: X`, and the analytics panel's
`Tool Result Management` section lists the classification, the skipped reasons and
the priority order. `TOOL_RESULT_MANAGEMENT_ENABLED=false` turns the whole thing off.

**The model or the provider answers with an error.** The API returns `413` when
the context budget refuses a request locally (nothing was sent) and `502` for a
provider or tool failure, with a short message in the browser and the raw error
only in the server console. Check `OPENAI_API_KEY`, `BASE_URL` and `MODEL_ID`,
and the `usage`/`context` cards beside the answer for what was actually sent.

## K. Updating dependencies

Install the package into the active environment, then record it deliberately:

```powershell
python -m pip install <package>
python -m pip freeze > requirements.txt
```

`pip freeze` lists **every** installed package, including transitive ones that no
project file imports (`numpy` and `packaging`, for example, arrive with
`transformers`), plus anything else you happen to have installed in the same
environment. It also drops the comment lines that separate the core runtime
packages from the tokenizer packages. So freeze is something to do after a
review, not after every install:

* Check `git diff requirements.txt` and keep only the packages the project really
  needs, with `==` pins.
* Keep the two groups (core runtime, tokenizer support) and their comments.
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
3. A message gets an answer, and the console shows one
   `[tokenizer] backend=huggingface name=deepseek-ai/DeepSeek-V4.1-Flash compatibility=compatible`
   line for that process.
4. The analytics panel beside the chat reports `Hugging Face
   (deepseek-ai/DeepSeek-V4.1-Flash)`, `Matches this model` and `Exact token
   count`, and its **Copy Analysis** button copies the turn's full report.
5. Once a conversation grows large enough, the console prints a
   `[compaction] folded N saved messages: estimated input A -> B tokens ...` line,
   and the analytics panel shows a `Context compaction` row - while the chat itself
   still lists every message, because compaction only changes what is sent.

### Where to read more

* `docs/ARCHITECTURE.md` - the layout, the request flow and the safety rules.
* `docs/CONTEXT_BUDGET.md` - the tokenizer backends, the context budget and the
  analytics panel field by field.
* `.agents/skills/python-ai-agent/SKILL.md` - the working conventions for changes
  to this project.



