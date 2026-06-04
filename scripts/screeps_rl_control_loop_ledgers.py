#!/usr/bin/env python3
"""Bounded artifact-first producers for Screeps RL control-loop cron jobs."""

from __future__ import annotations

import argparse
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
STEWARD_DIGEST_TYPE = "screeps-rl-steward-bounded-digest"
DEFAULT_ARTIFACT_ROOT = Path("runtime-artifacts")
DEFAULT_CONTROL_LOOP_DIR = Path("runtime-artifacts/rl-control-loop")
DEFAULT_MAX_FILES_PER_ROOT = 25
DEFAULT_STDOUT_BYTES = 4096
HISTORICAL_CONTEXT_ISSUES = [879, 893, 1589]
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
    latest_training = latest_external_dashboard_artifact(bounded_artifacts, "training_ledger")
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
        "scan": {**source_scan, "gateScan": gate_scan, "mode": "bounded-control-loop-ledger-producer"},
    }


def output_path(out_dir: Path, created_at: str, suffix: str) -> Path:
    return out_dir / f"{timestamp_stem(created_at)}-{suffix}.json"


def latest_artifact_payload(dashboard: JsonObject, key: str, repo_root: Path) -> JsonObject | None:
    artifacts = as_dict(dashboard.get("artifacts"))
    raw_path = artifacts.get(key)
    if raw_path is None:
        return None
    path = Path(raw_path)
    if not path.is_absolute():
        path = repo_root / path
    return load_json(path)


def latest_artifact_path(dashboard: JsonObject, key: str, repo_root: Path) -> str | None:
    artifacts = as_dict(dashboard.get("artifacts"))
    return repo_display_path(artifacts.get(key), repo_root)


def field_from(payload: JsonObject | None, key: str, fallback: Any) -> Any:
    if isinstance(payload, dict) and key in payload:
        return payload[key]
    return fallback


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


def training_status(training: JsonObject) -> str:
    if training.get("hasComputeEvidence") is True:
        return "RUN_VALIDATED"
    raw_status = text_value(training.get("status")) or "N/A"
    if raw_status.upper() in {"RUN_NO_SIGNAL", "RUNNING"}:
        return "RUN_NO_SIGNAL"
    return "NOT_RUN"


def training_did_run(training: JsonObject) -> bool:
    return bool(training.get("hasComputeEvidence") is True or training.get("trainingDidRun") is True)


def training_anomalies(dashboard: JsonObject, previous: JsonObject | None, repo_root: Path) -> list[JsonObject]:
    training = as_dict(dashboard.get("training"))
    gate = as_dict(dashboard.get("gate"))
    anomalies: list[JsonObject] = []
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
        if isinstance(item, dict) and item.get("code") not in {anomaly["code"] for anomaly in anomalies}:
            anomalies.append(item)
    return anomalies[:12]


def build_training_ledger(
    *,
    repo_root: Path,
    artifact_root: Path,
    created_at: str,
    source_cron: str,
    max_files_per_root: int,
) -> JsonObject:
    summary = dashboard_summary(repo_root, artifact_root, created_at, max_files_per_root)
    previous = latest_artifact_payload(summary, "trainingLedger", repo_root)
    training = as_dict(summary.get("training"))
    gate = as_dict(summary.get("gate"))
    simulator = as_dict(summary.get("simulator"))
    status = training_status(training)
    did_run = training_did_run(training)
    iteration = as_dict((previous or {}).get("iterationExecution"))
    environment = as_dict((previous or {}).get("environmentExecution"))
    metrics_fields = as_dict((previous or {}).get("metricsFields"))
    git = git_metadata(repo_root)
    episodes = int_value(training.get("episodes")) or int_value(iteration.get("episodesRun")) or 0
    policy_updates = int_value(training.get("policyUpdates")) or int_value(iteration.get("policyUpdateIterations")) or 0
    ticks_run = int_value(iteration.get("simulatorTicksRun")) or int_value(simulator.get("ticksRun")) or 0
    env_completed = int_value(environment.get("completed")) or int_value(simulator.get("succeeded")) or 0
    env_failed = int_value(environment.get("failed")) or int_value(simulator.get("failed")) or 0
    anomalies = training_anomalies(summary, previous, repo_root)
    previous_environment = as_dict((previous or {}).get("environmentExecution"))

    return {
        "type": TRAINING_LEDGER_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "createdAt": created_at,
        "sourceCron": source_cron,
        "sourceIssue": None,
        "historicalContextIssues": HISTORICAL_CONTEXT_ISSUES,
        **git,
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
            "experimentCard": as_dict((previous or {}).get("trainingArtifacts")).get("experimentCard"),
            "experimentCardPath": as_dict((previous or {}).get("trainingArtifacts")).get("experimentCardPath"),
            "simulatorRunIds": as_dict((previous or {}).get("trainingArtifacts")).get("simulatorRunIds", []),
            "trainingReportIds": as_dict((previous or {}).get("trainingArtifacts")).get("trainingReportIds", []),
            "candidatePolicyIds": as_dict((previous or {}).get("trainingArtifacts")).get("candidatePolicyIds", []),
            "rewardDecisionId": as_dict((previous or {}).get("trainingArtifacts")).get("rewardDecisionId"),
            "latestTrainingLedger": latest_artifact_path(summary, "trainingLedger", repo_root),
        },
        "anomalies": anomalies,
        "nextTrainingCapabilityAction": (
            text_value((previous or {}).get("nextTrainingCapabilityAction"))
            or text_value(training.get("blocker"))
            or "Run the bounded training ledger producer after fresh Loop A training evidence is available."
        ),
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
            "rewardDecisionId": metrics_fields.get("rewardDecisionId"),
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


