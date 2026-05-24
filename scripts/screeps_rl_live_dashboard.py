#!/usr/bin/env python3
"""Serve a local live RL dashboard backed by the RL metrics SQLite store."""

from __future__ import annotations

import argparse
import html
import json
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence
from urllib.parse import urlparse

import screeps_rl_dashboard as static_dashboard
import screeps_rl_metrics_ingestor as metrics_ingestor
import screeps_rl_scale_gates as scale_gates


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_REFRESH_SECONDS = 60
DEFAULT_AUTO_REFRESH_SECONDS = 300
DEFAULT_DASHBOARD_URL = f"http://{DEFAULT_HOST}:{DEFAULT_PORT}/"
DEFAULT_HEALTHCHECK_URL = f"http://{DEFAULT_HOST}:{DEFAULT_PORT}/healthz"
DEFAULT_SUMMARY_CACHE_SECONDS = DEFAULT_AUTO_REFRESH_SECONDS
DEFAULT_SUMMARY_SCAN_FILE_LIMIT = 25
DEFAULT_INGEST_FILE_LIMIT_PER_ROOT = 250
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
SUMMARY_STATUS_PRIORITY = {"BLOCKED": 2, "OK": 1, "N/A": 0}
TENCENT_ACTIVE_FINAL_STATUS_KEYS = {"", "unknown", "running", "inprogress"}
TENCENT_TERMINAL_FINAL_STATUS_KEYS = {
    "completed",
    "completedscaledownfailed",
    "failed",
    "ok",
    "preflightok",
    "success",
}
TENCENT_TIMEOUT_TOTAL_KEYS = (
    "totalSeconds",
    "totalTimeoutSeconds",
    "runTimeoutSeconds",
    "timeoutSeconds",
    "total",
)
TENCENT_TIMEOUT_COMPONENT_KEY_GROUPS = (
    ("scaleTimeoutSeconds", "scale_timeout_seconds", "scale-timeout-seconds", "scale"),
    ("scaleDownTimeoutSeconds", "scale_down_timeout_seconds", "scale-down-timeout-seconds", "scaleDown"),
    ("bootstrapTimeoutSeconds", "bootstrap_timeout_seconds", "bootstrap-timeout-seconds", "bootstrap"),
    ("trainingTimeoutSeconds", "training_timeout_seconds", "training-timeout-seconds", "training"),
    ("transferTimeoutSeconds", "transfer_timeout_seconds", "transfer-timeout-seconds", "transfer"),
)
TRUSTED_POLICY_UPDATE_REPORT_TYPES = {
    "screeps-rl-training-report",
    "screeps-rl-training-generation",
    "screeps-rl-training-execution-report",
}
HOST_KEY_SELF_HEAL_SUCCESS_STATUSES = {
    "accepted_new_known_host",
    "already_prepared",
    "existing_known_host",
    "existing_known_host_keyscan_unavailable",
    "host_key_scanned",
    "new_known_host",
    "rotated_known_host",
    "skipped_no_public_ip",
}
HOST_KEY_SELF_HEAL_RETRY_STATUSES = {
    "host_key_accept_new_unavailable",
    "host_key_scan_unavailable",
}
HOST_KEY_SELF_HEAL_FAILURE_STATUSES = {"host_key_self_healing_failed"}
HOST_KEY_SELF_HEAL_STEP_NAMES = {
    "accept_new_worker_known_host",
    "clear_worker_known_host",
    "install_worker_known_host",
    "prepare_worker_known_host",
    "scan_worker_host_key",
}
SUMMARY_ARTIFACT_SOURCE_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "rl-control-loop",
        (
            "*.json",
            "scorecards/*.json",
            "gate-data/*.json",
            "gate-data/*/*.json",
            "*/gate_summary.json",
            "*/gate_report.json",
        ),
    ),
    (
        "rl-training",
        (
            "*.json",
            "policy-candidates/*.json",
            "*/experiment_card.json",
            "*/training-report*.json",
        ),
    ),
    (
        "tencent-cloud/batch-runs",
        (
            "*/controller-summary.json",
            "*/experiment_card.json",
            "*/remote/runtime-artifacts/rl-control-loop/*.json",
            "*/remote/runtime-artifacts/rl-training/*.json",
        ),
    ),
)

JsonObject = dict[str, Any]
ArtifactJson = tuple[Path, JsonObject, datetime]
ClientDisconnectError = (BrokenPipeError, ConnectionAbortedError, ConnectionResetError)


