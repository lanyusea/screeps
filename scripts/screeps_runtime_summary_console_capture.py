#!/usr/bin/env python3
"""Persist Screeps runtime telemetry console lines into local artifacts."""

from __future__ import annotations

import argparse
import asyncio
import html
import json
import os
import re
import sys
import tempfile
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, TextIO

import screeps_cli_io as cli_io
import screeps_runtime_kpi_reducer as reducer
import screeps_world_profiles as world_profiles


DEFAULT_OUT_DIR = Path("/root/screeps/runtime-artifacts/runtime-summary-console")
DEFAULT_STATUS_ARTIFACT_NAME = "runtime-summary-console-status.json"
RUNTIME_CPU_SUMMARY_PREFIX = "#cpu-summary "
RUNTIME_TELEMETRY_PREFIXES = (reducer.RUNTIME_SUMMARY_PREFIX, RUNTIME_CPU_SUMMARY_PREFIX)
DEFAULT_API_URL = "https://screeps.com"
DEFAULT_CONSOLE_CHANNELS = ("console",)
DEFAULT_LIVE_TIMEOUT_SECONDS = 20.0
DEFAULT_LIVE_MAX_MESSAGES = 50
DEFAULT_LIVE_OPEN_TIMEOUT_SECONDS = 10.0
OUT_DIR_ENV = "SCREEPS_RUNTIME_SUMMARY_CONSOLE_OUT_DIR"
OUT_FILE_ENV = "SCREEPS_RUNTIME_SUMMARY_CONSOLE_OUT_FILE"
STATUS_FILE_ENV = "SCREEPS_RUNTIME_SUMMARY_CONSOLE_STATUS_FILE"
AUTH_TOKEN_ENV = "SCREEPS_AUTH_TOKEN"
API_URL_ENV = "SCREEPS_API_URL"
CONSOLE_CHANNELS_ENV = "SCREEPS_CONSOLE_CHANNELS"
LIVE_TIMEOUT_ENV = "SCREEPS_CONSOLE_CAPTURE_TIMEOUT_SECONDS"
LIVE_MAX_MESSAGES_ENV = "SCREEPS_CONSOLE_CAPTURE_MAX_MESSAGES"
WORLD_PROFILE_ENV = world_profiles.WORLD_PROFILE_ENV
CHANNEL_SOURCE_CLI = "cli"
CHANNEL_SOURCE_ENV = "env"
CHANNEL_SOURCE_AUTHENTICATED_USER = "authenticated-user"
CHANNEL_SOURCE_FALLBACK_DEFAULT = "fallback-default"
SAFE_ARTIFACT_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
CAPTURE_STATUS_CLEAN_RUNTIME_SUMMARY = "clean_runtime_summary"
CAPTURE_STATUS_CPU_ONLY = "cpu_only"
CAPTURE_STATUS_NO_MESSAGES = "no_messages"
CAPTURE_STATUS_NO_RUNTIME_TELEMETRY = "no_runtime_telemetry"
CAPTURE_STATUS_ERROR = "capture_error"
STATUS_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class PersistResult:
    input_paths: list[str]
    input_line_count: int
    persisted_line_count: int
    runtime_summary_line_count: int
    cpu_summary_line_count: int
    skipped_line_count: int
    output_path: Path | None
    metadata_extra: dict[str, object] | None = None

    @property
    def capture_status(self) -> str:
        return classify_capture_status(self)

    def metadata(self) -> dict[str, object]:
        metadata = {
            "captureOk": self.capture_status == CAPTURE_STATUS_CLEAN_RUNTIME_SUMMARY,
            "captureStatus": self.capture_status,
            "cpuSummaryLineCount": self.cpu_summary_line_count,
            "inputPaths": self.input_paths,
            "inputLineCount": self.input_line_count,
            "persistedLineCount": self.persisted_line_count,
            "runtimeSummaryLineCount": self.runtime_summary_line_count,
            "skippedLineCount": self.skipped_line_count,
            "outputPath": str(self.output_path) if self.output_path is not None else None,
        }
        if self.metadata_extra is not None:
            metadata.update(self.metadata_extra)
        return metadata


