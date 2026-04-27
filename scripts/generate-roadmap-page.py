#!/usr/bin/env python3
"""Generate the static GitHub Pages roadmap report."""

from __future__ import annotations

import argparse
import html
import json
import math
import re
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence


SCHEMA_VERSION = 1
DEFAULT_OWNER = "lanyusea"
DEFAULT_REPO = "screeps"
DEFAULT_PROJECT_NUMBER = 3
PAGE_TITLE = "Screeps Roadmap Live Report"
PAGES_URL = "https://lanyusea.github.io/screeps/"
GITHUB_PROJECT_URL = "https://github.com/users/lanyusea/projects/3"
SCREEPS_ROOM_URL = "https://screeps.com/a/#!/room/shardX/E48S28"
DISCORD_URL = "https://discord.gg/XenFZG9bCE"
LFS_POINTER_PREFIX = b"version https://git-lfs.github.com/spec/v1"

OBSERVED = "observed"
NOT_OBSERVED = "not observed"
NOT_INSTRUMENTED = "not instrumented"
INSUFFICIENT_EVIDENCE = "insufficient evidence"


JsonObject = dict[str, Any]


STATIC_SUPPORT_ISSUES: tuple[JsonObject, ...] = (
    {
        "type": "Issue",
        "number": 29,
        "title": "P1: Phase C runtime-summary/runtime-alert scheduled monitor delivery",
        "state": "OPEN",
        "labels": ["kind:ops", "priority:p1", "roadmap", "roadmap:phase-c-telemetry"],
        "milestone": "Phase C",
        "status": "Ready",
        "priority": "P1",
        "domain": "Runtime monitor",
        "kind": "ops",
        "visionLayer": "foundation blocker",
        "evidence": "Supports runtime KPI and alert delivery evidence for live reporting.",
        "nextAction": "Verify scheduled runtime-summary/runtime-alert delivery and no-alert silence behavior.",
    },
    {
        "type": "Issue",
        "number": 59,
        "title": "P1: Gameplay Evolution: vision-driven game-result review to roadmap/task loop",
        "state": "OPEN",
        "labels": ["kind:ops", "priority:p1", "roadmap", "roadmap:phase-c-telemetry"],
        "milestone": "Phase C",
        "status": "Ready",
        "priority": "P1",
        "domain": "Gameplay Evolution",
        "kind": "ops",
        "visionLayer": "territory",
        "evidence": "Anchors territory > resources > enemy kills KPI reporting and task feedback.",
        "nextAction": "Use KPI evidence to drive accepted roadmap and Codex task updates.",
    },
)


@dataclass(frozen=True)
class MetricSpec:
    key: str
    category: str
    label: str
    unit: str
    layer: str
    description: str
    source: str
    priority: int
    lower_is_better: bool = False


METRIC_SPECS: tuple[MetricSpec, ...] = (
    MetricSpec(
        "owned_rooms",
        "territory",
        "Owned rooms",
        "rooms",
        "territory",
        "Owned room count in the latest runtime KPI window.",
        "runtime-summary rooms",
        10,
    ),
    MetricSpec(
        "owned_room_delta",
        "territory",
        "Owned-room delta",
        "rooms/window",
        "territory",
        "Net owned-room gain or loss across the runtime KPI window.",
        "runtime-summary rooms",
        20,
    ),
    MetricSpec(
        "reserved_remote_rooms",
        "territory",
        "Reserved / remote rooms",
        "rooms",
        "territory",
        "Reserved or remote room footprint; reducer support is still pending.",
        "future room-footprint telemetry",
        30,
    ),
    MetricSpec(
        "controller_level_sum",
        "territory",
        "Controller level sum",
        "RCL",
        "territory",
        "Sum of latest room controller levels.",
        "runtime-summary controller fields",
        40,
    ),
    MetricSpec(
        "controller_progress_delta",
        "territory",
        "Controller progress delta",
        "progress/window",
        "territory",
        "Total controller progress movement across the runtime KPI window.",
        "runtime-summary controller fields",
        50,
    ),
    MetricSpec(
        "stored_energy",
        "resources",
        "Stored energy",
        "energy",
        "resources",
        "Energy held in room stores in the latest runtime KPI window.",
        "runtime-summary resource fields",
        10,
    ),
    MetricSpec(
        "stored_energy_delta",
        "resources",
        "Stored-energy delta",
        "energy/window",
        "resources",
        "Stored energy movement across the runtime KPI window.",
        "runtime-summary resource fields",
        20,
    ),
    MetricSpec(
        "worker_carried_energy",
        "resources",
        "Worker carried energy",
        "energy",
        "resources",
        "Energy currently carried by workers.",
        "runtime-summary resource fields",
        30,
    ),
    MetricSpec(
        "dropped_energy",
        "resources",
        "Dropped energy",
        "energy",
        "resources",
        "Visible dropped energy in owned rooms.",
        "runtime-summary resource fields",
        40,
    ),
    MetricSpec(
        "source_count",
        "resources",
        "Source count",
        "sources",
        "resources",
        "Visible source count in currently observed owned rooms.",
        "runtime-summary resource fields",
        50,
    ),
    MetricSpec(
        "harvested_energy",
        "resources",
        "Harvested energy",
        "energy/window",
        "resources",
        "Energy harvested from runtime event totals when observed.",
        "runtime-summary resource events",
        60,
    ),
    MetricSpec(
        "transferred_energy",
        "resources",
        "Transferred energy",
        "energy/window",
        "resources",
        "Energy transferred from runtime event totals when observed.",
        "runtime-summary resource events",
        70,
    ),
    MetricSpec(
        "spawn_utilization",
        "resources",
        "Spawn utilization",
        "ratio",
        "resources",
        "Spawn busy time or utilization ratio; telemetry support is pending.",
        "future spawn telemetry",
        80,
    ),
    MetricSpec(
        "spawn_queue_pressure",
        "resources",
        "Spawn queue pressure",
        "requests",
        "resources",
        "Unserved spawn demand; telemetry support is pending.",
        "future spawn telemetry",
        90,
    ),
    MetricSpec(
        "hostile_creeps",
        "combat",
        "Hostile creeps",
        "creeps",
        "enemy kills",
        "Latest hostile creep count in observed rooms.",
        "runtime-summary combat fields",
        10,
    ),
    MetricSpec(
        "hostile_structures",
        "combat",
        "Hostile structures",
        "structures",
        "enemy kills",
        "Latest hostile structure count in observed rooms.",
        "runtime-summary combat fields",
        20,
    ),
    MetricSpec(
        "attack_count",
        "combat",
        "Attack events",
        "events/window",
        "enemy kills",
        "Attack event total across the runtime KPI window when observed.",
        "runtime-summary combat events",
        30,
    ),
    MetricSpec(
        "attack_damage",
        "combat",
        "Attack damage",
        "damage/window",
        "enemy kills",
        "Attack damage total across the runtime KPI window when observed.",
        "runtime-summary combat events",
        40,
    ),
    MetricSpec(
        "objects_destroyed",
        "combat",
        "Objects destroyed",
        "objects/window",
        "enemy kills",
        "Generic destroyed-object event total; this is not enemy-kill proof.",
        "runtime-summary combat events",
        50,
    ),
    MetricSpec(
        "creeps_destroyed_generic",
        "combat",
        "Creeps destroyed, generic",
        "creeps/window",
        "enemy kills",
        "Generic destroyed-creep event total; this can include own losses.",
        "runtime-summary combat events",
        60,
    ),
    MetricSpec(
        "enemy_kills",
        "combat",
        "Enemy kills",
        "kills/window",
        "enemy kills",
        "Ownership-aware enemy kills are not available yet.",
        "future ownership-aware combat reducer",
        70,
    ),
    MetricSpec(
        "own_losses",
        "combat",
        "Own losses",
        "creeps/window",
        "enemy kills",
        "Own creep losses; ownership-aware combat reducer support is pending.",
        "future ownership-aware combat reducer",
        80,
    ),
    MetricSpec(
        "runtime_summary_samples",
        "guardrails",
        "Runtime summary samples",
        "samples",
        "guardrails",
        "Runtime-summary lines found by the persisted artifact feeder.",
        "runtime KPI artifact bridge",
        10,
    ),
    MetricSpec(
        "kpi_artifact_files",
        "guardrails",
        "KPI artifact files",
        "files",
        "guardrails",
        "Files matched by the persisted artifact feeder.",
        "runtime KPI artifact bridge",
        20,
    ),
    MetricSpec(
        "controller_downgrade_min_ticks",
        "guardrails",
        "Downgrade risk",
        "ticks",
        "guardrails",
        "Minimum ticks-to-downgrade among observed controllers.",
        "runtime-summary controller fields",
        30,
        lower_is_better=True,
    ),
    MetricSpec(
        "cpu_used",
        "guardrails",
        "CPU used",
        "cpu",
        "guardrails",
        "CPU used per tick; telemetry support is pending.",
        "future reliability telemetry",
        40,
        lower_is_better=True,
    ),
    MetricSpec(
        "cpu_bucket",
        "guardrails",
        "CPU bucket",
        "bucket",
        "guardrails",
        "CPU bucket safety; telemetry support is pending.",
        "future reliability telemetry",
        50,
    ),
    MetricSpec(
        "runtime_exceptions",
        "guardrails",
        "Runtime exceptions",
        "exceptions",
        "guardrails",
        "Loop exceptions across the review window; telemetry support is pending.",
        "future reliability telemetry",
        60,
        lower_is_better=True,
    ),
    MetricSpec(
        "global_resets",
        "guardrails",
        "Global resets",
        "resets",
        "guardrails",
        "Global reset count across the review window; telemetry support is pending.",
        "future reliability telemetry",
        70,
        lower_is_better=True,
    ),
    MetricSpec(
        "telemetry_silence_minutes",
        "guardrails",
        "Telemetry silence",
        "minutes",
        "guardrails",
        "Longest telemetry silence interval; reporter support is pending.",
        "future reliability telemetry",
        80,
        lower_is_better=True,
    ),
    MetricSpec(
        "alert_false_positives",
        "guardrails",
        "Alert false positives",
        "alerts",
        "guardrails",
        "Known false-positive alerts; review classification support is pending.",
        "future alert review telemetry",
        90,
        lower_is_better=True,
    ),
    MetricSpec(
        "alert_false_negatives",
        "guardrails",
        "Alert false negatives",
        "alerts",
        "guardrails",
        "Known missed alerts; review classification support is pending.",
        "future alert review telemetry",
        100,
        lower_is_better=True,
    ),
    MetricSpec(
        "worker_recovery_state",
        "guardrails",
        "Worker recovery state",
        "state",
        "guardrails",
        "Spawn/worker death-spiral recovery health; telemetry support is pending.",
        "future reliability telemetry",
        110,
    ),
)


