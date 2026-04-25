#!/usr/bin/env python3
"""Prepare a pinned private-server smoke harness for the Screeps bot."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sys
import tempfile
import textwrap
import unittest
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


DEFAULT_WORKDIR_REL = Path("runtime-artifacts/private-server-smoke")
DEFAULT_WORKDIR_ENV = "SCREEPS_PRIVATE_SMOKE_WORKDIR"
DEFAULT_STEAM_KEY_ENV = "STEAM_KEY"
DEFAULT_MAP_URL = "https://maps.screepspl.us/maps/map-0b6758af.json"
DEFAULT_SERVER_PORT = 21025
DEFAULT_CLI_PORT = 21026
DEFAULT_USERNAME = "smoke"
DEFAULT_PASSWORD = "smoke-local-only"
STEAM_KEY_FILE = "STEAM_KEY"
SCREEPS_VERSION = "4.2.21"
NODE_VERSION = "Erbium"

PINNED_PACKAGES = (
    ("ssri", "8.0.1"),
    ("cacache", "15.3.0"),
    ("passport-steam", "1.0.17"),
    ("minipass-fetch", "2.1.2"),
    ("express-rate-limit", "6.7.0"),
    ("body-parser", "1.20.3"),
    ("path-to-regexp", "0.1.12"),
    ("psl", "1.10.0"),
)

MODS = (
    "screepsmod-auth",
    "screepsmod-admin-utils",
    "screepsmod-mongo",
)


@dataclass(frozen=True)
class PreparePlan:
    repo_root: Path
    workdir: Path
    explicit_workdir: bool
    map_url: str
    map_filename: str
    server_port: int
    cli_port: int
    steam_key_env: str
    username: str
    password: str
    dry_run: bool
    no_download: bool
    force_download: bool
    no_steam_key_file: bool

    @property
    def config_path(self) -> Path:
        return self.workdir / "config.yml"

    @property
    def compose_path(self) -> Path:
        return self.workdir / "docker-compose.yml"

    @property
    def maps_dir(self) -> Path:
        return self.workdir / "maps"

    @property
    def map_path(self) -> Path:
        return self.maps_dir / self.map_filename

    @property
    def steam_key_path(self) -> Path:
        return self.workdir / STEAM_KEY_FILE

    @property
    def container_map_path(self) -> str:
        return f"/screeps/maps/{self.map_filename}"


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def resolve_repo_root(value: str | None) -> Path:
    if value:
        return Path(value).expanduser().resolve()
    return Path(__file__).resolve().parents[1]


def resolve_workdir(repo_root: Path, value: str | None, env: dict[str, str]) -> tuple[Path, bool]:
    if value:
        candidate = Path(value).expanduser()
        explicit = True
    elif env.get(DEFAULT_WORKDIR_ENV):
        candidate = Path(env[DEFAULT_WORKDIR_ENV]).expanduser()
        explicit = True
    else:
        candidate = repo_root / DEFAULT_WORKDIR_REL
        explicit = False

    if not candidate.is_absolute():
        candidate = repo_root / candidate
    return candidate.resolve(strict=False), explicit


def validate_workdir(repo_root: Path, workdir: Path, explicit_workdir: bool) -> None:
    repo_root = repo_root.resolve()
    workdir = workdir.resolve(strict=False)
    runtime_root = (repo_root / "runtime-artifacts").resolve(strict=False)

    if workdir == repo_root:
        raise RuntimeError("refusing to use the repository root as the smoke workdir")

    if is_relative_to(workdir, repo_root) and not is_relative_to(workdir, runtime_root) and not explicit_workdir:
        raise RuntimeError(
            "refusing to write an implicit smoke workdir inside tracked source; "
            "use runtime-artifacts/ or pass --workdir explicitly"
        )


def map_filename_from_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    filename = Path(parsed.path).name
    if not re.fullmatch(r"map-[A-Za-z0-9_-]+\.json", filename):
        raise ValueError(
            f"map URL must end in a map-*.json filename, got {filename!r}"
        )
    return filename


def redact_text(text: str, secrets: Iterable[str | None]) -> str:
    redacted = text
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "<redacted>")
    return redacted


def render_config(container_map_path: str, cli_port: int) -> str:
    lines = [
        f"steamKeyFile: {STEAM_KEY_FILE}",
        f"version: {SCREEPS_VERSION}",
        f"nodeVersion: {NODE_VERSION}",
        "pinnedPackages:",
    ]
    lines.extend(f"  {name}: {version}" for name, version in PINNED_PACKAGES)
    lines.append("mods:")
    lines.extend(f"  - {name}" for name in MODS)
    lines.extend(
        [
            "env:",
            "  backend:",
            "    CLI_HOST: 0.0.0.0",
            "serverConfig:",
            '  welcomeText: "Local Screeps MVP pinned smoke server"',
            "  tickRate: 200",
            "  shardName: shardX",
            f"  mapFile: {container_map_path}",
            "cli:",
            "  host: 127.0.0.1",
            f"  port: {cli_port}",
            '  username: ""',
            '  password: ""',
            "",
        ]
    )
    return "\n".join(lines)


def render_compose(server_port: int, cli_port: int) -> str:
    return (
        textwrap.dedent(
            f"""\
            services:
              screeps:
                image: screepers/screeps-launcher:latest
                volumes:
                  - ./:/screeps
                ports:
                  - "127.0.0.1:{server_port}:21025/tcp"
                  - "127.0.0.1:{cli_port}:21026/tcp"
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
                  test: ["CMD-SHELL", "sh", "-c", "curl --fail --silent http://127.0.0.1:21025/ >/dev/null"]
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
        )
        + "\n"
    )


