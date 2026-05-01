#!/usr/bin/env python3
"""Generate the static GitHub Pages roadmap report."""

from __future__ import annotations

import argparse
from copy import deepcopy
import html
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SCHEMA_VERSION = 1
DEFAULT_OWNER = "lanyusea"
DEFAULT_REPO = "screeps"
DEFAULT_PROJECT_NUMBER = 3
PAGE_TITLE = "Hermes Screeps Project Roadmap Report"
PAGES_URL = "https://lanyusea.github.io/screeps/"
GITHUB_PROJECT_URL = "https://github.com/users/lanyusea/projects/3"
SCREEPS_ROOM_URL_BASE = "https://screeps.com/a/#!/room"
# AGENTS.md official deployment target; generation env can override it.
OFFICIAL_SCREEPS_SHARD = "shardX"
OFFICIAL_SCREEPS_ROOM = "E26S49"
DISCORD_URL = "https://discord.gg/XenFZG9bCE"
LFS_POINTER_PREFIX = b"version https://git-lfs.github.com/spec/v1"
SCREEPS_SHARD_RE = re.compile(r"^[A-Za-z0-9_-]+$")
SCREEPS_ROOM_RE = re.compile(r"^[WE]\d+[NS]\d+$")
CJK_TEXT_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
INTERNAL_PROCESS_ID_RE = re.compile(r"\bproc_[a-z0-9]+\b")
HOST_ABSOLUTE_PATH_RE = re.compile(
    r"(?<![A-Za-z0-9_:/.-])/(?:root|home|Users|tmp|var|mnt|opt|Volumes)(?:/[^\s\"'<>`,;)]*)*"
)
WINDOWS_DRIVE_ROOT_PATH_RE = re.compile(r"(?<![A-Za-z0-9_:/.-])[A-Za-z]:[\\/][^\s\"'<>`,;)]*")
PUBLIC_CONTROLLER_TEXT_RE = re.compile(
    r"\b(?:scheduler dispatched|scheduler prompt|codex review-fix|review-fix task|"
    r"next scheduler action|reconcile codex|process_session|codex session|"
    r"controller workflow|controller evidence|controller diff-check|controller-side|controller qa|"
    r"operator-only|worktree|branch feat/|branch behind|local main fast-forwarded|remote/local branch)\b",
    re.IGNORECASE,
)
CACHED_SUFFIX_RE = re.compile(r"(?:\s*·\s*cached)+\s*$")

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
        "domain": "Docs/process",
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


@dataclass(frozen=True)
class OfficialDeployEvidenceRecord:
    path: Path
    timestamp: datetime | None
    commit: str
    run_id: str


@dataclass(frozen=True)
class OfficialDeployEvidenceSummary:
    count: int
    latest: OfficialDeployEvidenceRecord | None = None


@dataclass(frozen=True)
class CodexSessionMetrics:
    session_count: int
    token_session_count: int
    timed_session_count: int
    total_tokens: int | None
    elapsed_seconds: int | None
    unreadable_count: int


@dataclass(frozen=True)
class AutomationRunMetrics:
    run_count: int
    job_count: int
    available: bool


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

PROJECT_DOMAIN_ORDER: tuple[str, ...] = (
    "Agent OS",
    "Change-control",
    "Runtime monitor",
    "Release/deploy",
    "Bot capability",
    "Combat",
    "Territory/Economy",
    "Gameplay Evolution",
    "RL flywheel",
    "Docs/process",
)

REPORT_ROADMAP_DOMAIN_ORDER: tuple[str, ...] = tuple(
    domain for domain in PROJECT_DOMAIN_ORDER if domain != "Docs/process"
)

PROJECT_DOMAIN_FIELD_KEYS: tuple[str, ...] = (
    "Project Domain",
    "projectDomain",
    "project_domain",
    "Domain",
)

PROJECT_DOMAIN_GOALS: dict[str, str] = {
    "Agent OS": "Keep autonomous scheduling, routing, review, and handoff operations healthy.",
    "Change-control": "Keep repository, PR, Project, and release governance enforceable.",
    "Runtime monitor": "Turn live Screeps telemetry into reliable KPI, alert, and report evidence.",
    "Release/deploy": "Validate, deploy, and observe accepted changes across private smoke and official MMO gates.",
    "Bot capability": "Ship general gameplay behavior that advances the bot beyond single-slice fixes.",
    "Combat": "Protect survival, hostile response, and defense/combat readiness.",
    "Territory/Economy": "Advance expansion, controller pressure, worker efficiency, and resource throughput.",
    "Gameplay Evolution": "Convert game-result evidence into accepted roadmap, release, and strategy decisions.",
    "RL flywheel": "Drive offline/simulator/data/training/validation work for safe strategy self-evolution.",
    "Docs/process": "Preserve decisions, rules, and operating context for agent continuity.",
}

CST = timezone(timedelta(hours=8), "CST")
REPORT_FORMAT = "roadmap-portrait-kpi-kanban-v5"
APPROVED_REPORT_MODEL_ID = REPORT_FORMAT
STALE_VISIBLE_REPORT_MARKERS: tuple[str, ...] = ("pr #70",)
OFFICIAL_DEPLOY_EVIDENCE_DIR = Path("runtime-artifacts") / "official-screeps-deploy"
OFFICIAL_DEPLOY_EVIDENCE_PATTERNS: tuple[str, ...] = (
    "official-screeps-deploy.json",
    "official-screeps-deploy-*.json",
)
CODEX_SESSION_ROOT = Path("/root/.codex/sessions")
CODEX_SESSION_PATTERN = "rollout-*.jsonl"
HERMES_CRON_OUTPUT_ROOT = Path("/root/.hermes/cron/output")

KPI_DATES: tuple[str, ...] = ("4/21", "4/22", "4/23", "4/24", "4/25", "4/26", "4/27")

# Owner-approved presentation contract from Discord message/image 1498175235797811291.
# The visible Pages report is intentionally narrower than the SQLite/JSON data layer:
# exactly three in-game KPI cards plus the v5 roadmap/Kanban/process sections.
# build_approved_report_model() enriches this contract with live history, issue URLs,
# current repo metadata, and fetch status without adding extra visible dashboard cards.
REPORT_KPI_CARDS: tuple[JsonObject, ...] = (
    {
        "key": "territory",
        "title": "Territory",
        "subtitle": "owned rooms · RCL · room gain",
        "pill": "rooms/RCL",
        "ticks": (0, 1.5, 3),
        "max": 3,
        "series": (
            {"label": "Owned rooms", "values": (None, None, None, None, None, None, None), "color": "#9f6a3a", "width": 4},
            {"label": "RCL", "values": (None, None, None, None, None, None, None), "color": "#77716a", "width": 4},
            {"label": "Room gain", "values": (None, None, None, None, None, None, None), "color": "#c8945a", "width": 3, "dash": "6 6"},
        ),
        "footer": "7d history is still being connected; current points come from official room monitor and Project evidence.",
    },
    {
        "key": "resources",
        "title": "Resources",
        "subtitle": "stored energy · harvest delta · carried energy",
        "pill": "energy",
        "ticks": (0, 0.5, 1),
        "max": 1,
        "series": (
            {"label": "Stored energy", "values": (None, None, None, None, None, None, None), "color": "#25211c", "width": 2},
            {"label": "Harvest delta", "values": (None, None, None, None, None, None, None), "color": "#66605a", "width": 2},
            {"label": "Worker carried", "values": (None, None, None, None, None, None, None), "color": "#c8945a", "width": 3, "dash": "6 6"},
        ),
        "footer": "PR #65 added resource fields; reducer and 7d aggregation remain part of #29.",
    },
    {
        "key": "combat",
        "title": "Combat",
        "subtitle": "enemy kills · hostile count · own loss",
        "pill": "events",
        "ticks": (0, 0.5, 1),
        "max": 1,
        "series": (
            {"label": "Enemy kills", "values": (None, None, None, None, None, None, None), "color": "#25211c", "width": 2},
            {"label": "Hostiles seen", "values": (None, None, None, None, None, None, None), "color": "#77716a", "width": 4},
            {"label": "Own loss", "values": (None, None, None, None, None, None, None), "color": "#c8945a", "width": 3, "dash": "6 6"},
        ),
        "footer": "Kill/loss 7d reducers are not connected yet; the current hostile monitor reports no alerts.",
    },
)

REPORT_KPI_SERIES_METRICS: dict[str, tuple[str, ...]] = {
    "territory": ("owned_rooms", "controller_level_sum", "owned_room_delta"),
    "resources": ("stored_energy", "harvested_energy", "worker_carried_energy"),
    "combat": ("enemy_kills", "hostile_creeps", "own_losses"),
}

APPROVED_PRIVATE_SMOKE_PROCESS_COUNT = 1