@dataclass(frozen=True)
class LiveConsoleContext:
    base_http: str
    token: str
    channels: list[str]
    timeout_seconds: float
    max_messages: int
    channel_metadata: dict[str, object] | None = None

    @property
    def base_ws(self) -> str:
        if self.base_http.startswith("https://"):
            return "wss://" + self.base_http[len("https://") :]
        if self.base_http.startswith("http://"):
            return "ws://" + self.base_http[len("http://") :]
        return self.base_http

    @property
    def websocket_url(self) -> str:
        return self.base_ws.rstrip("/") + "/socket/websocket"


@dataclass(frozen=True)
class LiveConsoleCapture:
    requested_channels: list[str]
    websocket_url: str
    timeout_seconds: float
    max_messages: int
    received_message_count: int
    console_lines: list[str]

    def metadata(self) -> dict[str, object]:
        return {
            "source": "live-official-console",
            "websocketUrl": self.websocket_url,
            "requestedChannels": self.requested_channels,
            "timeoutSeconds": self.timeout_seconds,
            "maxMessages": self.max_messages,
            "receivedMessageCount": self.received_message_count,
        }


def iter_runtime_summary_lines(lines: Iterable[str]) -> Iterable[str]:
    for line in lines:
        normalized = normalize_runtime_summary_line(line)
        if normalized is not None:
            yield normalized


def is_runtime_telemetry_line(line: str) -> bool:
    return any(line.startswith(prefix) for prefix in RUNTIME_TELEMETRY_PREFIXES)


def normalize_runtime_summary_line(line: str) -> str | None:
    if not is_runtime_telemetry_line(line) or "&" in line:
        line = html.unescape(line)
    if not is_runtime_telemetry_line(line):
        return None
    return line.rstrip("\r\n") + "\n"


def count_runtime_summary_lines(lines: Iterable[str]) -> int:
    return sum(1 for line in lines if line.startswith(reducer.RUNTIME_SUMMARY_PREFIX))


def count_cpu_summary_lines(lines: Iterable[str]) -> int:
    return sum(1 for line in lines if line.startswith(RUNTIME_CPU_SUMMARY_PREFIX))


def classify_capture_status(result: PersistResult) -> str:
    if result.runtime_summary_line_count > 0:
        return CAPTURE_STATUS_CLEAN_RUNTIME_SUMMARY
    if result.cpu_summary_line_count > 0:
        return CAPTURE_STATUS_CPU_ONLY
    if result.input_line_count == 0:
        received_message_count = None
        if result.metadata_extra is not None:
            received_message_count = result.metadata_extra.get("receivedMessageCount")
        if isinstance(received_message_count, int) and received_message_count > 0:
            return CAPTURE_STATUS_NO_RUNTIME_TELEMETRY
        return CAPTURE_STATUS_NO_MESSAGES
    return CAPTURE_STATUS_NO_RUNTIME_TELEMETRY


def iter_input_lines(input_paths: list[str], stdin: TextIO = sys.stdin) -> Iterable[str]:
    paths = input_paths or ["-"]
    for path_text in paths:
        if path_text == "-":
            yield from stdin
            continue

        with Path(path_text).expanduser().open("r", encoding="utf-8") as input_file:
            yield from input_file


def split_console_text_lines(text: str) -> list[str]:
    if not text:
        return []
    return text.splitlines(keepends=True) or [text]


