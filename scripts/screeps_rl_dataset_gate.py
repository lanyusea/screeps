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
import screeps_strategy_shadow_report as shadow_report


SCHEMA_VERSION = 1
CONTRACT_TYPE = "screeps-rl-dataset-evaluation-gate-contract"
REPORT_TYPE = "screeps-rl-dataset-evaluation-gate"
SUMMARY_TYPE = "screeps-rl-dataset-evaluation-gate-summary"
DEFAULT_OUT_DIR = Path("runtime-artifacts/rl-dataset-gates")
DEFAULT_MIN_SAMPLES = 1
DEFAULT_SHADOW_ARTIFACT_LIMIT = 200
GATE_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")

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
        },
        "outputs": {
            "directory": "runtime-artifacts/rl-dataset-gates/<gate-id>/",
            "files": {
                "gateReport": "gate_report.json",
                "gateSummary": "gate_summary.json",
                "rolloutGateContract": "rollout_gate_contract.json",
                "rolloutDecision": "rollout_decision.json when --baseline-kpi is supplied",
            },
            "linkedArtifacts": [
                "runtime-artifacts/rl-datasets/<run-id>/",
                "runtime-artifacts/strategy-shadow/<report-id>.json unless --skip-shadow-report is used",
                "historical validation report when --candidate-config is supplied",
            ],
        },
        "gateChecks": {
            "dataset": "dataset run exists, has at least the configured sample count, has manifest/source/tick/KPI files, and preserves offline safety flags",
            "shadowEvaluation": "strategy-shadow report generation succeeds unless explicitly skipped",
            "historicalValidation": "candidate report must pass when --candidate-config is supplied",
            "predefinedMetrics": "current KPI window must satisfy configured metric floors",
            "rolloutManager": "dry-run decision must pass when --baseline-kpi is supplied; rollout contract is always persisted",
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


def evaluate_dataset_readiness(
    dataset_summary: JsonObject,
    file_paths: dict[str, Path],
    run_manifest: JsonObject,
    ticks_count: int,
    *,
    min_samples: int,
) -> JsonObject:
    sample_count = int(dataset_summary.get("sampleCount", 0)) if isinstance(dataset_summary.get("sampleCount"), int) else 0
    files_to_check = ("scenarioManifest", "runManifest", "sourceIndex", "ticks", "kpiWindows", "episodes", "datasetCard")
    checks: list[JsonObject] = [
        pass_fail_check(
            "minimum_samples",
            sample_count >= min_samples,
            actual=sample_count,
            required=min_samples,
        ),
        pass_fail_check("ticks_match_manifest_count", ticks_count == sample_count, ticksRows=ticks_count),
        pass_fail_check(
            "run_manifest_type",
            run_manifest.get("type") == dataset_export.RUN_MANIFEST_TYPE,
            actual=run_manifest.get("type"),
        ),
    ]
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
        "splitCounts": dataset_summary.get("splitCounts"),
        "runId": dataset_summary.get("runId"),
        "runDir": dataset_export.display_path(file_paths["runDir"]),
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


def evaluate_predefined_metric_gate(current_kpi: JsonObject, floors: dict[str, float], source_path: Path) -> JsonObject:
    normalized = rollout_manager.normalize_kpi_window(current_kpi, dataset_export.display_path(source_path))
    if not floors:
        return {
            "status": "not_configured",
            "checks": [],
            "floors": {},
            "normalizedCurrent": normalized,
        }

    checks: list[JsonObject] = []
    metrics = normalized["metrics"]
    for metric, floor in floors.items():
        value = metrics.get(metric)
        passed = isinstance(value, (int, float)) and not isinstance(value, bool) and float(value) >= floor
        checks.append(
            pass_fail_check(
                metric,
                passed,
                actual=value,
                minimum=floor,
            )
        )

    return {
        "status": "pass" if all(check["status"] == "pass" for check in checks) else "fail",
        "checks": checks,
        "floors": floors,
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
        return {
            "status": "not_configured",
            "ok": True,
            "reason": "baseline_kpi_not_provided",
            "contractPath": dataset_export.display_path(contract_path),
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

    for key in ("shadowEvaluation", "historicalValidation", "predefinedMetricGate", "rolloutGate"):
        gate = report.get(key)
        if not isinstance(gate, dict):
            continue
        status = gate.get("status")
        if status in ("pass", "skipped", "not_configured"):
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
    shadow = report.get("shadowEvaluation") if isinstance(report.get("shadowEvaluation"), dict) else {}
    historical = report.get("historicalValidation") if isinstance(report.get("historicalValidation"), dict) else {}
    predefined = report.get("predefinedMetricGate") if isinstance(report.get("predefinedMetricGate"), dict) else {}
    rollout = report.get("rolloutGate") if isinstance(report.get("rolloutGate"), dict) else {}
    return {
        "ok": report.get("ok") is True,
        "type": SUMMARY_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "gateId": report.get("gateId"),
        "reportPath": report.get("reportPath"),
        "datasetRunId": dataset.get("runId"),
        "datasetPath": dataset.get("outDir"),
        "sampleCount": dataset_gate.get("sampleCount"),
        "shadowStatus": shadow.get("status"),
        "shadowReportPath": shadow.get("reportPath"),
        "historicalValidationStatus": historical.get("status"),
        "historicalValidationDecision": historical.get("decision"),
        "predefinedMetricGateStatus": predefined.get("status"),
        "rolloutGateStatus": rollout.get("status"),
        "rolloutDecision": rollout.get("decision"),
        "blockingReasons": report.get("blockingReasons", []),
    }


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
    repo_root: Path | None = None,
) -> JsonObject:
    repo = (repo_root or Path.cwd()).expanduser().resolve()
    created = created_at or utc_now_iso()
    resolved_bot_commit = bot_commit or dataset_export.git_commit(repo)
    resolved_gate_id = gate_id or default_gate_id(
        created_at=created,
        input_paths=paths,
        candidate_config=candidate_config,
        baseline_kpi=baseline_kpi,
        current_kpi=current_kpi,
        bot_commit=resolved_bot_commit,
    )
    validate_gate_id(resolved_gate_id)

    gate_dir = resolve_path_against_repo(out_dir, repo) / resolved_gate_id
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

    summary = build_summary(report)
    write_json_atomic(report_path, report)
    write_json_atomic(gate_dir / "gate_summary.json", summary)
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
    run.add_argument("--baseline-kpi", type=Path, help="Optional pre/baseline KPI fixture for rollout-manager dry-run.")
    run.add_argument("--current-kpi", type=Path, help="Optional current KPI fixture. Defaults to the generated dataset kpi_windows.json.")
    run.add_argument("--candidate-id", help="Candidate ID recorded in rollout-manager dry-run output.")
    run.add_argument("--deploy-ref", help="Candidate deploy ref recorded in rollout-manager dry-run output.")
    run.add_argument("--min-reliability", type=non_negative_number, help="Optional current KPI reliability floor.")
    run.add_argument("--min-owned-rooms", type=non_negative_number, help="Optional current owned-room floor.")
    run.add_argument("--min-resource-score", type=non_negative_number, help="Optional current resource-score floor.")
    run.add_argument("--min-kills-score", type=non_negative_number, help="Optional current kills-score floor.")
    run.add_argument("--print-report", action="store_true", help="Print the full gate report instead of the compact summary.")
    return parser


def write_output(payload: JsonObject, output: Path | None, stdout: TextIO) -> None:
    text = canonical_json(payload)
    if output is None:
        stdout.write(text)
        return
    write_json_atomic(output, payload)


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
            )
            stdout.write(canonical_json(report if args.print_report else build_summary(report)))
            return 0 if report.get("ok") is True else 1

        parser.error(f"unsupported command: {args.command}")
    except DatasetGateError as error:
        stderr.write(f"error: {error}\n")
        return 2
    except (RuntimeError, OSError, mmo_validator.ValidationConfigError) as error:
        stderr.write(f"error: {dataset_export.redact_text(str(error))}\n")
        return 2

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