REPORT_ISSUE_DISPLAY_OVERRIDES: dict[int, JsonObject] = {
    26: {
        "title": "Main branch protection and required CI gate",
        "description": "Keep required checks and merge gates enforceable before bot changes land.",
    },
    27: {
        "title": "P0 monitoring and Discord route health",
        "description": "Keep watch-only P0 monitor evidence current.",
    },
    28: {
        "title": "Private smoke harness clean live rerun",
        "description": "Run a clean private-server smoke check and publish redacted evidence.",
    },
    29: {
        "title": "Runtime summary and alert scheduled monitor delivery",
        "description": "Persist runtime-summary lines, reduce KPI evidence, and deliver scheduled monitor reports.",
    },
    30: {
        "title": "Mock harness multi-tick spawn lifecycle",
        "description": "Cover spawn.spawning lifecycle behavior across multiple simulated ticks.",
    },
    31: {
        "title": "Zero-creep emergency recovery coverage",
        "description": "Confirm worker recovery when creeps are gone or energy is insufficient.",
    },
    32: {
        "title": "Alert-level telemetry from private smoke failures",
        "description": "Backfill alert telemetry based on private-smoke failure modes.",
    },
    33: {
        "title": "Official MMO deployment blocked by private smoke gate",
        "description": "Hold official deploys until private-smoke and monitor proof are complete.",
    },
    59: {
        "title": "Gameplay Evolution: game-result review to roadmap loop",
        "description": "Use game-result evidence to drive roadmap, task, and release updates.",
    },
    60: {
        "title": "Gameplay review cadence",
        "description": "Keep game-result review evidence tied to roadmap decisions.",
    },
    61: {
        "title": "Runtime KPI artifact bridge",
        "description": "Bridge runtime KPI artifacts into the Pages report data flow.",
    },
    62: {
        "title": "Tactical emergency response wiring",
        "description": "Connect alert signals to bounded tactical emergency triage.",
    },
    63: {
        "title": "Gameplay release cadence and emergency hotfix evidence",
        "description": "Record expected KPI movement and proof for gameplay releases and hotfixes.",
    },
    75: {
        "title": "Pages roadmap visual fidelity follow-up",
        "description": "Refine the public roadmap report presentation and English visible copy.",
    },
    77: {
        "title": "Roadmap report public artifact polish",
        "description": "Polish the generated roadmap page and publish sanitized public artifacts.",
    },
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
    cached_page_data = load_cached_page_data(docs_dir / "roadmap-data.json")
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
        cached_snapshot=cached_page_data.get("github") if isinstance(cached_page_data.get("github"), dict) else None,
    )
    repo_snapshot = build_repo_snapshot(repo_full_name)
    data = build_page_data(
        generated_at=generated_at,
        repo=repo_snapshot,
        runtime_report=runtime_report,
        metrics=metrics,
        history=history,
        github_snapshot=github_snapshot,
        docs_dir=docs_dir,
        repo_root=repo_root,
        cached_page_data=cached_page_data,
    )
    data = sanitize_public_data(data)

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


def load_cached_page_data(json_path: Path) -> JsonObject:
    if not json_path.exists():
        return {}
    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


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


def sanitize_public_data(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: sanitize_public_data(item) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize_public_data(item) for item in value]
    if isinstance(value, tuple):
        return [sanitize_public_data(item) for item in value]
    if isinstance(value, str):
        return sanitize_public_text(value)
    return value


def sanitize_public_text(value: str) -> str:
    text = INTERNAL_PROCESS_ID_RE.sub("proc_[redacted]", value)
    text = HOST_ABSOLUTE_PATH_RE.sub("[redacted-path]", text)
    text = WINDOWS_DRIVE_ROOT_PATH_RE.sub("[redacted-path]", text)
    if "[redacted-path]" in text or PUBLIC_CONTROLLER_TEXT_RE.search(text):
        return ""
    return text


def public_visible_report_text(value: Any) -> str:
    text = sanitize_public_text(str(value or "")).strip()
    if not text or has_stale_visible_report_marker(text) or has_cjk_text(text):
        return ""
    return text


def build_repo_snapshot(repo_full_name: str) -> JsonObject:
    return {
        "fullName": repo_full_name,
        "url": f"https://github.com/{repo_full_name}",
        "pagesUrl": PAGES_URL,
        "projectUrl": GITHUB_PROJECT_URL,
        "screepsRoom": build_screeps_room_target(),
        "discordUrl": DISCORD_URL,
    }


def build_screeps_room_target(environ: Mapping[str, str] | None = None) -> JsonObject:
    env = os.environ if environ is None else environ
    shard, shard_source = config_value(env, "SCREEPS_SHARD", OFFICIAL_SCREEPS_SHARD)
    room, room_source = config_value(env, "SCREEPS_ROOM", OFFICIAL_SCREEPS_ROOM)
    sources = {"shard": shard_source, "room": room_source}

    if not shard or not room:
        return {
            "status": "unknown",
            "shard": shard,
            "room": room,
            "url": "",
            "label": "unknown",
            "sources": sources,
            "message": "Set SCREEPS_SHARD and SCREEPS_ROOM to publish a target room link.",
        }
    if not SCREEPS_SHARD_RE.fullmatch(shard) or not SCREEPS_ROOM_RE.fullmatch(room):
        return {
            "status": "unknown",
            "shard": shard,
            "room": room,
            "url": "",
            "label": f"{shard}/{room}",
            "sources": sources,
            "message": "SCREEPS_SHARD or SCREEPS_ROOM is not a valid Screeps room selector.",
        }

    status = "configured" if "environment" in {shard_source, room_source} else "official target"
    message = (
        "Target room from SCREEPS_SHARD and SCREEPS_ROOM with the AGENTS.md official target as fallback."
        if status == "configured"
        else "Target room from the AGENTS.md official deployment target."
    )
    return {
        "status": status,
        "shard": shard,
        "room": room,
        "url": f"{SCREEPS_ROOM_URL_BASE}/{shard}/{room}",
        "label": f"{shard}/{room}",
        "sources": sources,
        "message": message,
    }


