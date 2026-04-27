#!/usr/bin/env python3
"""Screeps runtime room monitor.

This tool is intentionally outside the Screeps bot runtime. It uses the same
official-client HTTP and websocket surfaces as the existing room snapshot
prototype, renders cron-friendly PNG artifacts, and keeps alert state in a
local ignored path.
"""

from __future__ import annotations

import argparse
import asyncio
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_API_URL = "https://screeps.com"
DEFAULT_OUT_DIR = Path("/root/screeps/runtime-artifacts/screeps-monitor")
DEFAULT_STATE_FILE = Path("/root/.hermes/screeps-runtime-monitor/state.json")
DEFAULT_CACHE_DIR = Path("/root/.hermes/screeps-runtime-monitor/terrain-cache")
DEFAULT_DEBOUNCE_SECONDS = 300
DEFAULT_SHARD = "shardX"
DEFAULT_ROOM = "E48S28"

ROOM_SIZE = 50
TERRAIN_CELLS = ROOM_SIZE * ROOM_SIZE

STRUCTURE_TYPES = {
    "constructedWall",
    "container",
    "controller",
    "extension",
    "extractor",
    "factory",
    "invaderCore",
    "keeperLair",
    "lab",
    "link",
    "nuker",
    "observer",
    "portal",
    "powerBank",
    "powerSpawn",
    "rampart",
    "road",
    "spawn",
    "storage",
    "terminal",
    "tower",
}

DAMAGEABLE_STRUCTURE_TYPES = {
    "constructedWall",
    "container",
    "extension",
    "extractor",
    "factory",
    "lab",
    "link",
    "nuker",
    "observer",
    "powerSpawn",
    "rampart",
    "road",
    "spawn",
    "storage",
    "terminal",
    "tower",
}

CRITICAL_STRUCTURE_TYPES = {
    "controller",
    "factory",
    "nuker",
    "observer",
    "powerSpawn",
    "spawn",
    "storage",
    "terminal",
    "tower",
}

TACTICAL_SEVERITY_RANK = {
    "none": 0,
    "warning": 1,
    "high": 2,
    "critical": 3,
}

TACTICAL_CATEGORY_RULES: dict[str, dict[str, Any]] = {
    "hostiles": {
        "severity": "high",
        "decision": "owner_action_or_observe",
        "actions": ["capture_runtime_context", "inspect_live_room", "decide_owner_action"],
    },
    "owned_structure_damage": {
        "severity": "high",
        "decision": "open_issue_or_codex_hotfix",
        "actions": ["capture_runtime_context", "compare_baseline", "open_incident_issue"],
    },
    "owned_structure_disappearance": {
        "severity": "critical",
        "decision": "codex_hotfix_or_rollback",
        "actions": ["capture_runtime_context", "compare_baseline", "start_hotfix_gate"],
    },
    "spawn_collapse": {
        "severity": "critical",
        "decision": "codex_hotfix_or_owner_action",
        "actions": ["capture_runtime_context", "inspect_spawn_recovery", "start_hotfix_gate"],
    },
    "downgrade_risk": {
        "severity": "high",
        "decision": "owner_action_or_codex_hotfix",
        "actions": ["capture_runtime_context", "inspect_controller", "start_hotfix_gate"],
    },
    "telemetry_silence": {
        "severity": "critical",
        "decision": "rollback_or_monitor_fix",
        "actions": ["capture_runtime_context", "inspect_recent_deploy", "restore_telemetry"],
    },
    "monitor_integrity": {
        "severity": "high",
        "decision": "monitor_fix",
        "actions": ["capture_runtime_context", "inspect_monitor_state", "restore_telemetry"],
    },
    "unknown_runtime_alert": {
        "severity": "high",
        "decision": "main_agent_triage",
        "actions": ["capture_runtime_context", "open_incident_issue"],
    },
}

TACTICAL_REASON_CATEGORY_MAP = {
    "hostile_creep": ["hostiles"],
    "structure_damage": ["owned_structure_damage"],
    "critical_structure_missing": ["owned_structure_disappearance"],
    "spawn_destroyed": ["spawn_collapse"],
    "spawn_collapse": ["spawn_collapse"],
    "no_workers_no_recovery": ["spawn_collapse"],
    "no_spawn_recovery": ["spawn_collapse"],
    "controller_downgrade_risk": ["downgrade_risk"],
    "downgrade_risk": ["downgrade_risk"],
    "telemetry_silence": ["telemetry_silence"],
    "runtime_summary_silence": ["telemetry_silence"],
    "loop_exception": ["telemetry_silence"],
    "monitor_miss": ["monitor_integrity"],
    "monitor_spam": ["monitor_integrity"],
}

TACTICAL_ACTION_CATALOG: dict[str, dict[str, Any]] = {
    "return_silent": {
        "owner": "scheduler-wrapper",
        "action": "Return [SILENT] and do not post a runtime-alert message.",
        "decision": "observe",
    },
    "capture_runtime_context": {
        "owner": "main-agent",
        "action": "Capture the alert JSON, rendered room image path, recent runtime-summary evidence, current branch, and latest deploy SHA before changing code.",
        "decision": "triage",
    },
    "inspect_live_room": {
        "owner": "main-agent",
        "action": "Inspect the current room state for hostile owner, hostile body intent, tower/spawn/controller condition, and whether the alert persists across the next check.",
        "decision": "owner_action_or_observe",
    },
    "decide_owner_action": {
        "owner": "main-agent",
        "action": "Escalate to owner action only when live manual defense or market/terminal action is needed before a code change can help.",
        "decision": "owner_action",
    },
    "compare_baseline": {
        "owner": "main-agent",
        "action": "Compare the monitor baseline against the current snapshot to confirm damage or disappearance is real and not a stale object-cache artifact.",
        "decision": "open_issue_or_hotfix",
    },
    "open_incident_issue": {
        "owner": "main-agent",
        "action": "Open or update a GitHub incident issue when the condition persists, affects production behavior, or needs code work.",
        "decision": "open_issue",
    },
    "inspect_spawn_recovery": {
        "owner": "main-agent",
        "action": "Check whether any spawn exists, whether workers can recover harvesting, and whether the bot has a deterministic recovery path.",
        "decision": "codex_hotfix_or_owner_action",
    },
    "inspect_controller": {
        "owner": "main-agent",
        "action": "Check controller level, ticks-to-downgrade, upgrader presence, available energy, and spawn availability before selecting observe, hotfix, or owner action.",
        "decision": "owner_action_or_hotfix",
    },
    "inspect_recent_deploy": {
        "owner": "main-agent",
        "action": "Check the latest deploy, runtime console, and monitor capture path to distinguish bot loop failure from monitor transport failure.",
        "decision": "rollback_or_monitor_fix",
    },
    "inspect_monitor_state": {
        "owner": "main-agent",
        "action": "Inspect debounce state, alert signature churn, and scheduler wrapper behavior before changing cron configuration.",
        "decision": "monitor_fix",
    },
    "restore_telemetry": {
        "owner": "main-agent",
        "action": "Restore trustworthy telemetry first; use rollback only when the latest deploy plausibly caused loop exceptions or runtime-summary silence.",
        "decision": "rollback_or_monitor_fix",
    },
    "start_hotfix_gate": {
        "owner": "codex",
        "action": "Start the emergency hotfix gate: keep GitHub state current, preserve no-secret handling, implement prod changes through Codex, run required verification, and monitor after release.",
        "decision": "codex_hotfix",
    },
}

TACTICAL_HOTFIX_GATE = [
    "Keep the issue or PR state current before reporting completion.",
    "Do not expose tokens, auth headers, passwords, or local secret paths.",
    "Use Codex for production code changes.",
    "Run typecheck, tests, and build when prod code changes are involved.",
    "Run the runtime monitor self-test and tactical-response offline tests for monitor changes.",
    "Verify post-release runtime monitor output before closing the incident.",
]


@dataclass(frozen=True)
class RoomRef:
    shard: str
    room: str

    @property
    def key(self) -> str:
        return f"{self.shard}/{self.room}"

    @property
    def file_fragment(self) -> str:
        return safe_file_fragment(f"{self.shard}-{self.room}")


