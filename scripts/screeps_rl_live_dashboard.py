#!/usr/bin/env python3
"""Serve a local live RL dashboard backed by the RL metrics SQLite store."""

from __future__ import annotations

import argparse
import html
import json
import sqlite3
import sys
import threading
import urllib.error
import urllib.request
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Sequence
from urllib.parse import urlparse

import screeps_rl_dashboard as static_dashboard
import screeps_rl_metrics_ingestor as metrics_ingestor
import screeps_rl_scale_gates as scale_gates


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8790
DEFAULT_REFRESH_SECONDS = 60
DEFAULT_AUTO_REFRESH_SECONDS = 300
DEFAULT_HEALTHCHECK_URL = f"http://{DEFAULT_HOST}:{DEFAULT_PORT}/healthz"
REQUIRED_TABLES = (
    "metric_definitions",
    "metric_observations",
    "runtime_room_metrics",
    "gameplay_behavior_findings",
    "metric_coverage_gaps",
    "rl_dataset_gate_metrics",
    "rl_training_execution_metrics",
    "rl_policy_advantage_metrics",
    "metric_iteration_decisions",
)
DEFAULT_ARTIFACT_SUBDIRS = (
    "runtime-summary-console",
    "rl-dataset-gates",
    "rl-control-loop",
    "rl-training",
)
REQUIRED_TENCENT_SAFETY_FIELDS = ("liveEffect", "officialMmoWrites", "officialMmoWritesAllowed")
REQUIRED_TENCENT_SHADOW_SAFETY_FIELDS = ("conservative_actions_only", "ood_rejection")
RUNTIME_INJECTION_TRUE_KEYS = {
    "runtimeparameterinjection",
    "inlinecandidatesruntimeinjected",
    "inlinecandidatesappliedtosimulator",
}
RUNTIME_INJECTION_SCOPE_KEYS = {"candidateparameterscope"}
RUNTIME_INJECTION_METADATA_ONLY_VALUES = {"metadataonly"}

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class LiveDashboardConfig:
    repo_root: Path
    artifact_root: Path
    db_path: Path
    refresh_seconds: int = DEFAULT_REFRESH_SECONDS
    enable_refresh_endpoint: bool = False
    auto_refresh_seconds: int = 0


