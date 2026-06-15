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

    def test_valid_canary_contract_generation_records_safety_status(self) -> None:
        decision = manager.build_dry_run_decision(
            kpi_window(),
            kpi_window(resources=9900, kills=3, reliability=0.995),
            candidate_id="candidate-canary",
            deploy_ref="candidate-ref",
            incumbent_baseline_ref="incumbent-ref",
            rollback_ref="rollback-ref",
            live_influence_state="canary",
            live_influence_surface="bounded_high_level_strategy_knobs",
            created_at="2026-05-03T00:00:00Z",
        )

        canary = decision["canaryContract"]
        self.assertTrue(decision["passed"])
        self.assertEqual(canary["validation"]["status"], "pass")
        self.assertEqual(canary["candidate"]["id"], "candidate-canary")
        self.assertEqual(canary["candidate"]["deployRef"], "candidate-ref")
        self.assertEqual(canary["incumbentBaseline"]["ref"], "incumbent-ref")
        self.assertEqual(canary["rollback"]["ref"], "rollback-ref")
        self.assertEqual(canary["liveInfluence"]["state"], "canary")
        self.assertEqual(canary["liveInfluence"]["allowedSurface"], "bounded_high_level_strategy_knobs")
        self.assertEqual(canary["sampleRequirements"]["preWindow"]["minimumSamples"], 8)
        self.assertEqual(canary["rollbackThresholds"]["territory"]["maxDegradationAbsolute"], 0)
        self.assertIn("constructionPriority.extensionWeight", canary["strategyKnobLimits"])
        self.assertTrue(canary["validators"]["deterministicVetoRequired"])

    def test_canary_readiness_plan_records_ready_controller_handoff(self) -> None:
        plan = manager.build_canary_readiness_plan(
            active_world_ref="14df4ae442fb68e1273aa69c182daa0328e2d868",
            active_world_status="matched_main",
            baseline_raw=kpi_window(),
            baseline_source="runtime-artifacts/rl-control-loop/baselines/incumbent.json",
            candidate_id="candidate-top-construction",
            conclusion_records=[
                ("RL-CONC-20260612-004", "VALIDATING"),
                ("RL-CONC-20260610-002", "ACTIONED"),
            ],
            conclusion_registry_ref="runtime-artifacts/rl-control-loop/conclusion-registry.json",
            conclusion_summary="ACTIONED=1,VALIDATING=1,CLOSED=2",
            construction_acceptance_status="pass",
            cpu_baseline_ref="runtime-artifacts/rl-control-loop/cpu-baseline.json",
            cpu_baseline_status="pass",
            created_at="2026-06-15T00:00:00Z",
            deploy_artifact="runtime-artifacts/official-screeps-deploy/official-screeps-deploy-27530460405.json",
            deploy_ref="candidate-ref",
            health_gate_ok=True,
            incumbent_baseline_ref="incumbent-ref",
            official_deploy_head="14df4ae442fb68e1273aa69c182daa0328e2d868",
            official_deploy_run_id="27530460405",
            owned_creeps=5,
            owned_spawns=1,
            postdeploy_alert=False,
            postdeploy_alert_artifact="runtime-artifacts/official-screeps-deploy/postdeploy-alert-27530460405.json",
            postdeploy_health_gate_artifact="runtime-artifacts/official-screeps-deploy/postdeploy-health-gate-27530460405.json",
            postdeploy_summary_artifact="runtime-artifacts/official-screeps-deploy/postdeploy-summary-27530460405.json",
            rollback_ref="rollback-ref",
            scorecard_ref="runtime-artifacts/rl-control-loop/scorecards/candidate-top-construction.json",
        )

        self.assertEqual(plan["type"], manager.CANARY_PLAN_TYPE)
        self.assertEqual(plan["issue"], "#1583")
        self.assertEqual(plan["readiness"]["status"], "ready")
        self.assertEqual(plan["readiness"]["blockingReasons"], [])
        self.assertFalse(plan["safetyGuards"]["paidComputeAllowed"])
        self.assertFalse(plan["safetyGuards"]["officialMmoWritesAllowedDuringPlanning"])
        self.assertFalse(plan["safetyGuards"]["deploysCode"])
        self.assertEqual(plan["constructionGate"]["status"], "pass")
        self.assertEqual(plan["cpuGate"]["status"], "pass")
        self.assertEqual(plan["officialDeploy"]["ownedSpawns"], 1)
        self.assertEqual(plan["controlLoop"]["conclusions"][0]["conclusionId"], "RL-CONC-20260612-004")
        self.assertEqual(plan["canaryContract"]["validation"]["status"], "pass")
        self.assertEqual(plan["incumbentBaseline"]["kpiWindow"]["observation"]["status"], "pass")

    def test_canary_readiness_plan_holds_without_required_gates_or_safety(self) -> None:
        plan = manager.build_canary_readiness_plan(
            active_world_status="stale",
            baseline_raw=kpi_window(hours=1, samples=1),
            candidate_id="candidate-held",
            deploy_ref="candidate-ref",
            health_gate_ok=False,
            incumbent_baseline_ref="incumbent-ref",
            paid_compute_allowed=True,
            postdeploy_alert=True,
            rollback_ref="rollback-ref",
        )

        reasons = plan["readiness"]["blockingReasons"]
        self.assertEqual(plan["readiness"]["status"], "hold")
        self.assertTrue(any(reason.get("reason") == "duration_below_observation_window" for reason in reasons))
        self.assertTrue(any(reason.get("reason") == "samples_below_minimum" for reason in reasons))
        self.assertTrue(any(reason.get("reason") == "missing_candidate_scorecard_ref" for reason in reasons))
        self.assertTrue(any(reason.get("reason") == "missing_conclusion_registry_ref" for reason in reasons))
        self.assertTrue(any(reason.get("reason") == "paid_compute_must_remain_held" for reason in reasons))
        self.assertTrue(any(reason.get("reason") == "postdeploy_health_gate_must_be_ok" for reason in reasons))
        self.assertTrue(any(reason.get("reason") == "postdeploy_alert_must_be_false" for reason in reasons))
        self.assertTrue(any(reason.get("reason") == "cpu_baseline_must_pass" for reason in reasons))
        self.assertTrue(any(reason.get("reason") == "construction_acceptance_must_pass" for reason in reasons))

    def test_canary_contract_rejects_forbidden_surface_and_missing_rollback_ref(self) -> None:
        forbidden = manager.build_dry_run_decision(
            kpi_window(),
            kpi_window(),
            candidate_id="candidate-unsafe",
            deploy_ref="candidate-ref",
            incumbent_baseline_ref="incumbent-ref",
            rollback_ref="rollback-ref",
            live_influence_state="canary",
            live_influence_surface="raw_creep_intents",
            created_at="2026-05-03T00:00:00Z",
        )
        missing_rollback = manager.build_dry_run_decision(
            kpi_window(),
            kpi_window(),
            candidate_id="candidate-no-rollback",
            deploy_ref="candidate-ref",
            incumbent_baseline_ref="incumbent-ref",
            live_influence_state="canary",
            live_influence_surface="bounded_high_level_strategy_knobs",
            created_at="2026-05-03T00:00:00Z",
        )

        self.assertFalse(forbidden["passed"])
        self.assertEqual(forbidden["canaryContract"]["validation"]["status"], "fail")
        self.assertTrue(
            any(reason.get("reason") == "forbidden_live_influence_surface" for reason in forbidden["blockingReasons"])
        )
        self.assertFalse(missing_rollback["passed"])
        self.assertEqual(missing_rollback["canaryContract"]["validation"]["status"], "fail")
        self.assertTrue(
            any(reason.get("reason") == "missing_rollback_ref" for reason in missing_rollback["blockingReasons"])
        )

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
            current_deploy_ref="candidate-ref",
            incumbent_baseline_ref="incumbent-ref",
            previous_deploy_ref="rollback-ref",
            created_at="2026-05-03T00:00:00Z",
        )

        self.assertTrue(check["rollbackTriggered"])
        self.assertEqual(check["decision"], "auto_revert")
        self.assertCountEqual(
            [trigger["metric"] for trigger in check["metricTriggers"]],
            ["territory"],
        )

    def test_rollback_trigger_fires_on_reliability_regression(self) -> None:
        check = manager.build_rollback_check(
            kpi_window(reliability=0.995),
            kpi_window(reliability=0.94, hours=2, samples=2),
            candidate_id="candidate-unreliable",
            current_deploy_ref="candidate-ref",
            incumbent_baseline_ref="incumbent-ref",
            previous_deploy_ref="rollback-ref",
            created_at="2026-05-03T00:00:00Z",
        )

        self.assertTrue(check["rollbackTriggered"])
        self.assertEqual(check["decision"], "auto_revert")
        self.assertCountEqual(
            [trigger["metric"] for trigger in check["metricTriggers"]],
            ["reliability"],
        )

    def test_rollback_check_fails_safe_when_refs_or_sample_windows_are_missing(self) -> None:
        baseline = kpi_window()
        current = kpi_window(resources=9900, hours=2, samples=2)
        del baseline["window"]["sampleCount"]

        check = manager.build_rollback_check(
            baseline,
            current,
            current_deploy_ref="candidate-ref",
            previous_deploy_ref="rollback-ref",
            created_at="2026-05-03T00:00:00Z",
        )

        self.assertTrue(check["rollbackTriggered"])
        self.assertEqual(check["decision"], "auto_revert")
        self.assertTrue(any(reason.get("reason") == "missing_candidate_id" for reason in check["failSafeReasons"]))
        self.assertTrue(any(reason.get("reason") == "missing_incumbent_baseline_ref" for reason in check["failSafeReasons"]))
        self.assertTrue(any(reason.get("reason") == "missing_sample_count" for reason in check["failSafeReasons"]))

    def test_rollback_trigger_does_not_fire_on_normal_variance(self) -> None:
        check = manager.build_rollback_check(
            kpi_window(),
            kpi_window(resources=9850, kills=2, reliability=0.99, hours=2, samples=2),
            candidate_id="candidate-stable",
            current_deploy_ref="candidate-ref",
            incumbent_baseline_ref="incumbent-ref",
            previous_deploy_ref="rollback-ref",
            created_at="2026-05-03T00:00:00Z",
        )

        self.assertFalse(check["rollbackTriggered"])
        self.assertEqual(check["decision"], "continue_observation")
        self.assertEqual(check["metricTriggers"], [])

    def test_contract_and_compare_artifacts_report_live_influence_state(self) -> None:
        contract = manager.build_gate_contract()
        comparison = manager.build_kpi_comparison(
            kpi_window(),
            kpi_window(resources=10100),
            candidate_id="candidate-shadow",
            deploy_ref="candidate-ref",
            live_influence_state="shadow",
            live_influence_surface="recommendation_only",
            created_at="2026-05-03T00:00:00Z",
        )

        self.assertEqual(contract["safeCanary"]["liveInfluence"]["state"], "none")
        self.assertEqual(contract["safeCanary"]["liveInfluence"]["allowedSurface"], "none")
        self.assertEqual(comparison["canaryContract"]["liveInfluence"]["state"], "shadow")
        self.assertEqual(comparison["canaryContract"]["liveInfluence"]["allowedSurface"], "recommendation_only")
        self.assertEqual(comparison["canaryContract"]["validation"]["status"], "pass")

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

    def test_canary_plan_cli_writes_planning_record(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            baseline_path = root / "baseline.json"
            output_path = root / "canary-plan.json"
            write_json(baseline_path, kpi_window())

            exit_code = manager.main(
                [
                    "canary-plan",
                    "--baseline",
                    str(baseline_path),
                    "--candidate-id",
                    "candidate-cli",
                    "--deploy-ref",
                    "candidate-ref",
                    "--scorecard-ref",
                    "runtime-artifacts/rl-control-loop/scorecards/candidate-cli.json",
                    "--incumbent-baseline-ref",
                    "incumbent-ref",
                    "--rollback-ref",
                    "rollback-ref",
                    "--active-world-ref",
                    "14df4ae442fb68e1273aa69c182daa0328e2d868",
                    "--active-world-status",
                    "matched_main",
                    "--official-deploy-head",
                    "14df4ae442fb68e1273aa69c182daa0328e2d868",
                    "--official-deploy-run-id",
                    "27530460405",
                    "--deploy-artifact",
                    "runtime-artifacts/official-screeps-deploy/official-screeps-deploy-27530460405.json",
                    "--postdeploy-summary-artifact",
                    "runtime-artifacts/official-screeps-deploy/postdeploy-summary-27530460405.json",
                    "--postdeploy-health-gate-artifact",
                    "runtime-artifacts/official-screeps-deploy/postdeploy-health-gate-27530460405.json",
                    "--postdeploy-alert-artifact",
                    "runtime-artifacts/official-screeps-deploy/postdeploy-alert-27530460405.json",
                    "--health-gate-ok",
                    "true",
                    "--postdeploy-alert",
                    "false",
                    "--construction-acceptance-status",
                    "pass",
                    "--owned-spawns",
                    "1",
                    "--owned-creeps",
                    "5",
                    "--cpu-baseline-status",
                    "pass",
                    "--cpu-baseline-ref",
                    "runtime-artifacts/rl-control-loop/cpu-baseline.json",
                    "--conclusion-registry-ref",
                    "runtime-artifacts/rl-control-loop/conclusion-registry.json",
                    "--conclusion-summary",
                    "ACTIONED=1,VALIDATING=1,CLOSED=2",
                    "--conclusion",
                    "RL-CONC-20260612-004=VALIDATING",
                    "--conclusion",
                    "RL-CONC-20260610-002=ACTIONED",
                    "--created-at",
                    "2026-06-15T00:00:00Z",
                    "--output",
                    str(output_path),
                ],
                stdout=StringIO(),
            )

            self.assertEqual(exit_code, 0)
            plan = json.loads(output_path.read_text(encoding="utf-8"))

        self.assertEqual(plan["readiness"]["status"], "ready")
        self.assertEqual(plan["mode"], "planning_only")
        self.assertEqual(plan["officialDeploy"]["runId"], "27530460405")
        self.assertEqual(plan["controlLoop"]["summary"], "ACTIONED=1,VALIDATING=1,CLOSED=2")


if __name__ == "__main__":
    unittest.main()
