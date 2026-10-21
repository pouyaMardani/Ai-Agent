import json
import os
from pathlib import Path
from typing import Any
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from openai import (
    APIConnectionError,
    APIError,
    APITimeoutError,
    AuthenticationError,
    BadRequestError,
    OpenAI,
    RateLimitError,
)
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
REQUEST_TIMEOUT_SECONDS = 30.0
MODEL_ENV_KEYS = ("DEEPSEEK", "MIMO")
MODEL_LABELS = {
    "DEEPSEEK": "DeepSeek V4.1 Flash",
    "MIMO": "MiMo v2.6 Flash",
}

FALLBACK_MODEL = "deepseek-v4.1-flash:free"
WORKSPACE_DIR = BASE_DIR / "workspace"
WORKSPACE_MAX_BYTES = 200 * 1024  # biggest file on disk we agree to open
WORKSPACE_MAX_CHARS = 20_000  # most characters we hand back to the model
WORKSPACE_ALLOWED_SUFFIXES = (".txt", ".md", ".json", ".csv")
WORKSPACE_BLOCKED_SUFFIXES = (".pem", ".key", ".pfx", ".p12", ".crt", ".cer", ".env")
WORKSPACE_BLOCKED_NAME_PARTS = (
    "id_rsa",
    "id_ed25519",
    "private_key",
    "credentials",
    "secret",
    "password",
    "passwd",
    "apikey",
    "api_key",
)
MAX_TOOL_ROUNDS = 3
MAX_TOOL_CALLS_PER_ROUND = 3

def ensure_workspace():
    """Create workspace/ at startup so the tool always has a real folder."""
    try:
        WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        # Only the folder name is logged, never a full server path.
        print(f"[workspace] could not create {WORKSPACE_DIR.name}/: {error}", flush=True)

def load_env_file():
    """Copy simple KEY=VALUE lines from .env into environment variables.

    This uses only the standard library, so we do not need an extra package.
    Existing environment variables are never overwritten, and the values are
    never printed, because one of them is a secret API key.
    """
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        # Skip blank lines, comments, and anything that is not KEY=VALUE.
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        # setdefault() keeps a real environment variable if one already exists.
        os.environ.setdefault(key.strip(), value.strip())

def available_models():
    """Read the models the page may choose from, in the order to show them.

    Every entry is {"id": <model id sent to the API>, "label": <name for the
    UI>}. Only ids that really come from .env are offered, so the browser can
    never ask for a model this server does not know about.
    """
    models = []
    seen = set()

    for key in MODEL_ENV_KEYS:
        model_id = (os.environ.get(key) or "").strip()
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        models.append({"id": model_id, "label": MODEL_LABELS.get(key, key.title())})

    if not models:
        # A setup that only has the older MODEL_NAME keeps working.
        legacy = (os.environ.get("MODEL_NAME") or "").strip()
        if legacy:
            models.append({"id": legacy, "label": "Configured model"})
        else:
            models.append({"id": FALLBACK_MODEL, "label": "DeepSeek V4.1 Flash"})

    return models

def default_model(settings):
    """The first configured model: used when the page does not pick one."""
    return settings["models"][0]["id"]

def resolve_model(settings, requested):
    """Return the model id to use for one request.

    The browser may ask for any of the configured models. Anything else - a
    stale saved value, a hand-written request - falls back to the default.
    """
    wanted = (requested or "").strip()
    for model in settings["models"]:
        if model["id"] == wanted:
            return model["id"]
    return default_model(settings)

