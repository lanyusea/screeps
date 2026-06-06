#!/usr/bin/env python3
"""Bounded artifact-first producers for Screeps RL control-loop cron jobs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence, TextIO

import rl_conclusion_registry
import screeps_cli_io
import screeps_rl_dashboard as static_dashboard
import screeps_rl_live_dashboard as live_dashboard


SCHEMA_VERSION = 1
TRAINING_LEDGER_TYPE = "screeps-rl-training-execution-ledger"
POLICY_ADVANTAGE_TYPE = "screeps-rl-policy-online-advantage-report"
REWARD_DECISION_RECORD_TYPE = "screeps-rl-reward-decision-record"
STEWARD_DIGEST_TYPE = "screeps-rl-steward-bounded-digest"
DEFAULT_ARTIFACT_ROOT = Path("runtime-artifacts")
DEFAULT_CONTROL_LOOP_DIR = Path("runtime-artifacts/rl-control-loop")
DEFAULT_MAX_FILES_PER_ROOT = 25
DEFAULT_STDOUT_BYTES = 4096
E1_FULL_GATE_MIN_SAMPLE_COUNT = 200
E1_GATE_STALE_FRESHNESS_SECONDS = 86400
HISTORICAL_CONTEXT_ISSUES = [879, 893, 1589]
REWARD_DECISION_SOURCE_ISSUE = 1690
REWARD_DECISION_RELATED_ISSUES = [907, 924]
REWARD_DECISION_PLACEHOLDER_CANDIDATE_IDS = {"NO_STABLE_CANDIDATE", "N/A", "UNKNOWN"}
REWARD_DECISION_NULL_TEXT_MARKERS = (
    "rewardDecisionId=null",
    "rewardDecisionId is null",
    "rewardDecisionId was null",
    "currently null regression",
    "RESTORE rewardDecisionId",
    "latest ledger shows null",
    "rewardDecisionId_null_regression",
    "rewardDecisionId_missing",
    "null value breaks downstream",
)
POLICY_METRIC_CATEGORIES = ("territory", "resources", "combat", "reliability", "logistics")

JsonObject = dict[str, Any]


class ControlLoopLedgerError(RuntimeError):
    """Raised when a bounded control-loop artifact cannot be produced."""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def timestamp_stem(created_at: str) -> str:
    parsed = created_at.replace("-", "").replace(":", "")
    if parsed.endswith("+0000"):
        parsed = parsed[:-5] + "Z"
    return parsed.replace("+00:00", "Z")


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(temp_fd, "w", encoding="utf-8") as handle:
            temp_fd = -1
            handle.write(screeps_cli_io.canonical_json(json_safe(payload)))
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


def json_safe(value: Any) -> Any:
    if isinstance(value, Path):
        return value.as_posix()
    if isinstance(value, datetime):
        return value.isoformat().replace("+00:00", "Z")
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value


def load_json(path: Path | None) -> JsonObject | None:
    if path is None:
        return None
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def as_dict(value: Any) -> JsonObject:
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def text_value(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    if isinstance(value, (int, float, bool)):
        return str(value)
    return None


def number_value(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def int_value(value: Any) -> int | None:
    parsed = number_value(value)
    return int(parsed) if parsed is not None else None


def repo_display_path(path: Any, repo_root: Path) -> str | None:
    if path is None:
        return None
    candidate = Path(path)
    try:
        return candidate.resolve().relative_to(repo_root.resolve()).as_posix()
    except (OSError, ValueError):
        return candidate.as_posix()


def git_text(repo_root: Path, args: Sequence[str]) -> str | None:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=repo_root,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return completed.stdout.strip() or None


def git_metadata(repo_root: Path) -> JsonObject:
    commit = git_text(repo_root, ["rev-parse", "HEAD"])
    subject = git_text(repo_root, ["log", "-1", "--format=%s"])
    return {
        "mainCommit": commit,
        "mainCommitSubject": subject,
    }


def bounded_gate_infos(
    artifact_root: Path,
    repo_root: Path,
    warnings: list[str],
    latest_training: static_dashboard.LoadedArtifact | None,
    latest_metrics: static_dashboard.LoadedArtifact | None,
    *,
    max_files_per_root: int,
) -> tuple[list[JsonObject], JsonObject]:
    gate_infos: list[JsonObject] = []
    scan: JsonObject = {
        "roots": [],
        "filesLoaded": 0,
        "filesDiscovered": 0,
        "truncated": False,
    }
    roots_and_patterns = (
        (artifact_root / "rl-dataset-gates", ("*/gate_summary.json", "*/gate_report.json")),
        (
            artifact_root / "rl-control-loop",
            ("*/gate_summary.json", "*/gate_report.json", "gate-data/*/gate_summary.json", "gate-data/*/gate_report.json"),
        ),
    )
    for root, patterns in roots_and_patterns:
        paths, discovered, truncated = live_dashboard.newest_matching_files_with_discovery_limit(
            root,
            patterns,
            discovery_limit=max_files_per_root,
        )
        scan["filesDiscovered"] += discovered
        scan["truncated"] = bool(scan["truncated"]) or truncated
        scan["roots"].append(
            {
                "root": repo_display_path(root, repo_root),
                "patterns": list(patterns),
                "filesSelected": len(paths),
                "filesDiscovered": discovered,
                "truncated": truncated,
            }
        )
        for path in paths:
            artifact = static_dashboard.load_artifact(path, warnings, repo_root)
            if artifact is None:
                continue
            scan["filesLoaded"] += 1
            info = static_dashboard.extract_gate_info(artifact.payload, artifact.path, "gate artifact", repo_root)
            if info is not None:
                gate_infos.append(info)

    if latest_training is not None:
        e1_gate = as_dict(latest_training.payload.get("e1Gate"))
        if e1_gate:
            info = static_dashboard.extract_gate_info(e1_gate, latest_training.path, "training ledger e1Gate", repo_root)
            if info is not None:
                gate_infos.append(info)

    if latest_metrics is not None:
        info = static_dashboard.gate_info_from_metrics_observations(latest_metrics, repo_root)
        if info is not None:
            gate_infos.append(info)

    return gate_infos, scan


def bounded_simulator_health(latest_training: static_dashboard.LoadedArtifact | None) -> JsonObject:
    if latest_training is None:
        return {
            "hasData": False,
            "succeeded": 0,
            "failed": 0,
            "ticksRun": 0,
            "latestPath": None,
            "source": "bounded training-ledger aggregate",
        }
    execution = as_dict(latest_training.payload.get("environmentExecution"))
    iteration = as_dict(latest_training.payload.get("iterationExecution"))
    completed = int_value(execution.get("completed")) or 0
    failed = int_value(execution.get("failed")) or 0
    ticks_run = int_value(iteration.get("simulatorTicksRun")) or 0
    return {
        "hasData": True,
        "succeeded": completed,
        "failed": failed,
        "ticksRun": ticks_run,
        "latestPath": latest_training.path,
        "source": "bounded training-ledger aggregate",
    }


def is_bounded_producer_artifact(artifact: static_dashboard.LoadedArtifact) -> bool:
    return isinstance(artifact.payload.get("boundedProducer"), dict)


def latest_external_dashboard_artifact(
    artifacts: Sequence[static_dashboard.LoadedArtifact],
    artifact_kind: str,
) -> static_dashboard.LoadedArtifact | None:
    return live_dashboard.latest_bounded_dashboard_artifact(
        [artifact for artifact in artifacts if not is_bounded_producer_artifact(artifact)],
        artifact_kind,
    )


def first_int_value(*values: Any) -> int | None:
    for value in values:
        parsed = int_value(value)
        if parsed is not None:
            return parsed
    return None


def unique_text_values(values: Sequence[Any]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for value in values:
        if isinstance(value, list):
            for item in unique_text_values(value):
                if item in seen:
                    continue
                seen.add(item)
                unique.append(item)
            continue
        text = text_value(value)
        if text is None or text in seen:
            continue
        seen.add(text)
        unique.append(text)
    return unique


def path_is_direct_child(path: Path, root: Path) -> bool:
    try:
        relative = path.resolve().relative_to(root.resolve())
    except (OSError, ValueError):
        return False
    return len(relative.parts) == 1


def root_training_report_id(path: Path, payload: JsonObject) -> str:
    return (
        text_value(payload.get("reportId"))
        or text_value(payload.get("trainingReportId"))
        or path.stem
    )


def root_training_report_timestamp(path: Path, payload: JsonObject) -> datetime:
    for key in ("generatedAt", "completedAt", "finishedAt", "createdAt", "producedAt", "updatedAt", "timestamp"):
        parsed = static_dashboard.parse_iso_datetime(payload.get(key))
        if parsed is not None:
            return parsed
    return static_dashboard.artifact_timestamp(path, payload)


def is_root_rl_training_report(path: Path, artifact_root: Path, payload: JsonObject) -> bool:
    if not path_is_direct_child(path, artifact_root / "rl-training"):
        return False
    name = path.name.lower()
    if name.endswith(".json") is False or "training-ledger" in name or "training-execution-ledger" in name:
        return False
    if is_bounded_producer_artifact(static_dashboard.LoadedArtifact(path=path, payload=payload, timestamp=static_dashboard.artifact_timestamp(path, payload))):
        return False
    if live_dashboard.failed_training_report_status(payload):
        return False

    type_text = str(payload.get("type") or "").lower()
    if "training-report" in type_text and "ledger" not in type_text:
        return True
    if text_value(payload.get("reportId")) is None:
        return False
    return (
        "policyUpdateIterations" in payload
        or isinstance(payload.get("policyUpdate"), dict)
        or isinstance(payload.get("variantResults"), list)
        or isinstance(as_dict(payload.get("source")).get("simulatorRunIds"), list)
    )


def variant_result_rows(payload: JsonObject) -> list[JsonObject]:
    return [item for item in as_list(payload.get("variantResults")) if isinstance(item, dict)]


def sum_int_values(values: Sequence[Any]) -> int | None:
    total = 0
    found = False
    for value in values:
        parsed = int_value(value)
        if parsed is None:
            continue
        found = True
        total += parsed
    return total if found else None


def root_training_report_simulator_run_ids(payload: JsonObject) -> list[str]:
    source = as_dict(payload.get("source"))
    return unique_text_values(
        [
            as_list(source.get("simulatorRunIds")),
            as_list(payload.get("simulatorRunIds")),
        ]
    )


def root_training_report_completed_environments(payload: JsonObject) -> int:
    rows = variant_result_rows(payload)
    batch_scale = as_dict(payload.get("batchScale"))
    source = as_dict(payload.get("source"))
    simulator_run_ids = root_training_report_simulator_run_ids(payload)
    sample_total = sum_int_values([row.get("sampleCount") for row in rows])
    return (
        first_int_value(
            batch_scale.get("environmentRows"),
            payload.get("completedEnvironmentRuns"),
            payload.get("completedEnvironments"),
            payload.get("environmentsCompleted"),
            payload.get("environmentsRun"),
            sample_total,
            payload.get("artifactCount"),
            source.get("simulatorRunCount"),
            len(simulator_run_ids) if simulator_run_ids else None,
        )
        or 0
    )


def root_training_report_failed_environments(payload: JsonObject) -> int:
    rows = variant_result_rows(payload)
    explicit = first_int_value(
        payload.get("failedEnvironmentRuns"),
        payload.get("failedEnvironments"),
        payload.get("environmentsFailed"),
    )
    if explicit is not None:
        return explicit
    return sum(1 for row in rows if row.get("ok") is False)


def root_training_report_ticks(payload: JsonObject) -> int:
    batch_scale = as_dict(payload.get("batchScale"))
    simulation = as_dict(payload.get("simulation"))
    ticks = first_int_value(
        batch_scale.get("simulatorTicks"),
        payload.get("simulatorTicksRun"),
        payload.get("ticksRun"),
        payload.get("totalTickRuns"),
    )
    if ticks is not None:
        return ticks
    per_run_ticks = int_value(simulation.get("ticks"))
    repetitions = int_value(simulation.get("repetitions"))
    variant_count = len(variant_result_rows(payload))
    if per_run_ticks is not None and repetitions is not None and variant_count > 0:
        return per_run_ticks * repetitions * variant_count
    return 0


def root_training_report_policy_updates(payload: JsonObject) -> int:
    policy_update = as_dict(payload.get("policyUpdate"))
    return first_int_value(payload.get("policyUpdateIterations"), policy_update.get("iterations")) or 0


def root_training_report_candidate_policy_ids(payload: JsonObject) -> list[str]:
    policy_update = as_dict(payload.get("policyUpdate"))
    scorecard = as_dict(payload.get("candidateScorecard"))
    return unique_text_values(
        [
            payload.get("policyUpdateCandidatePolicyId"),
            payload.get("candidatePolicyId"),
            as_dict(policy_update.get("nextCandidatePolicy")).get("candidatePolicyId"),
            scorecard.get("candidateStrategyId"),
            as_list(payload.get("candidateStrategyIds")),
        ]
    )


def root_training_report_by_variant(payload: JsonObject) -> JsonObject:
    variants: JsonObject = {}
    for index, row in enumerate(variant_result_rows(payload)):
        variant_id = (
            text_value(row.get("variantId"))
            or text_value(row.get("candidatePolicyId"))
            or text_value(row.get("sourceStrategyId"))
            or f"variant-{index + 1}"
        )
        runtime_injection = as_dict(row.get("runtimeParameterInjection")) or as_dict(row.get("parameterEvidence"))
        variants[variant_id] = {
            "ok": row.get("ok"),
            "sampleCount": int_value(row.get("sampleCount")),
            "rolloutStatus": row.get("rolloutStatus"),
            "runtimeParameterConsumption": runtime_injection.get("runtimeParameterConsumption"),
        }
    return variants


def normalize_root_training_report_payload(path: Path, payload: JsonObject) -> JsonObject:
    report_id = root_training_report_id(path, payload)
    completed = root_training_report_completed_environments(payload)
    failed = root_training_report_failed_environments(payload)
    ticks_run = root_training_report_ticks(payload)
    policy_updates = root_training_report_policy_updates(payload)
    simulator_run_ids = root_training_report_simulator_run_ids(payload)
    candidate_policy_ids = root_training_report_candidate_policy_ids(payload)
    batch_scale = as_dict(payload.get("batchScale"))
    source = as_dict(payload.get("source"))
    simulation = as_dict(payload.get("simulation"))

    normalized = dict(payload)
    normalized.setdefault("trainingDidRun", True)
    normalized.setdefault("trainingReportId", report_id)
    normalized.setdefault("trainingReportIds", [report_id])

    environment = dict(as_dict(payload.get("environmentExecution")))
    environment.setdefault("environmentCountRequested", completed + failed)
    environment.setdefault("started", completed + failed)
    environment.setdefault("completed", completed)
    environment.setdefault("failed", failed)
    environment.setdefault("byVariant", root_training_report_by_variant(payload))
    if completed + failed > 0:
        environment.setdefault("successRate", completed / (completed + failed))
    environment.setdefault("mostRecentCompletedRun", report_id)
    normalized["environmentExecution"] = environment

    iteration = dict(as_dict(payload.get("iterationExecution")))
    iteration.setdefault("simulatorTicksRequested", ticks_run)
    iteration.setdefault("simulatorTicksRun", ticks_run)
    iteration.setdefault("episodesRun", completed)
    iteration.setdefault("candidateEvaluationIterations", len(variant_result_rows(payload)))
    iteration.setdefault("policyUpdateIterations", policy_updates)
    iteration.setdefault("wallClockSeconds", number_value(batch_scale.get("wallClockSeconds")))
    iteration.setdefault(
        "policyUpdateNote",
        "root-level RL training report; policy promotion remains gated by report trust fields",
    )
    normalized["iterationExecution"] = iteration

    artifacts = dict(as_dict(payload.get("trainingArtifacts")))
    artifacts.setdefault("experimentCard", as_dict(payload.get("experimentCard")).get("cardId"))
    artifacts.setdefault("experimentCardPath", source.get("experimentCardPath"))
    artifacts.setdefault("simulatorRunIds", simulator_run_ids)
    artifacts.setdefault("trainingReportIds", [report_id])
    artifacts.setdefault("candidatePolicyIds", candidate_policy_ids)
    artifacts.setdefault("latestTrainingReport", path)
    artifacts.setdefault("policyUpdateArtifactPath", payload.get("policyUpdateArtifactPath"))
    artifacts.setdefault("scorecardId", payload.get("scorecardId"))
    artifacts.setdefault("scorecardArtifactPath", payload.get("scorecardArtifactPath"))
    normalized["trainingArtifacts"] = artifacts

    metrics_fields = dict(as_dict(payload.get("metricsFields")))
    metrics_fields.setdefault("envRequested", completed + failed)
    metrics_fields.setdefault("envStarted", completed + failed)
    metrics_fields.setdefault("envCompleted", completed)
    metrics_fields.setdefault("envFailed", failed)
    metrics_fields.setdefault("ticksRequested", ticks_run)
    metrics_fields.setdefault("ticksRun", ticks_run)
    metrics_fields.setdefault("episodes", completed)
    metrics_fields.setdefault("policyUpdateIterations", policy_updates)
    metrics_fields.setdefault("trainingReportIds", [report_id])
    metrics_fields.setdefault("candidatePolicyId", candidate_policy_ids[0] if candidate_policy_ids else None)
    metrics_fields.setdefault("simulatorRunCount", first_int_value(source.get("simulatorRunCount"), len(simulator_run_ids)))
    metrics_fields.setdefault("simulationTicksPerRun", int_value(simulation.get("ticks")))
    normalized["metricsFields"] = metrics_fields
    return normalized


def training_evidence_candidate_policy_id(payload: JsonObject) -> str | None:
    policy_update = as_dict(payload.get("policyUpdate"))
    artifacts = as_dict(payload.get("trainingArtifacts"))
    metrics_fields = as_dict(payload.get("metricsFields"))
    candidate_policy_ids = as_list(artifacts.get("candidatePolicyIds"))
    return candidate_policy_text(
        metrics_fields.get("candidatePolicyId"),
        payload.get("policyUpdateCandidatePolicyId"),
        payload.get("candidatePolicyId"),
        as_dict(policy_update.get("nextCandidatePolicy")).get("candidatePolicyId"),
        candidate_policy_ids[-1] if candidate_policy_ids else None,
        as_dict(payload.get("candidateScorecard")).get("candidateStrategyId"),
    )


def referenced_training_report_ids(payload: JsonObject) -> list[str]:
    artifacts = as_dict(payload.get("trainingArtifacts"))
    metrics_fields = as_dict(payload.get("metricsFields"))
    return unique_text_values(
        [
            payload.get("trainingReportId"),
            as_list(payload.get("trainingReportIds")),
            as_list(artifacts.get("trainingReportIds")),
            as_list(metrics_fields.get("trainingReportIds")),
        ]
    )


def root_training_report_path_for_id(artifact_root: Path, report_id: str) -> Path | None:
    if "/" in report_id or "\\" in report_id:
        return None
    return artifact_root / "rl-training" / f"{report_id}.json"


def referenced_root_training_report_payload(payload: JsonObject, artifact_root: Path) -> JsonObject | None:
    payload_candidate = training_evidence_candidate_policy_id(payload)
    for report_id in reversed(referenced_training_report_ids(payload)):
        report_path = root_training_report_path_for_id(artifact_root, report_id)
        if report_path is None:
            continue
        report_payload = load_json(report_path)
        if report_payload is None or not is_root_rl_training_report(report_path, artifact_root, report_payload):
            continue
        normalized = normalize_root_training_report_payload(report_path, report_payload)
        report_candidate = training_evidence_candidate_policy_id(normalized)
        if payload_candidate is not None and report_candidate is not None and payload_candidate != report_candidate:
            continue
        return normalized
    return None


def fill_missing_mapping_values(target: JsonObject, source: JsonObject, keys: Sequence[str]) -> JsonObject:
    merged = dict(target)
    for key in keys:
        source_value = source.get(key)
        if source_value is None:
            continue
        target_value = merged.get(key)
        if target_value is None or target_value == [] or target_value == {}:
            merged[key] = source_value
    return merged


def enrich_training_ledger_from_referenced_report(payload: JsonObject, artifact_root: Path) -> JsonObject:
    report_payload = referenced_root_training_report_payload(payload, artifact_root)
    if report_payload is None:
        return payload
    enriched = fill_missing_mapping_values(
        payload,
        report_payload,
        (
            "policyUpdateCandidatePolicyId",
            "policyUpdateArtifactPath",
            "policyUpdate",
            "policyUpdatePromotionGate",
            "scorecardId",
            "scorecardArtifactPath",
            "candidateScorecard",
            "candidateScorecards",
            "trueGradient",
            "gradientStable",
            "trustedGradientUpdate",
            "highVariance",
        ),
    )
    enriched["trainingArtifacts"] = fill_missing_mapping_values(
        as_dict(payload.get("trainingArtifacts")),
        as_dict(report_payload.get("trainingArtifacts")),
        (
            "experimentCard",
            "experimentCardPath",
            "simulatorRunIds",
            "trainingReportIds",
            "candidatePolicyIds",
            "latestTrainingReport",
            "policyUpdateArtifactPath",
            "scorecardId",
            "scorecardArtifactPath",
        ),
    )
    enriched["metricsFields"] = fill_missing_mapping_values(
        as_dict(payload.get("metricsFields")),
        as_dict(report_payload.get("metricsFields")),
        (
            "candidatePolicyId",
            "simulatorRunCount",
            "simulationTicksPerRun",
        ),
    )
    return enriched


def normalize_training_evidence_payload(path: Path | None, artifact_root: Path, payload: JsonObject | None) -> JsonObject | None:
    if payload is None or path is None:
        return payload
    if is_root_rl_training_report(path, artifact_root, payload):
        return normalize_root_training_report_payload(path, payload)
    if payload.get("type") == TRAINING_LEDGER_TYPE:
        return enrich_training_ledger_from_referenced_report(payload, artifact_root)
    return payload


def latest_root_training_report_artifact(
    artifact_root: Path,
    repo_root: Path,
    warnings: list[str],
    *,
    max_files_per_root: int,
) -> tuple[static_dashboard.LoadedArtifact | None, JsonObject]:
    root = artifact_root / "rl-training"
    scan_limit = live_dashboard.artifact_evidence_candidate_scan_limit(max_files_per_root)
    paths, discovered, truncated = live_dashboard.newest_matching_files_with_discovery_limit(
        root,
        ("*.json",),
        discovery_limit=scan_limit,
    )
    scan: JsonObject = {
        "root": repo_display_path(root, repo_root),
        "patterns": ["*.json"],
        "filesDiscovered": discovered,
        "filesLoaded": 0,
        "reportCandidates": 0,
        "selected": None,
        "fileLimit": scan_limit,
        "truncated": truncated,
    }
    candidates: list[static_dashboard.LoadedArtifact] = []
    for path in paths:
        artifact = static_dashboard.load_artifact(path, warnings, repo_root)
        if artifact is None:
            continue
        scan["filesLoaded"] = int(scan["filesLoaded"]) + 1
        if not is_root_rl_training_report(artifact.path, artifact_root, artifact.payload):
            continue
        scan["reportCandidates"] = int(scan["reportCandidates"]) + 1
        candidates.append(
            static_dashboard.LoadedArtifact(
                path=artifact.path,
                payload=normalize_root_training_report_payload(artifact.path, artifact.payload),
                timestamp=root_training_report_timestamp(artifact.path, artifact.payload),
            )
        )
    if not candidates:
        return None, scan
    selected = max(candidates, key=lambda artifact: (artifact.timestamp, artifact.path.as_posix()))
    scan["selected"] = repo_display_path(selected.path, repo_root)
    return selected, scan


def latest_training_evidence_artifact(
    artifact_root: Path,
    repo_root: Path,
    warnings: list[str],
    bounded_artifacts: Sequence[static_dashboard.LoadedArtifact],
    *,
    max_files_per_root: int,
) -> tuple[static_dashboard.LoadedArtifact | None, JsonObject]:
    candidates: list[static_dashboard.LoadedArtifact] = []
    latest_training = latest_external_dashboard_artifact(bounded_artifacts, "training_ledger")
    if latest_training is not None:
        candidates.append(
            static_dashboard.LoadedArtifact(
                path=latest_training.path,
                payload=normalize_training_evidence_payload(latest_training.path, artifact_root, latest_training.payload) or latest_training.payload,
                timestamp=latest_training.timestamp,
            )
        )
    latest_report, report_scan = latest_root_training_report_artifact(
        artifact_root,
        repo_root,
        warnings,
        max_files_per_root=max_files_per_root,
    )
    if latest_report is not None:
        candidates.append(latest_report)
    if not candidates:
        return None, report_scan
    return max(candidates, key=lambda artifact: (artifact.timestamp, artifact.path.as_posix())), report_scan


def dashboard_summary(repo_root: Path, artifact_root: Path, created_at: str, max_files_per_root: int) -> JsonObject:
    warnings: list[str] = []
    control_root = artifact_root / "rl-control-loop"
    bounded_artifacts, source_scan = live_dashboard.load_bounded_dashboard_artifacts(
        artifact_root,
        repo_root,
        warnings,
        max_files_per_root=max_files_per_root,
    )
    conclusion_artifact = static_dashboard.load_optional_artifact(
        control_root / "conclusion-registry.json",
        warnings,
        repo_root,
    )
    latest_training, root_training_report_scan = latest_training_evidence_artifact(
        artifact_root,
        repo_root,
        warnings,
        bounded_artifacts,
        max_files_per_root=max_files_per_root,
    )
    latest_policy = latest_external_dashboard_artifact(bounded_artifacts, "policy_advantage")
    latest_metrics = live_dashboard.latest_bounded_dashboard_artifact(bounded_artifacts, "metrics_observations")
    gate_infos, gate_scan = bounded_gate_infos(
        artifact_root,
        repo_root,
        warnings,
        latest_training,
        latest_metrics,
        max_files_per_root=max_files_per_root,
    )
    gate = static_dashboard.latest_gate(gate_infos)
    simulator = bounded_simulator_health(latest_training)
    training = static_dashboard.training_execution(
        latest_training,
        standalone_card_supply_candidates=[],
        tencent_internal_card_supply_candidates=[],
    )
    policy = static_dashboard.policy_advantage(latest_policy, latest_metrics, training=training)
    lanes = static_dashboard.lane_statuses(gate, simulator, training, policy)
    return {
        "generatedAt": created_at,
        "repoRoot": repo_root,
        "artifactRoot": artifact_root,
        "warnings": warnings,
        "artifacts": {
            "conclusionRegistry": conclusion_artifact.path if conclusion_artifact else None,
            "trainingLedger": latest_training.path if latest_training else None,
            "policyAdvantage": latest_policy.path if latest_policy else None,
            "metricsObservations": latest_metrics.path if latest_metrics else None,
        },
        "lanes": lanes,
        "conclusions": static_dashboard.conclusion_summary(conclusion_artifact),
        "gate": gate,
        "simulator": simulator,
        "training": training,
        "policy": policy,
        "cardSupply": training.get("cardSupply"),
        "scan": {
            **source_scan,
            "gateScan": gate_scan,
            "rootTrainingReportScan": root_training_report_scan,
            "mode": "bounded-control-loop-ledger-producer",
        },
    }


def output_path(out_dir: Path, created_at: str, suffix: str) -> Path:
    return out_dir / f"{timestamp_stem(created_at)}-{suffix}.json"


def latest_artifact_payload(dashboard: JsonObject, key: str, repo_root: Path) -> JsonObject | None:
    path = latest_artifact_absolute_path(dashboard, key, repo_root)
    return load_json(path)


def latest_artifact_absolute_path(dashboard: JsonObject, key: str, repo_root: Path) -> Path | None:
    artifacts = as_dict(dashboard.get("artifacts"))
    raw_path = artifacts.get(key)
    if raw_path is None:
        return None
    path = Path(raw_path)
    if not path.is_absolute():
        path = repo_root / path
    return path


def latest_artifact_path(dashboard: JsonObject, key: str, repo_root: Path) -> str | None:
    artifacts = as_dict(dashboard.get("artifacts"))
    return repo_display_path(artifacts.get(key), repo_root)


def field_from(payload: JsonObject | None, key: str, fallback: Any) -> Any:
    if isinstance(payload, dict) and key in payload:
        return payload[key]
    return fallback


def first_text_value(*values: Any) -> str | None:
    for value in values:
        text = text_value(value)
        if text is not None:
            return text
    return None


def candidate_policy_text(*values: Any) -> str | None:
    for value in values:
        text = text_value(value)
        if text is None:
            continue
        if text.upper() in REWARD_DECISION_PLACEHOLDER_CANDIDATE_IDS:
            continue
        return text
    return None


def normalized_latest_training_payload(
    summary: JsonObject,
    artifact_root: Path,
    repo_root: Path,
) -> JsonObject | None:
    training_path = latest_artifact_absolute_path(summary, "trainingLedger", repo_root)
    return normalize_training_evidence_payload(
        training_path,
        artifact_root,
        latest_artifact_payload(summary, "trainingLedger", repo_root),
    )


def latest_root_training_report_payload_from_summary(
    summary: JsonObject,
    artifact_root: Path,
    repo_root: Path,
) -> JsonObject | None:
    scan = as_dict(as_dict(summary.get("scan")).get("rootTrainingReportScan"))
    selected = text_value(scan.get("selected"))
    if selected is None:
        return None
    path = Path(selected)
    if not path.is_absolute():
        path = repo_root / path
    payload = load_json(path)
    if payload is None or not is_root_rl_training_report(path, artifact_root, payload):
        return None
    return normalize_root_training_report_payload(path, payload)


def selected_scorecard_comparison(training_payload: JsonObject | None) -> JsonObject:
    payload = as_dict(training_payload)
    scorecard_set = as_dict(payload.get("candidateScorecards"))
    selected_scorecard_id = first_text_value(
        payload.get("scorecardId"),
        as_dict(payload.get("candidateScorecard")).get("scorecardId"),
        scorecard_set.get("selectedScorecardId"),
    )
    if selected_scorecard_id is None:
        return as_dict(payload.get("candidateScorecard"))
    for item in as_list(scorecard_set.get("comparisons")):
        if not isinstance(item, dict):
            continue
        if text_value(item.get("scorecardId")) == selected_scorecard_id:
            return item
    return as_dict(payload.get("candidateScorecard"))


def selected_scorecard_evidence(
    training_payload: JsonObject | None,
    previous_policy: JsonObject | None,
    repo_root: Path,
) -> JsonObject:
    payload = as_dict(training_payload)
    previous = as_dict(previous_policy)
    comparison = selected_scorecard_comparison(payload)
    training_artifacts = as_dict(payload.get("trainingArtifacts"))
    scorecard_id = first_text_value(
        payload.get("scorecardId"),
        comparison.get("scorecardId"),
        as_dict(payload.get("candidateScorecards")).get("selectedScorecardId"),
        previous.get("scorecardId"),
    )
    scorecard_artifact_path = first_text_value(
        payload.get("scorecardArtifactPath"),
        comparison.get("scorecardArtifactPath"),
        training_artifacts.get("scorecardArtifactPath"),
        previous.get("scorecardArtifactPath"),
    )
    scorecard_candidate_id = candidate_policy_text(
        comparison.get("candidateStrategyId"),
        as_dict(payload.get("candidateScorecard")).get("candidateStrategyId"),
        comparison.get("candidatePolicyId"),
    )
    return {
        "scorecardId": scorecard_id,
        "scorecardArtifactPath": repo_display_path(scorecard_artifact_path, repo_root) if scorecard_artifact_path else None,
        "scorecardCandidatePolicyId": scorecard_candidate_id,
        "baselinePolicyId": first_text_value(
            comparison.get("baselineStrategyId"),
            as_dict(payload.get("candidateScorecard")).get("baselineStrategyId"),
            previous.get("baselinePolicyId"),
        ),
        "status": first_text_value(comparison.get("status"), as_dict(payload.get("candidateScorecard")).get("status")),
        "classification": first_text_value(
            comparison.get("classification"),
            as_dict(payload.get("candidateScorecard")).get("classification"),
        ),
        "validationScaleComputeBlocked": comparison.get("validationScaleComputeBlocked"),
        "missingPrerequisite": first_text_value(comparison.get("missingPrerequisite")),
        "reason": first_text_value(comparison.get("reason")),
    }


def existing_reward_decision_id(previous_policy: JsonObject | None, training_payload: JsonObject | None) -> str | None:
    payload = as_dict(training_payload)
    return first_text_value(
        as_dict(previous_policy).get("rewardDecisionId"),
        payload.get("rewardDecisionId"),
        as_dict(payload.get("trainingArtifacts")).get("rewardDecisionId"),
        as_dict(payload.get("metricsFields")).get("rewardDecisionId"),
    )


def existing_reward_decision_artifact_path(
    previous_policy: JsonObject | None,
    training_payload: JsonObject | None,
) -> str | None:
    payload = as_dict(training_payload)
    return first_text_value(
        as_dict(previous_policy).get("rewardDecisionArtifactPath"),
        payload.get("rewardDecisionArtifactPath"),
        as_dict(payload.get("trainingArtifacts")).get("rewardDecisionArtifactPath"),
        as_dict(payload.get("metricsFields")).get("rewardDecisionArtifactPath"),
    )


def reward_decision_id_for_scorecard(scorecard_id: str, candidate_policy_id: str) -> str:
    digest = hashlib.sha1(f"{scorecard_id}\n{candidate_policy_id}".encode("utf-8")).hexdigest()[:12]
    return f"RD-AUTO-{digest}"


def reward_decision_path(artifact_root: Path, reward_decision_id: str) -> Path:
    return artifact_root / "rl-control-loop" / "reward-decisions" / f"{reward_decision_id}.json"


def reward_decision_existing_path(
    *,
    reward_decision_id: str,
    existing_path: str | None,
    artifact_root: Path,
    repo_root: Path,
) -> Path:
    if existing_path:
        path = Path(existing_path)
        return path if path.is_absolute() else repo_root / path
    return reward_decision_path(artifact_root, reward_decision_id)


def scorecard_ids_match(candidate_scorecard_id: str | None, record_scorecard_id: str | None) -> bool:
    if candidate_scorecard_id is None:
        return True
    if record_scorecard_id is None:
        return False
    return (
        candidate_scorecard_id == record_scorecard_id
        or candidate_scorecard_id in record_scorecard_id
        or record_scorecard_id in candidate_scorecard_id
    )


def reward_decision_record_timestamp(path: Path, record: JsonObject) -> datetime:
    for key in ("updatedAt", "createdAt", "decidedAt", "generatedAt"):
        parsed = static_dashboard.parse_iso_datetime(record.get(key))
        if parsed is not None:
            return parsed
    return static_dashboard.artifact_timestamp(path, record)


def load_reward_decision_record(path: Path) -> JsonObject | None:
    record = load_json(path)
    if record is None:
        return None
    reward_decision_id = text_value(record.get("rewardDecisionId"))
    if reward_decision_id is None:
        return None
    return record


def reward_decision_record_matches_candidate(
    record: JsonObject,
    *,
    scorecard_id: str | None,
    candidate_policy_id: str | None,
) -> bool:
    candidate = candidate_policy_text(candidate_policy_id)
    if candidate is None:
        return False
    record_candidate = candidate_policy_text(
        record.get("candidatePolicyId"),
        as_dict(record.get("validationEvidence")).get("candidatePolicyId"),
    )
    if record_candidate != candidate:
        return False
    record_scorecard_id = first_text_value(
        record.get("scorecardId"),
        as_dict(record.get("validationEvidence")).get("scorecardId"),
    )
    return scorecard_ids_match(scorecard_id, record_scorecard_id)


def find_existing_scorecard_reward_decision(
    *,
    artifact_root: Path,
    repo_root: Path,
    scorecard_id: str | None,
    candidate_policy_id: str | None,
) -> tuple[str | None, str | None]:
    candidate = candidate_policy_text(candidate_policy_id)
    if candidate is None:
        return None, None

    if scorecard_id is not None:
        expected_id = reward_decision_id_for_scorecard(scorecard_id, candidate)
        expected_path = reward_decision_path(artifact_root, expected_id)
        expected_record = load_reward_decision_record(expected_path)
        if (
            expected_record is not None
            and text_value(expected_record.get("rewardDecisionId")) == expected_id
            and reward_decision_record_matches_candidate(
                expected_record,
                scorecard_id=scorecard_id,
                candidate_policy_id=candidate,
            )
        ):
            return expected_id, repo_display_path(expected_path, repo_root)

    matches: list[tuple[datetime, str, str, Path]] = []
    decision_root = artifact_root / "rl-control-loop" / "reward-decisions"
    if not decision_root.is_dir():
        return None, None
    for path in sorted(decision_root.glob("*.json")):
        record = load_reward_decision_record(path)
        if record is None:
            continue
        if not reward_decision_record_matches_candidate(
            record,
            scorecard_id=scorecard_id,
            candidate_policy_id=candidate,
        ):
            continue
        reward_decision_id = text_value(record.get("rewardDecisionId"))
        if reward_decision_id is None:
            continue
        matches.append((reward_decision_record_timestamp(path, record), reward_decision_id, path.as_posix(), path))
    if not matches:
        return None, None
    if scorecard_id is None:
        unique_ids = {reward_decision_id for _timestamp, reward_decision_id, _path_key, _path in matches}
        if len(unique_ids) != 1:
            return None, None
    _timestamp, reward_decision_id, _path_key, path = max(matches)
    return reward_decision_id, repo_display_path(path, repo_root)


def matching_carried_reward_decision_link(
    *,
    previous_policy: JsonObject | None,
    training_payload: JsonObject | None,
    scorecard_id: str | None,
    candidate_policy_id: str | None,
    artifact_root: Path,
    repo_root: Path,
) -> tuple[str | None, str | None]:
    reward_decision_id = existing_reward_decision_id(previous_policy, training_payload)
    if reward_decision_id is None:
        return None, None

    path_candidates = [
        reward_decision_existing_path(
            reward_decision_id=reward_decision_id,
            existing_path=existing_reward_decision_artifact_path(previous_policy, training_payload),
            artifact_root=artifact_root,
            repo_root=repo_root,
        ),
        reward_decision_path(artifact_root, reward_decision_id),
    ]
    seen: set[str] = set()
    for path in path_candidates:
        path_key = path.as_posix()
        if path_key in seen:
            continue
        seen.add(path_key)
        record = load_reward_decision_record(path)
        if record is None or text_value(record.get("rewardDecisionId")) != reward_decision_id:
            continue
        if not reward_decision_record_matches_candidate(
            record,
            scorecard_id=scorecard_id,
            candidate_policy_id=candidate_policy_id,
        ):
            continue
        return reward_decision_id, repo_display_path(path, repo_root)
    return None, None


def resolve_reward_decision_link(
    *,
    previous_policy: JsonObject | None,
    training_payload: JsonObject | None,
    scorecard: JsonObject | None,
    candidate_policy_id: str | None,
    artifact_root: Path,
    repo_root: Path,
) -> tuple[str | None, str | None]:
    scorecard_id = text_value(as_dict(scorecard).get("scorecardId"))
    carried_id, carried_path = matching_carried_reward_decision_link(
        previous_policy=previous_policy,
        training_payload=training_payload,
        scorecard_id=scorecard_id,
        candidate_policy_id=candidate_policy_id,
        artifact_root=artifact_root,
        repo_root=repo_root,
    )
    if carried_id is not None:
        return carried_id, carried_path
    return find_existing_scorecard_reward_decision(
        artifact_root=artifact_root,
        repo_root=repo_root,
        scorecard_id=scorecard_id,
        candidate_policy_id=candidate_policy_id,
    )


def scorecard_reward_decision_type(training: JsonObject) -> str:
    if training.get("trustedGradientUpdate") is True:
        return "change"
    return "hold"


def reward_decision_reason(decision_type: str, training: JsonObject, scorecard: JsonObject) -> str:
    if decision_type == "change":
        return (
            "Selected candidate scorecard is present and Loop A marks trustedGradientUpdate=true; "
            "register a reward change-control decision before any gated rollout planning."
        )
    blocker = training_online_deployment_blocker(training)
    return (
        blocker
        or text_value(scorecard.get("reason"))
        or "Selected candidate scorecard is present, but the gradient trust gate has not authorized a reward change."
    )


def reward_decision_hypothesis(decision_type: str, candidate_policy_id: str, scorecard_id: str) -> str:
    if decision_type == "change":
        return (
            f"Candidate {candidate_policy_id} should be carried into reward/change-control validation because "
            f"scorecard {scorecard_id} selected it with trusted offline gradient evidence, while live rollout remains gated."
        )
    return (
        f"Candidate {candidate_policy_id} should stay on hold despite scorecard {scorecard_id}; "
        "additional Loop A evidence must prove a trusted, stable gradient before reward or policy rollout changes proceed."
    )


def reward_decision_validation_evidence(
    *,
    training: JsonObject,
    scorecard: JsonObject,
    evidence_windows: JsonObject,
    linked_artifact_paths: JsonObject,
    rollout_gate: Any,
    deployability_status: str,
    online_utility_status: str,
) -> JsonObject:
    return {
        "scorecardId": scorecard.get("scorecardId"),
        "scorecardStatus": scorecard.get("status"),
        "scorecardClassification": scorecard.get("classification"),
        "scorecardArtifactPath": scorecard.get("scorecardArtifactPath"),
        "trustedGradientUpdate": training.get("trustedGradientUpdate"),
        "gradientStable": training.get("gradientStable"),
        "policyUpdatePromotionStatus": training.get("policyUpdatePromotionStatus"),
        "onlineUtilityStatus": online_utility_status,
        "deployabilityStatus": deployability_status,
        "rolloutGate": rollout_gate,
        "evidenceWindows": evidence_windows,
        "linkedArtifactPaths": linked_artifact_paths,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
    }


def build_scorecard_reward_decision_record(
    *,
    reward_decision_id: str,
    decision_type: str,
    created_at: str,
    candidate_policy_id: str,
    baseline_policy_id: str | None,
    scorecard: JsonObject,
    training: JsonObject,
    evidence_windows: JsonObject,
    linked_artifact_paths: JsonObject,
    rollout_gate: Any,
    deployability_status: str,
    online_utility_status: str,
) -> JsonObject:
    scorecard_id = str(scorecard.get("scorecardId"))
    reason = reward_decision_reason(decision_type, training, scorecard)
    return {
        "type": REWARD_DECISION_RECORD_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "rewardDecisionId": reward_decision_id,
        "decisionType": decision_type,
        "title": "Automated scorecard-selected policy reward change-control decision",
        "state": "proposed",
        "sourceIssue": REWARD_DECISION_SOURCE_ISSUE,
        "relatedIssues": REWARD_DECISION_RELATED_ISSUES,
        "linkedGitHubIssue": f"https://github.com/lanyusea/screeps/issues/{REWARD_DECISION_SOURCE_ISSUE}",
        "linkedMetricEvidence": [
            f"https://github.com/lanyusea/screeps/issues/{issue}"
            for issue in [REWARD_DECISION_SOURCE_ISSUE, *REWARD_DECISION_RELATED_ISSUES]
        ],
        "linkedDashboardPanels": [
            "Loop B policy advantage",
            "#924 candidate-vs-baseline scorecard",
            "Loop A training execution ledger",
        ],
        "scorecardId": scorecard_id,
        "candidatePolicyId": candidate_policy_id,
        "scorecardCandidatePolicyId": scorecard.get("scorecardCandidatePolicyId"),
        "baselinePolicyId": baseline_policy_id,
        "problemStatement": (
            "Loop B had a scorecard-selected candidate but rewardDecisionId was null, blocking deployability "
            "despite available scorecard/change-control evidence."
        ),
        "hypothesis": reward_decision_hypothesis(decision_type, candidate_policy_id, scorecard_id),
        "reason": reason,
        "currentRewardCoverage": "Generated Loop A/B artifacts preserve offline/private evidence only; no live reward defaults are changed.",
        "proposedChangeType": (
            "scorecard_selected_candidate_change_control"
            if decision_type == "change"
            else "scorecard_selected_candidate_hold"
        ),
        "component": "policy-gradient-scorecard-selection",
        "direction": "scorecard-selected candidate is eligible only through offline/private validation gates",
        "expectedBehaviorChange": (
            "The selected candidate is no longer left without a reward/change-control decision record. "
            "Downstream rollout gates can distinguish trusted change candidates from explicit holds."
        ),
        "decisionDisposition": decision_type,
        "validationEvidence": reward_decision_validation_evidence(
            training=training,
            scorecard=scorecard,
            evidence_windows=evidence_windows,
            linked_artifact_paths=linked_artifact_paths,
            rollout_gate=rollout_gate,
            deployability_status=deployability_status,
            online_utility_status=online_utility_status,
        ),
        "linkedArtifactPaths": linked_artifact_paths,
        "riskAndRegressions": [
            "Do not infer online MMO utility from offline/private scorecard evidence alone.",
            "Do not promote if reliability, CPU, construction, territory, or resource scorecard dimensions regress.",
            "Do not allow learned-policy live control or official MMO writes from this record.",
        ],
        "validationWindows": [
            {
                "name": "scorecard_selected_candidate_validation",
                "requiredEvidence": [
                    "#924-compatible selected scorecard artifact",
                    "Loop A training report or ledger with candidate policy evidence",
                    "trustedGradientUpdate=true before change disposition can be used for rollout planning",
                    "liveEffect:false",
                    "officialMmoWrites:false",
                    "officialMmoWritesAllowed:false",
                ],
            }
        ],
        "acceptanceCriteria": [
            "Policy-advantage artifact carries this non-null rewardDecisionId.",
            "Decision record links scorecardId, candidatePolicyId, validation evidence, artifact paths, and #1690/#907/#924 context.",
            "A hold disposition remains non-promotable until trustedGradientUpdate=true and scorecard safety gates pass.",
            "All generated artifacts preserve liveEffect:false, officialMmoWrites:false, and officialMmoWritesAllowed:false.",
        ],
        "rollbackCriteria": [
            "Reject or rollback if gated validation shows reliability below 0.98.",
            "Reject or rollback if CPU, construction progress, territory, resources, or combat scorecard dimensions regress versus incumbent.",
            "Reject if any artifact enables official MMO learned-policy writes, Memory writes, RawMemory writes, creep intents, spawn intents, construction intents, or market intents.",
            "Reject if owner or steward supersedes this generated decision.",
        ],
        "holdCriteria": [
            "Hold while trustedGradientUpdate is not true.",
            "Hold while the selected scorecard artifact is missing or marked unusable.",
            "Hold while rollout gates lack fresh validation and rollback windows.",
            "Hold if any live-control safety flag is true.",
        ],
        "safety": {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "memoryWritesAllowed": False,
            "rawMemoryWritesAllowed": False,
            "rawCreepIntentControl": False,
            "spawnIntentControl": False,
            "constructionIntentControl": False,
            "marketIntentControl": False,
        },
        "stewardDecision": {
            "state": "needs_gated_validation" if decision_type == "change" else "hold_for_trusted_gradient",
            "decidedBy": "bounded-control-loop-ledger-producer",
            "decidedAt": created_at,
            "notes": reason,
        },
        "ownerDecision": {
            "state": "not_requested",
            "decidedBy": None,
            "decidedAt": None,
            "notes": "No owner approval, no live official MMO authority, and no deployment authorization.",
        },
        "linkedPRs": [],
        "linkedTrainingRuns": as_list(evidence_windows.get("trainingReportIds")),
        "linkedPolicyEvaluations": [
            path
            for path in [
                linked_artifact_paths.get("policyAdvantageArtifactPath"),
                linked_artifact_paths.get("scorecardArtifactPath"),
                linked_artifact_paths.get("trainingLedgerPath"),
            ]
            if isinstance(path, str)
        ],
        "createdAt": created_at,
        "updatedAt": created_at,
    }


def reward_decision_evidence_signature(record: JsonObject) -> JsonObject:
    validation = as_dict(record.get("validationEvidence"))
    evidence_windows = as_dict(validation.get("evidenceWindows"))
    return {
        "decisionType": record.get("decisionType"),
        "decisionDisposition": record.get("decisionDisposition"),
        "scorecardId": record.get("scorecardId"),
        "candidatePolicyId": record.get("candidatePolicyId"),
        "scorecardCandidatePolicyId": record.get("scorecardCandidatePolicyId"),
        "baselinePolicyId": record.get("baselinePolicyId"),
        "proposedChangeType": record.get("proposedChangeType"),
        "stewardDecisionState": as_dict(record.get("stewardDecision")).get("state"),
        "scorecardStatus": validation.get("scorecardStatus"),
        "scorecardClassification": validation.get("scorecardClassification"),
        "scorecardArtifactPath": validation.get("scorecardArtifactPath"),
        "trustedGradientUpdate": validation.get("trustedGradientUpdate"),
        "gradientStable": validation.get("gradientStable"),
        "policyUpdatePromotionStatus": validation.get("policyUpdatePromotionStatus"),
        "onlineUtilityStatus": validation.get("onlineUtilityStatus"),
        "deployabilityStatus": validation.get("deployabilityStatus"),
        "rolloutGate": validation.get("rolloutGate"),
        "trainingReportIds": as_list(evidence_windows.get("trainingReportIds")),
        "latestTrainingLedger": evidence_windows.get("latestTrainingLedger"),
    }


def write_scorecard_reward_decision_if_stale(
    path: Path,
    desired_record: JsonObject,
    created_at: str,
) -> None:
    existing_record = load_json(path) if path.exists() else None
    if existing_record is not None:
        desired_record["createdAt"] = first_text_value(existing_record.get("createdAt")) or desired_record.get(
            "createdAt"
        )
        desired_record["updatedAt"] = created_at
    existing_signature = reward_decision_evidence_signature(existing_record) if existing_record is not None else None
    desired_signature = reward_decision_evidence_signature(desired_record)
    if existing_signature != desired_signature:
        write_json_atomic(path, desired_record)


def emit_scorecard_reward_decision_if_missing(
    *,
    previous_policy: JsonObject | None,
    training_payload: JsonObject | None,
    training: JsonObject,
    scorecard: JsonObject,
    candidate_policy_id: str,
    baseline_policy_id: str | None,
    artifact_root: Path,
    repo_root: Path,
    created_at: str,
    evidence_windows: JsonObject,
    rollout_gate: Any,
    deployability_status: str,
    online_utility_status: str,
    current_policy_advantage_path: Path | None,
) -> tuple[str | None, str | None]:
    scorecard_id = text_value(scorecard.get("scorecardId"))
    existing, existing_path = resolve_reward_decision_link(
        previous_policy=previous_policy,
        training_payload=training_payload,
        scorecard=scorecard,
        candidate_policy_id=candidate_policy_id,
        artifact_root=artifact_root,
        repo_root=repo_root,
    )
    if scorecard_id is None or candidate_policy_text(candidate_policy_id) is None:
        if existing is not None:
            return existing, existing_path
        return None, None

    reward_decision_id = reward_decision_id_for_scorecard(scorecard_id, candidate_policy_id)
    if existing is not None and existing != reward_decision_id:
        return existing, existing_path

    path = reward_decision_path(artifact_root, reward_decision_id)
    if existing is not None:
        path = reward_decision_existing_path(
            reward_decision_id=reward_decision_id,
            existing_path=existing_path,
            artifact_root=artifact_root,
            repo_root=repo_root,
        )
    linked_artifact_paths: JsonObject = {
        "rewardDecisionArtifactPath": repo_display_path(path, repo_root),
        "policyAdvantageArtifactPath": repo_display_path(current_policy_advantage_path, repo_root) if current_policy_advantage_path else None,
        "trainingLedgerPath": repo_display_path(as_dict(training).get("latestPath"), repo_root),
        "scorecardArtifactPath": scorecard.get("scorecardArtifactPath"),
    }
    linked_artifact_paths = {key: value for key, value in linked_artifact_paths.items() if value is not None}
    decision_type = scorecard_reward_decision_type(training)
    write_scorecard_reward_decision_if_stale(
        path,
        build_scorecard_reward_decision_record(
            reward_decision_id=reward_decision_id,
            decision_type=decision_type,
            created_at=created_at,
            candidate_policy_id=candidate_policy_id,
            baseline_policy_id=baseline_policy_id,
            scorecard=scorecard,
            training=training,
            evidence_windows=evidence_windows,
            linked_artifact_paths=linked_artifact_paths,
            rollout_gate=rollout_gate,
            deployability_status=deployability_status,
            online_utility_status=online_utility_status,
        ),
        created_at,
    )
    return reward_decision_id, repo_display_path(path, repo_root)


def metric_list_to_category_map(metrics: Sequence[Any]) -> JsonObject:
    mapped: JsonObject = {}
    for item in metrics:
        if not isinstance(item, dict):
            continue
        category = text_value(item.get("category"))
        if not category:
            continue
        mapped[category] = {
            "advantage": item.get("status", "unknown"),
            "candidateValue": item.get("candidate"),
            "baselineValue": item.get("baseline"),
            "delta": item.get("delta"),
        }
    return mapped


def default_policy_metrics(policy: JsonObject) -> JsonObject:
    categories = metric_list_to_category_map(as_list(policy.get("metrics")))
    for category in POLICY_METRIC_CATEGORIES:
        categories.setdefault(category, {"advantage": "unknown", "candidateValue": None, "baselineValue": None, "delta": None})
    return categories


def positive_policy_status(status: str) -> bool:
    return status.upper() in {"ADVANTAGE", "APPROVED", "POSITIVE", "PROMOTABLE", "PROVEN", "ROLLOUT_APPROVED", "VALIDATED"}


def policy_evidence_windows(
    previous: JsonObject | None,
    summary: JsonObject,
    training: JsonObject,
    repo_root: Path,
    training_payload: JsonObject | None = None,
) -> JsonObject:
    previous_windows = as_dict((previous or {}).get("evidenceWindows"))
    windows: JsonObject = dict(previous_windows) if previous_windows else {
        "shadowReportIds": [],
        "simulatorRunIds": [],
        "trainingReportIds": [],
        "historicalValidationIds": [],
        "preOnlineWindow": None,
        "postOnlineWindow": None,
        "rolloutDecisionIds": [],
        "latestTrainingLedger": latest_artifact_path(summary, "trainingLedger", repo_root),
        "latestPolicyAdvantage": latest_artifact_path(summary, "policyAdvantage", repo_root),
    }
    current_training_report_ids = referenced_training_report_ids(as_dict(training_payload))
    if current_training_report_ids:
        windows["trainingReportIds"] = current_training_report_ids
    else:
        windows["trainingReportIds"] = unique_text_values(
            [
                as_list(windows.get("trainingReportIds")),
                training_report_ids_from_training(training),
            ]
        )
    windows["latestTrainingLedger"] = latest_artifact_path(summary, "trainingLedger", repo_root)
    windows["latestPolicyAdvantage"] = latest_artifact_path(summary, "policyAdvantage", repo_root)
    return windows


def training_status(training: JsonObject) -> str:
    if training.get("hasComputeEvidence") is True:
        return "RUN_VALIDATED"
    raw_status = text_value(training.get("status")) or "N/A"
    if raw_status.upper() in {"RUN_NO_SIGNAL", "RUNNING"}:
        return "RUN_NO_SIGNAL"
    return "NOT_RUN"


def training_did_run(training: JsonObject) -> bool:
    return bool(training.get("hasComputeEvidence") is True or training.get("trainingDidRun") is True)


def utc_datetime_value(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = static_dashboard.parse_iso_datetime(value)
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def selected_gate_resolves_e1_stale_anomaly(dashboard: JsonObject) -> bool:
    gate = as_dict(dashboard.get("gate"))
    if not gate:
        return False
    status = (text_value(gate.get("status")) or "").lower()
    if status not in {"pass", "passed", "ok"}:
        return False
    sample_count = int_value(gate.get("sampleCount"))
    if sample_count is None or sample_count < E1_FULL_GATE_MIN_SAMPLE_COUNT:
        return False
    generated_at = utc_datetime_value(dashboard.get("generatedAt"))
    gate_timestamp = utc_datetime_value(gate.get("timestamp"))
    if generated_at is None or gate_timestamp is None:
        return False
    age_seconds = (generated_at - gate_timestamp).total_seconds()
    return 0 <= age_seconds <= E1_GATE_STALE_FRESHNESS_SECONDS


def training_report_ids_from_training(training: JsonObject) -> list[str]:
    return unique_text_values(as_list(as_dict(training.get("identity")).get("report")))


def training_online_deployment_blocker(training: JsonObject) -> str | None:
    promotion_status = text_value(training.get("policyUpdatePromotionStatus"))
    if training.get("trustedGradientUpdate") is False:
        return "training report marks trustedGradientUpdate=false"
    if training.get("gradientStable") is False:
        return "training report marks gradientStable=false"
    if promotion_status and promotion_status.lower().startswith("blocked"):
        return f"policy update promotion gate is {promotion_status}"
    return None


def training_anomalies(
    dashboard: JsonObject,
    previous: JsonObject | None,
    repo_root: Path,
    *,
    reward_decision_id: str | None = None,
) -> list[JsonObject]:
    training = as_dict(dashboard.get("training"))
    gate = as_dict(dashboard.get("gate"))
    anomalies: list[JsonObject] = []
    stale_e1_gate_resolved = selected_gate_resolves_e1_stale_anomaly(dashboard)
    if not gate:
        anomalies.append(
            {
                "severity": "P1",
                "code": "DATA_GATE_MISSING",
                "evidence": "No bounded E1 dataset gate artifact was found.",
                "handoffRequired": True,
                "handoffSeverity": "P1",
                "blockerClass": "rl_data_gate_missing",
                "recommendedDispatcher": "Screeps autonomous continuation worker",
                "evidencePaths": [],
            }
        )
    if not training.get("hasComputeEvidence"):
        code = "TRAINING_LEDGER_MISSING" if not training.get("hasData") else "TRAINING_COMPUTE_EVIDENCE_MISSING"
        evidence_path = latest_artifact_path(dashboard, "trainingLedger", repo_root)
        anomalies.append(
            {
                "severity": "P0",
                "code": code,
                "evidence": text_value(training.get("blocker")) or "No bounded training compute evidence was found.",
                "handoffRequired": True,
                "handoffSeverity": "P0",
                "blockerClass": "rl_training_artifact_gap",
                "recommendedDispatcher": "Screeps autonomous continuation worker",
                "evidencePaths": [evidence_path] if evidence_path else [],
            }
        )
    for item in as_list((previous or {}).get("anomalies")):
        if not isinstance(item, dict):
            continue
        if reward_decision_id is not None and item.get("code") == "REWARD_DECISION_ID_NULL":
            continue
        if stale_e1_gate_resolved and item.get("code") == "E1_GATE_STALE":
            continue
        if item.get("code") not in {anomaly["code"] for anomaly in anomalies}:
            anomalies.append(item)
    return anomalies[:12]


def next_training_capability_action(previous: JsonObject | None, training: JsonObject, did_run: bool) -> str:
    previous_action = text_value((previous or {}).get("nextTrainingCapabilityAction"))
    if previous_action:
        return previous_action
    deployment_blocker = training_online_deployment_blocker(training)
    if did_run and deployment_blocker:
        return f"{deployment_blocker}; collect additional Loop A samples before online deployment."
    if did_run:
        return "Use the validated Loop A training evidence for bounded policy/steward evaluation."
    return (
        text_value(training.get("blocker"))
        or "Run the bounded training ledger producer after fresh Loop A training evidence is available."
    )


def build_training_ledger(
    *,
    repo_root: Path,
    artifact_root: Path,
    created_at: str,
    source_cron: str,
    max_files_per_root: int,
) -> JsonObject:
    summary = dashboard_summary(repo_root, artifact_root, created_at, max_files_per_root)
    training_path = latest_artifact_absolute_path(summary, "trainingLedger", repo_root)
    previous = normalize_training_evidence_payload(
        training_path,
        artifact_root,
        latest_artifact_payload(summary, "trainingLedger", repo_root),
    )
    training = as_dict(summary.get("training"))
    gate = as_dict(summary.get("gate"))
    simulator = as_dict(summary.get("simulator"))
    previous_policy = latest_artifact_payload(summary, "policyAdvantage", repo_root)
    status = training_status(training)
    did_run = training_did_run(training)
    iteration = as_dict((previous or {}).get("iterationExecution"))
    environment = as_dict((previous or {}).get("environmentExecution"))
    training_artifacts = as_dict((previous or {}).get("trainingArtifacts"))
    metrics_fields = as_dict((previous or {}).get("metricsFields"))
    git = git_metadata(repo_root)
    episodes = int_value(training.get("episodes")) or int_value(iteration.get("episodesRun")) or 0
    policy_updates = int_value(training.get("policyUpdates")) or int_value(iteration.get("policyUpdateIterations")) or 0
    ticks_run = int_value(iteration.get("simulatorTicksRun")) or int_value(simulator.get("ticksRun")) or 0
    env_completed = int_value(environment.get("completed")) or int_value(simulator.get("succeeded")) or 0
    env_failed = int_value(environment.get("failed")) or int_value(simulator.get("failed")) or 0
    previous_environment = as_dict((previous or {}).get("environmentExecution"))
    policy_update = as_dict((previous or {}).get("policyUpdate"))
    next_candidate_policy = as_dict(policy_update.get("nextCandidatePolicy"))
    candidate_policy_ids = as_list(training_artifacts.get("candidatePolicyIds"))
    scorecard = selected_scorecard_evidence(previous, previous_policy, repo_root)
    candidate_policy_id = candidate_policy_text(
        metrics_fields.get("candidatePolicyId"),
        (previous or {}).get("policyUpdateCandidatePolicyId"),
        next_candidate_policy.get("candidatePolicyId"),
        candidate_policy_ids[-1] if candidate_policy_ids else None,
        scorecard.get("scorecardCandidatePolicyId"),
    )
    reward_decision_id, reward_decision_artifact_path = resolve_reward_decision_link(
        previous_policy=previous_policy,
        training_payload=previous,
        scorecard=scorecard,
        candidate_policy_id=candidate_policy_id,
        artifact_root=artifact_root,
        repo_root=repo_root,
    )
    anomalies = training_anomalies(summary, previous, repo_root, reward_decision_id=reward_decision_id)

    return {
        "type": TRAINING_LEDGER_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "createdAt": created_at,
        "sourceCron": source_cron,
        "sourceIssue": None,
        "historicalContextIssues": HISTORICAL_CONTEXT_ISSUES,
        **git,
        "rewardDecisionId": reward_decision_id,
        "rewardDecisionArtifactPath": reward_decision_artifact_path,
        "status": status,
        "trainingDidRun": did_run,
        "e1Gate": {
            "gateId": gate.get("gateId"),
            "ok": gate.get("status") in {"pass", "passed", "ok", "PASS", "OK"},
            "datasetRunId": gate.get("datasetRunId"),
            "sampleCount": gate.get("sampleCount"),
            "runtimeSummaryArtifactCount": gate.get("runtimeSummaryArtifactCount"),
            "trainSplitCount": gate.get("trainSplitCount"),
            "evalSplitCount": gate.get("evalSplitCount"),
            "blockingReasons": gate.get("blockingReasons", []),
            "acceptanceRate": gate.get("acceptanceRate"),
            "sourcePath": repo_display_path(gate.get("sourcePath"), repo_root),
        },
        "dataTraversal": {
            "dataGroupCount": 1 if gate else 0,
            "totalSamplesTraversed": gate.get("sampleCount") or 0,
            "trainSamples": gate.get("trainSplitCount"),
            "evalSamples": gate.get("evalSplitCount"),
            "shadowReportsIndexed": 1 if summary.get("artifacts", {}).get("metricsObservations") else 0,
        },
        "environmentExecution": {
            "environmentCountRequested": previous_environment.get("environmentCountRequested", 0),
            "started": environment.get("started", env_completed + env_failed),
            "completed": env_completed,
            "failed": env_failed,
            "byVariant": environment.get("byVariant", {}),
            "successRate": environment.get("successRate"),
            "mostRecentCompletedRun": environment.get("mostRecentCompletedRun") or simulator.get("latestPath"),
        },
        "iterationExecution": {
            "simulatorTicksRequested": iteration.get("simulatorTicksRequested", 0),
            "simulatorTicksRun": ticks_run,
            "episodesRun": episodes,
            "candidateEvaluationIterations": iteration.get("candidateEvaluationIterations", 0),
            "policyUpdateIterations": policy_updates,
            "wallClockSeconds": iteration.get("wallClockSeconds"),
            "ticksPerSecond": iteration.get("ticksPerSecond"),
            "policyUpdateNote": iteration.get("policyUpdateNote") or "bounded artifact producer did not launch training",
        },
        "trainingArtifacts": {
            "experimentCard": training_artifacts.get("experimentCard"),
            "experimentCardPath": training_artifacts.get("experimentCardPath"),
            "simulatorRunIds": training_artifacts.get("simulatorRunIds", []),
            "trainingReportIds": training_artifacts.get("trainingReportIds", []),
            "candidatePolicyIds": training_artifacts.get("candidatePolicyIds", []),
            "rewardDecisionId": reward_decision_id,
            "rewardDecisionArtifactPath": reward_decision_artifact_path,
            "latestTrainingLedger": latest_artifact_path(summary, "trainingLedger", repo_root),
        },
        "anomalies": anomalies,
        "nextTrainingCapabilityAction": next_training_capability_action(previous, training, did_run),
        "metricsFields": {
            "dataGroups": metrics_fields.get("dataGroups", 1 if gate else 0),
            "samplesTraversed": metrics_fields.get("samplesTraversed", gate.get("sampleCount") or 0),
            "envRequested": metrics_fields.get("envRequested", 0),
            "envStarted": metrics_fields.get("envStarted", env_completed + env_failed),
            "envCompleted": metrics_fields.get("envCompleted", env_completed),
            "envFailed": metrics_fields.get("envFailed", env_failed),
            "ticksRequested": metrics_fields.get("ticksRequested", iteration.get("simulatorTicksRequested", 0)),
            "ticksRun": metrics_fields.get("ticksRun", ticks_run),
            "episodes": metrics_fields.get("episodes", episodes),
            "policyUpdateIterations": metrics_fields.get("policyUpdateIterations", policy_updates),
            "trainingReportIds": metrics_fields.get("trainingReportIds", []),
            "candidatePolicyId": metrics_fields.get("candidatePolicyId"),
            "rewardDecisionId": reward_decision_id,
            "anomalyCategories": [item.get("code") for item in anomalies],
        },
        "githubComment": "skipped_no_atomic_issue",
        "boundedProducer": {
            "maxFilesPerRoot": max_files_per_root,
            "artifactPaths": json_safe(as_dict(summary.get("artifacts"))),
            "scan": json_safe(as_dict(summary.get("scan"))),
        },
    }


def policy_regressions(metrics: JsonObject) -> list[JsonObject]:
    regressions = []
    for metric, value in metrics.items():
        status = str(as_dict(value).get("advantage", "")).lower()
        delta = as_dict(value).get("delta")
        if status in {"loss", "regression", "negative", "blocked_no_compute"} or (
            number_value(delta) is not None and number_value(delta) < 0
        ):
            regressions.append(
                {
                    "metric": metric,
                    "severity": "P1" if metric == "reliability" else "P2",
                    "delta": delta,
                    "evidence": as_dict(value),
                    "trainingFeedback": f"add {metric} guardrail or scenario coverage before promotion",
                }
            )
    return regressions[:8]


def reward_decision_missing_regression(
    *,
    scorecard: JsonObject,
    candidate_policy_id: str | None,
    training_payload: JsonObject | None,
) -> JsonObject:
    payload = as_dict(training_payload)
    artifacts = as_dict(payload.get("trainingArtifacts"))
    scorecard_id = text_value(scorecard.get("scorecardId"))
    candidate = candidate_policy_text(candidate_policy_id)
    if candidate is None:
        reason = "candidate policy id is missing or placeholder"
    elif scorecard_id is None:
        reason = "selected scorecard evidence is missing for the candidate policy"
    else:
        reason = "no matching reward decision could be carried or generated for the selected scorecard and candidate"
    return {
        "metric": "rewardDecisionId_missing",
        "severity": "P0",
        "delta": f"BLOCKED: rewardDecisionId is null because {reason}.",
        "evidence": {
            "candidatePolicyId": candidate,
            "scorecardId": scorecard_id,
            "scorecardArtifactPath": scorecard.get("scorecardArtifactPath"),
            "trainingReportIds": referenced_training_report_ids(payload),
            "policyUpdateArtifactPath": artifacts.get("policyUpdateArtifactPath"),
            "rewardDecisionId": None,
        },
        "trainingFeedback": (
            "Loop B requires a non-null rewardDecisionId before deployability can pass; "
            "propagate an exact matching decision or preserve this blocker."
        ),
    }


def reward_decision_null_text_present(value: Any) -> bool:
    if isinstance(value, str):
        return any(marker in value for marker in REWARD_DECISION_NULL_TEXT_MARKERS)
    if isinstance(value, list):
        return any(reward_decision_null_text_present(item) for item in value)
    if isinstance(value, dict):
        return any(reward_decision_null_text_present(item) for item in value.values())
    return False


def reward_decision_resolved_reference(reward_decision_id: str, reward_decision_artifact_path: str | None) -> str:
    if reward_decision_artifact_path:
        return f"rewardDecisionId {reward_decision_id} is available at {reward_decision_artifact_path}"
    return f"rewardDecisionId {reward_decision_id} is available"


def reward_decision_consistent_text(
    value: Any,
    *,
    reward_decision_id: str | None,
    reward_decision_artifact_path: str | None,
    field: str,
) -> Any:
    if reward_decision_id is None or not isinstance(value, str) or not reward_decision_null_text_present(value):
        return value
    resolved = reward_decision_resolved_reference(reward_decision_id, reward_decision_artifact_path)
    text = value
    text = text.replace("rewardDecisionId propagated (currently null regression), ", "")
    text = text.replace(
        "RESTORE rewardDecisionId provenance \u2014 investigate why latest ledger shows null",
        f"{resolved}; keep provenance guard active",
    )
    if not reward_decision_null_text_present(text):
        return text
    if field == "rolloutGate":
        return (
            f"BLOCKED. {resolved}; rollout still requires remaining non-reward gates, fresh validation evidence, "
            "and explicit deployment authorization before any live promotion."
        )
    if field == "nextExperimentCardDelta":
        return (
            f"{resolved}; continue with remaining non-reward blockers: experiment card/local runner validation, "
            "gate freshness, and guarded post-fix validation."
        )
    return (
        f"{resolved}; no current missing reward decision blocker remains. Keep remaining rollout and training "
        "blockers explicit before promotion."
    )


def reward_decision_consistent_training_feedback(
    feedback: Any,
    *,
    reward_decision_id: str | None,
    reward_decision_artifact_path: str | None,
) -> Any:
    if reward_decision_id is None or not isinstance(feedback, dict):
        return feedback
    updated = dict(feedback)
    for key, value in list(updated.items()):
        if reward_decision_null_text_present(value):
            updated[key] = reward_decision_consistent_text(
                value,
                reward_decision_id=reward_decision_id,
                reward_decision_artifact_path=reward_decision_artifact_path,
                field=f"trainingStrategyFeedback.{key}",
            )
    return updated


def build_policy_advantage(
    *,
    repo_root: Path,
    artifact_root: Path,
    created_at: str,
    source_cron: str,
    max_files_per_root: int,
    current_policy_advantage_path: Path | None = None,
) -> JsonObject:
    summary = dashboard_summary(repo_root, artifact_root, created_at, max_files_per_root)
    previous = latest_artifact_payload(summary, "policyAdvantage", repo_root)
    training_payload = normalized_latest_training_payload(summary, artifact_root, repo_root)
    root_training_payload = latest_root_training_report_payload_from_summary(summary, artifact_root, repo_root)
    evidence_training_payload = root_training_payload or training_payload
    policy = as_dict(summary.get("policy"))
    training = as_dict(summary.get("training"))
    git = git_metadata(repo_root)
    status = text_value(policy.get("status")) or "UNPROVEN"
    if status in {"N/A", "UNKNOWN"}:
        status = "UNPROVEN"
    deployment_blocker = training_online_deployment_blocker(training)
    if positive_policy_status(status) and deployment_blocker:
        status = "BLOCKED"
    metrics = default_policy_metrics(policy)
    regressions = policy_regressions(metrics)
    deployability = (
        "READY_FOR_GATED_LIVE"
        if positive_policy_status(status) and not regressions and not deployment_blocker
        else "BLOCKED"
    )
    rollout_gate = field_from(previous, "rolloutGate", {"status": "BLOCKED", "reason": "online KPI evidence missing"})
    if deployment_blocker:
        rollout_gate = {
            "status": "BLOCKED",
            "reason": deployment_blocker,
            "source": "training_report_gradient_gate",
        }
    scorecard = selected_scorecard_evidence(training_payload, previous, repo_root)
    training_payload_dict = as_dict(training_payload)
    policy_update = as_dict(training_payload_dict.get("policyUpdate"))
    next_candidate_policy = as_dict(policy_update.get("nextCandidatePolicy"))
    candidate_policy_id = (
        candidate_policy_text(
            field_from(previous, "candidatePolicyId", None),
            policy.get("candidate"),
            training_payload_dict.get("policyUpdateCandidatePolicyId"),
            next_candidate_policy.get("candidatePolicyId"),
            scorecard.get("scorecardCandidatePolicyId"),
        )
        or "NO_STABLE_CANDIDATE"
    )
    baseline_policy_id = first_text_value(
        field_from(previous, "baselinePolicyId", None),
        scorecard.get("baselinePolicyId"),
        policy.get("baseline"),
        "incumbent",
    )
    evidence_windows = policy_evidence_windows(
        previous,
        summary,
        training,
        repo_root,
        evidence_training_payload,
    )
    carried_reward_decision_id = existing_reward_decision_id(previous, training_payload)
    reward_decision_id, reward_decision_artifact_path = emit_scorecard_reward_decision_if_missing(
        previous_policy=previous,
        training_payload=training_payload,
        training=training,
        scorecard=scorecard,
        candidate_policy_id=candidate_policy_id,
        baseline_policy_id=baseline_policy_id,
        artifact_root=artifact_root,
        repo_root=repo_root,
        created_at=created_at,
        evidence_windows=evidence_windows,
        rollout_gate=rollout_gate,
        deployability_status=deployability,
        online_utility_status=status,
        current_policy_advantage_path=current_policy_advantage_path,
    )
    emitted_reward_decision = carried_reward_decision_id is None and reward_decision_id is not None
    if reward_decision_id is None:
        missing_regression = reward_decision_missing_regression(
            scorecard=scorecard,
            candidate_policy_id=candidate_policy_id,
            training_payload=training_payload,
        )
        if not any(as_dict(item).get("metric") == missing_regression["metric"] for item in regressions):
            regressions.append(missing_regression)
        deployability = "BLOCKED"
        if str(as_dict(rollout_gate).get("status", "")).upper() not in {"BLOCKED", "HOLD"}:
            rollout_gate = {
                "status": "BLOCKED",
                "reason": missing_regression["delta"],
                "source": "reward_decision_generation",
            }
    else:
        rollout_gate = reward_decision_consistent_text(
            rollout_gate,
            reward_decision_id=reward_decision_id,
            reward_decision_artifact_path=reward_decision_artifact_path,
            field="rolloutGate",
        )
    training_strategy_feedback = reward_decision_consistent_training_feedback(
        field_from(
            previous,
            "trainingStrategyFeedback",
            {
                "rewardChanges": [],
                "scenarioChanges": ["collect bounded online KPI evidence before promotion"],
                "dataWeightingChanges": [],
                "frameworkInstrumentationChanges": [] if training.get("hasComputeEvidence") else ["restore Loop A compute evidence"],
                "candidateGenerationChanges": [],
            },
        ),
        reward_decision_id=reward_decision_id,
        reward_decision_artifact_path=reward_decision_artifact_path,
    )
    next_experiment_card_delta = reward_decision_consistent_text(
        field_from(
            previous,
            "nextExperimentCardDelta",
            "Produce a candidate with fresh Loop A compute evidence and a pre/post KPI measurement window.",
        ),
        reward_decision_id=reward_decision_id,
        reward_decision_artifact_path=reward_decision_artifact_path,
        field="nextExperimentCardDelta",
    )

    return {
        "type": POLICY_ADVANTAGE_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "createdAt": created_at,
        "sourceCron": source_cron,
        "sourceIssue": (
            REWARD_DECISION_SOURCE_ISSUE if emitted_reward_decision else field_from(previous, "sourceIssue", None)
        ),
        "relatedIssues": (
            REWARD_DECISION_RELATED_ISSUES if emitted_reward_decision else field_from(previous, "relatedIssues", [])
        ),
        "historicalContextIssues": HISTORICAL_CONTEXT_ISSUES,
        **git,
        "candidatePolicyId": candidate_policy_id,
        "baselinePolicyId": baseline_policy_id,
        "mode": field_from(previous, "mode", "offline"),
        "onlineUtilityStatus": status,
        "deployabilityStatus": deployability,
        "onlineKpiDeltaSummary": field_from(previous, "onlineKpiDeltaSummary", "No bounded online KPI delta evidence was found."),
        "baselineWindow": field_from(previous, "baselineWindow", None),
        "validationWindow": field_from(previous, "validationWindow", None),
        "rolloutGate": rollout_gate,
        "rollbackCriteria": field_from(previous, "rollbackCriteria", {"reliabilityRegression": ">=2%", "officialMmoWritesAllowed": False}),
        "evidenceWindows": evidence_windows,
        "metrics": metrics,
        "regressions": regressions,
        "trainingStrategyFeedback": training_strategy_feedback,
        "nextExperimentCardDelta": next_experiment_card_delta,
        "rewardDecisionId": reward_decision_id,
        "rewardDecisionArtifactPath": reward_decision_artifact_path,
        "scorecardId": scorecard.get("scorecardId"),
        "scorecardArtifactPath": scorecard.get("scorecardArtifactPath"),
        "scorecardDecisionEvidence": scorecard,
        "githubComment": "skipped_no_atomic_issue",
        "boundedProducer": {
            "maxFilesPerRoot": max_files_per_root,
            "artifactPaths": json_safe(as_dict(summary.get("artifacts"))),
            "scan": json_safe(as_dict(summary.get("scan"))),
        },
    }


def build_steward_digest(
    *,
    repo_root: Path,
    artifact_root: Path,
    created_at: str,
    source_cron: str,
    max_files_per_root: int,
) -> JsonObject:
    summary = dashboard_summary(repo_root, artifact_root, created_at, max_files_per_root)
    conclusions = as_dict(summary.get("conclusions"))
    p0_unresolved = as_list(conclusions.get("p0Unresolved"))
    lanes = as_list(summary.get("lanes"))
    blocked_lanes = [item for item in lanes if isinstance(item, dict) and str(item.get("status", "")).upper() == "BLOCKED"]
    return {
        "type": STEWARD_DIGEST_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "createdAt": created_at,
        "sourceCron": source_cron,
        "sourceIssue": None,
        "historicalContextIssues": HISTORICAL_CONTEXT_ISSUES,
        **git_metadata(repo_root),
        "latestArtifacts": json_safe(as_dict(summary.get("artifacts"))),
        "conclusionCounts": conclusions.get("counts", {status: 0 for status in rl_conclusion_registry.CONCLUSION_STATUSES}),
        "p0Unresolved": json_safe(p0_unresolved[:8]),
        "lanes": json_safe(lanes),
        "blockedLanes": json_safe(blocked_lanes[:8]),
        "nextAction": (
            text_value(blocked_lanes[0].get("blocker")) if blocked_lanes and isinstance(blocked_lanes[0], dict) else
            "No bounded blocked lane was selected; inspect latest Loop A/B artifacts."
        ),
        "boundedProducer": {
            "maxFilesPerRoot": max_files_per_root,
            "scan": json_safe(as_dict(summary.get("scan"))),
        },
        "githubComment": "skipped_no_atomic_issue",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Write bounded Screeps RL control-loop artifacts for cron usage.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command, help_text, source_cron in (
        ("training-ledger", "write a bounded Loop A training execution ledger", "Screeps RL training execution ledger"),
        ("policy-advantage", "write a bounded Loop B policy online advantage report", "Screeps RL policy online advantage ledger"),
        ("steward-digest", "write a bounded RL steward digest", "Screeps RL flywheel steward"),
    ):
        sub = subparsers.add_parser(command, help=help_text)
        sub.add_argument("--repo-root", type=Path, default=Path.cwd())
        sub.add_argument("--artifact-root", type=Path, default=DEFAULT_ARTIFACT_ROOT)
        sub.add_argument("--out-dir", type=Path, default=DEFAULT_CONTROL_LOOP_DIR)
        sub.add_argument("--created-at", default=None)
        sub.add_argument("--source-cron", default=source_cron)
        sub.add_argument("--max-files-per-root", type=int, default=DEFAULT_MAX_FILES_PER_ROOT)
        sub.add_argument("--stdout-bytes", type=int, default=DEFAULT_STDOUT_BYTES)
        sub.add_argument("--output", type=Path, default=None)
    return parser


def resolve_against_repo(path: Path, repo_root: Path) -> Path:
    path = path.expanduser()
    if path.is_absolute():
        return path
    return repo_root / path


def run_command(args: argparse.Namespace) -> tuple[Path, JsonObject]:
    repo_root = args.repo_root.expanduser().resolve()
    artifact_root = resolve_against_repo(args.artifact_root, repo_root)
    out_dir = resolve_against_repo(args.out_dir, repo_root)
    created_at = args.created_at or utc_now_iso()
    max_files = max(1, int(args.max_files_per_root))
    if args.command == "training-ledger":
        payload = build_training_ledger(
            repo_root=repo_root,
            artifact_root=artifact_root,
            created_at=created_at,
            source_cron=args.source_cron,
            max_files_per_root=max_files,
        )
        path = resolve_against_repo(args.output, repo_root) if args.output else output_path(out_dir, created_at, "training-ledger")
    elif args.command == "policy-advantage":
        path = resolve_against_repo(args.output, repo_root) if args.output else output_path(out_dir, created_at, "policy-advantage")
        payload = build_policy_advantage(
            repo_root=repo_root,
            artifact_root=artifact_root,
            created_at=created_at,
            source_cron=args.source_cron,
            max_files_per_root=max_files,
            current_policy_advantage_path=path,
        )
    elif args.command == "steward-digest":
        payload = build_steward_digest(
            repo_root=repo_root,
            artifact_root=artifact_root,
            created_at=created_at,
            source_cron=args.source_cron,
            max_files_per_root=max_files,
        )
        path = resolve_against_repo(args.output, repo_root) if args.output else output_path(out_dir, created_at, "steward-digest")
    else:
        raise ControlLoopLedgerError(f"unsupported command: {args.command}")
    write_json_atomic(path, payload)
    return path, payload


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        path, payload = run_command(args)
    except (ControlLoopLedgerError, OSError, RuntimeError) as error:
        screeps_cli_io.write_json_line(
            stderr,
            {"ok": False, "type": "screeps-rl-control-loop-producer-error", "error": str(error)},
            max_bytes=max(256, int(getattr(args, "stdout_bytes", DEFAULT_STDOUT_BYTES))),
        )
        return 2
    summary = {
        "ok": True,
        "type": payload.get("type"),
        "artifact": repo_display_path(path, args.repo_root.expanduser().resolve()),
        "status": payload.get("status") or payload.get("onlineUtilityStatus") or "written",
        "githubComment": payload.get("githubComment"),
    }
    screeps_cli_io.write_json_line(stdout, summary, max_bytes=max(256, int(args.stdout_bytes)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
