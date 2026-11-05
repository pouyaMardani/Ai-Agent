"""Simple educational AI agent backend."""

import json
import logging
import os
import re
from unicodedata import name
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from config import BASE_DIR, create_client, get_settings

SYSTEM_PROMPT = "You are a helpful assistant. Keep answers clear and brief."
COMPACTION_THRESHOLD = 4000
try:
    MAX_TOOL_LOOPS = int(os.getenv("MAX_TOOL_LOOPS", "4"))
except ValueError as error:
    raise RuntimeError("MAX_TOOL_LOOPS must be a positive integer.") from error
if MAX_TOOL_LOOPS < 1:
    raise RuntimeError("MAX_TOOL_LOOPS must be a positive integer.")
LOGGER = logging.getLogger(__name__)

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
        messages.extend(self._normalize_history(history))
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

    def _make_summary(self, history, summary=None):
        messages = [{"role": "system", "content": "Write a short summary of the key facts from this conversation."}]
        if summary:
            messages.append({"role": "system", "content": f"Previous summary:\n{summary}"})
        messages.extend(self._normalize_history(history)[-10:])
        messages.append({"role": "user", "content": "Summarize the important points from the conversation."})

        result = self.client.chat.completions.create(
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

            request = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST"
            )

            try:
                with urllib.request.urlopen(request, timeout=20) as response:
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
    
            except urllib.error.HTTPError as error:
                return {
                    "ok": False,
                    "error": f"Tavily API error: {error.code}"
                }
    
            except urllib.error.URLError as error:
                return {
                    "ok": False,
                    "error": f"Search connection failed: {error.reason}"
                }
    
            return {"ok": False, "error": f"Unknown tool: {name}"}

    def _run_model_loop(self, messages):
        current_messages = list(messages)
        seen_tool_calls = set()
        for iteration in range(1, MAX_TOOL_LOOPS + 1):
            response = self.client.chat.completions.create(
                model=self.model,
                messages=current_messages,
                tools=TOOLS,
                tool_choice="auto",
                temperature=0.7,
            )
            message = response.choices[0].message
            tool_calls = list(message.tool_calls or [])

            if not tool_calls:
                current_messages.append(
                    {"role": "assistant", "content": message.content or ""}
                )
                return response, current_messages

            assistant_tool_calls = []
            call_ids = set()
            for tool_call in tool_calls:
                call_id = tool_call.id
                if not call_id or call_id in call_ids:
                    LOGGER.error(
                        "Invalid tool call IDs in iteration %d; rejecting tool-call message.",
                        iteration,
                    )
                    raise RuntimeError(
                        "The model returned missing or duplicate tool call IDs."
                    )
                call_ids.add(call_id)
                assistant_tool_calls.append(
                    {
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": tool_call.function.name,
                            "arguments": tool_call.function.arguments or "{}",
                        },
                    }
                )

            current_messages.append(
                {
                    "role": "assistant",
                    "content": message.content,
                    "tool_calls": assistant_tool_calls,
                }
            )

            for tool_call in tool_calls:
                tool_name = tool_call.function.name
                arguments = tool_call.function.arguments or "{}"
                try:
                    normalized_arguments = json.dumps(
                        json.loads(arguments),
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                except (TypeError, ValueError):
                    normalized_arguments = arguments
                call_signature = (tool_name, normalized_arguments)

                if call_signature in seen_tool_calls:
                    LOGGER.warning(
                        "Tool call skipped: iteration=%d tool=%s status=repeated-identical",
                        iteration,
                        tool_name,
                    )
                    tool_result = {
                        "ok": False,
                        "error": "Repeated identical tool call was not executed.",
                    }
                else:
                    seen_tool_calls.add(call_signature)
                    try:
                        tool_result = self._execute_tool(tool_call)
                        if tool_result is None:
                            tool_result = {
                                "ok": False,
                                "error": f"Unknown tool: {tool_name}",
                            }
                        status = (
                            "failed"
                            if isinstance(tool_result, dict)
                            and tool_result.get("ok") is False
                            else "completed"
                        )
                        LOGGER.info(
                            "Tool call: iteration=%d tool=%s status=%s",
                            iteration,
                            tool_name,
                            status,
                        )
                    except Exception as error:
                        LOGGER.error(
                            "Tool call: iteration=%d tool=%s status=exception error_type=%s",
                            iteration,
                            tool_name,
                            type(error).__name__,
                        )
                        tool_result = {
                            "ok": False,
                            "error": "Tool execution failed.",
                        }

                try:
                    result_content = json.dumps(tool_result)
                except (TypeError, ValueError) as error:
                    LOGGER.error(
                        "Tool call: iteration=%d tool=%s status=result-serialization-failed error_type=%s",
                        iteration,
                        tool_name,
                        type(error).__name__,
                    )
                    result_content = json.dumps(
                        {"ok": False, "error": "Tool result could not be serialized."}
                    )
                current_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": result_content,
                    }
                )

        raise RuntimeError(
            f"Tool loop exceeded the safe limit of {MAX_TOOL_LOOPS} iterations."
        )

    def handle_chat(self, message, history=None, compaction=None):
        clean_message = (message or "").strip()
        if not clean_message:
            raise HTTPException(status_code=400, detail="Please type a message first.")

        summary = compaction.get("summary") if isinstance(compaction, dict) else None
        history_list = self._normalize_history(history or [])
        messages = self._build_messages(history_list, clean_message, summary)

        try:
            response, messages_with_tools = self._run_model_loop(messages)
        except RuntimeError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error
        reply = response.choices[0].message.content or ""
        usage = self._extract_usage(response)

        compaction_payload = None
        if usage and usage["input_tokens"] is not None and usage["input_tokens"] >= COMPACTION_THRESHOLD:
            result = self._make_summary(history_list + [{"role": "user", "content": clean_message}])
            compaction_payload = {
                "summary": result["summary"],
                "triggered_input_tokens": usage["input_tokens"],
                "count": (compaction.get("count") if isinstance(compaction, dict) else 0) + 1,
                "summary_usage": result["usage"],
            }

        return {
            "reply": reply,
            "model": self.model,
            "usage": usage,
            "compaction": compaction_payload,
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
        return app_instance.handle_chat(request.message, request.history, request.compaction)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
