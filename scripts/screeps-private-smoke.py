#!/usr/bin/env python3
"""Automation harness for the pinned Dockerized Screeps private-server smoke.

The live ``run`` command is intentionally local/manual: it creates an ignored
work directory, starts the pinned launcher stack there, uploads the built bot,
places a local spawn, polls safe stats, and writes a redacted report.
"""

from __future__ import annotations

import argparse
import ast
import base64
import hashlib
import json
import os
import re
import secrets
import socket
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WORK_DIR = REPO_ROOT / "runtime-artifacts" / "screeps-private-smoke"
DEFAULT_MAP_URL = "https://maps.screepspl.us/maps/map-0b6758af.json"
MAP_FILENAME = "map-0b6758af.json"
MAP_CONTAINER_PATH = f"/screeps/maps/{MAP_FILENAME}"
SCREEPS_LAUNCHER_IMAGE = "screepers/screeps-launcher:v1.16.2"
MONGO_IMAGE = "mongo:8.2.7"
REDIS_IMAGE = "redis:7.4.8"
DEFAULT_CODE_PATH = REPO_ROOT / "prod" / "dist" / "main.js"
CONTAINER_HTTP_PORT = 21025
CONTAINER_CLI_PORT = 21026
DEFAULT_HTTP_PORT = CONTAINER_HTTP_PORT
DEFAULT_CLI_PORT = CONTAINER_CLI_PORT
MIN_TCP_PORT = 1
MAX_TCP_PORT = 65535
LAUNCHER_CLI_RESPONSE_LIMIT = 1400
DEFAULT_ROOM = "E1S1"
DEFAULT_SHARD = "shardX"
DEFAULT_USERNAME = "smoke"
DEFAULT_SPAWN_NAME = "Spawn1"
DEFAULT_SPAWN_X = 20
DEFAULT_SPAWN_Y = 20
GENERATED_FILE_MODE = 0o600
GENERATED_DIR_MODE = 0o700
STEAM_KEY_FILE_MODE = GENERATED_FILE_MODE
CONTAINER_WRITABLE_SUBDIRS = (
    "maps",
    "bots",
    "bots/mvpbot",
    "mods",
    "deps",
)
SECRET_KEYS = {
    "authorization",
    "password",
    "oldpassword",
    "token",
    "x-token",
    "x-username",
    "steamkey",
    "steam_key",
    "steamkeyfile",
    "server_password",
}
CODE_KEYS = {"main", "modules", "code"}


class SmokeError(RuntimeError):
    """A failure that should be shown as a sanitized CLI error."""


@dataclass(frozen=True)
class SmokeConfig:
    """Runtime configuration for dry-run and live private-smoke execution."""

    work_dir: Path
    server_host: str
    http_port: int
    cli_port: int
    server_url: str
    username: str
    email: str
    password: str | None
    room: str
    shard: str
    spawn_name: str
    spawn_x: int
    spawn_y: int
    branch: str
    code_path: Path
    map_url: str
    map_source_file: Path | None
    stats_timeout: int
    poll_interval: int
    min_creeps: int
    reset_data: bool
    dry_run: bool
    compose_project: str
    mongo_db: str

    @property
    def config_path(self) -> Path:
        """Return the generated launcher config path."""
        return self.work_dir / "config.yml"

    @property
    def compose_path(self) -> Path:
        """Return the generated Docker Compose file path."""
        return self.work_dir / "docker-compose.yml"

    @property
    def steam_key_path(self) -> Path:
        """Return the local Steam key file path used by the launcher."""
        return self.work_dir / "STEAM_KEY"

    @property
    def map_path(self) -> Path:
        """Return the local map file path mounted into the launcher."""
        return self.work_dir / "maps" / MAP_FILENAME

    @property
    def bot_main_path(self) -> Path:
        """Return the bot bundle path mounted into the launcher."""
        return self.work_dir / "bots" / "mvpbot" / "main.js"

    @property
    def report_path(self) -> Path:
        """Return a timestamped redacted report path in the workdir."""
        timestamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        return self.work_dir / f"private-smoke-report-{timestamp}.json"


@dataclass
class HttpResult:
    """HTTP status, decoded payload, and response headers."""

    status: int
    payload: Any
    headers: dict[str, str]


def short_text(value: Any, max_len: int = 500) -> str:
    """Return a bounded string representation for reports and errors."""
    text = str(value)
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "..."


def env_int(name: str, default: int) -> int:
    """Read an integer environment variable with a SmokeError on bad input."""
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise SmokeError(f"{name} must be an integer") from exc


def optional_env_int(name: str) -> int | None:
    """Read an optional integer environment variable."""
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except ValueError as exc:
        raise SmokeError(f"{name} must be an integer") from exc


def validate_tcp_port(name: str, value: int) -> int:
    """Validate a host TCP port value."""
    if value < MIN_TCP_PORT or value > MAX_TCP_PORT:
        raise SmokeError(f"{name} must be between {MIN_TCP_PORT} and {MAX_TCP_PORT}")
    return value


def host_port_pair_from_start(name: str, value: int) -> tuple[int, int]:
    """Return the HTTP/CLI host port pair implied by a starting port."""
    start = validate_tcp_port(name, value)
    if start >= MAX_TCP_PORT:
        raise SmokeError(f"{name} must be between {MIN_TCP_PORT} and {MAX_TCP_PORT - 1}")
    return start, start + 1


def resolve_host_ports(args: argparse.Namespace) -> tuple[int, int]:
    """Resolve host HTTP/CLI ports from CLI flags, env, and defaults."""
    arg_start = getattr(args, "host_port_start", None)
    arg_http = getattr(args, "host_http_port", None)
    arg_cli = getattr(args, "host_cli_port", None)
    env_start = optional_env_int("SCREEPS_PRIVATE_SMOKE_HOST_PORT_START")
    env_http = optional_env_int("SCREEPS_PRIVATE_SMOKE_HTTP_PORT")
    env_cli = optional_env_int("SCREEPS_PRIVATE_SMOKE_CLI_PORT")

    if arg_start is not None:
        http_port, cli_port = host_port_pair_from_start("--host-port-start", arg_start)
    elif env_start is not None:
        http_port, cli_port = host_port_pair_from_start("SCREEPS_PRIVATE_SMOKE_HOST_PORT_START", env_start)
    else:
        http_port, cli_port = DEFAULT_HTTP_PORT, DEFAULT_CLI_PORT

    if env_http is not None:
        http_port = env_http
    if env_cli is not None:
        cli_port = env_cli
    if arg_http is not None:
        http_port = arg_http
    if arg_cli is not None:
        cli_port = arg_cli

    http_port = validate_tcp_port("host HTTP port", http_port)
    cli_port = validate_tcp_port("host CLI port", cli_port)
    if http_port == cli_port:
        raise SmokeError("host HTTP port and host CLI port must be different")
    return http_port, cli_port


def host_ports_are_default(http_port: int, cli_port: int) -> bool:
    """Return whether selected host ports match the pinned default stack."""
    return http_port == DEFAULT_HTTP_PORT and cli_port == DEFAULT_CLI_PORT


def default_work_dir_for_ports(http_port: int, cli_port: int) -> Path:
    """Return the default smoke workdir for the selected host ports."""
    if host_ports_are_default(http_port, cli_port):
        return DEFAULT_WORK_DIR
    return DEFAULT_WORK_DIR.with_name(f"{DEFAULT_WORK_DIR.name}-{http_port}-{cli_port}")


def assert_host_port_work_dir_isolated(work_dir: Path, http_port: int, cli_port: int) -> None:
    """Reject alternate host ports when they explicitly reuse the default workdir."""
    if host_ports_are_default(http_port, cli_port):
        return
    if work_dir.resolve() == DEFAULT_WORK_DIR.resolve():
        derived = default_work_dir_for_ports(http_port, cli_port)
        raise SmokeError(
            "non-default host ports cannot reuse the default private-smoke work dir; "
            f"omit --work-dir to use {derived} or pass a distinct --work-dir"
        )


def env_bool(name: str, default: bool) -> bool:
    """Read a permissive boolean environment variable."""
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def safe_fragment(value: str) -> str:
    """Convert arbitrary text into a Docker Compose-safe fragment."""
    fragment = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip(".-")
    return fragment or "screeps-private-smoke"


def resolve_path(value: str | None, default: Path | None = None) -> Path | None:
    """Resolve an optional path relative to the current directory."""
    if not value:
        return default
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = (Path.cwd() / path).resolve()
    return path