@dataclass
class RuntimeContext:
    base_http: str
    token: str
    default_shard: str
    default_room: str
    owner: str | None
    state_file: Path
    cache_dir: Path
    debounce_seconds: int

    @property
    def base_ws(self) -> str:
        if self.base_http.startswith("https://"):
            return "wss://" + self.base_http[len("https://") :]
        if self.base_http.startswith("http://"):
            return "ws://" + self.base_http[len("http://") :]
        return self.base_http


@dataclass
class RoomSnapshot:
    ref: RoomRef
    terrain: str
    objects: dict[str, dict[str, Any]]
    tick: int | str | None
    owner: str | None
    info: dict[str, Any]

    @property
    def counts(self) -> Counter:
        return Counter(
            obj.get("type", "?")
            for obj in self.objects.values()
            if isinstance(obj, dict)
        )


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def pct(numerator: Any, denominator: Any) -> float:
    try:
        denominator_float = float(denominator)
        if denominator_float <= 0:
            return 0.0
        return max(0.0, min(1.0, float(numerator) / denominator_float))
    except (TypeError, ValueError):
        return 0.0


def short_text(value: Any, max_len: int = 64) -> str:
    text = str(value)
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "..."


def safe_file_fragment(value: str) -> str:
    fragment = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip(".-")
    return fragment or "room"


def room_owner(obj: dict[str, Any]) -> str | None:
    owner = obj.get("owner")
    if isinstance(owner, dict):
        username = owner.get("username")
        if isinstance(username, str):
            return username
    return None


def is_owned_object(obj: dict[str, Any], owner_username: str | None) -> bool:
    if obj.get("my") is True:
        return True
    username = room_owner(obj)
    return bool(owner_username and username == owner_username)


def infer_owner(objects: dict[str, dict[str, Any]], configured_owner: str | None) -> str | None:
    if configured_owner:
        return configured_owner
    for obj in objects.values():
        if not isinstance(obj, dict):
            continue
        if obj.get("my") is True:
            username = room_owner(obj)
            if username:
                return username
    return None


def normalize_objects(raw_objects: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(raw_objects, dict):
        return {}
    objects: dict[str, dict[str, Any]] = {}
    for object_id, obj in raw_objects.items():
        if isinstance(obj, dict):
            normalized = dict(obj)
            normalized.setdefault("_id", object_id)
            objects[str(object_id)] = normalized
    return objects


def terrain_flags(terrain: str, x: int, y: int) -> int:
    if len(terrain) != TERRAIN_CELLS:
        raise ValueError(f"expected {TERRAIN_CELLS} terrain cells, got {len(terrain)}")
    if not (0 <= x < ROOM_SIZE and 0 <= y < ROOM_SIZE):
        raise ValueError(f"terrain coordinate out of range: {x},{y}")
    value = terrain[y * ROOM_SIZE + x]
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"invalid terrain value {value!r} at {x},{y}") from exc


def terrain_counts(terrain: str) -> dict[str, int]:
    counts = {"plain": 0, "swamp": 0, "wall": 0}
    for index in range(TERRAIN_CELLS):
        value = int(terrain[index])
        if value & 1:
            counts["wall"] += 1
        elif value & 2:
            counts["swamp"] += 1
        else:
            counts["plain"] += 1
    return counts


def parse_room_arg(value: str | None, default_shard: str) -> RoomRef | None:
    if not value:
        return None
    if "/" in value:
        shard, room = value.split("/", 1)
        if not shard or not room:
            raise ValueError("--room must use shard/room, for example shardX/E48S28")
        return RoomRef(shard=shard, room=room)
    return RoomRef(shard=default_shard, room=value)


def context_from_env() -> RuntimeContext:
    token = os.environ.get("SCREEPS_AUTH_TOKEN")
    if not token:
        raise RuntimeError("SCREEPS_AUTH_TOKEN is required for live summary and alert commands")
    debounce = int(os.environ.get("SCREEPS_ALERT_DEBOUNCE_SECONDS", DEFAULT_DEBOUNCE_SECONDS))
    return RuntimeContext(
        base_http=os.environ.get("SCREEPS_API_URL", DEFAULT_API_URL).rstrip("/"),
        token=token,
        default_shard=os.environ.get("SCREEPS_SHARD", DEFAULT_SHARD),
        default_room=os.environ.get("SCREEPS_ROOM", DEFAULT_ROOM),
        owner=os.environ.get("SCREEPS_OWNER"),
        state_file=Path(os.environ.get("SCREEPS_MONITOR_STATE_FILE", str(DEFAULT_STATE_FILE))),
        cache_dir=Path(os.environ.get("SCREEPS_MONITOR_CACHE_DIR", str(DEFAULT_CACHE_DIR))),
        debounce_seconds=debounce,
    )


