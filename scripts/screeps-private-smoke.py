#!/usr/bin/env python3
"""Pinned Dockerized Screeps private-server smoke harness.

The default `plan`/`--dry-run` path is safe for cron: it renders only local,
non-secret files in an untracked work directory and prints redacted next steps.
The `run` path starts the local Dockerized private server and exercises the
previously verified pinned Screeps 4.2.21 launcher flow.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

DEFAULT_WORK_DIR = Path("/tmp/screeps-private-smoke-harness")
DEFAULT_MAP_URL = "https://maps.screepspl.us/maps/map-0b6758af.json"
DEFAULT_MAP_NAME = "map-0b6758af.json"
DEFAULT_HTTP_URL = "http://127.0.0.1:21025"
DEFAULT_ROOM = "E1S1"
DEFAULT_SPAWN = "Spawn1"
DEFAULT_USERNAME = "smoke"
MARKER_FILE = ".screeps-private-smoke-harness"
REDACTED = "<redacted>"

PINNED_PACKAGES = {
    "ssri": "8.0.1",
    "cacache": "15.3.0",
    "passport-steam": "1.0.17",
    "minipass-fetch": "2.1.2",
    "express-rate-limit": "6.7.0",
    "body-parser": "1.20.3",
    "path-to-regexp": "0.1.12",
    "psl": "1.10.0",
}

SECRET_KEYS = {"password", "token", "steam_key", "authorization", "x_token"}
SECRET_KEY_SUFFIXES = {"password", "token"}
MAX_SUMMARY_OUTPUT_CHARS = 1200


def normalize_secret_key(key: Any) -> str:
    if not isinstance(key, str):
        return ""
    return "".join(ch.lower() for ch in key if ch.isalnum())


SECRET_KEY_FINGERPRINTS = {normalize_secret_key(key) for key in SECRET_KEYS | {"steam-key", "steamKey", "x-token"}}


def should_redact_key(key: Any) -> bool:
    normalized = normalize_secret_key(key)
    return normalized in SECRET_KEY_FINGERPRINTS or any(normalized.endswith(suffix) for suffix in SECRET_KEY_SUFFIXES)


@dataclass
class HarnessConfig:
    work_dir: Path
    repo_root: Path
    http_url: str
    username: str
    password: str
    room: str
    spawn_name: str
    spawn_x: int
    spawn_y: int
    map_url: str
    map_name: str
    observation_seconds: int
    poll_interval_seconds: int
    steam_key_present: bool

    @property
    def map_file(self) -> Path:
        return self.work_dir / "maps" / self.map_name

    @property
    def summary_file(self) -> Path:
        return self.work_dir / "artifacts" / "summary.json"

    @property
    def compose_file(self) -> Path:
        return self.work_dir / "docker-compose.yml"

    @property
    def launcher_config_file(self) -> Path:
        return self.work_dir / "config.yml"

    @property
    def bot_bundle(self) -> Path:
        return self.repo_root / "prod" / "dist" / "main.js"


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: (REDACTED if should_redact_key(k) else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_safe_work_dir(work_dir: Path) -> None:
    work_dir.mkdir(parents=True, exist_ok=True)
    marker = work_dir / MARKER_FILE
    if not marker.exists() and any(work_dir.iterdir()):
        raise SystemExit(f"Refusing to use non-empty unmarked work dir: {work_dir}")
    marker.write_text("owned by scripts/screeps-private-smoke.py\n", encoding="utf-8")
    (work_dir / "maps").mkdir(exist_ok=True)
    (work_dir / "artifacts").mkdir(exist_ok=True)


def render_compose(config: HarnessConfig) -> str:
    return f"""services:
  screeps:
    image: screepers/screeps-launcher:latest
    restart: unless-stopped
    ports:
      - "21025:21025"
    environment:
      STEAM_KEY: ${{STEAM_KEY:-}}
    volumes:
      - ./config.yml:/screeps/config.yml:ro
      - ./maps:/screeps/maps:ro
      - {json.dumps(f"{config.repo_root / 'prod' / 'dist'}:/bot:ro")}
    depends_on:
      - mongo
      - redis
  mongo:
    image: mongo:8
    restart: unless-stopped
    volumes:
      - mongo-data:/data/db
  redis:
    image: redis:7
    restart: unless-stopped
volumes:
  mongo-data:
"""


def render_launcher_config(config: HarnessConfig) -> str:
    pins = "\n".join(f"  {name}: {version}" for name, version in PINNED_PACKAGES.items())
    return f"""steamKey: ${{STEAM_KEY}}
