#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_experiment_card as card_helper
import screeps_rl_simulator_harness as harness
import screeps_rl_training_runner as runner


REPO_ROOT = Path(__file__).resolve().parent.parent


class RlExperimentCardTest(unittest.TestCase):
    def test_generated_card_is_training_runner_valid(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-3d29e8b9397d",
            code_commit="a" * 40,
            training_approach="bandit",
            created_at="2026-05-16T10:09:35Z",
        )

        card_helper.validate_card(card)
        runner.validate_experiment_card(card)
        variants = runner.load_strategy_variants(
            card,
            registry_path=REPO_ROOT / "prod" / "src" / "strategy" / "strategyRegistry.ts",
        )
        config = runner.simulation_config_from_card(card)

        self.assertEqual(card["status"], "shadow")
        self.assertFalse(card["liveEffect"])
        self.assertFalse(card["officialMmoWrites"])
        self.assertFalse(card["officialMmoWritesAllowed"])
        self.assertTrue(card["conservative_actions_only"])
        self.assertTrue(card["ood_rejection"])
        self.assertEqual(card["reward_model"]["component_order"], ["reliability", "territory", "resources", "kills"])
        self.assertFalse(card["reward_model"]["scalar_weighted_sum_authorized"])
        self.assertEqual(
            [variant.id for variant in variants],
            [
                "construction-priority.incumbent.v1",
                "construction-priority.territory-shadow.v1",
                "expansion-remote.incumbent.v1",
                "expansion-remote.territory-shadow.v1",
            ],
        )
        self.assertEqual(config.ticks, 50)
        self.assertEqual(config.workers, 1)
        self.assertEqual(config.repetitions, 1)
        self.assertEqual(config.branch, "$activeWorld")

    def test_generated_simulation_paths_are_harness_defaults_from_arbitrary_cwd(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-cwd-safe-000000",
            code_commit="e" * 40,
            training_approach="bandit",
            created_at="2026-05-16T10:09:35Z",
        )

        original_cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as temp_dir:
            try:
                os.chdir(temp_dir)
                config = runner.simulation_config_from_card(card)
            finally:
                os.chdir(original_cwd)

        self.assertEqual(config.branch, harness.DEFAULT_ACTIVE_WORLD_BRANCH)
        self.assertEqual(config.map_source_file, harness.DEFAULT_MAP_SOURCE_FILE)
        self.assertTrue(config.map_source_file.is_absolute())
        self.assertEqual(config.code_path, harness.DEFAULT_CODE_PATH)
        self.assertTrue(config.code_path.is_absolute())
        self.assertTrue(config.code_path.is_file())
        self.assertEqual(config.simulator_out_dir, REPO_ROOT / "runtime-artifacts" / "rl-simulator")
        self.assertTrue(config.simulator_out_dir.is_absolute())

    def test_validate_rejects_header_only_card(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-3d29e8b9397d",
            code_commit="b" * 40,
            training_approach="bandit",
            created_at="2026-05-16T10:09:35Z",
        )
        del card["strategy_variants"]

        with self.assertRaisesRegex(card_helper.CardValidationError, "strategy_variants must contain"):
            card_helper.validate_card(card)

    def test_validate_accepts_training_runner_aliases_and_integer_floats(self) -> None:
        for variant_field in ("strategyVariants", "variants"):
            with self.subTest(variant_field=variant_field):
                card = card_helper.build_card(
                    dataset_run_id=f"rl-alias-{variant_field}",
                    code_commit="d" * 40,
                    training_approach="bandit",
                    created_at="2026-05-16T10:09:35Z",
                )
                variants = card.pop("strategy_variants")
                simulation = card.pop("simulation")
                card[variant_field] = variants
                card["simulator"] = {
                    "ticks": 50.0,
                    "workers": 1.0,
                    "repetitions": 1.0,
                    "hostPortStart": 24125.0,
                    "room": simulation["room"],
                    "shard": simulation["shard"],
                    "branch": simulation["branch"],
                    "codePath": simulation["code_path"],
                    "mapSourceFile": simulation["map_source_file"],
                    "simulatorOutDir": simulation["simulator_out_dir"],
                }

                card_helper.validate_card(card)
                runner.validate_experiment_card(card)
                config = runner.simulation_config_from_card(card)

                self.assertEqual(config.ticks, 50)
                self.assertEqual(config.workers, 1)
                self.assertEqual(config.repetitions, 1)
                self.assertEqual(config.host_port_start, 24125)

    def test_cli_generation_outputs_training_runner_valid_card(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "card.json"
            exit_code = card_helper.main(
                [
                    "--dataset-run-id",
                    "rl-3d29e8b9397d",
                    "--code-commit",
                    "c" * 40,
                    "--created-at",
                    "2026-05-16T10:09:35Z",
                    "--output",
                    str(output_path),
                ],
                stdout=io.StringIO(),
                stderr=io.StringIO(),
                repo_root=REPO_ROOT,
            )
            generated = json.loads(output_path.read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 0)
        runner.validate_experiment_card(generated)


if __name__ == "__main__":
    unittest.main()