@dataclass(frozen=True)
class LiveDashboardConfig:
    repo_root: Path
    artifact_root: Path
    db_path: Path
    refresh_seconds: int = DEFAULT_REFRESH_SECONDS
    enable_refresh_endpoint: bool = False
    auto_refresh_seconds: int = 0
    initial_refresh_required: bool = False
    summary_cache_seconds: float = DEFAULT_SUMMARY_CACHE_SECONDS
    summary_scan_file_limit: int = DEFAULT_SUMMARY_SCAN_FILE_LIMIT
    ingest_file_limit_per_root: int = DEFAULT_INGEST_FILE_LIMIT_PER_ROOT


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
        self.summary_lock = threading.Lock()
        self.background_refresh_threads_lock = threading.Lock()
        self.background_refresh_threads: list[threading.Thread] = []
        self.refresh_stop = threading.Event()
        self.refresh_thread: threading.Thread | None = None
        self.summary_cache: JsonObject | None = None
        self.summary_cache_dashboard_url: str | None = None
        self.summary_cache_until = 0.0
        self.summary_cache_generation = 0
        self.refresh_state: JsonObject = {
            "mode": "auto" if config.auto_refresh_seconds > 0 else "manual",
            "autoRefreshSeconds": config.auto_refresh_seconds if config.auto_refresh_seconds > 0 else None,
            "initialRefreshRequired": config.initial_refresh_required,
            "refreshInProgress": False,
            "activeRefreshStartedAt": None,
            "activeRefreshReason": None,
            "lastRefreshAt": None,
            "lastRefreshOk": None,
            "lastRefresh": None,
            "nextRefreshAt": utc_iso_after(config.auto_refresh_seconds)
            if config.auto_refresh_seconds > 0
            else None,
        }
        if config.auto_refresh_seconds > 0:
            self.start_auto_refresh()

    def record_refresh(
        self,
        refresh: JsonObject,
        refreshed_at: str | None = None,
        *,
        keep_in_progress: bool = False,
        active_reason: str | None = None,
    ) -> None:
        timestamp = refreshed_at or utc_now_iso()
        with self.refresh_state_lock:
            self.refresh_state["refreshInProgress"] = keep_in_progress
            self.refresh_state["activeRefreshStartedAt"] = (
                self.refresh_state.get("activeRefreshStartedAt") if keep_in_progress else None
            )
            self.refresh_state["activeRefreshReason"] = active_reason if keep_in_progress else None
            self.refresh_state["lastRefreshAt"] = timestamp
            self.refresh_state["lastRefreshOk"] = refresh_succeeded(refresh)
            self.refresh_state["lastRefresh"] = dashboard_json_safe(refresh, self.config.repo_root)
            self.refresh_state["nextRefreshAt"] = (
                utc_iso_after(self.config.auto_refresh_seconds)
                if self.config.auto_refresh_seconds > 0
                else None
            )
        self.invalidate_summary_cache(preserve_existing=keep_in_progress and refresh_succeeded(refresh))

    def refresh_snapshot(self) -> JsonObject:
        with self.refresh_state_lock:
            return dict(self.refresh_state)

    def finish_refresh_progress(self) -> None:
        with self.refresh_state_lock:
            self.refresh_state["refreshInProgress"] = False
            self.refresh_state["activeRefreshStartedAt"] = None
            self.refresh_state["activeRefreshReason"] = None

    def mark_refresh_started(self, reason: str) -> str:
        timestamp = utc_now_iso()
        with self.refresh_state_lock:
            previous_refresh_ok = self.refresh_state.get("lastRefreshOk") is True and bool(
                self.refresh_state.get("lastRefreshAt")
            )
            self.refresh_state["refreshInProgress"] = True
            self.refresh_state["activeRefreshStartedAt"] = timestamp
            self.refresh_state["activeRefreshReason"] = reason
        self.invalidate_summary_cache(preserve_existing=previous_refresh_ok)
        return timestamp

    def run_refresh_cycle(self, reason: str) -> JsonObject:
        with self.refresh_lock:
            self.mark_refresh_started(reason)
            try:
                refresh = refresh_metrics(
                    self.config.db_path,
                    self.config.artifact_root,
                    max_files_per_root=self.config.ingest_file_limit_per_root,
                )
            except Exception as error:  # pragma: no cover - defensive background boundary
                refresh = {"ok": False, "error": str(error)}
            self.record_refresh(
                refresh,
                keep_in_progress=refresh_succeeded(refresh),
                active_reason=f"{reason} summary",
            )
        if refresh_succeeded(refresh):
            try:
                self.prime_summary_cache()
            except Exception:
                self.invalidate_summary_cache()
            finally:
                self.finish_refresh_progress()
        return refresh

    def start_background_refresh(self, reason: str) -> threading.Thread:
        thread_holder: dict[str, threading.Thread] = {}

        def refresh_target() -> None:
            try:
                self.run_refresh_cycle(reason)
            finally:
                thread = thread_holder.get("thread")
                if thread is not None:
                    with self.background_refresh_threads_lock:
                        if thread in self.background_refresh_threads:
                            self.background_refresh_threads.remove(thread)

        thread = threading.Thread(target=refresh_target, daemon=True, name=f"rl-dashboard-{reason}-refresh")
        thread_holder["thread"] = thread
        with self.background_refresh_threads_lock:
            self.background_refresh_threads.append(thread)
        thread.start()
        return thread

    def start_auto_refresh(self) -> None:
        if self.refresh_thread is not None:
            return

        def refresh_loop() -> None:
            while not self.refresh_stop.wait(self.config.auto_refresh_seconds):
                self.run_refresh_cycle("auto")

        self.refresh_thread = threading.Thread(target=refresh_loop, daemon=True, name="rl-dashboard-refresh")
        self.refresh_thread.start()

    def dashboard_url(self) -> str:
        host, port = self.server_address[:2]
        return format_dashboard_url(str(host), int(port))

    def invalidate_summary_cache(self, *, preserve_existing: bool = False) -> None:
        with self.summary_lock:
            if not preserve_existing:
                self.summary_cache = None
                self.summary_cache_dashboard_url = None
                self.summary_cache_until = 0.0
            self.summary_cache_generation += 1

    def prime_summary_cache(self) -> JsonObject:
        return self.summary_snapshot(self.dashboard_url(), allow_refresh_placeholder=False)

    def cached_summary_for_refresh(self, dashboard_url: str, refresh: JsonObject) -> JsonObject | None:
        with self.summary_lock:
            cached = self.summary_cache
            if cached is None or self.summary_cache_dashboard_url != dashboard_url:
                return None
            if not summary_has_usable_cached_data(cached):
                return None
            return summary_with_refresh(cached, refresh)

    def summary_snapshot(self, dashboard_url: str, *, allow_refresh_placeholder: bool = True) -> JsonObject:
        refresh = self.refresh_snapshot()
        if allow_refresh_placeholder and refresh.get("refreshInProgress"):
            cached = self.cached_summary_for_refresh(dashboard_url, refresh)
            if cached is not None:
                return cached
            return build_refreshing_summary(self.config, dashboard_url, refresh)
        cache_ttl = max(0.0, float(self.config.summary_cache_seconds))
        current_monotonic = time.monotonic()
        with self.summary_lock:
            if (
                not refresh.get("refreshInProgress")
                and cache_ttl > 0
                and self.summary_cache is not None
                and self.summary_cache_dashboard_url == dashboard_url
                and current_monotonic < self.summary_cache_until
            ):
                return self.summary_cache
            cache_generation = self.summary_cache_generation

        if not self.refresh_lock.acquire(blocking=False):
            refresh = self.refresh_snapshot()
            if allow_refresh_placeholder and refresh.get("refreshInProgress"):
                cached = self.cached_summary_for_refresh(dashboard_url, refresh)
                if cached is not None:
                    return cached
                return build_refreshing_summary(self.config, dashboard_url, refresh)
            self.refresh_lock.acquire()
        try:
            db = sqlite_summary(self.config.db_path, self.config.repo_root)
            refresh = self.refresh_snapshot()
        finally:
            self.refresh_lock.release()
        summary = build_live_summary(
            self.config.repo_root,
            self.config.artifact_root,
            self.config.db_path,
            dashboard_url=dashboard_url,
            refresh=refresh,
            db_summary=db,
            scan_file_limit=self.config.summary_scan_file_limit,
        )

        current_monotonic = time.monotonic()
        with self.summary_lock:
            if (
                cache_ttl > 0
                and self.summary_cache is not None
                and self.summary_cache_dashboard_url == dashboard_url
                and current_monotonic < self.summary_cache_until
            ):
                return self.summary_cache
            if self.summary_cache_generation == cache_generation:
                self.summary_cache = summary
                self.summary_cache_dashboard_url = dashboard_url
                self.summary_cache_until = time.monotonic() + cache_ttl
        return summary

    def server_close(self) -> None:
        self.refresh_stop.set()
        if self.refresh_thread is not None:
            self.refresh_thread.join(timeout=2)
            self.refresh_thread = None
        with self.background_refresh_threads_lock:
            background_threads = list(self.background_refresh_threads)
        for thread in background_threads:
            thread.join(timeout=2)
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


def file_mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def newest_matching_files(
    root: Path,
    patterns: Sequence[str],
    *,
    recursive: bool = False,
    limit: int | None = None,
) -> tuple[list[Path], int]:
    if not root.exists():
        return [], 0
    paths: list[Path] = []
    seen: set[Path] = set()
    for pattern in patterns:
        try:
            matches = root.rglob(pattern) if recursive else root.glob(pattern)
            for path in matches:
                if not path.is_file():
                    continue
                try:
                    resolved = path.resolve()
                except OSError:
                    resolved = path
                if resolved in seen:
                    continue
                seen.add(resolved)
                paths.append(path)
        except OSError:
            continue
    ordered = sorted(paths, key=lambda candidate: (file_mtime(candidate), candidate.as_posix()), reverse=True)
    bounded_limit = max(0, limit) if limit is not None else None
    if bounded_limit is not None:
        return ordered[:bounded_limit], len(ordered)
    return ordered, len(ordered)


def latest_json_artifact(
    root: Path,
    patterns: Sequence[str],
    *,
    max_files: int | None = None,
) -> tuple[Path, JsonObject, datetime] | None:
    candidates: list[tuple[Path, JsonObject, datetime]] = []
    paths, _total = newest_matching_files(root, patterns, limit=max_files)
    for path in paths:
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


def db_summary_has_usable_data(db: JsonObject) -> bool:
    tables = db.get("tables")
    return (
        db.get("exists") is True
        and db.get("schemaReady") is True
        and not db.get("error")
        and isinstance(tables, dict)
        and bool(tables)
        and bool(db.get("latestObservedAt"))
    )


def summary_has_usable_cached_data(summary: JsonObject) -> bool:
    refresh = as_dict(summary.get("refresh"))
    return (
        db_summary_has_usable_data(as_dict(summary.get("db")))
        and as_dict(summary.get("health")).get("ok") is True
        and refresh.get("lastRefreshOk") is True
        and bool(refresh.get("lastRefreshAt"))
        and bool(as_dict(summary.get("e1Gate")))
        and bool(as_dict(summary.get("loopA")))
        and bool(as_dict(summary.get("loopB")))
        and bool(as_dict(summary.get("tencentBatch")))
        and bool(as_list(summary.get("projectGates")))
    )


def health_with_refresh(db_health: JsonObject, refresh: JsonObject, *, usable_data: bool = False) -> JsonObject:
    failures = list(as_list(db_health.get("failures")))
    refresh_succeeded_at_least_once = refresh.get("lastRefreshOk") is True and bool(refresh.get("lastRefreshAt"))
    if refresh.get("refreshInProgress") is True:
        if not (refresh_succeeded_at_least_once and usable_data):
            reason = text_value(refresh.get("activeRefreshReason")) or "metrics"
            failures.append(f"{reason} refresh is in progress")
    elif refresh.get("initialRefreshRequired") is True and not refresh_succeeded_at_least_once:
        failures.append("startup refresh has not completed successfully")
    elif refresh.get("mode") == "auto" and not refresh_succeeded_at_least_once:
        failures.append("auto-refresh has not completed successfully")
    ok = not failures
    return {
        "ok": ok,
        "status": "ok" if ok else "degraded",
        "failures": failures,
    }


def summary_with_refresh(summary: JsonObject, refresh: JsonObject) -> JsonObject:
    updated = dict(summary)
    db = as_dict(updated.get("db"))
    updated["refresh"] = dict(refresh)
    updated["health"] = health_with_refresh(
        health_from_db_summary(db),
        refresh,
        usable_data=db_summary_has_usable_data(db),
    )
    return updated


def refreshing_db_summary(db_path: Path, repo_root: Path, reason: str) -> JsonObject:
    expanded = db_path.expanduser()
    summary: JsonObject = {
        "path": safe_display_path(expanded, repo_root),
        "exists": expanded.exists(),
        "sizeBytes": None,
        "schemaReady": False,
        "tables": {},
        "latestObservedAt": None,
        "error": reason,
    }
    try:
        if expanded.exists():
            summary["sizeBytes"] = expanded.stat().st_size
    except OSError as error:
        summary["error"] = f"{reason}; cannot stat metrics database: {error}"
    return summary


