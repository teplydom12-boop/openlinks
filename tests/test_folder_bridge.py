"""Offline integration tests: never invoke Claude or contact any provider."""
import base64
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.common import BridgeError, FileLock, MAX_MESSAGE, MAX_RESPONSE, RETENTION_MS, Store, json_bytes, now_ms, read_json, write_json
from bridge.native_host import dispatch, main as host_main, read_message, write_message
from bridge.worker import ClaudeResult, Worker, claude_command, claude_input, execute_cli, parse_auth_status, parse_output, run_claude, structured_answer, subscription_environment

AUTH_FIXTURE = {"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "pro"}
AUTH_PROGRAM = "import json; print(json.dumps(" + repr(AUTH_FIXTURE) + "))"


class FolderBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config_path = self.root / "config.json"
        self.config = {"version": 1, "folder": str(self.root / "Desktop" / "OpenLinks-Claude"), "claudePath": str(Path(sys.executable).resolve()), "model": "sonnet", "enabled": False, "timeoutSeconds": 10, "pollSeconds": 1, "extensionId": "a" * 32}
        write_json(self.config_path, self.config)
        self.store = Store(self.config_path)

    def tearDown(self):
        self.temp.cleanup()

    def job(self, **changes):
        value = {"id": str(uuid.uuid4()), "kind": "dialog", "createdAt": now_ms(), "request": {"conversationId": "1688:seller-1", "revision": "confirmed-history-v1", "imageKeys": []}, "prompt": "Ответь продавцу: цена и срок?", "images": []}
        value.update(changes)
        return value

    def submit(self, job):
        return dispatch(self.store, {"action": "submit", "job": job})

    def enable(self):
        return dispatch(self.store, {"action": "configure", "enabled": True})

    def poll(self, *ids):
        return dispatch(self.store, {"action": "poll", "ids": list(ids)})["results"]

    def test_native_framing_unicode_and_short_reads(self):
        class OneByte(io.BytesIO):
            def read(self, size=-1):
                return super().read(min(1, size))
        payload = json_bytes({"action": "status", "text": "你好"})
        self.assertEqual(read_message(OneByte(struct.pack("<I", len(payload)) + payload))["text"], "你好")
        stream = io.BytesIO()
        write_message(stream, {"ok": True})
        self.assertEqual(read_message(io.BytesIO(stream.getvalue())), {"ok": True})

    def test_native_rejects_oversize_truncated_and_non_json(self):
        for raw in (struct.pack("<I", MAX_MESSAGE + 1), b"\x00\x00", struct.pack("<I", 9) + b"{}", struct.pack("<I", 3) + b"NaN", struct.pack("<I", 2) + b"[]"):
            with self.subTest(raw=raw):
                with self.assertRaises(BridgeError):
                    read_message(io.BytesIO(raw))

    def test_host_only_allows_configured_origin(self):
        request = json_bytes({"action": "status"})
        for origin, allowed in (("chrome-extension://" + "a" * 32 + "/", True), ("chrome-extension://" + "b" * 32 + "/", False)):
            output = io.BytesIO()
            host_main(["--config", str(self.config_path), origin, "--parent-window=0"], io.BytesIO(struct.pack("<I", len(request)) + request), output)
            self.assertEqual(read_message(io.BytesIO(output.getvalue()))["ok"], allowed)

    def test_host_rejects_missing_origin_and_invalid_parent_window(self):
        request = json_bytes({"action": "status"})
        for extra in ([], ["chrome-extension://" + "a" * 32 + "/", "--parent-window=evil"]):
            output = io.BytesIO()
            host_main(["--config", str(self.config_path), *extra], io.BytesIO(struct.pack("<I", len(request)) + request), output)
            self.assertFalse(read_message(io.BytesIO(output.getvalue()))["ok"])

    def test_status_has_no_prompt_or_credentials(self):
        job = self.job()
        self.submit(job)
        response = dispatch(self.store, {"action": "status"})
        self.assertFalse(response["enabled"])
        self.assertFalse(response["worker"]["running"])
        self.assertTrue(response["claude"]["available"])
        self.assertNotIn(job["prompt"], json.dumps(response, ensure_ascii=False))

    def test_submit_idempotency_and_changed_job_rejected(self):
        job = self.job()
        self.assertEqual(self.submit(job)["status"], "queued")
        self.assertEqual(self.submit(job)["status"], "queued")
        with self.assertRaisesRegex(BridgeError, "job_id_conflict"):
            self.submit(dict(job, prompt="different"))
        self.assertEqual(self.store.path("inbox", job["id"], "prompt.txt").read_text(encoding="utf-8"), job["prompt"])
        reordered = dict(job, request=dict(reversed(list(job["request"].items()))))
        self.assertEqual(self.submit(reordered)["status"], "queued")

    def test_untrusted_paths_and_invalid_job_ids_are_rejected(self):
        for value in ("../escape", str(uuid.uuid4()).upper(), "C:\\secret", "..", str(uuid.uuid1())):
            with self.subTest(value=value):
                with self.assertRaises(BridgeError):
                    self.submit(self.job(id=value))
        with self.assertRaises(BridgeError):
            self.store.path("inbox", "..", "secret")

    @unittest.skipIf(os.name == "nt", "Creating a symlink may require Windows developer mode")
    def test_symlink_queue_and_output_are_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        job = self.job()
        self.store.path("inbox", job["id"]).symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(BridgeError, "unsafe_path"):
            self.submit(job)
        self.assertEqual(list(outside.iterdir()), [])

    def test_image_names_never_become_paths_and_signatures_checked(self):
        png = b"\x89PNG\r\n\x1a\nfixture"
        job = self.job(images=[{"name": "../../escape.png", "mime": "image/png", "data": base64.b64encode(png).decode()}])
        self.submit(job)
        self.assertEqual(self.store.path("inbox", job["id"], "image-01.png").read_bytes(), png)
        self.assertFalse((self.root / "escape.png").exists())
        with self.assertRaisesRegex(BridgeError, "invalid_image"):
            self.submit(self.job(images=[{"name": "a.png", "mime": "image/png", "data": base64.b64encode(b"not an image").decode()}]))

    def test_image_keys_echo_actual_submitted_images(self):
        image = {"name": "a.png", "mime": "image/png", "data": base64.b64encode(b"\x89PNG\r\n\x1a\nfixture").decode(), "imageKey": "product:image:1"}
        job = self.job(images=[image], request={"revision": 1})
        self.submit(job)
        self.enable()
        Worker(self.store, lambda *_: ClaudeResult(text="answer")).step()
        self.assertEqual(self.poll(job["id"])[0]["imageKeys"], ["product:image:1"])

    def test_disabled_worker_never_invokes_model(self):
        self.submit(self.job())
        def forbidden(*_):
            self.fail("disabled worker invoked model")
        self.assertFalse(Worker(self.store, forbidden).step())
        self.assertEqual(self.store.runtime()["status"], "disabled")

    def test_completed_job_preserves_snapshot_unicode_and_is_acknowledged(self):
        job = self.job()
        self.submit(job)
        self.enable()
        Worker(self.store, lambda *_: ClaudeResult(text="您好，请问价格？")).run(once=True)
        result = self.poll(job["id"])[0]
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["request"], job["request"])
        self.assertEqual(result["text"], "您好，请问价格？")
        self.assertEqual(self.store.path("outbox", job["id"] + ".txt").read_text(encoding="utf-8"), result["text"])
        dispatch(self.store, {"action": "ack", "id": job["id"], "outcome": "accepted"})
        self.assertEqual(self.poll(job["id"])[0]["outcome"], "accepted")
        with self.assertRaisesRegex(BridgeError, "outcome_conflict"):
            dispatch(self.store, {"action": "ack", "id": job["id"], "outcome": "stale"})

    def test_offline_retains_queue_and_pauses_until_explicit_resume(self):
        first, second = self.job(createdAt=1), self.job(createdAt=2)
        self.submit(first)
        self.submit(second)
        self.enable()
        calls = []
        def offline(job, *_):
            calls.append(job["id"])
            return ClaudeResult(error="offline", pause=True, retry_on_resume=True)
        worker = Worker(self.store, offline)
        worker.step()
        for _ in range(3):
            self.assertFalse(worker.step())
        self.assertEqual(calls, [first["id"]])
        self.assertEqual(self.poll(first["id"])[0]["status"], "queued")
        self.assertEqual(self.store.runtime()["pauseReason"], "offline")
        restarted = Worker(self.store, offline)
        self.assertFalse(restarted.step())
        self.enable()
        restarted.step()
        self.assertEqual(calls, [first["id"], first["id"]])

    def test_unknown_error_is_never_retried_after_resume(self):
        job = self.job()
        self.submit(job)
        self.enable()
        calls = []
        def failure(*_):
            calls.append(1)
            return ClaudeResult(error="claude_timeout", pause=True)
        worker = Worker(self.store, failure)
        worker.step()
        self.enable()
        worker.step()
        self.assertEqual(calls, [1])
        self.assertEqual(self.poll(job["id"])[0]["status"], "error")

    def test_inflight_cancel_cannot_be_overwritten_by_late_result(self):
        job = self.job()
        self.submit(job)
        self.enable()
        def cancel(*_):
            dispatch(self.store, {"action": "cancel", "id": job["id"]})
            return ClaudeResult(text="late answer")
        Worker(self.store, cancel).step()
        self.assertEqual(self.poll(job["id"])[0]["status"], "cancelled")
        self.assertFalse(self.store.path("outbox", job["id"] + ".txt").exists())

    def test_cancelled_job_not_dispatched(self):
        job = self.job()
        self.submit(job)
        dispatch(self.store, {"action": "cancel", "id": job["id"]})
        self.enable()
        self.assertFalse(Worker(self.store, lambda *_: self.fail("cancelled dispatch")).step())

    def test_interrupted_jobs_become_error_not_automatic_retry(self):
        job = self.job()
        self.submit(job)
        state = self.store.state(job["id"])
        state["status"] = "running"
        self.store.save_state(job["id"], state)
        self.enable()
        Worker(self.store, lambda *_: self.fail("recovery repeated inference")).run(once=True)
        self.assertEqual(self.poll(job["id"])[0]["error"], "worker_interrupted")

    def test_worker_os_lock_prevents_second_instance_and_releases(self):
        worker = Worker(self.store)
        path = self.store.path("state", "worker.lock")
        with FileLock(path):
            with self.assertRaisesRegex(BridgeError, "worker_already_running"):
                worker.run(once=True)
        worker.run(once=True)

    def test_modify_job_file_is_detected_before_model_call(self):
        job = self.job()
        self.submit(job)
        job["prompt"] = "changed on disk"
        write_json(self.store.path("inbox", job["id"], "job.json"), job)
        self.enable()
        Worker(self.store, lambda *_: self.fail("modified job dispatched")).step()
        self.assertEqual(self.poll(job["id"])[0]["error"], "invalid_job")

    def test_configuration_does_not_accept_executable_from_extension(self):
        dispatch(self.store, {"action": "configure", "enabled": True, "claudePath": "evil", "folder": "evil", "model": "sonnet"})
        self.assertEqual(read_json(self.config_path)["claudePath"], self.config["claudePath"])
        with self.assertRaises(BridgeError):
            dispatch(self.store, {"action": "configure", "enabled": True, "model": "--system-prompt=evil"})

    def test_poll_budget_and_bad_ids(self):
        for ids in ([str(uuid.uuid4())] * 2, [str(uuid.uuid4()) for _ in range(21)], ["../secret"]):
            with self.assertRaises(BridgeError):
                dispatch(self.store, {"action": "poll", "ids": ids})
        ids = []
        for _ in range(10):
            job = self.job(request={"snapshot": "x" * (120 * 1024)})
            self.submit(job)
            ids.append(job["id"])
        result = dispatch(self.store, {"action": "poll", "ids": ids})
        self.assertTrue(result["more"])
        self.assertLess(len(json_bytes(result)), MAX_RESPONSE)
        self.assertGreater(len(result["results"]), 0)

    def test_queue_count_and_disk_quota_do_not_drop_existing_jobs(self):
        first = self.job()
        self.submit(first)
        with mock.patch("bridge.common.MAX_JOBS", 1):
            with self.assertRaisesRegex(BridgeError, "queue_capacity_reached"):
                self.submit(self.job())
            self.assertEqual(self.submit(first)["status"], "queued")
        with mock.patch("bridge.common.MAX_DISK_BYTES", 1):
            with self.assertRaisesRegex(BridgeError, "queue_capacity_reached"):
                self.submit(self.job())
        self.assertEqual(self.poll(first["id"])[0]["status"], "queued")

    def test_retention_removes_only_old_acknowledged_jobs(self):
        acknowledged, unresolved = self.job(), self.job()
        self.submit(acknowledged)
        self.submit(unresolved)
        dispatch(self.store, {"action": "cancel", "id": acknowledged["id"]})
        for job in (acknowledged, unresolved):
            state = self.store.state(job["id"])
            state["updatedAt"] = now_ms() - RETENTION_MS - 1000
            self.store.save_state(job["id"], state)
        self.submit(self.job())
        self.assertIsNone(self.store.state(acknowledged["id"]))
        self.assertFalse(self.store.path("inbox", acknowledged["id"]).exists())
        self.assertIsNotNone(self.store.state(unresolved["id"]))

    def test_only_terminal_result_is_used(self):
        frames = [{"type": "assistant", "message": {"content": [{"type": "text", "text": "partial"}]}}, {"type": "result", "subtype": "success", "is_error": False, "result": "Task summary, not the supplier reply", "structured_output": {"text": "final"}, "stop_reason": "end_turn"}]
        raw = b"\n".join(json_bytes(frame) for frame in frames)
        self.assertEqual(parse_output(raw, b"", 0, "dialog").text, "final")
        self.assertEqual(parse_output(json_bytes(frames[0]), b"", 0, "dialog").error, "missing_final_result")

    def structured_frames(self, payload):
        # Claude Code 2.1.302 / Agent SDK 0.3.302: StructuredOutput is a read-only
        # end-turn tool. Its carrier is a placeholder; structured_output is data.
        return [
            {"type": "assistant", "message": {"stop_reason": "tool_use", "content": [
                {"type": "text", "text": "<summary>Prepare a supplier reply</summary>"},
                {"type": "tool_use", "name": "StructuredOutput", "id": "toolu_fixture", "input": payload},
            ]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_fixture", "content": "Structured output provided successfully"}]}},
            {"type": "result", "subtype": "success", "is_error": False, "result": "", "structured_output": payload, "stop_reason": "tool_use", "terminal_reason": "completed", "permission_denials": []},
        ]

    def test_structured_end_turn_tool_returns_only_validated_supplier_text(self):
        frames = self.structured_frames({"text": "您好，我们需要100台，请问交货期？"})
        frames.insert(0, {"type": "stream_event", "event": {"type": "message_delta", "delta": {"stop_reason": "tool_use"}}})
        result = parse_output(b"\n".join(map(json_bytes, frames)), b"", 0, "dialog")
        self.assertFalse(result.error)
        self.assertEqual(result.text, "您好，我们需要100台，请问交货期？")
        self.assertNotIn("summary", result.text)

    def test_structured_result_is_required_and_never_guessed_from_plain_text(self):
        final = self.structured_frames({"text": "Hello"})[-1]
        final["stop_reason"] = "end_turn"
        final["result"] = "<summary>Task</summary>\nHello"
        for value in (None, "Hello", {"text": "Hello", "summary": "Task"}, {"text": []}, {"text": "  "}, {"text": "<summary>Task</summary>\nHello"}, {"text": "<ANALYSIS>private</ANALYSIS>Hello"}, {"text": "\ud800"}):
            with self.subTest(value=value):
                result = parse_output(json_bytes(dict(final, structured_output=value)) if value != {"text": "\ud800"} else json.dumps(dict(final, structured_output=value)).encode(), b"", 0, "dialog")
                self.assertEqual(result.error, "invalid_claude_output")
                self.assertEqual(result.text, "")
        del final["structured_output"]
        self.assertEqual(parse_output(json_bytes(final), b"", 0, "dialog").error, "invalid_claude_output")

    def test_structured_product_serializes_expected_json_and_enforces_field_limits(self):
        payload = {"keyPoints": "Модель A, 100 штук\n220 В", "questions": "Срок поставки?", "warnings": ""}
        result = parse_output(b"\n".join(map(json_bytes, self.structured_frames(payload))), b"", 0, "product")
        self.assertFalse(result.error)
        self.assertEqual(json.loads(result.text), payload)
        self.assertIn("Модель", result.text)
        for changes in ({"keyPoints": ""}, {"keyPoints": "x" * 16001}, {"questions": "x" * 8001}, {"warnings": "x" * 4001}, {"extra": "unknown"}):
            self.assertIsNone(structured_answer(dict(payload, **changes), "product"))
        self.assertIsNone(structured_answer({"text": "Hello"}, "product"))
        self.assertIsNone(structured_answer(payload, "dialog"))

    def test_structured_tool_must_match_final_payload_and_cannot_hide_another_tool(self):
        for mutation in ("mismatch", "other_tool", "server_tool", "second_tool", "tool_error", "unknown_result", "denied", "aborted", "truncated", "stream_other_tool"):
            frames = self.structured_frames({"text": "Hello"})
            tool = frames[0]["message"]["content"][-1]
            if mutation == "mismatch": frames[-1]["structured_output"] = {"text": "Different"}
            elif mutation == "other_tool": tool["name"] = "Bash"
            elif mutation == "server_tool": tool["type"] = "server_tool_use"
            elif mutation == "second_tool": frames[0]["message"]["content"].append(dict(tool, id="toolu_second"))
            elif mutation == "tool_error": frames[1]["message"]["content"][0]["is_error"] = True
            elif mutation == "unknown_result": frames[1]["message"]["content"][0]["tool_use_id"] = "unknown"
            elif mutation == "denied": frames[-1]["permission_denials"] = [{"tool_name": "StructuredOutput"}]
            elif mutation == "aborted": frames[0]["aborted"] = True
            elif mutation == "truncated": frames[0]["message"]["stop_reason"] = "max_tokens"
            elif mutation == "stream_other_tool": frames.insert(0, {"type": "stream_event", "event": {"type": "content_block_start", "content_block": {"type": "tool_use", "name": "Read"}}})
            with self.subTest(mutation=mutation):
                self.assertEqual(parse_output(b"\n".join(map(json_bytes, frames)), b"", 0, "dialog").error, "incomplete_claude_result")

    def test_tool_stop_without_validated_structured_tool_is_rejected(self):
        final = self.structured_frames({"text": "Hello"})[-1]
        self.assertEqual(parse_output(json_bytes(final), b"", 0, "dialog").error, "incomplete_claude_result")
        final["stop_reason"] = "end_turn"
        stream = {"type": "stream_event", "event": {"type": "message_delta", "delta": {"stop_reason": "tool_use"}}}
        self.assertEqual(parse_output(json_bytes(stream) + b"\n" + json_bytes(final), b"", 0, "dialog").error, "incomplete_claude_result")

    def test_sdk_completed_terminal_reason_accepts_only_a_successful_finished_turn(self):
        # @anthropic-ai/claude-agent-sdk 0.3.302 sdk.d.ts: SDKResultSuccess and
        # TerminalReason; Claude Code 2.1.302 emits completed, not end_turn here.
        assistant = {"type": "assistant", "parent_tool_use_id": None, "message": {"role": "assistant", "stop_reason": None, "content": [{"type": "text", "text": "We need 100 units. What is the lead time?"}]}}
        final = {"type": "result", "subtype": "success", "is_error": False, "num_turns": 1, "stop_reason": "end_turn", "terminal_reason": "completed", "permission_denials": [], "result": assistant["message"]["content"][0]["text"], "structured_output": {"text": assistant["message"]["content"][0]["text"]}, "usage": {"input_tokens": 120, "output_tokens": 18}}
        raw = json_bytes(assistant) + b"\n" + json_bytes(final)
        parsed = parse_output(raw, b"", 0, "dialog")
        self.assertFalse(parsed.error)
        self.assertEqual(parsed.text, final["result"])
        self.assertEqual(parsed.usage, {"inputTokens": 120, "outputTokens": 18})
        blocked = ("blocking_limit", "rapid_refill_breaker", "prompt_too_long", "image_error", "model_error", "api_error", "malformed_tool_use_exhausted", "aborted_streaming", "aborted_tools", "stop_hook_prevented", "hook_stopped", "tool_deferred", "max_turns", "background_requested", "budget_exhausted", "structured_output_retry_exhausted", "tool_deferred_unavailable", "turn_setup_failed", "unknown_future_reason")
        for reason in blocked:
            with self.subTest(terminal_reason=reason):
                self.assertEqual(parse_output(json_bytes(dict(final, terminal_reason=reason)), b"", 0, "dialog").error, "incomplete_claude_result")
        self.assertEqual(parse_output(json_bytes(dict(assistant, aborted=True)) + b"\n" + json_bytes(final), b"", 0, "dialog").error, "incomplete_claude_result")
        for change in ({"stop_reason": "max_tokens"}, {"permission_denials": [{"tool_name": "Bash"}]}, {"is_error": True}, {"subtype": "error_max_turns"}):
            self.assertTrue(parse_output(json_bytes(dict(final, **change)), b"", 0, "dialog").error)
        self.assertTrue(parse_output(raw, b"", 1, "dialog").error)

    def test_token_usage_keeps_only_bounded_counts_from_successful_final_result(self):
        usage = {"input_tokens": 125, "output_tokens": 40, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 500, "secret": "private", "email": "private@example.test"}
        final = {"type": "result", "subtype": "success", "is_error": False, "result": "", "structured_output": {"text": "A complete draft"}, "usage": usage, "total_cost_usd": 20, "modelUsage": {"private-model": {"private": "private"}}}
        result = parse_output(json_bytes(final), b"", 0, "dialog")
        self.assertEqual(result.usage, {"inputTokens": 125, "outputTokens": 40, "cacheReadInputTokens": 1000, "cacheCreationInputTokens": 500})
        for invalid in (True, -1, 1.5, "125", None, 1_000_000_001, {"private": "value"}):
            frame = dict(final, usage={"input_tokens": invalid, "output_tokens": 40})
            parsed = parse_output(json_bytes(frame), b"", 0, "dialog")
            self.assertEqual(parsed.text, "A complete draft")
            self.assertEqual(parsed.usage, {"outputTokens": 40})
        self.assertEqual(parse_output(json_bytes(dict(final, usage="private")), b"", 0, "dialog").usage, {})
        self.assertEqual(parse_output(json_bytes(dict(final, is_error=True)), b"", 1, "dialog").usage, {})

    def test_worker_records_usage_in_json_without_changing_reply_txt(self):
        job = self.job()
        self.submit(job)
        self.enable()
        frame = {"type": "result", "subtype": "success", "is_error": False, "result": "<summary>Ask the lead time</summary>", "structured_output": {"text": "您好，请问交货期？"}, "usage": {"input_tokens": 123, "output_tokens": 20, "private": "do not save"}}
        Worker(self.store, lambda *_: parse_output(json_bytes(frame), b"", 0, "dialog")).run(once=True)
        response = read_json(self.store.path("outbox", job["id"] + ".json"))
        self.assertEqual(response["usage"], {"inputTokens": 123, "outputTokens": 20})
        self.assertEqual(self.store.path("outbox", job["id"] + ".txt").read_text(encoding="utf-8"), frame["structured_output"]["text"])
        self.assertEqual(self.poll(job["id"])[0]["text"], frame["structured_output"]["text"])
        self.assertNotIn("do not save", json.dumps(response))

    def test_incomplete_large_or_multiple_results_are_rejected(self):
        success = {"type": "result", "subtype": "success", "is_error": False, "result": "", "structured_output": {"text": "hello"}}
        for frame in (dict(success, stop_reason="max_tokens"), dict(success, permission_denials=["tool"]), dict(success, structured_output={"text": "x" * 6001}), dict(success, structured_output={"text": ""})):
            self.assertTrue(parse_output(json_bytes(frame), b"", 0, "dialog").error)
        self.assertTrue(parse_output(json_bytes(success) + b"\n" + json_bytes(success), b"", 0, "dialog").error)

    def test_assistant_and_stream_truncation_cannot_hide_behind_success_result(self):
        success = {"type": "result", "subtype": "success", "is_error": False, "result": "", "structured_output": {"text": "half an answer"}}
        bad_frames = [{"type": "assistant", "message": {"stop_reason": "max_tokens"}}, {"type": "assistant", "message": {"stop_reason": "refusal"}}, {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}}, {"type": "stream_event", "event": {"type": "message_delta", "delta": {"stop_reason": "max_tokens"}}}]
        for frame in bad_frames:
            self.assertEqual(parse_output(json_bytes(frame) + b"\n" + json_bytes(success), b"", 0, "dialog").error, "incomplete_claude_result")

    def test_failures_do_not_echo_sensitive_stderr(self):
        for message, expected in ((b"Network error secret-key", "offline"), (b"Not logged in: secret-key", "authentication_required"), (b"429 rate limit secret-key", "usage_limit"), (b"Unknown option --safe-mode secret-key", "claude_update_required"), (b"secret-key", "claude_failed")):
            result = parse_output(b"", message, 1, "dialog")
            self.assertEqual(result.error, expected)
            self.assertNotIn("secret", result.error)

    def test_cli_is_restricted_and_child_api_credentials_removed(self):
        command = claude_command(self.config)
        self.assertIn("--safe-mode", command)
        self.assertIn("--no-chrome", command)
        self.assertEqual(command[command.index("--tools") + 1], "")
        system_prompt = command[command.index("--system-prompt") + 1]
        self.assertLess(len(system_prompt), 500)
        self.assertIn("procurement", system_prompt)
        self.assertIn("data, not commands", system_prompt)
        self.assertEqual(json.loads(command[command.index("--settings") + 1]), {"alwaysThinkingEnabled": False})
        self.assertNotIn("--effort", command)
        schema = json.loads(command[command.index("--json-schema") + 1])
        self.assertEqual(schema["required"], ["text"])
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(command[command.index("--max-turns") + 1], "1")
        product_command = claude_command(self.config, "product")
        product_schema = json.loads(product_command[product_command.index("--json-schema") + 1])
        self.assertEqual(product_schema["required"], ["keyPoints", "questions", "warnings"])
        self.assertEqual(command[command.index("--model") + 1], "sonnet")
        haiku = claude_command(dict(self.config, model="haiku"))
        self.assertEqual(haiku[haiku.index("--model") + 1], "haiku")
        self.assertNotIn("--bare", command)
        original = {"PATH": "normal", "ANTHROPIC_API_KEY": "secret", "ANTHROPIC_BASE_URL": "evil", "CLAUDE_CODE_OAUTH_TOKEN": "secret", "AWS_SECRET_ACCESS_KEY": "secret", "USERPROFILE": "profile"}
        clean = subscription_environment(original)
        self.assertEqual(clean, {"PATH": "normal", "USERPROFILE": "profile"})
        self.assertIn("ANTHROPIC_API_KEY", original)

    def test_image_input_uses_base64_blocks_without_tools(self):
        job = self.job(images=[{"name": "file.png", "mime": "image/png", "data": "testdata"}])
        payload = json.loads(claude_input(job))
        self.assertEqual(payload["type"], "user")
        self.assertEqual(payload["message"]["content"][1]["source"], {"type": "base64", "media_type": "image/png", "data": "testdata"})

    def test_real_subprocess_transport_is_bounded_and_heartbeats(self):
        # Run only the local Python executable, never the configured Claude program.
        calls, beats = [], []
        program = "import sys,json,time; data=json.loads(sys.stdin.readline()); time.sleep(1.1); print(json.dumps({'type':'result','subtype':'success','is_error':False,'result':'','structured_output':{'text':data['message']['content'][0]['text']}}))"
        def fake_popen(command, **kwargs):
            calls.append(command)
            return subprocess.Popen([sys.executable, "-c", AUTH_PROGRAM if "auth" in command else program], **kwargs)
        result = run_claude(self.job(), self.config, self.store.path("work"), lambda: False, lambda: beats.append(1), popen=fake_popen)
        self.assertFalse(result.error)
        self.assertGreaterEqual(len(beats), 2)
        self.assertEqual(len(calls), 2)
        self.assertIn("auth", calls[0])
        self.assertIn("--print", calls[1])

    def test_cancellation_stops_process_without_consuming_answer(self):
        def fake_popen(command, **kwargs):
            return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(10)"], **kwargs)
        started = time.monotonic()
        result = run_claude(self.job(), self.config, self.store.path("work"), lambda: True, lambda: None, popen=fake_popen)
        self.assertEqual(result.error, "cancelled")
        self.assertLess(time.monotonic() - started, 4)

    def test_process_stop_failure_overrides_cancellation(self):
        class UnstoppableFixture:
            stdin = io.BytesIO()
            stdout = io.BytesIO()
            stderr = io.BytesIO()
            def poll(self):
                return None
            def kill(self):
                pass
            def wait(self, timeout):
                raise subprocess.TimeoutExpired("fixture", timeout)
        result = execute_cli(["fixture"], b"", self.store.path("work"), lambda: True, lambda: None, 1, popen=lambda *_, **__: UnstoppableFixture())
        self.assertEqual(result.error, "claude_stop_failed")
        self.assertTrue(result.pause)

    def test_output_overflow_terminates_process(self):
        def fake_popen(command, **kwargs):
            return subprocess.Popen([sys.executable, "-c", AUTH_PROGRAM if "auth" in command else "import sys; sys.stdout.write('x'*3000000); sys.stdout.flush()"], **kwargs)
        result = run_claude(self.job(), self.config, self.store.path("work"), lambda: False, lambda: None, popen=fake_popen)
        self.assertEqual(result.error, "claude_output_too_large")

    def test_auth_preflight_allows_only_verified_personal_subscription(self):
        for subscription in ("pro", "max"):
            self.assertFalse(parse_auth_status(json_bytes(dict(AUTH_FIXTURE, subscriptionType=subscription)), 0).error)
        invalid = [dict(AUTH_FIXTURE, authMethod="api_key"), dict(AUTH_FIXTURE, authMethod="api_key_helper"), dict(AUTH_FIXTURE, authMethod="oauth_token"), dict(AUTH_FIXTURE, authMethod="third_party"), dict(AUTH_FIXTURE, apiProvider="bedrock"), dict(AUTH_FIXTURE, subscriptionType=None), dict(AUTH_FIXTURE, subscriptionType="team"), dict(AUTH_FIXTURE, subscriptionType="enterprise"), dict(AUTH_FIXTURE, apiKeySource="console"), {"loggedIn": True}]
        for value in invalid:
            with self.subTest(value=value):
                result = parse_auth_status(json_bytes(value), 0)
                self.assertEqual(result.error, "subscription_auth_required")
                self.assertTrue(result.pause)
                self.assertTrue(result.retry_on_resume)
        self.assertEqual(parse_auth_status(json_bytes(dict(AUTH_FIXTURE, loggedIn=False)), 1).error, "authentication_required")
        self.assertEqual(parse_auth_status(b"not json private-email", 1).error, "subscription_auth_unverified")
        self.assertTrue(parse_auth_status(json_bytes(AUTH_FIXTURE), 1).error)

    def test_console_auth_never_invokes_model_or_receives_prompt(self):
        calls, private_prompt = [], "SENSITIVE SUPPLIER MESSAGE"
        def fake_popen(command, **kwargs):
            calls.append(command)
            self.assertIn("auth", command)
            # Assert auth stdin is empty; saved Console API keys must not allow -p.
            program = "import json,sys; assert sys.stdin.read()==''; print(json.dumps({'loggedIn':True,'authMethod':'api_key','apiProvider':'firstParty','email':'private@example.test'}))"
            return subprocess.Popen([sys.executable, "-c", program], **kwargs)
        result = run_claude(self.job(prompt=private_prompt), self.config, self.store.path("work"), lambda: False, lambda: None, popen=fake_popen)
        self.assertEqual(result.error, "subscription_auth_required")
        self.assertEqual(len(calls), 1)
        self.assertNotIn("private", result.error)
        self.assertNotIn(private_prompt, str(calls))

    def test_auth_schema_failure_and_overflow_pause_without_inference(self):
        for program in ("print('unexpected private-email')", "import sys; sys.stdout.write('x'*100000); sys.stdout.flush()"):
            calls = []
            def fake_popen(command, **kwargs):
                calls.append(command)
                self.assertIn("auth", command)
                return subprocess.Popen([sys.executable, "-c", program], **kwargs)
            result = run_claude(self.job(), self.config, self.store.path("work"), lambda: False, lambda: None, popen=fake_popen)
            self.assertEqual(result.error, "subscription_auth_unverified")
            self.assertEqual(len(calls), 1)
            self.assertTrue(result.retry_on_resume)

    def test_logging_has_ids_and_events_only(self):
        job = self.job(prompt="SENSITIVE MESSAGE")
        self.submit(job)
        raw = self.store.path("logs", "bridge.jsonl").read_text(encoding="utf-8")
        self.assertNotIn(job["prompt"], raw)
        record = json.loads(raw.strip())
        self.assertEqual(set(record), {"time", "event", "id"})


if __name__ == "__main__":
    unittest.main()