def build_policy_advantage(
    *,
    repo_root: Path,
    artifact_root: Path,
    created_at: str,
    source_cron: str,
    max_files_per_root: int,
) -> JsonObject:
    summary = dashboard_summary(repo_root, artifact_root, created_at, max_files_per_root)
    previous = latest_artifact_payload(summary, "policyAdvantage", repo_root)
    policy = as_dict(summary.get("policy"))
    training = as_dict(summary.get("training"))
    git = git_metadata(repo_root)
    status = text_value(policy.get("status")) or "UNPROVEN"
    if status in {"N/A", "UNKNOWN"}:
        status = "UNPROVEN"
    metrics = default_policy_metrics(policy)
    regressions = policy_regressions(metrics)
    deployability = "READY_FOR_GATED_LIVE" if status in {"POSITIVE", "PROVEN", "VALIDATED"} and not regressions else "BLOCKED"

    return {
        "type": POLICY_ADVANTAGE_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "createdAt": created_at,
        "sourceCron": source_cron,
        "sourceIssue": None,
        "historicalContextIssues": HISTORICAL_CONTEXT_ISSUES,
        **git,
        "candidatePolicyId": field_from(previous, "candidatePolicyId", policy.get("candidate") or "NO_STABLE_CANDIDATE"),
        "baselinePolicyId": field_from(previous, "baselinePolicyId", policy.get("baseline") or "incumbent"),
        "mode": field_from(previous, "mode", "offline"),
        "onlineUtilityStatus": status,
        "deployabilityStatus": deployability,
        "onlineKpiDeltaSummary": field_from(previous, "onlineKpiDeltaSummary", "No bounded online KPI delta evidence was found."),
        "baselineWindow": field_from(previous, "baselineWindow", None),
        "validationWindow": field_from(previous, "validationWindow", None),
        "rolloutGate": field_from(previous, "rolloutGate", {"status": "BLOCKED", "reason": "online KPI evidence missing"}),
        "rollbackCriteria": field_from(previous, "rollbackCriteria", {"reliabilityRegression": ">=2%", "officialMmoWritesAllowed": False}),
        "evidenceWindows": field_from(
            previous,
            "evidenceWindows",
            {
                "shadowReportIds": [],
                "simulatorRunIds": [],
                "trainingReportIds": as_dict((previous or {}).get("trainingArtifacts")).get("trainingReportIds", []),
                "historicalValidationIds": [],
                "preOnlineWindow": None,
                "postOnlineWindow": None,
                "rolloutDecisionIds": [],
                "latestTrainingLedger": latest_artifact_path(summary, "trainingLedger", repo_root),
                "latestPolicyAdvantage": latest_artifact_path(summary, "policyAdvantage", repo_root),
            },
        ),
        "metrics": metrics,
        "regressions": regressions,
        "trainingStrategyFeedback": field_from(
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
        "nextExperimentCardDelta": field_from(
            previous,
            "nextExperimentCardDelta",
            "Produce a candidate with fresh Loop A compute evidence and a pre/post KPI measurement window.",
        ),
        "rewardDecisionId": field_from(previous, "rewardDecisionId", None),
        "scorecardId": field_from(previous, "scorecardId", None),
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
        payload = build_policy_advantage(
            repo_root=repo_root,
            artifact_root=artifact_root,
            created_at=created_at,
            source_cron=args.source_cron,
            max_files_per_root=max_files,
        )
        path = resolve_against_repo(args.output, repo_root) if args.output else output_path(out_dir, created_at, "policy-advantage")
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
