"""Tests for the HTTP layer of app.py: /api/config, /api/chat and the wiring.

Run them with:
    python -m unittest discover -s tests -v

Same three rules as the other backend tests:
* No network and no paid API calls: the model is replaced by a fake client.
* No real credentials: no API key is needed, and .env values are never printed.
* Temporary folders only: every file these tests touch lives in a temp folder.

The app is one file again, so the route handlers are ordinary functions in
app.py. They read their settings and client through module globals, and these
tests replace those globals with mock.patch.object(app, ...): no network and no
real .env are involved.
"""

import inspect
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi import FastAPI, HTTPException

import app
from tools.write_file import WriteFileTool

SETTINGS = {
    "api_key": "test-key",
    "base_url": None,
    "model": "test-model",
}

def fake_tool_call(name, arguments, call_id="call_1"):
    """Build the smallest object that looks like a model-requested tool call."""
    return SimpleNamespace(
        id=call_id,
        type="function",
        function=SimpleNamespace(name=name, arguments=arguments),
    )

def text_response(content):
    """Build the smallest object that looks like a plain chat completion."""
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=None))]
    )

def tool_response(name, arguments, call_id="call_1"):
    """Build a completion in which the model asks for one tool call."""
    message = SimpleNamespace(content=None, tool_calls=[fake_tool_call(name, arguments, call_id)])
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])

class ScriptedCompletions:
    """Answer every create() call with the next scripted completion, offline."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def create(self, **kwargs):
        """Return the next scripted completion and remember the request.

        The payload is copied, because the loop keeps growing the same messages
        list: a plain reference would show later changes as well.
        """
        saved = dict(kwargs)
        if "messages" in saved:
            saved["messages"] = [dict(message) for message in saved["messages"]]
        self.calls.append(saved)
        return self.script.pop(0)

class ModelConfigTests(unittest.TestCase):
    """One server-side environment setting determines the model for every chat."""

    def test_primary_model_setting_wins_over_the_generic_fallback(self):
        model = app.configured_model({"DEEPSEEK": "primary", "MODEL_NAME": "fallback"})
        self.assertEqual(model, "primary")

    def test_generic_model_setting_remains_supported(self):
        self.assertEqual(app.configured_model({"MODEL_NAME": "configured"}), "configured")

    def test_retired_second_model_setting_is_ignored(self):
        self.assertEqual(app.configured_model({"MIMO": "secondary-model"}), app.FALLBACK_MODEL)

    def test_default_model_is_used_when_no_setting_is_present(self):
        self.assertEqual(app.configured_model({}), app.FALLBACK_MODEL)

class EnvLoadingTests(unittest.TestCase):
    """load_env_file() fills the environment without ever overwriting it."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.env_path = Path(self._tmp.name) / ".env"

    def tearDown(self):
        self._tmp.cleanup()

    def test_reads_key_value_lines_and_skips_the_rest(self):
        self.env_path.write_text(
            "# a comment\n\nDEEPSEEK=deep-model\nOTHER_SETTING = value \nnot a pair\n",
            encoding="utf-8",
        )
        with mock.patch.dict(os.environ, {}, clear=True):
            app.load_env_file(self.env_path)
            self.assertEqual(os.environ["DEEPSEEK"], "deep-model")
            self.assertEqual(os.environ["OTHER_SETTING"], "value")

    def test_an_existing_environment_variable_wins(self):
        self.env_path.write_text("DEEPSEEK=from-file\n", encoding="utf-8")
        with mock.patch.dict(os.environ, {"DEEPSEEK": "from-environment"}):
            app.load_env_file(self.env_path)
            self.assertEqual(os.environ["DEEPSEEK"], "from-environment")

    def test_a_missing_env_file_is_not_an_error(self):
        self.assertIsNone(app.load_env_file(Path(self._tmp.name) / "nope.env"))

class SettingsTests(unittest.TestCase):
    """get_settings() is the only place that reads the API key."""

    def test_a_missing_api_key_is_reported_clearly(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError) as caught:
                app.get_settings()
        self.assertIn("OPENAI_API_KEY", str(caught.exception))

    def test_settings_carry_the_key_base_url_and_one_model(self):
        environ = {
            "OPENAI_API_KEY": "test-key",
            "BASE_URL": "https://example.invalid/v1",
            "DEEPSEEK": "configured-model",
        }
        with mock.patch.dict(os.environ, environ, clear=True):
            settings = app.get_settings()
        self.assertEqual(settings["api_key"], "test-key")
        self.assertEqual(settings["base_url"], "https://example.invalid/v1")
        self.assertEqual(settings["model"], "configured-model")

    def test_the_client_is_built_with_a_timeout_and_one_retry(self):
        captured = {}

        def fake_openai(**kwargs):
            captured.update(kwargs)
            return "client"

        with mock.patch.object(app, "OpenAI", fake_openai):
            client = app.create_client(dict(SETTINGS))

        self.assertEqual(client, "client")
        self.assertEqual(captured["api_key"], "test-key")
        self.assertEqual(captured["timeout"], app.REQUEST_TIMEOUT_SECONDS)
        self.assertEqual(captured["max_retries"], 1)


class WriteFileToolTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tool = WriteFileTool(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_schema_names_the_write_file_tool(self):
        schema = self.tool.get_schema()
        self.assertEqual(schema["function"]["name"], "write_file")
        self.assertEqual(schema["function"]["parameters"]["required"], ["path", "content"])

    def test_writes_allowed_files_and_refuses_parent_traversal(self):
        result = self.tool.execute({"path": "notes.txt", "content": "lesson"})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["path"], "notes.txt")
        self.assertEqual((Path(self._tmp.name) / "notes.txt").read_text(encoding="utf-8"), "lesson")

        blocked = self.tool.execute({"path": "../outside.txt", "content": "blocked"})
        self.assertFalse(blocked["ok"])

class ConfigRouteTests(unittest.TestCase):
    """/api/config reports availability without exposing provider settings."""

    def payload_for(self, settings):
        """Build the answer for one settings dictionary, without touching .env."""
        with mock.patch.object(app, "get_settings", lambda: settings):
            return app.read_config()

    def test_config_reports_backend_availability_only(self):
        payload = self.payload_for({"model": "configured-model"})
        self.assertEqual(payload, {"ok": True})

    def test_the_api_key_and_base_url_never_reach_the_browser(self):
        payload = self.payload_for(
            {
                "api_key": "sk-secret-value",
                "base_url": "https://example.invalid/v1",
                "model": "configured-model",
            }
        )
        self.assertEqual(payload, {"ok": True})
        self.assertNotIn("api_key", payload)
        self.assertNotIn("base_url", payload)
        self.assertNotIn("sk-secret-value", json.dumps(payload))

