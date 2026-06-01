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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import screeps_world_profiles as world_profiles


DEFAULT_API_URL = "https://screeps.com"
DEFAULT_OUT_DIR = Path("/root/screeps/runtime-artifacts/screeps-monitor")
DEFAULT_STATE_FILE = Path("/root/.hermes/screeps-runtime-monitor/state.json")
DEFAULT_CACHE_DIR = Path("/root/.hermes/screeps-runtime-monitor/terrain-cache")
DEFAULT_RUNTIME_SUMMARY_OUT_DIR = Path("/root/screeps/runtime-artifacts/runtime-summary-console")
DEFAULT_DEBOUNCE_SECONDS = 300
DEFAULT_COLLECTION_ATTEMPTS = 3
DEFAULT_COLLECTION_RETRY_DELAY_SECONDS = 5
DEFAULT_SHARD = world_profiles.PERSISTENT_DEFAULTS.shard
DEFAULT_ROOM = world_profiles.PERSISTENT_DEFAULTS.room
WORLD_PROFILE_ENV = world_profiles.WORLD_PROFILE_ENV
RAMPART_DECAY_HITS_PER_EVENT = 300
RAMPART_DECAY_EVENT_TICKS = 100
RAMPART_DECAY_RECENT_HOSTILE_TICKS = RAMPART_DECAY_EVENT_TICKS
RAMPART_SAFE_DECAY_HITS_FLOOR = 10_000
RAMPART_CRITICAL_DAMAGE_DELTA = 5_000
RAMPART_CRITICAL_DAMAGE_HITS_CEILING = 121_000
RUNTIME_SUMMARY_PREFIX = "#runtime-summary "
RUNTIME_CPU_SUMMARY_PREFIX = "#cpu-summary "
WORKER_IDLE_COLLAPSE_KIND = "worker_idle_collapse"
WORKER_IDLE_COLLAPSE_TICK_THRESHOLD = 20
WORKER_IDLE_COLLAPSE_REQUIRED_CONSECUTIVE = 2
EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND = "extension_count_zero_at_rcl_ge_2"
WORKER_ASSIGNMENT_GAP_BLOCKED_REASON = "worker_assignment_gap"
WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND = "worker_assignment_gap_sustained"
WORKER_ASSIGNMENT_GAP_REQUIRED_TICKS = 100
WORKER_ASSIGNMENT_GAP_RECOVERY_TICK_TOLERANCE = 0
WORKER_ASSIGNMENT_STALL_KIND = "worker_assignment_stall"
WORKER_ASSIGNMENT_STALL_REQUIRED_TICKS = 100
WORKER_ASSIGNMENT_STALL_REQUIRED_CONSECUTIVE_CAPTURES = 4
RUNTIME_SUMMARY_CAPTURE_HISTORY_LIMIT = 12
RUNTIME_SUMMARY_TICK_METADATA_KEY = "__runtimeSummaryTick"
RUNTIME_SUMMARY_ARTIFACT_TIMESTAMP_METADATA_KEY = "__runtimeSummaryArtifactTimestamp"
RUNTIME_SUMMARY_ARTIFACT_PATH_METADATA_KEY = "__runtimeSummaryArtifactPath"
RUNTIME_SUMMARY_ARTIFACT_LINE_METADATA_KEY = "__runtimeSummaryArtifactLine"
RUNTIME_SUMMARY_CAPTURE_HISTORY_METADATA_KEY = "__runtimeSummaryCaptureHistory"
RUNTIME_SUMMARY_SOURCE_METADATA_KEY = "__runtimeSummarySource"
RUNTIME_SUMMARY_CPU_METADATA_KEY = "__runtimeSummaryCpu"
MONITOR_RUNTIME_SUMMARY_SOURCE = "screeps-runtime-monitor"
ASSIGNED_WORKER_TASK_NAMES = ("harvest", "transfer", "build", "repair", "upgrade")
BUILD_BLOCKED_REASON_PATHS = (
    ("buildBlockedReason",),
    ("resources", "productiveEnergy", "buildBlockedReason"),
    ("construction", "buildBlockedReason"),
)
WORKER_ASSIGNMENT_EVIDENCE_AVAILABLE_PATHS = (
    ("workerAssignmentEvidenceAvailable",),
    ("resources", "productiveEnergy", "workerAssignmentEvidenceAvailable"),
    ("productiveEnergy", "workerAssignmentEvidenceAvailable"),
)
WORKER_ASSIGNMENT_BLOCKED_DETAIL_EVIDENCE_PATHS = (
    ("workerAssignmentBlockedDetail",),
    ("resources", "productiveEnergy", "workerAssignmentBlockedDetail"),
    ("productiveEnergy", "workerAssignmentBlockedDetail"),
)
WORKER_ASSIGNMENT_BLOCKED_WORKERS_EVIDENCE_PATHS = (
    ("workerAssignmentBlockedWorkers",),
    ("resources", "productiveEnergy", "workerAssignmentBlockedWorkers"),
    ("productiveEnergy", "workerAssignmentBlockedWorkers"),
)
PRODUCTIVE_ASSIGNMENT_COUNT_PATHS = (
    ("workerAssignmentEvidence", "productiveAssignmentCount"),
    ("resources", "productiveEnergy", "productiveAssignmentCount"),
    ("productiveEnergy", "productiveAssignmentCount"),
    ("productiveAssignmentCount",),
    ("resources", "productiveEnergy", "assignedWorkerCount"),
    ("productiveEnergy", "assignedWorkerCount"),
    ("assignedWorkerCount",),
)
WORKER_ASSIGNMENT_BLOCKED_WORKER_STRING_FIELDS = (
    "name",
    "task",
    "buildBlockedReason",
    "repairBlockedReason",
    "dispatchAssignedTargetId",
    "dispatchAssignedTask",
    "dispatchBaseSelectedTargetId",
    "dispatchBaseSelectedTask",
    "dispatchCurrentTargetId",
    "dispatchEnergyCriticalTargetId",
    "dispatchEnergyCriticalTask",
    "dispatchReason",
    "dispatchSelectedTargetId",
    "dispatchSelectedTask",
    "dispatchSpawnReservationTargetId",
    "dispatchSpawnReservationTask",
)
WORKER_ASSIGNMENT_BLOCKED_WORKER_NUMBER_FIELDS = (
    "carriedEnergy",
    "dispatchTick",
    "freeCapacity",
)
ENERGY_BUFFER_UNHEALTHY_KIND = "energy_buffer_unhealthy"
ENERGY_BUFFER_UNHEALTHY_REQUIRED_CONSECUTIVE = 2
ENERGY_BUFFER_UNHEALTHY_ROUTES = [
    {"issue": "#906", "topic": "metric_taxonomy"},
    {"issue": "#907", "topic": "reward_decisions"},
]
CPU_BUCKET_LOW_KIND = "cpu_bucket_low"
CPU_BUCKET_CRITICAL_KIND = "cpu_bucket_critical"
CPU_BUCKET_LOW_THRESHOLD = 1_000
CPU_BUCKET_CRITICAL_THRESHOLD = 100
CPU_BUCKET_ROUTES = [
    {"issue": "#1490", "topic": "runtime_alert"},
    {"issue": "#906", "topic": "metric_taxonomy"},
    {"issue": "#924", "topic": "scorecard_gate"},
]
CONSTRUCTION_DEADLOCK_KIND = "construction_deadlock_ticks"
CONSTRUCTION_DEADLOCK_P1_TICKS = 100
CONSTRUCTION_DEADLOCK_P0_TICKS = 500
EXTENSION_BOOTSTRAP_PROGRESS_STALL_TICKS = 100
CONSTRUCTION_DEADLOCK_ROUTES = [
    {"issue": "#906", "topic": "gameplay_behavior_metric"},
    {"issue": "#1025", "topic": "construction_deadlock_ticks"},
]
WORKER_ASSIGNMENT_STALL_ROUTES = [
    {"issue": "#1580", "topic": "worker_deadlock_alert"},
    {"issue": "#1553", "topic": "e29n57_worker_deadlock"},
    {"issue": "#1573", "topic": "worker_deadlock_alert"},
    {"issue": "#906", "topic": "gameplay_behavior_metric"},
]

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

ENERGY_STORAGE_STRUCTURE_TYPES = {
    "container",
    "extension",
    "spawn",
    "storage",
}

TACTICAL_SEVERITY_RANK = {
    "none": 0,
    "warning": 1,
    "high": 2,
    "critical": 3,
}

TACTICAL_PRIORITY_BY_SEVERITY = {
    "none": None,
    "warning": "P2",
    "high": "P1",
    "critical": "P0",
}

ROOM_DEATH_REASON_KINDS = {
    "room_dead",
    "postdeploy_room_dead",
}

NO_OWNED_SPAWN_REASON_KINDS = {
    "no_owned_spawn",
    "no_spawn_recovery",
    "owned_spawns=0",
    "postdeploy_no_owned_spawn",
}