CATEGORY_LABELS = {
    "territory": "Territory",
    "resources": "Resources / Economy",
    "combat": "Combat / Enemy Kills",
    "guardrails": "Guardrails / Reliability",
}

CATEGORY_ACCENTS = {
    "territory": "#2f6f5e",
    "resources": "#c6752a",
    "combat": "#a83f35",
    "guardrails": "#244c73",
}


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the GitHub Pages roadmap report.")
    parser.add_argument("--repo", default=".", help="Repository root. Default: current directory.")
    parser.add_argument("--docs-dir", default="docs", help="Documentation output directory.")
    parser.add_argument("--db", default="docs/roadmap-kpi.sqlite", help="SQLite KPI history path.")
    parser.add_argument("--project-number", type=int, default=DEFAULT_PROJECT_NUMBER, help="GitHub project number.")
    parser.add_argument("--project-owner", default=DEFAULT_OWNER, help="GitHub project owner.")
    parser.add_argument("--repo-full-name", default="", help="GitHub repository in owner/name form.")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = Path(args.repo).expanduser().resolve()
    docs_dir = (repo_root / args.docs_dir).resolve() if not Path(args.docs_dir).is_absolute() else Path(args.docs_dir)
    db_path = (repo_root / args.db).resolve() if not Path(args.db).is_absolute() else Path(args.db)

    docs_dir.mkdir(parents=True, exist_ok=True)
    repo_full_name = args.repo_full_name or detect_repo_full_name(repo_root)
    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    runtime_report = load_runtime_kpi_report(repo_root)
    metrics = build_current_metrics(runtime_report)
    conn = open_history_db(db_path)
    try:
        write_metric_definitions(conn)
        migrate_legacy_kpi_samples(conn)
        append_metric_samples(conn, generated_at, metrics)
        history = load_metric_history(conn)
    finally:
        conn.close()
        remove_sqlite_sidecars(db_path)

    github_snapshot = fetch_github_snapshot(
        repo_root=repo_root,
        repo_full_name=repo_full_name,
        project_owner=args.project_owner,
        project_number=args.project_number,
    )
    repo_snapshot = build_repo_snapshot(repo_root, repo_full_name)
    data = build_page_data(
        generated_at=generated_at,
        repo=repo_snapshot,
        runtime_report=runtime_report,
        metrics=metrics,
        history=history,
        github_snapshot=github_snapshot,
        docs_dir=docs_dir,
    )

    json_path = docs_dir / "roadmap-data.json"
    html_path = docs_dir / "index.html"
    json_path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    html_path.write_text(strip_trailing_whitespace(render_html(data)), encoding="utf-8")

    print(f"wrote {relative_to_cwd(html_path)}")
    print(f"wrote {relative_to_cwd(json_path)}")
    print(f"wrote {relative_to_cwd(db_path)}")
    return 0


def relative_to_cwd(path: Path) -> str:
    try:
        return str(path.relative_to(Path.cwd()))
    except ValueError:
        return str(path)


def detect_repo_full_name(repo_root: Path) -> str:
    remote_url = run_text(["git", "remote", "get-url", "origin"], repo_root).strip()
    if remote_url:
        parsed = parse_github_remote(remote_url)
        if parsed:
            return parsed
    return f"{DEFAULT_OWNER}/{DEFAULT_REPO}"


def parse_github_remote(remote_url: str) -> str | None:
    patterns = (
        r"github\.com[:/](?P<owner>[^/]+)/(?P<name>[^/.]+)(?:\.git)?$",
        r"^https?://github\.com/(?P<owner>[^/]+)/(?P<name>[^/.]+)(?:\.git)?$",
    )
    for pattern in patterns:
        match = re.search(pattern, remote_url.strip())
        if match:
            return f"{match.group('owner')}/{match.group('name')}"
    return None


def strip_trailing_whitespace(text: str) -> str:
    return "\n".join(line.rstrip() for line in text.splitlines()) + "\n"


def build_repo_snapshot(repo_root: Path, repo_full_name: str) -> JsonObject:
    branch = run_text(["git", "branch", "--show-current"], repo_root).strip()
    commit = run_text(["git", "rev-parse", "--short", "HEAD"], repo_root).strip()
    return {
        "fullName": repo_full_name,
        "branch": branch,
        "commit": commit,
        "url": f"https://github.com/{repo_full_name}",
        "pagesUrl": PAGES_URL,
        "projectUrl": GITHUB_PROJECT_URL,
        "screepsRoomUrl": SCREEPS_ROOM_URL,
        "discordUrl": DISCORD_URL,
    }


