#!/usr/bin/env python3
"""Generate bounded offline strategy-shadow reports from saved Screeps artifacts."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence, TextIO

import screeps_rl_dataset_export as dataset_export


SCHEMA_VERSION = 1
REPORT_TYPE = "screeps-strategy-shadow-report"
GENERATION_SUMMARY_TYPE = "screeps-strategy-shadow-report-generation"
DEFAULT_OUT_DIR = Path("runtime-artifacts/strategy-shadow")
DEFAULT_DIST_PATH = Path("prod/dist/main.js")
DEFAULT_ARTIFACT_LIMIT = 200
DEFAULT_MAX_RANKING_DIFF_SAMPLES = 25
DEFAULT_MAX_WARNING_COUNT = 20
DEFAULT_MAX_WARNING_BYTES = 240
DEFAULT_NODE_TIMEOUT_SECONDS = 30
DEFAULT_MAX_AGE_HOURS = 24 * 7
REPORT_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
FAST_SUMMARY_SUBDIR_PATTERNS = (
    "official-screeps-deploy",
    "screeps-monitor",
    "screeps-monitor-*",
)
FAST_SCAN_BASE_PATHS = (
    "runtime-artifacts",
    "/root/screeps/runtime-artifacts",
    "/root/.hermes/cron/output",
)
FAST_EXCLUDED_DIRECTORY_NAMES = (
    ".git",
    ".hermes",
    "dist",
    "node_modules",
    ".next",
    "screenshots",
    "images",
    "png",
    "jpeg",
    "jpg",
    "webp",
    "strategy-shadow",
)
FAST_BINARY_FILE_EXTENSIONS = (
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".mp4",
    ".webm",
    ".zip",
    ".gz",
    ".bz2",
    ".xz",
    ".bin",
)

JsonObject = dict[str, Any]

EVALUATOR_RUNNER_JS = r"""
const fs = require("fs");

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const evaluatorModule = require(input.distPath);
if (typeof evaluatorModule.evaluateStrategyShadowReplay !== "function") {
  throw new Error(`evaluateStrategyShadowReplay export not found in ${input.distPath}`);
}

const report = evaluatorModule.evaluateStrategyShadowReplay({
  artifacts: input.artifacts,
  config: {
    enabled: true,
    candidateStrategyIds: input.candidateStrategyIds || []
  }
});