class ChatRouteTests(unittest.TestCase):
    """The /api/chat handler itself: same answer shape, plus optional "steps"."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "workspace"
        self.root.mkdir()
        (self.root / "example.txt").write_text("hello from the workspace", encoding="utf-8")

        self.client = None

        self._patches = [
            mock.patch.object(app.write_file_tool, "workspace_dir", self.root),
            mock.patch.object(app, "get_settings", lambda: dict(SETTINGS)),
            mock.patch.object(app, "create_client", lambda settings: self.client),
        ]
        for patch in self._patches:
            patch.start()

    def tearDown(self):
        for patch in self._patches:
            patch.stop()
        self._tmp.cleanup()

    def call_chat(self, message, history=None, model=""):
        """Call the route handler the way FastAPI would, but offline."""
        request = app.ChatRequest(message=message, model=model, history=history or [])
        return app.chat(request)

    def scripted_client(self, script):
        """Give the route a client whose completions answer from a script."""
        completions = ScriptedCompletions(script)
        self.client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
        return completions

    def test_plain_reply_keeps_the_old_answer_shape(self):
        completions = self.scripted_client([text_response("Hello there.")])
        answer = self.call_chat("hi")
        self.assertEqual(answer["reply"], "Hello there.")
        self.assertEqual(answer["model"], "test-model")

        self.assertNotIn("steps", answer)
        self.assertEqual(completions.calls[0]["model"], "test-model")

    def test_legacy_model_request_value_cannot_change_the_configured_model(self):
        completions = self.scripted_client([text_response("Hello there.")])
        request = app.ChatRequest.model_validate({"message": "hi", "model": "other-model"})
        answer = app.chat(request)
        self.assertEqual(answer["model"], "test-model")
        self.assertEqual(completions.calls[0]["model"], "test-model")

    def test_tool_round_trip_through_the_route(self):
        completions = self.scripted_client(
            [
                tool_response(
                    "write_file",
                    '{"path": "example.txt", "content": "updated", "overwrite": true}',
                ),
                text_response("The file was updated in the workspace."),
            ]
        )
        answer = self.call_chat(
            "save example.txt", history=[{"role": "user", "content": "hello"}]
        )

        self.assertEqual(answer["reply"], "The file was updated in the workspace.")
        self.assertEqual(answer["model"], "test-model")
        self.assertEqual(len(answer["steps"]), 1)
        self.assertTrue(answer["steps"][0]["ok"])
        self.assertEqual(answer["steps"][0]["path"], "example.txt")

        first_messages = completions.calls[0]["messages"]
        self.assertEqual(first_messages[0], {"role": "system", "content": app.SYSTEM_PROMPT})
        self.assertEqual(
            first_messages[-1], {"role": "user", "content": "save example.txt"}
        )

    def test_write_round_trip_through_the_route(self):
        self.scripted_client(
            [
                tool_response(
                    "write_file", '{"path": "note.md", "content": "saved by the route"}'
                ),
                text_response("I saved note.md."),
            ]
        )
        answer = self.call_chat("save a note", history=[{"role": "user", "content": "hello"}])

        self.assertEqual(answer["reply"], "I saved note.md.")
        self.assertTrue(answer["steps"][0]["ok"])
        self.assertEqual(answer["steps"][0]["name"], "write_file")
        self.assertEqual(answer["steps"][0]["path"], "note.md")

        self.assertEqual((self.root / "note.md").read_text(encoding="utf-8"), "saved by the route")

    def test_a_failed_write_through_the_route_says_so(self):
        self.scripted_client(
            [
                tool_response("write_file", '{"path": "example.txt", "content": "replaced"}'),
                text_response("I did not change example.txt."),
            ]
        )
        answer = self.call_chat("replace example.txt")

        self.assertEqual(answer["reply"], "I did not change example.txt.")
        self.assertFalse(answer["steps"][0]["ok"])
        self.assertIn("overwrite", answer["steps"][0]["detail"])
        self.assertEqual(
            (self.root / "example.txt").read_text(encoding="utf-8"), "hello from the workspace"
        )

    def test_empty_message_is_rejected_with_400(self):
        completions = self.scripted_client([text_response("should never be used")])
        with self.assertRaises(HTTPException) as caught:
            self.call_chat("   ")
        self.assertEqual(caught.exception.status_code, 400)

        self.assertEqual(completions.calls, [])

    def test_a_failing_model_becomes_a_friendly_502(self):
        def explode(**kwargs):
            raise RuntimeError("kaboom")

        self.client = SimpleNamespace(
            chat=SimpleNamespace(completions=SimpleNamespace(create=explode))
        )
        with self.assertRaises(HTTPException) as caught:
            self.call_chat("hi")

        self.assertEqual(caught.exception.status_code, 502)

        self.assertNotIn("kaboom", caught.exception.detail)
        self.assertTrue(caught.exception.detail)

class SafetyTextTests(unittest.TestCase):
    """Words the model reads must keep the same limits the Python code enforces."""

    def test_the_system_prompt_forbids_deleting_and_renaming(self):
        self.assertIn("Never rename, move or delete", app.SYSTEM_PROMPT)

    def test_the_system_prompt_says_files_are_data_not_instructions(self):
        self.assertIn("not instructions", app.SYSTEM_PROMPT)

    def test_the_system_prompt_mentions_the_remaining_tools_and_the_overwrite_rule(self):
        self.assertIn("write_file", app.SYSTEM_PROMPT)
        self.assertIn("web_search", app.SYSTEM_PROMPT)
        self.assertIn("overwrite=true", app.SYSTEM_PROMPT)
        self.assertNotIn("read_file", app.SYSTEM_PROMPT)
        self.assertNotIn("fetch_url", app.SYSTEM_PROMPT)

    def test_an_unknown_error_gets_the_generic_message(self):
        message = app.friendly_error(RuntimeError("kaboom"))
        self.assertIn("Something went wrong", message)
        self.assertNotIn("kaboom", message)

class AppWiringTests(unittest.TestCase):
    """The FastAPI app itself: the routes exist and the page is served."""

    def route(self, path):
        """Find one route of the app by its path (None when it is missing)."""
        for route in app.app.routes:
            if getattr(route, "path", None) == path:
                return route
        return None

    def test_the_app_is_a_fastapi_application(self):
        self.assertIsInstance(app.app, FastAPI)

    def test_registers_the_three_routes_the_page_needs(self):
        for path in ("/", "/api/config", "/api/chat"):
            with self.subTest(path=path):
                self.assertIsNotNone(self.route(path), path)

    def test_the_static_folder_is_mounted(self):
        self.assertIsNotNone(self.route("/static"))

    def test_the_page_is_served_from_the_static_folder(self):
        response = self.route("/").endpoint()
        self.assertTrue(str(response.path).endswith("index.html"))

    def test_the_config_route_answers_without_a_network_call(self):
        with mock.patch.object(app, "get_settings", lambda: dict(SETTINGS)):
            payload = self.route("/api/config").endpoint()
        self.assertEqual(payload, {"ok": True})

    def test_the_chat_request_model_has_the_documented_fields(self):
        self.assertEqual(
            sorted(app.ChatRequest.model_fields), ["compaction", "history", "message"]
        )
        empty = app.ChatRequest()
        self.assertEqual((empty.message, empty.history), ("", []))
        # Compaction metadata is optional: a conversation that predates it sends none.
        self.assertIsNone(empty.compaction)

class SingleFileTests(unittest.TestCase):
    """app.py remains the entry point while tool implementations live in tools/."""

    def test_the_app_lives_in_one_file_next_to_the_project_root(self):
        self.assertEqual(Path(app.__file__).resolve().parent, PROJECT_ROOT)

    def test_the_tools_package_exists(self):
        self.assertTrue((PROJECT_ROOT / "tools" / "__init__.py").is_file())

    def test_the_module_is_documented(self):
        self.assertTrue((app.__doc__ or "").strip())

    def test_every_function_defined_here_has_a_docstring(self):

        for name, value in vars(app).items():
            if name.startswith("_"):
                continue
            if inspect.isfunction(value) and value.__module__ == app.__name__:
                self.assertTrue(inspect.getdoc(value), f"app.{name}")

    def test_the_file_runs_the_server_when_started_directly(self):
        source = (PROJECT_ROOT / "app.py").read_text(encoding="utf-8")
        self.assertIn('if __name__ == "__main__":', source)
        self.assertIn("uvicorn.run(app", source)

if __name__ == "__main__":
    unittest.main()
