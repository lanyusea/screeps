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


def policy_gradient_card(*, safe: bool = True, include_card_supply: bool = True) -> JsonObject:
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
        card["card_supply"] = {
            "type": "screeps-rl-loop-a-card-supply",
            "consumer": "loop-a-policy-gradient",
            "state": "available",
            "available_for_training": True,
            "dataset_run_id": card["dataset_run_id"],
            "training_approach": card["training_approach"],
            "created_at": card["created_at"],
            "status_field": "status",
            "safety_status": "shadow",
            "consumed_at": None,
            "consumed_by_report_id": None,
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
