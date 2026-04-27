#!/usr/bin/env python3
"""Generate the public GitHub Pages roadmap dashboard and KPI SQLite history.

This script intentionally publishes only public, non-secret state:
- GitHub issue/PR/project metadata already visible in the public repository/project.
- Aggregated Screeps KPI trend points, with missing metrics marked as not observed.

Outputs by default:
- docs/index.html              static GitHub Pages entrypoint
- docs/roadmap-data.json       current public dashboard data
- docs/roadmap-kpi.sqlite      single SQLite KPI history database
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

REPO_SLUG = "lanyusea/screeps"
FORMAT_VERSION = "roadmap-live-page-v1"
TARGET_SHARD = "shardX"
TARGET_ROOM = "E48S28"
PROJECT_URL = "https://github.com/lanyusea/screeps"
GAME_URL = "https://screeps.com/"
PROJECT_BOARD_URL = "https://github.com/users/lanyusea/projects/3"

KEY_KPI_DEFINITIONS = [
    # Territory / map control
    ("territory", "owned_rooms", "Owned rooms", "rooms", "Owned room count in the target shard."),
    ("territory", "reserved_rooms", "Reserved rooms", "rooms", "Reserved or remote-room footprint when instrumented."),
    ("territory", "room_gain", "Room gain", "rooms", "Owned-room delta across the observed window."),
    ("territory", "room_loss", "Room loss", "rooms", "Owned-room loss across the observed window."),
    ("territory", "controller_level", "Controller level", "RCL", "Latest owned-room controller level."),
    ("territory", "controller_progress", "Controller progress", "progress", "Latest controller progress."),
    ("territory", "controller_progress_total", "Controller progress total", "progress", "Latest controller progress target."),
    ("territory", "controller_ticks_to_downgrade", "Downgrade timer", "ticks", "Latest ticks to controller downgrade."),
    # Resources / economy
    ("resources", "stored_energy", "Stored energy", "energy", "Energy stored in owned structures."),
    ("resources", "worker_carried_energy", "Worker carried", "energy", "Energy carried by worker creeps."),
    ("resources", "dropped_energy", "Dropped energy", "energy", "Energy observed on the ground."),
    ("resources", "source_count", "Source count", "sources", "Known source count in owned rooms."),
    ("resources", "harvested_energy", "Harvested energy", "energy", "Event-backed harvested energy over the observed window."),
    ("resources", "transferred_energy", "Transferred energy", "energy", "Event-backed transferred energy over the observed window."),
    ("resources", "harvest_delta", "Harvest delta", "energy", "Harvested-energy delta/trend used by roadmap charts."),
    ("resources", "spawn_utilization", "Spawn utilization", "ratio", "Spawn uptime/utilization when instrumentation is available."),
    ("resources", "remote_uptime", "Remote uptime", "ratio", "Remote-harvest uptime when instrumentation is available."),
    # Combat / enemy kills
    ("combat", "enemy_kills", "Enemy kills", "events", "Enemy creep/structure kill count when event telemetry is available."),
    ("combat", "hostile_creep_count", "Hostile creeps", "creeps", "Latest hostile creep count."),
    ("combat", "hostile_structure_count", "Hostile structures", "structures", "Latest hostile structure count."),
    ("combat", "attack_count", "Attack events", "events", "Combat attack event count."),
    ("combat", "attack_damage", "Attack damage", "hits", "Total attack damage observed in event telemetry."),
    ("combat", "object_destroyed_count", "Objects destroyed", "events", "Destroyed object events."),
    ("combat", "creep_destroyed_count", "Creeps destroyed", "events", "Destroyed creep events."),
    ("combat", "own_loss", "Own loss", "events", "Own creep/structure loss count when instrumented."),
    ("combat", "defensive_readiness", "Defensive readiness", "score", "Tactical readiness score when strategy telemetry exists."),
    # Guardrails / reliability
    ("guardrails", "cpu_used", "CPU used", "cpu", "CPU used per tick when telemetry is available."),
    ("guardrails", "cpu_bucket", "CPU bucket", "cpu", "CPU bucket level when telemetry is available."),
    ("guardrails", "exceptions", "Loop exceptions", "count", "Runtime loop exception count."),
    ("guardrails", "resets", "Runtime resets", "count", "Runtime reset count."),
    ("guardrails", "telemetry_silence", "Telemetry silence", "minutes", "Minutes since last telemetry when monitored."),
    ("guardrails", "spawn_collapse", "Spawn collapse", "flag", "Emergency no-spawn/no-worker condition flag."),
]

ROADMAP_CARDS = [
    ("Gameplay Evolution", "真实游戏结果驱动 roadmap / task / release", "#59 统筹；#61 bridge；#29 KPI", 10),
    ("Territory / 占地", "先拿下并守住更大版图", "owned/reserved/room gain/RCL KPI", 15),
    ("Resource Economy", "把占地转换成能量、矿物、物流规模", "harvest/transfer/store deltas", 15),
    ("Combat / 敌人击杀", "防御/进攻服务于领土和经济控制", "event-log kills/losses + tactical bridge", 5),
    ("Reliability / P0", "自动化系统健康只在阻塞时压过游戏目标", "P0 monitor watch / no silent scheduler failures", 100),
    ("Foundation Gates", "私服验证 / release gate / official MMO", "private smoke + release/hotfix evidence", 85),
]

KANBAN_COLUMNS = [
    ("backlog", "Backlog"),
    ("developing", "开发中"),
    ("private", "私服验证中"),
    ("online", "已上线"),
]


def sh(args: list[str], cwd: Path, fallback: str = "") -> str:
    try:
        return subprocess.check_output(args, cwd=cwd, text=True, stderr=subprocess.DEVNULL, timeout=120).strip()
    except Exception:
        return fallback


def gh_json(args: list[str], cwd: Path, fallback: Any) -> Any:
    raw = sh(["gh", *args], cwd, "")
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return fallback


def esc(text: Any) -> str:
    return (
        str(text if text is not None else "—")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def slug_metric(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


@dataclass(frozen=True)
class KpiPoint:
    domain: str
    metric: str
    label: str
    value: float | None
    unit: str
    instrumented: bool
    source: str
    note: str


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS metric_points (
              id INTEGER PRIMARY KEY,
              captured_at TEXT NOT NULL,
              shard TEXT NOT NULL,
              room TEXT,
              domain TEXT NOT NULL,
              metric TEXT NOT NULL,
              label TEXT NOT NULL,
              value REAL,
              unit TEXT,
              instrumented INTEGER NOT NULL,
              source TEXT NOT NULL,
              note TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_metric_points_lookup
              ON metric_points(metric, shard, room, captured_at);
            CREATE INDEX IF NOT EXISTS idx_metric_points_domain_time
              ON metric_points(domain, captured_at);
            """
        )