class LiveDashboardHTTPServer(ThreadingHTTPServer):
    config: LiveDashboardConfig
    refresh_lock: threading.Lock
    refresh_state_lock: threading.Lock

    def __init__(
        self,
        server_address: tuple[str, int],
        handler_class: type[BaseHTTPRequestHandler],
        config: LiveDashboardConfig,
    ) -> None:
        super().__init__(server_address, handler_class)
        self.config = config
        self.refresh_lock = threading.Lock()
        self.refresh_state_lock = threading.Lock()
        self.refresh_stop = threading.Event()
        self.refresh_thread: threading.Thread | None = None
        self.refresh_state: JsonObject = {
            "mode": "auto" if config.auto_refresh_seconds > 0 else "manual",
            "autoRefreshSeconds": config.auto_refresh_seconds if config.auto_refresh_seconds > 0 else None,
            "lastRefreshAt": None,
            "lastRefreshOk": None,
            "lastRefresh": None,
            "nextRefreshAt": utc_iso_after(config.auto_refresh_seconds)
            if config.auto_refresh_seconds > 0
            else None,
        }
        if config.auto_refresh_seconds > 0:
            self.start_auto_refresh()

    def record_refresh(self, refresh: JsonObject, refreshed_at: str | None = None) -> None:
        timestamp = refreshed_at or utc_now_iso()
        with self.refresh_state_lock:
            self.refresh_state["lastRefreshAt"] = timestamp
            self.refresh_state["lastRefreshOk"] = refresh_succeeded(refresh)
            self.refresh_state["lastRefresh"] = dashboard_json_safe(refresh, self.config.repo_root)
            self.refresh_state["nextRefreshAt"] = (
                utc_iso_after(self.config.auto_refresh_seconds)
                if self.config.auto_refresh_seconds > 0
                else None
            )

    def refresh_snapshot(self) -> JsonObject:
        with self.refresh_state_lock:
            return dict(self.refresh_state)

    def start_auto_refresh(self) -> None:
        if self.refresh_thread is not None:
            return

        def refresh_loop() -> None:
            while not self.refresh_stop.wait(self.config.auto_refresh_seconds):
                with self.refresh_lock:
                    try:
                        refresh = refresh_metrics(self.config.db_path, self.config.artifact_root)
                    except Exception as error:  # pragma: no cover - defensive background loop boundary
                        refresh = {"ok": False, "error": str(error)}
                self.record_refresh(refresh)

        self.refresh_thread = threading.Thread(target=refresh_loop, daemon=True, name="rl-dashboard-refresh")
        self.refresh_thread.start()

    def server_close(self) -> None:
        self.refresh_stop.set()
        if self.refresh_thread is not None:
            self.refresh_thread.join(timeout=2)
            self.refresh_thread = None
        super().server_close()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def utc_iso_from_datetime(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def utc_iso_after(seconds: int) -> str:
    return utc_iso_from_datetime(datetime.now(timezone.utc) + timedelta(seconds=seconds))


def parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def display_timestamp(value: Any) -> str:
    parsed = parse_iso_datetime(value)
    if parsed is not None:
        return utc_iso_from_datetime(parsed)
    if isinstance(value, datetime):
        return utc_iso_from_datetime(value)
    return str(value) if value not in (None, "") else "N/A"


def seconds_since(value: Any, *, now: Any | None = None) -> int | None:
    parsed = parse_iso_datetime(value)
    current = parse_iso_datetime(now) if now is not None else datetime.now(timezone.utc)
    if parsed is None or current is None:
        return None
    return max(0, int((current - parsed).total_seconds()))


def age_label(value: Any, *, now: Any | None = None) -> str:
    age_seconds = seconds_since(value, now=now)
    if age_seconds is None:
        return "N/A"
    if age_seconds < 120:
        return f"{age_seconds}s"
    minutes = age_seconds // 60
    if minutes < 120:
        return f"{minutes}m"
    hours = minutes // 60
    if hours < 72:
        return f"{hours}h"
    return f"{hours // 24}d"


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def resolve_path(path: Path, repo_root: Path) -> Path:
    expanded = path.expanduser()
    return expanded if expanded.is_absolute() else repo_root / expanded


def safe_display_path(path: Path | str | None, repo_root: Path) -> str:
    return static_dashboard.safe_display_path(path, repo_root)


def format_dashboard_url(host: str, port: int) -> str:
    display_host = f"[{host}]" if ":" in host and not host.startswith("[") else host
    return f"http://{display_host}:{port}/"


def dashboard_json_safe(value: Any, repo_root: Path) -> Any:
    if isinstance(value, Path):
        return safe_display_path(value, repo_root)
    if isinstance(value, datetime):
        return display_timestamp(value)
    if isinstance(value, Counter):
        return dict(value)
    if isinstance(value, dict):
        return {str(key): dashboard_json_safe(item, repo_root) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [dashboard_json_safe(item, repo_root) for item in value]
    return value


def load_json_object(path: Path) -> JsonObject | None:
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
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return None


def normalized_key(value: Any) -> str:
    return "".join(character.lower() for character in str(value) if character.isalnum())


def iter_json_objects(value: Any) -> list[JsonObject]:
    objects: list[JsonObject] = []

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            objects.append(node)
            for nested in node.values():
                if isinstance(nested, (dict, list)):
                    visit(nested)
        elif isinstance(node, list):
            for nested in node:
                if isinstance(nested, (dict, list)):
                    visit(nested)

    visit(value)
    return objects


def compact_value(value: Any, *, limit: int = 160) -> str:
    if value in (None, "", [], {}):
        return "N/A"
    if isinstance(value, str):
        text = value
    else:
        text = json.dumps(value, sort_keys=True, ensure_ascii=True)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def compact_sequence(value: Any, *, limit: int = 3) -> str:
    if isinstance(value, dict):
        items = [f"{key}:{item}" for key, item in value.items()]
    elif isinstance(value, list):
        items = [compact_value(item, limit=80) for item in value]
    else:
        text = compact_value(value)
        return text
    if not items:
        return "N/A"
    suffix = "" if len(items) <= limit else f" (+{len(items) - limit} more)"
    return "; ".join(items[:limit]) + suffix


def artifact_timestamp(path: Path, payload: JsonObject) -> datetime:
    for key in ("finishedAt", "createdAt", "updatedAt", "generatedAt", "startedAt", "timestamp"):
        parsed = parse_iso_datetime(payload.get(key))
        if parsed is not None:
            return parsed
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    except OSError:
        return datetime.fromtimestamp(0, tz=timezone.utc)


def latest_json_artifact(root: Path, patterns: Sequence[str]) -> tuple[Path, JsonObject, datetime] | None:
    candidates: list[tuple[Path, JsonObject, datetime]] = []
    if not root.exists():
        return None
    for pattern in patterns:
        for path in root.glob(pattern):
            if not path.is_file():
                continue
            payload = load_json_object(path)
            if payload is None:
                continue
            candidates.append((path, payload, artifact_timestamp(path, payload)))
    if not candidates:
        return None
    return max(candidates, key=lambda item: item[2])


def db_latest_timestamp(conn: sqlite3.Connection, table_name: str, column_name: str) -> str | None:
    try:
        row = conn.execute(f"SELECT MAX({column_name}) FROM {table_name}").fetchone()
    except sqlite3.Error:
        return None
    return row[0] if row and row[0] else None


def sqlite_summary(db_path: Path, repo_root: Path) -> JsonObject:
    expanded = db_path.expanduser()
    summary: JsonObject = {
        "path": safe_display_path(expanded, repo_root),
        "exists": expanded.exists(),
        "sizeBytes": None,
        "schemaReady": False,
        "tables": {},
        "latestObservedAt": None,
        "error": None,
    }
    if not expanded.exists():
        summary["error"] = "metrics database does not exist"
        return summary

    try:
        summary["sizeBytes"] = expanded.stat().st_size
    except OSError as error:
        summary["error"] = f"cannot stat metrics database: {error}"
        return summary

    try:
        with sqlite3.connect(str(expanded)) as conn:
            conn.row_factory = sqlite3.Row
            tables = {
                row["name"]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            }
            counts: dict[str, int | None] = {}
            for table in REQUIRED_TABLES:
                if table not in tables:
                    counts[table] = None
                    continue
                counts[table] = int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            timestamps = [
                db_latest_timestamp(conn, "metric_observations", "observed_at"),
                db_latest_timestamp(conn, "runtime_room_metrics", "observed_at"),
                db_latest_timestamp(conn, "gameplay_behavior_findings", "first_seen_at"),
                db_latest_timestamp(conn, "metric_coverage_gaps", "observed_at"),
                db_latest_timestamp(conn, "rl_dataset_gate_metrics", "observed_at"),
                db_latest_timestamp(conn, "rl_training_execution_metrics", "observed_at"),
                db_latest_timestamp(conn, "rl_policy_advantage_metrics", "observed_at"),
                db_latest_timestamp(conn, "metric_iteration_decisions", "created_at"),
            ]
            valid_timestamps = [timestamp for timestamp in timestamps if timestamp]
            summary["schemaReady"] = all(table in tables for table in REQUIRED_TABLES)
            summary["tables"] = counts
            summary["latestObservedAt"] = max(valid_timestamps) if valid_timestamps else None
    except sqlite3.Error as error:
        summary["error"] = f"cannot read metrics database: {error}"
    return summary


def health_from_db_summary(db: JsonObject) -> JsonObject:
    failures: list[str] = []
    if not db.get("exists"):
        failures.append("metrics database missing")
    if db.get("error"):
        failures.append(str(db["error"]))
    if db.get("exists") and not db.get("schemaReady"):
        failures.append("metrics database schema is incomplete")
    ok = not failures
    return {
        "ok": ok,
        "status": "ok" if ok else "degraded",
        "failures": failures,
    }


def default_ingest_paths(artifact_root: Path) -> list[Path]:
    return [artifact_root / subdir for subdir in DEFAULT_ARTIFACT_SUBDIRS]


def refresh_metrics(db_path: Path, artifact_root: Path, paths: Sequence[Path] | None = None) -> JsonObject:
    ingest_paths = list(paths) if paths is not None and len(paths) > 0 else default_ingest_paths(artifact_root)
    result = metrics_ingestor.ingest_artifacts(db_path, ingest_paths)
    return {"ok": True, "db": str(db_path), "paths": [str(path) for path in ingest_paths], **result}


def refresh_succeeded(refresh: JsonObject) -> bool:
    return refresh.get("ok") is True


def collect_values_by_key(value: Any, key_names: set[str], *, limit: int = 12) -> list[Any]:
    found: list[Any] = []
    for node in iter_json_objects(value):
        for key, raw in node.items():
            if normalized_key(key) in key_names and raw not in (None, "", [], {}):
                found.append(raw)
                if len(found) >= limit:
                    return found
    return found


def latest_scorecard_summary(artifact_root: Path, repo_root: Path) -> JsonObject:
    latest = latest_json_artifact(
        artifact_root / "rl-control-loop" / "scorecards",
        ("*.json",),
    )
    if latest is None:
        return {
            "hasData": False,
            "status": "N/A",
            "runId": "N/A",
            "latestPath": None,
            "updatedAt": None,
            "safetyRegressions": [],
            "requiredActions": [],
            "missingEvidence": ["scorecard artifact missing"],
        }
    path, payload, timestamp = latest
    overall_gate = payload.get("overallGate") if isinstance(payload.get("overallGate"), dict) else {}
    missing_evidence = collect_values_by_key(
        payload,
        {"missingevidence", "missingevidences", "missingrequiredevidence"},
    )
    return {
        "hasData": True,
        "status": overall_gate.get("status") or overall_gate.get("decision") or payload.get("status") or "UNKNOWN",
        "runId": payload.get("runId") or path.stem,
        "candidate": payload.get("candidatePolicyId") or payload.get("candidateId"),
        "baseline": payload.get("baselinePolicyId") or payload.get("baselineId"),
        "latestPath": safe_display_path(path, repo_root),
        "updatedAt": display_timestamp(timestamp),
        "safetyRegressions": overall_gate.get("safetyRegressions") or payload.get("safetyRegressions") or [],
        "requiredActions": payload.get("requiredActions") or [],
        "missingEvidence": missing_evidence,
    }


def tencent_batch_summary(artifact_root: Path, repo_root: Path) -> JsonObject:
    root = artifact_root / "tencent-cloud" / "batch-runs"
    runs: list[JsonObject] = []
    if root.exists():
        for path in sorted(root.glob("*/controller-summary.json")):
            payload = load_json_object(path)
            if payload is None:
                continue
            compute_evidence = static_dashboard.compute_evidence_summary(payload)
            batch_scale = tencent_batch_scale(payload)
            runs.append(
                {
                    "runId": payload.get("runId") or path.parent.name,
                    "finalStatus": payload.get("finalStatus") or "unknown",
                    "partial": payload.get("partial"),
                    "startedAt": payload.get("startedAt"),
                    "finishedAt": payload.get("finishedAt"),
                    "instanceId": payload.get("instanceId"),
                    "workerUser": payload.get("workerUser"),
                    "inputs": payload.get("inputs") if isinstance(payload.get("inputs"), dict) else {},
                    "safety": payload.get("safety") if isinstance(payload.get("safety"), dict) else {},
                    "computeEvidence": compute_evidence,
                    "computeClassification": compute_evidence.get("classification"),
                    "batchScale": batch_scale,
                    "blocker": compute_evidence.get("blocker"),
                    "path": safe_display_path(path, repo_root),
                    "timestamp": display_timestamp(artifact_timestamp(path, payload)),
                }
            )
    latest = max(runs, key=lambda item: item["timestamp"]) if runs else None
    active = [
        run
        for run in runs
        if run.get("partial") is True or str(run.get("finalStatus", "")).lower() in {"unknown", "running"}
    ]
    completed = [run for run in runs if str(run.get("finalStatus", "")).lower() in {"completed", "success", "ok"}]
    compute_confirmed = [run for run in runs if run.get("computeClassification") == "COMPUTE_CONFIRMED"]
    preflight_only = [run for run in runs if run.get("computeClassification") == "PREFLIGHT_ONLY_VALIDATION"]
    return {
        "hasData": bool(runs),
        "runCount": len(runs),
        "activeRunCount": len(active),
        "completedRunCount": len(completed),
        "computeConfirmedRunCount": len(compute_confirmed),
        "preflightOnlyRunCount": len(preflight_only),
        "latest": latest,
    }


def tencent_batch_scale(payload: JsonObject) -> JsonObject:
    for candidate in (
        payload.get("batchScale"),
        static_dashboard.nested_value(payload, ("outputs", "trainingReport", "batchScale")),
    ):
        if isinstance(candidate, dict):
            rows = scale_gates.non_negative_int(candidate.get("environmentRows"))
            ticks = scale_gates.non_negative_int(candidate.get("simulatorTicks"))
            if rows is not None and ticks is not None:
                return scale_gates.build_batch_scale_summary(
                    environment_rows=rows,
                    simulator_ticks=ticks,
                    wall_clock_seconds=candidate.get("wallClockSeconds"),
                    asg_active_seconds=candidate.get("asgActiveSeconds"),
                    cost_estimate=candidate.get("costEstimate"),
                    basis=str(candidate.get("basis") or "controller_summary"),
                )
    inputs = payload.get("inputs") if isinstance(payload.get("inputs"), dict) else {}
    planned = inputs.get("plannedBatchScale")
    if isinstance(planned, dict):
        rows = scale_gates.non_negative_int(planned.get("environmentRows"))
        ticks = scale_gates.non_negative_int(planned.get("simulatorTicks"))
        if rows is not None and ticks is not None:
            return scale_gates.build_batch_scale_summary(
                environment_rows=rows,
                simulator_ticks=ticks,
                basis="planned_inputs",
            )
    workers = (
        scale_gates.non_negative_int(inputs.get("scaleEnvironments"))
        or scale_gates.non_negative_int(inputs.get("workers"))
        or 0
    )
    repetitions = scale_gates.non_negative_int(inputs.get("repetitions")) or 1
    ticks_per_row = scale_gates.non_negative_int(inputs.get("ticks")) or 0
    environment_rows = workers * repetitions
    return scale_gates.build_batch_scale_summary(
        environment_rows=environment_rows,
        simulator_ticks=environment_rows * ticks_per_row,
        basis="legacy_inputs",
    )


def safety_summary(dashboard: JsonObject, tencent: JsonObject, scorecard: JsonObject) -> JsonObject:
    card_supply = dashboard.get("cardSupply") if isinstance(dashboard.get("cardSupply"), dict) else {}
    latest_tencent = tencent.get("latest") if isinstance(tencent.get("latest"), dict) else {}
    tencent_safety = latest_tencent.get("safety") if isinstance(latest_tencent.get("safety"), dict) else {}
    unsafe_flags: list[JsonObject] = []
    if not latest_tencent:
        unsafe_flags.append({"source": "tencent", "field": "controllerSummary", "value": "missing"})
    else:
        for field in REQUIRED_TENCENT_SAFETY_FIELDS:
            if field not in tencent_safety:
                unsafe_flags.append({"source": "tencent", "field": field, "value": "missing"})
                continue
            value = tencent_safety[field]
            if value is not False:
                unsafe_flags.append({"source": "tencent", "field": field, "value": value})
        for field in REQUIRED_TENCENT_SHADOW_SAFETY_FIELDS:
            if field not in tencent_safety:
                unsafe_flags.append({"source": "tencent", "field": field, "value": "missing"})
                continue
            value = tencent_safety[field]
            if value is not True:
                unsafe_flags.append({"source": "tencent", "field": field, "value": value})
    if not scorecard.get("hasData"):
        unsafe_flags.append({"source": "scorecard", "field": "summary", "value": "missing"})
    else:
        for regression in scorecard.get("safetyRegressions", []):
            unsafe_flags.append({"source": "scorecard", "field": "safetyRegression", "value": regression})
    return {
        "status": "OK" if not unsafe_flags else "BLOCKED",
        "unsafeFlags": unsafe_flags,
        "tencent": tencent_safety,
        "cardSupplyStatus": card_supply.get("status"),
        "cardSupplySeverity": card_supply.get("severity"),
        "fallbackStatus": card_supply.get("fallbackStatus"),
        "conservativeActionsOnly": tencent_safety.get("conservative_actions_only"),
        "oodRejection": tencent_safety.get("ood_rejection"),
    }


def scan_artifact_json(artifact_root: Path) -> list[tuple[Path, JsonObject, datetime]]:
    artifacts: list[tuple[Path, JsonObject, datetime]] = []
    roots = (
        artifact_root / "rl-control-loop",
        artifact_root / "rl-training",
        artifact_root / "tencent-cloud" / "batch-runs",
    )
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("*.json"):
            if not path.is_file():
                continue
            payload = load_json_object(path)
            if payload is None:
                continue
            artifacts.append((path, payload, artifact_timestamp(path, payload)))
    return sorted(artifacts, key=lambda item: item[2], reverse=True)


def runtime_candidate_injection_summary(artifact_root: Path, repo_root: Path) -> JsonObject:
    explicit_false: list[JsonObject] = []
    metadata_only: list[JsonObject] = []
    for path, payload, timestamp in scan_artifact_json(artifact_root):
        for node in iter_json_objects(payload):
            for key, value in node.items():
                normalized = normalized_key(key)
                if normalized in RUNTIME_INJECTION_TRUE_KEYS and value is True:
                    return {
                        "status": "OK",
                        "evidence": f"{key}=true",
                        "latestPath": safe_display_path(path, repo_root),
                        "updatedAt": display_timestamp(timestamp),
                    }
                if normalized in RUNTIME_INJECTION_TRUE_KEYS and value is False:
                    explicit_false.append(
                        {
                            "field": key,
                            "value": value,
                            "path": safe_display_path(path, repo_root),
                            "updatedAt": display_timestamp(timestamp),
                        }
                    )
                if normalized in RUNTIME_INJECTION_SCOPE_KEYS:
                    scope = text_value(value)
                    if scope is not None and normalized_key(scope) in RUNTIME_INJECTION_METADATA_ONLY_VALUES:
                        metadata_only.append(
                            {
                                "field": key,
                                "value": value,
                                "path": safe_display_path(path, repo_root),
                                "updatedAt": display_timestamp(timestamp),
                            }
                        )
    if explicit_false or metadata_only:
        evidence = explicit_false[0] if explicit_false else metadata_only[0]
        return {
            "status": "BLOCKED",
            "evidence": f"{evidence['field']}={evidence['value']}",
            "latestPath": evidence["path"],
            "updatedAt": evidence["updatedAt"],
        }
    return {
        "status": "N/A",
        "evidence": "no runtime candidate injection evidence found",
        "latestPath": None,
        "updatedAt": None,
    }


def zero_iteration_policy_update_summary(artifact_root: Path, repo_root: Path) -> JsonObject:
    for path, payload, timestamp in scan_artifact_json(artifact_root):
        for node in iter_json_objects(payload):
            iterations = node.get("policyUpdateIterations")
            policy_update = node.get("policyUpdate")
            if iterations is None and not isinstance(policy_update, dict):
                continue
            if iterations == 0:
                if not isinstance(policy_update, dict):
                    return {
                        "status": "OK",
                        "evidence": "zero policy updates with no update artifact",
                        "latestPath": safe_display_path(path, repo_root),
                        "updatedAt": display_timestamp(timestamp),
                    }
                skipped = text_value(policy_update.get("skippedReason"))
                if skipped and not node.get("policyUpdateArtifactPath"):
                    return {
                        "status": "OK",
                        "evidence": f"safe zero-iteration no-op: {skipped}",
                        "latestPath": safe_display_path(path, repo_root),
                        "updatedAt": display_timestamp(timestamp),
                    }
                return {
                    "status": "BLOCKED",
                    "evidence": "zero-iteration policy update lacks safe skippedReason or has update artifact",
                    "latestPath": safe_display_path(path, repo_root),
                    "updatedAt": display_timestamp(timestamp),
                }
            if isinstance(iterations, (int, float)) and iterations > 0:
                return {
                    "status": "N/A",
                    "evidence": f"latest policy update had {iterations} iteration(s)",
                    "latestPath": safe_display_path(path, repo_root),
                    "updatedAt": display_timestamp(timestamp),
                }
    return {
        "status": "N/A",
        "evidence": "no policy update evidence found",
        "latestPath": None,
        "updatedAt": None,
    }


def policy_status_is_online_proven(status: Any) -> bool:
    return str(status or "").upper() in {"PROVEN", "VALIDATED", "PROMOTABLE", "ADVANTAGE", "ROLLOUT_APPROVED"}


def flywheel_stage_summary(
    *,
    db: JsonObject,
    dashboard: JsonObject,
    scorecard: JsonObject,
    safety: JsonObject,
) -> list[JsonObject]:
    training = as_dict(dashboard.get("training"))
    policy = as_dict(dashboard.get("policy"))
    iteration_count = as_dict(db.get("tables")).get("metric_iteration_decisions")
    stages = [
        {
            "stage": "construction-landed",
            "status": "OK" if db.get("schemaReady") else "BLOCKED",
            "evidence": "live dashboard service and SQLite schema are available"
            if db.get("schemaReady")
            else "SQLite schema is not ready",
        },
        {
            "stage": "training-running",
            "status": "OK" if training.get("hasComputeEvidence") else "BLOCKED",
            "evidence": as_dict(training.get("computeEvidence")).get("classification") or training.get("blocker") or "N/A",
        },
        {
            "stage": "online-proven",
            "status": "OK" if policy_status_is_online_proven(policy.get("status")) else "BLOCKED",
            "evidence": f"onlineUtilityStatus={policy.get('status') or 'N/A'}",
        },
        {
            "stage": "self-iterating",
            "status": "OK"
            if isinstance(iteration_count, int)
            and iteration_count > 0
            and scorecard.get("hasData")
            and safety.get("status") == "OK"
            else "BLOCKED",
            "evidence": (
                f"iteration decisions={iteration_count}; scorecard={scorecard.get('status')}; safety={safety.get('status')}"
            ),
        },
    ]
    return stages


def latest_batch_scale(tencent: JsonObject) -> JsonObject:
    latest = as_dict(tencent.get("latest"))
    return as_dict(latest.get("batchScale"))


def project_gate_summary(
    *,
    flywheel_stages: Sequence[JsonObject],
    tencent: JsonObject,
    injection: JsonObject,
    zero_iteration: JsonObject,
    refresh: JsonObject,
) -> list[JsonObject]:
    stage_statuses = {stage.get("stage"): stage.get("status") for stage in flywheel_stages}
    scale = latest_batch_scale(tencent)
    auto_refresh_ok = refresh.get("mode") == "auto" and refresh.get("autoRefreshSeconds")
    refresh_cadence = (
        f"{refresh.get('autoRefreshSeconds')}s"
        if refresh.get("autoRefreshSeconds")
        else "off"
    )
    all_stages_ok = all(status == "OK" for status in stage_statuses.values())
    return [
        {
            "issue": "#879",
            "gate": "recurring RL flywheel",
            "status": "OK" if all_stages_ok else "BLOCKED",
            "evidence": ", ".join(f"{key}={value}" for key, value in stage_statuses.items()),
            "nextAction": "clear blocked flywheel stages" if not all_stages_ok else "keep evidence fresh",
        },
        {
            "issue": "#1032",
            "gate": "scale-first training",
            "status": "OK" if scale.get("scaleFirstEligible") is True else "BLOCKED",
            "evidence": (
                f"batchClass={scale.get('batchClass', 'N/A')}; rows={scale.get('environmentRows', 'N/A')}; "
                f"ticks={scale.get('simulatorTicks', 'N/A')}"
            ),
            "nextAction": "run validation-or-larger batch" if scale.get("scaleFirstEligible") is not True else "score candidate",
        },
        {
            "issue": "#1229",
            "gate": "runtime candidate injection",
            "status": injection.get("status"),
            "evidence": injection.get("evidence"),
            "nextAction": "prove candidate params affect simulator/runtime behavior"
            if injection.get("status") != "OK"
            else "use injected candidate in scorecard",
        },
        {
            "issue": "#1233",
            "gate": "autonomous compute cadence",
            "status": "OK" if auto_refresh_ok and tencent.get("hasData") else "BLOCKED",
            "evidence": f"autoRefresh={refresh_cadence}; tencentRuns={tencent.get('runCount', 0)}",
            "nextAction": "keep dashboard auto-refresh and compute evidence alive"
            if auto_refresh_ok and tencent.get("hasData")
            else "restore recurring refresh/compute evidence",
        },
        {
            "issue": "#1234",
            "gate": "zero-iteration no-op policy update",
            "status": zero_iteration.get("status"),
            "evidence": zero_iteration.get("evidence"),
            "nextAction": "preserve safe no-op semantics"
            if zero_iteration.get("status") == "OK"
            else "verify latest zero-iteration policyUpdate evidence",
        },
    ]


def build_live_summary(
    repo_root: Path,
    artifact_root: Path,
    db_path: Path,
    *,
    generated_at: str | None = None,
    dashboard_url: str | None = None,
    refresh: JsonObject | None = None,
) -> JsonObject:
    generated = generated_at or utc_now_iso()
    refresh_summary: JsonObject = refresh or {
        "mode": "manual",
        "autoRefreshSeconds": None,
        "lastRefreshAt": None,
        "lastRefreshOk": None,
        "lastRefresh": None,
        "nextRefreshAt": None,
    }
    db = sqlite_summary(db_path, repo_root)
    health = health_from_db_summary(db)
    raw_dashboard = static_dashboard.build_dashboard(repo_root=repo_root, artifact_root=artifact_root, generated_at=generated)
    dashboard = dashboard_json_safe(raw_dashboard, repo_root)
    scorecard = latest_scorecard_summary(artifact_root, repo_root)
    tencent = tencent_batch_summary(artifact_root, repo_root)
    safety = safety_summary(dashboard, tencent, scorecard)
    injection = runtime_candidate_injection_summary(artifact_root, repo_root)
    zero_iteration = zero_iteration_policy_update_summary(artifact_root, repo_root)
    flywheel_stages = flywheel_stage_summary(db=db, dashboard=dashboard, scorecard=scorecard, safety=safety)
    project_gates = project_gate_summary(
        flywheel_stages=flywheel_stages,
        tencent=tencent,
        injection=injection,
        zero_iteration=zero_iteration,
        refresh=refresh_summary,
    )
    loop_a = {
        "environment": dashboard.get("simulator", {}),
        "training": dashboard.get("training", {}),
    }
    loop_b = {
        "onlineUtilityStatus": dashboard.get("policy", {}).get("status"),
        "policy": dashboard.get("policy", {}),
        "scorecard": scorecard,
    }
    return {
        "type": "screeps-rl-live-dashboard",
        "generatedAt": generated,
        "repoRoot": safe_display_path(repo_root, repo_root),
        "artifactRoot": safe_display_path(artifact_root, repo_root),
        "dashboardUrl": dashboard_url or format_dashboard_url(DEFAULT_HOST, DEFAULT_PORT),
        "health": health,
        "db": db,
        "refresh": refresh_summary,
        "flywheelStages": flywheel_stages,
        "projectGates": project_gates,
        "runtimeCandidateInjection": injection,
        "zeroIterationPolicyUpdate": zero_iteration,
        "lanes": dashboard.get("lanes", []),
        "e1Gate": dashboard.get("gate"),
        "loopA": loop_a,
        "loopB": loop_b,
        "tencentBatch": tencent,
        "safety": safety,
        "warnings": dashboard.get("warnings", []),
    }


def h(value: Any) -> str:
    return html.escape(str(value), quote=True)


def format_value(value: Any) -> str:
    if value is None:
        return "N/A"
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


def percent_value(value: Any) -> str:
    if isinstance(value, (int, float)):
        return f"{value * 100:.1f}%"
    return "N/A"


def status_class(status: Any) -> str:
    text = str(status or "unknown").lower()
    if text in {"ok", "pass", "passed", "proven", "validated", "promotable", "completed", "success"}:
        return "ok"
    if text in {"degraded", "unknown", "unproven", "inconclusive", "n/a"}:
        return "warn"
    return "bad"


def render_status(status: Any) -> str:
    return f'<span class="status {status_class(status)}">{h(status or "N/A")}</span>'


def table(headers: Sequence[str], rows: Sequence[Sequence[Any]], empty_label: str = "No data") -> str:
    header_html = "".join(f"<th>{h(header)}</th>" for header in headers)
    if not rows:
        body = f'<tr><td colspan="{len(headers)}" class="muted">{h(empty_label)}</td></tr>'
    else:
        body = "\n".join(
            "<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>"
            for row in rows
        )
    return f"<table><thead><tr>{header_html}</tr></thead><tbody>{body}</tbody></table>"


def render_live_html(summary: JsonObject, config: LiveDashboardConfig) -> str:
    e1 = summary.get("e1Gate") if isinstance(summary.get("e1Gate"), dict) else {}
    loop_a = summary.get("loopA") if isinstance(summary.get("loopA"), dict) else {}
    environment = loop_a.get("environment") if isinstance(loop_a.get("environment"), dict) else {}
    training = loop_a.get("training") if isinstance(loop_a.get("training"), dict) else {}
    loop_b = summary.get("loopB") if isinstance(summary.get("loopB"), dict) else {}
    scorecard = loop_b.get("scorecard") if isinstance(loop_b.get("scorecard"), dict) else {}
    tencent = summary.get("tencentBatch") if isinstance(summary.get("tencentBatch"), dict) else {}
    latest_tencent = tencent.get("latest") if isinstance(tencent.get("latest"), dict) else {}
    latest_batch_scale = latest_tencent.get("batchScale") if isinstance(latest_tencent.get("batchScale"), dict) else {}
    safety = summary.get("safety") if isinstance(summary.get("safety"), dict) else {}
    db = summary.get("db") if isinstance(summary.get("db"), dict) else {}
    refresh = summary.get("refresh") if isinstance(summary.get("refresh"), dict) else {}
    flywheel_stages = [row for row in summary.get("flywheelStages", []) if isinstance(row, dict)]
    project_gates = [row for row in summary.get("projectGates", []) if isinstance(row, dict)]
    policy = loop_b.get("policy") if isinstance(loop_b.get("policy"), dict) else {}
    policy_metrics = [row for row in policy.get("metrics", []) if isinstance(row, dict)]

    lane_rows = [
        (
            h(row.get("lane")),
            h(row.get("name")),
            render_status(row.get("status")),
            h(row.get("latestArtifact") or "N/A"),
            h(row.get("blocker") or "N/A"),
        )
        for row in summary.get("lanes", [])
        if isinstance(row, dict)
    ]
    db_rows = [
        ("Path", h(db.get("path"))),
        ("Exists", render_status("OK" if db.get("exists") else "missing")),
        ("Schema", render_status("OK" if db.get("schemaReady") else "incomplete")),
        ("Size bytes", h(format_value(db.get("sizeBytes")))),
        ("Latest observation", h(display_timestamp(db.get("latestObservedAt")))),
        ("Observation age", h(age_label(db.get("latestObservedAt"), now=summary.get("generatedAt")))),
        ("Last refresh", h(display_timestamp(refresh.get("lastRefreshAt")))),
        ("Refresh mode", h(refresh.get("mode") or "manual")),
        ("Auto refresh seconds", h(format_value(refresh.get("autoRefreshSeconds")))),
        ("Next refresh", h(display_timestamp(refresh.get("nextRefreshAt")))),
    ]
    db_table_rows = [
        (h(table_name), h("missing" if count is None else count))
        for table_name, count in as_dict(db.get("tables")).items()
    ]
    e1_rows = [
        ("Status", render_status(e1.get("status"))),
        ("Latest gate", h(display_timestamp(e1.get("timestamp")))),
        ("Gate age", h(age_label(e1.get("timestamp"), now=summary.get("generatedAt")))),
        ("Acceptance", h(percent_value(e1.get("acceptanceRate")))),
        ("Sample count", h(format_value(e1.get("sampleCount")))),
        ("Accepted", h(format_value(e1.get("samplesAccepted")))),
        ("Rejected", h(format_value(e1.get("samplesRejected")))),
        ("Rejection reasons", h(compact_sequence(e1.get("rejectionReasons")))),
        ("Source", h(e1.get("displayPath") or "N/A")),
    ]
    loop_a_rows = [
        ("Environments succeeded", h(format_value(environment.get("succeeded")))),
        ("Environments failed", h(format_value(environment.get("failed")))),
        ("Ticks run", h(format_value(environment.get("ticksRun")))),
        ("Training status", render_status(training.get("status"))),
        ("Episodes", h(format_value(training.get("episodes")))),
        ("Policy updates", h(format_value(training.get("policyUpdates")))),
        ("Compute evidence", h(as_dict(training.get("computeEvidence")).get("classification") or "N/A")),
        ("Batch class", h(latest_batch_scale.get("batchClass") or "N/A")),
        ("Anomalies", h(compact_sequence(environment.get("failureModes")))),
        ("Blocker", h(training.get("blocker") or "N/A")),
    ]
    loop_b_rows = [
        ("Online utility", render_status(loop_b.get("onlineUtilityStatus"))),
        ("Candidate", h(policy.get("candidate") or "N/A")),
        ("Baseline", h(policy.get("baseline") or "N/A")),
        ("Advantages", h(compact_sequence([row for row in policy_metrics if str(row.get("status", "")).upper() in {"ADVANTAGE", "IMPROVED"}]))),
        ("Regressions", h(compact_sequence([row for row in policy_metrics if str(row.get("status", "")).upper() in {"REGRESSED", "REGRESSION"}]))),
        ("Scorecard", render_status(scorecard.get("status"))),
        ("Scorecard run", h(scorecard.get("runId") or "N/A")),
        ("Safety regressions", h(compact_sequence(scorecard.get("safetyRegressions")))),
    ]
    tencent_rows = [
        ("Runs", h(format_value(tencent.get("runCount")))),
        ("Active runs", h(format_value(tencent.get("activeRunCount")))),
        ("Completed runs", h(format_value(tencent.get("completedRunCount")))),
        ("Compute-confirmed runs", h(format_value(tencent.get("computeConfirmedRunCount")))),
        ("Preflight-only validations", h(format_value(tencent.get("preflightOnlyRunCount")))),
        ("Latest run", h(latest_tencent.get("runId") or "N/A")),
        ("Latest status", render_status(latest_tencent.get("finalStatus"))),
        ("Latest compute evidence", h(latest_tencent.get("computeClassification") or "N/A")),
        ("Latest batch class", h(latest_batch_scale.get("batchClass") or "N/A")),
        ("Latest env rows", h(latest_batch_scale.get("environmentRows", "N/A"))),
        ("Latest simulator ticks", h(latest_batch_scale.get("simulatorTicks", "N/A"))),
        ("Scale-first eligible", h(latest_batch_scale.get("scaleFirstEligible", "N/A"))),
        ("Wall clock seconds", h(format_value(latest_batch_scale.get("wallClockSeconds")))),
        ("ASG active seconds", h(format_value(latest_batch_scale.get("asgActiveSeconds")))),
        ("Utilization ratio", h(format_value(latest_batch_scale.get("utilizationRatio")))),
        ("Cost estimate", h(compact_value(latest_batch_scale.get("costEstimate")))),
        ("Scale down attempted", h(latest_tencent.get("safety", {}).get("scaleDownAttempted") if isinstance(latest_tencent.get("safety"), dict) else "N/A")),
    ]
    safety_rows = [
        ("Status", render_status(safety.get("status"))),
        ("liveEffect", h(safety.get("tencent", {}).get("liveEffect") if isinstance(safety.get("tencent"), dict) else "N/A")),
        ("officialMmoWrites", h(safety.get("tencent", {}).get("officialMmoWrites") if isinstance(safety.get("tencent"), dict) else "N/A")),
        (
            "officialMmoWritesAllowed",
            h(safety.get("tencent", {}).get("officialMmoWritesAllowed") if isinstance(safety.get("tencent"), dict) else "N/A"),
        ),
        ("conservative_actions_only", h(safety.get("conservativeActionsOnly", "N/A"))),
        ("ood_rejection", h(safety.get("oodRejection", "N/A"))),
        ("Card supply", h(safety.get("cardSupplyStatus") or "N/A")),
        ("Unsafe flags", h(len(safety.get("unsafeFlags", [])))),
    ]
    scorecard_rows = [
        ("Status", render_status(scorecard.get("status"))),
        ("Run", h(scorecard.get("runId") or "N/A")),
        ("Candidate", h(scorecard.get("candidate") or "N/A")),
        ("Baseline", h(scorecard.get("baseline") or "N/A")),
        ("Updated", h(display_timestamp(scorecard.get("updatedAt")))),
        ("Missing evidence", h(compact_sequence(scorecard.get("missingEvidence")))),
        ("Required actions", h(compact_sequence(scorecard.get("requiredActions")))),
        ("Source", h(scorecard.get("latestPath") or "N/A")),
    ]
    stage_rows = [
        (h(row.get("stage")), render_status(row.get("status")), h(row.get("evidence") or "N/A"))
        for row in flywheel_stages
    ]
    project_gate_rows = [
        (
            h(row.get("issue")),
            h(row.get("gate")),
            render_status(row.get("status")),
            h(row.get("evidence") or "N/A"),
            h(row.get("nextAction") or "N/A"),
        )
        for row in project_gates
    ]

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="{h(config.refresh_seconds)}">
  <title>Screeps RL Live Dashboard</title>
  <style>
    :root {{
      color-scheme: dark;
      --bg: #0b1014;
      --panel: #111920;
      --panel-2: #0f151b;
      --text: #dbe5ee;
      --muted: #90a0ad;
      --border: #253440;
      --ok: #49c185;
      --warn: #e5b84c;
      --bad: #ff6a6a;
      --accent: #8ab4f8;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.45;
    }}
    main {{
      width: min(1500px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 18px 0 32px;
    }}
    header {{
      display: grid;
      gap: 8px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 14px;
    }}
    h1, h2 {{
      margin: 0;
      letter-spacing: 0;
    }}
    h1 {{ font-size: 22px; }}
    h2 {{ font-size: 15px; margin-bottom: 10px; }}
    .meta, .muted {{ color: var(--muted); margin: 0 0 10px; }}
    .grid {{ display: grid; gap: 12px; margin-bottom: 12px; }}
    .two {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }}
    .three {{ grid-template-columns: repeat(3, minmax(0, 1fr)); }}
    .panel {{
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      overflow: hidden;
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      background: var(--panel-2);
      border: 1px solid var(--border);
    }}
    th, td {{
      border-bottom: 1px solid var(--border);
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
    }}
    th {{
      color: #b8c7d6;
      background: #16212b;
    }}
    tr:last-child td {{ border-bottom: 0; }}
    .status {{
      display: inline-block;
      min-width: 70px;
      border-radius: 4px;
      padding: 2px 6px;
      color: #091015;
      text-align: center;
      font-weight: 700;
    }}
    .ok {{ background: var(--ok); }}
    .warn {{ background: var(--warn); }}
    .bad {{ background: var(--bad); }}
    code {{ color: var(--accent); }}
    @media (max-width: 900px) {{
      main {{ width: calc(100vw - 20px); }}
      .two, .three {{ grid-template-columns: 1fr; }}
      body {{ font-size: 12px; }}
    }}
  </style>
</head>
<body>
<main>
  <header>
    <h1>Screeps RL Live Dashboard</h1>
    <p class="meta">Generated {h(summary.get("generatedAt"))}. Auto-refreshes every {h(config.refresh_seconds)}s. JSON: <code>/api/summary</code>. Health: <code>/healthz</code>.</p>
    <p class="meta">DB {h(db.get("path"))}; artifacts {h(summary.get("artifactRoot"))}.</p>
  </header>

  <section class="panel grid">
    <h2>Lane Status</h2>
    {table(("Lane", "Name", "Status", "Latest artifact", "Blocker"), lane_rows)}
  </section>

  <div class="grid two">
    <section class="panel"><h2>#879 Flywheel Stage Proof</h2>{table(("Stage", "Status", "Evidence"), stage_rows)}</section>
    <section class="panel"><h2>Project Gate Status</h2>{table(("Issue", "Gate", "Status", "Evidence", "Next action"), project_gate_rows)}</section>
  </div>

  <div class="grid two">
    <section class="panel"><h2>Metrics Store</h2>{table(("Item", "Value"), db_rows)}</section>
    <section class="panel"><h2>E1 Gate Acceptance</h2>{table(("Item", "Value"), e1_rows)}</section>
  </div>

  <section class="panel grid">
    <h2>SQLite Table Counts</h2>
    {table(("Table", "Rows"), db_table_rows)}
  </section>

  <div class="grid two">
    <section class="panel"><h2>Loop A Env Ticks Episodes</h2>{table(("Item", "Value"), loop_a_rows)}</section>
    <section class="panel"><h2>Loop B Utility Scorecard</h2>{table(("Item", "Value"), loop_b_rows)}</section>
  </div>

  <div class="grid two">
    <section class="panel"><h2>Tencent Batch Utilization</h2>{table(("Item", "Value"), tencent_rows)}</section>
    <section class="panel"><h2>Safety Flags</h2>{table(("Item", "Value"), safety_rows)}</section>
  </div>

  <section class="panel grid">
    <h2>#924 Scorecard Status</h2>
    {table(("Item", "Value"), scorecard_rows)}
  </section>
</main>
</body>
</html>
"""


class LiveDashboardRequestHandler(BaseHTTPRequestHandler):
    server: LiveDashboardHTTPServer

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in ("", "/"):
            self.write_html(HTTPStatus.OK, render_live_html(self.summary(), self.server.config))
            return
        if parsed.path == "/api/summary":
            self.write_json(HTTPStatus.OK, self.summary())
            return
        if parsed.path == "/healthz":
            summary = self.summary()
            status = HTTPStatus.OK if summary["health"]["ok"] else HTTPStatus.SERVICE_UNAVAILABLE
            self.write_json(
                status,
                summary["health"]
                | {
                    "message": "OK" if summary["health"]["ok"] else "DEGRADED",
                    "db": summary["db"],
                    "refresh": summary["refresh"],
                    "generatedAt": summary["generatedAt"],
                },
            )
            return
        self.write_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/refresh":
            self.write_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        if not self.server.config.enable_refresh_endpoint:
            self.write_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "refresh endpoint disabled"})
            return
        with self.server.refresh_lock:
            try:
                refresh = refresh_metrics(self.server.config.db_path, self.server.config.artifact_root)
            except Exception as error:  # pragma: no cover - defensive handler boundary
                self.write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(error)})
                return
        if not refresh_succeeded(refresh):
            self.write_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": "refresh failed", "refresh": refresh, "summary": self.summary()},
            )
            return
        self.write_json(HTTPStatus.OK, {"ok": True, "refresh": refresh, "summary": self.summary()})

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

    def summary(self) -> JsonObject:
        config = self.server.config
        host, port = self.server.server_address[:2]
        return build_live_summary(
            config.repo_root,
            config.artifact_root,
            config.db_path,
            dashboard_url=format_dashboard_url(str(host), int(port)),
            refresh=self.server.refresh_snapshot(),
        )

    def write_json(self, status: HTTPStatus, payload: JsonObject) -> None:
        body = (json.dumps(payload, sort_keys=True, ensure_ascii=True) + "\n").encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def write_html(self, status: HTTPStatus, body_text: str) -> None:
        body = body_text.encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def make_server(host: str, port: int, config: LiveDashboardConfig) -> LiveDashboardHTTPServer:
    return LiveDashboardHTTPServer((host, port), LiveDashboardRequestHandler, config)


def build_config(args: argparse.Namespace) -> LiveDashboardConfig:
    repo_root = args.repo_root.expanduser().resolve()
    artifact_root = resolve_path(args.artifact_root, repo_root).resolve()
    db_path = resolve_path(args.db, repo_root)
    return LiveDashboardConfig(
        repo_root=repo_root,
        artifact_root=artifact_root,
        db_path=db_path,
        refresh_seconds=args.refresh_seconds,
        enable_refresh_endpoint=bool(getattr(args, "enable_refresh_endpoint", False)),
        auto_refresh_seconds=max(0, int(getattr(args, "auto_refresh_seconds", 0) or 0)),
    )


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--repo-root", type=Path, default=repo_root_from_script(), help="Repository root.")
    parser.add_argument(
        "--artifact-root",
        type=Path,
        default=Path("runtime-artifacts"),
        help="Runtime artifact root. Defaults to <repo>/runtime-artifacts.",
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=metrics_ingestor.DEFAULT_DB_PATH,
        help="RL metrics SQLite path.",
    )
    parser.add_argument(
        "--refresh-seconds",
        type=int,
        default=DEFAULT_REFRESH_SECONDS,
        help="HTML meta-refresh interval in seconds.",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Serve or inspect the local Screeps RL live dashboard.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve = subparsers.add_parser("serve", help="serve the live dashboard over HTTP")
    add_common_args(serve)
    serve.add_argument("--host", default=DEFAULT_HOST, help="Bind host.")
    serve.add_argument("--port", type=int, default=DEFAULT_PORT, help="Bind port.")
    serve.add_argument("--refresh-on-start", action="store_true", help="Run the metrics ingestor before serving.")
    serve.add_argument(
        "--auto-refresh-seconds",
        type=int,
        default=0,
        help=(
            "Refresh the SQLite metrics store in the background while serving. "
            f"Use {DEFAULT_AUTO_REFRESH_SECONDS} for the standard owner-facing local surface."
        ),
    )
    serve.add_argument(
        "--enable-refresh-endpoint",
        action="store_true",
        help="Enable POST /refresh. Disabled by default because it mutates the local SQLite metrics store.",
    )

    refresh = subparsers.add_parser("refresh", help="refresh the SQLite metrics database with the ingestor")
    add_common_args(refresh)
    refresh.add_argument("paths", nargs="*", type=Path, help="Optional artifact files/directories to ingest.")

    summary = subparsers.add_parser("summary", help="print the live dashboard summary JSON")
    add_common_args(summary)

    health = subparsers.add_parser("healthcheck", help="check a running dashboard /healthz endpoint")
    health.add_argument("--url", default=DEFAULT_HEALTHCHECK_URL, help="Health URL.")
    health.add_argument("--timeout", type=float, default=5.0, help="HTTP timeout seconds.")
    return parser


def run_healthcheck(url: str, timeout: float) -> int:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
            ok = bool(payload.get("ok"))
            if ok and "message" not in payload:
                payload["message"] = "OK"
            print(json.dumps(payload, sort_keys=True))
            return 0 if ok else 1
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        print(body.strip() or json.dumps({"ok": False, "status": error.code}))
        return 1
    except (OSError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True))
        return 1


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "healthcheck":
        return run_healthcheck(args.url, args.timeout)

    config = build_config(args)
    if args.command == "refresh":
        paths = [resolve_path(path, config.repo_root) for path in args.paths]
        result = refresh_metrics(config.db_path, config.artifact_root, paths)
        print(json.dumps(result, sort_keys=True))
        return 0 if refresh_succeeded(result) else 1
    if args.command == "summary":
        print(json.dumps(build_live_summary(config.repo_root, config.artifact_root, config.db_path), sort_keys=True))
        return 0
    if args.command == "serve":
        initial_refresh: JsonObject | None = None
        if args.refresh_on_start:
            refresh = refresh_metrics(config.db_path, config.artifact_root)
            if not refresh_succeeded(refresh):
                print(
                    json.dumps({"ok": False, "error": "refresh-on-start failed", "refresh": refresh}, sort_keys=True),
                    file=sys.stderr,
                )
                return 1
            initial_refresh = refresh
        server = make_server(args.host, args.port, config)
        if initial_refresh is not None:
            server.record_refresh(initial_refresh)
        host, port = server.server_address
        print(f"Serving Screeps RL live dashboard at {format_dashboard_url(str(host), int(port))}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("Stopping Screeps RL live dashboard.")
        finally:
            server.server_close()
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
