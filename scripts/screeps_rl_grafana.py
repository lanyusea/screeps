#!/usr/bin/env python3
"""Validate and run the local Grafana surface for Screeps RL metrics."""

from __future__ import annotations

import argparse
import json
import re
import shlex
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DATASOURCE_UID = "screeps-rl-metrics-sqlite"
DATASOURCE_TYPE = "frser-sqlite-datasource"
DATASOURCE_NAME = "Screeps RL Metrics SQLite"
DASHBOARD_UID = "screeps-rl-gameplay-metrics"
DASHBOARD_TITLE = "Screeps RL Gameplay Metrics"
DASHBOARD_SLUG = "screeps-rl-gameplay-metrics"
DEFAULT_GRAFANA_URL = "http://127.0.0.1:3000"
DEFAULT_GRAFANA_IMAGE = "grafana/grafana-oss:11.5.2"
DEFAULT_GRAFANA_PLUGIN = DATASOURCE_TYPE
DEFAULT_CONTAINER_NAME = "screeps-rl-grafana"
DEFAULT_DOCKER_RESTART_POLICY = "unless-stopped"
CONTAINER_DB_PATH = "/var/lib/grafana/rl-metrics/rl_metrics.sqlite"
CONTAINER_DASHBOARD_PATH = "/var/lib/grafana/dashboards/screeps"
CONTAINER_PROVISIONING_PATH = "/etc/grafana/provisioning"
LOCAL_GRAFANA_HOSTS = {"127.0.0.1", "localhost", "::1"}
TIME_SERIES_FORMAT = "time_series"
TIME_SERIES_QUERY_TYPE = "time series"
TABLE_QUERY_TYPE = "table"
TIME_SERIES_TIME_COLUMNS = ["time"]
CONTENT_READY = "ready"
CONTENT_WAITING_FOR_DATA = "waiting_for_data"
CONTENT_NOT_INSTRUMENTED = "not_instrumented"
CONTENT_MISCONFIGURED = "misconfigured"

SQL_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
SQL_STRING_RE = re.compile(r"'((?:''|[^'])*)'")
SQL_TABLE_RE = re.compile(r"\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)", re.IGNORECASE)

RUNTIME_ROOM_COLUMN_METRICS = {
    "build_carried_energy": "construction.build_carried_energy",
    "build_blocked_reason": "construction.build_blocked_reason",
    "construction_site_count": "construction.site_count",
    "construction_deadlock_ticks": "construction.deadlock_ticks",
    "destination_blocked": "creep.destination_blocked",
    "extension_capacity_contribution": "economy.extension_capacity_contribution",
    "extension_count": "economy.extension_count",
    "path_finding_failures": "creep.path_finding_failures",
    "pending_build_progress": "construction.pending_build_progress",
    "worker_load_trip_energy_mean": "creep.worker_load_trip_energy_mean",
    "worker_load_trip_energy_min": "creep.worker_load_trip_energy_min",
}

REQUIRED_QUERY_COVERAGE = {
    "metric observation history": "FROM metric_observations",
    "runtime room metrics": "FROM runtime_room_metrics",
    "gameplay behavior findings": "FROM gameplay_behavior_findings",
    "metric coverage gaps": "FROM metric_coverage_gaps",
    "E1 dataset gate metrics": "FROM rl_dataset_gate_metrics",
    "Loop A training execution metrics": "FROM rl_training_execution_metrics",
    "Loop B policy advantage metrics": "FROM rl_policy_advantage_metrics",
    "RL iteration decisions": "FROM metric_iteration_decisions",
    "metrics refresh proof": "source.rl_metrics_refresh.completed",
}


JsonObject = dict[str, Any]


class HostBindingError(ValueError):
    """Raised when Grafana would be exposed beyond loopback by default."""


def validate_host_binding(host: str, allow_nonlocal: bool) -> None:
    if allow_nonlocal or host in LOCAL_GRAFANA_HOSTS:
        return
    allowed_hosts = ", ".join(sorted(LOCAL_GRAFANA_HOSTS))
    raise HostBindingError(
        f"refusing non-local host binding {host!r} without --allow-nonlocal; "
        f"allowed local hosts: {allowed_hosts}"
    )


def docker_port_binding(host: str, port: int) -> str:
    if ":" in host and not host.startswith("["):
        return f"[{host}]:{port}:3000"
    return f"{host}:{port}:3000"


def host_binding_error(error: HostBindingError) -> int:
    print(f"ERROR: {error}", file=sys.stderr)
    return 2


def default_repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def grafana_root(repo_root: Path) -> Path:
    return repo_root / "docs" / "ops" / "grafana"


def datasource_file(repo_root: Path) -> Path:
    return grafana_root(repo_root) / "provisioning" / "datasources" / "screeps-rl-sqlite.yaml"


def dashboard_provider_file(repo_root: Path) -> Path:
    return grafana_root(repo_root) / "provisioning" / "dashboards" / "screeps-rl-dashboards.yaml"


def dashboard_file(repo_root: Path) -> Path:
    return grafana_root(repo_root) / "screeps-rl-gameplay-metrics.json"


def default_db_path(repo_root: Path) -> Path:
    return repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"


def check_result(name: str, status: str, details: str) -> JsonObject:
    return {"name": name, "status": status, "details": details}


def append_check(report: JsonObject, name: str, ok: bool, details: str) -> None:
    status = "PASS" if ok else "FAIL"
    report["checks"].append(check_result(name, status, details))
    if not ok:
        report["errors"].append(f"{name}: {details}")


def read_json(path: Path) -> JsonObject:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def iter_panels(panels: Any) -> list[JsonObject]:
    result: list[JsonObject] = []
    if not isinstance(panels, list):
        return result
    for panel in panels:
        if not isinstance(panel, dict):
            continue
        result.append(panel)
        result.extend(iter_panels(panel.get("panels")))
    return result


def panel_queries(panels: list[JsonObject]) -> list[str]:
    queries: list[str] = []
    for panel in panels:
        targets = panel.get("targets", [])
        if not isinstance(targets, list):
            continue
        for target in targets:
            if not isinstance(target, dict):
                continue
            query_text = target.get("queryText")
            if isinstance(query_text, str):
                queries.append(query_text)
    return queries