def run_text(command: Sequence[str], cwd: Path, timeout: int = 15) -> str:
    try:
        completed = subprocess.run(
            list(command),
            cwd=str(cwd),
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if completed.returncode != 0:
        return ""
    return completed.stdout


def run_json(command: Sequence[str], cwd: Path, timeout: int = 30) -> tuple[Any | None, JsonObject | None]:
    command_list = list(command)
    try:
        completed = subprocess.run(
            command_list,
            cwd=str(cwd),
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None, {"command": command_list[:4], "exitCode": None, "message": "command timed out"}
    except OSError:
        return None, {"command": command_list[:4], "exitCode": None, "message": "command unavailable"}

    if completed.returncode != 0:
        return None, {"command": command_list[:4], "exitCode": completed.returncode, "message": "command failed"}

    try:
        return json.loads(completed.stdout), None
    except json.JSONDecodeError:
        return None, {"command": command_list[:4], "exitCode": completed.returncode, "message": "invalid json output"}


def load_runtime_kpi_report(repo_root: Path) -> JsonObject:
    script_path = repo_root / "scripts" / "screeps_runtime_kpi_artifact_bridge.py"
    if not script_path.exists():
        return empty_runtime_report("runtime KPI bridge missing")

    data, error = run_json([sys.executable, str(script_path), "--format", "json"], repo_root, timeout=45)
    if error is not None or not isinstance(data, dict):
        report = empty_runtime_report("runtime KPI bridge unavailable")
        report["source"]["bridgeError"] = error
        return report
    return data


def empty_runtime_report(reason: str) -> JsonObject:
    return {
        "type": "runtime-kpi-report",
        "schemaVersion": 1,
        "input": {
            "lineCount": 0,
            "runtimeSummaryCount": 0,
            "ignoredLineCount": 0,
            "malformedRuntimeSummaryCount": 0,
        },
        "window": {"firstTick": None, "latestTick": None},
        "territory": {
            "status": NOT_INSTRUMENTED,
            "ownedRooms": {"status": NOT_INSTRUMENTED, "message": NOT_INSTRUMENTED},
            "controllers": {"status": NOT_INSTRUMENTED, "message": NOT_INSTRUMENTED},
        },
        "resources": {"status": NOT_INSTRUMENTED, "message": NOT_INSTRUMENTED},
        "combat": {"status": NOT_INSTRUMENTED, "message": NOT_INSTRUMENTED},
        "source": {
            "inputPaths": [],
            "matchedFiles": 0,
            "runtimeSummaryLines": 0,
            "scannedFiles": 0,
            "skippedFileCount": 0,
            "skippedFiles": [],
            "reason": reason,
        },
    }


def build_current_metrics(runtime_report: JsonObject) -> list[JsonObject]:
    value_builders = {
        "owned_rooms": metric_owned_rooms,
        "owned_room_delta": metric_owned_room_delta,
        "reserved_remote_rooms": metric_not_ready,
        "controller_level_sum": metric_controller_level_sum,
        "controller_progress_delta": metric_controller_progress_delta,
        "stored_energy": lambda report: metric_total(report, "resources", "latest", "storedEnergy"),
        "stored_energy_delta": lambda report: metric_total(report, "resources", "delta", "storedEnergy"),
        "worker_carried_energy": lambda report: metric_total(report, "resources", "latest", "workerCarriedEnergy"),
        "dropped_energy": lambda report: metric_total(report, "resources", "latest", "droppedEnergy"),
        "source_count": lambda report: metric_total(report, "resources", "latest", "sourceCount"),
        "harvested_energy": lambda report: metric_event(report, "resources", "harvestedEnergy"),
        "transferred_energy": lambda report: metric_event(report, "resources", "transferredEnergy"),
        "spawn_utilization": metric_not_ready,
        "spawn_queue_pressure": metric_not_ready,
        "hostile_creeps": lambda report: metric_total(report, "combat", "latest", "hostileCreepCount"),
        "hostile_structures": lambda report: metric_total(report, "combat", "latest", "hostileStructureCount"),
        "attack_count": lambda report: metric_event(report, "combat", "attackCount"),
        "attack_damage": lambda report: metric_event(report, "combat", "attackDamage"),
        "objects_destroyed": lambda report: metric_event(report, "combat", "objectDestroyedCount"),
        "creeps_destroyed_generic": lambda report: metric_event(report, "combat", "creepDestroyedCount"),
        "enemy_kills": metric_enemy_kills,
        "own_losses": metric_not_ready,
        "runtime_summary_samples": metric_runtime_summary_samples,
        "kpi_artifact_files": metric_kpi_artifact_files,
        "controller_downgrade_min_ticks": metric_controller_downgrade_min_ticks,
        "cpu_used": metric_not_ready,
        "cpu_bucket": metric_not_ready,
        "runtime_exceptions": metric_not_ready,
        "global_resets": metric_not_ready,
        "telemetry_silence_minutes": metric_not_ready,
        "alert_false_positives": metric_not_ready,
        "alert_false_negatives": metric_not_ready,
        "worker_recovery_state": metric_not_ready,
    }

    metrics: list[JsonObject] = []
    for spec in METRIC_SPECS:
        value_state = value_builders[spec.key](runtime_report)
        metric = {
            "key": spec.key,
            "category": spec.category,
            "categoryLabel": CATEGORY_LABELS[spec.category],
            "label": spec.label,
            "unit": spec.unit,
            "layer": spec.layer,
            "description": spec.description,
            "source": spec.source,
            "priority": spec.priority,
            "lowerIsBetter": spec.lower_is_better,
            **value_state,
        }
        metric["formattedValue"] = format_metric_value(metric)
        metrics.append(metric)
    return metrics


def status_value(
    value: int | float | None,
    instrumented: bool,
    status: str | None = None,
    details: JsonObject | None = None,
) -> JsonObject:
    if status is None:
        if not instrumented:
            status = NOT_INSTRUMENTED
        elif value is None:
            status = NOT_OBSERVED
        else:
            status = OBSERVED
    return {
        "value": value,
        "instrumented": bool(instrumented),
        "observed": value is not None and status == OBSERVED,
        "status": status,
        "details": details or {},
    }


def metric_not_ready(_report: JsonObject) -> JsonObject:
    return status_value(None, False)


def metric_enemy_kills(_report: JsonObject) -> JsonObject:
    return status_value(
        None,
        False,
        NOT_INSTRUMENTED,
        {
            "reason": (
                "Generic creepDestroyedCount can include own losses; enemy_kills stays empty "
                "until an ownership-aware reducer exists."
            )
        },
    )


def metric_owned_rooms(report: JsonObject) -> JsonObject:
    owned_rooms = get_path(report, ("territory", "ownedRooms"), {})
    if owned_rooms.get("status") != OBSERVED:
        return status_value(None, False)
    return status_value(as_number(owned_rooms.get("latestCount")), True, OBSERVED, room_delta_details(owned_rooms))


def metric_owned_room_delta(report: JsonObject) -> JsonObject:
    owned_rooms = get_path(report, ("territory", "ownedRooms"), {})
    if owned_rooms.get("status") != OBSERVED:
        return status_value(None, False)
    return status_value(as_number(owned_rooms.get("deltaCount")), True, OBSERVED, room_delta_details(owned_rooms))


def room_delta_details(owned_rooms: JsonObject) -> JsonObject:
    return {
        "latest": owned_rooms.get("latest", []),
        "gained": owned_rooms.get("gained", []),
        "lost": owned_rooms.get("lost", []),
    }


def metric_controller_level_sum(report: JsonObject) -> JsonObject:
    controllers = get_path(report, ("territory", "controllers"), {})
    if controllers.get("status") != OBSERVED:
        return status_value(None, False)
    return status_value(as_number(get_path(controllers, ("totals", "latest", "level"))), True)


def metric_controller_progress_delta(report: JsonObject) -> JsonObject:
    controllers = get_path(report, ("territory", "controllers"), {})
    if controllers.get("status") != OBSERVED:
        return status_value(None, False)
    return status_value(as_number(get_path(controllers, ("totals", "delta", "progress"))), True)


def metric_controller_downgrade_min_ticks(report: JsonObject) -> JsonObject:
    controllers = get_path(report, ("territory", "controllers"), {})
    if controllers.get("status") != OBSERVED:
        return status_value(None, False)

    values: list[int | float] = []
    rooms = controllers.get("rooms")
    if isinstance(rooms, dict):
        for room_report in rooms.values():
            value = as_number(get_path(room_report, ("latest", "ticksToDowngrade")))
            if value is not None:
                values.append(value)
    return status_value(min(values) if values else None, True)


def metric_total(report: JsonObject, section_name: str, total_kind: str, field_name: str) -> JsonObject:
    section = get_path(report, (section_name,), {})
    if section.get("status") != OBSERVED:
        return status_value(None, False)
    return status_value(as_number(get_path(section, ("totals", total_kind, field_name))), True)


def metric_event(report: JsonObject, section_name: str, field_name: str) -> JsonObject:
    section = get_path(report, (section_name,), {})
    if section.get("status") != OBSERVED:
        return status_value(None, False)
    events = section.get("eventDeltas")
    if not isinstance(events, dict):
        return status_value(None, True, NOT_OBSERVED)
    if events.get("status") != OBSERVED:
        return status_value(None, True, NOT_OBSERVED)
    return status_value(as_number(events.get(field_name)), True, OBSERVED)


def metric_runtime_summary_samples(report: JsonObject) -> JsonObject:
    source = report.get("source")
    value = None
    if isinstance(source, dict):
        value = as_number(source.get("runtimeSummaryLines"))
    if value is None:
        value = as_number(get_path(report, ("input", "runtimeSummaryCount")))
    return status_value(value, value is not None)


def metric_kpi_artifact_files(report: JsonObject) -> JsonObject:
    source = report.get("source")
    value = as_number(source.get("matchedFiles")) if isinstance(source, dict) else None
    return status_value(value, value is not None)


def get_path(value: Any, path: Iterable[str], default: Any = None) -> Any:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return default
        current = current.get(key)
    return default if current is None else current


def as_number(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return value
    return None


def format_metric_value(metric: JsonObject) -> str:
    if not metric["instrumented"]:
        return NOT_INSTRUMENTED
    if metric["status"] == NOT_OBSERVED or metric["value"] is None:
        return NOT_OBSERVED
    value = metric["value"]
    if isinstance(value, float) and not value.is_integer():
        return f"{value:.2f}"
    return str(int(value))


def open_history_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if is_lfs_pointer(db_path):
        db_path.unlink()

    try:
        conn = sqlite3.connect(str(db_path))
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute("PRAGMA foreign_keys=ON")
        ensure_schema(conn)
        return conn
    except sqlite3.DatabaseError:
        try:
            conn.close()  # type: ignore[possibly-undefined]
        except Exception:
            pass
        if db_path.exists():
            db_path.unlink()

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    ensure_schema(conn)
    return conn


def is_lfs_pointer(path: Path) -> bool:
    if not path.exists() or not path.is_file():
        return False
    try:
        return path.read_bytes()[: len(LFS_POINTER_PREFIX)] == LFS_POINTER_PREFIX
    except OSError:
        return False


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS metric_definitions (
          metric_key TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          label TEXT NOT NULL,
          unit TEXT NOT NULL,
          layer TEXT NOT NULL,
          description TEXT NOT NULL,
          source TEXT NOT NULL,
          priority INTEGER NOT NULL,
          lower_is_better INTEGER NOT NULL CHECK (lower_is_better IN (0, 1))
        );

        CREATE TABLE IF NOT EXISTS metric_points (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          captured_at TEXT NOT NULL,
          metric TEXT NOT NULL,
          category TEXT NOT NULL,
          label TEXT NOT NULL,
          value REAL,
          unit TEXT NOT NULL,
          layer TEXT NOT NULL,
          instrumented INTEGER NOT NULL CHECK (instrumented IN (0, 1)),
          observed INTEGER NOT NULL CHECK (observed IN (0, 1)),
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          details_json TEXT NOT NULL,
          FOREIGN KEY (metric) REFERENCES metric_definitions(metric_key)
        );

        CREATE INDEX IF NOT EXISTS idx_metric_points_metric_time
          ON metric_points(metric, captured_at);
        """
    )
    conn.execute(
        "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
        ("schema_version", str(SCHEMA_VERSION)),
    )
    conn.commit()


def migrate_legacy_kpi_samples(conn: sqlite3.Connection) -> None:
    legacy_exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kpi_samples'"
    ).fetchone()
    if not legacy_exists:
        return

    conn.execute(
        """
        INSERT INTO metric_points
        (captured_at, metric, category, label, value, unit, layer, instrumented, observed, status, source, details_json)
        SELECT sampled_at, metric_key, category, label, value, unit, layer, instrumented, observed, status, source, details_json
        FROM kpi_samples
        WHERE NOT EXISTS (
          SELECT 1
          FROM metric_points
          WHERE metric_points.captured_at = kpi_samples.sampled_at
            AND metric_points.metric = kpi_samples.metric_key
        )
        """
    )


def write_metric_definitions(conn: sqlite3.Connection) -> None:
    conn.executemany(
        """
        INSERT OR REPLACE INTO metric_definitions
        (metric_key, category, label, unit, layer, description, source, priority, lower_is_better)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                spec.key,
                spec.category,
                spec.label,
                spec.unit,
                spec.layer,
                spec.description,
                spec.source,
                spec.priority,
                int(spec.lower_is_better),
            )
            for spec in METRIC_SPECS
        ],
    )
    conn.commit()