def assert_safe_work_dir(work_dir: Path) -> None:
    """Ensure an in-repository workdir is ignored before secrets are written."""
    resolved = work_dir.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return

    check = subprocess.run(
        ["git", "check-ignore", "-q", "--", str(resolved)],
        cwd=REPO_ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if check.returncode != 0:
        raise SmokeError(f"work dir must be outside the repo or gitignored before writing secrets: {resolved}")


def assert_path_inside_work_dir(work_dir: Path, path: Path) -> None:
    """Raise unless a generated path resolves under the configured workdir."""
    resolved_work_dir = work_dir.resolve()
    resolved_path = path.resolve()
    try:
        resolved_path.relative_to(resolved_work_dir)
    except ValueError as exc:
        raise SmokeError(f"generated path escapes smoke work dir: {resolved_path}") from exc


def reject_existing_symlink(path: Path) -> None:
    """Reject an existing generated path component when it is a symlink."""
    if path.is_symlink():
        raise SmokeError(f"refusing to use symlinked smoke work dir path: {path}")


def assert_generated_path_has_no_symlink(work_dir: Path, path: Path) -> None:
    """Reject existing symlinks from the workdir root through a generated path."""
    assert_path_inside_work_dir(work_dir, path)
    reject_existing_symlink(work_dir)
    try:
        relative = path.relative_to(work_dir)
    except ValueError:
        relative = path.resolve().relative_to(work_dir.resolve())
    current = work_dir
    for part in relative.parts:
        current = current / part
        reject_existing_symlink(current)


def ensure_generated_dir(work_dir: Path, path: Path) -> None:
    """Create and chmod one generated directory without following symlink paths."""
    assert_generated_path_has_no_symlink(work_dir, path)
    path.mkdir(mode=GENERATED_DIR_MODE, parents=True, exist_ok=True)
    assert_generated_path_has_no_symlink(work_dir, path)
    if not path.is_dir():
        raise SmokeError(f"generated smoke work dir path is not a directory: {path}")
    path.chmod(GENERATED_DIR_MODE)


def write_generated_bytes(work_dir: Path, path: Path, data: bytes, mode: int = GENERATED_FILE_MODE) -> None:
    """Atomically write a generated file without following a preexisting symlink."""
    ensure_generated_dir(work_dir, path.parent)
    assert_generated_path_has_no_symlink(work_dir, path)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as temp_file:
            temp_file.write(data)
        temp_path.chmod(mode)
        assert_generated_path_has_no_symlink(work_dir, path)
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink()
    assert_generated_path_has_no_symlink(work_dir, path)


def write_generated_text(work_dir: Path, path: Path, text: str, mode: int = GENERATED_FILE_MODE) -> None:
    """Atomically write generated UTF-8 text without following symlink paths."""
    write_generated_bytes(work_dir, path, text.encode("utf-8"), mode)


def prepare_container_writable_work_dir(cfg: SmokeConfig) -> list[str]:
    """Prepare only generated smoke workdir paths for the mapped container UID."""
    assert_safe_work_dir(cfg.work_dir)
    ensure_generated_dir(cfg.work_dir, cfg.work_dir)
    prepared = ["."]
    for relative in CONTAINER_WRITABLE_SUBDIRS:
        path = cfg.work_dir / relative
        ensure_generated_dir(cfg.work_dir, path)
        prepared.append(relative)
    return prepared


def config_from_env(args: argparse.Namespace) -> SmokeConfig:
    """Build a SmokeConfig from CLI arguments and environment variables."""
    server_host = os.environ.get("SCREEPS_PRIVATE_SMOKE_HOST", "127.0.0.1")
    http_port, cli_port = resolve_host_ports(args)
    work_dir = resolve_path(
        args.work_dir or os.environ.get("SCREEPS_PRIVATE_SMOKE_WORKDIR"),
        default_work_dir_for_ports(http_port, cli_port),
    )
    assert work_dir is not None
    assert_host_port_work_dir_isolated(work_dir, http_port, cli_port)
    assert_safe_work_dir(work_dir)
    username = os.environ.get("SCREEPS_PRIVATE_SMOKE_USERNAME", DEFAULT_USERNAME)
    room = os.environ.get("SCREEPS_PRIVATE_SMOKE_ROOM", DEFAULT_ROOM)
    shard = os.environ.get("SCREEPS_PRIVATE_SMOKE_SHARD", DEFAULT_SHARD)
    spawn_name = os.environ.get("SCREEPS_PRIVATE_SMOKE_SPAWN_NAME", DEFAULT_SPAWN_NAME)
    spawn_x = env_int("SCREEPS_PRIVATE_SMOKE_SPAWN_X", DEFAULT_SPAWN_X)
    spawn_y = env_int("SCREEPS_PRIVATE_SMOKE_SPAWN_Y", DEFAULT_SPAWN_Y)
    branch = os.environ.get("SCREEPS_PRIVATE_SMOKE_BRANCH", "default")
    map_url = os.environ.get("SCREEPS_PRIVATE_SMOKE_MAP_URL", DEFAULT_MAP_URL)
    map_source_file = resolve_path(os.environ.get("SCREEPS_PRIVATE_SMOKE_MAP_FILE"))
    code_path = resolve_path(os.environ.get("SCREEPS_PRIVATE_SMOKE_CODE_PATH"), DEFAULT_CODE_PATH)
    assert code_path is not None
    reset_data = not args.no_reset_data and env_bool("SCREEPS_PRIVATE_SMOKE_RESET_DATA", True)
    password = os.environ.get("SCREEPS_PRIVATE_SMOKE_PASSWORD")
    if not password and not args.dry_run and reset_data:
        password = secrets.token_urlsafe(24)
    compose_seed = hashlib.sha1(str(work_dir).encode("utf-8")).hexdigest()[:8]
    compose_project = safe_fragment(
        os.environ.get("SCREEPS_PRIVATE_SMOKE_COMPOSE_PROJECT", f"screeps-private-smoke-{compose_seed}")
    )
    return SmokeConfig(
        work_dir=work_dir,
        server_host=server_host,
        http_port=http_port,
        cli_port=cli_port,
        server_url=f"http://{server_host}:{http_port}",
        username=username,
        email=os.environ.get("SCREEPS_PRIVATE_SMOKE_EMAIL", f"{username}@local.invalid"),
        password=password,
        room=room,
        shard=shard,
        spawn_name=spawn_name,
        spawn_x=spawn_x,
        spawn_y=spawn_y,
        branch=branch,
        code_path=code_path,
        map_url=map_url,
        map_source_file=map_source_file,
        stats_timeout=env_int("SCREEPS_PRIVATE_SMOKE_STATS_TIMEOUT", args.stats_timeout),
        poll_interval=env_int("SCREEPS_PRIVATE_SMOKE_POLL_INTERVAL", args.poll_interval),
        min_creeps=env_int("SCREEPS_PRIVATE_SMOKE_MIN_CREEPS", args.min_creeps),
        reset_data=reset_data,
        dry_run=args.dry_run,
        compose_project=compose_project,
        mongo_db=os.environ.get("SCREEPS_PRIVATE_SMOKE_MONGO_DB", "screeps"),
    )


def required_env_errors(cfg: SmokeConfig) -> list[str]:
    """Return sanitized prerequisite errors for live execution."""
    errors: list[str] = []
    if cfg.dry_run:
        return errors
    if not os.environ.get("STEAM_KEY"):
        errors.append("STEAM_KEY is required for run mode")
    if not cfg.password:
        if not cfg.reset_data:
            errors.append("SCREEPS_PRIVATE_SMOKE_PASSWORD is required when reusing server data without reset")
        else:
            errors.append("internal error: smoke password was not generated")
    if not cfg.code_path.is_file():
        errors.append(f"bot bundle is not a file: {cfg.code_path}")
    return errors


def build_launcher_config(cfg: SmokeConfig) -> str:
    """Render the pinned screeps-launcher configuration."""
    return f"""steamKeyFile: STEAM_KEY
version: 4.2.21
nodeVersion: Erbium
pinnedPackages:
  ssri: 8.0.1
  cacache: 15.3.0
  passport-steam: 1.0.17
  minipass-fetch: 2.1.2
  express-rate-limit: 6.7.0
  body-parser: 1.20.3
  path-to-regexp: 0.1.12
  psl: 1.10.0
mods:
  - screepsmod-mongo
  - screepsmod-auth
  - screepsmod-admin-utils
bots:
  mvpbot: ./bots/mvpbot
localMods: ./mods
env:
  backend:
    CLI_HOST: 0.0.0.0
serverConfig:
  welcomeText: "Local Screeps MVP pinned smoke server"
  tickRate: 200
  shardName: {cfg.shard}
  mapFile: {MAP_CONTAINER_PATH}
cli:
  host: 127.0.0.1
  port: {CONTAINER_CLI_PORT}
  username: ""
  password: ""
"""


def build_compose_file(cfg: SmokeConfig) -> str:
    """Render the Docker Compose stack used for the private smoke."""
    return f"""services:
  screeps:
    image: {SCREEPS_LAUNCHER_IMAGE}
    user: "{os.getuid()}:{os.getgid()}"
    volumes:
      - ./:/screeps
    ports:
      - "{cfg.server_host}:{cfg.http_port}:{CONTAINER_HTTP_PORT}/tcp"
      - "{cfg.server_host}:{cfg.cli_port}:{CONTAINER_CLI_PORT}/tcp"
    environment:
      MONGO_HOST: mongo
      REDIS_HOST: redis
    depends_on:
      mongo:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: "no"
    healthcheck:
      test: ["CMD-SHELL", "curl --fail --silent http://127.0.0.1:{CONTAINER_HTTP_PORT}/api/version >/dev/null"]
      interval: 10s
      timeout: 5s
      start_period: 10s
      retries: 12

  mongo:
    image: {MONGO_IMAGE}
    volumes:
      - mongo-data:/data/db
    restart: "no"
    healthcheck:
      test: ["CMD-SHELL", "echo 'db.runCommand(\\"ping\\").ok' | mongosh localhost:27017/test --quiet"]
      interval: 10s
      timeout: 5s
      start_period: 10s
      retries: 12

  redis:
    image: {REDIS_IMAGE}
    volumes:
      - redis-data:/data
    restart: "no"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      start_period: 10s
      retries: 12

volumes:
  redis-data:
  mongo-data:
"""


def code_digest(path: Path) -> dict[str, Any]:
    """Return a non-secret size and SHA-256 summary for a code artifact."""
    data = path.read_bytes()
    return {
        "path": str(path),
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def redacted_module_summary(modules: dict[str, Any]) -> dict[str, Any]:
    """Summarize uploaded code modules without returning their contents."""
    summary: dict[str, Any] = {}
    for name, value in modules.items():
        if isinstance(value, str):
            summary[name] = {
                "redacted": True,
                "bytes": len(value.encode("utf-8")),
                "sha256": hashlib.sha256(value.encode("utf-8")).hexdigest(),
            }
        else:
            summary[name] = {"redacted": True, "type": type(value).__name__}
    return summary


def redact(value: Any, secrets_to_hide: list[str] | None = None, parent_key: str = "") -> Any:
    """Recursively replace secret-like values and uploaded code with summaries."""
    secrets_to_hide = [s for s in (secrets_to_hide or []) if s]
    key = parent_key.lower().replace("-", "_")
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for item_key, item_value in value.items():
            item_key_text = str(item_key)
            normalized = item_key_text.lower().replace("-", "_")
            if normalized in SECRET_KEYS or any(part in normalized for part in ("password", "token", "steam_key")):
                redacted[item_key_text] = "[REDACTED]"
            elif normalized == "modules" and isinstance(item_value, dict):
                redacted[item_key_text] = redacted_module_summary(item_value)
            else:
                redacted[item_key_text] = redact(item_value, secrets_to_hide, item_key_text)
        return redacted
    if isinstance(value, list):
        return [redact(item, secrets_to_hide, parent_key) for item in value]
    if isinstance(value, tuple):
        return tuple(redact(item, secrets_to_hide, parent_key) for item in value)
    if isinstance(value, str):
        if key in CODE_KEYS and ("module.exports" in value or len(value) > 120):
            return f"[REDACTED_CODE bytes={len(value.encode('utf-8'))}]"
        text = value
        for secret_value in secrets_to_hide:
            text = text.replace(secret_value, "[REDACTED]")
        return text
    return value


def assert_no_secret_leak(payload: Any, secrets_to_hide: list[str]) -> None:
    """Raise if a supposedly redacted report still contains sensitive material."""
    encoded = json.dumps(payload, sort_keys=True)
    for secret_value in secrets_to_hide:
        if secret_value and secret_value in encoded:
            raise SmokeError("redacted report still contains a secret value")
    if "module.exports.loop" in encoded:
        raise SmokeError("redacted report still contains uploaded code contents")


def ok_field_succeeded(value: Any) -> bool:
    """Return whether a Screeps API ok field represents success."""
    return value is True or value == 1


def upload_code_succeeded(result: HttpResult) -> bool:
    """Return whether /api/user/code accepted the uploaded bundle."""
    if result.status != 200 or not isinstance(result.payload, dict):
        return False
    return "timestamp" in result.payload or ok_field_succeeded(result.payload.get("ok"))


def api_dict_succeeded(result: HttpResult) -> bool:
    """Return whether an authenticated probe returned a usable success payload."""
    if result.status != 200 or not isinstance(result.payload, dict):
        return False
    ok_value = result.payload.get("ok")
    return ok_value is None or ok_field_succeeded(ok_value)


def http_result_summary(
    endpoint: str,
    result: HttpResult,
    secrets_to_hide: list[str] | None = None,
    max_len: int = 200,
) -> str:
    """Return a bounded, redacted HTTP failure summary."""
    return f"{endpoint} returned {result.status}: {short_text(redact(result.payload, secrets_to_hide), max_len)}"


def record_required_api_probe(
    phases: list[dict[str, Any]],
    name: str,
    endpoint: str,
    result: HttpResult,
    secrets_to_hide: list[str],
) -> None:
    """Record an authenticated API probe and fail the smoke on unusable responses."""
    ok = api_dict_succeeded(result)
    phases.append({
        "name": name,
        "ok": ok,
        "details": {"status": result.status, "response": redact(result.payload, secrets_to_hide)},
    })
    if not ok:
        raise SmokeError(f"{name} failed: {http_result_summary(endpoint, result, secrets_to_hide)}")


def build_register_payload(cfg: SmokeConfig) -> dict[str, Any]:
    """Build the local user registration request body."""
    if not cfg.password:
        raise SmokeError("smoke password is unavailable")
    return {
        "username": cfg.username,
        "email": cfg.email,
        "password": cfg.password,
    }


def build_signin_payload(cfg: SmokeConfig) -> dict[str, Any]:
    """Build the local user sign-in request body."""
    if not cfg.password:
        raise SmokeError("smoke password is unavailable")
    return {
        "email": cfg.email,
        "password": cfg.password,
    }


def build_code_payload(cfg: SmokeConfig, code: str) -> dict[str, Any]:
    """Build the code upload request body for the configured branch."""
    return {
        "branch": cfg.branch,
        "modules": {
            "main": code,
        },
    }


def build_spawn_payload(cfg: SmokeConfig) -> dict[str, Any]:
    """Build the spawn placement request body."""
    return {
        "name": cfg.spawn_name,
        "room": cfg.room,
        "x": cfg.spawn_x,
        "y": cfg.spawn_y,
    }


def request_shape(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """Describe an HTTP request shape for dry-run reports."""
    return {
        "method": method,
        "path": path,
        "body": body or {},
    }


def prepare_work_dir(cfg: SmokeConfig) -> dict[str, Any]:
    """Create launcher files and copy live-only secret/runtime inputs."""
    assert_safe_work_dir(cfg.work_dir)
    if cfg.dry_run:
        ensure_generated_dir(cfg.work_dir, cfg.work_dir)
        for relative in ("maps", "bots", "bots/mvpbot"):
            ensure_generated_dir(cfg.work_dir, cfg.work_dir / relative)
        container_writable_dirs: list[str] | str = "not-applied-dry-run"
    else:
        container_writable_dirs = prepare_container_writable_work_dir(cfg)
    write_generated_text(cfg.work_dir, cfg.config_path, build_launcher_config(cfg))
    write_generated_text(cfg.work_dir, cfg.compose_path, build_compose_file(cfg))
    if not cfg.dry_run:
        steam_key = os.environ["STEAM_KEY"]
        write_generated_text(cfg.work_dir, cfg.steam_key_path, steam_key, STEAM_KEY_FILE_MODE)
        write_generated_bytes(cfg.work_dir, cfg.bot_main_path, cfg.code_path.read_bytes())
    return {
        "work_dir": str(cfg.work_dir),
        "compose_project": cfg.compose_project,
        "config": str(cfg.config_path),
        "compose": str(cfg.compose_path),
        "ports": {
            "host": {"http": cfg.http_port, "cli": cfg.cli_port},
            "container": {"http": CONTAINER_HTTP_PORT, "cli": CONTAINER_CLI_PORT},
        },
        "container_writable_dirs": container_writable_dirs,
        "steam_key_file": "created" if not cfg.dry_run else "not-created-dry-run",
        "bot_package_main": str(cfg.bot_main_path) if not cfg.dry_run else "not-copied-dry-run",
    }


def prepare_map(cfg: SmokeConfig) -> dict[str, Any]:
    """Prepare the map file from dry-run metadata, a local file, or a URL."""
    if cfg.dry_run:
        return {
            "path": str(cfg.map_path),
            "container_path": MAP_CONTAINER_PATH,
            "source": str(cfg.map_source_file) if cfg.map_source_file else cfg.map_url,
            "status": "planned",
        }
    if cfg.map_source_file:
        if not cfg.map_source_file.exists():
            raise SmokeError(f"map source file does not exist: {cfg.map_source_file}")
        write_generated_bytes(cfg.work_dir, cfg.map_path, cfg.map_source_file.read_bytes())
        source = str(cfg.map_source_file)
    elif cfg.map_path.exists():
        assert_generated_path_has_no_symlink(cfg.work_dir, cfg.map_path)
        source = "existing-workdir-file"
    else:
        parsed = urllib.parse.urlparse(cfg.map_url)
        if parsed.scheme not in {"http", "https"}:
            raise SmokeError(
                "SCREEPS_PRIVATE_SMOKE_MAP_URL must use http or https; "
                "use SCREEPS_PRIVATE_SMOKE_MAP_FILE for local files"
            )
        request = urllib.request.Request(cfg.map_url, headers={"User-Agent": "screeps-private-smoke/1.0"})
        with urllib.request.urlopen(request, timeout=60) as response:
            write_generated_bytes(cfg.work_dir, cfg.map_path, response.read())
        source = cfg.map_url
    return {
        "path": str(cfg.map_path),
        "container_path": MAP_CONTAINER_PATH,
        "source": source,
        "bytes": cfg.map_path.stat().st_size,
        "sha256": hashlib.sha256(cfg.map_path.read_bytes()).hexdigest(),
    }


def find_compose_command() -> list[str]:
    """Find a usable Docker Compose command."""
    docker = shutil.which("docker")
    if docker:
        try:
            result = subprocess.run(
                [docker, "compose", "version"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=20,
                check=False,
            )
            if result.returncode == 0:
                return [docker, "compose"]
        except (OSError, subprocess.SubprocessError):
            pass
    legacy = shutil.which("docker-compose")
    if legacy:
        return [legacy]
    raise SmokeError("Docker Compose is required for run mode")


def compose_env(cfg: SmokeConfig) -> dict[str, str]:
    """Return subprocess environment with the smoke Compose project name."""
    env = os.environ.copy()
    env["COMPOSE_PROJECT_NAME"] = cfg.compose_project
    return env


def host_port_unavailable_reason(host: str, port: int) -> str | None:
    """Return a sanitized bind failure reason when a host port is unavailable."""
    try:
        candidates = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        return short_text(exc, 200)
    if not candidates:
        return f"no socket address candidates for {host}:{port}"

    last_error: OSError | None = None
    for family, socktype, proto, _canonname, sockaddr in candidates:
        try:
            with socket.socket(family, socktype, proto) as probe:
                probe.bind(sockaddr)
            return None
        except OSError as exc:
            last_error = exc
    if last_error is None:
        return "unknown bind failure"
    return short_text(last_error, 200)


def preflight_host_ports(cfg: SmokeConfig) -> dict[str, Any]:
    """Fail before Docker startup if selected host ports cannot be bound."""
    if cfg.http_port == cfg.cli_port:
        raise SmokeError(
            f"selected HTTP and CLI host ports must be different: {cfg.server_host}:{cfg.http_port}"
        )

    checks: list[dict[str, Any]] = []
    for service, host_port, container_port in (
        ("http", cfg.http_port, CONTAINER_HTTP_PORT),
        ("cli", cfg.cli_port, CONTAINER_CLI_PORT),
    ):
        reason = host_port_unavailable_reason(cfg.server_host, host_port)
        if reason:
            raise SmokeError(
                f"selected private-smoke {service} host port is unavailable: "
                f"{cfg.server_host}:{host_port} ({reason})"
            )
        checks.append({
            "service": service,
            "host": cfg.server_host,
            "host_port": host_port,
            "container_port": container_port,
            "available": True,
        })
    return {"checks": checks}


def run_command(
    command: list[str],
    cfg: SmokeConfig,
    input_text: str | None = None,
    timeout: int = 120,
    output_limit: int = 1400,
) -> dict[str, Any]:
    """Run a Compose-scoped command and return sanitized bounded output."""
    started = time.time()
    result = subprocess.run(
        command,
        cwd=cfg.work_dir,
        input=input_text,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        env=compose_env(cfg),
        check=False,
    )
    elapsed = round(time.time() - started, 3)
    command_summary = [Path(command[0]).name, *command[1:]]
    output = "\n".join(part for part in (result.stdout, result.stderr) if part)
    sanitized_output = redact(short_text(output, output_limit), [os.environ.get("STEAM_KEY", ""), cfg.password or ""])
    return {
        "command": command_summary,
        "returncode": result.returncode,
        "elapsed_seconds": elapsed,
        "output_excerpt": sanitized_output,
    }


def require_success(step: dict[str, Any]) -> dict[str, Any]:
    """Raise SmokeError when a command step returned a non-zero status."""
    if step["returncode"] != 0:
        raise SmokeError(f"command failed: {' '.join(step['command'])}: {step['output_excerpt']}")
    return step


def http_json(
    method: str,
    base_url: str,
    path: str,
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    basic_auth: tuple[str, str] | None = None,
    timeout: int = 25,
) -> HttpResult:
    """Send an HTTP request and decode a JSON response or HTTP error body."""
    url = base_url.rstrip("/") + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = None
    request_headers = {"User-Agent": "screeps-private-smoke/1.0"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    if headers:
        request_headers.update(headers)
    if basic_auth:
        raw = f"{basic_auth[0]}:{basic_auth[1]}".encode("utf-8")
        request_headers["Authorization"] = "Basic " + base64.b64encode(raw).decode("ascii")
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            parsed = json.loads(body) if body else {}
            return HttpResult(response.status, parsed, dict(response.headers.items()))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"error": short_text(body, 500)}
        return HttpResult(exc.code, parsed, dict(exc.headers.items()))


def http_text(
    method: str,
    base_url: str,
    path: str,
    body: str | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 25,
    max_len: int = LAUNCHER_CLI_RESPONSE_LIMIT,
) -> HttpResult:
    """Send an HTTP request with a text body and return bounded text."""
    url = base_url.rstrip("/") + path
    data = body.encode("utf-8") if body is not None else None
    request_headers = {"User-Agent": "screeps-private-smoke/1.0"}
    if body is not None:
        request_headers["Content-Type"] = "text/plain; charset=utf-8"
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)

    def read_bounded(response: Any) -> str:
        raw = response.read(max_len + 1)
        return short_text(raw.decode("utf-8", errors="replace"), max_len)

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return HttpResult(response.status, read_bounded(response), dict(response.headers.items()))
    except urllib.error.HTTPError as exc:
        return HttpResult(exc.code, read_bounded(exc), dict(exc.headers.items()))


def token_headers(token: str) -> dict[str, str]:
    """Return the Screeps token headers expected by the private server."""
    return {
        "X-Username": token,
        "X-Token": token,
    }


def update_token_from_headers(current: str, headers: dict[str, str]) -> str:
    """Refresh the auth token when the private server rotates it."""
    for key, value in headers.items():
        if key.lower() == "x-token" and value:
            return value
    return current


def wait_for_http(cfg: SmokeConfig, timeout: int = 300) -> dict[str, Any]:
    """Poll the private server until its version endpoint is reachable."""
    deadline = time.time() + timeout
    attempts = 0
    last_error = ""
    while time.time() < deadline:
        attempts += 1
        try:
            result = http_json("GET", cfg.server_url, "/api/version", timeout=10)
            if result.status == 200 and isinstance(result.payload, dict):
                return {
                    "attempts": attempts,
                    "version": redact(result.payload),
                }
            if result.status != 200:
                last_error = http_result_summary("/api/version", result, max_len=200)
        except Exception as exc:  # noqa: BLE001 - sanitized below for report
            last_error = short_text(exc, 200)
        time.sleep(3)
    raise SmokeError(f"private server did not become HTTP-ready after {timeout}s: {last_error}")


def run_launcher_cli(compose: list[str], cfg: SmokeConfig, expression: str) -> dict[str, Any]:
    """Execute a screeps-launcher CLI expression through the local HTTP CLI."""
    _ = compose
    started = time.time()
    secrets_to_hide = [os.environ.get("STEAM_KEY", ""), cfg.password or ""]
    cli_base_url = f"http://{cfg.server_host}:{cfg.cli_port}"
    endpoint = cli_base_url.rstrip("/") + "/cli"
    try:
        result = http_text(
            "POST",
            cli_base_url,
            "/cli",
            expression,
            timeout=240,
            max_len=LAUNCHER_CLI_RESPONSE_LIMIT,
        )
    except Exception as exc:  # noqa: BLE001 - sanitized below for report
        message = redact(short_text(exc, 200), secrets_to_hide)
        raise SmokeError(f"launcher CLI HTTP request failed: {message}") from exc

    elapsed = round(time.time() - started, 3)
    response_excerpt = redact(short_text(result.payload, LAUNCHER_CLI_RESPONSE_LIMIT), secrets_to_hide)
    details = {
        "endpoint": endpoint,
        "status": result.status,
        "elapsed_seconds": elapsed,
        "response_excerpt": response_excerpt,
    }
    if result.status < 200 or result.status >= 300:
        raise SmokeError(f"launcher CLI HTTP request failed: {endpoint} returned {result.status}: {response_excerpt}")
    if isinstance(result.payload, str) and result.payload.startswith("Error:"):
        raise SmokeError(f"launcher CLI returned error: {response_excerpt}")
    return details


def safe_user_stats(stats: dict[str, Any], username: str) -> dict[str, Any]:
    """Extract the non-secret per-user fields needed for smoke criteria."""
    users = stats.get("users")
    selected = None
    if isinstance(users, list):
        for user in users:
            if isinstance(user, dict) and user.get("username") == username:
                selected = user
                break
    return {
        "gametime": stats.get("gametime"),
        "totalRooms": stats.get("totalRooms"),
        "activeRooms": stats.get("activeRooms"),
        "ownedRooms": stats.get("ownedRooms"),
        "activeUsers": stats.get("activeUsers"),
        "ticks": redact(stats.get("ticks")),
        "user": redact(selected) if selected else None,
    }


def stats_passed(summary: dict[str, Any], min_creeps: int) -> bool:
    """Return whether aggregate stats meet the smoke success criteria."""
    user = summary.get("user")
    if not isinstance(user, dict):
        return False
    rooms = user.get("rooms")
    creeps = user.get("creeps")
    return (
        isinstance(summary.get("totalRooms"), int)
        and summary["totalRooms"] > 0
        and isinstance(summary.get("ownedRooms"), int)
        and summary["ownedRooms"] > 0
        and isinstance(rooms, int)
        and rooms > 0
        and isinstance(creeps, int)
        and creeps >= min_creeps
    )


def poll_stats(cfg: SmokeConfig) -> dict[str, Any]:
    """Poll /stats until criteria pass or the configured deadline expires."""
    deadline = time.time() + cfg.stats_timeout
    first: dict[str, Any] | None = None
    last: dict[str, Any] | None = None
    samples = 0
    last_error = ""
    while time.time() < deadline:
        try:
            result = http_json("GET", cfg.server_url, "/stats", timeout=15)
        except Exception as exc:  # noqa: BLE001 - transient request failures are retried until the deadline
            last_error = short_text(exc, 200)
            time.sleep(min(cfg.poll_interval, max(0, deadline - time.time())))
            continue
        if result.status == 200 and isinstance(result.payload, dict):
            samples += 1
            summary = safe_user_stats(result.payload, cfg.username)
            first = first or summary
            last = summary
            if stats_passed(summary, cfg.min_creeps):
                return {
                    "ok": True,
                    "samples": samples,
                    "first": first,
                    "last": last,
                    "criteria": {"min_creeps": cfg.min_creeps},
                }
        else:
            last_error = http_result_summary("/stats", result, max_len=200)
        time.sleep(min(cfg.poll_interval, max(0, deadline - time.time())))
    return {
        "ok": False,
        "samples": samples,
        "first": first,
        "last": last,
        "criteria": {"min_creeps": cfg.min_creeps},
        "error": "stats criteria were not met before timeout",
        "last_error": last_error or None,
    }


def collect_mongo_summary(compose: list[str], cfg: SmokeConfig) -> dict[str, Any]:
    """Collect a bounded room-specific object summary from Mongo."""
    eval_script = f"""
const smokeDb = db.getSiblingDB({json.dumps(cfg.mongo_db)});
const counts = {{}};
const objects = smokeDb.getCollection('rooms.objects');
const user = smokeDb.getCollection('users').findOne({{username: {json.dumps(cfg.username)}}}, {{_id: 1, username: 1}});
for (const item of objects.aggregate([
  {{$match: {{room: {json.dumps(cfg.room)}, type: {{$in: ['spawn', 'creep', 'controller', 'source', 'mineral']}}}}}},
  {{$group: {{_id: '$type', count: {{$sum: 1}}}}}},
])) {{
  counts[item._id] = item.count;
}}
const spawns = objects
  .find({{room: {json.dumps(cfg.room)}, type: 'spawn'}}, {{_id: 0, name: 1, x: 1, y: 1, hits: 1, hitsMax: 1, user: 1}})
  .sort({{name: 1}})
  .limit(20)
  .toArray()
  .map(object => ({{name: object.name, x: object.x, y: object.y, hits: object.hits, hitsMax: object.hitsMax, user: object.user == null ? null : String(object.user)}}));
const creeps = objects
  .find({{room: {json.dumps(cfg.room)}, type: 'creep'}}, {{_id: 0, name: 1, x: 1, y: 1, body: 1, ticksToLive: 1, user: 1}})
  .sort({{name: 1}})
  .limit(10)
  .toArray()
  .map(object => ({{name: object.name, x: object.x, y: object.y, body: (object.body || []).map(part => part.type), ticksToLive: object.ticksToLive, user: object.user == null ? null : String(object.user)}}));
const controllerObject = objects.findOne(
  {{room: {json.dumps(cfg.room)}, type: 'controller'}},
  {{_id: 0, x: 1, y: 1, level: 1, progress: 1, progressTotal: 1, user: 1}},
);
const controller = controllerObject
  ? {{x: controllerObject.x, y: controllerObject.y, level: controllerObject.level, progress: controllerObject.progress, progressTotal: controllerObject.progressTotal, user: controllerObject.user == null ? null : String(controllerObject.user)}}
  : null;
print(JSON.stringify({{room: {json.dumps(cfg.room)}, user: user ? {{username: user.username, id: String(user._id)}} : null, counts, spawns, creeps, controller}}));
"""
    command = [*compose, "exec", "-T", "mongo", "mongosh", "--quiet", "--eval", eval_script]
    result = run_command(command, cfg, timeout=60, output_limit=12000)
    if result["returncode"] != 0:
        return {"ok": False, "error": result["output_excerpt"]}
    try:
        payload = json.loads(str(result["output_excerpt"]).strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as exc:
        return {"ok": False, "error": f"could not parse mongosh summary: {short_text(exc, 160)}"}
    return {"ok": True, "summary": redact(payload)}


def verify_room_spawn_summary(mongo_summary: dict[str, Any], cfg: SmokeConfig) -> dict[str, Any]:
    """Verify Mongo proves the expected smoke spawn belongs in the room."""
    if not mongo_summary.get("ok"):
        return {
            "ok": False,
            "error": f"room-specific Mongo summary could not be collected: {mongo_summary.get('error', 'unknown error')}",
            "summary_ok": False,
        }
    summary = mongo_summary.get("summary")
    if not isinstance(summary, dict):
        return {"ok": False, "error": "room-specific Mongo summary was not an object", "summary_ok": True}
    if summary.get("room") != cfg.room:
        return {"ok": False, "error": f"Mongo summary returned unexpected room {summary.get('room')!r}", "summary_ok": True}

    user = summary.get("user")
    expected_user_id = user.get("id") if isinstance(user, dict) else None
    if not isinstance(expected_user_id, str) or not expected_user_id:
        return {"ok": False, "error": f"Mongo summary could not prove smoke user {cfg.username!r}", "summary_ok": True}

    spawns = summary.get("spawns")
    matching_spawn = None
    if isinstance(spawns, list):
        for spawn in spawns:
            if isinstance(spawn, dict) and spawn.get("name") == cfg.spawn_name:
                matching_spawn = spawn
                break
    if matching_spawn is None:
        return {
            "ok": False,
            "error": f"smoke did not confirm spawn {cfg.spawn_name!r} in room {cfg.room!r}",
            "summary_ok": True,
        }

    spawn_user = matching_spawn.get("user")
    if spawn_user != expected_user_id:
        return {
            "ok": False,
            "error": f"spawn {cfg.spawn_name!r} in room {cfg.room!r} is not owned by smoke user {cfg.username!r}",
            "summary_ok": True,
        }

    controller = summary.get("controller")
    controller_user = controller.get("user") if isinstance(controller, dict) else None
    if controller_user not in (None, expected_user_id):
        return {
            "ok": False,
            "error": f"room {cfg.room!r} controller is not owned by smoke user {cfg.username!r}",
            "summary_ok": True,
        }

    return {
        "ok": True,
        "room": cfg.room,
        "spawn": cfg.spawn_name,
        "username": cfg.username,
        "spawn_owner_confirmed": True,
        "controller_owner_confirmed": controller_user == expected_user_id,
    }


def run_live(cfg: SmokeConfig) -> dict[str, Any]:
    """Run the full live Dockerized smoke and write a redacted report."""
    phases: list[dict[str, Any]] = []
    secrets_to_hide = [os.environ.get("STEAM_KEY", ""), cfg.password or ""]
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    report: dict[str, Any] = {
        "ok": False,
        "dry_run": False,
        "started_at": started_at,
        "work_dir": str(cfg.work_dir),
        "compose_project": cfg.compose_project,
        "server_url": cfg.server_url,
        "ports": {
            "host": {"http": cfg.http_port, "cli": cfg.cli_port},
            "container": {"http": CONTAINER_HTTP_PORT, "cli": CONTAINER_CLI_PORT},
        },
        "launcher": {
            "image": SCREEPS_LAUNCHER_IMAGE,
            "version": "4.2.21",
            "nodeVersion": "Erbium",
            "map_container_path": MAP_CONTAINER_PATH,
        },
        "smoke": {
            "username": cfg.username,
            "room": cfg.room,
            "shard": cfg.shard,
            "spawn": {
                "name": cfg.spawn_name,
                "x": cfg.spawn_x,
                "y": cfg.spawn_y,
            },
            "branch": cfg.branch,
        },
        "phases": phases,
    }
    try:
        port_preflight = preflight_host_ports(cfg)
        phases.append({"name": "host-port-preflight", "ok": True, "details": port_preflight})

        prepare = prepare_work_dir(cfg)
        phases.append({"name": "prepare-workdir", "ok": True, "details": redact(prepare, secrets_to_hide)})

        map_details = prepare_map(cfg)
        phases.append({"name": "prepare-map", "ok": True, "details": redact(map_details, secrets_to_hide)})

        code_summary = code_digest(cfg.code_path)
        phases.append({"name": "code-artifact", "ok": True, "details": code_summary})

        compose = find_compose_command()
        phases.append({"name": "compose-detected", "ok": True, "details": {"command": [Path(compose[0]).name, *compose[1:]], "project": cfg.compose_project}})

        phases.append({"name": "compose-up", "ok": True, "details": require_success(run_command([*compose, "up", "-d"], cfg, timeout=900))})
        phases.append({"name": "wait-http", "ok": True, "details": wait_for_http(cfg)})

        if cfg.reset_data:
            phases.append({"name": "reset-data", "ok": True, "details": run_launcher_cli(compose, cfg, "system.resetAllData()")})

        phases.append({"name": "import-map", "ok": True, "details": run_launcher_cli(compose, cfg, f"utils.importMapFile('{MAP_CONTAINER_PATH}')")})
        phases.append({"name": "restart-screeps", "ok": True, "details": require_success(run_command([*compose, "restart", "screeps"], cfg, timeout=240))})
        phases.append({"name": "wait-http-after-import", "ok": True, "details": wait_for_http(cfg)})
        phases.append({"name": "resume-simulation", "ok": True, "details": run_launcher_cli(compose, cfg, "system.resumeSimulation()")})

        register = http_json("POST", cfg.server_url, "/api/register/submit", build_register_payload(cfg))
        register_payload = redact(register.payload, secrets_to_hide)
        register_ok = bool(isinstance(register.payload, dict) and (register.payload.get("ok") == 1 or "already exists" in str(register.payload.get("error", "")).lower()))
        phases.append({"name": "register-user", "ok": register_ok, "details": {"status": register.status, "response": register_payload}})
        if not register_ok:
            raise SmokeError(f"registration failed: {register_payload}")

        signin = http_json("POST", cfg.server_url, "/api/auth/signin", build_signin_payload(cfg))
        token = signin.payload.get("token") if isinstance(signin.payload, dict) else None
        signin_ok = signin.status == 200 and isinstance(token, str) and bool(token)
        phases.append({"name": "signin", "ok": signin_ok, "details": {"status": signin.status, "token_received": signin_ok}})
        if not signin_ok:
            raise SmokeError(f"signin failed: {redact(signin.payload, secrets_to_hide)}")

        code_text = cfg.code_path.read_text(encoding="utf-8")
        upload = http_json("POST", cfg.server_url, "/api/user/code", build_code_payload(cfg, code_text), headers=token_headers(token))
        token = update_token_from_headers(token, upload.headers)
        upload_ok = upload_code_succeeded(upload)
        phases.append({"name": "upload-code", "ok": upload_ok, "details": {"status": upload.status, "response": redact(upload.payload, secrets_to_hide), "module": code_summary}})
        if not upload_ok:
            raise SmokeError(f"code upload failed: {http_result_summary('/api/user/code', upload, secrets_to_hide)}")

        roundtrip = http_json("GET", cfg.server_url, "/api/user/code", headers=token_headers(token), params={"branch": cfg.branch})
        token = update_token_from_headers(token, roundtrip.headers)
        remote_main = ""
        if isinstance(roundtrip.payload, dict):
            modules = roundtrip.payload.get("modules")
            if isinstance(modules, dict) and isinstance(modules.get("main"), str):
                remote_main = modules["main"]
        roundtrip_summary = {
            "status": roundtrip.status,
            "branch": roundtrip.payload.get("branch") if isinstance(roundtrip.payload, dict) else None,
            "main_bytes": len(remote_main.encode("utf-8")),
            "main_sha256": hashlib.sha256(remote_main.encode("utf-8")).hexdigest() if remote_main else None,
            "matches_local": remote_main == code_text,
        }
        phases.append({"name": "roundtrip-code", "ok": bool(roundtrip_summary["matches_local"]), "details": roundtrip_summary})
        if not roundtrip_summary["matches_local"]:
            raise SmokeError("uploaded code round-trip did not match the local bundle")

        place = http_json("POST", cfg.server_url, "/api/game/place-spawn", build_spawn_payload(cfg), headers=token_headers(token))
        token = update_token_from_headers(token, place.headers)
        place_ok = place.status == 200 and isinstance(place.payload, dict) and place.payload.get("ok") == 1
        already_playing = isinstance(place.payload, dict) and "already playing" in str(place.payload.get("error", "")).lower()
        phases.append({"name": "place-spawn", "ok": place_ok or already_playing, "details": {"status": place.status, "response": redact(place.payload, secrets_to_hide)}})
        if not (place_ok or already_playing):
            raise SmokeError(f"spawn placement failed: {redact(place.payload, secrets_to_hide)}")
        needs_room_spawn_verify = already_playing and not place_ok

        overview = http_json("GET", cfg.server_url, "/api/user/overview", headers=token_headers(token))
        token = update_token_from_headers(token, overview.headers)
        record_required_api_probe(phases, "user-overview", "/api/user/overview", overview, secrets_to_hide)

        room_overview = http_json(
            "GET",
            cfg.server_url,
            "/api/game/room-overview",
            headers=token_headers(token),
            params={"room": cfg.room, "shard": cfg.shard},
        )
        token = update_token_from_headers(token, room_overview.headers)
        record_required_api_probe(phases, "room-overview", "/api/game/room-overview", room_overview, secrets_to_hide)

        mongo_summary: dict[str, Any] | None = None
        if needs_room_spawn_verify:
            mongo_summary = collect_mongo_summary(compose, cfg)
            room_spawn_verify = verify_room_spawn_summary(mongo_summary, cfg)
            phases.append({"name": "room-spawn-verify", "ok": bool(room_spawn_verify.get("ok")), "details": redact(room_spawn_verify, secrets_to_hide)})
            if not room_spawn_verify.get("ok"):
                raise SmokeError(str(room_spawn_verify.get("error", "room-specific spawn verification failed")))

        stats = poll_stats(cfg)
        phases.append({"name": "poll-stats", "ok": bool(stats.get("ok")), "details": redact(stats, secrets_to_hide)})
        if not stats.get("ok"):
            raise SmokeError("stats polling did not reach the expected owned-room/creep criteria")

        if mongo_summary is None:
            mongo_summary = collect_mongo_summary(compose, cfg)
        phases.append({
            "name": "mongo-summary",
            "ok": bool(mongo_summary.get("ok")),
            "optional": not needs_room_spawn_verify,
            "details": redact(mongo_summary, secrets_to_hide),
        })

        report["ok"] = True
    except Exception as exc:  # noqa: BLE001 - top-level report must capture sanitized failures
        phases.append({"name": "failure", "ok": False, "error": redact(short_text(exc, 1000), secrets_to_hide)})
        report["error"] = redact(short_text(exc, 1000), secrets_to_hide)
    finally:
        report["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        report_path = cfg.report_path
        report["report_path"] = str(report_path)
        assert_no_secret_leak(report, secrets_to_hide)
        assert_safe_work_dir(cfg.work_dir)
        write_generated_text(cfg.work_dir, report_path, json.dumps(report, indent=2, sort_keys=True))
    return report


def run_dry(cfg: SmokeConfig) -> dict[str, Any]:
    """Run the secret-free dry-run path and write a redacted report."""
    fake_password = "dry-run-password"
    dry_cfg = SmokeConfig(
        **{
            **cfg.__dict__,
            "password": fake_password,
            "dry_run": True,
        }
    )
    prepare = prepare_work_dir(dry_cfg)
    map_details = prepare_map(dry_cfg)
    sample_code = "module.exports.loop = function loop() { return 'dry-run'; };"
    request_shapes = [
        request_shape("POST", "/api/register/submit", build_register_payload(dry_cfg)),
        request_shape("POST", "/api/auth/signin", build_signin_payload(dry_cfg)),
        request_shape("POST", "/api/user/code", build_code_payload(dry_cfg, sample_code)),
        request_shape("POST", "/api/game/place-spawn", build_spawn_payload(dry_cfg)),
    ]
    report = {
        "ok": True,
        "dry_run": True,
        "work_dir": str(dry_cfg.work_dir),
        "compose_project": dry_cfg.compose_project,
        "server_url": dry_cfg.server_url,
        "ports": {
            "host": {"http": dry_cfg.http_port, "cli": dry_cfg.cli_port},
            "container": {"http": CONTAINER_HTTP_PORT, "cli": CONTAINER_CLI_PORT},
        },
        "prepare": redact(prepare, [fake_password]),
        "map": redact(map_details, [fake_password]),
        "launcher_config_contains_secret": "dry-run-password" in build_launcher_config(dry_cfg),
        "request_shapes": redact(request_shapes, [fake_password]),
        "redaction_checked": True,
    }
    report_path = dry_cfg.report_path
    report["report_path"] = str(report_path)
    assert_no_secret_leak(report, [fake_password, sample_code])
    write_generated_text(dry_cfg.work_dir, report_path, json.dumps(report, indent=2, sort_keys=True))
    return report


class SmokeSelfTest(unittest.TestCase):
    """Offline regression tests for helper behavior and redaction."""

    def make_cfg(self) -> SmokeConfig:
        """Create a minimal local config for offline tests."""
        return SmokeConfig(
            work_dir=Path("/tmp/screeps-private-smoke-self-test"),
            server_host="127.0.0.1",
            http_port=21025,
            cli_port=21026,
            server_url="http://127.0.0.1:21025",
            username="smoke",
            email="smoke@local.invalid",
            password="super-secret-password",
            room="E1S1",
            shard="shardX",
            spawn_name="Spawn1",
            spawn_x=20,
            spawn_y=20,
            branch="default",
            code_path=Path("/tmp/main.js"),
            map_url=DEFAULT_MAP_URL,
            map_source_file=None,
            stats_timeout=1,
            poll_interval=1,
            min_creeps=1,
            reset_data=True,
            dry_run=True,
            compose_project="self-test",
            mongo_db="screeps",
        )

    def make_args(self, **overrides: Any) -> argparse.Namespace:
        """Create parser-like args for config_from_env tests."""
        values = {
            "command": "run",
            "dry_run": False,
            "work_dir": "/tmp/screeps-private-smoke-self-test",
            "host_port_start": None,
            "host_http_port": None,
            "host_cli_port": None,
            "stats_timeout": 1,
            "poll_interval": 0,
            "min_creeps": 1,
            "no_reset_data": False,
        }
        values.update(overrides)
        return argparse.Namespace(**values)

    def screeps_healthcheck_from_compose(self, compose: str) -> dict[str, Any]:
        """Extract the generated Screeps healthcheck without external YAML dependencies."""
        healthcheck: dict[str, Any] = {}
        in_screeps = False
        in_healthcheck = False
        for line in compose.splitlines():
            if line == "  screeps:":
                in_screeps = True
                continue
            if in_screeps and line.startswith("  ") and not line.startswith("    "):
                break
            if not in_screeps:
                continue
            if line == "    healthcheck:":
                in_healthcheck = True
                continue
            if not in_healthcheck:
                continue
            if line.startswith("    ") and not line.startswith("      "):
                break
            if not line.startswith("      "):
                continue
            key, separator, raw_value = line.strip().partition(": ")
            self.assertEqual(separator, ": ", f"malformed healthcheck line: {line!r}")
            if key == "test":
                parsed = ast.literal_eval(raw_value)
                self.assertIsInstance(parsed, list)
                self.assertTrue(all(isinstance(part, str) for part in parsed))
                healthcheck[key] = parsed
            elif key == "interval":
                healthcheck[key] = raw_value
            elif key == "retries":
                healthcheck[key] = int(raw_value)
        self.assertIn("test", healthcheck)
        self.assertIn("interval", healthcheck)
        self.assertIn("retries", healthcheck)
        return healthcheck

    def assert_screeps_healthcheck(self, compose: str) -> None:
        """Assert the generated Screeps healthcheck stays Compose-compatible."""
        screeps_healthcheck = self.screeps_healthcheck_from_compose(compose)
        self.assertEqual(
            screeps_healthcheck["test"],
            ["CMD-SHELL", "curl --fail --silent http://127.0.0.1:21025/api/version >/dev/null"],
        )
        self.assertEqual(screeps_healthcheck["interval"], "10s")
        self.assertEqual(screeps_healthcheck["retries"], 12)

    def test_launcher_config_is_secret_free(self) -> None:
        """Launcher config should reference, not embed, local secrets."""
        cfg = self.make_cfg()
        config_text = build_launcher_config(cfg)
        self.assertIn("steamKeyFile: STEAM_KEY", config_text)
        self.assertIn("version: 4.2.21", config_text)
        self.assertIn("nodeVersion: Erbium", config_text)
        self.assertIn("body-parser: 1.20.3", config_text)
        self.assertIn("path-to-regexp: 0.1.12", config_text)
        self.assertIn(f"mapFile: {MAP_CONTAINER_PATH}", config_text)
        self.assertNotIn("super-secret-password", config_text)

    def test_compose_file_binds_local_ports(self) -> None:
        """Compose output should bind local ports and map the launcher UID/GID."""
        cfg = self.make_cfg()
        compose = build_compose_file(cfg)
        self.assertIn('"127.0.0.1:21025:21025/tcp"', compose)
        self.assertIn('"127.0.0.1:21026:21026/tcp"', compose)
        self.assertIn(f'user: "{os.getuid()}:{os.getgid()}"', compose)
        self.assertIn(f"image: {SCREEPS_LAUNCHER_IMAGE}", compose)
        self.assertIn(f"image: {MONGO_IMAGE}", compose)
        self.assertIn(f"image: {REDIS_IMAGE}", compose)

    def test_custom_host_ports_preserve_container_ports(self) -> None:
        """Custom host bindings should leave Screeps container ports unchanged."""
        cfg = SmokeConfig(
            **{
                **self.make_cfg().__dict__,
                "http_port": 21125,
                "cli_port": 21126,
                "server_url": "http://127.0.0.1:21125",
            }
        )
        compose = build_compose_file(cfg)
        launcher_config = build_launcher_config(cfg)
        self.assertIn('"127.0.0.1:21125:21025/tcp"', compose)
        self.assertIn('"127.0.0.1:21126:21026/tcp"', compose)
        self.assertIn("curl --fail --silent http://127.0.0.1:21025/api/version", compose)
        self.assert_screeps_healthcheck(compose)
        self.assertIn("  port: 21026", launcher_config)
        self.assertNotIn("  port: 21126", launcher_config)

    def test_screeps_healthcheck_rejects_wrapped_shell_array(self) -> None:
        """Healthcheck validation should reject CMD-SHELL, sh, -c array forms."""
        compose = build_compose_file(self.make_cfg())
        malformed = compose.replace(
            'test: ["CMD-SHELL", "curl --fail --silent http://127.0.0.1:21025/api/version >/dev/null"]',
            'test: ["CMD-SHELL", "sh", "-c", "curl --fail --silent http://127.0.0.1:21025/api/version >/dev/null"]',
        )
        self.assertNotEqual(compose, malformed)
        with self.assertRaises(AssertionError):
            self.assert_screeps_healthcheck(malformed)

    def test_dry_run_persists_custom_port_metadata(self) -> None:
        """Dry-run reports and generated Compose should show custom host ports."""
        with tempfile.TemporaryDirectory() as temp_dir:
            cfg = SmokeConfig(
                **{
                    **self.make_cfg().__dict__,
                    "work_dir": Path(temp_dir),
                    "http_port": 21125,
                    "cli_port": 21126,
                    "server_url": "http://127.0.0.1:21125",
                }
            )
            report = run_dry(cfg)
            persisted = json.loads(Path(report["report_path"]).read_text(encoding="utf-8"))
            compose = cfg.compose_path.read_text(encoding="utf-8")

        self.assertEqual(report["server_url"], "http://127.0.0.1:21125")
        self.assertEqual(persisted["ports"]["host"], {"http": 21125, "cli": 21126})
        self.assertEqual(persisted["ports"]["container"], {"http": 21025, "cli": 21026})
        self.assertIn('"127.0.0.1:21125:21025/tcp"', compose)
        self.assertIn('"127.0.0.1:21126:21026/tcp"', compose)

    def test_redaction_removes_secrets_and_code(self) -> None:
        """Report redaction should hide credentials and uploaded code."""
        payload = {
            "headers": {"X-Token": "abc123", "Authorization": "Basic abc123"},
            "password": "super-secret-password",
            "modules": {"main": "module.exports.loop = function loop() {};"},
            "message": "token abc123 password super-secret-password",
        }
        redacted = redact(payload, ["abc123", "super-secret-password"])
        encoded = json.dumps(redacted)
        self.assertNotIn("abc123", encoded)
        self.assertNotIn("super-secret-password", encoded)
        self.assertNotIn("module.exports.loop", encoded)
        self.assertIn("sha256", encoded)

    def test_request_shapes_are_redacted(self) -> None:
        """Dry-run request shapes should be useful without leaking secrets."""
        cfg = self.make_cfg()
        code = "module.exports.loop = function loop() { console.log('secret-free code'); };"
        shapes = [
            request_shape("POST", "/api/register/submit", build_register_payload(cfg)),
            request_shape("POST", "/api/auth/signin", build_signin_payload(cfg)),
            request_shape("POST", "/api/user/code", build_code_payload(cfg, code)),
            request_shape("POST", "/api/game/place-spawn", build_spawn_payload(cfg)),
        ]
        encoded = json.dumps(redact(shapes, [cfg.password or "", code]))
        self.assertIn("/api/register/submit", encoded)
        self.assertIn("/api/user/code", encoded)
        self.assertIn("Spawn1", encoded)
        self.assertNotIn("super-secret-password", encoded)
        self.assertNotIn("module.exports.loop", encoded)

    def test_dry_run_persists_report_path_metadata(self) -> None:
        """Persisted dry-run reports should include their own report path."""
        with tempfile.TemporaryDirectory() as temp_dir:
            cfg = SmokeConfig(**{**self.make_cfg().__dict__, "work_dir": Path(temp_dir)})
            report = run_dry(cfg)
            report_path = Path(report["report_path"])
            persisted = json.loads(report_path.read_text(encoding="utf-8"))

        self.assertEqual(persisted["report_path"], str(report_path))
        self.assertEqual(report["report_path"], str(report_path))

    def test_live_prepare_sets_owner_only_generated_modes(self) -> None:
        """Live preparation should keep generated dirs and files owner-only."""
        steam_key_was_set = "STEAM_KEY" in os.environ
        old_steam_key = os.environ.get("STEAM_KEY")
        try:
            os.environ["STEAM_KEY"] = "self-test-steam-key"
            with tempfile.TemporaryDirectory() as temp_dir:
                temp_path = Path(temp_dir)
                code_path = temp_path / "main.js"
                code_path.write_text("module.exports.loop = function loop() {};", encoding="utf-8")
                cfg = SmokeConfig(
                    **{
                        **self.make_cfg().__dict__,
                        "work_dir": temp_path / "work",
                        "code_path": code_path,
                        "dry_run": False,
                    }
                )
                details = prepare_work_dir(cfg)
                steam_key_mode = cfg.steam_key_path.stat().st_mode & 0o777
                directory_modes = {
                    relative: (cfg.work_dir / relative).stat().st_mode & 0o7777
                    for relative in (".", *CONTAINER_WRITABLE_SUBDIRS)
                }
                file_modes = {
                    "config": cfg.config_path.stat().st_mode & 0o777,
                    "compose": cfg.compose_path.stat().st_mode & 0o777,
                    "steam_key": steam_key_mode,
                    "bot_main": cfg.bot_main_path.stat().st_mode & 0o777,
                }

        finally:
            if steam_key_was_set:
                os.environ["STEAM_KEY"] = old_steam_key or ""
            else:
                os.environ.pop("STEAM_KEY", None)

        for relative, mode in directory_modes.items():
            with self.subTest(relative=relative):
                self.assertEqual(mode, GENERATED_DIR_MODE)
                self.assertEqual(mode & 0o077, 0)
        for name, mode in file_modes.items():
            with self.subTest(name=name):
                self.assertEqual(mode, GENERATED_FILE_MODE)
                self.assertEqual(mode & 0o077, 0)
        self.assertIn("deps", details["container_writable_dirs"])
        self.assertEqual(steam_key_mode, STEAM_KEY_FILE_MODE)
        self.assertEqual(steam_key_mode & 0o700, 0o600)
        self.assertEqual(steam_key_mode & 0o111, 0)
        self.assertNotIn("self-test-steam-key", json.dumps(details))

    def test_live_prepare_rejects_preexisting_steam_key_symlink(self) -> None:
        """Live preparation should not follow a preexisting STEAM_KEY symlink."""
        if not hasattr(os, "symlink"):
            self.skipTest("os.symlink is unavailable")
        steam_key_was_set = "STEAM_KEY" in os.environ
        old_steam_key = os.environ.get("STEAM_KEY")
        try:
            os.environ["STEAM_KEY"] = "self-test-steam-key"
            with tempfile.TemporaryDirectory() as temp_dir:
                temp_path = Path(temp_dir)
                code_path = temp_path / "main.js"
                code_path.write_text("module.exports.loop = function loop() {};", encoding="utf-8")
                cfg = SmokeConfig(
                    **{
                        **self.make_cfg().__dict__,
                        "work_dir": temp_path / "work",
                        "code_path": code_path,
                        "dry_run": False,
                    }
                )
                cfg.work_dir.mkdir(mode=GENERATED_DIR_MODE)
                target = cfg.work_dir / "target-steam-key"
                os.symlink(target, cfg.steam_key_path)
                with self.assertRaises(SmokeError):
                    prepare_work_dir(cfg)
                self.assertFalse(target.exists())
        finally:
            if steam_key_was_set:
                os.environ["STEAM_KEY"] = old_steam_key or ""
            else:
                os.environ.pop("STEAM_KEY", None)

    def test_live_prepare_rejects_preexisting_bot_main_symlink(self) -> None:
        """Live preparation should not follow a preexisting bot main symlink."""
        if not hasattr(os, "symlink"):
            self.skipTest("os.symlink is unavailable")
        steam_key_was_set = "STEAM_KEY" in os.environ
        old_steam_key = os.environ.get("STEAM_KEY")
        try:
            os.environ["STEAM_KEY"] = "self-test-steam-key"
            with tempfile.TemporaryDirectory() as temp_dir:
                temp_path = Path(temp_dir)
                code_path = temp_path / "main.js"
                code_path.write_text("module.exports.loop = function loop() {};", encoding="utf-8")
                cfg = SmokeConfig(
                    **{
                        **self.make_cfg().__dict__,
                        "work_dir": temp_path / "work",
                        "code_path": code_path,
                        "dry_run": False,
                    }
                )
                cfg.bot_main_path.parent.mkdir(mode=GENERATED_DIR_MODE, parents=True)
                target = cfg.work_dir / "target-main.js"
                os.symlink(target, cfg.bot_main_path)
                with self.assertRaises(SmokeError):
                    prepare_work_dir(cfg)
                self.assertFalse(target.exists())
        finally:
            if steam_key_was_set:
                os.environ["STEAM_KEY"] = old_steam_key or ""
            else:
                os.environ.pop("STEAM_KEY", None)

    def test_dry_run_does_not_create_or_report_steam_key(self) -> None:
        """Dry-run should remain secret-free even if STEAM_KEY is present."""
        steam_key_was_set = "STEAM_KEY" in os.environ
        old_steam_key = os.environ.get("STEAM_KEY")
        try:
            os.environ["STEAM_KEY"] = "dry-run-env-steam-key"
            with tempfile.TemporaryDirectory() as temp_dir:
                cfg = SmokeConfig(**{**self.make_cfg().__dict__, "work_dir": Path(temp_dir)})
                report = run_dry(cfg)
                persisted = json.loads(Path(report["report_path"]).read_text(encoding="utf-8"))
                encoded = json.dumps({"report": report, "persisted": persisted}, sort_keys=True)
                steam_key_exists = cfg.steam_key_path.exists()
                dry_run_directory_modes = {
                    relative: (cfg.work_dir / relative).stat().st_mode & 0o7777
                    for relative in (".", "maps", "bots", "bots/mvpbot")
                }
        finally:
            if steam_key_was_set:
                os.environ["STEAM_KEY"] = old_steam_key or ""
            else:
                os.environ.pop("STEAM_KEY", None)

        self.assertFalse(steam_key_exists)
        for relative, mode in dry_run_directory_modes.items():
            with self.subTest(relative=relative):
                self.assertEqual(mode, GENERATED_DIR_MODE)
                self.assertEqual(mode & 0o077, 0)
        self.assertEqual(report["prepare"]["container_writable_dirs"], "not-applied-dry-run")
        self.assertNotIn("dry-run-env-steam-key", encoded)

    def test_upload_code_accepts_common_success_payloads(self) -> None:
        """/api/user/code should accept timestamp and ok-style success bodies."""
        for payload in ({"timestamp": 123}, {"ok": 1}, {"ok": True}):
            with self.subTest(payload=payload):
                self.assertTrue(upload_code_succeeded(HttpResult(200, payload, {})))

        for result in (
            HttpResult(500, {"ok": 1}, {}),
            HttpResult(200, {"ok": 0}, {}),
            HttpResult(200, {"ok": False}, {}),
            HttpResult(200, ["ok"], {}),
        ):
            with self.subTest(result=result):
                self.assertFalse(upload_code_succeeded(result))

    def test_required_api_probe_rejects_bad_overview_payloads(self) -> None:
        """Overview phases should fail on non-200 or unusable payloads."""
        phases: list[dict[str, Any]] = []
        record_required_api_probe(phases, "user-overview", "/api/user/overview", HttpResult(200, {"rooms": []}, {}), [])
        self.assertTrue(phases[-1]["ok"])

        hidden = "api-token-123"
        for result in (
            HttpResult(503, {"error": hidden}, {}),
            HttpResult(200, ["not", "a", "dict"], {}),
            HttpResult(200, {"ok": 0}, {}),
        ):
            with self.subTest(result=result):
                with self.assertRaises(SmokeError) as caught:
                    record_required_api_probe(phases, "user-overview", "/api/user/overview", result, [hidden])
                self.assertFalse(phases[-1]["ok"])
                self.assertNotIn(hidden, str(caught.exception))

    def test_run_launcher_cli_posts_expression_to_http_endpoint(self) -> None:
        """Launcher CLI execution should post raw expressions to the HTTP CLI."""
        cfg = self.make_cfg()
        original_http_text = globals()["http_text"]
        captured: dict[str, Any] = {}

        def fake_http_text(
            method: str,
            base_url: str,
            path: str,
            body: str | None = None,
            **kwargs: Any,
        ) -> HttpResult:
            """Capture the request shape without touching the network."""
            captured.update({
                "method": method,
                "base_url": base_url,
                "path": path,
                "body": body,
                "timeout": kwargs.get("timeout"),
                "max_len": kwargs.get("max_len"),
            })
            return HttpResult(200, "2\n", {})

        try:
            globals()["http_text"] = fake_http_text
            details = run_launcher_cli(["docker", "compose"], cfg, "1+1")
        finally:
            globals()["http_text"] = original_http_text

        self.assertEqual(
            captured,
            {
                "method": "POST",
                "base_url": "http://127.0.0.1:21026",
                "path": "/cli",
                "body": "1+1",
                "timeout": 240,
                "max_len": LAUNCHER_CLI_RESPONSE_LIMIT,
            },
        )
        self.assertEqual(details["endpoint"], "http://127.0.0.1:21026/cli")
        self.assertEqual(details["status"], 200)
        self.assertEqual(details["response_excerpt"], "2\n")

    def test_run_launcher_cli_rejects_http_and_cli_error_payloads(self) -> None:
        """Launcher CLI execution should fail on HTTP errors and Error: payloads."""
        cfg = self.make_cfg()
        original_http_text = globals()["http_text"]

        cases = (
            ("http-status", HttpResult(503, "temporary unavailable", {}), "returned 503"),
            ("cli-error", HttpResult(200, "Error: bad expression", {}), "launcher CLI returned error"),
            ("timeout", TimeoutError("temporary timeout"), "temporary timeout"),
        )
        for name, outcome, expected in cases:
            with self.subTest(name=name):

                def fake_http_text(
                    *args: Any,
                    outcome: HttpResult | BaseException = outcome,
                    **kwargs: Any,
                ) -> HttpResult:
                    """Return a deterministic launcher CLI failure."""
                    if isinstance(outcome, BaseException):
                        raise outcome
                    return outcome

                try:
                    globals()["http_text"] = fake_http_text
                    with self.assertRaises(SmokeError) as caught:
                        run_launcher_cli([], cfg, "bad()")
                finally:
                    globals()["http_text"] = original_http_text
                self.assertIn(expected, str(caught.exception))

    def test_run_launcher_cli_redacts_and_bounds_response_output(self) -> None:
        """Launcher CLI reports should redact secrets and bound response text."""
        cfg = self.make_cfg()
        original_http_text = globals()["http_text"]
        steam_key_was_set = "STEAM_KEY" in os.environ
        old_steam_key = os.environ.get("STEAM_KEY")
        hidden_steam_key = "self-test-steam-key"
        long_response = f"ok {hidden_steam_key} {cfg.password} " + ("x" * 2000)

        def fake_http_text(*args: Any, **kwargs: Any) -> HttpResult:
            """Return a successful response that still needs report sanitation."""
            return HttpResult(200, long_response, {})

        try:
            os.environ["STEAM_KEY"] = hidden_steam_key
            globals()["http_text"] = fake_http_text
            details = run_launcher_cli([], cfg, "secretProbe()")
        finally:
            globals()["http_text"] = original_http_text
            if steam_key_was_set:
                os.environ["STEAM_KEY"] = old_steam_key or ""
            else:
                os.environ.pop("STEAM_KEY", None)

        excerpt = details["response_excerpt"]
        self.assertLessEqual(len(excerpt), LAUNCHER_CLI_RESPONSE_LIMIT)
        self.assertTrue(excerpt.endswith("..."))
        self.assertIn("[REDACTED]", excerpt)
        self.assertNotIn(hidden_steam_key, excerpt)
        self.assertNotIn(cfg.password or "", excerpt)

    def test_signin_payload_uses_configured_email(self) -> None:
        """Sign-in should use the registered email even when username differs."""
        cfg = SmokeConfig(
            **{**self.make_cfg().__dict__, "username": "smoke-user", "email": "smoke@example.test"}
        )
        self.assertEqual(build_signin_payload(cfg)["email"], "smoke@example.test")

    def test_required_env_only_applies_to_live_run(self) -> None:
        """Live-only prerequisites should not block dry-run validation."""
        cfg = self.make_cfg()
        self.assertEqual(required_env_errors(cfg), [])
        live_cfg = SmokeConfig(**{**cfg.__dict__, "dry_run": False})
        old_steam_key = os.environ.pop("STEAM_KEY", None)
        try:
            errors = required_env_errors(live_cfg)
        finally:
            if old_steam_key is not None:
                os.environ["STEAM_KEY"] = old_steam_key
        self.assertTrue(any("STEAM_KEY" in error for error in errors))

    def test_default_ports_use_pinned_default_work_dir(self) -> None:
        """The pinned default port pair should keep the historical workdir/project."""
        env_names = (
            "SCREEPS_PRIVATE_SMOKE_WORKDIR",
            "SCREEPS_PRIVATE_SMOKE_HOST_PORT_START",
            "SCREEPS_PRIVATE_SMOKE_HTTP_PORT",
            "SCREEPS_PRIVATE_SMOKE_CLI_PORT",
            "SCREEPS_PRIVATE_SMOKE_COMPOSE_PROJECT",
        )
        old_values = {name: os.environ.get(name) for name in env_names}
        try:
            for name in env_names:
                os.environ.pop(name, None)
            cfg = config_from_env(self.make_args(dry_run=True, work_dir=None))
        finally:
            for name, value in old_values.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

        expected_seed = hashlib.sha1(str(DEFAULT_WORK_DIR).encode("utf-8")).hexdigest()[:8]
        self.assertEqual(cfg.work_dir, DEFAULT_WORK_DIR)
        self.assertEqual(cfg.compose_project, f"screeps-private-smoke-{expected_seed}")

    def test_alternate_ports_derive_distinct_default_work_dir_and_project(self) -> None:
        """Alternate host ports should not target the pinned default stack by default."""
        env_names = (
            "SCREEPS_PRIVATE_SMOKE_WORKDIR",
            "SCREEPS_PRIVATE_SMOKE_HOST_PORT_START",
            "SCREEPS_PRIVATE_SMOKE_HTTP_PORT",
            "SCREEPS_PRIVATE_SMOKE_CLI_PORT",
            "SCREEPS_PRIVATE_SMOKE_COMPOSE_PROJECT",
        )
        old_values = {name: os.environ.get(name) for name in env_names}
        try:
            for name in env_names:
                os.environ.pop(name, None)
            default_cfg = config_from_env(self.make_args(dry_run=True, work_dir=None))
            dry_cfg = config_from_env(
                self.make_args(dry_run=True, work_dir=None, host_http_port=22125, host_cli_port=22126)
            )
            live_cfg = config_from_env(
                self.make_args(dry_run=False, work_dir=None, host_http_port=22125, host_cli_port=22126)
            )
        finally:
            for name, value in old_values.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

        expected_work_dir = DEFAULT_WORK_DIR.with_name("screeps-private-smoke-22125-22126")
        self.assertEqual(dry_cfg.work_dir, expected_work_dir)
        self.assertEqual(live_cfg.work_dir, expected_work_dir)
        self.assertNotEqual(dry_cfg.work_dir, default_cfg.work_dir)
        self.assertNotEqual(dry_cfg.compose_project, default_cfg.compose_project)
        self.assertEqual(dry_cfg.server_url, "http://127.0.0.1:22125")
        self.assertEqual(live_cfg.server_url, "http://127.0.0.1:22125")

    def test_alternate_ports_reject_explicit_default_work_dir(self) -> None:
        """Live alternate ports should fail safely if pinned to the default workdir."""
        env_names = (
            "SCREEPS_PRIVATE_SMOKE_WORKDIR",
            "SCREEPS_PRIVATE_SMOKE_HOST_PORT_START",
            "SCREEPS_PRIVATE_SMOKE_HTTP_PORT",
            "SCREEPS_PRIVATE_SMOKE_CLI_PORT",
            "SCREEPS_PRIVATE_SMOKE_COMPOSE_PROJECT",
        )
        old_values = {name: os.environ.get(name) for name in env_names}
        try:
            for name in env_names:
                os.environ.pop(name, None)
            with self.assertRaisesRegex(SmokeError, "cannot reuse the default private-smoke work dir"):
                config_from_env(
                    self.make_args(
                        dry_run=False,
                        work_dir=str(DEFAULT_WORK_DIR),
                        host_http_port=22125,
                        host_cli_port=22126,
                    )
                )
        finally:
            for name, value in old_values.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def test_alternate_ports_allow_explicit_non_default_work_dir(self) -> None:
        """Live alternate ports can use a caller-supplied isolated workdir."""
        env_names = (
            "SCREEPS_PRIVATE_SMOKE_WORKDIR",
            "SCREEPS_PRIVATE_SMOKE_HOST_PORT_START",
            "SCREEPS_PRIVATE_SMOKE_HTTP_PORT",
            "SCREEPS_PRIVATE_SMOKE_CLI_PORT",
            "SCREEPS_PRIVATE_SMOKE_COMPOSE_PROJECT",
        )
        old_values = {name: os.environ.get(name) for name in env_names}
        try:
            for name in env_names:
                os.environ.pop(name, None)
            with tempfile.TemporaryDirectory() as temp_dir:
                cfg = config_from_env(
                    self.make_args(
                        dry_run=False,
                        work_dir=temp_dir,
                        host_http_port=22125,
                        host_cli_port=22126,
                    )
                )
        finally:
            for name, value in old_values.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

        self.assertEqual(cfg.work_dir, Path(temp_dir).resolve())
        self.assertEqual(cfg.http_port, 22125)
        self.assertEqual(cfg.cli_port, 22126)

    def test_config_from_cli_host_port_start_sets_host_pair(self) -> None:
        """CLI port-start should configure adjacent host HTTP/CLI ports."""
        old_values = {
            name: os.environ.get(name)
            for name in (
                "SCREEPS_PRIVATE_SMOKE_HOST_PORT_START",
                "SCREEPS_PRIVATE_SMOKE_HTTP_PORT",
                "SCREEPS_PRIVATE_SMOKE_CLI_PORT",
            )
        }
        try:
            os.environ["SCREEPS_PRIVATE_SMOKE_HOST_PORT_START"] = "21115"
            os.environ.pop("SCREEPS_PRIVATE_SMOKE_HTTP_PORT", None)
            os.environ.pop("SCREEPS_PRIVATE_SMOKE_CLI_PORT", None)
            cfg = config_from_env(self.make_args(dry_run=True, host_port_start=21125))
        finally:
            for name, value in old_values.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

        self.assertEqual(cfg.http_port, 21125)
        self.assertEqual(cfg.cli_port, 21126)
        self.assertEqual(cfg.server_url, "http://127.0.0.1:21125")

    def test_config_from_env_host_port_start_sets_host_pair(self) -> None:
        """Env port-start should configure adjacent host HTTP/CLI ports."""
        old_values = {
            name: os.environ.get(name)
            for name in (
                "SCREEPS_PRIVATE_SMOKE_HOST_PORT_START",
                "SCREEPS_PRIVATE_SMOKE_HTTP_PORT",
                "SCREEPS_PRIVATE_SMOKE_CLI_PORT",
            )
        }
        try:
            os.environ["SCREEPS_PRIVATE_SMOKE_HOST_PORT_START"] = "21125"
            os.environ.pop("SCREEPS_PRIVATE_SMOKE_HTTP_PORT", None)
            os.environ.pop("SCREEPS_PRIVATE_SMOKE_CLI_PORT", None)
            cfg = config_from_env(self.make_args(dry_run=True))
        finally:
            for name, value in old_values.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

        self.assertEqual(cfg.http_port, 21125)
        self.assertEqual(cfg.cli_port, 21126)
        self.assertEqual(cfg.server_url, "http://127.0.0.1:21125")

    def test_env_explicit_host_ports_override_cli_start_pair(self) -> None:
        """Env explicit host ports should override the selected start-port pair."""
        old_values = {
            name: os.environ.get(name)
            for name in (
                "SCREEPS_PRIVATE_SMOKE_HOST_PORT_START",
                "SCREEPS_PRIVATE_SMOKE_HTTP_PORT",
                "SCREEPS_PRIVATE_SMOKE_CLI_PORT",
            )
        }
        try:
            os.environ["SCREEPS_PRIVATE_SMOKE_HOST_PORT_START"] = "21115"
            os.environ["SCREEPS_PRIVATE_SMOKE_HTTP_PORT"] = "21135"
            os.environ["SCREEPS_PRIVATE_SMOKE_CLI_PORT"] = "21136"
            cfg = config_from_env(self.make_args(dry_run=True, host_port_start=21125))
        finally:
            for name, value in old_values.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

        self.assertEqual(cfg.http_port, 21135)
        self.assertEqual(cfg.cli_port, 21136)
        self.assertEqual(cfg.server_url, "http://127.0.0.1:21135")

    def test_cli_explicit_host_ports_override_env_explicit_ports(self) -> None:
        """CLI explicit host ports should be the final port override layer."""
        old_values = {
            name: os.environ.get(name)
            for name in (
                "SCREEPS_PRIVATE_SMOKE_HOST_PORT_START",
                "SCREEPS_PRIVATE_SMOKE_HTTP_PORT",
                "SCREEPS_PRIVATE_SMOKE_CLI_PORT",
            )
        }
        try:
            os.environ["SCREEPS_PRIVATE_SMOKE_HOST_PORT_START"] = "21115"
            os.environ["SCREEPS_PRIVATE_SMOKE_HTTP_PORT"] = "21135"
            os.environ["SCREEPS_PRIVATE_SMOKE_CLI_PORT"] = "21136"
            cfg = config_from_env(
                self.make_args(
                    dry_run=True,
                    host_port_start=21125,
                    host_http_port=21145,
                    host_cli_port=21146,
                )
            )
        finally:
            for name, value in old_values.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

        self.assertEqual(cfg.http_port, 21145)
        self.assertEqual(cfg.cli_port, 21146)
        self.assertEqual(cfg.server_url, "http://127.0.0.1:21145")

    def test_config_from_explicit_host_port_env_and_cli(self) -> None:
        """Explicit HTTP/CLI host ports should work from env and CLI flags."""
        old_values = {
            name: os.environ.get(name)
            for name in (
                "SCREEPS_PRIVATE_SMOKE_HOST_PORT_START",
                "SCREEPS_PRIVATE_SMOKE_HTTP_PORT",
                "SCREEPS_PRIVATE_SMOKE_CLI_PORT",
            )
        }
        try:
            os.environ.pop("SCREEPS_PRIVATE_SMOKE_HOST_PORT_START", None)
            os.environ["SCREEPS_PRIVATE_SMOKE_HTTP_PORT"] = "21135"
            os.environ["SCREEPS_PRIVATE_SMOKE_CLI_PORT"] = "21136"
            env_cfg = config_from_env(self.make_args(dry_run=True))
            cli_cfg = config_from_env(
                self.make_args(dry_run=True, host_http_port=21145, host_cli_port=21146)
            )
        finally:
            for name, value in old_values.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

        self.assertEqual(env_cfg.http_port, 21135)
        self.assertEqual(env_cfg.cli_port, 21136)
        self.assertEqual(env_cfg.server_url, "http://127.0.0.1:21135")
        self.assertEqual(cli_cfg.http_port, 21145)
        self.assertEqual(cli_cfg.cli_port, 21146)
        self.assertEqual(cli_cfg.server_url, "http://127.0.0.1:21145")

    def test_config_rejects_invalid_host_ports(self) -> None:
        """Host ports should be valid and non-overlapping."""
        cases = (
            {"host_port_start": 65535},
            {"host_http_port": 0},
            {"host_http_port": 21125, "host_cli_port": 21125},
        )
        for overrides in cases:
            with self.subTest(overrides=overrides):
                with self.assertRaises(SmokeError):
                    config_from_env(self.make_args(dry_run=True, **overrides))

    def test_host_port_preflight_rejects_occupied_port(self) -> None:
        """Live preflight should catch occupied host ports before Docker startup."""
        original_probe = globals()["host_port_unavailable_reason"]

        def fake_probe(host: str, port: int) -> str | None:
            """Pretend only the selected HTTP host port is occupied."""
            self.assertEqual(host, "127.0.0.1")
            if port == 22025:
                return "Address already in use"
            return None

        try:
            globals()["host_port_unavailable_reason"] = fake_probe
            cfg = SmokeConfig(
                **{
                    **self.make_cfg().__dict__,
                    "http_port": 22025,
                    "cli_port": 22026,
                    "server_url": "http://127.0.0.1:22025",
                    "dry_run": False,
                }
            )
            with self.assertRaisesRegex(SmokeError, "http host port is unavailable"):
                preflight_host_ports(cfg)
        finally:
            globals()["host_port_unavailable_reason"] = original_probe

    def test_host_port_preflight_allows_available_alternate_ports(self) -> None:
        """Live preflight should let alternate available host ports proceed."""
        original_probe = globals()["host_port_unavailable_reason"]
        try:
            globals()["host_port_unavailable_reason"] = lambda _host, _port: None
            cfg = SmokeConfig(
                **{
                    **self.make_cfg().__dict__,
                    "http_port": 22025,
                    "cli_port": 22026,
                    "server_url": "http://127.0.0.1:22025",
                    "dry_run": False,
                }
            )
            result = preflight_host_ports(cfg)
        finally:
            globals()["host_port_unavailable_reason"] = original_probe

        self.assertEqual(
            result["checks"],
            [
                {
                    "service": "http",
                    "host": "127.0.0.1",
                    "host_port": 22025,
                    "container_port": CONTAINER_HTTP_PORT,
                    "available": True,
                },
                {
                    "service": "cli",
                    "host": "127.0.0.1",
                    "host_port": 22026,
                    "container_port": CONTAINER_CLI_PORT,
                    "available": True,
                },
            ],
        )

    def test_required_env_rejects_non_file_bot_bundle(self) -> None:
        """Live runs should reject bot bundle paths that are not regular files."""
        steam_key_was_set = "STEAM_KEY" in os.environ
        old_steam_key = os.environ.get("STEAM_KEY")
        try:
            os.environ["STEAM_KEY"] = "self-test-steam-key"
            with tempfile.TemporaryDirectory() as temp_dir:
                cfg = SmokeConfig(
                    **{
                        **self.make_cfg().__dict__,
                        "code_path": Path(temp_dir),
                        "dry_run": False,
                    }
                )
                errors = required_env_errors(cfg)
        finally:
            if steam_key_was_set:
                os.environ["STEAM_KEY"] = old_steam_key or ""
            else:
                os.environ.pop("STEAM_KEY", None)
        self.assertTrue(any("bot bundle is not a file" in error for error in errors))

    def test_reusing_server_state_requires_stable_password(self) -> None:
        """No-reset live runs should require a caller-supplied password."""
        old_password = os.environ.pop("SCREEPS_PRIVATE_SMOKE_PASSWORD", None)
        try:
            cfg = config_from_env(self.make_args(no_reset_data=True))
            self.assertFalse(cfg.reset_data)
            self.assertIsNone(cfg.password)
            errors = required_env_errors(cfg)
        finally:
            if old_password is not None:
                os.environ["SCREEPS_PRIVATE_SMOKE_PASSWORD"] = old_password
        self.assertTrue(any("SCREEPS_PRIVATE_SMOKE_PASSWORD" in error for error in errors))

    def test_reusing_server_state_rejects_empty_password(self) -> None:
        """No-reset live runs should reject an explicitly empty password."""
        password_was_set = "SCREEPS_PRIVATE_SMOKE_PASSWORD" in os.environ
        old_password = os.environ.get("SCREEPS_PRIVATE_SMOKE_PASSWORD")
        reset_was_set = "SCREEPS_PRIVATE_SMOKE_RESET_DATA" in os.environ
        old_reset = os.environ.get("SCREEPS_PRIVATE_SMOKE_RESET_DATA")
        try:
            os.environ["SCREEPS_PRIVATE_SMOKE_PASSWORD"] = ""
            os.environ["SCREEPS_PRIVATE_SMOKE_RESET_DATA"] = "false"
            cfg = config_from_env(self.make_args())
            self.assertFalse(cfg.reset_data)
            self.assertEqual(cfg.password, "")
            errors = required_env_errors(cfg)
        finally:
            if password_was_set:
                os.environ["SCREEPS_PRIVATE_SMOKE_PASSWORD"] = old_password or ""
            else:
                os.environ.pop("SCREEPS_PRIVATE_SMOKE_PASSWORD", None)
            if reset_was_set:
                os.environ["SCREEPS_PRIVATE_SMOKE_RESET_DATA"] = old_reset or ""
            else:
                os.environ.pop("SCREEPS_PRIVATE_SMOKE_RESET_DATA", None)
        self.assertTrue(any("SCREEPS_PRIVATE_SMOKE_PASSWORD" in error for error in errors))

    def test_prepare_map_rejects_non_network_map_url(self) -> None:
        """Map URL fetches should be limited to http and https schemes."""
        with tempfile.TemporaryDirectory() as temp_dir:
            cfg = SmokeConfig(
                **{
                    **self.make_cfg().__dict__,
                    "work_dir": Path(temp_dir),
                    "map_url": "file:///tmp/local-map.json",
                    "dry_run": False,
                }
            )
            with self.assertRaisesRegex(SmokeError, "SCREEPS_PRIVATE_SMOKE_MAP_URL"):
                prepare_map(cfg)

    def test_prepare_map_rejects_preexisting_map_symlink(self) -> None:
        """Map preparation should not follow a preexisting map-file symlink."""
        if not hasattr(os, "symlink"):
            self.skipTest("os.symlink is unavailable")
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            source = temp_path / "source-map.json"
            source.write_text("{}", encoding="utf-8")
            cfg = SmokeConfig(
                **{
                    **self.make_cfg().__dict__,
                    "work_dir": temp_path / "work",
                    "map_source_file": source,
                    "dry_run": False,
                }
            )
            cfg.map_path.parent.mkdir(mode=GENERATED_DIR_MODE, parents=True)
            target = cfg.work_dir / "target-map.json"
            os.symlink(target, cfg.map_path)
            with self.assertRaises(SmokeError):
                prepare_map(cfg)
            self.assertFalse(target.exists())

    def test_safe_work_dir_rejects_unignored_repo_paths(self) -> None:
        """Secret-bearing workdirs must be outside the repo or ignored."""
        assert_safe_work_dir(Path("/tmp/screeps-private-smoke-self-test"))
        assert_safe_work_dir(DEFAULT_WORK_DIR)
        with self.assertRaises(SmokeError):
            assert_safe_work_dir(REPO_ROOT / "scripts" / "screeps-private-smoke.py")

    def test_stats_criteria(self) -> None:
        """Aggregate stats criteria should require owned rooms and creeps."""
        self.assertTrue(
            stats_passed(
                {
                    "totalRooms": 169,
                    "ownedRooms": 1,
                    "user": {"rooms": 1, "creeps": 1},
                },
                min_creeps=1,
            )
        )
        self.assertFalse(
            stats_passed(
                {
                    "totalRooms": 169,
                    "ownedRooms": 1,
                    "user": {"rooms": 1, "creeps": 0},
                },
                min_creeps=1,
            )
        )

    def test_wait_for_http_reports_last_http_failure(self) -> None:
        """Readiness timeouts should report the last bad /api/version response."""
        cfg = self.make_cfg()
        original_http_json = globals()["http_json"]
        original_time = time.time
        original_sleep = time.sleep
        ticks = [0.0, 0.0, 2.0]
        hidden = "api-token-123"

        def fake_http_json(*args: Any, **kwargs: Any) -> HttpResult:
            """Return a reachable but unhealthy version endpoint response."""
            return HttpResult(
                503,
                {"error": "temporary unavailable", "token": hidden, "detail": "x" * 500},
                {},
            )

        def fake_time() -> float:
            """Return deterministic clock ticks for one readiness attempt."""
            if ticks:
                return ticks.pop(0)
            return 2.0

        def fake_sleep(_seconds: float) -> None:
            """Avoid waiting during the deterministic readiness test."""

        try:
            globals()["http_json"] = fake_http_json
            time.time = fake_time
            time.sleep = fake_sleep
            with self.assertRaises(SmokeError) as caught:
                wait_for_http(cfg, timeout=1)
        finally:
            globals()["http_json"] = original_http_json
            time.time = original_time
            time.sleep = original_sleep

        message = str(caught.exception)
        self.assertIn("/api/version returned 503", message)
        self.assertIn("temporary unavailable", message)
        self.assertNotIn(hidden, message)
        self.assertNotIn("x" * 300, message)

    def test_poll_stats_retries_transient_http_errors(self) -> None:
        """A transient /stats request failure should not abort polling."""
        cfg = SmokeConfig(**{**self.make_cfg().__dict__, "stats_timeout": 10, "poll_interval": 0})
        original_http_json = globals()["http_json"]
        calls = 0

        def fake_http_json(*args: Any, **kwargs: Any) -> HttpResult:
            """Fail once, then return a passing stats payload."""
            nonlocal calls
            calls += 1
            if calls == 1:
                raise urllib.error.URLError("temporary reset")
            return HttpResult(
                200,
                {
                    "totalRooms": 169,
                    "ownedRooms": 1,
                    "users": [{"username": "smoke", "rooms": 1, "creeps": 1}],
                },
                {},
            )

        try:
            globals()["http_json"] = fake_http_json
            result = poll_stats(cfg)
        finally:
            globals()["http_json"] = original_http_json
        self.assertTrue(result["ok"])
        self.assertEqual(result["samples"], 1)
        self.assertEqual(calls, 2)

    def test_poll_stats_reports_last_transient_error(self) -> None:
        """Failed polling should keep the last transient request error."""
        cfg = SmokeConfig(**{**self.make_cfg().__dict__, "stats_timeout": 1, "poll_interval": 1})
        original_http_json = globals()["http_json"]
        original_time = time.time
        original_sleep = time.sleep
        ticks = [0.0, 0.0, 0.5, 2.0]

        def fake_http_json(*args: Any, **kwargs: Any) -> HttpResult:
            """Always simulate a timeout."""
            raise TimeoutError("temporary timeout")

        def fake_time() -> float:
            """Return deterministic clock ticks for one poll iteration."""
            if ticks:
                return ticks.pop(0)
            return 2.0

        def fake_sleep(_seconds: float) -> None:
            """Avoid waiting during the deterministic timeout test."""

        try:
            globals()["http_json"] = fake_http_json
            time.time = fake_time
            time.sleep = fake_sleep
            result = poll_stats(cfg)
        finally:
            globals()["http_json"] = original_http_json
            time.time = original_time
            time.sleep = original_sleep
        self.assertFalse(result["ok"])
        self.assertIn("temporary timeout", result["last_error"])

    def test_poll_stats_reports_last_http_failure(self) -> None:
        """Failed polling should keep the last bad /stats HTTP response."""
        cfg = SmokeConfig(**{**self.make_cfg().__dict__, "stats_timeout": 1, "poll_interval": 1})
        original_http_json = globals()["http_json"]
        original_time = time.time
        original_sleep = time.sleep
        ticks = [0.0, 0.0, 0.5, 2.0]

        def fake_http_json(*args: Any, **kwargs: Any) -> HttpResult:
            """Return a bounded, parseable server error payload."""
            return HttpResult(503, {"error": "temporary unavailable", "detail": "x" * 500}, {})

        def fake_time() -> float:
            """Return deterministic clock ticks for one poll iteration."""
            if ticks:
                return ticks.pop(0)
            return 2.0

        def fake_sleep(_seconds: float) -> None:
            """Avoid waiting during the deterministic timeout test."""

        try:
            globals()["http_json"] = fake_http_json
            time.time = fake_time
            time.sleep = fake_sleep
            result = poll_stats(cfg)
        finally:
            globals()["http_json"] = original_http_json
            time.time = original_time
            time.sleep = original_sleep
        self.assertFalse(result["ok"])
        self.assertIn("/stats returned 503", result["last_error"])
        self.assertIn("temporary unavailable", result["last_error"])
        self.assertNotIn("x" * 300, result["last_error"])

    def test_poll_stats_reports_last_non_dict_payload(self) -> None:
        """Failed polling should capture unusable /stats payloads."""
        cfg = SmokeConfig(**{**self.make_cfg().__dict__, "stats_timeout": 1, "poll_interval": 1})
        original_http_json = globals()["http_json"]
        original_time = time.time
        original_sleep = time.sleep
        ticks = [0.0, 0.0, 0.5, 2.0]

        def fake_http_json(*args: Any, **kwargs: Any) -> HttpResult:
            """Return a 200 response with a payload shape the stats parser cannot use."""
            return HttpResult(200, ["not", "stats"], {})

        def fake_time() -> float:
            """Return deterministic clock ticks for one poll iteration."""
            if ticks:
                return ticks.pop(0)
            return 2.0

        def fake_sleep(_seconds: float) -> None:
            """Avoid waiting during the deterministic timeout test."""

        try:
            globals()["http_json"] = fake_http_json
            time.time = fake_time
            time.sleep = fake_sleep
            result = poll_stats(cfg)
        finally:
            globals()["http_json"] = original_http_json
            time.time = original_time
            time.sleep = original_sleep
        self.assertFalse(result["ok"])
        self.assertIn("/stats returned 200", result["last_error"])
        self.assertIn("not", result["last_error"])

    def test_collect_mongo_summary_uses_bounded_parseable_output(self) -> None:
        """Mongo summary parsing should use the expanded bounded excerpt."""
        cfg = self.make_cfg()
        original_run_command = globals()["run_command"]
        captured: dict[str, Any] = {}

        def fake_run_command(command: list[str], cfg: SmokeConfig, **kwargs: Any) -> dict[str, Any]:
            """Return a complete one-line Mongo JSON summary."""
            captured["output_limit"] = kwargs.get("output_limit")
            return {
                "command": command,
                "returncode": 0,
                "elapsed_seconds": 0,
                "output_excerpt": json.dumps({"room": cfg.room, "spawns": [], "creeps": [], "controller": None}),
            }

        try:
            globals()["run_command"] = fake_run_command
            result = collect_mongo_summary([], cfg)
        finally:
            globals()["run_command"] = original_run_command
        self.assertEqual(captured["output_limit"], 12000)
        self.assertTrue(result["ok"])

    def test_room_spawn_summary_verifies_expected_owner(self) -> None:
        """Room-spawn verification should require the named spawn owner."""
        cfg = self.make_cfg()
        summary = {
            "ok": True,
            "summary": {
                "room": "E1S1",
                "user": {"username": "smoke", "id": "user-1"},
                "spawns": [{"name": "Spawn1", "user": "user-1"}],
                "controller": {"user": "user-1"},
            },
        }
        self.assertTrue(verify_room_spawn_summary(summary, cfg)["ok"])

        missing_spawn = {"ok": True, "summary": {**summary["summary"], "spawns": []}}
        self.assertFalse(verify_room_spawn_summary(missing_spawn, cfg)["ok"])

        wrong_owner = {"ok": True, "summary": {**summary["summary"], "spawns": [{"name": "Spawn1", "user": "user-2"}]}}
        self.assertFalse(verify_room_spawn_summary(wrong_owner, cfg)["ok"])


def run_self_test() -> int:
    """Run the offline unittest suite."""
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SmokeSelfTest)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser for self-test and run modes."""
    parser = argparse.ArgumentParser(
        description="Run or self-test the pinned Dockerized Screeps private-server smoke harness.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser(
        "self-test",
        help="Run offline helper tests. Requires no Docker, network, secrets, or live Screeps server.",
    )

    dry_parser = subparsers.add_parser(
        "dry-run",
        help="Generate a secret-free config/report without Docker, network, secrets, or a live server.",
    )
    dry_parser.add_argument(
        "--work-dir",
        help=(
            f"Ignored local work directory. Default: {DEFAULT_WORK_DIR}; "
            "non-default host ports derive a port-specific default workdir."
        ),
    )
    dry_parser.add_argument(
        "--host-port-start",
        type=int,
        help=(
            "Bind the private server HTTP host port to this value and CLI host port to the next value. "
            "Env: SCREEPS_PRIVATE_SMOKE_HOST_PORT_START. "
            f"Default: {DEFAULT_HTTP_PORT}/{DEFAULT_CLI_PORT}."
        ),
    )
    dry_parser.add_argument(
        "--host-http-port",
        type=int,
        help=f"Explicit private server HTTP host port. Env: SCREEPS_PRIVATE_SMOKE_HTTP_PORT. Default: {DEFAULT_HTTP_PORT}.",
    )
    dry_parser.add_argument(
        "--host-cli-port",
        type=int,
        help=f"Explicit private server CLI host port. Env: SCREEPS_PRIVATE_SMOKE_CLI_PORT. Default: {DEFAULT_CLI_PORT}.",
    )
    dry_parser.set_defaults(
        dry_run=True,
        stats_timeout=240,
        poll_interval=5,
        min_creeps=1,
        no_reset_data=False,
    )

    run_parser = subparsers.add_parser(
        "run",
        help="Prepare an ignored workdir and run the local Dockerized private-server smoke.",
    )
    run_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Generate secret-free config/report and validate request shapes without Docker, network, secrets, or a live server.",
    )
    run_parser.add_argument(
        "--work-dir",
        help=(
            f"Ignored local work directory. Default: {DEFAULT_WORK_DIR}; "
            "non-default host ports derive a port-specific default workdir."
        ),
    )
    run_parser.add_argument(
        "--host-port-start",
        type=int,
        help=(
            "Bind the private server HTTP host port to this value and CLI host port to the next value. "
            "Env: SCREEPS_PRIVATE_SMOKE_HOST_PORT_START. "
            f"Default: {DEFAULT_HTTP_PORT}/{DEFAULT_CLI_PORT}."
        ),
    )
    run_parser.add_argument(
        "--host-http-port",
        type=int,
        help=f"Explicit private server HTTP host port. Env: SCREEPS_PRIVATE_SMOKE_HTTP_PORT. Default: {DEFAULT_HTTP_PORT}.",
    )
    run_parser.add_argument(
        "--host-cli-port",
        type=int,
        help=f"Explicit private server CLI host port. Env: SCREEPS_PRIVATE_SMOKE_CLI_PORT. Default: {DEFAULT_CLI_PORT}.",
    )
    run_parser.add_argument(
        "--stats-timeout",
        type=int,
        default=240,
        help="Seconds to poll /stats for owned-room and creep criteria. Default: 240.",
    )
    run_parser.add_argument(
        "--poll-interval",
        type=int,
        default=5,
        help="Seconds between /stats polls. Default: 5.",
    )
    run_parser.add_argument(
        "--min-creeps",
        type=int,
        default=1,
        help="Minimum smoke-user creep count required in /stats before success. Default: 1.",
    )
    run_parser.add_argument(
        "--no-reset-data",
        action="store_true",
        help="Skip system.resetAllData() before map import; requires SCREEPS_PRIVATE_SMOKE_PASSWORD for live reuse.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "self-test":
        return run_self_test()
    if args.command in {"run", "dry-run"}:
        try:
            cfg = config_from_env(args)
            errors = required_env_errors(cfg)
            if errors:
                for error in errors:
                    print(f"error: {error}", file=sys.stderr)
                return 2
            report = run_dry(cfg) if cfg.dry_run else run_live(cfg)
            print(json.dumps(redact(report, [cfg.password or "", os.environ.get("STEAM_KEY", "")]), indent=2, sort_keys=True))
            return 0 if report.get("ok") else 1
        except SmokeError as exc:
            print(f"error: {redact(str(exc), [os.environ.get('STEAM_KEY', '')])}", file=sys.stderr)
            return 1
        except KeyboardInterrupt:
            print("interrupted", file=sys.stderr)
            return 130
    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
