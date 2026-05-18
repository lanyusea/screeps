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
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Sequence
from urllib.parse import urlparse

import screeps_rl_dashboard as static_dashboard
import screeps_rl_metrics_ingestor as metrics_ingestor


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8790
DEFAULT_REFRESH_SECONDS = 60
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

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class LiveDashboardConfig:
    repo_root: Path
    artifact_root: Path
    db_path: Path
    refresh_seconds: int = DEFAULT_REFRESH_SECONDS


class LiveDashboardHTTPServer(ThreadingHTTPServer):
    config: LiveDashboardConfig
    refresh_lock: threading.Lock

    def __init__(
        self,
        server_address: tuple[str, int],
        handler_class: type[BaseHTTPRequestHandler],
        config: LiveDashboardConfig,
    ) -> None:
        super().__init__(server_address, handler_class)
        self.config = config
        self.refresh_lock = threading.Lock()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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
        return parsed.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return str(value) if value not in (None, "") else "N/A"


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def resolve_path(path: Path, repo_root: Path) -> Path:
    expanded = path.expanduser()
    return expanded if expanded.is_absolute() else repo_root / expanded


def safe_display_path(path: Path | str | None, repo_root: Path) -> str:
    return static_dashboard.safe_display_path(path, repo_root)


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
        }
    path, payload, timestamp = latest
    overall_gate = payload.get("overallGate") if isinstance(payload.get("overallGate"), dict) else {}
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
    }


def tencent_batch_summary(artifact_root: Path, repo_root: Path) -> JsonObject:
    root = artifact_root / "tencent-cloud" / "batch-runs"
    runs: list[JsonObject] = []
    if root.exists():
        for path in sorted(root.glob("*/controller-summary.json")):
            payload = load_json_object(path)
            if payload is None:
                continue
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
    return {
        "hasData": bool(runs),
        "runCount": len(runs),
        "activeRunCount": len(active),
        "completedRunCount": len(completed),
        "latest": latest,
    }


def safety_summary(dashboard: JsonObject, tencent: JsonObject, scorecard: JsonObject) -> JsonObject:
    card_supply = dashboard.get("cardSupply") if isinstance(dashboard.get("cardSupply"), dict) else {}
    latest_tencent = tencent.get("latest") if isinstance(tencent.get("latest"), dict) else {}
    tencent_safety = latest_tencent.get("safety") if isinstance(latest_tencent.get("safety"), dict) else {}
    unsafe_flags = []
    for field in ("liveEffect", "officialMmoWrites", "officialMmoWritesAllowed"):
        value = tencent_safety.get(field)
        if value is not False and value is not None:
            unsafe_flags.append({"source": "tencent", "field": field, "value": value})
    for regression in scorecard.get("safetyRegressions", []):
        unsafe_flags.append({"source": "scorecard", "field": "safetyRegression", "value": regression})
    return {
        "status": "OK" if not unsafe_flags else "BLOCKED",
        "unsafeFlags": unsafe_flags,
        "tencent": tencent_safety,
        "cardSupplyStatus": card_supply.get("status"),
        "cardSupplySeverity": card_supply.get("severity"),
        "fallbackStatus": card_supply.get("fallbackStatus"),
    }