def write_text(path: Path, content: str, dry_run: bool) -> str:
    if dry_run:
        return f"would write {path}"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return f"wrote {path}"


def write_steam_key_file(path: Path, steam_key: str, dry_run: bool) -> str:
    if dry_run:
        return f"would write local {path.name} secret file"
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(steam_key)
        if not steam_key.endswith("\n"):
            handle.write("\n")
    os.chmod(path, 0o600)
    return f"wrote local {path.name} secret file"


def download_map(plan: PreparePlan) -> str:
    if plan.map_path.exists() and not plan.force_download:
        return f"using cached map {plan.map_path}"
    if plan.no_download:
        return f"skipped map download; expected path is {plan.map_path}"
    if plan.dry_run:
        return f"would download {plan.map_url} to {plan.map_path}"

    plan.maps_dir.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        plan.map_url,
        headers={"User-Agent": "screeps-private-smoke-harness/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = response.read()

    try:
        json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"downloaded map was not valid JSON: {plan.map_url}") from exc

    plan.map_path.write_bytes(payload)
    return f"downloaded map {plan.map_path}"


def build_prepare_summary(plan: PreparePlan, actions: list[str], steam_key_present: bool) -> str:
    steam_status = "present" if steam_key_present else "missing"
    key_file_status = "not written"
    if steam_key_present and not plan.no_steam_key_file:
        key_file_status = f"{STEAM_KEY_FILE} written locally"
    elif plan.no_steam_key_file:
        key_file_status = "skipped by --no-steam-key-file"

    lines = [
        "Screeps private-server smoke harness prepared.",
        f"workdir: {plan.workdir}",
        f"config: {plan.config_path}",
        f"compose: {plan.compose_path}",
        f"map: {plan.map_path}",
        f"server: http://127.0.0.1:{plan.server_port}",
        f"launcher CLI: 127.0.0.1:{plan.cli_port}",
        f"steam key env: {plan.steam_key_env} ({steam_status})",
        f"steam key file: {key_file_status}",
        f"local smoke username default: {plan.username}",
        "local smoke password default: <redacted>",
    ]
    if plan.dry_run:
        lines.append("dry run: no files were written")
    lines.append("")
    lines.append("Actions:")
    lines.extend(f"- {action}" for action in actions)
    lines.append("")
    lines.append("Next commands:")
    lines.append(f"cd {shlex.quote(str(plan.workdir))}")
    lines.append("docker compose up -d")
    lines.append("docker compose exec screeps screeps-launcher cli")
    lines.append(f"utils.importMapFile('{plan.container_map_path}')")
    lines.append("system.resumeSimulation()")
    lines.append("")
    lines.append(
        "Then register the local smoke user after map import, upload prod/dist/main.js, "
        "place Spawn1 in E1S1 at (20,20), and poll /stats plus room objects with secrets redacted."
    )
    return "\n".join(lines)


