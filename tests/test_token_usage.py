"""Tests for the token usage reported next to one assistant answer.

Run them with:
    py -3 -m unittest discover -s tests -v

The feature being tested is deliberately honest about missing data, so most of
these tests are about what happens when the provider tells us *nothing*:

* A field the provider left out stays None and is shown as "N/A". It is never
  turned into a silent 0, because "we do not know" is a different answer from
  "it cost nothing".
* A total is only derived locally when every call reported both parts, and the
  result is flagged with `derived_total` so the page can say so.
* A tool run is not a model API call. The two counters are reported separately.

Three rules this file follows, like the other test modules:
* No internet requests: the model and the search tool are both fakes.
* No real credentials: made-up keys go into the environment, and .env is never
  read or printed.
* No real workspace writes: the route tests only ever ask for a text answer.
"""

import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import app

# A key that looks real enough to be sent, and is worthless to anyone.
FAKE_KEY = "sk-not-a-real-key"

# The environment the route test uses. Values never leave this process.
SETTINGS_ENV = {
    "OPENAI_API_KEY": FAKE_KEY,
    "MODEL_ID": "test-model",
    "BASE_URL": "https://provider.invalid/v1",
}


def usage_block(prompt=None, completion=None, total=None, cached=None, reasoning=None):
    """Build a provider-style usage block, leaving out whatever is not given.

    Passing None (the default) means "the provider did not send this field",
    which is exactly the case the code has to keep honest.
    """
    block = {}
    if prompt is not None:
        block["prompt_tokens"] = prompt
    if completion is not None:
        block["completion_tokens"] = completion
    if total is not None:
        block["total_tokens"] = total
    if cached is not None:
        block["prompt_tokens_details"] = {"cached_tokens": cached}
    if reasoning is not None:
        block["completion_tokens_details"] = {"reasoning_tokens": reasoning}
    return block


def fake_tool_call(name, arguments, call_id="call_1"):
    """Build the smallest object that looks like a model-requested tool call."""
    return SimpleNamespace(
        id=call_id,
        type="function",
        function=SimpleNamespace(name=name, arguments=arguments),
    )


def text_response(content, usage=None):
    """Build a chat completion that answers with text and maybe reports usage."""
    message = SimpleNamespace(content=content, tool_calls=None)
    response = SimpleNamespace(choices=[SimpleNamespace(message=message)])
    if usage is not None:
        response.usage = usage
    return response


def tool_response(name, arguments, usage=None, call_id="call_1"):
    """Build a chat completion in which the model asks for one tool call."""
    message = SimpleNamespace(content=None, tool_calls=[fake_tool_call(name, arguments, call_id)])
    response = SimpleNamespace(choices=[SimpleNamespace(message=message)])
    if usage is not None:
        response.usage = usage
    return response


class FakeCompletions:
    """Stand-in for client.chat.completions that never touches the network."""

    def __init__(self, script=None):
        """Store the scripted answers and start with an empty request log."""
        self.script = list(script or [])
        self.calls = []

    def create(self, **kwargs):
        """Return the next scripted answer, or raise it when it is an exception."""
        saved = dict(kwargs)
        if "messages" in saved:
            saved["messages"] = [dict(message) for message in saved["messages"]]
        self.calls.append(saved)
        if not self.script:
            return text_response("done")
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class UsageFieldTests(unittest.TestCase):
    """Reading one value out of a dict or an SDK object, without inventing it."""

    def test_usage_field_reads_both_a_dict_and_an_object(self):
        self.assertEqual(app.usage_field({"tokens": 7}, "tokens"), 7)
        self.assertEqual(app.usage_field(SimpleNamespace(tokens=7), "tokens"), 7)

    def test_usage_field_returns_none_for_anything_missing(self):
        for container in (None, {}, SimpleNamespace()):
            with self.subTest(container=repr(container)):
                self.assertIsNone(app.usage_field(container, "tokens"))

    def test_as_token_count_rejects_everything_that_is_not_a_count(self):
        for value in (None, True, False, "12", 12.5, -1, [], {}, object()):
            with self.subTest(value=repr(value)):
                self.assertIsNone(app.as_token_count(value))

    def test_as_token_count_keeps_real_numbers_including_zero(self):
        for value, expected in ((0, 0), (12, 12), (12.0, 12), (1500, 1500)):
            with self.subTest(value=repr(value)):
                self.assertEqual(app.as_token_count(value), expected)


