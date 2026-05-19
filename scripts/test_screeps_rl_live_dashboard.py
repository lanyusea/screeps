#!/usr/bin/env python3
from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import unittest
import urllib.request
from pathlib import Path
from typing import Any


sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_live_dashboard as live


JsonObject = dict[str, Any]


def write_json(path: Path, payload: JsonObject) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


def write_runtime_summary(path: Path) -> None:
    payload = {
        "type": "runtime-summary",
        "tick": 12345,
        "shard": "shardX",
        "cpu": {"bucket": 9000, "used": 7.5},
        "reliability": {"loopExceptionCount": 0, "telemetrySilenceTicks": 0},
        "rooms": [
            {
                "roomName": "E29N55",
                "controller": {"my": True, "level": 3},
                "rclLevel": 3,
                "workerCount": 4,
                "spawnStatus": [{"name": "Spawn1", "status": "idle"}],
                "taskCounts": {"harvest": 1, "build": 1, "upgrade": 2},
                "energyAvailable": 300,
                "resources": {"storedEnergy": 900, "workerCarriedEnergy": 50},
                "combat": {"hostileCreepCount": 0},
                "structures": {"spawn": 1, "tower": 1, "rampart": 0},
            }
        ],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"#runtime-summary {json.dumps(payload, sort_keys=True)}\n", encoding="utf-8")


def write_live_artifacts(root: Path) -> None:
    write_runtime_summary(root / "runtime-summary-console" / "runtime.log")
    write_json(
        root / "rl-dataset-gates" / "e1-live" / "gate_summary.json",
        {
            "type": "screeps-rl-dataset-evaluation-gate",
            "gateId": "e1-live",
            "datasetGate": {"status": "pass", "sampleCount": 100},
            "quality_checks": {"status": "pass", "samples_accepted": 95, "samples_rejected": 5},
            "createdAt": "2026-05-18T10:00:00Z",
        },
    )
    write_json(
        root / "rl-control-loop" / "training-ledger.json",
        {
            "type": "screeps-rl-training-execution-ledger",
            "status": "RUN",
            "trainingDidRun": True,
            "iterationExecution": {
                "episodesRun": 7,
                "policyUpdateIterations": 3,
                "simulatorTicksRun": 1400,
            },
            "environmentExecution": {"completed": 2, "failed": 0, "lastNewRunAt": "2026-05-18T10:05:00Z"},
            "createdAt": "2026-05-18T10:05:00Z",
        },
    )
    write_json(
        root / "rl-control-loop" / "policy-advantage.json",
        {
            "type": "screeps-rl-policy-online-advantage-report",
            "onlineUtilityStatus": "PROVEN",
            "candidatePolicyId": "candidate-policy",
            "baselinePolicyId": "incumbent-policy",
            "trainingReportIds": ["training-report-tencent-test"],
            "metricsByCategory": {
                "territory": {"status": "ADVANTAGE", "candidateValue": 3, "baselineValue": 2, "delta": 1},
            },
            "createdAt": "2026-05-18T10:06:00Z",
        },
    )
    write_json(
        root / "rl-control-loop" / "scorecards" / "scorecard.json",
        {
            "type": "screeps-rl-evaluation-scorecard",
            "runId": "scorecard-live",
            "overallGate": {"status": "PASS", "safetyRegressions": []},
            "requiredActions": [],
            "createdAt": "2026-05-18T10:07:00Z",
        },
    )
    write_json(
        root / "tencent-cloud" / "batch-runs" / "tencent-live" / "controller-summary.json",
        {
            "type": "screeps-tencent-batch-rl-run",
            "runId": "tencent-live",
            "startedAt": "2026-05-18T10:01:00Z",
            "finishedAt": "2026-05-18T10:08:00Z",
            "finalStatus": "completed",
            "partial": False,
            "instanceId": "ins-live",
            "workerUser": "screeps-batch",
            "inputs": {"ticks": 500, "workers": 5, "repetitions": 5},
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
                "billingGuardBeforeScale": True,
                "scaleDownAttempted": True,
            },
        },
    )
    (root / "rl-training").mkdir(parents=True, exist_ok=True)


def count_rows(db_path: Path, table: str) -> int:
    with sqlite3.connect(db_path) as conn:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def read_json_url(url: str, timeout: float = 1.0) -> JsonObject:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise AssertionError(f"expected JSON object from {url}")
    return payload


