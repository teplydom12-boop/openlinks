"""Chrome native messaging endpoint. Stdout is reserved for framed JSON."""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import uuid

try:
    from .common import (BridgeError, EXTENSION_RE, IMAGE_EXTENSIONS, MAX_MESSAGE, MAX_RESPONSE, PROTOCOL, Store, atomic_write, available_claude, image_keys, json_bytes, now_ms, read_json, validate_id, validate_job, valid_model, write_json)
except ImportError:
    from common import (BridgeError, EXTENSION_RE, IMAGE_EXTENSIONS, MAX_MESSAGE, MAX_RESPONSE, PROTOCOL, Store, atomic_write, available_claude, image_keys, json_bytes, now_ms, read_json, validate_id, validate_job, valid_model, write_json)


def read_exact(source, size):
    chunks, remaining = [], size
    while remaining:
        piece = source.read(remaining)
        if not piece:
            raise BridgeError("incomplete_message")
        chunks.append(piece)
        remaining -= len(piece)
    return b"".join(chunks)


def read_message(source):
    size = struct.unpack("<I", read_exact(source, 4))[0]
    if not 1 <= size <= MAX_MESSAGE:
        raise BridgeError("message_too_large")
    try:
        value = json.loads(read_exact(source, size).decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (UnicodeError, ValueError, RecursionError):
        raise BridgeError("invalid_json") from None
    if not isinstance(value, dict):
        raise BridgeError("invalid_message")
    return value


def write_message(output, value):
    payload = json_bytes(value)
    if len(payload) > MAX_RESPONSE:
        payload = json_bytes({"ok": False, "error": "response_too_large"})
    output.write(struct.pack("<I", len(payload)))
    output.write(payload)
    output.flush()


def status(store):
    runtime = store.runtime()
    heartbeat = runtime.get("heartbeat", 0)
    alive = isinstance(heartbeat, int) and 0 <= now_ms() - heartbeat < 20000
    with store.lock():
        capacity = store.capacity()
    return {"ok": True, "protocol": PROTOCOL, "folder": str(store.root), "enabled": store.config.get("enabled", False), "model": store.config.get("model", "sonnet"), "worker": {"running": alive, "heartbeat": heartbeat, "status": runtime.get("status", "stopped") if alive else "stopped", "pauseReason": runtime.get("pauseReason", ""), "jobId": runtime.get("jobId")}, "claude": {"available": available_claude(store.config)}, "capacity": capacity}


def submit(store, value):
    job, digest, decoded = validate_job(value)
    job_id = job["id"]
    with store.lock():
        existing = store.state(job_id)
        if existing:
            if existing.get("digest") != digest:
                raise BridgeError("job_id_conflict")
            return {"ok": True, "jobId": job_id, "status": existing["status"]}
        store.prune_acknowledged()
        capacity = store.capacity()
        required = len(json_bytes(job)) + len(job["prompt"].encode("utf-8")) + sum(map(len, decoded)) + 8192
        # Reserve room for bounded results from every queued input.
        if capacity["jobs"] >= capacity["maxJobs"] or capacity["bytes"] + required + (capacity["jobs"] + 1) * 256 * 1024 > capacity["maxBytes"]:
            raise BridgeError("queue_capacity_reached")
        directory = store.path("inbox", job_id)
        directory.mkdir(exist_ok=True)
        # An interrupted submit may leave immutable input files but no state marker.
        job_path = store.path("inbox", job_id, "job.json")
        if job_path.exists():
            previous, previous_digest, _ = validate_job(read_json(job_path))
            if previous_digest != digest:
                raise BridgeError("job_id_conflict")
        atomic_write(store.path("inbox", job_id, "prompt.txt"), job["prompt"].encode("utf-8"))
        for index, (image, raw) in enumerate(zip(job["images"], decoded)):
            filename = f"image-{index + 1:02d}" + IMAGE_EXTENSIONS[image["mime"]]
            atomic_write(store.path("inbox", job_id, filename), raw)
        write_json(job_path, job)
        store.save_state(job_id, {"id": job_id, "digest": digest, "status": "queued", "createdAt": job["createdAt"], "updatedAt": now_ms(), "attempts": 0})
    store.log("job_queued", job_id)
    return {"ok": True, "jobId": job_id, "status": "queued"}


def poll(store, ids):
    if not isinstance(ids, list) or len(ids) > 20 or len(set(map(str, ids))) != len(ids):
        raise BridgeError("invalid_poll_ids")
    for job_id in ids:
        validate_id(job_id)
    response = {"ok": True, "results": []}
    with store.lock():
        for job_id in ids:
            state = store.state(job_id)
            if not state:
                item = {"id": job_id, "status": "error", "error": "job_not_found"}
            else:
                job = store.job(job_id)
                item = {"id": job_id, "status": state["status"], "request": job["request"]}
                if state.get("error"):
                    item["error"] = state["error"]
                if state["status"] == "done":
                    result = read_json(store.path("outbox", job_id + ".json"), MAX_RESPONSE)
                    if result.get("id") != job_id or result.get("request") != job["request"] or not isinstance(result.get("text"), str) or len(result["text"]) > (6000 if job["kind"] == "dialog" else 40000):
                        raise BridgeError("invalid_result")
                    item["text"] = result["text"]
                    item["imageKeys"] = image_keys(job)
                if state.get("outcome"):
                    item["outcome"] = state["outcome"]
            proposed = {"ok": True, "results": response["results"] + [item]}
            if len(json_bytes(proposed)) > MAX_RESPONSE - 1024:
                response["more"] = True
                break
            response["results"].append(item)
    return response


def acknowledge(store, job_id, outcome):
    validate_id(job_id)
    if outcome not in ("accepted", "stale", "cancelled"):
        raise BridgeError("invalid_outcome")
    with store.lock():
        state = store.state(job_id)
        if not state:
            raise BridgeError("job_not_found")
        if outcome == "accepted" and state["status"] != "done":
            raise BridgeError("job_not_done")
        if state.get("outcome") and state["outcome"] != outcome:
            raise BridgeError("outcome_conflict")
        state.update(outcome=outcome, updatedAt=now_ms())
        if outcome in ("stale", "cancelled"):
            state["status"] = "cancelled"
        store.save_state(job_id, state)
    store.log("job_" + outcome, job_id)
    return {"ok": True, "jobId": job_id, "status": state["status"]}


def configure(store, message):
    enabled = message.get("enabled")
    if not isinstance(enabled, bool):
        raise BridgeError("invalid_enabled")
    model = valid_model(message.get("model", store.config.get("model", "sonnet")))
    with store.lock():
        config = store.refresh()
        config.update(enabled=enabled, model=model, resumeId=str(uuid.uuid4()))
        write_json(store.config_path, config)
    store.log("worker_enabled" if enabled else "worker_disabled")
    return status(store)


def dispatch(store, message):
    action = message.get("action")
    if action == "status":
        return status(store)
    if action == "submit":
        return submit(store, message.get("job"))
    if action == "poll":
        return poll(store, message.get("ids"))
    if action == "ack":
        return acknowledge(store, message.get("id"), message.get("outcome"))
    if action == "cancel":
        return acknowledge(store, message.get("id"), "cancelled")
    if action == "configure":
        return configure(store, message)
    raise BridgeError("unknown_action")


def main(argv=None, source=None, output=None):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--config")
    parser.add_argument("origin", nargs="?")
    # Chrome adds --parent-window=... on Windows; this never affects our execution.
    parser.add_argument("--parent-window")
    options = parser.parse_args(argv)
    source = source or sys.stdin.buffer
    output = output or sys.stdout.buffer
    if os.name == "nt" and source is sys.stdin.buffer:
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    try:
        store = Store(options.config)
        extension_id = store.config.get("extensionId", "")
        if not isinstance(extension_id, str) or not EXTENSION_RE.fullmatch(extension_id) or options.origin != f"chrome-extension://{extension_id}/":
            raise BridgeError("origin_not_allowed")
        if options.parent_window is not None and (not options.parent_window.isdigit() or len(options.parent_window) > 24):
            raise BridgeError("invalid_parent_window")
        result = dispatch(store, read_message(source))
    except BridgeError as error:
        result = {"ok": False, "error": str(error)}
    except Exception:
        # Do not expose file contents, local credentials, or subprocess details.
        result = {"ok": False, "error": "bridge_internal_error"}
    write_message(output, result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
