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
from bridge.worker import ClaudeResult, Worker, claude_command, claude_input, execute_cli, parse_auth_status, parse_output, run_claude, subscription_environment

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
        frames = [{"type": "assistant", "message": {"content": [{"type": "text", "text": "partial"}]}}, {"type": "result", "subtype": "success", "is_error": False, "result": "final", "stop_reason": "end_turn"}]
        raw = b"\n".join(json_bytes(frame) for frame in frames)
        self.assertEqual(parse_output(raw, b"", 0, "dialog").text, "final")
        self.assertEqual(parse_output(json_bytes(frames[0]), b"", 0, "dialog").error, "missing_final_result")

    def test_incomplete_large_or_multiple_results_are_rejected(self):
        success = {"type": "result", "subtype": "success", "is_error": False, "result": "hello"}
        for frame in (dict(success, stop_reason="max_tokens"), dict(success, permission_denials=["tool"]), dict(success, result="x" * 6001), dict(success, result="")):
            self.assertTrue(parse_output(json_bytes(frame), b"", 0, "dialog").error)
        self.assertTrue(parse_output(json_bytes(success) + b"\n" + json_bytes(success), b"", 0, "dialog").error)

    def test_assistant_and_stream_truncation_cannot_hide_behind_success_result(self):
        success = {"type": "result", "subtype": "success", "is_error": False, "result": "half an answer"}
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
        program = "import sys,json,time; data=json.loads(sys.stdin.readline()); time.sleep(1.1); print(json.dumps({'type':'result','subtype':'success','is_error':False,'result':data['message']['content'][0]['text']}))"
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