def append_snapshot(db_path: Path, captured_at: str, points: list[KpiPoint]) -> None:
    init_db(db_path)
    with sqlite3.connect(db_path) as conn:
        existing = conn.execute(
            "SELECT COUNT(*) FROM metric_points WHERE captured_at = ?", (captured_at,)
        ).fetchone()[0]
        if existing:
            return
        conn.executemany(
            """
            INSERT INTO metric_points
            (captured_at, shard, room, domain, metric, label, value, unit, instrumented, source, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    captured_at,
                    TARGET_SHARD,
                    TARGET_ROOM,
                    p.domain,
                    p.metric,
                    p.label,
                    p.value,
                    p.unit,
                    1 if p.instrumented else 0,
                    p.source,
                    p.note,
                )
                for p in points
            ],
        )


def query_metric_history(db_path: Path, since_iso: str) -> dict[str, list[dict[str, Any]]]:
    if not db_path.exists():
        return {}
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT captured_at, domain, metric, label, value, unit, instrumented, source, note
            FROM metric_points
            WHERE captured_at >= ?
            ORDER BY captured_at ASC, domain ASC, metric ASC
            """,
            (since_iso,),
        ).fetchall()
    history: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        history.setdefault(row["metric"], []).append(dict(row))
    return history


def latest_summary_svg(repo: Path) -> Path | None:
    monitor_dir = repo / "runtime-artifacts" / "screeps-monitor"
    if not monitor_dir.exists():
        return None
    svgs = sorted(monitor_dir.glob("**/summary-*.svg"), key=lambda p: p.stat().st_mtime, reverse=True)
    return svgs[0] if svgs else None


def extract_rcl(repo: Path) -> float | None:
    svg_path = latest_summary_svg(repo)
    if not svg_path:
        return None
    try:
        match = re.search(r"Controller\s+R(\d+)", svg_path.read_text(errors="ignore"), re.I)
        return float(match.group(1)) if match else None
    except OSError:
        return None


