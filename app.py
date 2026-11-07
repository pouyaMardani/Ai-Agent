"""Simple educational AI agent backend."""

import json
import logging
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from typing import Any

import openai
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from config import BASE_DIR, create_client, get_settings

SYSTEM_PROMPT = "You are a helpful assistant. Keep answers clear and brief."
COMPACTION_THRESHOLD = 4000
MAX_TOOL_CALLS = 10
try:
    MAX_TOOL_LOOPS = int(os.getenv("MAX_TOOL_LOOPS", "4"))
except ValueError as error:
    raise RuntimeError("MAX_TOOL_LOOPS must be a positive integer.") from error
if MAX_TOOL_LOOPS < 1:
    raise RuntimeError("MAX_TOOL_LOOPS must be a positive integer.")
LOGGER = logging.getLogger(__name__)


class ProviderError(Exception):
    """Raised when a model request fails, retaining completed tool results."""

    def __init__(
        self,
        status_code,
        details,
        tool_results=None,
        first_model_request_usage=None,
        first_model_request_completed=False,
        uses_compacted_history=False,
    ):
        self.status_code = status_code or 502
        self.details = details or {}
        self.tool_results = list(tool_results or [])
        self.first_model_request_usage = first_model_request_usage
        self.first_model_request_completed = first_model_request_completed
        self.uses_compacted_history = uses_compacted_history
        super().__init__(self.details.get("message") or "The provider rejected the request.")


def _extract_provider_details(error, api_key=None):
    """Summarize an SDK error without exposing the API key or request payload."""
    response = getattr(error, "response", None)
    body = getattr(error, "body", None)

    message = None
    code = None
    error_type = None
    if isinstance(body, dict):
        inner = body.get("error")
        if isinstance(inner, dict):
            message = inner.get("message")
            code = inner.get("code")
            error_type = inner.get("type")
        message = message or (body.get("message") if isinstance(body.get("message"), str) else None)
        code = code or (body.get("code") if isinstance(body.get("code"), str) else None)
        error_type = error_type or (body.get("type") if isinstance(body.get("type"), str) else None)
    elif isinstance(body, str):
        try:
            parsed_body = json.loads(body)
        except json.JSONDecodeError:
            parsed_body = None
        if isinstance(parsed_body, dict):
            inner = parsed_body.get("error")
            if isinstance(inner, dict):
                message = inner.get("message")
                code = inner.get("code")
                error_type = inner.get("type")
            if message is None and isinstance(parsed_body.get("message"), str):
                message = parsed_body["message"]

    status_code = getattr(error, "status_code", None)
    if status_code is None and response is not None:
        status_code = getattr(response, "status_code", None)
    if not isinstance(message, str) or not message:
        message = "The provider rejected the request."
    if api_key:
        message = message.replace(api_key, "[redacted]")

    request_id = getattr(error, "request_id", None)
    retry_after = None
    rate_limit_reset_requests = None
    rate_limit_reset_tokens = None
    if response is not None:
        headers = getattr(response, "headers", None)
        if headers:
            retry_after = headers.get("retry-after")
            rate_limit_reset_requests = headers.get("x-ratelimit-reset-requests")
            rate_limit_reset_tokens = headers.get("x-ratelimit-reset-tokens")
            request_id = request_id or headers.get("x-request-id")

    return {
        "status": status_code,
        "message": message,
        "code": code,
        "type": error_type,
        "request_id": request_id,
        "retry_after": retry_after,
        "rate_limit_reset_requests": rate_limit_reset_requests,
        "rate_limit_reset_tokens": rate_limit_reset_tokens,
    }


def _classify_provider_error(status_code):
    """Map an HTTP status code to a coarse reason the frontend can present."""
    if status_code == 429:
        return "rate_limit_or_restriction"
    if status_code in (401, 403):
        return "auth"
    if status_code == 404:
        return "model_not_found"
    if status_code and status_code >= 500:
        return "provider_unavailable"
    return "provider_error"


