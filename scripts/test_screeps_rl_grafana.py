#!/usr/bin/env python3
from __future__ import annotations

import copy
import io
import json
import subprocess
import sys
import tempfile
import urllib.error
import unittest
from contextlib import redirect_stderr, redirect_stdout
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
        target_contract_check = next(
            check for check in report["checks"] if check["name"] == "dashboard frser SQLite target contract"
        )
        self.assertEqual(target_contract_check["status"], "PASS")

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

    def test_dashboard_contract_rejects_missing_frser_sqlite_target_fields(self) -> None:
        dashboard_path = grafana.dashboard_file(REPO_ROOT)
        dashboard = json.loads(dashboard_path.read_text(encoding="utf-8"))
        broken_dashboard = copy.deepcopy(dashboard)
        target = broken_dashboard["panels"][1]["targets"][0]
        target.pop("rawQueryText", None)
        target.pop("queryType", None)
        target.pop("timeColumns", None)

        report = grafana.validate_dashboard_payload(broken_dashboard, dashboard_path)

        self.assertEqual(report["status"], "FAIL")
        errors = "\n".join(error for error in report["errors"])
        self.assertIn("rawQueryText", errors)
        self.assertIn("queryType", errors)
        self.assertIn("timeColumns", errors)

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

        self.assertIn("-d", command)
        self.assertIn("--restart", command)
        self.assertIn(grafana.DEFAULT_DOCKER_RESTART_POLICY, command)
        self.assertIn("127.0.0.1:3000:3000", command)
        self.assertIn(f"GF_INSTALL_PLUGINS={grafana.DATASOURCE_TYPE}", command)
        self.assertIn(f"GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS={grafana.DATASOURCE_TYPE}", command)
        self.assertIn(f"{grafana.grafana_root(REPO_ROOT) / 'provisioning'}:{grafana.CONTAINER_PROVISIONING_PATH}:ro", command)
        self.assertIn(f"{grafana.grafana_root(REPO_ROOT)}:{grafana.CONTAINER_DASHBOARD_PATH}:ro", command)
        self.assertIn(f"{db_path.resolve()}:{grafana.CONTAINER_DB_PATH}:ro", command)
        self.assertNotIn(f"{db_path.parent.resolve()}:/var/lib/grafana/rl-metrics:ro", command)
        self.assertIn("grafana/grafana-oss:test", command)
        self.assertNotIn("--rm", command)
        self.assertNotIn("0.0.0.0:3000:3000", command_text)

    def test_docker_command_mounts_custom_db_file_to_provisioned_container_path(self) -> None:
        db_path = Path("/tmp/custom-rl-metrics.sqlite")

        command = grafana.build_docker_command(
            repo_root=REPO_ROOT,
            db_path=db_path,
            host="127.0.0.1",
            port=3000,
            image="grafana/grafana-oss:test",
            plugin=grafana.DATASOURCE_TYPE,
            container_name="screeps-rl-grafana-test",
        )

        self.assertIn(f"{db_path.resolve()}:{grafana.CONTAINER_DB_PATH}:ro", command)
        self.assertNotIn(f"{db_path.parent.resolve()}:/var/lib/grafana/rl-metrics:ro", command)

    def test_docker_command_rejects_nonlocal_host_without_override(self) -> None:
        stderr = io.StringIO()

        with redirect_stderr(stderr):
            exit_code = grafana.main(["docker-command", "--host", "0.0.0.0"])

        self.assertEqual(exit_code, 2)
        self.assertIn("refusing non-local host binding", stderr.getvalue())
        self.assertIn("--allow-nonlocal", stderr.getvalue())

    def test_run_rejects_nonlocal_host_before_starting_container(self) -> None:
        stderr = io.StringIO()

        with redirect_stderr(stderr):
            exit_code = grafana.main(["run", "--host", "0.0.0.0", "--print-only"])

        self.assertEqual(exit_code, 2)
        self.assertIn("refusing non-local host binding", stderr.getvalue())

    def test_docker_command_allows_explicit_nonlocal_override(self) -> None:
        stdout = io.StringIO()

        with redirect_stdout(stdout):
            exit_code = grafana.main(["docker-command", "--host", "0.0.0.0", "--allow-nonlocal"])

        self.assertEqual(exit_code, 0)
        self.assertIn("0.0.0.0:3000:3000", stdout.getvalue())

    def test_docker_command_formats_ipv6_loopback_binding(self) -> None:
        command = grafana.build_docker_command(
            repo_root=REPO_ROOT,
            db_path=REPO_ROOT / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite",
            host="::1",
            port=3000,
            image="grafana/grafana-oss:test",
            plugin=grafana.DATASOURCE_TYPE,
            container_name="screeps-rl-grafana-test",
        )

        self.assertIn("[::1]:3000:3000", command)

    def test_ensure_durable_container_creates_missing_container(self) -> None:
        command = ["docker", "run", "-d", "--restart", "unless-stopped", "--name", "test"]

        with patch.object(grafana.subprocess, "run") as run:
            run.side_effect = [
                subprocess.CompletedProcess(["docker", "inspect"], 1, stdout="", stderr="missing"),
                subprocess.CompletedProcess(command, 0, stdout="container-id\n", stderr=""),
            ]
            exit_code = grafana.ensure_durable_container(command, "test", "unless-stopped")

        self.assertEqual(exit_code, 0)
        self.assertEqual(run.call_args_list[0].args[0][:3], ["docker", "inspect", "--format"])
        self.assertEqual(run.call_args_list[1].args[0], command)

    def test_ensure_durable_container_starts_existing_container_with_restart_policy(self) -> None:
        command = ["docker", "run", "-d", "--restart", "unless-stopped", "--name", "test"]

        with patch.object(grafana.subprocess, "run") as run:
            run.side_effect = [
                subprocess.CompletedProcess(["docker", "inspect"], 0, stdout="false\n", stderr=""),
                subprocess.CompletedProcess(["docker", "update"], 0, stdout="test\n", stderr=""),
                subprocess.CompletedProcess(["docker", "start"], 0, stdout="test\n", stderr=""),
            ]
            exit_code = grafana.ensure_durable_container(command, "test", "unless-stopped")

        self.assertEqual(exit_code, 0)
        self.assertEqual(run.call_args_list[1].args[0], ["docker", "update", "--restart", "unless-stopped", "test"])
        self.assertEqual(run.call_args_list[2].args[0], ["docker", "start", "test"])

    def test_run_uses_durable_container_command(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".sqlite") as db_file:
            with patch.object(grafana.subprocess, "run") as run:
                run.side_effect = [
                    subprocess.CompletedProcess(["docker", "inspect"], 1, stdout="", stderr="missing"),
                    subprocess.CompletedProcess(["docker", "run"], 0, stdout="container-id\n", stderr=""),
                ]
                exit_code = grafana.main(["run", "--db-path", db_file.name])

        self.assertEqual(exit_code, 0)
        docker_run = run.call_args_list[1].args[0]
        self.assertIn("-d", docker_run)
        self.assertIn("--restart", docker_run)
        self.assertIn(grafana.DEFAULT_DOCKER_RESTART_POLICY, docker_run)
        self.assertIn("127.0.0.1:3000:3000", docker_run)
        self.assertNotIn("--rm", docker_run)


if __name__ == "__main__":
    unittest.main()