def build_live_summary(
    repo_root: Path,
    artifact_root: Path,
    db_path: Path,
    *,
    generated_at: str | None = None,
) -> JsonObject:
    generated = generated_at or utc_now_iso()
    db = sqlite_summary(db_path, repo_root)
    health = health_from_db_summary(db)
    raw_dashboard = static_dashboard.build_dashboard(repo_root=repo_root, artifact_root=artifact_root, generated_at=generated)
    dashboard = dashboard_json_safe(raw_dashboard, repo_root)
    scorecard = latest_scorecard_summary(artifact_root, repo_root)
    tencent = tencent_batch_summary(artifact_root, repo_root)
    safety = safety_summary(dashboard, tencent, scorecard)
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
        "dashboardUrl": f"http://{DEFAULT_HOST}:{DEFAULT_PORT}/",
        "health": health,
        "db": db,
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
    safety = summary.get("safety") if isinstance(summary.get("safety"), dict) else {}
    db = summary.get("db") if isinstance(summary.get("db"), dict) else {}

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
        ("Latest observation", h(display_timestamp(db.get("latestObservedAt")))),
    ]
    e1_rows = [
        ("Status", render_status(e1.get("status"))),
        ("Acceptance", h(percent_value(e1.get("acceptanceRate")))),
        ("Sample count", h(format_value(e1.get("sampleCount")))),
        ("Accepted", h(format_value(e1.get("samplesAccepted")))),
        ("Rejected", h(format_value(e1.get("samplesRejected")))),
        ("Source", h(e1.get("displayPath") or "N/A")),
    ]
    loop_a_rows = [
        ("Environments succeeded", h(format_value(environment.get("succeeded")))),
        ("Environments failed", h(format_value(environment.get("failed")))),
        ("Ticks run", h(format_value(environment.get("ticksRun")))),
        ("Training status", render_status(training.get("status"))),
        ("Episodes", h(format_value(training.get("episodes")))),
        ("Policy updates", h(format_value(training.get("policyUpdates")))),
    ]
    loop_b_rows = [
        ("Online utility", render_status(loop_b.get("onlineUtilityStatus"))),
        ("Candidate", h(loop_b.get("policy", {}).get("candidate") if isinstance(loop_b.get("policy"), dict) else "N/A")),
        ("Baseline", h(loop_b.get("policy", {}).get("baseline") if isinstance(loop_b.get("policy"), dict) else "N/A")),
        ("Scorecard", render_status(scorecard.get("status"))),
        ("Scorecard run", h(scorecard.get("runId") or "N/A")),
    ]
    tencent_rows = [
        ("Runs", h(format_value(tencent.get("runCount")))),
        ("Active runs", h(format_value(tencent.get("activeRunCount")))),
        ("Completed runs", h(format_value(tencent.get("completedRunCount")))),
        ("Latest run", h(latest_tencent.get("runId") or "N/A")),
        ("Latest status", render_status(latest_tencent.get("finalStatus"))),
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
        ("Card supply", h(safety.get("cardSupplyStatus") or "N/A")),
        ("Unsafe flags", h(len(safety.get("unsafeFlags", [])))),
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
    <section class="panel"><h2>Metrics Store</h2>{table(("Item", "Value"), db_rows)}</section>
    <section class="panel"><h2>E1 Gate Acceptance</h2>{table(("Item", "Value"), e1_rows)}</section>
  </div>

  <div class="grid two">
    <section class="panel"><h2>Loop A Env Ticks Episodes</h2>{table(("Item", "Value"), loop_a_rows)}</section>
    <section class="panel"><h2>Loop B Utility Scorecard</h2>{table(("Item", "Value"), loop_b_rows)}</section>
  </div>

  <div class="grid two">
    <section class="panel"><h2>Tencent Batch Utilization</h2>{table(("Item", "Value"), tencent_rows)}</section>
    <section class="panel"><h2>Safety Flags</h2>{table(("Item", "Value"), safety_rows)}</section>
  </div>
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
            self.write_json(status, summary["health"] | {"db": summary["db"], "generatedAt": summary["generatedAt"]})
            return
        self.write_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/refresh":
            self.write_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        with self.server.refresh_lock:
            try:
                refresh = refresh_metrics(self.server.config.db_path, self.server.config.artifact_root)
            except Exception as error:  # pragma: no cover - defensive handler boundary
                self.write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(error)})
                return
        self.write_json(HTTPStatus.OK, {"ok": True, "refresh": refresh, "summary": self.summary()})

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

    def summary(self) -> JsonObject:
        config = self.server.config
        return build_live_summary(config.repo_root, config.artifact_root, config.db_path)

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
        return 0
    if args.command == "summary":
        print(json.dumps(build_live_summary(config.repo_root, config.artifact_root, config.db_path), sort_keys=True))
        return 0
    if args.command == "serve":
        if args.refresh_on_start:
            refresh_metrics(config.db_path, config.artifact_root)
        server = make_server(args.host, args.port, config)
        host, port = server.server_address
        print(f"Serving Screeps RL live dashboard at http://{host}:{port}/")
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