version: 4.2.21
nodeVersion: Erbium
pinnedPackages:
{pins}
mods:
  - screepsmod-auth
  - screepsmod-admin-utils
  - screepsmod-mongo
serverConfig:
  welcomeText: "Local Screeps MVP smoke server"
  mapFile: /screeps/maps/{config.map_name}
  tickRate: 200
"""


def write_rendered_files(config: HarnessConfig) -> None:
    ensure_safe_work_dir(config.work_dir)
    config.compose_file.write_text(render_compose(config), encoding="utf-8")
    config.launcher_config_file.write_text(render_launcher_config(config), encoding="utf-8")


def download_map(config: HarnessConfig, *, allow_network: bool) -> str:
    if config.map_file.exists() and config.map_file.stat().st_size > 0:
        return "cached"
    if not allow_network:
        return "not-downloaded-dry-run"
    request = urllib.request.Request(config.map_url, headers={"User-Agent": "screeps-private-smoke/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        config.map_file.write_bytes(response.read())
    return "downloaded"


def run_command(args: list[str], *, cwd: Path, input_text: str | None = None, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, input=input_text, text=True, capture_output=True, timeout=timeout, check=False)


def text_tail(value: str, limit: int = MAX_SUMMARY_OUTPUT_CHARS) -> str:
    if len(value) <= limit:
        return value
    return value[-limit:]


def command_summary(result: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    return {
        "returncode": result.returncode,
        "stdout_tail": text_tail(result.stdout or ""),
        "stderr_tail": text_tail(result.stderr or ""),
    }


def exception_summary(exc: Exception) -> dict[str, str]:
    return {"type": type(exc).__name__, "message": text_tail(str(exc), limit=600)}


def record_failure(summary: dict[str, Any], phase: str, details: Any) -> None:
    summary["status"] = "failed"
    summary["failure"] = {"phase": phase, "details": redact(details)}


def require_success(summary: dict[str, Any], phase: str, result: subprocess.CompletedProcess[str]) -> None:
    if result.returncode != 0:
        record_failure(summary, phase, command_summary(result))
        raise RuntimeError(f"{phase} failed with exit code {result.returncode}")


def docker_compose_base() -> list[str]:
    if shutil.which("docker"):
        return ["docker", "compose"]
    if shutil.which("docker-compose"):
        return ["docker-compose"]
    raise RuntimeError("Neither docker compose nor docker-compose is available")


def http_json(url: str, *, method: str = "GET", data: dict[str, Any] | None = None, headers: dict[str, str] | None = None, timeout: int = 20) -> dict[str, Any]:
    body = None
    request_headers = {"Accept": "application/json"}
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read().decode("utf-8")
    if not payload:
        return {}
    return json.loads(payload)


def wait_for_http(config: HarnessConfig, seconds: int) -> dict[str, Any]:
    deadline = time.time() + seconds
    last_error = "not attempted"
    while time.time() < deadline:
        try:
            return http_json(f"{config.http_url}/api/version")
        except Exception as exc:  # readiness loop only
            last_error = str(exc)
            time.sleep(2)
    raise RuntimeError(f"HTTP readiness timed out: {last_error}")


def launcher_cli(config: HarnessConfig, js: str, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return run_command(docker_compose_base() + ["exec", "-T", "screeps", "screeps-launcher", "cli"], cwd=config.work_dir, input_text=js + "\n", timeout=timeout)


def basic_auth(config: HarnessConfig) -> str:
    raw = f"{config.username}:{config.password}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def register_user(config: HarnessConfig) -> dict[str, Any]:
    payload = {"username": config.username, "email": config.username, "password": config.password}
    try:
        return http_json(f"{config.http_url}/api/register/submit", method="POST", data=payload)
    except urllib.error.HTTPError as exc:
        # Existing user is acceptable for reruns; return redacted status.
        return {"status": "register-http-error", "code": exc.code}


def upload_code(config: HarnessConfig) -> dict[str, Any]:
    code = config.bot_bundle.read_text(encoding="utf-8")
    payload = {"branch": "default", "modules": {"main": code}}
    return http_json(
        f"{config.http_url}/api/user/code",
        method="POST",
        data=payload,
        headers={"Authorization": basic_auth(config)},
    )


def place_spawn(config: HarnessConfig) -> dict[str, Any]:
    payload = {"room": config.room, "x": config.spawn_x, "y": config.spawn_y, "name": config.spawn_name}
    return http_json(
        f"{config.http_url}/api/game/place-spawn",
        method="POST",
        data=payload,
        headers={"Authorization": basic_auth(config), "X-Username": config.username, "X-Token": config.password},
    )


def poll_stats(config: HarnessConfig, seconds: int) -> list[dict[str, Any]]:
    observations: list[dict[str, Any]] = []
    deadline = time.time() + seconds
    while time.time() <= deadline:
        try:
            stats = http_json(f"{config.http_url}/stats")
            observations.append({k: stats.get(k) for k in ("gametime", "totalRooms", "activeRooms", "ownedRooms", "activeUsers")})
        except Exception as exc:
            observations.append({"error": str(exc)[:160]})
        time.sleep(config.poll_interval_seconds)
    return observations


def write_summary(config: HarnessConfig, summary: dict[str, Any]) -> None:
    redacted = redact(summary)
    config.summary_file.parent.mkdir(exist_ok=True)
    config.summary_file.write_text(json.dumps(redacted, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def plan(config: HarnessConfig) -> dict[str, Any]:
    write_rendered_files(config)
    map_status = download_map(config, allow_network=False)
    summary = {
        "mode": "plan",
        "work_dir": str(config.work_dir),
        "files": [str(config.compose_file), str(config.launcher_config_file), str(config.map_file)],
        "map_status": map_status,
        "bot_bundle_exists": config.bot_bundle.exists(),
        "steam_key_present": config.steam_key_present,
        "next_actions": [
            "export STEAM_KEY through a local secret channel if not already present",
            f"python3 scripts/screeps-private-smoke.py run --work-dir {config.work_dir}",
            f"python3 scripts/screeps-private-smoke.py down --work-dir {config.work_dir}",
        ],
    }
    write_summary(config, summary)
    return redact(summary)


def run_harness(config: HarnessConfig) -> dict[str, Any]:
    if not config.bot_bundle.exists():
        raise SystemExit(f"Missing bot bundle: {config.bot_bundle}; run cd prod && npm run build first")
    write_rendered_files(config)
    summary = {
        "mode": "run",
        "work_dir": str(config.work_dir),
        "status": "running",
        "phase": "initializing",
        "commands": {},
        "username": config.username,
        "password": config.password,
        "steam_key_present": config.steam_key_present,
    }
    try:
        summary["phase"] = "download_map"
        summary["map_status"] = download_map(config, allow_network=True)
        summary["map_sha256"] = sha256_file(config.map_file) if config.map_file.exists() else None

        summary["phase"] = "docker compose up"
        compose = docker_compose_base()
        up = run_command(compose + ["up", "-d"], cwd=config.work_dir, timeout=300)
        summary["commands"]["docker_compose_up"] = command_summary(up)
        require_success(summary, "docker compose up", up)

        summary["phase"] = "wait_for_http_initial"
        summary["version"] = wait_for_http(config, seconds=180)

        summary["phase"] = "system.resetAllData()"
        reset = launcher_cli(config, "system.resetAllData()", timeout=120)
        summary["commands"]["reset_all_data"] = command_summary(reset)
        summary["reset_returncode"] = reset.returncode
        require_success(summary, "system.resetAllData()", reset)

        summary["phase"] = "utils.importMapFile(...)"
        import_map = launcher_cli(config, f"utils.importMapFile('/screeps/maps/{config.map_name}')", timeout=240)
        summary["commands"]["import_map_file"] = command_summary(import_map)
        summary["import_map_returncode"] = import_map.returncode
        require_success(summary, "utils.importMapFile(...)", import_map)

        summary["phase"] = "docker compose restart screeps"
        restart = run_command(compose + ["restart", "screeps"], cwd=config.work_dir, timeout=180)
        summary["commands"]["docker_compose_restart_screeps"] = command_summary(restart)
        summary["restart_returncode"] = restart.returncode
        require_success(summary, "docker compose restart screeps", restart)

        summary["phase"] = "wait_for_http_after_restart"
        wait_for_http(config, seconds=180)

        summary["phase"] = "system.resumeSimulation()"
        resume = launcher_cli(config, "system.resumeSimulation()", timeout=120)
        summary["commands"]["resume_simulation"] = command_summary(resume)
        summary["resume_returncode"] = resume.returncode
        require_success(summary, "system.resumeSimulation()", resume)

        summary["phase"] = "register_user"
        summary["registration"] = register_user(config)
        summary["phase"] = "upload_code"
        summary["upload"] = upload_code(config)
        summary["phase"] = "place_spawn"
        summary["spawn"] = place_spawn(config)
        summary["phase"] = "poll_stats"
        summary["observations"] = poll_stats(config, config.observation_seconds)
        summary["status"] = "passed"
        summary.pop("phase", None)
        return redact(summary)
    except Exception as exc:
        if "failure" not in summary:
            record_failure(summary, str(summary.get("phase", "run")), exception_summary(exc))
        raise
    finally:
        write_summary(config, summary)


def down(config: HarnessConfig) -> dict[str, Any]:
    ensure_safe_work_dir(config.work_dir)
    result = run_command(docker_compose_base() + ["down"], cwd=config.work_dir, timeout=180)
    summary = {"mode": "down", "work_dir": str(config.work_dir), **command_summary(result)}
    write_summary(config, summary)
    return redact(summary)


def exit_code_for_result(command: str, result: dict[str, Any]) -> int:
    if command == "down":
        return int(result.get("returncode") or 0)
    return 0


def self_test() -> dict[str, Any]:
    import contextlib
    import io
    import tempfile

    checks = 0
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo"
        dist = repo / "prod" / "dist"
        dist.mkdir(parents=True)
        (dist / "main.js").write_text("module.exports.loop = function() {};\n", encoding="utf-8")
        cfg = build_config(argparse.Namespace(
            work_dir=str(Path(tmp) / "work"),
            repo_root=str(repo),
            http_url=DEFAULT_HTTP_URL,
            username="smoke",
            password="super-secret",
            room="E1S1",
            spawn_name="Spawn1",
            spawn_x=20,
            spawn_y=20,
            map_url=DEFAULT_MAP_URL,
            map_name=DEFAULT_MAP_NAME,
            observation_seconds=1,
            poll_interval_seconds=1,
        ))
        rendered = render_launcher_config(cfg)
        assert "version: 4.2.21" in rendered
        assert "body-parser: 1.20.3" in rendered
        assert f"mapFile: /screeps/maps/{DEFAULT_MAP_NAME}" in rendered
        checks += 3

        compose = render_compose(cfg)
        assert f'"{repo.resolve() / "prod" / "dist"}:/bot:ro"' in compose
        checks += 1

        secret_variants = {
            "steamKey": "a",
            "steam_key": "b",
            "steam-key": "c",
            "X-Token": "d",
            "x_token": "e",
            "authorization": "f",
            "password": "g",
            "token": "h",
        }
        redacted = redact({"nested": secret_variants, "steam_key_present": True, "ok": 1})
        for key in secret_variants:
            assert redacted["nested"][key] == REDACTED
        assert redacted["steam_key_present"] is True
        checks += len(secret_variants) + 1

        planned = plan(cfg)
        assert (cfg.work_dir / MARKER_FILE).exists()
        assert cfg.compose_file.exists()
        assert cfg.launcher_config_file.exists()
        assert planned["bot_bundle_exists"] is True
        assert "super-secret" not in cfg.summary_file.read_text(encoding="utf-8")
        checks += 5

        original_download_map = globals()["download_map"]
        original_docker_compose_base = globals()["docker_compose_base"]
        original_run_command = globals()["run_command"]
        original_launcher_cli = globals()["launcher_cli"]
        original_wait_for_http = globals()["wait_for_http"]
        original_register_user = globals()["register_user"]
        original_upload_code = globals()["upload_code"]
        original_place_spawn = globals()["place_spawn"]
        original_poll_stats = globals()["poll_stats"]
        try:
            calls: list[str] = []

            def fake_download_map(config: HarnessConfig, *, allow_network: bool) -> str:
                config.map_file.write_text("{}", encoding="utf-8")
                return "cached"

            def fake_docker_compose_base() -> list[str]:
                return ["docker", "compose"]

            def fake_run_command(args: list[str], *, cwd: Path, input_text: str | None = None, timeout: int = 120) -> subprocess.CompletedProcess[str]:
                return subprocess.CompletedProcess(args, 0, "ok", "")

            def fake_launcher_cli(config: HarnessConfig, js: str, timeout: int = 120) -> subprocess.CompletedProcess[str]:
                calls.append(js)
                return subprocess.CompletedProcess(["screeps-launcher", "cli"], 7, "", "reset failed")

            globals()["download_map"] = fake_download_map
            globals()["docker_compose_base"] = fake_docker_compose_base
            globals()["run_command"] = fake_run_command
            globals()["launcher_cli"] = fake_launcher_cli
            globals()["wait_for_http"] = lambda config, seconds: {"ok": True}
            globals()["register_user"] = lambda config: (_ for _ in ()).throw(AssertionError("register_user should not run"))
            globals()["upload_code"] = lambda config: (_ for _ in ()).throw(AssertionError("upload_code should not run"))
            globals()["place_spawn"] = lambda config: (_ for _ in ()).throw(AssertionError("place_spawn should not run"))
            globals()["poll_stats"] = lambda config, seconds: (_ for _ in ()).throw(AssertionError("poll_stats should not run"))

            try:
                run_harness(cfg)
                raise AssertionError("run_harness should fail on reset failure")
            except RuntimeError as exc:
                assert "system.resetAllData()" in str(exc)
            failure_summary_text = cfg.summary_file.read_text(encoding="utf-8")
            failure_summary = json.loads(failure_summary_text)
            assert failure_summary["status"] == "failed"
            assert failure_summary["failure"]["phase"] == "system.resetAllData()"
            assert failure_summary["reset_returncode"] == 7
            assert "super-secret" not in failure_summary_text
            assert calls == ["system.resetAllData()"]
            checks += 5
        finally:
            globals()["download_map"] = original_download_map
            globals()["docker_compose_base"] = original_docker_compose_base
            globals()["run_command"] = original_run_command
            globals()["launcher_cli"] = original_launcher_cli
            globals()["wait_for_http"] = original_wait_for_http
            globals()["register_user"] = original_register_user
            globals()["upload_code"] = original_upload_code
            globals()["place_spawn"] = original_place_spawn
            globals()["poll_stats"] = original_poll_stats

        original_docker_compose_base = globals()["docker_compose_base"]
        original_run_command = globals()["run_command"]
        try:
            globals()["docker_compose_base"] = lambda: ["docker", "compose"]
            globals()["run_command"] = lambda args, *, cwd, input_text=None, timeout=120: subprocess.CompletedProcess(args, 23, "", "down failed")
            down_summary = down(cfg)
            assert down_summary["returncode"] == 23
            assert exit_code_for_result("down", down_summary) == 23
            with contextlib.redirect_stdout(io.StringIO()):
                assert main(["down", "--work-dir", str(cfg.work_dir), "--repo-root", str(repo)]) == 23
            checks += 3
        finally:
            globals()["docker_compose_base"] = original_docker_compose_base
            globals()["run_command"] = original_run_command
    return {"self_test": "passed", "checks": checks}


def build_config(args: argparse.Namespace) -> HarnessConfig:
    repo_root = Path(args.repo_root).expanduser().resolve()
    password = args.password or os.environ.get("SCREEPS_PRIVATE_SMOKE_PASSWORD") or secrets.token_urlsafe(24)
    return HarnessConfig(
        work_dir=Path(args.work_dir).expanduser().resolve(),
        repo_root=repo_root,
        http_url=args.http_url.rstrip("/"),
        username=args.username,
        password=password,
        room=args.room,
        spawn_name=args.spawn_name,
        spawn_x=args.spawn_x,
        spawn_y=args.spawn_y,
        map_url=args.map_url,
        map_name=args.map_name,
        observation_seconds=args.observation_seconds,
        poll_interval_seconds=args.poll_interval_seconds,
        steam_key_present=bool(os.environ.get("STEAM_KEY")),
    )


def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--work-dir", default=str(DEFAULT_WORK_DIR))
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--http-url", default=DEFAULT_HTTP_URL)
    parser.add_argument("--username", default=DEFAULT_USERNAME)
    parser.add_argument("--password", default=None, help="local-only password; defaults to SCREEPS_PRIVATE_SMOKE_PASSWORD or generated token")
    parser.add_argument("--room", default=DEFAULT_ROOM)
    parser.add_argument("--spawn-name", default=DEFAULT_SPAWN)
    parser.add_argument("--spawn-x", type=int, default=20)
    parser.add_argument("--spawn-y", type=int, default=20)
    parser.add_argument("--map-url", default=DEFAULT_MAP_URL)
    parser.add_argument("--map-name", default=DEFAULT_MAP_NAME)
    parser.add_argument("--observation-seconds", type=int, default=120)
    parser.add_argument("--poll-interval-seconds", type=int, default=10)


def main(argv: list[str] | None = None) -> int:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--dry-run", action="store_true", help="alias for the plan subcommand")
    sub = root.add_subparsers(dest="command")
    for name in ("plan", "run", "down"):
        add_common(sub.add_parser(name))
    sub.add_parser("self-test")
    args = root.parse_args(argv)
    command = "plan" if args.dry_run and args.command is None else (args.command or "plan")
    if command == "self-test":
        print(json.dumps(self_test(), indent=2, sort_keys=True))
        return 0
    config = build_config(args)
    if command == "plan":
        result = plan(config)
    elif command == "run":
        result = run_harness(config)
    elif command == "down":
        result = down(config)
    else:
        root.error(f"unknown command: {command}")
    print(json.dumps(result, indent=2, sort_keys=True))
    return exit_code_for_result(command, result)


if __name__ == "__main__":
    raise SystemExit(main())
