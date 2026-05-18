#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_training_runner as runner
import screeps_rl_experiment_card as card_helper


JsonObject = dict[str, Any]


def write_json(path: Path, payload: JsonObject) -> None:
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


def read_json(path: Path) -> JsonObject:
    return json.loads(path.read_text(encoding="utf-8"))


def base_card(variant_ids: list[str] | None = None) -> JsonObject:
    ids = variant_ids or ["baseline", "candidate"]
    return {
        "card_id": "rl-exp-test-000000000000",
        "dataset_run_id": "rl-test-dataset",
        "code_commit": "a" * 40,
        "created_at": "2026-05-03T00:00:00Z",
        "status": "shadow",
        "training_approach": "bandit",
        "safety": {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "ood_rejection": True,
            "conservative_actions_only": True,
        },
        "reward_model": {
            "type": "lexicographic",
            "component_order": ["reliability", "territory", "resources", "kills"],
            "component_weights": {
                "alpha_reliability": 1000000000,
                "beta_territory": 1000000,
                "gamma_resources": 1000,
                "delta_kills": 1,
            },
            "resource_normalizer": 1000,
            "scalar_weighted_sum_authorized": False,
        },
        "scenario": card_helper.scenario_metadata_block(),
        "simulation": {
            "ticks": 2,
            "workers": 1,
            "room": "W1N1",
            "shard": "shardX",
            "branch": "activeWorld",
            "code_path": "prod/dist/main.js",
            "map_source_file": "/root/screeps/maps/map-0b6758af.json",
            "simulator_out_dir": "runtime-artifacts/rl-simulator-test",
        },
        "strategy_variants": [
            {
                "id": variant_id,
                "rolloutStatus": "incumbent" if index == 0 else "shadow",
                "family": "test-family",
                "parameters": {
                    "expansion_aggressiveness": index,
                    "worker_allocation_ratio": 0.5,
                    "construction_priority": "balanced",
                    "defense_posture": "hold",
                },
            }
            for index, variant_id in enumerate(ids)
        ],
    }


def room(
    room_name: str,
    *,
    spawns: int = 1,
    creeps: int = 3,
    energy: int = 100,
    rcl: int = 1,
    claimed: bool = True,
    harvested: int = 0,
    hostile_kills: int = 0,
    own_losses: int = 0,
    spawn_status: str | None = None,
) -> JsonObject:
    payload: JsonObject = {
        "roomName": room_name,
        "controller": {"level": rcl, "my": claimed},
        "structures": {"spawn": spawns},
        "creeps": creeps,
        "resources": {
            "storedEnergy": energy,
            "events": {"harvestedEnergy": harvested},
        },
        "combat": {
            "events": {
                "hostileCreepDestroyedCount": hostile_kills,
                "ownCreepDestroyedCount": own_losses,
            }
        },
    }
    if spawn_status is not None:
        payload["spawnStatus"] = [{"name": "Spawn1", "status": spawn_status}]
    return payload


def hostile_fixture_room(room_name: str = "E2S1", *, hostile_creeps: int = 2, hostile_structures: int = 1) -> JsonObject:
    return {
        "roomName": room_name,
        "controller": {"level": 2, "my": False, "owner": {"username": "Invader"}},
        "structures": {"spawn": hostile_structures},
        "creeps": hostile_creeps,
        "combat": {
            "hostileCreeps": hostile_creeps,
            "hostileStructures": hostile_structures,
            "events": {},
        },
    }


def tick(tick_number: int, rooms: list[JsonObject]) -> JsonObject:
    return {
        "tick": tick_number,
        "rooms": {str(room_payload["roomName"]): room_payload for room_payload in rooms},
    }


def variant_result(variant_id: str, ticks: list[JsonObject]) -> JsonObject:
    return {
        "variant_id": variant_id,
        "variant_run_id": f"run-{variant_id}",
        "ticks_run": len(ticks),
        "wall_clock_seconds": 0.01,
        "ok": True,
        "tick_log": ticks,
    }


class MockSimulator:
    def __init__(self, results_by_variant: dict[str, JsonObject]) -> None:
        self.results_by_variant = results_by_variant
        self.calls: list[JsonObject] = []

    def __call__(self, **kwargs: Any) -> JsonObject:
        self.calls.append(dict(kwargs))
        return {
            "type": "screeps-rl-simulator-run",
            "runId": kwargs["run_id"],
            "liveEffect": False,
            "officialMmoWrites": False,
            "variants": [self.results_by_variant[variant_id] for variant_id in kwargs["variants"]],
        }


class RequiredSteamKeySimulator(MockSimulator):
    def __init__(self, results_by_variant: dict[str, JsonObject]) -> None:
        super().__init__(results_by_variant)
        self.observed_steam_keys: list[str | None] = []

    def __call__(self, **kwargs: Any) -> JsonObject:
        self.observed_steam_keys.append(os.environ.get("STEAM_KEY"))
        if not os.environ.get("STEAM_KEY", "").strip():
            raise RuntimeError("STEAM_KEY environment variable is required for run mode")
        return super().__call__(**kwargs)