DEBOUNCE_BYPASS_REASON_KINDS = {
    "room_dead",
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
    "room_dead": {
        "severity": "critical",
        "decision": "autonomous_recovery_authorized",
        "actions": ["capture_runtime_context", "start_autonomous_recovery", "start_hotfix_gate"],
    },
    EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND: {
        "severity": "critical",
        "decision": "codex_hotfix_or_rollback",
        "actions": ["capture_runtime_context", "compare_baseline", "start_hotfix_gate"],
    },
    WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND: {
        "severity": "critical",
        "decision": "codex_hotfix",
        "actions": ["capture_runtime_context", "inspect_resource_state", "start_hotfix_gate"],
    },
    WORKER_ASSIGNMENT_STALL_KIND: {
        "severity": "warning",
        "decision": "open_issue_or_codex_hotfix",
        "actions": ["capture_runtime_context", "inspect_resource_state", "open_incident_issue"],
        "metadata": {
            "metric": "workerAssignmentEvidence.productiveAssignmentCount",
            "related_issues": ["#1580", "#1553", "#1573", "#906"],
            "thresholds": {
                "P2_ticks": WORKER_ASSIGNMENT_STALL_REQUIRED_TICKS,
                "P2_consecutive_captures": WORKER_ASSIGNMENT_STALL_REQUIRED_CONSECUTIVE_CAPTURES,
            },
            "routes_to": WORKER_ASSIGNMENT_STALL_ROUTES,
        },
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
    "runtime_exception": {
        "severity": "critical",
        "decision": "codex_hotfix_or_rollback",
        "actions": ["capture_runtime_context", "inspect_recent_deploy", "start_hotfix_gate"],
    },
    "runtime_deadlock": {
        "severity": "critical",
        "decision": "codex_hotfix_or_rollback",
        "actions": ["capture_runtime_context", "inspect_runtime_deadlock", "start_hotfix_gate"],
    },
    "resource_crisis": {
        "severity": "high",
        "decision": "owner_action_or_codex_hotfix",
        "actions": ["capture_runtime_context", "inspect_resource_state", "start_hotfix_gate"],
    },
    CPU_BUCKET_CRITICAL_KIND: {
        "severity": "critical",
        "decision": "codex_hotfix",
        "actions": ["capture_runtime_context", "inspect_recent_deploy", "start_hotfix_gate"],
        "metadata": {
            "metric": "cpu.bucket",
            "related_issues": ["#1490", "#906", "#924"],
            "thresholds": {"P1": CPU_BUCKET_LOW_THRESHOLD, "P0": CPU_BUCKET_CRITICAL_THRESHOLD},
            "routes_to": CPU_BUCKET_ROUTES,
        },
    },
    CPU_BUCKET_LOW_KIND: {
        "severity": "high",
        "decision": "codex_hotfix",
        "actions": ["capture_runtime_context", "inspect_recent_deploy", "start_hotfix_gate"],
        "metadata": {
            "metric": "cpu.bucket",
            "related_issues": ["#1490", "#906", "#924"],
            "thresholds": {"P1": CPU_BUCKET_LOW_THRESHOLD, "P0": CPU_BUCKET_CRITICAL_THRESHOLD},
            "routes_to": CPU_BUCKET_ROUTES,
        },
    },
    "energy_buffer_unhealthy": {
        "severity": "high",
        "decision": "metric_taxonomy_and_reward_decision_followup",
        "actions": ["capture_runtime_context", "inspect_resource_state", "open_incident_issue"],
        "metadata": {
            "related_issues": ["#906", "#907"],
            "routes_to": ENERGY_BUFFER_UNHEALTHY_ROUTES,
        },
    },
    CONSTRUCTION_DEADLOCK_KIND: {
        "severity": "high",
        "decision": "codex_hotfix",
        "actions": ["capture_runtime_context", "inspect_resource_state", "start_hotfix_gate"],
        "metadata": {
            "metric": "constructionDeadlockTicks",
            "related_issues": ["#906", "#1025"],
            "thresholds": {"P1": CONSTRUCTION_DEADLOCK_P1_TICKS, "P0": CONSTRUCTION_DEADLOCK_P0_TICKS},
            "routes_to": CONSTRUCTION_DEADLOCK_ROUTES,
        },
    },
    "worker_idle_collapse": {
        "severity": "high",
        "decision": "codex_hotfix_or_owner_action",
        "actions": ["capture_runtime_context", "inspect_resource_state", "inspect_spawn_recovery", "start_hotfix_gate"],
    },
    "private_smoke_failure": {
        "severity": "high",
        "decision": "main_agent_triage",
        "actions": ["capture_runtime_context", "inspect_private_smoke_report", "open_incident_issue"],
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
    "room_ownership_lost": ["spawn_collapse"],
    "room_dead": ["room_dead", "spawn_collapse"],
    "no_workers_no_recovery": ["spawn_collapse"],
    "no_spawn_recovery": ["spawn_collapse"],
    "postdeploy_room_dead": ["room_dead", "spawn_collapse"],
    EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND: [EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND],
    WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND: [WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND],
    WORKER_ASSIGNMENT_STALL_KIND: [WORKER_ASSIGNMENT_STALL_KIND],
    "postdeploy_no_owned_spawn": ["spawn_collapse"],
    "owned_spawns=0": ["spawn_collapse"],
    "controller_downgrade_risk": ["downgrade_risk"],
    "downgrade_risk": ["downgrade_risk"],
    "telemetry_silence": ["telemetry_silence"],
    "runtime_summary_silence": ["telemetry_silence"],
    "loop_exception": ["runtime_exception", "telemetry_silence"],
    "runtime_exception": ["runtime_exception"],
    "runtime_deadlock": ["runtime_deadlock"],
    "resource_crisis": ["resource_crisis"],
    CPU_BUCKET_CRITICAL_KIND: [CPU_BUCKET_CRITICAL_KIND],
    CPU_BUCKET_LOW_KIND: [CPU_BUCKET_LOW_KIND],
    "energy_buffer_unhealthy": ["energy_buffer_unhealthy"],
    CONSTRUCTION_DEADLOCK_KIND: [CONSTRUCTION_DEADLOCK_KIND],
    "worker_idle_collapse": ["worker_idle_collapse"],
    "private_smoke_failed_phase": ["private_smoke_failure"],
    "private_smoke_runtime_failure": ["private_smoke_failure"],
    "private_smoke_telemetry_silence": ["telemetry_silence", "private_smoke_failure"],
    "private_smoke_runtime_deadlock": ["runtime_deadlock", "private_smoke_failure"],
    "private_smoke_spawn_collapse": ["spawn_collapse", "private_smoke_failure"],
    "private_smoke_no_worker_evidence": ["spawn_collapse", "private_smoke_failure"],
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
    "start_autonomous_recovery": {
        "owner": "scheduler-wrapper",
        "action": "For room_dead with owned_spawns=0 and owned_creeps=0, trigger authorized recovery: POST /api/game/respawn with body {room: \"shardX/{roomName}\"}, then deploy the last-known-healthy commit; escalate only if recovery is blocked.",
        "decision": "autonomous_recovery_authorized",
    },
    "inspect_controller": {
        "owner": "main-agent",
        "action": "Check controller level, ticks-to-downgrade, upgrader presence, available energy, and spawn availability before selecting observe, hotfix, or owner action.",
        "decision": "owner_action_or_hotfix",
    },
    "inspect_runtime_deadlock": {
        "owner": "main-agent",
        "action": "Inspect private-smoke/runtime stats for tick progress, owned room count, spawn availability, creep count, and repeated no-progress criteria failures.",
        "decision": "codex_hotfix_or_rollback",
    },
    "inspect_resource_state": {
        "owner": "main-agent",
        "action": "Check available energy, worker carry, dropped energy, sources, spawn queue, and whether the bot can recover harvesting without owner action.",
        "decision": "owner_action_or_hotfix",
    },
    "inspect_private_smoke_report": {
        "owner": "main-agent",
        "action": "Inspect the private-smoke report phases, stats polling details, room spawn evidence, worker evidence, and sanitized failure excerpts.",
        "decision": "main_agent_triage",
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
    owner_id: str | None
    state_file: Path
    cache_dir: Path
    debounce_seconds: int
    collection_attempts: int
    collection_retry_delay_seconds: float

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
    expected_owner: str | None = None
    expected_owner_id: str | None = None

    @property
    def counts(self) -> Counter:
        return Counter(
            obj.get("type", "?")
            for obj in self.objects.values()
            if isinstance(obj, dict)
        )


@dataclass
class RoomSummaryMetrics:
    structures: list[dict[str, Any]]
    controller_summary: dict[str, Any]
    owned_creep_objects: list[dict[str, Any]]
    task_counts: dict[str, int]
    worker_assignment_evidence_available: bool
    construction_sites: list[dict[str, Any]]
    pending_build_progress: int | float
    build_carried_energy: int | float
    build_blocked_reason: str | None
    construction_deadlock_ticks: int | float
    extension_count: int
    extension_capacity_contribution: int | float
    extension_construction_site_count: int
    extension_pending_build_progress: int | float
    stored_energy: int | float
    cpu_used: int | float | None
    cpu_bucket: int | float | None
    rcl_level: int | float | None


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


def is_owned_object(obj: dict[str, Any], owner_username: str | None, owner_id: str | None = None) -> bool:
    if obj.get("my") is True:
        return True
    username = room_owner(obj)
    if owner_username and username == owner_username:
        return True
    return bool(owner_id and obj.get("user") == owner_id)


def infer_owner(
    objects: dict[str, dict[str, Any]], configured_owner: str | None = None, configured_owner_id: str | None = None
) -> str | None:
    for obj in objects.values():
        if not isinstance(obj, dict):
            continue
        if obj.get("my") is True or (configured_owner_id and obj.get("user") == configured_owner_id):
            return room_owner(obj) or configured_owner or configured_owner_id
    for obj in objects.values():
        if not isinstance(obj, dict) or obj.get("type") != "controller":
            continue
        username = room_owner(obj)
        if username:
            return username
        if configured_owner_id and obj.get("user") == configured_owner_id:
            return configured_owner or configured_owner_id
    return None


def normalize_objects(raw_objects: Any) -> dict[str, dict[str, Any]]:
    if isinstance(raw_objects, list):
        objects: dict[str, dict[str, Any]] = {}
        for index, obj in enumerate(raw_objects):
            if isinstance(obj, dict):
                normalized = dict(obj)
                object_id = normalized.get("_id") or normalized.get("id") or f"object-{index}"
                normalized.setdefault("_id", object_id)
                objects[str(object_id)] = normalized
        return objects
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
            raise ValueError(f"--room must use shard/room, for example {DEFAULT_SHARD}/{DEFAULT_ROOM}")
        return RoomRef(shard=shard, room=room)
    return RoomRef(shard=default_shard, room=value)


def env_default(name: str, default: str) -> str:
    return os.environ[name] if name in os.environ else default


def context_from_env(world_profile: str | None = None) -> RuntimeContext:
    profile = world_profiles.resolve_world_profile(world_profile, os.environ)
    token = os.environ.get("SCREEPS_AUTH_TOKEN")
    if not token:
        raise RuntimeError("SCREEPS_AUTH_TOKEN is required for live summary and alert commands")
    debounce = int(os.environ.get("SCREEPS_ALERT_DEBOUNCE_SECONDS", DEFAULT_DEBOUNCE_SECONDS))
    collection_attempts = max(1, int(os.environ.get("SCREEPS_MONITOR_COLLECTION_ATTEMPTS", DEFAULT_COLLECTION_ATTEMPTS)))
    collection_retry_delay_seconds = max(
        0.0,
        float(os.environ.get("SCREEPS_MONITOR_COLLECTION_RETRY_DELAY_SECONDS", DEFAULT_COLLECTION_RETRY_DELAY_SECONDS)),
    )
    return RuntimeContext(
        base_http=env_default("SCREEPS_API_URL", profile.api_url).rstrip("/"),
        token=token,
        default_shard=env_default("SCREEPS_SHARD", profile.shard),
        default_room=os.environ.get("SCREEPS_ROOM", profile.room or DEFAULT_ROOM),
        owner=os.environ.get("SCREEPS_OWNER"),
        owner_id=os.environ.get("SCREEPS_OWNER_ID"),
        state_file=Path(env_default("SCREEPS_MONITOR_STATE_FILE", str(profile.monitor_state_file))),
        cache_dir=Path(env_default("SCREEPS_MONITOR_CACHE_DIR", str(profile.monitor_cache_dir))),
        debounce_seconds=debounce,
        collection_attempts=collection_attempts,
        collection_retry_delay_seconds=collection_retry_delay_seconds,
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


def user_identity(ctx: RuntimeContext, warnings: list[str]) -> tuple[str | None, str | None]:
    if ctx.owner or ctx.owner_id:
        return ctx.owner, ctx.owner_id
    try:
        auth = get_json(ctx.base_http, ctx.token, "/api/auth/me")
    except Exception as exc:  # noqa: BLE001 - sanitized in caller payload
        warnings.append(f"authenticated user discovery unavailable: {short_text(exc, 140)}")
        return None, None
    if not isinstance(auth, dict):
        return None, None
    username = auth.get("username") if isinstance(auth.get("username"), str) else None
    user_id = auth.get("_id") if isinstance(auth.get("_id"), str) else None
    return username, user_id


def overview_rooms(overview: Any, shard: str) -> list[str]:
    if not isinstance(overview, dict):
        return []
    shard_info = (overview.get("shards") or {}).get(shard)
    if not isinstance(shard_info, dict):
        return []
    rooms = shard_info.get("rooms")
    if not isinstance(rooms, list):
        return []
    return [room for room in rooms if isinstance(room, str)]


def overview_room_refs(overview: Any) -> list[RoomRef]:
    if not isinstance(overview, dict):
        return []
    shards = overview.get("shards")
    if not isinstance(shards, dict):
        return []

    refs: list[RoomRef] = []
    for shard in sorted(shards):
        shard_info = shards.get(shard)
        if not isinstance(shard_info, dict):
            continue
        for room in shard_info.get("rooms") or []:
            if isinstance(room, str):
                refs.append(RoomRef(shard=shard, room=room))
    return refs


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


def discover_owned_rooms(ctx: RuntimeContext, forced_room: RoomRef | None) -> tuple[list[RoomRef], Any, list[str], list[RoomRef]]:
    warnings: list[str] = []
    overview: Any = None
    try:
        overview = get_json(ctx.base_http, ctx.token, "/api/user/overview")
    except Exception as exc:  # noqa: BLE001 - sanitized in user payload
        warnings.append(f"owned room discovery unavailable: {short_text(exc, 140)}")

    overview_refs = overview_room_refs(overview)
    if forced_room:
        return [forced_room], overview, warnings, overview_refs

    if overview_refs:
        return overview_refs, overview, warnings, overview_refs

    fallback = RoomRef(ctx.default_shard, ctx.default_room)
    warnings.append(f"falling back to configured room {fallback.key}")
    return [fallback], overview, warnings, [fallback]


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


def fetch_room_event_http(ctx: RuntimeContext, ref: RoomRef) -> dict[str, Any]:
    response = get_json(
        ctx.base_http,
        ctx.token,
        "/api/game/room-objects",
        {"room": ref.room, "shard": ref.shard},
    )
    if not isinstance(response, dict):
        raise RuntimeError("room-objects response was not a JSON object")
    objects = response.get("objects")
    if objects is None:
        raise RuntimeError("room-objects response did not include objects")
    return {
        "objects": objects,
        "gameTime": response.get("gameTime") or response.get("time") or response.get("tick"),
        "info": response.get("info") if isinstance(response.get("info"), dict) else {},
        "source": "http-room-objects",
    }


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


def collect_snapshots(ctx: RuntimeContext, room_arg: str | None) -> tuple[list[RoomSnapshot], list[str], list[RoomRef]]:
    forced_room = parse_room_arg(room_arg, ctx.default_shard)
    refs, overview, warnings, overview_refs = discover_owned_rooms(ctx, forced_room)
    configured_owner, configured_owner_id = user_identity(ctx, warnings)
    configured_owner = configured_owner or overview_username(overview)
    snapshots: list[RoomSnapshot] = []

    for ref in refs:
        terrain: str | None = None
        room_warnings: list[str] = []
        for attempt in range(1, ctx.collection_attempts + 1):
            try:
                if terrain is None:
                    terrain = fetch_terrain(ctx, ref, warnings)
                try:
                    event = asyncio.run(fetch_room_event(ctx, ref))
                except Exception as websocket_exc:  # noqa: BLE001 - fall back to the HTTP room snapshot endpoint
                    error_text = short_text(redact_secrets(str(websocket_exc), [ctx.token]), 180)
                    room_warnings.append(
                        f"{ref.key} websocket snapshot attempt {attempt}/{ctx.collection_attempts} failed; using HTTP fallback: {error_text}"
                    )
                    event = fetch_room_event_http(ctx, ref)
                objects = normalize_objects(event.get("objects"))
                owner = infer_owner(objects, configured_owner, configured_owner_id)
                tick = event.get("gameTime") or event.get("time") or gametime_from_overview(overview, ref.shard)
                snapshots.append(
                    RoomSnapshot(
                        ref=ref,
                        terrain=terrain,
                        objects=objects,
                        tick=tick,
                        owner=owner,
                        info=event.get("info") if isinstance(event.get("info"), dict) else {},
                        expected_owner=configured_owner,
                        expected_owner_id=configured_owner_id,
                    )
                )
                if room_warnings:
                    warnings.extend(room_warnings)
                break
            except Exception as exc:  # noqa: BLE001 - report room-level failures without secrets
                error_text = short_text(redact_secrets(str(exc), [ctx.token]), 180)
                room_warnings.append(
                    f"{ref.key} collection attempt {attempt}/{ctx.collection_attempts} failed: {error_text}"
                )
                if attempt < ctx.collection_attempts and ctx.collection_retry_delay_seconds > 0:
                    time.sleep(ctx.collection_retry_delay_seconds)
        else:
            warnings.extend(room_warnings)

    if not snapshots:
        detail = "; ".join(warnings[-12:]) if warnings else "no collection warnings recorded"
        raise RuntimeError(f"no room snapshots collected: {detail}")
    return snapshots, warnings, overview_refs


def detect_hostile_creeps(objects: dict[str, dict[str, Any]], owner_username: str | None) -> list[dict[str, Any]]:
    hostiles: list[dict[str, Any]] = []
    for obj in objects.values():
        if not isinstance(obj, dict) or obj.get("type") != "creep":
            continue
        username = room_owner(obj)
        if obj.get("my") is False or (owner_username and username and username != owner_username):
            hostiles.append(obj)
    return hostiles


def structure_snapshot(
    objects: dict[str, dict[str, Any]], owner_username: str | None, owner_id: str | None = None
) -> dict[str, dict[str, Any]]:
    structures: dict[str, dict[str, Any]] = {}
    for object_id, obj in objects.items():
        if not isinstance(obj, dict):
            continue
        object_type = obj.get("type")
        if object_type not in STRUCTURE_TYPES:
            continue
        owned = is_owned_object(obj, owner_username, owner_id)
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
    hits_max = current.get("hitsMax")
    return {
        "kind": "structure_damage",
        "room": ref.key,
        "object_id": object_id,
        "structure_type": current.get("type"),
        "x": current.get("x"),
        "y": current.get("y"),
        "previous_hits": old_hits,
        "current_hits": new_hits,
        "hitsMax": hits_max,
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


def count_owned_objects(
    objects: dict[str, dict[str, Any]], owner_username: str | None, object_type: str, owner_id: str | None = None
) -> int:
    return sum(
        1
        for obj in objects.values()
        if isinstance(obj, dict) and obj.get("type") == object_type and is_owned_object(obj, owner_username, owner_id)
    )


def count_owned_spawns(structures: dict[str, dict[str, Any]]) -> int:
    return sum(
        1
        for structure in structures.values()
        if isinstance(structure, dict) and structure.get("type") == "spawn" and structure.get("owned") is True
    )


def previous_critical_spawn_count(previous_structures: dict[str, Any]) -> int:
    return sum(
        1
        for structure in previous_structures.values()
        if isinstance(structure, dict)
        and structure.get("type") == "spawn"
        and structure.get("owned") is True
        and structure.get("critical") is True
    )


def build_survival_reason(ref: RoomRef, kind: str, message: str, **details: Any) -> dict[str, Any]:
    return {
        "kind": kind,
        "room": ref.key,
        "message": message,
        "signature": f"{kind}:{ref.key}",
        **details,
    }


def runtime_task_count(room: dict[str, Any], task_name: str) -> int | float | None:
    return number_value(as_dict(room.get("taskCounts")).get(task_name))


def runtime_worker_count(room: dict[str, Any], behavior_entries: list[dict[str, Any]]) -> int:
    worker_count = number_value(room.get("workerCount"))
    if worker_count is not None:
        return max(0, int(worker_count))

    task_counts = as_dict(room.get("taskCounts"))
    counted_workers = sum(value for value in (number_value(item) for item in task_counts.values()) if value is not None)
    if counted_workers > 0:
        return int(counted_workers)
    return len(behavior_entries)


def runtime_spawn_idle(room: dict[str, Any], owned_spawns: int) -> bool:
    if owned_spawns <= 0:
        return False
    raw_statuses = room.get("spawnStatus")
    if raw_statuses is None:
        return False
    if not isinstance(raw_statuses, list) or not raw_statuses:
        return False

    statuses: list[Any] = []
    for raw_status in raw_statuses:
        if isinstance(raw_status, dict):
            statuses.append(raw_status.get("status"))
        else:
            statuses.append(raw_status)
    return all(status == "idle" for status in statuses)


def runtime_worker_behavior_entries(room: dict[str, Any]) -> list[dict[str, Any]]:
    behavior = as_dict(room.get("behavior"))
    candidates = (
        behavior.get("creeps"),
        behavior.get("topIdleWorkers"),
        room.get("workerBehavior"),
        room.get("workers"),
        room.get("creeps"),
    )
    for candidate in candidates:
        if not isinstance(candidate, list):
            continue
        entries = [entry for entry in candidate if isinstance(entry, dict)]
        if entries:
            return entries
    return []


def worker_behavior_entries_for_workers(entries: list[dict[str, Any]], worker_count: int) -> list[dict[str, Any]]:
    tagged_workers = [
        entry
        for entry in entries
        if entry.get("role") == "worker"
        or (isinstance(entry.get("creepName"), str) and str(entry.get("creepName")).startswith("worker"))
        or (isinstance(entry.get("name"), str) and str(entry.get("name")).startswith("worker"))
    ]
    return tagged_workers if len(tagged_workers) >= worker_count else entries


def all_workers_idle_or_stuck(room: dict[str, Any]) -> tuple[bool, int, int, int]:
    entries = runtime_worker_behavior_entries(room)
    worker_count = runtime_worker_count(room, entries)
    if worker_count <= 0 or len(entries) < worker_count:
        return False, worker_count, 0, 0

    worker_entries = worker_behavior_entries_for_workers(entries, worker_count)
    if len(worker_entries) < worker_count:
        return False, worker_count, 0, 0

    idle_count = sum(
        1
        for entry in worker_entries
        if (number_value(entry.get("idleTicks")) or 0) > WORKER_IDLE_COLLAPSE_TICK_THRESHOLD
    )
    stuck_count = sum(
        1
        for entry in worker_entries
        if (number_value(entry.get("stuckTicks")) or 0) > WORKER_IDLE_COLLAPSE_TICK_THRESHOLD
    )
    return idle_count >= worker_count or stuck_count >= worker_count, worker_count, idle_count, stuck_count


def runtime_energy_at_risk(room: dict[str, Any]) -> tuple[bool, int | float | None, int | float | None, dict[str, Any]]:
    available = number_value(room.get("energyAvailable"))
    capacity = number_value(room.get("energyCapacity"))
    buffer_health = as_dict(room.get("energyBufferHealth"))
    buffer_current = number_value(buffer_health.get("currentEnergy"))
    buffer_threshold = number_value(buffer_health.get("threshold"))

    current_energy = available if available is not None else buffer_current
    capacity_energy = capacity if capacity is not None else number_value(room.get("energyCapacityAvailable"))
    below_capacity = available is not None and capacity is not None and available < capacity
    unhealthy_buffer = (
        buffer_health.get("healthy") is False
        and buffer_current is not None
        and buffer_threshold is not None
        and buffer_current < buffer_threshold
    )
    return below_capacity or unhealthy_buffer, current_energy, capacity_energy, buffer_health


def energy_buffer_route_metadata() -> dict[str, Any]:
    return {
        "related_issues": [str(route["issue"]) for route in ENERGY_BUFFER_UNHEALTHY_ROUTES],
        "routes_to": [dict(route) for route in ENERGY_BUFFER_UNHEALTHY_ROUTES],
    }


def construction_deadlock_metadata() -> dict[str, Any]:
    return {
        "metric": "constructionDeadlockTicks",
        "related_issues": [str(route["issue"]) for route in CONSTRUCTION_DEADLOCK_ROUTES],
        "thresholds": {"P1": CONSTRUCTION_DEADLOCK_P1_TICKS, "P0": CONSTRUCTION_DEADLOCK_P0_TICKS},
        "routes_to": [dict(route) for route in CONSTRUCTION_DEADLOCK_ROUTES],
    }


def worker_assignment_stall_metadata() -> dict[str, Any]:
    return {
        "metric": "workerAssignmentEvidence.productiveAssignmentCount",
        "related_issues": [str(route["issue"]) for route in WORKER_ASSIGNMENT_STALL_ROUTES],
        "thresholds": {
            "P2_ticks": WORKER_ASSIGNMENT_STALL_REQUIRED_TICKS,
            "P2_consecutive_captures": WORKER_ASSIGNMENT_STALL_REQUIRED_CONSECUTIVE_CAPTURES,
        },
        "routes_to": [dict(route) for route in WORKER_ASSIGNMENT_STALL_ROUTES],
    }


def format_energy_value(value: int | float | None) -> str:
    if value is None:
        return "unknown"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def cpu_bucket_metadata() -> dict[str, Any]:
    return {
        "metric": "cpu.bucket",
        "related_issues": [str(route["issue"]) for route in CPU_BUCKET_ROUTES],
        "thresholds": {"P1": CPU_BUCKET_LOW_THRESHOLD, "P0": CPU_BUCKET_CRITICAL_THRESHOLD},
        "routes_to": [dict(route) for route in CPU_BUCKET_ROUTES],
    }


def string_list_values(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


def runtime_cpu_signal_values(room: dict[str, Any], field: str) -> list[str]:
    values: list[str] = []
    for candidate in (
        nested_value(room, RUNTIME_SUMMARY_CPU_METADATA_KEY, field),
        nested_value(room, "cpu", field),
        room.get(field),
    ):
        for item in string_list_values(candidate):
            if item not in values:
                values.append(item)
    return values


def runtime_cpu_pressure(room: dict[str, Any]) -> str | None:
    for candidate in (
        nested_value(room, RUNTIME_SUMMARY_CPU_METADATA_KEY, "pressure"),
        nested_value(room, "cpu", "pressure"),
        room.get("pressure"),
    ):
        if isinstance(candidate, str) and candidate in {"normal", "degraded", "critical"}:
            return candidate
    return None


def runtime_cpu_bucket(room: dict[str, Any]) -> int | float | None:
    return first_number_value(
        room,
        ("cpuBucket",),
        ("cpu", "bucket"),
        (RUNTIME_SUMMARY_CPU_METADATA_KEY, "bucket"),
        ("bucket",),
    )


def runtime_cpu_used(room: dict[str, Any]) -> int | float | None:
    return first_number_value(
        room,
        ("cpuUsed",),
        ("cpu", "used"),
        (RUNTIME_SUMMARY_CPU_METADATA_KEY, "used"),
    )


def runtime_cpu_limit(room: dict[str, Any]) -> int | float | None:
    return first_number_value(
        room,
        ("cpuLimit",),
        ("cpu", "limit"),
        (RUNTIME_SUMMARY_CPU_METADATA_KEY, "limit"),
    )


def runtime_low_bucket_ticks(room: dict[str, Any]) -> int | float | None:
    return first_number_value(
        room,
        ("lowBucketTicks",),
        ("cpu", "lowBucketTicks"),
        (RUNTIME_SUMMARY_CPU_METADATA_KEY, "lowBucketTicks"),
    )


def detect_cpu_bucket_kind(runtime_room: dict[str, Any] | None) -> str | None:
    if not isinstance(runtime_room, dict):
        return None

    bucket = runtime_cpu_bucket(runtime_room)
    pressure = runtime_cpu_pressure(runtime_room)
    alerts = set(runtime_cpu_signal_values(runtime_room, "alerts"))
    reasons = set(runtime_cpu_signal_values(runtime_room, "reasons"))

    critical_bucket = (
        pressure == "critical"
        or "criticalBucket" in reasons
        or (bucket is not None and bucket <= CPU_BUCKET_CRITICAL_THRESHOLD)
    )
    if critical_bucket:
        return CPU_BUCKET_CRITICAL_KIND

    low_bucket = (
        "lowBucket" in alerts
        or "lowBucket" in reasons
        or (bucket is not None and bucket < CPU_BUCKET_LOW_THRESHOLD)
    )
    if low_bucket:
        return CPU_BUCKET_LOW_KIND
    return None


def build_cpu_bucket_reason(ref: RoomRef, runtime_room: dict[str, Any], kind: str) -> dict[str, Any]:
    bucket = runtime_cpu_bucket(runtime_room)
    used = runtime_cpu_used(runtime_room)
    limit = runtime_cpu_limit(runtime_room)
    pressure = runtime_cpu_pressure(runtime_room)
    alerts = runtime_cpu_signal_values(runtime_room, "alerts")
    reasons = runtime_cpu_signal_values(runtime_room, "reasons")
    low_bucket_ticks = runtime_low_bucket_ticks(runtime_room)
    critical = kind == CPU_BUCKET_CRITICAL_KIND
    threshold = CPU_BUCKET_CRITICAL_THRESHOLD if critical else CPU_BUCKET_LOW_THRESHOLD
    severity = "critical" if critical else "high"
    priority = "P0" if critical else "P1"
    return {
        "kind": kind,
        "room": ref.key,
        "room_name": ref.room,
        "severity": severity,
        "priority": priority,
        "cpuBucket": bucket,
        "cpu_bucket": bucket,
        "bucket": bucket,
        "cpuUsed": used,
        "cpuLimit": limit,
        "pressure": pressure,
        "alerts": alerts,
        "reasons": reasons,
        "lowBucketTicks": low_bucket_ticks,
        "threshold": threshold,
        "low_bucket_threshold": CPU_BUCKET_LOW_THRESHOLD,
        "critical_bucket_threshold": CPU_BUCKET_CRITICAL_THRESHOLD,
        "metadata": cpu_bucket_metadata(),
        "message": (
            f"{kind} in {ref.key}: cpu bucket {format_energy_value(bucket)} below "
            f"{threshold} threshold; pressure={pressure or 'unknown'}, alerts={alerts or []}, "
            f"reasons={reasons or []}."
        ),
        "signature": f"{kind}:{ref.key}",
    }


def detect_cpu_bucket_reason(ref: RoomRef, runtime_room: dict[str, Any] | None) -> dict[str, Any] | None:
    kind = detect_cpu_bucket_kind(runtime_room)
    if kind is None or not isinstance(runtime_room, dict):
        return None
    return build_cpu_bucket_reason(ref, runtime_room, kind)


def build_energy_buffer_unhealthy_reason(
    ref: RoomRef,
    room: dict[str, Any],
    consecutive: int,
    build_count: int | float,
    upgrade_count: int | float,
    buffer_health: dict[str, Any],
) -> dict[str, Any]:
    current_energy = number_value(buffer_health.get("currentEnergy"))
    threshold = number_value(buffer_health.get("threshold"))
    return {
        "kind": ENERGY_BUFFER_UNHEALTHY_KIND,
        "room": ref.key,
        "room_name": ref.room,
        "severity": "high",
        "priority": "P1",
        "build": build_count,
        "upgrade": upgrade_count,
        "task_counts": dict(as_dict(room.get("taskCounts"))),
        "energy_buffer_health": dict(buffer_health),
        "current_energy": current_energy,
        "threshold": threshold,
        "energy_buffer_threshold": threshold,
        "consecutive": consecutive,
        "metadata": energy_buffer_route_metadata(),
        "message": (
            f"energy_buffer_unhealthy in {ref.key}: energyBufferHealth.healthy=false, "
            f"build={format_energy_value(build_count)} upgrade={format_energy_value(upgrade_count)}, "
            f"buffer {format_energy_value(current_energy)}/{format_energy_value(threshold)} for "
            f"{consecutive} consecutive console captures."
        ),
        "signature": f"{ENERGY_BUFFER_UNHEALTHY_KIND}:{ref.key}",
    }


def detect_energy_buffer_unhealthy_reason(
    ref: RoomRef,
    runtime_room: dict[str, Any] | None,
    consecutive: int,
) -> dict[str, Any] | None:
    if not isinstance(runtime_room, dict):
        return None

    buffer_health = as_dict(runtime_room.get("energyBufferHealth"))
    if buffer_health.get("healthy") is not False:
        return None

    build_count = runtime_task_count(runtime_room, "build")
    upgrade_count = runtime_task_count(runtime_room, "upgrade")
    if build_count != 0 or upgrade_count != 0:
        return None

    return build_energy_buffer_unhealthy_reason(
        ref,
        runtime_room,
        consecutive,
        build_count,
        upgrade_count,
        buffer_health,
    )


def runtime_construction_deadlock_ticks(room: dict[str, Any] | None) -> int | float | None:
    if not isinstance(room, dict):
        return None
    return first_number_value(
        room,
        ("constructionDeadlockTicks",),
        ("resources", "productiveEnergy", "constructionDeadlockTicks"),
        ("construction", "constructionDeadlockTicks"),
        ("construction_deadlock_ticks",),
    )


def runtime_pending_build_progress(room: dict[str, Any] | None) -> int | float | None:
    if not isinstance(room, dict):
        return None
    return first_number_value(
        room,
        ("pendingBuildProgress",),
        ("resources", "productiveEnergy", "pendingBuildProgress"),
        ("resources", "pendingBuildProgress"),
        ("construction", "pendingBuildProgress"),
    )


def runtime_build_carried_energy(room: dict[str, Any] | None) -> int | float | None:
    if not isinstance(room, dict):
        return None
    return first_number_value(
        room,
        ("buildCarriedEnergy",),
        ("resources", "productiveEnergy", "buildCarriedEnergy"),
        ("resources", "buildCarriedEnergy"),
        ("construction", "buildCarriedEnergy"),
    )


def build_construction_deadlock_reason(
    ref: RoomRef,
    runtime_room: dict[str, Any] | None,
    metrics: RoomSummaryMetrics,
    deadlock_ticks: int | float,
) -> dict[str, Any]:
    priority = "P0" if deadlock_ticks >= CONSTRUCTION_DEADLOCK_P0_TICKS else "P1"
    severity = "critical" if priority == "P0" else "high"
    construction_site_count = runtime_construction_site_count(runtime_room)
    if construction_site_count is None:
        construction_site_count = len(metrics.construction_sites)
    build_count = runtime_task_count(runtime_room or {}, "build")
    if build_count is None:
        build_count = metrics.task_counts.get("build")
    pending_build_progress = runtime_pending_build_progress(runtime_room)
    if pending_build_progress is None:
        pending_build_progress = metrics.pending_build_progress
    build_carried_energy = runtime_build_carried_energy(runtime_room)
    if build_carried_energy is None:
        build_carried_energy = metrics.build_carried_energy
    task_counts = dict(as_dict(runtime_room.get("taskCounts")) if isinstance(runtime_room, dict) else metrics.task_counts)
    threshold = CONSTRUCTION_DEADLOCK_P0_TICKS if priority == "P0" else CONSTRUCTION_DEADLOCK_P1_TICKS
    return {
        "kind": CONSTRUCTION_DEADLOCK_KIND,
        "room": ref.key,
        "room_name": ref.room,
        "severity": severity,
        "priority": priority,
        "constructionDeadlockTicks": deadlock_ticks,
        "threshold": threshold,
        "p1_threshold": CONSTRUCTION_DEADLOCK_P1_TICKS,
        "p0_threshold": CONSTRUCTION_DEADLOCK_P0_TICKS,
        "build": build_count,
        "task_counts": task_counts,
        "constructionSiteCount": construction_site_count,
        "pendingBuildProgress": pending_build_progress,
        "buildCarriedEnergy": build_carried_energy,
        "metadata": construction_deadlock_metadata(),
        "message": (
            f"{CONSTRUCTION_DEADLOCK_KIND} in {ref.key}: constructionDeadlockTicks="
            f"{format_energy_value(deadlock_ticks)} with build={format_energy_value(build_count)} and "
            f"constructionSiteCount={format_energy_value(construction_site_count)}."
        ),
        "signature": f"{CONSTRUCTION_DEADLOCK_KIND}:{priority}:{ref.key}",
    }


def detect_construction_deadlock_reason(
    ref: RoomRef,
    runtime_room: dict[str, Any] | None,
    metrics: RoomSummaryMetrics,
) -> dict[str, Any] | None:
    deadlock_ticks = runtime_construction_deadlock_ticks(runtime_room)
    if deadlock_ticks is None:
        deadlock_ticks = metrics.construction_deadlock_ticks
    if deadlock_ticks < CONSTRUCTION_DEADLOCK_P1_TICKS:
        return None

    construction_site_count = runtime_construction_site_count(runtime_room)
    if construction_site_count is None:
        construction_site_count = len(metrics.construction_sites)
    if construction_site_count <= 0:
        return None

    build_count = runtime_task_count(runtime_room or {}, "build")
    if build_count is None:
        build_count = metrics.task_counts.get("build")
    if build_count != 0:
        return None

    return build_construction_deadlock_reason(ref, runtime_room, metrics, deadlock_ticks)


def build_worker_idle_collapse_reason(
    ref: RoomRef,
    room: dict[str, Any],
    consecutive: int,
    worker_count: int,
    idle_count: int,
    stuck_count: int,
    current_energy: int | float | None,
    capacity_energy: int | float | None,
    buffer_health: dict[str, Any],
) -> dict[str, Any]:
    return {
        "kind": WORKER_IDLE_COLLAPSE_KIND,
        "room": ref.key,
        "room_name": ref.room,
        "severity": "high",
        "priority": "P1",
        "harvest": runtime_task_count(room, "harvest"),
        "upgrade": runtime_task_count(room, "upgrade"),
        "worker_count": worker_count,
        "idle_worker_count": idle_count,
        "stuck_worker_count": stuck_count,
        "current_energy": current_energy,
        "energy_capacity": capacity_energy,
        "energy_buffer_health": buffer_health,
        "consecutive": consecutive,
        "message": (
            f"worker_idle_collapse in {ref.key}: harvest=0 upgrade=0, all workers idle/stuck, spawn idle, "
            f"energy {format_energy_value(current_energy)}/{format_energy_value(capacity_energy)}. "
            "Room may die within ~1500 ticks without intervention."
        ),
        "signature": f"{WORKER_IDLE_COLLAPSE_KIND}:{ref.key}",
    }


def detect_worker_idle_collapse_reason(
    ref: RoomRef,
    runtime_room: dict[str, Any] | None,
    owned_spawns: int,
    consecutive: int,
) -> dict[str, Any] | None:
    if not isinstance(runtime_room, dict):
        return None

    harvest_count = runtime_task_count(runtime_room, "harvest")
    upgrade_count = runtime_task_count(runtime_room, "upgrade")
    if harvest_count != 0 or upgrade_count != 0:
        return None
    if not runtime_spawn_idle(runtime_room, owned_spawns):
        return None

    all_idle_or_stuck, worker_count, idle_count, stuck_count = all_workers_idle_or_stuck(runtime_room)
    if not all_idle_or_stuck:
        return None

    energy_at_risk, current_energy, capacity_energy, buffer_health = runtime_energy_at_risk(runtime_room)
    if not energy_at_risk:
        return None

    return build_worker_idle_collapse_reason(
        ref,
        runtime_room,
        consecutive,
        worker_count,
        idle_count,
        stuck_count,
        current_energy,
        capacity_energy,
        buffer_health,
    )


def tick_number(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def runtime_build_blocked_reason(room: dict[str, Any] | None) -> str | None:
    if not isinstance(room, dict):
        return None
    for path in BUILD_BLOCKED_REASON_PATHS:
        value = nested_value(room, *path)
        if isinstance(value, str) and value:
            return value
    return None


def runtime_construction_site_count(room: dict[str, Any] | None) -> int | float | None:
    if not isinstance(room, dict):
        return None
    for path in (
        ("constructionSiteCount",),
        ("resources", "productiveEnergy", "constructionSiteCount"),
        ("construction", "constructionSiteCount"),
    ):
        value = number_value(nested_value(room, *path))
        if value is not None:
            return value
    return None


def runtime_assigned_worker_task_count(room: dict[str, Any]) -> int | float:
    task_counts = as_dict(room.get("taskCounts"))
    return sum(number_value(task_counts.get(task_name)) or 0 for task_name in ASSIGNED_WORKER_TASK_NAMES)


def runtime_productive_assignment_count(room: dict[str, Any] | None) -> int | float | None:
    if not isinstance(room, dict):
        return None
    return first_number_value(
        room,
        *PRODUCTIVE_ASSIGNMENT_COUNT_PATHS,
    )


def runtime_assigned_productive_worker_count(room: dict[str, Any]) -> int | float | None:
    return runtime_productive_assignment_count(room)


def runtime_worker_assignment_blocked_detail(room: dict[str, Any] | None) -> str | None:
    if not isinstance(room, dict):
        return None
    detail = explicit_worker_assignment_blocked_detail(room)
    return detail.strip() if isinstance(detail, str) and detail.strip() else None


def runtime_worker_assignment_blocked_workers(room: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(room, dict):
        return []
    return explicit_worker_assignment_blocked_workers(room) or []


def runtime_worker_assignment_evidence_available(room: dict[str, Any] | None) -> bool:
    if not isinstance(room, dict):
        return True
    for path in WORKER_ASSIGNMENT_EVIDENCE_AVAILABLE_PATHS:
        value = nested_value(room, *path)
        if isinstance(value, bool):
            return value
    for path in WORKER_ASSIGNMENT_BLOCKED_DETAIL_EVIDENCE_PATHS:
        if string_value(nested_value(room, *path)) is not None:
            return True
    for path in WORKER_ASSIGNMENT_BLOCKED_WORKERS_EVIDENCE_PATHS:
        value = nested_value(room, *path)
        if not isinstance(value, list):
            continue
        if any(sanitized_worker_assignment_blocked_worker(item) is not None for item in value):
            return True
    return room.get(RUNTIME_SUMMARY_SOURCE_METADATA_KEY) != MONITOR_RUNTIME_SUMMARY_SOURCE


def runtime_worker_assignment_recovered(room: dict[str, Any] | None) -> bool:
    if not isinstance(room, dict):
        return False
    if not runtime_worker_assignment_evidence_available(room):
        return False
    worker_count = number_value(room.get("workerCount"))
    if worker_count is not None and worker_count <= 0:
        return False
    productive_worker_count = runtime_assigned_productive_worker_count(room)
    deadlock_ticks = runtime_construction_deadlock_ticks(room)
    return (
        runtime_assigned_worker_task_count(room) > 0
        or (productive_worker_count is not None and productive_worker_count > 0)
        or (deadlock_ticks is not None and deadlock_ticks <= 0)
    )


def runtime_reports_worker_assignment_gap(room: dict[str, Any] | None) -> bool:
    if not isinstance(room, dict):
        return False
    if not runtime_worker_assignment_evidence_available(room):
        return False
    return any(nested_value(room, *path) == WORKER_ASSIGNMENT_GAP_BLOCKED_REASON for path in BUILD_BLOCKED_REASON_PATHS)


def runtime_worker_assignment_gap_recovered(room: dict[str, Any] | None) -> bool:
    return not runtime_reports_worker_assignment_gap(room) and runtime_worker_assignment_recovered(room)


def runtime_summary_room_tick(room: dict[str, Any] | None) -> int | None:
    if not isinstance(room, dict):
        return None
    return tick_number(room.get(RUNTIME_SUMMARY_TICK_METADATA_KEY))


def runtime_worker_assignment_gap_recovery_is_fresh(
    room: dict[str, Any] | None,
    current_tick_value: Any,
) -> bool:
    current_tick = tick_number(current_tick_value)
    room_tick = runtime_summary_room_tick(room)
    if current_tick is None or room_tick is None:
        return False
    return room_tick + WORKER_ASSIGNMENT_GAP_RECOVERY_TICK_TOLERANCE >= current_tick


def extension_bootstrap_previous_state(value: Any) -> dict[str, int | float]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, int | float] = {}
    for key in (
        "start_tick",
        "last_tick",
        "last_progress_tick",
        "extension_construction_site_count",
        "extension_pending_build_progress",
        "stalled_ticks",
    ):
        number = number_value(value.get(key))
        if number is not None:
            result[key] = number
    return result


def extension_bootstrap_next_state(
    previous_state: Any,
    current_tick: int,
    extension_construction_site_count: int,
    extension_pending_build_progress: int | float,
) -> dict[str, int | float]:
    previous = extension_bootstrap_previous_state(previous_state)
    previous_last_tick = tick_number(previous.get("last_tick"))
    previous_progress_tick = tick_number(previous.get("last_progress_tick"))
    previous_site_count = number_value(previous.get("extension_construction_site_count"))
    previous_pending_progress = number_value(previous.get("extension_pending_build_progress"))

    reset_state = previous_last_tick is None or current_tick < previous_last_tick
    progress_observed = (
        reset_state
        or previous_site_count is None
        or previous_pending_progress is None
        or extension_construction_site_count > previous_site_count
        or extension_pending_build_progress < previous_pending_progress
    )
    if progress_observed:
        last_progress_tick = current_tick
    elif previous_progress_tick is not None:
        last_progress_tick = previous_progress_tick
    else:
        last_progress_tick = current_tick
    previous_start_tick = tick_number(previous.get("start_tick"))
    if reset_state:
        start_tick = current_tick
    elif previous_start_tick is not None:
        start_tick = previous_start_tick
    else:
        start_tick = current_tick
    stalled_ticks = max(0, current_tick - last_progress_tick)

    return {
        "start_tick": start_tick,
        "last_tick": current_tick,
        "last_progress_tick": last_progress_tick,
        "extension_construction_site_count": extension_construction_site_count,
        "extension_pending_build_progress": extension_pending_build_progress,
        "stalled_ticks": stalled_ticks,
    }


def build_extension_count_zero_at_rcl_ge_2_reason(
    ref: RoomRef,
    metrics: RoomSummaryMetrics,
    *,
    reason: str,
    state: dict[str, int | float] | None = None,
) -> dict[str, Any]:
    extension_site_count = metrics.extension_construction_site_count
    extension_pending_progress = metrics.extension_pending_build_progress
    stalled_ticks = number_value(state.get("stalled_ticks")) if state else None
    state_fields: dict[str, Any] = {}
    if state:
        state_fields = {
            "start_tick": state.get("start_tick"),
            "current_tick": state.get("last_tick"),
            "last_progress_tick": state.get("last_progress_tick"),
            "stalledTicks": stalled_ticks,
            "stallThresholdTicks": EXTENSION_BOOTSTRAP_PROGRESS_STALL_TICKS,
        }
    message_detail = (
        "no active extension construction site"
        if reason == "missing_extension_site"
        else (
            f"{extension_site_count} active extension construction site(s), "
            f"no extension bootstrap progress for {format_energy_value(stalled_ticks)} ticks"
        )
    )
    return {
        "kind": EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND,
        "room": ref.key,
        "room_name": ref.room,
        "severity": "critical",
        "priority": "P0",
        "extensionCount": metrics.extension_count,
        "extensionConstructionSiteCount": extension_site_count,
        "extensionPendingBuildProgress": extension_pending_progress,
        "rclLevel": metrics.rcl_level,
        "bootstrapState": reason,
        **state_fields,
        "message": (
            f"{EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND} in {ref.key}: "
            f"extensionCount={metrics.extension_count} at RCL {format_energy_value(metrics.rcl_level)} with "
            f"{message_detail}"
        ),
        "signature": f"{EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND}:{reason}:{ref.key}",
    }


def detect_extension_count_zero_at_rcl_ge_2_reason(
    ref: RoomRef,
    metrics: RoomSummaryMetrics,
    previous_rule_state: Any,
    current_tick_value: Any,
) -> tuple[dict[str, Any] | None, dict[str, int | float] | int]:
    if metrics.extension_count != 0 or metrics.rcl_level is None or metrics.rcl_level < 2:
        return None, 0

    if metrics.extension_construction_site_count <= 0 or metrics.extension_pending_build_progress <= 0:
        return build_extension_count_zero_at_rcl_ge_2_reason(
            ref,
            metrics,
            reason="missing_extension_site",
        ), 0

    current_tick = tick_number(current_tick_value)
    if current_tick is None:
        preserved_state = extension_bootstrap_previous_state(previous_rule_state)
        return None, preserved_state or 0

    state = extension_bootstrap_next_state(
        previous_rule_state,
        current_tick,
        metrics.extension_construction_site_count,
        metrics.extension_pending_build_progress,
    )
    stalled_ticks = number_value(state.get("stalled_ticks")) or 0
    if stalled_ticks >= EXTENSION_BOOTSTRAP_PROGRESS_STALL_TICKS:
        return build_extension_count_zero_at_rcl_ge_2_reason(
            ref,
            metrics,
            reason="extension_bootstrap_stalled",
            state=state,
        ), state
    return None, state


def worker_assignment_gap_active(
    runtime_room: dict[str, Any] | None,
    metrics: RoomSummaryMetrics,
    current_tick_value: Any,
) -> tuple[bool, str | None, int | float]:
    metrics_site_count = len(metrics.construction_sites)
    site_count = runtime_construction_site_count(runtime_room)
    if site_count is None:
        site_count = metrics_site_count
    if worker_assignment_stall_evidence(runtime_room, metrics) is not None:
        return False, None, site_count
    runtime_assignment_evidence_available = runtime_worker_assignment_evidence_available(runtime_room)
    runtime_blocked_reason = runtime_build_blocked_reason(runtime_room) if runtime_assignment_evidence_available else None
    blocked_reason = runtime_blocked_reason or metrics.build_blocked_reason
    if runtime_reports_worker_assignment_gap(runtime_room):
        blocked_reason = WORKER_ASSIGNMENT_GAP_BLOCKED_REASON
    elif runtime_assignment_evidence_available and runtime_worker_assignment_gap_recovered(runtime_room):
        if (
            metrics.build_blocked_reason == WORKER_ASSIGNMENT_GAP_BLOCKED_REASON
            and not runtime_worker_assignment_gap_recovery_is_fresh(runtime_room, current_tick_value)
        ):
            return metrics_site_count > 0, metrics.build_blocked_reason, metrics_site_count
        return False, None, site_count
    return blocked_reason == WORKER_ASSIGNMENT_GAP_BLOCKED_REASON and site_count > 0, blocked_reason, site_count


def worker_assignment_gap_previous_state(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, int] = {}
    for key in ("start_tick", "last_tick", "consecutive_ticks"):
        tick = tick_number(value.get(key))
        if tick is not None:
            result[key] = tick
    return result


def worker_assignment_gap_next_state(previous_state: dict[str, int], current_tick: int) -> dict[str, int]:
    previous_start_tick = previous_state.get("start_tick")
    previous_last_tick = previous_state.get("last_tick")
    if previous_start_tick is None or previous_last_tick is None or current_tick < previous_last_tick:
        start_tick = current_tick
    else:
        start_tick = previous_start_tick
    return {
        "start_tick": start_tick,
        "last_tick": current_tick,
        "consecutive_ticks": max(0, current_tick - start_tick),
    }


def build_worker_assignment_gap_sustained_reason(
    ref: RoomRef,
    blocked_reason: str | None,
    construction_site_count: int | float,
    state: dict[str, int],
) -> dict[str, Any]:
    return {
        "kind": WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND,
        "room": ref.key,
        "room_name": ref.room,
        "severity": "critical",
        "priority": "P0",
        "buildBlockedReason": blocked_reason,
        "constructionSiteCount": construction_site_count,
        "start_tick": state["start_tick"],
        "current_tick": state["last_tick"],
        "consecutive_ticks": state["consecutive_ticks"],
        "message": (
            f"{WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND} in {ref.key}: "
            f"buildBlockedReason={blocked_reason} with constructionSiteCount={format_energy_value(construction_site_count)} "
            f"for {state['consecutive_ticks']} ticks."
        ),
        "signature": f"{WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND}:{ref.key}",
    }


def detect_worker_assignment_gap_sustained_reason(
    ref: RoomRef,
    runtime_room: dict[str, Any] | None,
    metrics: RoomSummaryMetrics,
    previous_rule_state: Any,
    current_tick_value: Any,
) -> tuple[dict[str, Any] | None, dict[str, int] | int]:
    active, blocked_reason, construction_site_count = worker_assignment_gap_active(
        runtime_room,
        metrics,
        current_tick_value,
    )
    current_tick = tick_number(current_tick_value)
    if not active or current_tick is None:
        return None, 0

    state = worker_assignment_gap_next_state(worker_assignment_gap_previous_state(previous_rule_state), current_tick)
    if state["consecutive_ticks"] > WORKER_ASSIGNMENT_GAP_REQUIRED_TICKS:
        return build_worker_assignment_gap_sustained_reason(ref, blocked_reason, construction_site_count, state), state
    return None, state


def worker_assignment_deadlock_evidence(
    runtime_room: dict[str, Any] | None,
    metrics: RoomSummaryMetrics,
) -> dict[str, Any] | None:
    if not isinstance(runtime_room, dict):
        return None
    if not runtime_worker_assignment_evidence_available(runtime_room):
        return None

    blocked_detail = runtime_worker_assignment_blocked_detail(runtime_room)
    if blocked_detail is None:
        return None

    productive_assignment_count = runtime_productive_assignment_count(runtime_room)
    if productive_assignment_count != 0:
        return None

    worker_count = first_number_value(
        runtime_room,
        ("workerCount",),
        ("workerAssignmentEvidence", "workerCount"),
        ("resources", "productiveEnergy", "workerCount"),
        ("productiveEnergy", "workerCount"),
    )
    if worker_count is not None and worker_count <= 0:
        return None

    construction_site_count = runtime_construction_site_count(runtime_room)
    if construction_site_count is None:
        construction_site_count = len(metrics.construction_sites)
    pending_build_progress = runtime_pending_build_progress(runtime_room)
    if pending_build_progress is None:
        pending_build_progress = metrics.pending_build_progress

    build_count = runtime_task_count(runtime_room, "build")
    if build_count is None:
        build_count = metrics.task_counts.get("build")

    runtime_gap_blocked_reason = runtime_build_blocked_reason(runtime_room)
    build_blocked_reason = runtime_gap_blocked_reason or metrics.build_blocked_reason

    task_counts = dict(as_dict(runtime_room.get("taskCounts"))) or dict(metrics.task_counts)
    evidence = {
        "workerAssignmentBlockedDetail": blocked_detail,
        "productiveAssignmentCount": productive_assignment_count,
        "workerCount": worker_count,
        "build": build_count,
        "task_counts": task_counts,
        "constructionSiteCount": construction_site_count,
        "pendingBuildProgress": pending_build_progress,
        "constructionDeadlockTicks": runtime_construction_deadlock_ticks(runtime_room),
        "buildBlockedReason": build_blocked_reason,
        "runtimeSummaryTick": runtime_summary_room_tick(runtime_room),
    }
    blocked_workers = runtime_worker_assignment_blocked_workers(runtime_room)
    if blocked_workers:
        evidence["workerAssignmentBlockedWorkers"] = blocked_workers
    artifact_timestamp = runtime_room.get(RUNTIME_SUMMARY_ARTIFACT_TIMESTAMP_METADATA_KEY)
    if isinstance(artifact_timestamp, (int, float, str)) and artifact_timestamp:
        evidence["runtimeSummaryArtifactTimestamp"] = artifact_timestamp
    artifact_path = runtime_room.get(RUNTIME_SUMMARY_ARTIFACT_PATH_METADATA_KEY)
    if isinstance(artifact_path, str) and artifact_path:
        evidence["runtimeSummaryArtifactPath"] = artifact_path
    artifact_line = number_value(runtime_room.get(RUNTIME_SUMMARY_ARTIFACT_LINE_METADATA_KEY))
    if artifact_line is not None:
        evidence["runtimeSummaryArtifactLine"] = int(artifact_line)
    return evidence


def worker_assignment_stall_evidence(
    runtime_room: dict[str, Any] | None,
    metrics: RoomSummaryMetrics,
) -> dict[str, Any] | None:
    evidence = worker_assignment_deadlock_evidence(runtime_room, metrics)
    if evidence is None:
        return None

    if evidence["constructionSiteCount"] <= 0 and evidence["pendingBuildProgress"] <= 0:
        return None
    build_count = evidence.get("build")
    if build_count is not None and build_count > 0:
        return None
    if runtime_build_blocked_reason(runtime_room) == WORKER_ASSIGNMENT_GAP_BLOCKED_REASON:
        return None
    return evidence


def runtime_summary_capture_history(runtime_room: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(runtime_room, dict):
        return []
    value = runtime_room.get(RUNTIME_SUMMARY_CAPTURE_HISTORY_METADATA_KEY)
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def worker_assignment_deadlock_capture_matches(capture: dict[str, Any]) -> bool:
    if not runtime_worker_assignment_evidence_available(capture):
        return False
    if runtime_productive_assignment_count(capture) != 0:
        return False
    if runtime_worker_assignment_blocked_detail(capture) is None:
        return False
    worker_count = first_number_value(capture, ("workerCount",), ("workerAssignmentEvidence", "workerCount"))
    return worker_count is None or worker_count > 0


def worker_assignment_deadlock_consecutive_captures(
    runtime_room: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    captures = runtime_summary_capture_history(runtime_room)
    if not captures:
        return []
    consecutive: list[dict[str, Any]] = []
    for capture in captures:
        if not worker_assignment_deadlock_capture_matches(capture):
            break
        consecutive.append(capture)
    return consecutive


def worker_assignment_capture_state(captures: list[dict[str, Any]], current_tick_value: Any) -> dict[str, int]:
    current_tick = tick_number(captures[0].get("runtimeSummaryTick")) if captures else None
    start_tick = tick_number(captures[-1].get("runtimeSummaryTick")) if captures else None
    if current_tick is None:
        current_tick = tick_number(current_tick_value)
    if start_tick is None:
        start_tick = current_tick
    if current_tick is None:
        current_tick = start_tick if start_tick is not None else 0
    if start_tick is None:
        start_tick = current_tick
    return {
        "start_tick": start_tick,
        "last_tick": current_tick,
        "consecutive_ticks": max(0, current_tick - start_tick),
    }


def worker_assignment_capture_paths(captures: list[dict[str, Any]]) -> list[str]:
    paths: list[str] = []
    for capture in captures:
        path = capture.get("path")
        if isinstance(path, str) and path and path not in paths:
            paths.append(path)
    return paths


def worker_assignment_capture_window_evidence(
    runtime_room: dict[str, Any] | None,
    metrics: RoomSummaryMetrics,
) -> tuple[dict[str, Any], dict[str, int]] | None:
    captures = worker_assignment_deadlock_consecutive_captures(runtime_room)
    if len(captures) < WORKER_ASSIGNMENT_STALL_REQUIRED_CONSECUTIVE_CAPTURES:
        return None

    evidence = worker_assignment_deadlock_evidence(runtime_room, metrics)
    if evidence is None:
        evidence = worker_assignment_deadlock_evidence(captures[0], metrics)
    if evidence is None:
        return None

    evidence["consecutiveCaptures"] = len(captures)
    evidence["thresholdCaptures"] = WORKER_ASSIGNMENT_STALL_REQUIRED_CONSECUTIVE_CAPTURES
    evidence["runtimeSummaryCaptures"] = captures
    evidence["runtimeSummaryCapturePaths"] = worker_assignment_capture_paths(captures)
    return evidence, worker_assignment_capture_state(captures, evidence.get("runtimeSummaryTick"))


def build_worker_assignment_stall_reason(
    ref: RoomRef,
    evidence: dict[str, Any],
    state: dict[str, int],
) -> dict[str, Any]:
    blocked_detail = evidence["workerAssignmentBlockedDetail"]
    consecutive_captures = number_value(evidence.get("consecutiveCaptures"))
    if consecutive_captures is not None:
        duration = (
            f"across {format_energy_value(consecutive_captures)} consecutive runtime-summary captures "
            f"(threshold>{WORKER_ASSIGNMENT_STALL_REQUIRED_CONSECUTIVE_CAPTURES - 1})."
        )
    else:
        duration = f"for {state['consecutive_ticks']} ticks."
    return {
        "kind": WORKER_ASSIGNMENT_STALL_KIND,
        "room": ref.key,
        "shard": ref.shard,
        "room_name": ref.room,
        "severity": "warning",
        "priority": "P2",
        **evidence,
        "blocked_detail": blocked_detail,
        "threshold": WORKER_ASSIGNMENT_STALL_REQUIRED_TICKS,
        "start_tick": state["start_tick"],
        "current_tick": state["last_tick"],
        "consecutive_ticks": state["consecutive_ticks"],
        "next_action": (
            "Codex triage: inspect worker dispatch and spawn energy reservation for the affected room; "
            "verify productiveAssignmentCount recovers above 0 in fresh runtime-summary captures."
        ),
        "owner_ping": False,
        "metadata": worker_assignment_stall_metadata(),
        "message": (
            f"{WORKER_ASSIGNMENT_STALL_KIND} in {ref.key}: "
            f"productiveAssignmentCount=0, workerAssignmentBlockedDetail={blocked_detail}, "
            f"pendingBuildProgress={format_energy_value(evidence.get('pendingBuildProgress'))} "
            f"{duration}"
        ),
        "signature": f"{WORKER_ASSIGNMENT_STALL_KIND}:{ref.key}",
    }


def detect_worker_assignment_stall_reason(
    ref: RoomRef,
    runtime_room: dict[str, Any] | None,
    metrics: RoomSummaryMetrics,
    previous_rule_state: Any,
    current_tick_value: Any,
) -> tuple[dict[str, Any] | None, dict[str, int] | int]:
    capture_window = worker_assignment_capture_window_evidence(runtime_room, metrics)
    if capture_window is not None:
        evidence, state = capture_window
        return build_worker_assignment_stall_reason(ref, evidence, state), state

    evidence = worker_assignment_stall_evidence(runtime_room, metrics)
    if evidence is None:
        return None, 0
    current_tick = tick_number(evidence.get("runtimeSummaryTick"))
    if current_tick is None:
        current_tick = tick_number(current_tick_value)
    if current_tick is None:
        return None, 0

    state = worker_assignment_gap_next_state(worker_assignment_gap_previous_state(previous_rule_state), current_tick)
    if state["consecutive_ticks"] > WORKER_ASSIGNMENT_STALL_REQUIRED_TICKS:
        return build_worker_assignment_stall_reason(ref, evidence, state), state
    return None, state


def alert_reason_kind(reason: dict[str, Any]) -> str:
    value = reason.get("kind")
    return value.lower() if isinstance(value, str) else ""


def should_bypass_alert_debounce(reason: dict[str, Any]) -> bool:
    return alert_reason_kind(reason) in DEBOUNCE_BYPASS_REASON_KINDS


def expected_rampart_decay_delta(previous_room_state: dict[str, Any], current_tick_value: Any) -> int:
    previous_tick = tick_number(previous_room_state.get("tick"))
    current_tick = tick_number(current_tick_value)
    if previous_tick is None or current_tick is None or current_tick <= previous_tick:
        return 0

    elapsed_ticks = current_tick - previous_tick
    decay_events = max(1, (elapsed_ticks + RAMPART_DECAY_EVENT_TICKS - 1) // RAMPART_DECAY_EVENT_TICKS)
    return decay_events * RAMPART_DECAY_HITS_PER_EVENT


def previous_room_state_has_recent_visible_hostiles(
    previous_room_state: dict[str, Any], current_tick_value: Any
) -> bool:
    current_tick = tick_number(current_tick_value)
    previous_tick = tick_number(previous_room_state.get("tick"))
    previous_visible_hostiles = previous_room_state.get("visible_hostile_creeps")
    had_visible_hostiles = (
        not isinstance(previous_visible_hostiles, bool)
        and isinstance(previous_visible_hostiles, (int, float))
        and previous_visible_hostiles > 0
    )
    if had_visible_hostiles:
        return True

    last_visible_hostile_tick = tick_number(previous_room_state.get("last_visible_hostile_tick"))
    if last_visible_hostile_tick is None:
        return False

    if current_tick is None:
        current_tick = previous_tick
    if current_tick is None:
        return True
    if current_tick < last_visible_hostile_tick:
        return False
    return current_tick - last_visible_hostile_tick <= RAMPART_DECAY_RECENT_HOSTILE_TICKS


def is_expected_safe_rampart_decay_reason(
    reason: dict[str, Any],
    previous_room_state: dict[str, Any],
    current_tick_value: Any,
    has_visible_hostiles: bool,
) -> bool:
    if has_visible_hostiles or previous_room_state_has_recent_visible_hostiles(previous_room_state, current_tick_value):
        return False
    if alert_reason_kind(reason) != "structure_damage":
        return False
    structure_type = str(reason.get("structure_type") or reason.get("structureType") or "").lower()
    if structure_type != "rampart":
        return False

    current_hits = number_from_reason(reason, "current_hits", "currentHits", "hits")
    delta = number_from_reason(reason, "delta")
    if current_hits is None or delta is None:
        return False
    # Long monitor gaps can accumulate normal decay above the raw damage delta threshold.
    if delta >= RAMPART_CRITICAL_DAMAGE_DELTA and current_hits <= RAMPART_CRITICAL_DAMAGE_HITS_CEILING:
        return False

    return (
        current_hits > RAMPART_SAFE_DECAY_HITS_FLOOR
        and 0 < delta <= expected_rampart_decay_delta(previous_room_state, current_tick_value)
    )


def should_preserve_previous_baseline(
    previous_structures: dict[str, Any], current_structures: dict[str, dict[str, Any]], reasons: list[dict[str, Any]]
) -> bool:
    if not previous_structures or current_structures:
        return False
    survival_kinds = {"room_ownership_lost", "spawn_collapse", "room_dead"}
    return any(reason.get("kind") in survival_kinds for reason in reasons)


def build_next_room_state(
    snapshot: RoomSnapshot,
    previous_room_state: dict[str, Any],
    previous_structures: dict[str, Any],
    current_structures: dict[str, dict[str, Any]],
    alerts: dict[str, Any],
    rule_counts: dict[str, Any],
    detected: list[dict[str, Any]],
    now: int,
    owned_creeps: int,
    owned_spawns: int,
    visible_hostile_creeps: int,
) -> dict[str, Any]:
    structures = previous_structures if should_preserve_previous_baseline(previous_structures, current_structures, detected) else current_structures
    previous_owner = previous_room_state.get("owner")
    owner = snapshot.owner or (previous_owner if should_preserve_previous_baseline(previous_structures, current_structures, detected) else None)
    last_visible_hostile_tick = (
        snapshot.tick if visible_hostile_creeps > 0 else previous_room_state.get("last_visible_hostile_tick")
    )
    next_state = {
        "baseline_established": True,
        "observed_at": now,
        "tick": snapshot.tick,
        "owner": owner,
        "owner_observed": snapshot.owner,
        "expected_owner": snapshot.expected_owner,
        "expected_owner_id": snapshot.expected_owner_id,
        "owned_creeps": owned_creeps,
        "owned_spawns": owned_spawns,
        "structures": structures,
        "alerts": alerts,
        "rule_counts": rule_counts,
        "visible_hostile_creeps": visible_hostile_creeps,
    }
    if last_visible_hostile_tick is not None:
        next_state["last_visible_hostile_tick"] = last_visible_hostile_tick
    return next_state


def evaluate_room_alert(
    snapshot: RoomSnapshot,
    previous_room_state: dict[str, Any] | None,
    now: int,
    debounce_seconds: int,
    runtime_room_summary: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    previous_room_state = previous_room_state or {}
    previous_structures = previous_room_state.get("structures")
    if not isinstance(previous_structures, dict):
        previous_structures = {}
    previous_alerts = previous_room_state.get("alerts")
    if not isinstance(previous_alerts, dict):
        previous_alerts = {}
    previous_rule_counts = previous_room_state.get("rule_counts")
    if not isinstance(previous_rule_counts, dict):
        previous_rule_counts = {}

    current_structures = structure_snapshot(snapshot.objects, snapshot.owner, snapshot.expected_owner_id)
    current_owned_spawns = count_owned_spawns(current_structures)
    current_owned_creeps = count_owned_objects(snapshot.objects, snapshot.owner, "creep", snapshot.expected_owner_id)
    current_metrics = compute_room_summary_metrics(snapshot)
    baseline_established = bool(previous_room_state.get("baseline_established"))
    previous_owner = previous_room_state.get("owner")
    expected_owner = snapshot.expected_owner if snapshot.expected_owner else previous_owner
    previous_owned_spawns = previous_room_state.get("owned_spawns")
    previous_owned_creeps = previous_room_state.get("owned_creeps")
    previous_spawn_count = previous_critical_spawn_count(previous_structures)
    detected: list[dict[str, Any]] = []

    visible_hostiles = detect_hostile_creeps(snapshot.objects, snapshot.owner)
    for hostile in visible_hostiles:
        detected.append(build_hostile_reason(snapshot.ref, hostile))

    if expected_owner and snapshot.owner != expected_owner:
        detected.append(
            build_survival_reason(
                snapshot.ref,
                "room_ownership_lost",
                f"room owner changed from {expected_owner} to {snapshot.owner or 'none'}",
                previous_owner=expected_owner,
                current_owner=snapshot.owner,
            )
        )

    if baseline_established:
        if previous_spawn_count > 0 and current_owned_spawns == 0:
            detected.append(
                build_survival_reason(
                    snapshot.ref,
                    "spawn_collapse",
                    f"owned spawn count dropped from {previous_spawn_count} to 0",
                    previous_owned_spawns=previous_spawn_count,
                    current_owned_spawns=current_owned_spawns,
                    current_owned_creeps=current_owned_creeps,
                )
            )
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

    if (baseline_established or expected_owner) and current_owned_spawns == 0 and current_owned_creeps == 0:
        detected.append(
            build_survival_reason(
                snapshot.ref,
                "room_dead",
                "room has no owned creeps and no owned spawn recovery path",
                current_owned_spawns=current_owned_spawns,
                current_owned_creeps=current_owned_creeps,
                previous_owned_spawns=previous_owned_spawns,
                previous_owned_creeps=previous_owned_creeps,
                current_owner=snapshot.owner,
                expected_owner=expected_owner,
                controller_claimed=bool(snapshot.owner and (expected_owner is None or snapshot.owner == expected_owner)),
                rclLevel=current_metrics.rcl_level,
                severity="critical",
                priority="P0",
            )
        )

    rule_counts = dict(previous_rule_counts)
    previous_extension_bootstrap_state = rule_counts.get(EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND)
    extension_count_zero_candidate, extension_bootstrap_state = detect_extension_count_zero_at_rcl_ge_2_reason(
        snapshot.ref,
        current_metrics,
        previous_extension_bootstrap_state,
        snapshot.tick,
    )
    rule_counts[EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND] = extension_bootstrap_state
    if extension_count_zero_candidate is not None:
        detected.append(extension_count_zero_candidate)

    previous_worker_assignment_stall_state = rule_counts.get(WORKER_ASSIGNMENT_STALL_KIND)
    owned_room_for_worker_alerts = bool(
        current_owned_spawns > 0
        or current_owned_creeps > 0
        or (expected_owner is not None and snapshot.owner == expected_owner)
    )
    worker_assignment_stall_candidate, worker_assignment_stall_state = detect_worker_assignment_stall_reason(
        snapshot.ref,
        runtime_room_summary if owned_room_for_worker_alerts else None,
        current_metrics,
        previous_worker_assignment_stall_state,
        snapshot.tick,
    )
    rule_counts[WORKER_ASSIGNMENT_STALL_KIND] = worker_assignment_stall_state
    if worker_assignment_stall_candidate is not None:
        detected.append(worker_assignment_stall_candidate)

    previous_worker_assignment_gap_state = rule_counts.get(WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND)
    worker_assignment_gap_candidate, worker_assignment_gap_state = detect_worker_assignment_gap_sustained_reason(
        snapshot.ref,
        runtime_room_summary,
        current_metrics,
        previous_worker_assignment_gap_state,
        snapshot.tick,
    )
    rule_counts[WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND] = worker_assignment_gap_state
    if worker_assignment_gap_candidate is not None:
        detected.append(worker_assignment_gap_candidate)

    construction_deadlock_candidate = detect_construction_deadlock_reason(
        snapshot.ref,
        runtime_room_summary,
        current_metrics,
    )
    if construction_deadlock_candidate is not None:
        detected.append(construction_deadlock_candidate)

    cpu_bucket_candidate = detect_cpu_bucket_reason(snapshot.ref, runtime_room_summary)
    if cpu_bucket_candidate is not None:
        detected.append(cpu_bucket_candidate)

    previous_energy_buffer_unhealthy_count = number_value(rule_counts.get(ENERGY_BUFFER_UNHEALTHY_KIND)) or 0
    energy_buffer_unhealthy_candidate = detect_energy_buffer_unhealthy_reason(
        snapshot.ref,
        runtime_room_summary,
        int(previous_energy_buffer_unhealthy_count) + 1,
    )
    if energy_buffer_unhealthy_candidate is None:
        rule_counts[ENERGY_BUFFER_UNHEALTHY_KIND] = 0
    else:
        rule_counts[ENERGY_BUFFER_UNHEALTHY_KIND] = energy_buffer_unhealthy_candidate["consecutive"]
        if energy_buffer_unhealthy_candidate["consecutive"] >= ENERGY_BUFFER_UNHEALTHY_REQUIRED_CONSECUTIVE:
            detected.append(energy_buffer_unhealthy_candidate)

    previous_worker_idle_count = number_value(rule_counts.get(WORKER_IDLE_COLLAPSE_KIND)) or 0
    worker_idle_candidate = detect_worker_idle_collapse_reason(
        snapshot.ref,
        runtime_room_summary,
        current_owned_spawns,
        int(previous_worker_idle_count) + 1,
    )
    if worker_idle_candidate is None:
        rule_counts[WORKER_IDLE_COLLAPSE_KIND] = 0
    else:
        rule_counts[WORKER_IDLE_COLLAPSE_KIND] = worker_idle_candidate["consecutive"]
        if worker_idle_candidate["consecutive"] >= WORKER_IDLE_COLLAPSE_REQUIRED_CONSECUTIVE:
            detected.append(worker_idle_candidate)

    emitted: list[dict[str, Any]] = []
    suppressed: list[dict[str, Any]] = []
    alerts = dict(previous_alerts)
    for reason in detected:
        if is_expected_safe_rampart_decay_reason(
            reason,
            previous_room_state,
            snapshot.tick,
            has_visible_hostiles=bool(visible_hostiles),
        ):
            suppressed_reason = dict(reason)
            suppressed_reason["suppression_reason"] = "expected_rampart_decay"
            suppressed_reason["expected_decay_delta"] = expected_rampart_decay_delta(previous_room_state, snapshot.tick)
            suppressed_reason["safe_hits_floor"] = RAMPART_SAFE_DECAY_HITS_FLOOR
            suppressed.append(suppressed_reason)
            continue

        signature = str(reason.get("signature"))
        last_seen = alerts.get(signature)
        if (
            not should_bypass_alert_debounce(reason)
            and isinstance(last_seen, (int, float))
            and now - int(last_seen) < debounce_seconds
        ):
            suppressed.append(reason)
            continue
        alerts[signature] = now
        emitted.append(reason)

    next_state = build_next_room_state(
        snapshot,
        previous_room_state,
        previous_structures,
        current_structures,
        alerts,
        rule_counts,
        detected,
        now,
        current_owned_creeps,
        current_owned_spawns,
        len(visible_hostiles),
    )
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


def energy_buffer_unhealthy_reason_is_actionable(reason: dict[str, Any]) -> bool:
    if tactical_reason_kind(reason).lower() != ENERGY_BUFFER_UNHEALTHY_KIND:
        return True
    consecutive = number_from_reason(reason, "consecutive", "consecutive_captures", "consecutiveCaptures") or 0
    buffer_health = as_dict(reason.get("energy_buffer_health")) or as_dict(reason.get("energyBufferHealth"))
    task_counts = as_dict(reason.get("task_counts")) or as_dict(reason.get("taskCounts"))
    build_count = number_value(reason.get("build"))
    if build_count is None:
        build_count = number_value(task_counts.get("build"))
    upgrade_count = number_value(reason.get("upgrade"))
    if upgrade_count is None:
        upgrade_count = number_value(task_counts.get("upgrade"))
    return (
        consecutive >= ENERGY_BUFFER_UNHEALTHY_REQUIRED_CONSECUTIVE
        and buffer_health.get("healthy") is False
        and build_count == 0
        and upgrade_count == 0
    )


def copy_tactical_metadata(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): copy_tactical_metadata(item) for key, item in value.items()}
    if isinstance(value, list):
        return [copy_tactical_metadata(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def tactical_trigger_metadata(rule: dict[str, Any], reason: dict[str, Any]) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    for source in (rule.get("metadata"), reason.get("metadata")):
        copied = copy_tactical_metadata(source)
        if isinstance(copied, dict):
            metadata.update(copied)
    return metadata


def tactical_priority(severity: str) -> str | None:
    return TACTICAL_PRIORITY_BY_SEVERITY.get(severity)


def reason_owned_spawns(reason: dict[str, Any]) -> float | None:
    return number_from_reason(reason, "current_owned_spawns", "owned_spawns", "ownedSpawns", "spawns")


def reason_owned_creeps(reason: dict[str, Any]) -> float | None:
    return number_from_reason(reason, "current_owned_creeps", "owned_creeps", "ownedCreeps", "creeps")


def is_room_dead_reason(reason: dict[str, Any]) -> bool:
    kind = tactical_reason_kind(reason).lower()
    message = str(reason.get("message") or "").lower()
    if kind in ROOM_DEATH_REASON_KINDS or "room_dead" in kind or "room dead" in message:
        return True
    owned_spawns = reason_owned_spawns(reason)
    owned_creeps = reason_owned_creeps(reason)
    return owned_spawns == 0 and owned_creeps == 0


def room_dead_autonomous_recovery_authorized(reason: dict[str, Any]) -> bool:
    if not is_room_dead_reason(reason):
        return False
    owned_spawns = reason_owned_spawns(reason)
    owned_creeps = reason_owned_creeps(reason)
    if owned_spawns is not None and owned_spawns != 0:
        return False
    if owned_creeps is not None and owned_creeps != 0:
        return False
    controller_claimed = reason.get("controller_claimed")
    if controller_claimed is False:
        return False
    return True


def tactical_decision(category: str, rule: dict[str, Any], reason: dict[str, Any]) -> str:
    if category in {"room_dead", "spawn_collapse"} and room_dead_autonomous_recovery_authorized(reason):
        return "autonomous_recovery_authorized"
    return str(rule["decision"])


def is_no_owned_spawn_reason(reason: dict[str, Any]) -> bool:
    kind = tactical_reason_kind(reason).lower()
    message = str(reason.get("message") or "").lower()
    if kind in NO_OWNED_SPAWN_REASON_KINDS:
        return True
    if "owned_spawns=0" in message or "no owned spawn" in message or "no spawn recovery" in message:
        return True
    owned_spawns = reason_owned_spawns(reason)
    return owned_spawns == 0


def nested_value(value: Any, *keys: str) -> Any:
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def numeric_value(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    return None


def is_private_smoke_report(payload: dict[str, Any]) -> bool:
    return isinstance(payload.get("phases"), list) and isinstance(payload.get("smoke"), dict)


def private_smoke_phases(payload: dict[str, Any]) -> list[dict[str, Any]]:
    phases = payload.get("phases")
    if not isinstance(phases, list):
        return []
    return [phase for phase in phases if isinstance(phase, dict)]


def private_smoke_phase_name(phase: dict[str, Any]) -> str:
    name = phase.get("name")
    return name if isinstance(name, str) and name else "unknown-phase"


def private_smoke_phase_details(phase: dict[str, Any]) -> dict[str, Any]:
    details = phase.get("details")
    return details if isinstance(details, dict) else {}


def private_smoke_room(payload: dict[str, Any]) -> str | None:
    smoke = payload.get("smoke")
    if not isinstance(smoke, dict):
        return None
    room = smoke.get("room")
    shard = smoke.get("shard")
    if isinstance(room, str) and room:
        if isinstance(shard, str) and shard:
            return f"{shard}/{room}"
        return room
    return None


def private_smoke_phase_failure_excerpt(phase: dict[str, Any]) -> str:
    for key in ("error", "message"):
        value = phase.get(key)
        if isinstance(value, str) and value:
            return short_text(value, 160)
    details = private_smoke_phase_details(phase)
    for key in ("error", "last_error", "output_excerpt", "response_excerpt"):
        value = details.get(key)
        if isinstance(value, str) and value:
            return short_text(value, 160)
    return "phase did not report a usable success signal"


def private_smoke_reason(
    payload: dict[str, Any],
    kind: str,
    message: str,
    phase: str | None = None,
    **fields: Any,
) -> dict[str, Any]:
    room = private_smoke_room(payload)
    signature_parts = [kind, room or "unknown-room", phase or ""]
    if fields.get("object_id"):
        signature_parts.append(str(fields["object_id"]))
    else:
        signature_parts.append(safe_file_fragment(message)[:64])
    reason = {
        "kind": kind,
        "message": message,
        "signature": ":".join(signature_parts),
    }
    if room:
        reason["room"] = room
    if phase:
        reason["phase"] = phase
    reason.update(fields)
    return reason


def classify_private_smoke_failed_phase(payload: dict[str, Any], phase: dict[str, Any]) -> dict[str, Any]:
    name = private_smoke_phase_name(phase)
    details = private_smoke_phase_details(phase)
    excerpt = private_smoke_phase_failure_excerpt(phase)

    if name == "poll-stats":
        samples = numeric_value(details.get("samples"))
        if not samples and not isinstance(details.get("last"), dict):
            return private_smoke_reason(
                payload,
                "private_smoke_telemetry_silence",
                f"private smoke poll-stats produced no usable stats before timeout: {excerpt}",
                phase=name,
                samples=samples,
            )
        return private_smoke_reason(
            payload,
            "private_smoke_runtime_deadlock",
            f"private smoke stats never reached owned-room/creep criteria: {excerpt}",
            phase=name,
            samples=samples,
        )

    if name in {"place-spawn", "room-spawn-verify"}:
        return private_smoke_reason(
            payload,
            "private_smoke_spawn_collapse",
            f"private smoke could not confirm spawn recovery in phase {name}: {excerpt}",
            phase=name,
            structure_type="spawn",
        )

    if name in {"upload-code", "roundtrip-code"}:
        return private_smoke_reason(
            payload,
            "private_smoke_runtime_failure",
            f"private smoke bot bundle phase {name} failed: {excerpt}",
            phase=name,
        )

    return private_smoke_reason(
        payload,
        "private_smoke_failed_phase",
        f"private smoke phase {name} failed: {excerpt}",
        phase=name,
    )


def private_smoke_phase_by_name(payload: dict[str, Any], name: str) -> dict[str, Any] | None:
    for phase in private_smoke_phases(payload):
        if private_smoke_phase_name(phase) == name:
            return phase
    return None


def classify_private_smoke_stats_evidence(payload: dict[str, Any]) -> list[dict[str, Any]]:
    poll_stats = private_smoke_phase_by_name(payload, "poll-stats")
    if poll_stats is None:
        if payload.get("ok") is True and payload.get("dry_run") is False:
            return [
                private_smoke_reason(
                    payload,
                    "private_smoke_telemetry_silence",
                    "private smoke succeeded without poll-stats telemetry evidence",
                    phase="poll-stats",
                )
            ]
        return []

    if poll_stats.get("ok") is not True:
        return []

    details = private_smoke_phase_details(poll_stats)
    samples = numeric_value(details.get("samples"))
    last = details.get("last")
    if not samples or not isinstance(last, dict):
        return [
            private_smoke_reason(
                payload,
                "private_smoke_telemetry_silence",
                "private smoke poll-stats phase passed without usable latest stats",
                phase="poll-stats",
                samples=samples,
            )
        ]

    user = last.get("user")
    min_creeps = numeric_value(nested_value(details, "criteria", "min_creeps"))
    if min_creeps is None:
        min_creeps = 1.0
    creeps = numeric_value(nested_value(user, "creeps")) if isinstance(user, dict) else None
    rooms = numeric_value(nested_value(user, "rooms")) if isinstance(user, dict) else None
    owned_rooms = numeric_value(last.get("ownedRooms"))
    if not isinstance(user, dict) or creeps is None or rooms is None:
        return [
            private_smoke_reason(
                payload,
                "private_smoke_telemetry_silence",
                "private smoke latest stats did not include smoke-user creep evidence",
                phase="poll-stats",
                samples=samples,
            )
        ]
    if creeps is not None and creeps < min_creeps:
        return [
            private_smoke_reason(
                payload,
                "private_smoke_runtime_deadlock",
                f"private smoke latest stats had {int(creeps)} creeps, below required {int(min_creeps)}",
                phase="poll-stats",
                samples=samples,
            )
        ]
    if rooms == 0 or owned_rooms == 0:
        return [
            private_smoke_reason(
                payload,
                "private_smoke_runtime_deadlock",
                "private smoke latest stats did not show an owned room",
                phase="poll-stats",
                samples=samples,
            )
        ]
    return []


def classify_private_smoke_room_evidence(payload: dict[str, Any]) -> list[dict[str, Any]]:
    mongo = private_smoke_phase_by_name(payload, "mongo-summary")
    if mongo is None:
        if payload.get("ok") is True and payload.get("dry_run") is False:
            return [
                private_smoke_reason(
                    payload,
                    "private_smoke_failed_phase",
                    "private smoke succeeded without mongo-summary room evidence",
                    phase="mongo-summary",
                )
            ]
        return []
    if mongo.get("ok") is not True:
        return []

    summary = nested_value(private_smoke_phase_details(mongo), "summary")
    if not isinstance(summary, dict):
        return [
            private_smoke_reason(
                payload,
                "private_smoke_failed_phase",
                "private smoke mongo-summary phase passed without a room summary object",
                phase="mongo-summary",
            )
        ]

    smoke = payload.get("smoke") if isinstance(payload.get("smoke"), dict) else {}
    expected_spawn = nested_value(smoke, "spawn", "name")
    spawns = summary.get("spawns")
    spawn_list = spawns if isinstance(spawns, list) else []
    counts = summary.get("counts")
    spawn_count = numeric_value(nested_value(counts, "spawn")) if isinstance(counts, dict) else None
    matching_spawn = any(isinstance(spawn, dict) and spawn.get("name") == expected_spawn for spawn in spawn_list)
    spawn_visible = matching_spawn or bool(spawn_list) or (spawn_count is not None and spawn_count > 0)
    if not spawn_visible:
        return [
            private_smoke_reason(
                payload,
                "private_smoke_spawn_collapse",
                "private smoke Mongo summary did not include spawn evidence",
                phase="mongo-summary",
                structure_type="spawn",
            )
        ]

    creeps = summary.get("creeps")
    creep_list = creeps if isinstance(creeps, list) else []
    creep_count = numeric_value(nested_value(counts, "creep")) if isinstance(counts, dict) else None
    worker_visible = bool(creep_list) or (creep_count is not None and creep_count > 0)
    if not worker_visible:
        return [
            private_smoke_reason(
                payload,
                "private_smoke_no_worker_evidence",
                "private smoke Mongo summary did not include worker creep evidence",
                phase="mongo-summary",
            )
        ]
    return []


def classify_private_smoke_report(payload: dict[str, Any]) -> list[dict[str, Any]]:
    reasons: list[dict[str, Any]] = []
    phases = private_smoke_phases(payload)
    for phase in phases:
        if phase.get("ok") is False:
            reasons.append(classify_private_smoke_failed_phase(payload, phase))

    if not phases and payload.get("ok") is False:
        reasons.append(
            private_smoke_reason(
                payload,
                "private_smoke_runtime_failure",
                "private smoke failed without phase details",
            )
        )

    if payload.get("dry_run") is not True:
        reasons.extend(classify_private_smoke_stats_evidence(payload))
        reasons.extend(classify_private_smoke_room_evidence(payload))

    if payload.get("ok") is False and not reasons:
        reasons.append(
            private_smoke_reason(
                payload,
                "private_smoke_runtime_failure",
                str(payload.get("error") or "private smoke returned ok=false"),
            )
        )
    return reasons


def infer_tactical_categories(reason: dict[str, Any]) -> list[str]:
    kind = tactical_reason_kind(reason)
    lowered_kind = kind.lower()
    message = str(reason.get("message") or "").lower()
    structure_type = str(reason.get("structure_type") or reason.get("structureType") or "").lower()
    categories: list[str] = []

    if lowered_kind == ENERGY_BUFFER_UNHEALTHY_KIND and not energy_buffer_unhealthy_reason_is_actionable(reason):
        return []

    categories.extend(TACTICAL_REASON_CATEGORY_MAP.get(kind, []))
    categories.extend(TACTICAL_REASON_CATEGORY_MAP.get(lowered_kind, []))

    if is_room_dead_reason(reason):
        categories.extend(["room_dead", "spawn_collapse"])
    elif is_no_owned_spawn_reason(reason):
        categories.append("spawn_collapse")

    if "hostile" in lowered_kind or "hostile" in message:
        categories.append("hostiles")
    if "downgrade" in lowered_kind or "downgrade" in message:
        categories.append("downgrade_risk")
    if "telemetry" in lowered_kind or "runtime-summary" in lowered_kind or "loop_exception" in lowered_kind:
        categories.append("telemetry_silence")
    if "silence" in lowered_kind or "silent" in lowered_kind:
        categories.append("telemetry_silence")
    if "exception" in lowered_kind or "exception" in message:
        categories.append("runtime_exception")
    if (
        "deadlock" in lowered_kind or "deadlock" in message or "no-progress" in message
    ) and CONSTRUCTION_DEADLOCK_KIND not in categories:
        categories.append("runtime_deadlock")
    if "resource" in lowered_kind and "crisis" in lowered_kind:
        categories.append("resource_crisis")
    if "private_smoke" in lowered_kind or "private smoke" in message:
        categories.append("private_smoke_failure")
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
    reason_severity = reason.get("severity")
    if (
        isinstance(reason_severity, str)
        and reason_severity in TACTICAL_SEVERITY_RANK
        and TACTICAL_SEVERITY_RANK[reason_severity] > TACTICAL_SEVERITY_RANK.get(severity, 0)
    ):
        severity = reason_severity
    if category == "downgrade_risk":
        ticks = number_from_reason(reason, "ticks_to_downgrade", "ticksToDowngrade", "remaining_ticks", "remainingTicks")
        if ticks is not None and ticks <= 2000:
            return "critical"
    if category == "owned_structure_damage":
        structure_type = str(reason.get("structure_type") or reason.get("structureType") or "").lower()
        hits = number_from_reason(reason, "current_hits", "currentHits", "hits")
        hits_max = number_from_reason(reason, "hitsMax", "hits_max")
        if structure_type == "rampart":
            delta = number_from_reason(reason, "delta")
            if hits is not None and hits <= RAMPART_SAFE_DECAY_HITS_FLOOR:
                return "critical"
            if (
                hits is not None
                and hits <= RAMPART_CRITICAL_DAMAGE_HITS_CEILING
                and delta is not None
                and delta >= RAMPART_CRITICAL_DAMAGE_DELTA
            ):
                return "critical"
        elif hits is not None and hits_max and hits / hits_max <= 0.25:
            return "critical"
    return severity


def tactical_source_summary(alert_payload: dict[str, Any], reasons: list[dict[str, Any]]) -> dict[str, Any]:
    if is_private_smoke_report(alert_payload):
        phases = private_smoke_phases(alert_payload)
        failed_phases = [
            private_smoke_phase_name(phase)
            for phase in phases
            if phase.get("ok") is False
        ]
        room = private_smoke_room(alert_payload)
        summary = {
            "ok": bool(alert_payload.get("ok")),
            "mode": "private-smoke",
            "alert": bool(reasons),
            "reason_count": len(reasons),
            "rooms": [room] if room else [],
            "suppressed": False,
            "suppressed_count": 0,
            "warning_count": 0,
            "dry_run": bool(alert_payload.get("dry_run")),
            "phase_count": len(phases),
            "failed_phase_count": len(failed_phases),
            "failed_phases": failed_phases,
        }
        if alert_payload.get("ok") is False:
            error = alert_payload.get("error")
            if isinstance(error, str):
                summary["error_excerpt"] = short_text(redact_secrets(error, [os.environ.get("SCREEPS_AUTH_TOKEN", "")]), 220)
        return summary

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


def room_summary_count(room_summary_payload: dict[str, Any], owned_key: str, fallback_key: str) -> Any:
    owned_value = room_summary_payload.get(owned_key)
    if isinstance(owned_value, (int, float)):
        return owned_value
    return room_summary_payload.get(fallback_key)


def tactical_payload_is_clean_no_alert(alert_payload: dict[str, Any]) -> bool:
    raw_reasons = alert_payload.get("reasons")
    return alert_payload.get("alert") is False and isinstance(raw_reasons, list) and not raw_reasons


def tactical_room_summary_survival_reasons(alert_payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_room_summaries = alert_payload.get("room_summaries")
    if not isinstance(raw_room_summaries, list):
        return []

    clean_no_alert = tactical_payload_is_clean_no_alert(alert_payload)
    reasons: list[dict[str, Any]] = []
    for room in raw_room_summaries:
        if not isinstance(room, dict):
            continue
        room_name = room.get("room")
        owned_spawns = room_summary_count(room, "owned_spawns", "spawns")
        owned_creeps = room_summary_count(room, "owned_creeps", "creeps")
        hostiles = room.get("hostiles")
        owner = room.get("owner")
        expected_owner = room.get("expected_owner") or room.get("expectedOwner")
        if isinstance(owned_spawns, (int, float)) and owned_spawns <= 0:
            if isinstance(owned_creeps, (int, float)) and owned_creeps <= 0:
                reasons.append(
                    {
                        "kind": "room_dead",
                        "room": room_name,
                        "current_owned_spawns": owned_spawns,
                        "current_owned_creeps": owned_creeps,
                        "current_owner": owner,
                        "expected_owner": expected_owner,
                        "controller_claimed": bool(owner and (not expected_owner or owner == expected_owner)),
                        "message": f"{room_name}: owned_spawns=0 and owned_creeps=0",
                    }
                )
            else:
                if (
                    clean_no_alert
                    and isinstance(owned_creeps, (int, float))
                    and owned_creeps > 0
                    and isinstance(hostiles, (int, float))
                    and hostiles <= 0
                ):
                    continue
                reasons.append(
                    {
                        "kind": "owned_spawns=0",
                        "room": room_name,
                        "owned_spawns": owned_spawns,
                        "owned_creeps": owned_creeps,
                        "message": f"{room_name}: owned_spawns=0",
                    }
                )
    return reasons


def normalize_tactical_reasons(alert_payload: dict[str, Any]) -> list[dict[str, Any]]:
    reasons: list[dict[str, Any]] = []
    if is_private_smoke_report(alert_payload):
        reasons.extend(classify_private_smoke_report(alert_payload))

    raw_reasons = alert_payload.get("reasons")
    if isinstance(raw_reasons, list):
        reasons.extend(dict(reason) for reason in raw_reasons if isinstance(reason, dict))

    raw_suppressed_reasons = alert_payload.get("suppressed_reasons")
    if isinstance(raw_suppressed_reasons, list):
        for reason in raw_suppressed_reasons:
            if not isinstance(reason, dict) or not is_room_dead_reason(reason):
                continue
            suppressed_reason = dict(reason)
            suppressed_reason["suppressed"] = True
            reasons.append(suppressed_reason)
    if not any(is_room_dead_reason(reason) or is_no_owned_spawn_reason(reason) for reason in reasons):
        reasons.extend(tactical_room_summary_survival_reasons(alert_payload))
    return reasons


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
    private_smoke = is_private_smoke_report(alert_payload)
    triggers: list[dict[str, Any]] = []
    category_set: set[str] = set()
    action_ids: list[str] = []
    severity = "none"

    if alert_payload.get("ok") is False and not private_smoke:
        synthetic_reason = {
            "kind": "telemetry_silence",
            "message": "runtime monitor returned ok=false",
        }
        reasons = [synthetic_reason, *reasons]
    elif alert_payload.get("ok") is False and private_smoke and not reasons:
        reasons = [
            private_smoke_reason(
                alert_payload,
                "private_smoke_runtime_failure",
                "private smoke returned ok=false without classifiable phase details",
            )
        ]
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
            trigger = {
                "category": category,
                "severity": category_sev,
                "priority": tactical_priority(category_sev),
                "decision": tactical_decision(category, rule, reason),
                "reason_kind": tactical_reason_kind(reason),
                "room": reason.get("room"),
                "object_id": reason.get("object_id"),
                "structure_type": reason.get("structure_type") or reason.get("structureType"),
                "suppressed": bool(reason.get("suppressed")),
                "message": short_text(redact_secrets(str(reason.get("message") or tactical_reason_kind(reason)), [os.environ.get("SCREEPS_AUTH_TOKEN", "")]), 180),
            }
            metadata = tactical_trigger_metadata(rule, reason)
            if metadata:
                trigger["metadata"] = metadata
            triggers.append(trigger)

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
        "priority": tactical_priority(severity),
    }

    return {
        "ok": True,
        "mode": "tactical-response",
        "source": source,
        "emergency": emergency,
        "silent": not emergency,
        "severity": severity,
        "priority": tactical_priority(severity),
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
    construction_sites = [obj for obj in objects.values() if isinstance(obj, dict) and obj.get("type") == "constructionSite"]
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

    def site_marker(obj: dict[str, Any]) -> None:
        x, y = center(obj)
        add(
            f'<rect x="{x-4.8:.2f}" y="{y-4.8:.2f}" width="9.6" height="9.6" rx="1.4" '
            'fill="none" stroke="#cf4327" stroke-width="1.1" stroke-dasharray="2 2"/>'
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
    for site in construction_sites:
        site_marker(site)

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

    def legend_sample(x: float, y: float, shape: str, fill: str, label: str, stroke: str = "#111", opacity: str = "1") -> None:
        if shape == "circle":
            add(f'<circle cx="{x+7:.1f}" cy="{y-5:.1f}" r="6.5" fill="{fill}" fill-opacity="{opacity}" stroke="{stroke}" stroke-width="1.2"/>')
        elif shape == "site":
            add(f'<rect x="{x:.1f}" y="{y-12:.1f}" width="14" height="14" rx="1.8" fill="none" stroke="{stroke}" stroke-width="1.1" stroke-dasharray="2 2"/>')
        else:
            add(f'<rect x="{x:.1f}" y="{y-12:.1f}" width="14" height="14" rx="1.8" fill="{fill}" fill-opacity="{opacity}" stroke="{stroke}" stroke-width="1"/>')
        text(x + 20, y - 1, label, "legend")

    legend_rows = [
        [
            ("square", "#e4ded2", "plain", "#111", "1"),
            ("square", "#b7b48e", "swamp", "#111", "1"),
            ("square", "#353632", "terrain wall", "#111", "1"),
            ("circle", "#2f8c5a", "spawn", "#111", "1"),
            ("circle", "#d3a400", "source", "#111", "1"),
            ("circle", "#2f6e91", "controller", "#111", "1"),
            ("circle", "#8060a8", "mineral", "#111", "1"),
            ("circle", "#fffaf0", "creep", "#111", "1"),
            ("circle", "#cf4327", "hostile", "#cf4327", "1"),
        ],
        [
            ("square", "#a69b8d", "road", "#8c8174", ".72"),
            ("square", "#71956e", "extension", "#111", ".95"),
            ("square", "#6f6379", "tower", "#111", ".98"),
            ("square", "#84ad83", "rampart", "#496f4d", ".45"),
            ("square", "#292a27", "built wall", "#111", ".88"),
            ("square", "#9a8165", "utility", "#111", ".98"),
            ("square", "#b9a98f", "other struct", "#111", ".9"),
            ("site", "none", "site", "#cf4327", "1"),
            ("circle", "none", "alert ring", "#cf4327", "0"),
        ],
    ]
    legend_y = card_y + card_h - 58
    for row_index, row in enumerate(legend_rows):
        item_width = 135 if row_index == 0 else 142
        legend_x = 96
        y = legend_y + row_index * 28
        for shape, fill, label, stroke, opacity in row:
            if label == "alert ring":
                add(f'<circle cx="{legend_x+7:.1f}" cy="{y-5:.1f}" r="8.0" fill="none" stroke="{stroke}" stroke-width="1.4"/>')
                text(legend_x + 20, y - 1, label, "legend")
            else:
                legend_sample(legend_x, y, shape, fill, label, stroke, opacity)
            legend_x += item_width

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
    info = snapshot.info if isinstance(snapshot.info, dict) else {}
    hostiles = detect_hostile_creeps(snapshot.objects, snapshot.owner)
    metrics = compute_room_summary_metrics(snapshot)
    owned_spawns = count_owned_objects(snapshot.objects, snapshot.owner, "spawn", snapshot.expected_owner_id)
    behavior_totals = behavior_pathing_totals(info)
    assignment_blocked_fields = worker_assignment_blocked_fields(snapshot, metrics)
    summary = {
        "room": snapshot.ref.key,
        "shard": snapshot.ref.shard,
        "name": snapshot.ref.room,
        "tick": snapshot.tick,
        "objects": len(snapshot.objects),
        "creeps": snapshot.counts.get("creep", 0),
        "owned_creeps": len(metrics.owned_creep_objects),
        "structures": len(metrics.structures),
        "spawns": sum(1 for structure in metrics.structures if structure.get("type") == "spawn"),
        "owned_spawns": owned_spawns,
        "hostiles": len(hostiles),
        "owner": snapshot.owner,
        "expected_owner": snapshot.expected_owner,
        "expected_owner_id": snapshot.expected_owner_id,
        "taskCounts": metrics.task_counts,
        "workerAssignmentEvidenceAvailable": metrics.worker_assignment_evidence_available,
        "pendingBuildProgress": metrics.pending_build_progress,
        "buildCarriedEnergy": metrics.build_carried_energy,
        "constructionDeadlockTicks": metrics.construction_deadlock_ticks,
        "buildBlockedReason": metrics.build_blocked_reason,
        **assignment_blocked_fields,
        "constructionSiteCount": len(metrics.construction_sites),
        "extensionConstructionSiteCount": metrics.extension_construction_site_count,
        "extensionPendingBuildProgress": metrics.extension_pending_build_progress,
        "extensionCount": metrics.extension_count,
        "extensionCapacityContribution": metrics.extension_capacity_contribution,
        "workerLoadEfficiency": worker_load_efficiency(metrics.owned_creep_objects),
        "cpuUsed": metrics.cpu_used,
        "cpuBucket": metrics.cpu_bucket,
        "rclLevel": metrics.rcl_level,
        "controller": metrics.controller_summary,
        "storedEnergy": metrics.stored_energy,
        "energyCapacity": number_value(info.get("energyCapacity") or info.get("energyCapacityAvailable")),
        "energyCapacityAvailable": number_value(info.get("energyCapacityAvailable")),
        "energyBufferHealth": as_dict(info.get("energyBufferHealth")),
    }
    if metrics.build_blocked_reason is None:
        summary.pop("buildBlockedReason", None)
    if behavior_totals:
        summary["behavior"] = {"totals": behavior_totals}
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


def number_value(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    return None


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def runtime_summary_room_name(room: dict[str, Any]) -> str | None:
    for key in ("roomName", "name"):
        value = room.get(key)
        if isinstance(value, str) and value:
            return value

    room_ref = room.get("room")
    if isinstance(room_ref, str) and room_ref:
        return room_ref.rsplit("/", 1)[-1]
    return None


def runtime_summary_room_shard(room: dict[str, Any]) -> str | None:
    room_ref = room.get("room")
    if isinstance(room_ref, str) and "/" in room_ref:
        shard = room_ref.split("/", 1)[0]
        if shard:
            return shard

    shard = room.get("shard")
    if isinstance(shard, str) and shard:
        return shard
    return None


def ambiguous_runtime_room_names(refs: list[RoomRef]) -> set[str]:
    shards_by_room: dict[str, set[str]] = {}
    for ref in refs:
        shards_by_room.setdefault(ref.room, set()).add(ref.shard)
    return {room for room, shards in shards_by_room.items() if len(shards) > 1}


def runtime_summary_room_matches(
    room: dict[str, Any],
    ref: RoomRef,
    ambiguous_room_names: set[str],
    payload_explicit_shards_by_room: dict[str, set[str]] | None = None,
) -> bool:
    room_ref = room.get("room")
    if isinstance(room_ref, str) and room_ref == ref.key:
        return True
    room_name = runtime_summary_room_name(room)
    shard = runtime_summary_room_shard(room)
    if room_name != ref.room:
        return False
    if shard is not None:
        return shard == ref.shard
    if room_name in ambiguous_room_names:
        return False
    explicit_shards = (payload_explicit_shards_by_room or {}).get(room_name, set())
    return not explicit_shards or explicit_shards == {ref.shard}


def runtime_summary_explicit_shards_by_room(rooms: list[dict[str, Any]]) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for room in rooms:
        room_name = runtime_summary_room_name(room)
        shard = runtime_summary_room_shard(room)
        if room_name is not None and shard is not None:
            result.setdefault(room_name, set()).add(shard)
    return result


def runtime_summary_room_has_worker_idle_fields(room: dict[str, Any]) -> bool:
    return any(
        key in room
        for key in (
            "taskCounts",
            "spawnStatus",
            "energyAvailable",
            "energyCapacity",
            "energyBufferHealth",
            "workerCount",
        )
    )


def runtime_summary_payload_has_cpu_fields(payload: dict[str, Any]) -> bool:
    return (
        runtime_cpu_bucket(payload) is not None
        or runtime_cpu_used(payload) is not None
        or runtime_cpu_limit(payload) is not None
        or runtime_low_bucket_ticks(payload) is not None
        or runtime_cpu_pressure(payload) is not None
        or bool(runtime_cpu_signal_values(payload, "alerts"))
        or bool(runtime_cpu_signal_values(payload, "reasons"))
    )


def runtime_summary_room_has_cpu_fields(room: dict[str, Any]) -> bool:
    return (
        runtime_cpu_bucket(room) is not None
        or runtime_cpu_used(room) is not None
        or runtime_cpu_limit(room) is not None
        or runtime_low_bucket_ticks(room) is not None
        or runtime_cpu_pressure(room) is not None
        or bool(runtime_cpu_signal_values(room, "alerts"))
        or bool(runtime_cpu_signal_values(room, "reasons"))
    )


def runtime_summary_room_has_monitor_alert_fields(room: dict[str, Any], payload: dict[str, Any]) -> bool:
    return (
        runtime_summary_room_has_worker_idle_fields(room)
        or runtime_summary_room_has_cpu_fields(room)
        or runtime_summary_payload_has_cpu_fields(payload)
        or runtime_productive_assignment_count(room) is not None
        or runtime_worker_assignment_blocked_detail(room) is not None
        or bool(runtime_worker_assignment_blocked_workers(room))
    )


def parse_runtime_summary_line(line: str) -> dict[str, Any] | None:
    stripped = line.strip()
    if not stripped.startswith(RUNTIME_SUMMARY_PREFIX):
        return None
    try:
        payload = json.loads(html.unescape(stripped[len(RUNTIME_SUMMARY_PREFIX) :]))
    except json.JSONDecodeError:
        return None
    if isinstance(payload, dict) and payload.get("type") == "runtime-summary":
        return payload
    return None


def parse_runtime_cpu_summary_line(line: str) -> dict[str, Any] | None:
    stripped = line.strip()
    if not stripped.startswith(RUNTIME_CPU_SUMMARY_PREFIX):
        return None
    try:
        cpu = json.loads(html.unescape(stripped[len(RUNTIME_CPU_SUMMARY_PREFIX) :]))
    except json.JSONDecodeError:
        return None
    if not isinstance(cpu, dict):
        return None

    payload = {"type": "runtime-cpu-summary", "cpu": cpu}
    if not runtime_summary_payload_has_cpu_fields(payload):
        return None
    return payload


def payload_runtime_rooms(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rooms = payload.get("rooms")
    if not isinstance(rooms, list):
        return []
    return [room for room in rooms if isinstance(room, dict)]


def runtime_summary_artifact_timestamp(path: Path) -> float | None:
    match = re.search(r"(\d{8}T\d{6}Z)", path.name)
    if match is not None:
        try:
            return datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            pass
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def runtime_summary_log_sort_key(path: Path) -> tuple[bool, float, str]:
    timestamp = runtime_summary_artifact_timestamp(path)
    return (timestamp is not None, timestamp if timestamp is not None else -1.0, str(path))


def runtime_summary_log_paths(runtime_summary_dir: Path) -> list[Path]:
    return sorted(runtime_summary_dir.glob("*.log"), key=runtime_summary_log_sort_key, reverse=True)


def runtime_summary_payload_tick(payload: dict[str, Any]) -> int | None:
    return tick_number(payload.get("tick"))


def runtime_summary_freshness_key(payload: dict[str, Any], path: Path, line_index: int) -> tuple[bool, float, int, bool, int, str]:
    tick = runtime_summary_payload_tick(payload)
    timestamp = runtime_summary_artifact_timestamp(path)
    return (
        timestamp is not None,
        timestamp if timestamp is not None else -1.0,
        line_index,
        tick is not None,
        tick if tick is not None else -1,
        str(path),
    )


def runtime_summary_candidate_key(
    payload: dict[str, Any],
    path: Path,
    line_index: int,
    room: dict[str, Any],
) -> tuple[bool, int, bool, float, int, int, str]:
    tick = runtime_summary_payload_tick(payload)
    timestamp = runtime_summary_artifact_timestamp(path)
    explicit_shard_rank = 1 if runtime_summary_room_shard(room) is not None else 0
    return (
        tick is not None,
        tick if tick is not None else -1,
        timestamp is not None,
        timestamp if timestamp is not None else -1.0,
        line_index,
        explicit_shard_rank,
        str(path),
    )


def runtime_summary_room_with_metadata(
    payload: dict[str, Any],
    path: Path,
    room: dict[str, Any],
    line_index: int | None = None,
) -> dict[str, Any]:
    result = dict(room)
    tick = runtime_summary_payload_tick(payload)
    if tick is not None:
        result[RUNTIME_SUMMARY_TICK_METADATA_KEY] = tick
    timestamp = runtime_summary_artifact_timestamp(path)
    if timestamp is not None:
        result[RUNTIME_SUMMARY_ARTIFACT_TIMESTAMP_METADATA_KEY] = timestamp
    result[RUNTIME_SUMMARY_ARTIFACT_PATH_METADATA_KEY] = str(path)
    if line_index is not None:
        result[RUNTIME_SUMMARY_ARTIFACT_LINE_METADATA_KEY] = line_index + 1
    source = payload.get("source")
    if isinstance(source, str) and source:
        result[RUNTIME_SUMMARY_SOURCE_METADATA_KEY] = source
    elif path.name.startswith("runtime-summary-monitor-"):
        result[RUNTIME_SUMMARY_SOURCE_METADATA_KEY] = MONITOR_RUNTIME_SUMMARY_SOURCE
    cpu = payload.get("cpu")
    if isinstance(cpu, dict) and runtime_summary_payload_has_cpu_fields(payload):
        result[RUNTIME_SUMMARY_CPU_METADATA_KEY] = dict(cpu)
    return result


def runtime_cpu_summary_room(ref: RoomRef, cpu: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"room": ref.key, "roomName": ref.room, "shard": ref.shard}
    used = number_value(cpu.get("used"))
    if used is not None:
        result["cpuUsed"] = used
    limit = number_value(cpu.get("limit"))
    if limit is not None:
        result["cpuLimit"] = limit
    bucket = number_value(cpu.get("bucket"))
    if bucket is not None:
        result["cpuBucket"] = bucket
    low_bucket_ticks = number_value(cpu.get("lowBucketTicks"))
    if low_bucket_ticks is not None:
        result["lowBucketTicks"] = low_bucket_ticks
    return result


def runtime_summary_room_with_cpu_fields(base: dict[str, Any], cpu_room: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for field in ("room", "roomName", "shard"):
        if field not in result and field in cpu_room:
            result[field] = cpu_room[field]
    cpu_metadata = as_dict(cpu_room.get(RUNTIME_SUMMARY_CPU_METADATA_KEY))
    if cpu_metadata:
        result[RUNTIME_SUMMARY_CPU_METADATA_KEY] = dict(cpu_metadata)
    nested_cpu = as_dict(cpu_room.get("cpu"))
    if nested_cpu:
        result["cpu"] = dict(nested_cpu)
    for field in (
        "cpuBucket",
        "cpuUsed",
        "cpuLimit",
        "lowBucketTicks",
        "bucketEmptyTicks",
        "bucket",
        "pressure",
        "alerts",
        "reasons",
    ):
        if field in cpu_room:
            result[field] = cpu_room[field]
    return result


def runtime_summary_capture_history_entry(room: dict[str, Any]) -> dict[str, Any]:
    entry: dict[str, Any] = {}
    for source_key, target_key in (
        ("room", "room"),
        ("roomName", "roomName"),
        ("shard", "shard"),
        (RUNTIME_SUMMARY_SOURCE_METADATA_KEY, "source"),
        (RUNTIME_SUMMARY_ARTIFACT_PATH_METADATA_KEY, "path"),
    ):
        value = room.get(source_key)
        if isinstance(value, str) and value:
            entry[target_key] = value

    tick = runtime_summary_room_tick(room)
    if tick is not None:
        entry["runtimeSummaryTick"] = tick
    timestamp = room.get(RUNTIME_SUMMARY_ARTIFACT_TIMESTAMP_METADATA_KEY)
    if isinstance(timestamp, (int, float, str)):
        entry["runtimeSummaryArtifactTimestamp"] = timestamp
    line_number = number_value(room.get(RUNTIME_SUMMARY_ARTIFACT_LINE_METADATA_KEY))
    if line_number is not None:
        entry["line"] = int(line_number)

    productive_assignment_count = runtime_productive_assignment_count(room)
    if productive_assignment_count is not None:
        entry["productiveAssignmentCount"] = productive_assignment_count
    blocked_detail = runtime_worker_assignment_blocked_detail(room)
    if blocked_detail is not None:
        entry["workerAssignmentBlockedDetail"] = blocked_detail
    blocked_workers = runtime_worker_assignment_blocked_workers(room)
    if blocked_workers:
        entry["workerAssignmentBlockedWorkers"] = blocked_workers
    worker_count = first_number_value(room, ("workerCount",), ("workerAssignmentEvidence", "workerCount"))
    if worker_count is not None:
        entry["workerCount"] = worker_count

    task_counts = as_dict(room.get("taskCounts"))
    if task_counts:
        entry["taskCounts"] = dict(task_counts)
    build_count = runtime_task_count(room, "build")
    if build_count is not None:
        entry["build"] = build_count
    construction_site_count = runtime_construction_site_count(room)
    if construction_site_count is not None:
        entry["constructionSiteCount"] = construction_site_count
    pending_build_progress = runtime_pending_build_progress(room)
    if pending_build_progress is not None:
        entry["pendingBuildProgress"] = pending_build_progress
    build_blocked_reason = runtime_build_blocked_reason(room)
    if build_blocked_reason is not None:
        entry["buildBlockedReason"] = build_blocked_reason

    return entry


def runtime_summary_capture_history_key(entry: dict[str, Any]) -> tuple[bool, int, bool, float, int, str]:
    tick = tick_number(entry.get("runtimeSummaryTick"))
    timestamp = number_value(entry.get("runtimeSummaryArtifactTimestamp"))
    line_number = number_value(entry.get("line"))
    path = entry.get("path")
    return (
        tick is not None,
        tick if tick is not None else -1,
        timestamp is not None,
        timestamp if timestamp is not None else -1.0,
        int(line_number) if line_number is not None else -1,
        path if isinstance(path, str) else "",
    )


def attach_runtime_summary_capture_history(
    room: dict[str, Any],
    history: list[dict[str, Any]],
) -> dict[str, Any]:
    result = dict(room)
    if history:
        result[RUNTIME_SUMMARY_CAPTURE_HISTORY_METADATA_KEY] = sorted(
            history,
            key=runtime_summary_capture_history_key,
            reverse=True,
        )[:RUNTIME_SUMMARY_CAPTURE_HISTORY_LIMIT]
    return result


def load_latest_runtime_room_summaries(
    runtime_summary_dir: Path,
    refs: list[RoomRef],
    warnings: list[str],
    disambiguation_refs: list[RoomRef] | None = None,
) -> dict[str, dict[str, Any]]:
    if not refs or not runtime_summary_dir.exists():
        return {}

    try:
        paths = runtime_summary_log_paths(runtime_summary_dir)
    except OSError as exc:
        warnings.append(f"runtime-summary scan unavailable: {short_text(exc, 140)}")
        return {}

    ambiguous_room_names = ambiguous_runtime_room_names([*refs, *(disambiguation_refs or [])])
    runtime_result: dict[str, dict[str, Any]] = {}
    runtime_result_keys: dict[str, tuple[bool, int, bool, float, int, int, str]] = {}
    runtime_cpu_freshness_keys: dict[str, tuple[bool, float, int, bool, int, str]] = {}
    cpu_result: dict[str, dict[str, Any]] = {}
    cpu_freshness_keys: dict[str, tuple[bool, float, int, bool, int, str]] = {}
    capture_history: dict[str, list[dict[str, Any]]] = {}
    for path in paths:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as exc:
            warnings.append(f"runtime-summary artifact unreadable {path.name}: {short_text(exc, 140)}")
            continue

        for line_index, line in reversed(list(enumerate(lines))):
            is_cpu_summary_line = line.strip().startswith(RUNTIME_CPU_SUMMARY_PREFIX)
            cpu_payload = parse_runtime_cpu_summary_line(line)
            if is_cpu_summary_line and cpu_payload is None:
                warnings.append(f"runtime-summary artifact ignored malformed #cpu-summary {path.name}:{line_index + 1}")
                continue
            if cpu_payload is not None:
                cpu = as_dict(cpu_payload.get("cpu"))
                candidate_freshness_key = runtime_summary_freshness_key(cpu_payload, path, line_index)
                for ref in refs:
                    if candidate_freshness_key <= cpu_freshness_keys.get(ref.key, (False, -1.0, -1, False, -1, "")):
                        continue
                    room = runtime_cpu_summary_room(ref, cpu)
                    cpu_result[ref.key] = runtime_summary_room_with_metadata(cpu_payload, path, room, line_index)
                    cpu_freshness_keys[ref.key] = candidate_freshness_key
                continue

            payload = parse_runtime_summary_line(line)
            if payload is None:
                continue
            rooms = payload_runtime_rooms(payload)
            payload_explicit_shards_by_room = runtime_summary_explicit_shards_by_room(rooms)
            candidate_freshness_key = runtime_summary_freshness_key(payload, path, line_index)
            for room in rooms:
                if not runtime_summary_room_has_monitor_alert_fields(room, payload):
                    continue
                for ref in refs:
                    if not runtime_summary_room_matches(
                        room,
                        ref,
                        ambiguous_room_names,
                        payload_explicit_shards_by_room,
                    ):
                        continue
                    candidate_key = runtime_summary_candidate_key(payload, path, line_index, room)
                    candidate_room = runtime_summary_room_with_metadata(payload, path, room, line_index)
                    capture_history.setdefault(ref.key, []).append(runtime_summary_capture_history_entry(candidate_room))
                    if runtime_summary_room_has_cpu_fields(room) or runtime_summary_payload_has_cpu_fields(payload):
                        if candidate_freshness_key > cpu_freshness_keys.get(ref.key, (False, -1.0, -1, False, -1, "")):
                            cpu_result[ref.key] = candidate_room
                            cpu_freshness_keys[ref.key] = candidate_freshness_key
                    if candidate_key <= runtime_result_keys.get(ref.key, (False, -1, False, -1.0, -1, -1, "")):
                        continue
                    runtime_result[ref.key] = candidate_room
                    runtime_result_keys[ref.key] = candidate_key
                    if runtime_summary_room_has_cpu_fields(room) or runtime_summary_payload_has_cpu_fields(payload):
                        runtime_cpu_freshness_keys[ref.key] = candidate_freshness_key
                    break

    result: dict[str, dict[str, Any]] = {}
    for ref in refs:
        runtime_room = runtime_result.get(ref.key)
        cpu_room = cpu_result.get(ref.key)
        history = capture_history.get(ref.key, [])
        if runtime_room is None and cpu_room is None:
            continue
        if runtime_room is None:
            result[ref.key] = attach_runtime_summary_capture_history(dict(cpu_room) if cpu_room is not None else {}, history)
            continue
        if cpu_room is None:
            result[ref.key] = attach_runtime_summary_capture_history(runtime_room, history)
            continue
        cpu_key = cpu_freshness_keys.get(ref.key)
        runtime_cpu_key = runtime_cpu_freshness_keys.get(ref.key)
        if cpu_key is not None and (runtime_cpu_key is None or cpu_key > runtime_cpu_key):
            result[ref.key] = attach_runtime_summary_capture_history(
                runtime_summary_room_with_cpu_fields(runtime_room, cpu_room),
                history,
            )
        else:
            result[ref.key] = attach_runtime_summary_capture_history(runtime_room, history)
    return result


def store_energy(obj: dict[str, Any]) -> int | float:
    store = obj.get("store")
    if isinstance(store, dict):
        energy = number_value(store.get("energy"))
        if energy is not None:
            return energy
    carry = obj.get("carry")
    if isinstance(carry, dict):
        energy = number_value(carry.get("energy"))
        if energy is not None:
            return energy
    energy = number_value(obj.get("energy"))
    return energy if energy is not None else 0


def store_capacity(obj: dict[str, Any], fallback: int | float = 0) -> int | float:
    store = obj.get("store")
    if isinstance(store, dict):
        for key in ("capacity", "storeCapacity", "energyCapacity"):
            capacity = number_value(store.get(key))
            if capacity is not None:
                return capacity
    for key in ("storeCapacity", "energyCapacity", "capacity"):
        capacity = number_value(obj.get(key))
        if capacity is not None:
            return capacity
    return fallback


def carried_energy(obj: dict[str, Any]) -> int | float:
    carry = obj.get("carry")
    if isinstance(carry, dict):
        energy = number_value(carry.get("energy"))
        if energy is not None:
            return energy
    return store_energy(obj)


def creep_role(creep: dict[str, Any]) -> str | None:
    for candidate in (creep.get("role"), as_dict(creep.get("memory")).get("role")):
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def is_worker_creep(creep: dict[str, Any]) -> bool:
    role = creep_role(creep)
    return role is not None and role.lower() == "worker"


def is_worker_assignment_task_type(task_type: str | None) -> bool:
    return task_type is not None and task_type.strip().lower() in ASSIGNED_WORKER_TASK_NAMES


def creep_has_assignment_evidence(creep: dict[str, Any]) -> bool:
    return is_worker_creep(creep) or is_worker_assignment_task_type(creep_task_type(creep))


def worker_assignment_evidence_available(
    owned_creeps: list[dict[str, Any]],
    explicit_blocked_workers: list[dict[str, Any]] | None,
    explicit_blocked_detail: str | None,
) -> bool:
    if explicit_blocked_detail is not None or bool(explicit_blocked_workers):
        return True
    return any(creep_has_assignment_evidence(creep) for creep in owned_creeps)


def behavior_pathing_totals(source: dict[str, Any]) -> dict[str, int | float]:
    totals = as_dict(as_dict(source.get("behavior")).get("totals"))
    result: dict[str, int | float] = {}
    for key in ("pathFindingFailures", "destinationBlocked"):
        if key not in totals:
            continue
        value = number_value(totals.get(key))
        if value is not None:
            result[key] = value
    return result


def first_number_value(value: Any, *paths: tuple[str, ...]) -> int | float | None:
    for path in paths:
        found = number_value(nested_value(value, *path))
        if found is not None:
            return found
    return None


def construction_site_pending_progress(site: dict[str, Any]) -> int | float:
    progress = number_value(site.get("progress")) or 0
    progress_total = number_value(site.get("progressTotal"))
    if progress_total is None:
        return 0
    return max(0, progress_total - progress)


def normalize_structure_type_name(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    normalized = value.lower()
    if normalized.startswith("structure_"):
        normalized = normalized[len("structure_") :]
    return normalized


def construction_site_matches_structure_type(site: dict[str, Any], structure_type: str) -> bool:
    return normalize_structure_type_name(site.get("structureType")) == structure_type


def is_owned_construction_site(site: dict[str, Any], snapshot: RoomSnapshot) -> bool:
    return site.get("type") == "constructionSite" and is_owned_object(
        site,
        snapshot.owner,
        snapshot.expected_owner_id,
    )


def owned_construction_sites(snapshot: RoomSnapshot) -> list[dict[str, Any]]:
    return [
        obj
        for obj in snapshot.objects.values()
        if isinstance(obj, dict) and is_owned_construction_site(obj, snapshot)
    ]


def object_has_build_task(value: Any) -> bool:
    if isinstance(value, str):
        lowered = value.lower()
        return lowered == "build" or lowered == "builder" or lowered.endswith(":build")
    if isinstance(value, dict):
        for key, item in value.items():
            lowered_key = str(key).lower()
            if lowered_key in {"role", "task", "taskname", "action", "job", "intent"} and object_has_build_task(item):
                return True
            if isinstance(item, dict) and object_has_build_task(item):
                return True
        return False
    return False


def creep_has_build_task(creep: dict[str, Any]) -> bool:
    for candidate in (
        creep.get("role"),
        creep.get("task"),
        creep.get("memory"),
        creep.get("runtimeTask"),
        creep.get("assignment"),
    ):
        if object_has_build_task(candidate):
            return True
    return False


def room_stored_energy(objects: dict[str, dict[str, Any]], owner_username: str | None) -> int | float:
    total: int | float = 0
    for obj in structure_objects(objects):
        if confirmed_foreign_owner(obj, owner_username):
            continue
        if isinstance(obj.get("store"), dict) or obj.get("type") in ENERGY_STORAGE_STRUCTURE_TYPES:
            total += store_energy(obj)
    return total


def room_extension_metrics(structures: list[dict[str, Any]], owner_username: str | None) -> tuple[int, int | float]:
    extensions = [
        structure
        for structure in structures
        if structure.get("type") == "extension" and not confirmed_foreign_owner(structure, owner_username)
    ]
    return len(extensions), sum(store_capacity(extension, fallback=50) for extension in extensions)


def worker_load_efficiency(owned_creeps: list[dict[str, Any]]) -> dict[str, Any]:
    trip_energies = [carried_energy(creep) for creep in owned_creeps if is_worker_creep(creep)]
    if not trip_energies:
        return {"sampleCount": 0, "tripEnergyMean": None, "tripEnergyMin": None}
    return {
        "sampleCount": len(trip_energies),
        "tripEnergyMean": round(sum(trip_energies) / len(trip_energies), 3),
        "tripEnergyMin": min(trip_energies),
    }


def worker_task_counts(owned_creeps: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"harvest": 0, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 0}
    for creep in owned_creeps:
        if not is_worker_creep(creep):
            continue
        task_type = creep_task_type(creep)
        if task_type in counts and task_type != "none":
            counts[task_type] += 1
        else:
            counts["none"] += 1
    return counts


def string_value(value: Any) -> str | None:
    if isinstance(value, str) and value:
        return value
    return None


def explicit_worker_assignment_blocked_detail(source: dict[str, Any]) -> str | None:
    for path in (
        ("workerAssignmentBlockedDetail",),
        ("resources", "productiveEnergy", "workerAssignmentBlockedDetail"),
        ("productiveEnergy", "workerAssignmentBlockedDetail"),
        ("construction", "workerAssignmentBlockedDetail"),
    ):
        value = string_value(nested_value(source, *path))
        if value is not None:
            return value
    return None


def sanitized_worker_assignment_blocked_worker(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None

    result: dict[str, Any] = {}
    for key in WORKER_ASSIGNMENT_BLOCKED_WORKER_STRING_FIELDS:
        field_value = string_value(value.get(key))
        if field_value is not None:
            result[key] = field_value
    for key in WORKER_ASSIGNMENT_BLOCKED_WORKER_NUMBER_FIELDS:
        field_value = number_value(value.get(key))
        if field_value is not None:
            result[key] = field_value
    return result or None


def explicit_worker_assignment_blocked_workers(source: dict[str, Any]) -> list[dict[str, Any]] | None:
    for path in (
        ("workerAssignmentBlockedWorkers",),
        ("resources", "productiveEnergy", "workerAssignmentBlockedWorkers"),
        ("productiveEnergy", "workerAssignmentBlockedWorkers"),
        ("construction", "workerAssignmentBlockedWorkers"),
    ):
        value = nested_value(source, *path)
        if not isinstance(value, list):
            continue
        workers = [
            worker
            for worker in (sanitized_worker_assignment_blocked_worker(item) for item in value)
            if worker is not None
        ]
        return workers
    return None


def creep_memory(creep: dict[str, Any]) -> dict[str, Any]:
    return as_dict(creep.get("memory"))


def creep_name(creep: dict[str, Any]) -> str | None:
    return string_value(creep.get("name")) or string_value(creep_memory(creep).get("name"))


def creep_task_type(creep: dict[str, Any]) -> str | None:
    memory = creep_memory(creep)
    for candidate in (memory.get("task"), creep.get("task"), creep.get("runtimeTask"), creep.get("assignment")):
        if isinstance(candidate, dict):
            task_type = string_value(candidate.get("type"))
            if task_type is not None:
                return task_type
        task_type = string_value(candidate)
        if task_type is not None:
            return task_type
    return None


def creep_free_energy_capacity(creep: dict[str, Any]) -> int | float:
    return max(0, store_capacity(creep) - carried_energy(creep))


def creep_has_active_body_part(creep: dict[str, Any], part_type: str) -> bool:
    body = creep.get("body")
    if not isinstance(body, list):
        return False
    for part in body:
        if not isinstance(part, dict):
            continue
        hits = number_value(part.get("hits"))
        if part.get("type") == part_type and (1 if hits is None else hits) > 0:
            return True
    return False


def creep_is_construction_capable(creep: dict[str, Any]) -> bool:
    return creep_has_active_body_part(creep, "work") and store_capacity(creep) > 0


def worker_assignment_blocked_detail_from_snapshot(
    snapshot: RoomSnapshot,
    workers: list[dict[str, Any]],
) -> str:
    if not any(creep_is_construction_capable(worker) for worker in workers):
        return "no_valid_body"

    buffer_health = as_dict(snapshot.info.get("energyBufferHealth"))
    buffer_current = number_value(buffer_health.get("currentEnergy"))
    buffer_threshold = number_value(buffer_health.get("threshold"))
    if buffer_health.get("healthy") is False or (
        buffer_current is not None and buffer_threshold is not None and buffer_current < buffer_threshold
    ):
        return "energy_buffer_below_threshold"

    if workers and all(creep_free_energy_capacity(worker) <= 0 for worker in workers):
        return "room_capacity_full"

    reservation = as_dict(snapshot.info.get("spawnEnergyReservation"))
    if (number_value(reservation.get("unmetReservedEnergy")) or 0) > 0:
        return "spawn_reserving_energy"

    return "unknown"


def worker_build_assignment_blocked_reason(
    snapshot: RoomSnapshot,
    worker: dict[str, Any],
    metrics: RoomSummaryMetrics,
) -> str:
    task_type = creep_task_type(worker)
    if task_type == "build":
        return "build_assigned"
    if not creep_is_construction_capable(worker):
        return "build_blocked_no_valid_body"
    if len(metrics.construction_sites) <= 0 or metrics.pending_build_progress <= 0:
        return "build_blocked_no_construction_sites"
    if carried_energy(worker) <= 0:
        return "build_blocked_no_carried_energy"

    buffer_health = as_dict(snapshot.info.get("energyBufferHealth"))
    buffer_current = number_value(buffer_health.get("currentEnergy"))
    buffer_threshold = number_value(buffer_health.get("threshold"))
    if buffer_health.get("healthy") is False or (
        buffer_current is not None and buffer_threshold is not None and buffer_current < buffer_threshold
    ):
        return "build_blocked_energy_buffer"
    if task_type == "upgrade":
        return "build_blocked_controller_progress_preferred"
    if task_type:
        return "build_blocked_other_task"
    return "build_blocked_unknown"


def worker_repair_assignment_blocked_reason(worker: dict[str, Any], metrics: RoomSummaryMetrics) -> str:
    task_type = creep_task_type(worker)
    if task_type == "repair":
        return "repair_assigned"
    if not creep_is_construction_capable(worker):
        return "repair_blocked_no_valid_body"
    if carried_energy(worker) <= 0:
        return "repair_blocked_no_carried_energy"
    if metrics.pending_build_progress > 0:
        return "repair_blocked_build_backlog_first"
    if task_type == "upgrade":
        return "repair_blocked_controller_progress_preferred"
    if task_type:
        return "repair_blocked_other_task"
    return "repair_blocked_unknown"


def worker_dispatch_diagnostic_fields(
    creep: dict[str, Any],
    snapshot_tick: int | str | None,
) -> dict[str, Any]:
    diagnostic = as_dict(creep_memory(creep).get("workerDispatchDiagnostic"))
    if not diagnostic:
        return {}

    diagnostic_tick = number_value(diagnostic.get("tick"))
    normalized_snapshot_tick: int | None
    if isinstance(snapshot_tick, int):
        normalized_snapshot_tick = snapshot_tick
    elif isinstance(snapshot_tick, str) and snapshot_tick.isdigit():
        normalized_snapshot_tick = int(snapshot_tick)
    else:
        normalized_snapshot_tick = None

    if (
        normalized_snapshot_tick is not None
        and diagnostic_tick is not None
        and diagnostic_tick != normalized_snapshot_tick
    ):
        return {}

    return {
        **({"dispatchReason": diagnostic.get("reason")} if string_value(diagnostic.get("reason")) else {}),
        **({"dispatchTick": diagnostic_tick} if diagnostic_tick is not None else {}),
        **({"dispatchCurrentTargetId": diagnostic.get("currentTargetId")} if string_value(diagnostic.get("currentTargetId")) else {}),
        **({"dispatchSelectedTask": diagnostic.get("selectedTask")} if string_value(diagnostic.get("selectedTask")) else {}),
        **({"dispatchSelectedTargetId": diagnostic.get("selectedTargetId")} if string_value(diagnostic.get("selectedTargetId")) else {}),
        **({"dispatchBaseSelectedTask": diagnostic.get("baseSelectedTask")} if string_value(diagnostic.get("baseSelectedTask")) else {}),
        **({"dispatchBaseSelectedTargetId": diagnostic.get("baseSelectedTargetId")} if string_value(diagnostic.get("baseSelectedTargetId")) else {}),
        **({"dispatchEnergyCriticalTask": diagnostic.get("energyCriticalTask")} if string_value(diagnostic.get("energyCriticalTask")) else {}),
        **({"dispatchEnergyCriticalTargetId": diagnostic.get("energyCriticalTargetId")} if string_value(diagnostic.get("energyCriticalTargetId")) else {}),
        **({"dispatchSpawnReservationTask": diagnostic.get("spawnReservationTask")} if string_value(diagnostic.get("spawnReservationTask")) else {}),
        **({"dispatchSpawnReservationTargetId": diagnostic.get("spawnReservationTargetId")} if string_value(diagnostic.get("spawnReservationTargetId")) else {}),
        **({"dispatchAssignedTask": diagnostic.get("assignedTask")} if string_value(diagnostic.get("assignedTask")) else {}),
        **({"dispatchAssignedTargetId": diagnostic.get("assignedTargetId")} if string_value(diagnostic.get("assignedTargetId")) else {}),
    }


def worker_assignment_blocked_workers_from_creeps(
    snapshot: RoomSnapshot,
    metrics: RoomSummaryMetrics,
) -> list[dict[str, Any]]:
    workers = [creep for creep in metrics.owned_creep_objects if is_worker_creep(creep)]
    result: list[dict[str, Any]] = []
    for worker in sorted(workers, key=lambda creep: (creep_task_type(creep) or "", creep_name(creep) or "")):
        worker_summary: dict[str, Any] = {
            **({"name": creep_name(worker)} if creep_name(worker) else {}),
            **({"task": creep_task_type(worker)} if creep_task_type(worker) else {}),
            "carriedEnergy": carried_energy(worker),
            "freeCapacity": creep_free_energy_capacity(worker),
            "buildBlockedReason": worker_build_assignment_blocked_reason(snapshot, worker, metrics),
            "repairBlockedReason": worker_repair_assignment_blocked_reason(worker, metrics),
            **worker_dispatch_diagnostic_fields(worker, snapshot.tick),
        }
        result.append(worker_summary)
    return result


def worker_assignment_blocked_fields(snapshot: RoomSnapshot, metrics: RoomSummaryMetrics) -> dict[str, Any]:
    info = snapshot.info if isinstance(snapshot.info, dict) else {}
    detail = explicit_worker_assignment_blocked_detail(info)
    workers = explicit_worker_assignment_blocked_workers(info)
    visible_worker_creeps = [creep for creep in metrics.owned_creep_objects if is_worker_creep(creep)]

    if (
        detail is None
        and visible_worker_creeps
        and metrics.build_blocked_reason == WORKER_ASSIGNMENT_GAP_BLOCKED_REASON
    ):
        detail = worker_assignment_blocked_detail_from_snapshot(
            snapshot,
            visible_worker_creeps,
        )
    if (
        workers is None
        and visible_worker_creeps
        and metrics.build_blocked_reason == WORKER_ASSIGNMENT_GAP_BLOCKED_REASON
    ):
        workers = worker_assignment_blocked_workers_from_creeps(snapshot, metrics)

    result: dict[str, Any] = {}
    if detail is not None:
        result["workerAssignmentBlockedDetail"] = detail
    if workers is not None:
        result["workerAssignmentBlockedWorkers"] = workers
    return result


def build_blocked_reason(
    snapshot: RoomSnapshot,
    pending_build_progress: int | float,
    construction_site_count: int,
    build_carried_energy: int | float,
    assignment_evidence_available: bool,
) -> str | None:
    if construction_site_count <= 0 or pending_build_progress <= 0:
        return "no_construction_sites"
    if build_carried_energy > 0:
        return None

    info = snapshot.info if isinstance(snapshot.info, dict) else {}
    energy_available = first_number_value(info, ("energyAvailable",), ("energy", "available"), ("energy",))
    buffer_health = as_dict(info.get("energyBufferHealth"))
    buffer_current = number_value(buffer_health.get("currentEnergy"))
    buffer_threshold = number_value(buffer_health.get("threshold"))
    if (
        energy_available == 0
        or (
            buffer_health.get("healthy") is False
            and buffer_current is not None
            and buffer_threshold is not None
            and buffer_current < buffer_threshold
        )
    ):
        return "energy_buffer_blocked"
    if not assignment_evidence_available:
        return None
    return "worker_assignment_gap"


def construction_deadlock_ticks(
    snapshot: RoomSnapshot,
    task_counts: dict[str, int],
    construction_site_count: int,
    assignment_evidence_available: bool,
) -> int | float:
    explicit = first_number_value(
        snapshot.info,
        ("constructionDeadlockTicks",),
        ("resources", "productiveEnergy", "constructionDeadlockTicks"),
        ("construction", "constructionDeadlockTicks"),
        ("construction_deadlock_ticks",),
    )
    if explicit is not None:
        return explicit
    if not assignment_evidence_available:
        return 0
    return 1 if task_counts.get("build", 0) == 0 and construction_site_count > 0 else 0


def snapshot_cpu_used(snapshot: RoomSnapshot) -> int | float | None:
    return first_number_value(
        snapshot.info,
        ("cpu", "used"),
        ("cpu", "cpuUsed"),
        ("cpuUsed",),
        ("usedCpu",),
    )


def snapshot_cpu_bucket(snapshot: RoomSnapshot) -> int | float | None:
    return first_number_value(
        snapshot.info,
        ("cpu", "bucket"),
        ("cpuBucket",),
        ("bucket",),
    )


def compute_room_summary_metrics(snapshot: RoomSnapshot) -> RoomSummaryMetrics:
    structures = structure_objects(snapshot.objects)
    controller = next((obj for obj in structures if obj.get("type") == "controller"), None)
    owned_creep_objects = [
        obj
        for obj in snapshot.objects.values()
        if (
            isinstance(obj, dict)
            and obj.get("type") == "creep"
            and is_owned_object(obj, snapshot.owner, snapshot.expected_owner_id)
        )
    ]
    construction_sites = owned_construction_sites(snapshot)
    extension_construction_sites = [
        site for site in construction_sites if construction_site_matches_structure_type(site, "extension")
    ]
    task_counts = worker_task_counts(owned_creep_objects)
    info = snapshot.info if isinstance(snapshot.info, dict) else {}
    assignment_evidence_available = worker_assignment_evidence_available(
        owned_creep_objects,
        explicit_worker_assignment_blocked_workers(info),
        explicit_worker_assignment_blocked_detail(info),
    )
    pending_build_progress = sum(construction_site_pending_progress(site) for site in construction_sites)
    extension_pending_build_progress = sum(
        construction_site_pending_progress(site) for site in extension_construction_sites
    )
    build_carried_energy = sum(carried_energy(creep) for creep in owned_creep_objects if creep_has_build_task(creep))
    extension_count, extension_capacity_contribution = room_extension_metrics(structures, snapshot.owner)
    stored_energy = room_stored_energy(snapshot.objects, snapshot.owner)
    controller_summary: dict[str, Any] = {}
    if controller is not None:
        for key in ("level", "progress", "progressTotal", "ticksToDowngrade"):
            controller_summary[key] = number_value(controller.get(key))
        controller_summary["sign"] = controller_sign_summary(controller)

    return RoomSummaryMetrics(
        structures=structures,
        controller_summary=controller_summary,
        owned_creep_objects=owned_creep_objects,
        task_counts=task_counts,
        worker_assignment_evidence_available=assignment_evidence_available,
        construction_sites=construction_sites,
        pending_build_progress=pending_build_progress,
        build_carried_energy=build_carried_energy,
        build_blocked_reason=build_blocked_reason(
            snapshot,
            pending_build_progress,
            len(construction_sites),
            build_carried_energy,
            assignment_evidence_available,
        ),
        construction_deadlock_ticks=construction_deadlock_ticks(
            snapshot,
            task_counts,
            len(construction_sites),
            assignment_evidence_available,
        ),
        extension_count=extension_count,
        extension_capacity_contribution=extension_capacity_contribution,
        extension_construction_site_count=len(extension_construction_sites),
        extension_pending_build_progress=extension_pending_build_progress,
        stored_energy=stored_energy,
        cpu_used=snapshot_cpu_used(snapshot),
        cpu_bucket=snapshot_cpu_bucket(snapshot),
        rcl_level=number_value(controller.get("level")) if controller is not None else None,
    )


def controller_sign_summary(controller: dict[str, Any]) -> dict[str, Any] | None:
    sign = controller.get("sign")
    if not isinstance(sign, dict):
        return None

    summary: dict[str, Any] = {
        "text": sign.get("text") if isinstance(sign.get("text"), str) else None,
    }
    username = sign.get("username")
    if isinstance(username, str):
        summary["username"] = username
    user = sign.get("user")
    if isinstance(user, str):
        summary["user"] = user
    time_value = number_value(sign.get("time"))
    if time_value is not None:
        summary["time"] = time_value
    datetime_value = sign.get("datetime")
    if isinstance(datetime_value, str):
        summary["datetime"] = datetime_value
    return summary


def confirmed_foreign_owner(obj: dict[str, Any], owner_username: str | None) -> bool:
    username = room_owner(obj)
    return bool(username is not None and username != owner_username)


def runtime_summary_room(snapshot: RoomSnapshot) -> dict[str, Any]:
    objects = snapshot.objects
    metrics = compute_room_summary_metrics(snapshot)
    owned_creeps = metrics.owned_creep_objects
    sources = [obj for obj in objects.values() if isinstance(obj, dict) and obj.get("type") == "source"]
    dropped_energy = [
        obj
        for obj in objects.values()
        if isinstance(obj, dict)
        and obj.get("type") == "resource"
        and obj.get("resourceType") == "energy"
        and number_value(obj.get("amount")) is not None
    ]
    hostiles = detect_hostile_creeps(objects, snapshot.owner)
    hostile_structures = [
        obj
        for obj in metrics.structures
        if confirmed_foreign_owner(obj, snapshot.owner)
    ]
    behavior_totals = behavior_pathing_totals(snapshot.info)
    assignment_blocked_fields = worker_assignment_blocked_fields(snapshot, metrics)
    worker_carried_energy = sum(store_energy(obj) for obj in owned_creeps)
    productive_energy = {
        "pendingBuildProgress": metrics.pending_build_progress,
        "buildCarriedEnergy": metrics.build_carried_energy,
        "constructionDeadlockTicks": metrics.construction_deadlock_ticks,
        "constructionSiteCount": len(metrics.construction_sites),
        "extensionConstructionSiteCount": metrics.extension_construction_site_count,
        "extensionPendingBuildProgress": metrics.extension_pending_build_progress,
        "workerAssignmentEvidenceAvailable": metrics.worker_assignment_evidence_available,
        "buildBlockedReason": metrics.build_blocked_reason,
        **assignment_blocked_fields,
    }

    summary = {
        "roomName": snapshot.ref.room,
        "shard": snapshot.ref.shard,
        "taskCounts": metrics.task_counts,
        "workerAssignmentEvidenceAvailable": metrics.worker_assignment_evidence_available,
        "pendingBuildProgress": metrics.pending_build_progress,
        "buildCarriedEnergy": metrics.build_carried_energy,
        "constructionDeadlockTicks": metrics.construction_deadlock_ticks,
        "buildBlockedReason": metrics.build_blocked_reason,
        **assignment_blocked_fields,
        "constructionSiteCount": len(metrics.construction_sites),
        "extensionConstructionSiteCount": metrics.extension_construction_site_count,
        "extensionPendingBuildProgress": metrics.extension_pending_build_progress,
        "extensionCount": metrics.extension_count,
        "extensionCapacityContribution": metrics.extension_capacity_contribution,
        "cpuUsed": metrics.cpu_used,
        "cpuBucket": metrics.cpu_bucket,
        "rclLevel": metrics.rcl_level,
        "storedEnergy": metrics.stored_energy,
        "workerCarriedEnergy": worker_carried_energy,
        "controller": metrics.controller_summary,
        "structures": {
            "extensionCount": metrics.extension_count,
            "extensionCapacityContribution": metrics.extension_capacity_contribution,
        },
        "resources": {
            "storedEnergy": metrics.stored_energy,
            "workerCarriedEnergy": worker_carried_energy,
            "droppedEnergy": sum(number_value(obj.get("amount")) or 0 for obj in dropped_energy),
            "sourceCount": len(sources),
            "productiveEnergy": productive_energy,
        },
        "workerLoadEfficiency": worker_load_efficiency(owned_creeps),
        "combat": {
            "hostileCreepCount": len(hostiles),
            "hostileStructureCount": len(hostile_structures),
        },
    }
    if metrics.build_blocked_reason is None:
        summary.pop("buildBlockedReason", None)
        as_dict(as_dict(summary.get("resources")).get("productiveEnergy")).pop("buildBlockedReason", None)
    if behavior_totals:
        summary["behavior"] = {"totals": behavior_totals}
    return summary


def runtime_summary_payload_from_snapshots(snapshots: list[RoomSnapshot]) -> dict[str, Any]:
    ticks = [snapshot.tick for snapshot in snapshots if isinstance(snapshot.tick, int)]
    cpu_used = next((value for value in (snapshot_cpu_used(snapshot) for snapshot in snapshots) if value is not None), None)
    cpu_bucket = next((value for value in (snapshot_cpu_bucket(snapshot) for snapshot in snapshots) if value is not None), None)
    return {
        "type": "runtime-summary",
        "tick": max(ticks) if ticks else None,
        "rooms": [runtime_summary_room(snapshot) for snapshot in snapshots],
        "cpu": {"used": cpu_used, "bucket": cpu_bucket},
        "source": MONITOR_RUNTIME_SUMMARY_SOURCE,
    }


def runtime_summary_artifact_line(snapshots: list[RoomSnapshot]) -> str:
    payload = runtime_summary_payload_from_snapshots(snapshots)
    return "#runtime-summary " + json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n"


def runtime_summary_artifact_name(now: datetime | None = None) -> str:
    timestamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return f"runtime-summary-monitor-{timestamp.strftime('%Y%m%dT%H%M%SZ')}.log"


def iter_path_candidates(path: Path) -> Iterable[Path]:
    yield path
    for index in range(2, 1000):
        yield path.with_name(f"{path.stem}-{index}{path.suffix}")


def unique_path(path: Path) -> Path:
    for candidate in iter_path_candidates(path):
        if not candidate.exists():
            return candidate
    raise FileExistsError(f"could not choose a unique artifact path for {path}")


def link_artifact_exclusively(temp_path: Path, path: Path) -> Path:
    for candidate in iter_path_candidates(path):
        try:
            os.link(temp_path, candidate)
            return candidate
        except FileExistsError:
            continue
    raise FileExistsError(f"could not choose a unique artifact path for {path}")


def write_runtime_summary_artifact(snapshots: list[RoomSnapshot], out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / runtime_summary_artifact_name()
    payload = runtime_summary_artifact_line(snapshots)
    temp_fd: int | None = None
    temp_path: Path | None = None
    try:
        temp_fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=str(out_dir))
        temp_path = Path(temp_name)
        with os.fdopen(temp_fd, "w", encoding="utf-8") as handle:
            temp_fd = None
            handle.write(payload)
        linked_path = link_artifact_exclusively(temp_path, target)
        return linked_path.resolve()
    finally:
        if temp_fd is not None:
            try:
                os.close(temp_fd)
            except OSError:
                pass
        if temp_path is not None:
            try:
                temp_path.unlink()
            except FileNotFoundError:
                pass


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


def load_json_file(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise RuntimeError(f"expected object JSON in {path}")
    return value


def resolve_owned_count(room_summary_payload: dict[str, Any], owned_key: str, fallback_key: str) -> Any:
    owned_value = room_summary_payload.get(owned_key)
    if isinstance(owned_value, (int, float)):
        return owned_value
    return room_summary_payload.get(fallback_key)


def threshold_exceeds_capacity_reason(room: dict[str, Any]) -> dict[str, Any] | None:
    buffer_health = as_dict(room.get("energyBufferHealth"))
    threshold = number_value(buffer_health.get("threshold"))
    capacity = number_value(room.get("energyCapacity"))
    if capacity is None:
        capacity = number_value(room.get("energyCapacityAvailable"))
    if threshold is None or capacity is None or threshold <= capacity:
        return None

    room_name = room.get("room") or room.get("roomName") or room.get("name")
    return {
        "kind": "threshold_exceeds_capacity",
        "room": room_name,
        "threshold": threshold,
        "energyCapacity": capacity,
        "message": f"{room_name}: energyBufferHealth.threshold {threshold} exceeds energyCapacity {capacity}",
    }


def runtime_summary_room_ref(room: dict[str, Any]) -> RoomRef:
    room_ref = room.get("room")
    if isinstance(room_ref, str) and "/" in room_ref:
        shard, room_name = room_ref.split("/", 1)
        if shard and room_name:
            return RoomRef(shard=shard, room=room_name)

    room_name = runtime_summary_room_name(room)
    shard = runtime_summary_room_shard(room)
    return RoomRef(shard=shard or "unknown", room=room_name or str(room_ref or "unknown"))


def runtime_summary_lookup_keys(room: dict[str, Any]) -> list[str]:
    keys: list[str] = []
    room_ref = room.get("room")
    if isinstance(room_ref, str) and room_ref:
        keys.append(room_ref)

    room_name = runtime_summary_room_name(room)
    shard = runtime_summary_room_shard(room)
    if shard and room_name:
        keys.append(f"{shard}/{room_name}")
    if room_name:
        keys.append(room_name)

    return list(dict.fromkeys(keys))


def load_runtime_summary_artifact_rooms(artifact_path: str) -> dict[str, dict[str, Any]]:
    try:
        lines = Path(artifact_path).read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}

    result: dict[str, dict[str, Any]] = {}
    for line in reversed(lines):
        payload = parse_runtime_summary_line(line)
        if payload is None:
            continue
        for room in payload_runtime_rooms(payload):
            if not runtime_summary_room_has_monitor_alert_fields(room, payload):
                continue
            runtime_room = runtime_summary_room_with_metadata(payload, Path(artifact_path), room)
            for key in runtime_summary_lookup_keys(room):
                result.setdefault(key, runtime_room)
        if result:
            return result

    return result


def enrich_room_summaries_from_runtime_artifact(room_summaries: list[Any], artifact_path: str) -> None:
    runtime_rooms = load_runtime_summary_artifact_rooms(artifact_path)
    if not runtime_rooms:
        return

    for room in room_summaries:
        if not isinstance(room, dict):
            continue
        runtime_room = next((runtime_rooms[key] for key in runtime_summary_lookup_keys(room) if key in runtime_rooms), None)
        if runtime_room is None:
            continue

        if number_value(room.get("energyCapacity")) is None:
            capacity = number_value(runtime_room.get("energyCapacity"))
            if capacity is not None:
                room["energyCapacity"] = capacity
        if number_value(room.get("energyCapacityAvailable")) is None:
            capacity_available = number_value(runtime_room.get("energyCapacityAvailable"))
            if capacity_available is not None:
                room["energyCapacityAvailable"] = capacity_available
        if not as_dict(room.get("energyBufferHealth")):
            buffer_health = as_dict(runtime_room.get("energyBufferHealth"))
            if buffer_health:
                room["energyBufferHealth"] = buffer_health
        if runtime_summary_room_has_cpu_fields(runtime_room) or as_dict(runtime_room.get(RUNTIME_SUMMARY_CPU_METADATA_KEY)):
            room.update(runtime_summary_room_with_cpu_fields(room, runtime_room))


def evaluate_postdeploy_health_gate(summary_payload: dict[str, Any], alert_payload: dict[str, Any]) -> dict[str, Any]:
    reasons: list[dict[str, Any]] = []
    if summary_payload.get("ok") is not True:
        reasons.append({"kind": "postdeploy_summary_failed", "message": "post-deploy summary did not report ok=true"})
    if alert_payload.get("ok") is not True:
        reasons.append({"kind": "postdeploy_alert_failed", "message": "post-deploy alert did not report ok=true"})
    if alert_payload.get("alert") is True:
        for reason in alert_payload.get("reasons") if isinstance(alert_payload.get("reasons"), list) else []:
            if isinstance(reason, dict):
                reasons.append({"kind": "postdeploy_active_alert", "message": reason.get("message", "runtime alert active"), "source": reason})

    room_summaries = summary_payload.get("room_summaries")
    artifact_path = summary_payload.get("runtime_summary_artifact")
    if isinstance(room_summaries, list) and isinstance(artifact_path, str):
        enrich_room_summaries_from_runtime_artifact(room_summaries, artifact_path)
    if not isinstance(room_summaries, list) or not room_summaries:
        reasons.append({"kind": "postdeploy_no_room_summary", "message": "post-deploy summary has no room_summaries"})
    else:
        for room in room_summaries:
            if not isinstance(room, dict):
                continue
            creeps = resolve_owned_count(room, "owned_creeps", "creeps")
            structures = room.get("structures")
            spawns = resolve_owned_count(room, "owned_spawns", "spawns")
            owner = room.get("owner")
            room_name = room.get("room")
            owner_missing = owner is None or owner == ""
            threshold_reason = threshold_exceeds_capacity_reason(room)
            if threshold_reason is not None:
                reasons.append(threshold_reason)
            cpu_reason = detect_cpu_bucket_reason(runtime_summary_room_ref(room), room)
            if cpu_reason is not None:
                reasons.append(cpu_reason)
            if owner_missing:
                creeps = 0
                spawns = 0
            if owner_missing and (not isinstance(spawns, (int, float)) or spawns <= 0):
                reasons.append(
                    {
                        "kind": "postdeploy_owner_missing",
                        "room": room_name,
                        "message": f"{room_name}: owner missing and no spawn recovery is visible",
                    }
                )
            if (
                not owner_missing
                and isinstance(creeps, (int, float))
                and creeps <= 0
                and (not isinstance(spawns, (int, float)) or spawns <= 0)
            ):
                reasons.append(
                    {
                        "kind": "postdeploy_no_owned_spawn",
                        "room": room_name,
                        "message": f"{room_name}: no owned spawn recovery path is visible after deploy",
                    }
                )
            if (
                isinstance(creeps, (int, float))
                and creeps <= 0
                and (not isinstance(spawns, (int, float)) or spawns <= 0)
            ):
                reasons.append(
                    {
                        "kind": "postdeploy_room_dead",
                        "room": room_name,
                        "creeps": creeps,
                        "structures": structures,
                        "spawns": spawns,
                        "owner": owner,
                        "message": f"{room_name}: no creeps, no spawn, and <=1 visible structure after deploy",
                    }
                )
    return {"ok": not reasons, "reasons": reasons}


def command_health_gate(args: argparse.Namespace) -> int:
    summary_payload = load_json_file(args.summary)
    alert_payload = load_json_file(args.alert)
    result = evaluate_postdeploy_health_gate(summary_payload, alert_payload)
    print_json(result, [os.environ.get("SCREEPS_AUTH_TOKEN", "")])
    return 0 if result["ok"] else 1


def command_summary(args: argparse.Namespace) -> int:
    ctx = context_from_env(args.world_profile)
    snapshots, warnings, _overview_refs = collect_snapshots(ctx, args.room)
    images: list[str] = []
    room_summaries: list[dict[str, Any]] = []
    out_dir = Path(args.out_dir)
    for snapshot in snapshots:
        image: str | None = None
        try:
            image = str(render_room_snapshot(snapshot, out_dir, "summary"))
            images.append(image)
        except Exception as exc:  # noqa: BLE001 - JSON summary evidence must survive renderer outages
            warnings.append(f"summary image render failed for {snapshot.ref.key}: {short_text(redact_secrets(str(exc), [ctx.token]), 180)}")
        room_summaries.append(room_summary(snapshot, image=image))

    runtime_summary_artifact: str | None = None
    if not args.no_runtime_summary_artifact:
        try:
            runtime_summary_artifact = str(write_runtime_summary_artifact(snapshots, Path(args.runtime_summary_out_dir)))
        except Exception as exc:  # noqa: BLE001 - keep image delivery alive; report sanitized warning
            warnings.append(f"runtime-summary artifact unavailable: {short_text(exc, 160)}")

    payload = {
        "ok": True,
        "mode": "summary",
        "summary": summarize_rooms(snapshots),
        "images": images,
        "rooms": [snapshot.ref.key for snapshot in snapshots],
        "room_summaries": room_summaries,
        "runtime_summary_artifact": runtime_summary_artifact,
        "warnings": warnings,
    }
    print_json(payload, [ctx.token])
    return 0


def command_alert(args: argparse.Namespace) -> int:
    ctx = context_from_env(args.world_profile)
    snapshots, warnings, overview_refs = collect_snapshots(ctx, args.room)
    runtime_room_summaries = load_latest_runtime_room_summaries(
        Path(args.runtime_summary_dir).expanduser(),
        [snapshot.ref for snapshot in snapshots],
        warnings,
        disambiguation_refs=overview_refs,
    )
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
            runtime_room_summary=runtime_room_summaries.get(snapshot.ref.key),
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
                try:
                    images.append(str(render_room_snapshot(snapshot, out_dir, "alert", reasons)))
                except Exception as exc:  # noqa: BLE001 - alert JSON is still authoritative evidence
                    warnings.append(f"alert image render failed for {snapshot.ref.key}: {short_text(redact_secrets(str(exc), [ctx.token]), 180)}")
    elif args.force_alert_image:
        for snapshot in snapshots:
            try:
                images.append(str(render_room_snapshot(snapshot, out_dir, "alert", [])))
            except Exception as exc:  # noqa: BLE001 - alert JSON is still authoritative evidence
                warnings.append(f"alert image render failed for {snapshot.ref.key}: {short_text(redact_secrets(str(exc), [ctx.token]), 180)}")

    payload = {
        "ok": True,
        "mode": "alert",
        "alert": bool(all_emitted),
        "reasons": all_emitted,
        "images": images,
        "rooms": [snapshot.ref.key for snapshot in snapshots],
        "summary": summarize_rooms(snapshots),
        "room_summaries": [room_summary(snapshot) for snapshot in snapshots],
        "state_file": str(ctx.state_file),
        "debounce_seconds": ctx.debounce_seconds,
        "suppressed": bool(all_suppressed),
        "suppressed_count": len(all_suppressed),
        "suppressed_reasons": all_suppressed,
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


def apply_world_profile_defaults(args: argparse.Namespace) -> argparse.Namespace:
    if not hasattr(args, "world_profile"):
        return args

    profile = world_profiles.resolve_world_profile(getattr(args, "world_profile", None), os.environ)
    args.world_profile = profile.name
    if hasattr(args, "out_dir") and getattr(args, "out_dir") is None:
        args.out_dir = str(profile.monitor_out_dir)
    if hasattr(args, "runtime_summary_out_dir") and getattr(args, "runtime_summary_out_dir") is None:
        args.runtime_summary_out_dir = str(profile.runtime_summary_out_dir)
    if hasattr(args, "runtime_summary_dir") and getattr(args, "runtime_summary_dir") is None:
        args.runtime_summary_dir = env_default("SCREEPS_RUNTIME_SUMMARY_DIR", str(profile.runtime_summary_out_dir))
    return args


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
    parser = WorldProfileArgumentParser(description="Render Screeps runtime summary and alert monitor images.")
    subcommands = parser.add_subparsers(dest="command", required=True)

    def add_live_options(subparser: argparse.ArgumentParser) -> None:
        world_profiles.add_world_profile_argument(subparser)
        subparser.add_argument("--out-dir", default=None, help=f"artifact directory (default: {DEFAULT_OUT_DIR})")
        subparser.add_argument("--room", help="optional single room selector, preferably shard/room")
        subparser.add_argument("--format", choices=["json"], default="json", help="output format")

    summary = subcommands.add_parser("summary", help="render summary PNGs for owned rooms")
    add_live_options(summary)
    summary.add_argument(
        "--runtime-summary-out-dir",
        default=None,
        help="Directory for reducer-compatible #runtime-summary artifacts written from the same live room snapshot.",
    )
    summary.add_argument(
        "--no-runtime-summary-artifact",
        action="store_true",
        help="Do not write a reducer-compatible #runtime-summary artifact while rendering summary images.",
    )
    summary.set_defaults(func=command_summary)

    alert = subcommands.add_parser("alert", help="evaluate alert rules and render alert PNGs when needed")
    add_live_options(alert)
    alert.add_argument("--force-alert-image", action="store_true", help="render alert-style image even when no alert is emitted")
    alert.add_argument(
        "--runtime-summary-dir",
        default=None,
        help="Directory containing persisted #runtime-summary console .log artifacts for semantic alert rules.",
    )
    alert.set_defaults(func=command_alert)

    health_gate = subcommands.add_parser("health-gate", help="fail when post-deploy summary/alert evidence violates survival invariants")
    health_gate.add_argument("--summary", required=True, help="summary JSON path produced by the summary command")
    health_gate.add_argument("--alert", required=True, help="alert JSON path produced by the alert command")
    health_gate.set_defaults(func=command_health_gate)

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
            self.assertIn("critical_structure_missing", [reason["kind"] for reason in emitted])

        def test_room_loss_alert_preserves_healthy_baseline(self) -> None:
            previous = {
                "baseline_established": True,
                "owner": "owner",
                "owned_creeps": 3,
                "owned_spawns": 1,
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
            snapshot = RoomSnapshot(
                ref=RoomRef("shardTest", "E1N1"),
                terrain="0" * TERRAIN_CELLS,
                objects=normalize_objects(
                    {
                        "ctrl": {"type": "controller", "x": 5, "y": 36, "level": 3},
                        "site": {"type": "constructionSite", "structureType": "extension", "x": 6, "y": 36},
                    }
                ),
                tick=2,
                owner=None,
                info={},
                expected_owner="owner",
            )

            emitted, _suppressed, next_state = evaluate_room_alert(snapshot, previous, now=100, debounce_seconds=300)

            self.assertIn("room_ownership_lost", [reason["kind"] for reason in emitted])
            self.assertIn("spawn_collapse", [reason["kind"] for reason in emitted])
            self.assertEqual(next_state["owner"], "owner")
            self.assertIn("spawn1", next_state["structures"])

        def test_expected_owner_does_not_mask_observed_owner_loss(self) -> None:
            snapshot = RoomSnapshot(
                ref=RoomRef("shardTest", "E1N1"),
                terrain="0" * TERRAIN_CELLS,
                objects=normalize_objects({"ctrl": {"type": "controller", "x": 5, "y": 36, "level": 3}}),
                tick=2,
                owner=None,
                info={},
                expected_owner="owner",
            )

            emitted, _suppressed, _next_state = evaluate_room_alert(snapshot, {}, now=100, debounce_seconds=300)

            self.assertIn("room_ownership_lost", [reason["kind"] for reason in emitted])

        def test_dead_room_alerts_even_after_baseline_was_already_cleared(self) -> None:
            previous = {
                "baseline_established": True,
                "owner": None,
                "structures": {},
                "owned_creeps": 0,
                "owned_spawns": 0,
            }
            snapshot = RoomSnapshot(
                ref=RoomRef("shardTest", "E1N1"),
                terrain="0" * TERRAIN_CELLS,
                objects=normalize_objects({"ctrl": {"type": "controller", "x": 5, "y": 36, "level": 3}}),
                tick=3,
                owner=None,
                info={},
            )

            emitted, _suppressed, _next_state = evaluate_room_alert(snapshot, previous, now=100, debounce_seconds=300)

            self.assertIn("room_dead", [reason["kind"] for reason in emitted])

        def test_dead_room_alerts_when_cleared_baseline_has_no_survival_counts(self) -> None:
            previous = {"baseline_established": True, "owner": None, "structures": {}}
            snapshot = RoomSnapshot(
                ref=RoomRef("shardTest", "E1N1"),
                terrain="0" * TERRAIN_CELLS,
                objects=normalize_objects({"ctrl": {"type": "controller", "x": 5, "y": 36, "level": 3}}),
                tick=3,
                owner=None,
                info={},
            )

            emitted, _suppressed, _next_state = evaluate_room_alert(snapshot, previous, now=100, debounce_seconds=300)

            self.assertIn("room_dead", [reason["kind"] for reason in emitted])

        def test_room_dead_bypasses_debounce(self) -> None:
            signature = "room_dead:shardTest/E1N1"
            previous = {
                "baseline_established": True,
                "owner": None,
                "structures": {},
                "owned_creeps": 0,
                "owned_spawns": 0,
                "alerts": {signature: 90},
            }
            snapshot = RoomSnapshot(
                ref=RoomRef("shardTest", "E1N1"),
                terrain="0" * TERRAIN_CELLS,
                objects=normalize_objects({"ctrl": {"type": "controller", "x": 5, "y": 36, "level": 3}}),
                tick=3,
                owner=None,
                info={},
            )

            emitted, suppressed, _next_state = evaluate_room_alert(snapshot, previous, now=100, debounce_seconds=300)

            self.assertIn("room_dead", [reason["kind"] for reason in emitted])
            self.assertEqual(suppressed, [])

        def test_debounce_suppresses_identical_alert(self) -> None:
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
                    },
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

        def test_extension_count_zero_at_rcl_ge_2_alerts_as_p0(self) -> None:
            snapshot = RoomSnapshot(
                ref=RoomRef("shardTest", "E1N1"),
                terrain="0" * TERRAIN_CELLS,
                objects=normalize_objects(
                    {
                        "spawn1": {
                            "type": "spawn",
                            "my": True,
                            "owner": {"username": "owner"},
                            "x": 25,
                            "y": 25,
                            "hits": 5000,
                            "hitsMax": 5000,
                        },
                        "ctrl": {
                            "type": "controller",
                            "my": True,
                            "owner": {"username": "owner"},
                            "level": 2,
                            "x": 5,
                            "y": 36,
                        },
                    }
                ),
                tick=10,
                owner="owner",
                info={},
            )

            emitted, _suppressed, _next_state = evaluate_room_alert(
                snapshot,
                {"baseline_established": True, "owner": "owner"},
                now=100,
                debounce_seconds=300,
            )

            extension_reason = next(reason for reason in emitted if reason["kind"] == EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND)
            self.assertEqual(extension_reason["severity"], "critical")
            self.assertEqual(extension_reason["priority"], "P0")
            self.assertEqual(extension_reason["bootstrapState"], "missing_extension_site")
            report = build_tactical_response_report({"ok": True, "mode": "alert", "alert": True, "reasons": [extension_reason]})
            self.assertEqual(report["severity"], "critical")
            self.assertEqual(report["priority"], "P0")
            self.assertEqual(report["categories"], [EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND])

        def test_extension_count_zero_with_active_extension_site_tracks_bootstrap_progress(self) -> None:
            base_objects = {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "ctrl": {
                    "type": "controller",
                    "my": True,
                    "owner": {"username": "owner"},
                    "level": 2,
                    "x": 5,
                    "y": 36,
                },
                "site1": {
                    "type": "constructionSite",
                    "my": True,
                    "owner": {"username": "owner"},
                    "structureType": "extension",
                    "progress": 100,
                    "progressTotal": 3000,
                    "x": 24,
                    "y": 24,
                },
            }
            first_snapshot = RoomSnapshot(
                ref=RoomRef("shardTest", "E1N1"),
                terrain="0" * TERRAIN_CELLS,
                objects=normalize_objects(base_objects),
                tick=1000,
                owner="owner",
                info={},
            )
            second_snapshot = RoomSnapshot(
                ref=RoomRef("shardTest", "E1N1"),
                terrain="0" * TERRAIN_CELLS,
                objects=normalize_objects(base_objects),
                tick=1100,
                owner="owner",
                info={},
            )

            first_emitted, first_suppressed, first_state = evaluate_room_alert(
                first_snapshot,
                {"baseline_established": True, "owner": "owner"},
                now=100,
                debounce_seconds=300,
            )
            self.assertEqual(first_emitted, [])
            self.assertEqual(first_suppressed, [])
            self.assertEqual(
                first_state["rule_counts"][EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND]["extension_pending_build_progress"],
                2900,
            )

            second_emitted, second_suppressed, second_state = evaluate_room_alert(
                second_snapshot,
                first_state,
                now=200,
                debounce_seconds=300,
            )
            self.assertEqual(second_suppressed, [])
            extension_reason = next(reason for reason in second_emitted if reason["kind"] == EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND)
            self.assertEqual(extension_reason["bootstrapState"], "extension_bootstrap_stalled")
            self.assertEqual(extension_reason["stalledTicks"], EXTENSION_BOOTSTRAP_PROGRESS_STALL_TICKS)
            self.assertEqual(
                second_state["rule_counts"][EXTENSION_COUNT_ZERO_AT_RCL_GE_2_KIND]["stalled_ticks"],
                EXTENSION_BOOTSTRAP_PROGRESS_STALL_TICKS,
            )

        def test_worker_assignment_gap_sustained_alerts_after_100_ticks(self) -> None:
            base_objects = {
                "spawn1": {
                    "type": "spawn",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 25,
                    "y": 25,
                    "hits": 5000,
                    "hitsMax": 5000,
                },
                "ctrl": {
                    "type": "controller",
                    "my": True,
                    "owner": {"username": "owner"},
                    "level": 2,
                    "x": 5,
                    "y": 36,
                },
                "extension1": {
                    "type": "extension",
                    "my": True,
                    "owner": {"username": "owner"},
                    "x": 26,
                    "y": 25,
                    "hits": 1000,
                    "hitsMax": 1000,
                },
                "worker1": {
                    "type": "creep",
                    "my": True,
                    "owner": {"username": "owner"},
                    "name": "worker1",
                    "x": 23,
                    "y": 25,
                    "carry": {"energy": 0},
                    "memory": {"role": "worker"},
                },
                "site1": {
                    "type": "constructionSite",
                    "my": True,
                    "owner": {"username": "owner"},
                    "structureType": "extension",
                    "progress": 0,
                    "progressTotal": 50,
                    "x": 27,
                    "y": 25,
                },
            }
            first_snapshot = RoomSnapshot(
                ref=RoomRef("shardTest", "E1N1"),
                terrain="0" * TERRAIN_CELLS,
                objects=normalize_objects(base_objects),
                tick=1000,
                owner="owner",
                info={"energyAvailable": 300},
            )
            second_snapshot = RoomSnapshot(
                ref=RoomRef("shardTest", "E1N1"),
                terrain="0" * TERRAIN_CELLS,
                objects=normalize_objects(base_objects),
                tick=1101,
                owner="owner",
                info={"energyAvailable": 300},
            )

            first_emitted, first_suppressed, first_state = evaluate_room_alert(
                first_snapshot,
                {"baseline_established": True, "owner": "owner"},
                now=100,
                debounce_seconds=300,
            )
            self.assertEqual(first_emitted, [])
            self.assertEqual(first_suppressed, [])
            self.assertEqual(first_state["rule_counts"][WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND]["consecutive_ticks"], 0)

            second_emitted, second_suppressed, second_state = evaluate_room_alert(
                second_snapshot,
                first_state,
                now=200,
                debounce_seconds=300,
            )
            self.assertEqual(second_suppressed, [])
            gap_reason = next(reason for reason in second_emitted if reason["kind"] == WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND)
            self.assertEqual(gap_reason["priority"], "P0")
            self.assertEqual(gap_reason["consecutive_ticks"], 101)
            self.assertEqual(second_state["rule_counts"][WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND]["consecutive_ticks"], 101)
            report = build_tactical_response_report({"ok": True, "mode": "alert", "alert": True, "reasons": [gap_reason]})
            self.assertEqual(report["severity"], "critical")
            self.assertEqual(report["categories"], [WORKER_ASSIGNMENT_GAP_SUSTAINED_KIND])

        def test_construction_deadlock_ticks_alerts_and_escalates(self) -> None:
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
                    },
                    "site1": {
                        "type": "constructionSite",
                        "my": True,
                        "owner": {"username": "owner"},
                        "structureType": "extension",
                        "progress": 0,
                        "progressTotal": 50,
                    },
                }
            )
            runtime_room = {
                "roomName": "E1N1",
                "taskCounts": {"harvest": 1, "upgrade": 1, "build": 0, "transfer": 0},
                "constructionSiteCount": 1,
                "pendingBuildProgress": 50,
                "buildCarriedEnergy": 0,
                "constructionDeadlockTicks": CONSTRUCTION_DEADLOCK_P0_TICKS,
            }

            emitted, suppressed, _next_state = evaluate_room_alert(
                snapshot,
                {"baseline_established": True, "owner": "owner"},
                now=100,
                debounce_seconds=300,
                runtime_room_summary=runtime_room,
            )

            self.assertEqual(suppressed, [])
            reason = next(reason for reason in emitted if reason["kind"] == CONSTRUCTION_DEADLOCK_KIND)
            self.assertEqual(reason["priority"], "P0")
            self.assertEqual(reason["severity"], "critical")
            report = build_tactical_response_report({"ok": True, "mode": "alert", "alert": True, "reasons": [reason]})
            self.assertEqual(report["severity"], "critical")
            self.assertEqual(report["categories"], [CONSTRUCTION_DEADLOCK_KIND])

        def test_worker_idle_collapse_alerts_on_second_consecutive_detection(self) -> None:
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
                    },
                    "worker-1": {
                        "type": "creep",
                        "my": True,
                        "owner": {"username": "owner"},
                        "name": "worker-1",
                        "x": 23,
                        "y": 25,
                    },
                    "worker-2": {
                        "type": "creep",
                        "my": True,
                        "owner": {"username": "owner"},
                        "name": "worker-2",
                        "x": 24,
                        "y": 25,
                    },
                }
            )
            runtime_room = {
                "roomName": "E1N1",
                "energyAvailable": 250,
                "energyCapacity": 300,
                "energyBufferHealth": {"currentEnergy": 250, "threshold": 300, "healthy": False},
                "workerCount": 2,
                "spawnStatus": [{"name": "Spawn1", "status": "idle"}],
                "taskCounts": {"harvest": 0, "upgrade": 0, "transfer": 0, "build": 1, "repair": 0, "none": 2},
                "behavior": {
                    "creeps": [
                        {"creepName": "worker-1", "idleTicks": 25, "stuckTicks": 0},
                        {"creepName": "worker-2", "idleTicks": 25, "stuckTicks": 0},
                    ]
                },
            }
            previous = {
                "baseline_established": True,
                "owner": "owner",
                "owned_creeps": 2,
                "owned_spawns": 1,
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

            first_emitted, first_suppressed, first_state = evaluate_room_alert(
                snapshot,
                previous,
                now=100,
                debounce_seconds=300,
                runtime_room_summary=runtime_room,
            )
            self.assertEqual(first_emitted, [])
            self.assertEqual(first_suppressed, [])
            self.assertEqual(first_state["rule_counts"][WORKER_IDLE_COLLAPSE_KIND], 1)

            second_emitted, second_suppressed, second_state = evaluate_room_alert(
                snapshot,
                first_state,
                now=200,
                debounce_seconds=300,
                runtime_room_summary=runtime_room,
            )
            self.assertEqual([reason["kind"] for reason in second_emitted], [WORKER_IDLE_COLLAPSE_KIND])
            self.assertEqual(second_suppressed, [])
            self.assertEqual(second_state["rule_counts"][WORKER_IDLE_COLLAPSE_KIND], 2)
            self.assertEqual(second_emitted[0]["severity"], "high")
            self.assertIn("worker_idle_collapse in shardTest/E1N1", second_emitted[0]["message"])

            cleared_room = dict(runtime_room)
            cleared_room["taskCounts"] = dict(runtime_room["taskCounts"], harvest=1)
            cleared_emitted, _cleared_suppressed, cleared_state = evaluate_room_alert(
                snapshot,
                second_state,
                now=300,
                debounce_seconds=300,
                runtime_room_summary=cleared_room,
            )
            self.assertEqual(cleared_emitted, [])
            self.assertEqual(cleared_state["rule_counts"][WORKER_IDLE_COLLAPSE_KIND], 0)

        def test_energy_buffer_unhealthy_alerts_on_second_consecutive_detection(self) -> None:
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
                    },
                    "worker-1": {
                        "type": "creep",
                        "my": True,
                        "owner": {"username": "owner"},
                        "name": "worker-1",
                        "x": 23,
                        "y": 25,
                    },
                }
            )
            runtime_room = {
                "roomName": "E1N1",
                "energyBufferHealth": {"currentEnergy": 250, "threshold": 300, "healthy": False},
                "taskCounts": {"harvest": 1, "upgrade": 0, "build": 0, "transfer": 1},
            }
            previous = {"baseline_established": True, "owner": "owner"}

            first_emitted, first_suppressed, first_state = evaluate_room_alert(
                snapshot,
                previous,
                now=100,
                debounce_seconds=300,
                runtime_room_summary=runtime_room,
            )
            self.assertEqual(first_emitted, [])
            self.assertEqual(first_suppressed, [])
            self.assertEqual(first_state["rule_counts"][ENERGY_BUFFER_UNHEALTHY_KIND], 1)

            second_emitted, second_suppressed, second_state = evaluate_room_alert(
                snapshot,
                first_state,
                now=200,
                debounce_seconds=300,
                runtime_room_summary=runtime_room,
            )
            self.assertEqual([reason["kind"] for reason in second_emitted], [ENERGY_BUFFER_UNHEALTHY_KIND])
            self.assertEqual(second_suppressed, [])
            self.assertEqual(second_state["rule_counts"][ENERGY_BUFFER_UNHEALTHY_KIND], 2)
            self.assertEqual(second_emitted[0]["priority"], "P1")
            self.assertEqual(second_emitted[0]["metadata"]["related_issues"], ["#906", "#907"])

        def test_energy_buffer_unhealthy_transient_resets_without_alert(self) -> None:
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
                    },
                    "worker-1": {
                        "type": "creep",
                        "my": True,
                        "owner": {"username": "owner"},
                        "name": "worker-1",
                        "x": 23,
                        "y": 25,
                    },
                }
            )
            unhealthy_room = {
                "roomName": "E1N1",
                "energyBufferHealth": {"currentEnergy": 250, "threshold": 300, "healthy": False},
                "taskCounts": {"harvest": 1, "upgrade": 0, "build": 0, "transfer": 1},
            }
            recovered_room = {
                "roomName": "E1N1",
                "energyBufferHealth": {"currentEnergy": 300, "threshold": 300, "healthy": True},
                "taskCounts": {"harvest": 1, "upgrade": 0, "build": 0, "transfer": 1},
            }

            first_emitted, _first_suppressed, first_state = evaluate_room_alert(
                snapshot,
                {"baseline_established": True, "owner": "owner"},
                now=100,
                debounce_seconds=300,
                runtime_room_summary=unhealthy_room,
            )
            self.assertEqual(first_emitted, [])

            second_emitted, second_suppressed, second_state = evaluate_room_alert(
                snapshot,
                first_state,
                now=200,
                debounce_seconds=300,
                runtime_room_summary=recovered_room,
            )
            self.assertEqual(second_emitted, [])
            self.assertEqual(second_suppressed, [])
            self.assertEqual(second_state["rule_counts"][ENERGY_BUFFER_UNHEALTHY_KIND], 0)

    class RenderTests(unittest.TestCase):
        def test_room_svg_legend_covers_rendered_marker_families(self) -> None:
            snapshot = RoomSnapshot(
                ref=RoomRef("shardTest", "E1N1"),
                terrain="0" * TERRAIN_CELLS,
                objects=normalize_objects(
                    {
                        "spawn1": {"type": "spawn", "x": 25, "y": 25, "hits": 5000, "hitsMax": 5000},
                        "ctrl": {"type": "controller", "x": 5, "y": 36, "level": 3},
                        "mineral": {"type": "mineral", "x": 30, "y": 30},
                        "road": {"type": "road", "x": 24, "y": 25, "hits": 500, "hitsMax": 5000},
                        "extension": {"type": "extension", "x": 26, "y": 25, "hits": 1000, "hitsMax": 1000},
                        "tower": {"type": "tower", "x": 27, "y": 25, "hits": 3000, "hitsMax": 3000},
                        "rampart": {"type": "rampart", "x": 28, "y": 25, "hits": 10000, "hitsMax": 10000},
                        "wall": {"type": "constructedWall", "x": 29, "y": 25, "hits": 10000, "hitsMax": 10000},
                        "storage": {"type": "storage", "x": 30, "y": 25, "hits": 10000, "hitsMax": 10000},
                        "site": {"type": "constructionSite", "x": 31, "y": 25, "structureType": "extension"},
                    }
                ),
                tick=1,
                owner="owner",
                info={},
            )
            svg = render_room_svg(snapshot, "summary", [])
            for label in [
                "controller",
                "mineral",
                "creep",
                "road",
                "extension",
                "tower",
                "rampart",
                "built wall",
                "utility",
                "other struct",
                "site",
                "alert ring",
            ]:
                self.assertIn(label, svg)
            self.assertIn('stroke-dasharray="2 2"', svg)

    class SummaryTests(unittest.TestCase):
        def test_room_summary_includes_energy_fields_from_snapshot_info(self) -> None:
            snapshot = RoomSnapshot(
                ref=RoomRef("shardTest", "E1N1"),
                terrain="0" * TERRAIN_CELLS,
                objects=normalize_objects({}),
                tick=1,
                owner="owner",
                info={
                    "energyCapacity": 300,
                    "energyCapacityAvailable": 250,
                    "energyBufferHealth": {"currentEnergy": 250, "threshold": 300, "healthy": False},
                },
            )

            summary = room_summary(snapshot)

            self.assertEqual(summary["energyCapacity"], 300)
            self.assertEqual(summary["energyCapacityAvailable"], 250)
            self.assertEqual(summary["energyBufferHealth"], {"currentEnergy": 250, "threshold": 300, "healthy": False})

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

        def test_tactical_response_classifies_energy_buffer_unhealthy_as_p1(self) -> None:
            report = build_tactical_response_report(
                {
                    "ok": True,
                    "mode": "alert",
                    "alert": True,
                    "reasons": [
                        {
                            "kind": ENERGY_BUFFER_UNHEALTHY_KIND,
                            "room": "shardTest/E1N1",
                            "consecutive": 2,
                            "energy_buffer_health": {"currentEnergy": 250, "threshold": 300, "healthy": False},
                            "task_counts": {"build": 0, "upgrade": 0},
                            "metadata": energy_buffer_route_metadata(),
                            "message": "energy_buffer_unhealthy in shardTest/E1N1",
                        }
                    ],
                }
            )

            self.assertTrue(report["emergency"])
            self.assertEqual(report["severity"], "high")
            self.assertEqual(report["priority"], "P1")
            self.assertEqual(report["categories"], [ENERGY_BUFFER_UNHEALTHY_KIND])
            self.assertEqual(report["triggers"][0]["metadata"]["related_issues"], ["#906", "#907"])

        def test_tactical_response_ignores_single_capture_energy_buffer_unhealthy(self) -> None:
            report = build_tactical_response_report(
                {
                    "ok": True,
                    "mode": "alert",
                    "alert": True,
                    "reasons": [
                        {
                            "kind": ENERGY_BUFFER_UNHEALTHY_KIND,
                            "room": "shardTest/E1N1",
                            "consecutive": 1,
                            "energy_buffer_health": {"currentEnergy": 250, "threshold": 300, "healthy": False},
                            "task_counts": {"build": 0, "upgrade": 0},
                        }
                    ],
                }
            )

            self.assertFalse(report["emergency"])
            self.assertTrue(report["silent"])
            self.assertEqual(report["triggers"], [])

        def test_postdeploy_health_gate_rejects_dead_room_even_when_alert_is_silent(self) -> None:
            result = evaluate_postdeploy_health_gate(
                {
                    "ok": True,
                    "mode": "summary",
                    "room_summaries": [
                        {"room": "shardTest/E1N1", "creeps": 0, "structures": 1, "owner": None}
                    ],
                },
                {"ok": True, "mode": "alert", "alert": False, "reasons": []},
            )

            self.assertFalse(result["ok"])
            self.assertIn("postdeploy_room_dead", [reason["kind"] for reason in result["reasons"]])

        def test_postdeploy_health_gate_accepts_respawn_spawn_recovery(self) -> None:
            result = evaluate_postdeploy_health_gate(
                {
                    "ok": True,
                    "mode": "summary",
                    "room_summaries": [
                        {
                            "room": "shardTest/E1N1",
                            "creeps": 0,
                            "owned_creeps": 0,
                            "structures": 2,
                            "owner": "owner",
                            "spawns": 1,
                            "owned_spawns": 1,
                        }
                    ],
                },
                {"ok": True, "mode": "alert", "alert": False, "reasons": []},
            )

            self.assertTrue(result["ok"])

        def test_postdeploy_health_gate_enriches_energy_fields_from_runtime_summary_artifact(self) -> None:
            with tempfile.TemporaryDirectory() as temp_dir:
                artifact = Path(temp_dir) / "runtime-summary.log"
                old_payload = {
                    "type": "runtime-summary",
                    "rooms": [
                        {
                            "roomName": "E1N1",
                            "shard": "shardTest",
                            "energyCapacity": 300,
                            "energyBufferHealth": {"threshold": 250},
                        }
                    ],
                }
                latest_payload = {
                    "type": "runtime-summary",
                    "rooms": [
                        {
                            "roomName": "E1N1",
                            "shard": "shardTest",
                            "energyCapacity": 300,
                            "energyBufferHealth": {"threshold": 350},
                        }
                    ],
                }
                artifact.write_text(
                    "ignored\n"
                    + RUNTIME_SUMMARY_PREFIX
                    + json.dumps(old_payload)
                    + "\n"
                    + RUNTIME_SUMMARY_PREFIX
                    + json.dumps(latest_payload)
                    + "\n",
                    encoding="utf-8",
                )

                result = evaluate_postdeploy_health_gate(
                    {
                        "ok": True,
                        "mode": "summary",
                        "runtime_summary_artifact": str(artifact),
                        "room_summaries": [
                            {
                                "room": "shardTest/E1N1",
                                "name": "E1N1",
                                "owned_creeps": 1,
                                "owned_spawns": 1,
                                "owner": "owner",
                            }
                        ],
                    },
                    {"ok": True, "mode": "alert", "alert": False, "reasons": []},
                )

            self.assertFalse(result["ok"])
            threshold_reason = next(reason for reason in result["reasons"] if reason["kind"] == "threshold_exceeds_capacity")
            self.assertEqual(threshold_reason["threshold"], 350)

        def test_postdeploy_health_gate_rejects_threshold_above_capacity_in_any_room(self) -> None:
            result = evaluate_postdeploy_health_gate(
                {
                    "ok": True,
                    "mode": "summary",
                    "room_summaries": [
                        {
                            "room": "shardTest/E1N1",
                            "owned_creeps": 1,
                            "owned_spawns": 1,
                            "owner": "owner",
                            "energyCapacity": 300,
                            "energyBufferHealth": {"threshold": 300},
                        },
                        {
                            "room": "shardTest/E2N2",
                            "owned_creeps": 1,
                            "owned_spawns": 1,
                            "owner": "owner",
                            "energyCapacity": 300,
                            "energyBufferHealth": {"threshold": 350},
                        },
                    ],
                },
                {"ok": True, "mode": "alert", "alert": False, "reasons": []},
            )

            self.assertFalse(result["ok"])
            self.assertIn("threshold_exceeds_capacity", [reason["kind"] for reason in result["reasons"]])
            threshold_reason = next(reason for reason in result["reasons"] if reason["kind"] == "threshold_exceeds_capacity")
            self.assertEqual(threshold_reason["room"], "shardTest/E2N2")

        def test_postdeploy_health_gate_accepts_threshold_at_or_below_capacity(self) -> None:
            result = evaluate_postdeploy_health_gate(
                {
                    "ok": True,
                    "mode": "summary",
                    "room_summaries": [
                        {
                            "room": "shardTest/E1N1",
                            "owned_creeps": 1,
                            "owned_spawns": 1,
                            "owner": "owner",
                            "energyCapacity": 300,
                            "energyBufferHealth": {"threshold": 300},
                        },
                        {
                            "room": "shardTest/E2N2",
                            "owned_creeps": 1,
                            "owned_spawns": 1,
                            "owner": "owner",
                            "energyCapacity": 300,
                            "energyBufferHealth": {"threshold": 250},
                        },
                    ],
                },
                {"ok": True, "mode": "alert", "alert": False, "reasons": []},
            )

            self.assertTrue(result["ok"])

        def test_postdeploy_health_gate_rejects_enemy_spawn_without_owned_recovery(self) -> None:
            result = evaluate_postdeploy_health_gate(
                {
                    "ok": True,
                    "mode": "summary",
                    "room_summaries": [
                        {
                            "room": "shardTest/E1N1",
                            "creeps": 2,
                            "owned_creeps": 0,
                            "structures": 8,
                            "owner": None,
                            "expected_owner": "owner",
                            "spawns": 1,
                            "owned_spawns": 0,
                        }
                    ],
                },
                {"ok": True, "mode": "alert", "alert": False, "reasons": []},
            )

            self.assertFalse(result["ok"])
            self.assertIn("postdeploy_room_dead", [reason["kind"] for reason in result["reasons"]])

        def test_postdeploy_health_gate_accepts_owned_room_without_spawn_when_worker_survives(self) -> None:
            result = evaluate_postdeploy_health_gate(
                {
                    "ok": True,
                    "mode": "summary",
                    "room_summaries": [
                        {
                            "room": "shardTest/E1N1",
                            "creeps": 1,
                            "owned_creeps": 1,
                            "structures": 4,
                            "owner": "owner",
                            "expected_owner": "owner",
                            "spawns": 0,
                            "owned_spawns": 0,
                        }
                    ],
                },
                {"ok": True, "mode": "alert", "alert": False, "reasons": []},
            )

            self.assertTrue(result["ok"])
            self.assertNotIn("postdeploy_no_owned_spawn", [reason["kind"] for reason in result["reasons"]])

        def test_postdeploy_health_gate_rejects_owned_room_without_spawn_or_creeps(self) -> None:
            result = evaluate_postdeploy_health_gate(
                {
                    "ok": True,
                    "mode": "summary",
                    "room_summaries": [
                        {
                            "room": "shardTest/E1N1",
                            "creeps": 0,
                            "owned_creeps": 0,
                            "structures": 4,
                            "owner": "owner",
                            "expected_owner": "owner",
                            "spawns": 0,
                            "owned_spawns": 0,
                        }
                    ],
                },
                {"ok": True, "mode": "alert", "alert": False, "reasons": []},
            )

            kinds = [reason["kind"] for reason in result["reasons"]]
            self.assertFalse(result["ok"])
            self.assertIn("postdeploy_no_owned_spawn", kinds)
            self.assertIn("postdeploy_room_dead", kinds)

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

        def test_tactical_response_classifies_room_dead_as_p0_critical(self) -> None:
            report = build_tactical_response_report(
                {
                    "ok": True,
                    "mode": "alert",
                    "alert": True,
                    "reasons": [
                        {
                            "kind": "room_dead",
                            "room": "shardTest/E1N1",
                            "current_owned_spawns": 0,
                            "current_owned_creeps": 0,
                            "message": "room has no owned creeps and no owned spawn recovery path",
                        }
                    ],
                }
            )
            self.assertTrue(report["emergency"])
            self.assertEqual(report["severity"], "critical")
            self.assertEqual(report["priority"], "P0")
            self.assertIn("room_dead", report["categories"])
            self.assertEqual(report["scheduler"]["priority"], "P0")
            self.assertEqual(report["triggers"][0]["decision"], "autonomous_recovery_authorized")
            self.assertIn("start_autonomous_recovery", {action["id"] for action in report["next_actions"]})

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

        def test_tactical_response_classifies_postdeploy_no_owned_spawn_as_p0(self) -> None:
            report = build_tactical_response_report(
                {
                    "ok": True,
                    "mode": "health-gate",
                    "alert": False,
                    "reasons": [
                        {
                            "kind": "postdeploy_no_owned_spawn",
                            "room": "shardTest/E1N1",
                            "spawns": 0,
                            "creeps": 0,
                            "message": "shardTest/E1N1: no owned spawn recovery path is visible after deploy",
                        }
                    ],
                }
            )
            self.assertTrue(report["emergency"])
            self.assertEqual(report["severity"], "critical")
            self.assertEqual(report["priority"], "P0")
            self.assertIn("spawn_collapse", report["categories"])

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

        def test_tactical_response_classifies_private_smoke_stats_silence(self) -> None:
            report = build_tactical_response_report(
                {
                    "ok": False,
                    "dry_run": False,
                    "smoke": {"room": "E1S1", "shard": "shardX", "spawn": {"name": "Spawn1"}},
                    "phases": [
                        {"name": "place-spawn", "ok": True, "details": {}},
                        {
                            "name": "poll-stats",
                            "ok": False,
                            "details": {
                                "samples": 0,
                                "first": None,
                                "last": None,
                                "error": "stats criteria were not met before timeout",
                            },
                        },
                    ],
                }
            )
            self.assertTrue(report["emergency"])
            self.assertEqual(report["severity"], "critical")
            self.assertIn("telemetry_silence", report["categories"])
            self.assertIn("private_smoke_failure", report["categories"])

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
    for case in (TerrainTests, AlertTests, RenderTests, TacticalResponseTests, SafeJsonTests):
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