class ExtractCallUsageTests(unittest.TestCase):
    """What one model call told us, in our own field names."""

    def test_a_response_without_a_usage_block_reports_nothing(self):
        self.assertIsNone(app.extract_call_usage(text_response("hi")))

    def test_a_full_usage_block_is_read_into_our_own_names(self):
        response = text_response(
            "hi",
            usage=usage_block(prompt=120, completion=30, total=150, cached=64, reasoning=8),
        )
        self.assertEqual(
            app.extract_call_usage(response),
            {
                "input_tokens": 120,
                "output_tokens": 30,
                "total_tokens": 150,
                "cached_input_tokens": 64,
                "reasoning_tokens": 8,
            },
        )

    def test_the_same_block_is_read_when_the_sdk_returns_objects(self):
        usage = SimpleNamespace(
            prompt_tokens=120,
            completion_tokens=30,
            total_tokens=150,
            prompt_tokens_details=SimpleNamespace(cached_tokens=64),
            completion_tokens_details=SimpleNamespace(reasoning_tokens=8),
        )
        self.assertEqual(
            app.extract_call_usage(text_response("hi", usage=usage)),
            {
                "input_tokens": 120,
                "output_tokens": 30,
                "total_tokens": 150,
                "cached_input_tokens": 64,
                "reasoning_tokens": 8,
            },
        )

    def test_optional_details_stay_none_when_the_provider_omits_them(self):
        extracted = app.extract_call_usage(
            text_response("hi", usage=usage_block(prompt=120, completion=30, total=150))
        )
        self.assertIsNone(extracted["cached_input_tokens"])
        self.assertIsNone(extracted["reasoning_tokens"])

    def test_a_field_the_provider_left_out_is_never_zero(self):
        extracted = app.extract_call_usage(text_response("hi", usage=usage_block(prompt=1)))
        self.assertEqual(extracted["input_tokens"], 1)
        self.assertIsNone(extracted["output_tokens"])
        self.assertIsNone(extracted["total_tokens"])

    def test_an_empty_usage_block_reports_everything_as_unknown(self):
        extracted = app.extract_call_usage(text_response("hi", usage=usage_block()))
        self.assertIsNotNone(extracted)
        for field in app.USAGE_TOKEN_FIELDS:
            with self.subTest(field=field):
                self.assertIsNone(extracted[field])


class SumTokenFieldTests(unittest.TestCase):
    """Adding one field across calls without dressing up what is missing."""

    def test_missing_values_are_skipped_not_counted_as_zero(self):
        calls = [
            {"input_tokens": 10},
            {"input_tokens": None},
            {"input_tokens": 5},
            {},
        ]
        self.assertEqual(app.sum_token_field(calls, "input_tokens"), 15)

    def test_a_field_nobody_reported_stays_none(self):
        calls = [{"input_tokens": 10}, {"input_tokens": 5}]
        self.assertIsNone(app.sum_token_field(calls, "reasoning_tokens"))

    def test_no_calls_at_all_stays_none(self):
        self.assertIsNone(app.sum_token_field([], "input_tokens"))


