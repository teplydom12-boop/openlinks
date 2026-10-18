"""Shared storage and validation. Never log prompts, conversations, or credentials."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

PROTOCOL = 1
MAX_MESSAGE = 32 * 1024 * 1024
MAX_RESPONSE = 950 * 1024
MAX_PROMPT = 2 * 1024 * 1024
MAX_REQUEST = 128 * 1024
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGES = 12
MAX_JOBS = 500
MAX_DISK_BYTES = 512 * 1024 * 1024
RETENTION_MS = 30 * 24 * 60 * 60 * 1000
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
EXTENSION_RE = re.compile(r"^[a-p]{32}$")
IMAGE_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}


class BridgeError(Exception):
    """An intentionally safe, static error suitable for the extension."""


def now_ms():
    return int(time.time() * 1000)


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def default_config():
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        raise BridgeError("config_not_found")
    return Path(local) / "OpenLinksClaude" / "config.json"


def is_link(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def require_plain(path):
    if is_link(path):
        raise BridgeError("unsafe_path")


def read_json(path, limit=MAX_MESSAGE):
    require_plain(path)
    try:
        with path.open("rb") as source:
            raw = source.read(limit + 1)
        if len(raw) > limit:
            raise BridgeError("file_too_large")
        return json.loads(raw.decode("utf-8-sig"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (UnicodeError, ValueError, RecursionError):
        raise BridgeError("invalid_json") from None


def atomic_write(path, data):
    """Use a sibling temporary file and replace only after flushing its contents."""
    require_plain(path.parent)
    require_plain(path)
    temp = path.parent / ("." + path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temp.open("xb") as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        require_plain(path)
        os.replace(temp, path)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def write_json(path, value):
    atomic_write(path, json_bytes(value))


class FileLock:
    """OS-owned advisory lock; stale PID files cannot deadlock the worker."""
    def __init__(self, path, blocking=False):
        self.path, self.blocking, self.file = path, blocking, None

    def __enter__(self):
        require_plain(self.path)
        self.file = self.path.open("a+b")
        if self.file.tell() == 0:
            self.file.write(b"0")
            self.file.flush()
        self.file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                mode = msvcrt.LK_LOCK if self.blocking else msvcrt.LK_NBLCK
                msvcrt.locking(self.file.fileno(), mode, 1)
            else:
                import fcntl
                mode = fcntl.LOCK_EX | (0 if self.blocking else fcntl.LOCK_NB)
                fcntl.flock(self.file.fileno(), mode)
        except OSError:
            self.file.close()
            self.file = None
            raise BridgeError("worker_already_running" if self.path.name == "worker.lock" else "storage_busy") from None
        return self

    def __exit__(self, *_):
        if self.file:
            if os.name == "nt":
                import msvcrt
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
            self.file.close()
            self.file = None


def validate_id(value):
    if not isinstance(value, str):
        raise BridgeError("invalid_job_id")
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        raise BridgeError("invalid_job_id") from None
    if str(parsed) != value or parsed.version != 4:
        raise BridgeError("invalid_job_id")
    return value


def valid_model(value):
    if not isinstance(value, str) or not MODEL_RE.fullmatch(value):
        raise BridgeError("invalid_model")
    return value


class Store:
    def __init__(self, config_path=None):
        self.config_path = Path(config_path) if config_path else default_config()
        self.config = self.load_config()
        self.root = Path(self.config["folder"])
        require_plain(self.root)
        self.root.mkdir(parents=True, exist_ok=True)
        for directory in ("inbox", "outbox", "state", "logs", "work"):
            self.path(directory).mkdir(exist_ok=True)

    def load_config(self):
        try:
            config = read_json(self.config_path, 32 * 1024)
        except FileNotFoundError:
            raise BridgeError("config_not_found") from None
        if not isinstance(config, dict) or config.get("version") != PROTOCOL:
            raise BridgeError("invalid_config")
        folder = config.get("folder")
        if not isinstance(folder, str) or not Path(folder).is_absolute():
            raise BridgeError("invalid_folder")
        if not isinstance(config.get("enabled", False), bool):
            raise BridgeError("invalid_config")
        valid_model(config.get("model", "sonnet"))
        executable = config.get("claudePath", "")
        if executable and (not isinstance(executable, str) or not Path(executable).is_absolute()):
            raise BridgeError("invalid_claude_path")
        for key, fallback, minimum, maximum in (("timeoutSeconds", 180, 10, 900), ("pollSeconds", 3, 1, 60)):
            number = config.get(key, fallback)
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not minimum <= number <= maximum:
                raise BridgeError("invalid_config")
        return config

    def refresh(self):
        config = self.load_config()
        if config["folder"] != str(self.root):
            raise BridgeError("folder_changed_restart_required")
        self.config = config
        return config

    def path(self, *parts):
        current = self.root
        require_plain(current)
        for part in parts:
            if not isinstance(part, str) or part in ("", ".", "..") or "/" in part or "\\" in part or ":" in part:
                raise BridgeError("unsafe_path")
            current = current / part
            require_plain(current)
        return current

    def lock(self):
        return FileLock(self.path("state", "storage.lock"), blocking=True)

    def state_path(self, job_id):
        return self.path("state", validate_id(job_id) + ".json")

    def state(self, job_id):
        try:
            return read_json(self.state_path(job_id), 16 * 1024)
        except FileNotFoundError:
            return None

    def save_state(self, job_id, value):
        write_json(self.state_path(job_id), value)

    def runtime(self):
        try:
            value = read_json(self.path("state", "worker.json"), 16 * 1024)
            return value if isinstance(value, dict) else {}
        except FileNotFoundError:
            return {}

    def job(self, job_id):
        return read_json(self.path("inbox", validate_id(job_id), "job.json"))

    def log(self, event, job_id=None):
        # Keep logs bounded and do not copy subprocess output or exception strings.
        if not re.fullmatch(r"[a-z_]{1,60}", event):
            raise BridgeError("invalid_log_event")
        path = self.path("logs", "bridge.jsonl")
        with self.lock():
            if path.exists() and path.stat().st_size > 1024 * 1024:
                archived = self.path("logs", "bridge.previous.jsonl")
                os.replace(path, archived)
            record = {"time": now_ms(), "event": event}
            if job_id:
                record["id"] = validate_id(job_id)
            with path.open("ab") as output:
                output.write(json_bytes(record) + b"\n")

    def capacity(self):
        count, used = 0, 0
        for directory, directories, files in os.walk(self.root, followlinks=False):
            base = Path(directory)
            require_plain(base)
            for name in directories:
                require_plain(base / name)
            for name in files:
                path = base / name
                require_plain(path)
                try:
                    used += path.stat().st_size
                except FileNotFoundError:
                    # Heartbeats atomically replace short-lived sibling temp files.
                    continue
                if base == self.path("state"):
                    try:
                        validate_id(path.stem)
                        count += 1
                    except BridgeError:
                        pass
        return {"jobs": count, "maxJobs": MAX_JOBS, "bytes": used, "maxBytes": MAX_DISK_BYTES, "retentionDays": 30}

    def prune_acknowledged(self):
        """Called with the storage lock. Only explicit acknowledgements expire."""
        cutoff = now_ms() - RETENTION_MS
        for path in self.path("state").glob("*.json"):
            try:
                job_id = validate_id(path.stem)
            except BridgeError:
                continue
            state = self.state(job_id)
            if state.get("outcome") not in ("accepted", "stale", "cancelled") or state.get("updatedAt", now_ms()) > cutoff:
                continue
            folder = self.path("inbox", job_id)
            if folder.exists():
                entries = list(folder.iterdir())
                for entry in entries:
                    require_plain(entry)
                    if not entry.is_file():
                        raise BridgeError("unsafe_path")
                for entry in entries:
                    entry.unlink()
                folder.rmdir()
            for extension in (".json", ".txt"):
                self.path("outbox", job_id + extension).unlink(missing_ok=True)
            path.unlink()


def validate_job(value):
    if not isinstance(value, dict):
        raise BridgeError("invalid_job")
    job_id = validate_id(value.get("id"))
    kind = value.get("kind")
    if kind not in ("dialog", "product"):
        raise BridgeError("invalid_job_kind")
    created = value.get("createdAt")
    if isinstance(created, bool) or not isinstance(created, int) or created < 0 or created > 2**53 - 1:
        raise BridgeError("invalid_job_time")
    request = value.get("request")
    if not isinstance(request, dict) or len(json_bytes(request)) > MAX_REQUEST:
        raise BridgeError("invalid_request")
    prompt = value.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode("utf-8")) > MAX_PROMPT:
        raise BridgeError("invalid_prompt")
    images = value.get("images", [])
    if not isinstance(images, list) or len(images) > MAX_IMAGES:
        raise BridgeError("invalid_images")
    normalized, decoded = [], []
    total = 0
    for item in images:
        if not isinstance(item, dict) or item.get("mime") not in IMAGE_EXTENSIONS:
            raise BridgeError("invalid_image")
        name, encoded = item.get("name", "image"), item.get("data")
        if not isinstance(name, str) or len(name) > 256 or not isinstance(encoded, str) or len(encoded) > (MAX_IMAGE_BYTES + 2) // 3 * 4:
            raise BridgeError("invalid_image")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            raise BridgeError("invalid_image") from None
        if not raw or len(raw) > MAX_IMAGE_BYTES:
            raise BridgeError("invalid_image")
        mime = item["mime"]
        signatures = {"image/png": raw.startswith(b"\x89PNG\r\n\x1a\n"), "image/jpeg": raw.startswith(b"\xff\xd8\xff"), "image/gif": raw.startswith((b"GIF87a", b"GIF89a")), "image/webp": len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"}
        if not signatures[mime]:
            raise BridgeError("invalid_image")
        total += len(raw)
        if total > 20 * 1024 * 1024:
            raise BridgeError("images_too_large")
        normalized_item = {"name": name, "mime": mime, "data": encoded}
        if "imageKey" in item:
            key = item["imageKey"]
            if not isinstance(key, str) or not key or len(key) > 1024:
                raise BridgeError("invalid_image_key")
            normalized_item["imageKey"] = key
        normalized.append(normalized_item)
        decoded.append(raw)
    job = {"id": job_id, "kind": kind, "createdAt": created, "request": request, "prompt": prompt, "images": normalized}
    digest = hashlib.sha256(json.dumps(job, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()
    return job, digest, decoded


def available_claude(config):
    executable = config.get("claudePath", "")
    return bool(executable and Path(executable).is_file() and not is_link(Path(executable)))


def image_keys(job):
    if job["images"] and all("imageKey" in image for image in job["images"]):
        return [image["imageKey"] for image in job["images"]]
    # Compatibility for snapshots explicitly carrying attachment references.
    keys = job["request"].get("imageKeys", [])
    return keys if isinstance(keys, list) and all(isinstance(k, str) and len(k) <= 512 for k in keys) and len(keys) <= MAX_IMAGES else []
