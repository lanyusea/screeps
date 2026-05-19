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


if __name__ == "__main__":
    unittest.main()