def append_metric_samples(conn: sqlite3.Connection, sampled_at: str, metrics: Sequence[JsonObject]) -> None:
    conn.executemany(
        """
        INSERT INTO metric_points
        (captured_at, metric, category, label, value, unit, layer, instrumented, observed, status, source, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                sampled_at,
                metric["key"],
                metric["category"],
                metric["label"],
                metric["value"],
                metric["unit"],
                metric["layer"],
                int(metric["instrumented"]),
                int(metric["observed"]),
                metric["status"],
                metric["source"],
                json.dumps(metric["details"], sort_keys=True),
            )
            for metric in metrics
        ],
    )
    conn.commit()


def load_metric_history(conn: sqlite3.Connection) -> JsonObject:
    rows = conn.execute(
        """
        SELECT metric, captured_at, value, instrumented, observed, status
        FROM metric_points
        ORDER BY captured_at ASC, id ASC
        """
    ).fetchall()
    history: JsonObject = {}
    for metric, captured_at, value, instrumented, observed, status in rows:
        points = history.setdefault(metric, [])
        points.append(
            {
                "sampledAt": captured_at,
                "value": value,
                "instrumented": bool(instrumented),
                "observed": bool(observed),
                "status": status,
            }
        )
    return {key: points[-24:] for key, points in history.items()}


def remove_sqlite_sidecars(db_path: Path) -> None:
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(db_path) + suffix)
        if sidecar.exists():
            sidecar.unlink()


def fetch_github_snapshot(
    repo_root: Path,
    repo_full_name: str,
    project_owner: str,
    project_number: int,
) -> JsonObject:
    errors: list[JsonObject] = []

    issues_json, issue_error = run_json(
        [
            "gh",
            "issue",
            "list",
            "--repo",
            repo_full_name,
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "number,title,url,state,labels,milestone,updatedAt,createdAt",
        ],
        repo_root,
    )
    if issue_error:
        errors.append({"source": "issues", **issue_error})

    prs_json, pr_error = run_json(
        [
            "gh",
            "pr",
            "list",
            "--repo",
            repo_full_name,
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "number,title,url,state,labels,isDraft,reviewDecision,statusCheckRollup,updatedAt,createdAt",
        ],
        repo_root,
    )
    if pr_error:
        errors.append({"source": "pullRequests", **pr_error})

    project_json, project_error = run_json(
        ["gh", "project", "item-list", str(project_number), "--owner", project_owner, "--limit", "100", "--format", "json"],
        repo_root,
    )
    if project_error:
        project_json, project_error_alt = run_json(
            ["gh", "project", "item-list", str(project_number), "--owner", "@me", "--limit", "100", "--format", "json"],
            repo_root,
        )
        if project_error_alt:
            errors.append({"source": "project", **project_error})

    issues = [normalize_issue(item) for item in issues_json] if isinstance(issues_json, list) else []
    seeded_issue_count = 0
    if issue_error or not issues:
        issues, seeded_issue_count = merge_static_support_issues(issues, repo_full_name)
    pull_requests = [normalize_pull_request(item) for item in prs_json] if isinstance(prs_json, list) else []
    project_items = normalize_project_items(project_json)

    roadmap_cards = build_roadmap_cards(project_items, issues, pull_requests)
    kanban_cards = build_kanban_cards(project_items, issues, pull_requests)
    return {
        "fetched": not errors,
        "sourceMode": github_source_mode(errors, seeded_issue_count),
        "seededFallbackIssueCount": seeded_issue_count,
        "fetchErrors": errors,
        "issues": issues,
        "pullRequests": pull_requests,
        "projectItems": project_items,
        "roadmapCards": roadmap_cards,
        "kanban": {
            "columns": build_kanban_columns(kanban_cards),
            "cards": kanban_cards,
        },
        "processMetrics": build_process_metrics(issues, pull_requests, project_items, errors),
    }


def merge_static_support_issues(issues: Sequence[JsonObject], repo_full_name: str) -> tuple[list[JsonObject], int]:
    merged = [dict(issue) for issue in issues if issue]
    seen_numbers = {issue.get("number") for issue in merged}
    added = 0
    for issue in STATIC_SUPPORT_ISSUES:
        if issue["number"] in seen_numbers:
            continue
        seeded = dict(issue)
        seeded["url"] = f"https://github.com/{repo_full_name}/issues/{issue['number']}"
        seeded["seededFallback"] = True
        seeded.setdefault("createdAt", "")
        seeded.setdefault("updatedAt", "")
        merged.append(seeded)
        added += 1
    return merged, added


def github_source_mode(errors: Sequence[JsonObject], seeded_issue_count: int) -> str:
    if not errors:
        return "live"
    if seeded_issue_count:
        return "fallback"
    return "incomplete"


def normalize_issue(item: Any) -> JsonObject:
    if not isinstance(item, dict):
        return {}
    labels = labels_from(item.get("labels"))
    milestone = item.get("milestone") if isinstance(item.get("milestone"), dict) else {}
    return {
        "type": "Issue",
        "number": item.get("number"),
        "title": item.get("title") or "",
        "url": item.get("url") or "",
        "state": item.get("state") or "",
        "labels": labels,
        "milestone": milestone.get("title") or "",
        "status": infer_status_from_labels(labels),
        "priority": infer_priority(labels),
        "domain": infer_domain(labels, milestone.get("title") or "", item.get("title") or ""),
        "kind": infer_kind(labels),
        "updatedAt": item.get("updatedAt") or "",
        "createdAt": item.get("createdAt") or "",
    }


def normalize_pull_request(item: Any) -> JsonObject:
    if not isinstance(item, dict):
        return {}
    labels = labels_from(item.get("labels"))
    return {
        "type": "PullRequest",
        "number": item.get("number"),
        "title": item.get("title") or "",
        "url": item.get("url") or "",
        "state": item.get("state") or "",
        "labels": labels,
        "milestone": "",
        "status": "In review",
        "priority": infer_priority(labels),
        "domain": infer_domain(labels, "", item.get("title") or ""),
        "kind": "code",
        "isDraft": bool(item.get("isDraft")),
        "reviewDecision": item.get("reviewDecision"),
        "updatedAt": item.get("updatedAt") or "",
        "createdAt": item.get("createdAt") or "",
        "checks": summarize_checks(item.get("statusCheckRollup")),
    }


def normalize_project_items(payload: Any) -> list[JsonObject]:
    if not isinstance(payload, dict):
        return []
    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        return []
    return [normalize_project_item(item) for item in raw_items if isinstance(item, dict)]


def normalize_project_item(item: JsonObject) -> JsonObject:
    content = item.get("content") if isinstance(item.get("content"), dict) else {}
    labels = labels_from(item.get("labels") or content.get("labels"))
    title = item.get("title") or content.get("title") or ""
    milestone = normalize_milestone(item.get("milestone") or content.get("milestone"))
    status = str(item.get("Status") or item.get("status") or infer_status_from_labels(labels) or "Backlog")
    priority = str(item.get("Priority") or item.get("priority") or infer_priority(labels))
    domain = str(item.get("Domain") or item.get("domain") or infer_domain(labels, milestone, title))
    kind = str(item.get("Kind") or item.get("kind") or infer_kind(labels))
    return {
        "type": item.get("type") or content.get("type") or "",
        "number": item.get("number") or content.get("number"),
        "title": title,
        "url": item.get("url") or content.get("url") or "",
        "state": item.get("state") or content.get("state") or "",
        "labels": labels,
        "milestone": milestone,
        "status": status,
        "priority": priority,
        "domain": domain,
        "kind": kind,
        "evidence": str(item.get("Evidence") or item.get("evidence") or ""),
        "nextAction": str(item.get("Next action") or item.get("nextAction") or ""),
        "blockedBy": str(item.get("Blocked by") or item.get("blockedBy") or ""),
        "updatedAt": item.get("updatedAt") or content.get("updatedAt") or "",
    }


def labels_from(value: Any) -> list[str]:
    labels: list[str] = []
    if isinstance(value, list):
        for entry in value:
            if isinstance(entry, str):
                labels.append(entry)
            elif isinstance(entry, dict) and isinstance(entry.get("name"), str):
                labels.append(entry["name"])
    return sorted(set(labels))


def normalize_milestone(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("title") or "")
    if isinstance(value, str):
        return value
    return ""


def infer_status_from_labels(labels: Sequence[str]) -> str:
    joined = " ".join(labels).lower()
    if "blocked" in joined:
        return "Backlog"
    if "review" in joined:
        return "In review"
    return "Ready" if "roadmap" in joined else "Backlog"


def infer_priority(labels: Sequence[str]) -> str:
    joined = " ".join(labels).lower()
    for priority in ("p0", "p1", "p2"):
        if f"priority:{priority}" in joined or priority in joined.split():
            return priority.upper()
    return "P1"


def infer_kind(labels: Sequence[str]) -> str:
    for label in labels:
        if label.startswith("kind:"):
            return label.split(":", 1)[1]
    return "code"


def infer_domain(labels: Sequence[str], milestone: str, title: str) -> str:
    haystack = " ".join([*labels, milestone, title]).lower()
    if "agent" in haystack:
        return "Agent OS"
    if "change-control" in haystack or "ci" in haystack or "branch" in haystack:
        return "Change-control"
    if "private" in haystack or "smoke" in haystack:
        return "Private smoke"
    if "runtime" in haystack or "monitor" in haystack or "telemetry" in haystack:
        return "Runtime monitor"
    if "official" in haystack or "deploy" in haystack:
        return "Official MMO"
    if "docs" in haystack or "process" in haystack:
        return "Docs/process"
    return "Bot capability"


def summarize_checks(value: Any) -> JsonObject:
    if not isinstance(value, list):
        return {"total": 0, "success": 0, "failure": 0, "pending": 0}
    counts = {"total": len(value), "success": 0, "failure": 0, "pending": 0}
    for item in value:
        if not isinstance(item, dict):
            continue
        conclusion = str(item.get("conclusion") or item.get("state") or "").lower()
        if conclusion in {"success", "completed", "passed"}:
            counts["success"] += 1
        elif conclusion in {"failure", "error", "cancelled", "timed_out", "action_required"}:
            counts["failure"] += 1
        else:
            counts["pending"] += 1
    return counts


def build_roadmap_cards(project_items: Sequence[JsonObject], issues: Sequence[JsonObject], prs: Sequence[JsonObject]) -> list[JsonObject]:
    source_items = [item for item in project_items if is_roadmapish(item)]
    if not source_items:
        source_items = [item for item in issues if is_roadmapish(item)]
    if not source_items:
        source_items = list(prs[:6])

    cards = []
    for item in source_items:
        cards.append(
            {
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "type": item.get("type", ""),
                "number": item.get("number"),
                "status": item.get("status", "Backlog"),
                "priority": item.get("priority", "P1"),
                "domain": item.get("domain", "Bot capability"),
                "milestone": item.get("milestone", ""),
                "visionLayer": classify_vision_layer(item),
                "nextAction": item.get("nextAction", ""),
                "evidence": item.get("evidence", ""),
            }
        )
    return sorted(cards, key=roadmap_sort_key)[:12]


def build_kanban_cards(
    project_items: Sequence[JsonObject],
    issues: Sequence[JsonObject],
    pull_requests: Sequence[JsonObject],
) -> list[JsonObject]:
    source_items = list(project_items) or [*issues, *pull_requests]
    cards: list[JsonObject] = []
    for item in source_items:
        if not item.get("title"):
            continue
        vision_layer = classify_vision_layer(item)
        cards.append(
            {
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "type": item.get("type", ""),
                "number": item.get("number"),
                "status": normalize_status(item.get("status")),
                "priority": item.get("priority", "P1"),
                "domain": item.get("domain", "Bot capability"),
                "kind": item.get("kind", "code"),
                "visionLayer": vision_layer,
                "lane": "Gameplay" if vision_layer in {"territory", "resources", "enemy kills"} else "Foundation",
                "updatedAt": item.get("updatedAt", ""),
            }
        )
    return sorted(cards, key=kanban_sort_key)


def is_roadmapish(item: JsonObject) -> bool:
    haystack = " ".join([*(item.get("labels") or []), str(item.get("milestone") or ""), str(item.get("title") or "")]).lower()
    return "roadmap" in haystack or "phase" in haystack or "p0" in haystack


def classify_vision_layer(item: JsonObject) -> str:
    explicit = str(item.get("visionLayer") or "").strip()
    if explicit:
        return explicit
    haystack = " ".join(
        [
            str(item.get("title") or ""),
            str(item.get("domain") or ""),
            str(item.get("milestone") or ""),
            " ".join(item.get("labels") or []),
        ]
    ).lower()
    if any(word in haystack for word in ("territory", "expand", "expansion", "claim", "reserve", "remote", "controller", "room")):
        return "territory"
    if any(word in haystack for word in ("resource", "economy", "energy", "harvest", "storage", "market", "spawn", "worker")):
        return "resources"
    if any(word in haystack for word in ("combat", "enemy", "hostile", "kill", "attack", "defense", "tower", "rampart")):
        return "enemy kills"
    if any(word in haystack for word in ("gameplay evolution", "game-result", "vision-driven")):
        return "territory"
    if any(word in haystack for word in ("p0", "agent", "change-control", "ci", "monitor", "smoke", "deploy", "docs", "telemetry")):
        return "foundation blocker"
    return "foundation blocker"


def normalize_status(status: Any) -> str:
    text = str(status or "Backlog").strip()
    canonical = {
        "todo": "Ready",
        "in progress": "In progress",
        "in review": "In review",
        "review": "In review",
        "done": "Done",
        "ready": "Ready",
        "backlog": "Backlog",
    }
    return canonical.get(text.lower(), text)


def roadmap_sort_key(card: JsonObject) -> tuple[int, int, str]:
    priority_order = {"P0": 0, "P1": 1, "P2": 2}
    status_order = {"In progress": 0, "In review": 1, "Ready": 2, "Backlog": 3, "Done": 4}
    return (
        priority_order.get(str(card.get("priority")), 5),
        status_order.get(str(card.get("status")), 5),
        str(card.get("title", "")),
    )


def kanban_sort_key(card: JsonObject) -> tuple[str, int, int, str]:
    priority_order = {"P0": 0, "P1": 1, "P2": 2}
    status_order = {"In progress": 0, "In review": 1, "Ready": 2, "Backlog": 3, "Done": 4}
    return (
        str(card.get("lane", "")),
        status_order.get(str(card.get("status")), 5),
        priority_order.get(str(card.get("priority")), 5),
        str(card.get("title", "")),
    )


def build_kanban_columns(cards: Sequence[JsonObject]) -> list[JsonObject]:
    statuses = ["Backlog", "Ready", "In progress", "In review", "Done"]
    lanes = ["Gameplay", "Foundation"]
    return [
        {
            "lane": lane,
            "statuses": [
                {
                    "status": status,
                    "cards": [card for card in cards if card["lane"] == lane and card["status"] == status],
                }
                for status in statuses
            ],
        }
        for lane in lanes
    ]


def build_process_metrics(
    issues: Sequence[JsonObject],
    pull_requests: Sequence[JsonObject],
    project_items: Sequence[JsonObject],
    errors: Sequence[JsonObject],
) -> list[JsonObject]:
    blocked = [item for item in [*issues, *project_items] if "blocked" in " ".join(item.get("labels") or []).lower()]
    statuses = [normalize_status(item.get("status")) for item in project_items]
    status_counts = {status: statuses.count(status) for status in sorted(set(statuses))}
    return [
        {
            "label": "Open roadmap issues",
            "value": sum(1 for item in issues if is_roadmapish(item)),
            "instrumented": not errors,
        },
        {"label": "Open PRs", "value": len(pull_requests), "instrumented": not errors},
        {"label": "Blocked cards", "value": len(blocked), "instrumented": not errors},
        {"label": "Project cards", "value": len(project_items), "instrumented": not errors},
        {"label": "In progress", "value": status_counts.get("In progress", 0), "instrumented": not errors},
        {"label": "In review", "value": status_counts.get("In review", 0), "instrumented": not errors},
    ]


def build_page_data(
    generated_at: str,
    repo: JsonObject,
    runtime_report: JsonObject,
    metrics: Sequence[JsonObject],
    history: JsonObject,
    github_snapshot: JsonObject,
    docs_dir: Path,
) -> JsonObject:
    logo_path = docs_dir / "assets" / "screeps-community-logo.png"
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "title": PAGE_TITLE,
        "repo": repo,
        "assets": {
            "logo": "assets/screeps-community-logo.png" if logo_path.exists() else "",
        },
        "kpis": {
            "categories": [
                {
                    "key": category,
                    "label": label,
                    "accent": CATEGORY_ACCENTS[category],
                    "metrics": sorted(
                        [metric for metric in metrics if metric["category"] == category],
                        key=lambda metric: metric["priority"],
                    ),
                }
                for category, label in CATEGORY_LABELS.items()
            ],
            "history": history,
        },
        "runtimeReport": {
            "window": runtime_report.get("window", {}),
            "source": summarize_runtime_source(runtime_report.get("source")),
        },
        "github": github_snapshot,
    }


def summarize_runtime_source(source: Any) -> JsonObject:
    if not isinstance(source, dict):
        return {}
    return {
        "inputPaths": source.get("inputPaths", []),
        "matchedFiles": source.get("matchedFiles", 0),
        "runtimeSummaryLines": source.get("runtimeSummaryLines", 0),
        "scannedFiles": source.get("scannedFiles", 0),
        "skippedFileCount": source.get("skippedFileCount", 0),
        "reason": source.get("reason", ""),
    }


def render_html(data: JsonObject) -> str:
    title = esc(data["title"])
    repo = data["repo"]
    logo = data["assets"].get("logo") or ""
    logo_html = f'<img class="brand-logo" src="{esc(logo)}" alt="Screeps community logo">' if logo else ""
    generated_at = esc(data["generatedAt"])
    body = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
{render_css()}
  </style>
</head>
<body>
  <header class="poster">
    <div class="poster-copy">
      <p class="eyebrow">Screeps: World automation roadmap</p>
      <h1>{title}</h1>
      <p class="summary">A static Pages dashboard for the live roadmap: territory first, resource scale second, enemy-kill capability third, with reliability guardrails called out when evidence is missing.</p>
      <nav class="link-row" aria-label="Project links">
        <a href="{esc(repo['url'])}">GitHub repository</a>
        <a href="{esc(repo['projectUrl'])}">Project board</a>
        <a href="{esc(repo['screepsRoomUrl'])}">Target room</a>
        <a href="{esc(repo['discordUrl'])}">Discord</a>
        <a href="{esc(repo['pagesUrl'])}">Pages URL</a>
      </nav>
      <p class="published">Published {generated_at} from {esc(repo.get('branch') or 'unknown')} at {esc(repo.get('commit') or 'unknown')}</p>
    </div>
    {logo_html}
  </header>

  <main>
    {render_kpi_sections(data)}
    {render_github_source_notice(data)}
    {render_roadmap_cards(data)}
    {render_kanban(data)}
    {render_process_metrics(data)}
  </main>
</body>
</html>
"""
    return body


def render_css() -> str:
    return """
:root {
  color-scheme: light;
  --ink: #172026;
  --muted: #52616b;
  --paper: #f4f7f8;
  --surface: #ffffff;
  --line: #d7e0e5;
  --gold: #b7791f;
  --green: #18876f;
  --red: #b8433f;
  --blue: #2563a7;
  --shadow: 0 14px 34px rgba(23, 32, 38, 0.1);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.5;
}

a {
  color: inherit;
}

.poster {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 280px);
  align-items: center;
  gap: 36px;
  padding: clamp(28px, 5vw, 58px);
  border-bottom: 1px solid var(--line);
  background:
    linear-gradient(135deg, rgba(24, 135, 111, 0.12), rgba(37, 99, 167, 0.08)),
    var(--surface);
}

.poster-copy {
  max-width: 980px;
}

.eyebrow {
  margin: 0 0 12px;
  color: var(--green);
  font-size: 0.8rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1 {
  max-width: 980px;
  margin: 0;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(2.35rem, 5vw, 5.2rem);
  line-height: 1;
  letter-spacing: 0;
}

.summary {
  max-width: 760px;
  margin: 28px 0 0;
  color: #33434c;
  font-size: clamp(1rem, 1.5vw, 1.25rem);
}

.published {
  margin: 18px 0 0;
  color: var(--muted);
  font-size: 0.95rem;
}

.brand-logo {
  width: min(100%, 220px);
  justify-self: end;
  filter: drop-shadow(0 14px 30px rgba(23, 32, 38, 0.16));
}

.link-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 28px;
}

.link-row a,
.card-link {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 9px 13px;
  background: rgba(255, 255, 255, 0.82);
  color: var(--ink);
  font-size: 0.92rem;
  font-weight: 700;
  text-decoration: none;
}

main {
  padding: 42px clamp(18px, 4vw, 64px) 80px;
}

.section {
  margin: 0 auto 48px;
  max-width: 1320px;
}

.section-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 18px;
}

.section-header h2 {
  margin: 0;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(1.9rem, 3vw, 3rem);
  letter-spacing: 0;
}

.section-header p {
  max-width: 620px;
  margin: 0;
  color: var(--muted);
}

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 14px;
}

.metric-card,
.roadmap-card,
.kanban-card,
.process-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: var(--shadow);
}

.metric-card {
  min-height: 220px;
  padding: 18px;
}

.metric-top {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 14px;
}

.metric-label {
  margin: 0;
  color: var(--muted);
  font-size: 0.9rem;
  font-weight: 800;
}

.metric-value {
  margin: 10px 0 0;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(1.9rem, 4vw, 3.1rem);
  line-height: 1;
  overflow-wrap: anywhere;
}

.metric-unit {
  margin-top: 8px;
  color: var(--muted);
  font-size: 0.86rem;
}

.status {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  border-radius: 999px;
  padding: 4px 9px;
  color: #fff;
  font-size: 0.76rem;
  font-weight: 800;
  white-space: nowrap;
}

.status.observed {
  background: var(--green);
}

.status.not-observed {
  background: var(--blue);
}

.status.not-instrumented {
  background: var(--red);
}

.sparkline {
  width: 100%;
  height: 68px;
  margin-top: 18px;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
}

.roadmap-card {
  position: relative;
  min-height: 190px;
  padding: 18px;
}

.roadmap-card h3,
.kanban-card h4 {
  margin: 0;
  font-size: 1rem;
  line-height: 1.35;
}

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.pill {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 4px 8px;
  color: var(--muted);
  font-size: 0.78rem;
  font-weight: 700;
}

.card-link {
  display: inline-flex;
  margin-top: 18px;
}

.empty {
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 22px;
  color: var(--muted);
  background: rgba(255, 255, 255, 0.72);
}

.notice {
  border-left: 5px solid var(--blue);
  border-radius: 8px;
  padding: 16px 18px;
  background: #edf4f8;
  color: #2d3d46;
}

.notice strong {
  color: var(--ink);
}

.kanban-lane {
  margin-top: 24px;
}

.kanban-lane h3 {
  margin: 0 0 12px;
  color: var(--ink);
  font-size: 1.2rem;
}

.kanban-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(190px, 1fr));
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 6px;
}

.kanban-column {
  min-width: 190px;
  border-top: 3px solid var(--gold);
  padding-top: 10px;
}

.kanban-column-title {
  margin: 0 0 10px;
  color: var(--muted);
  font-size: 0.8rem;
  font-weight: 900;
  text-transform: uppercase;
}

.kanban-card {
  display: block;
  margin-bottom: 10px;
  padding: 12px;
  color: var(--ink);
  text-decoration: none;
  box-shadow: none;
}

.kanban-card h4 {
  font-size: 0.92rem;
}

.process-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.process-card {
  padding: 16px;
  box-shadow: none;
}

.process-value {
  margin: 0;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 2.4rem;
  line-height: 1;
  overflow-wrap: anywhere;
}

.process-value-text {
  font-family: inherit;
  font-size: 1rem;
  font-weight: 900;
  line-height: 1.25;
}

.process-label {
  margin: 8px 0 0;
  color: var(--muted);
  font-weight: 800;
}

@media (max-width: 760px) {
  .poster {
    min-height: auto;
    grid-template-columns: 1fr;
    gap: 28px;
  }

  .brand-logo {
    justify-self: start;
    width: 160px;
  }

  .section-header {
    display: block;
  }

  .section-header p {
    margin-top: 8px;
  }
}
"""


def render_kpi_sections(data: JsonObject) -> str:
    sections: list[str] = []
    history = data["kpis"]["history"]
    for category in data["kpis"]["categories"]:
        cards = "\n".join(render_metric_card(metric, history.get(metric["key"], []), category["accent"]) for metric in category["metrics"])
        sections.append(
            f"""
    <section class="section" id="kpi-{esc(category['key'])}">
      <div class="section-header">
        <h2>{esc(category['label'])}</h2>
        <p>{esc(kpi_category_summary(category['key']))}</p>
      </div>
      <div class="kpi-grid">
        {cards}
      </div>
    </section>
"""
        )
    return "\n".join(sections)


def render_github_source_notice(data: JsonObject) -> str:
    github = data.get("github")
    if not isinstance(github, dict) or github.get("fetched"):
        return ""

    errors = github.get("fetchErrors")
    sources = []
    if isinstance(errors, list):
        for error in errors:
            if isinstance(error, dict):
                source = str(error.get("source") or "GitHub")
                message = str(error.get("message") or "fetch unavailable")
                sources.append(f"{source}: {message}")
    detail = "; ".join(sources) if sources else "GitHub data was unavailable during this generator run."
    return f"""
    <section class="section">
      <div class="notice">
        <strong>GitHub snapshot fallback:</strong> {esc(detail)}
      </div>
    </section>
"""


def kpi_category_summary(category_key: str) -> str:
    summaries = {
        "territory": "Control, expansion, controller progress, and downgrade pressure remain the first-priority outcome surface.",
        "resources": "Economy metrics show whether territory is converting into stored energy, harvest flow, and spawn capacity.",
        "combat": "Combat metrics stay conservative: generic destroy counts are shown separately, while enemy_kills remains empty until ownership-aware evidence exists.",
        "guardrails": "Reliability metrics keep runtime health visible so short-term gains do not hide an unstable bot.",
    }
    return summaries[category_key]


def render_metric_card(metric: JsonObject, points: Sequence[JsonObject], accent: str) -> str:
    status_class = metric["status"].replace(" ", "-")
    return f"""
        <article class="metric-card">
          <div class="metric-top">
            <div>
              <p class="metric-label">{esc(metric['label'])}</p>
              <p class="metric-value">{esc(metric['formattedValue'])}</p>
            </div>
            <span class="status {esc(status_class)}">{esc(metric['status'])}</span>
          </div>
          <div class="metric-unit">{esc(metric['unit'])} · {esc(metric['source'])}</div>
          {render_sparkline(points, accent)}
        </article>
"""


def render_sparkline(points: Sequence[JsonObject], accent: str) -> str:
    observed = [point for point in points if point.get("observed") and isinstance(point.get("value"), (int, float))]
    if not observed:
        return """
          <svg class="sparkline" role="img" aria-label="No observed history yet" viewBox="0 0 240 68">
            <line x1="8" y1="36" x2="232" y2="36" stroke="#ded2c3" stroke-width="2" stroke-dasharray="5 5"/>
          </svg>
"""
    values = [float(point["value"]) for point in observed]
    min_value = min(values)
    max_value = max(values)
    span = max_value - min_value
    width = 224
    x_start = 8
    y_top = 10
    y_span = 46
    coords: list[tuple[float, float]] = []
    for index, value in enumerate(values):
        x = x_start + (width / max(1, len(values) - 1)) * index
        if span == 0:
            y = y_top + y_span / 2
        else:
            y = y_top + y_span - ((value - min_value) / span) * y_span
        coords.append((x, y))
    polyline = " ".join(f"{x:.1f},{y:.1f}" for x, y in coords)
    circles = "\n".join(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="{esc(accent)}"/>' for x, y in coords[-8:])
    return f"""
          <svg class="sparkline" role="img" aria-label="Metric history" viewBox="0 0 240 68">
            <line x1="8" y1="56" x2="232" y2="56" stroke="#ded2c3" stroke-width="1"/>
            <polyline fill="none" stroke="{esc(accent)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="{polyline}"/>
            {circles}
          </svg>
"""


def render_roadmap_cards(data: JsonObject) -> str:
    cards = data["github"]["roadmapCards"]
    if not cards:
        cards_html = '<div class="empty">No live GitHub roadmap cards were fetched during this generator run.</div>'
    else:
        cards_html = "\n".join(render_roadmap_card(card) for card in cards)
        cards_html = f'<div class="card-grid">{cards_html}</div>'
    return f"""
    <section class="section" id="roadmap">
      <div class="section-header">
        <h2>Roadmap Cards</h2>
        <p>Current roadmap work is linked to GitHub issues, pull requests, or Project items whenever a public URL is available.</p>
      </div>
      {cards_html}
    </section>
"""


def render_roadmap_card(card: JsonObject) -> str:
    link = render_card_link(card.get("url"))
    number = f"#{card['number']}" if card.get("number") else esc(card.get("type") or "Card")
    return f"""
        <article class="roadmap-card">
          <h3>{esc(card.get('title') or 'Untitled')}</h3>
          <div class="meta-row">
            <span class="pill">{esc(number)}</span>
            <span class="pill">{esc(card.get('priority') or 'P1')}</span>
            <span class="pill">{esc(card.get('status') or 'Backlog')}</span>
            <span class="pill">{esc(card.get('visionLayer') or 'foundation blocker')}</span>
          </div>
          <div class="meta-row">
            <span class="pill">{esc(card.get('domain') or 'Bot capability')}</span>
            <span class="pill">{esc(card.get('milestone') or 'No milestone')}</span>
          </div>
          {link}
        </article>
"""


def render_card_link(url: Any) -> str:
    if not isinstance(url, str) or not url:
        return ""
    return f'<a class="card-link" href="{esc(url)}">Open on GitHub</a>'


def render_kanban(data: JsonObject) -> str:
    columns = data["github"]["kanban"]["columns"]
    lanes_html = []
    for lane in columns:
        status_columns = []
        for status in lane["statuses"]:
            cards = status["cards"]
            cards_html = "\n".join(render_kanban_card(card) for card in cards) or '<div class="empty">No cards</div>'
            status_columns.append(
                f"""
          <div class="kanban-column">
            <p class="kanban-column-title">{esc(status['status'])}</p>
            {cards_html}
          </div>
"""
            )
        lanes_html.append(
            f"""
      <div class="kanban-lane">
        <h3>{esc(lane['lane'])}</h3>
        <div class="kanban-grid">
          {''.join(status_columns)}
        </div>
      </div>
"""
        )
    return f"""
    <section class="section" id="kanban">
      <div class="section-header">
        <h2>Gameplay / Foundation Kanban</h2>
        <p>Gameplay cards serve territory, resources, and enemy-kill outcomes; foundation cards keep the autonomous delivery system safe.</p>
      </div>
      {''.join(lanes_html)}
    </section>
"""


def render_kanban_card(card: JsonObject) -> str:
    number = f"#{card['number']}" if card.get("number") else card.get("type") or "Card"
    content = f"""
            <h4>{esc(card.get('title') or 'Untitled')}</h4>
            <div class="meta-row">
              <span class="pill">{esc(number)}</span>
              <span class="pill">{esc(card.get('priority') or 'P1')}</span>
              <span class="pill">{esc(card.get('visionLayer') or 'foundation blocker')}</span>
            </div>
"""
    url = card.get("url")
    if isinstance(url, str) and url:
        return f'<a class="kanban-card" href="{esc(url)}">{content}</a>'
    return f'<div class="kanban-card">{content}</div>'


def render_process_metrics(data: JsonObject) -> str:
    process_metrics = data["github"]["processMetrics"]
    rendered_cards = []
    for metric in process_metrics:
        instrumented = bool(metric.get("instrumented"))
        value = metric["value"] if instrumented else INSUFFICIENT_EVIDENCE
        value_class = "process-value" if instrumented else "process-value process-value-text"
        rendered_cards.append(
            f"""
        <article class="process-card">
          <p class="{value_class}">{esc(str(value))}</p>
          <p class="process-label">{esc(metric['label'])}</p>
        </article>
"""
        )
    cards = "\n".join(rendered_cards)
    return f"""
    <section class="section" id="process">
      <div class="section-header">
        <h2>Process Metrics</h2>
        <p>These numbers come from the current GitHub snapshot and are intentionally kept out of the SQLite KPI history.</p>
      </div>
      <div class="process-grid">
        {cards}
      </div>
    </section>
"""


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


if __name__ == "__main__":
    raise SystemExit(main())