def _provider_error_payload(error):
    details = error.details
    return {
        "kind": _classify_provider_error(error.status_code),
        "status": error.status_code,
        "message": details.get("message"),
        "code": details.get("code"),
        "type": details.get("type"),
        "request_id": details.get("request_id"),
        "retry_after": details.get("retry_after"),
        "rate_limit_reset_requests": details.get("rate_limit_reset_requests"),
        "rate_limit_reset_tokens": details.get("rate_limit_reset_tokens"),
        "model": details.get("model"),
        "executed_tools": [result.get("name") for result in error.tool_results],
        "tool_results": error.tool_results,
    }


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Create or update a file inside the project workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path inside the workspace."},
                    "content": {"type": "string", "description": "The file contents."},
                    "overwrite": {
                        "type": "boolean",
                        "description": "Set to true only when replacing an existing file.",
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for current information.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "Search query."}},
                "required": ["query"],
            },
        },
    },
]


class ChatRequest(BaseModel):
    message: str = Field(default="", description="The newest user message.")
    history: list[dict[str, Any]] = Field(default_factory=list)
    compaction: dict[str, Any] | None = None
    after_measurement_pending: bool = False


class AIApp:
    def __init__(self):
        self.settings = get_settings()
        self.model = self.settings["model"]
        self.client = create_client(self.settings)
        self.workspace = BASE_DIR.resolve()

    def _normalize_history(self, history):
        cleaned = []
        for item in history[-30:]:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            if role not in {"user", "assistant", "tool", "system"}:
                continue
            content = item.get("content")
            if content is None:
                continue
            message = {"role": role, "content": str(content)}
            if role == "tool" and item.get("tool_call_id"):
                message["tool_call_id"] = item["tool_call_id"]
            cleaned.append(message)
        return cleaned

    def _build_messages(self, history, user_message, summary=None):
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        if summary:
            messages.append({"role": "system", "content": f"Earlier summary:\n{summary}"})
        messages.extend(history)
        messages.append({"role": "user", "content": user_message.strip()})
        return messages

    def _extract_usage(self, response):
        usage = getattr(response, "usage", None)
        if usage is None:
            return None

        if hasattr(usage, "model_dump"):
            raw = usage.model_dump()
        else:
            raw = dict(usage)

        if not isinstance(raw, dict):
            return None

        def pick(*keys):
            for key in keys:
                value = raw.get(key)
                if value is not None:
                    return value
            return None

        input_tokens = pick("prompt_tokens", "input_tokens")
        output_tokens = pick("completion_tokens", "output_tokens")
        total_tokens = pick("total_tokens")
        cached_tokens = pick("cached_tokens", "cache_read_input_tokens")
        reasoning_tokens = pick("reasoning_tokens")

        usage_data = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
            "cached_tokens": cached_tokens,
            "reasoning_tokens": reasoning_tokens,
            "provider_usage": raw,
        }

        if all(value is None for value in usage_data.values() if value is not usage_data["provider_usage"]):
            return None
        return usage_data

    def _request_model(
        self,
        tool_results=None,
        first_model_request_usage=None,
        first_model_request_completed=False,
        uses_compacted_history=False,
        after_measurement_pending=False,
        request_type="normal",
        **request,
    ):
        LOGGER.info(
            "Model request started: type=%s uses_compacted_history=%s after_measurement_pending=%s",
            request_type,
            uses_compacted_history,
            after_measurement_pending,
        )
        try:
            response = self.client.chat.completions.create(**request)
            usage = self._extract_usage(response)
            LOGGER.info(
                "Model request completed: type=%s uses_compacted_history=%s after_measurement_pending=%s provider_input_tokens=%s",
                request_type,
                uses_compacted_history,
                after_measurement_pending,
                usage.get("input_tokens") if usage else None,
            )
            return response
        except openai.APIStatusError as error:
            details = _extract_provider_details(error, self.settings["api_key"])
            details["model"] = request.get("model", self.model)
            raise ProviderError(
                details["status"],
                details,
                tool_results,
                first_model_request_usage,
                first_model_request_completed,
                uses_compacted_history,
            ) from error
        except openai.APIConnectionError as error:
            details = {
                "status": 502,
                "message": "Could not connect to the configured AI provider.",
                "code": None,
                "type": type(error).__name__,
                "request_id": None,
                "retry_after": None,
                "model": request.get("model", self.model),
            }
            raise ProviderError(
                502,
                details,
                tool_results,
                first_model_request_usage,
                first_model_request_completed,
                uses_compacted_history,
            ) from error
        except openai.APIError as error:
            details = {
                "status": 502,
                "message": "The AI provider returned an invalid response.",
                "code": None,
                "type": type(error).__name__,
                "request_id": getattr(error, "request_id", None),
                "retry_after": None,
                "model": request.get("model", self.model),
            }
            raise ProviderError(
                502,
                details,
                tool_results,
                first_model_request_usage,
                first_model_request_completed,
                uses_compacted_history,
            ) from error

    def _make_summary(self, history):
        messages = [{"role": "system", "content": "Write a short summary of the key facts from this conversation."}]
        messages.extend(history[-10:])
        messages.append({"role": "user", "content": "Summarize the important points from the conversation."})

        result = self._request_model(
            uses_compacted_history=False,
            request_type="summary",
            model=self.model,
            messages=messages,
            temperature=0.2,
        )
        text = result.choices[0].message.content or "Summary unavailable."
        usage = self._extract_usage(result)
        return {"summary": text.strip(), "usage": usage}

    def _execute_tool(self, tool_call):
        name = tool_call.function.name
        args = json.loads(tool_call.function.arguments or "{}")

        if name == "write_file":
            relative_path = (args.get("path") or "").strip()
            content = args.get("content", "")
            overwrite = bool(args.get("overwrite", False))
            if not relative_path:
                return {"ok": False, "error": "Missing path."}
            target = (self.workspace / relative_path).resolve()
            if self.workspace not in target.parents and target != self.workspace:
                return {"ok": False, "error": "Write blocked outside the project workspace."}
            if target.exists() and not overwrite:
                return {"ok": False, "error": "File already exists. Set overwrite to true to replace it."}
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            return {"ok": True, "path": str(target.relative_to(self.workspace))}

        if name == "web_search":
            query = (args.get("query") or "").strip()

            if not query:
               return {"ok": False, "error": "Missing search query."}

            api_key = os.getenv("TAVILY_API_KEY")

            if not api_key:
                return {"ok": False, "error": "TAVILY_API_KEY is not configured."}

            url = "https://api.tavily.com/search"

            payload = {
             "api_key": api_key,
             "query": query,
             "max_results": 5,
             "search_depth": "basic"
            }

            request = Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST"
            )

            try:
                with urlopen(request, timeout=20) as response:
                    data = json.loads(response.read().decode("utf-8"))
    
                results = []
    
                for item in data.get("results", []):
                    results.append({
                        "title": item.get("title", ""),
                        "url": item.get("url", ""),
                        "content": item.get("content", "")
                    })
    
                return {
                    "ok": True,
                    "query": query,
                    "results": results
                }
    
            except HTTPError as error:
                return {
                    "ok": False,
                    "error": f"Tavily API error: {error.code}"
                }
    
            except URLError as error:
                return {
                    "ok": False,
                    "error": f"Search connection failed: {error.reason}"
                }
        
        return {"ok": False, "error": f"Unknown tool: {name}"}

    
    def _run_model_loop(self, messages, uses_compacted_history=False, after_measurement_pending=False):
        current_messages = list(messages)
        tool_call_count = 0
        executed_tools = []
        tool_results = []
        first_model_request_usage = None
        first_model_request_completed = False

        for _ in range(MAX_TOOL_LOOPS):
            response = self._request_model(
                tool_results=tool_results,
                first_model_request_usage=first_model_request_usage,
                first_model_request_completed=first_model_request_completed,
                uses_compacted_history=uses_compacted_history,
                after_measurement_pending=after_measurement_pending,
                request_type="normal",
                model=self.model,
                messages=current_messages,
                tools=TOOLS,
                tool_choice="auto",
                temperature=0.7,
            )
            if not first_model_request_completed:
                first_model_request_usage = self._extract_usage(response)
                first_model_request_completed = True

            message = response.choices[0].message
            tool_calls = message.tool_calls or []

            if not tool_calls:
                return response, executed_tools, first_model_request_usage

            if tool_call_count + len(tool_calls) > MAX_TOOL_CALLS:
                current_messages.append({
                    "role": "system",
                    "content": (
                        "Tool call limit reached. Do not call any more tools. "
                        "Answer the user using the information already available."
                    ),
                })
                response = self._request_model(
                    tool_results=tool_results,
                    first_model_request_usage=first_model_request_usage,
                    first_model_request_completed=first_model_request_completed,
                    uses_compacted_history=uses_compacted_history,
                    after_measurement_pending=after_measurement_pending,
                    request_type="normal",
                    model=self.model,
                    messages=current_messages,
                    tool_choice="none",
                    temperature=0.7,
                )
                return response, executed_tools, first_model_request_usage

            current_messages.append(message.model_dump(exclude_none=True))

            for tool_call in tool_calls:
                tool_result = self._execute_tool(tool_call)
                executed_tools.append(tool_call.function.name)
                tool_results.append({
                    "name": tool_call.function.name,
                    "result": tool_result,
                })
                current_messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": json.dumps(tool_result),
                })

                tool_call_count += 1

        raise RuntimeError("Tool loop exceeded the safe limit.")


    def handle_chat(self, message, history=None, compaction=None, after_measurement_pending=False):
        clean_message = (message or "").strip()
        if not clean_message:
            raise HTTPException(status_code=400, detail="Please type a message first.")

        summary = compaction.get("summary") if compaction else None
        uses_compacted_history = bool(summary)
        history_list = self._normalize_history(history or [])
        messages = self._build_messages(history_list, clean_message, summary)

        try:
            response, executed_tools, first_model_request_usage = self._run_model_loop(
                messages,
                uses_compacted_history=uses_compacted_history,
                after_measurement_pending=after_measurement_pending,
            )
        except RuntimeError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error
        reply = response.choices[0].message.content or ""
        usage = self._extract_usage(response)

        compaction_payload = {
            "trigger_threshold": COMPACTION_THRESHOLD,
            "occurred": False,
            "before_input_tokens": None,
            "after_input_tokens": None,
        }
        input_tokens = usage.get("input_tokens") if usage else None
        if input_tokens is not None and input_tokens >= COMPACTION_THRESHOLD:
            try:
                result = self._make_summary(history_list + [{"role": "user", "content": clean_message}])
            except ProviderError as error:
                compaction_payload["error"] = _provider_error_payload(error)
                LOGGER.warning(
                    "Conversation summary request failed: status=%s code=%s type=%s request_id=%s",
                    error.status_code,
                    error.details.get("code"),
                    error.details.get("type"),
                    error.details.get("request_id"),
                )
            else:
                LOGGER.info(
                    "Compaction completed for current user request: provider_before_input_tokens=%s after_measurement_pending=true",
                    input_tokens,
                )
                compaction_payload.update({
                    "summary": result["summary"],
                    "occurred": True,
                    "before_input_tokens": input_tokens,
                    "triggered_input_tokens": input_tokens,
                    "count": (compaction.get("count", 0) if compaction else 0) + 1,
                    "summary_usage": result["usage"],
                })

        return {
            "reply": reply,
            "model": self.model,
            "usage": usage,
            "first_model_request_usage": first_model_request_usage,
            "first_model_request_completed": True,
            "uses_compacted_history": uses_compacted_history,
            "compaction": compaction_payload,
            "toolCalls": executed_tools,
        }