def prepare(args: argparse.Namespace) -> int:
    repo_root = resolve_repo_root(args.repo_root)
    workdir, explicit_workdir = resolve_workdir(repo_root, args.workdir, os.environ)
    validate_workdir(repo_root, workdir, explicit_workdir)
    map_filename = map_filename_from_url(args.map_url)

    plan = PreparePlan(
        repo_root=repo_root,
        workdir=workdir,
        explicit_workdir=explicit_workdir,
        map_url=args.map_url,
        map_filename=map_filename,
        server_port=args.server_port,
        cli_port=args.cli_port,
        steam_key_env=args.steam_key_env,
        username=args.username,
        password=args.password,
        dry_run=args.dry_run,
        no_download=args.no_download,
        force_download=args.force_download,
        no_steam_key_file=args.no_steam_key_file,
    )

    steam_key = os.environ.get(plan.steam_key_env)
    actions: list[str] = []
    actions.append(write_text(plan.config_path, render_config(plan.container_map_path, plan.cli_port), plan.dry_run))
    actions.append(write_text(plan.compose_path, render_compose(plan.server_port, plan.cli_port), plan.dry_run))
    if steam_key and not plan.no_steam_key_file:
        actions.append(write_steam_key_file(plan.steam_key_path, steam_key, plan.dry_run))
    elif not steam_key:
        actions.append(f"{plan.steam_key_env} is not set; create {plan.steam_key_path} before starting the server")
    actions.append(download_map(plan))

    summary = build_prepare_summary(plan, actions, bool(steam_key))
    print(redact_text(summary, [steam_key, plan.password]))
    return 0


