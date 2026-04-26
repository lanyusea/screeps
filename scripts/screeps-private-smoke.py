#!/usr/bin/env python3
"""Automation harness for the pinned Dockerized Screeps private-server smoke.

The live ``run`` command is intentionally local/manual: it creates an ignored
work directory, starts the pinned launcher stack there, uploads the built bot,
places a local spawn, polls safe stats, and writes a redacted report.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
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
DEFAULT_CODE_PATH = REPO_ROOT / "prod" / "dist" / "main.js"
DEFAULT_HTTP_PORT = 21025
DEFAULT_CLI_PORT = 21026
DEFAULT_ROOM = "E1S1"
DEFAULT_SHARD = "shardX"
DEFAULT_USERNAME = "smoke"
DEFAULT_SPAWN_NAME = "Spawn1"
DEFAULT_SPAWN_X = 20
DEFAULT_SPAWN_Y = 20
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
        return self.work_dir / "config.yml"

    @property
    def compose_path(self) -> Path:
        return self.work_dir / "docker-compose.yml"

    @property
    def steam_key_path(self) -> Path:
        return self.work_dir / "STEAM_KEY"

    @property
    def map_path(self) -> Path:
        return self.work_dir / "maps" / MAP_FILENAME

    @property
    def bot_main_path(self) -> Path:
        return self.work_dir / "bots" / "mvpbot" / "main.js"

    @property
    def report_path(self) -> Path:
        timestamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        return self.work_dir / f"private-smoke-report-{timestamp}.json"


@dataclass
class HttpResult:
    status: int
    payload: Any
    headers: dict[str, str]


def short_text(value: Any, max_len: int = 500) -> str:
    text = str(value)
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "..."


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise SmokeError(f"{name} must be an integer") from exc


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def safe_fragment(value: str) -> str:
    fragment = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip(".-")
    return fragment or "screeps-private-smoke"


def resolve_path(value: str | None, default: Path | None = None) -> Path | None:
    if not value:
        return default
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = (Path.cwd() / path).resolve()
    return path


def config_from_env(args: argparse.Namespace) -> SmokeConfig:
    work_dir = resolve_path(
        args.work_dir or os.environ.get("SCREEPS_PRIVATE_SMOKE_WORKDIR"),
        DEFAULT_WORK_DIR,
    )
    assert work_dir is not None
    server_host = os.environ.get("SCREEPS_PRIVATE_SMOKE_HOST", "127.0.0.1")
    http_port = env_int("SCREEPS_PRIVATE_SMOKE_HTTP_PORT", DEFAULT_HTTP_PORT)
    cli_port = env_int("SCREEPS_PRIVATE_SMOKE_CLI_PORT", DEFAULT_CLI_PORT)
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
    password = os.environ.get("SCREEPS_PRIVATE_SMOKE_PASSWORD")
    if not password and not args.dry_run:
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
        reset_data=not args.no_reset_data and env_bool("SCREEPS_PRIVATE_SMOKE_RESET_DATA", True),
        dry_run=args.dry_run,
        compose_project=compose_project,
        mongo_db=os.environ.get("SCREEPS_PRIVATE_SMOKE_MONGO_DB", "screeps"),
    )


def required_env_errors(cfg: SmokeConfig) -> list[str]:
    errors: list[str] = []
    if cfg.dry_run:
        return errors
    if not os.environ.get("STEAM_KEY"):
        errors.append("STEAM_KEY is required for run mode")
    if cfg.password is None:
        errors.append("internal error: smoke password was not generated")
    if not cfg.code_path.exists():
        errors.append(f"bot bundle does not exist: {cfg.code_path}")
    return errors


def build_launcher_config(cfg: SmokeConfig) -> str:
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
  port: {cfg.cli_port}
  username: ""
  password: ""
"""


