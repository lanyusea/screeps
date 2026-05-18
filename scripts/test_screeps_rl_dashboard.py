#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_dashboard as dashboard


JsonObject = dict[str, Any]


def write_json(path: Path, payload: JsonObject) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


def policy_gradient_card(
    *,
    safe: bool = True,
    include_card_supply: bool = True,
    card_supply_state: str = "available",
) -> JsonObject:
    safety = {
        "conservative_actions_only": safe,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "ood_rejection": safe,
    }
    card: JsonObject = {
        "card_id": "rl-exp-rl-accepted-123456789abc",
        "code_commit": "1" * 40,
        "conservative_actions_only": safe,
        "created_at": "2026-05-18T10:35:11Z",
        "dataset_run_id": "rl-accepted",
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "ood_rejection": safe,
        "policy_gradient": {"target_family": "construction-priority"},
        "reward_model": {
            "component_order": ["reliability", "territory", "resources", "kills"],
            "scalar_weighted_sum_authorized": False,
            "type": "lexicographic",
        },
        "safety": safety,
        "status": "shadow",
        "training_approach": "policy_gradient",
    }
    if include_card_supply:
        consumed_at = None
        consumed_by_report_id = None
        available_for_training = True
        if card_supply_state == "consumed":
            consumed_at = "2026-05-18T10:38:11Z"
            consumed_by_report_id = "report-consumed-card"
            available_for_training = False
        elif card_supply_state != "available":
            raise ValueError(f"unknown card_supply_state: {card_supply_state}")
        card["card_supply"] = {
            "type": "screeps-rl-loop-a-card-supply",
            "consumer": "loop-a-policy-gradient",
            "state": card_supply_state,
            "available_for_training": available_for_training,
            "dataset_run_id": card["dataset_run_id"],
            "training_approach": card["training_approach"],
            "created_at": card["created_at"],
            "status_field": "status",
            "safety_status": "shadow",
            "consumed_at": consumed_at,
            "consumed_by_report_id": consumed_by_report_id,
        }
    return card


def loaded_artifact(path: Path, payload: JsonObject) -> dashboard.LoadedArtifact:
    return dashboard.LoadedArtifact(
        path=path,
        payload=payload,
        timestamp=datetime(2026, 5, 18, 10, 40, 0, tzinfo=timezone.utc),
    )


