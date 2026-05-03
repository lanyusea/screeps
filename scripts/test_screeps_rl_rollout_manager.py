#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_rollout_manager as manager


JsonObject = dict[str, Any]


def write_json(path: Path, payload: JsonObject) -> None:
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


def kpi_window(
    *,
    territory: float = 2,
    resources: float = 10000,
    kills: float = 3,
    reliability: float = 0.995,
    hours: float = 8,
    samples: int = 8,
) -> JsonObject:
    return {
        "type": "screeps-rl-kpi-window",
        "window": {
            "durationHours": hours,
            "sampleCount": samples,
            "startedAt": "2026-05-03T00:00:00Z",
            "endedAt": "2026-05-03T08:00:00Z",
        },
        "metrics": {
            "kills": {"score": kills},
            "reliability": {"score": reliability},
            "resources": {"score": resources},
            "territory": {"ownedRooms": territory},
        },
    }


def reducer_report(
    *,
    latest_rooms: int = 1,
    stored: int = 1000,
    carried: int = 100,
    harvested: int = 9000,
    transferred: int = 500,
    kills: int = 2,
    malformed: int = 0,
) -> JsonObject:
    return {
        "type": "runtime-kpi-report",
        "input": {
            "ignoredLineCount": 0,
            "malformedRuntimeSummaryCount": malformed,
            "runtimeSummaryCount": 8,
        },
        "window": {
            "firstTick": 0,
            "latestTick": 9600,
        },
        "territory": {
            "ownedRooms": {
                "deltaCount": 0,
                "gained": [],
                "latest": [f"W{i}N1" for i in range(latest_rooms)],
                "latestCount": latest_rooms,
                "lost": [],
                "status": "observed",
            }
        },
        "resources": {
            "eventDeltas": {
                "harvestedEnergy": harvested,
                "status": "observed",
                "transferredEnergy": transferred,
            },
            "status": "observed",
            "totals": {
                "latest": {
                    "droppedEnergy": 0,
                    "sourceCount": 1,
                    "storedEnergy": stored,
                    "workerCarriedEnergy": carried,
                }
            },
        },
        "combat": {
            "eventDeltas": {
                "creepDestroyedCount": kills,
                "objectDestroyedCount": 0,
                "status": "observed",
            },
            "status": "observed",
        },
    }


class RlRolloutManagerTest(unittest.TestCase):
    def test_dry_run_passes_when_all_kpis_stay_within_contract(self) -> None:
        decision = manager.build_dry_run_decision(
            kpi_window(),
            kpi_window(resources=9800, kills=2, reliability=0.99),
            candidate_id="candidate-safe",
            deploy_ref="abc1234",
            created_at="2026-05-03T00:00:00Z",
            rollout_id="rollout-test-pass",
        )

        self.assertTrue(decision["passed"])
        self.assertEqual(decision["decision"], "rollout_approved")
        self.assertEqual(decision["comparison"]["metrics"]["territory"]["status"], "pass")
        self.assertEqual(decision["feedbackIngestion"]["status"], "ready")

    def test_dry_run_fails_when_a_priority_kpi_degrades(self) -> None:
        decision = manager.build_dry_run_decision(
            kpi_window(),
            kpi_window(territory=1, resources=9300, kills=3, reliability=0.995),
            created_at="2026-05-03T00:00:00Z",
        )

        self.assertFalse(decision["passed"])
        self.assertEqual(decision["decision"], "rollout_rejected")
        self.assertEqual(decision["comparison"]["metrics"]["territory"]["status"], "fail")
        self.assertIn("degradation_exceeds_threshold", decision["comparison"]["metrics"]["territory"]["reasons"])

    def test_dry_run_edge_case_short_or_sparse_window_blocks_rollout(self) -> None:
        decision = manager.build_dry_run_decision(
            kpi_window(),
            kpi_window(hours=7.5, samples=7),
            created_at="2026-05-03T00:00:00Z",
        )

        self.assertFalse(decision["passed"])
        reasons = decision["blockingReasons"]
        self.assertTrue(any(reason.get("reason") == "duration_below_observation_window" for reason in reasons))
        self.assertTrue(any(reason.get("reason") == "samples_below_minimum" for reason in reasons))

    def test_dry_run_edge_case_missing_metric_fails_closed(self) -> None:
        post = kpi_window()
        del post["metrics"]["reliability"]

        decision = manager.build_dry_run_decision(
            kpi_window(),
            post,
            created_at="2026-05-03T00:00:00Z",
        )

        self.assertFalse(decision["passed"])
        self.assertEqual(decision["comparison"]["metrics"]["reliability"]["status"], "fail")
        self.assertIn("missing_post_metric", decision["comparison"]["metrics"]["reliability"]["reasons"])

    def test_post_rollout_comparison_reports_metric_deltas(self) -> None:
        comparison = manager.build_kpi_comparison(
            kpi_window(resources=10000, kills=4),
            kpi_window(resources=10400, kills=5),
            created_at="2026-05-03T00:00:00Z",
        )

        self.assertEqual(comparison["gateStatus"], "pass")
        self.assertEqual(comparison["metrics"]["resources"]["delta"], 400)
        self.assertEqual(comparison["metrics"]["kills"]["delta"], 1)

    def test_rollback_trigger_fires_on_degradation_inside_window(self) -> None:
        check = manager.build_rollback_check(
            kpi_window(),
            kpi_window(territory=1, resources=10000, kills=3, reliability=0.995, hours=2, samples=2),
            candidate_id="candidate-regressed",
            created_at="2026-05-03T00:00:00Z",
        )

        self.assertTrue(check["rollbackTriggered"])
        self.assertEqual(check["decision"], "auto_revert")
        self.assertEqual(check["metricTriggers"][0]["metric"], "territory")

    def test_rollback_trigger_does_not_fire_on_normal_variance(self) -> None:
        check = manager.build_rollback_check(
            kpi_window(),
            kpi_window(resources=9850, kills=2, reliability=0.99, hours=2, samples=2),
            created_at="2026-05-03T00:00:00Z",
        )

        self.assertFalse(check["rollbackTriggered"])
        self.assertEqual(check["decision"], "continue_observation")
        self.assertEqual(check["metricTriggers"], [])

    def test_fixture_based_dry_run_integration_accepts_reducer_style_kpi_reports(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            pre_path = root / "pre.json"
            post_path = root / "post.json"
            output_path = root / "decision.json"
            write_json(pre_path, reducer_report(stored=1000, harvested=9000, transferred=500, kills=2))
            write_json(post_path, reducer_report(stored=1200, harvested=9100, transferred=500, kills=2))

            exit_code = manager.main(
                [
                    "dry-run",
                    "--pre",
                    str(pre_path),
                    "--post",
                    str(post_path),
                    "--candidate-id",
                    "fixture-candidate",
                    "--deploy-ref",
                    "deadbee",
                    "--created-at",
                    "2026-05-03T00:00:00Z",
                    "--output",
                    str(output_path),
                ],
                stdout=StringIO(),
            )

            self.assertEqual(exit_code, 0)
            decision = json.loads(output_path.read_text(encoding="utf-8"))

        self.assertTrue(decision["passed"])
        self.assertEqual(decision["candidate"]["id"], "fixture-candidate")
        self.assertEqual(decision["comparison"]["metrics"]["resources"]["delta"], 300)
        self.assertEqual(decision["comparison"]["pre"]["metrics"]["reliability"], 1)


if __name__ == "__main__":
    unittest.main()