def build_compose_file(cfg: SmokeConfig) -> str:
    return f"""services:
  screeps:
    image: screepers/screeps-launcher:latest
    volumes:
      - ./:/screeps
    ports:
      - "{cfg.server_host}:{cfg.http_port}:21025/tcp"
      - "{cfg.server_host}:{cfg.cli_port}:21026/tcp"
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
      test: ["CMD-SHELL", "sh", "-c", "curl --fail --silent http://127.0.0.1:21025/api/version >/dev/null"]
      interval: 10s
      timeout: 5s
      start_period: 10s
      retries: 12

  mongo:
    image: mongo:8
    volumes:
      - mongo-data:/data/db
    restart: "no"
    healthcheck:
      test: ["CMD-SHELL", "sh", "-c", "echo 'db.runCommand(\\"ping\\").ok' | mongosh localhost:27017/test --quiet"]
      interval: 10s
      timeout: 5s
      start_period: 10s
      retries: 12

  redis:
    image: redis:7
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
    data = path.read_bytes()
    return {
        "path": str(path),
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def redacted_module_summary(modules: dict[str, Any]) -> dict[str, Any]:
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
    encoded = json.dumps(payload, sort_keys=True)
    for secret_value in secrets_to_hide:
        if secret_value and secret_value in encoded:
            raise SmokeError("redacted report still contains a secret value")
    if "module.exports.loop" in encoded:
        raise SmokeError("redacted report still contains uploaded code contents")


def build_register_payload(cfg: SmokeConfig) -> dict[str, Any]:
    if cfg.password is None:
        raise SmokeError("smoke password is unavailable")
    return {
        "username": cfg.username,
        "email": cfg.email,
        "password": cfg.password,
    }


def build_signin_payload(cfg: SmokeConfig) -> dict[str, Any]:
    if cfg.password is None:
        raise SmokeError("smoke password is unavailable")
    return {
        "email": cfg.username,
        "password": cfg.password,
    }


def build_code_payload(cfg: SmokeConfig, code: str) -> dict[str, Any]:
    return {
        "branch": cfg.branch,
        "modules": {
            "main": code,
        },
    }


def build_spawn_payload(cfg: SmokeConfig) -> dict[str, Any]:
    return {
        "name": cfg.spawn_name,
        "room": cfg.room,
        "x": cfg.spawn_x,
        "y": cfg.spawn_y,
    }


def request_shape(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "method": method,
        "path": path,
        "body": body or {},
    }


def prepare_work_dir(cfg: SmokeConfig) -> dict[str, Any]:
    cfg.work_dir.mkdir(parents=True, exist_ok=True)
    (cfg.work_dir / "maps").mkdir(parents=True, exist_ok=True)
    cfg.bot_main_path.parent.mkdir(parents=True, exist_ok=True)
    cfg.config_path.write_text(build_launcher_config(cfg), encoding="utf-8")
    cfg.compose_path.write_text(build_compose_file(cfg), encoding="utf-8")
    if not cfg.dry_run:
        steam_key = os.environ["STEAM_KEY"]
        cfg.steam_key_path.write_text(steam_key, encoding="utf-8")
        cfg.steam_key_path.chmod(0o600)
        shutil.copyfile(cfg.code_path, cfg.bot_main_path)
    return {
        "work_dir": str(cfg.work_dir),
        "config": str(cfg.config_path),
        "compose": str(cfg.compose_path),
        "steam_key_file": "created" if not cfg.dry_run else "not-created-dry-run",
        "bot_package_main": str(cfg.bot_main_path) if not cfg.dry_run else "not-copied-dry-run",
    }


def prepare_map(cfg: SmokeConfig) -> dict[str, Any]:
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
        shutil.copyfile(cfg.map_source_file, cfg.map_path)
        source = str(cfg.map_source_file)
    elif cfg.map_path.exists():
        source = "existing-workdir-file"
    else:
        request = urllib.request.Request(cfg.map_url, headers={"User-Agent": "screeps-private-smoke/1.0"})
        with urllib.request.urlopen(request, timeout=60) as response:
            cfg.map_path.write_bytes(response.read())
        source = cfg.map_url
    return {
        "path": str(cfg.map_path),
        "container_path": MAP_CONTAINER_PATH,
        "source": source,
        "bytes": cfg.map_path.stat().st_size,
        "sha256": hashlib.sha256(cfg.map_path.read_bytes()).hexdigest(),
    }


def find_compose_command() -> list[str]:
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
    env = os.environ.copy()
    env["COMPOSE_PROJECT_NAME"] = cfg.compose_project
    return env


def run_command(
    command: list[str],
    cfg: SmokeConfig,
    input_text: str | None = None,
    timeout: int = 120,
) -> dict[str, Any]:
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
    sanitized_output = redact(short_text(output, 1400), [os.environ.get("STEAM_KEY", ""), cfg.password or ""])
    return {
        "command": command_summary,
        "returncode": result.returncode,
        "elapsed_seconds": elapsed,
        "output_excerpt": sanitized_output,
    }


def require_success(step: dict[str, Any]) -> dict[str, Any]:
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


def token_headers(token: str) -> dict[str, str]:
    return {
        "X-Username": token,
        "X-Token": token,
    }


def update_token_from_headers(current: str, headers: dict[str, str]) -> str:
    for key, value in headers.items():
        if key.lower() == "x-token" and value:
            return value
    return current


def wait_for_http(cfg: SmokeConfig, timeout: int = 300) -> dict[str, Any]:
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
        except Exception as exc:  # noqa: BLE001 - sanitized below for report
            last_error = short_text(exc, 200)
        time.sleep(3)
    raise SmokeError(f"private server did not become HTTP-ready after {timeout}s: {last_error}")


def run_launcher_cli(compose: list[str], cfg: SmokeConfig, expression: str) -> dict[str, Any]:
    command = [*compose, "exec", "-T", "screeps", "screeps-launcher", "cli"]
    return require_success(run_command(command, cfg, input_text=expression + "\n", timeout=240))


def safe_user_stats(stats: dict[str, Any], username: str) -> dict[str, Any]:
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
    deadline = time.time() + cfg.stats_timeout
    first: dict[str, Any] | None = None
    last: dict[str, Any] | None = None
    samples = 0
    while time.time() < deadline:
        result = http_json("GET", cfg.server_url, "/stats", timeout=15)
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
        time.sleep(cfg.poll_interval)
    return {
        "ok": False,
        "samples": samples,
        "first": first,
        "last": last,
        "criteria": {"min_creeps": cfg.min_creeps},
        "error": "stats criteria were not met before timeout",
    }


def collect_mongo_summary(compose: list[str], cfg: SmokeConfig) -> dict[str, Any]:
    eval_script = f"""