class HarnessSelfTests(unittest.TestCase):
    def test_config_renders_pinned_runtime_without_secret_value(self) -> None:
        config = render_config("/screeps/maps/map-0b6758af.json", 21026)
        self.assertTrue(config.startswith("steamKeyFile: STEAM_KEY\n"))
        self.assertIn("version: 4.2.21", config)
        self.assertIn("nodeVersion: Erbium", config)
        self.assertIn("steamKeyFile: STEAM_KEY", config)
        self.assertIn("\n  body-parser: 1.20.3", config)
        self.assertIn("\n  path-to-regexp: 0.1.12", config)
        self.assertIn("\n  - screepsmod-auth", config)
        self.assertIn("mapFile: /screeps/maps/map-0b6758af.json", config)
        self.assertNotIn("secret-value", config)

    def test_compose_renders_local_ports_and_backing_services(self) -> None:
        compose = render_compose(22025, 22026)
        self.assertIn('"127.0.0.1:22025:21025/tcp"', compose)
        self.assertIn('"127.0.0.1:22026:21026/tcp"', compose)
        self.assertIn("MONGO_HOST: mongo", compose)
        self.assertIn("REDIS_HOST: redis", compose)
        self.assertIn("image: mongo:8", compose)
        self.assertIn("image: redis:7", compose)

    def test_redaction_removes_secrets(self) -> None:
        text = redact_text("key=abc123 password=localpass", ["abc123", "localpass"])
        self.assertEqual(text, "key=<redacted> password=<redacted>")

    def test_map_filename_from_default_url(self) -> None:
        self.assertEqual(map_filename_from_url(DEFAULT_MAP_URL), "map-0b6758af.json")

    def test_map_filename_rejects_unexpected_names(self) -> None:
        with self.assertRaises(ValueError):
            map_filename_from_url("https://example.invalid/not-a-map.txt")

    def test_default_workdir_is_under_runtime_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp).resolve()
            workdir, explicit = resolve_workdir(repo, None, {})
            self.assertFalse(explicit)
            self.assertEqual(workdir, repo / DEFAULT_WORKDIR_REL)
            validate_workdir(repo, workdir, explicit)

    def test_implicit_tracked_source_workdir_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp).resolve()
            bad_workdir = repo / "docs" / "private-smoke"
            with self.assertRaises(RuntimeError):
                validate_workdir(repo, bad_workdir, explicit_workdir=False)
            validate_workdir(repo, bad_workdir, explicit_workdir=True)

    def test_no_download_mode_is_offline_and_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp).resolve()
            plan = PreparePlan(
                repo_root=repo,
                workdir=repo / DEFAULT_WORKDIR_REL,
                explicit_workdir=False,
                map_url=DEFAULT_MAP_URL,
                map_filename="map-0b6758af.json",
                server_port=DEFAULT_SERVER_PORT,
                cli_port=DEFAULT_CLI_PORT,
                steam_key_env=DEFAULT_STEAM_KEY_ENV,
                username=DEFAULT_USERNAME,
                password=DEFAULT_PASSWORD,
                dry_run=False,
                no_download=True,
                force_download=False,
                no_steam_key_file=False,
            )
            result = download_map(plan)
            self.assertIn("skipped map download", result)
            self.assertFalse(plan.map_path.exists())


def self_test(_args: argparse.Namespace) -> int:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(HarnessSelfTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.wasSuccessful():
        print(f"self-test passed: {suite.countTestCases()} tests")
        return 0
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Prepare a pinned Dockerized Screeps private-server smoke harness outside production code.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare_parser = subparsers.add_parser(
        "prepare",
        help="write config.yml/docker-compose.yml and cache the pinned smoke map",
    )
    prepare_parser.add_argument("--repo-root", help="repository root; defaults to this script's parent repo")
    prepare_parser.add_argument(
        "--workdir",
        help=(
            "untracked smoke workdir; defaults to runtime-artifacts/private-server-smoke "
            f"or ${DEFAULT_WORKDIR_ENV}"
        ),
    )
    prepare_parser.add_argument("--steam-key-env", default=DEFAULT_STEAM_KEY_ENV, help="env var holding the Steam key")
    prepare_parser.add_argument("--server-port", type=int, default=DEFAULT_SERVER_PORT, help="host HTTP/game port")
    prepare_parser.add_argument("--cli-port", type=int, default=DEFAULT_CLI_PORT, help="host launcher CLI port")
    prepare_parser.add_argument("--username", default=DEFAULT_USERNAME, help="local-only smoke username default")
    prepare_parser.add_argument("--password", default=DEFAULT_PASSWORD, help="local-only smoke password default")
    prepare_parser.add_argument("--map-url", default=DEFAULT_MAP_URL, help="map-*.json URL to cache under maps/")
    prepare_parser.add_argument("--dry-run", action="store_true", help="print planned files and commands without writing")
    prepare_parser.add_argument("--no-download", action="store_true", help="do not download the map JSON")
    prepare_parser.add_argument("--force-download", action="store_true", help="refresh the cached map JSON if present")
    prepare_parser.add_argument(
        "--no-steam-key-file",
        action="store_true",
        help="do not copy the steam key env value into the local untracked STEAM_KEY file",
    )
    prepare_parser.set_defaults(func=prepare)

    self_test_parser = subparsers.add_parser(
        "self-test",
        help="run deterministic offline tests; does not require Docker or network",
    )
    self_test_parser.set_defaults(func=self_test)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except Exception as exc:  # noqa: BLE001 - top-level CLI should print clean errors
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