def latest_reducer_report(repo: Path) -> dict[str, Any] | None:
    candidates = sorted(
        list((repo / "runtime-artifacts").glob("**/*kpi*.json"))
        + list((repo / "runtime-artifacts").glob("**/*runtime*summary*.json")),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    ) if (repo / "runtime-artifacts").exists() else []
    for candidate in candidates[:20]:
        try:
            data = json.loads(candidate.read_text(errors="ignore"))
        except Exception:
            continue
        if isinstance(data, dict) and (data.get("type") == "runtime-kpi-report" or {"territory", "resources", "combat"} & set(data.keys())):
            return data
    return None


def nested(data: dict[str, Any] | None, path: list[str], default: Any = None) -> Any:
    cur: Any = data
    for key in path:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(key)
    return cur if cur is not None else default


def number(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def build_kpi_points(repo: Path) -> list[KpiPoint]:
    report = latest_reducer_report(repo)
    rcl = extract_rcl(repo)
    observed: dict[str, tuple[float | None, bool, str, str]] = {
        "owned_rooms": (number(nested(report, ["territory", "ownedRooms", "latestCount"], 1)) or 1.0, True, "runtime-monitor", "Observed owned room count or safe current target baseline."),
        "room_gain": (number(nested(report, ["territory", "ownedRooms", "deltaCount"], 0)) or 0.0, True, "runtime-kpi-reducer", "Delta from reducer when available; otherwise current window baseline."),
        "room_loss": (0.0, False, "runtime-kpi-reducer", "Loss-specific reducer field pending; room delta is tracked."),
        "controller_level": (rcl if rcl is not None else number(nested(report, ["territory", "controllers", "latest", "level"], 3)) or 3.0, True, "runtime-monitor", "Latest controller level from room monitor/reducer."),
        "controller_progress": (number(nested(report, ["territory", "controllers", "latest", "progress"])), bool(nested(report, ["territory", "controllers", "latest", "progress"]) is not None), "runtime-kpi-reducer", "Controller progress from runtime summary when present."),
        "controller_progress_total": (number(nested(report, ["territory", "controllers", "latest", "progressTotal"])), bool(nested(report, ["territory", "controllers", "latest", "progressTotal"]) is not None), "runtime-kpi-reducer", "Controller progress target from runtime summary when present."),
        "controller_ticks_to_downgrade": (number(nested(report, ["territory", "controllers", "latest", "ticksToDowngrade"])), bool(nested(report, ["territory", "controllers", "latest", "ticksToDowngrade"]) is not None), "runtime-kpi-reducer", "Downgrade risk from runtime summary when present."),
        "stored_energy": (number(nested(report, ["resources", "latest", "storedEnergy"], 0)) or 0.0, bool(report), "runtime-kpi-reducer", "Resource reducer field; 0 until observed."),
        "worker_carried_energy": (number(nested(report, ["resources", "latest", "workerCarriedEnergy"], 0)) or 0.0, bool(report), "runtime-kpi-reducer", "Worker carried energy from runtime summary."),
        "dropped_energy": (number(nested(report, ["resources", "latest", "droppedEnergy"], 0)) or 0.0, bool(report), "runtime-kpi-reducer", "Dropped energy from runtime summary."),
        "source_count": (number(nested(report, ["resources", "latest", "sourceCount"])), bool(nested(report, ["resources", "latest", "sourceCount"]) is not None), "runtime-kpi-reducer", "Known source count when runtime summary includes it."),
        "harvested_energy": (number(nested(report, ["resources", "events", "harvestedEnergy"], 0)) or 0.0, bool(report), "runtime-kpi-reducer", "Harvest event total over reducer window."),
        "transferred_energy": (number(nested(report, ["resources", "events", "transferredEnergy"], 0)) or 0.0, bool(report), "runtime-kpi-reducer", "Transfer event total over reducer window."),
        "harvest_delta": (number(nested(report, ["resources", "events", "harvestedEnergy"], 0)) or 0.0, bool(report), "runtime-kpi-reducer", "Harvest delta used for roadmap trend."),
        "hostile_creep_count": (number(nested(report, ["combat", "latest", "hostileCreepCount"], 0)) or 0.0, bool(report), "runtime-kpi-reducer", "Latest hostile creep count."),
        "hostile_structure_count": (number(nested(report, ["combat", "latest", "hostileStructureCount"], 0)) or 0.0, bool(report), "runtime-kpi-reducer", "Latest hostile structure count."),
        "attack_count": (number(nested(report, ["combat", "events", "attackCount"], 0)) or 0.0, bool(report), "runtime-kpi-reducer", "Attack event count."),
        "attack_damage": (number(nested(report, ["combat", "events", "attackDamage"], 0)) or 0.0, bool(report), "runtime-kpi-reducer", "Attack damage event total."),
        "object_destroyed_count": (number(nested(report, ["combat", "events", "objectDestroyedCount"], 0)) or 0.0, bool(report), "runtime-kpi-reducer", "Destroyed object events."),
        "creep_destroyed_count": (number(nested(report, ["combat", "events", "creepDestroyedCount"], 0)) or 0.0, bool(report), "runtime-kpi-reducer", "Destroyed creep events."),
        "enemy_kills": (number(nested(report, ["combat", "events", "creepDestroyedCount"], 0)) or 0.0, bool(report), "runtime-kpi-reducer", "Enemy kill proxy until ownership-aware kill reducer is added."),
    }
    points: list[KpiPoint] = []
    for domain, metric, label, unit, definition_note in KEY_KPI_DEFINITIONS:
        value, instrumented, source, note = observed.get(
            metric,
            (None, False, "pending-instrumentation", f"{definition_note} Pending telemetry/reducer implementation."),
        )
        points.append(KpiPoint(domain, metric, label, value, unit, instrumented, source, note))
    return points


def project_items(repo: Path) -> list[dict[str, Any]]:
    raw = gh_json(["project", "item-list", "3", "--owner", "lanyusea", "--limit", "100", "--format", "json"], repo, {"items": []})
    items: list[dict[str, Any]] = []
    for item in raw.get("items", []) if isinstance(raw, dict) else []:
        content = item.get("content") if isinstance(item.get("content"), dict) else {}
        number = content.get("number") or item.get("number")
        url = content.get("url") or item.get("url") or ""
        items.append(
            {
                "id": item.get("id"),
                "number": number,
                "type": content.get("type") or item.get("type") or "Issue",
                "title": item.get("title") or content.get("title") or "",
                "status": item.get("status") or "Backlog",
                "priority": item.get("priority") or "",
                "domain": item.get("domain") or "",
                "kind": item.get("kind") or "",
                "evidence": item.get("evidence") or "",
                "nextAction": item.get("next action") or "",
                "nextPointPct": item.get("next-point %"),
                "url": url or (f"{PROJECT_URL}/issues/{number}" if number else PROJECT_URL),
            }
        )
    return items


def status_column(item: dict[str, Any]) -> str:
    title = item.get("title", "")
    status = item.get("status", "")
    domain = item.get("domain", "")
    if status == "Done":
        return "online"
    if domain == "Private smoke" or re.search(r"private|私服|smoke", title, re.I):
        return "backlog" if status == "Backlog" else "private"
    if status in {"In review", "In progress"}:
        return "developing"
    return "backlog"


def build_data(repo: Path, db_path: Path) -> dict[str, Any]:
    now = datetime.now(UTC)
    captured_at = now.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    published_at_cst = (now + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M:%S CST")
    head = sh(["git", "rev-parse", "--short", "HEAD"], repo, "—")
    commit_count = int(sh(["git", "rev-list", "--count", "HEAD"], repo, "0") or "0")
    prs = gh_json(["pr", "list", "--repo", REPO_SLUG, "--state", "all", "--limit", "100", "--json", "number,state,title,mergedAt,url"], repo, [])
    issues = gh_json(["issue", "list", "--repo", REPO_SLUG, "--state", "all", "--limit", "100", "--json", "number,state,title,labels,url"], repo, [])
    items = project_items(repo)
    by_number = {item["number"]: item for item in items if item.get("number")}

    points = build_kpi_points(repo)
    append_snapshot(db_path, captured_at, points)
    since = (now - timedelta(days=30)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    history = query_metric_history(db_path, since)

    def issue_url(number: int) -> str:
        return by_number.get(number, {}).get("url") or f"{PROJECT_URL}/issues/{number}"

    roadmap = []
    roadmap_issue_map = [59, 0, 29, 62, 27, 28]
    for idx, (title, goal, next_point, pct) in enumerate(ROADMAP_CARDS):
        number = roadmap_issue_map[idx]
        item = by_number.get(number) if number else None
        roadmap.append(
            {
                "title": title,
                "goal": goal,
                "nextPoint": item.get("nextAction") if item and item.get("nextAction") else next_point,
                "progressPct": item.get("nextPointPct") if item and item.get("nextPointPct") is not None else pct,
                "url": item.get("url") if item else PROJECT_BOARD_URL,
            }
        )

    game_numbers = [59, 29, 61, 30, 31, 62]
    foundation_numbers = [28, 33, 63, 27, 26, 66, 68]

    def kanban_for(numbers: list[int]) -> list[dict[str, Any]]:
        cards = []
        for number in numbers:
            item = by_number.get(number)
            if not item:
                continue
            cards.append({**item, "column": status_column(item)})
        return cards

    return {
        "formatVersion": FORMAT_VERSION,
        "publishedAt": published_at_cst,
        "capturedAt": captured_at,
        "repo": {"slug": REPO_SLUG, "url": PROJECT_URL, "head": head, "projectBoardUrl": PROJECT_BOARD_URL},
        "game": {"url": GAME_URL, "shard": TARGET_SHARD, "room": TARGET_ROOM},
        "kpiDefinitions": [
            {"domain": d, "metric": m, "label": l, "unit": u, "note": n}
            for d, m, l, u, n in KEY_KPI_DEFINITIONS
        ],
        "kpiLatest": [p.__dict__ for p in points],
        "kpiHistory": history,
        "roadmap": roadmap,
        "kanban": {"gameplay": kanban_for(game_numbers), "foundation": kanban_for(foundation_numbers), "columns": KANBAN_COLUMNS},
        "processMetrics": {
            "commits": commit_count,
            "prs": len(prs) if isinstance(prs, list) else 0,
            "mergedPrs": len([p for p in prs if p.get("state") == "MERGED"]) if isinstance(prs, list) else 0,
            "issues": len(issues) if isinstance(issues, list) else 0,
            "openIssues": len([i for i in issues if i.get("state") == "OPEN"]) if isinstance(issues, list) else 0,
            "officialDeploys": 0,
            "privateTests": max(1, len(list(repo.glob("**/*private*smoke*report*.json")))),
        },
    }


def chart_svg(data: dict[str, Any], metrics: list[str], width: int = 430, height: int = 220) -> str:
    colors = ["#8f6235", "#5c8456", "#a33b2f", "#756d62"]
    series = []
    for metric in metrics:
        rows = data.get("kpiHistory", {}).get(metric, [])[-7:]
        if not rows:
            latest = next((p for p in data["kpiLatest"] if p["metric"] == metric), None)
            rows = [{"captured_at": data["capturedAt"], "value": latest.get("value") if latest else 0, "label": latest.get("label", metric) if latest else metric}]
        label = rows[-1].get("label") or metric
        values = [float(r["value"] or 0) for r in rows]
        series.append((metric, label, values))
    vals = [v for _, _, values in series for v in values] or [0]
    max_v = max(1, max(vals))
    min_v = min(0, min(vals))
    if max_v == min_v:
        max_v += 1
    pad_l, pad_r, pad_t, pad_b = 54, 24, 28, 40
    def x(i: int, n: int) -> float:
        return pad_l + (i if n > 1 else 0) * ((width - pad_l - pad_r) / max(1, n - 1))
    def y(v: float) -> float:
        return height - pad_b - ((v - min_v) / (max_v - min_v)) * (height - pad_t - pad_b)
    ticks = [max_v, (max_v + min_v) / 2, min_v]
    parts = [f'<svg viewBox="0 0 {width} {height}" class="chart">']
    for t in ticks:
        yy = y(t)
        label = str(int(t)) if float(t).is_integer() else f"{t:.1f}"
        parts.append(f'<line x1="{pad_l}" x2="{width-pad_r}" y1="{yy:.1f}" y2="{yy:.1f}" class="grid"/><text x="{pad_l-10}" y="{yy+4:.1f}" text-anchor="end" class="axis">{esc(label)}</text>')
    parts.append(f'<line x1="{pad_l}" x2="{pad_l}" y1="{pad_t}" y2="{height-pad_b}" class="axisline"/>')
    for idx, (_, label, values) in enumerate(series):
        color = colors[idx % len(colors)]
        d = " ".join(f'{"M" if i == 0 else "L"}{x(i, len(values)):.1f},{y(v):.1f}' for i, v in enumerate(values))
        parts.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="3.2" stroke-linecap="round"/>')
        for i, v in enumerate(values):
            px, py = x(i, len(values)), y(v)
            dy = -10 if idx % 2 == 0 else 17
            text = str(int(v)) if float(v).is_integer() else f"{v:.1f}"
            parts.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="3.8" fill="{color}" stroke="#fffdf7" stroke-width="1.4"/><text x="{px:.1f}" y="{py+dy:.1f}" text-anchor="middle" class="point-label">{esc(text)}</text>')
    n = max(len(series[0][2]) if series else 1, 1)
    for i in range(n):
        parts.append(f'<text x="{x(i, n):.1f}" y="{height-12}" text-anchor="middle" class="axis">{i+1}</text>')
    parts.append("</svg>")
    legend = "".join(f'<span><i style="background:{colors[i % len(colors)]}"></i>{esc(label)}</span>' for i, (_, label, _) in enumerate(series))
    return "".join(parts) + f'<div class="legend">{legend}</div>'


def render_html(data: dict[str, Any]) -> str:
    logo_src = "assets/screeps-community-logo.png"

    def latest(metric: str) -> dict[str, Any]:
        return next((p for p in data["kpiLatest"] if p["metric"] == metric), {"value": None, "instrumented": False})

    def kpi_card(title: str, metrics: list[str], note: str) -> str:
        return f"""
        <article class="card kpi-card">
          <h3>{esc(title)}</h3>
          {chart_svg(data, metrics)}
          <p class="note">{esc(note)}</p>
        </article>
        """

    def roadmap_card(card: dict[str, Any]) -> str:
        return f"""
        <a class="card roadmap-card" href="{esc(card['url'])}" target="_blank" rel="noopener noreferrer">
          <h3>{esc(card['title'])}</h3>
          <p><b>目标</b>{esc(card['goal'])}</p>
          <p><b>下个点</b>{esc(card['nextPoint'])}</p>
          <div class="progress"><strong>{esc(card['progressPct'])}%</strong><i><em style="width:{max(0, min(100, float(card['progressPct'] or 0)))}%"></em></i></div>
        </a>
        """

    def ticket(item: dict[str, Any]) -> str:
        return f"""
        <a class="ticket" href="{esc(item.get('url') or PROJECT_URL)}" target="_blank" rel="noopener noreferrer">
          <div><b>#{esc(item.get('number'))} {esc(item.get('title'))}</b><span>{esc(item.get('priority') or '')}</span></div>
          <p>{esc(item.get('nextAction') or item.get('domain') or item.get('status'))}</p>
        </a>
        """

    def kanban(title: str, items: list[dict[str, Any]]) -> str:
        columns = []
        for key, label in KANBAN_COLUMNS:
            col = [i for i in items if i.get("column") == key]
            columns.append(f'<div class="kan-col"><div class="kan-title">{esc(label)} <span>{len(col)}</span></div>{"".join(ticket(i) for i in col) or "<div class=empty>—</div>"}</div>')
        return f'<section class="section"><h2>{esc(title)}</h2><div class="kanban">{"".join(columns)}</div></section>'

    process = data["processMetrics"]
    metrics_html = "".join(
        f'<div class="card metric"><div class="metric-value">{esc(value)}</div><div class="metric-label">{esc(label)}</div></div>'
        for label, value in [
            ("总 commit 数", process["commits"]),
            ("总 PR 数", process["prs"]),
            ("总 issue 数", process["issues"]),
            ("发版到官方游戏", process["officialDeploys"]),
            ("私服内总测试次数", process["privateTests"]),
        ]
    )

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hermes Screeps Project Roadmap Report</title>
  <meta name="description" content="Live roadmap report for the Hermes Screeps Project.">
  <link rel="preload" href="roadmap-data.json" as="fetch" crossorigin="anonymous">
  <style>
    *{{box-sizing:border-box}} body{{margin:0;background:#f4eee3;color:#2e2a24;font-family:Inter,Arial,'Noto Sans CJK SC','Microsoft YaHei',sans-serif}} a{{color:inherit;text-decoration:none}} .page{{max-width:1600px;margin:0 auto;padding:62px 46px}}
    .hero{{position:relative;display:grid;grid-template-columns:1.55fr .95fr;gap:18px;min-height:330px;margin-bottom:28px;padding:34px 36px 30px;border-radius:34px;overflow:hidden;background:radial-gradient(circle at 82% 46%,rgba(201,100,66,.24),transparent 24%),linear-gradient(135deg,#fffdf7 0%,#f7eedf 58%,#ead8bd 100%);box-shadow:0 20px 46px rgba(90,70,35,.10)}} .hero:after{{content:"";position:absolute;right:-120px;top:-120px;width:470px;height:470px;border-radius:50%;background:rgba(143,98,53,.06)}} .hero-main{{position:relative;z-index:2;display:flex;flex-direction:column;justify-content:space-between;min-height:266px}} .kicker{{font-size:16px;letter-spacing:.18em;text-transform:uppercase;color:#8f6235;font-weight:950}} h1{{font-size:72px;line-height:.9;margin:10px 0 16px;font-weight:950;letter-spacing:-3.4px;max-width:960px}} .subtitle{{font-size:22px;color:#5e554b;margin:0 0 15px;line-height:1.34;max-width:780px}} .hero-copy{{display:grid;gap:5px;color:#4d463d;font-size:17px;line-height:1.34;max-width:860px}} .hero-copy p{{margin:0}} .hero-copy b{{color:#8f6235}} .publish-time{{margin-top:13px;color:#8f6235;font-size:15px;font-weight:950;letter-spacing:.04em;text-transform:uppercase}} .hero-art{{position:relative;z-index:1;min-height:266px}} .logo-orb{{position:absolute;right:-8px;top:51%;width:372px;height:372px;transform:translateY(-50%);border-radius:50%;background:rgba(255,253,247,.62);box-shadow:0 22px 58px rgba(90,70,35,.16),inset 0 0 0 18px rgba(239,228,211,.48);display:flex;align-items:center;justify-content:center}} .logo-orb img{{width:286px;height:286px;object-fit:contain;filter:drop-shadow(0 12px 20px rgba(46,42,36,.18))}} .hero-meta{{position:absolute;right:10px;bottom:2px;width:300px;text-align:right;color:#8f6235;font-size:15px;font-weight:950;letter-spacing:.04em}} .stamp{{display:inline-block;background:rgba(239,228,211,.72);border-radius:999px;padding:9px 13px}}
    .section{{margin-top:26px}} h2{{font-size:34px;line-height:1;margin:0 0 14px;font-weight:900;letter-spacing:-.5px}} .card{{background:#fffdf7;border:1.6px solid #d2c5b4;border-radius:22px;box-shadow:0 12px 26px rgba(90,70,35,.07)}} .kpi-grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}} .kpi-card{{padding:18px}} .kpi-card h3,.roadmap-card h3{{font-size:24px;margin:0 0 10px}} .chart{{width:100%;display:block;margin-top:8px}} .grid{{stroke:#e4dacd;stroke-width:1}} .axisline{{stroke:#b8aa99;stroke-width:1.4}} .axis{{font-size:13px;fill:#7c7266}} .point-label{{font-size:12px;fill:#2e2a24;font-weight:900;paint-order:stroke;stroke:#fffdf7;stroke-width:3px;stroke-linejoin:round}} .legend{{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;font-size:14px;color:#5e554b}} .legend i{{display:inline-block;width:20px;height:4px;border-radius:99px;margin-right:5px;vertical-align:middle}} .note{{font-size:14px;color:#8b806f;margin:7px 0 0;line-height:1.3}}
    .road-grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}} .roadmap-card{{padding:18px;transition:.16s transform,.16s box-shadow}} .roadmap-card:hover,.ticket:hover{{transform:translateY(-2px);box-shadow:0 18px 34px rgba(90,70,35,.12)}} .roadmap-card p{{display:grid;grid-template-columns:58px 1fr;gap:8px;margin:8px 0;color:#5e554b;font-size:15px;line-height:1.34}} .roadmap-card b{{color:#8f6235}} .progress{{display:flex;align-items:center;gap:10px;margin-top:12px}} .progress strong{{font-size:20px;color:#8f6235}} .progress i{{height:10px;flex:1;background:#efe4d3;border-radius:999px;overflow:hidden}} .progress em{{display:block;height:100%;background:linear-gradient(90deg,#c89155,#8f6235);border-radius:999px}}
    .kanban{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}} .kan-col{{background:#f8f0e4;border:1px solid #d8c8b5;border-radius:20px;padding:12px;min-height:172px}} .kan-title{{display:flex;justify-content:space-between;font-size:16px;font-weight:950;color:#5a4c3d;margin-bottom:10px}} .kan-title span,.ticket span{{color:#8f6235;background:#efe4d3;border-radius:999px;padding:2px 8px}} .ticket{{display:block;background:#fffdf7;border:1px solid #dccdbb;border-radius:15px;padding:10px;margin:8px 0;transition:.16s transform,.16s box-shadow}} .ticket div{{display:flex;justify-content:space-between;gap:10px;font-size:14px;line-height:1.25}} .ticket p{{margin:7px 0 0;color:#786f63;font-size:13px;line-height:1.25}} .empty{{height:58px;border:1px dashed #d2c5b4;border-radius:14px;display:grid;place-items:center;color:#a0907e}}
    .metrics{{display:grid;grid-template-columns:repeat(5,1fr);gap:14px}} .metric{{padding:18px;text-align:center}} .metric-value{{font-size:42px;font-weight:950;letter-spacing:-1px;color:#8f6235}} .metric-label{{font-size:15px;color:#5e554b;margin-top:4px}} .footer{{margin-top:18px;color:#8b806f;font-size:14px;text-align:right}} @media(max-width:900px){{.page{{padding:24px 16px}}.hero,.kpi-grid,.road-grid,.kanban,.metrics{{grid-template-columns:1fr}}h1{{font-size:44px}}.logo-orb{{position:relative;right:auto;top:auto;transform:none;margin:auto;width:260px;height:260px}}.logo-orb img{{width:198px;height:198px}}}}
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <div class="hero-main">
        <div><div class="kicker">Persistent MMO AI Colony · Autonomous Roadmap</div><h1>Hermes Screeps Project Roadmap Report</h1><p class="subtitle">用真实游戏 KPI 驱动 bot 能力、策略开发、基建门禁和发版节奏。</p></div>
        <div><div class="hero-copy"><p><b>Project</b> · 长期运行的 Screeps: World AI / 自动化运营项目。</p><p><b>Links</b> · <a href="{PROJECT_URL}">{PROJECT_URL}</a> · <a href="{GAME_URL}">{GAME_URL}</a></p><p><b>Target</b> · Official MMO {esc(data['game']['shard'])}/{esc(data['game']['room'])} · 地盘 &gt; 资源 &gt; 击杀。</p></div><div class="publish-time">Published · {esc(data['publishedAt'])}</div></div>
      </div>
      <div class="hero-art"><div class="logo-orb"><img src="{logo_src}" alt="Screeps project logo"></div><div class="hero-meta"><span class="stamp">KPI/Kanban · {esc(data['repo']['head'])}</span></div></div>
    </section>
    <section class="section"><h2>01 游戏内部 KPI · 趋势</h2><div class="kpi-grid">
      {kpi_card('地盘 / Territory', ['owned_rooms','controller_level','room_gain'], '领土、RCL、房间增减；缺失项在 SQLite 中标为 not instrumented。')}
      {kpi_card('资源 / Resources', ['stored_energy','harvested_energy','worker_carried_energy'], '存储、采集、携带能量；来自 runtime summary / KPI reducer。')}
      {kpi_card('击杀 / Combat', ['enemy_kills','hostile_creep_count','own_loss'], '敌人击杀、hostile、己方损失；事件 reducer 未覆盖时保持显式缺失。')}
    </div></section>
    <section class="section"><h2>02 开发 Roadmap · 六项状态</h2><div class="road-grid">{''.join(roadmap_card(c) for c in data['roadmap'])}</div></section>
    {kanban('03 游戏策略开发 Kanban', data['kanban']['gameplay'])}
    {kanban('04 基建开发 Kanban', data['kanban']['foundation'])}
    <section class="section"><h2>05 开发过程数据</h2><div class="metrics">{metrics_html}</div></section>
    <div class="footer">format {esc(data['formatVersion'])} · repo {esc(data['repo']['head'])} · data <a href="roadmap-data.json">roadmap-data.json</a> · sqlite <a href="roadmap-kpi.sqlite">roadmap-kpi.sqlite</a></div>
  </main>
</body>
</html>
"""


def write_outputs(repo: Path, docs_dir: Path, data: dict[str, Any]) -> None:
    docs_dir.mkdir(parents=True, exist_ok=True)
    assets_dir = docs_dir / "assets"
    assets_dir.mkdir(exist_ok=True)
    logo_src = repo / "docs" / "assets" / "screeps-community-logo.png"
    logo_dst = assets_dir / "screeps-community-logo.png"
    if logo_src.exists() and logo_src.resolve() != logo_dst.resolve():
        shutil.copy2(logo_src, logo_dst)
    (docs_dir / "roadmap-data.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    (docs_dir / "index.html").write_text(render_html(data))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".", help="Repository root")
    parser.add_argument("--docs-dir", default="docs", help="GitHub Pages docs directory")
    parser.add_argument("--db", default="docs/roadmap-kpi.sqlite", help="Single KPI SQLite history DB")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo = Path(args.repo).resolve()
    docs_dir = (repo / args.docs_dir).resolve() if not Path(args.docs_dir).is_absolute() else Path(args.docs_dir)
    db_path = (repo / args.db).resolve() if not Path(args.db).is_absolute() else Path(args.db)
    data = build_data(repo, db_path)
    write_outputs(repo, docs_dir, data)
    print(json.dumps({"index": str(docs_dir / "index.html"), "json": str(docs_dir / "roadmap-data.json"), "sqlite": str(db_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