def sqlite_string_values(text: str) -> list[str]:
    return [match.group(1).replace("''", "'") for match in SQL_STRING_RE.finditer(text)]


def filter_values_from_query(query_text: str, column_name: str) -> list[str]:
    values: list[str] = []
    escaped_column = re.escape(column_name)
    equals_pattern = re.compile(
        rf"\b{escaped_column}\s*=\s*'((?:''|[^'])*)'",
        re.IGNORECASE,
    )
    in_pattern = re.compile(
        rf"\b{escaped_column}\s+IN\s*\(([^)]*)\)",
        re.IGNORECASE,
    )
    values.extend(match.group(1).replace("''", "'") for match in equals_pattern.finditer(query_text))
    for match in in_pattern.finditer(query_text):
        values.extend(sqlite_string_values(match.group(1)))
    return sorted(set(values))


def metric_names_from_query(query_text: str) -> list[str]:
    return filter_values_from_query(query_text, "metric_name")


def categories_from_query(query_text: str) -> list[str]:
    return filter_values_from_query(query_text, "category")


def tables_from_query(query_text: str) -> list[str]:
    return sorted({match.group(1) for match in SQL_TABLE_RE.finditer(query_text)})


def runtime_room_columns_from_query(query_text: str) -> list[str]:
    lowered = query_text.lower()
    columns = []
    for column_name in RUNTIME_ROOM_COLUMN_METRICS:
        if re.search(rf"\b{re.escape(column_name)}\b", lowered):
            columns.append(column_name)
    return sorted(columns)


def strip_sql_statement(query_text: str) -> str:
    return query_text.strip().rstrip(";").strip()


def query_row_count(conn: sqlite3.Connection, query_text: str) -> int:
    query = strip_sql_statement(query_text)
    if not query:
        raise sqlite3.OperationalError("empty queryText")
    row = conn.execute(f"SELECT COUNT(*) AS row_count FROM ({query}) AS grafana_target").fetchone()
    if row is None:
        return 0
    return int(row["row_count"])


def table_row_count(conn: sqlite3.Connection, table_name: str) -> int | None:
    if not SQL_IDENTIFIER_RE.match(table_name):
        return None
    try:
        row = conn.execute(f"SELECT COUNT(*) AS row_count FROM {table_name}").fetchone()
    except sqlite3.Error:
        return None
    if row is None:
        return 0
    return int(row["row_count"])


def metric_observation_counts(conn: sqlite3.Connection, metric_names: list[str]) -> dict[str, int]:
    if not metric_names:
        return {}
    placeholders = ", ".join("?" for _ in metric_names)
    try:
        rows = conn.execute(
            f"""
            SELECT metric_name, COUNT(*) AS row_count
            FROM metric_observations
            WHERE metric_name IN ({placeholders})
            GROUP BY metric_name
            """,
            metric_names,
        ).fetchall()
    except sqlite3.Error:
        return {}
    counts = {metric_name: 0 for metric_name in metric_names}
    counts.update({str(row["metric_name"]): int(row["row_count"]) for row in rows})
    return counts


def metric_coverage_gap_counts(conn: sqlite3.Connection, metric_names: list[str]) -> dict[str, int]:
    if not metric_names:
        return {}
    placeholders = ", ".join("?" for _ in metric_names)
    try:
        rows = conn.execute(
            f"""
            SELECT metric_name, COUNT(*) AS gap_count
            FROM metric_coverage_gaps
            WHERE metric_name IN ({placeholders})
            GROUP BY metric_name
            """,
            metric_names,
        ).fetchall()
    except sqlite3.Error:
        return {}
    return {str(row["metric_name"]): int(row["gap_count"]) for row in rows}


def runtime_room_non_null_count(conn: sqlite3.Connection, column_names: list[str]) -> int | None:
    safe_columns = [column_name for column_name in column_names if column_name in RUNTIME_ROOM_COLUMN_METRICS]
    if not safe_columns:
        return None
    predicate = " OR ".join(f"{column_name} IS NOT NULL" for column_name in safe_columns)
    try:
        row = conn.execute(
            f"SELECT COUNT(*) AS row_count FROM runtime_room_metrics WHERE {predicate}"
        ).fetchone()
    except sqlite3.Error:
        return None
    if row is None:
        return 0
    return int(row["row_count"])