app = FastAPI(title="Python AI Agent")
app_instance = AIApp()


@app.get("/")
def read_index():
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/api/config")
def read_config():
    return {"ok": True, "model": app_instance.model}


@app.post("/api/chat")
def chat(request: ChatRequest):
    try:
        return app_instance.handle_chat(
            request.message,
            request.history,
            request.compaction,
            request.after_measurement_pending,
        )
    except HTTPException:
        raise
    except ProviderError as error:
        LOGGER.warning(
            "Provider request failed: status=%s code=%s type=%s request_id=%s retry_after=%s "
            "uses_compacted_history=%s first_model_request_completed=%s first_model_input_tokens=%s",
            error.status_code,
            error.details.get("code"),
            error.details.get("type"),
            error.details.get("request_id"),
            error.details.get("retry_after"),
            error.uses_compacted_history,
            error.first_model_request_completed,
            error.first_model_request_usage.get("input_tokens")
            if error.first_model_request_usage
            else None,
        )
        headers = {}
        if error.details.get("retry_after"):
            headers["Retry-After"] = str(error.details["retry_after"])
        raise HTTPException(
            status_code=error.status_code,
            detail={
                **_provider_error_payload(error),
                "first_model_request_usage": error.first_model_request_usage,
                "first_model_request_completed": error.first_model_request_completed,
                "uses_compacted_history": error.uses_compacted_history,
            },
            headers=headers or None,
        ) from error
    except Exception as error:
        LOGGER.error("Unexpected chat request failure: %s", type(error).__name__)
        raise HTTPException(status_code=500, detail="An unexpected application error occurred.") from error


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