def default_ingest_paths(artifact_root: Path) -> list[Path]:
    return [artifact_root / subdir for subdir in DEFAULT_ARTIFACT_SUBDIRS]


def bounded_ingest_paths(artifact_root: Path, *, max_files_per_root: int) -> list[Path]:
    ingest_paths: list[Path] = []
    for root in default_ingest_paths(artifact_root):
        selected, total = newest_matching_files(
            root,
            ("*",),
            recursive=True,
            limit=max_files_per_root,
        )
        if selected:
            ingest_paths.extend(selected)
        elif total == 0:
            ingest_paths.append(root)
    return ingest_paths


def record_refresh_observation(db_path: Path, ingest_paths: Sequence[Path], result: JsonObject, *, bounded: bool) -> None:
    refreshed_at = utc_now_iso()
    refresh_key = f"{refreshed_at}:{time.time_ns()}"
    evidence = {
        "bounded": bounded,
        "filesScanned": result.get("files_scanned"),
        "filesSkipped": result.get("files_skipped"),
        "runtimeSummaries": result.get("runtime_summaries"),
        "datasetGateArtifacts": result.get("dataset_gate_artifacts"),
        "trainingArtifacts": result.get("training_artifacts"),
        "iterationDecisions": result.get("iteration_decisions"),
        "coverageGaps": result.get("coverage_gaps"),
        "paths": [str(path) for path in ingest_paths[:20]],
        "pathCount": len(ingest_paths),
    }
    with sqlite3.connect(str(db_path.expanduser())) as conn:
        conn.execute(
            """
            INSERT INTO metric_observations (
              metric_name, observed_at, value, value_text, unit, source_artifact, evidence_json, dedupe_key
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "source.rl_metrics_refresh.completed",
                refreshed_at,
                static_dashboard.number_value(result.get("files_scanned")),
                "bounded" if bounded else "explicit",
                "files",
                f"scripts/screeps_rl_live_dashboard.py refresh {refresh_key}",
                json.dumps(evidence, sort_keys=True, ensure_ascii=True),
                f"rl-dashboard-refresh:{refresh_key}",
            ),
        )
        conn.commit()


def refresh_metrics(
    db_path: Path,
    artifact_root: Path,
    paths: Sequence[Path] | None = None,
    *,
    max_files_per_root: int = DEFAULT_INGEST_FILE_LIMIT_PER_ROOT,
) -> JsonObject:
    bounded = paths is None or len(paths) == 0
    ingest_paths = (
        bounded_ingest_paths(artifact_root, max_files_per_root=max_files_per_root)
        if bounded
        else list(paths or [])
    )
    result = metrics_ingestor.ingest_artifacts(db_path, ingest_paths)
    record_refresh_observation(db_path, ingest_paths, result, bounded=bounded)
    return {
        "ok": True,
        "db": str(db_path),
        "paths": [str(path) for path in ingest_paths],
        "bounded": bounded,
        "fileLimitPerRoot": max_files_per_root if bounded else None,
        **result,
    }


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


def latest_scorecard_summary(
    artifact_root: Path,
    repo_root: Path,
    *,
    max_files: int = DEFAULT_SUMMARY_SCAN_FILE_LIMIT,
) -> JsonObject:
    latest = latest_json_artifact(
        artifact_root / "rl-control-loop" / "scorecards",
        ("*.json",),
        max_files=max_files,
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
    return tencent_batch_summary_at(artifact_root, repo_root, now=None)


def tencent_batch_summary_at(
    artifact_root: Path,
    repo_root: Path,
    *,
    now: Any | None,
    max_runs: int = DEFAULT_SUMMARY_SCAN_FILE_LIMIT,
) -> JsonObject:
    root = artifact_root / "tencent-cloud" / "batch-runs"
    runs: list[JsonObject] = []
    paths, total_paths = newest_matching_files(root, ("*/controller-summary.json",), limit=max_runs)
    for path in paths:
        payload = load_json_object(path)
        if payload is None:
            continue
        compute_evidence = static_dashboard.compute_evidence_summary(payload)
        batch_scale = tencent_batch_scale(payload)
        runner_state = classify_tencent_batch_run_state(payload, now=now)
        known_hosts_self_heal = as_dict(runner_state.get("knownHostsSelfHeal"))
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
                "knownHostsSelfHeal": known_hosts_self_heal,
                "runnerState": runner_state,
                "stateClassification": runner_state.get("status"),
                "activeAgeSeconds": runner_state.get("ageSeconds"),
                "declaredTimeoutSeconds": runner_state.get("timeoutSeconds"),
                "handoffRequired": runner_state.get("handoffRequired")
                or known_hosts_self_heal.get("handoffRequired") is True,
                "blocker": compute_evidence.get("blocker"),
                "path": safe_display_path(path, repo_root),
                "timestamp": display_timestamp(artifact_timestamp(path, payload)),
            }
            )
    latest = max(runs, key=lambda item: item["timestamp"]) if runs else None
    active = [run for run in runs if as_dict(run.get("runnerState")).get("active") is True]
    completed = [run for run in runs if str(run.get("finalStatus", "")).lower() in {"completed", "success", "ok"}]
    compute_confirmed = [run for run in runs if run.get("computeClassification") == "COMPUTE_CONFIRMED"]
    preflight_only = [run for run in runs if run.get("computeClassification") == "PREFLIGHT_ONLY_VALIDATION"]
    return {
        "hasData": bool(runs),
        "runCount": len(runs),
        "runsDiscovered": total_paths,
        "runsScanned": len(paths),
        "truncated": total_paths > len(paths),
        "fileLimit": max_runs,
        "activeRunCount": len(active),
        "completedRunCount": len(completed),
        "computeConfirmedRunCount": len(compute_confirmed),
        "preflightOnlyRunCount": len(preflight_only),
        "latest": latest,
    }


def classify_tencent_batch_run_state(payload: JsonObject, *, now: Any | None = None) -> JsonObject:
    run_id = text_value(payload.get("runId")) or "unknown"
    started_at = payload.get("startedAt")
    age_seconds = seconds_since(started_at, now=now)
    timeout_seconds = tencent_declared_timeout_seconds(payload)
    progress = tencent_batch_progress(payload)
    pid = tencent_controller_pid(payload)
    active = tencent_batch_run_is_active(payload)
    known_hosts_self_heal = known_hosts_self_heal_summary(payload)
    state: JsonObject = {
        "runId": run_id,
        "pid": pid,
        "active": active,
        "status": "TENCENT_BATCH_RUNNER_INACTIVE",
        "startedAt": display_timestamp(started_at),
        "ageSeconds": age_seconds,
        "timeoutSeconds": timeout_seconds,
        "timeoutKnown": timeout_seconds is not None,
        "progress": progress,
        "knownHostsSelfHeal": known_hosts_self_heal,
        "handoffRequired": False,
        "action": "none",
    }
    if known_hosts_self_heal.get("status") == "BLOCKED":
        state.update(
            {
                "status": "SSH_HOST_KEY_SELF_HEALING_FAILED",
                "handoffRequired": True,
                "handoffSeverity": "P1",
                "action": "inspect Tencent known_hosts self-heal failure before retrying SSH work",
                "evidence": known_hosts_self_heal.get("evidence"),
            }
        )
        return state
    if not active:
        return state
    if timeout_seconds is None or age_seconds is None or age_seconds <= timeout_seconds or progress.get("hasProgress") is True:
        state.update(
            {
                "status": "TRAINING_IN_PROGRESS",
                "action": "monitor",
                "evidence": tencent_active_evidence(run_id, pid, age_seconds, timeout_seconds, progress),
            }
        )
        return state
    action = (
        f"kill PID {pid} and scale down ASG to DesiredCapacity=0"
        if pid is not None
        else "scale down ASG to DesiredCapacity=0 after confirming the active runner process"
    )
    state.update(
        {
            "status": "TENCENT_BATCH_RUNNER_STUCK",
            "handoffRequired": True,
            "handoffSeverity": "P1",
            "action": action,
            "scaleDownAction": action,
            "evidence": (
                f"Active Tencent batch runner {run_id} (PID {pid if pid is not None else 'unknown'}) "
                f"age={age_seconds}s exceeded declared timeout={timeout_seconds}s with no environments, "
                "artifacts, or training report observed."
            ),
        }
    )
    return state


def tencent_active_evidence(
    run_id: str,
    pid: int | None,
    age_seconds: int | None,
    timeout_seconds: int | None,
    progress: JsonObject,
) -> str:
    pid_text = f", PID {pid}" if pid is not None else ""
    timeout_text = f", timeout={timeout_seconds}s" if timeout_seconds is not None else ", timeout=unknown"
    age_text = f"age={age_seconds}s" if age_seconds is not None else "age=unknown"
    progress_text = "progress observed" if progress.get("hasProgress") is True else "no completed environments yet"
    return f"Active Tencent batch runner {run_id}{pid_text}: {age_text}{timeout_text}; {progress_text}."


def tencent_batch_run_is_active(payload: JsonObject) -> bool:
    if parse_iso_datetime(payload.get("finishedAt")) is not None:
        return False
    final_status = normalized_key(text_value(payload.get("finalStatus")) or "")
    if final_status in TENCENT_ACTIVE_FINAL_STATUS_KEYS:
        return True
    return payload.get("partial") is True and final_status not in TENCENT_TERMINAL_FINAL_STATUS_KEYS


def tencent_declared_timeout_seconds(payload: JsonObject) -> int | None:
    inputs = as_dict(payload.get("inputs"))
    candidates = (
        as_dict(inputs.get("executionTimeouts")),
        as_dict(payload.get("executionTimeouts")),
        as_dict(inputs.get("timeouts")),
        as_dict(payload.get("timeouts")),
        inputs,
        payload,
    )
    for candidate in candidates:
        total = seconds_value_for_keys(candidate, TENCENT_TIMEOUT_TOTAL_KEYS)
        if total is not None and total > 0:
            return total
    for candidate in candidates:
        components: list[int] = []
        for keys in TENCENT_TIMEOUT_COMPONENT_KEY_GROUPS:
            value = seconds_value_for_keys(candidate, keys)
            if value is not None:
                components.append(value)
        if components:
            return sum(components)
    return None


def seconds_value_for_keys(container: JsonObject, keys: Sequence[str]) -> int | None:
    if not container:
        return None
    normalized_values = {normalized_key(key): value for key, value in container.items()}
    for key in keys:
        value = normalized_values.get(normalized_key(key))
        parsed = static_dashboard.number_value(value)
        if parsed is not None:
            return max(0, int(parsed))
    return None


def tencent_batch_progress(payload: JsonObject) -> JsonObject:
    execution = as_dict(payload.get("execution"))
    outputs = as_dict(payload.get("outputs"))
    training_report = as_dict(outputs.get("trainingReport"))
    environments_run = first_tencent_number(
        execution.get("environmentsRun"),
        execution.get("environmentsCompleted"),
        execution.get("completedEnvironments"),
        training_report.get("environmentRows"),
        training_report.get("environmentsRun"),
    )
    artifact_count = first_tencent_number(
        execution.get("artifactCount"),
        training_report.get("artifactCount"),
        as_dict(outputs.get("remoteArtifacts")).get("artifactCount"),
    )
    training_report_produced = (
        execution.get("trainingReportProduced") is True
        or bool(training_report.get("reportId"))
        or bool(training_report.get("path"))
    )
    has_progress = bool(
        (environments_run is not None and environments_run > 0)
        or (artifact_count is not None and artifact_count > 0)
        or training_report_produced
    )
    return {
        "hasProgress": has_progress,
        "environmentsRun": environments_run,
        "artifactCount": artifact_count,
        "trainingReportProduced": training_report_produced,
    }


def first_tencent_number(*values: Any) -> int | None:
    for value in values:
        parsed = static_dashboard.number_value(value)
        if parsed is not None:
            return max(0, int(parsed))
    return None


def tencent_controller_pid(payload: JsonObject) -> int | None:
    for container in (
        payload,
        as_dict(payload.get("controllerProcess")),
        as_dict(payload.get("process")),
        as_dict(payload.get("runnerProcess")),
    ):
        for key in ("pid", "controllerPid", "runnerPid"):
            parsed = static_dashboard.int_value(container.get(key))
            if parsed is not None and parsed > 0:
                return parsed
    return None


def tencent_step_status(step: JsonObject) -> str | None:
    detail = as_dict(step.get("detail"))
    return text_value(detail.get("status")) or text_value(step.get("status"))


def tencent_step_attempt(step: JsonObject) -> int | None:
    detail = as_dict(step.get("detail"))
    return static_dashboard.int_value(detail.get("attempt")) or static_dashboard.int_value(step.get("attempt"))


def known_hosts_self_heal_summary(payload: JsonObject) -> JsonObject:
    records: list[JsonObject] = []
    for index, step in enumerate(as_list(payload.get("steps"))):
        if not isinstance(step, dict):
            continue
        name = text_value(step.get("name")) or ""
        status = tencent_step_status(step)
        if (
            name not in HOST_KEY_SELF_HEAL_STEP_NAMES
            and status not in HOST_KEY_SELF_HEAL_SUCCESS_STATUSES
            and status not in HOST_KEY_SELF_HEAL_RETRY_STATUSES
            and status not in HOST_KEY_SELF_HEAL_FAILURE_STATUSES
        ):
            continue
        detail = as_dict(step.get("detail"))
        records.append(
            {
                "index": index,
                "step": name,
                "status": status,
                "ok": step.get("ok"),
                "retryable": detail.get("retryable"),
                "attempt": tencent_step_attempt(step),
            }
        )

    if not records:
        return {
            "status": "N/A",
            "classification": "SSH_HOST_KEY_SELF_HEALING_NOT_OBSERVED",
            "handoffRequired": False,
            "evidence": "no known_hosts self-heal steps observed",
            "steps": [],
        }

    retry_records = [record for record in records if record.get("status") in HOST_KEY_SELF_HEAL_RETRY_STATUSES]
    success_records = [record for record in records if record.get("status") in HOST_KEY_SELF_HEAL_SUCCESS_STATUSES]
    failure_records = [record for record in records if record.get("status") in HOST_KEY_SELF_HEAL_FAILURE_STATUSES]
    last_success = success_records[-1] if success_records else None
    last_failure = failure_records[-1] if failure_records else None
    if last_failure is not None and (last_success is None or last_failure["index"] > last_success["index"]):
        return {
            "status": "BLOCKED",
            "classification": "SSH_HOST_KEY_SELF_HEALING_FAILED",
            "handoffRequired": True,
            "evidence": (
                "known_hosts self-healing failed after "
                f"{len(retry_records)} retry/status attempt(s); latestStatus={last_failure.get('status')}"
            ),
            "steps": records,
        }
    if retry_records and last_success is not None:
        return {
            "status": "OK",
            "classification": "SSH_HOST_KEY_SELF_HEALING_RECOVERED",
            "handoffRequired": False,
            "evidence": (
                f"{len(retry_records)} retry/status attempt(s) recovered via {last_success.get('status')}"
            ),
            "steps": records,
        }
    if last_success is not None:
        return {
            "status": "OK",
            "classification": "SSH_HOST_KEY_SELF_HEALING_OK",
            "handoffRequired": False,
            "evidence": f"known_hosts prepared via {last_success.get('status')}",
            "steps": records,
        }
    if retry_records:
        return {
            "status": "MONITOR",
            "classification": "SSH_HOST_KEY_SELF_HEALING_RETRYING",
            "handoffRequired": False,
            "evidence": f"{len(retry_records)} retryable host-key status attempt(s) observed without terminal failure",
            "steps": records,
        }
    return {
        "status": "N/A",
        "classification": "SSH_HOST_KEY_SELF_HEALING_NOT_OBSERVED",
        "handoffRequired": False,
        "evidence": "known_hosts steps did not include retry, success, or failure statuses",
        "steps": records,
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


def summary_artifact_source_root(artifact_root: Path, source: str) -> Path:
    return artifact_root.joinpath(*source.split("/"))


def summary_artifact_json_paths(
    artifact_root: Path,
    repo_root: Path,
    *,
    max_files_per_root: int = DEFAULT_SUMMARY_SCAN_FILE_LIMIT,
) -> tuple[list[Path], JsonObject]:
    bounded_limit = max(0, max_files_per_root)
    paths: list[Path] = []
    source_summaries: list[JsonObject] = []
    seen: set[Path] = set()
    for source, patterns in SUMMARY_ARTIFACT_SOURCE_PATTERNS:
        root = summary_artifact_source_root(artifact_root, source)
        selected, total = newest_matching_files(root, patterns, limit=bounded_limit)
        source_paths: list[Path] = []
        for path in selected:
            try:
                resolved = path.resolve()
            except OSError:
                resolved = path
            if resolved in seen:
                continue
            seen.add(resolved)
            source_paths.append(path)
            paths.append(path)
        source_summaries.append(
            {
                "source": source,
                "root": safe_display_path(root, repo_root),
                "patterns": list(patterns),
                "filesDiscovered": total,
                "filesScanned": len(source_paths),
                "fileLimit": bounded_limit,
                "truncated": total > len(selected),
            }
        )
    ordered = sorted(paths, key=lambda candidate: (file_mtime(candidate), candidate.as_posix()), reverse=True)
    return ordered, {
        "mode": "bounded-targeted-json",
        "filesScanned": len(ordered),
        "fileLimitPerSource": bounded_limit,
        "sources": source_summaries,
        "truncated": any(source.get("truncated") is True for source in source_summaries),
    }


def load_artifact_json_paths(paths: Iterable[Path]) -> Iterator[ArtifactJson]:
    for path in paths:
        payload = load_json_object(path)
        if payload is None:
            continue
        yield path, payload, artifact_timestamp(path, payload)


def scan_artifact_json(
    artifact_root: Path,
    *,
    max_files_per_root: int = DEFAULT_SUMMARY_SCAN_FILE_LIMIT,
) -> Iterator[ArtifactJson]:
    paths, _scan = summary_artifact_json_paths(
        artifact_root,
        artifact_root,
        max_files_per_root=max_files_per_root,
    )
    yield from load_artifact_json_paths(paths)


def summary_status_priority(summary: JsonObject) -> int:
    return SUMMARY_STATUS_PRIORITY.get(str(summary.get("status") or "").upper(), 0)


def summary_tie_key(summary: JsonObject) -> str:
    for key in ("latestPath", "path", "runId", "id", "name", "evidence"):
        value = summary.get(key)
        if value not in (None, ""):
            return str(value)
    try:
        return json.dumps(summary, sort_keys=True, ensure_ascii=True)
    except TypeError:
        return str(summary)


def newest_summary(current: JsonObject | None, candidate: JsonObject | None) -> JsonObject | None:
    if candidate is None:
        return current
    if current is None:
        return candidate
    current_timestamp = parse_iso_datetime(current.get("updatedAt"))
    candidate_timestamp = parse_iso_datetime(candidate.get("updatedAt"))
    if current_timestamp is None:
        return candidate
    if candidate_timestamp is None:
        return current
    if candidate_timestamp > current_timestamp:
        return candidate
    if candidate_timestamp < current_timestamp:
        return current
    current_priority = summary_status_priority(current)
    candidate_priority = summary_status_priority(candidate)
    if candidate_priority != current_priority:
        return candidate if candidate_priority > current_priority else current
    return candidate if summary_tie_key(candidate) > summary_tie_key(current) else current


def preferred_policy_update_summary(
    trusted: JsonObject | None,
    fallback: JsonObject | None,
) -> JsonObject | None:
    if trusted is None:
        return fallback
    if fallback is None:
        return trusted
    trusted_is_blocked = str(trusted.get("status") or "").upper() == "BLOCKED"
    fallback_is_blocked = str(fallback.get("status") or "").upper() == "BLOCKED"
    trusted_timestamp = parse_iso_datetime(trusted.get("updatedAt"))
    fallback_timestamp = parse_iso_datetime(fallback.get("updatedAt"))
    if trusted_timestamp is not None and fallback_timestamp is not None:
        if fallback_timestamp > trusted_timestamp and fallback_is_blocked and not trusted_is_blocked:
            return fallback
        return trusted
    if fallback_is_blocked and not trusted_is_blocked:
        return newest_summary(trusted, fallback)
    return trusted


def runtime_candidate_injection_from_artifact(
    path: Path,
    payload: JsonObject,
    timestamp: datetime,
    repo_root: Path,
) -> JsonObject | None:
    blocked: JsonObject | None = None
    ok: JsonObject | None = None
    display_path = safe_display_path(path, repo_root)
    updated_at = display_timestamp(timestamp)
    for node in iter_json_objects(payload):
        for key, value in node.items():
            normalized = normalized_key(key)
            if normalized in RUNTIME_INJECTION_TRUE_KEYS:
                if value is True and ok is None:
                    ok = {
                        "status": "OK",
                        "evidence": f"{key}=true",
                        "latestPath": display_path,
                        "updatedAt": updated_at,
                    }
                if value is False and blocked is None:
                    blocked = {
                        "status": "BLOCKED",
                        "evidence": f"{key}={value}",
                        "latestPath": display_path,
                        "updatedAt": updated_at,
                    }
            if normalized in RUNTIME_INJECTION_SCOPE_KEYS:
                scope = text_value(value)
                if (
                    scope is not None
                    and normalized_key(scope) in RUNTIME_INJECTION_METADATA_ONLY_VALUES
                    and blocked is None
                ):
                    blocked = {
                        "status": "BLOCKED",
                        "evidence": f"{key}={value}",
                        "latestPath": display_path,
                        "updatedAt": updated_at,
                    }
    return blocked or ok


def runtime_candidate_injection_summary_from_artifacts(
    artifacts: Iterable[ArtifactJson],
    repo_root: Path,
) -> JsonObject:
    latest: JsonObject | None = None
    for path, payload, timestamp in artifacts:
        latest = newest_summary(latest, runtime_candidate_injection_from_artifact(path, payload, timestamp, repo_root))
    if latest is not None:
        return latest
    return {
        "status": "N/A",
        "evidence": "no runtime candidate injection evidence found",
        "latestPath": None,
        "updatedAt": None,
    }


def runtime_candidate_injection_summary(artifact_root: Path, repo_root: Path) -> JsonObject:
    return runtime_candidate_injection_summary_from_artifacts(scan_artifact_json(artifact_root), repo_root)


def trusted_policy_update_report_artifact(path: Path, payload: JsonObject) -> bool:
    type_text = str(payload.get("type") or "").lower()
    if type_text in TRUSTED_POLICY_UPDATE_REPORT_TYPES:
        return failed_training_report_status(payload) is not True
    if "training-report" in type_text and "ledger" not in type_text:
        return failed_training_report_status(payload) is not True
    if (
        "rl-training" in path.parts
        and "training-ledger" not in path.name
        and ("policyUpdateIterations" in payload or isinstance(payload.get("policyUpdate"), dict))
    ):
        return failed_training_report_status(payload) is not True
    return False


def failed_training_report_status(payload: JsonObject) -> bool:
    status = normalized_key(text_value(payload.get("finalStatus")) or text_value(payload.get("status")) or "")
    return status in {"cancelled", "canceled", "error", "failed", "timeout", "timedout"}


def policy_update_iterations_value(node: JsonObject, policy_update: JsonObject | None) -> int | None:
    values = [node.get("policyUpdateIterations")]
    if isinstance(policy_update, dict):
        values.append(policy_update.get("iterations"))
    for value in values:
        parsed = static_dashboard.int_value(value)
        if parsed is not None:
            return parsed
    return None


def policy_update_true_gradient_value(node: JsonObject, policy_update: JsonObject | None) -> bool | None:
    for container in (
        node,
        policy_update if isinstance(policy_update, dict) else {},
        as_dict(as_dict(policy_update).get("nextCandidatePolicy")) if isinstance(policy_update, dict) else {},
    ):
        value = container.get("trueGradient")
        if isinstance(value, bool):
            return value
    return None


def unique_policy_blocker_details(details: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for detail in details:
        if detail in seen:
            continue
        seen.add(detail)
        unique.append(detail)
    return unique


def promotion_gate_status_is_blocking(status: str | None) -> bool:
    return normalized_key(status or "").startswith("blocked")


def policy_update_non_promotional_details(node: JsonObject, policy_update: JsonObject | None) -> list[str]:
    policy_update_dict = policy_update if isinstance(policy_update, dict) else {}
    promotion_gate = as_dict(node.get("policyUpdatePromotionGate")) or as_dict(policy_update_dict.get("promotionGate"))
    details: list[str] = []
    status = text_value(promotion_gate.get("status"))
    status_is_blocking = promotion_gate_status_is_blocking(status)
    if status and status_is_blocking:
        details.append(status)
    elif promotion_gate.get("runtimeParameterConsumption") is False:
        details.append("blocked_runtime_parameter_consumption_missing")

    evidence_containers = (
        as_dict(node.get("runtimeParameterInjection")),
        as_dict(policy_update_dict.get("parameterEvidence")),
        as_dict(node.get("candidateScorecard")),
        as_dict(as_dict(node.get("candidateScorecard")).get("overallGate")).get("runtimeCandidateGate"),
    )
    for raw_container in evidence_containers:
        container = as_dict(raw_container)
        if container.get("runtimeParameterConsumption") is False and not status_is_blocking:
            details.append("runtimeParameterConsumption=false")
        consumed = static_dashboard.int_value(container.get("consumedVariantCount"))
        if consumed == 0:
            details.append("consumedVariantCount=0")
        if container.get("policyUpdateEligible") is False:
            details.append("policyUpdateEligible=false")

    for container in (
        node,
        policy_update_dict,
        as_dict(policy_update_dict.get("promotionGate")),
        as_dict(policy_update_dict.get("nextCandidatePolicy")),
        as_dict(node.get("gradientStability")),
    ):
        if container.get("trustedGradientUpdate") is False or container.get("trustedUpdate") is False:
            details.append("trustedGradientUpdate=false")
    return unique_policy_blocker_details(details)


def zero_iteration_policy_update_from_artifact(
    path: Path,
    payload: JsonObject,
    timestamp: datetime,
    repo_root: Path,
) -> JsonObject | None:
    display_path = safe_display_path(path, repo_root)
    updated_at = display_timestamp(timestamp)
    source_trust = "trusted_training_report" if trusted_policy_update_report_artifact(path, payload) else "artifact"
    for node in iter_json_objects(payload):
        raw_policy_update = node.get("policyUpdate")
        policy_update = raw_policy_update if isinstance(raw_policy_update, dict) else None
        iterations = policy_update_iterations_value(node, policy_update)
        if iterations is None and policy_update is None:
            continue
        if iterations == 0:
            if policy_update is None:
                return {
                    "status": "OK",
                    "evidence": "zero policy updates with no update artifact",
                    "latestPath": display_path,
                    "updatedAt": updated_at,
                    "sourceTrust": source_trust,
                }
            skipped = text_value(policy_update.get("skippedReason"))
            if skipped and not node.get("policyUpdateArtifactPath"):
                return {
                    "status": "OK",
                    "evidence": f"safe zero-iteration no-op: {skipped}",
                    "latestPath": display_path,
                    "updatedAt": updated_at,
                    "sourceTrust": source_trust,
                }
            return {
                "status": "BLOCKED",
                "evidence": "zero-iteration policy update lacks safe skippedReason or has update artifact",
                "latestPath": display_path,
                "updatedAt": updated_at,
                "sourceTrust": source_trust,
            }
        if iterations is not None and iterations > 0:
            true_gradient = policy_update_true_gradient_value(node, policy_update)
            if true_gradient is False:
                return {
                    "status": "BLOCKED",
                    "evidence": f"positive policy update lacks trueGradient=true; policyUpdateIterations={iterations}",
                    "latestPath": display_path,
                    "updatedAt": updated_at,
                    "sourceTrust": source_trust,
                }
            blocker_details = policy_update_non_promotional_details(node, policy_update)
            if blocker_details:
                return {
                    "status": "BLOCKED",
                    "evidence": f"policy update non-promotional: {'; '.join(blocker_details)}",
                    "latestPath": display_path,
                    "updatedAt": updated_at,
                    "sourceTrust": source_trust,
                }
            return {
                "status": "N/A",
                "evidence": (
                    f"latest policy update had {iterations} iteration(s); "
                    f"trueGradient={'true' if true_gradient is True else 'unknown'}"
                ),
                "latestPath": display_path,
                "updatedAt": updated_at,
                "sourceTrust": source_trust,
            }
    return None


def zero_iteration_policy_update_summary_from_artifacts(
    artifacts: Iterable[ArtifactJson],
    repo_root: Path,
) -> JsonObject:
    latest_trusted_report: JsonObject | None = None
    latest_fallback: JsonObject | None = None
    for path, payload, timestamp in artifacts:
        summary = zero_iteration_policy_update_from_artifact(path, payload, timestamp, repo_root)
        if as_dict(summary).get("sourceTrust") == "trusted_training_report":
            latest_trusted_report = newest_summary(latest_trusted_report, summary)
        else:
            latest_fallback = newest_summary(latest_fallback, summary)
    latest = preferred_policy_update_summary(latest_trusted_report, latest_fallback)
    if latest is not None:
        return latest
    return {
        "status": "N/A",
        "evidence": "no policy update evidence found",
        "latestPath": None,
        "updatedAt": None,
    }


def zero_iteration_policy_update_summary(artifact_root: Path, repo_root: Path) -> JsonObject:
    return zero_iteration_policy_update_summary_from_artifacts(scan_artifact_json(artifact_root), repo_root)


def artifact_evidence_summaries(
    artifact_root: Path,
    repo_root: Path,
    *,
    max_files_per_root: int = DEFAULT_SUMMARY_SCAN_FILE_LIMIT,
) -> tuple[JsonObject, JsonObject]:
    injection, zero_iteration, _scan = artifact_evidence_summaries_with_scan(
        artifact_root,
        repo_root,
        max_files_per_root=max_files_per_root,
    )
    return injection, zero_iteration


def artifact_evidence_summaries_with_scan(
    artifact_root: Path,
    repo_root: Path,
    *,
    max_files_per_root: int = DEFAULT_SUMMARY_SCAN_FILE_LIMIT,
) -> tuple[JsonObject, JsonObject, JsonObject]:
    injection: JsonObject | None = None
    trusted_zero_iteration: JsonObject | None = None
    fallback_zero_iteration: JsonObject | None = None
    paths, scan = summary_artifact_json_paths(
        artifact_root,
        repo_root,
        max_files_per_root=max_files_per_root,
    )
    for path, payload, timestamp in load_artifact_json_paths(paths):
        injection = newest_summary(injection, runtime_candidate_injection_from_artifact(path, payload, timestamp, repo_root))
        zero_iteration = zero_iteration_policy_update_from_artifact(path, payload, timestamp, repo_root)
        if as_dict(zero_iteration).get("sourceTrust") == "trusted_training_report":
            trusted_zero_iteration = newest_summary(trusted_zero_iteration, zero_iteration)
        else:
            fallback_zero_iteration = newest_summary(fallback_zero_iteration, zero_iteration)
    zero_iteration = preferred_policy_update_summary(trusted_zero_iteration, fallback_zero_iteration)
    return (
        injection
        or {
            "status": "N/A",
            "evidence": "no runtime candidate injection evidence found",
            "latestPath": None,
            "updatedAt": None,
        },
        zero_iteration
        or {
            "status": "N/A",
            "evidence": "no policy update evidence found",
            "latestPath": None,
            "updatedAt": None,
        },
        scan,
    )


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
    successful_refresh = refresh.get("lastRefreshOk") is True and bool(refresh.get("lastRefreshAt"))
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
            "status": "OK" if auto_refresh_ok and successful_refresh and tencent.get("hasData") else "BLOCKED",
            "evidence": (
                f"autoRefresh={refresh_cadence}; lastRefreshOk={refresh.get('lastRefreshOk')}; "
                f"lastRefreshAt={display_timestamp(refresh.get('lastRefreshAt'))}; "
                f"tencentRuns={tencent.get('runCount', 0)}"
            ),
            "nextAction": "keep dashboard auto-refresh and compute evidence alive"
            if auto_refresh_ok and successful_refresh and tencent.get("hasData")
            else "restore recurring refresh/compute evidence and confirm lastRefreshOk",
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


def build_bounded_dashboard_sections(
    repo_root: Path,
    artifact_root: Path,
    generated_at: str,
) -> JsonObject:
    warnings: list[str] = []
    control_root = artifact_root / "rl-control-loop"
    conclusion_artifact = static_dashboard.load_optional_artifact(
        control_root / "conclusion-registry.json",
        warnings,
        repo_root,
    )
    latest_training = static_dashboard.latest_artifact(
        control_root,
        ("*training-ledger*.json", "*.json"),
        warnings=warnings,
        repo_root=repo_root,
        predicate=lambda path, payload: static_dashboard.artifact_kind(path, payload) == "training_ledger",
    )
    latest_policy = static_dashboard.latest_artifact(
        control_root,
        ("*policy-advantage*.json", "*.json"),
        warnings=warnings,
        repo_root=repo_root,
        predicate=lambda path, payload: static_dashboard.artifact_kind(path, payload) == "policy_advantage",
    )
    latest_metrics = static_dashboard.latest_artifact(
        control_root,
        ("*metrics-observations*.json", "*.json"),
        warnings=warnings,
        repo_root=repo_root,
        predicate=lambda path, payload: static_dashboard.artifact_kind(path, payload) == "metrics_observations",
    )
    gate = static_dashboard.latest_gate(
        static_dashboard.discover_gate_infos(
            artifact_root,
            repo_root=repo_root,
            warnings=warnings,
            latest_training=latest_training,
            latest_metrics=latest_metrics,
        )
    )
    simulator = static_dashboard.simulator_health(
        artifact_root,
        repo_root=repo_root,
        warnings=warnings,
        latest_training=latest_training,
    )
    training = static_dashboard.training_execution(
        latest_training,
        standalone_card_supply_candidates=[],
        tencent_internal_card_supply_candidates=[],
    )
    policy = static_dashboard.policy_advantage(latest_policy, latest_metrics, training=training)
    lanes = static_dashboard.lane_statuses(gate, simulator, training, policy)
    return {
        "generatedAt": generated_at,
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
        "scan": {"mode": "bounded-live-dashboard-sections"},
    }


def build_live_summary(
    repo_root: Path,
    artifact_root: Path,
    db_path: Path,
    *,
    generated_at: str | None = None,
    dashboard_url: str | None = None,
    refresh: JsonObject | None = None,
    db_summary: JsonObject | None = None,
    scan_file_limit: int = DEFAULT_SUMMARY_SCAN_FILE_LIMIT,
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
    db = db_summary if db_summary is not None else sqlite_summary(db_path, repo_root)
    health = health_with_refresh(
        health_from_db_summary(db),
        refresh_summary,
        usable_data=db_summary_has_usable_data(db),
    )
    raw_dashboard = build_bounded_dashboard_sections(repo_root, artifact_root, generated)
    dashboard = dashboard_json_safe(raw_dashboard, repo_root)
    scorecard = latest_scorecard_summary(artifact_root, repo_root, max_files=scan_file_limit)
    tencent = tencent_batch_summary_at(artifact_root, repo_root, now=generated, max_runs=scan_file_limit)
    safety = safety_summary(dashboard, tencent, scorecard)
    injection, zero_iteration, artifact_evidence_scan = artifact_evidence_summaries_with_scan(
        artifact_root,
        repo_root,
        max_files_per_root=scan_file_limit,
    )
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
        "artifactEvidenceScan": artifact_evidence_scan,
        "warnings": dashboard.get("warnings", []),
    }


def build_refreshing_summary(config: LiveDashboardConfig, dashboard_url: str, refresh: JsonObject) -> JsonObject:
    generated = utc_now_iso()
    reason = text_value(refresh.get("activeRefreshReason")) or "metrics"
    db = refreshing_db_summary(config.db_path, config.repo_root, f"{reason} refresh in progress")
    health = health_with_refresh(health_from_db_summary(db), refresh)
    flywheel_stages = [
        {
            "stage": "construction-landed",
            "status": "BLOCKED",
            "evidence": f"{reason} refresh in progress",
        }
    ]
    empty_status = {"status": "N/A", "evidence": f"{reason} refresh in progress"}
    project_gates = project_gate_summary(
        flywheel_stages=flywheel_stages,
        tencent={},
        injection=empty_status,
        zero_iteration=empty_status,
        refresh=refresh,
    )
    return {
        "type": "screeps-rl-live-dashboard",
        "generatedAt": generated,
        "repoRoot": safe_display_path(config.repo_root, config.repo_root),
        "artifactRoot": safe_display_path(config.artifact_root, config.repo_root),
        "dashboardUrl": dashboard_url,
        "health": health,
        "db": db,
        "refresh": refresh,
        "flywheelStages": flywheel_stages,
        "projectGates": project_gates,
        "runtimeCandidateInjection": empty_status,
        "zeroIterationPolicyUpdate": empty_status,
        "lanes": [],
        "e1Gate": {},
        "loopA": {"environment": {}, "training": {}},
        "loopB": {"onlineUtilityStatus": None, "policy": {}, "scorecard": {}},
        "tencentBatch": {},
        "safety": {"status": "N/A"},
        "artifactEvidenceScan": {"mode": "refresh-in-progress", "truncated": False},
        "warnings": [f"{reason} refresh in progress"],
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
        ("Latest runner state", render_status(latest_tencent.get("stateClassification"))),
        ("Latest runner age seconds", h(format_value(latest_tencent.get("activeAgeSeconds")))),
        ("Latest declared timeout seconds", h(format_value(latest_tencent.get("declaredTimeoutSeconds")))),
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
            config = self.server.config
            generated = utc_now_iso()
            refresh = self.server.refresh_snapshot()
            if refresh.get("refreshInProgress"):
                summary = self.server.summary_snapshot(self.server.dashboard_url())
                db = as_dict(summary.get("db"))
                refresh = as_dict(summary.get("refresh"))
                health = as_dict(summary.get("health"))
            else:
                acquired = self.server.refresh_lock.acquire(blocking=False)
                if not acquired:
                    refresh = self.server.refresh_snapshot()
                    if refresh.get("refreshInProgress"):
                        summary = self.server.summary_snapshot(self.server.dashboard_url())
                        db = as_dict(summary.get("db"))
                        refresh = as_dict(summary.get("refresh"))
                        health = as_dict(summary.get("health"))
                        status = HTTPStatus.OK if health["ok"] else HTTPStatus.SERVICE_UNAVAILABLE
                        self.write_json(
                            status,
                            health
                            | {
                                "message": "OK" if health["ok"] else "DEGRADED",
                                "db": db,
                                "refresh": refresh,
                                "generatedAt": generated,
                            },
                        )
                        return
                    self.server.refresh_lock.acquire()
                try:
                    db = sqlite_summary(config.db_path, config.repo_root)
                    refresh = self.server.refresh_snapshot()
                    health = health_with_refresh(
                        health_from_db_summary(db),
                        refresh,
                        usable_data=db_summary_has_usable_data(db),
                    )
                finally:
                    self.server.refresh_lock.release()
            status = HTTPStatus.OK if health["ok"] else HTTPStatus.SERVICE_UNAVAILABLE
            self.write_json(
                status,
                health
                | {
                    "message": "OK" if health["ok"] else "DEGRADED",
                    "db": db,
                    "refresh": refresh,
                    "generatedAt": generated,
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
        refresh = self.server.run_refresh_cycle("manual")
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
        return self.server.summary_snapshot(self.server.dashboard_url())

    def write_json(self, status: HTTPStatus, payload: JsonObject) -> None:
        body = (json.dumps(payload, sort_keys=True, ensure_ascii=True) + "\n").encode("utf-8")
        self.write_response(status, "application/json; charset=utf-8", body)

    def write_html(self, status: HTTPStatus, body_text: str) -> None:
        body = body_text.encode("utf-8")
        self.write_response(status, "text/html; charset=utf-8", body)

    def write_response(self, status: HTTPStatus, content_type: str, body: bytes) -> bool:
        try:
            self.send_response(status.value)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return True
        except ClientDisconnectError:
            self.close_connection = True
            return False


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
        initial_refresh_required=bool(getattr(args, "refresh_on_start", False)),
        summary_cache_seconds=max(0.0, float(getattr(args, "summary_cache_seconds", DEFAULT_SUMMARY_CACHE_SECONDS))),
        summary_scan_file_limit=max(0, int(getattr(args, "summary_scan_file_limit", DEFAULT_SUMMARY_SCAN_FILE_LIMIT))),
        ingest_file_limit_per_root=max(
            0,
            int(getattr(args, "ingest_file_limit_per_root", DEFAULT_INGEST_FILE_LIMIT_PER_ROOT)),
        ),
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
    parser.add_argument(
        "--summary-scan-file-limit",
        type=int,
        default=DEFAULT_SUMMARY_SCAN_FILE_LIMIT,
        help="Newest JSON/controller files to inspect per live-summary source.",
    )
    parser.add_argument(
        "--ingest-file-limit-per-root",
        type=int,
        default=DEFAULT_INGEST_FILE_LIMIT_PER_ROOT,
        help="Newest artifact files to ingest per default source root when no explicit paths are supplied.",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Serve or inspect the local Screeps RL live dashboard.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve = subparsers.add_parser("serve", help="serve the live dashboard over HTTP")
    add_common_args(serve)
    serve.add_argument("--host", default=DEFAULT_HOST, help="Bind host.")
    serve.add_argument("--port", type=int, default=DEFAULT_PORT, help="Bind port.")
    serve.add_argument(
        "--refresh-on-start",
        action="store_true",
        help="Run the metrics ingestor in the background after binding and before reporting healthy.",
    )
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
    serve.add_argument(
        "--summary-cache-seconds",
        type=float,
        default=DEFAULT_SUMMARY_CACHE_SECONDS,
        help="Seconds to cache /api/summary and HTML summary data. Use 0 to disable.",
    )

    refresh = subparsers.add_parser("refresh", help="refresh the SQLite metrics database with the ingestor")
    add_common_args(refresh)
    refresh.add_argument("paths", nargs="*", type=Path, help="Optional artifact files/directories to ingest.")

    summary = subparsers.add_parser("summary", help="print the live dashboard summary JSON")
    add_common_args(summary)

    health = subparsers.add_parser("healthcheck", help="check a running dashboard /healthz endpoint")
    health.add_argument("--url", default=DEFAULT_HEALTHCHECK_URL, help="Health URL.")
    health.add_argument("--timeout", type=float, default=5.0, help="HTTP timeout seconds.")

    acceptance = subparsers.add_parser("acceptance", help="verify the running owner-facing dashboard surface")
    acceptance.add_argument("--url", default=DEFAULT_DASHBOARD_URL, help="Dashboard base URL.")
    acceptance.add_argument("--timeout", type=float, default=5.0, help="HTTP timeout seconds.")
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


class DashboardReachabilityError(RuntimeError):
    """Raised when the live dashboard service cannot be reached."""


def dashboard_endpoint_url(base_url: str, path: str) -> str:
    parsed = urlparse(base_url)
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}{path}"
    if parsed.netloc:
        return f"http://{parsed.netloc}{path}"
    if parsed.path:
        return f"http://{parsed.path.rstrip('/')}{path}"
    return f"{DEFAULT_DASHBOARD_URL.rstrip('/')}{path}"


def read_acceptance_json_url(url: str, timeout: float) -> tuple[int, JsonObject]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
            status = int(response.status)
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(body) if body.strip() else {"ok": False, "status": error.code}
        except json.JSONDecodeError:
            payload = {"ok": False, "status": error.code, "body": body.strip()}
        status = int(error.code)
    except urllib.error.URLError as error:
        reason = getattr(error, "reason", error)
        raise DashboardReachabilityError(
            f"live dashboard service is not running/reachable at {url}; "
            f"start `npm run rl-dashboard-live` first ({reason})"
        ) from error
    except (OSError, json.JSONDecodeError) as error:
        raise DashboardReachabilityError(
            f"live dashboard service is not running/reachable at {url}; "
            f"start `npm run rl-dashboard-live` first ({error})"
        ) from error
    if not isinstance(payload, dict):
        raise DashboardReachabilityError(f"{url} did not return a JSON object")
    return status, payload


def acceptance_check(label: str, ok: bool, evidence: str) -> JsonObject:
    return {"name": label, "ok": bool(ok), "evidence": evidence}


def acceptance_http_timeout(deadline: float, default_timeout: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return 0.05
    return max(0.05, min(default_timeout, remaining))


def refresh_is_in_progress(payload: JsonObject) -> bool:
    refresh = payload.get("refresh") if isinstance(payload.get("refresh"), dict) else {}
    return refresh.get("refreshInProgress") is True


def validate_acceptance_summary(health: JsonObject, summary: JsonObject) -> list[JsonObject]:
    db = summary.get("db") if isinstance(summary.get("db"), dict) else {}
    refresh = summary.get("refresh") if isinstance(summary.get("refresh"), dict) else {}
    loop_a = summary.get("loopA") if isinstance(summary.get("loopA"), dict) else {}
    loop_b = summary.get("loopB") if isinstance(summary.get("loopB"), dict) else {}
    tencent = summary.get("tencentBatch") if isinstance(summary.get("tencentBatch"), dict) else {}
    safety = summary.get("safety") if isinstance(summary.get("safety"), dict) else {}
    checks = [
        acceptance_check("/healthz ok=true", health.get("ok") is True, f"ok={health.get('ok')}; failures={health.get('failures', [])}"),
        acceptance_check("summary.dashboardUrl", bool(summary.get("dashboardUrl")), str(summary.get("dashboardUrl") or "missing")),
        acceptance_check("db.path", bool(db.get("path")), str(db.get("path") or "missing")),
        acceptance_check("db.tables", isinstance(db.get("tables"), dict) and bool(db.get("tables")), f"tables={len(db.get('tables', {}) if isinstance(db.get('tables'), dict) else {})}"),
        acceptance_check("db.latestObservedAt", bool(db.get("latestObservedAt")), str(db.get("latestObservedAt") or "missing")),
        acceptance_check("refresh.lastRefreshOk", refresh.get("lastRefreshOk") is True, f"lastRefreshOk={refresh.get('lastRefreshOk')}"),
        acceptance_check("refresh.lastRefreshAt", bool(refresh.get("lastRefreshAt")), str(refresh.get("lastRefreshAt") or "missing")),
        acceptance_check("E1 gate visible", isinstance(summary.get("e1Gate"), dict) and bool(summary.get("e1Gate")), f"type={type(summary.get('e1Gate')).__name__}"),
        acceptance_check("Loop A visible", isinstance(loop_a.get("environment"), dict) and isinstance(loop_a.get("training"), dict), f"keys={sorted(loop_a.keys())}"),
        acceptance_check("Loop B visible", isinstance(loop_b.get("policy"), dict) and isinstance(loop_b.get("scorecard"), dict), f"keys={sorted(loop_b.keys())}"),
        acceptance_check("Tencent utilization visible", isinstance(tencent, dict) and bool(tencent), f"keys={sorted(tencent.keys())}"),
        acceptance_check("scorecard visible", isinstance(loop_b.get("scorecard"), dict) and bool(loop_b.get("scorecard")), f"keys={sorted((loop_b.get('scorecard') or {}).keys()) if isinstance(loop_b.get('scorecard'), dict) else []}"),
        acceptance_check("safety visible", isinstance(safety, dict) and bool(safety), f"keys={sorted(safety.keys())}"),
        acceptance_check("project gates visible", isinstance(summary.get("projectGates"), list) and bool(summary.get("projectGates")), f"count={len(summary.get('projectGates', [])) if isinstance(summary.get('projectGates'), list) else 0}"),
    ]
    return checks


def run_acceptance(base_url: str, timeout: float) -> int:
    health_url = dashboard_endpoint_url(base_url, "/healthz")
    summary_url = dashboard_endpoint_url(base_url, "/api/summary")
    deadline = time.monotonic() + max(0.0, timeout)
    last_health_status: int | None = None
    last_health: JsonObject | None = None
    try:
        while True:
            request_timeout = acceptance_http_timeout(deadline, timeout)
            health_status, health = read_acceptance_json_url(health_url, request_timeout)
            last_health_status = health_status
            last_health = health
            if health_status == HTTPStatus.OK and health.get("ok") is True:
                break
            if not refresh_is_in_progress(health) or time.monotonic() >= deadline:
                checks = [
                    acceptance_check("/healthz reachable", health_status == HTTPStatus.OK, f"status={health_status}"),
                    acceptance_check(
                        "/healthz ok=true",
                        health.get("ok") is True,
                        f"ok={health.get('ok')}; failures={health.get('failures', [])}",
                    ),
                ]
                print(
                    json.dumps(
                        {
                            "ok": False,
                            "message": "FAIL",
                            "dashboardUrl": None,
                            "healthUrl": health_url,
                            "summaryUrl": summary_url,
                            "db": health.get("db"),
                            "refresh": health.get("refresh"),
                            "checks": checks,
                        },
                        sort_keys=True,
                    )
                )
                return 1
            time.sleep(min(0.25, max(0.01, deadline - time.monotonic())))
        summary_status, summary = read_acceptance_json_url(
            summary_url,
            acceptance_http_timeout(deadline, timeout),
        )
    except DashboardReachabilityError as error:
        print(json.dumps({"ok": False, "message": "FAIL", "error": str(error)}, sort_keys=True))
        return 1
    if last_health_status is None or last_health is None:
        print(json.dumps({"ok": False, "message": "FAIL", "error": "health check was not attempted"}, sort_keys=True))
        return 1
    checks = [
        acceptance_check("/healthz reachable", last_health_status == HTTPStatus.OK, f"status={last_health_status}"),
        acceptance_check("/api/summary reachable", summary_status == HTTPStatus.OK, f"status={summary_status}"),
    ]
    checks.extend(validate_acceptance_summary(last_health, summary))
    ok = all(check["ok"] for check in checks)
    result = {
        "ok": ok,
        "message": "PASS" if ok else "FAIL",
        "dashboardUrl": summary.get("dashboardUrl"),
        "healthUrl": health_url,
        "summaryUrl": summary_url,
        "db": summary.get("db"),
        "refresh": summary.get("refresh"),
        "checks": checks,
    }
    print(json.dumps(result, sort_keys=True))
    return 0 if ok else 1


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "healthcheck":
        return run_healthcheck(args.url, args.timeout)
    if args.command == "acceptance":
        return run_acceptance(args.url, args.timeout)

    config = build_config(args)
    if args.command == "refresh":
        paths = [resolve_path(path, config.repo_root) for path in args.paths]
        result = refresh_metrics(
            config.db_path,
            config.artifact_root,
            paths,
            max_files_per_root=config.ingest_file_limit_per_root,
        )
        print(json.dumps(result, sort_keys=True))
        return 0 if refresh_succeeded(result) else 1
    if args.command == "summary":
        print(
            json.dumps(
                build_live_summary(
                    config.repo_root,
                    config.artifact_root,
                    config.db_path,
                    scan_file_limit=config.summary_scan_file_limit,
                ),
                sort_keys=True,
            )
        )
        return 0
    if args.command == "serve":
        server = make_server(args.host, args.port, config)
        if args.refresh_on_start:
            server.start_background_refresh("startup")
        print(f"Serving Screeps RL live dashboard at {server.dashboard_url()}")
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
