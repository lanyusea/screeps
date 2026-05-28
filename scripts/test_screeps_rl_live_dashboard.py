#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import io
import json
import os
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import unittest
import urllib.request
from http import HTTPStatus
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
            "policyGradient": {
                "runner_support": {
                    "runtime_parameter_injection": False,
                    "candidate_parameter_scope": "metadata_only",
                }
            },
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
            "batchScale": {
                "environmentRows": 25,
                "simulatorTicks": 12500,
                "wallClockSeconds": 420,
                "asgActiveSeconds": 600,
                "costEstimate": {"currency": "USD", "amount": 1.23},
            },
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
                "conservative_actions_only": True,
                "ood_rejection": True,
                "billingGuardBeforeScale": True,
                "scaleDownAttempted": True,
            },
        },
    )
    write_json(
        root / "rl-control-loop" / "decision.json",
        {
            "type": "screeps-rl-iteration-decision",
            "decisionId": "decision-live",
            "decision": "hold",
            "feedbackIngestion": {"findingId": "finding-live"},
            "createdAt": "2026-05-18T10:08:30Z",
        },
    )
    (root / "rl-training").mkdir(parents=True, exist_ok=True)


def count_rows(db_path: Path, table: str) -> int:
    with sqlite3.connect(db_path) as conn:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def count_metric_rows_excluding_refresh(db_path: Path) -> int:
    with sqlite3.connect(db_path) as conn:
        return int(
            conn.execute(
                "SELECT COUNT(*) FROM metric_observations WHERE metric_name != ?",
                ("source.rl_metrics_refresh.completed",),
            ).fetchone()[0]
        )


def count_refresh_observations(db_path: Path) -> int:
    with sqlite3.connect(db_path) as conn:
        return int(
            conn.execute(
                "SELECT COUNT(*) FROM metric_observations WHERE metric_name = ?",
                ("source.rl_metrics_refresh.completed",),
            ).fetchone()[0]
        )


def read_json_url(url: str, timeout: float = 1.0) -> JsonObject:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise AssertionError(f"expected JSON object from {url}")
    return payload


