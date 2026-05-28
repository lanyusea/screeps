#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
import sys
import urllib.error
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_grafana as grafana


REPO_ROOT = Path(__file__).resolve().parents[1]


class ScreepsRlGrafanaContractTest(unittest.TestCase):
    def test_static_repository_contract_passes_without_running_grafana(self) -> None:
        report = grafana.validate_static(REPO_ROOT)

        self.assertEqual(report["status"], "PASS")
        self.assertEqual(report["datasourceUid"], grafana.DATASOURCE_UID)
        self.assertEqual(report["datasourceType"], grafana.DATASOURCE_TYPE)
        self.assertGreaterEqual(report["panelCount"], 13)
        self.assertEqual(report["metricsDb"]["status"], "MISSING")
        coverage_checks = {
            check["name"]: check["status"]
            for check in report["checks"]
            if check["name"].startswith("dashboard query coverage:")
        }
        for coverage_name in grafana.REQUIRED_QUERY_COVERAGE:
            self.assertEqual(coverage_checks[f"dashboard query coverage: {coverage_name}"], "PASS")

    def test_dashboard_contract_rejects_missing_iteration_decision_query(self) -> None:
        dashboard_path = grafana.dashboard_file(REPO_ROOT)
        dashboard = json.loads(dashboard_path.read_text(encoding="utf-8"))
        broken_dashboard = copy.deepcopy(dashboard)
        broken_dashboard["panels"] = [
            panel for panel in broken_dashboard["panels"] if panel.get("id") != 13
        ]

        report = grafana.validate_dashboard_payload(broken_dashboard, dashboard_path)

        self.assertEqual(report["status"], "FAIL")
        self.assertIn(
            "#879 iteration decisions",
            "\n".join(error for error in report["errors"]),
        )

    def test_live_validator_reports_not_running_instead_of_pass(self) -> None:
        report = grafana.validate_live("http://127.0.0.1:9", timeout=0.1)

        self.assertEqual(report["status"], "NOT_RUNNING")
        self.assertEqual(report["checks"][0]["status"], "NOT_RUNNING")

    def test_live_validator_tolerates_datasource_api_forbidden_for_anonymous_viewer(self) -> None:
        def fake_fetch_json(url: str, timeout: float) -> tuple[int, grafana.JsonObject]:
            if url.endswith("/api/health"):
                return 200, {"database": "ok", "version": "test"}
            if url.endswith(f"/api/datasources/uid/{grafana.DATASOURCE_UID}"):
                raise urllib.error.HTTPError(url, 403, "Forbidden", hdrs=None, fp=None)
            if url.endswith(f"/api/dashboards/uid/{grafana.DASHBOARD_UID}"):
                return 200, {"dashboard": {"uid": grafana.DASHBOARD_UID, "title": grafana.DASHBOARD_TITLE}}
            raise AssertionError(f"unexpected JSON fetch: {url}")

        with patch.object(grafana, "fetch_json", side_effect=fake_fetch_json), patch.object(
            grafana, "fetch_status", return_value=200
        ):
            report = grafana.validate_live("http://grafana.test", timeout=0.1)

        datasource_check = next(
            check for check in report["checks"] if check["name"] == "grafana datasource reachability"
        )
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(datasource_check["status"], "SKIP")
        self.assertIn("anonymous Viewer", datasource_check["details"])
        self.assertTrue(any("static provisioning validation is authoritative" in warning for warning in report["warnings"]))

    def test_docker_command_mounts_provisioning_dashboard_and_metrics_db(self) -> None:
        db_path = REPO_ROOT / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"

        command = grafana.build_docker_command(
            repo_root=REPO_ROOT,
            db_path=db_path,
            host="127.0.0.1",
            port=3000,
            image="grafana/grafana-oss:test",
            plugin=grafana.DATASOURCE_TYPE,
            container_name="screeps-rl-grafana-test",
        )
        command_text = " ".join(command)

        self.assertIn("127.0.0.1:3000:3000", command)
        self.assertIn(f"GF_INSTALL_PLUGINS={grafana.DATASOURCE_TYPE}", command)
        self.assertIn(f"GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS={grafana.DATASOURCE_TYPE}", command)
        self.assertIn(f"{grafana.grafana_root(REPO_ROOT) / 'provisioning'}:{grafana.CONTAINER_PROVISIONING_PATH}:ro", command)
        self.assertIn(f"{grafana.grafana_root(REPO_ROOT)}:{grafana.CONTAINER_DASHBOARD_PATH}:ro", command)
        self.assertIn(f"{db_path.parent.resolve()}:/var/lib/grafana/rl-metrics:ro", command)
        self.assertIn("grafana/grafana-oss:test", command)
        self.assertNotIn("0.0.0.0:3000:3000", command_text)


if __name__ == "__main__":
    unittest.main()
