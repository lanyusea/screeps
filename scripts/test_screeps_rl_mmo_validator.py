#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_mmo_validator as validator


JsonObject = dict[str, Any]


def write_json(path: Path, payload: JsonObject) -> None:
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


def runtime_line(payload: JsonObject) -> str:
    return f"#runtime-summary {json.dumps(payload, sort_keys=True)}\n"


def base_config(**overrides: Any) -> JsonObject:
    config: JsonObject = {
        "candidateStrategyId": "candidate.territory.v1",
        "incumbentStrategyId": "incumbent.v1",
        "status": "shadow",
        "safety": {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
        "resourceNormalizer": 1000,
        "metricModel": {
            "territory": {"delta": 1},
            "resources": {"multiplier": 1.1},
            "kills": {"delta": 1},
            "reliability": {"delta": 0},
        },
        "thresholds": {
            "reliability": {"minimum": 0.99, "maxDegradation": 0},
            "territory": {"maxDegradation": 0},
            "resources": {"maxDegradationRatio": 0.05},
            "kills": {"maxDegradation": 0},
        },
    }
    config.update(overrides)
    return config


class ScreepsRlMmoValidatorTest(unittest.TestCase):
    def test_metric_comparison_allows_configured_resource_tolerance(self) -> None:
        thresholds = {
            "maxDegradation": 10,
            "maxDegradationRatio": 0.05,
            "minimum": None,
        }

        passing = validator.compare_metric("resources", 100, 96, thresholds)
        failing = validator.compare_metric("resources", 100, 94, thresholds)

        self.assertTrue(passing["passed"])
        self.assertEqual(passing["degradationRatio"], 0.04)
        self.assertFalse(failing["passed"])
        self.assertIn("relative_degradation", failing["flags"])

    def test_fixture_runtime_artifacts_produce_machine_readable_pass_report(self) -> None:
        first = {
            "type": "runtime-summary",
            "tick": 100,
            "rooms": [
                {
                    "roomName": "E26S49",
                    "workerCount": 3,
                    "spawnStatus": [{"name": "Spawn1", "status": "idle"}],
                    "controller": {"level": 3, "progress": 1000, "ticksToDowngrade": 10000},
                    "resources": {"storedEnergy": 500, "events": {"harvestedEnergy": 0}},
                    "combat": {"events": {"creepDestroyedCount": 0}},
                }
            ],
            "cpu": {"bucket": 9000},
            "reliability": {"loopExceptionCount": 0, "telemetrySilenceTicks": 0},
        }
        latest = {
            "type": "runtime-summary",
            "tick": 110,
            "rooms": [
                {
                    "roomName": "E26S49",
                    "workerCount": 4,
                    "spawnStatus": [{"name": "Spawn1", "status": "spawning"}],
                    "controller": {"level": 3, "progress": 2000, "ticksToDowngrade": 9900},
                    "resources": {"storedEnergy": 900, "events": {"harvestedEnergy": 100}},
                    "combat": {"events": {"creepDestroyedCount": 0}},
                }
            ],
            "cpu": {"bucket": 8900},
            "reliability": {"loopExceptionCount": 0, "telemetrySilenceTicks": 0},
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config_path = root / "candidate.json"
            runtime_path = root / "runtime.log"
            out_dir = root / "reports"
            write_json(config_path, base_config())
            runtime_path.write_text(runtime_line(first) + runtime_line(latest), encoding="utf-8")

            report = validator.validate_candidate_against_history(
                config_path,
                [str(runtime_path)],
                out_dir=out_dir,
                report_id="fixture-pass",
                generated_at="2026-05-03T00:00:00Z",
            )

        self.assertTrue(report["ok"])
        self.assertEqual(report["type"], "screeps-rl-mmo-validation-report")
        self.assertEqual(report["rlSteward"]["decision"], "advance_to_kpi_shadow_gate")
        self.assertEqual(report["validation"]["scenarioCount"], 1)
        self.assertEqual(report["scenarioResults"][0]["evidenceMode"], "historical-runtime-summary")
        self.assertGreater(report["aggregate"]["candidateMetrics"]["territory"], report["aggregate"]["baselineMetrics"]["territory"])
        self.assertEqual(report["degradationFlags"], [])
        self.assertTrue(str(report["reportPath"]).endswith("reports/fixture-pass.json"))

    def test_artifact_bridge_report_is_accepted_as_historical_input(self) -> None:
        bridge_report = {
            "type": "runtime-kpi-report",
            "schemaVersion": 1,
            "input": {
                "runtimeSummaryCount": 2,
                "malformedRuntimeSummaryCount": 0,
            },
            "window": {"firstTick": 1, "latestTick": 2},
            "territory": {
                "ownedRooms": {"deltaCount": 0, "latest": ["E26S49"]},
                "controllers": {"totals": {"delta": {"level": 0, "progress": 1000}}},
            },
            "resources": {
                "totals": {"delta": {"storedEnergy": 500, "workerCarriedEnergy": 0, "droppedEnergy": 0}},
                "eventDeltas": {"harvestedEnergy": 250},
            },
            "combat": {
                "eventDeltas": {
                    "creepDestroyedCount": 1,
                    "objectDestroyedCount": 0,
                }
            },
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config_path = root / "candidate.json"
            bridge_path = root / "bridge.json"
            write_json(config_path, base_config(metricModel={"territory": {"delta": 0}, "resources": {"delta": 0.1}}))
            write_json(bridge_path, bridge_report)

            report = validator.validate_candidate_against_history(
                config_path,
                [str(bridge_path)],
                out_dir=None,
                generated_at="2026-05-03T00:00:00Z",
            )

        self.assertTrue(report["ok"])
        self.assertEqual(report["scenarioResults"][0]["evidenceMode"], "artifact-bridge-kpi-report")
        self.assertEqual(report["aggregate"]["baselineMetrics"]["resources"], 0.75)
        self.assertEqual(report["recommendation"]["decision"], "advance_to_kpi_shadow_gate")

    def test_degradation_detection_handles_zero_baseline_without_ratio_crash(self) -> None:
        report = validator.compare_metric(
            "resources",
            0,
            -0.1,
            {"maxDegradation": 0, "maxDegradationRatio": 0.05, "minimum": None},
        )

        self.assertFalse(report["passed"])
        self.assertEqual(report["degradation"], 0.1)
        self.assertIsNone(report["degradationRatio"])
        self.assertIn("absolute_degradation", report["flags"])

    def test_reliability_minimum_blocks_even_when_baseline_is_lower(self) -> None:
        report = validator.compare_metric(
            "reliability",
            0.97,
            0.98,
            {"maxDegradation": 0, "maxDegradationRatio": None, "minimum": 0.99},
        )

        self.assertFalse(report["passed"])
        self.assertIn("below_minimum", report["flags"])

    def test_explicit_scenario_candidate_degradation_is_rejected(self) -> None:
        fixture = {
            "scenarios": [
                {
                    "scenarioId": "edge-loss",
                    "baselineMetrics": {
                        "reliability": 1,
                        "territory": 1,
                        "resources": 10,
                        "kills": 0,
                    },
                    "candidateMetrics": {
                        "reliability": 1,
                        "territory": 0,
                        "resources": 12,
                        "kills": 2,
                    },
                }
            ]
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config_path = root / "candidate.json"
            fixture_path = root / "scenario.json"
            write_json(config_path, base_config(metricModel={}))
            write_json(fixture_path, fixture)

            report = validator.validate_candidate_against_history(
                config_path,
                [str(fixture_path)],
                out_dir=None,
                generated_at="2026-05-03T00:00:00Z",
            )

        self.assertFalse(report["ok"])
        self.assertEqual(report["recommendation"]["decision"], "reject")
        self.assertIn("territory", report["rlSteward"]["blockingMetrics"])
        self.assertEqual(report["degradationFlags"][0]["metric"], "territory")


if __name__ == "__main__":
    unittest.main()