def classify_empty_target(conn: sqlite3.Connection, query_text: str) -> tuple[str, str, JsonObject]:
    metric_names = metric_names_from_query(query_text)
    runtime_columns = runtime_room_columns_from_query(query_text)
    tables = tables_from_query(query_text)
    categories = categories_from_query(query_text)
    evidence: JsonObject = {
        "tables": tables,
        "metricNames": metric_names,
        "runtimeRoomColumns": runtime_columns,
        "categories": categories,
    }

    if "metric_observations" in tables and metric_names:
        total_metric_rows = table_row_count(conn, "metric_observations")
        observation_counts = metric_observation_counts(conn, metric_names)
        gap_counts = metric_coverage_gap_counts(conn, metric_names)
        missing_metrics = [metric_name for metric_name in metric_names if observation_counts.get(metric_name, 0) == 0]
        evidence["metricObservationCounts"] = observation_counts
        evidence["metricCoverageGapCounts"] = gap_counts
        if total_metric_rows == 0:
            return (
                CONTENT_WAITING_FOR_DATA,
                "metric_observations has no rows yet; refresh/ingest runtime artifacts before judging this panel",
                evidence,
            )
        if missing_metrics:
            gap_suffix = ""
            gap_metrics = [metric_name for metric_name in missing_metrics if gap_counts.get(metric_name, 0) > 0]
            if gap_metrics:
                gap_suffix = f"; coverage gaps recorded for {', '.join(gap_metrics)}"
            return (
                CONTENT_NOT_INSTRUMENTED,
                f"no metric_observations rows for metric streams {', '.join(missing_metrics)}{gap_suffix}",
                evidence,
            )

    if "runtime_room_metrics" in tables and runtime_columns:
        runtime_rows = table_row_count(conn, "runtime_room_metrics")
        populated_rows = runtime_room_non_null_count(conn, runtime_columns)
        runtime_metrics = [RUNTIME_ROOM_COLUMN_METRICS[column_name] for column_name in runtime_columns]
        evidence["runtimeRoomRowCount"] = runtime_rows
        evidence["runtimeRoomNonNullRows"] = populated_rows
        evidence["runtimeMetricNames"] = runtime_metrics
        if runtime_rows == 0:
            return (
                CONTENT_WAITING_FOR_DATA,
                "runtime_room_metrics has no rows yet; refresh/ingest runtime artifacts before judging this panel",
                evidence,
            )
        if populated_rows == 0:
            return (
                CONTENT_NOT_INSTRUMENTED,
                f"runtime_room_metrics columns have no non-null samples: {', '.join(runtime_columns)}",
                evidence,
            )

    if "gameplay_behavior_findings" in tables:
        total_findings = table_row_count(conn, "gameplay_behavior_findings")
        category_detail = f" for categories {', '.join(categories)}" if categories else ""
        evidence["gameplayBehaviorFindingCount"] = total_findings
        if total_findings == 0:
            return (
                CONTENT_WAITING_FOR_DATA,
                f"gameplay_behavior_findings has no rows yet{category_detail}",
                evidence,
            )
        return (
            CONTENT_NOT_INSTRUMENTED,
            f"no gameplay behavior findings match{category_detail}; table has {total_findings} total row(s)",
            evidence,
        )

    empty_source_tables = [table_name for table_name in tables if table_row_count(conn, table_name) == 0]
    if empty_source_tables:
        evidence["emptySourceTables"] = empty_source_tables
        return (
            CONTENT_WAITING_FOR_DATA,
            f"source table has no rows yet: {', '.join(empty_source_tables)}",
            evidence,
        )

    return (
        CONTENT_WAITING_FOR_DATA,
        "query returned zero rows; source tables exist but no matching samples are present yet",
        evidence,
    )


def target_content_audit(conn: sqlite3.Connection, panel: JsonObject, target: JsonObject) -> JsonObject:
    ref_id = target.get("refId")
    query_text = target.get("queryText")
    target_report: JsonObject = {
        "refId": ref_id if isinstance(ref_id, str) else None,
        "state": CONTENT_MISCONFIGURED,
        "rowCount": 0,
        "details": "target has no queryText",
        "evidence": {},
    }
    if not isinstance(query_text, str) or not query_text.strip():
        return target_report
    try:
        row_count = query_row_count(conn, query_text)
    except sqlite3.Error as error:
        target_report["details"] = f"query failed: {error}"
        target_report["evidence"] = {
            "tables": tables_from_query(query_text),
            "metricNames": metric_names_from_query(query_text),
            "runtimeRoomColumns": runtime_room_columns_from_query(query_text),
            "categories": categories_from_query(query_text),
        }
        return target_report

    target_report["rowCount"] = row_count
    if row_count > 0:
        target_report["state"] = CONTENT_READY
        target_report["details"] = f"query returned {row_count} row(s)"
        target_report["evidence"] = {
            "tables": tables_from_query(query_text),
            "metricNames": metric_names_from_query(query_text),
            "runtimeRoomColumns": runtime_room_columns_from_query(query_text),
            "categories": categories_from_query(query_text),
        }
        return target_report

    state, details, evidence = classify_empty_target(conn, query_text)
    target_report["state"] = state
    target_report["details"] = details
    target_report["evidence"] = evidence
    return target_report


def combined_content_state(states: list[str]) -> str:
    if any(state == CONTENT_MISCONFIGURED for state in states):
        return CONTENT_MISCONFIGURED
    if any(state == CONTENT_READY for state in states):
        return CONTENT_READY
    if any(state == CONTENT_NOT_INSTRUMENTED for state in states):
        return CONTENT_NOT_INSTRUMENTED
    return CONTENT_WAITING_FOR_DATA


def overall_content_state(states: list[str]) -> str:
    if any(state == CONTENT_MISCONFIGURED for state in states):
        return CONTENT_MISCONFIGURED
    if any(state == CONTENT_NOT_INSTRUMENTED for state in states):
        return CONTENT_NOT_INSTRUMENTED
    if any(state == CONTENT_WAITING_FOR_DATA for state in states):
        return CONTENT_WAITING_FOR_DATA
    return CONTENT_READY


def panel_content_audit(conn: sqlite3.Connection, panel: JsonObject) -> JsonObject:
    targets = panel.get("targets", [])
    if not isinstance(targets, list) or not targets:
        return {
            "id": panel.get("id"),
            "title": panel.get("title"),
            "type": panel.get("type"),
            "state": CONTENT_MISCONFIGURED,
            "rowCount": 0,
            "details": "panel has no targets",
            "targets": [],
        }

    target_reports = [
        target_content_audit(conn, panel, target)
        for target in targets
        if isinstance(target, dict)
    ]
    target_states = [str(target_report["state"]) for target_report in target_reports]
    panel_state = combined_content_state(target_states)
    row_count = sum(int(target_report.get("rowCount") or 0) for target_report in target_reports)
    non_ready_details = [
        f"{target_report.get('refId') or '?'}: {target_report['details']}"
        for target_report in target_reports
        if target_report.get("state") != CONTENT_READY
    ]
    details = (
        f"{row_count} total row(s) across {len(target_reports)} target(s)"
        if panel_state == CONTENT_READY
        else "; ".join(non_ready_details)
    )
    return {
        "id": panel.get("id"),
        "title": panel.get("title"),
        "type": panel.get("type"),
        "state": panel_state,
        "rowCount": row_count,
        "details": details,
        "targets": target_reports,
    }


