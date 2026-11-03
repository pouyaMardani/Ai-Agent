"""Token Harbor Chat backend: the HTTP routes and the static front end.

The model loop and token accounting live in the `agent` package; the tools the
model may call live in `tools`.

    python app.py                 # serves http://127.0.0.1:8000
    uvicorn app:app --reload      # the same app, reloading while you edit
"""

from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from agent.chat import SYSTEM_PROMPT, keep_history, run_chat_with_tools
from agent.context_budget import ContextBudgetExceeded
from config import BASE_DIR, create_client, friendly_error, get_settings, load_env_file

STATIC_DIR = BASE_DIR / "static"

load_env_file()

app = FastAPI(title="Token Harbor Chat")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class ChatRequest(BaseModel):
    """The shape of the JSON body the browser sends to POST /api/chat."""

    message: str = Field(default="", description="The newest user message")

    history: list[Any] = Field(
        default_factory=list,
        description="Earlier messages: a list of {role, content} objects",
    )

    compaction: Any = Field(
        default=None,
        description=(
            "Stored compaction metadata (summary plus the message it covers) sent "
            "back by the browser. Anything that is not that shape is ignored."
        ),
    )


@app.get("/")
def read_index():
    """Serve the chat page."""
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/config")
def read_config():
    """Confirm the backend is up, without exposing any provider setting."""
    return {"ok": True}


def describe_error(error, secret=None):
    """One short, safe line about an unexpected failure, for this console only.

    Bounded to a single trimmed line, so a provider message cannot dump request
    content here, and the API key is masked if it ever appears.
    """
    status = getattr(error, "status_code", None)
    if status is None:
        status = getattr(getattr(error, "response", None), "status_code", None)

    text = " ".join(str(error or "").split())[:300]
    if secret:
        text = text.replace(str(secret), "***")

    line = error.__class__.__name__
    if status is not None:
        line += f" (provider status {status})"
    if text:
        line += f": {text}"
    return line


@app.post("/api/chat")
def chat(request: ChatRequest):
    """Answer one message; the model comes from .env, never from the browser.

    Answers with {"reply", "model"} plus "steps", "usage", "context", and
    "compaction" when the stored summary changed. A request the provider refuses as
    longer than its context limit is reported as 413 with an explanation, and the
    conversation is left untouched; other failures become a 502.
    """
    settings = get_settings()
    model = settings["model"]
    client = create_client(settings)

    history_messages = keep_history(request.history)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        *history_messages,
        {"role": "user", "content": request.message.strip()},
    ]

    usage_out = []
    context_out = []
    compaction_out = []
    try:
        reply, steps = run_chat_with_tools(
            client,
            model,
            messages,
            usage_out=usage_out,
            context_out=context_out,
            history_count=len(history_messages),
            compaction=request.compaction,
            compaction_out=compaction_out,
        )
    except ContextBudgetExceeded as error:
        content = {
            "detail": error.message,
            "model": model,
            "rejected": True,
            "context": error.context,
        }
        # An earlier response in this turn may already have produced a summary; send
        # it back so the browser does not have to rebuild the same summary.
        updated = compaction_out[-1].get("compaction") if compaction_out else None
        if updated:
            content["compaction"] = updated
        return JSONResponse(status_code=413, content=content)
    except Exception as error:
        # The browser gets a fixed safe message; the detail stays in this console.
        print(f"[error] {describe_error(error, settings.get('api_key'))}", flush=True)
        raise HTTPException(status_code=502, detail=friendly_error(error)) from error

    payload = {"reply": reply, "model": model}
    if steps:
        payload["steps"] = steps
    if usage_out:
        payload["usage"] = usage_out[-1]
    if context_out:
        payload["context"] = context_out[-1]
    if compaction_out:
        updated = compaction_out[-1].get("compaction")
        if updated:
            payload["compaction"] = updated
    return payload


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
