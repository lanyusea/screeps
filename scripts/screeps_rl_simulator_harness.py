#!/usr/bin/env python3
"""Build a deterministic offline RL simulator-harness manifest."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import math
import os
import re
import secrets
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence, TextIO

import screeps_rl_dataset_export as dataset_export


def _load_runtime_monitor_module():
    """Load the sibling screeps-runtime-monitor.py module if the dashed package is unavailable."""
    module_path = Path(__file__).with_name("screeps-runtime-monitor.py")
    if not module_path.exists():
        raise RuntimeError(f"missing runtime monitor module: {module_path}")
    spec = importlib.util.spec_from_file_location("screeps_runtime_monitor", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load runtime monitor module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["screeps_runtime_monitor"] = module
    spec.loader.exec_module(module)
    return module


try:
    import screeps_runtime_monitor as runtime_monitor
except ModuleNotFoundError:
    runtime_monitor = _load_runtime_monitor_module()


SCHEMA_VERSION = 1
MANIFEST_TYPE = "screeps-rl-simulator-harness-manifest"
SUMMARY_TYPE = "screeps-rl-simulator-harness-generation"
RUN_SUMMARY_TYPE = "screeps-rl-simulator-run"
DEFAULT_OUT_DIR = Path("runtime-artifacts/rl-simulator-harness")
DEFAULT_RUN_OUT_DIR = Path("runtime-artifacts/rl-simulator")
DEFAULT_SEED = "screeps-rl-simulator-harness-v1"
DEFAULT_WORKERS = 4
DEFAULT_ROOMS_PER_WORKER = 4
DEFAULT_TARGET_SPEEDUP = 100.0
DEFAULT_OFFICIAL_TICK_SECONDS = 3.0
DEFAULT_RUN_TICKS = 100
DEFAULT_RUN_WORKERS = 2
RUN_CONTAINER_DOWN_TIMEOUT_SECONDS = 120
RUN_CONTAINER_UP_TIMEOUT_SECONDS = 900
RUN_CONTAINER_RESTART_TIMEOUT_SECONDS = 240
RUN_PHASE_TIMEOUT_SECONDS = 240
RUN_API_TIMEOUT_SECONDS = 25
DEFAULT_SIM_ROOM = "E26S49"
DEFAULT_SIM_SHARD = "shardX"
DEFAULT_SPAWN_X = 20
DEFAULT_SPAWN_Y = 20
DEFAULT_ACTIVE_WORLD_BRANCH = "activeWorld"
HARNESS_VERSION = "1.0.0"
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CODE_PATH = REPO_ROOT / "prod" / "dist" / "main.js"
DEFAULT_MAP_SOURCE_FILE = Path("/root/screeps/maps/map-0b6758af.json")
DEFAULT_STRATEGY_REGISTRY_PATH = REPO_ROOT / "prod" / "src" / "strategy" / "strategyRegistry.ts"
RUN_HTTP_START = 21025
RUN_CLI_START = 21026
RUN_HTTP_PORT_STEP = 2
RUN_TICK_TIMEOUT_SECONDS = 300
RUN_TICK_POLL_SECONDS = 0.20
RUN_WORKER_PREFIX = "rl-sim-worker"
RUN_ID_PREFIX = "rl-sim-run"
RUN_ID_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]+$")

JsonObject = dict[str, Any]
_smoke_module = None


def parse_variants_csv(raw: str) -> list[str]:
    """Parse a comma-separated variant list from CLI input."""
    variants: list[str] = []
    for token in raw.split(","):
        trimmed = token.strip()
        if not trimmed:
            continue
        if trimmed not in variants:
            variants.append(trimmed)
    return variants


def discover_strategy_variants(path: Path = DEFAULT_STRATEGY_REGISTRY_PATH) -> list[str]:
    """Return variant ids from the strategy registry TypeScript source."""
    if not path.exists():
        raise RuntimeError(f"strategy registry file not found: {path}")
    text = path.read_text(encoding="utf-8")
    pattern = re.compile(r"^\s*id:\s*['\"](?P<variant>[^'\"]+)['\"]", re.MULTILINE)
    variants: list[str] = []
    for match in pattern.finditer(text):
        variant_id = match.group("variant").strip()
        if variant_id and variant_id not in variants:
            variants.append(variant_id)
    if not variants:
        raise RuntimeError(f"no strategy variants found in registry: {path}")
    return variants


def normalize_variants(
    requested: Sequence[str] | None,
    available: Sequence[str],
) -> list[str]:
    """Combine `--variants` inputs with a default of all available registry entries."""
    if not requested:
        return list(available)
    selected: list[str] = []
    for raw in requested:
        for variant in parse_variants_csv(raw):
            if variant and variant not in selected:
                selected.append(variant)
    missing = sorted(set(selected) - set(available))
    if missing:
        raise RuntimeError(f"unknown strategy variants: {', '.join(missing)}")
    return selected


def _safe_text(value: Any, max_len: int = 320) -> str:
    text = dataset_export.redact_text(str(value))
    return text[:max_len]


def _safe_filename(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", value)
    safe = re.sub(r"-+", "-", safe).strip("-.")
    return safe or "variant"


def validate_run_id_token(value: str) -> str:
    if (
        not value
        or value in {".", ".."}
        or ".." in value
        or "/" in value
        or "\\" in value
        or not RUN_ID_TOKEN_RE.fullmatch(value)
    ):
        raise ValueError("run_id must use only letters, numbers, dashes, and underscores with no path separators or '..'")
    return value


def parse_run_id_token(value: str) -> str:
    try:
        return validate_run_id_token(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def _coerce_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _build_run_ports(worker_index: int) -> tuple[int, int]:
    http_port = RUN_HTTP_START + (worker_index * RUN_HTTP_PORT_STEP)
    cli_port = RUN_CLI_START + (worker_index * RUN_HTTP_PORT_STEP)
    if http_port > 65535:
        raise RuntimeError(f"worker HTTP port out of range: {http_port}")
    if cli_port > 65535:
        raise RuntimeError(f"worker CLI port out of range: {cli_port}")
    if http_port == cli_port:
        raise RuntimeError(f"worker HTTP and CLI ports must differ: {http_port}")
    return http_port, cli_port


def _extract_int(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _extract_room_payload(data: Any, room: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        return {}
    if data.get("room") == room and isinstance(data.get("details"), dict):
        nested = data["details"]
        return nested if isinstance(nested, dict) else {}
    if data.get("roomName") == room and isinstance(data.get("room"), dict):
        nested = data["room"]
        return nested if isinstance(nested, dict) else {}
    if data.get("room") == room and isinstance(data.get("roomData"), dict):
        return data["roomData"]
    if data.get("room") == room and isinstance(data.get("data"), dict):
        return data["data"]
    direct = data.get(room)
    return direct if isinstance(direct, dict) else data


def _collect_structure_counts(payload: dict[str, Any] | list[Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    objects: list[Any] = []
    if isinstance(payload, list):
        objects = payload
    elif isinstance(payload, dict):
        raw_objects = payload.get("objects")
        if isinstance(raw_objects, list):
            objects = raw_objects
        for key in ("structures", "structuresByType", "objectsByType"):
            section = payload.get(key)
            if isinstance(section, dict):
                for kind, value in section.items():
                    if isinstance(value, list):
                        counts[str(kind)] = len(value)
        for key in ("constructionSites", "construction_sites"):
            sites = payload.get(key)
            if isinstance(sites, list):
                counts["constructionSite"] = len(sites)

    for item in objects:
        if not isinstance(item, dict):
            continue
        object_type = item.get("type")
        if isinstance(object_type, str):
            counts[object_type] = counts.get(object_type, 0) + 1
    return counts


def _summarize_room_state(payload: dict[str, Any], room: str) -> JsonObject:
    normalized = _extract_room_payload(payload, room)
    controller = normalized.get("controller")
    controller_summary: JsonObject = {}
    if isinstance(controller, dict):
        level = _extract_int(controller.get("level"))
        progress = _extract_int(controller.get("progress"))
        progress_total = _extract_int(controller.get("progressTotal"))
        controller_summary = {
            "level": level,
            "progress": progress,
            "progressTotal": progress_total,
        }
    energy = _extract_int(normalized.get("energy"))
    if energy is None:
        energy = _extract_int(normalized.get("energyAvailable"))
    if energy is None:
        resources = normalized.get("resources")
        if isinstance(resources, dict):
            energy = _extract_int(resources.get("storedEnergy"))
    structures = _collect_structure_counts(normalized)
    creeps = _extract_int(normalized.get("creeps"))
    if creeps is None:
        creeps = _collect_structure_counts(normalized).get("creep")
    if creeps is None:
        creeps = 0
    if creeps is not None and not isinstance(creeps, int):
        creeps = 0
    return {
        "room": room,
        "controller": controller_summary if controller_summary else None,
        "energy": energy,
        "creeps": creeps,
        "structures": dict(sorted(structures.items())) if structures else {},
    }


def _terrain_summary(payload: Any) -> JsonObject:
    if not isinstance(payload, dict):
        return {"bytes": 0}
    terrain_payload = payload.get("terrain")
    terrain_text: str | None = None
    if isinstance(terrain_payload, list):
        first = terrain_payload[0] if terrain_payload else None
        if isinstance(first, dict):
            terrain_text = first.get("terrain")
        elif isinstance(first, str):
            terrain_text = first
    elif isinstance(terrain_payload, str):
        terrain_text = terrain_payload
    if not isinstance(terrain_text, str):
        return {"bytes": 0}
    return {
        "bytes": len(terrain_text),
        "sha256": hashlib.sha256(terrain_text.encode("utf-8")).hexdigest(),
    }


def build_scenario_config(
    run_id: str,
    variant_id: str,
    *,
    room: str,
    shard: str,
    branch: str,
    ticks: int,
    code_path: Path,
    map_source_file: Path,
) -> JsonObject:
    """Build a deterministic scenario config contract for one variant run."""
    code_data = code_path.read_bytes()
    map_data = map_source_file.read_bytes()
    return {
        "type": "screeps-rl-sim-run-scenario",
        "runId": run_id,
        "variantId": variant_id,
        "activeWorldBranch": branch,
        "room": room,
        "shard": shard,
        "tickPlan": {
            "ticks": ticks,
        },
        "spawn": {
            "name": "Spawn1",
            "x": DEFAULT_SPAWN_X,
            "y": DEFAULT_SPAWN_Y,
        },
        "codeArtifact": {
            "path": str(code_path),
            "bytes": len(code_data),
            "sha256": hashlib.sha256(code_data).hexdigest(),
        },
        "mapArtifact": {
            "sourcePath": str(map_source_file),
            "sha256": hashlib.sha256(map_data).hexdigest(),
            "bytes": len(map_data),
        },
    }


def build_run_artifact(
    run_id: str,
    *,
    ticks: int,
    workers: int,
    variant_results: Sequence[JsonObject],
    branch: str,
    wall_clock_seconds: float | None = None,
) -> JsonObject:
    """Build the public run-mode artifact payload."""
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    wall_clock = [item.get("wall_clock_seconds", 0.0) for item in variant_results]
    elapsed_wall_clock = wall_clock_seconds if wall_clock_seconds is not None else max(wall_clock, default=0.0)
    if elapsed_wall_clock < 0:
        elapsed_wall_clock = 0.0
    ticks_total = sum(item.get("ticks_run", 0) for item in variant_results)
    return {
        "type": RUN_SUMMARY_TYPE,
        "harnessVersion": HARNESS_VERSION,
        "harness_version": HARNESS_VERSION,
        "runId": run_id,
        "timestamp": timestamp,
        "live_effect": False,
        "official_mmo_writes": False,
        "official_mmo_writes_allowed": False,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "branch": branch,
        "ticksRequested": ticks,
        "workerCount": workers,
        "wallClockSeconds": round(elapsed_wall_clock, 3),
        "wallClockSummary": {
            "minSeconds": round(min(wall_clock), 3) if wall_clock else 0.0,
            "maxSeconds": round(max(wall_clock), 3) if wall_clock else 0.0,
            "totalTickRuns": ticks_total,
        },
        "safety": safety_metadata(),
        "variants": variant_results,
    }


def validate_run_artifact(artifact: JsonObject) -> bool:
    """Validate top-level run artifact structure and required safety flags."""
    if not isinstance(artifact, dict):
        raise ValueError("run artifact must be an object")
    if artifact.get("type") != RUN_SUMMARY_TYPE:
        raise ValueError(f"run artifact type must be {RUN_SUMMARY_TYPE!r}")
    run_id = artifact.get("runId")
    if not isinstance(run_id, str) or not run_id:
        raise ValueError("run artifact must include runId")
    if not isinstance(artifact.get("harness_version"), str):
        raise ValueError("run artifact must include harness_version")
    if not artifact.get("live_effect") is False:
        raise ValueError("run artifact must set live_effect=false")
    if not artifact.get("official_mmo_writes") is False:
        raise ValueError("run artifact must set official_mmo_writes=false")
    if not artifact.get("official_mmo_writes_allowed") is False:
        raise ValueError("run artifact must set official_mmo_writes_allowed=false")
    if not isinstance(artifact.get("safety"), dict):
        raise ValueError("run artifact must include safety metadata")
    if not isinstance(artifact.get("variants"), list):
        raise ValueError("run artifact must include variants list")
    for index, variant in enumerate(artifact["variants"]):
        if not isinstance(variant, dict):
            raise ValueError(f"variant record {index} must be an object")
        if not isinstance(variant.get("variant_id"), str):
            raise ValueError(f"variant record {index} missing variant_id")
        if not isinstance(variant.get("ticks_run"), int) or variant["ticks_run"] < 0:
            raise ValueError(f"variant record {index} has invalid ticks_run")
        if not isinstance(variant.get("wall_clock_seconds"), (int, float)):
            raise ValueError(f"variant record {index} has invalid wall_clock_seconds")
        tick_log = variant.get("tick_log")
        if not isinstance(tick_log, list):
            raise ValueError(f"variant record {index} missing tick_log")
        for tick_entry in tick_log:
            if not isinstance(tick_entry, dict):
                raise ValueError(f"variant {variant['variant_id']} has non-object tick_log entry")
            if not isinstance(tick_entry.get("tick"), int):
                raise ValueError(f"variant {variant['variant_id']} tick entry missing tick")
    return True


def _load_private_smoke_module():
    global _smoke_module
    if _smoke_module is not None:
        return _smoke_module

    module_path = Path(__file__).with_name("screeps-private-smoke.py")
    spec = importlib.util.spec_from_file_location("screeps_private_smoke", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load screeps-private-smoke.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _smoke_module = module
    return module


def _require_launcher_cli_success(smoke: Any, compose: list[str], cfg: Any, expression: str, phase: str) -> JsonObject:
    result = smoke.run_launcher_cli(compose, cfg, expression)
    if not isinstance(result, dict):
        raise RuntimeError(f"{phase} failed: launcher CLI returned non-object result")
    if not result.get("ok"):
        raise RuntimeError(f"{phase} failed: {_safe_redact_smoke_payload(result)}")
    return result


def _worker_output_dir(out_root: Path, run_id: str, worker_index: int) -> Path:
    safe_run_id = _safe_filename(run_id)
    return out_root / safe_run_id / "workers" / f"{RUN_WORKER_PREFIX}-{safe_run_id}-{worker_index:02d}"


def _build_tick_entry(
    shard: str,
    room: str,
    tick: int | None,
    overview: Any,
    terrain: Any,
    room_overviews: Any,
) -> JsonObject:
    overview_payload: JsonObject = {"roomCount": 0, "rooms": []}
    if isinstance(overview, dict):
        shards = overview.get("shards")
        if isinstance(shards, dict):
            selected = shards.get(shard)
            if isinstance(selected, dict):
                overview_payload = {
                    "rooms": selected.get("rooms") or [],
                    "roomCount": len(selected.get("rooms") or []),
                    "gametime": selected.get("gametime"),
                    "gametimes": selected.get("gametimes"),
                }
    room_names = _visible_room_names(overview, shard, room)
    room_payloads = _room_overview_payloads(room_overviews, room_names, room)
    room_summaries = {
        room_name: _summarize_room_state(room_payloads.get(room_name, {}), room_name)
        for room_name in room_names
    }
    return {
        "tick": tick if isinstance(tick, int) else None,
        "shard": shard,
        "room": room,
        "rooms": room_summaries,
        "overview": overview_payload,
        "terrain": _terrain_summary(terrain),
    }


def _visible_room_names(overview: Any, shard: str, anchor_room: str) -> list[str]:
    ordered: list[str] = []
    for room_name in runtime_monitor.overview_rooms(overview, shard):
        if room_name not in ordered:
            ordered.append(room_name)
    if anchor_room not in ordered:
        ordered.insert(0, anchor_room)
    return ordered


def _room_overview_payloads(room_overviews: Any, room_names: Sequence[str], anchor_room: str) -> dict[str, Any]:
    if not isinstance(room_overviews, dict):
        return {}
    if any(isinstance(room_overviews.get(room_name), dict) for room_name in room_names):
        return {
            room_name: payload
            for room_name, payload in room_overviews.items()
            if isinstance(room_name, str) and isinstance(payload, dict)
        }
    return {anchor_room: room_overviews}


def _wait_for_http_with_smoke(cfg: Any, smoke: Any, timeout_seconds: int = RUN_PHASE_TIMEOUT_SECONDS) -> None:
    smoke.wait_for_http(cfg, timeout=timeout_seconds)


def _read_gametime_from_overview(payload: Any, shard: str) -> int | None:
    gametime = runtime_monitor.gametime_from_overview(payload, shard)
    if isinstance(gametime, str):
        return _coerce_int(gametime)
    if isinstance(gametime, int):
        return gametime
    return None


def _safe_redact_smoke_payload(payload: Any) -> JsonObject:
    return {"ok": True, "payload": dataset_export.redact_text(json.dumps(payload, sort_keys=True, ensure_ascii=True))[:2000]}


def _fetch_room_overviews(
    cfg: Any,
    smoke: Any,
    token: str,
    rooms: Sequence[str],
    shard: str,
) -> tuple[str, dict[str, Any]]:
    payloads: dict[str, Any] = {}
    for room_name in rooms:
        room_overview = smoke.http_json(
            "GET",
            cfg.server_url,
            "/api/game/room-overview",
            params={"room": room_name, "shard": shard},
            headers=smoke.token_headers(token),
            timeout=RUN_API_TIMEOUT_SECONDS,
        )
        token = smoke.update_token_from_headers(token, room_overview.headers)
        if isinstance(room_overview.payload, dict) and not smoke.api_dict_succeeded(room_overview):
            raise RuntimeError(
                f"/api/game/room-overview returned unusable payload for {room_name}: "
                f"{_safe_redact_smoke_payload(room_overview.payload)}"
            )
        payloads[room_name] = room_overview.payload
    return token, payloads


def _run_one_tick(
    cfg: Any,
    smoke: Any,
    token: str,
    room: str,
    shard: str,
    previous_tick: int | None,
    timeout_seconds: float,
) -> tuple[str, int | None, JsonObject]:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        overview_result = smoke.http_json("GET", cfg.server_url, "/api/user/overview", headers=smoke.token_headers(token), timeout=RUN_API_TIMEOUT_SECONDS)
        token = smoke.update_token_from_headers(token, overview_result.headers)
        terrain_result = smoke.http_json(
            "GET",
            cfg.server_url,
            "/api/game/room-terrain",
            params={"room": room, "shard": shard, "encoded": "1"},
            headers=smoke.token_headers(token),
            timeout=RUN_API_TIMEOUT_SECONDS,
        )
        token = smoke.update_token_from_headers(token, terrain_result.headers)
        current_tick = _read_gametime_from_overview(overview_result.payload, shard)
        if isinstance(overview_result.payload, dict) and not smoke.api_dict_succeeded(overview_result):
            raise RuntimeError(f"/api/user/overview returned unusable payload: {_safe_redact_smoke_payload(overview_result.payload)}")
        if current_tick is None:
            time.sleep(RUN_TICK_POLL_SECONDS)
            continue
        if previous_tick is None or current_tick > previous_tick:
            visible_rooms = _visible_room_names(overview_result.payload, shard, room)
            token, room_overviews = _fetch_room_overviews(cfg, smoke, token, visible_rooms, shard)
            tick_entry = _build_tick_entry(
                shard,
                room,
                current_tick,
                overview_result.payload,
                terrain_result.payload,
                room_overviews,
            )
            return token, current_tick, tick_entry
        time.sleep(RUN_TICK_POLL_SECONDS)
    raise RuntimeError(f"timed out waiting for tick progression after {timeout_seconds}s")


def _run_variant(
    worker_index: int,
    variant_id: str,
    *,
    run_id: str,
    ticks: int,
    room: str,
    shard: str,
    branch: str,
    code_path: Path,
    map_source_file: Path,
    out_dir: Path,
) -> JsonObject:
    smoke = _load_private_smoke_module()
    variant_slug = _safe_filename(variant_id)
    worker_run_id = f"{run_id}-{variant_slug}"
    safe_run_root = _worker_output_dir(out_dir, run_id, worker_index)
    server_host = "127.0.0.1"
    http_port, cli_port = _build_run_ports(worker_index)
    compose_project = f"{RUN_WORKER_PREFIX}-{_safe_filename(run_id)}-{worker_index:02d}"
    password = secrets.token_urlsafe(20)
    cfg = smoke.SmokeConfig(
        work_dir=safe_run_root,
        server_host=server_host,
        http_port=http_port,
        cli_port=cli_port,
        server_url=f"http://{server_host}:{http_port}",
        username=f"rl-sim-{variant_slug}",
        email=f"{variant_slug}@sim.local",
        password=password,
        room=room,
        shard=shard,
        spawn_name="Spawn1",
        spawn_x=DEFAULT_SPAWN_X,
        spawn_y=DEFAULT_SPAWN_Y,
        branch=branch,
        code_path=code_path,
        map_url="",
        map_source_file=map_source_file,
        stats_timeout=30,
        poll_interval=1,
        min_creeps=1,
        reset_data=True,
        dry_run=False,
        compose_project=compose_project,
        mongo_db="screeps",
    )
    errors: list[str] = []
    start = time.time()
    token: str | None = None
    variant_ticks: list[JsonObject] = []
    compose = None
    try:
        for error in smoke.required_env_errors(cfg):
            raise RuntimeError(error)
        smoke.assert_safe_work_dir(cfg.work_dir)
        if not code_path.is_file():
            raise RuntimeError(f"code path is not a file: {code_path}")
        if not map_source_file.is_file():
            raise RuntimeError(f"map source file is not a file: {map_source_file}")
        preflight = smoke.preflight_host_ports(cfg)
        if preflight.get("checks") and not preflight["checks"]:
            raise RuntimeError("port preflight returned empty checks")
        compose = smoke.find_compose_command()
        smoke.prepare_work_dir(cfg)
        smoke.prepare_map(cfg)

        # Reset server-owned state by removing any leftover stack and volumes first.
        smoke.run_command([*compose, "down", "-v"], cfg, timeout=RUN_CONTAINER_DOWN_TIMEOUT_SECONDS)
        smoke.run_command([*compose, "up", "-d"], cfg, timeout=RUN_CONTAINER_UP_TIMEOUT_SECONDS)
        _wait_for_http_with_smoke(cfg, smoke, timeout_seconds=RUN_CONTAINER_UP_TIMEOUT_SECONDS)
        _require_launcher_cli_success(smoke, compose, cfg, "system.resetAllData()", "reset simulator data")
        _require_launcher_cli_success(
            smoke,
            compose,
            cfg,
            "utils.importMapFile('/screeps/maps/map-0b6758af.json')",
            "import simulator map",
        )
        smoke.run_command([*compose, "restart", "screeps"], cfg, timeout=RUN_CONTAINER_RESTART_TIMEOUT_SECONDS)
        _wait_for_http_with_smoke(cfg, smoke, timeout_seconds=RUN_CONTAINER_UP_TIMEOUT_SECONDS)
        _require_launcher_cli_success(smoke, compose, cfg, "system.resumeSimulation()", "resume simulator")

        register = smoke.http_json(
            "POST",
            cfg.server_url,
            "/api/register/submit",
            smoke.build_register_payload(cfg),
            timeout=RUN_PHASE_TIMEOUT_SECONDS,
        )
        if not smoke.api_dict_succeeded(register):
            raise RuntimeError(f"register failed: {_safe_redact_smoke_payload(register.payload)}")
        signin = smoke.http_json(
            "POST",
            cfg.server_url,
            "/api/auth/signin",
            smoke.build_signin_payload(cfg),
            timeout=RUN_PHASE_TIMEOUT_SECONDS,
        )
        if signin.status != 200:
            raise RuntimeError("signin response was not successful")
        if not isinstance(signin.payload, dict):
            raise RuntimeError("signin response payload was not JSON")
        token = signin.payload.get("token")
        if not isinstance(token, str) or not token:
            raise RuntimeError("signin response did not include an auth token")

        code_text = code_path.read_text(encoding="utf-8")
        upload_payload = smoke.build_code_payload(cfg, code_text)
        upload_payload["branch"] = branch
        upload = smoke.http_json(
            "POST",
            cfg.server_url,
            "/api/user/code",
            upload_payload,
            headers=smoke.token_headers(token),
            timeout=RUN_PHASE_TIMEOUT_SECONDS,
        )
        token = smoke.update_token_from_headers(token, upload.headers)
        if not smoke.upload_code_succeeded(upload):
            raise RuntimeError("code upload failed")

        place = smoke.http_json(
            "POST",
            cfg.server_url,
            "/api/game/place-spawn",
            smoke.build_spawn_payload(cfg),
            headers=smoke.token_headers(token),
            timeout=RUN_PHASE_TIMEOUT_SECONDS,
        )
        if not isinstance(place.payload, dict) or not (place.payload.get("ok") == 1):
            place_payload = _safe_redact_smoke_payload(place.payload)
            if "already playing" not in str(place.payload.get("error", "")).lower():
                raise RuntimeError(f"place-spawn API rejected with unexpected payload: {place_payload}")

        initial_state = smoke.http_json(
            "GET",
            cfg.server_url,
            "/api/user/overview",
            headers=smoke.token_headers(token),
            timeout=RUN_PHASE_TIMEOUT_SECONDS,
        )
        token = smoke.update_token_from_headers(token, initial_state.headers)
        previous_tick = _read_gametime_from_overview(initial_state.payload, shard)

        for _ in range(ticks):
            token, observed_tick, tick_entry = _run_one_tick(
                cfg,
                smoke,
                token,
                room,
                shard,
                previous_tick,
                timeout_seconds=RUN_TICK_TIMEOUT_SECONDS,
            )
            previous_tick = observed_tick if observed_tick is not None else previous_tick
            variant_ticks.append(tick_entry)
    except Exception as exc:  # noqa: BLE001 - collect the failure into a safe result
        errors.append(_safe_text(exc, 480))
    finally:
        if compose is not None:
            smoke.run_command([*compose, "down", "-v"], cfg, timeout=RUN_CONTAINER_DOWN_TIMEOUT_SECONDS)

    wall_seconds = round(time.time() - start, 3)
    if wall_seconds <= 0:
        wall_seconds = 0.0
    ticks_run = len(variant_ticks)
    ticks_per_second = round(ticks_run / wall_seconds, 6) if wall_seconds > 0 else 0.0
    return {
        "variant_id": variant_id,
        "variant_run_id": worker_run_id,
        "worker_id": worker_index,
        "scenario": build_scenario_config(
            worker_run_id,
            variant_id,
            room=room,
            shard=shard,
            branch=branch,
            ticks=ticks,
            code_path=code_path,
            map_source_file=map_source_file,
        ),
        "ticks_requested": ticks,
        "ticks_run": ticks_run,
        "wall_clock_seconds": wall_seconds,
        "ticks_per_second": ticks_per_second,
        "tick_log": variant_ticks,
        "live_effect": False,
        "official_mmo_writes": False,
        "ok": len(errors) == 0,
        "error": errors[0] if errors else None,
        "serverHost": cfg.server_host,
        "serverPorts": {"http": http_port, "cli": cli_port},
        "branch": branch,
    }


def _run_worker_assignments(
    variants: Sequence[str],
    workers: int,
) -> list[list[int]]:
    if workers <= 0:
        return []
    buckets = [[] for _ in range(min(len(variants), workers))]
    for index, variant_index in enumerate(range(len(variants))):
        buckets[index % len(buckets)].append(variant_index)
    return buckets


def run_variants(
    *,
    variants: Sequence[str],
    ticks: int,
    workers: int,
    room: str,
    shard: str,
    branch: str,
    code_path: Path,
    map_source_file: Path,
    out_dir: Path,
    run_id: str,
) -> tuple[JsonObject, list[JsonObject]]:
    if ticks <= 0:
        raise ValueError("ticks must be a positive integer")
    if workers <= 0:
        raise ValueError("workers must be a positive integer")

    start = time.monotonic()
    normalized_workers = max(1, min(workers, len(variants)))
    buckets = _run_worker_assignments(variants, normalized_workers)
    worker_variants: list[list[str]] = [[variants[index] for index in bucket] for bucket in buckets]

    def worker_loop(worker_id: int, assigned_variants: list[str]) -> list[JsonObject]:
        results: list[JsonObject] = []
        for variant_id in assigned_variants:
            results.append(
                _run_variant(
                    worker_index=worker_id,
                    variant_id=variant_id,
                    run_id=run_id,
                    ticks=ticks,
                    room=room,
                    shard=shard,
                    branch=branch,
                    code_path=code_path,
                    map_source_file=map_source_file,
                    out_dir=out_dir,
                )
            )
        return results

    result_map: dict[str, JsonObject] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=normalized_workers) as executor:
        futures = {}
        for worker_id, assigned in enumerate(worker_variants):
            if not assigned:
                continue
            futures[executor.submit(worker_loop, worker_id, assigned)] = assigned
        for future in concurrent.futures.as_completed(futures):
            assigned = futures[future]
            worker_results = future.result()
            for item in worker_results:
                result_map[item["variant_id"]] = item
    ordered = [result_map[variant] for variant in variants if variant in result_map]
    artifact = build_run_artifact(
        run_id,
        ticks=ticks,
        workers=normalized_workers,
        variant_results=ordered,
        branch=branch,
        wall_clock_seconds=time.monotonic() - start,
    )
    return artifact, ordered


@dataclass(frozen=True)
class ThroughputSample:
    worker_id: str
    room_ticks: int
    wall_seconds: float
    failure_count: int = 0


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def positive_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number") from error
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than 0")
    return parsed


def non_negative_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number") from error
    if not math.isfinite(parsed) or parsed < 0:
        raise argparse.ArgumentTypeError("must be at least 0")
    return parsed


def parse_throughput_sample(value: str) -> ThroughputSample:
    """Parse worker_id:room_ticks:wall_seconds[:failure_count]."""
    parts = value.split(":")
    if len(parts) not in {3, 4}:
        raise argparse.ArgumentTypeError(
            "throughput sample must be worker_id:room_ticks:wall_seconds[:failure_count]"
        )
    worker_id = parts[0].strip()
    if not worker_id:
        raise argparse.ArgumentTypeError("throughput sample worker_id may not be empty")
    try:
        room_ticks = int(parts[1])
        wall_seconds = float(parts[2])
        failure_count = int(parts[3]) if len(parts) == 4 else 0
    except ValueError as error:
        raise argparse.ArgumentTypeError("throughput sample has invalid numeric fields") from error
    if room_ticks <= 0:
        raise argparse.ArgumentTypeError("throughput sample room_ticks must be greater than 0")
    if not math.isfinite(wall_seconds) or wall_seconds <= 0:
        raise argparse.ArgumentTypeError("throughput sample wall_seconds must be greater than 0")
    if failure_count < 0:
        raise argparse.ArgumentTypeError("throughput sample failure_count must be at least 0")
    return ThroughputSample(
        worker_id=worker_id,
        room_ticks=room_ticks,
        wall_seconds=wall_seconds,
        failure_count=failure_count,
    )


def build_harness_manifest(
    paths: Sequence[str],
    out_dir: Path = DEFAULT_OUT_DIR,
    *,
    manifest_id: str | None = None,
    bot_commit: str | None = None,
    seed: str = DEFAULT_SEED,
    workers: int = DEFAULT_WORKERS,
    rooms_per_worker: int = DEFAULT_ROOMS_PER_WORKER,
    target_speedup: float = DEFAULT_TARGET_SPEEDUP,
    official_tick_seconds: float = DEFAULT_OFFICIAL_TICK_SECONDS,
    throughput_samples: Sequence[ThroughputSample] = (),
    estimated_worker_room_ticks_per_second: float = 0.0,
    max_file_bytes: int = dataset_export.DEFAULT_MAX_FILE_BYTES,
    repo_root: Path | None = None,
) -> JsonObject:
    repo = repo_root or Path.cwd()
    resolved_bot_commit = bot_commit or dataset_export.git_commit(repo)
    resolved_out_dir = out_dir.expanduser()
    scan = dataset_export.collect_artifact_records(
        paths,
        max_file_bytes=max_file_bytes,
        excluded_roots=[resolved_out_dir],
    )
    metadata = collect_local_metadata(scan)
    throughput = build_throughput_evidence(
        workers=workers,
        rooms_per_worker=rooms_per_worker,
        target_speedup=target_speedup,
        official_tick_seconds=official_tick_seconds,
        samples=throughput_samples,
        estimated_worker_room_ticks_per_second=estimated_worker_room_ticks_per_second,
    )
    seed_material = build_seed_material(
        scan=scan,
        metadata=metadata,
        bot_commit=resolved_bot_commit,
        seed=seed,
        workers=workers,
        rooms_per_worker=rooms_per_worker,
        target_speedup=target_speedup,
        official_tick_seconds=official_tick_seconds,
        throughput=throughput,
    )
    resolved_manifest_id = manifest_id or f"rl-sim-{dataset_export.canonical_hash(seed_material)[:12]}"
    validate_manifest_id(resolved_manifest_id)

    manifest = {
        "type": MANIFEST_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "manifestId": resolved_manifest_id,
        "owningIssue": "#414",
        "milestone": "P1: RL strategy flywheel gate",
        "roadmap": {
            "path": "docs/ops/rl-domain-roadmap.md",
            "lane": "L3 Simulator harness",
            "slice": "Slice B - simulator harness design-to-smoke",
        },
        "sourceMode": "local-artifact-metadata-only",
        "botCommit": resolved_bot_commit,
        "scenario": build_scenario_metadata(resolved_manifest_id, seed_material, scan, metadata),
        "adapterContract": adapter_contract(),
        "seed": build_seed_contract(seed, seed_material),
        "reset": build_reset_contract(seed_material),
        "workers": build_worker_contract(workers, rooms_per_worker),
        "throughput": throughput,
        "sources": build_source_metadata(scan, metadata),
        "datasets": metadata["datasets"],
        "strategyShadow": {
            "indexedReportCount": len(scan.strategy_shadow_reports),
            "reports": scan.strategy_shadow_reports,
            "generatedReports": metadata["strategyShadowReports"],
        },
        "privateSmoke": metadata["privateSmokeReports"],
        "safety": safety_metadata(),
        "retention": {
            "class": "local-derived-artifact",
            "rawRuntimeLogsCopied": False,
            "rawSecretsPersisted": False,
            "rawDatasetRowsCopied": False,
            "redaction": "only file hashes, counts, bounded report metadata, and redacted paths are persisted",
        },
    }
    assert_no_secret_leak(manifest, dataset_export.configured_secret_values())

    manifest_path = resolved_out_dir / resolved_manifest_id / "simulator_harness_manifest.json"
    write_json_atomic(manifest_path, manifest)
    return build_summary(manifest, manifest_path)


def build_seed_material(
    *,
    scan: dataset_export.ScanResult,
    metadata: JsonObject,
    bot_commit: str,
    seed: str,
    workers: int,
    rooms_per_worker: int,
    target_speedup: float,
    official_tick_seconds: float,
    throughput: JsonObject,
) -> JsonObject:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "botCommit": bot_commit,
        "seed": seed,
        "sourceFiles": [
            {
                "sourceId": source.source_id,
                "sha256": source.sha256,
                "sizeBytes": source.size_bytes,
            }
            for source in sorted(scan.source_files.values(), key=lambda item: item.source_id)
        ],
        "runtimeArtifacts": [
            runtime_artifact_ref(record)
            for record in sorted(scan.records, key=dataset_export.record_sort_key)
        ],
        "strategyShadowReports": scan.strategy_shadow_reports,
        "metadata": metadata,
        "workers": workers,
        "roomsPerWorker": rooms_per_worker,
        "targetSpeedup": target_speedup,
        "officialTickSeconds": official_tick_seconds,
        "throughput": throughput,
    }


def build_scenario_metadata(
    manifest_id: str,
    seed_material: JsonObject,
    scan: dataset_export.ScanResult,
    metadata: JsonObject,
) -> JsonObject:
    scenario_hash = dataset_export.canonical_hash(seed_material)
    return {
        "scenarioId": "local-artifact-seeded-private-simulator-smoke",
        "scenarioVersion": "0.1.0",
        "manifestId": manifest_id,
        "sourceMode": "runtime/dataset/shadow metadata seed",
        "resettableSimulatorTarget": True,
        "currentSliceExecutesSimulator": False,
        "currentSliceMode": "dry-run planning manifest",
        "determinismKey": scenario_hash,
        "runtimeArtifactCount": len(scan.records),
        "datasetRunCount": len(metadata["datasets"]["runManifests"]),
        "datasetScenarioCount": len(metadata["datasets"]["scenarioManifests"]),
        "strategyShadowReportCount": len(scan.strategy_shadow_reports),
        "generatedStrategyShadowReportCount": len(metadata["strategyShadowReports"]),
        "privateSmokeReportCount": len(metadata["privateSmokeReports"]),
        "notes": [
            "This slice does not start Docker, contact the official MMO, or execute learned policies.",
            "The manifest is the seed/reset/throughput contract for a later self-hosted private simulator adapter.",
        ],
    }


def build_seed_contract(seed: str, seed_material: JsonObject) -> JsonObject:
    root_hash = dataset_export.canonical_hash(seed_material)
    return {
        "baseSeed": dataset_export.redact_text(seed),
        "scenarioSeed": root_hash[:24],
        "seedDerivation": "sha256(canonical source metadata, bot commit, worker target, throughput input)",
        "streams": {
            "world": f"world-{dataset_export.canonical_hash({'root': root_hash, 'stream': 'world'})[:16]}",
            "workers": f"workers-{dataset_export.canonical_hash({'root': root_hash, 'stream': 'workers'})[:16]}",
            "episodes": f"episodes-{dataset_export.canonical_hash({'root': root_hash, 'stream': 'episodes'})[:16]}",
            "validation": f"validation-{dataset_export.canonical_hash({'root': root_hash, 'stream': 'validation'})[:16]}",
        },
    }


def build_reset_contract(seed_material: JsonObject) -> JsonObject:
    reset_hash = dataset_export.canonical_hash({"reset": seed_material})
    return {
        "resetId": f"reset-{reset_hash[:16]}",
        "method": "atomic private-server world reset target",
        "idempotenceKey": reset_hash,
        "requiredInputs": [
            "scenario manifest",
            "scenario seed",
            "bot bundle commit",
            "strategy registry version",
            "memory/raw-memory fixture digest",
            "private-server package/container versions",
        ],
        "dryRunEvidence": {
            "resetExecuted": False,
            "reason": "first #414 slice records the reset contract without requiring Docker or secrets",
        },
    }


def build_worker_contract(workers: int, rooms_per_worker: int) -> JsonObject:
    return {
        "plannedWorkerCount": workers,
        "plannedRoomsPerWorker": rooms_per_worker,
        "plannedParallelRoomCount": workers * rooms_per_worker,
        "isolation": "one private-server worker process per worker index",
        "vectorization": "one or more scenario rooms per worker process",
        "workerIndexSeedPolicy": "derive worker seed stream from base scenario seed plus worker index",
        "healthRequired": [
            "process alive",
            "local control API responsive",
            "active scenario matches manifest",
            "failure count reported",
            "room tick counter increasing during run",
        ],
    }


def build_throughput_evidence(
    *,
    workers: int,
    rooms_per_worker: int,
    target_speedup: float,
    official_tick_seconds: float,
    samples: Sequence[ThroughputSample],
    estimated_worker_room_ticks_per_second: float,
) -> JsonObject:
    target_room_ticks_per_second = target_speedup / official_tick_seconds
    target = {
        "officialTickSecondsBaseline": official_tick_seconds,
        "targetSpeedupVsOfficial": target_speedup,
        "targetAggregateRoomTicksPerSecond": round(target_room_ticks_per_second, 6),
        "plannedWorkerCount": workers,
        "plannedRoomsPerWorker": rooms_per_worker,
        "plannedParallelRoomCount": workers * rooms_per_worker,
    }
    if samples:
        total_room_ticks = sum(sample.room_ticks for sample in samples)
        max_wall_seconds = max(sample.wall_seconds for sample in samples)
        aggregate_rps = total_room_ticks / max_wall_seconds if max_wall_seconds > 0 else 0.0
        failure_count = sum(sample.failure_count for sample in samples)
        mode = "sampled-dry-run-input"
        sample_rows = [
            {
                "workerId": dataset_export.redact_text(sample.worker_id),
                "roomTicks": sample.room_ticks,
                "wallSeconds": sample.wall_seconds,
                "failureCount": sample.failure_count,
                "roomTicksPerSecond": round(sample.room_ticks / sample.wall_seconds, 6),
            }
            for sample in samples
        ]
    elif estimated_worker_room_ticks_per_second > 0:
        total_room_ticks = None
        max_wall_seconds = None
        aggregate_rps = estimated_worker_room_ticks_per_second * workers
        failure_count = None
        mode = "estimated-from-worker-rate"
        sample_rows = []
    else:
        total_room_ticks = None
        max_wall_seconds = None
        aggregate_rps = None
        failure_count = None
        mode = "not-measured"
        sample_rows = []

    speedup = aggregate_rps * official_tick_seconds if aggregate_rps is not None else None
    gap = target_room_ticks_per_second - aggregate_rps if aggregate_rps is not None else None
    return {
        "target": target,
        "evidenceMode": mode,
        "samples": sample_rows,
        "aggregate": {
            "totalRoomTicks": total_room_ticks,
            "parallelWallSeconds": max_wall_seconds,
            "aggregateRoomTicksPerSecond": round(aggregate_rps, 6) if aggregate_rps is not None else None,
            "speedupVsOfficial": round(speedup, 6) if speedup is not None else None,
            "targetMet": bool(speedup is not None and speedup >= target_speedup),
            "gapRoomTicksPerSecond": round(gap, 6) if gap is not None and gap > 0 else 0,
            "failureCount": failure_count,
        },
        "bottleneckPolicy": (
            "If the sampled aggregate rate is below target, report bottlenecks and scale workers or rooms per "
            "worker instead of weakening Screeps mechanics."
        ),
    }


def collect_local_metadata(scan: dataset_export.ScanResult) -> JsonObject:
    metadata: JsonObject = {
        "datasets": {
            "runManifests": [],
            "scenarioManifests": [],
            "sourceIndexes": [],
            "exportSummaries": [],
        },
        "strategyShadowReports": [],
        "privateSmokeReports": [],
    }
    for source in sorted(scan.source_files.values(), key=lambda item: item.source_id):
        try:
            text = Path(source.path).read_text(encoding="utf-8")
        except OSError:
            continue
        for line_number, document in dataset_export.iter_json_documents(text):
            for item in dataset_export.flatten_json_documents(document):
                if not isinstance(item, dict):
                    continue
                append_dataset_metadata(metadata, source, line_number, item)
                shadow = generated_shadow_report_metadata(item, source, line_number)
                if shadow is not None:
                    metadata["strategyShadowReports"].append(shadow)
                smoke = private_smoke_report_metadata(item, source, line_number)
                if smoke is not None:
                    metadata["privateSmokeReports"].append(smoke)

    for key in metadata["datasets"]:
        metadata["datasets"][key].sort(key=lambda item: metadata_sort_key(item, "runId"))
    metadata["strategyShadowReports"].sort(key=lambda item: metadata_sort_key(item, "reportId"))
    metadata["privateSmokeReports"].sort(key=lambda item: metadata_sort_key(item, "workDir"))
    return metadata


def metadata_sort_key(item: JsonObject, id_key: str) -> tuple[str, str]:
    return (sort_text(item.get("path")), sort_text(item.get(id_key)))


def sort_text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def append_dataset_metadata(
    metadata: JsonObject,
    source: dataset_export.SourceFile,
    line_number: int | None,
    raw: JsonObject,
) -> None:
    common = source_common(source, line_number)
    raw_type = raw.get("type")
    if raw_type == dataset_export.RUN_MANIFEST_TYPE:
        strategy = raw.get("strategy") if isinstance(raw.get("strategy"), dict) else {}
        source_meta = raw.get("source") if isinstance(raw.get("source"), dict) else {}
        split = raw.get("split") if isinstance(raw.get("split"), dict) else {}
        metadata["datasets"]["runManifests"].append(
            {
                **common,
                "runId": text_or_none(raw.get("runId")),
                "botCommit": text_or_none(raw.get("botCommit")),
                "sampleCount": number_or_none(raw.get("sampleCount")),
                "sourceArtifactCount": number_or_none(source_meta.get("sourceArtifactCount")),
                "matchedArtifactCount": number_or_none(source_meta.get("matchedArtifactCount")),
                "strategyShadowReportCount": number_or_none(source_meta.get("strategyShadowReportCount")),
                "decisionSurfacesObserved": string_list(strategy.get("decisionSurfacesObserved")),
                "liveEffect": strategy.get("liveEffect") is True,
                "splitSeed": text_or_none(split.get("seed")),
                "splitCounts": select_number_map(split.get("counts")),
            }
        )
        return

    if raw_type == dataset_export.SCENARIO_MANIFEST_TYPE:
        source_artifact_ids = raw.get("sourceArtifactIds")
        metadata["datasets"]["scenarioManifests"].append(
            {
                **common,
                "runId": text_or_none(raw.get("runId")),
                "scenarioId": text_or_none(raw.get("scenarioId")),
                "sourceMode": text_or_none(raw.get("sourceMode")),
                "resettableSimulator": raw.get("resettableSimulator") is True,
                "networkRequired": raw.get("networkRequired") is True,
                "officialMmoWritesAllowed": raw.get("officialMmoWritesAllowed") is True,
                "sourceArtifactCount": len(source_artifact_ids) if isinstance(source_artifact_ids, list) else None,
            }
        )
        return

    if raw_type == "screeps-rl-source-index":
        source_files = raw.get("sourceFiles")
        metadata["datasets"]["sourceIndexes"].append(
            {
                **common,
                "inputPaths": string_list(raw.get("inputPaths")),
                "sourceFileCount": len(source_files) if isinstance(source_files, list) else None,
                "scannedFiles": number_or_none(raw.get("scannedFiles")),
                "matchedArtifactCount": number_or_none(raw.get("matchedArtifactCount")),
                "strategyShadowReportCount": number_or_none(raw.get("strategyShadowReportCount")),
                "skippedFileCount": len(raw.get("skippedFiles")) if isinstance(raw.get("skippedFiles"), list) else None,
            }
        )
        return

    if raw_type == dataset_export.DATASET_TYPE:
        metadata["datasets"]["exportSummaries"].append(
            {
                **common,
                "runId": text_or_none(raw.get("runId")),
                "sampleCount": number_or_none(raw.get("sampleCount")),
                "sourceArtifactCount": number_or_none(raw.get("sourceArtifactCount")),
                "runtimeSummaryArtifactCount": number_or_none(raw.get("runtimeSummaryArtifactCount")),
                "strategyShadowReportCount": number_or_none(raw.get("strategyShadowReportCount")),
                "splitCounts": select_number_map(raw.get("splitCounts")),
            }
        )


def generated_shadow_report_metadata(
    raw: JsonObject,
    source: dataset_export.SourceFile,
    line_number: int | None,
) -> JsonObject | None:
    if raw.get("type") != "screeps-strategy-shadow-report":
        return None
    return {
        **source_common(source, line_number),
        "reportId": text_or_none(raw.get("reportId")),
        "enabled": raw.get("enabled") is True,
        "liveEffect": raw.get("liveEffect") is True,
        "artifactCount": number_or_none(raw.get("artifactCount")),
        "modelReportCount": number_or_none(raw.get("modelReportCount")),
        "rankingDiffCount": number_or_none(raw.get("rankingDiffCount")),
        "changedTopCount": number_or_none(raw.get("changedTopCount")),
        "candidateStrategyIds": string_list(raw.get("candidateStrategyIds")),
        "incumbentStrategyIds": string_list(raw.get("incumbentStrategyIds")),
        "modelFamilies": string_list(raw.get("modelFamilies")),
    }


def private_smoke_report_metadata(
    raw: JsonObject,
    source: dataset_export.SourceFile,
    line_number: int | None,
) -> JsonObject | None:
    if not isinstance(raw.get("dry_run"), bool) or not isinstance(raw.get("ports"), dict):
        return None
    smoke = raw.get("smoke") if isinstance(raw.get("smoke"), dict) else {}
    ports = raw.get("ports") if isinstance(raw.get("ports"), dict) else {}
    return {
        **source_common(source, line_number),
        "ok": raw.get("ok") is True,
        "dryRun": raw.get("dry_run") is True,
        "workDir": text_or_none(raw.get("work_dir")),
        "composeProject": text_or_none(raw.get("compose_project")),
        "room": text_or_none(smoke.get("room")),
        "shard": text_or_none(smoke.get("shard")),
        "hostPorts": select_number_map(ports.get("host")),
        "containerPorts": select_number_map(ports.get("container")),
    }


def build_source_metadata(scan: dataset_export.ScanResult, metadata: JsonObject) -> JsonObject:
    runtime_counts: dict[str, int] = {}
    artifact_kinds: dict[str, set[str]] = {}
    for record in scan.records:
        runtime_counts[record.source.source_id] = runtime_counts.get(record.source.source_id, 0) + 1
        artifact_kinds.setdefault(record.source.source_id, set()).add(record.artifact_kind)

    dataset_sources = metadata_sources(metadata)
    runtime_artifacts = [runtime_artifact_ref(record) for record in sorted(scan.records, key=dataset_export.record_sort_key)]
    source_files = []
    for source in sorted(scan.source_files.values(), key=lambda item: item.source_id):
        kinds = sorted(artifact_kinds.get(source.source_id, set()) | dataset_sources.get(source.source_id, set()))
        source_files.append(
            {
                "sourceId": source.source_id,
                "path": source.display_path,
                "sizeBytes": source.size_bytes,
                "sha256": source.sha256,
                "runtimeArtifactCount": runtime_counts.get(source.source_id, 0),
                "metadataKinds": kinds,
            }
        )
    return {
        "inputPaths": dataset_export.redacted_input_paths(scan.input_paths),
        "scannedFiles": scan.scanned_files,
        "sourceFileCount": len(scan.source_files),
        "runtimeArtifactCount": len(scan.records),
        "strategyShadowReportCount": len(scan.strategy_shadow_reports),
        "skippedFileCount": len(scan.skipped_files),
        "skippedFiles": sanitize_skipped_files(scan.skipped_files),
        "sourceFiles": source_files,
        "runtimeArtifacts": runtime_artifacts,
    }


def metadata_sources(metadata: JsonObject) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for kind, items in metadata["datasets"].items():
        for item in items:
            source_id = item.get("sourceId")
            if isinstance(source_id, str):
                result.setdefault(source_id, set()).add(kind)
    for kind in ("strategyShadowReports", "privateSmokeReports"):
        for item in metadata[kind]:
            source_id = item.get("sourceId")
            if isinstance(source_id, str):
                result.setdefault(source_id, set()).add(kind)
    return result


def runtime_artifact_ref(record: dataset_export.ArtifactRecord) -> JsonObject:
    payload = record.payload
    rooms = payload.get("rooms") if isinstance(payload.get("rooms"), list) else []
    room_names = sorted(
        room.get("roomName")
        for room in rooms
        if isinstance(room, dict) and isinstance(room.get("roomName"), str)
    )
    return {
        "artifactId": f"runtime-{dataset_export.canonical_hash(payload)[:16]}",
        "sourceId": record.source.source_id,
        "artifactKind": record.artifact_kind,
        "path": record.source.display_path,
        "lineNumber": record.line_number,
        "tick": number_or_none(payload.get("tick")),
        "roomCount": len(room_names),
        "rooms": room_names,
    }


def adapter_contract() -> JsonObject:
    return {
        "apiVersion": "screeps-rl-sim-adapter.v1alpha1",
        "transport": "local JSON over stdio or loopback HTTP",
        "officialMmoApiExposed": False,
        "methods": {
            "health": "worker status, package versions, active scenario, tick, pid, and failure counters",
            "loadScenario": "load a deterministic scenario manifest without ticking",
            "reset": "atomically reset world state from seed, bot bundle, memory snapshot, and strategy version",
            "step": "advance a bounded number of private-server ticks with typed offline recommendations",
            "observe": "read room objects, terrain, event logs, memory summaries, CPU stats, and KPI reducers",
            "artifact": "export scenario config, seed, observations, actions, rewards, logs, KPI output, and throughput",
            "close": "stop worker-owned processes and verify cleanup",
        },
        "allowedActionSurface": [
            "construction_preset",
            "remote_target",
            "expansion_candidate",
            "defense_posture",
            "weight_vector",
        ],
        "forbiddenActionSurface": [
            "official MMO writes",
            "RawMemory commands to official MMO",
            "raw creep intents",
            "spawn intents",
            "market orders",
        ],
    }


def safety_metadata() -> JsonObject:
    return {
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "officialMmoControl": False,
        "networkRequired": False,
        "dockerRequired": False,
        "liveSecretsRequired": False,
        "rawCreepIntentControl": False,
        "memoryWritesAllowed": False,
        "rawMemoryWritesAllowed": False,
        "allowedUse": "offline/private simulator planning, shadow evaluation, and high-level recommendations only",
        "requiredBeforeLiveInfluence": [
            "simulator evidence",
            "historical official-MMO validation",
            "private/shadow safety gate",
            "KPI rollout gate",
            "rollback gate",
        ],
    }


def build_summary(manifest: JsonObject, manifest_path: Path) -> JsonObject:
    source = manifest["sources"]
    throughput = manifest["throughput"]
    return {
        "ok": True,
        "type": SUMMARY_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "manifestId": manifest["manifestId"],
        "manifestPath": dataset_export.display_path(manifest_path),
        "liveEffect": False,
        "officialMmoWrites": False,
        "sourceFileCount": source["sourceFileCount"],
        "runtimeArtifactCount": source["runtimeArtifactCount"],
        "datasetRunCount": manifest["scenario"]["datasetRunCount"],
        "strategyShadowReportCount": manifest["scenario"]["strategyShadowReportCount"],
        "throughput": {
            "evidenceMode": throughput["evidenceMode"],
            "aggregateRoomTicksPerSecond": throughput["aggregate"]["aggregateRoomTicksPerSecond"],
            "speedupVsOfficial": throughput["aggregate"]["speedupVsOfficial"],
            "targetMet": throughput["aggregate"]["targetMet"],
        },
        "safety": manifest["safety"],
    }


def source_common(source: dataset_export.SourceFile, line_number: int | None) -> JsonObject:
    return {
        "sourceId": source.source_id,
        "path": source.display_path,
        "lineNumber": line_number,
        "sha256": source.sha256,
        "sizeBytes": source.size_bytes,
    }


def sanitize_skipped_files(skipped_files: Sequence[JsonObject], limit: int = 20) -> list[JsonObject]:
    sanitized: list[JsonObject] = []
    for item in skipped_files[:limit]:
        sanitized_item: JsonObject = {}
        for key, value in item.items():
            if isinstance(value, str):
                sanitized_item[str(key)] = dataset_export.redact_text(value)[:240]
            elif isinstance(value, (int, float, bool)) or value is None:
                sanitized_item[str(key)] = value
        sanitized.append(sanitized_item)
    return sanitized


def validate_manifest_id(manifest_id: str) -> None:
    dataset_export.validate_run_id(manifest_id)


def text_or_none(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return dataset_export.redact_text(value)[:240]


def string_list(raw: Any, limit: int = 50) -> list[str]:
    if not isinstance(raw, list):
        return []
    result: list[str] = []
    for item in raw[:limit]:
        if isinstance(item, str):
            result.append(dataset_export.redact_text(item)[:240])
    return result


def select_number_map(raw: Any) -> JsonObject:
    if not isinstance(raw, dict):
        return {}
    return {str(key): value for key, value in sorted(raw.items()) if dataset_export.is_number(value)}


def number_or_none(value: Any) -> int | float | None:
    return value if dataset_export.is_number(value) else None


def assert_no_secret_leak(payload: JsonObject, secrets: Sequence[str]) -> None:
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=True)
    for secret in secrets:
        if secret and len(secret) >= 6 and secret in encoded:
            raise RuntimeError("refusing to persist simulator harness manifest containing a configured secret")


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(temp_fd, "w", encoding="utf-8") as handle:
            temp_fd = -1
            handle.write(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True))
            handle.write("\n")
        os.replace(temp_path, path)
    finally:
        if temp_fd != -1:
            try:
                os.close(temp_fd)
            except OSError:
                pass
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def run_self_test(stdout: TextIO = sys.stdout) -> int:
    payload = {
        "type": "runtime-summary",
        "tick": 100,
        "rooms": [{"roomName": "W1N1", "workerCount": 2, "resources": {"storedEnergy": 100}}],
    }
    shadow_report = {
        "type": "screeps-strategy-shadow-report",
        "reportId": "self-test-shadow",
        "enabled": True,
        "liveEffect": False,
        "artifactCount": 1,
        "modelReportCount": 1,
        "rankingDiffCount": 1,
        "changedTopCount": 0,
        "candidateStrategyIds": ["construction-priority.territory-shadow.v1"],
        "modelFamilies": ["construction-priority"],
        "modelReports": [],
    }
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        runtime = root / "runtime.log"
        shadow = root / "shadow.json"
        runtime.write_text(
            "#runtime-summary " + json.dumps(payload, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        shadow.write_text(json.dumps(shadow_report, sort_keys=True), encoding="utf-8")
        summary = build_harness_manifest(
            [str(runtime), str(shadow)],
            root / "out",
            manifest_id="self-test",
            bot_commit="0" * 40,
            throughput_samples=[ThroughputSample("worker-0", 1200, 30.0)],
        )
        if not summary["ok"] or summary["liveEffect"] or summary["officialMmoWrites"]:
            raise RuntimeError("self-test safety summary failed")
        if summary["runtimeArtifactCount"] != 1 or summary["strategyShadowReportCount"] < 1:
            raise RuntimeError("self-test source summary failed")
    stdout.write(json.dumps(summary, indent=2, sort_keys=True, ensure_ascii=True))
    stdout.write("\n")
    return 0


def run_simulator(
    *,
    ticks: int,
    workers: int,
    variants: Sequence[str],
    out_dir: Path,
    run_id: str | None = None,
    room: str = DEFAULT_SIM_ROOM,
    shard: str = DEFAULT_SIM_SHARD,
    branch: str = DEFAULT_ACTIVE_WORLD_BRANCH,
    code_path: Path = DEFAULT_CODE_PATH,
    map_source_file: Path = DEFAULT_MAP_SOURCE_FILE,
) -> JsonObject:
    if not code_path.is_file():
        raise RuntimeError(f"code path is not a file: {code_path}")
    if not map_source_file.is_file():
        raise RuntimeError(f"map source file is not a file: {map_source_file}")
    if not os.environ.get("STEAM_KEY"):
        raise RuntimeError("STEAM_KEY environment variable is required for run mode")

    resolved_out_dir = out_dir.expanduser()
    resolved_code_path = code_path.expanduser()
    resolved_map_source = map_source_file.expanduser()
    try:
        resolved_run_id = validate_run_id_token(run_id or f"{RUN_ID_PREFIX}-{int(time.time())}")
    except ValueError as error:
        raise RuntimeError(str(error)) from error
    artifact, variants_result = run_variants(
        variants=variants,
        ticks=ticks,
        workers=workers,
        room=room,
        shard=shard,
        branch=branch,
        code_path=resolved_code_path,
        map_source_file=resolved_map_source,
        out_dir=resolved_out_dir,
        run_id=resolved_run_id,
    )
    run_artifact_path = resolved_out_dir / resolved_run_id / "run_summary.json"
    validate_run_artifact(artifact)
    assert_no_secret_leak(artifact, dataset_export.configured_secret_values() + [os.environ.get("STEAM_KEY", "")])
    write_json_atomic(run_artifact_path, artifact)
    artifact["run_artifact_path"] = str(run_artifact_path)
    artifact["variants"] = variants_result
    return artifact


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build an offline Screeps RL simulator-harness planning manifest.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    dry = subparsers.add_parser(
        "dry-run",
        help="Generate a deterministic manifest without Docker, network, secrets, or official MMO writes.",
    )
    dry.add_argument(
        "paths",
        nargs="*",
        help=(
            "Files or directories to scan. Defaults to /root/screeps/runtime-artifacts, "
            "/root/.hermes/cron/output, and repo-local runtime-artifacts."
        ),
    )
    dry.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help=f"Manifest output root. Default: {DEFAULT_OUT_DIR}.",
    )
    dry.add_argument("--manifest-id", help="Optional manifest directory name. Defaults to a content hash.")
    dry.add_argument("--bot-commit", help="Bot commit to record. Defaults to git rev-parse HEAD.")
    dry.add_argument("--seed", default=DEFAULT_SEED, help=f"Base deterministic seed. Default: {DEFAULT_SEED}.")
    dry.add_argument(
        "--workers",
        type=positive_int,
        default=DEFAULT_WORKERS,
        help=f"Planned worker count. Default: {DEFAULT_WORKERS}.",
    )
    dry.add_argument(
        "--rooms-per-worker",
        type=positive_int,
        default=DEFAULT_ROOMS_PER_WORKER,
        help=f"Planned vectorized rooms per worker. Default: {DEFAULT_ROOMS_PER_WORKER}.",
    )
    dry.add_argument(
        "--target-speedup",
        type=positive_float,
        default=DEFAULT_TARGET_SPEEDUP,
        help=f"Aggregate target versus official tick speed. Default: {DEFAULT_TARGET_SPEEDUP}.",
    )
    dry.add_argument(
        "--official-tick-seconds",
        type=positive_float,
        default=DEFAULT_OFFICIAL_TICK_SECONDS,
        help=f"Official tick baseline used for speedup math. Default: {DEFAULT_OFFICIAL_TICK_SECONDS}.",
    )
    dry.add_argument(
        "--estimate-worker-room-ticks-per-second",
        type=non_negative_float,
        default=0.0,
        help="Optional dry-run estimate per worker when no samples are supplied.",
    )
    dry.add_argument(
        "--throughput-sample",
        action="append",
        default=[],
        type=parse_throughput_sample,
        help="Worker sample as worker_id:room_ticks:wall_seconds[:failure_count]. Repeat per worker.",
    )
    dry.add_argument(
        "--max-file-bytes",
        type=positive_int,
        default=dataset_export.DEFAULT_MAX_FILE_BYTES,
        help=f"Skip input files larger than this many bytes. Default: {dataset_export.DEFAULT_MAX_FILE_BYTES}.",
    )

    subparsers.add_parser("self-test", help="Run a no-network/no-Docker manifest generation self-test.")

    run = subparsers.add_parser(
        "run",
        help="Run Docker private-server variants and collect tick-level metrics.",
    )
    run.add_argument(
        "--run-id",
        type=parse_run_id_token,
        default=None,
        help="Optional run artifact id. Defaults to a timestamped rl-sim-run value.",
    )
    run.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_RUN_OUT_DIR,
        help=f"Run output root. Default: {DEFAULT_RUN_OUT_DIR}.",
    )
    run.add_argument(
        "--variants",
        action="append",
        default=[],
        help="Comma-separated strategy variants from registry. Repeatable.",
    )
    run.add_argument(
        "--ticks",
        type=positive_int,
        default=DEFAULT_RUN_TICKS,
        help=f"Ticks per variant. Default: {DEFAULT_RUN_TICKS}.",
    )
    run.add_argument(
        "--workers",
        type=positive_int,
        default=DEFAULT_RUN_WORKERS,
        help=f"Parallel simulator workers. Default: {DEFAULT_RUN_WORKERS}.",
    )
    run.add_argument(
        "--room",
        default=DEFAULT_SIM_ROOM,
        help=f"Target room for reset + spawn. Default: {DEFAULT_SIM_ROOM}.",
    )
    run.add_argument(
        "--shard",
        default=DEFAULT_SIM_SHARD,
        help=f"Target shard. Default: {DEFAULT_SIM_SHARD}.",
    )
    run.add_argument(
        "--branch",
        default=DEFAULT_ACTIVE_WORLD_BRANCH,
        help=f"Code branch for /api/user/code. Default: {DEFAULT_ACTIVE_WORLD_BRANCH}.",
    )
    run.add_argument(
        "--code-path",
        type=Path,
        default=DEFAULT_CODE_PATH,
        help=f"Bot bundle path. Default: {DEFAULT_CODE_PATH}.",
    )
    run.add_argument(
        "--map-source-file",
        type=Path,
        default=DEFAULT_MAP_SOURCE_FILE,
        help=f"Map source JSON path. Default: {DEFAULT_MAP_SOURCE_FILE}.",
    )
    return parser


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "self-test":
        return run_self_test(stdout)
    if args.command == "dry-run":
        summary = build_harness_manifest(
            args.paths,
            args.out_dir,
            manifest_id=args.manifest_id,
            bot_commit=args.bot_commit,
            seed=args.seed,
            workers=args.workers,
            rooms_per_worker=args.rooms_per_worker,
            target_speedup=args.target_speedup,
            official_tick_seconds=args.official_tick_seconds,
            throughput_samples=args.throughput_sample,
            estimated_worker_room_ticks_per_second=args.estimate_worker_room_ticks_per_second,
            max_file_bytes=args.max_file_bytes,
        )
        stdout.write(json.dumps(summary, indent=2, sort_keys=True, ensure_ascii=True))
        stdout.write("\n")
        return 0
    if args.command == "run":
        if not hasattr(args, "variants"):
            raise RuntimeError("run command requires --variants or no-argument default to registry")
        variants = normalize_variants(args.variants, discover_strategy_variants())
        summary = run_simulator(
            ticks=args.ticks,
            workers=args.workers,
            variants=variants,
            out_dir=args.out_dir,
            run_id=args.run_id,
            room=args.room,
            shard=args.shard,
            branch=args.branch,
            code_path=args.code_path,
            map_source_file=args.map_source_file,
        )
        stdout.write(json.dumps(summary, indent=2, sort_keys=True, ensure_ascii=True))
        stdout.write("\n")
        variant_results = summary.get("variants")
        if not isinstance(variant_results, list):
            return 1
        overall_ok = all(isinstance(variant, dict) and variant.get("ok", False) for variant in variant_results)
        return 0 if overall_ok else 1
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