def audit_content(repo_root: Path, db_path: Path) -> JsonObject:
    repo_root = repo_root.resolve()
    db_path = db_path.resolve()
    report: JsonObject = {
        "status": "PASS",
        "contentState": CONTENT_READY,
        "repoRoot": str(repo_root),
        "dbPath": str(db_path),
        "dashboardPath": str(dashboard_file(repo_root)),
        "checks": [],
        "errors": [],
        "warnings": [],
        "panels": [],
        "contentStateCounts": {
            CONTENT_READY: 0,
            CONTENT_WAITING_FOR_DATA: 0,
            CONTENT_NOT_INSTRUMENTED: 0,
            CONTENT_MISCONFIGURED: 0,
        },
    }

    dashboard_path = dashboard_file(repo_root)
    append_check(report, "dashboard JSON file", dashboard_path.is_file(), f"{dashboard_path} must exist")
    append_check(report, "metrics DB file", db_path.is_file(), f"{db_path} must exist")
    if report["errors"]:
        report["status"] = "FAIL"
        report["contentState"] = CONTENT_WAITING_FOR_DATA if not db_path.is_file() else CONTENT_MISCONFIGURED
        return report

    try:
        dashboard = read_json(dashboard_path)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        append_check(report, "dashboard JSON parses", False, str(error))
        report["status"] = "FAIL"
        report["contentState"] = CONTENT_MISCONFIGURED
        return report

    dashboard_report = validate_dashboard_payload(dashboard, dashboard_path)
    if dashboard_report["errors"]:
        report["checks"].extend(dashboard_report["checks"])
        report["errors"].extend(dashboard_report["errors"])
        report["warnings"].extend(dashboard_report["warnings"])
        report["status"] = "FAIL"
        report["contentState"] = CONTENT_MISCONFIGURED
        return report

    try:
        conn = sqlite3.connect(f"{db_path.as_uri()}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
    except sqlite3.Error as error:
        append_check(report, "metrics DB opens read-only", False, str(error))
        report["status"] = "FAIL"
        report["contentState"] = CONTENT_MISCONFIGURED
        return report

    try:
        panels = iter_panels(dashboard.get("panels"))
        panel_reports = [panel_content_audit(conn, panel) for panel in panels]
    finally:
        conn.close()

    for panel_report in panel_reports:
        state = str(panel_report.get("state"))
        if state in report["contentStateCounts"]:
            report["contentStateCounts"][state] += 1
    report["panels"] = panel_reports
    report["panelCount"] = len(panel_reports)
    report["emptyPanelCount"] = sum(1 for panel_report in panel_reports if int(panel_report.get("rowCount") or 0) == 0)
    report["classifiedEmptyPanelCount"] = sum(
        1
        for panel_report in panel_reports
        if int(panel_report.get("rowCount") or 0) == 0 and panel_report.get("state") != CONTENT_MISCONFIGURED
    )
    report["contentState"] = overall_content_state([str(panel_report.get("state")) for panel_report in panel_reports])
    if report["contentStateCounts"][CONTENT_MISCONFIGURED] > 0:
        report["status"] = "FAIL"
        for panel_report in panel_reports:
            if panel_report.get("state") == CONTENT_MISCONFIGURED:
                report["errors"].append(
                    f"panel {panel_report.get('id')} {panel_report.get('title')}: {panel_report.get('details')}"
                )
    return report


def is_time_series_target(panel: JsonObject, target: JsonObject) -> bool:
    return panel.get("type") == "timeseries" or target.get("format") == TIME_SERIES_FORMAT


def validate_dashboard_targets(panels: list[JsonObject]) -> list[str]:
    errors: list[str] = []
    for panel in panels:
        targets = panel.get("targets", [])
        if not isinstance(targets, list):
            errors.append(f"panel {panel.get('id')} targets must be a list")
            continue
        for index, target in enumerate(targets):
            if not isinstance(target, dict):
                errors.append(f"panel {panel.get('id')} target {index} must be an object")
                continue
            target_label = f"panel {panel.get('id')} target {target.get('refId', index)}"
            query_text = target.get("queryText")
            if not isinstance(query_text, str) or not query_text.strip():
                errors.append(f"{target_label} must define non-empty queryText")
                continue
            if target.get("rawQueryText") != query_text:
                errors.append(f"{target_label} rawQueryText must exactly match queryText")
            expected_query_type = TIME_SERIES_QUERY_TYPE if is_time_series_target(panel, target) else TABLE_QUERY_TYPE
            if target.get("queryType") != expected_query_type:
                errors.append(f"{target_label} queryType must be {expected_query_type!r}")
            if expected_query_type == TIME_SERIES_QUERY_TYPE and target.get("timeColumns") != TIME_SERIES_TIME_COLUMNS:
                errors.append(f"{target_label} timeColumns must be {TIME_SERIES_TIME_COLUMNS!r}")
    return errors


def validate_dashboard_payload(dashboard: JsonObject, path: Path) -> JsonObject:
    report: JsonObject = {"status": "PASS", "checks": [], "errors": [], "warnings": []}

    append_check(report, "dashboard uid", dashboard.get("uid") == DASHBOARD_UID, f"{path} uid must be {DASHBOARD_UID}")
    append_check(
        report,
        "dashboard title",
        dashboard.get("title") == DASHBOARD_TITLE,
        f"{path} title must be {DASHBOARD_TITLE}",
    )

    panels = iter_panels(dashboard.get("panels"))
    append_check(report, "dashboard panels", len(panels) > 0, f"{path} must define at least one panel")

    panel_ids = [panel.get("id") for panel in panels if isinstance(panel.get("id"), int)]
    append_check(
        report,
        "dashboard panel ids",
        len(panel_ids) == len(set(panel_ids)) == len(panels),
        "every panel must have a unique integer id",
    )

    datasource_errors = []
    for panel in panels:
        datasource = panel.get("datasource")
        if not isinstance(datasource, dict):
            datasource_errors.append(f"panel {panel.get('id')} has no datasource object")
            continue
        if datasource.get("uid") != DATASOURCE_UID or datasource.get("type") != DATASOURCE_TYPE:
            datasource_errors.append(f"panel {panel.get('id')} does not use {DATASOURCE_UID}/{DATASOURCE_TYPE}")
    append_check(
        report,
        "dashboard datasource binding",
        not datasource_errors,
        "; ".join(datasource_errors) if datasource_errors else "all panels use the provisioned SQLite datasource",
    )

    target_errors = validate_dashboard_targets(panels)
    append_check(
        report,
        "dashboard frser SQLite target contract",
        not target_errors,
        "; ".join(target_errors)
        if target_errors
        else "all targets preserve rawQueryText, queryType, and timeColumns where required",
    )

    queries = "\n".join(panel_queries(panels))
    for name, required_fragment in REQUIRED_QUERY_COVERAGE.items():
        append_check(
            report,
            f"dashboard query coverage: {name}",
            required_fragment in queries,
            f"dashboard queries must include {required_fragment}",
        )

    report["panelCount"] = len(panels)
    report["queryCount"] = len(panel_queries(panels))
    report["status"] = "FAIL" if report["errors"] else "PASS"
    return report


def validate_static(repo_root: Path) -> JsonObject:
    repo_root = repo_root.resolve()
    report: JsonObject = {
        "status": "PASS",
        "repoRoot": str(repo_root),
        "grafanaUrl": DEFAULT_GRAFANA_URL,
        "datasourceUid": DATASOURCE_UID,
        "datasourceType": DATASOURCE_TYPE,
        "dashboardUid": DASHBOARD_UID,
        "checks": [],
        "errors": [],
        "warnings": [],
    }

    datasource_path = datasource_file(repo_root)
    dashboard_provider_path = dashboard_provider_file(repo_root)
    dashboard_path = dashboard_file(repo_root)
    db_path = default_db_path(repo_root)

    for name, path in (
        ("datasource provisioning file", datasource_path),
        ("dashboard provisioning file", dashboard_provider_path),
        ("dashboard JSON file", dashboard_path),
    ):
        append_check(report, name, path.is_file(), f"{path} must exist")

    if datasource_path.is_file():
        datasource_text = datasource_path.read_text(encoding="utf-8")
        datasource_requirements = {
            "apiVersion: 1": "Grafana provisioning API version",
            "datasources:": "datasource list",
            f"name: {DATASOURCE_NAME}": "datasource display name",
            f"uid: {DATASOURCE_UID}": "stable datasource UID",
            f"type: {DATASOURCE_TYPE}": "SQLite datasource plugin id",
            "access: proxy": "server-side datasource access",
            "isDefault: true": "default local datasource",
            "editable: false": "tracked provisioning is authoritative",
            f"path: {CONTAINER_DB_PATH}": "container-visible SQLite path",
        }
        for required_text, description in datasource_requirements.items():
            append_check(
                report,
                f"datasource provisioning: {description}",
                required_text in datasource_text,
                f"{datasource_path} must include {required_text}",
            )
        secret_markers = ("secureJsonData", "password:", "token:", "basicAuthUser", "basicAuthPassword")
        append_check(
            report,
            "datasource provisioning has no secrets",
            not any(marker in datasource_text for marker in secret_markers),
            f"{datasource_path} must not contain credentials",
        )

    if dashboard_provider_path.is_file():
        provider_text = dashboard_provider_path.read_text(encoding="utf-8")
        provider_requirements = {
            "apiVersion: 1": "Grafana provisioning API version",
            "providers:": "dashboard provider list",
            "name: screeps-rl-dashboards": "dashboard provider name",
            "folder: Screeps RL": "dashboard folder",
            "type: file": "file-backed dashboard provider",
            f"path: {CONTAINER_DASHBOARD_PATH}": "container-visible dashboard path",
            "allowUiUpdates: false": "tracked dashboard JSON is authoritative",
        }
        for required_text, description in provider_requirements.items():
            append_check(
                report,
                f"dashboard provisioning: {description}",
                required_text in provider_text,
                f"{dashboard_provider_path} must include {required_text}",
            )

    if dashboard_path.is_file():
        try:
            dashboard = read_json(dashboard_path)
            dashboard_report = validate_dashboard_payload(dashboard, dashboard_path)
            report["checks"].extend(dashboard_report["checks"])
            report["errors"].extend(dashboard_report["errors"])
            report["warnings"].extend(dashboard_report["warnings"])
            report["panelCount"] = dashboard_report["panelCount"]
            report["queryCount"] = dashboard_report["queryCount"]
        except (OSError, ValueError, json.JSONDecodeError) as error:
            append_check(report, "dashboard JSON parses", False, str(error))

    if db_path.is_file():
        report["metricsDb"] = {"status": "PRESENT", "path": str(db_path)}
    else:
        report["metricsDb"] = {"status": "MISSING", "path": str(db_path)}
        report["warnings"].append(
            f"{db_path} is not present in this worktree; start Grafana only where the runtime metrics DB exists"
        )

    report["dashboardPath"] = f"/d/{DASHBOARD_UID}/{DASHBOARD_SLUG}"
    report["status"] = "FAIL" if report["errors"] else "PASS"
    return report


def fetch_json(url: str, timeout: float) -> tuple[int, JsonObject]:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError(f"{url} did not return a JSON object")
        return response.status, payload


def fetch_status(url: str, timeout: float) -> int:
    request = urllib.request.Request(url, headers={"Accept": "text/html,application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return int(response.status)


def live_url(base_url: str, path: str) -> str:
    return urllib.parse.urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))


def validate_live(base_url: str = DEFAULT_GRAFANA_URL, timeout: float = 2.0) -> JsonObject:
    report: JsonObject = {
        "status": "PASS",
        "grafanaUrl": base_url,
        "dashboardPath": f"/d/{DASHBOARD_UID}/{DASHBOARD_SLUG}",
        "checks": [],
        "errors": [],
        "warnings": [],
    }

    try:
        health_status, health_payload = fetch_json(live_url(base_url, "/api/health"), timeout)
    except urllib.error.HTTPError as error:
        append_check(report, "grafana health", False, f"/api/health returned HTTP {error.code}")
        report["status"] = "FAIL"
        return report
    except (ConnectionError, TimeoutError, OSError, urllib.error.URLError) as error:
        report["status"] = "NOT_RUNNING"
        report["checks"].append(check_result("grafana health", "NOT_RUNNING", str(error)))
        report["errors"].append(f"Grafana is not reachable at {base_url}: {error}")
        return report
    except (ValueError, json.JSONDecodeError) as error:
        append_check(report, "grafana health JSON", False, str(error))
        report["status"] = "FAIL"
        return report

    append_check(report, "grafana health", health_status == 200, f"/api/health returned HTTP {health_status}")
    report["health"] = health_payload

    datasource_endpoint = live_url(base_url, f"/api/datasources/uid/{DATASOURCE_UID}")
    try:
        datasource_status, datasource_payload = fetch_json(datasource_endpoint, timeout)
        append_check(
            report,
            "grafana datasource reachability",
            datasource_status == 200
            and datasource_payload.get("uid") == DATASOURCE_UID
            and datasource_payload.get("type") == DATASOURCE_TYPE,
            f"{datasource_endpoint} must return {DATASOURCE_UID}/{DATASOURCE_TYPE}",
        )
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            details = (
                f"{datasource_endpoint} returned HTTP {error.code}; anonymous Viewer access cannot read "
                "datasource metadata, so static provisioning validation is authoritative for the datasource contract"
            )
            report["checks"].append(check_result("grafana datasource reachability", "SKIP", details))
            report["warnings"].append(details)
        else:
            append_check(report, "grafana datasource reachability", False, f"{datasource_endpoint} returned HTTP {error.code}")
    except (OSError, ValueError, json.JSONDecodeError) as error:
        append_check(report, "grafana datasource reachability", False, str(error))

    dashboard_api_endpoint = live_url(base_url, f"/api/dashboards/uid/{DASHBOARD_UID}")
    try:
        dashboard_status, dashboard_payload = fetch_json(dashboard_api_endpoint, timeout)
        dashboard = dashboard_payload.get("dashboard")
        dashboard_ok = (
            dashboard_status == 200
            and isinstance(dashboard, dict)
            and dashboard.get("uid") == DASHBOARD_UID
            and dashboard.get("title") == DASHBOARD_TITLE
        )
        append_check(
            report,
            "grafana dashboard API reachability",
            dashboard_ok,
            f"{dashboard_api_endpoint} must return dashboard {DASHBOARD_UID}",
        )
    except urllib.error.HTTPError as error:
        append_check(report, "grafana dashboard API reachability", False, f"{dashboard_api_endpoint} returned HTTP {error.code}")
    except (OSError, ValueError, json.JSONDecodeError) as error:
        append_check(report, "grafana dashboard API reachability", False, str(error))

    dashboard_page = live_url(base_url, f"/d/{DASHBOARD_UID}/{DASHBOARD_SLUG}")
    try:
        page_status = fetch_status(dashboard_page, timeout)
        append_check(
            report,
            "grafana dashboard page reachability",
            page_status == 200,
            f"{dashboard_page} returned HTTP {page_status}",
        )
    except urllib.error.HTTPError as error:
        append_check(report, "grafana dashboard page reachability", False, f"{dashboard_page} returned HTTP {error.code}")
    except OSError as error:
        append_check(report, "grafana dashboard page reachability", False, str(error))

    report["status"] = "FAIL" if report["errors"] else "PASS"
    return report


def build_docker_command(
    repo_root: Path,
    db_path: Path,
    host: str,
    port: int,
    image: str,
    plugin: str,
    container_name: str,
    allow_nonlocal: bool = False,
    detach: bool = True,
    restart_policy: str | None = DEFAULT_DOCKER_RESTART_POLICY,
) -> list[str]:
    validate_host_binding(host, allow_nonlocal)
    repo_root = repo_root.resolve()
    db_path = db_path.resolve()
    command = [
        "docker",
        "run",
        "--name",
        container_name,
        "-p",
        docker_port_binding(host, port),
        "-e",
        f"GF_INSTALL_PLUGINS={plugin}",
        "-e",
        f"GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS={plugin}",
        "-e",
        "GF_AUTH_ANONYMOUS_ENABLED=true",
        "-e",
        "GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer",
        "-e",
        "GF_AUTH_DISABLE_LOGIN_FORM=true",
        "-e",
        "GF_AUTH_BASIC_ENABLED=false",
        "-e",
        "GF_SECURITY_ADMIN_USER=admin",
        "-e",
        "GF_SECURITY_ADMIN_PASSWORD=local-dev-only",
        "-v",
        f"{grafana_root(repo_root) / 'provisioning'}:{CONTAINER_PROVISIONING_PATH}:ro",
        "-v",
        f"{grafana_root(repo_root)}:{CONTAINER_DASHBOARD_PATH}:ro",
        "-v",
        f"{db_path}:{CONTAINER_DB_PATH}:ro",
        image,
    ]
    if detach:
        command[2:2] = ["-d"]
    if restart_policy:
        command[2:2] = ["--restart", restart_policy]
    return command


def render_command(command: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in command)


def parse_docker_port_binding(binding: str) -> tuple[str, tuple[str, str]]:
    if binding.startswith("["):
        host_end = binding.find("]")
        if host_end <= 0 or len(binding) <= host_end + 1 or binding[host_end + 1] != ":":
            raise ValueError(f"invalid Docker port binding: {binding}")
        host = binding[1:host_end]
        host_port, container_port = binding[host_end + 2:].split(":", 1)
    else:
        host, host_port, container_port = binding.rsplit(":", 2)
    return f"{container_port}/tcp", (host, host_port)


def parse_docker_volume(volume: str) -> tuple[str, tuple[str, bool]]:
    source, destination, *options = volume.split(":")
    option_flags = {flag.strip() for option in options for flag in option.split(",")}
    return destination, (source, "ro" in option_flags)


def parse_docker_env(env: str) -> tuple[str, str] | None:
    key, separator, value = env.partition("=")
    if not separator:
        return None
    return key, value


def expected_container_contract(command: list[str]) -> JsonObject:
    ports: dict[str, list[tuple[str, str]]] = {}
    mounts: dict[str, tuple[str, bool]] = {}
    env: dict[str, str] = {}
    image: str | None = None
    index = 2 if command[:2] == ["docker", "run"] else 0
    while index < len(command):
        argument = command[index]
        if argument in ("-p", "--publish"):
            port_key, port_binding = parse_docker_port_binding(command[index + 1])
            ports.setdefault(port_key, []).append(port_binding)
            index += 2
            continue
        if argument in ("-v", "--volume"):
            destination, mount = parse_docker_volume(command[index + 1])
            mounts[destination] = mount
            index += 2
            continue
        if argument in ("-e", "--env"):
            parsed_env = parse_docker_env(command[index + 1])
            if parsed_env:
                key, value = parsed_env
                env[key] = value
            index += 2
            continue
        if argument in ("--name", "--restart"):
            index += 2
            continue
        if argument in ("-d", "--detach"):
            index += 1
            continue
        if argument.startswith("-"):
            index += 1
            continue
        image = argument
        break
    return {
        "ports": {key: sorted(values) for key, values in ports.items()},
        "mounts": mounts,
        "env": env,
        "image": image,
    }


def actual_container_contract(container: JsonObject) -> JsonObject:
    host_config = container.get("HostConfig", {})
    if not isinstance(host_config, dict):
        host_config = {}
    config = container.get("Config", {})
    if not isinstance(config, dict):
        config = {}

    ports: dict[str, list[tuple[str, str]]] = {}
    port_bindings = host_config.get("PortBindings", {})
    if isinstance(port_bindings, dict):
        for port_key, bindings in port_bindings.items():
            if not isinstance(port_key, str) or not isinstance(bindings, list):
                continue
            parsed_bindings: list[tuple[str, str]] = []
            for binding in bindings:
                if not isinstance(binding, dict):
                    continue
                parsed_bindings.append((str(binding.get("HostIp", "")), str(binding.get("HostPort", ""))))
            ports[port_key] = sorted(parsed_bindings)

    mounts: dict[str, tuple[str, bool]] = {}
    mount_entries = container.get("Mounts", [])
    if isinstance(mount_entries, list):
        for mount in mount_entries:
            if not isinstance(mount, dict):
                continue
            source = mount.get("Source")
            destination = mount.get("Destination")
            if not isinstance(source, str) or not isinstance(destination, str):
                continue
            mode = mount.get("Mode", "")
            mode_flags = {part.strip() for part in str(mode).split(",")}
            read_only = mount.get("RW") is False or "ro" in mode_flags
            mounts[destination] = (source, read_only)
    if not mounts:
        binds = host_config.get("Binds", [])
        if isinstance(binds, list):
            for bind in binds:
                if not isinstance(bind, str):
                    continue
                destination, mount = parse_docker_volume(bind)
                mounts[destination] = mount

    env: dict[str, str] = {}
    env_entries = config.get("Env", [])
    if isinstance(env_entries, list):
        for entry in env_entries:
            if not isinstance(entry, str):
                continue
            parsed_env = parse_docker_env(entry)
            if parsed_env:
                key, value = parsed_env
                env[key] = value

    return {
        "ports": ports,
        "mounts": mounts,
        "env": env,
        "image": config.get("Image") if isinstance(config.get("Image"), str) else None,
    }


def container_reuse_mismatches(command: list[str], container: JsonObject) -> list[str]:
    expected = expected_container_contract(command)
    actual = actual_container_contract(container)
    mismatches: list[str] = []

    if expected["image"] and actual["image"] != expected["image"]:
        mismatches.append("image")

    if actual["ports"].keys() != expected["ports"].keys():
        mismatches.append("port set")
    else:
        for port_key, expected_bindings in expected["ports"].items():
            if actual["ports"].get(port_key) != expected_bindings:
                mismatches.append(f"port binding {port_key}")

    for destination, expected_mount in expected["mounts"].items():
        if actual["mounts"].get(destination) != expected_mount:
            mismatches.append(f"mount {destination}")

    for key, expected_value in expected["env"].items():
        if actual["env"].get(key) != expected_value:
            mismatches.append(f"env {key}")

    return mismatches


def print_report(report: JsonObject, as_json: bool) -> None:
    if as_json:
        print(json.dumps(report, indent=2, sort_keys=True))
        return
    print(f"status: {report['status']}")
    for check in report.get("checks", []):
        print(f"{check['status']}: {check['name']} - {check['details']}")
    for warning in report.get("warnings", []):
        print(f"WARNING: {warning}")
    for error in report.get("errors", []):
        print(f"ERROR: {error}")


def print_content_audit_report(report: JsonObject, as_json: bool) -> None:
    if as_json:
        print(json.dumps(report, indent=2, sort_keys=True))
        return
    print(f"status: {report['status']}")
    print(f"contentState: {report.get('contentState')}")
    print(f"dbPath: {report.get('dbPath')}")
    counts = report.get("contentStateCounts", {})
    if isinstance(counts, dict):
        print(
            "contentStateCounts: "
            + ", ".join(
                f"{state}={counts.get(state, 0)}"
                for state in (
                    CONTENT_READY,
                    CONTENT_WAITING_FOR_DATA,
                    CONTENT_NOT_INSTRUMENTED,
                    CONTENT_MISCONFIGURED,
                )
            )
        )
    for panel in report.get("panels", []):
        if not isinstance(panel, dict):
            continue
        print(
            f"{str(panel.get('state')).upper()}: panel {panel.get('id')} "
            f"{panel.get('title')} - {panel.get('details')}"
        )
    for warning in report.get("warnings", []):
        print(f"WARNING: {warning}")
    for error in report.get("errors", []):
        print(f"ERROR: {error}")


def exit_code_for_report(report: JsonObject) -> int:
    if report["status"] == "PASS":
        return 0
    if report["status"] == "NOT_RUNNING":
        return 2
    return 1


def ensure_durable_container(command: list[str], container_name: str, restart_policy: str) -> int:
    inspect = subprocess.run(
        ["docker", "inspect", container_name],
        check=False,
        capture_output=True,
        text=True,
    )
    if inspect.returncode != 0:
        return subprocess.run(command, check=False).returncode

    try:
        inspected = json.loads(inspect.stdout)
    except json.JSONDecodeError as error:
        print(f"ERROR: docker inspect returned invalid JSON for {container_name}: {error}", file=sys.stderr)
        return 1
    if not isinstance(inspected, list) or not inspected or not isinstance(inspected[0], dict):
        print(f"ERROR: docker inspect returned an invalid container payload for {container_name}", file=sys.stderr)
        return 1

    container = inspected[0]
    mismatches = container_reuse_mismatches(command, container)
    if mismatches:
        print(
            f"{container_name} exists with stale Docker settings ({', '.join(mismatches)}); recreating",
            file=sys.stderr,
        )
        remove = subprocess.run(["docker", "rm", "-f", container_name], check=False)
        if remove.returncode != 0:
            return remove.returncode
        return subprocess.run(command, check=False).returncode

    update = subprocess.run(["docker", "update", "--restart", restart_policy, container_name], check=False)
    if update.returncode != 0:
        return update.returncode

    state = container.get("State", {})
    running = isinstance(state, dict) and state.get("Running") is True
    if running:
        print(f"{container_name} already running with restart policy {restart_policy}")
        return 0

    return subprocess.run(["docker", "start", container_name], check=False).returncode


def cmd_validate(args: argparse.Namespace) -> int:
    repo_root = args.repo_root.resolve()
    static_report = validate_static(repo_root)
    if args.provisioning_only or static_report["status"] != "PASS":
        print_report(static_report, args.json)
        return exit_code_for_report(static_report)

    live_report = validate_live(args.url, timeout=args.timeout)
    combined: JsonObject = {
        "status": live_report["status"],
        "repoRoot": str(repo_root),
        "static": static_report,
        "live": live_report,
        "checks": static_report["checks"] + live_report["checks"],
        "warnings": static_report["warnings"] + live_report["warnings"],
        "errors": static_report["errors"] + live_report["errors"],
    }
    if live_report["status"] == "PASS":
        combined["status"] = "PASS"
    elif live_report["status"] == "NOT_RUNNING":
        combined["status"] = "NOT_RUNNING"
    else:
        combined["status"] = "FAIL"
    print_report(combined, args.json)
    return exit_code_for_report(combined)


def cmd_content_audit(args: argparse.Namespace) -> int:
    report = audit_content(args.repo_root, args.db_path)
    print_content_audit_report(report, args.json)
    return exit_code_for_report(report)


def cmd_docker_command(args: argparse.Namespace) -> int:
    try:
        command = build_docker_command(
            repo_root=args.repo_root,
            db_path=args.db_path,
            host=args.host,
            port=args.port,
            image=args.image,
            plugin=args.plugin,
            container_name=args.container_name,
            allow_nonlocal=args.allow_nonlocal,
        )
    except HostBindingError as error:
        return host_binding_error(error)
    print(render_command(command))
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    try:
        validate_host_binding(args.host, args.allow_nonlocal)
    except HostBindingError as error:
        return host_binding_error(error)

    repo_root = args.repo_root.resolve()
    db_path = args.db_path.resolve()
    static_report = validate_static(repo_root)
    if static_report["status"] != "PASS":
        print_report(static_report, args.json)
        return exit_code_for_report(static_report)
    if not db_path.is_file():
        print(f"ERROR: metrics DB is missing: {db_path}", file=sys.stderr)
        print("Run npm run rl-metrics-refresh in an environment with runtime artifacts before starting Grafana.", file=sys.stderr)
        return 2
    command = build_docker_command(
        repo_root=repo_root,
        db_path=db_path,
        host=args.host,
        port=args.port,
        image=args.image,
        plugin=args.plugin,
        container_name=args.container_name,
        allow_nonlocal=args.allow_nonlocal,
    )
    if args.print_only:
        print(render_command(command))
        return 0
    return ensure_durable_container(command, args.container_name, DEFAULT_DOCKER_RESTART_POLICY)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run or validate the Screeps RL Grafana contract.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate_parser = subparsers.add_parser("validate", help="Validate static provisioning and optionally live Grafana.")
    validate_parser.add_argument("--repo-root", type=Path, default=default_repo_root())
    validate_parser.add_argument("--url", default=DEFAULT_GRAFANA_URL)
    validate_parser.add_argument("--timeout", type=float, default=2.0)
    validate_parser.add_argument("--provisioning-only", action="store_true")
    validate_parser.add_argument("--json", action="store_true")
    validate_parser.set_defaults(func=cmd_validate)

    content_parser = subparsers.add_parser(
        "content-audit",
        help="Classify dashboard panel data states against the SQLite metrics DB.",
    )
    content_parser.add_argument("--repo-root", type=Path, default=default_repo_root())
    content_parser.add_argument("--db-path", type=Path, default=default_db_path(default_repo_root()))
    content_parser.add_argument("--json", action="store_true")
    content_parser.set_defaults(func=cmd_content_audit)

    docker_parser = subparsers.add_parser("docker-command", help="Print the Docker command for local Grafana.")
    docker_parser.add_argument("--repo-root", type=Path, default=default_repo_root())
    docker_parser.add_argument("--db-path", type=Path, default=default_db_path(default_repo_root()))
    docker_parser.add_argument("--host", default="127.0.0.1")
    docker_parser.add_argument("--port", type=int, default=3000)
    docker_parser.add_argument("--image", default=DEFAULT_GRAFANA_IMAGE)
    docker_parser.add_argument("--plugin", default=DEFAULT_GRAFANA_PLUGIN)
    docker_parser.add_argument("--container-name", default=DEFAULT_CONTAINER_NAME)
    docker_parser.add_argument("--allow-nonlocal", action="store_true")
    docker_parser.set_defaults(func=cmd_docker_command)

    run_parser = subparsers.add_parser("run", help="Run Grafana in Docker for the local RL metrics DB.")
    run_parser.add_argument("--repo-root", type=Path, default=default_repo_root())
    run_parser.add_argument("--db-path", type=Path, default=default_db_path(default_repo_root()))
    run_parser.add_argument("--host", default="127.0.0.1")
    run_parser.add_argument("--port", type=int, default=3000)
    run_parser.add_argument("--image", default=DEFAULT_GRAFANA_IMAGE)
    run_parser.add_argument("--plugin", default=DEFAULT_GRAFANA_PLUGIN)
    run_parser.add_argument("--container-name", default=DEFAULT_CONTAINER_NAME)
    run_parser.add_argument("--print-only", action="store_true")
    run_parser.add_argument("--json", action="store_true")
    run_parser.add_argument("--allow-nonlocal", action="store_true")
    run_parser.set_defaults(func=cmd_run)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