const smokeDb = db.getSiblingDB({json.dumps(cfg.mongo_db)});
const objects = smokeDb.getCollection('rooms.objects').find({{room: {json.dumps(cfg.room)}, type: {{$in: ['spawn', 'creep', 'controller', 'source', 'mineral']}}}}).toArray();
const counts = {{}};
const creeps = [];
const spawns = [];
let controller = null;
for (const object of objects) {{
  counts[object.type] = (counts[object.type] || 0) + 1;
  if (object.type === 'creep') creeps.push({{name: object.name, x: object.x, y: object.y, body: (object.body || []).map(part => part.type), ticksToLive: object.ticksToLive}});
  if (object.type === 'spawn') spawns.push({{name: object.name, x: object.x, y: object.y, hits: object.hits, hitsMax: object.hitsMax, store: object.store}});
  if (object.type === 'controller') controller = {{x: object.x, y: object.y, level: object.level, progress: object.progress, progressTotal: object.progressTotal}};
}}
print(JSON.stringify({{room: {json.dumps(cfg.room)}, counts, spawns, creeps, controller}}));
"""
    command = [*compose, "exec", "-T", "mongo", "mongosh", "--quiet", "--eval", eval_script]
    result = run_command(command, cfg, timeout=60)
    if result["returncode"] != 0:
        return {"ok": False, "error": result["output_excerpt"]}
    try:
        payload = json.loads(str(result["output_excerpt"]).strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as exc:
        return {"ok": False, "error": f"could not parse mongosh summary: {short_text(exc, 160)}"}
    return {"ok": True, "summary": redact(payload)}


def run_live(cfg: SmokeConfig) -> dict[str, Any]:
    phases: list[dict[str, Any]] = []
    secrets_to_hide = [os.environ.get("STEAM_KEY", ""), cfg.password or ""]
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    report: dict[str, Any] = {
        "ok": False,
        "dry_run": False,
        "started_at": started_at,
        "work_dir": str(cfg.work_dir),
        "server_url": cfg.server_url,
        "launcher": {
            "image": "screepers/screeps-launcher:latest",
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
        upload_ok = upload.status == 200 and isinstance(upload.payload, dict) and "timestamp" in upload.payload
        phases.append({"name": "upload-code", "ok": upload_ok, "details": {"status": upload.status, "response": redact(upload.payload, secrets_to_hide), "module": code_summary}})
        if not upload_ok:
            raise SmokeError(f"code upload failed: {redact(upload.payload, secrets_to_hide)}")

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

        overview = http_json("GET", cfg.server_url, "/api/user/overview", headers=token_headers(token))
        token = update_token_from_headers(token, overview.headers)
        phases.append({"name": "user-overview", "ok": overview.status == 200, "details": {"status": overview.status, "response": redact(overview.payload, secrets_to_hide)}})

        room_overview = http_json(
            "GET",
            cfg.server_url,
            "/api/game/room-overview",
            headers=token_headers(token),
            params={"room": cfg.room, "shard": cfg.shard},
        )
        token = update_token_from_headers(token, room_overview.headers)
        phases.append({"name": "room-overview", "ok": room_overview.status == 200, "details": {"status": room_overview.status, "response": redact(room_overview.payload, secrets_to_hide)}})

        stats = poll_stats(cfg)
        phases.append({"name": "poll-stats", "ok": bool(stats.get("ok")), "details": redact(stats, secrets_to_hide)})
        if not stats.get("ok"):
            raise SmokeError("stats polling did not reach the expected owned-room/creep criteria")

        mongo_summary = collect_mongo_summary(compose, cfg)
        phases.append({"name": "mongo-summary", "ok": bool(mongo_summary.get("ok")), "optional": True, "details": redact(mongo_summary, secrets_to_hide)})

        report["ok"] = True
    except Exception as exc:  # noqa: BLE001 - top-level report must capture sanitized failures
        phases.append({"name": "failure", "ok": False, "error": redact(short_text(exc, 1000), secrets_to_hide)})
        report["error"] = redact(short_text(exc, 1000), secrets_to_hide)
    finally:
        report["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        assert_no_secret_leak(report, secrets_to_hide)
        cfg.work_dir.mkdir(parents=True, exist_ok=True)
        report_path = cfg.report_path
        report_path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
        report["report_path"] = str(report_path)
    return report


def run_dry(cfg: SmokeConfig) -> dict[str, Any]:
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
        "prepare": redact(prepare, [fake_password]),
        "map": redact(map_details, [fake_password]),
        "launcher_config_contains_secret": "dry-run-password" in build_launcher_config(dry_cfg),
        "request_shapes": redact(request_shapes, [fake_password]),
        "redaction_checked": True,
    }
    assert_no_secret_leak(report, [fake_password, sample_code])
    report_path = dry_cfg.report_path
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    report["report_path"] = str(report_path)
    return report


class SmokeSelfTest(unittest.TestCase):
    def make_cfg(self) -> SmokeConfig:
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

    def test_launcher_config_is_secret_free(self) -> None:
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
        cfg = self.make_cfg()
        compose = build_compose_file(cfg)
        self.assertIn('"127.0.0.1:21025:21025/tcp"', compose)
        self.assertIn('"127.0.0.1:21026:21026/tcp"', compose)
        self.assertIn("screepers/screeps-launcher:latest", compose)

    def test_redaction_removes_secrets_and_code(self) -> None:
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

    def test_required_env_only_applies_to_live_run(self) -> None:
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

    def test_stats_criteria(self) -> None:
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


def run_self_test() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SmokeSelfTest)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run or self-test the pinned Dockerized Screeps private-server smoke harness.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser(
        "self-test",
        help="Run offline helper tests. Requires no Docker, network, secrets, or live Screeps server.",
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
        help=f"Ignored local work directory. Default: {DEFAULT_WORK_DIR}",
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
        help="Skip system.resetAllData() before map import when reusing a local smoke server.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "self-test":
        return run_self_test()
    if args.command == "run":
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
