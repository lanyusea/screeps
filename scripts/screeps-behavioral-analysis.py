#!/usr/bin/env python3
"""Analyze Screeps runtime artifacts for gameplay inefficiencies."""

from __future__ import annotations

import argparse
import html
import json
import os
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from typing import Any, Iterable, TextIO


RUNTIME_SUMMARY_PREFIX = "#runtime-summary "
REPORT_TYPE = "behavioral-analysis"
SCHEMA_VERSION = 1

DEFAULT_RUNTIME_SUMMARY_DIR = Path("/root/screeps/runtime-artifacts/runtime-summary-console")
DEFAULT_MONITOR_DIR = Path("/root/screeps/runtime-artifacts/screeps-monitor")
DEFAULT_OUTPUT_DIR = Path("runtime-artifacts/behavioral-analysis")

DEFAULT_HISTORY_LIMIT = 50
DEFAULT_THRESHOLDS: dict[str, float] = {
    "idle_worker_ratio": 0.5,
    "idle_worker_count": 1,
    "idle_behavior_ratio": 0.45,
    "idle_behavior_ticks": 8,
    "low_productive_assignment_ratio": 0.25,
    "energy_full_ratio": 0.95,
    "dropped_energy": 200,
    "dropped_energy_per_source": 100,
    "durable_free_capacity": 50,
    "construction_pending_progress": 500,
    "construction_min_rcl": 2,
    "construction_history_samples": 2,
    "spawn_energy_ratio": 0.8,
    "spawn_min_energy": 200,
    "max_transfer_worker_ratio": 0.5,
    "max_harvest_worker_ratio": 0.75,
    "min_workers_per_source": 1,
    "min_productive_workers": 1,
}

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class ArtifactSample:
    path: Path
    payload: JsonObject
    mtime: float
    line_index: int = 0

    @property
    def tick(self) -> int | float | None:
        return number_or_none(self.payload.get("tick"))


@dataclass(frozen=True)
class Finding:
    id: str
    category: str
    severity: str
    room: str | None
    message: str
    evidence: JsonObject
    recommendation: str

    def as_json(self) -> JsonObject:
        return {
            "id": self.id,
            "category": self.category,
            "severity": self.severity,
            "room": self.room,
            "message": self.message,
            "evidence": self.evidence,
            "recommendation": self.recommendation,
        }


