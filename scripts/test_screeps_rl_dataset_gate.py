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

    def test_run_rejects_dead_room_dataset_samples(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            dead_room = runtime_payload(100, stored_energy=0)
            room = dead_room["rooms"][0]
            room["roomName"] = "E19S57"
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
            home_room["rooms"][0]["roomName"] = "E19S57"
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
