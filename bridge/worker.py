"""Sequential Claude Code worker. Disabled by default; subscription auth only."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
import subprocess
import sys
import threading
import time

try:
    from .common import (BridgeError, FileLock, Store, atomic_write, available_claude, image_keys, json_bytes, now_ms, read_json, validate_id, validate_job, write_json)
except ImportError:
    from common import (BridgeError, FileLock, Store, atomic_write, available_claude, image_keys, json_bytes, now_ms, read_json, validate_id, validate_job, write_json)

OUTPUT_LIMIT = 2 * 1024 * 1024
STDERR_LIMIT = 128 * 1024
AUTH_OUTPUT_LIMIT = 64 * 1024


@dataclass
class ClaudeResult:
    text: str = ""
    error: str = ""
    pause: bool = False
    retry_on_resume: bool = False


def subscription_environment(environment=None):
    env = dict(os.environ if environment is None else environment)
    # Keep the ordinary OS login/keychain. Never read or export its contents.
    for key in list(env):
        upper = key.upper()
        if upper.startswith(("ANTHROPIC_", "CLAUDE_CODE_", "CLAUDE_AGENT_SDK_", "AWS_", "AZURE_", "GOOGLE_")) or upper in ("CLAUDE_CONFIG_DIR", "CLAUDECODE", "NODE_OPTIONS"):
            del env[key]
    return env


def claude_command(config):
    return [config["claudePath"], "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", config.get("model", "sonnet"), "--tools", "", "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--no-session-persistence", "--disable-slash-commands", "--max-turns", "1", "--safe-mode", "--no-chrome"]


def claude_input(job):
    content = [{"type": "text", "text": job["prompt"]}]
    for image in job["images"]:
        content.append({"type": "image", "source": {"type": "base64", "media_type": image["mime"], "data": image["data"]}})
    return json_bytes({"type": "user", "message": {"role": "user", "content": content}, "parent_tool_use_id": None, "session_id": ""}) + b"\n"


def classify_error(value):
    value = value.lower()
    if any(text in value for text in ("not logged in", "not authenticated", "authentication", "unauthorized", "invalid api key", "401", "please run /login", "please login", "oauth token", "login required")):
        return ClaudeResult(error="authentication_required", pause=True, retry_on_resume=True)
    if any(text in value for text in ("rate limit", "rate_limit", "usage limit", "usage_limit", "429", "hit your limit", "limit reached", "out of extra usage", "credit balance")):
        return ClaudeResult(error="usage_limit", pause=True, retry_on_resume=True)
    if any(text in value for text in ("enotfound", "econnrefused", "econnreset", "etimedout", "network", "fetch failed", "connection error", "connection failed", "connection refused", "could not resolve", "unable to connect", "offline")):
        return ClaudeResult(error="offline", pause=True, retry_on_resume=True)
    if any(text in value for text in ("unknown option", "unknown argument", "unrecognized option", "unsupported option")):
        return ClaudeResult(error="claude_update_required", pause=True, retry_on_resume=True)
    return ClaudeResult(error="claude_failed", pause=True)


def parse_output(raw, stderr, exit_code, kind):
    try:
        text = raw.decode("utf-8")
    except UnicodeError:
        return ClaudeResult(error="invalid_claude_output", pause=True)
    final = []
    try:
        for line in text.splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            if not isinstance(item, dict):
                return ClaudeResult(error="invalid_claude_output", pause=True)
            if item.get("type") == "assistant":
                message = item.get("message", {})
                if not isinstance(message, dict) or message.get("stop_reason") not in (None, "end_turn", "stop_sequence"):
                    return ClaudeResult(error="incomplete_claude_result", pause=True)
                blocks = message.get("content", [])
                if isinstance(blocks, list) and any(isinstance(block, dict) and block.get("type") == "tool_use" for block in blocks):
                    return ClaudeResult(error="incomplete_claude_result", pause=True)
            if item.get("type") == "stream_event":
                event = item.get("event", {})
                if isinstance(event, dict) and event.get("type") == "message_delta":
                    delta = event.get("delta", {})
                    if not isinstance(delta, dict) or delta.get("stop_reason") not in (None, "end_turn", "stop_sequence"):
                        return ClaudeResult(error="incomplete_claude_result", pause=True)
            if item.get("type") == "result":
                final.append(item)
    except ValueError:
        return classify_error(text + "\n" + stderr.decode("utf-8", "replace")) if exit_code else ClaudeResult(error="invalid_claude_output", pause=True)
    if len(final) != 1:
        if exit_code:
            return classify_error(text + "\n" + stderr.decode("utf-8", "replace"))
        return ClaudeResult(error="missing_final_result", pause=True)
    result = final[0]
    if exit_code or result.get("subtype") != "success" or result.get("is_error") is not False:
        return classify_error(json.dumps(result) + "\n" + stderr.decode("utf-8", "replace"))
    if result.get("permission_denials") or result.get("stop_reason") not in (None, "end_turn", "stop_sequence") or result.get("terminal_reason") not in (None, "end_turn", "stop_sequence", "success"):
        return ClaudeResult(error="incomplete_claude_result", pause=True)
    answer = result.get("result")
    if not isinstance(answer, str) or not answer.strip():
        return ClaudeResult(error="empty_claude_result", pause=True)
    if len(answer) > (6000 if kind == "dialog" else 40000):
        return ClaudeResult(error="claude_result_too_large", pause=True)
    return ClaudeResult(text=answer.strip())


def execute_cli(command, payload, workdir, cancelled, heartbeat, timeout, popen=subprocess.Popen, output_limit=OUTPUT_LIMIT):
    """Bound pipes for both auth and inference; no shell and no credential logs."""
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        process = popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=str(workdir), env=subscription_environment(), shell=False, creationflags=flags)
    except OSError:
        return ClaudeResult(error="claude_start_failed", pause=True, retry_on_resume=True)
    overflow = threading.Event()
    buffers = [bytearray(), bytearray()]

    def drain(pipe, output, maximum):
        try:
            while True:
                piece = pipe.read(65536)
                if not piece:
                    break
                if len(output) + len(piece) > maximum:
                    overflow.set()
                    break
                output.extend(piece)
        except (OSError, ValueError):
            overflow.set()
        finally:
            pipe.close()

    def feed():
        try:
            process.stdin.write(payload)
            process.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            pass
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass

    readers = [threading.Thread(target=drain, args=(process.stdout, buffers[0], output_limit), daemon=True), threading.Thread(target=drain, args=(process.stderr, buffers[1], STDERR_LIMIT), daemon=True), threading.Thread(target=feed, daemon=True)]
    for thread in readers:
        thread.start()
    started, last_beat = time.monotonic(), 0.0
    failure = None
    try:
        while process.poll() is None:
            current = time.monotonic()
            if current - last_beat >= 1:
                heartbeat()
                last_beat = current
            if cancelled():
                failure = ClaudeResult(error="cancelled")
                break
            if overflow.is_set():
                failure = ClaudeResult(error="claude_output_too_large", pause=True)
                break
            if current - started >= timeout:
                failure = ClaudeResult(error="claude_timeout", pause=True)
                break
            time.sleep(0.1)
    except Exception:
        failure = ClaudeResult(error="worker_interrupted", pause=True)
    finally:
        if process.poll() is None:
            process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            failure = ClaudeResult(error="claude_stop_failed", pause=True)
        else:
            for thread in readers:
                thread.join(timeout=2)
    if failure:
        return failure
    if overflow.is_set() or any(thread.is_alive() for thread in readers):
        return ClaudeResult(error="claude_output_too_large", pause=True)
    return bytes(buffers[0]), bytes(buffers[1]), process.returncode


def parse_auth_status(raw, exit_code):
    """Use the public CLI status schema. Never read the credential store ourselves."""
    try:
        value = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError, RecursionError):
        return ClaudeResult(error="subscription_auth_unverified", pause=True, retry_on_resume=True)
    if not isinstance(value, dict):
        return ClaudeResult(error="subscription_auth_unverified", pause=True, retry_on_resume=True)
    if value.get("loggedIn") is not True:
        return ClaudeResult(error="authentication_required", pause=True, retry_on_resume=True)
    # Deliberately allow only personal Pro/Max Claude.ai subscriptions. Console,
    # API keys/helpers, third-party providers, enterprise seats, and new unknown
    # auth methods need an explicit implementation change rather than billing.
    if exit_code != 0 or value.get("authMethod") != "claude.ai" or value.get("apiProvider") != "firstParty" or value.get("subscriptionType") not in ("pro", "max") or value.get("apiKeySource"):
        return ClaudeResult(error="subscription_auth_required", pause=True, retry_on_resume=True)
    return ClaudeResult()


def run_claude(job, config, workdir, cancelled, heartbeat, popen=subprocess.Popen):
    # Preflight is per job: a previously cached Pro login must not permit a later
    # switch to a stored Console/API login. The prompt is not sent to this command.
    auth_command = [config["claudePath"], "--safe-mode", "--setting-sources", "", "auth", "status", "--json"]
    auth_output = execute_cli(auth_command, b"", workdir, cancelled, heartbeat, 15, popen=popen, output_limit=AUTH_OUTPUT_LIMIT)
    if isinstance(auth_output, ClaudeResult):
        if auth_output.error == "cancelled":
            return auth_output
        return ClaudeResult(error="subscription_auth_unverified", pause=True, retry_on_resume=True)
    authenticated = parse_auth_status(auth_output[0], auth_output[2])
    if authenticated.error:
        return authenticated
    if cancelled():
        return ClaudeResult(error="cancelled")
    output = execute_cli(claude_command(config), claude_input(job), workdir, cancelled, heartbeat, config.get("timeoutSeconds", 180), popen=popen)
    if isinstance(output, ClaudeResult):
        return output
    return parse_output(*output, job["kind"])


class Worker:
    def __init__(self, store, runner=run_claude):
        self.store, self.runner = store, runner
        runtime = store.runtime()
        self.pause_reason = runtime.get("pauseReason", "")
        self.resume_id = runtime.get("resumeId", "")
        self.active_id = None
        self.status = "starting"

    def heartbeat(self, status=None):
        if status:
            self.status = status
        write_json(self.store.path("state", "worker.json"), {"pid": os.getpid(), "heartbeat": now_ms(), "status": self.status, "pauseReason": self.pause_reason, "resumeId": self.resume_id, "jobId": self.active_id})

    def recover(self):
        # A previous process may have paid for inference. Never repeat it silently.
        interrupted = []
        with self.store.lock():
            for path in self.store.path("state").glob("*.json"):
                try:
                    job_id = validate_id(path.stem)
                except BridgeError:
                    continue
                state = self.store.state(job_id)
                if state.get("status") == "running":
                    state.update(status="error", error="worker_interrupted", updatedAt=now_ms())
                    self.store.save_state(job_id, state)
                    interrupted.append(job_id)
        for job_id in interrupted:
            self.store.log("worker_interrupted", job_id)

    def cancelled(self):
        if not self.store.refresh().get("enabled", False):
            return True
        state = self.store.state(self.active_id)
        return not state or state.get("status") != "running"

    def step(self):
        config = self.store.refresh()
        if config.get("resumeId", "") != self.resume_id:
            self.resume_id = config.get("resumeId", "")
            self.pause_reason = ""
        if not config.get("enabled", False):
            self.heartbeat("disabled")
            return False
        if self.pause_reason:
            self.heartbeat("paused")
            return False
        if not available_claude(config):
            self.pause_reason = "claude_not_installed"
            self.heartbeat("paused")
            return False
        queued = []
        with self.store.lock():
            for path in self.store.path("state").glob("*.json"):
                try:
                    job_id = validate_id(path.stem)
                except BridgeError:
                    continue
                state = self.store.state(job_id)
                if state.get("status") == "queued":
                    queued.append(state)
            queued.sort(key=lambda state: (state.get("createdAt", 0), state["id"]))
            if not queued:
                self.heartbeat("idle")
                return False
            state = queued[0]
            self.active_id = state["id"]
            try:
                job, digest, _ = validate_job(self.store.job(self.active_id))
                if digest != state.get("digest"):
                    raise BridgeError("job_modified")
            except BridgeError:
                state.update(status="error", error="invalid_job", updatedAt=now_ms())
                self.store.save_state(self.active_id, state)
                self.active_id = None
                return True
            state.update(status="running", updatedAt=now_ms(), attempts=state.get("attempts", 0) + 1)
            state.pop("error", None)
            self.store.save_state(self.active_id, state)
        self.heartbeat("running")
        self.store.log("job_started", self.active_id)
        try:
            result = self.runner(job, config, self.store.path("work"), self.cancelled, self.heartbeat)
        except Exception:
            result = ClaudeResult(error="worker_interrupted", pause=True)
        with self.store.lock():
            latest = self.store.state(self.active_id)
            if latest.get("status") == "cancelled" or result.error == "cancelled" or not self.store.refresh().get("enabled", False):
                latest.update(status="cancelled", error="cancelled", updatedAt=now_ms())
                event = "job_cancelled"
            elif result.error:
                latest.update(status="queued" if result.retry_on_resume else "error", error=result.error, updatedAt=now_ms())
                event = "job_paused" if result.pause else "job_failed"
            else:
                answer = {"id": self.active_id, "status": "done", "request": job["request"], "text": result.text, "imageKeys": image_keys(job), "completedAt": now_ms()}
                atomic_write(self.store.path("outbox", self.active_id + ".txt"), result.text.encode("utf-8"))
                write_json(self.store.path("outbox", self.active_id + ".json"), answer)
                latest.update(status="done", updatedAt=now_ms())
                latest.pop("error", None)
                event = "job_completed"
            self.store.save_state(self.active_id, latest)
        self.store.log(event, self.active_id)
        if result.pause:
            self.pause_reason = result.error
        self.active_id = None
        self.heartbeat("paused" if self.pause_reason else "idle")
        return True

    def run(self, once=False):
        with FileLock(self.store.path("state", "worker.lock")):
            self.recover()
            try:
                while True:
                    self.step()
                    if once:
                        break
                    # Heartbeat remains current even with a long configured poll interval.
                    until = time.monotonic() + self.store.config.get("pollSeconds", 3)
                    while time.monotonic() < until:
                        time.sleep(min(1, max(0, until - time.monotonic())))
                        self.heartbeat()
            finally:
                self.heartbeat("stopped")
                runtime = self.store.runtime()
                runtime["heartbeat"] = 0
                write_json(self.store.path("state", "worker.json"), runtime)


def main(argv=None):
    parser = argparse.ArgumentParser(description="OpenLinks Claude subscription folder worker")
    parser.add_argument("--config")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true")
    mode.add_argument("--loop", action="store_true")
    args = parser.parse_args(argv)
    try:
        store = Store(args.config)
        Worker(store).run(once=args.once)
    except BridgeError as error:
        # Safe fixed codes only. No prompts or credentials on stderr.
        if sys.stderr:
            sys.stderr.write(str(error) + "\n")
        return 2
    except KeyboardInterrupt:
        return 0
    except Exception:
        if sys.stderr:
            sys.stderr.write("worker_internal_error\n")
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
