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
        self.assertEqual(card["scenario"]["scenario_id"], card_helper.DEFAULT_SCENARIO_ID)
        self.assertFalse(card["scenario"]["capabilities"]["adjacent_room_territory_signal"])
        self.assertFalse(card["scenario"]["capabilities"]["hostile_combat_signal"])
        self.assertEqual(
            card["scenario"]["suitability"]["classification"],
            "not_suitable_for_territory_combat_differentiation",
        )

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
        self.assertEqual(config.ticks, 500)
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
        self.assertFalse(card_helper.scenario_supports_multi_tier_policy_comparison(card["scenario"]))

    def test_multi_tier_policy_gradient_card_records_scenario_capabilities(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-multitier",
            code_commit="c" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:15:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_ID,
            require_multi_tier_scenario=True,
        )

        card_helper.validate_card(card)
        runner.validate_experiment_card(card)
        scenario = card["scenario"]

        self.assertEqual(scenario["scenario_id"], card_helper.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(scenario["capabilities"]["multi_room_capable"])
        self.assertTrue(scenario["capabilities"]["adjacent_room_territory_signal"])
        self.assertTrue(scenario["capabilities"]["hostile_combat_signal"])
        self.assertTrue(scenario["suitability"]["multi_tier_policy_comparison"])
        self.assertTrue(card_helper.scenario_supports_multi_tier_policy_comparison(scenario))
        self.assertEqual(scenario["evidence"]["implementation_status"], "active_fixture_validated")
        self.assertEqual(scenario["evidence"]["anchor_room"], "E1S1")
        self.assertEqual(scenario["evidence"]["adjacent_room"], "E2S1")
        self.assertEqual(scenario["evidence"]["room_count"], 2)
        self.assertEqual(scenario["evidence"]["hostile_creep_count"], 2)
        self.assertEqual(scenario["evidence"]["hostile_spawn_count"], 1)
        self.assertEqual(Path(card["simulation"]["map_source_file"]), card_helper.MULTI_TIER_SIMULATION_MAP_SOURCE_FILE)
        for field in ("liveEffect", "officialMmoWrites", "officialMmoWritesAllowed"):
            self.assertFalse(card[field])
            self.assertFalse(card["safety"][field])
            self.assertFalse(scenario["safety"][field])

    def test_multi_tier_scenario_rejects_metadata_only_guarded_evidence(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-multitier-stale",
            code_commit="c" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:15:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_ID,
        )
        card["scenario"]["evidence"]["implementation_status"] = "metadata_only_guarded"

        self.assertFalse(card_helper.scenario_supports_multi_tier_policy_comparison(card["scenario"]))
        with self.assertRaisesRegex(card_helper.CardValidationError, "metadata-only guarded"):
            card_helper.validate_card(card)
        with self.assertRaisesRegex(runner.TrainingCardError, "metadata-only guarded"):
            runner.validate_experiment_card(card)

    def test_multi_tier_scenario_rejects_zero_hostile_fixture(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-multitier-zero-hostile",
            code_commit="c" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:15:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_ID,
        )
        fixture = card_helper.load_json(card_helper.MULTI_TIER_SIMULATION_MAP_SOURCE_FILE)
        hostile_room = next(room for room in fixture["rooms"] if room.get("room") == "E2S1")
        hostile_room["objects"] = [
            item
            for item in hostile_room["objects"]
            if item.get("user") != "2"
        ]

        with tempfile.TemporaryDirectory(prefix="rl-fixture-", dir=REPO_ROOT) as temp_dir:
            fixture_path = Path(temp_dir) / "zero-hostile-map.json"
            fixture_path.write_text(json.dumps(fixture), encoding="utf-8")
            card["simulation"]["map_source_file"] = str(fixture_path)
            card["scenario"]["evidence"]["map_source_file"] = str(fixture_path)

            with self.assertRaisesRegex(card_helper.CardValidationError, "hostile creep fixtures"):
                card_helper.validate_card(card)

    def test_multi_tier_fixture_summary_rejects_wrong_fixture_identity(self) -> None:
        fixture = card_helper.load_json(card_helper.MULTI_TIER_SIMULATION_MAP_SOURCE_FILE)
        cases = (
            ("type", "screeps-rl-private-map-fixture-copy", "type is invalid"),
            ("scenario_id", card_helper.DEFAULT_SCENARIO_ID, "scenario_id is invalid"),
            ("schema_version", 2, "schema_version is invalid"),
        )

        with tempfile.TemporaryDirectory(prefix="rl-fixture-", dir=REPO_ROOT) as temp_dir:
            temp_root = Path(temp_dir)
            for field, value, message in cases:
                mutated = dict(fixture)
                mutated[field] = value
                fixture_path = temp_root / f"wrong-{field}.json"
                fixture_path.write_text(json.dumps(mutated), encoding="utf-8")

                with self.subTest(field=field):
                    with self.assertRaisesRegex(card_helper.CardValidationError, message):
                        card_helper.multi_tier_scenario_fixture_summary(fixture_path)

    def test_multi_tier_scenario_rejects_map_source_outside_repo(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-multitier-outside-path",
            code_commit="c" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:15:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_ID,
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            fixture_path = Path(temp_dir) / "multi-tier-map.json"
            fixture_path.write_text(
                card_helper.MULTI_TIER_SIMULATION_MAP_SOURCE_FILE.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            card["simulation"]["map_source_file"] = str(fixture_path)
            card["scenario"]["evidence"]["map_source_file"] = str(fixture_path)

            with self.assertRaisesRegex(card_helper.CardValidationError, "under repository root"):
                card_helper.validate_card(card)

    def test_multi_tier_requirement_rejects_single_room_no_hostile_scenario(self) -> None:
        with self.assertRaisesRegex(card_helper.CardValidationError, "multi-tier policy comparisons require"):
            card_helper.build_card(
                dataset_run_id="rl-policy-gradient-bad-scenario",
                code_commit="d" * 40,
                training_approach="policy_gradient",
                created_at="2026-05-18T10:16:00Z",
                require_multi_tier_scenario=True,
            )

    def test_cli_can_request_multi_tier_policy_gradient_scenario(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = card_helper.main(
            [
                "--dry-run",
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                card_helper.MULTI_TIER_SCENARIO_ID,
                "--require-multi-tier-scenario",
                "--code-commit",
                "9" * 40,
                "--created-at",
                "2026-05-18T10:18:00Z",
            ],
            stdout=stdout,
            stderr=stderr,
            repo_root=REPO_ROOT,
        )
        generated = json.loads(stdout.getvalue())

        self.assertEqual(exit_code, 0)
        self.assertEqual(generated["scenario"]["scenario_id"], card_helper.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(generated["scenario"]["suitability"]["multi_tier_policy_comparison"])
        self.assertEqual(stderr.getvalue(), "")

    def test_scenario_validation_rejects_inconsistent_multi_tier_claim(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-inconsistent",
            code_commit="e" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:17:00Z",
        )
        card["scenario"]["suitability"]["multi_tier_policy_comparison"] = True

        with self.assertRaisesRegex(card_helper.CardValidationError, "marked multi-tier suitable"):
            card_helper.validate_card(card)

    def test_loop_a_policy_gradient_supply_card_remains_shadow_and_available(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-loop-a-supply-000001",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T01:25:00Z",
            loop_a_card_supply=True,
        )

        card_helper.validate_card(card)
        runner.validate_experiment_card(card)
        config = runner.simulation_config_from_card(card)

        supply = card["card_supply"]
        self.assertEqual(card["status"], "shadow")
        self.assertEqual(card["training_approach"], "policy_gradient")
        self.assertEqual(config.ticks, 500)
        self.assertEqual(config.workers, 5)
        self.assertEqual(config.repetitions, 5)
        self.assertEqual(supply["state"], "available")
        self.assertTrue(supply["available_for_training"])
        self.assertEqual(supply["consumer"], "loop-a-policy-gradient")
        self.assertEqual(supply["safety_status"], "shadow")
        self.assertTrue(card_helper.is_loop_a_card_available_for_training(card))
        self.assertFalse(card["liveEffect"])
        self.assertFalse(card["officialMmoWrites"])
        self.assertFalse(card["officialMmoWritesAllowed"])
        self.assertTrue(card["conservative_actions_only"])
        self.assertTrue(card["ood_rejection"])
        self.assertEqual(card["reward_model"]["component_order"], ["reliability", "territory", "resources", "kills"])
        self.assertFalse(card["reward_model"]["scalar_weighted_sum_authorized"])

    def test_loop_a_supply_rejects_bandit_card(self) -> None:
        with self.assertRaisesRegex(card_helper.CardValidationError, "requires training_approach=policy_gradient"):
            card_helper.build_card(
                dataset_run_id="rl-loop-a-bandit",
                code_commit="f" * 40,
                training_approach="bandit",
                created_at="2026-05-17T01:25:00Z",
                loop_a_card_supply=True,
            )

    def test_cli_generates_loop_a_supply_from_latest_accepted_dataset(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            gate_root = root / "gates"
            card_dir = root / "cards"
            older_gate = gate_root / "older" / "gate_report.json"
            newer_gate = gate_root / "gate-20260517T181846Z-postmerge1176" / "gate_report.json"
            failed_gate = gate_root / "failed" / "gate_report.json"
            older_gate.parent.mkdir(parents=True)
            newer_gate.parent.mkdir(parents=True)
            failed_gate.parent.mkdir(parents=True)
            older_gate.write_text(
                json.dumps(
                    {
                        "type": card_helper.SOURCE_GATE_TYPE,
                        "ok": True,
                        "gateId": "older",
                        "createdAt": "2026-05-17T01:00:00Z",
                        "dataset": {"runId": "rl-accepted-older"},
                    }
                ),
                encoding="utf-8",
            )
            newer_gate.write_text(
                json.dumps(
                    {
                        "type": card_helper.SOURCE_GATE_TYPE,
                        "ok": False,
                        "gateId": "gate-20260517T181846Z-postmerge1176",
                        "createdAt": "2026-05-17T02:00:00Z",
                        "dataset": {"ok": True, "runId": "rl-accepted-newer", "sampleCount": 200},
                        "datasetGate": {"status": "pass"},
                        "shadowEvaluation": {"status": "pass", "ok": True},
                        "blockingReasons": [
                            {
                                "gate": "quality_checks",
                                "name": "sample_quality",
                                "status": "fail",
                                "samplesAccepted": 191,
                                "samplesRejected": 9,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            failed_gate.write_text(
                json.dumps(
                    {
                        "type": card_helper.SOURCE_GATE_TYPE,
                        "ok": False,
                        "gateId": "failed",
                        "createdAt": "2026-05-17T03:00:00Z",
                        "dataset": {"runId": "rl-rejected-newest"},
                    }
                ),
                encoding="utf-8",
            )
            stdout = io.StringIO()

            exit_code = card_helper.main(
                [
                    "--loop-a-policy-gradient-supply",
                    "--from-latest-accepted-dataset",
                    "--dataset-gate-root",
                    str(gate_root),
                    "--code-commit",
                    "6" * 40,
                    "--created-at",
                    "2026-05-17T02:05:00Z",
                    "--output-dir",
                    str(card_dir),
                ],
                stdout=stdout,
                stderr=io.StringIO(),
                repo_root=REPO_ROOT,
            )
            summary = json.loads(stdout.getvalue())
            generated = json.loads(Path(summary["path"]).read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 0)
        self.assertEqual(summary["dataset_run_id"], "rl-accepted-newer")
        self.assertEqual(summary["source_gate"]["gate_id"], "gate-20260517T181846Z-postmerge1176")
        self.assertFalse(summary["source_gate"]["gate_report_ok"])
        self.assertGreaterEqual(summary["source_gate"]["quality_acceptance_rate"], 0.95)
        self.assertEqual(summary["card_supply"]["state"], "available")
        self.assertEqual(generated["dataset_run_id"], "rl-accepted-newer")
        self.assertEqual(generated["training_approach"], "policy_gradient")
        self.assertEqual(generated["status"], "shadow")
        self.assertEqual(generated["simulation"]["ticks"], 500)
        self.assertEqual(generated["simulation"]["workers"], 5)
        self.assertEqual(generated["simulation"]["repetitions"], 5)
        self.assertTrue(card_helper.is_loop_a_card_available_for_training(generated))

    def test_cli_writes_loop_a_local_fallback_standalone_card_from_requested_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            gate_root = root / "gates"
            gate_id = "gate-20260518T025000Z-postmerge1188"
            dataset_run_id = "rl-ebf33fae619f"
            gate_path = gate_root / gate_id / "gate_report.json"
            output_path = root / "runtime-artifacts" / "rl-experiment-cards" / "experiment_card.json"
            gate_path.parent.mkdir(parents=True)
            gate_path.write_text(
                json.dumps(
                    {
                        "type": "screeps-rl-dataset-evaluation-gate",
                        "ok": True,
                        "gateId": gate_id,
                        "createdAt": "2026-05-18T02:50:00Z",
                        "dataset": {
                            "runId": dataset_run_id,
                            "sampleCount": 200,
                        },
                    }
                ),
                encoding="utf-8",
            )
            stdout = io.StringIO()

            exit_code = card_helper.main(
                [
                    "--loop-a-local-fallback",
                    "--source-gate-id",
                    gate_id,
                    "--dataset-gate-root",
                    str(gate_root),
                    "--code-commit",
                    "7" * 40,
                    "--created-at",
                    "2026-05-18T03:12:00Z",
                    "--ticks",
                    "1",
                    "--repetitions",
                    "1",
                    "--workers",
                    "1",
                    "--output",
                    str(output_path),
                ],
                stdout=stdout,
                stderr=io.StringIO(),
                repo_root=REPO_ROOT,
            )
            summary = json.loads(stdout.getvalue())
            generated = json.loads(output_path.read_text(encoding="utf-8"))
            selected_stdout = io.StringIO()
            selected_exit_code = card_helper.main(
                [
                    "--select-loop-a-card",
                    "--card-dir",
                    str(output_path.parent),
                    "--training-report-dir",
                    str(root / "runtime-artifacts" / "rl-training"),
                ],
                stdout=selected_stdout,
                stderr=io.StringIO(),
                repo_root=REPO_ROOT,
            )
            selected = json.loads(selected_stdout.getvalue())

        self.assertEqual(exit_code, 0)
        self.assertEqual(output_path.name, "experiment_card.json")
        self.assertEqual(summary["path"], str(output_path))
        self.assertTrue(summary["loop_a_local_fallback"])
        self.assertEqual(summary["source_gate"]["gate_id"], gate_id)
        self.assertEqual(summary["source_gate"]["dataset_run_id"], dataset_run_id)
        self.assertEqual(generated["dataset_run_id"], dataset_run_id)
        self.assertEqual(generated["source_gate"]["gate_id"], gate_id)
        self.assertEqual(generated["source_gate"]["dataset_run_id"], dataset_run_id)
        self.assertEqual(generated["training_approach"], "policy_gradient")
        self.assertEqual(generated["policy_gradient"]["target_family"], "construction-priority")

        config = runner.simulation_config_from_card(generated)
        self.assertEqual(config.workers, 5)
        self.assertEqual(config.repetitions, 5)
        self.assertEqual(config.ticks, 500)

        supply = generated["card_supply"]
        self.assertEqual(generated["status"], "shadow")
        self.assertEqual(supply["state"], "available")
        self.assertTrue(supply["available_for_training"])
        self.assertIsNone(supply["consumed_at"])
        self.assertIsNone(supply["consumed_by_report_id"])
        self.assertTrue(card_helper.is_loop_a_card_available_for_training(generated))
        self.assertEqual(selected_exit_code, 0)
        self.assertEqual(selected["card_path"], str(output_path))
        self.assertEqual(selected["card_supply"]["state"], "available")
        for field in ("liveEffect", "officialMmoWrites", "officialMmoWritesAllowed"):
            self.assertFalse(generated[field])
            self.assertFalse(generated["safety"][field])

            live_regression = json.loads(json.dumps(generated))
            live_regression[field] = True
            with self.assertRaises(card_helper.CardValidationError):
                card_helper.validate_card(live_regression)

            nested_live_regression = json.loads(json.dumps(generated))
            nested_live_regression["safety"][field] = True
            with self.assertRaises(card_helper.CardValidationError):
                card_helper.validate_card(nested_live_regression)

    def test_source_gate_block_uses_stable_provenance_path(self) -> None:
        gate_id = "rl-gate-93bf1aa18b62"
        dataset_run_id = "rl-ebf33fae619f"
        default_gate_path = card_helper.DEFAULT_DATASET_GATE_ROOT / gate_id / "gate_report.json"

        default_block = card_helper.source_gate_block(
            gate_id=gate_id,
            dataset_run_id=dataset_run_id,
            gate_report_path=default_gate_path,
            created_at=None,
        )

        self.assertEqual(
            default_block["gate_report_path"],
            f"runtime-artifacts/rl-dataset-gates/{gate_id}/gate_report.json",
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            old_cwd = Path.cwd()
            try:
                os.chdir(root)
                relative_gate_path = Path("gates") / gate_id / "gate_report.json"
                absolute_gate_path = root / relative_gate_path
                relative_block = card_helper.source_gate_block(
                    gate_id=gate_id,
                    dataset_run_id=dataset_run_id,
                    gate_report_path=relative_gate_path,
                    created_at=None,
                )
                absolute_block = card_helper.source_gate_block(
                    gate_id=gate_id,
                    dataset_run_id=dataset_run_id,
                    gate_report_path=absolute_gate_path,
                    created_at=None,
                )
            finally:
                os.chdir(old_cwd)

        self.assertEqual(relative_block["gate_report_path"], f"gates/{gate_id}/gate_report.json")
        self.assertEqual(absolute_block["gate_report_path"], relative_block["gate_report_path"])

    def test_validate_source_gate_requires_type(self) -> None:
        gate_id = "rl-gate-93bf1aa18b62"
        dataset_run_id = "rl-ebf33fae619f"
        source_gate = card_helper.source_gate_block(
            gate_id=gate_id,
            dataset_run_id=dataset_run_id,
            gate_report_path=Path("gates") / gate_id / "gate_report.json",
            created_at=None,
        )
        card = card_helper.build_card(
            dataset_run_id=dataset_run_id,
            code_commit="8" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T03:15:00Z",
            source_gate=source_gate,
        )
        del card["source_gate"]["type"]

        with self.assertRaisesRegex(card_helper.CardValidationError, "source_gate.type"):
            card_helper.validate_card(card)

    def test_latest_accepted_dataset_skips_malformed_accepted_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            gate_root = root / "gates"
            valid_gate_id = "gate-20260517T010000Z-postmerge1188"
            malformed_gate_id = "gate-20260517T020000Z-postmerge1188"
            valid_gate = gate_root / valid_gate_id / "gate_report.json"
            malformed_gate = gate_root / malformed_gate_id / "gate_report.json"
            valid_gate.parent.mkdir(parents=True)
            malformed_gate.parent.mkdir(parents=True)
            valid_gate.write_text(
                json.dumps(
                    {
                        "type": card_helper.SOURCE_GATE_TYPE,
                        "ok": True,
                        "gateId": valid_gate_id,
                        "createdAt": "2026-05-17T01:00:00Z",
                        "dataset": {"runId": "rl-accepted-valid"},
                    }
                ),
                encoding="utf-8",
            )
            malformed_gate.write_text(
                json.dumps(
                    {
                        "type": card_helper.SOURCE_GATE_TYPE,
                        "ok": True,
                        "gateId": malformed_gate_id,
                        "createdAt": "2026-05-17T02:00:00Z",
                        "dataset": {"runId": "invalid run id"},
                    }
                ),
                encoding="utf-8",
            )

            selected = card_helper.latest_accepted_dataset_run_id(gate_root)

        self.assertEqual(selected, "rl-accepted-valid")

    def test_latest_accepted_dataset_ignores_nested_non_gate_json(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            gate_root = root / "gates"
            valid_gate_id = "gate-20260517T010000Z-postmerge1188"
            nested_gate_id = "gate-20260517T030000Z-postmerge1188"
            valid_gate = gate_root / valid_gate_id / "gate_report.json"
            nested_artifact = gate_root / valid_gate_id / "nested" / "artifact.json"
            nested_named_report = gate_root / valid_gate_id / "nested" / "gate_report.json"
            valid_gate.parent.mkdir(parents=True)
            nested_artifact.parent.mkdir(parents=True)
            valid_gate.write_text(
                json.dumps(
                    {
                        "type": card_helper.SOURCE_GATE_TYPE,
                        "ok": True,
                        "gateId": valid_gate_id,
                        "createdAt": "2026-05-17T01:00:00Z",
                        "dataset": {"runId": "rl-accepted-real"},
                    }
                ),
                encoding="utf-8",
            )
            nested_payload = {
                "type": card_helper.SOURCE_GATE_TYPE,
                "ok": True,
                "gateId": nested_gate_id,
                "createdAt": "2026-05-17T03:00:00Z",
                "datasetRunId": "rl-accepted-nested",
            }
            nested_artifact.write_text(json.dumps(nested_payload), encoding="utf-8")
            nested_named_report.write_text(json.dumps(nested_payload), encoding="utf-8")

            selected = card_helper.select_accepted_dataset_gate(gate_root)

        self.assertEqual(selected["gate_id"], valid_gate_id)
        self.assertEqual(selected["dataset_run_id"], "rl-accepted-real")
        self.assertTrue(selected["gate_report_path"].endswith(f"gates/{valid_gate_id}/gate_report.json"))

    def test_latest_accepted_dataset_scans_control_loop_postmerge_gate_over_stale_dataset_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            runtime_root = root / "runtime-artifacts"
            stale_gate = runtime_root / "rl-dataset-gates" / "rl-gate-stale" / "gate_report.json"
            newer_wrong_stream_gate = runtime_root / "rl-control-loop" / "gate-20260518T063310Z" / "gate_report.json"
            fresh_gate = runtime_root / "rl-control-loop" / "gate-20260517T181846Z-postmerge1176" / "gate_report.json"
            stale_gate.parent.mkdir(parents=True)
            newer_wrong_stream_gate.parent.mkdir(parents=True)
            fresh_gate.parent.mkdir(parents=True)
            stale_gate.write_text(
                json.dumps(
                    {
                        "type": card_helper.SOURCE_GATE_TYPE,
                        "ok": True,
                        "gateId": "rl-gate-stale",
                        "createdAt": "2026-05-14T04:22:20Z",
                        "dataset": {"runId": "rl-stale-gate"},
                    }
                ),
                encoding="utf-8",
            )
            newer_wrong_stream_gate.write_text(
                json.dumps(
                    {
                        "type": card_helper.SOURCE_GATE_TYPE,
                        "ok": True,
                        "gateId": "gate-20260518T063310Z",
                        "createdAt": "2026-05-18T06:33:10Z",
                        "dataset": {"runId": "rl-wrong-stream-newer"},
                    }
                ),
                encoding="utf-8",
            )
            fresh_gate.write_text(
                json.dumps(
                    {
                        "type": card_helper.SOURCE_GATE_TYPE,
                        "ok": False,
                        "gateId": "gate-20260517T181846Z-postmerge1176",
                        "createdAt": "2026-05-17T18:18:47Z",
                        "dataset": {"ok": True, "runId": "rl-fresh-postmerge", "sampleCount": 200},
                        "datasetGate": {"status": "pass"},
                        "shadowEvaluation": {"status": "pass", "ok": True},
                        "blockingReasons": [
                            {
                                "gate": "quality_checks",
                                "name": "sample_quality",
                                "status": "fail",
                                "samplesAccepted": 191,
                                "samplesRejected": 9,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            selected = card_helper.select_accepted_dataset_gate(runtime_root)

        self.assertEqual(selected["gate_id"], "gate-20260517T181846Z-postmerge1176")
        self.assertEqual(selected["dataset_run_id"], "rl-fresh-postmerge")
        self.assertFalse(selected["gate_report_ok"])
        self.assertTrue(selected["gate_report_path"].endswith("rl-control-loop/gate-20260517T181846Z-postmerge1176/gate_report.json"))

    def test_latest_accepted_dataset_rejects_degraded_non_postmerge_gate(self) -> None:
        payload = {
            "type": card_helper.SOURCE_GATE_TYPE,
            "ok": False,
            "gateId": "gate-20260518T063310Z",
            "createdAt": "2026-05-18T06:33:10Z",
            "dataset": {"ok": True, "runId": "rl-wrong-stream-degraded", "sampleCount": 200},
            "datasetGate": {"status": "pass"},
            "shadowEvaluation": {"status": "pass", "ok": True},
            "blockingReasons": [
                {
                    "gate": "quality_checks",
                    "name": "sample_quality",
                    "status": "fail",
                    "samplesAccepted": 191,
                    "samplesRejected": 9,
                }
            ],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            runtime_root = root / "runtime-artifacts"
            gate_path = runtime_root / "rl-control-loop" / "gate-20260518T063310Z" / "gate_report.json"
            gate_path.parent.mkdir(parents=True)
            gate_path.write_text(json.dumps(payload), encoding="utf-8")

            with self.assertRaisesRegex(card_helper.CardValidationError, "no accepted dataset gate"):
                card_helper.select_accepted_dataset_gate(runtime_root)

        self.assertFalse(card_helper.is_acceptable_dataset_gate_report(payload))
        self.assertFalse(card_helper.is_degraded_e1_gate_acceptable(payload))

    def test_latest_accepted_dataset_skips_gate_deleted_during_scan(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            gate_root = root / "gates"
            valid_gate_id = "gate-20260517T010000Z-postmerge1188"
            vanished_gate_id = "gate-20260517T020000Z-postmerge1188"
            valid_gate = gate_root / valid_gate_id / "gate_report.json"
            vanished_gate = gate_root / vanished_gate_id / "gate_report.json"
            valid_gate.parent.mkdir(parents=True)
            vanished_gate.parent.mkdir(parents=True)
            valid_gate.write_text(
                json.dumps(
                    {
                        "type": card_helper.SOURCE_GATE_TYPE,
                        "ok": True,
                        "gateId": valid_gate_id,
                        "createdAt": "2026-05-17T01:00:00Z",
                        "dataset": {"runId": "rl-accepted-valid"},
                    }
                ),
                encoding="utf-8",
            )
            vanished_gate.write_text(
                json.dumps(
                    {
                        "type": card_helper.SOURCE_GATE_TYPE,
                        "ok": True,
                        "gateId": vanished_gate_id,
                        "createdAt": "2026-05-17T02:00:00Z",
                        "dataset": {"runId": "rl-accepted-vanished"},
                    }
                ),
                encoding="utf-8",
            )
            original_stat = Path.stat

            def stat_or_raise(path: Path, *args: object, **kwargs: object) -> os.stat_result:
                if path == vanished_gate:
                    raise OSError("deleted during scan")
                return original_stat(path, *args, **kwargs)

            with mock.patch.object(Path, "stat", stat_or_raise):
                selected = card_helper.latest_accepted_dataset_run_id(gate_root)

        self.assertEqual(selected, "rl-accepted-valid")

    def test_select_loop_a_card_skips_training_report_consumed_card(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_dir = root / "cards"
            report_dir = root / "reports"
            card_dir.mkdir()
            consumed = card_helper.build_card(
                dataset_run_id="rl-loop-a-consumed",
                code_commit="1" * 40,
                training_approach="policy_gradient",
                created_at="2026-05-17T02:00:00Z",
                loop_a_card_supply=True,
            )
            available = card_helper.build_card(
                dataset_run_id="rl-loop-a-available",
                code_commit="2" * 40,
                training_approach="policy_gradient",
                created_at="2026-05-17T01:00:00Z",
                loop_a_card_supply=True,
            )
            (card_dir / "consumed.json").write_text(json.dumps(consumed), encoding="utf-8")
            (card_dir / "available.json").write_text(json.dumps(available), encoding="utf-8")
            report_dir.mkdir()
            (report_dir / "training.json").write_text(
                json.dumps(
                    {
                        "type": "screeps-rl-training-report",
                        "experimentCard": {
                            "cardId": consumed["card_id"],
                            "cardSupply": consumed["card_supply"],
                        },
                    }
                ),
                encoding="utf-8",
            )

            selected = card_helper.select_loop_a_card_supply(card_dir, report_dir)

        self.assertIsNotNone(selected)
        assert selected is not None
        self.assertEqual(selected["card_id"], available["card_id"])
        self.assertEqual(selected["card_supply"]["state"], "available")

    def test_select_loop_a_card_ignores_non_loop_a_training_report_with_same_card_id(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_dir = root / "cards"
            report_dir = root / "reports"
            card_dir.mkdir()
            report_dir.mkdir()
            available = card_helper.build_card(
                dataset_run_id="rl-loop-a-available",
                code_commit="2" * 40,
                training_approach="policy_gradient",
                created_at="2026-05-17T01:00:00Z",
                loop_a_card_supply=True,
            )
            (card_dir / "available.json").write_text(json.dumps(available), encoding="utf-8")
            (report_dir / "bare-card-id.json").write_text(
                json.dumps(
                    {
                        "type": "screeps-rl-training-report",
                        "experimentCard": {"cardId": available["card_id"]},
                    }
                ),
                encoding="utf-8",
            )
            (report_dir / "wrong-supply-type.json").write_text(
                json.dumps(
                    {
                        "type": "screeps-rl-training-report",
                        "experimentCard": {
                            "cardId": available["card_id"],
                            "cardSupply": {
                                "type": "unrelated-supply",
                                "consumer": "loop-a-policy-gradient",
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )

            selected = card_helper.select_loop_a_card_supply(card_dir, report_dir)

        self.assertIsNotNone(selected)
        assert selected is not None
        self.assertEqual(selected["card_id"], available["card_id"])

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

        self.assertGreaterEqual(config.ticks, 500)
        self.assertGreaterEqual(config.repetitions, 5)

    def test_validate_rejects_policy_gradient_below_long_horizon_floor(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-short-horizon",
            code_commit="1" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T00:25:00Z",
        )
        card["simulation"]["ticks"] = 499

        with self.assertRaisesRegex(card_helper.CardValidationError, "simulation\\.ticks >= 500"):
            card_helper.validate_card(card)

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

    def test_cli_generation_floors_policy_gradient_ticks_and_accepts_repetitions(self) -> None:
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
        self.assertEqual(config.ticks, 500)
        self.assertEqual(config.repetitions, 6)
        self.assertEqual(generated["training_approach"], "policy_gradient")
        self.assertEqual(generated["policy_gradient"]["target_family"], "construction-priority")


if __name__ == "__main__":
    unittest.main()