def post_json_url(url: str, timeout: float = 1.0) -> tuple[int, JsonObject]:
    request = urllib.request.Request(url, data=b"", method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        status = error.code
        payload = json.loads(error.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise AssertionError(f"expected JSON object from {url}")
    return status, payload


def wait_for_json_url(url: str, timeout_seconds: float = 5.0) -> JsonObject:
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while True:
        try:
            return read_json_url(url)
        except urllib.error.HTTPError:
            raise
        except (OSError, json.JSONDecodeError) as error:
            last_error = error
            if time.monotonic() >= deadline:
                raise AssertionError(f"server did not become ready at {url}: {last_error}") from last_error
            time.sleep(0.05)


class ScreepsRlLiveDashboardTest(unittest.TestCase):
    def test_refresh_is_repeatable_and_summary_covers_live_observability(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)

            first_refresh = live.refresh_metrics(db_path, artifact_root)
            first_counts = {
                table: count_rows(db_path, table)
                for table in ("metric_observations", "rl_dataset_gate_metrics", "metric_coverage_gaps")
            }
            second_refresh = live.refresh_metrics(db_path, artifact_root)
            second_counts = {
                table: count_rows(db_path, table)
                for table in ("metric_observations", "rl_dataset_gate_metrics", "metric_coverage_gaps")
            }
            summary = live.build_live_summary(
                repo_root,
                artifact_root,
                db_path,
                generated_at="2026-05-18T10:09:00Z",
            )
            html = live.render_live_html(
                summary,
                live.LiveDashboardConfig(repo_root=repo_root, artifact_root=artifact_root, db_path=db_path),
            )

        self.assertTrue(first_refresh["ok"])
        self.assertTrue(second_refresh["ok"])
        self.assertEqual(second_counts, first_counts)
        self.assertTrue(summary["health"]["ok"])
        self.assertEqual(summary["e1Gate"]["acceptanceRate"], 0.95)
        self.assertEqual(summary["loopA"]["environment"]["ticksRun"], 1400)
        self.assertEqual(summary["loopA"]["training"]["episodes"], 7.0)
        self.assertEqual(summary["loopB"]["onlineUtilityStatus"], "PROVEN")
        self.assertEqual(summary["loopB"]["scorecard"]["status"], "PASS")
        self.assertEqual(summary["tencentBatch"]["latest"]["runId"], "tencent-live")
        self.assertEqual(summary["tencentBatch"]["latest"]["batchScale"]["batchClass"], "smoke")
        self.assertEqual(summary["tencentBatch"]["latest"]["batchScale"]["environmentRows"], 25)
        self.assertEqual(summary["tencentBatch"]["latest"]["batchScale"]["simulatorTicks"], 12500)
        self.assertFalse(summary["tencentBatch"]["latest"]["batchScale"]["scaleFirstEligible"])
        self.assertEqual(summary["safety"]["status"], "OK")
        self.assertIn("E1 Gate Acceptance", html)
        self.assertIn("Loop A Env Ticks Episodes", html)
        self.assertIn("Loop B Utility Scorecard", html)
        self.assertIn("Tencent Batch Utilization", html)
        self.assertIn("Latest batch class", html)
        self.assertIn("Safety Flags", html)

    def test_missing_tencent_safety_object_blocks_dashboard(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            controller_summary = artifact_root / "tencent-cloud" / "batch-runs" / "tencent-live" / "controller-summary.json"
            payload = json.loads(controller_summary.read_text(encoding="utf-8"))
            payload.pop("safety")
            write_json(controller_summary, payload)

            summary = live.build_live_summary(
                repo_root,
                artifact_root,
                db_path,
                generated_at="2026-05-18T10:09:00Z",
            )

        missing_fields = {
            flag["field"]
            for flag in summary["safety"]["unsafeFlags"]
            if flag.get("source") == "tencent" and flag.get("value") == "missing"
        }
        self.assertEqual(summary["safety"]["status"], "BLOCKED")
        self.assertEqual(missing_fields, set(live.REQUIRED_TENCENT_SAFETY_FIELDS))

    def test_missing_tencent_safety_field_blocks_dashboard(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            controller_summary = artifact_root / "tencent-cloud" / "batch-runs" / "tencent-live" / "controller-summary.json"
            payload = json.loads(controller_summary.read_text(encoding="utf-8"))
            payload["safety"].pop("officialMmoWritesAllowed")
            write_json(controller_summary, payload)

            summary = live.build_live_summary(
                repo_root,
                artifact_root,
                db_path,
                generated_at="2026-05-18T10:09:00Z",
            )

        self.assertEqual(summary["safety"]["status"], "BLOCKED")
        self.assertIn(
            {"source": "tencent", "field": "officialMmoWritesAllowed", "value": "missing"},
            summary["safety"]["unsafeFlags"],
        )

    def test_missing_tencent_controller_summary_blocks_dashboard(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            controller_summary = artifact_root / "tencent-cloud" / "batch-runs" / "tencent-live" / "controller-summary.json"
            controller_summary.unlink()

            summary = live.build_live_summary(
                repo_root,
                artifact_root,
                db_path,
                generated_at="2026-05-18T10:09:00Z",
            )

        self.assertEqual(summary["safety"]["status"], "BLOCKED")
        self.assertIn(
            {"source": "tencent", "field": "controllerSummary", "value": "missing"},
            summary["safety"]["unsafeFlags"],
        )

    def test_missing_scorecard_summary_blocks_dashboard(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            scorecard = artifact_root / "rl-control-loop" / "scorecards" / "scorecard.json"
            scorecard.unlink()

            summary = live.build_live_summary(
                repo_root,
                artifact_root,
                db_path,
                generated_at="2026-05-18T10:09:00Z",
            )

        self.assertEqual(summary["safety"]["status"], "BLOCKED")
        self.assertIn(
            {"source": "scorecard", "field": "summary", "value": "missing"},
            summary["safety"]["unsafeFlags"],
        )

    def test_health_and_summary_endpoints_are_startable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            live.refresh_metrics(db_path, artifact_root)
            config = live.LiveDashboardConfig(repo_root=repo_root, artifact_root=artifact_root, db_path=db_path)
            try:
                server = live.make_server("127.0.0.1", 0, config)
            except OSError as error:
                self.skipTest(f"socket creation is unavailable in this sandbox: {error}")
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                host, port = server.server_address
                health = wait_for_json_url(f"http://{host}:{port}/healthz")
                summary = read_json_url(f"http://{host}:{port}/api/summary")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

        self.assertTrue(health["ok"])
        self.assertEqual(summary["type"], "screeps-rl-live-dashboard")
        self.assertEqual(summary["dashboardUrl"], f"http://{host}:{port}/")
        self.assertEqual(summary["e1Gate"]["gateId"], "e1-live")

    def test_refresh_endpoint_is_disabled_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            config = live.LiveDashboardConfig(repo_root=repo_root, artifact_root=artifact_root, db_path=db_path)
            try:
                server = live.make_server("127.0.0.1", 0, config)
            except OSError as error:
                self.skipTest(f"socket creation is unavailable in this sandbox: {error}")
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                host, port = server.server_address
                wait_for_json_url(f"http://{host}:{port}/api/summary")
                status, payload = post_json_url(f"http://{host}:{port}/refresh")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

        self.assertEqual(status, 403)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], "refresh endpoint disabled")
        self.assertFalse(db_path.exists())

    def test_refresh_endpoint_propagates_soft_refresh_failure(self) -> None:
        original_refresh_metrics = live.refresh_metrics

        def failing_refresh_metrics(db_path: Path, artifact_root: Path, paths: Any = None) -> JsonObject:
            return {"ok": False, "error": "ingestor soft failure"}

        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            config = live.LiveDashboardConfig(
                repo_root=repo_root,
                artifact_root=artifact_root,
                db_path=db_path,
                enable_refresh_endpoint=True,
            )
            try:
                server = live.make_server("127.0.0.1", 0, config)
            except OSError as error:
                self.skipTest(f"socket creation is unavailable in this sandbox: {error}")
            live.refresh_metrics = failing_refresh_metrics
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                host, port = server.server_address
                wait_for_json_url(f"http://{host}:{port}/api/summary")
                status, payload = post_json_url(f"http://{host}:{port}/refresh")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
                live.refresh_metrics = original_refresh_metrics

        self.assertEqual(status, 500)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], "refresh failed")
        self.assertEqual(payload["refresh"]["error"], "ingestor soft failure")

    def test_refresh_on_start_returns_failure_when_refresh_reports_not_ok(self) -> None:
        original_refresh_metrics = live.refresh_metrics

        def failing_refresh_metrics(db_path: Path, artifact_root: Path, paths: Any = None) -> JsonObject:
            return {"ok": False, "error": "ingestor soft failure"}

        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            live.refresh_metrics = failing_refresh_metrics
            try:
                exit_code = live.main(
                    [
                        "serve",
                        "--repo-root",
                        str(repo_root),
                        "--artifact-root",
                        str(artifact_root),
                        "--db",
                        str(db_path),
                        "--refresh-on-start",
                        "--port",
                        "0",
                    ]
                )
            finally:
                live.refresh_metrics = original_refresh_metrics

        self.assertEqual(exit_code, 1)


if __name__ == "__main__":
    unittest.main()