def config_value(environ: Mapping[str, str], key: str, default: str) -> tuple[str, str]:
    value = str(environ.get(key) or "").strip()
    if value:
        return value, "environment"
    fallback = default.strip()
    if fallback:
        return fallback, "AGENTS.md official target"
    return "", "unknown"


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
    cached_snapshot: JsonObject | None = None,
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
        ["gh", "project", "item-list", str(project_number), "--owner", project_owner, "--limit", "500", "--format", "json"],
        repo_root,
    )
    if project_error:
        errors.append({"source": "project", **project_error})

    used_cache = False
    issues = [normalize_issue(item) for item in issues_json] if isinstance(issues_json, list) else []
    if issue_error and cached_snapshot is not None:
        cached_issues = cached_github_collection(cached_snapshot, "issues")
        if cached_issues:
            issues = cached_issues
            used_cache = True
    seeded_issue_count = 0
    if issue_error or not issues:
        issues, seeded_issue_count = merge_static_support_issues(issues, repo_full_name)
    pull_requests = [normalize_pull_request(item) for item in prs_json] if isinstance(prs_json, list) else []
    if pr_error and cached_snapshot is not None:
        cached_prs = cached_github_collection(cached_snapshot, "pullRequests")
        if cached_prs:
            pull_requests = cached_prs
            used_cache = True
    project_items = normalize_project_items(project_json)
    if project_error and cached_snapshot is not None:
        cached_project_items = cached_github_collection(cached_snapshot, "projectItems")
        if cached_project_items:
            project_items = cached_project_items
            used_cache = True

    roadmap_cards = build_roadmap_cards(project_items, issues, pull_requests)
    kanban_cards = build_kanban_cards(project_items, issues, pull_requests)
    return {
        "fetched": not errors,
        "sourceMode": github_source_mode(errors, seeded_issue_count, used_cache),
        "usedCachedSnapshot": used_cache,
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


def cached_github_collection(cached_snapshot: JsonObject, key: str) -> list[JsonObject]:
    value = cached_snapshot.get(key)
    if not isinstance(value, list):
        return []
    return [dict(item) for item in value if isinstance(item, dict)]


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


def github_source_mode(errors: Sequence[JsonObject], seeded_issue_count: int, used_cache: bool) -> str:
    if not errors:
        return "live"
    if used_cache:
        return "cached"
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
        "domainSource": "heuristic",
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
        "domainSource": "heuristic",
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
    explicit_domain = project_domain(item)
    domain = explicit_domain or infer_domain(labels, milestone, title)
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
        "projectDomain": explicit_domain,
        "domainSource": "project" if explicit_domain else "heuristic",
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
    if "rl" in haystack or "reinforcement" in haystack or "flywheel" in haystack:
        return "RL flywheel"
    if "gameplay evolution" in haystack or "strategy" in haystack or "retrospective" in haystack:
        return "Gameplay Evolution"
    if "combat" in haystack or "defense" in haystack or "hostile" in haystack:
        return "Combat"
    if "territory" in haystack or "expansion" in haystack or "economy" in haystack or "worker" in haystack or "resource" in haystack:
        return "Territory/Economy"
    if "private" in haystack or "smoke" in haystack or "official" in haystack or "deploy" in haystack or "release" in haystack:
        return "Release/deploy"
    if "runtime" in haystack or "monitor" in haystack or "telemetry" in haystack:
        return "Runtime monitor"
    if "docs" in haystack or "process" in haystack:
        return "Docs/process"
    return "Bot capability"


def canonical_project_domain(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    by_lower = {domain.lower(): domain for domain in PROJECT_DOMAIN_ORDER}
    aliases = {
        "private smoke": "Release/deploy",
        "official mmo": "Release/deploy",
        "official deploy": "Release/deploy",
        "release": "Release/deploy",
        "deploy": "Release/deploy",
        "territory": "Territory/Economy",
        "economy": "Territory/Economy",
        "resources": "Territory/Economy",
        "strategy/rl": "RL flywheel",
        "rl strategy": "RL flywheel",
    }
    return by_lower.get(raw.lower(), aliases.get(raw.lower(), ""))


def project_domain(item: Mapping[str, Any]) -> str:
    saw_explicit_field = False
    for key in PROJECT_DOMAIN_FIELD_KEYS:
        if str(item.get(key) or "").strip():
            saw_explicit_field = True
        matched = canonical_project_domain(item.get(key))
        if matched:
            return matched
    if saw_explicit_field:
        return ""

    source = str(item.get("domainSource") or item.get("domain_source") or "").strip().lower()
    if source != "heuristic":
        return canonical_project_domain(item.get("domain"))
    return ""


def domain_order_index(domain: str) -> int:
    try:
        return PROJECT_DOMAIN_ORDER.index(domain)
    except ValueError:
        return len(PROJECT_DOMAIN_ORDER)


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
        override = report_issue_display_override(item.get("number"))
        title = first_visible_report_text(override.get("title"), item.get("title"), item.get("domain"), "Roadmap item")
        if override.get("description"):
            next_action = first_visible_report_text(override.get("description"))
            evidence = ""
        else:
            next_action = first_visible_report_text(item.get("nextAction"))
            evidence = first_visible_report_text(item.get("evidence"))
        cards.append(
            {
                "title": title,
                "url": item.get("url", ""),
                "type": item.get("type", ""),
                "number": item.get("number"),
                "status": item.get("status", "Backlog"),
                "priority": item.get("priority", "P1"),
                "domain": item.get("domain", "Bot capability"),
                "projectDomain": project_domain(item),
                "domainSource": item.get("domainSource", ""),
                "milestone": item.get("milestone", ""),
                "visionLayer": classify_vision_layer(item),
                "nextAction": next_action,
                "evidence": evidence,
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
        override = report_issue_display_override(item.get("number"))
        title = first_visible_report_text(override.get("title"), item.get("title"), item.get("domain"), "Roadmap item")
        if override.get("description"):
            next_action = first_visible_report_text(override.get("description"))
            evidence = ""
        else:
            next_action = first_visible_report_text(item.get("nextAction"))
            evidence = first_visible_report_text(item.get("evidence"))
        cards.append(
            {
                "title": title,
                "url": item.get("url", ""),
                "type": item.get("type", ""),
                "number": item.get("number"),
                "status": normalize_status(item.get("status")),
                "priority": item.get("priority", "P1"),
                "domain": item.get("domain", "Bot capability"),
                "projectDomain": project_domain(item),
                "domainSource": item.get("domainSource", ""),
                "kind": item.get("kind", "code"),
                "visionLayer": vision_layer,
                "lane": project_domain(item),
                "nextAction": next_action,
                "evidence": evidence,
                "state": item.get("state", ""),
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


def kanban_sort_key(card: JsonObject) -> tuple[int, int, int, str]:
    priority_order = {"P0": 0, "P1": 1, "P2": 2}
    status_order = {"In progress": 0, "In review": 1, "Ready": 2, "Backlog": 3, "Done": 4}
    return (
        domain_order_index(str(card.get("domain") or card.get("lane") or "")),
        status_order.get(str(card.get("status")), 5),
        priority_order.get(str(card.get("priority")), 5),
        str(card.get("title", "")),
    )


def build_kanban_columns(cards: Sequence[JsonObject]) -> list[JsonObject]:
    statuses = ["Backlog", "Ready", "In progress", "In review", "Done"]
    return [
        {
            "lane": domain,
            "domain": domain,
            "statuses": [
                {
                    "status": status,
                    "cards": [card for card in cards if project_domain(card) == domain and card["status"] == status],
                }
                for status in statuses
            ],
        }
        for domain in PROJECT_DOMAIN_ORDER
    ]


def build_process_metrics(
    issues: Sequence[JsonObject],
    pull_requests: Sequence[JsonObject],
    project_items: Sequence[JsonObject],
    errors: Sequence[JsonObject],
) -> list[JsonObject]:
    failed_sources = {str(error.get("source") or "") for error in errors if isinstance(error, dict)}
    issues_ok = "issues" not in failed_sources
    prs_ok = "pullRequests" not in failed_sources
    project_ok = "project" not in failed_sources
    blocked = [item for item in [*issues, *project_items] if "blocked" in " ".join(item.get("labels") or []).lower()]
    statuses = [normalize_status(item.get("status")) for item in project_items]
    status_counts = {status: statuses.count(status) for status in sorted(set(statuses))}
    return [
        {
            "label": "Open roadmap issues",
            "value": sum(1 for item in issues if is_roadmapish(item)) if issues_ok else INSUFFICIENT_EVIDENCE,
            "instrumented": issues_ok,
        },
        {"label": "Open PRs", "value": len(pull_requests) if prs_ok else INSUFFICIENT_EVIDENCE, "instrumented": prs_ok},
        {
            "label": "Blocked cards",
            "value": len(blocked) if issues_ok or project_ok else INSUFFICIENT_EVIDENCE,
            "instrumented": issues_ok or project_ok,
        },
        {
            "label": "Project cards",
            "value": len(project_items) if project_ok else INSUFFICIENT_EVIDENCE,
            "instrumented": project_ok,
        },
        {
            "label": "In progress",
            "value": status_counts.get("In progress", 0) if project_ok else INSUFFICIENT_EVIDENCE,
            "instrumented": project_ok,
        },
        {
            "label": "In review",
            "value": status_counts.get("In review", 0) if project_ok else INSUFFICIENT_EVIDENCE,
            "instrumented": project_ok,
        },
    ]


def build_page_data(
    generated_at: str,
    repo: JsonObject,
    runtime_report: JsonObject,
    metrics: Sequence[JsonObject],
    history: JsonObject,
    github_snapshot: JsonObject,
    docs_dir: Path,
    repo_root: Path,
    cached_page_data: JsonObject | None = None,
) -> JsonObject:
    logo_path = docs_dir / "assets" / "screeps-community-logo.png"
    return {
        "schemaVersion": SCHEMA_VERSION,
        "format": REPORT_FORMAT,
        "generatedAt": generated_at,
        "generatedAtCst": format_cst(generated_at),
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
        "report": build_approved_report_model(
            generated_at,
            history,
            github_snapshot,
            repo_root,
            repo,
            cached_page_data or {},
        ),
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


def build_approved_report_model(
    generated_at: str,
    history: JsonObject,
    github_snapshot: JsonObject,
    repo_root: Path,
    repo: JsonObject,
    cached_page_data: JsonObject,
) -> JsonObject:
    return {
        "id": APPROVED_REPORT_MODEL_ID,
        "contract": (
            "Owner-approved roadmap-portrait-kpi-kanban-v5 presentation contract from "
            "Discord message/image 1498175235797811291."
        ),
        "kpiCards": build_report_kpi_cards(history, generated_at),
        "roadmapCards": build_report_roadmap_cards(github_snapshot, repo),
        "domainKanban": build_report_domain_kanban(github_snapshot),
        "processCards": build_report_process_cards(repo_root, repo, github_snapshot, cached_page_data),
    }


def build_report_kpi_cards(history: JsonObject, generated_at: str) -> list[JsonObject]:
    buckets = report_kpi_date_buckets(history, generated_at)
    cards = [deepcopy(card) for card in REPORT_KPI_CARDS]
    for card in cards:
        key = str(card.get("key") or "")
        metric_keys = REPORT_KPI_SERIES_METRICS.get(key, ())
        series_items = card.get("series", ())
        card["dates"] = [format_report_date(bucket) for bucket in buckets]
        enriched_series = []
        for index, series in enumerate(series_items):
            enriched = dict(series)
            if index < len(metric_keys):
                metric_key = metric_keys[index]
                enriched["metric"] = metric_key
                values, statuses = metric_history_values(history, metric_key, buckets)
                enriched["values"] = values
                enriched["statuses"] = statuses
            enriched_series.append(enriched)
        card["series"] = enriched_series
        normalize_report_chart_bounds(card)
        card["footer"] = report_kpi_footer(card)
    return cards


def report_kpi_date_buckets(history: JsonObject, generated_at: str) -> list[date]:
    latest = parse_timestamp(generated_at) or datetime.now(timezone.utc)
    for points in history.values():
        if not isinstance(points, list):
            continue
        for point in points:
            if not isinstance(point, dict):
                continue
            sampled_at = parse_timestamp(str(point.get("sampledAt") or ""))
            if sampled_at and sampled_at > latest:
                latest = sampled_at
    latest_day = latest.astimezone(CST).date()
    return [latest_day - timedelta(days=offset) for offset in range(6, -1, -1)]


def format_report_date(value: date) -> str:
    return f"{value.month}/{value.day}"


def parse_timestamp(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def metric_history_values(history: JsonObject, metric_key: str, buckets: Sequence[date]) -> tuple[list[int | float | None], list[str]]:
    points = history.get(metric_key)
    if not isinstance(points, list):
        return [None for _ in buckets], ["missing" for _ in buckets]

    latest_by_day: dict[date, JsonObject] = {}
    for point in points:
        if not isinstance(point, dict):
            continue
        sampled_at = parse_timestamp(str(point.get("sampledAt") or ""))
        if sampled_at is None:
            continue
        latest_by_day[sampled_at.astimezone(CST).date()] = point

    values: list[int | float | None] = []
    statuses: list[str] = []
    for bucket in buckets:
        point = latest_by_day.get(bucket)
        if point is None:
            values.append(None)
            statuses.append("missing")
            continue
        status = str(point.get("status") or "missing")
        statuses.append(status)
        if point.get("observed"):
            values.append(chart_number(point.get("value")))
        else:
            values.append(None)
    return values, statuses


def chart_number(value: Any) -> int | float | None:
    number = as_number(value)
    if number is None:
        return None
    if float(number).is_integer():
        return int(number)
    return number


def normalize_report_chart_bounds(card: JsonObject) -> None:
    highest = 0.0
    for series in card.get("series", ()):
        if not isinstance(series, dict):
            continue
        for value in series.get("values", ()):
            number = chart_number(value)
            if number is not None:
                highest = max(highest, float(number))
    current_max = max(float(card.get("max") or 1), 1.0)
    if highest <= current_max:
        return
    next_max = nice_chart_max(highest)
    card["max"] = next_max
    card["ticks"] = (0, next_max / 2, next_max)


def nice_chart_max(value: float) -> int | float:
    magnitude = 10 ** math.floor(math.log10(max(value, 1)))
    return math.ceil(value / magnitude) * magnitude


def report_kpi_footer(card: JsonObject) -> str:
    observed_count = sum(
        1
        for series in card.get("series", ())
        if isinstance(series, dict)
        for value in series.get("values", ())
        if chart_number(value) is not None
    )
    if card.get("key") == "combat":
        if observed_count == 0:
            return "Enemy-kill ownership data is unavailable; generic creepDestroyed is not counted as kills."
        return "Combat series uses ownership-aware values only; missing buckets are left blank."
    if observed_count == 0:
        return "No observed runtime KPI history yet; missing buckets stay blank until persisted summaries exist."
    return "Series values come from stored KPI history; missing buckets are left blank."


def build_report_roadmap_cards(github_snapshot: JsonObject, repo: JsonObject) -> list[JsonObject]:
    items = report_domain_source_items(github_snapshot)
    items_by_domain = {
        domain: sorted(
            [item for item in items if project_domain(item) == domain],
            key=domain_item_sort_key,
        )
        for domain in REPORT_ROADMAP_DOMAIN_ORDER
    }
    return [
        build_report_domain_card(domain, items_by_domain[domain], repo, github_snapshot)
        for domain in REPORT_ROADMAP_DOMAIN_ORDER
    ]


def report_domain_source_items(github_snapshot: JsonObject) -> list[JsonObject]:
    issue_lookup = build_issue_context_lookup(github_snapshot)
    for collection_name in ("projectItems", "roadmapCards", "issues", "pullRequests"):
        collection = github_snapshot.get(collection_name)
        if not isinstance(collection, list):
            continue
        items = [
            merge_issue_context(dict(item), issue_lookup)
            for item in collection
            if isinstance(item, dict) and (item.get("title") or item.get("domain"))
        ]
        if items:
            return items
    return []


def roadmap_item_haystack(item: JsonObject) -> str:
    return " ".join(
        str(item.get(key) or "")
        for key in ("title", "domain", "milestone", "visionLayer", "status", "priority")
    ).lower()


def item_key(item: JsonObject) -> tuple[str, str]:
    return (str(item.get("type") or ""), str(item.get("number") or item.get("title") or ""))


def merge_issue_context(item: JsonObject, issue_lookup: Mapping[int, JsonObject]) -> JsonObject:
    number = item.get("number")
    if not isinstance(number, int):
        return dict(item)
    context = issue_lookup.get(number, {})
    return {**context, **item}


def build_report_domain_card(
    domain: str,
    items: Sequence[JsonObject],
    repo: JsonObject,
    github_snapshot: JsonObject,
) -> JsonObject:
    total = len(items)
    done = sum(1 for item in items if is_done_item(item))
    active_items = [item for item in items if not is_done_item(item)]
    representative = active_items[0] if active_items else (items[0] if items else None)
    card = {
        "title": domain,
        "domain": domain,
        "goal": PROJECT_DOMAIN_GOALS[domain],
        "next": "No current GitHub/Project evidence available.",
        "progress": None,
        "status": github_unavailable_text(github_snapshot),
        "url": repo.get("projectUrl") or repo.get("url") or "",
        "totalItems": total,
        "activeItems": len(active_items),
        "doneItems": done,
    }
    if total == 0:
        return card

    card["progress"] = int(round((done / total) * 100))
    card["status"] = report_domain_status(domain, total, len(active_items), done, github_snapshot)
    item = representative or {}
    item_url = item.get("url") if isinstance(item, dict) else ""
    if isinstance(item_url, str) and item_url:
        card["url"] = item_url
    if active_items:
        card["next"] = shorten_text(report_domain_item_summary(active_items[0]), 96)
    else:
        card["next"] = shorten_text(report_domain_item_summary(item, prefix="No active item; latest tracked"), 96)
    return card


def report_domain_status(
    domain: str,
    total: int,
    active: int,
    done: int,
    github_snapshot: JsonObject,
) -> str:
    suffix = ""
    if github_snapshot.get("sourceMode") != "live":
        suffix = f" · {github_snapshot.get('sourceMode') or 'snapshot'}"
    item_word = "item" if total == 1 else "items"
    return f"{total} Project {item_word} · {active} active · {done} done{suffix}"


def report_domain_item_summary(item: JsonObject, prefix: str = "Current") -> str:
    number = f"#{item['number']} " if isinstance(item.get("number"), int) else ""
    status = normalize_status(item.get("status"))
    override = report_issue_display_override(item.get("number"))
    description = first_visible_report_text(
        override.get("description"),
        item.get("nextAction"),
        item.get("evidence"),
        item.get("title"),
        project_domain(item),
        "Track Project evidence and next action.",
    )
    return f"{prefix}: {number}{status} - {description}"


def is_done_item(item: Mapping[str, Any]) -> bool:
    state = str(item.get("state") or "").upper()
    return state in {"CLOSED", "MERGED"} or normalize_status(item.get("status")) == "Done"


def domain_item_sort_key(item: JsonObject) -> tuple[int, int, int, int, str]:
    priority_order = {"P0": 0, "P1": 1, "P2": 2}
    status_order = {"In progress": 0, "In review": 1, "Ready": 2, "Backlog": 3, "Done": 4}
    return (
        1 if is_done_item(item) else 0,
        status_order.get(normalize_status(item.get("status")), 5),
        priority_order.get(str(item.get("priority")), 5),
        int(item["number"]) if isinstance(item.get("number"), int) else 999999,
        str(item.get("title") or item.get("domain") or ""),
    )


def first_text(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def first_visible_report_text(*values: Any) -> str:
    for value in values:
        text = public_visible_report_text(value)
        if text:
            return text
    return ""


def has_stale_visible_report_marker(value: str) -> bool:
    text = value.lower()
    return any(marker in text for marker in STALE_VISIBLE_REPORT_MARKERS)


def has_cjk_text(value: Any) -> bool:
    return bool(CJK_TEXT_RE.search(str(value or "")))


def report_issue_display_override(number: Any) -> JsonObject:
    if not isinstance(number, int):
        return {}
    return REPORT_ISSUE_DISPLAY_OVERRIDES.get(number, {})


def shorten_text(value: str, limit: int) -> str:
    text = " ".join(value.split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."


def report_progress(item: JsonObject) -> int:
    state = str(item.get("state") or "").upper()
    if state in {"CLOSED", "MERGED"}:
        return 100
    status = normalize_status(item.get("status"))
    return {
        "Done": 100,
        "In review": 78,
        "In progress": 58,
        "Ready": 35,
        "Backlog": 12,
    }.get(status, 20)


def report_item_status(item: JsonObject, github_snapshot: JsonObject) -> str:
    number = f"#{item['number']} " if isinstance(item.get("number"), int) else ""
    status = normalize_status(item.get("status"))
    domain = first_visible_report_text(item.get("domain"), item.get("visionLayer"), "GitHub")
    suffix = ""
    if github_snapshot.get("sourceMode") != "live":
        suffix = f" · {github_snapshot.get('sourceMode') or 'snapshot'}"
    return shorten_text(f"{number}{status} · {domain}{suffix}", 72)


def github_unavailable_text(github_snapshot: JsonObject) -> str:
    mode = str(github_snapshot.get("sourceMode") or "unavailable")
    if mode == "live":
        return "No Project Domain items observed"
    return f"GitHub snapshot {mode}"


def build_report_domain_kanban(github_snapshot: JsonObject) -> list[JsonObject]:
    source_items = report_domain_source_items(github_snapshot)
    columns: list[JsonObject] = []
    for domain in PROJECT_DOMAIN_ORDER:
        domain_items = sorted(
            [item for item in source_items if project_domain(item) == domain and not is_done_item(item)],
            key=domain_item_sort_key,
        )
        columns.append(
            {
                "title": domain,
                "items": [report_domain_kanban_item(item) for item in domain_items[:4]],
            }
        )
    return columns


def report_domain_kanban_item(card: JsonObject) -> JsonObject:
    override = report_issue_display_override(card.get("number"))
    number = f"#{card['number']} " if isinstance(card.get("number"), int) else ""
    title = first_visible_report_text(override.get("title"), card.get("title"), project_domain(card), "Roadmap item")
    status = normalize_status(card.get("status"))
    description = first_visible_report_text(
        override.get("description"),
        card.get("nextAction"),
        card.get("evidence"),
        card.get("domain"),
        "Track Project evidence and next action.",
    )
    detail = f"{status} · {project_domain(card)}"
    if description:
        detail = f"{detail} · {description}"
    return {
        "number": card.get("number"),
        "priority": card.get("priority") or "P1",
        "status": status,
        "domain": project_domain(card),
        "title": shorten_text(f"{number}{title}", 72),
        "description": shorten_text(detail, 112),
        "url": card.get("url") or "",
    }


def format_cst(generated_at: str) -> str:
    try:
        value = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    except ValueError:
        value = datetime.now(timezone.utc)
    return value.astimezone(CST).strftime("%Y-%m-%d %H:%M:%S CST")


def report_cards_with_urls(
    cards: Sequence[JsonObject],
    repo: JsonObject,
    github_snapshot: JsonObject,
) -> list[JsonObject]:
    issue_lookup = build_issue_context_lookup(github_snapshot)
    return [report_card_with_url(card, repo, issue_lookup) for card in cards]


def report_card_with_url(card: JsonObject, repo: JsonObject, issue_lookup: Mapping[int, JsonObject]) -> JsonObject:
    enriched = deepcopy(card)
    issue = enriched.get("issue")
    if isinstance(issue, int):
        enriched["url"] = issue_url(repo, issue)
        enriched["github"] = issue_lookup.get(issue, {})
    return enriched


def report_kanban_with_urls(
    columns: Sequence[JsonObject],
    repo: JsonObject,
    github_snapshot: JsonObject,
) -> list[JsonObject]:
    issue_lookup = build_issue_context_lookup(github_snapshot)
    rendered_columns: list[JsonObject] = []
    for column in columns:
        rendered_columns.append(
            {
                "title": column["title"],
                "items": [
                    {**item, "url": issue_url(repo, item["number"]), "github": issue_lookup.get(item["number"], {})}
                    for item in column.get("items", ())
                    if isinstance(item.get("number"), int)
                ],
            }
        )
    return rendered_columns


def build_issue_context_lookup(github_snapshot: JsonObject) -> dict[int, JsonObject]:
    lookup: dict[int, JsonObject] = {}
    for collection_name in ("issues", "projectItems"):
        collection = github_snapshot.get(collection_name)
        if not isinstance(collection, list):
            continue
        for item in collection:
            if not isinstance(item, dict) or not isinstance(item.get("number"), int):
                continue
            number = int(item["number"])
            existing = lookup.get(number, {})
            lookup[number] = {
                **existing,
                "number": number,
                "state": item.get("state") or existing.get("state") or "",
                "status": item.get("status") or existing.get("status") or "",
                "priority": item.get("priority") or existing.get("priority") or "",
                "domain": item.get("domain") or existing.get("domain") or "",
                "kind": item.get("kind") or existing.get("kind") or "",
                "milestone": item.get("milestone") or existing.get("milestone") or "",
                "labels": item.get("labels") or existing.get("labels") or [],
                "evidence": item.get("evidence") or existing.get("evidence") or "",
                "nextAction": item.get("nextAction") or existing.get("nextAction") or "",
                "url": item.get("url") or existing.get("url") or "",
                "updatedAt": item.get("updatedAt") or existing.get("updatedAt") or "",
                "source": collection_name,
            }
    return lookup


def issue_url(repo: JsonObject, number: int) -> str:
    return f"{repo['url']}/issues/{number}"


def build_report_process_cards(
    repo_root: Path,
    repo: JsonObject,
    github_snapshot: JsonObject,
    cached_page_data: JsonObject,
) -> list[JsonObject]:
    cached_process_cards = cached_report_process_cards(cached_page_data)
    official_deploy_summary = summarize_official_deploy_evidence(repo_root)
    official_deploy_project_count = count_official_deploy_evidence(repo_root, github_snapshot)
    official_deploy_count = max(official_deploy_summary.count, official_deploy_project_count)
    official_deploy_value: int | str = official_deploy_count if official_deploy_count > 0 else INSUFFICIENT_EVIDENCE
    if official_deploy_summary.count > 0:
        official_deploy_detail = official_deploy_process_detail(official_deploy_summary)
        official_deploy_source = "official deploy evidence JSON"
    elif official_deploy_project_count > 0:
        official_deploy_detail = "GitHub Project official deploy evidence"
        official_deploy_source = "github project evidence"
    else:
        official_deploy_detail = "evidence unavailable"
        official_deploy_source = "unavailable"

    return [
        *build_agent_process_cards(cached_process_cards),
        {
            "value": official_deploy_value,
            "label": "Official deploys",
            "detail": official_deploy_detail,
            "delta": "+0",
            "source": official_deploy_source,
        },
    ]


def build_agent_process_cards(cached_process_cards: Sequence[JsonObject]) -> list[JsonObject]:
    codex_metrics = summarize_codex_sessions(CODEX_SESSION_ROOT)
    automation_metrics = summarize_automation_runs(HERMES_CRON_OUTPUT_ROOT)

    if codex_metrics.session_count == 0:
        token_card = cached_or_unavailable_process_card(
            cached_process_cards,
            "Agent tokens",
            "no local Codex rollout JSONL files found",
            "unavailable",
        )
        runtime_card = cached_or_unavailable_process_card(
            cached_process_cards,
            "Codex runtime",
            "no local Codex rollout JSONL files found",
            "unavailable",
        )
        runs_card = cached_or_unavailable_process_card(
            cached_process_cards,
            "Codex runs",
            "no local Codex rollout JSONL files found",
            "unavailable",
        )
    else:
        token_value: str = "unavailable"
        token_detail = f"0/{codex_metrics.session_count:,} sessions exposed token_count totals"
        if codex_metrics.total_tokens is not None:
            token_value = format_compact_count(codex_metrics.total_tokens)
            token_detail = (
                f"{format_integer(codex_metrics.total_tokens)} total; "
                f"latest token_count in {codex_metrics.token_session_count:,}/{codex_metrics.session_count:,} sessions"
            )
        if codex_metrics.unreadable_count:
            token_detail = f"{token_detail}; {codex_metrics.unreadable_count:,} unreadable"

        runtime_value: str = "unavailable"
        runtime_detail = f"0/{codex_metrics.session_count:,} sessions exposed timestamps"
        if codex_metrics.elapsed_seconds is not None:
            runtime_value = format_duration(codex_metrics.elapsed_seconds)
            runtime_detail = (
                "summed first-to-last JSONL timestamps across "
                f"{codex_metrics.timed_session_count:,}/{codex_metrics.session_count:,} sessions"
            )

        token_card = {
            "value": token_value,
            "rawValue": codex_metrics.total_tokens,
            "label": "Agent tokens",
            "detail": token_detail,
            "delta": "+0",
            "source": ".codex/sessions/**/rollout-*.jsonl",
        }
        runtime_card = {
            "value": runtime_value,
            "rawValueSeconds": codex_metrics.elapsed_seconds,
            "label": "Codex runtime",
            "detail": runtime_detail,
            "delta": "+0",
            "source": ".codex/sessions/**/rollout-*.jsonl timestamps",
        }
        runs_card = {
            "value": format_compact_count(codex_metrics.session_count),
            "rawValue": codex_metrics.session_count,
            "label": "Codex runs",
            "detail": "rollout JSONL files counted as Codex runs",
            "delta": "+0",
            "source": ".codex/sessions/**/rollout-*.jsonl",
        }

    if automation_metrics.available:
        automation_card = {
            "value": format_compact_count(automation_metrics.run_count),
            "rawValue": automation_metrics.run_count,
            "label": "Automation runs",
            "detail": (
                f"{automation_metrics.run_count:,} cron outputs across "
                f"{automation_metrics.job_count:,} jobs"
            ),
            "delta": "+0",
            "source": ".hermes/cron/output/*/*.md",
        }
    else:
        automation_card = cached_or_unavailable_process_card(
            cached_process_cards,
            "Automation runs",
            "no local Hermes cron markdown outputs found",
            "unavailable",
        )

    return [token_card, runtime_card, runs_card, automation_card]


def cached_or_unavailable_process_card(
    cached_process_cards: Sequence[JsonObject],
    label: str,
    detail: str,
    source: str,
) -> JsonObject:
    cached_card = cached_process_card(cached_process_cards, label)
    if cached_card:
        return {
            **cached_card,
            "detail": process_cached_detail(cached_card, detail),
            "source": "cached",
            "delta": cached_card.get("delta", "cached"),
        }
    return {
        "value": "unavailable",
        "label": label,
        "detail": detail,
        "delta": "n/a",
        "source": source,
    }


def process_cached_detail(cached_card: JsonObject, fallback: str) -> str:
    cached_detail = str(cached_card.get("detail") or "").strip()
    if not cached_detail:
        cached_detail = fallback
    cached_detail = CACHED_SUFFIX_RE.sub("", cached_detail).strip()
    return f"{cached_detail} · cached"


def summarize_codex_sessions(session_root: Path) -> CodexSessionMetrics:
    if not session_root.exists():
        return CodexSessionMetrics(0, 0, 0, None, None, 0)

    session_count = 0
    token_session_count = 0
    timed_session_count = 0
    unreadable_count = 0
    total_tokens = 0
    elapsed_seconds = 0
    for path in sorted(session_root.glob(f"**/{CODEX_SESSION_PATTERN}")):
        if not path.is_file():
            continue
        session_count += 1
        session = summarize_codex_session_file(path)
        if session is None:
            unreadable_count += 1
            continue
        latest_tokens, elapsed = session
        if latest_tokens is not None:
            token_session_count += 1
            total_tokens += latest_tokens
        if elapsed is not None:
            timed_session_count += 1
            elapsed_seconds += elapsed

    return CodexSessionMetrics(
        session_count=session_count,
        token_session_count=token_session_count,
        timed_session_count=timed_session_count,
        total_tokens=total_tokens if token_session_count else None,
        elapsed_seconds=elapsed_seconds if timed_session_count else None,
        unreadable_count=unreadable_count,
    )


def summarize_codex_session_file(path: Path) -> tuple[int | None, int | None] | None:
    first_seen: datetime | None = None
    last_seen: datetime | None = None
    latest_tokens: int | None = None
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(record, dict):
                    continue
                timestamp = parse_timestamp(str(record.get("timestamp") or ""))
                if timestamp is not None:
                    first_seen = timestamp if first_seen is None else min(first_seen, timestamp)
                    last_seen = timestamp if last_seen is None else max(last_seen, timestamp)
                token_count = codex_token_count_from_record(record)
                if token_count is not None:
                    latest_tokens = token_count
    except OSError:
        return None

    elapsed: int | None = None
    if first_seen is not None and last_seen is not None:
        elapsed = max(0, int((last_seen - first_seen).total_seconds()))
    return latest_tokens, elapsed


def codex_token_count_from_record(record: Mapping[str, Any]) -> int | None:
    if record.get("type") != "event_msg":
        return None
    payload = record.get("payload")
    if not isinstance(payload, Mapping) or payload.get("type") != "token_count":
        return None
    total = get_path(payload, ("info", "total_token_usage", "total_tokens"))
    number = as_number(total)
    if number is None:
        return None
    return int(number)


def summarize_automation_runs(output_root: Path) -> AutomationRunMetrics:
    if not output_root.exists():
        return AutomationRunMetrics(0, 0, False)
    paths = [path for path in output_root.glob("*/*.md") if path.is_file()]
    job_count = len({path.parent for path in paths})
    return AutomationRunMetrics(len(paths), job_count, bool(paths))


def format_compact_count(value: int | float) -> str:
    number = float(value)
    abs_value = abs(number)
    for threshold, suffix in ((1_000_000_000, "B"), (1_000_000, "M")):
        if abs_value >= threshold:
            compact = number / threshold
            decimals = 0 if abs(compact) >= 100 or compact.is_integer() else 1
            return f"{compact:.{decimals}f}{suffix}"
    return format_integer(int(number))


def format_integer(value: int | float) -> str:
    return f"{int(value):,}"


def format_duration(seconds: int | float) -> str:
    remaining = max(0, int(seconds))
    days, remaining = divmod(remaining, 86_400)
    hours, remaining = divmod(remaining, 3_600)
    minutes, _ = divmod(remaining, 60)
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    if minutes:
        return f"{minutes}m"
    return f"{remaining}s"


def cached_report_process_cards(cached_page_data: JsonObject) -> list[JsonObject]:
    report = cached_page_data.get("report")
    if not isinstance(report, dict):
        return []
    cards = report.get("processCards")
    if not isinstance(cards, list):
        return []
    return [dict(card) for card in cards if isinstance(card, dict)]


def cached_process_card(cards: Sequence[JsonObject], *labels: str) -> JsonObject:
    label_set = set(labels)
    for card in cards:
        if str(card.get("label") or "") in label_set:
            return card
    return {}


def process_detail(
    error: JsonObject | None,
    command_label: str,
    live_detail: str,
    cached_card: JsonObject,
) -> str:
    if error is None:
        return live_detail
    cached_detail = str(cached_card.get("detail") or "").strip()
    if cached_detail:
        cached_detail = CACHED_SUFFIX_RE.sub("", cached_detail).strip()
        return f"{cached_detail} · cached"
    return format_fetch_error(command_label, error)


def fetch_all_prs(repo_root: Path, repo_full_name: str) -> tuple[list[JsonObject], JsonObject | None]:
    data, error = run_json(
        ["gh", "pr", "list", "--repo", repo_full_name, "--state", "all", "--limit", "1000", "--json", "number,state"],
        repo_root,
        timeout=45,
    )
    if error is not None or not isinstance(data, list):
        return [], error or {"message": "invalid pull request payload"}
    return [item for item in data if isinstance(item, dict)], None


def fetch_all_issues(repo_root: Path, repo_full_name: str) -> tuple[list[JsonObject], JsonObject | None]:
    data, error = run_json(
        ["gh", "issue", "list", "--repo", repo_full_name, "--state", "all", "--limit", "1000", "--json", "number,state"],
        repo_root,
        timeout=45,
    )
    if error is not None or not isinstance(data, list):
        return [], error or {"message": "invalid issue payload"}
    return [item for item in data if isinstance(item, dict)], None


def format_fetch_error(label: str, error: JsonObject) -> str:
    message = str(error.get("message") or "unavailable")
    exit_code = error.get("exitCode")
    if exit_code is None:
        return f"{label}: {message}"
    return f"{label}: {message} ({exit_code})"


def parse_count(value: str) -> int:
    try:
        return int(value.strip())
    except ValueError:
        return 0


def summarize_official_deploy_evidence(repo_root: Path) -> OfficialDeployEvidenceSummary:
    records: list[OfficialDeployEvidenceRecord] = []
    for path in official_deploy_evidence_paths(repo_root):
        evidence = read_json_object(path)
        if not official_deploy_evidence_succeeded(evidence):
            continue
        records.append(
            OfficialDeployEvidenceRecord(
                path=path,
                timestamp=official_deploy_evidence_timestamp(evidence),
                commit=official_deploy_commit(evidence),
                run_id=official_deploy_run_id(evidence),
            )
        )

    latest = max(records, key=official_deploy_record_sort_key) if records else None
    return OfficialDeployEvidenceSummary(count=len(records), latest=latest)


def official_deploy_evidence_paths(repo_root: Path) -> list[Path]:
    evidence_dir = repo_root / OFFICIAL_DEPLOY_EVIDENCE_DIR
    if not evidence_dir.exists():
        return []

    paths: dict[Path, Path] = {}
    for pattern in OFFICIAL_DEPLOY_EVIDENCE_PATTERNS:
        for path in evidence_dir.glob(pattern):
            if path.is_file():
                paths[path.resolve()] = path
    return sorted(paths.values())


def read_json_object(path: Path) -> JsonObject:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def official_deploy_evidence_succeeded(evidence: Mapping[str, Any]) -> bool:
    if evidence.get("ok") is not True or evidence.get("mode") != "deploy":
        return False

    verification = evidence.get("verification")
    if not isinstance(verification, Mapping):
        return False

    target_branch = first_nested_scalar_text(evidence, (("target", "branch"),))
    return branch_code_verification_matched(verification) and active_world_verification_matched(
        verification,
        target_branch,
    )


def branch_code_verification_matched(verification: Mapping[str, Any]) -> bool:
    for key in ("branchCode", "deployedBranchCode", "uploadedBranchCode", "upload"):
        if verification_value_matched(verification.get(key)):
            return True
    return False


def active_world_verification_matched(verification: Mapping[str, Any], target_branch: str) -> bool:
    active_world = verification.get("activeWorld")
    if not isinstance(active_world, Mapping):
        return False
    if verification_value_matched(active_world):
        return active_world_branch_matches(active_world, target_branch)
    if verification_value_matched(active_world.get("code")):
        return active_world_branch_matches(active_world, target_branch)
    return False


def active_world_branch_matches(active_world: Mapping[str, Any], target_branch: str) -> bool:
    if not target_branch:
        return True
    active_branch = first_nested_scalar_text(
        active_world,
        (
            ("activeWorldBranch",),
            ("branch",),
            ("name",),
        ),
    )
    return not active_branch or active_branch == target_branch


def verification_value_matched(value: Any) -> bool:
    if not isinstance(value, Mapping):
        return False
    if any(value.get(key) is False for key in ("matched", "matches", "hashMatched")):
        return False
    status = str(value.get("status") or "").strip().lower()
    if status in {"matched", "match"}:
        return True
    return any(value.get(key) is True for key in ("matched", "matches", "hashMatched"))


def official_deploy_evidence_timestamp(evidence: Mapping[str, Any]) -> datetime | None:
    timestamp = first_nested_scalar_text(
        evidence,
        (
            ("timestampUtc",),
            ("timestamp",),
            ("generatedAt",),
            ("completedAt",),
            ("createdAt",),
        ),
    )
    return parse_timestamp(timestamp) if timestamp else None


def official_deploy_commit(evidence: Mapping[str, Any]) -> str:
    return first_nested_scalar_text(
        evidence,
        (
            ("git", "commit"),
            ("git", "sha"),
            ("commitSha",),
            ("commit",),
            ("headSha",),
            ("github", "sha"),
        ),
    )


def official_deploy_run_id(evidence: Mapping[str, Any]) -> str:
    return first_nested_scalar_text(
        evidence,
        (
            ("runId",),
            ("run_id",),
            ("workflowRunId",),
            ("workflow_run_id",),
            ("github", "runId"),
            ("github", "run_id"),
            ("workflow", "runId"),
            ("workflow", "run_id"),
            ("workflowRun", "id"),
        ),
    )


def first_nested_scalar_text(value: Mapping[str, Any], paths: Sequence[Sequence[str]]) -> str:
    for keys in paths:
        item: Any = value
        for key in keys:
            if not isinstance(item, Mapping):
                item = None
                break
            item = item.get(key)
        text = scalar_text(item)
        if text:
            return text
    return ""


def scalar_text(value: Any) -> str:
    if isinstance(value, str):
        text = value.strip()
    elif isinstance(value, int):
        text = str(value)
    else:
        return ""
    return "" if text.lower() == "unknown" else text


def official_deploy_record_sort_key(record: OfficialDeployEvidenceRecord) -> tuple[datetime, str]:
    timestamp = record.timestamp or datetime.min.replace(tzinfo=timezone.utc)
    return timestamp, record.path.name


def official_deploy_process_detail(summary: OfficialDeployEvidenceSummary) -> str:
    detail = "official deploy evidence"
    if summary.latest is None:
        return detail

    parts = []
    if summary.latest.commit:
        parts.append(f"latest commit {short_commit(summary.latest.commit)}")
    if summary.latest.run_id:
        parts.append(f"run {summary.latest.run_id}")
    if not parts:
        return detail
    return f"{detail} · {' · '.join(parts)}"


def short_commit(commit: str) -> str:
    text = commit.strip()
    return text[:12] if len(text) > 12 else text


def count_process_evidence(
    repo_root: Path,
    required_terms: Sequence[str],
    excluded_terms: Sequence[str] = (),
) -> int:
    process_dir = repo_root / "docs" / "process"
    if not process_dir.exists():
        return 0
    count = 0
    for path in process_dir.glob("*.md"):
        try:
            text = path.read_text(encoding="utf-8").lower()
        except OSError:
            continue
        if all(term.lower() in text for term in required_terms) and not any(
            term.lower() in text for term in excluded_terms
        ):
            count += 1
    return count


def count_official_deploy_evidence(repo_root: Path, github_snapshot: JsonObject) -> int:
    evidence: set[str] = set()
    artifact_dir = repo_root / "runtime-artifacts" / "official-screeps-deploy"
    if artifact_dir.is_dir():
        for path in artifact_dir.glob("official-screeps-deploy-*.json"):
            evidence.add(f"artifact:{path.name}")

    process_count = count_process_evidence(
        repo_root,
        required_terms=("official", "deploy evidence"),
        excluded_terms=("temporary official MMO link validation",),
    )
    for index in range(process_count):
        evidence.add(f"process:{index}")

    for collection_name in ("issues", "projectItems"):
        collection = github_snapshot.get(collection_name)
        if not isinstance(collection, list):
            continue
        for item in collection:
            if not isinstance(item, dict):
                continue
            text = " ".join(
                str(item.get(key) or "") for key in ("title", "status", "evidence", "nextAction")
            ).lower()
            run_ids = re.findall(r"official deploy run\s+(\d+)", text)
            for run_id in run_ids:
                evidence.add(f"run:{run_id}")
            if not run_ids and "deployment floor satisfied" in text and "official deploy" in text:
                evidence.add(f"item:{item.get('number', len(evidence))}")
    return len(evidence)


def count_private_smoke_process_reports(repo_root: Path) -> int:
    process_dir = repo_root / "docs" / "process"
    if not process_dir.exists():
        return APPROVED_PRIVATE_SMOKE_PROCESS_COUNT

    accepted_reports = 0
    for path in process_dir.glob("*private-smoke*.md"):
        try:
            text = path.read_text(encoding="utf-8").lower()
        except OSError:
            continue
        if "private-smoke-report-" in text:
            accepted_reports += 1

    return accepted_reports or APPROVED_PRIVATE_SMOKE_PROCESS_COUNT


def render_html(data: JsonObject) -> str:
    title = esc(data["title"])
    repo = data["repo"]
    logo = data["assets"].get("logo") or ""
    logo_html = f'<img class="brand-logo" src="{esc(logo)}" alt="Screeps community logo">' if logo else ""
    generated_at = esc(data["generatedAt"])
    target_room_nav = render_target_room_nav(repo)
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
        {target_room_nav}
        <a href="{esc(repo['discordUrl'])}">Discord</a>
        <a href="{esc(repo['pagesUrl'])}">Pages URL</a>
      </nav>
      <p class="published">Published {generated_at}</p>
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


def render_target_room_nav(repo: JsonObject) -> str:
    room_target = repo.get("screepsRoom") if isinstance(repo.get("screepsRoom"), dict) else {}
    label = str(room_target.get("label") or "unknown")
    status = str(room_target.get("status") or "unknown")
    message = str(room_target.get("message") or "")
    text = f"Target room: {label} ({status})"
    url = str(room_target.get("url") or "")
    if url:
        return f'<a href="{esc(url)}" title="{esc(message)}">{esc(text)}</a>'
    return f'<span class="link-status" title="{esc(message)}">{esc(text)}</span>'


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
.link-row .link-status,
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

.link-row .link-status {
  display: inline-flex;
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

.sparkline.unavailable {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: 12px;
  color: var(--muted);
  font-size: 0.82rem;
  font-weight: 700;
  background: rgba(255, 253, 247, 0.68);
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
          <div class="sparkline unavailable" data-sparkline-unavailable="true" role="img" aria-label="No observed metric history yet">
            No observed history
          </div>
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
        <h2>Project Domain Kanban</h2>
        <p>Cards are grouped by the current GitHub Project Domain field when it is available.</p>
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


# The Pages page intentionally renders the approved Discord-style static report.
# The dynamic KPI category dashboard above remains unused so SQLite/JSON can keep
# the broader metric history without exposing those extra cards on the page.
def render_html(data: JsonObject) -> str:
    title = esc(data["title"])
    repo = data["repo"]
    generated_at = esc(data["generatedAt"])
    return f"""<!doctype html>
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
  <div class="page-shell">
    {render_report_hero(data)}
    <main>
      {render_report_kpis(data)}
      {render_report_roadmap(data)}
      {render_kanban_section("domain-kanban", "03 Project Domain Board", data["report"]["domainKanban"])}
      {render_report_process(data)}
    </main>
    <footer class="report-footer">format {esc(data["format"])} · repo {esc(repo["url"])} · generated {generated_at}</footer>
  </div>
</body>
</html>
"""


def render_css() -> str:
    return """
:root {
  color-scheme: light;
  --ink: #211d18;
  --muted: #76685c;
  --paper: #f2ece2;
  --card: #fffdf7;
  --line: #d8c7b3;
  --line-soft: #e8dacb;
  --copper: #a56a36;
  --copper-dark: #875322;
  --green: #4f7b43;
  --shadow: 0 18px 36px rgba(91, 64, 34, 0.11);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.38;
}

a {
  color: inherit;
  text-decoration: none;
}

.page-shell {
  width: min(100%, 1600px);
  margin: 0 auto;
  padding: 62px 48px 72px;
}

.hero {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 410px;
  align-items: center;
  min-height: 390px;
  gap: 40px;
  overflow: hidden;
  border-radius: 30px;
  padding: 34px 36px;
  background:
    radial-gradient(circle at 88% 44%, rgba(255, 255, 255, 0.58) 0 118px, rgba(255, 255, 255, 0.24) 119px 174px, transparent 175px),
    linear-gradient(105deg, #fffaf0 0%, #f7eddd 58%, #e8d3b8 100%);
  box-shadow: var(--shadow);
}

.eyebrow {
  margin: 0 0 10px;
  color: var(--copper-dark);
  font-size: 1.03rem;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  max-width: 820px;
  font-size: clamp(3.35rem, 4.35vw, 4.45rem);
  font-weight: 900;
  letter-spacing: 0;
  line-height: 0.96;
}

h1 span {
  display: block;
}

.summary {
  max-width: 850px;
  margin: 20px 0 0;
  color: #665242;
  font-size: 1.45rem;
  font-weight: 500;
}

.hero-meta {
  margin-top: 14px;
}

.hero-meta p,
.published {
  margin: 7px 0;
  color: var(--muted);
  font-size: 1.02rem;
  font-weight: 650;
}

.hero-meta strong,
.published strong {
  color: var(--copper-dark);
  font-weight: 900;
}

.hero-art {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.brand-logo-frame {
  display: grid;
  width: 334px;
  height: 334px;
  place-items: center;
  border: 1px solid rgba(189, 159, 123, 0.72);
  border-radius: 50%;
  padding: 18px;
  background: rgba(255, 250, 240, 0.82);
  box-shadow: 0 25px 36px rgba(46, 31, 17, 0.18);
}

.brand-logo {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

main {
  margin-top: 28px;
}

.section {
  margin-top: 26px;
}

.section-title {
  margin: 0 0 14px;
  font-size: 2.15rem;
  line-height: 1.08;
  font-weight: 900;
  letter-spacing: 0;
}

.kpi-report-grid,
.roadmap-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 17px;
}

.chart-card,
.roadmap-card,
.kanban-column,
.process-card {
  border: 1px solid var(--line);
  border-radius: 18px;
  background: rgba(255, 253, 247, 0.86);
  box-shadow: 0 12px 26px rgba(72, 48, 24, 0.06);
}

.chart-card {
  min-height: 374px;
  padding: 18px;
}

.card-heading,
.column-heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
}

.chart-card h3,
.roadmap-card h3 {
  margin: 0;
  font-size: 1.48rem;
  line-height: 1.12;
  font-weight: 900;
}

.kanban-column h3 {
  margin: 0;
  font-size: 0.96rem;
  line-height: 1.12;
  font-weight: 900;
  text-transform: uppercase;
}

.chart-card p {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 1rem;
}

.mini-pill {
  flex: 0 0 auto;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 7px 12px;
  background: #f3e7d7;
  color: var(--copper-dark);
  font-size: 0.82rem;
  font-weight: 900;
}

.chart-svg {
  width: 100%;
  height: 244px;
  margin-top: 8px;
  overflow: visible;
}

.chart-footer {
  margin: 3px 0 0;
  color: var(--muted);
  font-size: 0.92rem;
  font-weight: 520;
}

.roadmap-card {
  display: block;
  min-height: 188px;
  padding: 18px;
}

.roadmap-card:hover,
.kanban-item:hover {
  border-color: #bd9f7b;
}

.roadmap-table {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 7px 16px;
  margin-top: 8px;
  font-size: 1rem;
}

.roadmap-label {
  color: var(--muted);
  font-weight: 900;
}

.progress-row {
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  margin-top: 13px;
}

.progress-value {
  color: var(--copper-dark);
  font-size: 1.18rem;
  font-weight: 800;
}

.progress-track {
  height: 11px;
  overflow: hidden;
  border: 1px solid #d4c0a9;
  border-radius: 999px;
  background: #efe5d7;
}

.progress-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #bd844b, #8f5d2c);
}

.roadmap-status {
  margin-top: 13px;
  color: var(--green);
  font-size: 0.95rem;
  font-weight: 900;
}

.kanban-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 14px;
}

.kanban-column {
  min-height: 335px;
  padding: 12px;
  background: rgba(250, 245, 238, 0.72);
}

.column-heading {
  margin-bottom: 10px;
}

.column-count {
  color: var(--copper-dark);
  font-size: 0.88rem;
  font-weight: 900;
}

.kanban-item {
  display: block;
  min-height: 88px;
  margin-top: 10px;
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  padding: 12px;
  background: var(--card);
}

.kanban-item h4 {
  margin: 0;
  font-size: 0.94rem;
  line-height: 1.16;
  font-weight: 900;
}

.kanban-item p {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 0.84rem;
  line-height: 1.22;
}

.kanban-priority {
  display: inline-block;
  margin-bottom: 7px;
  color: var(--copper-dark);
  font-size: 0.78rem;
  font-weight: 900;
}

.kanban-empty {
  display: grid;
  min-height: 88px;
  margin-top: 10px;
  place-items: center;
  border: 1px dashed #d7bea4;
  border-radius: 12px;
  color: #9f846a;
  font-size: 0.9rem;
}

.process-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 17px;
}

.process-card {
  min-height: 138px;
  padding: 19px 18px 14px;
}

.process-value {
  margin: 0;
  color: var(--copper-dark);
  font-size: 3rem;
  line-height: 1;
  font-weight: 900;
}

.process-label {
  margin: 10px 0 0;
  color: #4d4136;
  font-size: 1rem;
  font-weight: 650;
}

.process-detail {
  margin: 3px 0 0;
  color: var(--muted);
  font-size: 0.83rem;
}

.process-chip {
  float: right;
  margin-top: -3px;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 8px;
  background: #f6ead9;
  color: var(--copper-dark);
  font-size: 0.78rem;
  font-weight: 900;
}

.report-footer {
  margin-top: 28px;
  color: #9a8775;
  font-size: 0.86rem;
  text-align: right;
}

@media (max-width: 1180px) {
  .kpi-report-grid,
  .roadmap-grid,
  .process-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .hero {
    grid-template-columns: minmax(0, 1fr) 260px;
  }

  .brand-logo {
    width: 100%;
    height: 100%;
  }

  .brand-logo-frame {
    width: 268px;
    height: 268px;
  }

  .kanban-grid {
    overflow-x: auto;
    grid-template-columns: repeat(5, minmax(190px, 1fr));
    padding-bottom: 4px;
  }
}

@media (max-width: 820px) {
  .page-shell {
    padding: 24px 16px 42px;
  }

  .hero,
  .kpi-report-grid,
  .roadmap-grid,
  .process-grid {
    grid-template-columns: 1fr;
  }

  .hero {
    min-height: auto;
    padding: 26px 22px;
  }

  h1 {
    font-size: 2.78rem;
  }

  .summary {
    font-size: 1.1rem;
  }

  .brand-logo-frame {
    justify-self: start;
    width: 212px;
    height: 212px;
  }

  .kanban-grid {
    grid-template-columns: 1fr;
    overflow-x: visible;
    padding-bottom: 0;
  }
}
"""


def render_report_hero(data: JsonObject) -> str:
    repo = data["repo"]
    logo = data["assets"].get("logo") or ""
    logo_html = (
        f'<div class="brand-logo-frame"><img class="brand-logo" src="{esc(logo)}" alt="Screeps community logo"></div>'
        if logo
        else ""
    )
    return f"""
    <header class="hero">
      <div>
        <p class="eyebrow">PERSISTENT MMO AI COLONY · AUTONOMOUS ROADMAP</p>
        <h1><span>Hermes Screeps Project</span><span>Roadmap Report</span></h1>
        <p class="summary">Harness live Screeps KPI evidence for Agentic strategy, bot capability growth, delivery gates, and release cadence.</p>
        <div class="hero-meta">
          <p><strong>Project</strong> · Long-running Screeps: World AI and autonomous operations project.</p>
          <p><strong>Links</strong> · <a href="{esc(repo['url'])}">{esc(repo['url'])}</a></p>
        </div>
        <p class="published"><strong>PUBLISHED</strong> · {esc(data["generatedAtCst"])}</p>
      </div>
      <div class="hero-art">
        {logo_html}
      </div>
    </header>
"""


def render_report_kpis(data: JsonObject) -> str:
    cards = "\n".join(render_kpi_chart_card(card) for card in data["report"]["kpiCards"])
    return f"""
      <section class="section" id="kpi">
        <h2 class="section-title">01 Game KPI - 7d Trend</h2>
        <div class="kpi-report-grid">
          {cards}
        </div>
      </section>
"""


def render_kpi_chart_card(card: JsonObject) -> str:
    return f"""
          <article class="chart-card">
            <div class="card-heading">
              <div>
                <h3>{esc(card["title"])}</h3>
                <p>{esc(card["subtitle"])}</p>
              </div>
              <span class="mini-pill">{esc(card["pill"])}</span>
            </div>
            {render_kpi_svg(card)}
            <p class="chart-footer">{esc(card["footer"])}</p>
          </article>
"""


def render_kpi_svg(card: JsonObject) -> str:
    x0 = 70.0
    y0 = 24.0
    width = 430.0
    height = 166.0
    y_max = float(card["max"])
    date_values = card.get("dates")
    date_labels_values = [str(label) for label in date_values] if isinstance(date_values, list) else list(KPI_DATES)

    def x_for(index: int) -> float:
        return x0 + (width / max(len(date_labels_values) - 1, 1)) * index

    def y_for(value: float) -> float:
        clamped = min(max(float(value), 0.0), y_max)
        return y0 + height - (clamped / y_max) * height

    grid_parts: list[str] = []
    for tick in card["ticks"]:
        y = y_for(float(tick))
        grid_parts.append(
            f'<line x1="{x0:.1f}" y1="{y:.1f}" x2="{x0 + width:.1f}" y2="{y:.1f}" stroke="#e4d7c8" stroke-width="1"/>'
        )
        grid_parts.append(
            f'<text x="{x0 - 12:.1f}" y="{y + 5:.1f}" text-anchor="end" fill="#8b6d55" font-size="15">{esc(format_tick(tick))}</text>'
        )

    date_labels = "\n".join(
        f'<text x="{x_for(index):.1f}" y="226" text-anchor="middle" fill="#7b6654" font-size="15">{esc(label)}</text>'
        for index, label in enumerate(date_labels_values)
    )

    series_parts: list[str] = []
    legend_parts: list[str] = []
    legend_x = 8
    for series_index, series in enumerate(card["series"]):
        dash = f' stroke-dasharray="{esc(series["dash"])}"' if series.get("dash") else ""
        color = esc(series["color"])
        width_attr = esc(series.get("width", 3))
        segment: list[tuple[float, float, float]] = []
        coords: list[tuple[float, float, float]] = []
        values = list(series.get("values", ()))
        for index, raw_value in enumerate(values):
            value = chart_number(raw_value)
            if value is None:
                if len(segment) > 1:
                    points = " ".join(f"{x:.1f},{y:.1f}" for x, y, _ in segment)
                    series_parts.append(
                        f'<polyline fill="none" stroke="{color}" stroke-width="{width_attr}" stroke-linecap="round" stroke-linejoin="round"{dash} points="{points}"/>'
                    )
                segment = []
                continue
            x = x_for(index)
            y = y_for(float(value))
            point = (x, y, float(value))
            coords.append(point)
            segment.append(point)
        if len(segment) > 1:
            points = " ".join(f"{x:.1f},{y:.1f}" for x, y, _ in segment)
            series_parts.append(
                f'<polyline fill="none" stroke="{color}" stroke-width="{width_attr}" stroke-linecap="round" stroke-linejoin="round"{dash} points="{points}"/>'
            )
        for x, y, value in coords:
            if value == y_max:
                text_y = y + 22
            elif value == 0:
                text_y = y - 8 - (series_index * 13)
            else:
                text_y = y - 11
            series_parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4" fill="{color}"/>')
            series_parts.append(
                f'<text x="{x:.1f}" y="{text_y:.1f}" text-anchor="middle" fill="#241d17" font-size="14" font-weight="800">{esc(format_chart_value(value))}</text>'
            )
        legend_parts.append(
            f'<line x1="{legend_x}" y1="250" x2="{legend_x + 22}" y2="250" stroke="{color}" stroke-width="3"{dash}/>'
        )
        legend_parts.append(
            f'<text x="{legend_x + 30}" y="255" fill="#4f443a" font-size="14">{esc(series["label"])}</text>'
        )
        legend_x += 142 if len(series["label"]) < 11 else 164

    all_series_values = [
        chart_number(value)
        for series in card.get("series", ())
        if isinstance(series, dict)
        for value in series.get("values", ())
    ]
    has_observed_value = any(value is not None for value in all_series_values)
    unavailable_overlay = ""
    if not has_observed_value:
        unavailable_overlay = f'''
              <g data-kpi-unavailable="true">
                <rect x="{x0 + 52:.1f}" y="{y0 + 42:.1f}" width="{width - 104:.1f}" height="74" rx="10" fill="#fbfaf7" stroke="#d8cabc" stroke-width="1.2"/>
                <text x="{x0 + width / 2:.1f}" y="{y0 + 76:.1f}" text-anchor="middle" fill="#3e352d" font-size="17" font-weight="800">No observed KPI data</text>
                <text x="{x0 + width / 2:.1f}" y="{y0 + 101:.1f}" text-anchor="middle" fill="#8b6d55" font-size="13">Real reducer history is unavailable; chart is intentionally blank.</text>
              </g>'''

    return f"""
            <svg class="chart-svg" role="img" aria-label="{esc(card["title"])} 7 day trend" viewBox="0 0 560 260">
              <text x="{x0:.1f}" y="12" fill="#9a5d25" font-size="14" font-weight="900">{esc(card["pill"])}</text>
              {''.join(grid_parts)}
              <line x1="{x0:.1f}" y1="{y0:.1f}" x2="{x0:.1f}" y2="{y0 + height:.1f}" stroke="#cdbba7" stroke-width="1.5"/>
              <line x1="{x0:.1f}" y1="{y0 + height:.1f}" x2="{x0 + width:.1f}" y2="{y0 + height:.1f}" stroke="#cdbba7" stroke-width="1.5"/>
              {''.join(series_parts)}
              {unavailable_overlay}
              {date_labels}
              {''.join(legend_parts)}
            </svg>
"""


def format_tick(value: Any) -> str:
    number = float(value)
    if number.is_integer():
        return str(int(number))
    return str(number).rstrip("0").rstrip(".")


def format_chart_value(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else format_tick(value)


def render_report_roadmap(data: JsonObject) -> str:
    cards = "\n".join(render_report_roadmap_card(card) for card in data["report"]["roadmapCards"])
    return f"""
      <section class="section" id="roadmap">
        <h2 class="section-title">02 Project Domains</h2>
        <div class="roadmap-grid">
          {cards}
        </div>
      </section>
"""


def render_report_roadmap_card(card: JsonObject) -> str:
    tag = "a" if card.get("url") else "article"
    href = f' href="{esc(card["url"])}"' if card.get("url") else ""
    raw_progress = card.get("progress")
    progress = int(raw_progress) if isinstance(raw_progress, (int, float)) else 0
    progress_label = f"{progress}%" if isinstance(raw_progress, (int, float)) else "n/a"
    return f"""
          <{tag} class="roadmap-card"{href}>
            <h3>{esc(card["title"])}</h3>
            <div class="roadmap-table">
              <span class="roadmap-label">Goal</span><span>{esc(card["goal"])}</span>
              <span class="roadmap-label">Next</span><span>{esc(card["next"])}</span>
            </div>
            <div class="progress-row">
              <span class="progress-value">{esc(progress_label)}</span>
              <span class="progress-track"><span class="progress-fill" style="width: {progress}%"></span></span>
            </div>
            <div class="roadmap-status">{esc(card["status"])}</div>
          </{tag}>
"""


def render_kanban_section(section_id: str, title: str, columns: Sequence[JsonObject]) -> str:
    rendered_columns = "\n".join(render_kanban_column(column) for column in columns)
    return f"""
      <section class="section" id="{esc(section_id)}">
        <h2 class="section-title">{esc(title)}</h2>
        <div class="kanban-grid">
          {rendered_columns}
        </div>
      </section>
"""


def render_kanban_column(column: JsonObject) -> str:
    items = column.get("items", [])
    count = len(items)
    rendered_items = "\n".join(render_kanban_item(item) for item in items) if items else '<div class="kanban-empty">—</div>'
    return f"""
          <article class="kanban-column">
            <div class="column-heading">
              <h3>{esc(column["title"])}</h3>
              <span class="column-count">{count}</span>
            </div>
            {rendered_items}
          </article>
"""


def render_kanban_item(item: JsonObject) -> str:
    tag = "a" if item.get("url") else "div"
    href = f' href="{esc(item["url"])}"' if item.get("url") else ""
    return f"""
            <{tag} class="kanban-item"{href}>
              <span class="kanban-priority">{esc(item["priority"])}</span>
              <h4>{esc(item["title"])}</h4>
              <p>{esc(item["description"])}</p>
            </{tag}>
"""


def render_report_process(data: JsonObject) -> str:
    cards = "\n".join(render_process_card(card) for card in data["report"]["processCards"])
    return f"""
      <section class="section" id="process">
        <h2 class="section-title">04 Delivery Metrics</h2>
        <div class="process-grid">
          {cards}
        </div>
      </section>
"""


def render_process_card(card: JsonObject) -> str:
    return f"""
          <article class="process-card">
            <p class="process-value">{esc(card["value"])}</p>
            <p class="process-label">{esc(card["label"])}</p>
            <p class="process-detail">{esc(card["detail"])}</p>
          </article>
"""


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


if __name__ == "__main__":
    raise SystemExit(main())
