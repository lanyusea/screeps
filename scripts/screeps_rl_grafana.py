#!/usr/bin/env python3
"""Validate and run the local Grafana surface for Screeps RL metrics."""

from __future__ import annotations

import argparse
import json
import shlex
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
CONTAINER_DB_PATH = "/var/lib/grafana/rl-metrics/rl_metrics.sqlite"
CONTAINER_DASHBOARD_PATH = "/var/lib/grafana/dashboards/screeps"
CONTAINER_PROVISIONING_PATH = "/etc/grafana/provisioning"
LOCAL_GRAFANA_HOSTS = {"127.0.0.1", "localhost", "::1"}

REQUIRED_QUERY_COVERAGE = {
    "metric observation history": "FROM metric_observations",
    "runtime room metrics": "FROM runtime_room_metrics",
    "gameplay behavior findings": "FROM gameplay_behavior_findings",
    "metric coverage gaps": "FROM metric_coverage_gaps",
    "E1 dataset gate metrics": "FROM rl_dataset_gate_metrics",
    "Loop A training execution metrics": "FROM rl_training_execution_metrics",
    "Loop B policy advantage metrics": "FROM rl_policy_advantage_metrics",
    "#879 iteration decisions": "FROM metric_iteration_decisions",
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
) -> list[str]:
    validate_host_binding(host, allow_nonlocal)
    repo_root = repo_root.resolve()
    db_path = db_path.resolve()
    return [
        "docker",
        "run",
        "--rm",
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


def render_command(command: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in command)


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


def exit_code_for_report(report: JsonObject) -> int:
    if report["status"] == "PASS":
        return 0
    if report["status"] == "NOT_RUNNING":
        return 2
    return 1


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
    return subprocess.run(command, check=False).returncode


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