class SummarizeUsageTests(unittest.TestCase):
    """The `usage` object that travels to the browser with each answer."""

    def complete_call(self, prompt, completion, total, cached=None, reasoning=None):
        """Build one extracted call record the way the loop stores it."""
        return {
            "input_tokens": prompt,
            "output_tokens": completion,
            "total_tokens": total,
            "cached_input_tokens": cached,
            "reasoning_tokens": reasoning,
        }

    def test_no_calls_at_all_is_not_reported(self):
        summary = app.summarize_usage([])
        self.assertFalse(summary["available"])
        self.assertFalse(summary["complete"])
        self.assertFalse(summary["derived_total"])
        self.assertEqual(summary["model_calls"], 0)
        self.assertEqual(summary["tool_calls"], 0)
        self.assertEqual(summary["calls"], [])
        self.assertEqual(summary["unavailable"], list(app.USAGE_TOKEN_FIELDS))
        for field in app.USAGE_TOKEN_FIELDS:
            with self.subTest(field=field):
                self.assertIsNone(summary["totals"][field])

    def test_one_complete_call_is_available_and_complete(self):
        summary = app.summarize_usage([self.complete_call(120, 30, 150)])
        self.assertTrue(summary["available"])
        self.assertTrue(summary["complete"])
        self.assertFalse(summary["derived_total"])
        self.assertEqual(summary["model_calls"], 1)
        self.assertEqual(summary["totals"]["input_tokens"], 120)
        self.assertEqual(summary["totals"]["output_tokens"], 30)
        self.assertEqual(summary["totals"]["total_tokens"], 150)
        self.assertEqual(summary["unavailable"], ["cached_input_tokens", "reasoning_tokens"])
        self.assertEqual(summary["calls"][0]["call_index"], 1)
        self.assertTrue(summary["calls"][0]["reported"])

    def test_cached_and_reasoning_tokens_are_extras_that_keep_completeness(self):
        summary = app.summarize_usage(
            [self.complete_call(120, 30, 150, cached=64, reasoning=8)]
        )
        self.assertEqual(summary["totals"]["cached_input_tokens"], 64)
        self.assertEqual(summary["totals"]["reasoning_tokens"], 8)
        self.assertTrue(summary["complete"])
        self.assertEqual(summary["unavailable"], [])

    def test_a_tool_round_trip_sums_every_model_call_in_order(self):
        summary = app.summarize_usage(
            [
                self.complete_call(120, 30, 150),
                self.complete_call(200, 20, 220, cached=64),
            ],
            tool_calls=1,
        )
        self.assertEqual(summary["model_calls"], 2)
        self.assertEqual(summary["tool_calls"], 1, "a tool run is not a model call")
        self.assertEqual(summary["totals"]["input_tokens"], 320)
        self.assertEqual(summary["totals"]["output_tokens"], 50)
        self.assertEqual(summary["totals"]["total_tokens"], 370)
        self.assertEqual(summary["totals"]["cached_input_tokens"], 64)
        self.assertTrue(summary["complete"])
        self.assertEqual([call["call_index"] for call in summary["calls"]], [1, 2])

    def test_a_call_that_reported_nothing_makes_the_answer_incomplete(self):
        summary = app.summarize_usage([self.complete_call(120, 30, 150), None], tool_calls=1)
        self.assertTrue(summary["available"], "one call did report usage")
        self.assertFalse(summary["complete"], "but not every call did")
        self.assertEqual(summary["model_calls"], 2)
        self.assertEqual(summary["totals"]["total_tokens"], 150)
        self.assertFalse(summary["calls"][1]["reported"])
        for field in app.USAGE_TOKEN_FIELDS:
            with self.subTest(field=field):
                self.assertIsNone(summary["calls"][1][field])

    def test_a_missing_total_is_derived_locally_and_flagged(self):
        summary = app.summarize_usage(
            [self.complete_call(100, 50, None), self.complete_call(10, 5, None)]
        )
        self.assertTrue(summary["derived_total"])
        self.assertEqual(summary["totals"]["total_tokens"], 165)
        self.assertFalse(summary["complete"], "the provider never sent a total")

    def test_nothing_is_derived_when_a_part_is_also_missing(self):
        summary = app.summarize_usage([self.complete_call(100, None, None)])
        self.assertFalse(summary["derived_total"])
        self.assertIsNone(summary["totals"]["total_tokens"])
        self.assertIn("total_tokens", summary["unavailable"])

    def test_a_provider_total_is_preferred_over_a_derived_one(self):
        summary = app.summarize_usage([self.complete_call(100, 50, 999)])
        self.assertFalse(summary["derived_total"])
        self.assertEqual(summary["totals"]["total_tokens"], 999)

    def test_an_empty_usage_block_is_available_but_has_no_numbers(self):
        summary = app.summarize_usage([{field: None for field in app.USAGE_TOKEN_FIELDS}])
        self.assertTrue(summary["available"])
        self.assertFalse(summary["complete"])
        for field in app.USAGE_TOKEN_FIELDS:
            with self.subTest(field=field):
                self.assertIsNone(summary["totals"][field])

    def test_the_input_list_is_never_modified(self):
        calls = [self.complete_call(120, 30, 150)]
        before = json.dumps(calls, sort_keys=True)
        app.summarize_usage(calls)
        self.assertEqual(json.dumps(calls, sort_keys=True), before)


