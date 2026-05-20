#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_act_loop_planner as planner


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "rl" / "act-loop-mixed-unproven-policy-advantage.json"


class ScreepsRlActLoopPlannerTest(unittest.TestCase):
    def test_mixed_loop_b_policy_advantage_routes_to_scenario_policy_and_card_delta(self) -> None:
        raw = planner.load_json(FIXTURE_PATH)

        plan = planner.build_plans(raw, source_artifact=str(FIXTURE_PATH))

        self.assertEqual(plan["type"], planner.PLAN_TYPE)
        self.assertEqual(plan["decision"], "act_loop_planned")
        self.assertEqual(plan["status"], "ACT_DELTA_READY")
        self.assertEqual(plan["finding"]["classification"], "scenario_gap")
        self.assertIn("policy_parameterization_gap", plan["finding"]["secondaryClassifications"])
        self.assertIsNone(plan["nextRewardDecision"])

        scenario_delta = plan["nextScenarioDelta"]
        self.assertEqual(scenario_delta["targetScenarioId"], planner.MULTI_TIER_SCENARIO_ID)
        self.assertEqual(scenario_delta["routing"], "experiment_card_delta")
        self.assertTrue(scenario_delta["shadowOnly"])
        self.assertFalse(scenario_delta["safety"]["officialMmoWrites"])

        policy_delta = plan["nextPolicyDelta"]
        self.assertEqual(policy_delta["parameterSurface"], "construction-priority")
        self.assertEqual(policy_delta["boundsStatus"], "present")
        self.assertEqual(
            [item["name"] for item in policy_delta["bounds"]],
            ["territorySignalWeight", "riskPenalty"],
        )
        self.assertFalse(policy_delta["safety"]["officialMmoWritesAllowed"])

        card_delta = plan["nextExperimentCardDelta"]
        self.assertEqual(card_delta["trainingApproach"], "policy_gradient")
        self.assertEqual(card_delta["scenarioId"], planner.MULTI_TIER_SCENARIO_ID)
        self.assertEqual(card_delta["datasetRunId"], "rl-loop-b-sample-000001")
        self.assertEqual(card_delta["status"], "shadow")
        self.assertEqual(card_delta["deltas"]["policy"]["parameterSurface"], "construction-priority")
        self.assertFalse(card_delta["safety"]["liveEffect"])

        feedback = plan["feedbackIngestion"]
        self.assertEqual(feedback["finding"]["state"], "observed")
        self.assertEqual(feedback["decision"]["state"], "planned")
        self.assertEqual(feedback["decision"]["plannedId"], "act-decision:loop-b-mixed-unproven-construction-priority")
        self.assertEqual(feedback["experimentCard"]["state"], "planned")
        self.assertEqual(feedback["training"]["state"], "linked")
        self.assertEqual(feedback["training"]["id"], "training-loop-b-sample-000001")
        self.assertEqual(feedback["scorecard"]["state"], "linked")
        self.assertEqual(feedback["scorecard"]["id"], "scorecard-loop-b-sample-000001")

    def test_reward_gap_routes_through_reward_decision_record_before_card_use(self) -> None:
        raw = {
            "title": "Construction backlog has no reward pressure",
            "classification": "reward_gap",
            "componentId": "construction-neglect-penalty",
            "evidenceWindow": "2026-05-18T00:00:00Z..2026-05-18T08:00:00Z",
            "hypothesis": "Penalize build=0 when construction sites exist without weakening survival gates.",
            "kpiDeltaObserved": "constructionSiteCount stayed positive while taskCounts.build stayed zero",
        }

        plan = planner.build_plan(raw, source_artifact="runtime-artifacts/rl-control-loop/reward-gap.json")

        decision = plan["nextRewardDecision"]
        self.assertEqual(decision["decisionRecordStyle"], "#907-style")
        self.assertEqual(decision["registry"], planner.REWARD_DECISION_REGISTRY)
        self.assertEqual(decision["componentId"], "construction-neglect-penalty")
        self.assertIn("metric evidence", decision["requiredFields"])
        self.assertFalse(decision["safety"]["officialMmoWrites"])
        self.assertEqual(plan["nextExperimentCardDelta"]["deltas"]["rewardDecision"]["componentId"], "construction-neglect-penalty")
        self.assertIn("#907-style", " ".join(plan["blockingReasons"]))

    def test_data_quality_finding_does_not_emit_training_card_delta(self) -> None:
        plan = planner.build_plan(
            {
                "title": "Policy advantage has no compute evidence",
                "classification": "data_quality",
                "onlineUtilityStatus": "BLOCKED_NO_COMPUTE",
            }
        )

        self.assertEqual(plan["status"], "ROUTE_REQUIRED")
        self.assertIsNone(plan["nextRewardDecision"])
        self.assertIsNone(plan["nextScenarioDelta"])
        self.assertIsNone(plan["nextExperimentCardDelta"])
        self.assertEqual(plan["feedbackIngestion"]["training"]["state"], "missing")
        self.assertTrue(any("data quality" in reason for reason in plan["blockingReasons"]))

    def test_no_compute_status_takes_precedence_over_missing_capabilities(self) -> None:
        cases = (
            {
                "title": "Policy advantage has no compute evidence but lists scenario gaps",
                "onlineUtilityStatus": "BLOCKED_NO_COMPUTE",
                "missingCapabilities": ["multi_room_capable"],
                "componentId": "construction-neglect-penalty",
                "parameterSurface": "construction-priority",
            },
            {
                "title": "Explicit scenario gap still lacks compute evidence",
                "classification": "scenario_gap",
                "onlineUtilityStatus": "BLOCKED_NO_COMPUTE",
                "missingCapabilities": ["multi_room_capable"],
                "componentId": "construction-neglect-penalty",
                "parameterSurface": "construction-priority",
            },
        )

        for raw in cases:
            with self.subTest(title=raw["title"]):
                plan = planner.build_plan(raw)

                self.assertEqual(plan["finding"]["classification"], "data_quality")
                self.assertIn("scenario_gap", plan["finding"]["secondaryClassifications"])
                self.assertIn("policy_parameterization_gap", plan["finding"]["secondaryClassifications"])
                self.assertEqual(plan["status"], "ROUTE_REQUIRED")
                self.assertIsNone(plan["nextRewardDecision"])
                self.assertIsNone(plan["nextScenarioDelta"])
                self.assertIsNone(plan["nextPolicyDelta"])
                self.assertIsNone(plan["nextExperimentCardDelta"])
                self.assertEqual(plan["feedbackIngestion"]["training"]["state"], "missing")
                self.assertTrue(any("data quality" in reason for reason in plan["blockingReasons"]))

    def test_blocked_classification_with_signal_noise_still_blocks_all_deltas(self) -> None:
        plan = planner.build_plan(
            {
                "title": "Telemetry missing with scenario and reward hints",
                "classification": "data_quality",
                "missingCapabilities": ["multi_room_capable"],
                "componentId": "construction-neglect-penalty",
                "onlineUtilityStatus": "BLOCKED_NO_COMPUTE",
            }
        )

        self.assertEqual(plan["status"], "ROUTE_REQUIRED")
        self.assertIsNone(plan["nextRewardDecision"])
        self.assertIsNone(plan["nextScenarioDelta"])
        self.assertIsNone(plan["nextPolicyDelta"])
        self.assertIsNone(plan["nextExperimentCardDelta"])
        self.assertEqual(plan["feedbackIngestion"]["training"]["state"], "missing")
        self.assertTrue(any("data quality" in reason for reason in plan["blockingReasons"]))

    def test_rollout_regression_with_signal_noise_still_blocks_all_deltas(self) -> None:
        plan = planner.build_plan(
            {
                "title": "Rollout regression with scenario, reward, and policy hints",
                "classification": "rollout_regression",
                "missingCapabilities": ["multi_room_capable"],
                "componentId": "construction-neglect-penalty",
                "onlineUtilityStatus": "MIXED",
                "parameterSurface": "construction-priority",
            }
        )

        self.assertEqual(plan["status"], "ROUTE_REQUIRED")
        self.assertIsNone(plan["nextRewardDecision"])
        self.assertIsNone(plan["nextScenarioDelta"])
        self.assertIsNone(plan["nextPolicyDelta"])
        self.assertIsNone(plan["nextExperimentCardDelta"])
        self.assertTrue(any("rollout regression" in reason for reason in plan["blockingReasons"]))

    def test_nested_policy_surface_name_and_bounds_are_honored(self) -> None:
        plan = planner.build_plan(
            {
                "title": "Construction backlog policy family should use the explicit nested surface",
                "classification": "policy_parameterization_gap",
                "onlineUtilityStatus": "UNPROVEN",
                "policyDelta": {
                    "parameterSurface": {
                        "name": "expansion-risk-window",
                        "bounds": [
                            {
                                "name": "remoteRiskLimit",
                                "min": 0,
                                "max": 1,
                                "step": 0.05,
                                "reason": "Keep remote risk bounded before expansion changes.",
                            }
                        ],
                    }
                },
            }
        )

        policy_delta = plan["nextPolicyDelta"]
        self.assertEqual(plan["status"], "ACT_DELTA_READY")
        self.assertEqual(policy_delta["parameterSurface"], "expansion-risk-window")
        self.assertEqual(policy_delta["boundsStatus"], "present")
        self.assertEqual(policy_delta["bounds"][0]["name"], "remoteRiskLimit")
        self.assertEqual(plan["nextExperimentCardDelta"]["deltas"]["policy"]["parameterSurface"], "expansion-risk-window")
        self.assertEqual(
            [item["name"] for item in plan["nextExperimentCardDelta"]["deltas"]["policy"]["bounds"]],
            ["remoteRiskLimit"],
        )

    def test_nested_policy_surface_without_bounds_stays_route_required(self) -> None:
        plan = planner.build_plan(
            {
                "title": "Explicit nested expansion surface is still unbounded",
                "classification": "policy_parameterization_gap",
                "onlineUtilityStatus": "UNPROVEN",
                "policyDelta": {
                    "parameterSurface": {
                        "name": "expansion-risk-window",
                    }
                },
            }
        )

        self.assertEqual(plan["status"], "ROUTE_REQUIRED")
        self.assertEqual(plan["nextPolicyDelta"]["parameterSurface"], "expansion-risk-window")
        self.assertEqual(plan["nextPolicyDelta"]["boundsStatus"], "missing")
        self.assertIsNone(plan["nextExperimentCardDelta"])
        self.assertTrue(any("missing named bounds" in reason for reason in plan["blockingReasons"]))

    def test_feedback_ingestion_links_first_usable_list_form_report_id(self) -> None:
        plan = planner.build_plan(
            {
                "title": "Training report already exists",
                "classification": "data_quality",
                "trainingRunId": "",
                "trainingReportIds": ["", "training-loop-b-sample-000002"],
                "scorecardId": None,
                "scorecardIds": [{"id": "scorecard-loop-b-sample-000002"}],
            }
        )

        self.assertEqual(plan["feedbackIngestion"]["training"]["state"], "linked")
        self.assertEqual(plan["feedbackIngestion"]["training"]["id"], "training-loop-b-sample-000002")
        self.assertEqual(plan["feedbackIngestion"]["scorecard"]["state"], "linked")
        self.assertEqual(plan["feedbackIngestion"]["scorecard"]["id"], "scorecard-loop-b-sample-000002")

    def test_unbounded_policy_only_finding_stays_route_required(self) -> None:
        plan = planner.build_plan(
            {
                "title": "Expansion policy needs a new parameter surface",
                "classification": "policy_parameterization_gap",
                "parameterSurface": "expansion-risk-window",
            }
        )

        self.assertEqual(plan["status"], "ROUTE_REQUIRED")
        self.assertEqual(plan["nextPolicyDelta"]["boundsStatus"], "missing")
        self.assertIsNone(plan["nextExperimentCardDelta"])
        self.assertTrue(any("missing named bounds" in reason for reason in plan["blockingReasons"]))

    def test_cli_writes_deterministic_plan_without_github_or_mmo_actions(self) -> None:
        with tempfile.TemporaryDirectory(prefix="act-loop-plan-") as temp_dir:
            output = Path(temp_dir) / "plan.json"
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = planner.main(
                [str(FIXTURE_PATH), "--source-artifact", "runtime-artifacts/rl-control-loop/policy-advantage.json", "--output", str(output)],
                stdout=stdout,
                stderr=stderr,
            )

            self.assertEqual(exit_code, 0, stderr.getvalue())
            self.assertEqual(stdout.getvalue(), "")
            first = json.loads(output.read_text(encoding="utf-8"))

            exit_code = planner.main(
                [str(FIXTURE_PATH), "--source-artifact", "runtime-artifacts/rl-control-loop/policy-advantage.json", "--output", str(output)],
                stdout=stdout,
                stderr=stderr,
            )

            self.assertEqual(exit_code, 0, stderr.getvalue())
            second = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(first, second)
            rendered = json.dumps(second, sort_keys=True)
            self.assertIn('"officialMmoWrites": false', rendered)
            self.assertNotIn("gh issue create", rendered)

    def test_cli_reports_malformed_json_without_traceback(self) -> None:
        with tempfile.TemporaryDirectory(prefix="act-loop-plan-") as temp_dir:
            bad_input = Path(temp_dir) / "bad.json"
            bad_input.write_text("{", encoding="utf-8")
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = planner.main([str(bad_input)], stdout=stdout, stderr=stderr)

            self.assertEqual(exit_code, 1)
            self.assertEqual(stdout.getvalue(), "")
            self.assertIn("invalid JSON", stderr.getvalue())
            self.assertNotIn("Traceback", stderr.getvalue())

    def test_cli_reports_input_io_failures_without_traceback(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        with mock.patch.object(planner, "load_json", side_effect=PermissionError("permission denied")):
            exit_code = planner.main([str(FIXTURE_PATH)], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("I/O failure", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())

    def test_cli_reports_output_write_failures_without_traceback(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        with mock.patch.object(planner, "write_text_atomic", side_effect=OSError("permission denied")):
            exit_code = planner.main([str(FIXTURE_PATH), "--output", "plan.json"], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("I/O failure", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())

    def test_cli_reports_serialization_failures_without_traceback(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        with mock.patch.object(planner, "build_plans", return_value={"bad": object()}):
            exit_code = planner.main([str(FIXTURE_PATH)], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("failed to serialize plan JSON", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