def get_json_url(url: str, timeout: float = 1.0) -> tuple[int, JsonObject]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            status = response.status
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        status = error.code
        payload = json.loads(error.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise AssertionError(f"expected JSON object from {url}")
    return status, payload


def wait_for_refresh_release(release_refresh: threading.Event) -> None:
    if not release_refresh.wait(timeout=5):
        raise AssertionError("test did not release blocked refresh")


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


def make_unbound_live_server(
    config: live.LiveDashboardConfig,
    server_address: tuple[str, int] = ("127.0.0.1", 8765),
) -> live.LiveDashboardHTTPServer:
    server = live.LiveDashboardHTTPServer.__new__(live.LiveDashboardHTTPServer)
    server.config = config
    server.server_address = server_address
    server.refresh_lock = threading.Lock()
    server.refresh_state_lock = threading.Lock()
    server.summary_lock = threading.Lock()
    server.background_refresh_threads_lock = threading.Lock()
    server.background_refresh_threads = []
    server.refresh_stop = threading.Event()
    server.refresh_thread = None
    server.summary_cache = None
    server.summary_cache_dashboard_url = None
    server.summary_cache_until = 0.0
    server.summary_cache_generation = 0
    server.refresh_state = {
        "mode": "auto" if config.auto_refresh_seconds > 0 else "manual",
        "autoRefreshSeconds": config.auto_refresh_seconds if config.auto_refresh_seconds > 0 else None,
        "initialRefreshRequired": config.initial_refresh_required,
        "refreshInProgress": False,
        "activeRefreshStartedAt": None,
        "activeRefreshReason": None,
        "lastRefreshAt": None,
        "lastRefreshOk": None,
        "lastRefresh": None,
        "nextRefreshAt": live.utc_iso_after(config.auto_refresh_seconds)
        if config.auto_refresh_seconds > 0
        else None,
    }
    return server


class ScreepsRlLiveDashboardTest(unittest.TestCase):
    def test_tencent_active_run_within_declared_timeout_uses_utc_age(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-20260521t084005z"
            write_json(
                run_dir / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-20260521t084005z",
                    "startedAt": "2026-05-21T08:40:06Z",
                    "finishedAt": None,
                    "partial": True,
                    "finalStatus": "unknown",
                    "controllerProcess": {"pid": 4185673},
                    "inputs": {
                        "executionTimeouts": {
                            "trainingTimeoutSeconds": 7200,
                            "scaleTimeoutSeconds": 1200,
                            "scaleDownTimeoutSeconds": 900,
                            "bootstrapTimeoutSeconds": 1800,
                            "transferTimeoutSeconds": 1200,
                        }
                    },
                    "execution": {
                        "environmentsRun": 0,
                        "artifactCount": 0,
                        "trainingReportProduced": False,
                    },
                },
            )

            summary = live.tencent_batch_summary_at(root, root, now="2026-05-21T17:05:00+08:00")

        latest = summary["latest"]
        state = latest["runnerState"]
        self.assertEqual(summary["activeRunCount"], 1)
        self.assertEqual(latest["stateClassification"], "TRAINING_IN_PROGRESS")
        self.assertEqual(state["ageSeconds"], 1494)
        self.assertEqual(state["timeoutSeconds"], 12300)
        self.assertFalse(state["handoffRequired"])
        self.assertEqual(state["action"], "monitor")

    def test_tencent_active_run_beyond_timeout_without_progress_reports_stuck_handoff(self) -> None:
        payload = {
            "type": "screeps-tencent-batch-rl-run",
            "runId": "tencent-pg-20260521t091504z",
            "startedAt": "2026-05-21T09:15:04Z",
            "finishedAt": None,
            "partial": True,
            "finalStatus": "running",
            "controllerProcess": {"pid": 49283},
            "inputs": {"executionTimeouts": {"totalSeconds": 12300}},
            "execution": {
                "environmentsRun": 0,
                "artifactCount": 0,
                "trainingReportProduced": False,
            },
        }

        state = live.classify_tencent_batch_run_state(payload, now="2026-05-21T12:40:05Z")

        self.assertEqual(state["status"], "TENCENT_BATCH_RUNNER_STUCK")
        self.assertEqual(state["runId"], "tencent-pg-20260521t091504z")
        self.assertEqual(state["pid"], 49283)
        self.assertEqual(state["ageSeconds"], 12301)
        self.assertEqual(state["timeoutSeconds"], 12300)
        self.assertTrue(state["handoffRequired"])
        self.assertIn("kill PID 49283", state["action"])
        self.assertIn("scale down ASG", state["action"])
        self.assertIn("age=12301s", state["evidence"])
        self.assertIn("timeout=12300s", state["evidence"])

    def test_refresh_is_repeatable_and_summary_covers_live_observability(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)

            first_refresh = live.refresh_metrics(db_path, artifact_root)
            first_counts = {
                "metric_observations_without_refresh": count_metric_rows_excluding_refresh(db_path),
                "rl_dataset_gate_metrics": count_rows(db_path, "rl_dataset_gate_metrics"),
                "metric_coverage_gaps": count_rows(db_path, "metric_coverage_gaps"),
            }
            second_refresh = live.refresh_metrics(db_path, artifact_root)
            second_counts = {
                "metric_observations_without_refresh": count_metric_rows_excluding_refresh(db_path),
                "rl_dataset_gate_metrics": count_rows(db_path, "rl_dataset_gate_metrics"),
                "metric_coverage_gaps": count_rows(db_path, "metric_coverage_gaps"),
            }
            refresh_observation_count = count_refresh_observations(db_path)
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
        self.assertEqual(refresh_observation_count, 2)
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
        self.assertEqual(summary["tencentBatch"]["latest"]["batchScale"]["asgActiveSeconds"], 600.0)
        self.assertEqual(summary["tencentBatch"]["latest"]["batchScale"]["utilizationRatio"], 0.7)
        self.assertFalse(summary["tencentBatch"]["latest"]["batchScale"]["scaleFirstEligible"])
        self.assertEqual(summary["safety"]["status"], "OK")
        self.assertTrue(summary["safety"]["conservativeActionsOnly"])
        self.assertTrue(summary["safety"]["oodRejection"])
        self.assertEqual(summary["runtimeCandidateInjection"]["status"], "BLOCKED")
        self.assertEqual(summary["zeroIterationPolicyUpdate"]["status"], "N/A")
        self.assertEqual(summary["flywheelStages"][0]["stage"], "construction-landed")
        self.assertIn("#879", {row["issue"] for row in summary["projectGates"]})
        self.assertIn("E1 Gate Acceptance", html)
        self.assertIn("Loop A Env Ticks Episodes", html)
        self.assertIn("Loop B Utility Scorecard", html)
        self.assertIn("Tencent Batch Utilization", html)
        self.assertIn("Latest batch class", html)
        self.assertIn("Safety Flags", html)
        self.assertIn("#879 Flywheel Stage Proof", html)
        self.assertIn("Project Gate Status", html)
        self.assertIn("SQLite Table Counts", html)
        self.assertIn("#924 Scorecard Status", html)

    def test_live_summary_does_not_call_unbounded_static_dashboard_builder(self) -> None:
        original_build_dashboard = live.static_dashboard.build_dashboard

        def unbounded_build_dashboard(*_args: Any, **_kwargs: Any) -> JsonObject:
            raise AssertionError("static dashboard full artifact scan should not run in live summary")

        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            live.refresh_metrics(db_path, artifact_root)
            live.static_dashboard.build_dashboard = unbounded_build_dashboard
            try:
                summary = live.build_live_summary(
                    repo_root,
                    artifact_root,
                    db_path,
                    generated_at="2026-05-18T10:09:00Z",
                )
            finally:
                live.static_dashboard.build_dashboard = original_build_dashboard

        self.assertEqual(summary["e1Gate"]["gateId"], "e1-live")
        self.assertEqual(summary["loopA"]["training"]["episodes"], 7.0)
        self.assertEqual(summary["loopB"]["onlineUtilityStatus"], "PROVEN")

    def test_bounded_dashboard_sections_use_declared_artifact_sources(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-control-loop" / "training-ledger.json",
                {
                    "type": "screeps-rl-training-execution-ledger",
                    "status": "RUN",
                    "trainingDidRun": True,
                    "iterationExecution": {"episodesRun": 1, "policyUpdateIterations": 0, "simulatorTicksRun": 100},
                    "environmentExecution": {"completed": 1, "failed": 0, "lastNewRunAt": "2026-05-18T10:00:00Z"},
                    "createdAt": "2026-05-18T10:00:00Z",
                },
            )
            write_json(
                artifact_root / "rl-training" / "training-ledger-new.json",
                {
                    "type": "screeps-rl-training-execution-ledger",
                    "status": "RUN",
                    "trainingDidRun": True,
                    "iterationExecution": {"episodesRun": 11, "policyUpdateIterations": 2, "simulatorTicksRun": 2200},
                    "environmentExecution": {"completed": 3, "failed": 0, "lastNewRunAt": "2026-05-18T10:10:00Z"},
                    "createdAt": "2026-05-18T10:10:00Z",
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "policy-advantage.json",
                {
                    "type": "screeps-rl-policy-online-advantage-report",
                    "onlineUtilityStatus": "STALE",
                    "candidatePolicyId": "old-candidate",
                    "baselinePolicyId": "old-baseline",
                    "createdAt": "2026-05-18T10:01:00Z",
                },
            )
            remote_control_root = (
                artifact_root
                / "tencent-cloud"
                / "batch-runs"
                / "tencent-new"
                / "remote"
                / "runtime-artifacts"
                / "rl-control-loop"
            )
            write_json(
                remote_control_root / "policy-advantage-remote.json",
                {
                    "type": "screeps-rl-policy-online-advantage-report",
                    "onlineUtilityStatus": "REMOTE_CURRENT",
                    "candidatePolicyId": "remote-candidate",
                    "baselinePolicyId": "remote-baseline",
                    "createdAt": "2026-05-18T10:11:00Z",
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "metrics-observations.json",
                {
                    "type": "screeps-rl-metrics-observations-report",
                    "observations": [],
                    "createdAt": "2026-05-18T10:02:00Z",
                },
            )
            write_json(
                remote_control_root / "metrics-observations-remote.json",
                {
                    "type": "screeps-rl-metrics-observations-report",
                    "observations": [],
                    "createdAt": "2026-05-18T10:12:00Z",
                },
            )

            dashboard = live.build_bounded_dashboard_sections(
                repo_root,
                artifact_root,
                "2026-05-18T10:13:00Z",
            )

        self.assertTrue(str(dashboard["artifacts"]["trainingLedger"]).endswith("rl-training/training-ledger-new.json"))
        self.assertTrue(str(dashboard["artifacts"]["policyAdvantage"]).endswith("policy-advantage-remote.json"))
        self.assertTrue(str(dashboard["artifacts"]["metricsObservations"]).endswith("metrics-observations-remote.json"))
        self.assertEqual(dashboard["training"]["episodes"], 11.0)
        self.assertEqual(dashboard["simulator"]["ticksRun"], 2200)
        self.assertEqual(dashboard["policy"]["candidate"], "remote-candidate")

    def test_bounded_dashboard_sections_filter_artifact_kind_before_source_cap(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            control_root = artifact_root / "rl-control-loop"
            for index in range(5):
                path = control_root / f"decision-{index}.json"
                write_json(
                    path,
                    {
                        "type": "screeps-rl-iteration-decision",
                        "decisionId": f"decision-{index}",
                        "createdAt": f"2026-05-18T10:1{index}:00Z",
                    },
                )
                os.utime(path, (1_771_001_000 + index, 1_771_001_000 + index))
            training_path = control_root / "training-ledger.json"
            write_json(
                training_path,
                {
                    "type": "screeps-rl-training-execution-ledger",
                    "status": "RUN",
                    "trainingDidRun": True,
                    "iterationExecution": {"episodesRun": 3, "policyUpdateIterations": 1, "simulatorTicksRun": 600},
                    "environmentExecution": {"completed": 1, "failed": 0, "lastNewRunAt": "2026-05-18T10:00:00Z"},
                    "createdAt": "2026-05-18T10:00:00Z",
                },
            )
            policy_path = control_root / "policy-advantage.json"
            write_json(
                policy_path,
                {
                    "type": "screeps-rl-policy-online-advantage-report",
                    "onlineUtilityStatus": "PROVEN",
                    "candidatePolicyId": "candidate-policy",
                    "baselinePolicyId": "baseline-policy",
                    "createdAt": "2026-05-18T10:01:00Z",
                },
            )
            metrics_path = control_root / "metrics-observations.json"
            write_json(
                metrics_path,
                {
                    "type": "screeps-rl-metrics-observations-report",
                    "observations": [],
                    "createdAt": "2026-05-18T10:02:00Z",
                },
            )
            for path in (training_path, policy_path, metrics_path):
                os.utime(path, (1_771_000_000, 1_771_000_000))

            dashboard = live.build_bounded_dashboard_sections(
                repo_root,
                artifact_root,
                "2026-05-18T10:15:00Z",
                max_files_per_root=1,
            )

        self.assertTrue(str(dashboard["artifacts"]["trainingLedger"]).endswith("training-ledger.json"))
        self.assertTrue(str(dashboard["artifacts"]["policyAdvantage"]).endswith("policy-advantage.json"))
        self.assertTrue(str(dashboard["artifacts"]["metricsObservations"]).endswith("metrics-observations.json"))
        self.assertEqual(dashboard["training"]["episodes"], 3.0)
        self.assertEqual(dashboard["policy"]["candidate"], "candidate-policy")
        control_source = {source["source"]: source for source in dashboard["scan"]["sources"]}["rl-control-loop"]
        self.assertEqual(control_source["filesDiscovered"], 8)
        self.assertEqual(control_source["semanticFilesDiscovered"], 3)
        self.assertEqual(control_source["filesScanned"], 3)
        self.assertEqual(control_source["fileLimitPerKind"], 1)

    def test_semantic_scan_keeps_newer_payload_only_fallback_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            control_root = artifact_root / "rl-control-loop"
            hinted_training = control_root / "training-ledger.json"
            payload_only_training = control_root / "candidate-output.json"
            write_json(
                hinted_training,
                {
                    "type": "screeps-rl-training-execution-ledger",
                    "status": "RUN",
                    "trainingDidRun": True,
                    "iterationExecution": {"episodesRun": 1, "policyUpdateIterations": 0, "simulatorTicksRun": 100},
                    "environmentExecution": {"completed": 1, "failed": 0, "lastNewRunAt": "2026-05-18T10:00:00Z"},
                    "createdAt": "2026-05-18T10:00:00Z",
                },
            )
            write_json(
                payload_only_training,
                {
                    "type": "screeps-rl-training-execution-ledger",
                    "status": "RUN",
                    "trainingDidRun": True,
                    "iterationExecution": {"episodesRun": 9, "policyUpdateIterations": 2, "simulatorTicksRun": 900},
                    "environmentExecution": {"completed": 4, "failed": 0, "lastNewRunAt": "2026-05-18T10:09:00Z"},
                    "createdAt": "2026-05-18T10:09:00Z",
                },
            )
            os.utime(hinted_training, (1_771_000_000, 1_771_000_000))
            os.utime(payload_only_training, (1_771_000_900, 1_771_000_900))

            artifacts, scan = live.load_bounded_dashboard_artifacts(
                artifact_root,
                repo_root,
                [],
                max_files_per_root=1,
            )

        artifacts_by_kind = {
            live.static_dashboard.artifact_kind(artifact.path, artifact.payload): artifact
            for artifact in artifacts
        }
        self.assertTrue(str(artifacts_by_kind["training_ledger"].path).endswith("candidate-output.json"))
        self.assertEqual(artifacts_by_kind["training_ledger"].payload["iterationExecution"]["episodesRun"], 9)
        control_source = {source["source"]: source for source in scan["sources"]}["rl-control-loop"]
        self.assertEqual(control_source["semanticFilesDiscovered"], 2)
        self.assertEqual(control_source["filesScanned"], 1)

    def test_semantic_scan_prefers_payload_timestamp_over_newer_file_mtime(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            control_root = artifact_root / "rl-control-loop"
            stale_copy = control_root / "training-ledger-copy.json"
            true_latest = control_root / "training-ledger-current.json"
            write_json(
                stale_copy,
                {
                    "type": "screeps-rl-training-execution-ledger",
                    "status": "RUN",
                    "trainingDidRun": True,
                    "iterationExecution": {"episodesRun": 1, "policyUpdateIterations": 0, "simulatorTicksRun": 100},
                    "environmentExecution": {"completed": 1, "failed": 0, "lastNewRunAt": "2026-05-18T10:00:00Z"},
                    "createdAt": "2026-05-18T10:00:00Z",
                },
            )
            write_json(
                true_latest,
                {
                    "type": "screeps-rl-training-execution-ledger",
                    "status": "RUN",
                    "trainingDidRun": True,
                    "iterationExecution": {"episodesRun": 9, "policyUpdateIterations": 2, "simulatorTicksRun": 900},
                    "environmentExecution": {"completed": 4, "failed": 0, "lastNewRunAt": "2026-05-18T10:10:00Z"},
                    "createdAt": "2026-05-18T10:10:00Z",
                },
            )
            os.utime(stale_copy, (1_771_002_000, 1_771_002_000))
            os.utime(true_latest, (1_771_001_000, 1_771_001_000))

            artifacts, scan = live.load_bounded_dashboard_artifacts(
                artifact_root,
                repo_root,
                [],
                max_files_per_root=1,
            )

        artifacts_by_kind = {
            live.static_dashboard.artifact_kind(artifact.path, artifact.payload): artifact
            for artifact in artifacts
        }
        self.assertTrue(str(artifacts_by_kind["training_ledger"].path).endswith("training-ledger-current.json"))
        self.assertEqual(artifacts_by_kind["training_ledger"].payload["iterationExecution"]["episodesRun"], 9)
        control_source = {source["source"]: source for source in scan["sources"]}["rl-control-loop"]
        self.assertEqual(control_source["semanticFilesDiscovered"], 2)
        self.assertEqual(control_source["filesScanned"], 1)

    def test_bounded_dashboard_semantic_scan_caps_irrelevant_deserialization(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            control_root = artifact_root / "rl-control-loop"
            fallback_limit = live.semantic_fallback_scan_limit(1, len(live.SUMMARY_DASHBOARD_ARTIFACT_KINDS))
            irrelevant_count = fallback_limit + 25
            for index in range(irrelevant_count):
                path = control_root / f"decision-{index:03d}.json"
                write_json(
                    path,
                    {
                        "type": "screeps-rl-iteration-decision",
                        "decisionId": f"decision-{index}",
                        "createdAt": f"2026-05-18T11:{index % 60:02d}:00Z",
                    },
                )
                os.utime(path, (1_771_002_000 + index, 1_771_002_000 + index))
            training_path = control_root / "training-ledger.json"
            write_json(
                training_path,
                {
                    "type": "screeps-rl-training-execution-ledger",
                    "status": "RUN",
                    "trainingDidRun": True,
                    "iterationExecution": {"episodesRun": 3, "policyUpdateIterations": 1, "simulatorTicksRun": 600},
                    "environmentExecution": {"completed": 1, "failed": 0, "lastNewRunAt": "2026-05-18T10:00:00Z"},
                    "createdAt": "2026-05-18T10:00:00Z",
                },
            )
            policy_path = control_root / "policy-advantage.json"
            write_json(
                policy_path,
                {
                    "type": "screeps-rl-policy-online-advantage-report",
                    "onlineUtilityStatus": "PROVEN",
                    "candidatePolicyId": "candidate-policy",
                    "baselinePolicyId": "baseline-policy",
                    "createdAt": "2026-05-18T10:01:00Z",
                },
            )
            metrics_path = control_root / "metrics-observations.json"
            write_json(
                metrics_path,
                {
                    "type": "screeps-rl-metrics-observations-report",
                    "observations": [],
                    "createdAt": "2026-05-18T10:02:00Z",
                },
            )
            for path in (training_path, policy_path, metrics_path):
                os.utime(path, (1_771_000_000, 1_771_000_000))

            load_attempts: list[Path] = []
            original_load_json_object = live.load_json_object

            def counting_load_json_object(path: Path) -> JsonObject | None:
                load_attempts.append(path)
                return original_load_json_object(path)

            live.load_json_object = counting_load_json_object
            try:
                artifacts, scan = live.load_bounded_dashboard_artifacts(
                    artifact_root,
                    repo_root,
                    [],
                    max_files_per_root=1,
                )
            finally:
                live.load_json_object = original_load_json_object

        artifacts_by_kind = {
            live.static_dashboard.artifact_kind(artifact.path, artifact.payload): artifact
            for artifact in artifacts
        }
        self.assertTrue(str(artifacts_by_kind["training_ledger"].path).endswith("training-ledger.json"))
        self.assertTrue(str(artifacts_by_kind["policy_advantage"].path).endswith("policy-advantage.json"))
        self.assertTrue(str(artifacts_by_kind["metrics_observations"].path).endswith("metrics-observations.json"))
        control_source = {source["source"]: source for source in scan["sources"]}["rl-control-loop"]
        self.assertTrue(control_source["candidateScanTruncated"])
        self.assertTrue(control_source["candidateFilesDiscoveredIsLowerBound"])
        self.assertEqual(control_source["fallbackScanLimit"], fallback_limit)
        self.assertEqual(control_source["semanticFilesDiscovered"], 3)
        self.assertEqual(len(load_attempts), control_source["jsonFilesDeserialized"])
        self.assertLessEqual(
            control_source["jsonFilesDeserialized"],
            fallback_limit + len(live.SUMMARY_DASHBOARD_ARTIFACT_KINDS),
        )
        self.assertLess(control_source["jsonFilesDeserialized"], irrelevant_count + 3)

    def test_discovery_limited_file_scan_selects_newest_before_truncating(self) -> None:
        original_glob = Path.glob
        original_iterdir = Path.iterdir

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            old = root / "old.json"
            middle = root / "middle.json"
            newest = root / "newest.json"
            for path, mtime in ((old, 1_771_000_000), (middle, 1_771_000_100), (newest, 1_771_000_200)):
                write_json(path, {"path": path.name})
                os.utime(path, (mtime, mtime))

            def stale_first_glob(self: Path, pattern: str) -> Any:
                if self == root and pattern == "*.json":
                    return iter((old, middle, newest))
                return original_glob(self, pattern)

            def stale_first_iterdir(self: Path) -> Any:
                if self == root:
                    return iter((old, middle, newest))
                return original_iterdir(self)

            Path.glob = stale_first_glob  # type: ignore[method-assign]
            Path.iterdir = stale_first_iterdir  # type: ignore[method-assign]
            try:
                selected, discovered, truncated = live.newest_matching_files_with_discovery_limit(
                    root,
                    ("*.json",),
                    discovery_limit=1,
                )
            finally:
                Path.glob = original_glob  # type: ignore[method-assign]
                Path.iterdir = original_iterdir  # type: ignore[method-assign]

        self.assertEqual(selected, [newest])
        self.assertEqual(discovered, 1)
        self.assertTrue(truncated)

    def test_wildcard_directory_scan_orders_by_matched_file_mtime(self) -> None:
        original_iterdir = Path.iterdir

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fanout_scan_limit = live.bounded_discovery_fanout_scan_limit(1)
            gate_dirs: list[Path] = []
            for index in range(fanout_scan_limit + 8):
                gate_dir = root / f"gate-{index:03d}"
                summary = gate_dir / "gate_summary.json"
                write_json(summary, {"path": f"{gate_dir.name}/gate_summary.json"})
                file_mtime = 1_771_000_000 + index
                dir_mtime = 1_771_001_000 + index
                os.utime(summary, (file_mtime, file_mtime))
                os.utime(gate_dir, (dir_mtime, dir_mtime))
                gate_dirs.append(gate_dir)
            fresh_file_old_dir = root / "old-dir" / "gate_summary.json"
            write_json(fresh_file_old_dir, {"path": "old-dir/gate_summary.json"})
            os.utime(fresh_file_old_dir, (1_771_003_000, 1_771_003_000))
            os.utime(fresh_file_old_dir.parent, (1_770_000_000, 1_770_000_000))
            gate_dirs.append(fresh_file_old_dir.parent)
            scanned_children: list[Path] = []

            def counted_iterdir(self: Path) -> Any:
                if self == root:
                    def generate() -> Any:
                        for gate_dir in gate_dirs:
                            scanned_children.append(gate_dir)
                            yield gate_dir

                    return generate()
                if self in gate_dirs:
                    raise AssertionError("unexpected recursive wildcard history scan")
                return original_iterdir(self)

            Path.iterdir = counted_iterdir  # type: ignore[method-assign]
            try:
                selected, discovered, truncated = live.newest_matching_files_with_discovery_limit(
                    root,
                    ("*/gate_summary.json",),
                    discovery_limit=1,
                )
            finally:
                Path.iterdir = original_iterdir  # type: ignore[method-assign]

        self.assertEqual(selected, [fresh_file_old_dir])
        self.assertEqual(discovered, 1)
        self.assertTrue(truncated)
        self.assertEqual(scanned_children, gate_dirs)

    def test_wildcard_directory_scan_ranks_before_bounded_fanout(self) -> None:
        original_iterdir = Path.iterdir

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            batch_root = root / "batch-runs"
            fanout_scan_limit = live.bounded_discovery_fanout_scan_limit(1)
            run_dirs: list[Path] = []
            for index in range(fanout_scan_limit + 8):
                run_dir = batch_root / f"run-{index:03d}"
                summary = run_dir / "controller-summary.json"
                write_json(summary, {"runId": run_dir.name, "createdAt": f"2026-05-18T10:{index % 60:02d}:00Z"})
                mtime = 1_771_000_000 + index
                os.utime(summary, (mtime, mtime))
                os.utime(run_dir, (mtime, mtime))
                run_dirs.append(run_dir)
            newest_run_dir = batch_root / "run-newest"
            newest_summary = newest_run_dir / "controller-summary.json"
            write_json(newest_summary, {"runId": newest_run_dir.name, "createdAt": "2026-05-18T10:59:59Z"})
            os.utime(newest_summary, (1_771_002_000, 1_771_002_000))
            os.utime(newest_run_dir, (1_770_000_000, 1_770_000_000))
            run_dirs.append(newest_run_dir)
            scanned_children: list[Path] = []

            def counted_iterdir(self: Path) -> Any:
                if self == batch_root:
                    def generate() -> Any:
                        for run_dir in run_dirs:
                            scanned_children.append(run_dir)
                            yield run_dir

                    return generate()
                if self in run_dirs:
                    raise AssertionError("unexpected recursive wildcard history scan")
                return original_iterdir(self)

            Path.iterdir = counted_iterdir  # type: ignore[method-assign]
            try:
                selected, discovered, truncated = live.newest_matching_files_with_discovery_limit(
                    batch_root,
                    ("*/controller-summary.json",),
                    discovery_limit=1,
                )
            finally:
                Path.iterdir = original_iterdir  # type: ignore[method-assign]

        self.assertEqual(selected, [newest_summary])
        self.assertEqual(discovered, 1)
        self.assertTrue(truncated)
        self.assertEqual(scanned_children, run_dirs)

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
        self.assertEqual(
            missing_fields,
            set(live.REQUIRED_TENCENT_SAFETY_FIELDS) | set(live.REQUIRED_TENCENT_SHADOW_SAFETY_FIELDS),
        )

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

    def test_runtime_candidate_injection_uses_newest_relevant_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-control-loop" / "old-success.json",
                {
                    "createdAt": "2026-05-18T10:00:00Z",
                    "runtime_parameter_injection": True,
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "new-blocked.json",
                {
                    "createdAt": "2026-05-18T10:10:00Z",
                    "runtime_parameter_injection": False,
                },
            )

            summary = live.runtime_candidate_injection_summary(artifact_root, repo_root)

        self.assertEqual(summary["status"], "BLOCKED")
        self.assertEqual(summary["evidence"], "runtime_parameter_injection=False")
        self.assertTrue(summary["latestPath"].endswith("new-blocked.json"))
        self.assertEqual(summary["updatedAt"], "2026-05-18T10:10:00Z")

    def test_equal_timestamp_artifact_gate_ties_are_conservative(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            timestamp = "2026-05-18T10:10:00Z"
            write_json(
                artifact_root / "rl-control-loop" / "a-runtime-success.json",
                {
                    "createdAt": timestamp,
                    "runtime_parameter_injection": True,
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "z-runtime-blocked.json",
                {
                    "createdAt": timestamp,
                    "runtime_parameter_injection": False,
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "a-zero-safe.json",
                {
                    "createdAt": timestamp,
                    "policyUpdateIterations": 0,
                    "policyUpdate": {"skippedReason": "no samples"},
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "z-zero-blocked.json",
                {
                    "createdAt": timestamp,
                    "policyUpdateIterations": 0,
                    "policyUpdate": {},
                },
            )

            injection = live.runtime_candidate_injection_summary(artifact_root, repo_root)
            zero_iteration = live.zero_iteration_policy_update_summary(artifact_root, repo_root)

        self.assertEqual(injection["status"], "BLOCKED")
        self.assertEqual(injection["evidence"], "runtime_parameter_injection=False")
        self.assertTrue(injection["latestPath"].endswith("z-runtime-blocked.json"))
        self.assertEqual(zero_iteration["status"], "BLOCKED")
        self.assertTrue(zero_iteration["latestPath"].endswith("z-zero-blocked.json"))

    def test_positive_non_consumed_policy_update_is_blocked_as_non_promotional(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-training" / "non-consumed-update.json",
                {
                    "createdAt": "2026-05-18T10:15:00Z",
                    "policyUpdateIterations": 1,
                    "policyUpdate": {
                        "iterations": 1,
                        "promotionGate": {
                            "status": "blocked_runtime_parameter_consumption_missing",
                            "runtimeParameterConsumption": False,
                        },
                    },
                },
            )

            zero_iteration = live.zero_iteration_policy_update_summary(artifact_root, repo_root)

        self.assertEqual(zero_iteration["status"], "BLOCKED")
        self.assertEqual(
            zero_iteration["evidence"],
            "policy update non-promotional: blocked_runtime_parameter_consumption_missing",
        )

    def test_runtime_consumed_shadow_candidate_policy_update_is_not_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-training" / "runtime-consumed-update.json",
                {
                    "createdAt": "2026-05-18T10:16:00Z",
                    "policyUpdateIterations": 1,
                    "trueGradient": True,
                    "trustedGradientUpdate": True,
                    "runtimeParameterInjection": {
                        "runtimeParameterConsumption": True,
                        "consumedVariantCount": 2,
                        "policyUpdateEligible": True,
                    },
                    "policyUpdate": {
                        "iterations": 1,
                        "trueGradient": True,
                        "trustedGradientUpdate": True,
                        "parameterEvidence": {
                            "runtimeParameterConsumption": True,
                            "consumedVariantCount": 2,
                            "policyUpdateEligible": True,
                        },
                        "promotionGate": {
                            "status": "runtime_consumed_shadow_candidate",
                            "runtimeParameterConsumption": True,
                            "loopAPromotionEligible": True,
                            "loopBPromotionEligible": True,
                        },
                    },
                },
            )

            zero_iteration = live.zero_iteration_policy_update_summary(artifact_root, repo_root)

        self.assertEqual(zero_iteration["status"], "N/A")
        self.assertEqual(
            zero_iteration["evidence"],
            "latest policy update had 1 iteration(s); trueGradient=true",
        )

    def test_policy_update_without_iteration_count_keeps_consumption_blocker_visible(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-training" / "missing-iterations-update.json",
                {
                    "type": "screeps-rl-training-report",
                    "createdAt": "2026-05-18T10:20:00Z",
                    "policyUpdate": {"nextCandidatePolicy": {"candidatePolicyId": "missing-iterations"}},
                },
            )
            write_json(
                artifact_root / "rl-training" / "non-consumed-update.json",
                {
                    "type": "screeps-rl-training-report",
                    "createdAt": "2026-05-18T10:15:00Z",
                    "policyUpdateIterations": 1,
                    "trueGradient": True,
                    "policyUpdate": {
                        "iterations": 1,
                        "trueGradient": True,
                        "promotionGate": {
                            "status": "blocked_runtime_parameter_consumption_missing",
                            "runtimeParameterConsumption": False,
                        },
                    },
                },
            )

            zero_iteration = live.zero_iteration_policy_update_summary(artifact_root, repo_root)

        self.assertEqual(zero_iteration["status"], "BLOCKED")
        self.assertEqual(zero_iteration["sourceTrust"], "trusted_training_report")
        self.assertTrue(zero_iteration["latestPath"].endswith("non-consumed-update.json"))
        self.assertIn("policy update non-promotional", zero_iteration["evidence"])
        self.assertIn("blocked_runtime_parameter_consumption_missing", zero_iteration["evidence"])

    def test_true_gradient_report_beats_newer_stale_zero_iteration_ledger(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-control-loop" / "20260523T164520Z-training-ledger.json",
                {
                    "type": "screeps-rl-training-execution-ledger",
                    "createdAt": "2026-05-23T16:45:20Z",
                    "status": "RUN_WITH_ANOMALY",
                    "policyUpdateIterations": 0,
                    "trueGradient": False,
                    "policyUpdate": {"nextCandidatePolicy": {"candidatePolicyId": "stale"}},
                    "blockingReasons": ["POLICY_UPDATE_NOT_TRUE_GRADIENT"],
                },
            )
            write_json(
                artifact_root
                / "tencent-cloud"
                / "batch-runs"
                / "tencent-pg-20260523t112504z"
                / "remote"
                / "runtime-artifacts"
                / "rl-training"
                / "tencent-pg-20260523t112504z.json",
                {
                    "type": "screeps-rl-training-report",
                    "generatedAt": "2026-05-23T11:25:04Z",
                    "reportId": "tencent-pg-20260523t112504z",
                    "status": "shadow",
                    "policyUpdateIterations": 1,
                    "trueGradient": True,
                    "trustedGradientUpdate": False,
                    "runtimeParameterInjection": {
                        "runtimeParameterConsumption": False,
                        "runtimeParameterConsumptionStatus": "missing_runtime_parameter_consumption",
                        "consumedVariantCount": 0,
                        "policyUpdateEligible": False,
                    },
                    "policyUpdate": {
                        "iterations": 1,
                        "trueGradient": True,
                        "trustedGradientUpdate": False,
                        "parameterEvidence": {
                            "runtimeParameterConsumption": False,
                            "consumedVariantCount": 0,
                            "policyUpdateEligible": False,
                        },
                        "promotionGate": {
                            "status": "blocked_runtime_parameter_consumption_missing",
                            "runtimeParameterConsumption": False,
                            "loopAPromotionEligible": False,
                            "loopBPromotionEligible": False,
                        },
                    },
                },
            )

            zero_iteration = live.zero_iteration_policy_update_summary(artifact_root, repo_root)

        self.assertEqual(zero_iteration["status"], "BLOCKED")
        self.assertEqual(zero_iteration["sourceTrust"], "trusted_training_report")
        self.assertTrue(zero_iteration["latestPath"].endswith("tencent-pg-20260523t112504z.json"))
        self.assertIn("policy update non-promotional", zero_iteration["evidence"])
        self.assertIn("blocked_runtime_parameter_consumption_missing", zero_iteration["evidence"])
        self.assertIn("consumedVariantCount=0", zero_iteration["evidence"])
        self.assertIn("policyUpdateEligible=false", zero_iteration["evidence"])
        self.assertIn("trustedGradientUpdate=false", zero_iteration["evidence"])
        self.assertNotIn("lacks trueGradient", zero_iteration["evidence"])
        self.assertNotIn("POLICY_UPDATE_NOT_TRUE_GRADIENT", zero_iteration["evidence"])

    def test_newer_blocked_ledger_beats_older_trusted_policy_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-training" / "trusted-policy-report.json",
                {
                    "type": "screeps-rl-training-report",
                    "generatedAt": "2026-05-23T11:25:04Z",
                    "policyUpdateIterations": 1,
                    "trueGradient": True,
                    "trustedGradientUpdate": True,
                    "policyUpdate": {
                        "iterations": 1,
                        "trueGradient": True,
                        "trustedGradientUpdate": True,
                    },
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "newer-zero-iteration-ledger.json",
                {
                    "type": "screeps-rl-training-execution-ledger",
                    "createdAt": "2026-05-23T16:45:20Z",
                    "policyUpdateIterations": 0,
                    "policyUpdate": {"nextCandidatePolicy": {"candidatePolicyId": "blocked"}},
                },
            )

            zero_iteration = live.zero_iteration_policy_update_summary(artifact_root, repo_root)
            _, aggregate_zero_iteration = live.artifact_evidence_summaries(artifact_root, repo_root)

        for summary in (zero_iteration, aggregate_zero_iteration):
            self.assertEqual(summary["status"], "BLOCKED")
            self.assertEqual(summary["sourceTrust"], "artifact")
            self.assertTrue(summary["latestPath"].endswith("newer-zero-iteration-ledger.json"))
            self.assertEqual(summary["updatedAt"], "2026-05-23T16:45:20Z")
            self.assertEqual(
                summary["evidence"],
                "zero-iteration policy update lacks safe skippedReason or has update artifact",
            )

    def test_known_hosts_retry_success_is_not_self_heal_handoff(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            write_json(
                artifact_root / "tencent-cloud" / "batch-runs" / "tencent-pg-20260523t121005z" / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-20260523t121005z",
                    "startedAt": "2026-05-23T12:10:05Z",
                    "finishedAt": None,
                    "partial": True,
                    "finalStatus": "running",
                    "controllerProcess": {"pid": 1205},
                    "inputs": {"executionTimeouts": {"totalSeconds": 12300}},
                    "execution": {
                        "environmentsRun": 0,
                        "artifactCount": 0,
                        "trainingReportProduced": False,
                    },
                    "steps": [
                        {
                            "name": "scan_worker_host_key",
                            "ok": False,
                            "detail": {"status": "host_key_scan_unavailable", "retryable": True, "attempt": 1},
                        },
                        {
                            "name": "scan_worker_host_key",
                            "ok": False,
                            "detail": {"status": "host_key_scan_unavailable", "retryable": True, "attempt": 2},
                        },
                        {
                            "name": "scan_worker_host_key",
                            "ok": True,
                            "detail": {"status": "host_key_scanned", "retryable": False, "attempt": 3},
                        },
                        {
                            "name": "install_worker_known_host",
                            "ok": True,
                            "detail": {"status": "new_known_host", "hostKeyCount": 3},
                        },
                    ],
                },
            )

            summary = live.tencent_batch_summary_at(
                artifact_root,
                repo_root,
                now="2026-05-23T12:20:00Z",
            )

        latest = summary["latest"]
        known_hosts = latest["knownHostsSelfHeal"]
        self.assertEqual(latest["stateClassification"], "TRAINING_IN_PROGRESS")
        self.assertFalse(latest["handoffRequired"])
        self.assertEqual(known_hosts["status"], "OK")
        self.assertEqual(known_hosts["classification"], "SSH_HOST_KEY_SELF_HEALING_RECOVERED")
        self.assertFalse(known_hosts["handoffRequired"])
        self.assertIn("recovered via new_known_host", known_hosts["evidence"])

    def test_known_hosts_terminal_self_heal_failure_requires_handoff(self) -> None:
        payload = {
            "type": "screeps-tencent-batch-rl-run",
            "runId": "tencent-pg-host-key-failed",
            "startedAt": "2026-05-23T12:10:05Z",
            "finishedAt": "2026-05-23T12:12:05Z",
            "partial": False,
            "finalStatus": "failed",
            "steps": [
                {
                    "name": "scan_worker_host_key",
                    "ok": False,
                    "detail": {"status": "host_key_scan_unavailable", "retryable": True, "attempt": 1},
                },
                {
                    "name": "prepare_worker_known_host",
                    "ok": False,
                    "detail": {"status": "host_key_self_healing_failed", "retryable": False},
                },
            ],
        }

        state = live.classify_tencent_batch_run_state(payload, now="2026-05-23T12:20:00Z")

        self.assertEqual(state["status"], "SSH_HOST_KEY_SELF_HEALING_FAILED")
        self.assertTrue(state["handoffRequired"])
        self.assertEqual(state["handoffSeverity"], "P1")
        self.assertEqual(state["knownHostsSelfHeal"]["classification"], "SSH_HOST_KEY_SELF_HEALING_FAILED")

    def test_known_hosts_stale_clear_rescan_success_is_recovered(self) -> None:
        payload = {
            "type": "screeps-tencent-batch-rl-run",
            "runId": "tencent-pg-host-key-recovered",
            "startedAt": "2026-05-23T12:10:05Z",
            "finishedAt": None,
            "partial": True,
            "finalStatus": "running",
            "controllerProcess": {"pid": 1205},
            "inputs": {"executionTimeouts": {"totalSeconds": 12300}},
            "execution": {
                "environmentsRun": 0,
                "artifactCount": 0,
                "trainingReportProduced": False,
            },
            "steps": [
                {
                    "name": "scan_worker_host_key",
                    "ok": False,
                    "detail": {"status": "host_key_scan_unavailable", "retryable": True, "attempt": 1},
                },
                {
                    "name": "clear_worker_known_host",
                    "ok": True,
                    "detail": {"warning": False},
                },
                {
                    "name": "scan_worker_host_key",
                    "ok": True,
                    "detail": {"status": "host_key_scanned", "retryable": False, "attempt": 1},
                },
                {
                    "name": "install_worker_known_host",
                    "ok": True,
                    "detail": {"status": "rotated_known_host", "hostKeyCount": 3},
                },
            ],
        }

        state = live.classify_tencent_batch_run_state(payload, now="2026-05-23T12:20:00Z")

        self.assertEqual(state["status"], "TRAINING_IN_PROGRESS")
        self.assertFalse(state["handoffRequired"])
        known_hosts = state["knownHostsSelfHeal"]
        self.assertEqual(known_hosts["status"], "OK")
        self.assertEqual(known_hosts["classification"], "SSH_HOST_KEY_SELF_HEALING_RECOVERED")
        self.assertIn("recovered via rotated_known_host", known_hosts["evidence"])

    def test_known_hosts_still_unavailable_after_stale_clear_requires_specific_handoff(self) -> None:
        payload = {
            "type": "screeps-tencent-batch-rl-run",
            "runId": "tencent-pg-host-key-unavailable",
            "startedAt": "2026-05-23T12:10:05Z",
            "finishedAt": "2026-05-23T12:12:05Z",
            "partial": False,
            "finalStatus": "failed",
            "steps": [
                {
                    "name": "scan_worker_host_key",
                    "ok": False,
                    "detail": {"status": "host_key_scan_unavailable", "retryable": True, "attempt": 1},
                },
                {
                    "name": "clear_worker_known_host",
                    "ok": True,
                    "detail": {"warning": False},
                },
                {
                    "name": "scan_worker_host_key",
                    "ok": False,
                    "detail": {"status": "host_key_scan_unavailable", "retryable": True, "attempt": 1},
                },
                {
                    "name": "prepare_worker_known_host",
                    "ok": False,
                    "detail": {
                        "status": "host_key_self_healing_unavailable",
                        "retryable": False,
                        "staleKnownHostRemoved": True,
                        "unsafeExistingKnownHostBlocked": True,
                    },
                },
            ],
        }

        state = live.classify_tencent_batch_run_state(payload, now="2026-05-23T12:20:00Z")

        self.assertEqual(state["status"], "SSH_HOST_KEY_SELF_HEALING_UNAVAILABLE")
        self.assertTrue(state["handoffRequired"])
        self.assertEqual(state["handoffSeverity"], "P1")
        known_hosts = state["knownHostsSelfHeal"]
        self.assertEqual(known_hosts["classification"], "SSH_HOST_KEY_SELF_HEALING_UNAVAILABLE")
        self.assertIn("still unavailable", known_hosts["evidence"])

    def test_known_hosts_unverified_existing_entry_requires_unsafe_handoff(self) -> None:
        payload = {
            "type": "screeps-tencent-batch-rl-run",
            "runId": "tencent-pg-host-key-unsafe",
            "startedAt": "2026-05-23T12:10:05Z",
            "finishedAt": "2026-05-23T12:12:05Z",
            "partial": False,
            "finalStatus": "failed",
            "steps": [
                {
                    "name": "scan_worker_host_key",
                    "ok": False,
                    "detail": {"status": "host_key_scan_unavailable", "retryable": True, "attempt": 1},
                },
                {
                    "name": "clear_worker_known_host",
                    "ok": True,
                    "detail": {"warning": False},
                },
                {
                    "name": "prepare_worker_known_host",
                    "ok": False,
                    "detail": {
                        "status": "host_key_unverified_existing_entry_blocked",
                        "retryable": False,
                        "staleKnownHostRemoved": True,
                        "unsafeExistingKnownHostBlocked": True,
                    },
                },
            ],
        }

        state = live.classify_tencent_batch_run_state(payload, now="2026-05-23T12:20:00Z")

        self.assertEqual(state["status"], "SSH_HOST_KEY_SELF_HEALING_UNSAFE")
        self.assertTrue(state["handoffRequired"])
        known_hosts = state["knownHostsSelfHeal"]
        self.assertEqual(known_hosts["classification"], "SSH_HOST_KEY_SELF_HEALING_UNSAFE")
        self.assertIn("unsafe host-key state", known_hosts["evidence"])

    def test_health_helper_requires_successful_auto_refresh(self) -> None:
        health = live.health_with_refresh(
            {"ok": True, "status": "ok", "failures": []},
            {
                "mode": "auto",
                "autoRefreshSeconds": 60,
                "lastRefreshAt": "2026-05-18T10:09:00Z",
                "lastRefreshOk": False,
            },
        )

        self.assertFalse(health["ok"])
        self.assertEqual(health["status"], "degraded")
        self.assertIn("auto-refresh has not completed successfully", health["failures"])

    def test_health_helper_reports_startup_refresh_in_progress(self) -> None:
        health = live.health_with_refresh(
            {"ok": True, "status": "ok", "failures": []},
            {
                "mode": "auto",
                "autoRefreshSeconds": 60,
                "initialRefreshRequired": True,
                "refreshInProgress": True,
                "activeRefreshReason": "startup",
                "lastRefreshAt": None,
                "lastRefreshOk": None,
            },
        )

        self.assertFalse(health["ok"])
        self.assertEqual(health["status"], "degraded")
        self.assertIn("startup refresh is in progress", health["failures"])

    def test_project_gate_requires_successful_auto_refresh(self) -> None:
        flywheel_stages = [{"stage": "construction-landed", "status": "OK"}]
        tencent = {
            "hasData": True,
            "runCount": 1,
            "latest": {"batchScale": {"scaleFirstEligible": True}},
        }
        injection = {"status": "OK", "evidence": "runtime_parameter_injection=true"}
        zero_iteration = {"status": "OK", "evidence": "safe zero-iteration no-op: no update"}
        pending_refresh = {
            "mode": "auto",
            "autoRefreshSeconds": 60,
            "lastRefreshAt": None,
            "lastRefreshOk": None,
        }
        successful_refresh = {
            "mode": "auto",
            "autoRefreshSeconds": 60,
            "lastRefreshAt": "2026-05-18T10:09:00Z",
            "lastRefreshOk": True,
        }

        pending_gates = live.project_gate_summary(
            flywheel_stages=flywheel_stages,
            tencent=tencent,
            injection=injection,
            zero_iteration=zero_iteration,
            refresh=pending_refresh,
        )
        successful_gates = live.project_gate_summary(
            flywheel_stages=flywheel_stages,
            tencent=tencent,
            injection=injection,
            zero_iteration=zero_iteration,
            refresh=successful_refresh,
        )

        pending_gate = {gate["issue"]: gate for gate in pending_gates}["#1233"]
        successful_gate = {gate["issue"]: gate for gate in successful_gates}["#1233"]
        self.assertEqual(pending_gate["status"], "BLOCKED")
        self.assertEqual(successful_gate["status"], "OK")
        self.assertIn("lastRefreshOk=True", successful_gate["evidence"])

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
        self.assertEqual(health["message"], "OK")
        self.assertEqual(summary["type"], "screeps-rl-live-dashboard")
        self.assertEqual(summary["dashboardUrl"], f"http://{host}:{port}/")
        self.assertEqual(summary["e1Gate"]["gateId"], "e1-live")

    def test_healthz_fails_when_auto_refresh_failed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            live.refresh_metrics(db_path, artifact_root)
            config = live.LiveDashboardConfig(
                repo_root=repo_root,
                artifact_root=artifact_root,
                db_path=db_path,
                auto_refresh_seconds=60,
            )
            try:
                server = live.make_server("127.0.0.1", 0, config)
            except OSError as error:
                self.skipTest(f"socket creation is unavailable in this sandbox: {error}")
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                server.record_refresh(
                    {"ok": False, "error": "ingestor soft failure"},
                    refreshed_at="2026-05-18T10:09:00Z",
                )
                host, port = server.server_address
                status, health = get_json_url(f"http://{host}:{port}/healthz")
                summary = read_json_url(f"http://{host}:{port}/api/summary")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

        self.assertEqual(status, 503)
        self.assertFalse(health["ok"])
        self.assertEqual(health["message"], "DEGRADED")
        self.assertIn("auto-refresh has not completed successfully", health["failures"])
        self.assertFalse(health["refresh"]["lastRefreshOk"])
        self.assertFalse(summary["health"]["ok"])
        self.assertEqual(summary["health"]["status"], "degraded")
        self.assertIn("auto-refresh has not completed successfully", summary["health"]["failures"])
        self.assertFalse(summary["refresh"]["lastRefreshOk"])

    def test_summary_and_healthz_read_sqlite_under_refresh_lock(self) -> None:
        original_sqlite_summary = live.sqlite_summary
        observed_locked_reads: list[bool] = []

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

            def locked_sqlite_summary(db_path_arg: Path, repo_root_arg: Path) -> JsonObject:
                observed_locked_reads.append(server.refresh_lock.locked())
                return original_sqlite_summary(db_path_arg, repo_root_arg)

            live.sqlite_summary = locked_sqlite_summary
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                host, port = server.server_address
                status, health = get_json_url(f"http://{host}:{port}/healthz")
                summary = read_json_url(f"http://{host}:{port}/api/summary")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
                live.sqlite_summary = original_sqlite_summary

        self.assertEqual(status, 200)
        self.assertTrue(health["ok"])
        self.assertTrue(summary["health"]["ok"])
        self.assertGreaterEqual(len(observed_locked_reads), 2)
        self.assertTrue(all(observed_locked_reads))

    def test_summary_snapshot_does_not_deadlock_with_refresh_state_invalidation(self) -> None:
        class ObservedLock:
            def __init__(self) -> None:
                self._lock = threading.Lock()
                self.enter_attempted = threading.Event()

            def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
                self.enter_attempted.set()
                return self._lock.acquire(blocking, timeout)

            def release(self) -> None:
                self._lock.release()

            def locked(self) -> bool:
                return self._lock.locked()

            def __enter__(self) -> "ObservedLock":
                self.acquire()
                return self

            def __exit__(self, *_args: object) -> None:
                self.release()

        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            live.refresh_metrics(db_path, artifact_root)
            config = live.LiveDashboardConfig(repo_root=repo_root, artifact_root=artifact_root, db_path=db_path)
            server = live.LiveDashboardHTTPServer.__new__(live.LiveDashboardHTTPServer)
            server.config = config
            server.server_address = ("127.0.0.1", 0)
            server.refresh_state_lock = threading.Lock()
            server.summary_lock = threading.Lock()
            server.refresh_state = {
                "mode": "manual",
                "autoRefreshSeconds": None,
                "lastRefreshAt": None,
                "lastRefreshOk": None,
                "lastRefresh": None,
                "nextRefreshAt": None,
            }
            server.summary_cache = None
            server.summary_cache_dashboard_url = None
            server.summary_cache_until = 0.0
            server.summary_cache_generation = 0

            observed_refresh_lock = ObservedLock()
            server.refresh_lock = observed_refresh_lock  # type: ignore[assignment]
            self.assertTrue(observed_refresh_lock.acquire())
            observed_refresh_lock.enter_attempted.clear()
            summary_errors: list[Exception] = []
            summary_result: list[JsonObject] = []

            def read_summary() -> None:
                try:
                    summary_result.append(server.summary_snapshot(server.dashboard_url()))
                except Exception as error:  # pragma: no cover - assertion path
                    summary_errors.append(error)

            summary_thread = threading.Thread(target=read_summary, daemon=True)
            summary_thread.start()
            self.assertTrue(observed_refresh_lock.enter_attempted.wait(timeout=1))

            refresh_state_entered = threading.Event()
            invalidate_done = threading.Event()

            def invalidate_while_refresh_state_locked() -> None:
                with server.refresh_state_lock:
                    refresh_state_entered.set()
                    server.invalidate_summary_cache()
                invalidate_done.set()

            invalidate_thread = threading.Thread(target=invalidate_while_refresh_state_locked, daemon=True)
            invalidate_thread.start()
            self.assertTrue(refresh_state_entered.wait(timeout=1))
            time.sleep(0.05)

            observed_refresh_lock.release()
            summary_thread.join(timeout=1)
            invalidate_thread.join(timeout=1)

        self.assertFalse(summary_thread.is_alive())
        self.assertFalse(invalidate_thread.is_alive())
        self.assertFalse(summary_errors)
        self.assertTrue(invalidate_done.is_set())
        self.assertEqual(summary_result[0]["type"], "screeps-rl-live-dashboard")

    def test_summary_endpoint_uses_cache_until_refresh_invalidates_it(self) -> None:
        original_build_live_summary = live.build_live_summary
        calls: list[str] = []

        def cached_build_live_summary(*args: Any, **kwargs: Any) -> JsonObject:
            calls.append(str(kwargs.get("dashboard_url")))
            return {
                "type": "screeps-rl-live-dashboard",
                "generatedAt": f"call-{len(calls)}",
                "dashboardUrl": kwargs.get("dashboard_url"),
            }

        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            config = live.LiveDashboardConfig(
                repo_root=repo_root,
                artifact_root=artifact_root,
                db_path=db_path,
                summary_cache_seconds=60,
            )
            try:
                server = live.make_server("127.0.0.1", 0, config)
            except OSError as error:
                self.skipTest(f"socket creation is unavailable in this sandbox: {error}")
            live.build_live_summary = cached_build_live_summary
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                host, port = server.server_address
                first = read_json_url(f"http://{host}:{port}/api/summary")
                second = read_json_url(f"http://{host}:{port}/api/summary")
                server.record_refresh({"ok": True, "files_scanned": 1}, refreshed_at="2026-05-18T10:09:00Z")
                third = read_json_url(f"http://{host}:{port}/api/summary")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
                live.build_live_summary = original_build_live_summary

        self.assertEqual(first["generatedAt"], "call-1")
        self.assertEqual(second["generatedAt"], "call-1")
        self.assertEqual(third["generatedAt"], "call-2")
        self.assertEqual(len(calls), 2)

    def test_successful_refresh_does_not_cache_in_progress_summary(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            config = live.LiveDashboardConfig(
                repo_root=repo_root,
                artifact_root=artifact_root,
                db_path=db_path,
                summary_cache_seconds=300,
            )
            server = live.LiveDashboardHTTPServer.__new__(live.LiveDashboardHTTPServer)
            server.config = config
            server.server_address = ("127.0.0.1", 8765)
            server.refresh_lock = threading.Lock()
            server.refresh_state_lock = threading.Lock()
            server.summary_lock = threading.Lock()
            server.background_refresh_threads_lock = threading.Lock()
            server.background_refresh_threads = []
            server.refresh_stop = threading.Event()
            server.refresh_thread = None
            server.summary_cache = None
            server.summary_cache_dashboard_url = None
            server.summary_cache_until = 0.0
            server.summary_cache_generation = 0
            server.refresh_state = {
                "mode": "manual",
                "autoRefreshSeconds": None,
                "initialRefreshRequired": False,
                "refreshInProgress": False,
                "activeRefreshStartedAt": None,
                "activeRefreshReason": None,
                "lastRefreshAt": None,
                "lastRefreshOk": None,
                "lastRefresh": None,
                "nextRefreshAt": None,
            }
            refresh = server.run_refresh_cycle("manual")
            first = server.summary_snapshot(server.dashboard_url())
            second = server.summary_snapshot(server.dashboard_url())

        self.assertTrue(refresh["ok"])
        self.assertTrue(first["refresh"]["lastRefreshOk"])
        self.assertFalse(first["refresh"]["refreshInProgress"])
        self.assertFalse(second["refresh"]["refreshInProgress"])

    def test_successful_refresh_keeps_primed_summary_cache_after_finishing(self) -> None:
        original_refresh_metrics = live.refresh_metrics
        original_build_live_summary = live.build_live_summary
        build_calls: list[JsonObject] = []

        def successful_refresh_metrics(
            db_path: Path,
            artifact_root: Path,
            paths: Any = None,
            **_kwargs: Any,
        ) -> JsonObject:
            return {"ok": True, "files_scanned": 7}

        def cached_build_live_summary(*_args: Any, **kwargs: Any) -> JsonObject:
            refresh = dict(kwargs.get("refresh") or {})
            build_calls.append(refresh)
            return {
                "type": "screeps-rl-live-dashboard",
                "generatedAt": f"primed-call-{len(build_calls)}",
                "dashboardUrl": kwargs.get("dashboard_url"),
                "health": {"ok": True, "status": "ok", "failures": []},
                "db": {
                    "exists": True,
                    "schemaReady": True,
                    "tables": {"metric_observations": 1},
                    "latestObservedAt": "2026-05-18T10:09:00Z",
                },
                "refresh": refresh,
                "e1Gate": {"status": "OK"},
                "loopA": {"environment": {}, "training": {}},
                "loopB": {"policy": {}, "scorecard": {"status": "OK"}},
                "tencentBatch": {"hasData": True},
                "projectGates": [{"issue": "#1233", "status": "OK"}],
            }

        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            config = live.LiveDashboardConfig(
                repo_root=repo_root,
                artifact_root=artifact_root,
                db_path=db_path,
                summary_cache_seconds=60,
            )
            server = make_unbound_live_server(config)
            live.refresh_metrics = successful_refresh_metrics
            live.build_live_summary = cached_build_live_summary
            try:
                refresh = server.run_refresh_cycle("manual")
                summary = server.summary_snapshot(server.dashboard_url())
            finally:
                live.refresh_metrics = original_refresh_metrics
                live.build_live_summary = original_build_live_summary

        self.assertTrue(refresh["ok"])
        self.assertEqual(len(build_calls), 1)
        self.assertEqual(summary["generatedAt"], "primed-call-1")
        self.assertFalse(summary["refresh"]["refreshInProgress"])
        self.assertIsNone(summary["refresh"]["activeRefreshReason"])
        self.assertTrue(summary["refresh"]["lastRefreshOk"])
        self.assertEqual(summary["refresh"]["lastRefresh"]["files_scanned"], 7)

    def test_live_acceptance_passes_running_service(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            refresh = live.refresh_metrics(db_path, artifact_root)
            config = live.LiveDashboardConfig(
                repo_root=repo_root,
                artifact_root=artifact_root,
                db_path=db_path,
                auto_refresh_seconds=60,
            )
            try:
                server = live.make_server("127.0.0.1", 0, config)
            except OSError as error:
                self.skipTest(f"socket creation is unavailable in this sandbox: {error}")
            server.record_refresh(refresh, refreshed_at="2026-05-18T10:09:00Z")
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                host, port = server.server_address
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    exit_code = live.run_acceptance(f"http://{host}:{port}/", timeout=2.0)
                payload = json.loads(output.getvalue())
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["message"], "PASS")
        checks = {check["name"]: check for check in payload["checks"]}
        for required in (
            "/healthz ok=true",
            "/api/summary reachable",
            "summary.dashboardUrl",
            "db.path",
            "db.tables",
            "db.latestObservedAt",
            "refresh.lastRefreshOk",
            "refresh.lastRefreshAt",
            "E1 gate visible",
            "Loop A visible",
            "Loop B visible",
            "Tencent utilization visible",
            "scorecard visible",
            "safety visible",
            "project gates visible",
        ):
            self.assertIn(required, checks)
            self.assertTrue(checks[required]["ok"], required)
        self.assertTrue(payload["refresh"]["lastRefreshOk"])
        self.assertEqual(payload["refresh"]["lastRefreshAt"], "2026-05-18T10:09:00Z")

    def test_health_and_acceptance_stay_ok_during_auto_refresh_with_cached_summary(self) -> None:
        original_refresh_metrics = live.refresh_metrics
        refresh_entered = threading.Event()
        release_refresh = threading.Event()

        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            initial_refresh = live.refresh_metrics(db_path, artifact_root)
            config = live.LiveDashboardConfig(
                repo_root=repo_root,
                artifact_root=artifact_root,
                db_path=db_path,
                auto_refresh_seconds=60,
            )
            try:
                server = live.make_server("127.0.0.1", 0, config)
            except OSError as error:
                self.skipTest(f"socket creation is unavailable in this sandbox: {error}")
            server.record_refresh(initial_refresh, refreshed_at="2026-05-18T10:09:00Z")

            def blocked_refresh_metrics(
                db_path_arg: Path,
                artifact_root_arg: Path,
                paths: Any = None,
                **kwargs: Any,
            ) -> JsonObject:
                refresh_entered.set()
                wait_for_refresh_release(release_refresh)
                return original_refresh_metrics(db_path_arg, artifact_root_arg, paths, **kwargs)

            live.refresh_metrics = blocked_refresh_metrics
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            refresh_thread: threading.Thread | None = None
            try:
                host, port = server.server_address
                warm_summary = read_json_url(f"http://{host}:{port}/api/summary")
                self.assertTrue(warm_summary["health"]["ok"])
                refresh_thread = server.start_background_refresh("auto")
                self.assertTrue(refresh_entered.wait(timeout=1))

                status, health = get_json_url(f"http://{host}:{port}/healthz")
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    exit_code = live.run_acceptance(f"http://{host}:{port}/", timeout=2.0)
                payload = json.loads(output.getvalue())
            finally:
                release_refresh.set()
                if refresh_thread is not None:
                    refresh_thread.join(timeout=5)
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
                live.refresh_metrics = original_refresh_metrics

        self.assertEqual(status, 200)
        self.assertTrue(health["ok"])
        self.assertEqual(health["message"], "OK")
        self.assertTrue(health["refresh"]["refreshInProgress"])
        self.assertEqual(health["refresh"]["activeRefreshReason"], "auto")
        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["message"], "PASS")
        self.assertTrue(payload["refresh"]["lastRefreshOk"])
        self.assertTrue(payload["refresh"]["refreshInProgress"])

    def test_live_acceptance_reports_not_running_connection_refused(self) -> None:
        try:
            sock = socket.socket()
            sock.bind(("127.0.0.1", 0))
            _host, port = sock.getsockname()
            sock.close()
        except OSError as error:
            self.skipTest(f"local socket allocation is unavailable: {error}")

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exit_code = live.run_acceptance(f"http://127.0.0.1:{port}/", timeout=0.2)
        payload = json.loads(output.getvalue())

        self.assertEqual(exit_code, 1)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["message"], "FAIL")
        self.assertIn("live dashboard service is not running/reachable", payload["error"])
        self.assertIn("npm run rl-dashboard-live", payload["error"])

    def test_refresh_on_start_binds_before_slow_refresh_finishes(self) -> None:
        original_refresh_metrics = live.refresh_metrics
        original_make_server = live.make_server
        refresh_entered = threading.Event()
        release_refresh = threading.Event()
        server_created = threading.Event()
        server_ref: dict[str, live.LiveDashboardHTTPServer] = {}

        def slow_refresh_metrics(
            db_path: Path,
            artifact_root: Path,
            paths: Any = None,
            **_kwargs: Any,
        ) -> JsonObject:
            refresh_entered.set()
            wait_for_refresh_release(release_refresh)
            return {"ok": True, "files_scanned": 1}

        def tracking_make_server(host: str, port: int, config: live.LiveDashboardConfig) -> live.LiveDashboardHTTPServer:
            server = original_make_server(host, port, config)
            server_ref["server"] = server
            server_created.set()
            return server

        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = artifact_root / "rl-metrics" / "rl_metrics.sqlite"
            probe_config = live.LiveDashboardConfig(repo_root=repo_root, artifact_root=artifact_root, db_path=db_path)
            try:
                probe_server = original_make_server("127.0.0.1", 0, probe_config)
            except OSError as error:
                self.skipTest(f"socket creation is unavailable in this sandbox: {error}")
            else:
                probe_server.server_close()
            live.refresh_metrics = slow_refresh_metrics
            live.make_server = tracking_make_server
            main_thread = threading.Thread(
                target=lambda: live.main(
                    [
                        "serve",
                        "--repo-root",
                        str(repo_root),
                        "--artifact-root",
                        str(artifact_root),
                        "--db",
                        str(db_path),
                        "--refresh-on-start",
                        "--auto-refresh-seconds",
                        "60",
                        "--port",
                        "0",
                    ]
                ),
                daemon=True,
            )
            main_thread.start()
            try:
                self.assertTrue(server_created.wait(timeout=1))
                self.assertTrue(refresh_entered.wait(timeout=1))
                server = server_ref["server"]
                host, port = server.server_address
                deadline = time.monotonic() + 2
                last_error: Exception | None = None
                while True:
                    try:
                        status, health = get_json_url(f"http://{host}:{port}/healthz", timeout=0.2)
                        break
                    except OSError as error:
                        last_error = error
                        if time.monotonic() >= deadline:
                            raise AssertionError(f"server did not bind before refresh finished: {last_error}")
                        time.sleep(0.05)
            finally:
                release_refresh.set()
                server = server_ref.get("server")
                if server is not None:
                    server.shutdown()
                main_thread.join(timeout=5)
                live.refresh_metrics = original_refresh_metrics
                live.make_server = original_make_server

        self.assertEqual(status, 503)
        self.assertFalse(health["ok"])
        self.assertTrue(health["refresh"]["refreshInProgress"])
        self.assertEqual(health["refresh"]["activeRefreshReason"], "startup")
        self.assertIn("startup refresh is in progress", health["failures"])

    def test_startup_refresh_in_progress_without_usable_data_is_degraded(self) -> None:
        original_refresh_metrics = live.refresh_metrics
        refresh_entered = threading.Event()
        release_refresh = threading.Event()

        def blocked_refresh_metrics(
            db_path: Path,
            artifact_root: Path,
            paths: Any = None,
            **_kwargs: Any,
        ) -> JsonObject:
            refresh_entered.set()
            wait_for_refresh_release(release_refresh)
            return {"ok": True, "files_scanned": 0}

        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = artifact_root / "rl-metrics" / "rl_metrics.sqlite"
            config = live.LiveDashboardConfig(
                repo_root=repo_root,
                artifact_root=artifact_root,
                db_path=db_path,
                auto_refresh_seconds=60,
                initial_refresh_required=True,
            )
            try:
                server = live.make_server("127.0.0.1", 0, config)
            except OSError as error:
                self.skipTest(f"socket creation is unavailable in this sandbox: {error}")
            live.refresh_metrics = blocked_refresh_metrics
            refresh_thread = server.start_background_refresh("startup")
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                host, port = server.server_address
                self.assertTrue(refresh_entered.wait(timeout=1))
                status, health = get_json_url(f"http://{host}:{port}/healthz")
            finally:
                release_refresh.set()
                refresh_thread.join(timeout=5)
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
                live.refresh_metrics = original_refresh_metrics

        self.assertEqual(status, 503)
        self.assertFalse(health["ok"])
        self.assertFalse(health["db"]["exists"])
        self.assertIsNone(health["refresh"]["lastRefreshOk"])
        self.assertIn("startup refresh is in progress", health["failures"])

    def test_live_acceptance_waits_for_startup_refresh_to_complete(self) -> None:
        original_refresh_metrics = live.refresh_metrics
        refresh_entered = threading.Event()
        release_refresh = threading.Event()

        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = artifact_root / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)

            def delayed_refresh_metrics(
                db_path_arg: Path,
                artifact_root_arg: Path,
                paths: Any = None,
                **kwargs: Any,
            ) -> JsonObject:
                refresh_entered.set()
                wait_for_refresh_release(release_refresh)
                return original_refresh_metrics(db_path_arg, artifact_root_arg, paths, **kwargs)

            config = live.LiveDashboardConfig(
                repo_root=repo_root,
                artifact_root=artifact_root,
                db_path=db_path,
                auto_refresh_seconds=60,
                initial_refresh_required=True,
            )
            try:
                server = live.make_server("127.0.0.1", 0, config)
            except OSError as error:
                self.skipTest(f"socket creation is unavailable in this sandbox: {error}")
            live.refresh_metrics = delayed_refresh_metrics
            server.start_background_refresh("startup")
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            output = io.StringIO()
            acceptance_result: list[int] = []

            def run_acceptance() -> None:
                with contextlib.redirect_stdout(output):
                    acceptance_result.append(live.run_acceptance(f"http://{host}:{port}/", timeout=5.0))

            try:
                host, port = server.server_address
                self.assertTrue(refresh_entered.wait(timeout=1))
                acceptance_thread = threading.Thread(target=run_acceptance, daemon=True)
                acceptance_thread.start()
                time.sleep(0.1)
                self.assertTrue(acceptance_thread.is_alive())
                release_refresh.set()
                acceptance_thread.join(timeout=5)
                self.assertFalse(acceptance_thread.is_alive())
                payload = json.loads(output.getvalue())
            finally:
                release_refresh.set()
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
                live.refresh_metrics = original_refresh_metrics

        self.assertEqual(acceptance_result, [0])
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["message"], "PASS")
        self.assertTrue(payload["refresh"]["lastRefreshOk"])

    def test_live_acceptance_retries_startup_refresh_pending_window(self) -> None:
        original_read_acceptance_json_url = live.read_acceptance_json_url
        original_sleep = live.time.sleep
        calls: list[str] = []
        pending_health: JsonObject = {
            "ok": False,
            "failures": ["startup refresh has not completed successfully"],
            "db": {"exists": False},
            "refresh": {
                "initialRefreshRequired": True,
                "refreshInProgress": False,
                "lastRefreshAt": None,
                "lastRefreshOk": None,
            },
        }
        refreshed_db: JsonObject = {
            "path": "/tmp/rl_metrics.sqlite",
            "tables": {"observations": {"rows": 1}},
            "latestObservedAt": "2026-05-18T10:09:00Z",
        }
        refreshed_state: JsonObject = {
            "initialRefreshRequired": True,
            "refreshInProgress": False,
            "lastRefreshAt": "2026-05-18T10:10:00Z",
            "lastRefreshOk": True,
        }
        ok_health: JsonObject = {
            "ok": True,
            "failures": [],
            "db": refreshed_db,
            "refresh": refreshed_state,
        }
        ok_summary: JsonObject = {
            "dashboardUrl": "http://127.0.0.1:48840/",
            "db": refreshed_db,
            "refresh": refreshed_state,
            "e1Gate": {"status": "OK"},
            "loopA": {"environment": {}, "training": {}},
            "loopB": {"policy": {}, "scorecard": {"status": "OK"}},
            "tencentBatch": {"status": "OK"},
            "safety": {"status": "OK"},
            "projectGates": [{"issue": "#1233", "status": "OK"}],
        }

        def fake_read_acceptance_json_url(url: str, _timeout: float) -> tuple[int, JsonObject]:
            calls.append(url)
            if url.endswith("/healthz"):
                health_attempts = sum(1 for call in calls if call.endswith("/healthz"))
                if health_attempts == 1:
                    return HTTPStatus.SERVICE_UNAVAILABLE, pending_health
                return HTTPStatus.OK, ok_health
            if url.endswith("/api/summary"):
                return HTTPStatus.OK, ok_summary
            raise AssertionError(f"unexpected URL: {url}")

        live.read_acceptance_json_url = fake_read_acceptance_json_url
        live.time.sleep = lambda _seconds: None
        try:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                exit_code = live.run_acceptance("http://127.0.0.1:48840/", timeout=2.0)
            payload = json.loads(output.getvalue())
        finally:
            live.read_acceptance_json_url = original_read_acceptance_json_url
            live.time.sleep = original_sleep

        self.assertEqual(exit_code, 0)
        self.assertEqual(sum(1 for call in calls if call.endswith("/healthz")), 2)
        self.assertEqual(sum(1 for call in calls if call.endswith("/api/summary")), 1)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["message"], "PASS")
        self.assertTrue(payload["refresh"]["lastRefreshOk"])

    def test_live_acceptance_does_not_retry_auto_refresh_degraded_health(self) -> None:
        original_read_acceptance_json_url = live.read_acceptance_json_url
        original_sleep = live.time.sleep
        calls: list[str] = []
        degraded_health: JsonObject = {
            "ok": False,
            "failures": ["auto refresh is in progress"],
            "db": {"exists": False},
            "refresh": {
                "initialRefreshRequired": False,
                "refreshInProgress": True,
                "activeRefreshReason": "auto",
                "lastRefreshAt": "2026-05-18T10:09:00Z",
                "lastRefreshOk": False,
            },
        }

        def fake_read_acceptance_json_url(url: str, _timeout: float) -> tuple[int, JsonObject]:
            calls.append(url)
            if url.endswith("/healthz"):
                return HTTPStatus.SERVICE_UNAVAILABLE, degraded_health
            raise AssertionError(f"unexpected URL: {url}")

        def forbidden_sleep(_seconds: float) -> None:
            raise AssertionError("acceptance retried a non-startup refresh")

        live.read_acceptance_json_url = fake_read_acceptance_json_url
        live.time.sleep = forbidden_sleep
        try:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                exit_code = live.run_acceptance("http://127.0.0.1:48840/", timeout=2.0)
            payload = json.loads(output.getvalue())
        finally:
            live.read_acceptance_json_url = original_read_acceptance_json_url
            live.time.sleep = original_sleep

        self.assertEqual(exit_code, 1)
        self.assertEqual(sum(1 for call in calls if call.endswith("/healthz")), 1)
        self.assertEqual(sum(1 for call in calls if call.endswith("/api/summary")), 0)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["message"], "FAIL")
        self.assertEqual(payload["refresh"]["activeRefreshReason"], "auto")

    def test_artifact_evidence_summary_scan_is_bounded_to_newest_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            control_root = artifact_root / "rl-control-loop"
            for index in range(5):
                path = control_root / f"old-{index}.json"
                write_json(path, {"createdAt": f"2026-05-18T09:0{index}:00Z", "irrelevant": True})
                os.utime(path, (1_771_000_000 + index, 1_771_000_000 + index))
            newest = control_root / "new-runtime-blocked.json"
            write_json(
                newest,
                {
                    "createdAt": "2026-05-18T10:10:00Z",
                    "runtime_parameter_injection": False,
                },
            )
            os.utime(newest, (1_771_001_000, 1_771_001_000))

            injection, zero_iteration, scan = live.artifact_evidence_summaries_with_scan(
                artifact_root,
                repo_root,
                max_files_per_root=1,
            )

        self.assertEqual(injection["status"], "BLOCKED")
        self.assertEqual(injection["evidence"], "runtime_parameter_injection=False")
        self.assertTrue(injection["latestPath"].endswith("new-runtime-blocked.json"))
        self.assertEqual(zero_iteration["status"], "N/A")
        control_source = {source["source"]: source for source in scan["sources"]}["rl-control-loop"]
        self.assertEqual(control_source["fileLimit"], 1)
        self.assertEqual(control_source["candidateScanLimit"], live.artifact_evidence_candidate_scan_limit(1))
        self.assertEqual(control_source["evidenceFilesSelected"], 1)

    def test_artifact_evidence_scan_classifies_before_evidence_cap(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            control_root = artifact_root / "rl-control-loop"
            training_root = artifact_root / "rl-training"
            for index in range(3):
                control_irrelevant = control_root / f"new-control-{index}.json"
                training_irrelevant = training_root / f"new-training-{index}.json"
                write_json(control_irrelevant, {"createdAt": f"2026-05-18T10:0{index}:00Z", "irrelevant": True})
                write_json(training_irrelevant, {"createdAt": f"2026-05-18T10:0{index}:00Z", "irrelevant": True})
                os.utime(control_irrelevant, (1_771_001_000 + index, 1_771_001_000 + index))
                os.utime(training_irrelevant, (1_771_001_000 + index, 1_771_001_000 + index))
            runtime_evidence = control_root / "old-runtime-blocked.json"
            policy_evidence = training_root / "old-training-report.json"
            write_json(
                runtime_evidence,
                {
                    "createdAt": "2026-05-18T09:00:00Z",
                    "runtime_parameter_injection": False,
                },
            )
            write_json(
                policy_evidence,
                {
                    "createdAt": "2026-05-18T09:01:00Z",
                    "policyUpdateIterations": 0,
                },
            )
            os.utime(runtime_evidence, (1_771_000_000, 1_771_000_000))
            os.utime(policy_evidence, (1_771_000_100, 1_771_000_100))

            injection, zero_iteration, scan = live.artifact_evidence_summaries_with_scan(
                artifact_root,
                repo_root,
                max_files_per_root=1,
            )

        self.assertEqual(injection["status"], "BLOCKED")
        self.assertTrue(injection["latestPath"].endswith("old-runtime-blocked.json"))
        self.assertEqual(zero_iteration["status"], "OK")
        self.assertTrue(zero_iteration["latestPath"].endswith("old-training-report.json"))
        sources = {source["source"]: source for source in scan["sources"]}
        self.assertEqual(sources["rl-control-loop"]["evidenceFilesSelected"], 1)
        self.assertEqual(sources["rl-training"]["evidenceFilesSelected"], 1)
        self.assertGreater(sources["rl-control-loop"]["filesScanned"], sources["rl-control-loop"]["fileLimit"])

    def test_artifact_evidence_scan_visits_later_patterns_after_broad_cap(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            control_root = artifact_root / "rl-control-loop"
            for index in range(3):
                path = control_root / f"decision-{index}.json"
                write_json(path, {"createdAt": f"2026-05-18T09:0{index}:00Z", "irrelevant": True})
                os.utime(path, (1_771_000_000 + index, 1_771_000_000 + index))
            nested = control_root / "scorecards" / "runtime-blocked.json"
            write_json(
                nested,
                {
                    "createdAt": "2026-05-18T10:10:00Z",
                    "runtime_parameter_injection": False,
                },
            )
            os.utime(nested, (1_771_001_000, 1_771_001_000))

            injection, zero_iteration, scan = live.artifact_evidence_summaries_with_scan(
                artifact_root,
                repo_root,
                max_files_per_root=1,
            )

        self.assertEqual(injection["status"], "BLOCKED")
        self.assertEqual(injection["evidence"], "runtime_parameter_injection=False")
        self.assertTrue(injection["latestPath"].endswith("scorecards/runtime-blocked.json"))
        self.assertEqual(zero_iteration["status"], "N/A")
        control_source = {source["source"]: source for source in scan["sources"]}["rl-control-loop"]
        self.assertEqual(control_source["evidenceFilesSelected"], 1)
        self.assertGreaterEqual(control_source["filesDiscovered"], 4)
        self.assertFalse(control_source["filesDiscoveredIsLowerBound"])

    def test_artifact_evidence_summary_scan_uses_bounded_discovery(self) -> None:
        original_newest_matching_files = live.newest_matching_files

        def forbidden_newest_matching_files(*_args: Any, **_kwargs: Any) -> Any:
            raise AssertionError("unbounded newest_matching_files scan attempted")

        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-control-loop" / "runtime-blocked.json",
                {
                    "createdAt": "2026-05-18T10:10:00Z",
                    "runtime_parameter_injection": False,
                },
            )

            live.newest_matching_files = forbidden_newest_matching_files
            try:
                injection, zero_iteration, scan = live.artifact_evidence_summaries_with_scan(
                    artifact_root,
                    repo_root,
                    max_files_per_root=1,
                )
            finally:
                live.newest_matching_files = original_newest_matching_files

        self.assertEqual(injection["status"], "BLOCKED")
        self.assertTrue(injection["latestPath"].endswith("runtime-blocked.json"))
        self.assertEqual(zero_iteration["status"], "N/A")
        control_source = {source["source"]: source for source in scan["sources"]}["rl-control-loop"]
        self.assertEqual(control_source["filesScanned"], 1)
        self.assertFalse(control_source["filesDiscoveredIsLowerBound"])

    def test_artifact_evidence_scan_avoids_recursive_whole_tree_discovery(self) -> None:
        original_rglob = Path.rglob

        def forbidden_rglob(self: Path, pattern: str) -> Any:
            raise AssertionError(f"recursive scan attempted for {self}/{pattern}")

        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-control-loop" / "runtime-blocked.json",
                {
                    "createdAt": "2026-05-18T10:10:00Z",
                    "runtime_parameter_injection": False,
                },
            )
            write_json(
                artifact_root
                / "tencent-cloud"
                / "batch-runs"
                / "tencent-pg"
                / "remote"
                / "runtime-artifacts"
                / "rl-training"
                / "trusted-report.json",
                {
                    "type": "screeps-rl-training-report",
                    "createdAt": "2026-05-18T10:09:00Z",
                    "policyUpdateIterations": 1,
                    "trueGradient": True,
                    "trustedGradientUpdate": False,
                    "policyUpdate": {
                        "iterations": 1,
                        "trueGradient": True,
                        "promotionGate": {
                            "status": "blocked_runtime_parameter_consumption_missing",
                            "runtimeParameterConsumption": False,
                        },
                    },
                },
            )

            Path.rglob = forbidden_rglob  # type: ignore[method-assign]
            try:
                injection, zero_iteration = live.artifact_evidence_summaries(artifact_root, repo_root)
            finally:
                Path.rglob = original_rglob  # type: ignore[method-assign]

        self.assertEqual(injection["status"], "BLOCKED")
        self.assertEqual(zero_iteration["status"], "BLOCKED")
        self.assertEqual(zero_iteration["sourceTrust"], "trusted_training_report")

    def test_write_json_suppresses_client_disconnect(self) -> None:
        class BrokenWriter:
            def write(self, _body: bytes) -> None:
                raise BrokenPipeError("client disconnected")

        handler = object.__new__(live.LiveDashboardRequestHandler)
        handler.wfile = BrokenWriter()
        handler.close_connection = False
        handler.send_response = lambda _status: None  # type: ignore[method-assign]
        handler.send_header = lambda _name, _value: None  # type: ignore[method-assign]
        handler.end_headers = lambda: None  # type: ignore[method-assign]

        handler.write_json(HTTPStatus.OK, {"ok": True})

        self.assertTrue(handler.close_connection)

    def test_auto_refresh_state_is_exposed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            live.refresh_metrics(db_path, artifact_root)
            config = live.LiveDashboardConfig(
                repo_root=repo_root,
                artifact_root=artifact_root,
                db_path=db_path,
                auto_refresh_seconds=60,
            )
            try:
                server = live.make_server("127.0.0.1", 0, config)
            except OSError as error:
                self.skipTest(f"socket creation is unavailable in this sandbox: {error}")
            try:
                pending_summary = live.build_live_summary(
                    repo_root,
                    artifact_root,
                    db_path,
                    generated_at="2026-05-18T10:08:30Z",
                    refresh=server.refresh_snapshot(),
                )
                server.record_refresh({"ok": True, "files_scanned": 1}, refreshed_at="2026-05-18T10:09:00Z")
                summary = live.build_live_summary(
                    repo_root,
                    artifact_root,
                    db_path,
                    generated_at="2026-05-18T10:09:30Z",
                    refresh=server.refresh_snapshot(),
                )
                html = live.render_live_html(summary, config)
            finally:
                server.server_close()

        self.assertEqual(summary["refresh"]["mode"], "auto")
        self.assertEqual(summary["refresh"]["autoRefreshSeconds"], 60)
        self.assertTrue(summary["refresh"]["lastRefreshOk"])
        pending_gates = {gate["issue"]: gate for gate in pending_summary["projectGates"]}
        refreshed_gates = {gate["issue"]: gate for gate in summary["projectGates"]}
        self.assertEqual(pending_gates["#1233"]["status"], "BLOCKED")
        self.assertEqual(refreshed_gates["#1233"]["status"], "OK")
        self.assertIn("lastRefreshOk=True", refreshed_gates["#1233"]["evidence"])
        self.assertIn("Last refresh", html)
        self.assertIn("Auto refresh seconds", html)

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

        def failing_refresh_metrics(
            db_path: Path,
            artifact_root: Path,
            paths: Any = None,
            **_kwargs: Any,
        ) -> JsonObject:
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
        self.assertFalse(payload["summary"]["refresh"]["lastRefreshOk"])
        self.assertEqual(payload["summary"]["refresh"]["lastRefresh"]["error"], "ingestor soft failure")

    def test_refresh_endpoint_records_successful_refresh_state(self) -> None:
        original_refresh_metrics = live.refresh_metrics

        def successful_refresh_metrics(
            db_path: Path,
            artifact_root: Path,
            paths: Any = None,
            **_kwargs: Any,
        ) -> JsonObject:
            return {"ok": True, "files_scanned": 7}

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
            live.refresh_metrics = successful_refresh_metrics
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

        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["summary"]["refresh"]["lastRefreshOk"])
        self.assertEqual(payload["summary"]["refresh"]["lastRefresh"]["files_scanned"], 7)

    def test_startup_refresh_failure_keeps_service_reachable_but_degraded(self) -> None:
        original_refresh_metrics = live.refresh_metrics

        def failing_refresh_metrics(
            db_path: Path,
            artifact_root: Path,
            paths: Any = None,
            **_kwargs: Any,
        ) -> JsonObject:
            return {"ok": False, "error": "ingestor soft failure"}

        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            artifact_root = repo_root / "runtime-artifacts"
            db_path = repo_root / "runtime-artifacts" / "rl-metrics" / "rl_metrics.sqlite"
            write_live_artifacts(artifact_root)
            live.refresh_metrics = failing_refresh_metrics
            try:
                config = live.LiveDashboardConfig(
                    repo_root=repo_root,
                    artifact_root=artifact_root,
                    db_path=db_path,
                    initial_refresh_required=True,
                )
                try:
                    server = live.make_server("127.0.0.1", 0, config)
                except OSError as error:
                    self.skipTest(f"socket creation is unavailable in this sandbox: {error}")
                refresh_thread = server.start_background_refresh("startup")
                refresh_thread.join(timeout=2)
                host, port = server.server_address
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                status, health = get_json_url(f"http://{host}:{port}/healthz")
            finally:
                if "server" in locals():
                    server.shutdown()
                    server.server_close()
                if "thread" in locals():
                    thread.join(timeout=5)
                live.refresh_metrics = original_refresh_metrics

        self.assertEqual(status, 503)
        self.assertFalse(health["ok"])
        self.assertFalse(health["refresh"]["lastRefreshOk"])
        self.assertEqual(health["refresh"]["lastRefresh"]["error"], "ingestor soft failure")
        self.assertIn("startup refresh has not completed successfully", health["failures"])


if __name__ == "__main__":
    unittest.main()
