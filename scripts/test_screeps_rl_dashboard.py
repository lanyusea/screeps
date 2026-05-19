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
    card_id: str = "rl-exp-rl-accepted-123456789abc",
    dataset_run_id: str = "rl-accepted",
    created_at: str = "2026-05-18T10:35:11Z",
) -> JsonObject:
    safety = {
        "conservative_actions_only": safe,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "ood_rejection": safe,
    }
    card: JsonObject = {
        "card_id": card_id,
        "code_commit": "1" * 40,
        "conservative_actions_only": safe,
        "created_at": created_at,
        "dataset_run_id": dataset_run_id,
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
            "dataset_run_id": dataset_run_id,
            "training_approach": card["training_approach"],
            "created_at": created_at,
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
                            "tencentInternalCardSupply": {
                                "runId": "tencent-pg-test",
                                "cardId": "rl-exp-rl-accepted-123456789abc",
                                "datasetRunId": "rl-accepted",
                            },
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

    def test_generic_tencent_training_text_does_not_borrow_latest_card_supply(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-generic"
            write_json(
                run_dir / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-generic",
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
                            "experimentCard": "Tencent batch generates internal cards per run",
                            "experimentCardPath": None,
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
        self.assertNotEqual(training["cardSupply"].get("source"), "tencent_internal_experiment_card")

    def test_matching_tencent_identity_ignores_unrelated_historical_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-current"
            write_json(
                run_dir / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-current",
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
                            "tencentInternalCardSupply": {
                                "runId": "tencent-pg-current",
                                "cardId": "rl-exp-rl-accepted-123456789abc",
                                "datasetRunId": "rl-accepted",
                            },
                            "historicalArtifacts": [
                                {
                                    "runId": "tencent-pg-historical",
                                    "cardId": "rl-exp-rl-old-000000000000",
                                    "datasetRunId": "rl-old",
                                }
                            ],
                        },
                    },
                ),
                tencent_internal_card_supply=card_supply,
            )

        self.assertEqual(training["cardSupply"]["status"], "PRIMARY_SATISFIED")
        self.assertEqual(training["cardSupply"]["source"], "tencent_internal_experiment_card")

    def test_mismatched_tencent_training_identity_does_not_borrow_latest_card_supply(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-latest"
            write_json(
                run_dir / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-latest",
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
                            "tencentInternalCardSupply": {
                                "runId": "tencent-pg-different",
                                "cardId": "rl-exp-rl-accepted-123456789abc",
                                "datasetRunId": "rl-accepted",
                            },
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
        self.assertNotEqual(training["cardSupply"].get("source"), "tencent_internal_experiment_card")

    def test_partial_tencent_training_identity_does_not_borrow_latest_card_supply(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-partial"
            write_json(
                run_dir / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-partial",
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
                            "tencentInternalCardSupply": {
                                "runId": "tencent-pg-partial",
                                "cardId": "rl-exp-rl-accepted-123456789abc",
                            },
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
        self.assertNotEqual(training["cardSupply"].get("source"), "tencent_internal_experiment_card")

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

    def test_legacy_metadata_less_tencent_card_satisfies_not_run_training_ledger(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-legacy"
            write_json(
                run_dir / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-legacy",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-accepted-123456789abc"}},
                },
            )
            write_json(run_dir / "experiment_card.json", policy_gradient_card(include_card_supply=False))

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

        self.assertEqual(card_supply["hasLoopACardSupplyMetadata"], False)
        self.assertEqual(training["status"], "NOT_RUN")
        self.assertEqual(training["cardSupply"]["status"], "PRIMARY_SATISFIED")
        self.assertEqual(training["cardSupply"]["severity"], "OK")
        self.assertIsNone(training["blocker"])

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

    def test_single_run_candidate_selection_prefers_available_card_over_later_consumed_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-mixed"
            write_json(
                run_dir / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-mixed",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-accepted-123456789abc"}},
                },
            )
            write_json(run_dir / "experiment_card.json", policy_gradient_card())
            consumed_card = policy_gradient_card(card_supply_state="consumed")
            consumed_card["created_at"] = "2026-05-18T10:45:11Z"
            consumed_card["card_supply"]["created_at"] = consumed_card["created_at"]
            write_json(
                run_dir / "remote" / "runtime-artifacts" / "rl-training" / "report-consumed.json",
                {
                    "type": "screeps-rl-training-execution-report",
                    "reportId": "report-consumed-card",
                    "status": "shadow",
                    "safety": consumed_card["safety"],
                    "experimentCard": consumed_card,
                },
            )

            card_supply = dashboard.discover_tencent_internal_card_supply(
                root,
                warnings=[],
                repo_root=root,
            )

        self.assertIsNotNone(card_supply)
        assert card_supply is not None
        self.assertEqual(card_supply["runId"], "tencent-pg-mixed")
        self.assertEqual(card_supply["source"], "tencent_internal_experiment_card")
        self.assertEqual(card_supply["cardSupply"]["state"], "available")

    def test_single_run_legacy_card_beats_later_consumed_report_for_not_run(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-legacy-mixed"
            write_json(
                run_dir / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-legacy-mixed",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-accepted-123456789abc"}},
                },
            )
            write_json(run_dir / "experiment_card.json", policy_gradient_card(include_card_supply=False))
            consumed_card = policy_gradient_card(card_supply_state="consumed")
            consumed_card["created_at"] = "2026-05-18T10:45:11Z"
            consumed_card["card_supply"]["created_at"] = consumed_card["created_at"]
            write_json(
                run_dir / "remote" / "runtime-artifacts" / "rl-training" / "report-consumed.json",
                {
                    "type": "screeps-rl-training-execution-report",
                    "reportId": "report-consumed-card",
                    "status": "shadow",
                    "safety": consumed_card["safety"],
                    "experimentCard": consumed_card,
                },
            )

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

        self.assertEqual(card_supply["source"], "tencent_internal_experiment_card")
        self.assertEqual(card_supply["hasLoopACardSupplyMetadata"], False)
        self.assertNotIn("cardSupply", card_supply)
        self.assertEqual(training["status"], "NOT_RUN")
        self.assertEqual(training["cardSupply"]["status"], "PRIMARY_SATISFIED")
        self.assertEqual(training["cardSupply"]["severity"], "OK")
        self.assertIsNone(training["blocker"])

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

    def test_training_identity_matches_consumed_report_over_unrelated_available_run(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            available_run = root / "tencent-cloud" / "batch-runs" / "tencent-pg-available-a"
            consumed_run = root / "tencent-cloud" / "batch-runs" / "tencent-pg-consumed-b"
            write_json(
                available_run / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-available-a",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-available-aaaaaaaaaaaa"}},
                },
            )
            write_json(
                available_run / "experiment_card.json",
                policy_gradient_card(
                    card_id="rl-exp-rl-available-aaaaaaaaaaaa",
                    dataset_run_id="rl-available",
                ),
            )
            write_json(
                consumed_run / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-consumed-b",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-consumed-bbbbbbbbbbbb"}},
                },
            )
            consumed_card = policy_gradient_card(
                card_supply_state="consumed",
                card_id="rl-exp-rl-consumed-bbbbbbbbbbbb",
                dataset_run_id="rl-consumed",
                created_at="2026-05-18T10:45:11Z",
            )
            write_json(
                consumed_run / "remote" / "runtime-artifacts" / "rl-training" / "report-consumed.json",
                {
                    "type": "screeps-rl-training-execution-report",
                    "reportId": "report-consumed-card",
                    "status": "shadow",
                    "safety": consumed_card["safety"],
                    "experimentCard": consumed_card,
                },
            )

            candidates = dashboard.discover_tencent_internal_card_supply_candidates(
                root,
                warnings=[],
                repo_root=root,
            )
            training = dashboard.training_execution(
                loaded_artifact(
                    root / "rl-control-loop" / "training-ledger.json",
                    {
                        "type": "screeps-rl-training-execution-ledger",
                        "status": "RUN",
                        "trainingDidRun": True,
                        "artifactCount": 1,
                        "trainingArtifacts": {
                            "tencentInternalCardSupply": {
                                "runId": "tencent-pg-consumed-b",
                                "cardId": "rl-exp-rl-consumed-bbbbbbbbbbbb",
                                "datasetRunId": "rl-consumed",
                            },
                        },
                    },
                ),
                tencent_internal_card_supply_candidates=candidates,
            )

        self.assertEqual(training["cardSupply"]["status"], "PRIMARY_SATISFIED")
        self.assertEqual(training["cardSupply"]["runId"], "tencent-pg-consumed-b")
        self.assertEqual(training["cardSupply"]["source"], "tencent_internal_training_report")
        self.assertEqual(training["cardSupply"]["cardSupply"]["state"], "consumed")

    def test_training_identity_prefers_consumed_report_over_stale_available_same_run_card(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-same-card"
            write_json(
                run_dir / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-same-card",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-same-cccccccccccc"}},
                },
            )
            write_json(
                run_dir / "experiment_card.json",
                policy_gradient_card(
                    card_id="rl-exp-rl-same-cccccccccccc",
                    dataset_run_id="rl-same",
                    created_at="2026-05-18T10:35:11Z",
                ),
            )
            consumed_card = policy_gradient_card(
                card_supply_state="consumed",
                card_id="rl-exp-rl-same-cccccccccccc",
                dataset_run_id="rl-same",
                created_at="2026-05-18T10:45:11Z",
            )
            write_json(
                run_dir / "remote" / "runtime-artifacts" / "rl-training" / "report-consumed.json",
                {
                    "type": "screeps-rl-training-execution-report",
                    "reportId": "report-consumed-card",
                    "status": "shadow",
                    "safety": consumed_card["safety"],
                    "experimentCard": consumed_card,
                },
            )

            candidates = dashboard.discover_tencent_internal_card_supply_candidates(
                root,
                warnings=[],
                repo_root=root,
            )
            training = dashboard.training_execution(
                loaded_artifact(
                    root / "rl-control-loop" / "training-ledger.json",
                    {
                        "type": "screeps-rl-training-execution-ledger",
                        "status": "RUN",
                        "trainingDidRun": True,
                        "artifactCount": 1,
                        "trainingArtifacts": {
                            "tencentInternalCardSupply": {
                                "runId": "tencent-pg-same-card",
                                "cardId": "rl-exp-rl-same-cccccccccccc",
                                "datasetRunId": "rl-same",
                            },
                        },
                    },
                ),
                tencent_internal_card_supply_candidates=candidates,
            )

        self.assertEqual(training["cardSupply"]["status"], "PRIMARY_SATISFIED")
        self.assertEqual(training["cardSupply"]["source"], "tencent_internal_training_report")
        self.assertEqual(training["cardSupply"]["cardSupply"]["state"], "consumed")

    def test_not_run_candidate_list_prefers_available_over_consumed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            available_run = root / "tencent-cloud" / "batch-runs" / "tencent-pg-available-a"
            consumed_run = root / "tencent-cloud" / "batch-runs" / "tencent-pg-consumed-b"
            write_json(
                available_run / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-available-a",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-available-aaaaaaaaaaaa"}},
                },
            )
            write_json(
                available_run / "experiment_card.json",
                policy_gradient_card(
                    card_id="rl-exp-rl-available-aaaaaaaaaaaa",
                    dataset_run_id="rl-available",
                ),
            )
            write_json(
                consumed_run / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-consumed-b",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-consumed-bbbbbbbbbbbb"}},
                },
            )
            write_json(
                consumed_run / "experiment_card.json",
                policy_gradient_card(
                    card_supply_state="consumed",
                    card_id="rl-exp-rl-consumed-bbbbbbbbbbbb",
                    dataset_run_id="rl-consumed",
                    created_at="2026-05-18T10:45:11Z",
                ),
            )

            candidates = dashboard.discover_tencent_internal_card_supply_candidates(
                root,
                warnings=[],
                repo_root=root,
            )
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
                tencent_internal_card_supply_candidates=candidates,
            )

        self.assertEqual(training["cardSupply"]["status"], "PRIMARY_SATISFIED")
        self.assertEqual(training["cardSupply"]["runId"], "tencent-pg-available-a")
        self.assertEqual(training["cardSupply"]["cardSupply"]["state"], "available")
        self.assertIsNone(training["blocker"])

    def test_not_run_candidate_list_consumed_only_stays_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_dir = root / "tencent-cloud" / "batch-runs" / "tencent-pg-consumed-only"
            write_json(
                run_dir / "controller-summary.json",
                {
                    "type": "screeps-tencent-batch-rl-run",
                    "runId": "tencent-pg-consumed-only",
                    "outputs": {"experimentCard": {"cardId": "rl-exp-rl-consumed-bbbbbbbbbbbb"}},
                },
            )
            write_json(
                run_dir / "experiment_card.json",
                policy_gradient_card(
                    card_supply_state="consumed",
                    card_id="rl-exp-rl-consumed-bbbbbbbbbbbb",
                    dataset_run_id="rl-consumed",
                ),
            )

            candidates = dashboard.discover_tencent_internal_card_supply_candidates(
                root,
                warnings=[],
                repo_root=root,
            )
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
                tencent_internal_card_supply_candidates=candidates,
            )

        self.assertEqual(training["cardSupply"]["status"], "BLOCKED")
        self.assertEqual(training["cardSupply"]["severity"], "P0")
        self.assertEqual(training["blocker"], "NO_UNCONSUMED_EXPERIMENT_CARD")

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

    def test_preflight_only_loop_b_evidence_blocks_compute_claims(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-control-loop" / "training-ledger.json",
                {
                    "type": "screeps-rl-training-execution-ledger",
                    "status": "RUN",
                    "trainingDidRun": True,
                    "trainingReportIds": [],
                    "environmentExecution": {"completed": 0, "failed": 0},
                    "controllerSummary": {
                        "finalStatus": "preflight_ok",
                        "instanceId": None,
                        "environmentsRun": 0,
                    },
                    "createdAt": "2026-05-19T00:01:00Z",
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "policy-advantage.json",
                {
                    "type": "screeps-rl-policy-online-advantage-report",
                    "onlineUtilityStatus": "PROVEN",
                    "candidatePolicyId": "candidate",
                    "baselinePolicyId": "incumbent",
                    "metricsByCategory": {
                        "resources": {
                            "status": "ADVANTAGE",
                            "candidateValue": 10,
                            "baselineValue": 5,
                            "delta": 5,
                        },
                    },
                    "controllerSummary": {
                        "finalStatus": "preflight_ok",
                        "instanceId": None,
                        "environmentsRun": 0,
                    },
                    "createdAt": "2026-05-19T00:02:00Z",
                },
            )
            report = dashboard.build_dashboard(
                repo_root=root,
                artifact_root=artifact_root,
                generated_at="2026-05-19T00:03:00Z",
            )

        lanes = {item["lane"]: item for item in report["lanes"]}
        self.assertEqual(report["training"]["status"], "PREFLIGHT_ONLY")
        self.assertFalse(report["training"]["hasComputeEvidence"])
        self.assertEqual(report["training"]["computeEvidence"]["classification"], "PREFLIGHT_ONLY_VALIDATION")
        self.assertEqual(report["policy"]["rawStatus"], "PROVEN")
        self.assertEqual(report["policy"]["status"], "BLOCKED")
        self.assertEqual(report["policy"]["metrics"][0]["rawStatus"], "ADVANTAGE")
        self.assertEqual(report["policy"]["metrics"][0]["status"], "BLOCKED_NO_COMPUTE")
        self.assertEqual(report["policy"]["computeEvidence"]["classification"], "PREFLIGHT_ONLY_VALIDATION")
        self.assertEqual(lanes["E3"]["status"], "BLOCKED")
        self.assertEqual(lanes["E4"]["status"], "BLOCKED")
        self.assertEqual(lanes["E5"]["status"], "BLOCKED")

    def test_unrelated_training_compute_does_not_unblock_preflight_policy_claims(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-control-loop" / "training-ledger.json",
                {
                    "type": "screeps-rl-training-execution-ledger",
                    "status": "RUN",
                    "trainingDidRun": True,
                    "trainingReportIds": ["training-report-a"],
                    "environmentExecution": {"completed": 2, "failed": 0},
                    "controllerSummary": {
                        "finalStatus": "completed",
                        "instanceId": "ins-training-a",
                        "environmentsRun": 2,
                    },
                    "createdAt": "2026-05-19T00:01:00Z",
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "policy-advantage.json",
                {
                    "type": "screeps-rl-policy-online-advantage-report",
                    "onlineUtilityStatus": "PROVEN",
                    "candidatePolicyId": "candidate",
                    "baselinePolicyId": "incumbent",
                    "metricsByCategory": {
                        "resources": {
                            "status": "ADVANTAGE",
                            "candidateValue": 10,
                            "baselineValue": 5,
                            "delta": 5,
                        },
                    },
                    "controllerSummary": {
                        "finalStatus": "preflight_ok",
                        "instanceId": None,
                        "environmentsRun": 0,
                    },
                    "createdAt": "2026-05-19T00:02:00Z",
                },
            )
            report = dashboard.build_dashboard(
                repo_root=root,
                artifact_root=artifact_root,
                generated_at="2026-05-19T00:03:00Z",
            )

        lanes = {item["lane"]: item for item in report["lanes"]}
        self.assertEqual(report["training"]["status"], "RUN")
        self.assertTrue(report["training"]["hasComputeEvidence"])
        self.assertEqual(report["policy"]["rawStatus"], "PROVEN")
        self.assertEqual(report["policy"]["status"], "BLOCKED")
        self.assertFalse(report["policy"]["hasComputeEvidence"])
        self.assertEqual(report["policy"]["metrics"][0]["status"], "BLOCKED_NO_COMPUTE")
        self.assertEqual(report["policy"]["computeEvidence"]["classification"], "PREFLIGHT_ONLY_VALIDATION")
        self.assertEqual(lanes["E3"]["status"], "BLOCKED")
        self.assertEqual(lanes["E5"]["status"], "BLOCKED")

    def test_policy_local_compute_evidence_unblocks_policy_claims(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-control-loop" / "policy-advantage.json",
                {
                    "type": "screeps-rl-policy-online-advantage-report",
                    "onlineUtilityStatus": "PROVEN",
                    "candidatePolicyId": "candidate",
                    "baselinePolicyId": "incumbent",
                    "trainingReportIds": ["policy-local-report"],
                    "metricsByCategory": {
                        "resources": {
                            "status": "ADVANTAGE",
                            "candidateValue": 10,
                            "baselineValue": 5,
                            "delta": 5,
                        },
                    },
                    "createdAt": "2026-05-19T00:02:00Z",
                },
            )
            report = dashboard.build_dashboard(
                repo_root=root,
                artifact_root=artifact_root,
                generated_at="2026-05-19T00:03:00Z",
            )

        lanes = {item["lane"]: item for item in report["lanes"]}
        self.assertEqual(report["policy"]["status"], "PROVEN")
        self.assertTrue(report["policy"]["hasComputeEvidence"])
        self.assertEqual(report["policy"]["metrics"][0]["status"], "ADVANTAGE")
        self.assertEqual(report["policy"]["computeEvidence"]["classification"], "COMPUTE_CONFIRMED")
        self.assertEqual(lanes["E3"]["status"], "OK")
        self.assertEqual(lanes["E5"]["status"], "OK")

    def test_policy_training_identity_match_can_use_training_compute_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-artifacts"
            write_json(
                artifact_root / "rl-control-loop" / "training-ledger.json",
                {
                    "type": "screeps-rl-training-execution-ledger",
                    "runId": "shared-training-run",
                    "status": "RUN",
                    "trainingDidRun": True,
                    "environmentExecution": {"completed": 1, "failed": 0},
                    "controllerSummary": {
                        "finalStatus": "completed",
                        "instanceId": "ins-shared",
                        "environmentsRun": 1,
                    },
                    "createdAt": "2026-05-19T00:01:00Z",
                },
            )
            write_json(
                artifact_root / "rl-control-loop" / "policy-advantage.json",
                {
                    "type": "screeps-rl-policy-online-advantage-report",
                    "runId": "shared-training-run",
                    "onlineUtilityStatus": "PROVEN",
                    "candidatePolicyId": "candidate",
                    "baselinePolicyId": "incumbent",
                    "metricsByCategory": {
                        "resources": {
                            "status": "ADVANTAGE",
                            "candidateValue": 10,
                            "baselineValue": 5,
                            "delta": 5,
                        },
                    },
                    "controllerSummary": {
                        "finalStatus": "preflight_ok",
                        "instanceId": None,
                        "environmentsRun": 0,
                    },
                    "createdAt": "2026-05-19T00:02:00Z",
                },
            )
            report = dashboard.build_dashboard(
                repo_root=root,
                artifact_root=artifact_root,
                generated_at="2026-05-19T00:03:00Z",
            )

        lanes = {item["lane"]: item for item in report["lanes"]}
        signal_fields = {item["field"] for item in report["policy"]["computeEvidence"]["signals"]}
        self.assertEqual(report["policy"]["status"], "PROVEN")
        self.assertTrue(report["policy"]["hasComputeEvidence"])
        self.assertEqual(report["policy"]["metrics"][0]["status"], "ADVANTAGE")
        self.assertEqual(report["policy"]["computeEvidence"]["classification"], "COMPUTE_CONFIRMED")
        self.assertIn("training.computeEvidence", signal_fields)
        self.assertIn("policy.trainingIdentity.run", signal_fields)
        self.assertEqual(lanes["E3"]["status"], "OK")
        self.assertEqual(lanes["E5"]["status"], "OK")

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
