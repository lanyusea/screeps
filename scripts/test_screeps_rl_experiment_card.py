#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_experiment_card as card_helper
import screeps_rl_simulator_harness as harness
import screeps_rl_training_runner as runner


REPO_ROOT = Path(__file__).resolve().parent.parent


class RlExperimentCardTest(unittest.TestCase):
    def assert_map_source_uses_harness_default_sentinel(self, map_source_file: Path) -> None:
        self.assertEqual(map_source_file, harness.DEFAULT_MAP_SOURCE_FILE)
        self.assertTrue(map_source_file.is_absolute())

        # The default map path is a harness sentinel. It may be absent because
        # the harness then asks private-smoke to fetch its default map.
        smoke_map_source_file = harness._resolve_smoke_map_source_file(map_source_file)
        if map_source_file.is_file():
            self.assertEqual(smoke_map_source_file, map_source_file)
        else:
            self.assertIsNone(smoke_map_source_file)

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

    def test_policy_gradient_construction_priority_card_is_runner_valid(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-000001",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T00:25:00Z",
            simulation_ticks=100,
            simulation_repetitions=5,
        )

        card_helper.validate_card(card)
        runner.validate_experiment_card(card)
        variants = runner.load_strategy_variants(
            card,
            registry_path=REPO_ROOT / "prod" / "src" / "strategy" / "strategyRegistry.ts",
        )
        config = runner.simulation_config_from_card(card)
        policy_gradient = card["policy_gradient"]
        candidates = policy_gradient["candidate_parameter_vectors"]
        learnable_names = [item["name"] for item in policy_gradient["learnable_parameters"]]

        self.assertEqual(card["training_approach"], "policy_gradient")
        self.assertEqual(config.ticks, 100)
        self.assertEqual(config.repetitions, 5)
        self.assertFalse(card["liveEffect"])
        self.assertFalse(card["officialMmoWrites"])
        self.assertFalse(card["officialMmoWritesAllowed"])
        self.assertTrue(card["conservative_actions_only"])
        self.assertTrue(card["ood_rejection"])
        self.assertEqual(policy_gradient["target_family"], "construction-priority")
        runner_support = policy_gradient["runner_support"]
        self.assertEqual(
            learnable_names,
            [
                "baseScoreWeight",
                "territorySignalWeight",
                "resourceSignalWeight",
                "killSignalWeight",
                "riskPenalty",
            ],
        )
        self.assertFalse(runner_support["inline_candidates_applied_to_simulator"])
        self.assertEqual(runner_support["simulator_variant_transport"], "variant_ids_only")
        self.assertTrue(runner_support["report_preserves_candidate_parameters"])
        self.assertTrue(runner_support["candidate_policy_id_preserved"])
        self.assertEqual(
            [candidate["candidatePolicyId"] for candidate in candidates],
            [
                "construction-priority.pg.incumbent-seed.v1",
                "construction-priority.pg.territory-seed.v1",
                "construction-priority.pg.resource-seed.v1",
                "construction-priority.pg.risk-aware-seed.v1",
            ],
        )
        self.assertEqual([variant.candidate_policy_id for variant in variants], [candidate["candidatePolicyId"] for candidate in candidates])
        self.assertEqual(variants[0].parameters["baseScoreWeight"], 1)
        self.assertEqual(variants[1].parameters["territorySignalWeight"], 22)
        for candidate in candidates:
            self.assertEqual(set(candidate["parameters"]), set(learnable_names))
            self.assertFalse(candidate["parameterEvidence"]["liveEffect"])
            self.assertFalse(candidate["parameterEvidence"]["officialMmoWrites"])

    def test_policy_gradient_missing_registry_uses_fallback_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            card = card_helper.build_card(
                dataset_run_id="rl-policy-gradient-missing-registry",
                code_commit="f" * 40,
                training_approach="policy_gradient",
                created_at="2026-05-17T00:25:00Z",
                registry_path=Path(temp_dir) / "missing-registry.ts",
            )

        card_helper.validate_card(card)
        candidates = card["policy_gradient"]["candidate_parameter_vectors"]
        self.assertEqual(candidates[0]["parameters"]["territorySignalWeight"], 6)
        self.assertEqual(candidates[1]["parameters"]["territorySignalWeight"], 22)

    def test_policy_gradient_existing_registry_must_include_construction_priority_variants(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            registry_path = Path(temp_dir) / "strategyRegistry.ts"
            registry_path.write_text("export const STRATEGY_REGISTRY = [];\n", encoding="utf-8")

            with self.assertRaisesRegex(card_helper.CardValidationError, "missing construction-priority variants"):
                card_helper.build_card(
                    dataset_run_id="rl-policy-gradient-empty-registry",
                    code_commit="f" * 40,
                    training_approach="policy_gradient",
                    created_at="2026-05-17T00:25:00Z",
                    registry_path=registry_path,
                )

    def test_policy_gradient_existing_registry_must_include_valid_construction_priority_parameters(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            registry_path = Path(temp_dir) / "strategyRegistry.ts"
            registry_path.write_text("export const STRATEGY_REGISTRY = [];\n", encoding="utf-8")
            incumbent_id = "construction-priority.incumbent.v1"
            territory_id = "construction-priority.territory-shadow.v1"
            incumbent_parameters = dict(card_helper.CONSTRUCTION_PRIORITY_FALLBACK_DEFAULTS[incumbent_id])
            del incumbent_parameters["riskPenalty"]
            registry = {
                incumbent_id: runner.StrategyVariant(id=incumbent_id, parameters=incumbent_parameters),
                territory_id: runner.StrategyVariant(
                    id=territory_id,
                    parameters=dict(card_helper.CONSTRUCTION_PRIORITY_FALLBACK_DEFAULTS[territory_id]),
                ),
            }

            with mock.patch.object(runner, "load_strategy_registry", return_value=registry):
                with self.assertRaisesRegex(
                    card_helper.CardValidationError,
                    "variant construction-priority\\.incumbent\\.v1 must define finite construction-priority parameters",
                ):
                    card_helper.build_card(
                        dataset_run_id="rl-policy-gradient-invalid-registry-parameters",
                        code_commit="f" * 40,
                        training_approach="policy_gradient",
                        created_at="2026-05-17T00:25:00Z",
                        registry_path=registry_path,
                    )

    def test_policy_gradient_registry_loader_errors_surface(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            registry_path = Path(temp_dir) / "strategyRegistry.ts"
            registry_path.write_text("export const STRATEGY_REGISTRY = [];\n", encoding="utf-8")

            with mock.patch.object(runner, "load_strategy_registry", side_effect=RuntimeError("registry broke")):
                with self.assertRaisesRegex(RuntimeError, "registry broke"):
                    card_helper.build_card(
                        dataset_run_id="rl-policy-gradient-loader-error",
                        code_commit="f" * 40,
                        training_approach="policy_gradient",
                        created_at="2026-05-17T00:25:00Z",
                        registry_path=registry_path,
                    )

    def test_validate_policy_gradient_rejects_out_of_range_candidate_parameters(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-bounds",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T00:25:00Z",
        )
        candidate = card["policy_gradient"]["candidate_parameter_vectors"][0]
        candidate["parameters"]["territorySignalWeight"] = 31

        with self.assertRaisesRegex(
            card_helper.CardValidationError,
            "candidate_parameter_vectors\\[0\\].parameters.territorySignalWeight must be within registry knob bounds",
        ):
            card_helper.validate_card(card)

    def test_validate_policy_gradient_rejects_unsupported_runner_transport(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-runner-transport",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T00:25:00Z",
        )
        card["policy_gradient"]["runner_support"]["simulator_variant_transport"] = "inline_vectors"

        with self.assertRaisesRegex(
            card_helper.CardValidationError,
            "runner_support.simulator_variant_transport must be variant_ids_only",
        ):
            card_helper.validate_card(card)

    def test_validate_policy_gradient_rejects_unpreserved_candidate_policy_id(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-runner-candidate-id",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T00:25:00Z",
        )
        card["policy_gradient"]["runner_support"]["candidate_policy_id_preserved"] = False

        with self.assertRaisesRegex(
            card_helper.CardValidationError,
            "runner_support.candidate_policy_id_preserved must be true",
        ):
            card_helper.validate_card(card)

    def test_default_policy_gradient_card_requests_loop_a_run_floor(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-defaults",
            code_commit="1" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T00:25:00Z",
        )
        config = runner.simulation_config_from_card(card)

        self.assertGreaterEqual(config.ticks, 100)
        self.assertGreaterEqual(config.repetitions, 5)

    def test_policy_gradient_rejects_stale_strategy_variant_candidate_policy_id(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-stale-variant-id",
            code_commit="4" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T00:25:00Z",
        )
        card["strategy_variants"][0]["candidatePolicyId"] = "construction-priority.pg.stale-seed.v1"

        with self.assertRaisesRegex(
            card_helper.CardValidationError,
            "strategy_variants\\[0\\]\\.candidatePolicyId must match",
        ):
            card_helper.validate_card(card)

    def test_policy_gradient_rejects_strategy_variant_parameter_divergence(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-stale-variant-parameters",
            code_commit="5" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T00:25:00Z",
        )
        variant_parameters = dict(card["strategy_variants"][0]["parameters"])
        variant_parameters["territorySignalWeight"] = 7
        card["strategy_variants"][0]["parameters"] = variant_parameters

        with self.assertRaisesRegex(
            card_helper.CardValidationError,
            "strategy_variants\\[0\\]\\.parameters must match",
        ):
            card_helper.validate_card(card)

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
        self.assert_map_source_uses_harness_default_sentinel(config.map_source_file)
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

    def test_validate_rejects_top_level_true_safety_regression(self) -> None:
        for field in ("conservative_actions_only", "ood_rejection"):
            with self.subTest(field=field):
                card = card_helper.build_card(
                    dataset_run_id=f"rl-safety-{field}",
                    code_commit="2" * 40,
                    training_approach="policy_gradient",
                    created_at="2026-05-17T00:25:00Z",
                )
                card[field] = False

                with self.assertRaisesRegex(card_helper.CardValidationError, f"{field} must be true"):
                    card_helper.validate_card(card)

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

    def test_cli_generation_accepts_policy_gradient_ticks_and_repetitions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "card.json"
            exit_code = card_helper.main(
                [
                    "--dataset-run-id",
                    "rl-policy-gradient-cli",
                    "--code-commit",
                    "3" * 40,
                    "--training-approach",
                    "policy_gradient",
                    "--created-at",
                    "2026-05-17T00:25:00Z",
                    "--ticks",
                    "125",
                    "--repetitions",
                    "6",
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
        config = runner.simulation_config_from_card(generated)
        self.assertEqual(config.ticks, 125)
        self.assertEqual(config.repetitions, 6)
        self.assertEqual(generated["training_approach"], "policy_gradient")
        self.assertEqual(generated["policy_gradient"]["target_family"], "construction-priority")


if __name__ == "__main__":
    unittest.main()