def iter_string_values(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
        return
    if isinstance(value, list):
        for item in value:
            yield from iter_string_values(item)
        return
    if isinstance(value, dict):
        for item in value.values():
            yield from iter_string_values(item)


def decode_websocket_text(message: object) -> str | None:
    if isinstance(message, bytes):
        return message.decode("utf-8", errors="replace")
    if isinstance(message, str):
        return message
    return None


def iter_console_text_lines_from_websocket_message(
    message: object,
    requested_channels: list[str],
) -> Iterable[str]:
    text = decode_websocket_text(message)
    if text is None:
        return

    parsed: object | None = None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None

    if (
        isinstance(parsed, list)
        and len(parsed) >= 2
        and isinstance(parsed[0], str)
        and parsed[0] in set(requested_channels)
    ):
        for console_text in iter_string_values(parsed[1]):
            yield from split_console_text_lines(console_text)
        return

    if parsed is None:
        yield from split_console_text_lines(text)


def default_artifact_name(now: datetime | None = None) -> str:
    timestamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return f"runtime-summary-console-{timestamp.strftime('%Y%m%dT%H%M%SZ')}.log"


def validate_artifact_name(name: str) -> str:
    if Path(name).name != name or not name or name in {".", ".."}:
        raise ValueError("--artifact-name must be a file name, not a path")
    if not SAFE_ARTIFACT_NAME_RE.fullmatch(name):
        raise ValueError("--artifact-name may contain only letters, numbers, dot, underscore, and hyphen")
    return name


def iter_artifact_path_candidates(path: Path) -> Iterable[Path]:
    yield path
    for index in range(2, 1000):
        yield path.with_name(f"{path.stem}-{index}{path.suffix}")


def unique_artifact_path(path: Path) -> Path:
    for candidate in iter_artifact_path_candidates(path):
        if not candidate.exists():
            return candidate
    raise FileExistsError(f"could not choose a unique artifact path for {path}")


def resolve_output_path(
    out_dir: Path,
    out_file: Path | None = None,
    artifact_name: str | None = None,
    now: datetime | None = None,
) -> Path:
    if out_file is not None:
        return out_file.expanduser()

    name = validate_artifact_name(artifact_name or default_artifact_name(now))
    return unique_artifact_path(out_dir.expanduser() / name)


def link_artifact_exclusively(temp_path: Path, path: Path) -> Path:
    for candidate in iter_artifact_path_candidates(path):
        try:
            os.link(temp_path, candidate)
            return candidate
        except FileExistsError:
            continue

    raise FileExistsError(f"could not choose a unique artifact path for {path}")


def write_artifact(path: Path, lines: list[str]) -> Path:
    if path.exists():
        raise FileExistsError(f"artifact already exists: {path}")

    path.parent.mkdir(parents=True, exist_ok=True)
    temp_fd: int | None = None
    temp_path: Path | None = None
    try:
        temp_fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        temp_path = Path(temp_name)
        with os.fdopen(temp_fd, "w", encoding="utf-8") as output:
            temp_fd = None
            output.writelines(lines)
            output.flush()
            os.fsync(output.fileno())
        return link_artifact_exclusively(temp_path, path)
    finally:
        if temp_fd is not None:
            os.close(temp_fd)
        try:
            if temp_path is not None:
                temp_path.unlink()
        except OSError:
            pass


def write_json_file_atomically(path: Path, payload: dict[str, object]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_fd: int | None = None
    temp_path: Path | None = None
    try:
        temp_fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        temp_path = Path(temp_name)
        with os.fdopen(temp_fd, "w", encoding="utf-8") as output:
            temp_fd = None
            json.dump(payload, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp_path, path)
        temp_path = None
        return path
    finally:
        if temp_fd is not None:
            os.close(temp_fd)
        try:
            if temp_path is not None:
                temp_path.unlink()
        except OSError:
            pass


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def build_status_payload(
    metadata: dict[str, object],
    *,
    process_status: str,
    exit_code: int,
    status_path: Path | None = None,
    error: str | None = None,
) -> dict[str, object]:
    payload = {
        "type": "screeps-runtime-summary-console-capture-status",
        "schemaVersion": STATUS_SCHEMA_VERSION,
        "createdAt": utc_timestamp(),
        "processStatus": process_status,
        "exitCode": exit_code,
        "finalizationHint": (
            "This status file is written before CLI stdout. If Hermes cron reports Broken pipe "
            "while this file is fresh and processStatus is completed, classify the incident as "
            "outer_cron_finalization instead of inner_capture_failure."
        ),
    }
    payload.update(metadata)
    if status_path is not None:
        payload["statusPath"] = str(status_path)
    if error is not None:
        payload["error"] = error
    return payload


def try_write_status_file(
    status_path: Path | None,
    payload: dict[str, object],
    stderr: TextIO = sys.stderr,
) -> bool:
    if status_path is None:
        return False
    try:
        write_json_file_atomically(status_path, payload)
        return True
    except OSError as exc:
        cli_io.write_text(stderr, f"warning: failed to write status file {status_path}: {exc}\n")
        return False


def persist_runtime_summary_artifact(
    input_paths: list[str],
    out_dir: Path = DEFAULT_OUT_DIR,
    out_file: Path | None = None,
    artifact_name: str | None = None,
    stdin: TextIO = sys.stdin,
    now: datetime | None = None,
    input_lines: Iterable[str] | None = None,
    metadata_extra: dict[str, object] | None = None,
) -> PersistResult:
    paths = input_paths or ["-"]
    input_line_count = 0
    persisted_lines: list[str] = []

    lines = input_lines if input_lines is not None else iter_input_lines(input_paths, stdin=stdin)
    for line in lines:
        input_line_count += 1
        normalized = normalize_runtime_summary_line(line)
        if normalized is not None:
            persisted_lines.append(normalized)

    runtime_summary_line_count = count_runtime_summary_lines(persisted_lines)
    cpu_summary_line_count = count_cpu_summary_lines(persisted_lines)
    skipped_line_count = input_line_count - len(persisted_lines)
    if not persisted_lines:
        return PersistResult(
            input_paths=paths,
            input_line_count=input_line_count,
            persisted_line_count=0,
            runtime_summary_line_count=0,
            cpu_summary_line_count=0,
            skipped_line_count=skipped_line_count,
            output_path=None,
            metadata_extra=metadata_extra,
        )

    output_path = resolve_output_path(out_dir=out_dir, out_file=out_file, artifact_name=artifact_name, now=now)
    output_path = write_artifact(output_path, persisted_lines)

    return PersistResult(
        input_paths=paths,
        input_line_count=input_line_count,
        persisted_line_count=len(persisted_lines),
        runtime_summary_line_count=runtime_summary_line_count,
        cpu_summary_line_count=cpu_summary_line_count,
        skipped_line_count=skipped_line_count,
        output_path=output_path,
        metadata_extra=metadata_extra,
    )


def positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be greater than zero")
    return parsed


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be greater than zero")
    return parsed


def validate_console_channel(channel: str) -> str:
    if not channel or any(character.isspace() for character in channel) or not channel.isprintable():
        raise ValueError("console channel names must be non-empty printable strings without whitespace")
    return channel


def parse_console_channels(value: str | None) -> list[str]:
    raw = value if value is not None and value.strip() else ",".join(DEFAULT_CONSOLE_CHANNELS)
    channels: list[str] = []
    seen: set[str] = set()
    for channel in raw.split(","):
        channel = channel.strip()
        if not channel:
            continue
        channel = validate_console_channel(channel)
        if channel not in seen:
            channels.append(channel)
            seen.add(channel)
    if not channels:
        raise ValueError("at least one console channel is required")
    return channels


def resolve_console_channels(cli_channels: list[str] | None) -> list[str]:
    if cli_channels:
        return parse_console_channels(",".join(cli_channels))
    return parse_console_channels(os.environ.get(CONSOLE_CHANNELS_ENV))


def short_error_text(value: object, limit: int = 180) -> str:
    text = str(value).replace("\n", " ").strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."


def fetch_authenticated_user_id(base_http: str, token: str) -> str:
    request = urllib.request.Request(
        base_http.rstrip("/") + "/api/auth/me",
        headers={
            "X-Token": token,
            "User-Agent": "screeps-runtime-summary-console-capture/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        payload = json.load(response)
    if not isinstance(payload, dict):
        raise RuntimeError("authenticated user response was not a JSON object")
    for key in ("_id", "id", "userId", "user_id"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    raise RuntimeError("authenticated user response did not include a user id")


def default_live_console_channels(base_http: str, token: str) -> tuple[list[str], dict[str, object]]:
    try:
        user_id = fetch_authenticated_user_id(base_http, token)
    except Exception as exc:  # noqa: BLE001 - fallback remains diagnosable in the status sidecar
        return (
            list(DEFAULT_CONSOLE_CHANNELS),
            {
                "channelSource": CHANNEL_SOURCE_FALLBACK_DEFAULT,
                "channelDiscoveryStatus": "unavailable",
                "channelDiscoveryError": sanitize_error_text(short_error_text(exc), [token]),
            },
        )
    return (
        [f"user:{user_id}/console"],
        {
            "channelSource": CHANNEL_SOURCE_AUTHENTICATED_USER,
            "channelDiscoveryStatus": "ok",
        },
    )


def resolve_live_console_channels(
    cli_channels: list[str] | None,
    base_http: str,
    token: str,
) -> tuple[list[str], dict[str, object]]:
    if cli_channels:
        return parse_console_channels(",".join(cli_channels)), {"channelSource": CHANNEL_SOURCE_CLI}
    env_channels = os.environ.get(CONSOLE_CHANNELS_ENV)
    if env_channels is not None and env_channels.strip():
        return parse_console_channels(env_channels), {"channelSource": CHANNEL_SOURCE_ENV}
    return default_live_console_channels(base_http, token)


def live_console_context_from_args(args: argparse.Namespace) -> LiveConsoleContext:
    token = os.environ.get(AUTH_TOKEN_ENV)
    if not token:
        raise RuntimeError(f"{AUTH_TOKEN_ENV} is required for --live-official-console")
    base_http = str(args.api_url).rstrip("/")
    channels, channel_metadata = resolve_live_console_channels(args.console_channel, base_http, token)
    return LiveConsoleContext(
        base_http=base_http,
        token=token,
        channels=channels,
        timeout_seconds=args.live_timeout_seconds,
        max_messages=args.live_max_messages,
        channel_metadata=channel_metadata,
    )


def import_websockets_module() -> Any:
    try:
        import websockets
    except ModuleNotFoundError as exc:
        raise RuntimeError("Python package 'websockets' is required for --live-official-console") from exc
    return websockets


def remaining_timeout(deadline: float) -> float:
    return max(0.001, deadline - asyncio.get_running_loop().time())


async def wait_for_auth_ok(websocket: Any, deadline: float) -> None:
    while asyncio.get_running_loop().time() < deadline:
        try:
            message = await asyncio.wait_for(websocket.recv(), timeout=remaining_timeout(deadline))
        except asyncio.TimeoutError:
            break
        text = decode_websocket_text(message)
        if isinstance(text, str) and text.startswith("auth "):
            if "ok" in text.lower():
                return
            break
    raise RuntimeError("websocket authentication did not complete")


async def collect_live_official_console_lines(
    ctx: LiveConsoleContext,
    websockets_module: Any | None = None,
) -> LiveConsoleCapture:
    websockets_module = websockets_module or import_websockets_module()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + ctx.timeout_seconds
    received_message_count = 0
    console_lines: list[str] = []

    async with websockets_module.connect(
        ctx.websocket_url,
        open_timeout=min(DEFAULT_LIVE_OPEN_TIMEOUT_SECONDS, ctx.timeout_seconds),
    ) as websocket:
        await websocket.send("auth " + ctx.token)
        await wait_for_auth_ok(websocket, deadline)
        for channel in ctx.channels:
            await websocket.send(f"subscribe {channel}")

        while received_message_count < ctx.max_messages and loop.time() < deadline:
            try:
                message = await asyncio.wait_for(websocket.recv(), timeout=remaining_timeout(deadline))
            except asyncio.TimeoutError:
                break
            received_message_count += 1
            console_lines.extend(iter_console_text_lines_from_websocket_message(message, ctx.channels))

    return LiveConsoleCapture(
        requested_channels=ctx.channels,
        websocket_url=ctx.websocket_url,
        timeout_seconds=ctx.timeout_seconds,
        max_messages=ctx.max_messages,
        received_message_count=received_message_count,
        console_lines=console_lines,
    )


def persist_live_official_console_artifact(
    ctx: LiveConsoleContext,
    out_dir: Path = DEFAULT_OUT_DIR,
    out_file: Path | None = None,
    artifact_name: str | None = None,
    websockets_module: Any | None = None,
) -> PersistResult:
    capture = asyncio.run(collect_live_official_console_lines(ctx, websockets_module=websockets_module))
    metadata_extra = capture.metadata()
    if ctx.channel_metadata:
        metadata_extra.update(ctx.channel_metadata)
    return persist_runtime_summary_artifact(
        input_paths=["live-official-console"],
        out_dir=out_dir,
        out_file=out_file,
        artifact_name=artifact_name,
        input_lines=capture.console_lines,
        metadata_extra=metadata_extra,
    )


def render_json(result: PersistResult, status_path: Path | None = None) -> str:
    metadata = result.metadata()
    if status_path is not None:
        metadata["statusPath"] = str(status_path)
    return json.dumps(metadata, indent=2, sort_keys=True)


def render_human(result: PersistResult, status_path: Path | None = None) -> str:
    output = str(result.output_path) if result.output_path is not None else "none"
    rendered = (
        f"status: {result.capture_status}; input lines: {result.input_line_count}; "
        f"persisted: {result.persisted_line_count}; runtime summaries: {result.runtime_summary_line_count}; "
        f"cpu summaries: {result.cpu_summary_line_count}; "
        f"skipped: {result.skipped_line_count}; output: {output}"
    )
    if status_path is not None:
        rendered += f"; status file: {status_path}"
    if result.metadata_extra and "requestedChannels" in result.metadata_extra:
        channels = ",".join(str(channel) for channel in result.metadata_extra["requestedChannels"])
        rendered += f"; requested channels: {channels}"
        rendered += f"; websocket messages: {result.metadata_extra.get('receivedMessageCount', 0)}"
    return rendered


def render_status_line(result: PersistResult, status_path: Path | None = None) -> str:
    output = Path(result.output_path).name if result.output_path is not None else "none"
    status_output = Path(status_path).name if status_path is not None else "none"
    received_messages = 0
    if result.metadata_extra and isinstance(result.metadata_extra.get("receivedMessageCount"), int):
        received_messages = int(result.metadata_extra["receivedMessageCount"])
    return (
        f"CAPTURE_STATUS status={result.capture_status} "
        f"runtime={result.runtime_summary_line_count} cpu={result.cpu_summary_line_count} "
        f"persisted={result.persisted_line_count} input={result.input_line_count} "
        f"messages={received_messages} output={output} status_file={status_output}"
    )


def env_default(name: str, default: str) -> str:
    return os.environ[name] if name in os.environ else default


def apply_world_profile_defaults(args: argparse.Namespace) -> argparse.Namespace:
    profile = world_profiles.resolve_world_profile(getattr(args, "world_profile", None), os.environ)
    args.world_profile = profile.name
    if getattr(args, "out_dir", None) is None:
        args.out_dir = env_default(OUT_DIR_ENV, str(profile.console_capture_out_dir))
    if getattr(args, "out_file", None) is None and OUT_FILE_ENV in os.environ:
        args.out_file = os.environ[OUT_FILE_ENV]
    if getattr(args, "status_file", None) is None and STATUS_FILE_ENV in os.environ:
        args.status_file = os.environ[STATUS_FILE_ENV]
    if getattr(args, "api_url", None) is None:
        args.api_url = env_default(API_URL_ENV, profile.api_url)
    return args


def resolve_status_path(args: argparse.Namespace) -> Path | None:
    if getattr(args, "no_status_file", False):
        return None
    if getattr(args, "status_file", None):
        return Path(args.status_file).expanduser()
    if getattr(args, "live_official_console", False):
        return Path(args.out_dir).expanduser() / DEFAULT_STATUS_ARTIFACT_NAME
    return None


def sanitize_error_text(message: str, secrets: Iterable[str]) -> str:
    sanitized = message
    for secret in secrets:
        if secret:
            sanitized = sanitized.replace(secret, "[redacted]")
    return sanitized


def build_error_metadata(args: argparse.Namespace, error: str) -> dict[str, object]:
    channels: list[str] = []
    try:
        channels = resolve_console_channels(getattr(args, "console_channel", None))
    except ValueError:
        channels = []
    return {
        "captureOk": False,
        "captureStatus": CAPTURE_STATUS_ERROR,
        "cpuSummaryLineCount": 0,
        "inputPaths": ["live-official-console"] if getattr(args, "live_official_console", False) else list(args.inputs),
        "inputLineCount": 0,
        "outputPath": None,
        "persistedLineCount": 0,
        "requestedChannels": channels,
        "runtimeSummaryLineCount": 0,
        "skippedLineCount": 0,
        "source": "live-official-console" if getattr(args, "live_official_console", False) else "input",
        "timeoutSeconds": getattr(args, "live_timeout_seconds", None),
        "maxMessages": getattr(args, "live_max_messages", None),
        "error": error,
    }


class WorldProfileArgumentParser(argparse.ArgumentParser):
    def parse_args(
        self,
        args: list[str] | None = None,
        namespace: argparse.Namespace | None = None,
    ) -> argparse.Namespace:
        parsed = super().parse_args(args, namespace)
        try:
            return apply_world_profile_defaults(parsed)
        except ValueError as exc:
            self.error(str(exc))


def build_parser() -> argparse.ArgumentParser:
    parser = WorldProfileArgumentParser(
        description=(
            "Persist only exact-prefix Screeps #runtime-summary and #cpu-summary console lines "
            "into a local artifact that monitor and KPI tooling can scan."
        ),
    )
    world_profiles.add_world_profile_argument(parser)
    parser.add_argument(
        "inputs",
        nargs="*",
        help="Console log files to scan. Use '-' for stdin. Reads stdin when no inputs are provided.",
    )
    parser.add_argument(
        "--out-dir",
        default=None,
        help=f"Artifact directory. Default: ${OUT_DIR_ENV} or {DEFAULT_OUT_DIR}.",
    )
    parser.add_argument(
        "--out-file",
        default=None,
        help=f"Exact artifact file path. Overrides --out-dir and --artifact-name. May also be set with ${OUT_FILE_ENV}.",
    )
    parser.add_argument(
        "--artifact-name",
        help="Artifact file name to create inside --out-dir. Defaults to a UTC timestamped .log name.",
    )
    parser.add_argument(
        "--format",
        choices=("json", "human", "status-line"),
        default="json",
        help="Output format. JSON is deterministic and is the default.",
    )
    parser.add_argument(
        "--status-file",
        default=None,
        help=(
            "Write a latest-status JSON sidecar at this exact path. "
            f"May also be set with ${STATUS_FILE_ENV}. Live capture defaults to "
            f"--out-dir/{DEFAULT_STATUS_ARTIFACT_NAME}."
        ),
    )
    parser.add_argument(
        "--no-status-file",
        action="store_true",
        help="Disable the live-capture latest-status JSON sidecar.",
    )
    parser.add_argument(
        "--live-official-console",
        action="store_true",
        help=(
            "Capture live official-client console websocket messages instead of stdin/files. "
            f"Requires ${AUTH_TOKEN_ENV}; uses ${API_URL_ENV} for the base URL."
        ),
    )
    parser.add_argument(
        "--api-url",
        default=None,
        help=f"Screeps API base URL for live capture. Default: ${API_URL_ENV} or {DEFAULT_API_URL}.",
    )
    parser.add_argument(
        "--console-channel",
        action="append",
        help=(
            "Console websocket channel to subscribe. May be repeated or comma-separated. "
            f"Default: ${CONSOLE_CHANNELS_ENV}, or the authenticated user's console channel in live mode."
        ),
    )
    parser.add_argument(
        "--live-timeout-seconds",
        type=positive_float,
        default=positive_float(os.environ.get(LIVE_TIMEOUT_ENV, str(DEFAULT_LIVE_TIMEOUT_SECONDS))),
        help=f"Maximum live capture duration. Default: ${LIVE_TIMEOUT_ENV} or {DEFAULT_LIVE_TIMEOUT_SECONDS}.",
    )
    parser.add_argument(
        "--live-max-messages",
        type=positive_int,
        default=positive_int(os.environ.get(LIVE_MAX_MESSAGES_ENV, str(DEFAULT_LIVE_MAX_MESSAGES))),
        help=f"Maximum websocket messages to inspect after subscription. Default: ${LIVE_MAX_MESSAGES_ENV} or {DEFAULT_LIVE_MAX_MESSAGES}.",
    )
    return parser


def main(
    argv: list[str] | None = None,
    stdin: TextIO = sys.stdin,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.live_official_console and args.inputs:
        parser.error("inputs cannot be used with --live-official-console")

    status_path = resolve_status_path(args)
    live_context: LiveConsoleContext | None = None
    try:
        if args.live_official_console:
            live_context = live_console_context_from_args(args)
            result = persist_live_official_console_artifact(
                ctx=live_context,
                out_dir=Path(args.out_dir),
                out_file=Path(args.out_file) if args.out_file else None,
                artifact_name=args.artifact_name,
            )
        else:
            result = persist_runtime_summary_artifact(
                input_paths=args.inputs,
                out_dir=Path(args.out_dir),
                out_file=Path(args.out_file) if args.out_file else None,
                artifact_name=args.artifact_name,
                stdin=stdin,
            )
    except (RuntimeError, ValueError) as exc:
        if args.live_official_console:
            token = os.environ.get(AUTH_TOKEN_ENV, "")
            error_text = sanitize_error_text(str(exc), [token])
            error_metadata = build_error_metadata(args, error_text)
            if live_context is not None:
                error_metadata["requestedChannels"] = live_context.channels
                error_metadata["websocketUrl"] = live_context.websocket_url
                if live_context.channel_metadata:
                    error_metadata.update(live_context.channel_metadata)
            try_write_status_file(
                status_path,
                build_status_payload(
                    error_metadata,
                    process_status="capture_error",
                    exit_code=1,
                    status_path=status_path,
                    error=error_text,
                ),
                stderr=stderr,
            )
            cli_io.write_text(stderr, f"error: {error_text}\n")
            return 1
        raise

    status_metadata = result.metadata()
    try_write_status_file(
        status_path,
        build_status_payload(
            status_metadata,
            process_status="completed",
            exit_code=0,
            status_path=status_path,
        ),
        stderr=stderr,
    )
    if args.format == "human":
        output = render_human(result, status_path=status_path)
    elif args.format == "status-line":
        output = render_status_line(result, status_path=status_path)
    else:
        output = render_json(result, status_path=status_path)
    cli_io.write_text(stdout, output + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