def get_json(base_http: str, token: str, path: str, params: dict[str, Any] | None = None) -> Any:
    url = base_http + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(
        url,
        headers={
            "X-Token": token,
            "User-Agent": "screeps-runtime-monitor/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=25) as response:
        return json.load(response)


def overview_username(overview: Any) -> str | None:
    if not isinstance(overview, dict):
        return None
    for path in (("username",), ("user", "username"), ("me", "username")):
        value: Any = overview
        for key in path:
            if not isinstance(value, dict):
                value = None
                break
            value = value.get(key)
        if isinstance(value, str):
            return value
    return None


def gametime_from_overview(overview: Any, shard: str) -> int | str | None:
    if not isinstance(overview, dict):
        return None
    shard_info = (overview.get("shards") or {}).get(shard)
    if not isinstance(shard_info, dict):
        return None
    gametimes = shard_info.get("gametimes")
    if isinstance(gametimes, list) and gametimes:
        return gametimes[0]
    return shard_info.get("gametime")


def discover_owned_rooms(ctx: RuntimeContext, forced_room: RoomRef | None) -> tuple[list[RoomRef], Any, list[str]]:
    warnings: list[str] = []
    overview: Any = None
    try:
        overview = get_json(ctx.base_http, ctx.token, "/api/user/overview")
    except Exception as exc:  # noqa: BLE001 - sanitized in user payload
        warnings.append(f"owned room discovery unavailable: {short_text(exc, 140)}")

    if forced_room:
        return [forced_room], overview, warnings

    rooms: list[RoomRef] = []
    if isinstance(overview, dict):
        shards = overview.get("shards")
        if isinstance(shards, dict):
            for shard in sorted(shards):
                shard_info = shards.get(shard)
                if not isinstance(shard_info, dict):
                    continue
                for room in shard_info.get("rooms") or []:
                    if isinstance(room, str):
                        rooms.append(RoomRef(shard=shard, room=room))

    if rooms:
        return rooms, overview, warnings

    fallback = RoomRef(ctx.default_shard, ctx.default_room)
    warnings.append(f"falling back to configured room {fallback.key}")
    return [fallback], overview, warnings


def terrain_cache_path(cache_dir: Path, ref: RoomRef) -> Path:
    return cache_dir / f"{ref.file_fragment}.json"


def load_cached_terrain(cache_path: Path) -> str | None:
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        terrain = payload.get("terrain")
        if isinstance(terrain, str) and len(terrain) == TERRAIN_CELLS:
            return terrain
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError):
        return None
    return None


def fetch_terrain(ctx: RuntimeContext, ref: RoomRef, warnings: list[str]) -> str:
    ctx.cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = terrain_cache_path(ctx.cache_dir, ref)
    cached = load_cached_terrain(cache_path)
    try:
        response = get_json(
            ctx.base_http,
            ctx.token,
            "/api/game/room-terrain",
            {"room": ref.room, "shard": ref.shard, "encoded": "1"},
        )
        terrain_entries = response.get("terrain") if isinstance(response, dict) else None
        if not terrain_entries:
            raise RuntimeError("room-terrain response did not include terrain")
        terrain = terrain_entries[0].get("terrain")
        if not isinstance(terrain, str) or len(terrain) != TERRAIN_CELLS:
            raise RuntimeError("room-terrain response had invalid encoded terrain")
        cache_path.write_text(
            json.dumps(
                {
                    "shard": ref.shard,
                    "room": ref.room,
                    "terrain": terrain,
                    "fetched_at": int(time.time()),
                },
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        return terrain
    except Exception as exc:  # noqa: BLE001 - keep cron alive when cached terrain exists
        if cached:
            warnings.append(f"using cached terrain for {ref.key}: {short_text(exc, 140)}")
            return cached
        raise


async def fetch_room_event(ctx: RuntimeContext, ref: RoomRef) -> dict[str, Any]:
    try:
        import websockets
    except ModuleNotFoundError as exc:
        raise RuntimeError("Python package 'websockets' is required") from exc

    uri = ctx.base_ws + "/socket/websocket"
    async with websockets.connect(uri, open_timeout=25) as websocket:
        await websocket.send("auth " + ctx.token)
        authenticated = False
        for _ in range(30):
            message = await asyncio.wait_for(websocket.recv(), timeout=25)
            if isinstance(message, bytes):
                message = message.decode()
            if isinstance(message, str) and message.startswith("auth "):
                authenticated = "ok" in message.lower()
                break
        if not authenticated:
            raise RuntimeError("websocket authentication did not complete")

        channel = f"room:{ref.shard}/{ref.room}"
        await websocket.send(f"subscribe {channel}")
        for _ in range(60):
            message = await asyncio.wait_for(websocket.recv(), timeout=25)
            if isinstance(message, bytes):
                message = message.decode()
            if not isinstance(message, str) or not message.startswith("["):
                continue
            try:
                payload = json.loads(message)
            except json.JSONDecodeError:
                continue
            if (
                isinstance(payload, list)
                and len(payload) >= 2
                and isinstance(payload[0], str)
                and payload[0] == channel
                and isinstance(payload[1], dict)
            ):
                return payload[1]
    raise RuntimeError(f"no room snapshot event received for {ref.key}")


def collect_snapshots(ctx: RuntimeContext, room_arg: str | None) -> tuple[list[RoomSnapshot], list[str]]:
    forced_room = parse_room_arg(room_arg, ctx.default_shard)
    refs, overview, warnings = discover_owned_rooms(ctx, forced_room)
    configured_owner = ctx.owner or overview_username(overview)
    snapshots: list[RoomSnapshot] = []

    for ref in refs:
        try:
            terrain = fetch_terrain(ctx, ref, warnings)
            event = asyncio.run(fetch_room_event(ctx, ref))
            objects = normalize_objects(event.get("objects"))
            owner = infer_owner(objects, configured_owner)
            tick = event.get("gameTime") or event.get("time") or gametime_from_overview(overview, ref.shard)
            snapshots.append(
                RoomSnapshot(
                    ref=ref,
                    terrain=terrain,
                    objects=objects,
                    tick=tick,
                    owner=owner,
                    info=event.get("info") if isinstance(event.get("info"), dict) else {},
                )
            )
        except Exception as exc:  # noqa: BLE001 - report room-level failures without secrets
            warnings.append(f"{ref.key} collection failed: {short_text(exc, 180)}")

    if not snapshots:
        raise RuntimeError("no room snapshots collected")
    return snapshots, warnings


def detect_hostile_creeps(objects: dict[str, dict[str, Any]], owner_username: str | None) -> list[dict[str, Any]]:
    hostiles: list[dict[str, Any]] = []
    for obj in objects.values():
        if not isinstance(obj, dict) or obj.get("type") != "creep":
            continue
        username = room_owner(obj)
        if obj.get("my") is False or (owner_username and username and username != owner_username):
            hostiles.append(obj)
    return hostiles


def structure_snapshot(objects: dict[str, dict[str, Any]], owner_username: str | None) -> dict[str, dict[str, Any]]:
    structures: dict[str, dict[str, Any]] = {}
    for object_id, obj in objects.items():
        if not isinstance(obj, dict):
            continue
        object_type = obj.get("type")
        if object_type not in STRUCTURE_TYPES:
            continue
        owned = is_owned_object(obj, owner_username)
        has_hits = isinstance(obj.get("hits"), (int, float)) and isinstance(obj.get("hitsMax"), (int, float))
        damageable = object_type in DAMAGEABLE_STRUCTURE_TYPES and has_hits
        critical = object_type in CRITICAL_STRUCTURE_TYPES and owned
        if not owned and not critical:
            continue
        if not damageable and not critical:
            continue
        structures[object_id] = {
            "type": object_type,
            "x": obj.get("x"),
            "y": obj.get("y"),
            "hits": obj.get("hits") if has_hits else None,
            "hitsMax": obj.get("hitsMax") if has_hits else None,
            "owned": owned,
            "damageable": damageable,
            "critical": critical,
        }
    return structures


def build_hostile_reason(ref: RoomRef, hostile: dict[str, Any]) -> dict[str, Any]:
    object_id = str(hostile.get("_id") or hostile.get("id") or f"{hostile.get('x')},{hostile.get('y')}")
    owner = room_owner(hostile) or "unknown"
    return {
        "kind": "hostile_creep",
        "room": ref.key,
        "object_id": object_id,
        "owner": owner,
        "x": hostile.get("x"),
        "y": hostile.get("y"),
        "message": f"hostile creep visible: {owner} at {hostile.get('x')},{hostile.get('y')}",
        "signature": f"hostile_creep:{ref.key}:{owner}:{object_id}",
    }


def build_damage_reason(ref: RoomRef, object_id: str, previous: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    old_hits = previous.get("hits")
    new_hits = current.get("hits")
    return {
        "kind": "structure_damage",
        "room": ref.key,
        "object_id": object_id,
        "structure_type": current.get("type"),
        "x": current.get("x"),
        "y": current.get("y"),
        "previous_hits": old_hits,
        "current_hits": new_hits,
        "delta": old_hits - new_hits if isinstance(old_hits, (int, float)) and isinstance(new_hits, (int, float)) else None,
        "message": (
            f"{current.get('type')} hits decreased "
            f"{old_hits}->{new_hits} at {current.get('x')},{current.get('y')}"
        ),
        "signature": f"structure_damage:{ref.key}:{object_id}",
    }


def build_missing_reason(ref: RoomRef, object_id: str, previous: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "critical_structure_missing",
        "room": ref.key,
        "object_id": object_id,
        "structure_type": previous.get("type"),
        "x": previous.get("x"),
        "y": previous.get("y"),
        "message": f"critical {previous.get('type')} disappeared from {previous.get('x')},{previous.get('y')}",
        "signature": f"critical_structure_missing:{ref.key}:{object_id}",
    }


def evaluate_room_alert(
    snapshot: RoomSnapshot,
    previous_room_state: dict[str, Any] | None,
    now: int,
    debounce_seconds: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    previous_room_state = previous_room_state or {}
    previous_structures = previous_room_state.get("structures")
    if not isinstance(previous_structures, dict):
        previous_structures = {}
    previous_alerts = previous_room_state.get("alerts")
    if not isinstance(previous_alerts, dict):
        previous_alerts = {}

    current_structures = structure_snapshot(snapshot.objects, snapshot.owner)
    baseline_established = bool(previous_room_state.get("baseline_established"))
    detected: list[dict[str, Any]] = []

    for hostile in detect_hostile_creeps(snapshot.objects, snapshot.owner):
        detected.append(build_hostile_reason(snapshot.ref, hostile))

    if baseline_established:
        for object_id, current in current_structures.items():
            previous = previous_structures.get(object_id)
            if not isinstance(previous, dict):
                continue
            if not (current.get("owned") and current.get("damageable")):
                continue
            old_hits = previous.get("hits")
            new_hits = current.get("hits")
            if isinstance(old_hits, (int, float)) and isinstance(new_hits, (int, float)) and new_hits < old_hits:
                detected.append(build_damage_reason(snapshot.ref, object_id, previous, current))

        for object_id, previous in previous_structures.items():
            if not isinstance(previous, dict):
                continue
            if previous.get("owned") and previous.get("critical") and object_id not in current_structures:
                detected.append(build_missing_reason(snapshot.ref, object_id, previous))

    emitted: list[dict[str, Any]] = []
    suppressed: list[dict[str, Any]] = []
    alerts = dict(previous_alerts)
    for reason in detected:
        signature = str(reason.get("signature"))
        last_seen = alerts.get(signature)
        if isinstance(last_seen, (int, float)) and now - int(last_seen) < debounce_seconds:
            suppressed.append(reason)
            continue
        alerts[signature] = now
        emitted.append(reason)

    next_state = {
        "baseline_established": True,
        "observed_at": now,
        "tick": snapshot.tick,
        "owner": snapshot.owner,
        "structures": current_structures,
        "alerts": alerts,
    }
    return emitted, suppressed, next_state


def severity_max(left: str, right: str) -> str:
    return left if TACTICAL_SEVERITY_RANK.get(left, 0) >= TACTICAL_SEVERITY_RANK.get(right, 0) else right


def tactical_rule(category: str) -> dict[str, Any]:
    return TACTICAL_CATEGORY_RULES.get(category, TACTICAL_CATEGORY_RULES["unknown_runtime_alert"])


def tactical_reason_kind(reason: dict[str, Any]) -> str:
    for key in ("kind", "category", "type"):
        value = reason.get(key)
        if isinstance(value, str) and value:
            return value
    return "unknown_runtime_alert"


def number_from_reason(reason: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = reason.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return None


def infer_tactical_categories(reason: dict[str, Any]) -> list[str]:
    kind = tactical_reason_kind(reason)
    lowered_kind = kind.lower()
    message = str(reason.get("message") or "").lower()
    structure_type = str(reason.get("structure_type") or reason.get("structureType") or "").lower()
    categories: list[str] = []

    categories.extend(TACTICAL_REASON_CATEGORY_MAP.get(kind, []))
    categories.extend(TACTICAL_REASON_CATEGORY_MAP.get(lowered_kind, []))

    if "hostile" in lowered_kind or "hostile" in message:
        categories.append("hostiles")
    if "downgrade" in lowered_kind or "downgrade" in message:
        categories.append("downgrade_risk")
    if "telemetry" in lowered_kind or "runtime-summary" in lowered_kind or "loop_exception" in lowered_kind:
        categories.append("telemetry_silence")
    if "silence" in lowered_kind or "silent" in lowered_kind:
        categories.append("telemetry_silence")
    if "monitor" in lowered_kind and ("miss" in lowered_kind or "spam" in lowered_kind):
        categories.append("monitor_integrity")
    if "damage" in lowered_kind:
        categories.append("owned_structure_damage")
    if "missing" in lowered_kind or "disappear" in lowered_kind or "destroyed" in lowered_kind:
        categories.append("owned_structure_disappearance")

    current_hits = number_from_reason(reason, "current_hits", "currentHits", "hits")
    if structure_type == "spawn" and (
        "missing" in lowered_kind
        or "destroyed" in lowered_kind
        or "collapse" in lowered_kind
        or current_hits == 0
    ):
        categories.append("spawn_collapse")

    if not categories:
        categories.append("unknown_runtime_alert")
    return sorted(set(categories), key=lambda category: (-TACTICAL_SEVERITY_RANK.get(tactical_rule(category)["severity"], 0), category))


def category_severity(category: str, reason: dict[str, Any]) -> str:
    severity = str(tactical_rule(category)["severity"])
    if category == "downgrade_risk":
        ticks = number_from_reason(reason, "ticks_to_downgrade", "ticksToDowngrade", "remaining_ticks", "remainingTicks")
        if ticks is not None and ticks <= 2000:
            return "critical"
    if category == "owned_structure_damage":
        hits = number_from_reason(reason, "current_hits", "currentHits", "hits")
        hits_max = number_from_reason(reason, "hitsMax", "hits_max")
        structure_type = str(reason.get("structure_type") or reason.get("structureType") or "").lower()
        if structure_type in {"spawn", "tower", "storage", "terminal"} and hits is not None and hits_max and hits / hits_max <= 0.25:
            return "critical"
    return severity


def tactical_source_summary(alert_payload: dict[str, Any], reasons: list[dict[str, Any]]) -> dict[str, Any]:
    rooms = alert_payload.get("rooms")
    warnings = alert_payload.get("warnings")
    summary = {
        "ok": bool(alert_payload.get("ok")),
        "mode": alert_payload.get("mode") if isinstance(alert_payload.get("mode"), str) else None,
        "alert": bool(alert_payload.get("alert")),
        "reason_count": len(reasons),
        "rooms": [room for room in rooms if isinstance(room, str)] if isinstance(rooms, list) else [],
        "suppressed": bool(alert_payload.get("suppressed")),
        "suppressed_count": int(alert_payload.get("suppressed_count", 0) or 0),
        "warning_count": len(warnings) if isinstance(warnings, list) else 0,
    }
    if alert_payload.get("ok") is False:
        error = alert_payload.get("error")
        if isinstance(error, str):
            summary["error_excerpt"] = short_text(redact_secrets(error, [os.environ.get("SCREEPS_AUTH_TOKEN", "")]), 220)
    return summary


def normalize_tactical_reasons(alert_payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_reasons = alert_payload.get("reasons")
    if not isinstance(raw_reasons, list):
        return []
    return [dict(reason) for reason in raw_reasons if isinstance(reason, dict)]


def append_unique_action(action_ids: list[str], action_id: str) -> None:
    if action_id not in action_ids:
        action_ids.append(action_id)


def tactical_action_payload(action_id: str, priority: int) -> dict[str, Any]:
    action = dict(TACTICAL_ACTION_CATALOG[action_id])
    action["id"] = action_id
    action["priority"] = priority
    return action


def build_tactical_response_report(alert_payload: dict[str, Any]) -> dict[str, Any]:
    reasons = normalize_tactical_reasons(alert_payload)
    source = tactical_source_summary(alert_payload, reasons)
    triggers: list[dict[str, Any]] = []
    category_set: set[str] = set()
    action_ids: list[str] = []
    severity = "none"

    if alert_payload.get("ok") is False:
        synthetic_reason = {
            "kind": "telemetry_silence",
            "message": "runtime monitor returned ok=false",
        }
        reasons = [synthetic_reason, *reasons]
    elif alert_payload.get("alert") is True and not reasons:
        reasons = [
            {
                "kind": "unknown_runtime_alert",
                "message": "runtime monitor returned alert=true without reason details",
            }
        ]

    for reason in reasons:
        categories = infer_tactical_categories(reason)
        for category in categories:
            rule = tactical_rule(category)
            category_set.add(category)
            category_sev = category_severity(category, reason)
            severity = severity_max(severity, category_sev)
            for action_id in rule["actions"]:
                append_unique_action(action_ids, action_id)
            triggers.append(
                {
                    "category": category,
                    "severity": category_sev,
                    "decision": rule["decision"],
                    "reason_kind": tactical_reason_kind(reason),
                    "room": reason.get("room"),
                    "object_id": reason.get("object_id"),
                    "structure_type": reason.get("structure_type") or reason.get("structureType"),
                    "message": short_text(redact_secrets(str(reason.get("message") or tactical_reason_kind(reason)), [os.environ.get("SCREEPS_AUTH_TOKEN", "")]), 180),
                }
            )

    emergency = bool(triggers)
    if not emergency:
        action_ids = ["return_silent"]

    categories = sorted(category_set, key=lambda category: (-TACTICAL_SEVERITY_RANK.get(tactical_rule(category)["severity"], 0), category))
    next_actions = [tactical_action_payload(action_id, (index + 1) * 10) for index, action_id in enumerate(action_ids)]
    scheduler = {
        "should_post": emergency,
        "direct_discord_send": False,
        "recommended_output": "TACTICAL_EMERGENCY_REPORT" if emergency else "[SILENT]",
        "silent_token": None if emergency else "[SILENT]",
    }

    return {
        "ok": True,
        "mode": "tactical-response",
        "source": source,
        "emergency": emergency,
        "silent": not emergency,
        "severity": severity,
        "categories": categories,
        "triggers": triggers,
        "next_actions": next_actions,
        "scheduler": scheduler,
        "hotfix_gate": TACTICAL_HOTFIX_GATE if emergency else [],
        "report_template": {
            "title": "Tactical Emergency Report",
            "required_fields": [
                "source alert JSON path or artifact id",
                "room and shard",
                "severity and categories",
                "evidence snapshot paths",
                "decision: observe/open issue/Codex hotfix/rollback/owner action",
                "verification and post-release monitor result",
            ],
        },
    }


def load_tactical_alert_payload(input_path: str | None) -> dict[str, Any]:
    if not input_path or input_path == "-":
        raw = sys.stdin.read()
    else:
        raw = Path(input_path).read_text(encoding="utf-8")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"tactical-response input must be JSON: {exc.msg}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("tactical-response input must be a JSON object")
    return payload


def load_state(path: Path) -> dict[str, Any]:
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
        return state if isinstance(state, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(state, indent=2, sort_keys=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=str(path.parent), delete=False) as handle:
        handle.write(payload)
        handle.write("\n")
        temp_name = handle.name
    os.replace(temp_name, path)


def structure_objects(objects: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        obj
        for obj in objects.values()
        if isinstance(obj, dict) and obj.get("type") in STRUCTURE_TYPES
    ]


def lowest_hits_structure(objects: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    candidates = [
        obj
        for obj in structure_objects(objects)
        if isinstance(obj.get("hits"), (int, float)) and isinstance(obj.get("hitsMax"), (int, float))
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda obj: pct(obj.get("hits"), obj.get("hitsMax")))


def object_center(obj: dict[str, Any], map_x: float, map_y: float, cell: float) -> tuple[float, float]:
    return map_x + float(obj.get("x", 0)) * cell + cell / 2, map_y + float(obj.get("y", 0)) * cell + cell / 2


def render_room_svg(snapshot: RoomSnapshot, render_mode: str, alert_reasons: list[dict[str, Any]]) -> str:
    objects = snapshot.objects
    counts = snapshot.counts
    creeps = [obj for obj in objects.values() if isinstance(obj, dict) and obj.get("type") == "creep"]
    hostiles = detect_hostile_creeps(objects, snapshot.owner)
    sources = [obj for obj in objects.values() if isinstance(obj, dict) and obj.get("type") == "source"]
    structures = structure_objects(objects)
    spawn = next((obj for obj in structures if obj.get("type") == "spawn"), None)
    controller = next((obj for obj in structures if obj.get("type") == "controller"), None)
    mineral = next((obj for obj in objects.values() if isinstance(obj, dict) and obj.get("type") == "mineral"), None)
    lowest = lowest_hits_structure(objects)
    alert_emphasis = render_mode == "alert"
    accent = "#c8452f" if alert_emphasis else "#111111"
    accent_soft = "#f0d9d3" if alert_emphasis else "#efece5"
    badge = "ALERT" if alert_reasons else ("CHECK" if alert_emphasis else "LIVE")
    side_title = "Alert reading" if alert_emphasis else "Runtime reading"

    W, H = 1440, 900
    card_x, card_y = 54, 50
    card_w, card_h = 1332, 800
    map_x, map_y = 86, 142
    cell = 13.4
    map_size = cell * ROOM_SIZE
    side_x = 875

    svg: list[str] = []

    def add(value: str) -> None:
        svg.append(value)

    def text(x: float, y: float, content: Any, cls: str = "", **attrs: Any) -> None:
        attr = " ".join(f'{key.replace("_", "-")}="{esc(value)}"' for key, value in attrs.items())
        add(f'<text x="{x}" y="{y}" class="{cls}" {attr}>{esc(content)}</text>')

    def center(obj: dict[str, Any]) -> tuple[float, float]:
        return object_center(obj, map_x, map_y, cell)

    def dot(
        obj: dict[str, Any],
        fill: str,
        radius: float,
        stroke: str = "#111",
        label: str | None = None,
        dx: float = 14,
        dy: float = -10,
        width: float = 1.4,
    ) -> None:
        x, y = center(obj)
        add(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="{width}"/>')
        if label:
            add(f'<path d="M{x+radius+2:.1f} {y:.1f} L{x+dx-4:.1f} {y+dy:.1f}" stroke="{stroke}" stroke-opacity=".55"/>')
            text(x + dx, y + dy + 4, label, "caption")

    def square(obj: dict[str, Any], fill: str, size: float, stroke: str = "#111", opacity: str = "1") -> None:
        x, y = center(obj)
        half = size / 2
        add(
            f'<rect x="{x-half:.2f}" y="{y-half:.2f}" width="{size:.2f}" height="{size:.2f}" '
            f'rx="1.4" fill="{fill}" fill-opacity="{opacity}" stroke="{stroke}" stroke-width=".9"/>'
        )

    add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
    add(
        """<defs>
      <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity=".03"/><feDropShadow dx="0" dy="16" stdDeviation="18" flood-opacity=".07"/></filter>
      <style>
        .sans{font-family:Inter,Helvetica,Arial,sans-serif}.serif{font-family:Georgia,Times New Roman,serif}.mono{font-family:JetBrains Mono,IBM Plex Mono,Courier New,monospace}.kicker{font:700 10px Inter,Helvetica,Arial,sans-serif;letter-spacing:.24em;fill:#6b6359}.body{font:400 13px Inter,Helvetica,Arial,sans-serif;fill:#5f5a54}.small{font:500 12px Inter,Helvetica,Arial,sans-serif;fill:#6b6359}.metricNum{font:500 32px Georgia,Times New Roman,serif;fill:#111}.metricLabel{font:700 9px Inter,Helvetica,Arial,sans-serif;letter-spacing:.18em;fill:#8a8379}.coord{font:500 8px JetBrains Mono,Courier New,monospace;fill:#8f887e}.caption{font:500 12px Inter,Helvetica,Arial,sans-serif;fill:#3e3a35}.legend{font:500 11px Inter,Helvetica,Arial,sans-serif;fill:#6b6359}.dense{font:500 12px Inter,Helvetica,Arial,sans-serif;fill:#3e3a35}.denseMuted{font:400 11px Inter,Helvetica,Arial,sans-serif;fill:#6b6359}
      </style>
    </defs>"""
    )
    add('<rect width="100%" height="100%" fill="#efece5"/>')
    add(f'<rect x="{card_x}" y="{card_y}" width="{card_w}" height="{card_h}" rx="8" fill="#fbfaf7" filter="url(#shadow)"/>')
    add(f'<path d="M{card_x} {card_y+66} H{card_x+card_w}" stroke="#e6e1d8"/>')
    if alert_emphasis:
        add(f'<rect x="{card_x+1}" y="{card_y+1}" width="{card_w-2}" height="{card_h-2}" rx="8" fill="none" stroke="{accent}" stroke-width="2.2"/>')
    add(f'<rect x="{card_x+24}" y="{card_y+22}" width="68" height="24" rx="3" fill="{accent_soft}" stroke="{accent}" stroke-opacity=".35"/>')
    text(card_x + 58, card_y + 38, badge, "kicker", text_anchor="middle", fill=accent)
    text(card_x + 110, card_y + 39, "Screeps room snapshot", "small")
    text(card_x + card_w - 24, card_y + 39, f"{snapshot.ref.key} · tick {snapshot.tick or 'unknown'}", "small", text_anchor="end")

    text(96, 112, snapshot.ref.key, "kicker")
    text(96, 132, f"tick {snapshot.tick or 'unknown'} · official-client room feed", "small")
    text(side_x, 112, side_title, "kicker")
    add(f'<path d="M{side_x} 132 H{card_x+card_w-72}" stroke="{accent}" stroke-opacity=".75"/>')

    add(f'<rect x="{map_x-18}" y="{map_y-18}" width="{map_size+36}" height="{map_size+36}" fill="#f3f0ea" stroke="#d8d0c4"/>')
    for y in range(ROOM_SIZE):
        for x in range(ROOM_SIZE):
            value = terrain_flags(snapshot.terrain, x, y)
            fill = "#353632" if value & 1 else ("#b7b48e" if value & 2 else "#e4ded2")
            add(f'<rect x="{map_x+x*cell:.2f}" y="{map_y+y*cell:.2f}" width="{cell+.04:.2f}" height="{cell+.04:.2f}" fill="{fill}"/>')
    for index in range(0, ROOM_SIZE + 1, 5):
        opacity = ".45" if index % 10 == 0 else ".22"
        add(f'<path d="M{map_x+index*cell:.2f} {map_y} V{map_y+map_size}" stroke="#fff" stroke-opacity="{opacity}"/>')
        add(f'<path d="M{map_x} {map_y+index*cell:.2f} H{map_x+map_size}" stroke="#fff" stroke-opacity="{opacity}"/>')
        if index < ROOM_SIZE and index % 10 == 0:
            text(map_x + index * cell + 2, map_y - 7, index, "coord")
            text(map_x - 20, map_y + index * cell + 11, index, "coord")
    add(f'<rect x="{map_x}" y="{map_y}" width="{map_size}" height="{map_size}" fill="none" stroke="#111" stroke-width="1.2"/>')

    for obj in structures:
        object_type = obj.get("type")
        if object_type == "road":
            square(obj, "#a69b8d", 4.2, stroke="#8c8174", opacity=".72")
        elif object_type == "rampart":
            square(obj, "#84ad83", 8.8, stroke="#496f4d", opacity=".45")
        elif object_type == "constructedWall":
            square(obj, "#292a27", 8.8, stroke="#111", opacity=".88")
        elif object_type == "extension":
            square(obj, "#71956e", 7.0, stroke="#111", opacity=".95")
        elif object_type == "tower":
            square(obj, "#6f6379", 9.0, stroke="#111", opacity=".98")
        elif object_type in {"storage", "terminal", "factory", "link", "lab"}:
            square(obj, "#9a8165", 9.5, stroke="#111", opacity=".98")
        elif object_type != "spawn":
            square(obj, "#b9a98f", 6.4, stroke="#111", opacity=".9")

    for index, source in enumerate(sources, 1):
        dot(source, "#d3a400", 6.5, label=f"Source {index}", dx=16, dy=-12 if index == 1 else -18)
    if mineral:
        dot(mineral, "#8060a8", 6, label="Mineral", dx=-72, dy=-12)
    if controller:
        dot(controller, "#2f6e91", 7, label=f"Controller R{controller.get('level', 0)}", dx=18, dy=26)
    if spawn:
        dot(spawn, "#2f8c5a", 8, label="Spawn", dx=16, dy=-14)

    alert_object_ids = {str(reason.get("object_id")) for reason in alert_reasons}
    for creep in creeps:
        hostile = creep in hostiles
        object_id = str(creep.get("_id") or creep.get("id") or "")
        dot(creep, "#cf4327" if hostile else "#fffaf0", 4.5, stroke="#cf4327" if hostile else "#111")
        if hostile or object_id in alert_object_ids:
            x, y = center(creep)
            add(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="10.2" fill="none" stroke="#cf4327" stroke-width="1.6"/>')

    for obj in structures:
        object_id = str(obj.get("_id") or obj.get("id") or "")
        if object_id in alert_object_ids:
            x, y = center(obj)
            add(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="12.5" fill="none" stroke="#cf4327" stroke-width="1.8"/>')

    metrics = [
        ("objects", len(objects)),
        ("creeps", counts.get("creep", 0)),
        ("structures", len(structures)),
        ("hostiles", len(hostiles)),
    ]
    metric_y = 172
    text(side_x, metric_y, "Snapshot", "kicker")
    metric_y += 26
    for index, (label, value) in enumerate(metrics):
        x = side_x + (index % 2) * 170
        y = metric_y + (index // 2) * 30
        text(x, y, label.upper(), "metricLabel")
        text(x + 124, y, value, "dense", text_anchor="end", fill=accent if label == "hostiles" and value else "#3e3a35")
        add(f'<path d="M{x} {y+12} H{x+132}" stroke="#e0d9ce"/>')

    status_y = 290
    text(side_x, status_y, "Objects and status", "kicker")
    hit_text = "not visible"
    if lowest:
        hit_text = f"{lowest.get('type')} {lowest.get('hits')}/{lowest.get('hitsMax')} at {lowest.get('x')},{lowest.get('y')}"
    alert_text = "No active alert"
    if alert_reasons:
        alert_text = short_text(alert_reasons[0].get("message", "alert"), 52)
    elif alert_emphasis:
        alert_text = "Forced alert-image render; no active alert"
    rows = [
        ("Spawn", f"{spawn.get('hits')}/{spawn.get('hitsMax')} at {spawn.get('x')},{spawn.get('y')}" if spawn else "not visible"),
        ("Controller", f"R{controller.get('level')} at {controller.get('x')},{controller.get('y')}" if controller else "not visible"),
        ("Alert", alert_text),
        ("Lowest hits", hit_text),
        ("Feed", "fresh websocket room event + cached terrain"),
    ]
    row_y = status_y + 26
    for key, value in rows:
        text(side_x, row_y, key.upper(), "metricLabel")
        text(side_x + 108, row_y, value, "dense", fill=accent if key == "Alert" and (alert_reasons or alert_emphasis) else "#3e3a35")
        add(f'<path d="M{side_x} {row_y+15} H{card_x+card_w-72}" stroke="#e0d9ce"/>')
        row_y += 27

    row_y += 14
    text(side_x, row_y, "Object mix", "kicker")
    row_y += 24
    mix = [
        ("spawn", counts.get("spawn", 0)),
        ("controller", counts.get("controller", 0)),
        ("creep", counts.get("creep", 0)),
        ("source", counts.get("source", 0)),
        ("mineral", counts.get("mineral", 0)),
        ("hostile", len(hostiles)),
    ]
    for index, (name, value) in enumerate(mix):
        x = side_x + (index % 2) * 170
        y = row_y + (index // 2) * 25
        text(x, y, name.upper(), "metricLabel")
        text(x + 118, y, value, "dense", text_anchor="end", fill=accent if name == "hostile" and value else "#3e3a35")
    row_y += 86

    add(f'<path d="M{side_x} {row_y} H{card_x+card_w-72}" stroke="{accent}" stroke-opacity=".65"/>')
    text(side_x, row_y + 28, "summary cadence", "metricLabel")
    text(side_x + 160, row_y + 28, "cron-friendly snapshot", "dense")
    text(side_x, row_y + 52, "alert treatment", "metricLabel")
    text(side_x + 160, row_y + 52, "red emphasis + debounced state", "dense")
    text(side_x, row_y + 76, "delivery", "metricLabel")
    text(side_x + 160, row_y + 76, "runtime-summary / runtime-alerts", "dense")

    reason_y = row_y + 118
    if alert_reasons:
        text(side_x, reason_y, "Alert reasons", "kicker", fill=accent)
        reason_y += 23
        for reason in alert_reasons[:5]:
            text(side_x, reason_y, short_text(reason.get("message", reason.get("kind")), 58), "dense", fill=accent)
            reason_y += 21

    legend_y = card_y + card_h - 44
    legend_x = 96
    legend = [
        ("#e4ded2", "plain"),
        ("#b7b48e", "swamp"),
        ("#353632", "wall"),
        ("#2f8c5a", "spawn"),
        ("#d3a400", "source"),
        ("#fffaf0", "creep"),
        ("#cf4327", "hostile"),
    ]
    for color, label in legend:
        add(f'<rect x="{legend_x}" y="{legend_y-11}" width="18" height="18" fill="{color}" stroke="#111" stroke-opacity=".45"/>')
        text(legend_x + 26, legend_y + 2, label, "legend")
        legend_x += 110
    footer = "alert state uses local baseline + debounce" if alert_emphasis else "designed for quiet summaries; alert state swaps in red emphasis"
    text(card_x + card_w - 72, legend_y + 2, footer, "legend", text_anchor="end")

    add("</svg>")
    return "\n".join(svg)


def render_svg_to_png(svg_path: Path, png_path: Path, width: int = 1440, height: int = 900) -> None:
    png_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        import cairosvg  # type: ignore[import-not-found]

        cairosvg.svg2png(url=str(svg_path), write_to=str(png_path), output_width=width, output_height=height)
    except ModuleNotFoundError:
        pass
    else:
        return

    for command in ("rsvg-convert", "magick", "convert", "inkscape"):
        executable = shutil.which(command)
        if not executable:
            continue
        if command == "rsvg-convert":
            args = [executable, "-w", str(width), "-h", str(height), "-o", str(png_path), str(svg_path)]
        elif command == "magick":
            args = [executable, str(svg_path), str(png_path)]
        elif command == "convert":
            args = [executable, str(svg_path), str(png_path)]
        else:
            args = [executable, str(svg_path), "--export-type=png", f"--export-filename={png_path}"]
        subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if png_path.exists() and png_path.stat().st_size > 0:
            return

    node = shutil.which("node")
    if not node:
        raise RuntimeError("no SVG-to-PNG renderer available; install cairosvg, rsvg-convert, ImageMagick, Inkscape, or Playwright")

    node_script = r"""
const fs = require('fs');
let playwright = null;
for (const candidate of [process.env.PLAYWRIGHT_NODE_PATH, 'playwright', '/root/.hermes/hermes-agent/node_modules/playwright']) {
  if (!candidate) continue;
  try {
    playwright = require(candidate);
    break;
  } catch (error) {}
}
if (!playwright) {
  console.error('Playwright is unavailable for SVG-to-PNG rendering');
  process.exit(2);
}
const [svgPath, pngPath, widthText, heightText] = process.argv.slice(2);
const width = Number(widthText);
const height = Number(heightText);
const svg = fs.readFileSync(svgPath, 'utf8');
const launchOptions = {
  headless: true,
  chromiumSandbox: false,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
};
for (const executablePath of [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome']) {
  if (executablePath && fs.existsSync(executablePath)) {
    launchOptions.executablePath = executablePath;
    break;
  }
}
(async () => {
  const browser = await playwright.chromium.launch(launchOptions);
  const page = await browser.newPage({viewport: {width, height}, deviceScaleFactor: 1});
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#efece5">${svg}</body></html>`, {waitUntil: 'load'});
  await page.screenshot({path: pngPath, fullPage: false, omitBackground: false});
  await browser.close();
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
"""
    with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=False) as handle:
        handle.write(node_script)
        script_path = handle.name
    try:
        try:
            subprocess.run(
                [node, script_path, str(svg_path), str(png_path), str(width), str(height)],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        except subprocess.CalledProcessError as exc:
            detail = short_text((exc.stderr or exc.stdout or str(exc)).strip(), 2400)
            raise RuntimeError(f"Playwright SVG-to-PNG rendering failed: {detail}") from exc
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass
    if not png_path.exists() or png_path.stat().st_size <= 0:
        raise RuntimeError("SVG-to-PNG renderer did not create a PNG")


def render_room_snapshot(
    snapshot: RoomSnapshot,
    out_dir: Path,
    render_mode: str,
    alert_reasons: list[dict[str, Any]] | None = None,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    alert_reasons = alert_reasons or []
    prefix = "alert" if render_mode == "alert" else "summary"
    stem = f"{prefix}-{snapshot.ref.file_fragment}"
    svg_path = out_dir / f"{stem}.svg"
    png_path = out_dir / f"{stem}.png"
    svg_path.write_text(render_room_svg(snapshot, render_mode, alert_reasons), encoding="utf-8")
    render_svg_to_png(svg_path, png_path)
    return png_path.resolve()


def room_summary(snapshot: RoomSnapshot, image: str | None = None) -> dict[str, Any]:
    hostiles = detect_hostile_creeps(snapshot.objects, snapshot.owner)
    summary = {
        "room": snapshot.ref.key,
        "shard": snapshot.ref.shard,
        "name": snapshot.ref.room,
        "tick": snapshot.tick,
        "objects": len(snapshot.objects),
        "creeps": snapshot.counts.get("creep", 0),
        "structures": len(structure_objects(snapshot.objects)),
        "hostiles": len(hostiles),
        "owner": snapshot.owner,
    }
    if image:
        summary["image"] = image
    return summary


def summarize_rooms(snapshots: list[RoomSnapshot]) -> dict[str, Any]:
    return {
        "room_count": len(snapshots),
        "objects": sum(len(snapshot.objects) for snapshot in snapshots),
        "creeps": sum(snapshot.counts.get("creep", 0) for snapshot in snapshots),
        "hostiles": sum(len(detect_hostile_creeps(snapshot.objects, snapshot.owner)) for snapshot in snapshots),
    }


def redact_secrets(text: str, secrets: list[str]) -> str:
    redacted = text
    for secret in secrets:
        if secret and len(secret) >= 6:
            redacted = redacted.replace(secret, "[REDACTED]")
    redacted = re.sub(r"(?i)(x-token|authorization)\s*[:=]\s*(?:bearer\s+)?[^,\s}]+", r"\1=[REDACTED]", redacted)
    redacted = re.sub(r"(?i)(token|password|secret)\s*[:=]\s*[^,\s}]+", r"\1=[REDACTED]", redacted)
    redacted = re.sub(r"/root/\.secret/[^,\s\"']+", "[REDACTED_SECRET_PATH]", redacted)
    return redacted


def safe_json_dumps(payload: dict[str, Any], secrets: list[str]) -> str:
    rendered = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    for secret in secrets:
        if secret and len(secret) >= 6 and secret in rendered:
            raise RuntimeError("refusing to print JSON containing a configured secret")
    return rendered


def print_json(payload: dict[str, Any], secrets: list[str]) -> None:
    sys.stdout.write(safe_json_dumps(payload, secrets))
    sys.stdout.write("\n")


def command_summary(args: argparse.Namespace) -> int:
    ctx = context_from_env()
    snapshots, warnings = collect_snapshots(ctx, args.room)
    images: list[str] = []
    room_summaries: list[dict[str, Any]] = []
    out_dir = Path(args.out_dir)
    for snapshot in snapshots:
        image = str(render_room_snapshot(snapshot, out_dir, "summary"))
        images.append(image)
        room_summaries.append(room_summary(snapshot, image=image))

    payload = {
        "ok": True,
        "mode": "summary",
        "summary": summarize_rooms(snapshots),
        "images": images,
        "rooms": [snapshot.ref.key for snapshot in snapshots],
        "room_summaries": room_summaries,
        "warnings": warnings,
    }
    print_json(payload, [ctx.token])
    return 0


def command_alert(args: argparse.Namespace) -> int:
    ctx = context_from_env()
    snapshots, warnings = collect_snapshots(ctx, args.room)
    state = load_state(ctx.state_file)
    rooms_state = state.get("rooms")
    if not isinstance(rooms_state, dict):
        rooms_state = {}
    now = int(time.time())

    emitted_by_room: dict[str, list[dict[str, Any]]] = {}
    all_emitted: list[dict[str, Any]] = []
    all_suppressed: list[dict[str, Any]] = []
    for snapshot in snapshots:
        previous = rooms_state.get(snapshot.ref.key)
        if not isinstance(previous, dict):
            previous = {}
        emitted, suppressed, next_room_state = evaluate_room_alert(
            snapshot,
            previous,
            now=now,
            debounce_seconds=ctx.debounce_seconds,
        )
        rooms_state[snapshot.ref.key] = next_room_state
        if emitted:
            emitted_by_room[snapshot.ref.key] = emitted
            all_emitted.extend(emitted)
        all_suppressed.extend(suppressed)

    state = {
        "version": 1,
        "updated_at": now,
        "debounce_seconds": ctx.debounce_seconds,
        "rooms": rooms_state,
    }
    save_state(ctx.state_file, state)

    images: list[str] = []
    out_dir = Path(args.out_dir)
    if all_emitted:
        for snapshot in snapshots:
            reasons = emitted_by_room.get(snapshot.ref.key, [])
            if reasons:
                images.append(str(render_room_snapshot(snapshot, out_dir, "alert", reasons)))
    elif args.force_alert_image:
        for snapshot in snapshots:
            images.append(str(render_room_snapshot(snapshot, out_dir, "alert", [])))

    payload = {
        "ok": True,
        "mode": "alert",
        "alert": bool(all_emitted),
        "reasons": all_emitted,
        "images": images,
        "rooms": [snapshot.ref.key for snapshot in snapshots],
        "summary": summarize_rooms(snapshots),
        "state_file": str(ctx.state_file),
        "debounce_seconds": ctx.debounce_seconds,
        "suppressed": bool(all_suppressed),
        "suppressed_count": len(all_suppressed),
        "force_alert_image": bool(args.force_alert_image),
        "warnings": warnings,
    }
    print_json(payload, [ctx.token])
    return 0


def command_tactical_response(args: argparse.Namespace) -> int:
    payload = load_tactical_alert_payload(args.input)
    response = build_tactical_response_report(payload)
    print_json(response, [os.environ.get("SCREEPS_AUTH_TOKEN", "")])
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Render Screeps runtime summary and alert monitor images.")
    subcommands = parser.add_subparsers(dest="command", required=True)

    def add_live_options(subparser: argparse.ArgumentParser) -> None:
        subparser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR), help=f"artifact directory (default: {DEFAULT_OUT_DIR})")
        subparser.add_argument("--room", help="optional single room selector, preferably shard/room")
        subparser.add_argument("--format", choices=["json"], default="json", help="output format")

    summary = subcommands.add_parser("summary", help="render summary PNGs for owned rooms")
    add_live_options(summary)
    summary.set_defaults(func=command_summary)

    alert = subcommands.add_parser("alert", help="evaluate alert rules and render alert PNGs when needed")
    add_live_options(alert)
    alert.add_argument("--force-alert-image", action="store_true", help="render alert-style image even when no alert is emitted")
    alert.set_defaults(func=command_alert)

    tactical_response = subcommands.add_parser(
        "tactical-response",
        help="classify runtime alert JSON into a bounded tactical emergency response payload",
    )
    tactical_response.add_argument(
        "--input",
        default="-",
        help="runtime alert JSON path, or '-' for stdin (default: stdin)",
    )
    tactical_response.add_argument("--format", choices=["json"], default="json", help="output format")
    tactical_response.set_defaults(func=command_tactical_response)

    self_test = subcommands.add_parser("self-test", help="run offline pure-function tests")
    self_test.set_defaults(func=command_self_test)
    return parser


def command_self_test(_args: argparse.Namespace) -> int:
    import unittest

    class TerrainTests(unittest.TestCase):
        def test_terrain_counts_and_flags(self) -> None:
            terrain = list("0" * TERRAIN_CELLS)
            terrain[0] = "1"
            terrain[1] = "2"
            terrain[2] = "3"
            terrain_text = "".join(terrain)
            self.assertEqual(terrain_flags(terrain_text, 0, 0), 1)
            self.assertEqual(terrain_flags(terrain_text, 1, 0), 2)
            self.assertEqual(terrain_counts(terrain_text), {"plain": 2497, "swamp": 1, "wall": 2})

    class AlertTests(unittest.TestCase):
        def make_snapshot(self, objects: dict[str, dict[str, Any]]) -> RoomSnapshot:
            return RoomSnapshot(
                ref=RoomRef("shardTest", "E1N1"),
                terrain="0" * TERRAIN_CELLS,
                objects=normalize_objects(objects),
                tick=1,
                owner="owner",
                info={},
            )

        def test_first_run_baseline_no_alert(self) -> None:
            snapshot = self.make_snapshot(
                {
                    "spawn1": {
                        "type": "spawn",
                        "my": True,
                        "owner": {"username": "owner"},
                        "x": 25,
                        "y": 25,
                        "hits": 5000,
                        "hitsMax": 5000,
                    }
                }
            )
            emitted, suppressed, next_state = evaluate_room_alert(snapshot, {}, now=100, debounce_seconds=300)
            self.assertEqual(emitted, [])
            self.assertEqual(suppressed, [])
            self.assertTrue(next_state["baseline_established"])

        def test_hostile_alert_on_first_run(self) -> None:
            snapshot = self.make_snapshot(
                {
                    "h1": {
                        "type": "creep",
                        "my": False,
                        "owner": {"username": "Invader"},
                        "x": 10,
                        "y": 11,
                    }
                }
            )
            emitted, _suppressed, _next_state = evaluate_room_alert(snapshot, {}, now=100, debounce_seconds=300)
            self.assertEqual([reason["kind"] for reason in emitted], ["hostile_creep"])

        def test_damage_alert_after_baseline(self) -> None:
            previous = {
                "baseline_established": True,
                "structures": {
                    "spawn1": {
                        "type": "spawn",
                        "x": 25,
                        "y": 25,
                        "hits": 5000,
                        "hitsMax": 5000,
                        "owned": True,
                        "damageable": True,
                        "critical": True,
                    }
                },
            }
            snapshot = self.make_snapshot(
                {
                    "spawn1": {
                        "type": "spawn",
                        "my": True,
                        "owner": {"username": "owner"},
                        "x": 25,
                        "y": 25,
                        "hits": 4900,
                        "hitsMax": 5000,
                    }
                }
            )
            emitted, _suppressed, _next_state = evaluate_room_alert(snapshot, previous, now=100, debounce_seconds=300)
            self.assertEqual(emitted[0]["kind"], "structure_damage")
            self.assertEqual(emitted[0]["delta"], 100)

        def test_critical_structure_missing_after_baseline(self) -> None:
            previous = {
                "baseline_established": True,
                "structures": {
                    "spawn1": {
                        "type": "spawn",
                        "x": 25,
                        "y": 25,
                        "hits": 5000,
                        "hitsMax": 5000,
                        "owned": True,
                        "damageable": True,
                        "critical": True,
                    }
                },
            }
            snapshot = self.make_snapshot({})
            emitted, _suppressed, _next_state = evaluate_room_alert(snapshot, previous, now=100, debounce_seconds=300)
            self.assertEqual(emitted[0]["kind"], "critical_structure_missing")

        def test_debounce_suppresses_identical_alert(self) -> None:
            snapshot = self.make_snapshot(
                {
                    "h1": {
                        "type": "creep",
                        "my": False,
                        "owner": {"username": "Invader"},
                        "x": 10,
                        "y": 11,
                    }
                }
            )
            signature = "hostile_creep:shardTest/E1N1:Invader:h1"
            previous = {"baseline_established": True, "alerts": {signature: 90}}
            emitted, suppressed, _next_state = evaluate_room_alert(snapshot, previous, now=100, debounce_seconds=300)
            self.assertEqual(emitted, [])
            self.assertEqual(len(suppressed), 1)

    class TacticalResponseTests(unittest.TestCase):
        def test_tactical_response_keeps_no_alert_silent(self) -> None:
            report = build_tactical_response_report(
                {
                    "ok": True,
                    "mode": "alert",
                    "alert": False,
                    "reasons": [],
                    "rooms": ["shardTest/E1N1"],
                }
            )
            self.assertFalse(report["emergency"])
            self.assertTrue(report["silent"])
            self.assertEqual(report["severity"], "none")
            self.assertEqual(report["scheduler"]["recommended_output"], "[SILENT]")
            self.assertEqual(report["next_actions"][0]["id"], "return_silent")

        def test_tactical_response_classifies_hostile_alert(self) -> None:
            report = build_tactical_response_report(
                {
                    "ok": True,
                    "mode": "alert",
                    "alert": True,
                    "reasons": [
                        {
                            "kind": "hostile_creep",
                            "room": "shardTest/E1N1",
                            "object_id": "h1",
                            "owner": "Invader",
                            "x": 10,
                            "y": 11,
                            "message": "hostile creep visible: Invader at 10,11",
                        }
                    ],
                }
            )
            self.assertTrue(report["emergency"])
            self.assertFalse(report["silent"])
            self.assertEqual(report["severity"], "high")
            self.assertEqual(report["categories"], ["hostiles"])
            self.assertEqual(report["scheduler"]["recommended_output"], "TACTICAL_EMERGENCY_REPORT")

        def test_tactical_response_promotes_missing_spawn_to_critical(self) -> None:
            report = build_tactical_response_report(
                {
                    "ok": True,
                    "mode": "alert",
                    "alert": True,
                    "reasons": [
                        {
                            "kind": "critical_structure_missing",
                            "room": "shardTest/E1N1",
                            "object_id": "spawn1",
                            "structure_type": "spawn",
                            "message": "critical spawn disappeared from 25,25",
                        }
                    ],
                }
            )
            self.assertTrue(report["emergency"])
            self.assertEqual(report["severity"], "critical")
            self.assertEqual(report["categories"], ["owned_structure_disappearance", "spawn_collapse"])

        def test_tactical_response_treats_monitor_failure_as_telemetry_silence(self) -> None:
            report = build_tactical_response_report(
                {
                    "ok": False,
                    "mode": "alert",
                    "error": "no room snapshots collected",
                }
            )
            self.assertTrue(report["emergency"])
            self.assertEqual(report["severity"], "critical")
            self.assertEqual(report["categories"], ["telemetry_silence"])

    class SafeJsonTests(unittest.TestCase):
        def test_safe_json_rejects_secret(self) -> None:
            with self.assertRaises(RuntimeError):
                safe_json_dumps({"token": "abcdef123456"}, ["abcdef123456"])

        def test_safe_json_allows_clean_payload(self) -> None:
            rendered = safe_json_dumps({"mode": "summary", "images": ["/tmp/image.png"]}, ["abcdef123456"])
            self.assertIn('"mode": "summary"', rendered)

        def test_redact_secrets_handles_auth_header_text(self) -> None:
            rendered = redact_secrets("Authorization: Bearer abcdef123456 token=abcdef123456", [])
            self.assertNotIn("abcdef123456", rendered)

    suite = unittest.TestSuite()
    loader = unittest.defaultTestLoader
    for case in (TerrainTests, AlertTests, TacticalResponseTests, SafeJsonTests):
        suite.addTests(loader.loadTestsFromTestCase(case))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except Exception as exc:  # noqa: BLE001 - cron-facing JSON failure without stack or secrets
        token = os.environ.get("SCREEPS_AUTH_TOKEN", "")
        payload = {
            "ok": False,
            "mode": getattr(args, "command", "unknown"),
            "error": redact_secrets(str(exc), [token]),
        }
        print_json(payload, [token])
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
