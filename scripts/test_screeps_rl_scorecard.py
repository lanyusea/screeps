#!/usr/bin/env python3
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any


sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_scorecard as scorecard


JsonObject = dict[str, Any]


class ScreepsRlScorecardComputeEvidenceTest(unittest.TestCase):
    def test_value_has_reference_parses_numeric_strings(self) -> None:
        self.assertFalse(scorecard.value_has_reference("0"))
        self.assertFalse(scorecard.value_has_reference("0.0"))
        self.assertFalse(scorecard.value_has_reference(["0"]))
        self.assertFalse(scorecard.value_has_reference({"ids": ["0", {"fallback": "0.0"}]}))
        self.assertTrue(scorecard.value_has_reference("1"))
        self.assertTrue(scorecard.value_has_reference(["0", "2.5"]))
        self.assertTrue(scorecard.value_has_reference("training-report-a"))

    def test_failed_controller_instance_id_does_not_count_as_real_compute(self) -> None:
        for final_status in ("failed", "signal_15"):
            with self.subTest(final_status=final_status):
                payload: JsonObject = {
                    "type": "screeps-rl-policy-online-advantage-report",
                    "onlineUtilityStatus": "PROVEN",
                    "trainingReportIds": "0",
                    "advantageResources": 5,
                    "environmentExecution": {"completed": 0, "failed": 1},
                    "controllerSummary": {
                        "finalStatus": final_status,
                        "instanceId": "ins-failed",
                        "environmentsRun": 0,
                    },
                }

                self.assertFalse(scorecard.real_compute_evidence_present(payload))

                accumulator = scorecard.MetricAccumulator()
                scorecard.ingest_training_or_advantage(
                    accumulator,
                    payload,
                    "policy-advantage.json",
                    require_compute=True,
                )
                self.assertEqual(accumulator.summarize(), {})

    def test_environment_execution_shape_marks_preflight_only_payload(self) -> None:
        payload: JsonObject = {
            "type": "screeps-rl-training-execution-ledger",
            "controllerSummary": {
                "finalStatus": "preflight_ok",
                "environmentExecution": {"completed": 0},
            },
            "advantageResources": 5,
        }

        self.assertTrue(scorecard.preflight_only_compute_payload(payload))

        accumulator = scorecard.MetricAccumulator()
        scorecard.ingest_training_or_advantage(accumulator, payload, "training-ledger.json")
        self.assertEqual(accumulator.summarize(), {})

    def test_completed_controller_instance_id_counts_as_real_compute(self) -> None:
        payload: JsonObject = {
            "type": "screeps-rl-policy-online-advantage-report",
            "onlineUtilityStatus": "PROVEN",
            "environmentExecution": {"completed": 0, "failed": 0},
            "controllerSummary": {
                "finalStatus": "completed",
                "instanceId": "ins-completed",
                "environmentsRun": 0,
            },
        }

        self.assertTrue(scorecard.real_compute_evidence_present(payload))

    def test_blank_executor_identity_does_not_count_as_real_compute(self) -> None:
        payload: JsonObject = {
            "type": "screeps-rl-policy-online-advantage-report",
            "onlineUtilityStatus": "PROVEN",
            "advantageResources": 5,
            "controllerSummary": {
                "finalStatus": "running",
                "instanceId": " ",
                "workerUser": "\t",
            },
        }

        self.assertFalse(scorecard.real_compute_evidence_present(payload))

        accumulator = scorecard.MetricAccumulator()
        scorecard.ingest_training_or_advantage(
            accumulator,
            payload,
            "policy-advantage.json",
            require_compute=True,
        )
        self.assertEqual(accumulator.summarize(), {})

    def test_runtime_summary_construction_activity_acceptance_metric(self) -> None:
        accumulator = scorecard.MetricAccumulator()
        scorecard.ingest_runtime_summary(
            accumulator,
            {
                "type": "runtime-summary",
                "tick": 123,
                "rooms": [
                    {
                        "roomName": "W1N1",
                        "constructionActivity": {
                            "state": "active",
                            "accepted": True,
                            "reason": "build_energy_carried",
                        },
                        "resources": {"productiveEnergy": {"buildCarriedEnergy": 20}},
                    },
                    {
                        "roomName": "W2N2",
                        "resources": {
                            "productiveEnergy": {
                                "constructionActivity": {
                                    "state": "candidate_suppressed",
                                    "accepted": True,
                                    "reason": "spawn_reserving_energy",
                                }
                            }
                        },
                    },
                    {
                        "roomName": "W3N3",
                        "constructionActivity": {
                            "state": "no_viable_candidate",
                            "accepted": False,
                            "reason": "no_viable_candidate",
                        },
                    },
                ],
            },
            "runtime-summary.log",
        )

        metrics = accumulator.summarize()
        self.assertEqual(metrics["construction_activity_acceptance"]["value"], 1.0)
        self.assertEqual(metrics["construction_activity_acceptance"]["sampleCount"], 3)


if __name__ == "__main__":
    unittest.main()