class ChatLoopUsageTests(unittest.TestCase):
    """run_chat_with_tools: the usage of a real turn, with a fake model."""

    def client(self, script):
        """Build a fake model whose completions answer from a script."""
        completions = FakeCompletions(script)
        return SimpleNamespace(chat=SimpleNamespace(completions=completions)), completions

    def runner(self, name, arguments):
        """Pretend a tool ran, without touching the disk or the network."""
        return {"ok": True, "summary": f"{name} ran once", "path": "example.txt"}

    def test_a_single_call_reports_its_usage_and_keeps_the_two_tuple_return(self):
        client, completions = self.client(
            [text_response("Hello there.", usage=usage_block(prompt=90, completion=12, total=102))]
        )
        usage_out = []

        result = app.run_chat_with_tools(
            client,
            "test-model",
            [{"role": "user", "content": "hi"}],
            tool_runner=self.runner,
            usage_out=usage_out,
        )

        self.assertEqual(len(result), 2, "the return value stays (reply, steps)")
        reply, steps = result
        self.assertEqual(reply, "Hello there.")
        self.assertEqual(steps, [])
        self.assertEqual(len(usage_out), 1, "exactly one summary per answer")
        summary = usage_out[0]
        self.assertTrue(summary["available"])
        self.assertTrue(summary["complete"])
        self.assertEqual(summary["model_calls"], 1)
        self.assertEqual(summary["tool_calls"], 0)
        self.assertEqual(summary["totals"]["total_tokens"], 102)
        self.assertEqual(completions.calls[0]["model"], "test-model")

    def test_a_tool_round_trip_reports_every_model_call_and_the_tool_run(self):
        client, completions = self.client(
            [
                tool_response(
                    "write_file",
                    '{"path": "example.txt", "content": "hi", "overwrite": true}',
                    usage=usage_block(prompt=200, completion=25, total=225),
                ),
                text_response(
                    "The file was updated.",
                    usage=usage_block(prompt=300, completion=15, total=315),
                ),
            ]
        )
        usage_out = []

        reply, steps = app.run_chat_with_tools(
            client,
            "test-model",
            [{"role": "user", "content": "save it"}],
            tool_runner=self.runner,
            usage_out=usage_out,
        )

        self.assertEqual(reply, "The file was updated.")
        self.assertEqual(len(steps), 1)
        summary = usage_out[0]
        self.assertEqual(summary["model_calls"], 2)
        self.assertEqual(summary["tool_calls"], 1, "the tool run is counted separately")
        self.assertEqual(summary["totals"]["input_tokens"], 500)
        self.assertEqual(summary["totals"]["output_tokens"], 40)
        self.assertEqual(summary["totals"]["total_tokens"], 540)
        self.assertTrue(summary["complete"])
        self.assertEqual(len(completions.calls), 2, "two real model calls were made")

    def test_a_response_without_a_usage_block_is_not_reported_and_never_zero(self):
        client, _ = self.client([text_response("No numbers from this provider.")])
        usage_out = []

        app.run_chat_with_tools(client, "test-model", [], usage_out=usage_out)

        summary = usage_out[0]
        self.assertFalse(summary["available"])
        self.assertFalse(summary["complete"])
        self.assertFalse(summary["derived_total"])
        self.assertEqual(summary["model_calls"], 1)
        self.assertFalse(summary["calls"][0]["reported"])
        for field in app.USAGE_TOKEN_FIELDS:
            with self.subTest(field=field):
                self.assertIsNone(summary["totals"][field], "unknown is not zero")

    def test_optional_details_are_reported_only_when_the_provider_sent_them(self):
        client, _ = self.client(
            [
                text_response(
                    "Half reported.",
                    usage=usage_block(prompt=120, completion=30, total=150),
                )
            ]
        )
        usage_out = []

        app.run_chat_with_tools(client, "test-model", [], usage_out=usage_out)

        summary = usage_out[0]
        self.assertTrue(summary["complete"], "the three core counts did arrive")
        self.assertIsNone(summary["totals"]["cached_input_tokens"])
        self.assertIsNone(summary["totals"]["reasoning_tokens"])
        self.assertEqual(
            summary["unavailable"], ["cached_input_tokens", "reasoning_tokens"]
        )

    def test_usage_is_optional_so_older_callers_still_work(self):
        client, _ = self.client([text_response("Old caller.")])

        reply, steps = app.run_chat_with_tools(client, "test-model", [])

        self.assertEqual(reply, "Old caller.")
        self.assertEqual(steps, [])

    def test_each_answer_carries_its_own_usage(self):
        first_client, _ = self.client(
            [text_response("First.", usage=usage_block(prompt=10, completion=5, total=15))]
        )
        second_client, _ = self.client(
            [text_response("Second.", usage=usage_block(prompt=400, completion=60, total=460))]
        )
        first_usage = []
        second_usage = []

        app.run_chat_with_tools(first_client, "test-model", [], usage_out=first_usage)
        app.run_chat_with_tools(second_client, "test-model", [], usage_out=second_usage)

        self.assertEqual(len(first_usage), 1, "a regeneration starts from a clean list")
        self.assertEqual(len(second_usage), 1)
        self.assertEqual(first_usage[0]["totals"]["total_tokens"], 15)
        self.assertEqual(second_usage[0]["totals"]["total_tokens"], 460)

    def test_a_failed_call_leaves_no_usage_for_the_answer(self):
        client, _ = self.client(
            [
                tool_response(
                    "write_file",
                    '{"path": "example.txt", "content": "hi", "overwrite": true}',
                    usage=usage_block(prompt=200, completion=25, total=225),
                ),
                RuntimeError("provider exploded"),
            ]
        )
        usage_out = []

        with self.assertRaises(RuntimeError):
            app.run_chat_with_tools(
                client, "test-model", [], tool_runner=self.runner, usage_out=usage_out
            )

        self.assertEqual(
            usage_out,
            [],
            "a failed turn must not leave a half-finished summary behind",
        )