def number_or_none(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    return None


def bool_or_none(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    return None


def as_dict(value: Any) -> JsonObject:
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def numeric_value(value: Any, default: float = 0.0) -> float:
    number = number_or_none(value)
    return float(number) if number is not None else default


def nested_value(value: Any, *keys: str) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def room_name_from_summary(room: JsonObject) -> str | None:
    for key in ("roomName", "name"):
        value = room.get(key)
        if isinstance(value, str) and value:
            return value

    room_ref = room.get("room")
    if isinstance(room_ref, str) and room_ref:
        return room_ref.rsplit("/", 1)[-1]

    return None


def parse_runtime_summary_line(line: str) -> JsonObject | None:
    stripped = line.strip()
    if not stripped.startswith(RUNTIME_SUMMARY_PREFIX):
        return None

    payload_text = html.unescape(stripped[len(RUNTIME_SUMMARY_PREFIX) :])
    try:
        payload = json.loads(payload_text)
    except json.JSONDecodeError:
        return None

    if isinstance(payload, dict) and payload.get("type") == "runtime-summary":
        return payload
    return None


def iter_runtime_summary_samples(runtime_summary_dir: Path) -> Iterable[ArtifactSample]:
    if not runtime_summary_dir.exists():
        return

    for path in sorted(runtime_summary_dir.glob("*.log")):
        try:
            stat = path.stat()
        except OSError:
            continue

        try:
            with path.open("r", encoding="utf-8") as input_file:
                for line_index, line in enumerate(input_file):
                    payload = parse_runtime_summary_line(line)
                    if payload is not None:
                        yield ArtifactSample(path=path, payload=payload, mtime=stat.st_mtime, line_index=line_index)
        except OSError:
            continue


def is_monitor_payload(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    if isinstance(payload.get("room_summaries"), list):
        return True
    if payload.get("mode") in {"summary", "alert"} and isinstance(payload.get("summary"), dict):
        return True
    return False


def iter_monitor_samples(monitor_dir: Path) -> Iterable[ArtifactSample]:
    if not monitor_dir.exists():
        return

    for path in sorted(monitor_dir.rglob("*.json")):
        try:
            stat = path.stat()
        except OSError:
            continue

        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        if is_monitor_payload(payload):
            yield ArtifactSample(path=path, payload=payload, mtime=stat.st_mtime)


def sample_sort_key(sample: ArtifactSample) -> tuple[float, str, int]:
    return (sample.mtime, str(sample.path), sample.line_index)


def latest_sample(samples: list[ArtifactSample]) -> ArtifactSample | None:
    if not samples:
        return None
    return max(samples, key=sample_sort_key)


def limit_history(samples: list[ArtifactSample], limit: int) -> list[ArtifactSample]:
    ordered = sorted(samples, key=sample_sort_key)
    if limit <= 0:
        return ordered
    return ordered[-limit:]


def room_summaries(payload: JsonObject) -> list[JsonObject]:
    rooms = payload.get("rooms")
    if isinstance(rooms, list):
        return [room for room in rooms if isinstance(room, dict)]
    return []


def monitor_room_summaries(payload: JsonObject | None) -> list[JsonObject]:
    if payload is None:
        return []
    rooms = payload.get("room_summaries")
    if isinstance(rooms, list):
        return [room for room in rooms if isinstance(room, dict)]
    return []


def build_monitor_room_index(payload: JsonObject | None) -> dict[str, JsonObject]:
    result: dict[str, JsonObject] = {}
    for room in monitor_room_summaries(payload):
        name = room_name_from_summary(room)
        if name:
            result[name] = room
    return result


def room_metric(room: JsonObject, monitor_room: JsonObject, key: str) -> int | float | None:
    value = number_or_none(room.get(key))
    if value is not None:
        return value

    monitor_key = {
        "workerCount": "owned_creeps",
        "spawnCount": "owned_spawns",
        "structureCount": "structures",
    }.get(key)
    if monitor_key is None:
        return None
    return number_or_none(monitor_room.get(monitor_key))


def task_count(room: JsonObject, task_name: str) -> float:
    return numeric_value(nested_value(room, "taskCounts", task_name))


def role_count(room: JsonObject, *names: str) -> float:
    role_counts = as_dict(room.get("roleCounts"))
    return sum(numeric_value(role_counts.get(name)) for name in names)


def spawn_statuses(room: JsonObject, monitor_room: JsonObject) -> list[JsonObject]:
    statuses = as_list(room.get("spawnStatus"))
    typed_statuses = [status for status in statuses if isinstance(status, dict)]
    if typed_statuses:
        return typed_statuses

    owned_spawns = number_or_none(monitor_room.get("owned_spawns"))
    if owned_spawns is None or owned_spawns <= 0:
        return []
    return [{"status": "unknown"} for _ in range(int(owned_spawns))]


def idle_spawn_count(room: JsonObject, monitor_room: JsonObject) -> int:
    statuses = spawn_statuses(room, monitor_room)
    return sum(1 for status in statuses if status.get("status") == "idle")


def all_known_spawns_idle(room: JsonObject, monitor_room: JsonObject) -> bool:
    statuses = spawn_statuses(room, monitor_room)
    known = [status for status in statuses if status.get("status") in {"idle", "spawning"}]
    return bool(known) and all(status.get("status") == "idle" for status in known)


def room_worker_count(room: JsonObject, monitor_room: JsonObject) -> float:
    return numeric_value(room_metric(room, monitor_room, "workerCount"))


def room_source_count(room: JsonObject) -> float:
    return numeric_value(nested_value(room, "resources", "sourceCount"))


def energy_fill_ratio(room: JsonObject) -> float | None:
    available = number_or_none(room.get("energyAvailable"))
    capacity = number_or_none(room.get("energyCapacity"))
    if available is None or capacity is None or capacity <= 0:
        return None
    return float(available) / float(capacity)


def room_has_high_urgency_construction(room: JsonObject) -> bool:
    urgency = nested_value(room, "constructionPriority", "nextPrimary", "urgency")
    if isinstance(urgency, str) and urgency in {"high", "critical"}:
        return True
    for candidate in as_list(nested_value(room, "constructionPriority", "candidates")):
        if isinstance(candidate, dict) and candidate.get("urgency") in {"high", "critical"}:
            return True
    return False


def room_baseline(samples: list[ArtifactSample], room_name: str) -> JsonObject:
    room_entries: list[tuple[ArtifactSample, JsonObject]] = []
    for sample in samples:
        for room in room_summaries(sample.payload):
            if room_name_from_summary(room) == room_name:
                room_entries.append((sample, room))

    if not room_entries:
        return {"sampleCount": 0}

    first_sample, first_room = room_entries[0]
    latest_sample_value, latest_room = room_entries[-1]
    first_tick = number_or_none(first_sample.payload.get("tick"))
    latest_tick = number_or_none(latest_sample_value.payload.get("tick"))
    built_progress_total = 0.0
    upgraded_progress_total = 0.0
    harvested_energy_total = 0.0
    stored_energy_values: list[float] = []

    for _, room in room_entries:
        resources = as_dict(room.get("resources"))
        events = as_dict(resources.get("events"))
        built_progress_total += numeric_value(events.get("builtProgress"))
        upgraded_progress_total += numeric_value(events.get("upgradedControllerProgress"))
        harvested_energy_total += numeric_value(events.get("harvestedEnergy"), numeric_value(resources.get("harvestedThisTick")))
        stored_energy = number_or_none(resources.get("storedEnergy"))
        if stored_energy is not None:
            stored_energy_values.append(float(stored_energy))

    first_level = number_or_none(nested_value(first_room, "controller", "level"))
    latest_level = number_or_none(nested_value(latest_room, "controller", "level"))
    first_controller_progress = number_or_none(nested_value(first_room, "controller", "progress"))
    latest_controller_progress = number_or_none(nested_value(latest_room, "controller", "progress"))
    controller_progress_delta: float | None = None
    if first_controller_progress is not None and latest_controller_progress is not None and first_level == latest_level:
        controller_progress_delta = float(latest_controller_progress) - float(first_controller_progress)

    first_pending = number_or_none(nested_value(first_room, "resources", "productiveEnergy", "pendingBuildProgress"))
    latest_pending = number_or_none(nested_value(latest_room, "resources", "productiveEnergy", "pendingBuildProgress"))
    pending_delta: float | None = None
    if first_pending is not None and latest_pending is not None:
        pending_delta = float(latest_pending) - float(first_pending)

    return {
        "sampleCount": len(room_entries),
        "firstTick": first_tick,
        "latestTick": latest_tick,
        "tickSpan": float(latest_tick) - float(first_tick) if first_tick is not None and latest_tick is not None else None,
        "controllerLevelDelta": (float(latest_level) - float(first_level)) if first_level is not None and latest_level is not None else None,
        "controllerProgressDelta": controller_progress_delta,
        "pendingBuildProgressDelta": pending_delta,
        "builtProgressTotal": built_progress_total,
        "upgradedControllerProgressTotal": upgraded_progress_total,
        "harvestedEnergyTotal": harvested_energy_total,
        "averageStoredEnergy": mean(stored_energy_values) if stored_energy_values else None,
    }


def monitor_baseline(samples: list[ArtifactSample], room_name: str) -> JsonObject:
    entries: list[tuple[ArtifactSample, JsonObject]] = []
    for sample in samples:
        for room in monitor_room_summaries(sample.payload):
            if room_name_from_summary(room) == room_name:
                entries.append((sample, room))

    if not entries:
        return {"sampleCount": 0}

    first_sample, first_room = entries[0]
    latest_sample_value, latest_room = entries[-1]
    return {
        "sampleCount": len(entries),
        "firstTick": number_or_none(first_room.get("tick")),
        "latestTick": number_or_none(latest_room.get("tick")),
        "ownedCreepsDelta": delta_number(first_room.get("owned_creeps"), latest_room.get("owned_creeps")),
        "ownedSpawnsDelta": delta_number(first_room.get("owned_spawns"), latest_room.get("owned_spawns")),
        "structuresDelta": delta_number(first_room.get("structures"), latest_room.get("structures")),
        "firstPath": str(first_sample.path),
        "latestPath": str(latest_sample_value.path),
    }


def delta_number(first: Any, latest: Any) -> float | None:
    first_number = number_or_none(first)
    latest_number = number_or_none(latest)
    if first_number is None or latest_number is None:
        return None
    return float(latest_number) - float(first_number)


def build_baselines(
    runtime_samples: list[ArtifactSample],
    monitor_samples: list[ArtifactSample],
    room_names: Iterable[str],
) -> dict[str, JsonObject]:
    baselines: dict[str, JsonObject] = {}
    for room_name in sorted(set(room_names)):
        baselines[room_name] = {
            "runtimeSummary": room_baseline(runtime_samples, room_name),
            "monitor": monitor_baseline(monitor_samples, room_name),
        }
    return baselines


def detect_idle_workers(room: JsonObject, monitor_room: JsonObject, thresholds: dict[str, float]) -> list[Finding]:
    findings: list[Finding] = []
    room_name = room_name_from_summary(room)
    workers = room_worker_count(room, monitor_room)
    if workers <= 0:
        return findings

    none_count = task_count(room, "none")
    none_ratio = none_count / workers if workers > 0 else 0
    if none_count >= thresholds["idle_worker_count"] and none_ratio >= thresholds["idle_worker_ratio"]:
        severity = "critical" if none_ratio >= 0.75 or none_count >= 2 else "warning"
        findings.append(
            Finding(
                id=f"idle-workers:{room_name}:unassigned",
                category="idle-workers",
                severity=severity,
                room=room_name,
                message=f"{int(none_count)} of {int(workers)} workers have no active task.",
                evidence={"workerCount": workers, "noneTaskCount": none_count, "noneTaskRatio": round(none_ratio, 3)},
                recommendation="Inspect worker task assignment and ensure harvest, refill, build, repair, or upgrade work is available.",
            )
        )

    behavior_totals = as_dict(nested_value(room, "behavior", "totals"))
    idle_ticks = numeric_value(behavior_totals.get("idleTicks"))
    move_ticks = numeric_value(behavior_totals.get("moveTicks"))
    work_ticks = numeric_value(behavior_totals.get("workTicks"))
    sampled_ticks = idle_ticks + move_ticks + work_ticks
    if sampled_ticks > 0:
        idle_ratio = idle_ticks / sampled_ticks
        if idle_ticks >= thresholds["idle_behavior_ticks"] and idle_ratio >= thresholds["idle_behavior_ratio"]:
            findings.append(
                Finding(
                    id=f"idle-workers:{room_name}:behavior",
                    category="idle-workers",
                    severity="critical" if idle_ratio >= 0.65 else "warning",
                    room=room_name,
                    message=f"Worker behavior samples are {idle_ratio:.0%} idle.",
                    evidence={
                        "idleTicks": idle_ticks,
                        "moveTicks": move_ticks,
                        "workTicks": work_ticks,
                        "idleRatio": round(idle_ratio, 3),
                    },
                    recommendation="Check whether workers are blocked by missing targets, pathing, or saturated energy sinks.",
                )
            )

    productive = as_dict(nested_value(room, "resources", "productiveEnergy"))
    productive_workers = numeric_value(productive.get("assignedWorkerCount"))
    pending_build = numeric_value(productive.get("pendingBuildProgress"))
    controller_remaining = number_or_none(productive.get("controllerProgressRemaining"))
    productive_ratio = productive_workers / workers if workers > 0 else 0
    if (
        workers > 0
        and productive_ratio < thresholds["low_productive_assignment_ratio"]
        and (pending_build > 0 or (controller_remaining is not None and controller_remaining > 0))
        and numeric_value(nested_value(room, "resources", "workerCarriedEnergy")) > 0
    ):
        findings.append(
            Finding(
                id=f"idle-workers:{room_name}:low-productive-assignment",
                category="idle-workers",
                severity="warning",
                room=room_name,
                message="Workers carry energy while too few are assigned to build, repair, or upgrade work.",
                evidence={
                    "workerCount": workers,
                    "productiveWorkerCount": productive_workers,
                    "productiveWorkerRatio": round(productive_ratio, 3),
                    "pendingBuildProgress": pending_build,
                    "controllerProgressRemaining": controller_remaining,
                    "workerCarriedEnergy": numeric_value(nested_value(room, "resources", "workerCarriedEnergy")),
                },
                recommendation="Prioritize productive sinks when spawn/refill targets are full.",
            )
        )

    return findings


def detect_energy_wastage(room: JsonObject, monitor_room: JsonObject, thresholds: dict[str, float]) -> list[Finding]:
    del monitor_room
    findings: list[Finding] = []
    room_name = room_name_from_summary(room)
    resources = as_dict(room.get("resources"))
    surplus = as_dict(resources.get("energySurplus"))
    fill_ratio = energy_fill_ratio(room)
    spawn_extensions_full = bool_or_none(surplus.get("spawnExtensionsFull")) is True
    containers_full = bool_or_none(surplus.get("containersFull")) is True
    durable_free = numeric_value(surplus.get("durableFreeCapacity"))
    dropped_energy = numeric_value(resources.get("droppedEnergy"))
    source_count = room_source_count(room)
    dropped_per_source = dropped_energy / source_count if source_count > 0 else dropped_energy

    energy_full = fill_ratio is not None and fill_ratio >= thresholds["energy_full_ratio"]
    no_room_for_energy = spawn_extensions_full and (containers_full or durable_free <= thresholds["durable_free_capacity"])
    productive_workers = numeric_value(nested_value(room, "resources", "productiveEnergy", "assignedWorkerCount"))

    if energy_full and no_room_for_energy and productive_workers <= 0:
        findings.append(
            Finding(
                id=f"energy-wastage:{room_name}:full-sinks",
                category="energy-wastage",
                severity="critical",
                room=room_name,
                message="Energy sinks are full while no worker is assigned to productive energy work.",
                evidence={
                    "energyFillRatio": round(fill_ratio, 3) if fill_ratio is not None else None,
                    "spawnExtensionsFull": spawn_extensions_full,
                    "containersFull": containers_full,
                    "durableFreeCapacity": durable_free,
                    "productiveWorkerCount": productive_workers,
                },
                recommendation="Route surplus energy into construction, repairs, controller upgrades, storage, or spawn demand.",
            )
        )

    if dropped_energy >= thresholds["dropped_energy"] or dropped_per_source >= thresholds["dropped_energy_per_source"]:
        findings.append(
            Finding(
                id=f"energy-wastage:{room_name}:dropped-energy",
                category="energy-wastage",
                severity="warning",
                room=room_name,
                message="Dropped energy is above the configured waste threshold.",
                evidence={
                    "droppedEnergy": dropped_energy,
                    "sourceCount": source_count,
                    "droppedEnergyPerSource": round(dropped_per_source, 3),
                },
                recommendation="Increase pickup/haul/refill pressure or add source containers before harvesting more energy.",
            )
        )

    harvesters = task_count(room, "harvest")
    harvested_this_tick = numeric_value(resources.get("harvestedThisTick"))
    if harvesters > 0 and harvested_this_tick <= 0 and (energy_full or no_room_for_energy):
        findings.append(
            Finding(
                id=f"energy-wastage:{room_name}:harvesters-blocked",
                category="energy-wastage",
                severity="warning",
                room=room_name,
                message="Harvest workers are assigned while no harvest throughput is observed and energy sinks look saturated.",
                evidence={
                    "harvestTaskCount": harvesters,
                    "harvestedThisTick": harvested_this_tick,
                    "energyFillRatio": round(fill_ratio, 3) if fill_ratio is not None else None,
                    "spawnExtensionsFull": spawn_extensions_full,
                    "containersFull": containers_full,
                },
                recommendation="Throttle harvesting or open downstream sinks before assigning more harvest work.",
            )
        )

    return findings


def detect_stalled_construction(
    room: JsonObject,
    monitor_room: JsonObject,
    baseline: JsonObject,
    thresholds: dict[str, float],
) -> list[Finding]:
    del monitor_room
    findings: list[Finding] = []
    room_name = room_name_from_summary(room)
    rcl = numeric_value(nested_value(room, "controller", "level"))
    productive = as_dict(nested_value(room, "resources", "productiveEnergy"))
    pending_build = numeric_value(productive.get("pendingBuildProgress"))
    build_workers = task_count(room, "build")
    runtime_baseline = as_dict(baseline.get("runtimeSummary"))
    sample_count = numeric_value(runtime_baseline.get("sampleCount"))
    built_progress_total = numeric_value(runtime_baseline.get("builtProgressTotal"))
    pending_delta = number_or_none(runtime_baseline.get("pendingBuildProgressDelta"))
    high_urgency = room_has_high_urgency_construction(room)

    enough_history = sample_count >= thresholds["construction_history_samples"]
    no_progress = built_progress_total <= 0 and (pending_delta is None or pending_delta >= 0)
    if (
        rcl >= thresholds["construction_min_rcl"]
        and pending_build >= thresholds["construction_pending_progress"]
        and enough_history
        and no_progress
        and build_workers <= 0
    ):
        severity = "critical" if high_urgency else "warning"
        findings.append(
            Finding(
                id=f"stalled-construction:{room_name}:no-progress",
                category="stalled-construction",
                severity=severity,
                room=room_name,
                message="Construction backlog is present across history but no build progress or build assignment is visible.",
                evidence={
                    "controllerLevel": rcl,
                    "pendingBuildProgress": pending_build,
                    "buildTaskCount": build_workers,
                    "historySamples": sample_count,
                    "builtProgressTotal": built_progress_total,
                    "pendingBuildProgressDelta": pending_delta,
                    "highUrgencyConstruction": high_urgency,
                },
                recommendation="Assign at least one builder or demote stale construction plans if the backlog is intentional.",
            )
        )

    return findings


def detect_underutilized_spawn(
    room: JsonObject,
    monitor_room: JsonObject,
    thresholds: dict[str, float],
) -> list[Finding]:
    findings: list[Finding] = []
    room_name = room_name_from_summary(room)
    if not all_known_spawns_idle(room, monitor_room):
        return findings

    fill_ratio = energy_fill_ratio(room)
    energy_available = number_or_none(room.get("energyAvailable"))
    has_energy = False
    if fill_ratio is not None and fill_ratio >= thresholds["spawn_energy_ratio"]:
        has_energy = True
    if energy_available is not None and energy_available >= thresholds["spawn_min_energy"]:
        has_energy = True
    if not has_energy:
        return findings

    workers = room_worker_count(room, monitor_room)
    worker_capacity = number_or_none(nested_value(room, "survival", "workerCapacity"))
    effective_workers = float(worker_capacity) if worker_capacity is not None else workers
    worker_target = number_or_none(nested_value(room, "survival", "workerTarget"))
    worker_deficit = None
    if worker_target is not None:
        worker_deficit = float(worker_target) - effective_workers

    if worker_deficit is not None and worker_deficit > 0:
        findings.append(
            Finding(
                id=f"under-utilized-spawn:{room_name}:worker-deficit",
                category="under-utilized-spawn",
                severity="critical",
                room=room_name,
                message="Spawn is idle with enough energy while survival worker target is not met.",
                evidence={
                    "idleSpawnCount": idle_spawn_count(room, monitor_room),
                    "energyAvailable": energy_available,
                    "energyCapacity": number_or_none(room.get("energyCapacity")),
                    "energyFillRatio": round(fill_ratio, 3) if fill_ratio is not None else None,
                    "workerCapacity": effective_workers,
                    "workerTarget": worker_target,
                    "workerDeficit": worker_deficit,
                },
                recommendation="Check spawn queue planning and body affordability for worker replacement.",
            )
        )
        return findings

    useful_backlog = (
        numeric_value(nested_value(room, "resources", "productiveEnergy", "pendingBuildProgress")) > 0
        or number_or_none(nested_value(room, "resources", "productiveEnergy", "controllerProgressRemaining")) not in {None, 0}
    )
    if useful_backlog and workers <= 0:
        findings.append(
            Finding(
                id=f"under-utilized-spawn:{room_name}:empty-workforce",
                category="under-utilized-spawn",
                severity="critical",
                room=room_name,
                message="Spawn is idle with energy while the room has no workers and useful work remains.",
                evidence={
                    "idleSpawnCount": idle_spawn_count(room, monitor_room),
                    "energyAvailable": energy_available,
                    "workerCount": workers,
                    "usefulBacklog": useful_backlog,
                },
                recommendation="Recover the worker population before other spawn priorities.",
            )
        )

    return findings


def detect_role_imbalance(room: JsonObject, monitor_room: JsonObject, thresholds: dict[str, float]) -> list[Finding]:
    findings: list[Finding] = []
    room_name = room_name_from_summary(room)
    workers = room_worker_count(room, monitor_room)
    if workers <= 0:
        return findings

    transfer_workers = max(task_count(room, "transfer"), role_count(room, "hauler", "carrier", "transporter"))
    harvest_workers = max(task_count(room, "harvest"), role_count(room, "harvester", "sourceHarvester"))
    upgrade_workers = max(task_count(room, "upgrade"), role_count(room, "upgrader"))
    productive_workers = task_count(room, "build") + task_count(room, "repair") + task_count(room, "upgrade")
    source_count = room_source_count(room)
    controller_remaining = number_or_none(nested_value(room, "resources", "productiveEnergy", "controllerProgressRemaining"))
    pending_build = numeric_value(nested_value(room, "resources", "productiveEnergy", "pendingBuildProgress"))

    transfer_ratio = transfer_workers / workers
    if transfer_workers > 0 and transfer_ratio > thresholds["max_transfer_worker_ratio"] and productive_workers < thresholds["min_productive_workers"]:
        findings.append(
            Finding(
                id=f"role-imbalance:{room_name}:hauler-heavy",
                category="role-imbalance",
                severity="warning",
                room=room_name,
                message="Logistics assignment dominates the workforce while productive roles are scarce.",
                evidence={
                    "workerCount": workers,
                    "transferOrHaulerCount": transfer_workers,
                    "transferOrHaulerRatio": round(transfer_ratio, 3),
                    "productiveTaskCount": productive_workers,
                    "pendingBuildProgress": pending_build,
                    "controllerProgressRemaining": controller_remaining,
                },
                recommendation="Shift excess haulers/refill workers into build, repair, or upgrade work when sinks are full.",
            )
        )

    harvest_ratio = harvest_workers / workers
    fill_ratio = energy_fill_ratio(room)
    if harvest_ratio > thresholds["max_harvest_worker_ratio"] and fill_ratio is not None and fill_ratio >= thresholds["energy_full_ratio"]:
        findings.append(
            Finding(
                id=f"role-imbalance:{room_name}:harvest-heavy",
                category="role-imbalance",
                severity="warning",
                room=room_name,
                message="Harvest assignment dominates while room energy is already full.",
                evidence={
                    "workerCount": workers,
                    "harvestOrSourceHarvesterCount": harvest_workers,
                    "harvestOrSourceHarvesterRatio": round(harvest_ratio, 3),
                    "energyFillRatio": round(fill_ratio, 3),
                },
                recommendation="Prefer downstream energy sinks over additional harvesting until free capacity returns.",
            )
        )

    if source_count > 0 and workers < source_count * thresholds["min_workers_per_source"]:
        findings.append(
            Finding(
                id=f"role-imbalance:{room_name}:source-worker-shortage",
                category="role-imbalance",
                severity="critical",
                room=room_name,
                message="Worker count is below the configured minimum per source.",
                evidence={
                    "workerCount": workers,
                    "sourceCount": source_count,
                    "minimumWorkersPerSource": thresholds["min_workers_per_source"],
                    "requiredWorkers": source_count * thresholds["min_workers_per_source"],
                },
                recommendation="Prioritize worker recovery before expansion or specialized roles.",
            )
        )

    if (
        controller_remaining is not None
        and controller_remaining > 0
        and pending_build <= 0
        and upgrade_workers <= 0
        and fill_ratio is not None
        and fill_ratio >= thresholds["energy_full_ratio"]
    ):
        findings.append(
            Finding(
                id=f"role-imbalance:{room_name}:no-upgrade-pressure",
                category="role-imbalance",
                severity="warning",
                room=room_name,
                message="Controller progress remains but no upgrader or upgrade task is visible while energy is full.",
                evidence={
                    "upgradeOrUpgraderCount": upgrade_workers,
                    "controllerProgressRemaining": controller_remaining,
                    "energyFillRatio": round(fill_ratio, 3),
                },
                recommendation="Assign upgrade work when construction is empty and energy is saturated.",
            )
        )

    return findings


def analyze_room(
    room: JsonObject,
    monitor_room: JsonObject,
    baseline: JsonObject,
    thresholds: dict[str, float],
) -> JsonObject:
    detectors = [
        detect_idle_workers(room, monitor_room, thresholds),
        detect_energy_wastage(room, monitor_room, thresholds),
        detect_stalled_construction(room, monitor_room, baseline, thresholds),
        detect_underutilized_spawn(room, monitor_room, thresholds),
        detect_role_imbalance(room, monitor_room, thresholds),
    ]
    findings = [finding for detector_findings in detectors for finding in detector_findings]
    room_name = room_name_from_summary(room) or room_name_from_summary(monitor_room) or "unknown"
    resources = as_dict(room.get("resources"))
    productive = as_dict(resources.get("productiveEnergy"))
    structures = as_dict(room.get("structures"))
    return {
        "roomName": room_name,
        "tick": number_or_none(room.get("tick")),
        "metrics": {
            "workerCount": room_worker_count(room, monitor_room),
            "spawnCount": room_metric(room, monitor_room, "spawnCount"),
            "structureCount": room_metric(room, monitor_room, "structureCount"),
            "energyAvailable": number_or_none(room.get("energyAvailable")),
            "energyCapacity": number_or_none(room.get("energyCapacity")),
            "energyFillRatio": energy_fill_ratio(room),
            "controllerLevel": number_or_none(nested_value(room, "controller", "level")),
            "storedEnergy": number_or_none(resources.get("storedEnergy")),
            "workerCarriedEnergy": number_or_none(resources.get("workerCarriedEnergy")),
            "droppedEnergy": number_or_none(resources.get("droppedEnergy")),
            "sourceCount": number_or_none(resources.get("sourceCount")),
            "pendingBuildProgress": number_or_none(productive.get("pendingBuildProgress")),
            "productiveWorkerCount": number_or_none(productive.get("assignedWorkerCount")),
            "idleSpawnCount": idle_spawn_count(room, monitor_room),
            "towerCount": number_or_none(structures.get("towerCount")),
            "rampartCount": number_or_none(structures.get("rampartCount")),
            "containerCount": len(as_list(structures.get("containers"))),
            "repairTargetCount": len(as_list(structures.get("repairTargets"))),
            "roadCount": number_or_none(structures.get("roadCount")),
            "pendingRoadSiteCount": number_or_none(structures.get("pendingRoadSiteCount")),
        },
        "taskCounts": as_dict(room.get("taskCounts")),
        "baseline": baseline,
        "findings": [finding.as_json() for finding in findings],
    }


def severity_rank(severity: str) -> int:
    return {"critical": 3, "warning": 2, "info": 1}.get(severity, 0)


def report_status(findings: list[Finding], has_input: bool) -> str:
    if not has_input:
        return "no-data"
    if any(finding.severity == "critical" for finding in findings):
        return "critical"
    if any(finding.severity == "warning" for finding in findings):
        return "warning"
    return "ok"


def source_metadata(sample: ArtifactSample | None) -> JsonObject | None:
    if sample is None:
        return None
    return {
        "path": str(sample.path),
        "mtime": datetime.fromtimestamp(sample.mtime, tz=timezone.utc).isoformat(),
        "tick": sample.tick,
    }


def build_report(
    runtime_samples: list[ArtifactSample],
    monitor_samples: list[ArtifactSample],
    thresholds: dict[str, float],
    generated_at: datetime | None = None,
) -> JsonObject:
    generated = (generated_at or datetime.now(timezone.utc)).astimezone(timezone.utc)
    latest_runtime = latest_sample(runtime_samples)
    latest_monitor = latest_sample(monitor_samples)
    latest_monitor_with_rooms = latest_sample([sample for sample in monitor_samples if monitor_room_summaries(sample.payload)])
    monitor_room_index = build_monitor_room_index(latest_monitor_with_rooms.payload if latest_monitor_with_rooms else None)

    latest_runtime_rooms = room_summaries(latest_runtime.payload) if latest_runtime is not None else []
    room_names = {room_name_from_summary(room) for room in latest_runtime_rooms}
    room_names.update(monitor_room_index)
    clean_room_names = {name for name in room_names if isinstance(name, str) and name}

    baselines = build_baselines(runtime_samples, monitor_samples, clean_room_names)
    room_reports: list[JsonObject] = []
    all_findings: list[Finding] = []
    runtime_rooms_by_name = {
        name: room
        for room in latest_runtime_rooms
        if (name := room_name_from_summary(room))
    }

    for room_name in sorted(clean_room_names):
        room = runtime_rooms_by_name.get(room_name, {"roomName": room_name})
        monitor_room = monitor_room_index.get(room_name, {})
        room_report = analyze_room(room, monitor_room, baselines.get(room_name, {}), thresholds)
        room_reports.append(room_report)
        all_findings.extend(Finding(**finding) for finding in room_report["findings"])

    all_findings.sort(key=lambda finding: (-severity_rank(finding.severity), finding.category, finding.room or "", finding.id))
    critical_count = sum(1 for finding in all_findings if finding.severity == "critical")
    warning_count = sum(1 for finding in all_findings if finding.severity == "warning")
    status = report_status(all_findings, latest_runtime is not None or latest_monitor is not None)

    return {
        "type": REPORT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated.isoformat().replace("+00:00", "Z"),
        "status": status,
        "summary": {
            "roomCount": len(clean_room_names),
            "findingCount": len(all_findings),
            "criticalCount": critical_count,
            "warningCount": warning_count,
        },
        "inputs": {
            "runtimeSummarySamples": len(runtime_samples),
            "monitorSamples": len(monitor_samples),
            "latestRuntimeSummary": source_metadata(latest_runtime),
            "latestMonitor": source_metadata(latest_monitor),
            "latestMonitorWithRooms": source_metadata(latest_monitor_with_rooms),
        },
        "thresholds": thresholds,
        "findings": [finding.as_json() for finding in all_findings],
        "rooms": room_reports,
    }


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd: int | None = None
    temp_path: Path | None = None
    try:
        fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        temp_path = Path(temp_name)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            fd = None
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        temp_path.replace(path)
    finally:
        if fd is not None:
            os.close(fd)
        if temp_path is not None:
            try:
                temp_path.unlink()
            except FileNotFoundError:
                pass


def analysis_artifact_name(generated_at: datetime) -> str:
    timestamp = generated_at.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"analysis-{timestamp}.json"


def write_report_artifacts(report: JsonObject, output_dir: Path, generated_at: datetime) -> tuple[Path, Path]:
    output_dir = output_dir.expanduser()
    json_path = output_dir / analysis_artifact_name(generated_at)
    latest_md_path = output_dir / "latest.md"
    atomic_write_text(json_path, json.dumps(report, indent=2, sort_keys=True) + "\n")
    atomic_write_text(latest_md_path, render_markdown_summary(report))
    return json_path, latest_md_path


def render_markdown_summary(report: JsonObject) -> str:
    summary = as_dict(report.get("summary"))
    lines = [
        "# Screeps Behavioral Analysis",
        "",
        f"- Generated: {report.get('generatedAt')}",
        f"- Status: {report.get('status')}",
        f"- Rooms analyzed: {int(numeric_value(summary.get('roomCount')))}",
        f"- Findings: {int(numeric_value(summary.get('findingCount')))} "
        f"({int(numeric_value(summary.get('criticalCount')))} critical, "
        f"{int(numeric_value(summary.get('warningCount')))} warning)",
        "",
    ]

    findings = as_list(report.get("findings"))
    if report.get("status") == "no-data":
        lines.extend(["No input data was available; analysis coverage is incomplete.", ""])
        return "\n".join(lines)

    if not findings:
        lines.extend(["No inefficiencies detected.", ""])
        return "\n".join(lines)

    lines.append("## Findings")
    lines.append("")
    for finding in findings:
        if not isinstance(finding, dict):
            continue
        room = finding.get("room") or "global"
        lines.append(
            f"- [{finding.get('severity')}] {finding.get('category')} {room}: {finding.get('message')}"
        )
        recommendation = finding.get("recommendation")
        if recommendation:
            lines.append(f"  - Fix: {recommendation}")
    lines.append("")
    return "\n".join(lines)


def parse_threshold_override(value: str) -> tuple[str, float]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("threshold overrides must use key=value")
    key, raw_number = value.split("=", 1)
    key = key.strip()
    if not key:
        raise argparse.ArgumentTypeError("threshold key cannot be empty")
    try:
        number = float(raw_number)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"threshold value for {key!r} must be numeric") from exc
    return key, number


def apply_threshold_overrides(overrides: list[tuple[str, float]]) -> dict[str, float]:
    thresholds = dict(DEFAULT_THRESHOLDS)
    for key, value in overrides:
        if key not in thresholds:
            allowed = ", ".join(sorted(thresholds))
            raise ValueError(f"unknown threshold {key!r}; known thresholds: {allowed}")
        thresholds[key] = value
    return thresholds


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Analyze Screeps runtime summary and monitor artifacts for gameplay inefficiencies."
    )
    parser.add_argument(
        "--runtime-summary-dir",
        default=str(DEFAULT_RUNTIME_SUMMARY_DIR),
        help="Directory containing #runtime-summary console .log artifacts.",
    )
    parser.add_argument(
        "--monitor-dir",
        default=str(DEFAULT_MONITOR_DIR),
        help="Directory containing Screeps monitor JSON artifacts.",
    )
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_OUTPUT_DIR),
        help="Directory for analysis-{timestamp}.json and latest.md outputs.",
    )
    parser.add_argument(
        "--history-limit",
        type=int,
        default=DEFAULT_HISTORY_LIMIT,
        help="Number of latest runtime/monitor samples to use for historical baselines; 0 means all.",
    )
    parser.add_argument(
        "--threshold",
        action="append",
        default=[],
        type=parse_threshold_override,
        metavar="KEY=VALUE",
        help="Override a numeric detector threshold. May be passed multiple times.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero when critical inefficiencies are detected.",
    )
    return parser


def run(args: argparse.Namespace, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    try:
        thresholds = apply_threshold_overrides(args.threshold)
    except ValueError as exc:
        print(str(exc), file=stderr)
        return 2

    runtime_samples = limit_history(list(iter_runtime_summary_samples(Path(args.runtime_summary_dir).expanduser())), args.history_limit)
    monitor_samples = limit_history(list(iter_monitor_samples(Path(args.monitor_dir).expanduser())), args.history_limit)
    generated_at = datetime.now(timezone.utc)
    report = build_report(runtime_samples, monitor_samples, thresholds, generated_at=generated_at)
    json_path, md_path = write_report_artifacts(report, Path(args.output_dir), generated_at)

    output = {
        "ok": report["status"] not in {"critical", "no-data"},
        "status": report["status"],
        "criticalCount": nested_value(report, "summary", "criticalCount"),
        "warningCount": nested_value(report, "summary", "warningCount"),
        "report": str(json_path),
        "summary": str(md_path),
    }
    stdout.write(json.dumps(output, sort_keys=True) + "\n")

    if args.check and report["status"] in {"critical", "no-data"}:
        return 1
    return 0


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return run(args, stdout=stdout, stderr=stderr)


if __name__ == "__main__":
    raise SystemExit(main())
