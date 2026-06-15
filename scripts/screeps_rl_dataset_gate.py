#!/usr/bin/env python3
"""Executable RL dataset collection and evaluation gate for Screeps artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence, TextIO

import screeps_rl_dataset_export as dataset_export
import screeps_rl_mmo_validator as mmo_validator
import screeps_rl_rollout_manager as rollout_manager
import rl_conclusion_registry as conclusion_registry
import screeps_cli_io
import screeps_world_profiles as world_profiles
import screeps_strategy_shadow_report as shadow_report


SCHEMA_VERSION = 1
CONTRACT_TYPE = "screeps-rl-dataset-evaluation-gate-contract"
REPORT_TYPE = "screeps-rl-dataset-evaluation-gate"
SUMMARY_TYPE = "screeps-rl-dataset-evaluation-gate-summary"
DEFAULT_OUT_DIR = Path("runtime-artifacts/rl-dataset-gates")
DEFAULT_CONCLUSION_REGISTRY = Path("runtime-artifacts/rl-control-loop/conclusion-registry.json")
E1_OWNER_CRON = "d6cff532edd4"
DEFAULT_MIN_SAMPLES = 1
DEFAULT_SHADOW_ARTIFACT_LIMIT = 200
QUALITY_REJECTED_SAMPLE_LOG_LIMIT = 50
QUALITY_TOP_REJECTED_BUCKET_LIMIT = 10
STALE_QUALITY_SOURCE_AGE_HOURS = 24.0
RUNTIME_SUMMARY_CAPTURE_COMMAND = "python3 scripts/screeps_runtime_summary_console_capture.py"
CONSOLE_CAPTURE_EXPORT_COMMAND = "python3 scripts/screeps_rl_dataset_export.py"
DEFAULT_HOME_ROOM = world_profiles.PERSISTENT_DEFAULTS.room
HOME_ROOM_ENV_VAR = "SCREEPS_HOME_ROOM"
GATE_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
SOURCE_TIMESTAMP_RE = re.compile(r"(\d{8}T\d{6}Z)")
E1_METRIC_FLOOR_KEYS = rollout_manager.METRIC_ORDER
DERIVED_RUNTIME_KPI_FLOOR_SOURCE = "current_runtime_kpi_window"
DERIVED_BASELINE_OBJECTIVE_TYPE = "screeps-rl-derived-runtime-kpi-baseline-objective"

JsonObject = dict[str, Any]


class DatasetGateError(ValueError):
    """Raised when the dataset/evaluation gate cannot safely run."""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).hexdigest()


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(temp_fd, "w", encoding="utf-8") as handle:
            temp_fd = -1
            handle.write(canonical_json(payload))
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


def load_json(path: Path) -> JsonObject:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise DatasetGateError(f"could not read {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise DatasetGateError(f"{path} is not valid JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise DatasetGateError(f"{path} must contain a JSON object")
    return parsed


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def non_negative_number(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number") from error
    if not math.isfinite(parsed) or parsed < 0:
        raise argparse.ArgumentTypeError("must be a finite non-negative number")
    return parsed


def validate_gate_id(gate_id: str) -> None:
    if not GATE_ID_RE.fullmatch(gate_id) or gate_id in {".", ".."}:
        raise DatasetGateError("gate id may contain only letters, numbers, dot, underscore, and hyphen")


def default_gate_id(
    *,
    created_at: str,
    input_paths: Sequence[str],
    candidate_config: Path | None,
    baseline_kpi: Path | None,
    current_kpi: Path | None,
    bot_commit: str,
) -> str:
    seed = {
        "baselineKpi": dataset_export.display_path(baseline_kpi) if baseline_kpi else None,
        "botCommit": bot_commit,
        "candidateConfig": dataset_export.display_path(candidate_config) if candidate_config else None,
        "createdAt": created_at,
        "currentKpi": dataset_export.display_path(current_kpi) if current_kpi else None,
        "inputPaths": [dataset_export.display_path(path) for path in input_paths],
        "schemaVersion": SCHEMA_VERSION,
    }
    return f"rl-gate-{canonical_hash(seed)[:12]}"


def build_contract() -> JsonObject:
    return {
        "type": CONTRACT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "owningIssue": "#409",
        "command": {
            "contract": "python3 scripts/screeps_rl_dataset_gate.py contract",
            "run": "python3 scripts/screeps_rl_dataset_gate.py run [artifact files/directories]",
        },
        "inputs": {
            "artifactPaths": {
                "required": False,
                "defaultRoots": list(dataset_export.DEFAULT_INPUT_PATHS),
                "accepted": [
                    "runtime-summary console artifacts",
                    "JSON runtime-summary artifacts",
                    "runtime monitor summary JSON",
                    "strategy-shadow reports as bounded metadata",
                ],
            },
            "candidateConfig": {
                "flag": "--candidate-config",
                "required": False,
                "contract": "shadow-safe JSON accepted by scripts/screeps_rl_mmo_validator.py",
            },
            "baselineKpi": {
                "flag": "--baseline-kpi",
                "required": False,
                "contract": "KPI fixture or runtime-kpi-report accepted by scripts/screeps_rl_rollout_manager.py",
            },
            "predefinedMetricFloors": [
                "--min-reliability",
                "--min-owned-rooms",
                "--min-resource-score",
                "--min-kills-score",
            ],
            "qualityHomeRoom": {
                "env": HOME_ROOM_ENV_VAR,
                "default": DEFAULT_HOME_ROOM,
                "contract": "only the configured home room is expected to have owned spawns",
            },
            "conclusionRegistry": {
                "flag": "--conclusion-registry",
                "required": False,
                "defaultWhenOutDirIsGateData": str(DEFAULT_CONCLUSION_REGISTRY),
                "contract": "read-modify-write merge keyed by conclusionId; non-E1 ownerCron records are preserved",
            },
        },
        "outputs": {
            "directory": "runtime-artifacts/rl-dataset-gates/<gate-id>/",
            "files": {
                "gateReport": "gate_report.json",
                "gateSummary": "gate_summary.json",
                "rolloutGateContract": "rollout_gate_contract.json",
                "rolloutBaselineObjective": "rollout_baseline_objective.json when --baseline-kpi is absent",
                "rolloutDecision": "rollout_decision.json when --baseline-kpi is supplied",
            },
            "linkedArtifacts": [
                "runtime-artifacts/rl-datasets/<run-id>/",
                "runtime-artifacts/strategy-shadow/<report-id>.json unless --skip-shadow-report is used",
                "historical validation report when --candidate-config is supplied",
                "runtime-artifacts/rl-control-loop/conclusion-registry.json when --conclusion-registry is supplied or --out-dir is runtime-artifacts/rl-control-loop/gate-data",
            ],
        },
        "gateChecks": {
            "dataset": "dataset run exists, has at least the configured sample count, has manifest/source/tick/KPI files, and preserves offline safety flags",
            "qualityChecks": "dataset samples must show active harvest/upgrade work, room energy, owned creeps, and home-room owned spawns; non-home rooms may have no owned spawns",
            "shadowEvaluation": "strategy-shadow report generation succeeds unless explicitly skipped",
            "historicalValidation": "candidate report must pass when --candidate-config is supplied",
            "predefinedMetrics": (
                "current KPI window must satisfy configured metric floors; missing floors are derived from the "
                "current runtime KPI window"
            ),
            "rolloutManager": (
                "dry-run decision must pass when --baseline-kpi is supplied; otherwise a derived baseline objective "
                "from the current runtime KPI window is persisted; rollout contract is always persisted"
            ),
        },
        "safety": safety_metadata(),
    }


def safety_metadata() -> JsonObject:
    return {
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "officialMmoControl": False,
        "liveApiCalls": False,
        "liveSecretsRequired": False,
        "memoryWritesAllowed": False,
        "rawMemoryWritesAllowed": False,
        "rawCreepIntentControl": False,
        "spawnIntentControl": False,
        "constructionIntentControl": False,
        "marketIntentControl": False,
        "allowedUse": "offline dataset collection, shadow evaluation, historical validation, and KPI gate evidence only",
    }


def resolve_path_against_repo(path: Path, repo_root: Path) -> Path:
    expanded = path.expanduser()
    resolved = expanded if expanded.is_absolute() else repo_root / expanded
    return resolved.resolve()


def resolve_input_paths(paths: Sequence[str], repo_root: Path) -> list[str]:
    if paths:
        return [str(resolve_path_against_repo(Path(path), repo_root)) for path in paths]
    return list(dataset_export.DEFAULT_INPUT_PATHS)


def path_is_under(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def append_shadow_report_path(input_paths: Sequence[str], shadow_report_path: Path | None, repo_root: Path) -> list[str]:
    dataset_paths = resolve_input_paths(input_paths, repo_root)
    if shadow_report_path is None or not shadow_report_path.exists():
        return dataset_paths

    resolved_shadow = shadow_report_path.resolve()
    for raw_path in dataset_paths:
        candidate = resolve_path_against_repo(Path(raw_path), repo_root)
        if candidate.is_dir() and path_is_under(resolved_shadow, candidate):
            return dataset_paths
        if candidate == resolved_shadow:
            return dataset_paths

    return [*dataset_paths, str(resolved_shadow)]


def count_ndjson_rows(path: Path) -> int:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return sum(1 for line in handle if line.strip())
    except OSError:
        return 0


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return None


def number_at_path(value: JsonObject, path: Sequence[str]) -> float | None:
    current: Any = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return finite_number(current)


def first_number(value: JsonObject, paths: Sequence[Sequence[str]]) -> float | None:
    for path in paths:
        value_at_path = number_at_path(value, path)
        if value_at_path is not None:
            return value_at_path
    return None


def positive_value(value: float | None) -> bool:
    return value is not None and value > 0


def at_least_one(value: float | None) -> bool:
    return value is not None and value >= 1


def configured_home_room() -> str:
    return os.environ.get(HOME_ROOM_ENV_VAR, "").strip() or DEFAULT_HOME_ROOM


def sample_room_name(sample: JsonObject) -> str | None:
    observation = sample.get("observation") if isinstance(sample.get("observation"), dict) else {}
    room_name = observation.get("roomName") if isinstance(observation, dict) else None
    return room_name if isinstance(room_name, str) and room_name else None


def sample_source_path(sample: JsonObject) -> str | None:
    source = sample.get("source") if isinstance(sample.get("source"), dict) else {}
    path = source.get("path") if isinstance(source, dict) else None
    return path if isinstance(path, str) and path else None


def parse_iso_utc_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def source_timestamp_from_path(path: str | None) -> datetime | None:
    if not path:
        return None
    match = SOURCE_TIMESTAMP_RE.search(path)
    if match is None:
        return None
    try:
        return datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def source_age_hours(path: str | None, created_at: str | None) -> float | None:
    created = parse_iso_utc_timestamp(created_at)
    source_created = source_timestamp_from_path(path)
    if created is None or source_created is None:
        return None
    age_hours = (created - source_created).total_seconds() / 3600
    return round(max(0.0, age_hours), 3)


def quality_evidence(sample: JsonObject) -> JsonObject:
    observation = sample.get("observation") if isinstance(sample.get("observation"), dict) else {}
    harvest_tasks = number_at_path(observation, ("workers", "taskCounts", "harvest"))
    upgrade_tasks = number_at_path(observation, ("workers", "taskCounts", "upgrade"))
    return {
        "harvestTasks": harvest_tasks,
        "upgradeTasks": upgrade_tasks,
        "workerCarriedEnergy": first_number(
            observation,
            (
                ("resources", "workerCarriedEnergy"),
                ("workerCarriedEnergy",),
            ),
        ),
        "energyAvailable": first_number(
            observation,
            (
                ("energy", "available"),
                ("energyAvailable",),
            ),
        ),
        "storedEnergy": first_number(
            observation,
            (
                ("resources", "storedEnergy"),
                ("storedEnergy",),
            ),
        ),
        "ownedCreeps": first_number(
            observation,
            (
                ("workers", "count"),
                ("ownedCreeps",),
                ("ownedCreepCount",),
                ("workerCount",),
            ),
        ),
        "ownedSpawns": first_number(
            observation,
            (
                ("spawn", "total"),
                ("monitor", "ownedSpawnCount"),
                ("ownedSpawns",),
                ("ownedSpawnCount",),
                ("spawnCount",),
            ),
        ),
    }


def quality_rejection_reasons(sample: JsonObject, *, home_room: str | None = None) -> list[str]:
    resolved_home_room = home_room or configured_home_room()
    evidence = quality_evidence(sample)
    room_name = sample_room_name(sample)
    reasons: list[str] = []
    room_energy_present = (
        positive_value(evidence["workerCarriedEnergy"])
        or positive_value(evidence["energyAvailable"])
        or positive_value(evidence["storedEnergy"])
    )
    # Console-capture data source cannot observe per-creep task assignments
    # (those are in bot Memory, not visible room objects).
    # Accept rooms with valid energy + creeps + expected spawn telemetry even when task counts are unavailable.
    spawn_requirement_satisfied = positive_value(evidence["ownedSpawns"]) or (
        room_name is not None and room_name != resolved_home_room
    )
    room_has_valid_telemetry = (
        room_energy_present
        and positive_value(evidence["ownedCreeps"])
        and spawn_requirement_satisfied
    )
    if not (
        at_least_one(evidence["harvestTasks"])
        or at_least_one(evidence["upgradeTasks"])
        or room_has_valid_telemetry
    ):
        reasons.append("no_harvest_or_upgrade_task")
    if not room_energy_present:
        reasons.append("no_room_energy")
    if not positive_value(evidence["ownedCreeps"]):
        reasons.append("no_owned_creeps")
    if room_name == resolved_home_room and not positive_value(evidence["ownedSpawns"]):
        reasons.append("no_owned_spawns")
    return reasons


def missing_quality_telemetry(evidence: JsonObject) -> bool:
    task_telemetry_missing = evidence.get("harvestTasks") is None and evidence.get("upgradeTasks") is None
    energy_telemetry_missing = (
        evidence.get("workerCarriedEnergy") is None
        and evidence.get("energyAvailable") is None
        and evidence.get("storedEnergy") is None
    )
    ownership_telemetry_missing = evidence.get("ownedCreeps") is None or evidence.get("ownedSpawns") is None
    return task_telemetry_missing or energy_telemetry_missing or ownership_telemetry_missing


def classify_quality_rejection(
    sample: JsonObject,
    reasons: Sequence[str],
    *,
    home_room: str,
    created_at: str | None = None,
) -> str:
    if "invalid_sample_json" in reasons:
        return "invalid_sample_json"

    evidence = quality_evidence(sample)
    if missing_quality_telemetry(evidence):
        return "missing_quality_telemetry"

    room_name = sample_room_name(sample)
    source_age = source_age_hours(sample_source_path(sample), created_at)
    stale_source = source_age is not None and source_age >= STALE_QUALITY_SOURCE_AGE_HOURS
    non_current_room = room_name is not None and room_name != home_room
    if stale_source and non_current_room:
        prefix = "stale_non_current_room"
    elif non_current_room:
        prefix = "non_current_room"
    else:
        prefix = "home_room"

    if "no_owned_creeps" in reasons and "no_room_energy" in reasons:
        return f"{prefix}_empty_or_lost"
    if "no_owned_creeps" in reasons:
        if positive_value(evidence["ownedSpawns"]):
            return f"{prefix}_spawn_recovery_no_owned_creeps"
        return f"{prefix}_no_owned_creeps"
    if "no_room_energy" in reasons:
        return f"{prefix}_energy_starved_actionless_creeps"
    if "no_owned_spawns" in reasons:
        return f"{prefix}_no_owned_spawns"
    if "no_harvest_or_upgrade_task" in reasons:
        return f"{prefix}_no_harvest_or_upgrade_task"
    return f"{prefix}_quality_rejection"


def increment_count(counts: dict[str, int], key: str | None) -> None:
    if not key:
        return
    counts[key] = counts.get(key, 0) + 1


def top_counts(counts: dict[str, int], *, limit: int = QUALITY_TOP_REJECTED_BUCKET_LIMIT) -> dict[str, int]:
    items = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return dict(items[:limit])


def build_quality_tail_classification(
    *,
    samples_rejected: int,
    classification_counts: dict[str, int],
    room_counts: dict[str, int],
    source_counts: dict[str, int],
    stale_source_sample_count: int,
    non_current_room_sample_count: int,
    home_room: str,
) -> JsonObject:
    if samples_rejected == 0:
        return {
            "status": "pass",
            "primary_cause": None,
            "blocker": None,
            "parser_or_instrumentation_gap_suspected": False,
        }

    primary_class = next(iter(top_counts(classification_counts, limit=1)), "unclassified_quality_rejection")
    parser_gap_count = sum(
        count
        for classification, count in classification_counts.items()
        if classification in {"invalid_sample_json", "missing_quality_telemetry"}
    )
    stale_non_current_count = sum(
        count
        for classification, count in classification_counts.items()
        if classification.startswith("stale_non_current_room")
    )
    if stale_non_current_count == samples_rejected:
        primary_cause = "stale_non_current_room_quality_tail"
        blocker = "dataset_contains_stale_non_current_room_loss_samples"
    elif parser_gap_count:
        primary_cause = "parser_or_instrumentation_gap"
        blocker = "dataset_quality_telemetry_missing_or_invalid"
    elif non_current_room_sample_count == samples_rejected:
        primary_cause = "non_current_room_quality_tail"
        blocker = "dataset_contains_non_current_unproductive_room_samples"
    else:
        primary_cause = "current_room_or_mixed_quality_tail"
        blocker = "dataset_contains_unproductive_or_unobservable_samples"

    return {
        "status": "blocked",
        "primary_cause": primary_cause,
        "primary_class": primary_class,
        "blocker": blocker,
        "home_room": home_room,
        "stale_source_age_hours": STALE_QUALITY_SOURCE_AGE_HOURS,
        "stale_source_sample_count": stale_source_sample_count,
        "non_current_room_sample_count": non_current_room_sample_count,
        "parser_or_instrumentation_gap_suspected": parser_gap_count > 0,
        "classification_counts": dict(sorted(classification_counts.items())),
        "top_rejected_rooms": top_counts(room_counts),
        "top_rejected_sources": top_counts(source_counts),
        "recommended_action": "Regenerate or narrow the dataset source window before claiming stronger E1 rollout readiness; do not mark the gate pass while rejected samples remain.",
    }


def evaluate_quality_checks(ticks_path: Path, *, home_room: str | None = None, created_at: str | None = None) -> JsonObject:
    resolved_home_room = home_room or configured_home_room()
    samples_accepted = 0
    samples_rejected = 0
    rejection_reasons: dict[str, int] = {}
    rejected_sample_classifications: dict[str, int] = {}
    rejected_room_counts: dict[str, int] = {}
    rejected_source_counts: dict[str, int] = {}
    stale_source_sample_count = 0
    non_current_room_sample_count = 0
    rejected_samples: list[JsonObject] = []

    try:
        handle = ticks_path.open("r", encoding="utf-8")
    except OSError as error:
        return {
            "status": "fail",
            "samples_total": 0,
            "samples_accepted": 0,
            "samples_rejected": 0,
            "acceptance_rate": None,
            "rejection_reasons": {"ticks_read_error": 1},
            "rejected_sample_classifications": {"ticks_read_error": 1},
            "tail_classification": {
                "status": "blocked",
                "primary_cause": "parser_or_instrumentation_gap",
                "primary_class": "ticks_read_error",
                "blocker": "dataset_ticks_unreadable",
                "parser_or_instrumentation_gap_suspected": True,
            },
            "rejected_samples": [],
            "error": dataset_export.redact_text(str(error)),
        }

    with handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                sample = json.loads(line)
            except json.JSONDecodeError:
                sample = {}
                reasons = ["invalid_sample_json"]
            else:
                reasons = (
                    quality_rejection_reasons(sample, home_room=resolved_home_room)
                    if isinstance(sample, dict)
                    else ["invalid_sample_json"]
                )

            if not reasons:
                samples_accepted += 1
                continue

            samples_rejected += 1
            for reason in reasons:
                rejection_reasons[reason] = rejection_reasons.get(reason, 0) + 1
            classification = (
                classify_quality_rejection(sample, reasons, home_room=resolved_home_room, created_at=created_at)
                if isinstance(sample, dict)
                else "invalid_sample_json"
            )
            increment_count(rejected_sample_classifications, classification)
            room_name = sample_room_name(sample) if isinstance(sample, dict) else None
            source_path = sample_source_path(sample) if isinstance(sample, dict) else None
            source_age = source_age_hours(source_path, created_at)
            if source_age is not None and source_age >= STALE_QUALITY_SOURCE_AGE_HOURS:
                stale_source_sample_count += 1
            if room_name is not None and room_name != resolved_home_room:
                non_current_room_sample_count += 1
            increment_count(rejected_room_counts, room_name or "unknown")
            increment_count(rejected_source_counts, source_path or "unknown")
            if len(rejected_samples) < QUALITY_REJECTED_SAMPLE_LOG_LIMIT:
                observation = sample.get("observation") if isinstance(sample, dict) else {}
                source = sample.get("source") if isinstance(sample, dict) else {}
                rejected_samples.append(
                    {
                        "classification": classification,
                        "line": line_number,
                        "sampleId": sample.get("sampleId") if isinstance(sample, dict) else None,
                        "tick": observation.get("tick") if isinstance(observation, dict) else None,
                        "roomName": observation.get("roomName") if isinstance(observation, dict) else None,
                        "sourcePath": source.get("path") if isinstance(source, dict) else None,
                        "sourceAgeHours": source_age,
                        "reasons": reasons,
                        "evidence": quality_evidence(sample) if isinstance(sample, dict) else {},
                    }
                )

    checks = [
        pass_fail_check(
            "productive_task_present",
            rejection_reasons.get("no_harvest_or_upgrade_task", 0) == 0,
            rejectedSamples=rejection_reasons.get("no_harvest_or_upgrade_task", 0),
            requirement="harvestTasks >=1 OR upgradeTasks >=1 OR ((workerCarriedEnergy>0 OR energyAvailable>0 OR storedEnergy>0) AND ownedCreeps>0 AND (ownedSpawns>0 OR non-home room))",
        ),
        pass_fail_check(
            "room_energy_present",
            rejection_reasons.get("no_room_energy", 0) == 0,
            rejectedSamples=rejection_reasons.get("no_room_energy", 0),
            requirement="workerCarriedEnergy > 0 OR energyAvailable > 0 OR storedEnergy > 0",
        ),
        pass_fail_check(
            "owned_creeps_present",
            rejection_reasons.get("no_owned_creeps", 0) == 0,
            rejectedSamples=rejection_reasons.get("no_owned_creeps", 0),
            requirement="ownedCreeps > 0",
        ),
        pass_fail_check(
            "owned_spawns_present",
            rejection_reasons.get("no_owned_spawns", 0) == 0,
            rejectedSamples=rejection_reasons.get("no_owned_spawns", 0),
            requirement="ownedSpawns > 0 in home room; non-home rooms may have no owned spawns",
            homeRoom=resolved_home_room,
        ),
    ]
    samples_total = samples_accepted + samples_rejected
    acceptance_rate = samples_accepted / samples_total if samples_total > 0 else None
    return {
        "status": "pass" if samples_rejected == 0 else "fail",
        "samples_total": samples_total,
        "samples_accepted": samples_accepted,
        "samples_rejected": samples_rejected,
        "acceptance_rate": round(acceptance_rate, 6) if acceptance_rate is not None else None,
        "rejection_reasons": dict(sorted(rejection_reasons.items())),
        "rejected_sample_classifications": dict(sorted(rejected_sample_classifications.items())),
        "tail_classification": build_quality_tail_classification(
            samples_rejected=samples_rejected,
            classification_counts=rejected_sample_classifications,
            room_counts=rejected_room_counts,
            source_counts=rejected_source_counts,
            stale_source_sample_count=stale_source_sample_count,
            non_current_room_sample_count=non_current_room_sample_count,
            home_room=resolved_home_room,
        ),
        "rejected_samples": rejected_samples,
        "rejected_sample_log_limit": QUALITY_REJECTED_SAMPLE_LOG_LIMIT,
        "rejected_samples_truncated": max(0, samples_rejected - len(rejected_samples)),
        "home_room": resolved_home_room,
        "checks": checks,
    }


def dataset_file_paths(dataset_out_dir: Path, run_id: str, files: JsonObject) -> dict[str, Path]:
    run_dir = dataset_out_dir.expanduser() / run_id
    return {
        "runDir": run_dir,
        "scenarioManifest": run_dir / str(files.get("scenarioManifest", "scenario_manifest.json")),
        "runManifest": run_dir / str(files.get("runManifest", "run_manifest.json")),
        "sourceIndex": run_dir / str(files.get("sourceIndex", "source_index.json")),
        "ticks": run_dir / str(files.get("ticks", "ticks.ndjson")),
        "kpiWindows": run_dir / str(files.get("kpiWindows", "kpi_windows.json")),
        "episodes": run_dir / str(files.get("episodes", "episodes.json")),
        "datasetCard": run_dir / str(files.get("datasetCard", "dataset_card.md")),
    }


def pass_fail_check(name: str, passed: bool, **details: Any) -> JsonObject:
    return {"name": name, "status": "pass" if passed else "fail", **details}


def official_mmo_control_forbidden(value: Any) -> bool:
    return value is False or (isinstance(value, str) and value.startswith("forbidden"))


def source_max_age_window_text(source_max_age_hours: Any) -> str:
    if (
        isinstance(source_max_age_hours, (int, float))
        and not isinstance(source_max_age_hours, bool)
        and math.isfinite(float(source_max_age_hours))
    ):
        return f"configured {source_max_age_hours:g}h max age"
    return "configured max-age window"


def finite_positive_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)) and float(value) > 0:
        return float(value)
    return None


def first_runtime_summary_source_root(input_paths: Sequence[Any]) -> str:
    for path in input_paths:
        if isinstance(path, str) and "runtime-summary-console" in path.replace("\\", "/"):
            return path
    for path in input_paths:
        if isinstance(path, str) and path:
            return path
    return "runtime-artifacts/runtime-summary-console"


def command_string(parts: Sequence[str]) -> str:
    return " ".join(parts)


def build_runtime_sample_cadence_diagnostics(
    *,
    input_paths: Sequence[Any],
    sample_count: int,
    min_samples: int,
    runtime_summary_count: Any,
    source_artifact_count: Any,
    source_max_age_hours: Any,
    skipped_file_reasons: Any,
) -> JsonObject:
    sample_deficit = max(0, min_samples - sample_count)
    source_root = first_runtime_summary_source_root(input_paths)
    source_max_age = finite_positive_number(source_max_age_hours)
    runtime_summary_artifacts = runtime_summary_count if isinstance(runtime_summary_count, int) else None
    samples_per_runtime_artifact: float | None = None
    precise_samples_per_runtime_artifact: float | None = None
    estimated_additional_runtime_artifacts: int | None = None
    if runtime_summary_artifacts is not None and runtime_summary_artifacts > 0 and sample_count > 0:
        precise_samples_per_runtime_artifact = sample_count / runtime_summary_artifacts
        samples_per_runtime_artifact = round(precise_samples_per_runtime_artifact, 3)
        if sample_deficit > 0:
            estimated_additional_runtime_artifacts = max(
                1,
                math.ceil(sample_deficit / precise_samples_per_runtime_artifact),
            )

    minimum_sample_cadence_minutes: float | None = None
    estimated_capture_cadence_minutes: float | None = None
    required_successful_captures_per_window: int | None = None
    if source_max_age is not None and min_samples > 0:
        minimum_sample_cadence_minutes = round(source_max_age * 60 / min_samples, 1)
        if precise_samples_per_runtime_artifact is not None and precise_samples_per_runtime_artifact > 0:
            required_successful_captures_per_window = max(
                1,
                math.ceil(min_samples / precise_samples_per_runtime_artifact),
            )
            estimated_capture_cadence_minutes = round(
                source_max_age * 60 / required_successful_captures_per_window,
                1,
            )

    capture_command = [
        *RUNTIME_SUMMARY_CAPTURE_COMMAND.split(),
        "--live-official-console",
        "--format",
        "status-line",
        "--out-dir",
        source_root,
    ]
    export_command = [
        *CONSOLE_CAPTURE_EXPORT_COMMAND.split(),
        "--console-capture-only",
        "--sample-limit",
        str(min_samples),
    ]
    if source_max_age is not None:
        export_command.extend(["--source-max-age-hours", f"{source_max_age:g}"])

    older_than_max_age_count = None
    incomplete_derived_count = None
    if isinstance(skipped_file_reasons, dict):
        older_than_max_age = skipped_file_reasons.get("older_than_max_age")
        incomplete_derived = skipped_file_reasons.get(dataset_export.INCOMPLETE_DERIVED_RUNTIME_SUMMARY_SKIP_REASON)
        older_than_max_age_count = older_than_max_age if isinstance(older_than_max_age, int) else None
        incomplete_derived_count = incomplete_derived if isinstance(incomplete_derived, int) else None

    return {
        "status": "blocked" if sample_deficit > 0 else "pass",
        "classification": "insufficient_runtime_samples" if sample_deficit > 0 else "sample_floor_satisfied",
        "minimumSamples": min_samples,
        "currentSamples": sample_count,
        "minimumAdditionalSamples": sample_deficit,
        "runtimeSummaryArtifactCount": runtime_summary_count,
        "sourceArtifactCount": source_artifact_count,
        "sourceRoot": source_root,
        "sourceMaxAgeHours": source_max_age_hours,
        "olderThanMaxAgeFileCount": older_than_max_age_count,
        "incompleteDerivedRuntimeSummaryFileCount": incomplete_derived_count,
        "observedSamplesPerRuntimeSummaryArtifact": samples_per_runtime_artifact,
        "estimatedAdditionalRuntimeSummaryArtifactsAtObservedDensity": estimated_additional_runtime_artifacts,
        "minimumAcceptedSampleCadenceMinutes": minimum_sample_cadence_minutes,
        "estimatedSuccessfulCaptureCadenceMinutesAtObservedDensity": estimated_capture_cadence_minutes,
        "requiredSuccessfulCapturesPerSourceWindowAtObservedDensity": required_successful_captures_per_window,
        "successCondition": f"next console-capture-only export reports sampleCount >= {min_samples}",
        "captureCommand": command_string(capture_command),
        "captureCommandArgs": capture_command,
        "exportCheckCommand": command_string(export_command),
        "exportCheckCommandArgs": export_command,
        "notes": [
            "Only exact-prefix #runtime-summary lines increase this floor; #cpu-summary-only captures do not count.",
            "The capture command reads the official console websocket and persists local artifacts; it does not write MMO state.",
        ],
    }


def dataset_source_diagnostics(
    dataset_summary: JsonObject,
    run_manifest: JsonObject,
    *,
    sample_count: int,
    min_samples: int,
) -> JsonObject:
    source = run_manifest.get("source") if isinstance(run_manifest.get("source"), dict) else {}
    input_paths = source.get("inputPaths") if isinstance(source.get("inputPaths"), list) else []
    source_artifact_count = dataset_summary.get("sourceArtifactCount")
    runtime_summary_count = dataset_summary.get("runtimeSummaryArtifactCount")
    skipped_sample_count = dataset_summary.get("skippedSampleCount")
    skipped_sample_reasons = dataset_summary.get("skippedSampleReasons")
    skipped_file_reasons = source.get("skippedFileReasons")
    if not isinstance(skipped_file_reasons, dict):
        skipped_file_reasons = dataset_summary.get("skippedFileReasons")
    source_max_age_hours = source.get("sourceMaxAgeHours", dataset_summary.get("sourceMaxAgeHours"))

    if sample_count >= min_samples:
        return {
            "status": "pass",
            "classification": "sample_floor_satisfied",
            "inputPaths": input_paths,
        }

    sample_cadence = build_runtime_sample_cadence_diagnostics(
        input_paths=input_paths,
        sample_count=sample_count,
        min_samples=min_samples,
        runtime_summary_count=runtime_summary_count,
        source_artifact_count=source_artifact_count,
        source_max_age_hours=source_max_age_hours,
        skipped_file_reasons=skipped_file_reasons,
    )

    if (
        source_artifact_count == 0
        and isinstance(skipped_file_reasons, dict)
        and int(skipped_file_reasons.get("older_than_max_age", 0)) > 0
    ):
        classification = "no_recent_source_artifacts_within_max_age"
        recommended_action = (
            "Refresh runtime-summary-console captures or increase the console-capture source window; "
            f"all scanned source files were older than the {source_max_age_window_text(source_max_age_hours)}."
        )
    elif source_artifact_count == 0:
        classification = "no_source_artifacts_scanned"
        recommended_action = (
            "Point the full E1 gate at runtime-summary source artifacts, such as "
            "runtime-artifacts/runtime-summary-console, instead of an empty or generated gate-data directory."
        )
    elif runtime_summary_count == 0:
        classification = "no_runtime_summary_artifacts"
        recommended_action = (
            "Use the same runtime-summary console source window that feeds the passing E1-lite gate; "
            "generated gate-data and dataset directories are outputs, not full-gate input evidence."
        )
    elif isinstance(skipped_sample_count, int) and skipped_sample_count > 0 and sample_count == 0:
        classification = "all_runtime_samples_filtered"
        recommended_action = (
            "Refresh or narrow the runtime-summary source window so the full gate has current samples "
            "for the configured home room."
        )
    else:
        classification = "insufficient_runtime_samples"
        deficit = sample_cadence["minimumAdditionalSamples"]
        artifact_estimate = sample_cadence["estimatedAdditionalRuntimeSummaryArtifactsAtObservedDensity"]
        cadence = sample_cadence["estimatedSuccessfulCaptureCadenceMinutesAtObservedDensity"]
        estimate_text = (
            f" about {artifact_estimate} more successful runtime-summary captures at the observed density"
            if isinstance(artifact_estimate, int)
            else " enough successful runtime-summary captures"
        )
        cadence_text = (
            f"; maintain roughly <= {cadence:g} minutes between successful captures inside the source window"
            if isinstance(cadence, (int, float))
            else ""
        )
        recommended_action = (
            f"Need {deficit} more accepted runtime-summary samples before treating the full E1 gate as fresh; "
            f"collect{estimate_text}{cadence_text}, then rerun the console-capture-only export."
        )

    return {
        "status": "blocked",
        "classification": classification,
        "recommendedAction": recommended_action,
        "inputPaths": input_paths,
        "scannedFiles": source.get("scannedFiles"),
        "sourceMaxAgeHours": source_max_age_hours,
        "sourceArtifactCount": source_artifact_count,
        "runtimeSummaryArtifactCount": runtime_summary_count,
        "skippedFileCount": source.get("skippedFileCount"),
        "skippedFileReasons": skipped_file_reasons,
        "skippedSampleCount": skipped_sample_count,
        "skippedSampleReasons": skipped_sample_reasons,
        "sampleCadence": sample_cadence,
    }


def evaluate_dataset_readiness(
    dataset_summary: JsonObject,
    file_paths: dict[str, Path],
    run_manifest: JsonObject,
    ticks_count: int,
    *,
    min_samples: int,
) -> JsonObject:
    sample_count = int(dataset_summary.get("sampleCount", 0)) if isinstance(dataset_summary.get("sampleCount"), int) else 0
    runtime_summary_count = (
        int(dataset_summary.get("runtimeSummaryArtifactCount", 0))
        if isinstance(dataset_summary.get("runtimeSummaryArtifactCount"), int)
        else 0
    )
    diagnostics = dataset_source_diagnostics(
        dataset_summary,
        run_manifest,
        sample_count=sample_count,
        min_samples=min_samples,
    )
    files_to_check = ("scenarioManifest", "runManifest", "sourceIndex", "ticks", "kpiWindows", "episodes", "datasetCard")
    checks: list[JsonObject] = [
        pass_fail_check(
            "minimum_samples",
            sample_count >= min_samples,
            actual=sample_count,
            required=min_samples,
            **({"sampleCadence": diagnostics.get("sampleCadence")} if sample_count < min_samples else {}),
        ),
        pass_fail_check("ticks_match_manifest_count", ticks_count == sample_count, ticksRows=ticks_count),
        pass_fail_check(
            "run_manifest_type",
            run_manifest.get("type") == dataset_export.RUN_MANIFEST_TYPE,
            actual=run_manifest.get("type"),
        ),
    ]
    if sample_count < min_samples:
        checks.append(
            pass_fail_check(
                "runtime_summary_artifacts_present",
                runtime_summary_count > 0,
                actual=runtime_summary_count,
                required=">0",
                classification=diagnostics.get("classification"),
                recommendedAction=diagnostics.get("recommendedAction"),
            )
        )
    for key in files_to_check:
        checks.append(
            pass_fail_check(
                f"file_exists:{key}",
                file_paths[key].exists(),
                path=dataset_export.display_path(file_paths[key]),
            )
        )

    safety = run_manifest.get("safety") if isinstance(run_manifest.get("safety"), dict) else {}
    strategy = run_manifest.get("strategy") if isinstance(run_manifest.get("strategy"), dict) else {}
    checks.extend(
        [
            pass_fail_check("dataset_ok", dataset_summary.get("ok") is True),
            pass_fail_check("strategy_live_effect_false", strategy.get("liveEffect") is False),
            pass_fail_check("official_mmo_control_forbidden", official_mmo_control_forbidden(safety.get("officialMmoControl"))),
        ]
    )

    failed = [check for check in checks if check["status"] != "pass"]
    return {
        "status": "pass" if not failed else "fail",
        "checks": checks,
        "sampleCount": sample_count,
        "sourceArtifactCount": dataset_summary.get("sourceArtifactCount"),
        "runtimeSummaryArtifactCount": dataset_summary.get("runtimeSummaryArtifactCount"),
        "strategyShadowReportCount": dataset_summary.get("strategyShadowReportCount"),
        "skippedSampleCount": dataset_summary.get("skippedSampleCount"),
        "skippedSampleReasons": dataset_summary.get("skippedSampleReasons"),
        "splitCounts": dataset_summary.get("splitCounts"),
        "runId": dataset_summary.get("runId"),
        "runDir": dataset_export.display_path(file_paths["runDir"]),
        "diagnostics": diagnostics,
    }


def metric_floors(
    *,
    min_reliability: float | None,
    min_owned_rooms: float | None,
    min_resource_score: float | None,
    min_kills_score: float | None,
) -> dict[str, float]:
    floors: dict[str, float] = {}
    if min_reliability is not None:
        floors["reliability"] = min_reliability
    if min_owned_rooms is not None:
        floors["territory"] = min_owned_rooms
    if min_resource_score is not None:
        floors["resources"] = min_resource_score
    if min_kills_score is not None:
        floors["kills"] = min_kills_score
    return floors


def finite_metric_value(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)):
        return float(value)
    return None


def round_metric_value(value: float) -> float | int:
    return rollout_manager.round_float(value)


def derive_runtime_metric_floor_plan(normalized_current: JsonObject, explicit_floors: dict[str, float]) -> JsonObject:
    metrics = normalized_current.get("metrics") if isinstance(normalized_current.get("metrics"), dict) else {}
    floors: dict[str, float] = {}
    derived_floors: dict[str, float | int] = {}
    explicit_floor_values: dict[str, float | int] = {}
    floor_sources: dict[str, JsonObject] = {}
    missing_metrics: list[str] = []

    for metric in E1_METRIC_FLOOR_KEYS:
        explicit_floor = finite_metric_value(explicit_floors.get(metric))
        if explicit_floor is not None:
            floors[metric] = explicit_floor
            explicit_floor_values[metric] = round_metric_value(explicit_floor)
            floor_sources[metric] = {"mode": "explicit_cli_floor", "value": round_metric_value(explicit_floor)}
            continue

        derived_floor = finite_metric_value(metrics.get(metric))
        if derived_floor is None:
            missing_metrics.append(metric)
            continue
        floors[metric] = derived_floor
        derived_floors[metric] = round_metric_value(derived_floor)
        floor_sources[metric] = {"mode": DERIVED_RUNTIME_KPI_FLOOR_SOURCE, "value": round_metric_value(derived_floor)}

    return {
        "configuredMetricCount": len(floors),
        "derivedFloors": derived_floors,
        "explicitFloors": explicit_floor_values,
        "floorSources": floor_sources,
        "floors": {metric: round_metric_value(value) for metric, value in floors.items()},
        "missingMetrics": missing_metrics,
        "requiredMetrics": list(E1_METRIC_FLOOR_KEYS),
        "source": DERIVED_RUNTIME_KPI_FLOOR_SOURCE,
    }


def evaluate_predefined_metric_gate(current_kpi: JsonObject, floors: dict[str, float], source_path: Path) -> JsonObject:
    normalized = rollout_manager.normalize_kpi_window(current_kpi, dataset_export.display_path(source_path))
    floor_plan = derive_runtime_metric_floor_plan(normalized, floors)
    checks: list[JsonObject] = []
    metrics = normalized["metrics"]
    planned_floors = floor_plan["floors"] if isinstance(floor_plan.get("floors"), dict) else {}
    for metric in E1_METRIC_FLOOR_KEYS:
        floor = finite_metric_value(planned_floors.get(metric))
        value = metrics.get(metric)
        if floor is None:
            checks.append(
                pass_fail_check(
                    metric,
                    False,
                    actual=value,
                    minimum=None,
                    reason="missing_current_kpi_metric",
                )
            )
            continue
        actual = finite_metric_value(value)
        passed = actual is not None and actual >= floor
        checks.append(
            pass_fail_check(
                metric,
                passed,
                actual=round_metric_value(actual) if actual is not None else value,
                minimum=round_metric_value(floor),
            )
        )

    return {
        "status": "pass" if all(check["status"] == "pass" for check in checks) else "fail",
        "checks": checks,
        "floorSource": {
            "mode": DERIVED_RUNTIME_KPI_FLOOR_SOURCE,
            "sourcePath": dataset_export.display_path(source_path),
            **floor_plan,
        },
        "floors": planned_floors,
        "normalizedCurrent": normalized,
    }


def build_shadow_evaluation(
    *,
    skipped: bool,
    summary: JsonObject | None = None,
    report_path: Path | None = None,
    error: Exception | None = None,
) -> JsonObject:
    if skipped:
        return {
            "status": "skipped",
            "reason": "skip_shadow_report_requested",
            "ok": True,
        }
    if error is not None:
        return {
            "status": "fail",
            "ok": False,
            "error": dataset_export.redact_text(str(error)),
        }
    return {
        "status": "pass" if summary and summary.get("ok") is True else "fail",
        "ok": bool(summary and summary.get("ok") is True),
        "summary": summary,
        "reportPath": dataset_export.display_path(report_path) if report_path else summary.get("reportPath") if summary else None,
    }


def run_historical_validation(
    *,
    candidate_config: Path | None,
    dataset_paths: Sequence[str],
    gate_dir: Path,
    gate_id: str,
    max_file_bytes: int,
    created_at: str,
) -> JsonObject:
    if candidate_config is None:
        return {
            "status": "skipped",
            "ok": True,
            "reason": "candidate_config_not_provided",
            "mode": "current_bot_behavior_dataset_gate_only",
        }

    report_id = f"{gate_id}-historical"
    try:
        report = mmo_validator.validate_candidate_against_history(
            candidate_config,
            dataset_paths,
            out_dir=gate_dir,
            report_id=report_id,
            generated_at=created_at,
            max_file_bytes=max_file_bytes,
        )
    except Exception as error:
        return {
            "status": "fail",
            "ok": False,
            "error": dataset_export.redact_text(str(error)),
        }

    return {
        "status": "pass" if report.get("ok") is True else "fail",
        "ok": bool(report.get("ok") is True),
        "reportId": report.get("reportId"),
        "reportPath": report.get("reportPath"),
        "decision": (report.get("recommendation") or {}).get("decision") if isinstance(report.get("recommendation"), dict) else None,
        "advance": (report.get("recommendation") or {}).get("advance") if isinstance(report.get("recommendation"), dict) else None,
        "scenarioCount": (report.get("validation") or {}).get("scenarioCount") if isinstance(report.get("validation"), dict) else None,
        "blockingMetrics": (report.get("rlSteward") or {}).get("blockingMetrics")
        if isinstance(report.get("rlSteward"), dict)
        else [],
    }


def build_rollout_baseline_objective(current_kpi: JsonObject, source_path: Path, created_at: str) -> JsonObject:
    normalized = rollout_manager.normalize_kpi_window(current_kpi, dataset_export.display_path(source_path))
    metrics = normalized["metrics"]
    metric_targets: dict[str, JsonObject] = {}
    missing_metrics: list[str] = []

    for metric in E1_METRIC_FLOOR_KEYS:
        value = finite_metric_value(metrics.get(metric))
        if value is None:
            missing_metrics.append(metric)
            metric_targets[metric] = {
                "status": "fail",
                "reason": "missing_current_kpi_metric",
                "source": DERIVED_RUNTIME_KPI_FLOOR_SOURCE,
                "target": None,
                "threshold": rollout_manager.METRIC_SPECS[metric].to_json(),
            }
            continue
        metric_targets[metric] = {
            "status": "pass",
            "source": DERIVED_RUNTIME_KPI_FLOOR_SOURCE,
            "target": round_metric_value(value),
            "threshold": rollout_manager.METRIC_SPECS[metric].to_json(),
        }

    return {
        "type": DERIVED_BASELINE_OBJECTIVE_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "createdAt": created_at,
        "derivation": DERIVED_RUNTIME_KPI_FLOOR_SOURCE,
        "missingMetrics": missing_metrics,
        "metrics": metric_targets,
        "normalizedCurrent": normalized,
        "sourcePath": dataset_export.display_path(source_path),
        "status": "pass" if not missing_metrics else "fail",
    }


def run_rollout_gate(
    *,
    baseline_kpi: Path | None,
    current_kpi: JsonObject,
    current_kpi_path: Path,
    gate_dir: Path,
    candidate_id: str | None,
    deploy_ref: str | None,
    created_at: str,
    gate_id: str,
) -> JsonObject:
    contract_path = gate_dir / "rollout_gate_contract.json"
    write_json_atomic(contract_path, rollout_manager.build_gate_contract())

    if baseline_kpi is None:
        objective = build_rollout_baseline_objective(current_kpi, current_kpi_path, created_at)
        objective_path = gate_dir / "rollout_baseline_objective.json"
        write_json_atomic(objective_path, objective)
        if objective.get("status") != "pass":
            return {
                "status": "fail",
                "ok": False,
                "reason": "derived_baseline_objective_missing_metrics",
                "contractPath": dataset_export.display_path(contract_path),
                "objectivePath": dataset_export.display_path(objective_path),
                "baselineObjective": objective,
                "blockingReasons": [
                    {"scope": "rolloutBaselineObjective", "metric": metric, "reason": "missing_current_kpi_metric"}
                    for metric in objective.get("missingMetrics", [])
                    if isinstance(metric, str)
                ],
            }
        return {
            "status": "objective",
            "ok": True,
            "reason": "baseline_kpi_derived_from_current_runtime_kpi",
            "contractPath": dataset_export.display_path(contract_path),
            "objectivePath": dataset_export.display_path(objective_path),
            "baselineObjective": objective,
        }

    pre = load_json(baseline_kpi)
    decision = rollout_manager.build_dry_run_decision(
        pre,
        current_kpi,
        candidate_id=candidate_id,
        deploy_ref=deploy_ref,
        created_at=created_at,
        rollout_id=f"{gate_id}-rollout",
        pre_source=dataset_export.display_path(baseline_kpi),
        post_source=dataset_export.display_path(current_kpi_path),
    )
    decision_path = gate_dir / "rollout_decision.json"
    write_json_atomic(decision_path, decision)
    return {
        "status": "pass" if decision.get("passed") is True else "fail",
        "ok": bool(decision.get("passed") is True),
        "decision": decision.get("decision"),
        "decisionPath": dataset_export.display_path(decision_path),
        "contractPath": dataset_export.display_path(contract_path),
        "blockingReasons": decision.get("blockingReasons"),
        "feedbackIngestion": decision.get("feedbackIngestion"),
    }


def collect_blocking_reasons(report: JsonObject) -> list[JsonObject]:
    reasons: list[JsonObject] = []

    dataset_gate = report.get("datasetGate")
    if isinstance(dataset_gate, dict) and dataset_gate.get("status") != "pass":
        for check in dataset_gate.get("checks", []):
            if isinstance(check, dict) and check.get("status") != "pass":
                reasons.append({"gate": "dataset", **check})

    quality_checks = report.get("quality_checks")
    if isinstance(quality_checks, dict) and quality_checks.get("status") != "pass":
        reasons.append(
            {
                "gate": "quality_checks",
                "name": "sample_quality",
                "status": quality_checks.get("status"),
                "samplesAccepted": quality_checks.get("samples_accepted"),
                "samplesRejected": quality_checks.get("samples_rejected"),
                "acceptanceRate": quality_checks.get("acceptance_rate"),
                "rejectionReasons": quality_checks.get("rejection_reasons"),
                "tailClassification": quality_checks.get("tail_classification"),
            }
        )

    for key in ("shadowEvaluation", "historicalValidation", "predefinedMetricGate", "rolloutGate"):
        gate = report.get(key)
        if not isinstance(gate, dict):
            continue
        status = gate.get("status")
        if status in ("pass", "skipped", "not_configured", "objective"):
            continue
        reasons.append(
            {
                "gate": key,
                "status": status,
                **({"error": gate["error"]} if isinstance(gate.get("error"), str) else {}),
                **({"decision": gate["decision"]} if isinstance(gate.get("decision"), str) else {}),
            }
        )

    return reasons


def build_summary(report: JsonObject) -> JsonObject:
    dataset_gate = report.get("datasetGate") if isinstance(report.get("datasetGate"), dict) else {}
    dataset = report.get("dataset") if isinstance(report.get("dataset"), dict) else {}
    quality = report.get("quality_checks") if isinstance(report.get("quality_checks"), dict) else {}
    shadow = report.get("shadowEvaluation") if isinstance(report.get("shadowEvaluation"), dict) else {}
    historical = report.get("historicalValidation") if isinstance(report.get("historicalValidation"), dict) else {}
    predefined = report.get("predefinedMetricGate") if isinstance(report.get("predefinedMetricGate"), dict) else {}
    rollout = report.get("rolloutGate") if isinstance(report.get("rolloutGate"), dict) else {}
    registry = report.get("conclusionRegistry") if isinstance(report.get("conclusionRegistry"), dict) else {}
    return {
        "ok": report.get("ok") is True,
        "type": SUMMARY_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "gateId": report.get("gateId"),
        "reportPath": report.get("reportPath"),
        "datasetRunId": dataset.get("runId"),
        "datasetPath": dataset.get("outDir"),
        "sampleCount": dataset_gate.get("sampleCount"),
        "qualityChecksStatus": quality.get("status"),
        "samplesAccepted": quality.get("samples_accepted"),
        "samplesRejected": quality.get("samples_rejected"),
        "qualityAcceptanceRate": quality.get("acceptance_rate"),
        "qualityTailClassification": (quality.get("tail_classification") or {}).get("primary_cause")
        if isinstance(quality.get("tail_classification"), dict)
        else None,
        "shadowStatus": shadow.get("status"),
        "shadowReportPath": shadow.get("reportPath"),
        "historicalValidationStatus": historical.get("status"),
        "historicalValidationDecision": historical.get("decision"),
        "predefinedMetricGateStatus": predefined.get("status"),
        "rolloutGateStatus": rollout.get("status"),
        "rolloutDecision": rollout.get("decision"),
        "conclusionRegistryPath": registry.get("path"),
        "conclusionRegistrySummary": registry.get("summary"),
        "blockingReasons": report.get("blockingReasons", []),
    }


def inferred_conclusion_registry_path(out_dir: Path) -> Path | None:
    resolved = out_dir.expanduser().resolve()
    if resolved.name == "gate-data" and resolved.parent.name == "rl-control-loop":
        return resolved.parent / "conclusion-registry.json"
    return None


def resolve_conclusion_registry_path(
    conclusion_registry_path: Path | None,
    out_dir: Path,
    repo_root: Path,
) -> Path | None:
    if conclusion_registry_path is not None:
        return resolve_path_against_repo(conclusion_registry_path, repo_root)
    return inferred_conclusion_registry_path(out_dir)


def source_artifacts_for_report(report: JsonObject) -> list[str]:
    outputs = report.get("outputs") if isinstance(report.get("outputs"), dict) else {}
    candidates = [report.get("reportPath"), outputs.get("reportPath"), outputs.get("gateDir")]
    artifacts: list[str] = []
    seen: set[str] = set()
    for value in candidates:
        if not isinstance(value, str) or not value or value in seen:
            continue
        seen.add(value)
        artifacts.append(value)
    return artifacts


def e1_gate_conclusions(report: JsonObject, *, updated_at: str) -> list[JsonObject]:
    gate_id = str(report.get("gateId") or "unknown")
    source_artifacts = source_artifacts_for_report(report)
    dataset = report.get("dataset") if isinstance(report.get("dataset"), dict) else {}
    dataset_gate = report.get("datasetGate") if isinstance(report.get("datasetGate"), dict) else {}
    quality = report.get("quality_checks") if isinstance(report.get("quality_checks"), dict) else {}
    shadow = report.get("shadowEvaluation") if isinstance(report.get("shadowEvaluation"), dict) else {}
    predefined = report.get("predefinedMetricGate") if isinstance(report.get("predefinedMetricGate"), dict) else {}

    samples_accepted = quality.get("samples_accepted")
    samples_rejected = quality.get("samples_rejected")
    gate_ok = report.get("ok") is True
    records: list[JsonObject] = [
        {
            "conclusionId": "E1-GATE-STATUS",
            "sourceArtifacts": source_artifacts,
            "category": "gate-status",
            "severity": "P3" if gate_ok else "P1",
            "statement": (
                f"E1 shadow-eval gate {gate_id} {'PASSED' if gate_ok else 'BLOCKED'}: "
                f"{samples_accepted if samples_accepted is not None else 'unknown'} accepted, "
                f"{samples_rejected if samples_rejected is not None else 'unknown'} rejected."
            ),
            "status": "CLOSED" if gate_ok else "OPEN",
            "closureAction": "Gate report and metrics persisted." if gate_ok else None,
            "linkedIssues": ["#1566", "#893", "#906"],
            "requiredLandingEvidence": "Gate report JSON persisted and dashboard/metrics ingest can read it.",
            "sustainedOutputRule": "Gate must keep passing with acceptance >= 0.95 on the next E1 run.",
            "nextVerification": updated_at,
            "lastSeenAt": updated_at,
            "staleAfterHours": 48,
            "gateId": gate_id,
        }
    ]

    split_counts = dataset.get("splitCounts") if isinstance(dataset.get("splitCounts"), dict) else {}
    eval_count = split_counts.get("eval")
    if isinstance(eval_count, int):
        records.append(
            {
                "conclusionId": "E1-EVAL-SAMPLE-LIMITED",
                "sourceArtifacts": source_artifacts,
                "category": "data-quality",
                "severity": "P2",
                "statement": f"Eval split has {eval_count} samples. Statistical power is limited below 50 samples.",
                "status": "OPEN" if eval_count < 50 else "CLOSED",
                "closureAction": "Eval split reached at least 50 samples." if eval_count >= 50 else None,
                "linkedIssues": ["#1566", "#893"],
                "requiredLandingEvidence": "Eval set >= 50 samples or explicit owner/steward acceptance.",
                "sustainedOutputRule": "Flag on every E1 run while eval samples remain below 50.",
                "nextVerification": updated_at,
                "lastSeenAt": updated_at,
                "staleAfterHours": 72,
                "gateId": gate_id,
            }
        )

    if predefined.get("status") == "not_configured":
        normalized = predefined.get("normalizedCurrent") if isinstance(predefined.get("normalizedCurrent"), dict) else {}
        metrics = normalized.get("metrics") if isinstance(normalized.get("metrics"), dict) else {}
        records.append(
            {
                "conclusionId": "E1-PREDEFINED-METRIC-NOT-CONFIGURED",
                "sourceArtifacts": source_artifacts,
                "category": "configuration-gap",
                "severity": "P2",
                "statement": (
                    "Predefined metric gate not configured"
                    f" (territory={metrics.get('territory')}, resources={metrics.get('resources')}, "
                    f"kills={metrics.get('kills')}, reliability={metrics.get('reliability')})."
                ),
                "status": "OPEN",
                "closureAction": None,
                "linkedIssues": ["#893", "#906"],
                "requiredLandingEvidence": "Metric floors configured in a future E1 gate run.",
                "sustainedOutputRule": "Flag on every E1 run until metric floors are configured.",
                "nextVerification": updated_at,
                "lastSeenAt": updated_at,
                "staleAfterHours": 72,
                "gateId": gate_id,
            }
        )

    shadow_status = shadow.get("status")
    if shadow_status not in (None, "skipped"):
        records.append(
            {
                "conclusionId": "E1-SHADOW-EVAL-STATUS",
                "sourceArtifacts": [value for value in [shadow.get("reportPath"), *source_artifacts] if isinstance(value, str)],
                "category": "strategy-eval",
                "severity": "P3" if shadow_status == "pass" else "P1",
                "statement": f"Shadow eval status is {shadow_status}; ranking context evidence remains gate-owned.",
                "status": "CLOSED" if shadow_status == "pass" else "OPEN",
                "closureAction": "Shadow report generated without blocking regression." if shadow_status == "pass" else None,
                "linkedIssues": ["#1566", "#893"],
                "requiredLandingEvidence": "Shadow report with non-regressing candidate-vs-incumbent evidence.",
                "sustainedOutputRule": "Reopen if shadow evaluation fails or reports unsafe/live-write flags.",
                "nextVerification": updated_at,
                "lastSeenAt": updated_at,
                "staleAfterHours": 48,
                "gateId": gate_id,
            }
        )

    if dataset_gate.get("status") == "pass" and quality.get("status") == "pass":
        records.append(
            {
                "conclusionId": "E1-CONSOLE-CAPTURE-FLOWING",
                "sourceArtifacts": source_artifacts,
                "category": "data-quality",
                "severity": "P2",
                "statement": (
                    "Console capture pipeline is flowing: "
                    f"{dataset_gate.get('sampleCount', dataset.get('sampleCount', 'unknown'))} samples accepted by the dataset gate."
                ),
                "status": "CLOSED",
                "closureAction": "Dataset and quality gates passed.",
                "linkedIssues": ["#1566", "#893"],
                "requiredLandingEvidence": "Two consecutive gate runs with acceptable quality and sample counts.",
                "sustainedOutputRule": "Reopen if quality acceptance drops below 0.95.",
                "nextVerification": updated_at,
                "lastSeenAt": updated_at,
                "staleAfterHours": 48,
                "gateId": gate_id,
            }
        )

    return records


def run_gate(
    paths: Sequence[str],
    *,
    out_dir: Path = DEFAULT_OUT_DIR,
    gate_id: str | None = None,
    created_at: str | None = None,
    dataset_out_dir: Path = dataset_export.DEFAULT_OUT_DIR,
    dataset_run_id: str | None = None,
    bot_commit: str | None = None,
    max_file_bytes: int = dataset_export.DEFAULT_MAX_FILE_BYTES,
    sample_limit: int = dataset_export.DEFAULT_SAMPLE_LIMIT,
    eval_ratio_value: float = dataset_export.DEFAULT_EVAL_RATIO,
    split_seed: str = "screeps-rl-v1",
    min_samples: int = DEFAULT_MIN_SAMPLES,
    skip_shadow_report: bool = False,
    shadow_out_dir: Path = shadow_report.DEFAULT_OUT_DIR,
    shadow_report_id: str | None = None,
    shadow_artifact_limit: int = DEFAULT_SHADOW_ARTIFACT_LIMIT,
    dist_path: Path = shadow_report.DEFAULT_DIST_PATH,
    candidate_strategy_ids: Sequence[str] = (),
    candidate_config: Path | None = None,
    baseline_kpi: Path | None = None,
    current_kpi: Path | None = None,
    candidate_id: str | None = None,
    deploy_ref: str | None = None,
    min_reliability: float | None = None,
    min_owned_rooms: float | None = None,
    min_resource_score: float | None = None,
    min_kills_score: float | None = None,
    conclusion_registry_path: Path | None = None,
    repo_root: Path | None = None,
) -> JsonObject:
    repo = (repo_root or Path.cwd()).expanduser().resolve()
    created = created_at or utc_now_iso()
    if parse_iso_utc_timestamp(created) is None:
        raise DatasetGateError("--created-at must be a valid ISO-8601 UTC timestamp")
    resolved_bot_commit = bot_commit or dataset_export.git_commit(repo)
    resolved_home_room = configured_home_room()
    resolved_gate_id = gate_id or default_gate_id(
        created_at=created,
        input_paths=paths,
        candidate_config=candidate_config,
        baseline_kpi=baseline_kpi,
        current_kpi=current_kpi,
        bot_commit=resolved_bot_commit,
    )
    validate_gate_id(resolved_gate_id)

    resolved_out_dir = resolve_path_against_repo(out_dir, repo)
    gate_dir = resolved_out_dir / resolved_gate_id
    resolved_dataset_out_dir = resolve_path_against_repo(dataset_out_dir, repo)
    resolved_shadow_out_dir = resolve_path_against_repo(shadow_out_dir, repo)
    resolved_dist_path = resolve_path_against_repo(dist_path, repo)
    gate_dir.mkdir(parents=True, exist_ok=True)

    shadow_summary: JsonObject | None = None
    shadow_report_path: Path | None = None
    shadow_error: Exception | None = None
    if not skip_shadow_report:
        resolved_shadow_report_id = shadow_report_id or f"{resolved_gate_id}-shadow"
        try:
            shadow_summary = shadow_report.build_strategy_shadow_report(
                paths,
                resolved_shadow_out_dir,
                dist_path=resolved_dist_path,
                report_id=resolved_shadow_report_id,
                generated_at=created,
                bot_commit=resolved_bot_commit,
                max_file_bytes=max_file_bytes,
                artifact_limit=shadow_artifact_limit,
                candidate_strategy_ids=candidate_strategy_ids,
                repo_root=repo,
            )
            shadow_report_path = resolved_shadow_out_dir / f"{resolved_shadow_report_id}.json"
        except Exception as error:
            shadow_error = error

    dataset_paths = append_shadow_report_path(paths, shadow_report_path, repo)
    dataset_summary = dataset_export.build_dataset(
        dataset_paths,
        resolved_dataset_out_dir,
        run_id=dataset_run_id,
        bot_commit=resolved_bot_commit,
        max_file_bytes=max_file_bytes,
        sample_limit=sample_limit,
        eval_ratio_value=eval_ratio_value,
        split_seed=split_seed,
        repo_root=repo,
        created_at=created,
        home_room=resolved_home_room,
    )
    file_paths = dataset_file_paths(resolved_dataset_out_dir, str(dataset_summary["runId"]), dataset_summary["files"])
    run_manifest = load_json(file_paths["runManifest"])
    current_kpi_path = resolve_path_against_repo(current_kpi, repo) if current_kpi is not None else file_paths["kpiWindows"]
    current_kpi_payload = load_json(current_kpi_path)
    ticks_count = count_ndjson_rows(file_paths["ticks"])

    dataset_gate = evaluate_dataset_readiness(
        dataset_summary,
        file_paths,
        run_manifest,
        ticks_count,
        min_samples=min_samples,
    )
    quality_checks = evaluate_quality_checks(file_paths["ticks"], home_room=resolved_home_room, created_at=created)
    floors = metric_floors(
        min_reliability=min_reliability,
        min_owned_rooms=min_owned_rooms,
        min_resource_score=min_resource_score,
        min_kills_score=min_kills_score,
    )
    predefined_gate = evaluate_predefined_metric_gate(current_kpi_payload, floors, current_kpi_path)
    historical_validation = run_historical_validation(
        candidate_config=resolve_path_against_repo(candidate_config, repo) if candidate_config is not None else None,
        dataset_paths=dataset_paths,
        gate_dir=gate_dir,
        gate_id=resolved_gate_id,
        max_file_bytes=max_file_bytes,
        created_at=created,
    )
    rollout_gate = run_rollout_gate(
        baseline_kpi=resolve_path_against_repo(baseline_kpi, repo) if baseline_kpi is not None else None,
        current_kpi=current_kpi_payload,
        current_kpi_path=current_kpi_path,
        gate_dir=gate_dir,
        candidate_id=candidate_id,
        deploy_ref=deploy_ref,
        created_at=created,
        gate_id=resolved_gate_id,
    )

    report_path = gate_dir / "gate_report.json"
    report: JsonObject = {
        "ok": False,
        "type": REPORT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "gateId": resolved_gate_id,
        "createdAt": created,
        "owningIssue": "#409",
        "mode": "candidate" if candidate_config is not None else "current-bot-behavior",
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
        "input": {
            "paths": [dataset_export.display_path(path) for path in dataset_paths],
            "candidateConfig": dataset_export.display_path(candidate_config) if candidate_config is not None else None,
            "baselineKpi": dataset_export.display_path(baseline_kpi) if baseline_kpi is not None else None,
            "currentKpi": dataset_export.display_path(current_kpi_path),
            "botCommit": resolved_bot_commit,
        },
        "dataset": dataset_summary,
        "datasetGate": dataset_gate,
        "quality_checks": quality_checks,
        "shadowEvaluation": build_shadow_evaluation(
            skipped=skip_shadow_report,
            summary=shadow_summary,
            report_path=shadow_report_path,
            error=shadow_error,
        ),
        "historicalValidation": historical_validation,
        "predefinedMetricGate": predefined_gate,
        "rolloutGate": rollout_gate,
        "outputs": {
            "gateDir": dataset_export.display_path(gate_dir),
            "reportPath": dataset_export.display_path(report_path),
            "summaryPath": dataset_export.display_path(gate_dir / "gate_summary.json"),
        },
    }
    report["blockingReasons"] = collect_blocking_reasons(report)
    report["ok"] = not report["blockingReasons"]
    report["reportPath"] = dataset_export.display_path(report_path)

    resolved_conclusion_registry_path = resolve_conclusion_registry_path(
        conclusion_registry_path,
        resolved_out_dir,
        repo,
    )
    summary_path = gate_dir / "gate_summary.json"
    summary = build_summary(report)
    write_json_atomic(report_path, report)
    write_json_atomic(summary_path, summary)

    if resolved_conclusion_registry_path is not None:
        merged_registry = conclusion_registry.merge_registry_file(
            resolved_conclusion_registry_path,
            e1_gate_conclusions(report, updated_at=created),
            owner_cron=E1_OWNER_CRON,
            updated_at=created,
            updated_by=E1_OWNER_CRON,
        )
        report["outputs"]["conclusionRegistryPath"] = dataset_export.display_path(resolved_conclusion_registry_path)
        report["conclusionRegistry"] = {
            "path": dataset_export.display_path(resolved_conclusion_registry_path),
            "ownerCron": E1_OWNER_CRON,
            "summary": merged_registry.get("summary"),
        }
        summary = build_summary(report)
        write_json_atomic(report_path, report)
        write_json_atomic(summary_path, summary)

    dataset_export.assert_no_secret_leak(gate_dir, dataset_export.configured_secret_values())
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Collect an RL dataset and run the offline evaluation gate for saved Screeps artifacts.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    contract = subparsers.add_parser("contract", help="Print the dataset/evaluation gate input/output contract.")
    contract.add_argument("--output", type=Path, help="Write JSON output to this path instead of stdout.")

    run = subparsers.add_parser("run", help="Collect a dataset and evaluate candidate/current behavior gates.")
    run.add_argument(
        "paths",
        nargs="*",
        help="Runtime artifact files/directories. Defaults to the RL dataset exporter safe local roots.",
    )
    run.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR, help=f"Gate report output root. Default: {DEFAULT_OUT_DIR}.")
    run.add_argument("--gate-id", help="Optional stable gate report directory name.")
    run.add_argument("--created-at", help="ISO UTC timestamp to record. Defaults to current UTC second.")
    run.add_argument("--dataset-out-dir", type=Path, default=dataset_export.DEFAULT_OUT_DIR)
    run.add_argument("--dataset-run-id", help="Optional dataset run ID to pass to the exporter.")
    run.add_argument("--bot-commit", help="Bot commit to record. Defaults to git rev-parse HEAD.")
    run.add_argument("--repo-root", type=Path, help="Repository root for resolving relative inputs and outputs.")
    run.add_argument("--max-file-bytes", type=positive_int, default=dataset_export.DEFAULT_MAX_FILE_BYTES)
    run.add_argument("--sample-limit", type=positive_int, default=dataset_export.DEFAULT_SAMPLE_LIMIT)
    run.add_argument("--eval-ratio", type=dataset_export.eval_ratio, default=dataset_export.DEFAULT_EVAL_RATIO)
    run.add_argument("--split-seed", default="screeps-rl-v1")
    run.add_argument("--min-samples", type=positive_int, default=DEFAULT_MIN_SAMPLES)
    run.add_argument("--skip-shadow-report", action="store_true", help="Skip strategy-shadow report generation.")
    run.add_argument("--shadow-out-dir", type=Path, default=shadow_report.DEFAULT_OUT_DIR)
    run.add_argument("--shadow-report-id", help="Optional strategy-shadow report file stem.")
    run.add_argument("--shadow-artifact-limit", type=positive_int, default=DEFAULT_SHADOW_ARTIFACT_LIMIT)
    run.add_argument("--dist-path", type=Path, default=shadow_report.DEFAULT_DIST_PATH)
    run.add_argument(
        "--candidate-strategy-id",
        action="append",
        default=[],
        help="Candidate strategy ID for the shadow evaluator. Repeatable.",
    )
    run.add_argument("--candidate-config", type=Path, help="Optional shadow-safe candidate config for historical validation.")
    run.add_argument(
        "--baseline-kpi",
        type=Path,
        help=(
            "Optional pre/baseline KPI fixture for rollout-manager dry-run. When omitted, "
            "a baseline objective is derived from the current runtime KPI window."
        ),
    )
    run.add_argument("--current-kpi", type=Path, help="Optional current KPI fixture. Defaults to the generated dataset kpi_windows.json.")
    run.add_argument("--candidate-id", help="Candidate ID recorded in rollout-manager dry-run output.")
    run.add_argument("--deploy-ref", help="Candidate deploy ref recorded in rollout-manager dry-run output.")
    run.add_argument("--min-reliability", type=non_negative_number, help="Optional current KPI reliability floor.")
    run.add_argument("--min-owned-rooms", type=non_negative_number, help="Optional current owned-room floor.")
    run.add_argument("--min-resource-score", type=non_negative_number, help="Optional current resource-score floor.")
    run.add_argument("--min-kills-score", type=non_negative_number, help="Optional current kills-score floor.")
    run.add_argument(
        "--conclusion-registry",
        type=Path,
        help=(
            "Optional conclusion registry path. If omitted, gate-data out dirs under "
            "runtime-artifacts/rl-control-loop infer conclusion-registry.json."
        ),
    )
    run.add_argument("--print-report", action="store_true", help="Print the full gate report instead of the compact summary.")
    return parser


def write_output(payload: JsonObject, output: Path | None, stdout: TextIO) -> None:
    if output is None:
        screeps_cli_io.write_json(stdout, payload)
        return
    write_json_atomic(output, payload)


def cli_failure_created_at(args: argparse.Namespace) -> str:
    created_at = getattr(args, "created_at", None)
    if isinstance(created_at, str) and parse_iso_utc_timestamp(created_at) is not None:
        return created_at
    return utc_now_iso()


def cli_failure_gate_id(args: argparse.Namespace, repo: Path, created_at: str) -> str:
    gate_id = getattr(args, "gate_id", None)
    if isinstance(gate_id, str) and gate_id:
        validate_gate_id(gate_id)
        return gate_id
    bot_commit = getattr(args, "bot_commit", None) or dataset_export.git_commit(repo)
    return default_gate_id(
        created_at=created_at,
        input_paths=getattr(args, "paths", []),
        candidate_config=getattr(args, "candidate_config", None),
        baseline_kpi=getattr(args, "baseline_kpi", None),
        current_kpi=getattr(args, "current_kpi", None),
        bot_commit=bot_commit,
    )


def build_cli_failure_report(
    args: argparse.Namespace,
    error: Exception,
    *,
    repo: Path,
    created_at: str,
    gate_id: str,
    gate_dir: Path,
) -> JsonObject:
    report_path = gate_dir / "gate_report.json"
    summary_path = gate_dir / "gate_summary.json"
    redacted_error = dataset_export.redact_text(str(error))
    bot_commit = getattr(args, "bot_commit", None) or dataset_export.git_commit(repo)
    input_paths = [
        dataset_export.display_path(path)
        for path in resolve_input_paths(getattr(args, "paths", []), repo)
    ]
    failure = {
        "status": "fail",
        "stage": "full_gate_execution",
        "errorClass": error.__class__.__name__,
        "error": redacted_error,
        "recommendedAction": (
            "Inspect this executionFailure block and rerun the full E1 gate after correcting the input "
            "or configuration error. The CLI persists this report before returning non-zero so the "
            "control loop does not treat the gate directory as silently empty."
        ),
    }
    blocking_reason = {
        "gate": "execution",
        "name": "full_gate_execution",
        "status": "fail",
        "errorClass": failure["errorClass"],
        "error": redacted_error,
    }
    return {
        "ok": False,
        "type": REPORT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "gateId": gate_id,
        "createdAt": created_at,
        "owningIssue": "#409",
        "mode": "candidate" if getattr(args, "candidate_config", None) is not None else "current-bot-behavior",
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": safety_metadata(),
        "input": {
            "paths": input_paths,
            "candidateConfig": dataset_export.display_path(getattr(args, "candidate_config", None))
            if getattr(args, "candidate_config", None) is not None
            else None,
            "baselineKpi": dataset_export.display_path(getattr(args, "baseline_kpi", None))
            if getattr(args, "baseline_kpi", None) is not None
            else None,
            "currentKpi": dataset_export.display_path(getattr(args, "current_kpi", None))
            if getattr(args, "current_kpi", None) is not None
            else None,
            "botCommit": bot_commit,
        },
        "datasetGate": {
            "status": "fail",
            "checks": [
                pass_fail_check(
                    "gate_execution_completed",
                    False,
                    errorClass=failure["errorClass"],
                    error=redacted_error,
                )
            ],
        },
        "executionFailure": failure,
        "blockingReasons": [blocking_reason],
        "outputs": {
            "gateDir": dataset_export.display_path(gate_dir),
            "reportPath": dataset_export.display_path(report_path),
            "summaryPath": dataset_export.display_path(summary_path),
        },
        "reportPath": dataset_export.display_path(report_path),
    }


def build_post_report_failure(error: Exception) -> JsonObject:
    redacted_error = dataset_export.redact_text(str(error))
    return {
        "status": "fail",
        "stage": "post_report_persistence",
        "errorClass": error.__class__.__name__,
        "error": redacted_error,
        "recommendedAction": (
            "The gate report was already written and has been preserved. Inspect this postReportFailure "
            "block, correct the post-report persistence error, and rerun the full E1 gate if registry "
            "or wrapper evidence must be refreshed."
        ),
    }


def preserve_completed_gate_artifacts(report_path: Path, summary_path: Path, error: Exception, stderr: TextIO) -> bool:
    if not report_path.exists() and not summary_path.exists():
        return False

    post_report_failure = build_post_report_failure(error)
    preserved_paths: list[Path] = []
    report: JsonObject | None = None

    if report_path.exists():
        report = load_json(report_path)
        report["postReportFailure"] = post_report_failure
        write_json_atomic(report_path, report)
        preserved_paths.append(report_path)

    if summary_path.exists():
        summary = load_json(summary_path)
    elif report is not None:
        summary = build_summary(report)
    else:
        summary = None

    if summary is not None:
        summary["postReportFailure"] = post_report_failure
        write_json_atomic(summary_path, summary)
        preserved_paths.append(summary_path)

    displayed_paths = ", ".join(dataset_export.display_path(path) for path in preserved_paths)
    screeps_cli_io.write_text(
        stderr,
        f"preserved completed gate artifacts after post-report failure: {displayed_paths}\n",
    )
    return True


def persist_cli_failure_report(args: argparse.Namespace, error: Exception, stderr: TextIO) -> None:
    if getattr(args, "command", None) != "run":
        return
    try:
        repo = (getattr(args, "repo_root", None) or Path.cwd()).expanduser().resolve()
        created_at = cli_failure_created_at(args)
        gate_id = cli_failure_gate_id(args, repo, created_at)
        out_dir = resolve_path_against_repo(getattr(args, "out_dir", DEFAULT_OUT_DIR), repo)
        gate_dir = out_dir / gate_id
        gate_dir.mkdir(parents=True, exist_ok=True)
        report_path = gate_dir / "gate_report.json"
        summary_path = gate_dir / "gate_summary.json"
        if preserve_completed_gate_artifacts(report_path, summary_path, error, stderr):
            return
        report = build_cli_failure_report(args, error, repo=repo, created_at=created_at, gate_id=gate_id, gate_dir=gate_dir)
        write_json_atomic(report_path, report)
        write_json_atomic(summary_path, build_summary(report))
        screeps_cli_io.write_text(stderr, f"failure report: {dataset_export.display_path(report_path)}\n")
    except Exception as report_error:  # noqa: BLE001 - best-effort diagnostics must not hide the original error
        screeps_cli_io.write_text(
            stderr,
            f"warning: could not write failure report: {dataset_export.redact_text(str(report_error))}\n",
        )


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "contract":
            write_output(build_contract(), args.output, stdout)
            return 0

        if args.command == "run":
            report = run_gate(
                args.paths,
                out_dir=args.out_dir,
                gate_id=args.gate_id,
                created_at=args.created_at,
                dataset_out_dir=args.dataset_out_dir,
                dataset_run_id=args.dataset_run_id,
                bot_commit=args.bot_commit,
                max_file_bytes=args.max_file_bytes,
                sample_limit=args.sample_limit,
                eval_ratio_value=args.eval_ratio,
                split_seed=args.split_seed,
                min_samples=args.min_samples,
                skip_shadow_report=args.skip_shadow_report,
                shadow_out_dir=args.shadow_out_dir,
                shadow_report_id=args.shadow_report_id,
                shadow_artifact_limit=args.shadow_artifact_limit,
                dist_path=args.dist_path,
                candidate_strategy_ids=args.candidate_strategy_id,
                candidate_config=args.candidate_config,
                baseline_kpi=args.baseline_kpi,
                current_kpi=args.current_kpi,
                candidate_id=args.candidate_id,
                deploy_ref=args.deploy_ref,
                min_reliability=args.min_reliability,
                min_owned_rooms=args.min_owned_rooms,
                min_resource_score=args.min_resource_score,
                min_kills_score=args.min_kills_score,
                conclusion_registry_path=args.conclusion_registry,
                repo_root=args.repo_root,
            )
            screeps_cli_io.write_json(stdout, report if args.print_report else build_summary(report))
            return 0 if report.get("ok") is True else 1

        parser.error(f"unsupported command: {args.command}")
    except (DatasetGateError, conclusion_registry.ConclusionRegistryError) as error:
        persist_cli_failure_report(args, error, stderr)
        screeps_cli_io.write_text(stderr, f"error: {error}\n")
        return 2
    except (RuntimeError, OSError, mmo_validator.ValidationConfigError) as error:
        persist_cli_failure_report(args, error, stderr)
        screeps_cli_io.write_text(stderr, f"error: {dataset_export.redact_text(str(error))}\n")
        return 2

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