def search_body():
    """Build a minimal Tavily-like answer body with one result."""
    return json.dumps(
        {
            "query": "current news",
            "results": [
                {
                    "title": "Example News",
                    "url": "https://example.invalid/news",
                    "content": "Something current.",
                }
            ],
        }
    )


def fake_search_transport(url, payload, headers, timeout):
    """Stand in for the only search function that would dial out."""
    return 200, search_body()


class ChatRouteUsageTests(unittest.TestCase):
    """/api/chat: the usage of the answer travels with it, and nothing else."""

    def setUp(self):
        """Use a fake client and a fake environment, never the real ones."""
        self.client = None
        self._patches = [
            mock.patch.dict(os.environ, SETTINGS_ENV),
            mock.patch.object(app, "OpenAI", lambda **kwargs: self.client),
        ]
        for patch in self._patches:
            patch.start()

    def tearDown(self):
        """Undo every patch so the rest of the suite sees a clean module."""
        for patch in reversed(self._patches):
            patch.stop()

    def scripted_client(self, script):
        """Give the route a client whose completions answer from a script."""
        completions = FakeCompletions(script)
        self.client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
        return completions

    def call_chat(self, message, history=None):
        """Call the route handler the way FastAPI would, but offline."""
        request = app.ChatRequest(message=message, history=history or [])
        return app.chat(request)

    def test_the_route_attaches_the_usage_of_the_answer(self):
        self.scripted_client(
            [text_response("Hello there.", usage=usage_block(prompt=90, completion=12, total=102))]
        )

        answer = self.call_chat("hi", history=[{"role": "user", "content": "hello"}])

        self.assertEqual(answer["reply"], "Hello there.")
        self.assertEqual(answer["model"], "test-model")
        self.assertNotIn("steps", answer)
        self.assertIn("usage", answer, "the page needs the numbers to show them")
        usage = answer["usage"]
        self.assertTrue(usage["available"])
        self.assertTrue(usage["complete"])
        self.assertEqual(usage["model_calls"], 1)
        self.assertEqual(usage["tool_calls"], 0)
        self.assertEqual(usage["totals"]["total_tokens"], 102)
        self.assertEqual(usage["calls"][0]["call_index"], 1)

    def test_the_route_reports_every_model_call_when_a_tool_runs(self):
        self.scripted_client(
            [
                tool_response(
                    "web_search",
                    '{"query": "current news", "max_results": 1}',
                    usage=usage_block(prompt=200, completion=25, total=225),
                    call_id="call_search_1",
                ),
                text_response(
                    "Found it.",
                    usage=usage_block(prompt=300, completion=15, total=315),
                ),
            ]
        )

        env = {app.web_search_tool.api_key_env: FAKE_KEY}
        with mock.patch.dict(os.environ, env):
            with mock.patch.object(app.web_search_tool, "_post_json", fake_search_transport):
                answer = self.call_chat("what is current?")

        self.assertEqual(answer["reply"], "Found it.")
        self.assertEqual(len(answer["steps"]), 1)
        self.assertEqual(answer["steps"][0]["name"], "web_search")
        usage = answer["usage"]
        self.assertEqual(usage["model_calls"], 2, "the tool round trip costs two calls")
        self.assertEqual(usage["tool_calls"], 1, "but only one tool run")
        self.assertEqual(usage["totals"]["input_tokens"], 500)
        self.assertEqual(usage["totals"]["output_tokens"], 40)
        self.assertEqual(usage["totals"]["total_tokens"], 540)

    def test_the_route_says_not_reported_instead_of_zero(self):
        self.scripted_client([text_response("No numbers from this provider.")])

        answer = self.call_chat("hi")

        self.assertEqual(answer["reply"], "No numbers from this provider.")
        usage = answer["usage"]
        self.assertFalse(usage["available"])
        self.assertFalse(usage["complete"])
        self.assertEqual(usage["model_calls"], 1)
        self.assertFalse(usage["calls"][0]["reported"])
        for field in app.USAGE_TOKEN_FIELDS:
            with self.subTest(field=field):
                self.assertIsNone(usage["totals"][field])

    def test_the_route_never_echoes_credentials_or_provider_settings(self):
        self.scripted_client(
            [text_response("Hello there.", usage=usage_block(prompt=90, completion=12, total=102))]
        )

        answer = self.call_chat("hi")
        body = json.dumps(answer)

        for secret in (FAKE_KEY, SETTINGS_ENV["BASE_URL"], "api_key", "base_url"):
            with self.subTest(secret=secret):
                self.assertNotIn(secret, body)
        self.assertIn("usage", answer, "the honest numbers are still reported")






