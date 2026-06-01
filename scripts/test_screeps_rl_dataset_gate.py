#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_dataset_export as dataset_export
import screeps_rl_dataset_gate as gate


JsonObject = dict[str, Any]


def write_json(path: Path, payload: JsonObject) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


def read_json(path: Path) -> JsonObject:
    return json.loads(path.read_text(encoding="utf-8"))


def runtime_line(payload: JsonObject) -> str:
    return f"#runtime-summary {json.dumps(payload, sort_keys=True)}\n"


def runtime_payload(tick: int, stored_energy: int = 1000) -> JsonObject:
    return {
        "type": "runtime-summary",
        "tick": tick,
        "rooms": [
            {
                "roomName": "E26S49",
                "workerCount": 4,
                "spawnStatus": [{"name": "Spawn1", "status": "idle"}],
                "taskCounts": {"harvest": 1, "upgrade": 0, "transfer": 2, "none": 1},
                "controller": {"level": 3, "progress": 1000 + tick, "ticksToDowngrade": 10000},
                "resources": {
                    "storedEnergy": stored_energy,
                    "workerCarriedEnergy": 0,
                    "events": {"harvestedEnergy": 100, "transferredEnergy": 0},
                },
                "combat": {
                    "hostileCreepCount": 0,
                    "hostileStructureCount": 0,
                    "events": {"creepDestroyedCount": 0, "objectDestroyedCount": 0},
                },
                "constructionPriority": {
                    "nextPrimary": {
                        "buildItem": "build extension capacity",
                        "room": "E26S49",
                        "score": 70,
                        "urgency": "high",
                    }
                },
            }
        ],
        "cpu": {"bucket": 9000},
        "reliability": {"loopExceptionCount": 0, "telemetrySilenceTicks": 0},
    }


def incomplete_postdeploy_monitor_payload(tick: int = 1056627) -> JsonObject:
    return {
        "ok": True,
        "mode": "summary",
        "room_summaries": [
            {
                "room": "shardX/E29N55",
                "tick": tick,
                "objects": 68,
                "structures": 56,
                "owned_creeps": 9,
                "owned_spawns": 1,
                "hostiles": 0,
            }
        ],
    }


def baseline_kpi_window() -> JsonObject:
    return {
        "type": "screeps-rl-kpi-window",
        "window": {
            "durationHours": 8,
            "sampleCount": 8,
            "startedAt": "2026-05-04T00:00:00Z",
            "endedAt": "2026-05-04T08:00:00Z",
        },
        "metrics": {
            "territory": {"ownedRooms": 1},
            "resources": {"score": 1700},
            "kills": {"score": 0},
            "reliability": {"score": 1},
        },
    }