class RlTrainingRunnerTest(unittest.TestCase):
    def test_experiment_card_validation_requires_conservative_and_ood_safety_flags(self) -> None:
        for field in ("conservative_actions_only", "ood_rejection"):
            with self.subTest(field=field):
                card = base_card()
                del card["safety"][field]

                with self.assertRaisesRegex(runner.TrainingCardError, f"safety.{field} must be true"):
                    runner.validate_experiment_card(card)

    def test_experiment_card_validation_rejects_missing_reliability_reward_tier(self) -> None:
        card = base_card()
        card["reward_model"]["component_order"] = ["territory", "resources", "kills"]

        with self.assertRaisesRegex(
            runner.TrainingCardError,
            "reward_model.component_order must preserve reliability, territory, resources, kills",
        ):
            runner.validate_experiment_card(card)

    def test_experiment_card_validation_requires_scenario_metadata(self) -> None:
        card = base_card()
        del card["scenario"]

        with self.assertRaisesRegex(runner.TrainingCardError, "scenario metadata is required"):
            runner.validate_experiment_card(card)

    def test_experiment_card_validation_rejects_inconsistent_scenario_suitability(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-scenario-invalid",
            code_commit="a" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:20:00Z",
        )
        card["scenario"]["suitability"]["multi_tier_policy_comparison"] = True

        with self.assertRaisesRegex(runner.TrainingCardError, "marked multi-tier suitable"):
            runner.validate_experiment_card(card)

    def test_training_report_carries_single_room_scenario_classification(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-scenario-report",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:21:00Z",
        )
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        start = tick(1, [room("E1S1", energy=100)])
        finish = tick(2, [room("E1S1", energy=150)])
        simulator = MockSimulator({
            variant_id: variant_result(variant_id, [start, finish])
            for variant_id in variant_ids
        })

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="scenario-classification",
                simulator_runner=simulator,
            )

        self.assertEqual(report["scenario"]["scenario_id"], card_helper.DEFAULT_SCENARIO_ID)
        self.assertFalse(report["experimentCard"]["multiTierPolicyComparisonSuitable"])
        self.assertEqual(
            report["scenario"]["suitability"]["classification"],
            "not_suitable_for_territory_combat_differentiation",
        )
        self.assertIn(
            "experiment card scenario is classified as not suitable for multi-tier territory/combat policy comparison",
            report["warnings"],
        )

    def test_multi_tier_activation_proof_blocks_when_fixture_signal_has_no_objective_movement(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-blocked",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:21:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_ID,
            require_multi_tier_scenario=True,
        )
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        start = tick(1, [room("E1S1", energy=100), hostile_fixture_room()])
        finish = tick(2, [room("E1S1", energy=150), hostile_fixture_room()])
        simulator_results: dict[str, JsonObject] = {}
        for variant_id in variant_ids:
            result = variant_result(variant_id, [start, finish])
            result["metrics"] = {"territoryDelta": 2, "hostileKills": 0}
            simulator_results[variant_id] = result

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="multi-tier-blocked",
                simulator_runner=MockSimulator(simulator_results),
            )

        proof = report["activationProof"]
        self.assertEqual(proof["status"], "blocked")
        self.assertEqual(proof["blocker"]["classification"], "SIMULATOR_OBJECTIVE_SIGNAL_NOT_ACTIVATED")
        self.assertTrue(proof["transport"]["objectiveSignalObserved"])
        self.assertEqual(proof["bestObserved"]["territoryScore"], 2.0)
        self.assertEqual(proof["bestObserved"]["hostileKills"], 0.0)
        self.assertEqual(report["variantResults"][0]["metrics"]["territory"]["ownedRoomCount"], 1)
        self.assertEqual(report["variantResults"][0]["metrics"]["objectiveSignal"]["finalObservedRoomCount"], 2)
        self.assertIn("multi-tier activation proof blocked", report["warnings"][-1])
        self.assertFalse(runner.build_generation_summary(report)["ok"])

    def test_multi_tier_activation_proof_requires_hostile_signal_for_transport(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-missing-fixture-signal",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:22:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_ID,
            require_multi_tier_scenario=True,
        )
        proof = runner.build_multi_tier_activation_proof(
            results=[
                {
                    "variantId": "candidate",
                    "sampleCount": 1,
                    "metrics": {
                        "territory": {"delta": 2},
                        "kills": {"hostileKills": 0},
                        "objectiveSignal": {
                            "initialObservedRoomCount": 2,
                            "finalObservedRoomCount": 2,
                            "initialHostileCreeps": 0,
                            "finalHostileCreeps": 0,
                            "initialHostileStructures": 0,
                            "finalHostileStructures": 0,
                            "initialObjectiveSignalPresent": False,
                            "finalObjectiveSignalPresent": False,
                        },
                    },
                }
            ],
            scenario=card["scenario"],
            kpi_summary={},
        )

        self.assertIsNotNone(proof)
        if proof is None:
            self.fail("expected multi-tier activation proof")
        self.assertFalse(proof["transport"]["objectiveSignalObserved"])
        self.assertEqual(proof["transport"]["classification"], "not_observed_in_variant_metrics")
        self.assertFalse(proof["variants"][0]["objectiveSignalObserved"])
        self.assertEqual(proof["blocker"]["classification"], "SIMULATOR_FIXTURE_SIGNAL_NOT_TRANSPORTED")

    def test_multi_tier_activation_proof_rejects_legacy_progress_without_transport(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-legacy-progress",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:23:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_ID,
            require_multi_tier_scenario=True,
        )
        proof = runner.build_multi_tier_activation_proof(
            results=[
                {
                    "variantId": "candidate",
                    "sampleCount": 1,
                    "metrics": {
                        "territory": {"delta": 3},
                        "kills": {"hostileKills": 1},
                        "objectiveSignal": {
                            "initialObservedRoomCount": 2,
                            "finalObservedRoomCount": 2,
                            "initialHostileCreeps": 0,
                            "finalHostileCreeps": 0,
                            "initialHostileStructures": 0,
                            "finalHostileStructures": 0,
                            "initialObjectiveSignalPresent": False,
                            "finalObjectiveSignalPresent": False,
                        },
                    },
                }
            ],
            scenario=card["scenario"],
            kpi_summary={},
        )

        self.assertIsNotNone(proof)
        if proof is None:
            self.fail("expected multi-tier activation proof")
        self.assertEqual(proof["status"], "blocked")
        self.assertFalse(proof["ok"])
        self.assertFalse(proof["transport"]["objectiveSignalObserved"])
        self.assertFalse(proof["variants"][0]["passesActivation"])
        self.assertEqual(proof["bestObserved"]["territoryScore"], 3.0)
        self.assertEqual(proof["bestObserved"]["hostileKills"], 1.0)
        self.assertNotIn("passingVariants", proof)
        self.assertEqual(proof["blocker"]["classification"], "SIMULATOR_FIXTURE_SIGNAL_NOT_TRANSPORTED")

    def test_multi_tier_activation_proof_rejects_stitched_sample_average(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-stitched-samples",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:24:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_ID,
            require_multi_tier_scenario=True,
        )
        variant = runner.StrategyVariant(id="candidate", family="test-family", parameters={})
        transport_only = variant_result(
            "candidate",
            [
                tick(1, [room("E1S1", energy=100), hostile_fixture_room()]),
                tick(2, [room("E1S1", energy=100), hostile_fixture_room()]),
            ],
        )
        transport_only["metrics"] = {"territoryDelta": 0, "hostileKills": 0}
        score_only = variant_result(
            "candidate",
            [
                tick(3, [room("E1S1", energy=100)]),
                tick(4, [room("E1S1", energy=100)]),
            ],
        )
        score_only["metrics"] = {"territoryDelta": 6, "hostileKills": 0}
        result = runner.summarize_variant(
            variant,
            [transport_only, score_only],
            {"resourceNormalizer": 1000},
        )

        proof = runner.build_multi_tier_activation_proof(
            results=[result],
            scenario=card["scenario"],
            kpi_summary={},
        )

        self.assertIsNotNone(proof)
        if proof is None:
            self.fail("expected multi-tier activation proof")
        self.assertEqual(proof["status"], "blocked")
        self.assertTrue(proof["transport"]["objectiveSignalObserved"])
        self.assertFalse(proof["variants"][0]["passesActivation"])
        self.assertEqual(proof["variants"][0]["activationSampleCount"], 2)
        self.assertEqual(
            [sample["passesActivation"] for sample in proof["variants"][0]["activationSamples"]],
            [False, False],
        )
        self.assertEqual(proof["bestObserved"]["territoryScore"], 3.0)
        self.assertEqual(proof["blocker"]["classification"], "SIMULATOR_OBJECTIVE_SIGNAL_NOT_ACTIVATED")

    def test_multi_tier_activation_proof_reports_missing_samples_separately(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-no-samples",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:25:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_ID,
            require_multi_tier_scenario=True,
        )
        proof = runner.build_multi_tier_activation_proof(
            results=[
                {
                    "variantId": "candidate",
                    "sampleCount": 0,
                    "metrics": runner.aggregate_metrics([]),
                }
            ],
            scenario=card["scenario"],
            kpi_summary={},
        )

        self.assertIsNotNone(proof)
        if proof is None:
            self.fail("expected multi-tier activation proof")
        self.assertEqual(proof["status"], "blocked")
        self.assertEqual(proof["blocker"]["classification"], "SIMULATOR_NO_SUCCESSFUL_SAMPLES")
        self.assertIn("no successful simulator samples", proof["blocker"]["evidence"])

    def test_multi_tier_activation_proof_passes_when_variant_has_hostile_kill_signal(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-passed",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:22:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_ID,
            require_multi_tier_scenario=True,
        )
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        start = tick(1, [room("E1S1", energy=100), hostile_fixture_room()])
        finish = tick(2, [room("E1S1", energy=150), hostile_fixture_room(hostile_creeps=1)])
        simulator_results: dict[str, JsonObject] = {}
        for index, variant_id in enumerate(variant_ids):
            result = variant_result(variant_id, [start, finish])
            result["metrics"] = {"territoryDelta": 2, "hostileKills": 1 if index == 0 else 0}
            simulator_results[variant_id] = result

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="multi-tier-passed",
                simulator_runner=MockSimulator(simulator_results),
            )

        proof = report["activationProof"]
        self.assertEqual(proof["status"], "passed")
        self.assertTrue(proof["ok"])
        self.assertEqual(proof["passingVariants"], [variant_ids[0]])
        self.assertNotIn("blocker", proof)

    def test_steam_key_env_var_wins_over_env_file(self) -> None:
        env_secret = "env-secret-token-123456"
        file_secret = "file-secret-token-123456"
        simulator = RequiredSteamKeySimulator({
            "baseline": variant_result("baseline", []),
            "candidate": variant_result("candidate", []),
        })

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            env_file = root / "runner.env"
            write_json(card_path, base_card())
            env_file.write_text(f"STEAM_KEY={file_secret}\n", encoding="utf-8")

            with mock.patch.dict(os.environ, {"STEAM_KEY": env_secret}, clear=True):
                runner.run_training_experiment(
                    card_path,
                    root / "reports",
                    report_id="steam-key-env-wins",
                    simulator_runner=simulator,
                    steam_key_env_file=env_file,
                )
                self.assertEqual(os.environ.get("STEAM_KEY"), env_secret)

        self.assertEqual(simulator.observed_steam_keys, [env_secret])

    def test_absent_steam_key_loads_from_env_file(self) -> None:
        file_secret = "file-secret-token-123456"
        simulator = RequiredSteamKeySimulator({
            "baseline": variant_result("baseline", []),
            "candidate": variant_result("candidate", []),
        })

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            env_file = root / "runner.env"
            write_json(card_path, base_card())
            env_file.write_text(f"export STEAM_KEY='{file_secret}' # local only\n", encoding="utf-8")

            with mock.patch.dict(os.environ, {}, clear=True):
                runner.run_training_experiment(
                    card_path,
                    root / "reports",
                    report_id="steam-key-env-file-load",
                    simulator_runner=simulator,
                    steam_key_env_file=env_file,
                )
                self.assertEqual(os.environ.get("STEAM_KEY"), file_secret)

        self.assertEqual(simulator.observed_steam_keys, [file_secret])

    def test_whitespace_steam_key_env_loads_from_env_file_without_secret_leak(self) -> None:
        file_secret = "file-secret-token-123456"
        simulator = RequiredSteamKeySimulator({
            "baseline": variant_result("baseline", []),
            "candidate": variant_result("candidate", []),
        })

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            env_file = root / "runner.env"
            write_json(card_path, base_card())
            env_file.write_text(f"STEAM_KEY={file_secret}\n", encoding="utf-8")

            with mock.patch.dict(os.environ, {"STEAM_KEY": "   \t  "}, clear=True):
                runner.run_training_experiment(
                    card_path,
                    out_dir,
                    report_id="steam-key-whitespace-env-file-load",
                    simulator_runner=simulator,
                    steam_key_env_file=env_file,
                )
                self.assertEqual(os.environ.get("STEAM_KEY"), file_secret)
                report_text = (out_dir / "steam-key-whitespace-env-file-load.json").read_text(encoding="utf-8")

        self.assertEqual(simulator.observed_steam_keys, [file_secret])
        self.assertNotIn(file_secret, report_text)

    def test_default_real_training_path_loads_steam_key_env_file(self) -> None:
        file_secret = "default-file-secret-token-123456"

        with tempfile.TemporaryDirectory() as temp_dir:
            env_file = Path(temp_dir) / "local.env"
            env_file.write_text(f"STEAM_KEY={file_secret}\n", encoding="utf-8")

            with (
                mock.patch.dict(os.environ, {}, clear=True),
                mock.patch.object(runner, "DEFAULT_STEAM_KEY_ENV_FILE", env_file),
            ):
                runner.ensure_steam_key_for_training(simulator_runner=runner.simulator_harness.run_simulator)
                self.assertEqual(os.environ.get("STEAM_KEY"), file_secret)

    def test_configured_steam_key_env_file_loads_for_wrapped_training_path(self) -> None:
        file_secret = "configured-file-secret-token-123456"
        simulator = RequiredSteamKeySimulator({
            "baseline": variant_result("baseline", []),
            "candidate": variant_result("candidate", []),
        })

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            env_file = root / "runner.env"
            write_json(card_path, base_card())
            env_file.write_text(f"STEAM_KEY={file_secret}\n", encoding="utf-8")

            with mock.patch.dict(os.environ, {runner.STEAM_KEY_ENV_FILE_ENV: str(env_file)}, clear=True):
                runner.run_training_experiment(
                    card_path,
                    root / "reports",
                    report_id="steam-key-configured-env-file-load",
                    simulator_runner=simulator,
                )
                self.assertEqual(os.environ.get("STEAM_KEY"), file_secret)

        self.assertEqual(simulator.observed_steam_keys, [file_secret])

    def test_missing_or_empty_steam_key_env_reports_required_env_error(self) -> None:
        for case, contents in (("missing", None), ("empty", "STEAM_KEY=\n")):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                card_path = root / "card.json"
                env_file = root / "runner.env"
                write_json(card_path, base_card())
                if contents is not None:
                    env_file.write_text(contents, encoding="utf-8")
                simulator = RequiredSteamKeySimulator({
                    "baseline": variant_result("baseline", []),
                    "candidate": variant_result("candidate", []),
                })

                with mock.patch.dict(os.environ, {}, clear=True):
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "STEAM_KEY environment variable is required for run mode",
                    ) as caught:
                        runner.run_training_experiment(
                            card_path,
                            root / "reports",
                            report_id=f"steam-key-required-{case}",
                            simulator_runner=simulator,
                            steam_key_env_file=env_file,
                        )

                self.assertEqual(str(caught.exception), "STEAM_KEY environment variable is required for run mode")
                self.assertEqual(simulator.observed_steam_keys, [None])

    def test_main_redacts_steam_key_from_error_output(self) -> None:
        secret = "steam-secret-token-123456"
        stdout = io.StringIO()
        stderr = io.StringIO()

        with (
            mock.patch.dict(os.environ, {"STEAM_KEY": secret}, clear=True),
            mock.patch.object(
                runner,
                "run_training_experiment",
                side_effect=RuntimeError(f"simulator echoed {secret}"),
            ),
        ):
            exit_code = runner.main(["--experiment-card", "card.json"], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 2)
        self.assertNotIn(secret, stdout.getvalue())
        self.assertNotIn(secret, stderr.getvalue())
        self.assertIn("[REDACTED]", stderr.getvalue())

    def test_lexicographic_reward_makes_territory_win_beat_resource_win(self) -> None:
        start = tick(1, [room("W1N1", energy=100)])
        resource_win = variant_result(
            "baseline",
            [
                start,
                tick(2, [room("W1N1", energy=12000, harvested=9000)]),
            ],
        )
        territory_win = variant_result(
            "candidate",
            [
                start,
                tick(2, [room("W1N1", energy=50), room("W1N2", energy=50)]),
            ],
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            write_json(card_path, base_card())
            report = runner.run_training_experiment(
                card_path,
                out_dir,
                report_id="territory-beats-resources",
                simulator_runner=MockSimulator({"baseline": resource_win, "candidate": territory_win}),
            )

        self.assertEqual(report["ranking"][0]["variantId"], "candidate")
        self.assertEqual(report["variantResults"][1]["reward"]["tuple"][0], 1)
        self.assertEqual(report["variantResults"][1]["reward"]["tuple"][1], 1)
        self.assertGreater(
            report["variantResults"][0]["reward"]["tuple"][2],
            report["variantResults"][1]["reward"]["tuple"][2],
        )
        comparison = report["statisticalComparison"]["pairwise"][0]
        self.assertEqual(comparison["winner"], "candidate")
        self.assertEqual(comparison["firstDifferingTier"], "territory")

    def test_expansion_survival_marks_claimed_but_collapsed_room_as_loss(self) -> None:
        start = tick(1, [room("W1N1", energy=100)])
        collapsed_expansion = variant_result(
            "candidate",
            [
                start,
                tick(
                    2,
                    [
                        room("W1N1", energy=100),
                        room("W1N2", spawns=0, creeps=0, energy=0, claimed=True),
                    ],
                ),
            ],
        )
        metrics = runner.compute_run_metrics(collapsed_expansion, {"resourceNormalizer": 1000})

        self.assertEqual(metrics["territory"]["delta"], -1)
        self.assertEqual(metrics["territory"]["roomsLost"], 1)
        self.assertEqual(metrics["territory"]["collapsedClaimedRooms"], ["W1N2"])
        self.assertEqual(metrics["rewardTuple"][0], 1)
        self.assertEqual(metrics["rewardTuple"][1], -1)

    def test_run_metrics_prefer_harness_room_states_over_aggregate_room_counters(self) -> None:
        run = variant_result("candidate", [])
        run["metrics"] = {
            "initialRooms": {"ownedRoomCount": 0, "structures": {}, "controllerLevels": {}},
            "finalRooms": {"ownedRoomCount": 0, "structures": {}, "controllerLevels": {}},
            "initialRoomStates": {"E1S1": room("E1S1", spawns=1, creeps=1, energy=250, rcl=1)},
            "finalRoomStates": {"E1S1": room("E1S1", spawns=1, creeps=2, energy=300, rcl=2)},
        }

        metrics = runner.compute_run_metrics(run, {"resourceNormalizer": 1000})

        self.assertEqual(metrics["territory"]["ownedRoomCount"], 1)
        self.assertEqual(metrics["territory"]["rclLevels"], {"E1S1": 2})
        self.assertEqual(metrics["resources"]["storedEnergyDelta"], 50)

    def test_run_metrics_count_owned_controller_owner_object_without_my_flag(self) -> None:
        owned_room = room("E1S1", spawns=1, creeps=2, energy=300, rcl=2)
        owned_room["controller"] = {"level": 2, "owner": {"username": "rl-sim"}}
        run = variant_result(
            "candidate",
            [
                tick(1, [owned_room]),
                tick(2, [owned_room]),
            ],
        )

        metrics = runner.compute_run_metrics(run, {"resourceNormalizer": 1000})

        self.assertEqual(metrics["territory"]["ownedRoomCount"], 1)
        self.assertEqual(metrics["territory"]["survivedEndRooms"], ["E1S1"])
        self.assertEqual(metrics["territory"]["rclLevels"], {"E1S1": 2})

    def test_experiment_card_loading_and_validation_accepts_yaml_inline_variants(self) -> None:
        yaml_text = """
card_id: rl-exp-yaml-000000000000
dataset_run_id: rl-yaml-dataset
code_commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
created_at: "2026-05-03T00:00:00Z"
status: shadow
training_approach: bandit
safety:
  liveEffect: false
  officialMmoWrites: false
  officialMmoWritesAllowed: false
  ood_rejection: true
  conservative_actions_only: true
scenario:
  type: screeps-rl-training-scenario
  scenario_id: e1s1-single-room-no-hostile
  scenario_tier: single_room_smoke
  capabilities:
    multi_room_capable: false
    adjacent_room_territory_signal: false
    hostile_combat_signal: false
    multi_tier_policy_comparison: false
  suitability:
    multi_tier_policy_comparison: false
    territory_combat_differentiation: false
    classification: not_suitable_for_territory_combat_differentiation
    reasons:
      - single-room E1S1 map has no adjacent-room expansion signal
      - default smoke fixture has no hostile/combat signal
reward_model:
  type: lexicographic
  component_order:
    - reliability
    - territory
    - resources
    - kills
  scalar_weighted_sum_authorized: false
simulation:
  ticks: 5
  workers: 1
  repetitions: 1
  room: W1N1
strategy_variants:
  - id: yaml-baseline
    rolloutStatus: incumbent
    parameters:
      expansion_aggressiveness: 0.4
      worker_allocation_ratio: 0.6
      construction_priority: balanced
      defense_posture: hold
  - id: yaml-candidate
    rolloutStatus: shadow
    parameters:
      expansion_aggressiveness: 0.7
      worker_allocation_ratio: 0.5
      construction_priority: territory
      defense_posture: hold
"""
        with tempfile.TemporaryDirectory() as temp_dir:
            card_path = Path(temp_dir) / "card.yaml"
            card_path.write_text(yaml_text, encoding="utf-8")
            card = runner.load_experiment_card(card_path)
            variants = runner.load_strategy_variants(card, registry_path=Path(temp_dir) / "missing-registry.ts")
            config = runner.simulation_config_from_card(card)

        self.assertEqual(card["status"], "shadow")
        self.assertEqual([variant.id for variant in variants], ["yaml-baseline", "yaml-candidate"])
        self.assertEqual(variants[0].parameters["construction_priority"], "balanced")
        self.assertEqual(config.ticks, 5)

    def test_strategy_registry_loader_ignores_commented_entries(self) -> None:
        registry_text = """
export const STRATEGY_REGISTRY = [
  // { id: 'commented-line', defaultValues: { expansion_aggressiveness: 9 } },
  {
    id: 'candidate',
    family: 'test-family',
    rolloutStatus: 'shadow',
    title: 'Candidate',
    defaultValues: {
      expansion_aggressiveness: 1,
      worker_allocation_ratio: 0.5,
    },
  },
  /*
  {
    id: 'commented-block',
    defaultValues: { expansion_aggressiveness: 10 },
  },
  */
];
"""
        with tempfile.TemporaryDirectory() as temp_dir:
            registry_path = Path(temp_dir) / "strategyRegistry.ts"
            registry_path.write_text(registry_text, encoding="utf-8")
            registry = runner.load_strategy_registry(registry_path)

        self.assertEqual(list(registry), ["candidate"])
        self.assertEqual(registry["candidate"].parameters["expansion_aggressiveness"], 1)

    def test_strategy_registry_loader_preserves_comment_markers_inside_strings(self) -> None:
        registry_text = """
export const STRATEGY_REGISTRY = [
  {
    id: 'candidate',
    title: 'https://planner.example/variants/*literal*/',
    defaultValues: {
      construction_priority: 'https://planner.example/queues',
      defense_posture: 'hold /* literal comment marker */',
    },
  },
];
"""
        with tempfile.TemporaryDirectory() as temp_dir:
            registry_path = Path(temp_dir) / "strategyRegistry.ts"
            registry_path.write_text(registry_text, encoding="utf-8")
            registry = runner.load_strategy_registry(registry_path)

        self.assertEqual(registry["candidate"].title, "https://planner.example/variants/*literal*/")
        self.assertEqual(registry["candidate"].parameters["construction_priority"], "https://planner.example/queues")
        self.assertEqual(registry["candidate"].parameters["defense_posture"], "hold /* literal comment marker */")

    def test_variant_ranking_uses_resources_when_territory_ties(self) -> None:
        start = tick(1, [room("W1N1", energy=100)])
        lower_resource = variant_result("baseline", [start, tick(2, [room("W1N1", energy=300, harvested=100)])])
        higher_resource = variant_result("candidate", [start, tick(2, [room("W1N1", energy=900, harvested=100)])])

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, base_card())
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="resource-tiebreak",
                simulator_runner=MockSimulator({"baseline": lower_resource, "candidate": higher_resource}),
            )

        self.assertEqual(report["ranking"][0]["variantId"], "candidate")
        self.assertEqual(report["ranking"][0]["rewardTuple"][0], 1)
        self.assertEqual(report["ranking"][0]["rewardTuple"][1], 0)
        self.assertEqual(report["statisticalComparison"]["pairwise"][0]["firstDifferingTier"], "resources")

    def test_equal_reward_tuple_does_not_count_as_top_change(self) -> None:
        start = tick(1, [room("W1N1", energy=100)])
        finish = tick(2, [room("W1N1", energy=300, harvested=100)])
        baseline = variant_result("baseline", [start, finish])
        candidate = variant_result("candidate", [start, finish])

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, base_card())
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="equal-reward-tie",
                simulator_runner=MockSimulator({"baseline": baseline, "candidate": candidate}),
            )

        self.assertEqual(report["ranking"][0]["variantId"], "candidate")
        self.assertEqual([item["rank"] for item in report["ranking"]], [1, 1])
        self.assertIsNone(report["statisticalComparison"]["pairwise"][0]["winner"])
        self.assertEqual(report["changedTopCount"], 0)
        self.assertEqual(report["rankingDiffCount"], 0)

        model_report = next(item for item in report["modelReports"] if item["candidateStrategyId"] == "candidate")
        self.assertEqual(model_report["changedTopCount"], 0)
        self.assertFalse(model_report["rankingDiffs"][0]["changedTop"])
        self.assertEqual(runner.build_generation_summary(report)["changedTopCount"], 0)

    def test_failed_variant_runs_are_excluded_from_reward_ranking(self) -> None:
        start = tick(1, [room("W1N1", energy=100)])
        negative_baseline = variant_result(
            "baseline",
            [
                start,
                tick(2, [room("W1N1", spawns=0, creeps=0, energy=0, claimed=True)]),
            ],
        )
        failed_candidate = variant_result("candidate", [])
        failed_candidate["ok"] = False
        failed_candidate["error"] = "simulator failed"

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, base_card())
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="failed-run-excluded",
                simulator_runner=MockSimulator({"baseline": negative_baseline, "candidate": failed_candidate}),
            )

        candidate_result = next(result for result in report["variantResults"] if result["variantId"] == "candidate")
        self.assertEqual(candidate_result["sampleCount"], 0)
        self.assertEqual(candidate_result["excludedRunCount"], 1)
        self.assertEqual(candidate_result["metrics"]["reliability"]["score"], 0)
        self.assertEqual(candidate_result["reward"]["samples"], [[0, None, None, None]])
        self.assertEqual([item["variantId"] for item in report["ranking"]], ["baseline"])
        self.assertNotIn("candidate", report["statisticalComparison"]["componentMeans"])
        self.assertTrue(
            any(
                "excluded 1 failed simulator run(s) from sampleCount and non-reliability reward tiers; "
                "reliability scored them as 0" in warning
                for warning in report["warnings"]
            )
        )
        self.assertFalse(any("from reward scoring" in warning for warning in report["warnings"]))

    def test_reward_samples_include_failed_repetition_reliability(self) -> None:
        start = tick(1, [room("W1N1", energy=100)])
        baseline = variant_result("baseline", [start, tick(2, [room("W1N1", energy=200)])])
        successful_candidate = variant_result("candidate", [start, tick(2, [room("W1N1", energy=300)])])
        failed_candidate = variant_result("candidate", [])
        failed_candidate["variant_run_id"] = "run-candidate-failed"
        failed_candidate["ok"] = False
        failed_candidate["error"] = "simulator failed"

        class FlakyRepetitionSimulator:
            def __init__(self) -> None:
                self.calls: list[JsonObject] = []

            def __call__(self, **kwargs: Any) -> JsonObject:
                self.calls.append(dict(kwargs))
                candidate = successful_candidate if len(self.calls) == 1 else failed_candidate
                return {
                    "type": "screeps-rl-simulator-run",
                    "runId": kwargs["run_id"],
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "variants": [baseline, candidate],
                }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            card = base_card()
            card["simulation"]["repetitions"] = 2
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="flaky-reliability-samples",
                simulator_runner=FlakyRepetitionSimulator(),
            )

        candidate_result = next(result for result in report["variantResults"] if result["variantId"] == "candidate")
        self.assertEqual(candidate_result["sampleCount"], 1)
        self.assertEqual(candidate_result["excludedRunCount"], 1)
        self.assertEqual(candidate_result["reward"]["tuple"][0], 0.5)
        self.assertEqual([sample[0] for sample in candidate_result["reward"]["samples"]], [1, 0])
        self.assertEqual(candidate_result["reward"]["samples"][1], [0, None, None, None])
        self.assertEqual(candidate_result["reward"]["sampleStdDev"][0], 0.5)
        self.assertEqual(candidate_result["reward"]["sampleStdDev"][1:], [0, 0, 0])

    def test_missing_variant_repetition_counts_as_unreliable_attempt(self) -> None:
        start = tick(1, [room("W1N1", energy=100)])
        baseline = variant_result("baseline", [start, tick(2, [room("W1N1", energy=200)])])
        successful_candidate = variant_result("candidate", [start, tick(2, [room("W1N1", energy=10000)])])

        class MissingCandidateRepetitionSimulator:
            def __init__(self) -> None:
                self.calls: list[JsonObject] = []

            def __call__(self, **kwargs: Any) -> JsonObject:
                self.calls.append(dict(kwargs))
                variants = [baseline, successful_candidate] if len(self.calls) == 1 else [baseline]
                return {
                    "type": "screeps-rl-simulator-run",
                    "runId": kwargs["run_id"],
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "variants": variants,
                }

        simulator = MissingCandidateRepetitionSimulator()
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            card = base_card()
            card["simulation"]["repetitions"] = 2
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="missing-candidate-repetition",
                simulator_runner=simulator,
            )

        candidate_result = next(result for result in report["variantResults"] if result["variantId"] == "candidate")
        self.assertEqual(len(simulator.calls), 2)
        self.assertEqual(candidate_result["sampleCount"], 1)
        self.assertEqual(candidate_result["excludedRunCount"], 1)
        self.assertEqual(candidate_result["reward"]["tuple"][0], 0.5)
        self.assertEqual(candidate_result["metrics"]["reliability"]["score"], 0.5)
        self.assertEqual([sample[0] for sample in candidate_result["reward"]["samples"]], [1, 0])
        self.assertEqual(candidate_result["reward"]["samples"][1], [0, None, None, None])
        self.assertIn("missing from simulator run", candidate_result["runs"][1]["error"])

        ranking_by_variant = {item["variantId"]: item for item in report["ranking"]}
        self.assertEqual([item["variantId"] for item in report["ranking"]], ["baseline", "candidate"])
        self.assertEqual(ranking_by_variant["baseline"]["rank"], 1)
        self.assertGreater(ranking_by_variant["candidate"]["rank"], ranking_by_variant["baseline"]["rank"])
        self.assertNotEqual(ranking_by_variant["candidate"]["rewardTuple"][0], 1)
        self.assertEqual(report["statisticalComparison"]["pairwise"][0]["winner"], "baseline")

    def test_duplicate_or_unexpected_variant_rows_fail_before_report_is_persisted(self) -> None:
        start = tick(1, [room("W1N1", energy=100)])
        baseline = variant_result("baseline", [start, tick(2, [room("W1N1", energy=200)])])
        candidate = variant_result("candidate", [start, tick(2, [room("W1N1", energy=250)])])
        duplicate_baseline = dict(baseline)
        duplicate_baseline["variant_run_id"] = "run-baseline-duplicate"
        unexpected = variant_result("intruder", [start, tick(2, [room("W1N1", energy=300)])])

        cases = (
            (
                "duplicate-variant-row",
                [baseline, duplicate_baseline, candidate],
                r"duplicate-variant-row .*run_index=0.*duplicate variant id 'baseline'",
            ),
            (
                "unexpected-variant-row",
                [baseline, candidate, unexpected],
                r"unexpected-variant-row .*run_index=0.*unexpected variant id 'intruder'",
            ),
        )
        for report_id, variants, message_regex in cases:
            with self.subTest(report_id=report_id), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                card_path = root / "card.json"
                out_dir = root / "reports"

                class MalformedVariantSimulator:
                    def __call__(self, **kwargs: Any) -> JsonObject:
                        return {
                            "type": "screeps-rl-simulator-run",
                            "runId": kwargs["run_id"],
                            "liveEffect": False,
                            "officialMmoWrites": False,
                            "variants": variants,
                        }

                write_json(card_path, base_card())
                with self.assertRaisesRegex(RuntimeError, message_regex):
                    runner.run_training_experiment(
                        card_path,
                        out_dir,
                        report_id=report_id,
                        simulator_runner=MalformedVariantSimulator(),
                    )

                self.assertFalse((out_dir / f"{report_id}.json").exists())

    def test_malformed_variant_rows_fail_before_report_is_persisted(self) -> None:
        start = tick(1, [room("W1N1", energy=100)])
        baseline = variant_result("baseline", [start, tick(2, [room("W1N1", energy=200)])])
        candidate = variant_result("candidate", [start, tick(2, [room("W1N1", energy=250)])])

        cases = (
            (
                "non-dict-variant-row",
                [baseline, "not-a-dict", candidate],
                r"non-dict-variant-row .*run_index=0.*variant_index=1.*raw_variant='not-a-dict'",
            ),
            (
                "missing-variant-id",
                [baseline, {"ticks": []}, candidate],
                r"missing-variant-id .*run_index=0.*variant_index=1.*missing string variant id.*raw_variant=",
            ),
            (
                "empty-variant-id",
                [baseline, {"variant_id": "", "ticks": []}, candidate],
                r"empty-variant-id .*run_index=0.*variant_index=1.*missing string variant id.*raw_variant=",
            ),
            (
                "non-string-variant-id",
                [baseline, {"variant_id": 7, "ticks": []}, candidate],
                r"non-string-variant-id .*run_index=0.*variant_index=1.*missing string variant id.*raw_variant=",
            ),
        )
        for report_id, variants, message_regex in cases:
            with self.subTest(report_id=report_id), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                card_path = root / "card.json"
                out_dir = root / "reports"

                class MalformedVariantSimulator:
                    def __call__(self, **kwargs: Any) -> JsonObject:
                        return {
                            "type": "screeps-rl-simulator-run",
                            "runId": kwargs["run_id"],
                            "liveEffect": False,
                            "officialMmoWrites": False,
                            "variants": variants,
                        }

                write_json(card_path, base_card())
                with self.assertRaisesRegex(RuntimeError, message_regex):
                    runner.run_training_experiment(
                        card_path,
                        out_dir,
                        report_id=report_id,
                        simulator_runner=MalformedVariantSimulator(),
                    )

                self.assertFalse((out_dir / f"{report_id}.json").exists())

    def test_json_report_output_format_is_shadow_report_compatible(self) -> None:
        start = tick(1, [room("W1N1", energy=100, spawn_status="idle")])
        baseline = variant_result("baseline", [start, tick(2, [room("W1N1", energy=200, spawn_status="spawning")])])
        candidate = variant_result("candidate", [start, tick(2, [room("W1N1", energy=250, hostile_kills=2)])])
        simulator = MockSimulator({"baseline": baseline, "candidate": candidate})

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            write_json(card_path, base_card())
            report = runner.run_training_experiment(
                card_path,
                out_dir,
                report_id="format-check",
                simulator_runner=simulator,
            )
            persisted = read_json(out_dir / "format-check.json")

        self.assertEqual(persisted["type"], "screeps-rl-training-report")
        self.assertEqual(persisted["schemaVersion"], 1)
        self.assertFalse(persisted["liveEffect"])
        self.assertFalse(persisted["officialMmoWrites"])
        self.assertFalse(persisted["safety"]["liveApiCalls"])
        self.assertTrue(persisted["safety"]["conservative_actions_only"])
        self.assertTrue(persisted["safety"]["ood_rejection"])
        self.assertEqual(persisted["rewardModel"]["componentOrder"], ["reliability", "territory", "resources", "kills"])
        self.assertEqual(persisted["variantResults"][0]["reward"]["componentOrder"], ["reliability", "territory", "resources", "kills"])
        self.assertEqual(persisted["kpiSummary"]["reliability"]["score"], 1)
        self.assertEqual(persisted["candidateStrategyIds"], ["baseline", "candidate"])
        self.assertEqual(persisted["incumbentStrategyIds"], ["baseline"])
        self.assertIn("modelReports", persisted)
        self.assertIn("kpiSummary", persisted)
        self.assertIn("statisticalComparison", persisted)
        self.assertTrue(str(report["reportPath"]).endswith("reports/format-check.json"))
        self.assertEqual(simulator.calls[0]["ticks"], 2)
        self.assertEqual(simulator.calls[0]["variants"], ["baseline", "candidate"])

    def test_policy_gradient_report_preserves_candidate_parameter_evidence(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-report",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T00:25:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        start = tick(1, [room("W1N1", energy=100)])
        simulator = MockSimulator({
            variant_id: variant_result(variant_id, [start, tick(2, [room("W1N1", energy=200)])])
            for variant_id in variant_ids
        })

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="policy-gradient-evidence",
                simulator_runner=simulator,
            )

        self.assertEqual(report["experimentCard"]["trainingApproach"], "policy_gradient")
        self.assertEqual(report["policyGradient"]["target_family"], "construction-priority")
        self.assertEqual(report["policyUpdateAlgorithm"], runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM)
        self.assertTrue(report["trueGradient"])
        self.assertFalse(report["policyGradient"]["runner_support"]["inline_candidates_applied_to_simulator"])
        self.assertTrue(report["policyGradient"]["runner_support"]["report_preserves_candidate_parameters"])
        self.assertEqual(simulator.calls[0]["ticks"], 500)
        self.assertEqual(simulator.calls[0]["variants"], variant_ids)
        self.assertEqual(
            [variant["candidatePolicyId"] for variant in report["strategyVariants"]],
            [candidate["candidatePolicyId"] for candidate in card["policy_gradient"]["candidate_parameter_vectors"]],
        )
        first_result = report["variantResults"][0]
        self.assertEqual(first_result["candidatePolicyId"], "construction-priority.pg.incumbent-seed.v1")
        self.assertEqual(
            set(first_result["parameters"]),
            {
                "baseScoreWeight",
                "territorySignalWeight",
                "resourceSignalWeight",
                "killSignalWeight",
                "riskPenalty",
            },
        )
        self.assertEqual(first_result["parameterEvidence"]["sourceStrategyId"], "construction-priority.incumbent.v1")

    def test_policy_reward_tuple_aggregation_weights_by_sample_count(self) -> None:
        self.assertEqual(
            runner.aggregate_policy_reward_tuple(
                [
                    {"sampleCount": 20, "reward": {"tuple": [1, 10, 100, 0]}},
                    {"sampleCount": 1, "reward": {"tuple": [0, 110, 0, 10]}},
                ]
            ),
            [0.952381, 14.761905, 95.238095, 0.47619],
        )
        self.assertEqual(
            runner.aggregate_policy_reward_tuple(
                [
                    {"reward": {"tuple": [1, 2, 3, 4]}},
                    {"sampleCount": "invalid", "reward": {"tuple": [3, 4, 5, 6]}},
                    {"sampleCount": 0, "reward": {"tuple": [100, 100, 100, 100]}},
                ]
            ),
            [2, 3, 4, 5],
        )
        self.assertEqual(
            runner.aggregate_policy_reward_tuple([{"sampleCount": 0, "reward": {"tuple": [1, 2, 3, 4]}}]),
            [0, 0, 0, 0],
        )

    def test_policy_update_candidate_rows_accepts_evaluated_parameters_field(self) -> None:
        parameter_space = {"knob": {"min": 0, "max": 10}}
        rows = runner.policy_update_candidate_rows(
            {
                "candidate_parameter_vectors": [
                    {
                        "candidatePolicyId": "candidate",
                        "strategyVariantId": "candidate",
                        "parameters": {"knob": 4.2},
                    },
                ]
            },
            [
                {
                    "variantId": "candidate",
                    "sampleCount": 1,
                    "evaluatedParameters": {"knob": 4.2},
                    "reward": {"tuple": [1, 0, 0, 0]},
                }
            ],
            parameter_space,
        )

        self.assertEqual(rows[0]["parameters"], {"knob": 4.2})

    def test_policy_update_candidate_rows_uses_reward_weight_defaults_for_sample_count(self) -> None:
        parameter_space = {"knob": {"min": 0, "max": 10}}
        rows = runner.policy_update_candidate_rows(
            {
                "candidate_parameter_vectors": [
                    {
                        "candidatePolicyId": "candidate",
                        "strategyVariantId": "candidate",
                        "parameters": {"knob": 4.2},
                    },
                ]
            },
            [
                {
                    "variantId": "candidate.scale-env-01",
                    "evaluatedParameters": {"knob": 4.2},
                    "reward": {"tuple": [1, 2, 3, 4]},
                },
                {
                    "variantId": "candidate.scale-env-02",
                    "sampleCount": "invalid",
                    "evaluatedParameters": {"knob": 4.2},
                    "reward": {"tuple": [3, 4, 5, 6]},
                },
                {
                    "variantId": "candidate.scale-env-03",
                    "sampleCount": -7,
                    "evaluatedParameters": {"knob": 4.2},
                    "reward": {"tuple": [5, 6, 7, 8]},
                },
                {
                    "variantId": "candidate.scale-env-04",
                    "sampleCount": 2,
                    "evaluatedParameters": {"knob": 4.2},
                    "reward": {"tuple": [9, 10, 11, 12]},
                },
                {
                    "variantId": "candidate.scale-env-05",
                    "sampleCount": 0,
                    "evaluatedParameters": {"knob": 4.2},
                    "reward": {"tuple": [100, 100, 100, 100]},
                },
                {
                    "variantId": "candidate.scale-env-06",
                    "sampleCount": 100,
                    "evaluatedParameters": {"knob": 4.2},
                    "reward": {"tuple": [1000]},
                },
            ],
            parameter_space,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["sampleCount"], 5)
        self.assertEqual(rows[0]["rewardTuple"], [5.4, 6.4, 7.4, 8.4])
        self.assertEqual(
            rows[0]["resultVariantIds"],
            [
                "candidate.scale-env-01",
                "candidate.scale-env-02",
                "candidate.scale-env-03",
                "candidate.scale-env-04",
                "candidate.scale-env-05",
            ],
        )

    def test_policy_gradient_noop_update_preserves_structured_skip_evidence(self) -> None:
        policy_gradient = {
            "targetFamily": "test-family",
            "policyUpdate": {"algorithm": runner.RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM},
            "learnableParameters": [{"name": "territorySignalWeight", "min": 0, "max": 5}],
            "candidateParameterVectors": [
                {
                    "candidatePolicyId": "candidate-a",
                    "strategyVariantId": "variant-a",
                    "rolloutStatus": "incumbent",
                    "parameters": {"territorySignalWeight": 1.0},
                },
                {
                    "candidatePolicyId": "candidate-b",
                    "strategyVariantId": "variant-b",
                    "rolloutStatus": "shadow",
                    "parameters": {"territorySignalWeight": 2.0},
                },
            ],
        }
        results = [
            {
                "variantId": "variant-a",
                "sampleCount": 1,
                "reward": {"tuple": [1, 0, 0, 0]},
                "parameters": {"territorySignalWeight": 1.0},
            },
            {
                "variantId": "variant-b",
                "sampleCount": 1,
                "reward": {"tuple": [1, 0, 0, 0]},
                "parameters": {"territorySignalWeight": 2.0},
            },
        ]

        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=results,
            report_id="policy-gradient-noop",
            generated_at="2026-05-17T03:30:00Z",
        )

        self.assertEqual(update["iterations"], 0)
        self.assertEqual(update["skippedReason"], "no_nonzero_reward_advantage")
        self.assertEqual(update["candidateCount"], 2)
        self.assertEqual(update["anchor"]["candidatePolicyId"], "candidate-a")
        self.assertEqual(len(update["candidateRewards"]), 2)
        self.assertFalse(update["liveEffect"])
        self.assertFalse(update["officialMmoWrites"])
        self.assertFalse(update["officialMmoWritesAllowed"])
        self.assertFalse(update["safety"]["liveEffect"])
        self.assertNotIn("nextCandidatePolicy", update)
        self.assertNotIn("updatedParameters", update)
        self.assertNotIn("parameterDelta", update)

    def test_reinforce_true_gradient_consumes_returns_and_persists_candidate_update(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-reinforce",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T05:25:00Z",
            simulation_ticks=100,
            simulation_repetitions=2,
        )
        card["policy_gradient"]["policy_update"] = {
            "algorithm": runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
            "learning_rate": 1,
        }
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        start = tick(1, [room("W1N1", energy=100)])
        simulator_results: dict[str, JsonObject] = {}
        for variant_id in variant_ids:
            if variant_id.endswith("territory-seed.v1"):
                simulator_results[variant_id] = variant_result(
                    variant_id,
                    [start, tick(2, [room("W1N1", energy=150), room("W1N2", energy=100)])],
                )
            elif variant_id.endswith("resource-seed.v1"):
                simulator_results[variant_id] = variant_result(
                    variant_id,
                    [start, tick(2, [room("W1N1", energy=2400, harvested=1000)])],
                )
            else:
                simulator_results[variant_id] = variant_result(
                    variant_id,
                    [start, tick(2, [room("W1N1", energy=200)])],
                )
        simulator = MockSimulator(simulator_results)

        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.dict(os.environ, {}, clear=True):
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                out_dir,
                report_id="policy-gradient-reinforce",
                generated_at="2026-05-17T05:30:00Z",
                simulator_runner=simulator,
            )
            persisted = read_json(out_dir / "policy-gradient-reinforce.json")
            artifact = read_json(Path(report["policyUpdateArtifactPath"]))

            self.assertNotIn("STEAM_KEY", os.environ)

        self.assertEqual(len(simulator.calls), 2)
        self.assertTrue(all(call["variants"] == variant_ids for call in simulator.calls))
        self.assertEqual(report["policyUpdateIterations"], 1)
        self.assertEqual(persisted["policyUpdateIterations"], 1)
        self.assertEqual(report["policyUpdateAlgorithm"], runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM)
        self.assertEqual(persisted["policyUpdateAlgorithm"], runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM)
        self.assertTrue(report["trueGradient"])
        self.assertTrue(persisted["trueGradient"])
        self.assertEqual(report["policyUpdateCandidatePolicyId"], artifact["candidatePolicyId"])
        update = report["policyUpdate"]
        self.assertEqual(update["algorithm"], runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM)
        self.assertEqual(update["policyUpdateAlgorithm"], runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM)
        self.assertTrue(update["trueGradient"])
        self.assertEqual(update["policyGradientEstimator"], "score_function_reinforce_v1")
        self.assertEqual(update["returnSummary"]["type"], "monte_carlo_reward_tuple_returns")
        self.assertEqual(update["returnSummary"]["sampleCount"], 8)
        self.assertEqual(update["returnSummary"]["baselineType"], "mean_return")
        self.assertTrue(all(item["returnSampleCount"] == 2 for item in update["returnSummary"]["candidateReturns"]))
        self.assertIn("territorySignalWeight", update["gradientByRewardTier"])
        self.assertTrue(any(float(value) != 0 for value in update["parameterDelta"].values()))
        self.assertEqual(artifact["sourcePolicyUpdateAlgorithm"], runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM)
        self.assertEqual(artifact["policyUpdateAlgorithm"], runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM)
        self.assertTrue(artifact["trueGradient"])
        self.assertTrue(artifact["parameterEvidence"]["trueGradient"])
        self.assertEqual(artifact["parameterEvidence"]["returnSampleCount"], 8)
        self.assertEqual(artifact["parameterEvidence"]["returnBaseline"], update["returnSummary"]["baseline"])

    def test_loop_a_true_gradient_card_takes_bounded_step_on_small_safe_advantage(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-loop-a-true-gradient-proof",
            code_commit="9" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T05:25:00Z",
            simulation_repetitions=1,
            loop_a_card_supply=True,
        )
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]

        def result_for(variant_id: str) -> JsonObject:
            result = variant_result(variant_id, [])
            result["metrics"] = {
                "territoryDelta": 0.4 if variant_id.endswith("territory-seed.v1") else 0,
                "storedEnergyDelta": 0,
                "collectedEnergy": 0,
                "hostileKills": 0,
                "ownLosses": 0,
                "initialRoomStates": {
                    "E1S1": room("E1S1", spawns=1, creeps=1, energy=100),
                },
                "finalRoomStates": {
                    "E1S1": room("E1S1", spawns=1, creeps=1, energy=100),
                },
            }
            return result

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                out_dir,
                report_id="loop-a-true-gradient-proof",
                generated_at="2026-05-18T05:30:00Z",
                simulator_runner=MockSimulator({variant_id: result_for(variant_id) for variant_id in variant_ids}),
            )
            persisted = read_json(out_dir / "loop-a-true-gradient-proof.json")
            artifact = read_json(Path(report["policyUpdateArtifactPath"]))

        self.assertEqual(report["policyUpdateIterations"], 1)
        self.assertEqual(persisted["policyUpdateIterations"], 1)
        self.assertEqual(report["policyUpdateAlgorithm"], runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM)
        self.assertTrue(report["trueGradient"])
        self.assertEqual(report["policyGradient"]["policy_update"]["learning_rate"], 1)
        update = report["policyUpdate"]
        self.assertEqual(update["iterations"], 1)
        self.assertEqual(update["policyUpdateAlgorithm"], runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM)
        self.assertTrue(update["trueGradient"])
        self.assertEqual(update["learningRate"], 1)
        self.assertEqual(update["selectedRewardTierByParameter"]["territorySignalWeight"], "territory")
        self.assertEqual(update["parameterDelta"]["territorySignalWeight"], 1)
        self.assertFalse(update["liveEffect"])
        self.assertFalse(update["officialMmoWrites"])
        self.assertFalse(update["officialMmoWritesAllowed"])
        self.assertEqual(artifact["candidatePolicyId"], report["policyUpdateCandidatePolicyId"])
        self.assertEqual(artifact["parameters"], update["updatedParameters"])
        self.assertTrue(artifact["trueGradient"])
        self.assertFalse(artifact["officialMmoWrites"])

    def test_policy_gradient_computes_and_persists_bounded_policy_update(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-update",
            code_commit="d" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T03:25:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
        card["policy_gradient"]["policy_update"] = {
            "algorithm": runner.RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM,
        }
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        start = tick(1, [room("W1N1", energy=100)])
        simulator_results: dict[str, JsonObject] = {}
        for variant_id in variant_ids:
            if variant_id.endswith("territory-seed.v1"):
                simulator_results[variant_id] = variant_result(
                    variant_id,
                    [start, tick(2, [room("W1N1", energy=150), room("W1N2", energy=100)])],
                )
            elif variant_id.endswith("resource-seed.v1"):
                simulator_results[variant_id] = variant_result(
                    variant_id,
                    [start, tick(2, [room("W1N1", energy=1800, harvested=900)])],
                )
            else:
                simulator_results[variant_id] = variant_result(
                    variant_id,
                    [start, tick(2, [room("W1N1", energy=200)])],
                )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                out_dir,
                report_id="policy-gradient-update",
                generated_at="2026-05-17T03:30:00Z",
                simulator_runner=MockSimulator(simulator_results),
            )
            persisted = read_json(out_dir / "policy-gradient-update.json")
            artifact_path = Path(report["policyUpdateArtifactPath"])
            artifact = read_json(artifact_path)

        self.assertEqual(report["policyUpdateIterations"], 1)
        self.assertEqual(persisted["policyUpdateIterations"], 1)
        self.assertEqual(report["policyUpdateAlgorithm"], runner.RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM)
        self.assertFalse(report["trueGradient"])
        update = report["policyUpdate"]
        self.assertEqual(update["iterations"], 1)
        self.assertEqual(update["algorithm"], runner.RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM)
        self.assertEqual(update["policyUpdateAlgorithm"], runner.RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM)
        self.assertFalse(update["trueGradient"])
        self.assertFalse(update["liveEffect"])
        self.assertFalse(update["officialMmoWrites"])
        self.assertFalse(update["officialMmoWritesAllowed"])
        self.assertGreater(
            update["updatedParameters"]["territorySignalWeight"],
            update["anchor"]["parameters"]["territorySignalWeight"],
        )
        self.assertTrue(any(float(value) != 0 for value in update["parameterDelta"].values()))
        for name, spec in update["parameterSpace"].items():
            self.assertGreaterEqual(update["updatedParameters"][name], spec["min"])
            self.assertLessEqual(update["updatedParameters"][name], spec["max"])
        self.assertEqual(artifact["parameters"], update["updatedParameters"])
        self.assertEqual(artifact["policyUpdateIterations"], 1)
        self.assertEqual(artifact["sourceReportId"], "policy-gradient-update")
        self.assertEqual(artifact["sourcePolicyUpdateAlgorithm"], runner.RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM)
        self.assertFalse(artifact["trueGradient"])
        self.assertFalse(artifact["liveEffect"])
        self.assertFalse(artifact["officialMmoWrites"])
        self.assertFalse(artifact["officialMmoWritesAllowed"])
        self.assertFalse(artifact["safety"]["liveEffect"])
        self.assertFalse(artifact["safety"]["officialMmoWrites"])

    def test_policy_gradient_rejects_card_and_evaluated_parameter_drift(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-drift",
            code_commit="e" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T04:25:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        drifted_variant = card["strategy_variants"][1]
        drifted_variant["parameters"] = {
            **drifted_variant["parameters"],
            "territorySignalWeight": drifted_variant["parameters"]["territorySignalWeight"] - 1,
        }
        start = tick(1, [room("W1N1", energy=100)])
        simulator_results = {
            variant_id: variant_result(variant_id, [start, tick(2, [room("W1N1", energy=200)])])
            for variant_id in variant_ids
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)

            with self.assertRaisesRegex(runner.TrainingCardError, "drift from evaluated parameters"):
                runner.run_training_experiment(
                    card_path,
                    root / "reports",
                    report_id="policy-gradient-drift",
                    simulator_runner=MockSimulator(simulator_results),
                )

    def test_loop_a_supply_report_preserves_card_supply_and_is_discoverably_consumed(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-loop-a-runner-report",
            code_commit="c" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T02:25:00Z",
            simulation_repetitions=1,
            loop_a_card_supply=True,
        )
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        start = tick(1, [room("W1N1", energy=100)])
        simulator = MockSimulator({
            variant_id: variant_result(variant_id, [start, tick(2, [room("W1N1", energy=200)])])
            for variant_id in variant_ids
        })

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_dir = root / "cards"
            report_dir = root / "reports"
            card_dir.mkdir()
            card_path = card_dir / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                report_dir,
                report_id="loop-a-supply-report",
                simulator_runner=simulator,
            )
            selected_after_report = card_helper.select_loop_a_card_supply(card_dir, report_dir)

        self.assertEqual(report["experimentCard"]["status"], "shadow")
        self.assertEqual(report["experimentCard"]["cardSupply"]["state"], "available")
        self.assertEqual(report["experimentCard"]["cardSupply"]["consumer"], "loop-a-policy-gradient")
        self.assertIsNone(selected_after_report)
        self.assertFalse(report["liveEffect"])
        self.assertFalse(report["officialMmoWrites"])
        self.assertFalse(report["officialMmoWritesAllowed"])
        self.assertTrue(report["safety"]["conservative_actions_only"])
        self.assertTrue(report["safety"]["ood_rejection"])
        self.assertEqual(report["rewardModel"]["componentOrder"], ["reliability", "territory", "resources", "kills"])
        self.assertFalse(report["rewardModel"]["scalarWeightedSumAuthorized"])

    def test_loop_a_available_supply_requires_policy_gradient(self) -> None:
        card = base_card()
        card["card_supply"] = {
            "type": "screeps-rl-loop-a-card-supply",
            "consumer": "loop-a-policy-gradient",
            "state": "available",
            "available_for_training": True,
            "dataset_run_id": card["dataset_run_id"],
            "training_approach": card["training_approach"],
            "created_at": "2026-05-17T02:25:00Z",
            "status_field": "status",
            "safety_status": "shadow",
            "consumed_at": None,
            "consumed_by_report_id": None,
        }

        with self.assertRaisesRegex(
            runner.TrainingCardError,
            "available Loop A card supply requires training_approach=policy_gradient",
        ):
            runner.validate_experiment_card(card)

    def test_report_id_with_dots_is_normalized_for_simulator_run_id(self) -> None:
        start = tick(1, [room("W1N1", energy=100)])
        baseline = variant_result("baseline", [start, tick(2, [room("W1N1", energy=200)])])
        candidate = variant_result("candidate", [start, tick(2, [room("W1N1", energy=250)])])
        simulator = MockSimulator({"baseline": baseline, "candidate": candidate})

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, base_card())
            runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="rl.exp.with.dots",
                simulator_runner=simulator,
            )

        self.assertEqual(simulator.calls[0]["run_id"], "rl_exp_with_dots")

    def test_repetitions_use_disjoint_run_ids_and_host_port_ranges(self) -> None:
        start = tick(1, [room("W1N1", energy=100)])
        baseline = variant_result("baseline", [start, tick(2, [room("W1N1", energy=200)])])
        candidate = variant_result("candidate", [start, tick(2, [room("W1N1", energy=250)])])
        simulator = MockSimulator({"baseline": baseline, "candidate": candidate})

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            card = base_card()
            card["simulation"]["workers"] = 2
            card["simulation"]["repetitions"] = 3
            card["simulation"]["host_port_start"] = 24125
            write_json(card_path, card)
            runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="multi-rep-ports",
                simulator_runner=simulator,
            )

        self.assertEqual([call["run_id"] for call in simulator.calls], ["multi-rep-ports-r01", "multi-rep-ports-r02", "multi-rep-ports-r03"])
        self.assertEqual([call["host_port_start"] for call in simulator.calls], [24125, 24133, 24141])
        attempts_per_run = 1 + runner.simulator_harness.RUN_BROKEN_PIPE_MAX_RETRIES
        repetition_port_width = 2 * runner.simulator_harness.RUN_HTTP_PORT_STEP * attempts_per_run
        reserved_ports_by_repetition = [
            set(range(call["host_port_start"], call["host_port_start"] + repetition_port_width))
            for call in simulator.calls
        ]
        self.assertEqual([max(ports) for ports in reserved_ports_by_repetition], [24132, 24140, 24148])
        for left_index, left_ports in enumerate(reserved_ports_by_repetition):
            for right_ports in reserved_ports_by_repetition[left_index + 1 :]:
                self.assertTrue(left_ports.isdisjoint(right_ports))

    def test_scale_environment_expansion_deep_copies_nested_variant_parameters(self) -> None:
        base = runner.StrategyVariant(
            id="baseline",
            parameters={"nested": {"threshold": 1}, "weights": [1, 2]},
            title="Baseline",
        )

        expanded = runner.expand_scale_environment_strategy_variants([base], 2)
        expanded[0].parameters["nested"]["threshold"] = 99
        expanded[0].parameters["weights"].append(3)

        self.assertEqual([variant.id for variant in expanded], ["baseline.scale-env-01", "baseline.scale-env-02"])
        self.assertEqual(base.parameters, {"nested": {"threshold": 1}, "weights": [1, 2]})
        self.assertEqual(expanded[1].parameters, {"nested": {"threshold": 1}, "weights": [1, 2]})

    def test_scale_validation_deduplicates_environment_slots_per_run(self) -> None:
        card = base_card(["baseline"])
        card["simulation"]["scale_environments"] = 3
        config = runner.simulation_config_from_card(card)

        summary = runner.build_scale_validation_summary(
            [
                {
                    "runId": "explicit-env-run",
                    "variants": [
                        {"variant_id": "a", "environmentId": "env-a", "ok": False},
                        {"variant_id": "b", "environmentId": "env-a", "ok": True},
                        {"variant_id": "c", "environmentId": "env-b", "ok": True},
                        {"variant_id": "d", "environmentId": "env-c", "ok": True},
                        {"variant_id": "e", "environmentId": "env-c", "ok": False},
                    ],
                },
                {
                    "runId": "variant-id-fallback-run",
                    "variants": [
                        {"variant_id": "baseline.scale-env-01", "ok": False},
                        {"variant_id": "baseline.scale-env-01", "ok": True},
                        {"variant_id": "baseline.scale-env-02", "ok": False},
                        {"variant_id": "baseline.scale-env-03", "ok": True},
                        {"variant_id": "baseline.scale-env-03", "ok": False},
                    ],
                },
            ],
            config,
        )

        self.assertIsNotNone(summary)
        assert summary is not None
        self.assertFalse(summary["ok"])
        self.assertEqual(summary["totalEnvironments"], 6)
        self.assertEqual(summary["successfulEnvironments"], 5)
        self.assertEqual(summary["failedEnvironments"], 1)
        self.assertEqual(summary["minimumSuccessfulEnvironments"], 3)
        self.assertEqual(summary["perRun"][0]["totalEnvironments"], 3)
        self.assertEqual(summary["perRun"][0]["successfulEnvironments"], 3)
        self.assertTrue(summary["perRun"][0]["ok"])
        self.assertEqual(summary["perRun"][1]["totalEnvironments"], 3)
        self.assertEqual(summary["perRun"][1]["successfulEnvironments"], 2)
        self.assertFalse(summary["perRun"][1]["ok"])

    def test_scale_environment_card_expands_variants_and_records_success_threshold(self) -> None:
        expanded_ids = runner.simulator_harness.expand_scale_environment_variants(["baseline", "candidate"], 5)
        start = tick(1, [room("W1N1", energy=100)])
        simulator = MockSimulator({
            variant_id: variant_result(variant_id, [start, tick(2, [room("W1N1", energy=200)])])
            for variant_id in expanded_ids
        })

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            card = base_card()
            card["simulation"]["workers"] = 5
            card["simulation"]["scale_environments"] = 5
            card["simulation"]["min_concurrent_environments"] = 5
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="scale-env-proof",
                simulator_runner=simulator,
            )

        self.assertEqual(simulator.calls[0]["variants"], expanded_ids)
        self.assertEqual(simulator.calls[0]["workers"], 5)
        self.assertEqual(simulator.calls[0]["min_concurrent_environments"], 5)
        self.assertTrue(report["scaleValidation"]["ok"])
        self.assertEqual(report["scaleValidation"]["minimumSuccessfulEnvironments"], 4)
        self.assertEqual(report["scaleValidation"]["successfulEnvironments"], 5)
        self.assertEqual(report["simulation"]["scaleEnvironments"], 5)

    def test_scale_environment_card_preserves_variants_when_scale_count_is_smaller(self) -> None:
        variant_ids = ["baseline", "candidate", "expansion", "defense", "economy", "remote"]
        start = tick(1, [room("W1N1", energy=100)])
        simulator = MockSimulator({
            variant_id: variant_result(variant_id, [start, tick(2, [room("W1N1", energy=200 + index)])])
            for index, variant_id in enumerate(variant_ids)
        })

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            card = base_card(variant_ids)
            card["simulation"]["workers"] = 5
            card["simulation"]["scale_environments"] = 5
            card["simulation"]["min_concurrent_environments"] = 5
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="scale-env-preserves-all-variants",
                simulator_runner=simulator,
            )

        self.assertEqual(simulator.calls[0]["variants"], variant_ids)
        self.assertEqual(simulator.calls[0]["workers"], 5)
        self.assertEqual([result["variantId"] for result in report["variantResults"]], variant_ids)
        self.assertEqual({item["variantId"] for item in report["ranking"]}, set(variant_ids))
        self.assertTrue(report["scaleValidation"]["ok"])
        self.assertEqual(report["scaleValidation"]["targetEnvironments"], 5)
        self.assertEqual(report["scaleValidation"]["totalEnvironments"], len(variant_ids))

    def test_unsafe_simulator_flags_fail_before_report_is_persisted(self) -> None:
        start = tick(1, [room("W1N1", energy=100)])
        baseline = variant_result("baseline", [start, tick(2, [room("W1N1", energy=200)])])
        candidate = variant_result("candidate", [start, tick(2, [room("W1N1", energy=250)])])

        for unsafe_field in ("liveEffect", "officialMmoWritesAllowed", "official_mmo_writes_allowed"):
            with self.subTest(unsafe_field=unsafe_field), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                card_path = root / "card.json"
                out_dir = root / "reports"
                report_id = f"unsafe-{unsafe_field}"

                class UnsafeSimulator(MockSimulator):
                    def __call__(self, **kwargs: Any) -> JsonObject:
                        result = super().__call__(**kwargs)
                        result[unsafe_field] = True
                        return result

                write_json(card_path, base_card())
                with self.assertRaisesRegex(RuntimeError, f"{unsafe_field}=true"):
                    runner.run_training_experiment(
                        card_path,
                        out_dir,
                        report_id=report_id,
                        simulator_runner=UnsafeSimulator({"baseline": baseline, "candidate": candidate}),
                    )

                self.assertFalse((out_dir / f"{report_id}.json").exists())

    def test_final_report_secret_scan_includes_steam_key_variant_errors(self) -> None:
        secret = "steam-secret-token-123456"
        start = tick(1, [room("W1N1", energy=100)])
        baseline = variant_result("baseline", [start, tick(2, [room("W1N1", energy=200)])])
        failed_candidate = variant_result("candidate", [])
        failed_candidate["ok"] = False
        failed_candidate["error"] = f"simulator echoed {secret}"

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            write_json(card_path, base_card())
            with (
                mock.patch.dict(os.environ, {"STEAM_KEY": secret}),
                mock.patch.object(runner.dataset_export, "configured_secret_values", return_value=[]),
                self.assertRaisesRegex(RuntimeError, "configured secret"),
            ):
                runner.run_training_experiment(
                    card_path,
                    out_dir,
                    report_id="steam-key-error-leak",
                    simulator_runner=MockSimulator({"baseline": baseline, "candidate": failed_candidate}),
                )

            self.assertFalse((out_dir / "steam-key-error-leak.json").exists())


if __name__ == "__main__":
    unittest.main()
