"""Token Harbor Chat backend: the HTTP layer, the model loop and static front end.

The routes live here; token counting and the chat loop live in the `agent`
package, and the two tools the model may call live in `tools`. See
docs/ARCHITECTURE.md for the layout and how a message travels through it.

Run it with:
    python app.py                      # serves http://127.0.0.1:8000
    uvicorn app:app --reload           # the same app, reloading while you edit
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
            "The conversation's stored compaction metadata (the summary and the "
            "message it covers), sent back by the browser so a summary survives an "
            "application restart. Anything that is not that shape is ignored."
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


@app.post("/api/chat")
def chat(request: ChatRequest):
    """Answer one message and report its token usage and context budget.

    The model is chosen by the server from .env, never by the browser. Success is
    {"reply", "model"} plus "steps" when a tool ran, "usage" for the real token
    counts the provider reported and "context" for the estimates made before each
    call. A request that does not fit the context budget is refused locally with
    413; anything the provider or a tool raised becomes a 502 with a safe message.
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
        # A refused turn can still have produced a summary before the request was
        # judged, so it is sent back instead of being thrown away.
        updated = compaction_out[-1].get("compaction") if compaction_out else None
        if updated:
            content["compaction"] = updated
        return JSONResponse(status_code=413, content=content)
    except Exception as error:
        # 502 = "the other server failed". The browser shows detail as a friendly
        # message; the raw error stays in this server's console.
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