def candidate_config() -> JsonObject:
    return {
        "candidateStrategyId": "candidate.current-shadow",
        "incumbentStrategyId": "incumbent.current",
        "status": "shadow",
        "safety": {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
        "metricModel": {
            "territory": {"delta": 0},
            "resources": {"delta": 0},
            "kills": {"delta": 0},
            "reliability": {"delta": 0},
        },
    }


def fake_shadow_report(paths: list[str], out_dir: Path, **kwargs: Any) -> JsonObject:
    report_id = str(kwargs.get("report_id") or "fake-shadow")
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / f"{report_id}.json"
    report = {
        "type": "screeps-strategy-shadow-report",
        "schemaVersion": 1,
        "reportId": report_id,
        "enabled": True,
        "artifactCount": 1,
        "liveEffect": False,
        "modelReports": [
            {
                "family": "construction-priority",
                "incumbentStrategyId": "construction-priority.incumbent.v1",
                "candidateStrategyId": "construction-priority.territory-shadow.v1",
                "rankingDiffCount": 1,
                "changedTopCount": 1,
                "rankingDiffs": [{"changedTop": True}],
            }
        ],
    }
    write_json(report_path, report)
    return {
        "ok": True,
        "reportId": report_id,
        "reportPath": dataset_export.display_path(report_path),
        "artifactCount": 1,
        "parsedRuntimeArtifactCount": 8,
        "modelReportCount": 1,
        "rankingDiffCount": 1,
        "changedTopCount": 1,
        "liveEffect": False,
    }


class ScreepsRlDatasetGateTest(unittest.TestCase):
    def test_contract_exposes_executable_inputs_and_outputs(self) -> None:
        contract = gate.build_contract()

        self.assertEqual(contract["type"], "screeps-rl-dataset-evaluation-gate-contract")
        self.assertIn("python3 scripts/screeps_rl_dataset_gate.py run", contract["command"]["run"])
        self.assertIn("gate_report.json", contract["outputs"]["files"]["gateReport"])
        self.assertIn("rolloutManager", contract["gateChecks"])
        self.assertFalse(contract["safety"]["officialMmoWritesAllowed"])

    def test_run_collects_dataset_indexes_shadow_and_writes_rollout_decision(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            ticks = [0, 1200, 2400, 3600, 4800, 6000, 7200, 9600]
            artifact.write_text("".join(runtime_line(runtime_payload(tick)) for tick in ticks), encoding="utf-8")
            baseline_path = root / "baseline.json"
            candidate_path = root / "candidate.json"
            write_json(baseline_path, baseline_kpi_window())
            write_json(candidate_path, candidate_config())

            with mock.patch.object(gate.shadow_report, "build_strategy_shadow_report", side_effect=fake_shadow_report):
                report = gate.run_gate(
                    [str(artifact)],
                    out_dir=root / "gates",
                    gate_id="gate-pass",
                    created_at="2026-05-04T08:00:00Z",
                    dataset_out_dir=root / "datasets",
                    shadow_out_dir=root / "shadow",
                    candidate_config=candidate_path,
                    baseline_kpi=baseline_path,
                    candidate_id="candidate.current-shadow",
                    deploy_ref="abc123",
                    min_reliability=1,
                    min_owned_rooms=1,
                    min_resource_score=1800,
                    bot_commit="a" * 40,
                    eval_ratio_value=0,
                    repo_root=Path.cwd(),
                )

            gate_dir = root / "gates" / "gate-pass"
            saved_report = read_json(gate_dir / "gate_report.json")
            summary = read_json(gate_dir / "gate_summary.json")
            rollout_decision = read_json(gate_dir / "rollout_decision.json")
            run_manifest = read_json(root / "datasets" / report["dataset"]["runId"] / "run_manifest.json")

        self.assertTrue(report["ok"])
        self.assertTrue(saved_report["ok"])
        self.assertEqual(summary["datasetRunId"], report["dataset"]["runId"])
        self.assertEqual(report["datasetGate"]["status"], "pass")
        self.assertEqual(report["quality_checks"]["status"], "pass")
        self.assertEqual(report["quality_checks"]["samples_rejected"], 0)
        self.assertEqual(summary["qualityChecksStatus"], "pass")
        self.assertEqual(report["shadowEvaluation"]["status"], "pass")
        self.assertEqual(report["historicalValidation"]["status"], "pass")
        self.assertEqual(report["predefinedMetricGate"]["status"], "pass")
        self.assertEqual(report["rolloutGate"]["status"], "pass")
        self.assertTrue(rollout_decision["passed"])
        self.assertEqual(run_manifest["source"]["strategyShadowReportCount"], 1)

    def test_run_derives_e1_metric_floors_and_rollout_objective_from_current_kpi(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            ticks = [0, 1200, 2400, 3600, 4800, 6000, 7200, 9600]
            artifact.write_text("".join(runtime_line(runtime_payload(tick)) for tick in ticks), encoding="utf-8")

            report = gate.run_gate(
                [str(artifact)],
                out_dir=root / "gates",
                gate_id="gate-derived-floors",
                created_at="2026-05-26T18:00:00Z",
                dataset_out_dir=root / "datasets",
                skip_shadow_report=True,
                bot_commit="f" * 40,
                eval_ratio_value=0,
                repo_root=root,
            )

            gate_dir = root / "gates" / "gate-derived-floors"
            summary = read_json(gate_dir / "gate_summary.json")
            baseline_objective = read_json(gate_dir / "rollout_baseline_objective.json")
            rollout_decision_exists = (gate_dir / "rollout_decision.json").exists()

        expected_metrics = {"reliability": 1, "territory": 1, "resources": 1800, "kills": 0}
        predefined_gate = report["predefinedMetricGate"]
        predefined_checks = {check["name"]: check for check in predefined_gate["checks"]}
        baseline_metrics = baseline_objective["metrics"]

        self.assertTrue(report["ok"])
        self.assertEqual(report["blockingReasons"], [])
        self.assertEqual(predefined_gate["status"], "pass")
        self.assertEqual(summary["predefinedMetricGateStatus"], "pass")
        self.assertEqual(predefined_gate["floors"], expected_metrics)
        self.assertEqual(predefined_gate["normalizedCurrent"]["metrics"], expected_metrics)
        self.assertEqual(predefined_gate["floorSource"]["source"], "current_runtime_kpi_window")
        self.assertEqual(predefined_gate["floorSource"]["derivedFloors"], expected_metrics)
        self.assertEqual(predefined_gate["floorSource"]["explicitFloors"], {})
        self.assertEqual(predefined_gate["floorSource"]["missingMetrics"], [])
        self.assertEqual(set(predefined_checks), set(expected_metrics))
        for metric, expected_value in expected_metrics.items():
            self.assertEqual(predefined_checks[metric]["actual"], expected_value)
            self.assertEqual(predefined_checks[metric]["minimum"], expected_value)
        self.assertEqual(report["rolloutGate"]["status"], "objective")
        self.assertEqual(summary["rolloutGateStatus"], "objective")
        self.assertEqual(report["rolloutGate"]["reason"], "baseline_kpi_derived_from_current_runtime_kpi")
        self.assertEqual(report["rolloutGate"]["baselineObjective"]["status"], "pass")
        self.assertEqual(report["rolloutGate"]["baselineObjective"]["normalizedCurrent"]["metrics"], expected_metrics)
        self.assertEqual(baseline_objective["status"], "pass")
        self.assertEqual(baseline_objective["missingMetrics"], [])
        self.assertEqual(baseline_objective["normalizedCurrent"]["metrics"], expected_metrics)
        self.assertEqual(set(baseline_metrics), set(expected_metrics))
        for metric, expected_value in expected_metrics.items():
            self.assertEqual(baseline_metrics[metric]["status"], "pass")
            self.assertEqual(baseline_metrics[metric]["source"], "current_runtime_kpi_window")
            self.assertEqual(baseline_metrics[metric]["target"], expected_value)
        self.assertFalse(rollout_decision_exists)

    def test_empty_full_gate_input_reports_actionable_source_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            generated_gate_data = root / "runtime-artifacts" / "rl-control-loop" / "gate-data" / "rl-empty"
            generated_gate_data.mkdir(parents=True)
            write_json(generated_gate_data / "gate_summary.json", {"type": "not-a-runtime-summary"})

            report = gate.run_gate(
                [str(generated_gate_data)],
                out_dir=root / "gates",
                gate_id="gate-empty-input",
                created_at="2026-05-31T02:19:40Z",
                dataset_out_dir=root / "datasets",
                skip_shadow_report=True,
                bot_commit="a" * 40,
                eval_ratio_value=0,
                repo_root=root,
            )
            saved_report = read_json(root / "gates" / "gate-empty-input" / "gate_report.json")

        self.assertFalse(report["ok"])
        self.assertFalse(saved_report["ok"])
        self.assertEqual(report["datasetGate"]["sampleCount"], 0)
        diagnostics = report["datasetGate"]["diagnostics"]
        self.assertEqual(diagnostics["status"], "blocked")
        self.assertEqual(diagnostics["classification"], "no_runtime_summary_artifacts")
        self.assertIn("runtime-summary console", diagnostics["recommendedAction"])
        self.assertEqual(diagnostics["runtimeSummaryArtifactCount"], 0)
        failed_checks = {
            check["name"]: check
            for check in report["datasetGate"]["checks"]
            if check["status"] == "fail"
        }
        self.assertIn("minimum_samples", failed_checks)
        self.assertEqual(
            failed_checks["runtime_summary_artifacts_present"]["classification"],
            "no_runtime_summary_artifacts",
        )

    def test_run_rejects_dead_room_dataset_samples(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime-summary-console-20260517T000000Z.log"
            dead_room = runtime_payload(100, stored_energy=0)
            room = dead_room["rooms"][0]
            room["roomName"] = "E29N55"
            room["workerCount"] = 0
            room["spawnStatus"] = []
            room["taskCounts"] = {"harvest": 0, "upgrade": 0, "none": 0}
            room["energyAvailable"] = 0
            room["resources"]["workerCarriedEnergy"] = 0
            artifact.write_text(runtime_line(dead_room), encoding="utf-8")

            report = gate.run_gate(
                [str(artifact)],
                out_dir=root / "gates",
                gate_id="gate-dead-room",
                created_at="2026-05-04T08:00:00Z",
                dataset_out_dir=root / "datasets",
                skip_shadow_report=True,
                bot_commit="c" * 40,
                eval_ratio_value=0,
                repo_root=Path.cwd(),
            )

            gate_dir = root / "gates" / "gate-dead-room"
            saved_report = read_json(gate_dir / "gate_report.json")

        self.assertFalse(report["ok"])
        self.assertFalse(saved_report["ok"])
        self.assertEqual(report["datasetGate"]["status"], "pass")
        self.assertEqual(report["quality_checks"]["status"], "fail")
        self.assertEqual(report["quality_checks"]["samples_accepted"], 0)
        self.assertEqual(report["quality_checks"]["samples_rejected"], 1)
        self.assertIn("no_harvest_or_upgrade_task", report["quality_checks"]["rejection_reasons"])
        self.assertIn("no_room_energy", report["quality_checks"]["rejection_reasons"])
        self.assertIn("no_owned_creeps", report["quality_checks"]["rejection_reasons"])
        self.assertIn("no_owned_spawns", report["quality_checks"]["rejection_reasons"])
        self.assertTrue(any(reason["gate"] == "quality_checks" for reason in report["blockingReasons"]))

    def test_run_rejects_dead_room_console_capture_under_postdeploy_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "postdeploy" / "runtime-summary-console-20260517T000000Z.log"
            artifact.parent.mkdir(parents=True)
            dead_room = runtime_payload(100, stored_energy=0)
            room = dead_room["rooms"][0]
            room["roomName"] = "E29N55"
            room["workerCount"] = 0
            room["spawnStatus"] = []
            room["taskCounts"] = {"harvest": 0, "upgrade": 0, "none": 0}
            room.pop("energyAvailable", None)
            room["resources"].pop("storedEnergy", None)
            room["resources"].pop("workerCarriedEnergy", None)
            artifact.write_text(runtime_line(dead_room), encoding="utf-8")

            report = gate.run_gate(
                [str(artifact)],
                out_dir=root / "gates",
                gate_id="gate-dead-room-postdeploy-console",
                created_at="2026-05-17T14:20:00Z",
                dataset_out_dir=root / "datasets",
                skip_shadow_report=True,
                bot_commit="e" * 40,
                eval_ratio_value=0,
                repo_root=Path.cwd(),
            )

        self.assertFalse(report["ok"])
        self.assertEqual(report["dataset"]["sampleCount"], 1)
        self.assertEqual(report["quality_checks"]["status"], "fail")
        self.assertEqual(report["quality_checks"]["samples_rejected"], 1)
        self.assertIn("no_room_energy", report["quality_checks"]["rejection_reasons"])
        self.assertIn("no_harvest_or_upgrade_task", report["quality_checks"]["rejection_reasons"])

    def test_run_excludes_stale_non_current_console_capture_before_quality_acceptance(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            stale_artifact = root / "runtime-summary-console-20260510T173515Z.log"
            stale_room = runtime_payload(786180, stored_energy=0)
            room = stale_room["rooms"][0]
            room["roomName"] = "E26S48"
            room["workerCount"] = 0
            room["spawnStatus"] = []
            room["taskCounts"] = {"harvest": 0, "upgrade": 0, "none": 0}
            room["energyAvailable"] = 0
            room["resources"]["workerCarriedEnergy"] = 0
            stale_artifact.write_text(runtime_line(stale_room), encoding="utf-8")

            current_artifact = root / "runtime-summary-console-20260521T025000Z.log"
            current_room = runtime_payload(1056600, stored_energy=250)
            current_room["rooms"][0]["roomName"] = "E29N55"
            current_artifact.write_text(runtime_line(current_room), encoding="utf-8")

            with mock.patch.dict(gate.os.environ, {"SCREEPS_HOME_ROOM": "E29N55"}, clear=False):
                report = gate.run_gate(
                    [str(stale_artifact), str(current_artifact)],
                    out_dir=root / "gates",
                    gate_id="gate-stale-non-current-filter",
                    created_at="2026-05-21T03:03:07Z",
                    dataset_out_dir=root / "datasets",
                    skip_shadow_report=True,
                    bot_commit="a" * 40,
                    eval_ratio_value=0,
                    repo_root=Path.cwd(),
                )
            saved_report = read_json(root / "gates" / "gate-stale-non-current-filter" / "gate_report.json")

        quality = report["quality_checks"]
        self.assertTrue(report["ok"])
        self.assertEqual(report["dataset"]["sampleCount"], 1)
        self.assertEqual(report["dataset"]["skippedSampleCount"], 1)
        self.assertEqual(
            report["dataset"]["skippedSampleReasons"],
            {gate.dataset_export.STALE_NON_CURRENT_CONSOLE_CAPTURE_SKIP_REASON: 1},
        )
        skipped_sample = report["dataset"]["skippedSamples"][0]
        self.assertEqual(skipped_sample["roomName"], "E26S48")
        self.assertGreater(skipped_sample["sourceAgeHours"], 24)
        self.assertEqual(quality["status"], "pass")
        self.assertEqual(quality["samples_accepted"], 1)
        self.assertEqual(quality["samples_rejected"], 0)
        self.assertEqual(quality["acceptance_rate"], 1.0)
        self.assertEqual(saved_report["dataset"]["skippedSamples"][0]["roomName"], "E26S48")

    def test_run_bounds_large_stale_non_current_tail_before_quality_evaluation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            stale_count = dataset_export.SKIPPED_SAMPLE_LOG_LIMIT + 5
            for index in range(stale_count):
                stale_room = runtime_payload(786180 + index, stored_energy=0)
                room = stale_room["rooms"][0]
                room["roomName"] = f"E26S{index % 10}"
                room["workerCount"] = 0
                room["spawnStatus"] = []
                room["taskCounts"] = {"harvest": 0, "upgrade": 0, "none": 0}
                room["energyAvailable"] = 0
                room["resources"]["workerCarriedEnergy"] = 0
                stale_artifact = root / f"runtime-summary-console-20260510T1735{index % 60:02d}Z-{index}.log"
                stale_artifact.write_text(runtime_line(stale_room), encoding="utf-8")

            current_artifact = root / "runtime-summary-console-20260521T025000Z.log"
            current_room = runtime_payload(1056600, stored_energy=250)
            current_room["rooms"][0]["roomName"] = "E29N55"
            current_artifact.write_text(runtime_line(current_room), encoding="utf-8")

            with mock.patch.dict(gate.os.environ, {"SCREEPS_HOME_ROOM": "E29N55"}, clear=False):
                report = gate.run_gate(
                    [str(root)],
                    out_dir=root / "gates",
                    gate_id="gate-bounded-stale-tail",
                    created_at="2026-05-21T03:03:07Z",
                    dataset_out_dir=root / "datasets",
                    sample_limit=1,
                    min_samples=1,
                    skip_shadow_report=True,
                    bot_commit="a" * 40,
                    eval_ratio_value=0,
                    repo_root=Path.cwd(),
                )

            source_index = read_json(root / "datasets" / report["dataset"]["runId"] / "source_index.json")

        self.assertTrue(report["ok"])
        self.assertEqual(report["dataset"]["sampleCount"], 1)
        self.assertEqual(report["dataset"]["skippedSampleCount"], stale_count)
        self.assertEqual(len(report["dataset"]["skippedSamples"]), dataset_export.SKIPPED_SAMPLE_LOG_LIMIT)
        self.assertEqual(report["dataset"]["skippedSamplesTruncated"], 5)
        self.assertEqual(source_index["skippedSampleCount"], stale_count)
        self.assertEqual(len(source_index["skippedSamples"]), dataset_export.SKIPPED_SAMPLE_LOG_LIMIT)
        self.assertEqual(report["quality_checks"]["samples_total"], 1)
        self.assertEqual(report["quality_checks"]["samples_accepted"], 1)
        self.assertEqual(report["quality_checks"]["samples_rejected"], 0)

    def test_run_rejects_malformed_created_at_before_stale_age_logic(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime-summary-console-20260521T025000Z.log"
            artifact.write_text(runtime_line(runtime_payload(1056600)), encoding="utf-8")

            with self.assertRaisesRegex(
                gate.DatasetGateError,
                "--created-at must be a valid ISO-8601 UTC timestamp",
            ):
                gate.run_gate(
                    [str(artifact)],
                    out_dir=root / "gates",
                    gate_id="gate-invalid-created-at",
                    created_at="INVALID_TIMESTAMP",
                    dataset_out_dir=root / "datasets",
                    skip_shadow_report=True,
                    bot_commit="a" * 40,
                    eval_ratio_value=0,
                    repo_root=Path.cwd(),
                )

    def test_run_filters_incomplete_postdeploy_monitor_artifact_without_quality_rejection(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            console_artifact = root / "runtime-summary-console-20260517T140000Z.log"
            valid_home_room = runtime_payload(1056600)
            valid_home_room["rooms"][0]["roomName"] = "E29N55"
            console_artifact.write_text(runtime_line(valid_home_room), encoding="utf-8")

            postdeploy_artifact = root / "postdeploy-observation-20260517T140626Z.json"
            write_json(postdeploy_artifact, incomplete_postdeploy_monitor_payload())

            report = gate.run_gate(
                [str(console_artifact), str(postdeploy_artifact)],
                out_dir=root / "gates",
                gate_id="gate-filter-postdeploy",
                created_at="2026-05-17T14:10:00Z",
                dataset_out_dir=root / "datasets",
                skip_shadow_report=True,
                bot_commit="1" * 40,
                eval_ratio_value=0,
                repo_root=Path.cwd(),
            )

        self.assertTrue(report["ok"])
        self.assertEqual(report["dataset"]["sampleCount"], 1)
        self.assertEqual(report["quality_checks"]["status"], "pass")
        self.assertEqual(report["quality_checks"]["samples_accepted"], 1)
        self.assertEqual(report["quality_checks"]["samples_rejected"], 0)
        self.assertNotIn("no_room_energy", report["quality_checks"]["rejection_reasons"])
        self.assertNotIn("no_harvest_or_upgrade_task", report["quality_checks"]["rejection_reasons"])

    def test_run_allows_non_home_room_without_owned_spawns(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            remote_room = runtime_payload(100)
            remote_room["rooms"][0]["roomName"] = "E26S49"
            remote_room["rooms"][0]["spawnStatus"] = []
            remote_room["rooms"][0]["taskCounts"] = {"harvest": 0, "upgrade": 0, "none": 4}
            remote_room["rooms"][0]["energyAvailable"] = 0
            remote_room["rooms"][0]["resources"]["workerCarriedEnergy"] = 300
            artifact.write_text(runtime_line(remote_room), encoding="utf-8")

            report = gate.run_gate(
                [str(artifact)],
                out_dir=root / "gates",
                gate_id="gate-remote-no-spawn",
                created_at="2026-05-04T08:00:00Z",
                dataset_out_dir=root / "datasets",
                skip_shadow_report=True,
                bot_commit="d" * 40,
                eval_ratio_value=0,
                repo_root=Path.cwd(),
            )

        self.assertTrue(report["ok"])
        self.assertEqual(report["quality_checks"]["status"], "pass")
        self.assertEqual(report["quality_checks"]["samples_accepted"], 1)
        self.assertEqual(report["quality_checks"]["samples_rejected"], 0)
        self.assertNotIn("no_owned_spawns", report["quality_checks"]["rejection_reasons"])

    def test_run_accepts_home_room_with_owned_spawns(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            home_room = runtime_payload(100)
            home_room["rooms"][0]["roomName"] = "E29N55"
            artifact.write_text(runtime_line(home_room), encoding="utf-8")

            report = gate.run_gate(
                [str(artifact)],
                out_dir=root / "gates",
                gate_id="gate-home-with-spawn",
                created_at="2026-05-04T08:00:00Z",
                dataset_out_dir=root / "datasets",
                skip_shadow_report=True,
                bot_commit="e" * 40,
                eval_ratio_value=0,
                repo_root=Path.cwd(),
            )

        self.assertTrue(report["ok"])
        self.assertEqual(report["quality_checks"]["status"], "pass")
        self.assertEqual(report["quality_checks"]["samples_accepted"], 1)
        self.assertEqual(report["quality_checks"]["samples_rejected"], 0)

    def test_run_deduplicates_input_roots_before_gate_evaluation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-summary-console"
            artifact_root.mkdir()
            artifact = artifact_root / "runtime-summary-console-20260521T025000Z.log"
            home_room = runtime_payload(100)
            home_room["rooms"][0]["roomName"] = "E29N55"
            artifact.write_text(runtime_line(home_room), encoding="utf-8")

            scanned_roots: list[Path] = []
            real_iter_directory_files = dataset_export.iter_directory_files

            def counting_iter_directory_files(root_path: Path, *args: Any, **kwargs: Any) -> list[Path]:
                scanned_roots.append(root_path.resolve())
                return real_iter_directory_files(root_path, *args, **kwargs)

            with mock.patch.object(dataset_export, "iter_directory_files", side_effect=counting_iter_directory_files):
                report = gate.run_gate(
                    [str(artifact_root), str(artifact_root)],
                    out_dir=root / "gates",
                    gate_id="gate-deduped-input-root",
                    created_at="2026-05-21T03:03:07Z",
                    dataset_out_dir=root / "datasets",
                    skip_shadow_report=True,
                    bot_commit="e" * 40,
                    eval_ratio_value=0,
                    repo_root=Path.cwd(),
                )
            source_index = read_json(root / "datasets" / report["dataset"]["runId"] / "source_index.json")

        self.assertTrue(report["ok"])
        self.assertEqual(report["dataset"]["runtimeSummaryArtifactCount"], 1)
        self.assertEqual(report["quality_checks"]["samples_total"], 1)
        self.assertEqual(source_index["scannedFiles"], 1)
        self.assertEqual(scanned_roots, [artifact_root.resolve()])

    def test_home_room_env_var_controls_no_owned_spawns_rejection(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            configured_home_room = runtime_payload(100)
            configured_home_room["rooms"][0]["roomName"] = "W1N1"
            configured_home_room["rooms"][0]["spawnStatus"] = []
            artifact.write_text(runtime_line(configured_home_room), encoding="utf-8")

            with mock.patch.dict(gate.os.environ, {"SCREEPS_HOME_ROOM": "W1N1"}):
                report = gate.run_gate(
                    [str(artifact)],
                    out_dir=root / "gates",
                    gate_id="gate-configured-home-no-spawn",
                    created_at="2026-05-04T08:00:00Z",
                    dataset_out_dir=root / "datasets",
                    skip_shadow_report=True,
                    bot_commit="f" * 40,
                    eval_ratio_value=0,
                    repo_root=Path.cwd(),
                )

        self.assertFalse(report["ok"])
        self.assertEqual(report["quality_checks"]["home_room"], "W1N1")
        self.assertEqual(report["quality_checks"]["samples_rejected"], 1)
        self.assertIn("no_owned_spawns", report["quality_checks"]["rejection_reasons"])

    def test_cli_persists_failure_report_when_full_gate_errors_before_report_write(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            artifact.write_text(runtime_line(runtime_payload(100)), encoding="utf-8")
            stdout = io.StringIO()
            stderr = io.StringIO()

            with mock.patch.object(
                gate.dataset_export,
                "build_dataset",
                side_effect=RuntimeError("simulated full gate dataset failure"),
            ):
                exit_code = gate.main(
                    [
                        "run",
                        str(artifact),
                        "--out-dir",
                        str(root / "gates"),
                        "--gate-id",
                        "gate-dataset-crash",
                        "--dataset-out-dir",
                        str(root / "datasets"),
                        "--skip-shadow-report",
                        "--bot-commit",
                        "b" * 40,
                        "--eval-ratio",
                        "0",
                    ],
                    stdout=stdout,
                    stderr=stderr,
                )

            report_path = root / "gates" / "gate-dataset-crash" / "gate_report.json"
            summary_path = root / "gates" / "gate-dataset-crash" / "gate_summary.json"
            report = read_json(report_path)
            summary = read_json(summary_path)

        self.assertEqual(exit_code, 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("failure report:", stderr.getvalue())
        self.assertIn("simulated full gate dataset failure", stderr.getvalue())
        self.assertFalse(report["ok"])
        self.assertEqual(report["executionFailure"]["stage"], "full_gate_execution")
        self.assertEqual(report["executionFailure"]["errorClass"], "RuntimeError")
        self.assertIn("simulated full gate dataset failure", report["executionFailure"]["error"])
        self.assertEqual(report["datasetGate"]["status"], "fail")
        self.assertEqual(summary["blockingReasons"][0]["gate"], "execution")

    def test_gate_data_out_dir_merges_e1_conclusions_without_dropping_loop_b_records(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-artifacts"
            control_loop = artifact_root / "rl-control-loop"
            registry_path = control_loop / "conclusion-registry.json"
            write_json(
                registry_path,
                {
                    "schemaVersion": 1,
                    "registryType": "rl-conclusion-registry",
                    "lastUpdatedAt": "2026-05-22T22:00:00Z",
                    "updatedBy": "01609968392a",
                    "conclusions": {
                        "LOOP-B-ACTIONED": {
                            "conclusionId": "LOOP-B-ACTIONED",
                            "ownerCron": "01609968392a",
                            "status": "ACTIONED",
                            "statement": "Loop B action still needs validation.",
                        },
                        "E1-GATE-STATUS": {
                            "conclusionId": "E1-GATE-STATUS",
                            "ownerCron": gate.E1_OWNER_CRON,
                            "status": "OPEN",
                            "statement": "Previous E1 gate failed.",
                        },
                        "E1-SHADOW-EVAL-STATUS": {
                            "conclusionId": "E1-SHADOW-EVAL-STATUS",
                            "ownerCron": gate.E1_OWNER_CRON,
                            "status": "OPEN",
                            "statement": "Previous E1 shadow eval failed.",
                        },
                    },
                },
            )
            artifact = root / "runtime.log"
            artifact.write_text(runtime_line(runtime_payload(100)), encoding="utf-8")

            with mock.patch.dict(gate.os.environ, {"SCREEPS_HOME_ROOM": "E26S49"}):
                report = gate.run_gate(
                    [str(artifact)],
                    out_dir=control_loop / "gate-data",
                    gate_id="gate-e1-merge",
                    created_at="2026-05-23T00:00:00Z",
                    dataset_out_dir=artifact_root / "rl-datasets",
                    skip_shadow_report=True,
                    bot_commit="c" * 40,
                    eval_ratio_value=0,
                    repo_root=root,
                )

            saved_registry = read_json(registry_path)
            saved_summary = read_json(control_loop / "gate-data" / "gate-e1-merge" / "gate_summary.json")

        self.assertIn("conclusionRegistry", report)
        self.assertEqual(report["conclusionRegistry"]["ownerCron"], gate.E1_OWNER_CRON)
        self.assertEqual(saved_summary["conclusionRegistrySummary"]["total"], len(saved_registry["conclusions"]))
        conclusions = saved_registry["conclusions"]
        self.assertEqual(conclusions["LOOP-B-ACTIONED"]["statement"], "Loop B action still needs validation.")
        self.assertEqual(conclusions["LOOP-B-ACTIONED"]["ownerCron"], "01609968392a")
        self.assertNotEqual(conclusions["E1-GATE-STATUS"]["statement"], "Previous E1 gate failed.")
        self.assertEqual(conclusions["E1-GATE-STATUS"]["ownerCron"], gate.E1_OWNER_CRON)
        self.assertNotIn("E1-SHADOW-EVAL-STATUS", conclusions)
        self.assertIn("E1-CONSOLE-CAPTURE-FLOWING", conclusions)
        self.assertEqual(saved_registry["summary"]["total"], len(conclusions))
        self.assertEqual(
            saved_summary["conclusionRegistrySummary"]["countsByStatus"],
            saved_registry["summary"]["countsByStatus"],
        )
        self.assertEqual(sum(saved_registry["summary"]["countsByStatus"].values()), len(conclusions))

    def test_gate_updates_legacy_e1_conclusion_missing_owner_cron(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-artifacts"
            control_loop = artifact_root / "rl-control-loop"
            registry_path = control_loop / "conclusion-registry.json"
            write_json(
                registry_path,
                {
                    "schemaVersion": 1,
                    "registryType": "rl-conclusion-registry",
                    "lastUpdatedAt": "2026-05-22T22:00:00Z",
                    "updatedBy": "legacy-gate",
                    "conclusions": {
                        "E1-GATE-STATUS": {
                            "conclusionId": "E1-GATE-STATUS",
                            "status": "OPEN",
                            "statement": "Legacy E1 gate failed before ownerCron existed.",
                        },
                    },
                },
            )
            artifact = root / "runtime.log"
            artifact.write_text(runtime_line(runtime_payload(100)), encoding="utf-8")

            with mock.patch.dict(gate.os.environ, {"SCREEPS_HOME_ROOM": "E26S49"}):
                report = gate.run_gate(
                    [str(artifact)],
                    out_dir=control_loop / "gate-data",
                    gate_id="gate-e1-legacy-owner",
                    created_at="2026-05-23T00:00:00Z",
                    dataset_out_dir=artifact_root / "rl-datasets",
                    skip_shadow_report=True,
                    bot_commit="d" * 40,
                    eval_ratio_value=0,
                    repo_root=root,
                )

            saved_registry = read_json(registry_path)

        self.assertTrue(report["ok"])
        conclusion = saved_registry["conclusions"]["E1-GATE-STATUS"]
        self.assertEqual(conclusion["ownerCron"], gate.E1_OWNER_CRON)
        self.assertEqual(conclusion["status"], "CLOSED")
        self.assertNotEqual(conclusion["statement"], "Legacy E1 gate failed before ownerCron existed.")

    def test_gate_does_not_update_registry_when_initial_summary_write_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-artifacts"
            control_loop = artifact_root / "rl-control-loop"
            registry_path = control_loop / "conclusion-registry.json"
            original_registry = {
                "schemaVersion": 1,
                "registryType": "rl-conclusion-registry",
                "lastUpdatedAt": "2026-05-22T22:00:00Z",
                "updatedBy": gate.E1_OWNER_CRON,
                "conclusions": {
                    "E1-GATE-STATUS": {
                        "conclusionId": "E1-GATE-STATUS",
                        "ownerCron": gate.E1_OWNER_CRON,
                        "status": "OPEN",
                        "statement": "Previous E1 gate failed.",
                    },
                },
            }
            write_json(registry_path, original_registry)
            artifact = root / "runtime.log"
            artifact.write_text(runtime_line(runtime_payload(100)), encoding="utf-8")
            original_write_json_atomic = gate.write_json_atomic

            def fail_summary_write(path: Path, payload: JsonObject) -> None:
                if path.name == "gate_summary.json":
                    raise OSError("simulated summary write failure")
                original_write_json_atomic(path, payload)

            with mock.patch.dict(gate.os.environ, {"SCREEPS_HOME_ROOM": "E26S49"}):
                with mock.patch.object(gate, "write_json_atomic", side_effect=fail_summary_write):
                    with self.assertRaises(OSError):
                        gate.run_gate(
                            [str(artifact)],
                            out_dir=control_loop / "gate-data",
                            gate_id="gate-summary-write-fails",
                            created_at="2026-05-23T00:00:00Z",
                            dataset_out_dir=artifact_root / "rl-datasets",
                            skip_shadow_report=True,
                            bot_commit="e" * 40,
                            eval_ratio_value=0,
                            repo_root=root,
                        )

            self.assertEqual(read_json(registry_path), original_registry)

    def test_cli_returns_nonzero_when_predefined_metric_floor_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            artifact.write_text(runtime_line(runtime_payload(100, stored_energy=20)), encoding="utf-8")
            stdout = io.StringIO()

            exit_code = gate.main(
                [
                    "run",
                    str(artifact),
                    "--out-dir",
                    str(root / "gates"),
                    "--gate-id",
                    "gate-floor-fail",
                    "--dataset-out-dir",
                    str(root / "datasets"),
                    "--skip-shadow-report",
                    "--bot-commit",
                    "b" * 40,
                    "--eval-ratio",
                    "0",
                    "--min-resource-score",
                    "1000",
                ],
                stdout=stdout,
            )
            summary = json.loads(stdout.getvalue())

        self.assertEqual(exit_code, 1)
        self.assertFalse(summary["ok"])
        self.assertEqual(summary["predefinedMetricGateStatus"], "fail")
        self.assertTrue(any(reason["gate"] == "predefinedMetricGate" for reason in summary["blockingReasons"]))


if __name__ == "__main__":
    unittest.main()
