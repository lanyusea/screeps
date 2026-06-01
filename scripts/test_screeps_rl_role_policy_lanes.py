#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_role_policy_lanes as lanes


FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "rl" / "role-policy-scorecards"


class ScreepsRlRolePolicyLanesTest(unittest.TestCase):
    def test_contract_defines_safe_baseline_and_candidate_per_initial_lane(self) -> None:
        contract = lanes.role_policy_contract()

        lanes.validate_lane_contract(contract)
        by_family = {lane["policyFamily"]: lane for lane in contract["initialLanes"]}
        self.assertEqual(
            set(by_family),
            {"role.worker-task", "role.source-harvester", "role.defender-micro"},
        )
        for lane in by_family.values():
            for endpoint in ("baseline", "candidate"):
                payload = lane[endpoint]
                self.assertEqual(payload["policyFamily"], lane["policyFamily"])
                self.assertEqual(payload["rolePolicy"], lane["rolePolicy"])
                self.assertEqual(payload["trainingRole"], lane["trainingRole"])
                self.assertFalse(payload["liveEffect"])
                self.assertFalse(payload["officialMmoWrites"])
                self.assertFalse(payload["officialMmoWritesAllowed"])

    def test_role_policy_scorecard_fixtures_cover_each_lane_and_are_shadow_only(self) -> None:
        fixtures = sorted(FIXTURE_ROOT.glob("role.*.scorecard.json"))
        self.assertEqual(len(fixtures), 3)

        observed: set[str] = set()
        for path in fixtures:
            with self.subTest(path=path.name):
                payload = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(payload["type"], "screeps-rl-evaluation-scorecard")
                self.assertTrue(payload["fixtureOnly"])
                self.assertTrue(payload["noLiveComputeRun"])
                self.assertFalse(payload["liveEffect"])
                self.assertFalse(payload["officialMmoWrites"])
                self.assertFalse(payload["officialMmoWritesAllowed"])

                metadata = payload["rolePolicyMetadata"]
                candidate = metadata["candidate"]
                baseline = metadata["baseline"]
                lanes.validate_role_policy_collection(
                    [candidate, baseline],
                    context=f"{path.name}.rolePolicyMetadata",
                )
                self.assertEqual(candidate, baseline)
                self.assertEqual(metadata["rolePolicyFamilies"], [candidate["policyFamily"]])
                observed.add(candidate["policyFamily"])

        self.assertEqual(
            observed,
            {"role.worker-task", "role.source-harvester", "role.defender-micro"},
        )

    def test_mixed_role_policy_families_require_explicit_meta_policy_reason(self) -> None:
        worker = {
            "policyFamily": "role.worker-task",
            "rolePolicy": "worker-task",
            "trainingRole": "worker",
        }
        defender = {
            "policyFamily": "role.defender-micro",
            "rolePolicy": "defender-micro",
            "trainingRole": "defender",
        }

        with self.assertRaisesRegex(lanes.RolePolicyLaneError, "multiple role policy families"):
            lanes.validate_role_policy_collection([worker, defender], context="test")

        families = lanes.validate_role_policy_collection(
            [worker, defender],
            context="test",
            parent={"metaPolicyReason": "explicit meta-policy comparison fixture"},
        )
        self.assertEqual(families, ["role.defender-micro", "role.worker-task"])

    def test_role_scoped_metadata_requires_policy_family_role_policy_and_training_role(self) -> None:
        with self.assertRaisesRegex(lanes.RolePolicyLaneError, "omits policyFamily"):
            lanes.validate_role_policy_metadata(
                {"rolePolicy": "worker-task", "trainingRole": "worker"},
                "candidate",
            )

        with self.assertRaisesRegex(lanes.RolePolicyLaneError, "requires rolePolicy"):
            lanes.validate_role_policy_metadata(
                {"policyFamily": "role.worker-task", "trainingRole": "worker"},
                "candidate",
            )

        with self.assertRaisesRegex(lanes.RolePolicyLaneError, "requires trainingRole"):
            lanes.validate_role_policy_metadata(
                {"policyFamily": "role.worker-task", "rolePolicy": "worker-task"},
                "candidate",
            )


if __name__ == "__main__":
    unittest.main()
