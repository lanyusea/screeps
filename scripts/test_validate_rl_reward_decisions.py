#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

import validate_rl_reward_decisions as validator


JsonObject = dict[str, Any]


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "docs/ops/templates/rl-reward-decision.template.json"
EXAMPLES = ROOT / "docs/ops/examples/rl-reward-decisions"


def write_json(path: Path, payload: JsonObject) -> None:
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


class RlRewardDecisionValidatorTest(unittest.TestCase):
    def test_template_and_seed_examples_pass(self) -> None:
        errors = validator.validate_paths([TEMPLATE, EXAMPLES])

        self.assertEqual([], errors)

    def test_missing_required_field_fails(self) -> None:
        payload = json.loads(TEMPLATE.read_text(encoding="utf-8"))
        del payload["title"]

        with tempfile.TemporaryDirectory() as temp_dir:
            decision_path = Path(temp_dir) / "missing-title.json"
            write_json(decision_path, payload)

            errors = validator.validate_file(decision_path)

        self.assertEqual(1, len(errors))
        self.assertIn("missing required fields: title", errors[0].message)

    def test_unknown_state_fails(self) -> None:
        payload = json.loads(TEMPLATE.read_text(encoding="utf-8"))
        payload["state"] = "live_rollout"

        with tempfile.TemporaryDirectory() as temp_dir:
            decision_path = Path(temp_dir) / "bad-state.json"
            write_json(decision_path, payload)

            errors = validator.validate_file(decision_path)

        self.assertEqual(1, len(errors))
        self.assertIn("state must be one of", errors[0].message)

    def test_unsafe_true_flag_fails(self) -> None:
        payload = json.loads(TEMPLATE.read_text(encoding="utf-8"))
        payload["safety"] = {"officialMmoWrites": True}

        with tempfile.TemporaryDirectory() as temp_dir:
            decision_path = Path(temp_dir) / "unsafe.json"
            write_json(decision_path, payload)

            errors = validator.validate_file(decision_path)

        self.assertEqual(1, len(errors))
        self.assertIn("unsafe true flag at safety.officialMmoWrites", errors[0].message)


if __name__ == "__main__":
    unittest.main()