def get_settings():
    """Read the Token Harbor configuration from environment variables."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "OPENAI_API_KEY is not set. Add it to the .env file in the project root."
        )

    return {
        "api_key": api_key,
        "base_url": os.environ.get("BASE_URL"),
        "models": available_models(),
    }

def create_client(settings):
    """Build an OpenAI client that talks to Token Harbor instead of OpenAI."""
    return OpenAI(
        api_key=settings["api_key"],
        base_url=settings["base_url"],
        timeout=REQUEST_TIMEOUT_SECONDS,  # keep page requests from hanging forever
        max_retries=1,
    )

def friendly_error(error):
    """Turn an SDK exception into a short message that is safe for the browser.

    The real error text stays on the server, so no secret details leak out.
    """
    if isinstance(error, AuthenticationError):
        return "The API key was rejected. Check OPENAI_API_KEY in your .env file."
    if isinstance(error, RateLimitError):
        return "Too many requests right now. Please wait a moment and try again."
    if isinstance(error, APITimeoutError):
        return "The AI took too long to answer. Please try again."
    if isinstance(error, APIConnectionError):
        return "Could not reach Token Harbor. Check your internet connection."
    if isinstance(error, APIError):
        return "The AI service returned an error. Please try again."
    return "Something went wrong while talking to the AI. Please try again."

SYSTEM_PROMPT = (
    "You are Token Harbor Chat, a helpful assistant running on the user's own computer.\n"
    "You can read files, but only by calling the read_file tool.\n"
    "Rules you must follow:\n"
    "1. Call read_file whenever the user asks what a file contains.\n"
    "2. Never say you read a file unless the read_file tool really succeeded. "
    "If it failed, tell the user the reason the tool gave you.\n"
    "3. Never guess or invent file contents. If you do not have them, say so.\n"
    "4. If a file is missing, blocked, too big, or not one of .txt/.md/.json/.csv, "
    "explain clearly that you could not read it and why.\n"
    "5. You can only read. Never claim that you wrote, renamed, or deleted anything.\n"
)

def resolve_workspace_path(relative_path, root=None):
    """Check a model-supplied path and return (real_path, None) or (None, message).

    `root` exists so tests can point the tool at a temporary folder; the running
    app always uses WORKSPACE_DIR. The message is written for the model and the
    user to read, and it never contains a real server path.
    """
    root_dir = (WORKSPACE_DIR if root is None else Path(root)).resolve()

    if not isinstance(relative_path, str):
        return None, "The path must be text."

    raw = relative_path.strip()
    if not raw:
        return None, "No file path was given."
    if len(raw) > 300:
        return None, "That path is too long."
    if "\x00" in raw:
        return None, "That path is not allowed."

    # Refuse absolute paths such as "/etc/passwd" or "C:\Users\me\notes.txt", and
    # UNC paths such as "\\server\share\x.txt". Only paths relative to the
    # workspace folder are understood.
    if raw.startswith(("/", "\\")):
        return None, "Only paths inside the workspace folder are allowed."
    candidate = Path(raw)
    if candidate.is_absolute() or candidate.drive:
        return None, "Only paths inside the workspace folder are allowed."

    # ".." is the classic way to climb out of a folder, so it is refused before
    # the filesystem is touched at all.
    if ".." in candidate.parts:
        return None, "Paths containing '..' are not allowed."

    # Resolve the path (which also follows symlinks) and then check the result is
    # still inside the workspace. This is what stops a symlink that points
    # somewhere else on the disk.
    target = (root_dir / candidate).resolve()
    if target != root_dir and root_dir not in target.parents:
        return None, "That file is outside the workspace folder."
    if (root_dir / candidate).is_symlink():
        return None, "Symbolic links are not allowed inside the workspace."

    for part in candidate.parts:
        if part.startswith("."):
            return None, "Hidden files and folders are not allowed."
        lowered = part.lower()
        if any(blocked in lowered for blocked in WORKSPACE_BLOCKED_NAME_PARTS):
            return None, "That file name looks like it could hold secrets, so it is blocked."

    if not target.exists():
        return None, "That file does not exist in the workspace."
    if target.is_dir():
        return None, "That path is a folder, not a file."
    if not target.is_file():
        return None, "That path is not a regular file."

    suffix = target.suffix.lower()
    if suffix in WORKSPACE_BLOCKED_SUFFIXES:
        return None, "That type of file is blocked."
    if suffix not in WORKSPACE_ALLOWED_SUFFIXES:
        allowed = ", ".join(WORKSPACE_ALLOWED_SUFFIXES)
        return None, f"Only these file types can be read: {allowed}."

    return target, None

def read_workspace_file(relative_path, root=None):
    """Read one small text file from the workspace and return a JSON-ready dict.

    It never raises because of anything the caller did: problems come back as
    {"ok": False, "error": "..."} so the model can explain them and the browser
    never sees a stack trace or an absolute server path.
    """
    target, error = resolve_workspace_path(relative_path, root=root)
    if error is not None:
        return {"ok": False, "error": error}

    try:
        size = target.stat().st_size
    except OSError:
        return {"ok": False, "error": "That file could not be opened."}

    if size > WORKSPACE_MAX_BYTES:
        limit_kb = WORKSPACE_MAX_BYTES // 1024
        return {"ok": False, "error": f"That file is bigger than {limit_kb} KB, so it was not read."}

    try:
        # errors="replace" turns a stray byte into U+FFFD instead of raising, so
        # one odd character cannot spoil an otherwise readable file.
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {"ok": False, "error": "That file could not be read."}

    truncated = len(text) > WORKSPACE_MAX_CHARS
    if truncated:
        text = text[:WORKSPACE_MAX_CHARS]

    root_dir = (WORKSPACE_DIR if root is None else Path(root)).resolve()
    # The relative path is safe to hand to the model; the absolute one is not.
    relative_name = target.relative_to(root_dir).as_posix()
    return {
        "ok": True,
        "path": relative_name,
        "bytes": size,
        "characters": len(text),
        "truncated": truncated,
        "content": text,
    }

READ_FILE_TOOL = {
    "type": "function",
    "function": {
        "name": "read_file",
        "description": (
            "Read a small text file that the user put in the workspace folder. "
            "Use a path relative to the workspace, for example 'example.txt' or "
            "'data/report.csv'. Only .txt, .md, .json and .csv files up to 200 KB "
            "can be read; absolute paths, '..', hidden files and secret-looking "
            "names are refused. Call this tool instead of guessing what a file "
            "contains."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File path inside the workspace folder, e.g. 'example.txt'.",
                }
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
}

TOOLS = [READ_FILE_TOOL]

def run_read_file(arguments, root=None):
    """Executor for read_file: check the arguments, then read the file."""
    path = arguments.get("path")
    if not isinstance(path, str):
        return {"ok": False, "error": "The 'path' argument must be a text string."}
    return read_workspace_file(path, root=root)


TOOL_FUNCTIONS = {"read_file": run_read_file}

def execute_tool_call(name, raw_arguments, root=None):
    """Run one tool call the model asked for and return a JSON-ready result.

    `raw_arguments` is the JSON text the model produced, so it can be broken;
    that becomes an error result instead of an exception. An unknown tool name is
    refused here, before any function is looked up.
    """
    tool = TOOL_FUNCTIONS.get(str(name or "").strip())
    if tool is None:
        return {"ok": False, "error": f"Unknown tool: {name or '(none)'}. Only read_file is available."}

    if raw_arguments is None or raw_arguments == "":
        arguments = {}
    elif isinstance(raw_arguments, str):
        try:
            arguments = json.loads(raw_arguments)
        except ValueError:
            return {"ok": False, "error": "The tool arguments were not valid JSON."}
    else:
        return {"ok": False, "error": "The tool arguments must be JSON text."}

    if not isinstance(arguments, dict):
        return {"ok": False, "error": "The tool arguments must be a JSON object."}

    return tool(arguments, root=root)

def assistant_tool_message(assistant_message):
    """Rebuild the assistant's tool-call message as plain dictionaries.

    The API hands back an object; when the conversation is sent again, the same
    tool_call ids must come with it, otherwise the provider cannot match our tool
    results to the calls that asked for them.
    """
    tool_calls = []
    for call in getattr(assistant_message, "tool_calls", None) or []:
        function = getattr(call, "function", None)
        tool_calls.append(
            {
                "id": str(getattr(call, "id", "") or ""),
                "type": "function",
                "function": {
                    "name": str(getattr(function, "name", "") or ""),
                    "arguments": getattr(function, "arguments", "") or "",
                },
            }
        )

    return {
        "role": "assistant",
        "content": getattr(assistant_message, "content", "") or "",
        "tool_calls": tool_calls,
    }

def run_chat_with_tools(client, model, messages, tool_runner=None):
    """Ask the model for an answer, letting it call read_file up to 3 times.

    Returns (reply_text, steps): `reply_text` is the final assistant text, and
    `steps` is a short, secret-free summary of the tool calls that happened, so
    /api/chat can report them and tests can check them.

    This is the whole tool-calling idea:
      1. ask the model and tell it which tools exist: tools=TOOLS, tool_choice="auto"
      2. no tool calls -> that text is the reply, we are done
      3. tool calls -> keep the assistant message, run each tool here on the
         server, append one "tool" message per call (same tool_call_id), then
         go back to step 1
    """
    runner = tool_runner or execute_tool_call
    steps = []
    use_tools = True  # turned off if the provider refuses tools
    rounds = 0  # completed rounds that used a tool

    while True:
        request_args = {"model": model, "messages": messages}
        if use_tools:
            request_args["tools"] = TOOLS
            request_args["tool_choice"] = "auto"

        try:
            response = client.chat.completions.create(**request_args)
        except BadRequestError as error:
            if not use_tools:
                raise
            # Some providers or models answer "tools: not supported". We never
            # pretend the tool ran: the limitation is logged, the request is
            # retried without tools, and steps tells the truth about it.
            use_tools = False
            steps.append(
                {
                    "name": "read_file",
                    "path": "",
                    "ok": False,
                    "detail": "This provider or model does not support tool calling, so read_file was not used.",
                }
            )
            print(
                f"[tool] provider refused tools ({error.__class__.__name__}); answering without them",
                flush=True,
            )
            continue

        assistant = response.choices[0].message
        tool_calls = list(getattr(assistant, "tool_calls", None) or [])

        if not tool_calls:
            reply = (getattr(assistant, "content", "") or "").strip()
            return reply or "(The model returned an empty response.)", steps

        # The assistant message that asked for the tools must be part of the
        # conversation, and every call inside it needs exactly one tool answer.
        messages.append(assistant_tool_message(assistant))
        for index, call in enumerate(tool_calls):
            function = getattr(call, "function", None)
            name = str(getattr(function, "name", "") or "")
            arguments = getattr(function, "arguments", "") or ""
            if index < MAX_TOOL_CALLS_PER_ROUND:
                result = runner(name, arguments)
            else:
                result = {"ok": False, "error": "Too many tool calls in one round."}

            print(f"[tool] {name or '(none)'} -> ok={bool(result.get('ok'))}", flush=True)
            steps.append(
                {
                    "name": name,
                    "path": str(result.get("path") or ""),
                    "ok": bool(result.get("ok")),
                    "detail": result.get("error") or f"{result.get('characters', 0)} characters returned",
                }
            )
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": str(getattr(call, "id", "") or ""),
                    "content": json.dumps(result, ensure_ascii=False),
                }
            )

        rounds += 1
        if rounds >= MAX_TOOL_ROUNDS:
            # Safety brake: stop offering tools and ask for the written answer,
            # so this loop can never run forever.
            use_tools = False
            messages.append(
                {
                    "role": "user",
                    "content": "Please answer my question now using only the information you already have.",
                }
            )

def build_messages(request, message):
    """Build the message list sent to the model.

    Order: our system instruction, then the history from the browser, then the
    newest user message. Only "user" and "assistant" entries survive, so the page
    cannot inject a system message or replace ours.
    """
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    # Keep only the last 40 entries and only well-formed {role, content} pairs,
    # so a bad request cannot break us.
    for item in request.history[-40:]:
        # Ignore anything that is not a {role, content} dictionary.
        if not isinstance(item, dict):
            continue
        role = str(item.get("role", "")).strip()
        content = str(item.get("content", "")).strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})

    # The newest user message always goes last, so the model answers it.
    messages.append({"role": "user", "content": message})
    return messages

class ChatRequest(BaseModel):
    """The shape of the JSON body the browser sends to POST /api/chat."""

    message: str = Field(default="", description="The newest user message")
    # The model id chosen in Settings. Empty means "use the default model".
    model: str = Field(default="", description="Model id chosen in the UI")
    # list[Any] keeps the request tolerant: odd entries are filtered out below
    # instead of causing a confusing validation error for the browser.
    history: list[Any] = Field(
        default_factory=list,
        description="Earlier messages: a list of {role, content} objects",
    )

load_env_file()

ensure_workspace()

app = FastAPI(title="Token Harbor Chat")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
def read_index():
   
    return FileResponse(STATIC_DIR / "index.html")

@app.get("/api/config")
def read_config():
    """Tell the browser which models the Settings dialog may offer.

    Only model ids and their display names are returned. The API key is never
    included, and neither is anything else from .env.
    """
    settings = get_settings()
    return {
        # "model" stays for any client that only expects a single name.
        "model": default_model(settings),
        "default_model": default_model(settings),
        "models": settings["models"],
    }

@app.post("/api/chat")
def chat(request: ChatRequest):
    """Receive the user message plus history, and return the AI reply."""
    # 1. Validate: an empty message is a client mistake, so answer with 400.
    message = request.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Please type a message first.")

    settings = get_settings()
    client = create_client(settings)
    # Pick the model the page asked for; an unknown id means "use the default".
    model = resolve_model(settings, request.model)

    # 2. Rebuild the conversation: our system instruction first, then the last
    #    40 well-formed {role, content} pairs, then the newest user message.
    messages = build_messages(request, message)

    # 3. Ask the model. It may answer with text, or it may ask to call read_file;
    #    run_chat_with_tools runs that tool here on the server, sends the file
    #    contents back to the model, and returns the model's final answer.
    try:
        reply, steps = run_chat_with_tools(client, model, messages)
        payload = {"reply": reply, "model": model}
        # Optional extra field. The page ignores it, but it makes it easy to see
        # in DevTools (or in a test) whether a tool really ran.
        if steps:
            payload["steps"] = steps
        return payload

    except (
        AuthenticationError,
        RateLimitError,
        APITimeoutError,
        APIConnectionError,
        APIError,
        Exception,
    ) as error:
        # 502 = "the other server failed". The browser shows detail as a
        # friendly message; the raw error stays in this server's console.
        raise HTTPException(status_code=502, detail=friendly_error(error)) from error

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)