class ScreepsRlDashboardCardSupplyTest(unittest.TestCase):
    def test_tencent_internal_card_downgrades_standalone_stall_to_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-test"
            write_json(
                run_dir / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-test",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-accepted-123456789abc"}},
                },
            )
            write_json(run_dir / "experiment_card.json", policy_gradient_card())

            warnings: list[str] = []
            card_supply = dashboard.discover_tencent_internal_card_supply(
                root,
                warnings=warnings,
                repo_root=root,
            )
            self.assertEqual(warnings, [])
            self.assertIsNotNone(card_supply)
            assert card_supply is not None

            training = dashboard.training_execution(
                loaded_artifact(
                    root / "rl-control-loop" / "training-ledger.json",
                    {
                        "type": "screeps-rl-training-execution-ledger",
                        "status": "RUN_WITH_ANOMALY",
                        "trainingDidRun": True,
                        "trainingArtifacts": {
                            "experimentCard": "Tencent batch generates internal cards per run",
                            "experimentCardPath": None,
                        },
                    },
                ),
                tencent_internal_card_supply=card_supply,
            )
            policy = dashboard.policy_advantage(
                loaded_artifact(
                    root / "rl-control-loop" / "policy-advantage.json",
                    {
                        "type": "screeps-rl-policy-online-advantage-report",
                        "onlineUtilityStatus": "UNPROVEN",
                        "candidatePolicyId": "NO_STABLE_CANDIDATE",
                        "baselinePolicyId": "incumbent",
                        "evidenceWindows": {"loopACardPathStalledCycles": 17},
                    },
                ),
                None,
                training=training,
            )

        self.assertEqual(training["cardSupply"]["status"], "PRIMARY_SATISFIED")
        self.assertEqual(training["cardSupply"]["fallbackStatus"], "DEGRADED")
        self.assertEqual(training["cardSupply"]["fallbackSeverity"], "P2")
        self.assertNotEqual(training["cardSupply"]["severity"], "P0")
        self.assertEqual(policy["cardSupplyFinding"]["status"], "FALLBACK_DEGRADED")
        self.assertEqual(policy["cardSupplyFinding"]["severity"], "P2")

    def test_tencent_internal_card_satisfies_stale_not_run_training_ledger(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-stale"
            write_json(
                run_dir / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-stale",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-accepted-123456789abc"}},
                },
            )
            write_json(run_dir / "experiment_card.json", policy_gradient_card())

            card_supply = dashboard.discover_tencent_internal_card_supply(
                root,
                warnings=[],
                repo_root=root,
            )
            self.assertIsNotNone(card_supply)
            assert card_supply is not None

            training = dashboard.training_execution(
                loaded_artifact(
                    root / "rl-control-loop" / "training-ledger.json",
                    {
                        "type": "screeps-rl-training-execution-ledger",
                        "status": "NOT_RUN",
                        "trainingDidRun": False,
                        "trainingBlocker": "NO_UNCONSUMED_EXPERIMENT_CARD",
                    },
                ),
                tencent_internal_card_supply=card_supply,
            )
            policy = dashboard.policy_advantage(
                loaded_artifact(
                    root / "rl-control-loop" / "policy-advantage.json",
                    {
                        "type": "screeps-rl-policy-online-advantage-report",
                        "onlineUtilityStatus": "UNPROVEN",
                        "candidatePolicyId": "NO_STABLE_CANDIDATE",
                        "baselinePolicyId": "incumbent",
                        "evidenceWindows": {"loopACardPathStalledCycles": 17},
                    },
                ),
                None,
                training=training,
            )

        self.assertEqual(training["status"], "NOT_RUN")
        self.assertEqual(training["cardSupply"]["status"], "PRIMARY_SATISFIED")
        self.assertEqual(training["cardSupply"]["severity"], "OK")
        self.assertIsNone(training["blocker"])
        self.assertEqual(policy["cardSupplyFinding"]["status"], "FALLBACK_DEGRADED")
        self.assertEqual(policy["cardSupplyFinding"]["severity"], "P2")

    def test_consumed_tencent_card_does_not_clear_not_run_card_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-consumed"
            write_json(
                run_dir / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-consumed",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-accepted-123456789abc"}},
                },
            )
            write_json(run_dir / "experiment_card.json", policy_gradient_card(card_supply_state="consumed"))

            card_supply = dashboard.discover_tencent_internal_card_supply(
                root,
                warnings=[],
                repo_root=root,
            )
            self.assertIsNotNone(card_supply)
            assert card_supply is not None

            training = dashboard.training_execution(
                loaded_artifact(
                    root / "rl-control-loop" / "training-ledger.json",
                    {
                        "type": "screeps-rl-training-execution-ledger",
                        "status": "NOT_RUN",
                        "trainingDidRun": False,
                        "trainingBlocker": "NO_UNCONSUMED_EXPERIMENT_CARD",
                    },
                ),
                tencent_internal_card_supply=card_supply,
            )
            policy = dashboard.policy_advantage(
                loaded_artifact(
                    root / "rl-control-loop" / "policy-advantage.json",
                    {
                        "type": "screeps-rl-policy-online-advantage-report",
                        "onlineUtilityStatus": "UNPROVEN",
                        "candidatePolicyId": "NO_STABLE_CANDIDATE",
                        "baselinePolicyId": "incumbent",
                        "evidenceWindows": {"loopACardPathStalledCycles": 17},
                    },
                ),
                None,
                training=training,
            )

        self.assertEqual(training["status"], "NOT_RUN")
        self.assertEqual(training["cardSupply"]["status"], "BLOCKED")
        self.assertEqual(training["cardSupply"]["severity"], "P0")
        self.assertEqual(training["blocker"], "NO_UNCONSUMED_EXPERIMENT_CARD")
        self.assertEqual(policy["cardSupplyFinding"]["status"], "BLOCKED")
        self.assertEqual(policy["cardSupplyFinding"]["severity"], "P0")

    def test_discovery_prefers_available_card_supply_over_newer_consumed_card(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            older_run = root / "tencent-cloud" / "batch-runs" / "tencent-pg-older-available"
            newer_run = root / "tencent-cloud" / "batch-runs" / "tencent-pg-newer-consumed"
            write_json(
                older_run / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-older-available",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-accepted-123456789abc"}},
                },
            )
            write_json(older_run / "experiment_card.json", policy_gradient_card())
            newer_card = policy_gradient_card(card_supply_state="consumed")
            newer_card["created_at"] = "2026-05-18T10:45:11Z"
            newer_card["card_supply"]["created_at"] = newer_card["created_at"]
            write_json(
                newer_run / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-newer-consumed",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-accepted-123456789abc"}},
                },
            )
            write_json(newer_run / "experiment_card.json", newer_card)

            card_supply = dashboard.discover_tencent_internal_card_supply(
                root,
                warnings=[],
                repo_root=root,
            )
            self.assertIsNotNone(card_supply)
            assert card_supply is not None
            training = dashboard.training_execution(
                loaded_artifact(
                    root / "rl-control-loop" / "training-ledger.json",
                    {
                        "type": "screeps-rl-training-execution-ledger",
                        "status": "NOT_RUN",
                        "trainingDidRun": False,
                        "trainingBlocker": "NO_UNCONSUMED_EXPERIMENT_CARD",
                    },
                ),
                tencent_internal_card_supply=card_supply,
            )

        self.assertEqual(card_supply["runId"], "tencent-pg-older-available")
        self.assertEqual(card_supply["cardSupply"]["state"], "available")
        self.assertEqual(training["cardSupply"]["status"], "PRIMARY_SATISFIED")
        self.assertIsNone(training["blocker"])

    def test_non_tencent_training_run_without_embedded_supply_stays_degraded(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-unrelated"
            write_json(
                run_dir / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-unrelated",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-accepted-123456789abc"}},
                },
            )
            write_json(run_dir / "experiment_card.json", policy_gradient_card())
            card_supply = dashboard.discover_tencent_internal_card_supply(
                root,
                warnings=[],
                repo_root=root,
            )
            self.assertIsNotNone(card_supply)
            assert card_supply is not None

            training = dashboard.training_execution(
                loaded_artifact(
                    root / "rl-control-loop" / "training-ledger.json",
                    {
                        "type": "screeps-rl-training-execution-ledger",
                        "status": "RUN_WITH_ANOMALY",
                        "trainingDidRun": True,
                        "artifactCount": 1,
                        "trainingArtifacts": {
                            "experimentCard": "Local standalone experiment card missing card supply",
                            "experimentCardPath": "runtime-artifacts/rl-control-loop/experiment-card.json",
                        },
                    },
                ),
                tencent_internal_card_supply=card_supply,
            )

        self.assertEqual(training["cardSupply"]["status"], "DEGRADED")
        self.assertEqual(
            training["cardSupply"]["classification"],
            "TRAINING_RAN_WITHOUT_STRUCTURED_CARD_SUPPLY_EVIDENCE",
        )
        self.assertEqual(training["cardSupply"]["severity"], "P2")

    def test_tencent_training_report_with_nested_safety_satisfies_card_supply(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-report"
            write_json(
                run_dir / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-report",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-accepted-123456789abc"}},
                },
            )
            card = policy_gradient_card()
            write_json(
                run_dir / "remote" / "runtime-artifacts" / "rl-training" / "report.json",
                {
                    "type": "screeps-rl-training-execution-report",
                    "reportId": "report-nested-safety",
                    "status": "shadow",
                    "safety": card["safety"],
                    "experimentCard": card,
                },
            )

            card_supply = dashboard.discover_tencent_internal_card_supply(
                root,
                warnings=[],
                repo_root=root,
            )

        self.assertIsNotNone(card_supply)
        assert card_supply is not None
        self.assertEqual(card_supply["source"], "tencent_internal_training_report")
        self.assertEqual(card_supply["status"], "PRIMARY_SATISFIED")

    def test_missing_training_and_card_evidence_keeps_card_supply_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            training = dashboard.training_execution(
                loaded_artifact(
                    root / "rl-control-loop" / "training-ledger.json",
                    {
                        "type": "screeps-rl-training-execution-ledger",
                        "status": "NOT_RUN",
                        "trainingDidRun": False,
                        "trainingBlocker": "NO_UNCONSUMED_EXPERIMENT_CARD",
                    },
                ),
                tencent_internal_card_supply=None,
            )

        self.assertEqual(training["cardSupply"]["status"], "BLOCKED")
        self.assertEqual(training["cardSupply"]["severity"], "P0")
        self.assertEqual(training["blocker"], "NO_UNCONSUMED_EXPERIMENT_CARD")

    def test_policy_history_text_does_not_create_card_supply_finding(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            policy = dashboard.policy_advantage(
                loaded_artifact(
                    root / "rl-control-loop" / "policy-advantage.json",
                    {
                        "type": "screeps-rl-policy-online-advantage-report",
                        "onlineUtilityStatus": "UNPROVEN",
                        "candidatePolicyId": "candidate",
                        "baselinePolicyId": "incumbent",
                        "notes": [
                            "Resolved prior standaloneExperimentCard cardPipelineStalled finding after Tencent supply."
                        ],
                    },
                ),
                None,
                training=None,
            )

        self.assertIsNone(policy["cardSupplyFinding"])

    def test_resolved_structured_evidence_window_does_not_create_card_supply_finding(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            policy = dashboard.policy_advantage(
                loaded_artifact(
                    root / "rl-control-loop" / "policy-advantage.json",
                    {
                        "type": "screeps-rl-policy-online-advantage-report",
                        "onlineUtilityStatus": "UNPROVEN",
                        "candidatePolicyId": "candidate",
                        "baselinePolicyId": "incumbent",
                        "evidenceWindows": {
                            "loopACardPathStalledCycles": {"status": "resolved", "count": 0},
                            "cardPipelineStalled": [{"status": "resolved"}, {"count": 0}],
                        },
                    },
                ),
                None,
                training=None,
            )

        self.assertIsNone(policy["cardSupplyFinding"])

    def test_active_nested_structured_evidence_window_creates_card_supply_finding(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            policy = dashboard.policy_advantage(
                loaded_artifact(
                    root / "rl-control-loop" / "policy-advantage.json",
                    {
                        "type": "screeps-rl-policy-online-advantage-report",
                        "onlineUtilityStatus": "UNPROVEN",
                        "candidatePolicyId": "candidate",
                        "baselinePolicyId": "incumbent",
                        "evidenceWindows": {
                            "loopACardPathStalledCycles": {
                                "history": [{"status": "resolved", "count": 0}],
                                "current": {"count": 2},
                            }
                        },
                    },
                ),
                None,
                training=None,
            )

        self.assertEqual(policy["cardSupplyFinding"]["status"], "BLOCKED")
        self.assertEqual(policy["cardSupplyFinding"]["severity"], "P0")

    def test_tencent_internal_card_evidence_requires_safety_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-unsafe"
            write_json(
                run_dir / "controller-summary.json",
                {"type": "screeps-tencent-batch-rl-run", "runId": "tencent-pg-unsafe"},
            )
            write_json(run_dir / "experiment_card.json", policy_gradient_card(safe=False))

            card_supply = dashboard.discover_tencent_internal_card_supply(
                root,
                warnings=[],
                repo_root=root,
            )

        self.assertIsNone(card_supply)


if __name__ == "__main__":
    unittest.main()