process.stdout.write(JSON.stringify(report));
"""


@dataclass(frozen=True)
class SelectedArtifact:
    record: dataset_export.ArtifactRecord
    artifact_hash: str


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def build_strategy_shadow_report(
    paths: Sequence[str],
    out_dir: Path = DEFAULT_OUT_DIR,
    *,
    dist_path: Path = DEFAULT_DIST_PATH,
    report_id: str | None = None,
    generated_at: str | None = None,
    bot_commit: str | None = None,
    max_file_bytes: int = dataset_export.DEFAULT_MAX_FILE_BYTES,
    artifact_limit: int = DEFAULT_ARTIFACT_LIMIT,
    max_ranking_diff_samples: int = DEFAULT_MAX_RANKING_DIFF_SAMPLES,
    max_warning_count: int = DEFAULT_MAX_WARNING_COUNT,
    node_timeout_seconds: int = DEFAULT_NODE_TIMEOUT_SECONDS,
    candidate_strategy_ids: Sequence[str] = (),
    fast: bool = False,
    max_age_hours: int | None = None,
    repo_root: Path | None = None,
) -> JsonObject:
    repo = (repo_root or Path.cwd()).expanduser().resolve()
    resolved_out_dir = resolve_path_against_repo(out_dir, repo)
    resolved_paths = resolve_scan_paths(paths, repo, fast=fast)
    resolved_dist_path = resolve_dist_path(dist_path, repo)
    resolved_bot_commit = bot_commit or dataset_export.git_commit(repo)
    resolved_generated_at = generated_at or utc_now_iso()

    scan_kwargs = {}
    if fast:
        scan_kwargs.update(
            max_age_hours=max_age_hours,
            excluded_directory_names=FAST_EXCLUDED_DIRECTORY_NAMES,
            binary_file_extensions=FAST_BINARY_FILE_EXTENSIONS,
        )

    scan = dataset_export.collect_artifact_records(
        resolved_paths,
        max_file_bytes=max_file_bytes,
        excluded_roots=[resolved_out_dir],
        use_default_paths=not fast,
        **scan_kwargs,
    )
    selected_records = list(scan.records[:artifact_limit])
    selected_artifacts = [
        SelectedArtifact(record=record, artifact_hash=dataset_export.canonical_hash(record.payload))
        for record in selected_records
    ]
    artifacts = [selected.record.payload for selected in selected_artifacts]

    evaluator_report = run_shadow_evaluator(
        resolved_dist_path,
        artifacts,
        candidate_strategy_ids=candidate_strategy_ids,
        timeout_seconds=node_timeout_seconds,
    )
    report = sanitize_report(
        evaluator_report=evaluator_report,
        scan=scan,
        selected_artifacts=selected_artifacts,
        input_paths=[str(path) for path in resolved_paths],
        generated_at=resolved_generated_at,
        bot_commit=resolved_bot_commit,
        max_file_bytes=max_file_bytes,
        artifact_limit=artifact_limit,
        max_ranking_diff_samples=max_ranking_diff_samples,
        max_warning_count=max_warning_count,
        dist_path=resolved_dist_path,
    )
    resolved_report_id = report_id or default_report_id(report)
    validate_report_id(resolved_report_id)
    report["reportId"] = resolved_report_id

    report_path = resolved_out_dir / f"{resolved_report_id}.json"
    write_json_atomic(report_path, report)

    return build_generation_summary(report, report_path, scan)


def resolve_dist_path(dist_path: Path, repo_root: Path) -> Path:
    resolved = resolve_path_against_repo(dist_path, repo_root)
    if not resolved.exists():
        raise FileNotFoundError(
            f"{dataset_export.display_path(resolved)} not found; run `cd prod && npm run build` before generating reports"
        )
    return resolved


def resolve_scan_paths(paths: Sequence[str], repo_root: Path, *, fast: bool = False) -> list[Path]:
    if not paths:
        if fast:
            input_paths = resolve_fast_scan_roots(repo_root)
        else:
            input_paths = list(dataset_export.DEFAULT_INPUT_PATHS)
    else:
        input_paths = list(paths)
    return [resolve_path_against_repo(Path(path), repo_root) for path in input_paths]


def resolve_fast_scan_roots(repo_root: Path) -> list[Path]:
    resolved_roots: list[Path] = []
    for base_path in [resolve_path_against_repo(Path(path), repo_root) for path in FAST_SCAN_BASE_PATHS]:
        if not base_path.is_dir():
            continue
        for pattern in FAST_SUMMARY_SUBDIR_PATTERNS:
            if "*" in pattern:
                for match in sorted(base_path.glob(pattern)):
                    if match.is_dir():
                        resolved_roots.append(match.resolve())
                continue
            candidate = base_path / pattern
            if candidate.is_dir():
                resolved_roots.append(candidate.resolve())

    unique_paths: list[Path] = []
    seen = set[str]()
    for path in resolved_roots:
        canonical = str(path)
        if canonical not in seen:
            unique_paths.append(path)
            seen.add(canonical)
    return sorted(unique_paths, key=lambda item: str(item))


def resolve_path_against_repo(path: Path, repo_root: Path) -> Path:
    expanded = path.expanduser()
    resolved = expanded if expanded.is_absolute() else repo_root / expanded
    return resolved.resolve()


def run_shadow_evaluator(
    dist_path: Path,
    artifacts: Sequence[JsonObject],
    *,
    candidate_strategy_ids: Sequence[str],
    timeout_seconds: int,
) -> JsonObject:
    payload = {
        "distPath": str(dist_path),
        "artifacts": list(artifacts),
        "candidateStrategyIds": list(candidate_strategy_ids),
    }
    try:
        result = subprocess.run(
            ["node", "-e", EVALUATOR_RUNNER_JS],
            input=json.dumps(payload, sort_keys=True),
            text=True,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
        )
    except FileNotFoundError as error:
        raise RuntimeError("node executable not found; install Node and run `cd prod && npm run build`") from error
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"strategy shadow evaluator timed out after {timeout_seconds}s") from error
    except subprocess.CalledProcessError as error:
        stderr = sanitize_text(error.stderr or "", max_bytes=800)
        raise RuntimeError(f"strategy shadow evaluator failed: {stderr}") from error

    parsed = dataset_export.parse_json(result.stdout)
    if not isinstance(parsed, dict):
        raise RuntimeError("strategy shadow evaluator returned non-object JSON")
    return parsed


def sanitize_report(
    *,
    evaluator_report: JsonObject,
    scan: dataset_export.ScanResult,
    selected_artifacts: Sequence[SelectedArtifact],
    input_paths: Sequence[str],
    generated_at: str,
    bot_commit: str,
    max_file_bytes: int,
    artifact_limit: int,
    max_ranking_diff_samples: int,
    max_warning_count: int,
    dist_path: Path,
) -> JsonObject:
    model_reports = sanitize_model_reports(evaluator_report.get("modelReports"), max_ranking_diff_samples)
    ranking_diff_count = sum(number_or_zero(report.get("rankingDiffCount")) for report in model_reports)
    changed_top_count = sum(number_or_zero(report.get("changedTopCount")) for report in model_reports)
    warnings = bounded_warnings(evaluator_report.get("warnings"), max_warning_count)

    if len(scan.records) > len(selected_artifacts):
        warnings.append(
            sanitize_text(
                f"artifact limit applied: evaluated {len(selected_artifacts)} of {len(scan.records)} parsed artifacts",
                max_bytes=DEFAULT_MAX_WARNING_BYTES,
            )
        )

    return {
        "type": REPORT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "botCommit": sanitize_text(bot_commit, max_bytes=80),
        "enabled": evaluator_report.get("enabled") is True,
        "liveEffect": False,
        "safety": safety_metadata(dist_path),
        "source": source_metadata(
            scan=scan,
            selected_artifacts=selected_artifacts,
            input_paths=input_paths,
            max_file_bytes=max_file_bytes,
            artifact_limit=artifact_limit,
        ),
        "artifactCount": number_or_zero(evaluator_report.get("artifactCount")),
        "modelReportCount": len(model_reports),
        "modelFamilies": sorted(
            {
                report["family"]
                for report in model_reports
                if isinstance(report.get("family"), str) and report.get("family")
            }
        ),
        "candidateStrategyIds": sorted(
            {
                report["candidateStrategyId"]
                for report in model_reports
                if isinstance(report.get("candidateStrategyId"), str) and report.get("candidateStrategyId")
            }
        ),
        "incumbentStrategyIds": sorted(
            {
                report["incumbentStrategyId"]
                for report in model_reports
                if isinstance(report.get("incumbentStrategyId"), str) and report.get("incumbentStrategyId")
            }
        ),
        "rankingDiffCount": ranking_diff_count,
        "changedTopCount": changed_top_count,
        "kpiSummary": sanitize_kpi_summary(evaluator_report.get("kpi")),
        "modelReports": model_reports,
        "warnings": warnings[:max_warning_count],
    }


def safety_metadata(dist_path: Path) -> JsonObject:
    return {
        "liveEffect": False,
        "inputMode": "saved local runtime-summary artifacts only",
        "evaluator": "evaluateStrategyShadowReplay",
        "distPath": dataset_export.display_path(dist_path),
        "networkRequired": False,
        "liveApiCalls": False,
        "officialMmoWritesAllowed": False,
        "memoryWritesAllowed": False,
        "rawMemoryWritesAllowed": False,
        "creepSpawnMarketIntentsAllowed": False,
        "allowedUse": "offline strategy replay, RL dataset indexing, and historical validation input only",
    }


def source_metadata(
    *,
    scan: dataset_export.ScanResult,
    selected_artifacts: Sequence[SelectedArtifact],
    input_paths: Sequence[str],
    max_file_bytes: int,
    artifact_limit: int,
) -> JsonObject:
    selected_source_ids = {selected.record.source.source_id for selected in selected_artifacts}
    source_files = [
        source_file_metadata(source, selected_artifacts)
        for source in sorted(scan.source_files.values(), key=lambda item: item.source_id)
        if source.source_id in selected_source_ids
    ]
    artifacts = [
        {
            "artifactId": f"artifact-{selected.artifact_hash[:16]}",
            "sourceId": selected.record.source.source_id,
            "path": selected.record.source.display_path,
            "lineNumber": selected.record.line_number,
            "artifactKind": selected.record.artifact_kind,
            "sha256": selected.artifact_hash,
            "tick": number_or_none(selected.record.payload.get("tick")),
            "roomCount": room_count(selected.record.payload),
        }
        for selected in selected_artifacts
    ]
    return {
        "inputPaths": dataset_export.redacted_input_paths(input_paths),
        "scannedFiles": scan.scanned_files,
        "sourceCount": len(source_files),
        "parsedRuntimeArtifactCount": len(scan.records),
        "evaluatedArtifactCount": len(selected_artifacts),
        "artifactLimit": artifact_limit,
        "artifactLimitApplied": len(scan.records) > len(selected_artifacts),
        "maxFileBytes": max_file_bytes,
        "skippedFileCount": len(scan.skipped_files),
        "skippedFiles": sanitize_skipped_files(scan.skipped_files),
        "sourceFiles": source_files,
        "artifacts": artifacts,
    }


def source_file_metadata(source: dataset_export.SourceFile, selected_artifacts: Sequence[SelectedArtifact]) -> JsonObject:
    matching = [selected for selected in selected_artifacts if selected.record.source.source_id == source.source_id]
    return {
        "sourceId": source.source_id,
        "path": source.display_path,
        "sizeBytes": source.size_bytes,
        "sha256": source.sha256,
        "artifactCount": len(matching),
        "lineNumbers": [
            selected.record.line_number
            for selected in matching
            if isinstance(selected.record.line_number, int)
        ][:50],
    }


def sanitize_skipped_files(skipped_files: Sequence[JsonObject], limit: int = 20) -> list[JsonObject]:
    sanitized: list[JsonObject] = []
    for item in skipped_files[:limit]:
        sanitized_item: JsonObject = {}
        for key, value in item.items():
            if isinstance(value, str):
                sanitized_item[str(key)] = sanitize_text(value, max_bytes=240)
            elif isinstance(value, (int, float, bool)) or value is None:
                sanitized_item[str(key)] = value
        sanitized.append(sanitized_item)
    return sanitized


def sanitize_model_reports(raw_model_reports: Any, max_ranking_diff_samples: int) -> list[JsonObject]:
    if not isinstance(raw_model_reports, list):
        return []

    model_reports: list[JsonObject] = []
    for raw_report in raw_model_reports:
        if not isinstance(raw_report, dict):
            continue
        raw_diffs = raw_report.get("rankingDiffs") if isinstance(raw_report.get("rankingDiffs"), list) else []
        diff_samples = [sanitize_ranking_diff(diff) for diff in raw_diffs[:max_ranking_diff_samples] if isinstance(diff, dict)]
        changed_top_count = sum(1 for diff in raw_diffs if isinstance(diff, dict) and diff.get("changedTop") is True)
        model_reports.append(
            {
                "family": sanitize_text(raw_report.get("family"), max_bytes=80),
                "incumbentStrategyId": sanitize_text(raw_report.get("incumbentStrategyId"), max_bytes=120),
                "candidateStrategyId": sanitize_text(raw_report.get("candidateStrategyId"), max_bytes=120),
                "rankingDiffCount": len(raw_diffs),
                "changedTopCount": changed_top_count,
                "rankingDiffsTruncated": len(raw_diffs) > len(diff_samples),
                "rankingDiffs": diff_samples,
            }
        )
    return model_reports


def sanitize_ranking_diff(raw_diff: JsonObject) -> JsonObject:
    rank_changes = raw_diff.get("rankChanges") if isinstance(raw_diff.get("rankChanges"), list) else []
    return {
        "artifactIndex": number_or_none(raw_diff.get("artifactIndex")),
        "tick": number_or_none(raw_diff.get("tick")),
        "roomName": sanitize_optional_text(raw_diff.get("roomName"), max_bytes=80),
        "context": sanitize_text(raw_diff.get("context"), max_bytes=80),
        "changedTop": raw_diff.get("changedTop") is True,
        "incumbentTop": sanitize_ranked_item(raw_diff.get("incumbentTop")),
        "candidateTop": sanitize_ranked_item(raw_diff.get("candidateTop")),
        "rankChangeCount": len(rank_changes),
        "rankChangeSamples": [sanitize_rank_change(item) for item in rank_changes[:5] if isinstance(item, dict)],
    }


def sanitize_ranked_item(raw_item: Any) -> JsonObject | None:
    if not isinstance(raw_item, dict):
        return None
    return {
        "itemId": sanitize_text(raw_item.get("itemId"), max_bytes=160),
        "label": sanitize_text(raw_item.get("label"), max_bytes=160),
        "rank": number_or_none(raw_item.get("rank")),
        "score": number_or_none(raw_item.get("score")),
        "baseScore": number_or_none(raw_item.get("baseScore")),
    }


def sanitize_rank_change(raw_change: JsonObject) -> JsonObject:
    return {
        "itemId": sanitize_text(raw_change.get("itemId"), max_bytes=160),
        "label": sanitize_text(raw_change.get("label"), max_bytes=160),
        "incumbentRank": number_or_none(raw_change.get("incumbentRank")),
        "candidateRank": number_or_none(raw_change.get("candidateRank")),
        "delta": number_or_none(raw_change.get("delta")),
    }


def sanitize_kpi_summary(raw_kpi: Any) -> JsonObject:
    if not isinstance(raw_kpi, dict):
        return {}
    summary: JsonObject = {}
    reliability = raw_kpi.get("reliability")
    if isinstance(reliability, dict):
        summary["reliability"] = {
            "passed": reliability.get("passed") is True,
            "reasons": bounded_warnings(reliability.get("reasons"), DEFAULT_MAX_WARNING_COUNT),
            "metrics": select_number_map(reliability.get("metrics")),
        }
    for dimension in ("territory", "resources", "kills"):
        raw_dimension = raw_kpi.get(dimension)
        if isinstance(raw_dimension, dict):
            summary[dimension] = {
                "score": number_or_none(raw_dimension.get("score")),
                "components": select_number_map(raw_dimension.get("components")),
            }
    return summary


def bounded_warnings(raw_warnings: Any, limit: int) -> list[str]:
    if not isinstance(raw_warnings, list):
        return []
    warnings: list[str] = []
    for warning in raw_warnings[:limit]:
        if isinstance(warning, str):
            warnings.append(sanitize_text(warning, max_bytes=DEFAULT_MAX_WARNING_BYTES))
    return warnings


def build_generation_summary(report: JsonObject, report_path: Path, scan: dataset_export.ScanResult) -> JsonObject:
    return {
        "ok": True,
        "type": GENERATION_SUMMARY_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "reportId": report["reportId"],
        "reportPath": dataset_export.display_path(report_path),
        "liveEffect": False,
        "artifactCount": report["artifactCount"],
        "parsedRuntimeArtifactCount": len(scan.records),
        "modelReportCount": report["modelReportCount"],
        "rankingDiffCount": report["rankingDiffCount"],
        "changedTopCount": report["changedTopCount"],
        "candidateStrategyIds": report["candidateStrategyIds"],
        "incumbentStrategyIds": report["incumbentStrategyIds"],
        "warnings": report["warnings"],
    }


def default_report_id(report: JsonObject) -> str:
    generated_at = str(report.get("generatedAt", "unknown")).replace(":", "").replace("+", "").replace("Z", "Z")
    seed = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": report.get("generatedAt"),
        "botCommit": report.get("botCommit"),
        "source": report.get("source"),
        "candidateStrategyIds": report.get("candidateStrategyIds"),
        "rankingDiffCount": report.get("rankingDiffCount"),
        "changedTopCount": report.get("changedTopCount"),
    }
    return f"strategy-shadow-{generated_at}-{dataset_export.canonical_hash(seed)[:12]}"


def validate_report_id(report_id: str) -> None:
    if not REPORT_ID_RE.fullmatch(report_id) or report_id in {".", ".."}:
        raise ValueError("report id may contain only letters, numbers, dot, underscore, and hyphen")


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


def sanitize_text(value: Any, max_bytes: int) -> str:
    text = value if isinstance(value, str) else ""
    sanitized = dataset_export.redact_text(text).replace("\r", " ").replace("\n", " ")
    encoded = sanitized.encode("utf-8")[:max_bytes]
    return encoded.decode("utf-8", errors="ignore")


def sanitize_optional_text(value: Any, max_bytes: int) -> str | None:
    if not isinstance(value, str):
        return None
    return sanitize_text(value, max_bytes=max_bytes)


def select_number_map(raw: Any) -> JsonObject:
    if not isinstance(raw, dict):
        return {}
    return {str(key): value for key, value in sorted(raw.items()) if dataset_export.is_number(value)}


def number_or_none(value: Any) -> int | float | None:
    return value if dataset_export.is_number(value) else None


def number_or_zero(value: Any) -> int:
    return int(value) if dataset_export.is_number(value) else 0


def room_count(payload: JsonObject) -> int:
    rooms = payload.get("rooms")
    return len(rooms) if isinstance(rooms, list) else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Generate a bounded offline strategy-shadow report from saved local Screeps runtime-summary artifacts."
        ),
    )
    parser.add_argument(
        "paths",
        nargs="*",
        help=(
            "Files or directories to scan. Defaults to /root/screeps/runtime-artifacts, "
            "/root/.hermes/cron/output, and repo-local runtime-artifacts."
        ),
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help=f"Report output directory. Default: {DEFAULT_OUT_DIR}.",
    )
    parser.add_argument(
        "--dist-path",
        type=Path,
        default=DEFAULT_DIST_PATH,
        help=f"Built prod bundle exporting evaluateStrategyShadowReplay. Default: {DEFAULT_DIST_PATH}.",
    )
    parser.add_argument(
        "--report-id",
        help="Optional report file stem. Defaults to a timestamp plus content hash.",
    )
    parser.add_argument(
        "--bot-commit",
        help="Bot commit to record. Defaults to git rev-parse HEAD.",
    )
    parser.add_argument(
        "--max-file-bytes",
        type=positive_int,
        default=dataset_export.DEFAULT_MAX_FILE_BYTES,
        help=f"Skip files larger than this many bytes. Default: {dataset_export.DEFAULT_MAX_FILE_BYTES}.",
    )
    parser.add_argument(
        "--artifact-limit",
        type=positive_int,
        default=DEFAULT_ARTIFACT_LIMIT,
        help=f"Maximum parsed runtime artifacts to evaluate. Default: {DEFAULT_ARTIFACT_LIMIT}.",
    )
    parser.add_argument(
        "--max-ranking-diff-samples",
        type=positive_int,
        default=DEFAULT_MAX_RANKING_DIFF_SAMPLES,
        help=f"Maximum ranking diff samples kept per model report. Default: {DEFAULT_MAX_RANKING_DIFF_SAMPLES}.",
    )
    parser.add_argument(
        "--max-warning-count",
        type=positive_int,
        default=DEFAULT_MAX_WARNING_COUNT,
        help=f"Maximum warnings retained in the report. Default: {DEFAULT_MAX_WARNING_COUNT}.",
    )
    parser.add_argument(
        "--fast",
        action="store_true",
        help=(
            "Use cron-optimized scan: only official-screeps-deploy/, screeps-monitor/, and screeps-monitor-* "
            "under runtime-artifacts and /root/.hermes/cron/output."
        ),
    )
    parser.add_argument(
        "--max-age-hours",
        type=positive_int,
        default=DEFAULT_MAX_AGE_HOURS,
        help=(
            "When --fast is enabled, only include files modified in the last N hours. "
            f"Default: {DEFAULT_MAX_AGE_HOURS}."
        ),
    )
    parser.add_argument(
        "--candidate-strategy-id",
        action="append",
        default=[],
        help="Candidate strategy ID to evaluate. Repeat to override the registry's shadow candidates.",
    )
    parser.add_argument(
        "--json-summary",
        action="store_true",
        help="Output a compact one-line JSON summary for cron parsing.",
    )
    parser.add_argument(
        "--node-timeout-seconds",
        type=positive_int,
        default=DEFAULT_NODE_TIMEOUT_SECONDS,
        help=f"Node evaluator timeout. Default: {DEFAULT_NODE_TIMEOUT_SECONDS}.",
    )
    return parser


def main(
    argv: list[str] | None = None,
    stdout: TextIO = sys.stdout,
    repo_root: Path | None = None,
) -> int:
    args = build_parser().parse_args(argv)
    repo = (repo_root or Path.cwd()).expanduser().resolve()
    start_time = time.perf_counter()
    summary = build_strategy_shadow_report(
        args.paths,
        args.out_dir,
        dist_path=args.dist_path,
        repo_root=repo,
        report_id=args.report_id,
        bot_commit=args.bot_commit,
        max_file_bytes=args.max_file_bytes,
        artifact_limit=args.artifact_limit,
        max_ranking_diff_samples=args.max_ranking_diff_samples,
        max_warning_count=args.max_warning_count,
        node_timeout_seconds=args.node_timeout_seconds,
        candidate_strategy_ids=args.candidate_strategy_id,
        fast=args.fast,
        max_age_hours=args.max_age_hours if args.fast else None,
    )
    wall_seconds = time.perf_counter() - start_time
    if args.json_summary:
        stdout.write(
            json.dumps(
                build_json_summary(summary, wall_seconds),
                sort_keys=True,
                ensure_ascii=True,
            )
        )
    else:
        stdout.write(json.dumps(summary, indent=2, sort_keys=True, ensure_ascii=True))
    stdout.write("\n")
    return 0


def build_json_summary(report_summary: JsonObject, wall_seconds: float) -> JsonObject:
    return {
        "ok": bool(report_summary.get("ok")),
        "reportId": report_summary.get("reportId"),
        "reportPath": report_summary.get("reportPath"),
        "artifactCount": report_summary.get("artifactCount"),
        "parsedRuntimeArtifactCount": report_summary.get("parsedRuntimeArtifactCount"),
        "modelReportCount": report_summary.get("modelReportCount"),
        "rankingDiffCount": report_summary.get("rankingDiffCount"),
        "changedTopCount": report_summary.get("changedTopCount"),
        "warnings": report_summary.get("warnings", []),
        "wallSeconds": round(wall_seconds, 3),
    }


if __name__ == "__main__":
    raise SystemExit(main(repo_root=Path(__file__).resolve().parent.parent))
