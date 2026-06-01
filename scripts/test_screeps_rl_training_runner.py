#!/usr/bin/env python3
from __future__ import annotations

import io
import copy
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


def reinforce_stability_policy_gradient() -> JsonObject:
    return {
        "targetFamily": "test-family",
        "policyUpdate": {
            "algorithm": runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
            "learning_rate": 1,
        },
        "runner_support": {
            "runtime_parameter_injection": True,
            "inline_candidates_runtime_injected": True,
            "candidate_parameter_scope": "runtime_injected",
            "simulator_variant_transport": "variant_ids_with_runtime_injected_parameters",
            "policy_update_reward_use": "eligible_with_evaluated_runtime_parameters",
            "runtime_parameter_consumption_status": "consumed",
        },
        "learnableParameters": [{"name": "territorySignalWeight", "min": 0, "max": 30, "step": 1}],
        "candidateParameterVectors": [
            {
                "candidatePolicyId": "candidate-a",
                "strategyVariantId": "variant-a",
                "rolloutStatus": "incumbent",
                "parameters": {"territorySignalWeight": 6.0},
            },
            {
                "candidatePolicyId": "candidate-b",
                "strategyVariantId": "variant-b",
                "rolloutStatus": "shadow",
                "parameters": {"territorySignalWeight": 8.0},
            },
        ],
    }


def reinforce_stability_results(candidate_returns: list[list[int | float]]) -> list[JsonObject]:
    anchor_returns = [[1, 0, 0, 0] for _index in range(len(candidate_returns))]
    return [
        {
            "variantId": "variant-a",
            "sampleCount": len(anchor_returns),
            "reward": {"tuple": [1, 0, 0, 0], "samples": anchor_returns},
            "evaluatedParameters": {"territorySignalWeight": 6.0},
        },
        {
            "variantId": "variant-b",
            "sampleCount": len(candidate_returns),
            "reward": {
                "tuple": runner.mean_policy_return_tuple(candidate_returns),
                "samples": candidate_returns,
            },
            "evaluatedParameters": {"territorySignalWeight": 8.0},
        },
    ]


def scalar_gradient_scheme_identity(policy_gradient: JsonObject | None = None) -> JsonObject:
    policy_gradient = policy_gradient or reinforce_stability_policy_gradient()
    return runner.policy_update_scalar_gradient_scheme_identity(
        runner.policy_update_scalar_reward_weight_evidence(policy_gradient)
    )


def lexicographic_reinforce_gradient_scheme_identity() -> JsonObject:
    return runner.policy_update_lexicographic_reinforce_gradient_scheme_identity()


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
    def __init__(
        self,
        results_by_variant: dict[str, JsonObject],
        *,
        inject_runtime_parameters: bool = False,
        include_evaluated_parameters: bool = True,
        include_runtime_consumption_evidence: bool = True,
        include_runtime_consumption_parameters: bool = True,
        include_direct_game_loop_consumption_evidence: bool = False,
        include_active_code_direct_consumption_evidence: bool = False,
        evaluated_parameters_by_variant: dict[str, JsonObject] | None = None,
        js_runtime_numeric_canonicalization: bool = False,
    ) -> None:
        self.results_by_variant = results_by_variant
        self.inject_runtime_parameters = inject_runtime_parameters
        self.include_evaluated_parameters = include_evaluated_parameters
        self.include_runtime_consumption_evidence = include_runtime_consumption_evidence
        self.include_runtime_consumption_parameters = include_runtime_consumption_parameters
        self.include_direct_game_loop_consumption_evidence = include_direct_game_loop_consumption_evidence
        self.include_active_code_direct_consumption_evidence = include_active_code_direct_consumption_evidence
        self.evaluated_parameters_by_variant = evaluated_parameters_by_variant or {}
        self.js_runtime_numeric_canonicalization = js_runtime_numeric_canonicalization
        self.calls: list[JsonObject] = []
        self.last_variants: list[JsonObject] = []
        self.last_uploaded_code_by_variant: dict[str, str] = {}

    def __call__(self, **kwargs: Any) -> JsonObject:
        self.calls.append(dict(kwargs))
        self.last_uploaded_code_by_variant = {}
        variants: list[JsonObject] = []
        for variant_id in kwargs["variants"]:
            result = copy.deepcopy(self.results_by_variant[variant_id])
            if self.inject_runtime_parameters:
                variant_config = runner.simulator_harness.strategy_variant_config_by_id(
                    variant_id,
                    variant_configs=kwargs["variant_configs"],
                )
                injection = runner.simulator_harness.runtime_parameter_injection_for_variant(variant_id, variant_config)
                code_text = runner.simulator_harness.apply_runtime_parameter_injection_to_code(
                    "\n".join(
                        [
                            f'var runtimePolicyConsumer = "{runner.simulator_harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";',
                            "function consumeRuntimePolicyParameters() {",
                            f"  return globalThis[{json.dumps(runner.simulator_harness.RUNTIME_PARAMETER_INJECTION_GLOBAL)}].parameters;",
                            "}",
                            "module.exports.loop = function loop() { return consumeRuntimePolicyParameters(); };",
                            "",
                        ]
                    ),
                    injection,
                )
                self.last_uploaded_code_by_variant[variant_id] = code_text
                upload_tick = None
                if self.include_active_code_direct_consumption_evidence:
                    tick_log = result.get("tick_log")
                    if isinstance(tick_log, list):
                        numeric_ticks = [
                            tick_entry.get("tick")
                            for tick_entry in tick_log
                            if isinstance(tick_entry, dict)
                            and isinstance(tick_entry.get("tick"), int)
                            and not isinstance(tick_entry.get("tick"), bool)
                        ]
                        if numeric_ticks:
                            upload_tick = min(numeric_ticks) - 1
                result["runtimeParameterInjection"] = runner.simulator_harness.mark_runtime_parameter_injection_uploaded(
                    injection,
                    code_text=code_text,
                    upload_tick=upload_tick,
                )
                if self.include_active_code_direct_consumption_evidence:
                    requested_branch = kwargs.get("branch")
                    readback_branch = runner.simulator_harness.normalize_private_server_code_branch(
                        requested_branch
                        if isinstance(requested_branch, str)
                        else runner.simulator_harness.DEFAULT_ACTIVE_WORLD_BRANCH
                    )
                    result["activeCodeReadback"] = (
                        runner.simulator_harness.private_simulator_active_code_readback_summary(
                            code_text,
                            {"branch": readback_branch, "modules": {"main": code_text}},
                            branch=readback_branch,
                            http_status=200,
                        )
                    )
                if variant_id in self.evaluated_parameters_by_variant:
                    evaluated_parameters = copy.deepcopy(self.evaluated_parameters_by_variant[variant_id])
                else:
                    parameters = variant_config.get("parameters")
                    if not isinstance(parameters, dict) or not parameters:
                        raise AssertionError(
                            f"runtime injection test expected parameters for {variant_id}, got {variant_config!r}"
                        )
                    evaluated_parameters = copy.deepcopy(parameters)
                if self.js_runtime_numeric_canonicalization:
                    evaluated_parameters = runner.simulator_harness.canonical_runtime_parameter_value(
                        evaluated_parameters
                    )
                consumption_evidence = {
                    "type": runner.simulator_harness.RUNTIME_PARAMETER_CONSUMPTION_TYPE,
                    "consumerMarker": runner.simulator_harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER,
                    "consumerVersion": runner.simulator_harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_VERSION,
                    "runtimeParameterInjection": True,
                    "consumed": True,
                    "source": "runtime_policy_parameter_consumption",
                    "strategyVariantId": variant_id,
                    "candidatePolicyId": variant_config.get("candidatePolicyId"),
                    "family": variant_config.get("family"),
                    "parameters": evaluated_parameters,
                    "parametersSha256": result["runtimeParameterInjection"].get("parametersSha256"),
                    "consumedStrategyVariantId": variant_id,
                    "consumedParametersSha256": result["runtimeParameterInjection"].get("parametersSha256"),
                    "appliedStrategyIds": [variant_id],
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                }
                tick_log = result.get("tick_log")
                if isinstance(tick_log, list) and tick_log and isinstance(tick_log[-1], dict):
                    tick_number = tick_log[-1].get("tick")
                    if isinstance(tick_number, int):
                        consumption_evidence["tick"] = tick_number
                if self.include_direct_game_loop_consumption_evidence and isinstance(tick_log, list):
                    direct_tick_evidence = {
                        **consumption_evidence,
                        "parameters": copy.deepcopy(result["runtimeParameterInjection"].get("parameters")),
                        "parametersSha256": result["runtimeParameterInjection"].get("parametersSha256"),
                        "consumedParametersSha256": result["runtimeParameterInjection"].get("parametersSha256"),
                    }
                    for tick_entry in reversed(tick_log):
                        tick_number = tick_entry.get("tick") if isinstance(tick_entry, dict) else None
                        if isinstance(tick_number, int) and not isinstance(tick_number, bool):
                            direct_tick_evidence["tick"] = tick_number
                            rooms = tick_entry.get("rooms")
                            if isinstance(rooms, dict):
                                for room_payload in rooms.values():
                                    if isinstance(room_payload, dict):
                                        room_payload["runtimeParameterConsumption"] = copy.deepcopy(
                                            direct_tick_evidence
                                        )
                                        break
                            break
                runtime_consumption = None
                if self.include_runtime_consumption_evidence:
                    runtime_consumption = runner.simulator_harness.runtime_parameter_consumption_check(
                        result["runtimeParameterInjection"],
                        consumption_evidence,
                    )
                elif (
                    self.include_direct_game_loop_consumption_evidence
                    or self.include_active_code_direct_consumption_evidence
                ):
                    runtime_consumption = runner.simulator_harness.runtime_parameter_consumption_check(
                        result["runtimeParameterInjection"],
                        None,
                    )
                if runtime_consumption is not None and (
                    self.include_direct_game_loop_consumption_evidence
                    or self.include_active_code_direct_consumption_evidence
                ):
                    runtime_consumption = (
                        runner.simulator_harness.runtime_parameter_consumption_with_direct_game_loop_fallback(
                            result["runtimeParameterInjection"],
                            runtime_consumption,
                            tick_log if isinstance(tick_log, list) else [],
                            active_code_readback=(
                                result.get("activeCodeReadback")
                                if self.include_active_code_direct_consumption_evidence
                                else None
                            ),
                        )
                    )
                if runtime_consumption is not None:
                    result["runtimeParameterConsumption"] = runtime_consumption
                    if not self.include_runtime_consumption_parameters:
                        result["runtimeParameterConsumption"].pop("evaluatedParameters", None)
                        result["runtimeParameterConsumption"].pop("evaluatedParametersSha256", None)
                if self.include_evaluated_parameters:
                    consumption = result.get("runtimeParameterConsumption")
                    if isinstance(consumption, dict) and consumption.get("runtimeParameterConsumption") is True:
                        consumed_parameters = consumption.get("evaluatedParameters")
                        result["evaluatedParameters"] = copy.deepcopy(
                            consumed_parameters if isinstance(consumed_parameters, dict) else evaluated_parameters
                        )
                        result["evaluatedParametersSource"] = "runtime_parameter_consumption"
                    elif not self.include_runtime_consumption_evidence:
                        result["evaluatedParameters"] = copy.deepcopy(evaluated_parameters)
                        result["evaluatedParametersSource"] = "runtime_parameter_consumption"
            variants.append(result)
        self.last_variants = copy.deepcopy(variants)
        return {
            "type": "screeps-rl-simulator-run",
            "runId": kwargs["run_id"],
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "variants": variants,
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
    def test_mock_simulator_resets_uploaded_code_evidence_per_call(self) -> None:
        start = tick(1, [room("W1N1", energy=100)])
        simulator = MockSimulator(
            {
                "candidate": variant_result("candidate", [start]),
                "control": variant_result("control", [start]),
            },
            inject_runtime_parameters=True,
        )
        variant_configs = {
            "candidate": runner.StrategyVariant(
                id="candidate",
                family="test-family",
                parameters={"knob": 1},
            ).to_json(),
            "control": runner.StrategyVariant(
                id="control",
                family="test-family",
                parameters={"knob": 0},
            ).to_json(),
        }

        simulator(run_id="first", variants=["candidate"], variant_configs=variant_configs)
        self.assertIn("candidate", simulator.last_uploaded_code_by_variant)

        simulator.inject_runtime_parameters = False
        simulator(run_id="second", variants=["control"], variant_configs=variant_configs)
        self.assertEqual(simulator.last_uploaded_code_by_variant, {})

    def test_runtime_parameter_hash_preserves_tiny_floats_and_mixed_keys(self) -> None:
        parameters = {
            "tinyNonZeroWeight": 1e-10,
            "integralWeight": 6.0,
            "nested": [{"tinyNonZeroWeight": -1e-10, "integralWeight": 7.0, 8: "ignored"}],
            9: "ignored",
        }

        canonical = runner.simulator_harness.canonical_runtime_parameter_value(parameters)
        parameters_hash = runner.runtime_parameter_parameters_hash(parameters)

        self.assertEqual(canonical["tinyNonZeroWeight"], 1e-10)
        self.assertNotEqual(canonical["tinyNonZeroWeight"], 0)
        self.assertIs(type(canonical["integralWeight"]), int)
        self.assertEqual(canonical["integralWeight"], 6)
        self.assertEqual(canonical["nested"][0]["tinyNonZeroWeight"], -1e-10)
        self.assertNotEqual(canonical["nested"][0]["tinyNonZeroWeight"], 0)
        self.assertIs(type(canonical["nested"][0]["integralWeight"]), int)
        self.assertEqual(canonical["nested"][0]["integralWeight"], 7)
        self.assertNotIn(9, canonical)
        self.assertNotIn(8, canonical["nested"][0])
        self.assertIsInstance(parameters_hash, str)

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

    def test_experiment_card_validation_rejects_policy_gradient_below_activation_floor(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-policy-gradient-short-horizon",
            code_commit="a" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:19:30Z",
        )
        card["simulation"]["ticks"] = runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS - 1

        with self.assertRaisesRegex(
            runner.TrainingCardError,
            f"simulation\\.ticks >= {runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS}",
        ):
            runner.validate_experiment_card(card)

    def test_experiment_card_validation_rejects_scaled_policy_gradient_under_sample_plan(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-policy-gradient-under-sampled-scale",
            code_commit="a" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:19:45Z",
            simulation_repetitions=10,
            simulation_workers=2,
            simulation_scale_environments=2,
            simulation_min_concurrent_environments=2,
        )
        card["simulation"]["repetitions"] = 10

        with self.assertRaisesRegex(
            runner.TrainingCardError,
            "planned minimum is 10 .*requires simulation\\.repetitions >= 20",
        ):
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

    def test_training_report_classifies_default_smoke_batch_scale(self) -> None:
        start = tick(1, [room("W1N1", energy=100)])
        baseline = variant_result("baseline", [start, tick(2, [room("W1N1", energy=200)])])
        candidate = variant_result("candidate", [start, tick(2, [room("W1N1", energy=250)])])

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, base_card())
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="smoke-batch-scale",
                simulator_runner=MockSimulator({"baseline": baseline, "candidate": candidate}),
            )

        self.assertEqual(report["batchScale"]["batchClass"], "smoke")
        self.assertEqual(report["batchScale"]["environmentRows"], 2)
        self.assertEqual(report["batchScale"]["simulatorTicks"], 4)
        self.assertFalse(report["batchScale"]["scaleFirstEligible"])
        self.assertEqual(runner.build_generation_summary(report)["batchScale"]["batchClass"], "smoke")

    def test_multi_tier_activation_proof_blocks_when_fixture_signal_has_no_objective_movement(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-blocked",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:21:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_V0_ID,
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
            scenario_id=card_helper.MULTI_TIER_SCENARIO_V0_ID,
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
            scenario_id=card_helper.MULTI_TIER_SCENARIO_V0_ID,
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
            scenario_id=card_helper.MULTI_TIER_SCENARIO_V0_ID,
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

    def test_multi_tier_activation_proof_blocks_post_1448_smoke_without_combat_activation(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-post-1448-blocked",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:24:30Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_V0_ID,
            require_multi_tier_scenario=True,
        )
        proof = runner.build_multi_tier_activation_proof(
            results=[
                {
                    "variantId": "construction-priority.pg.territory-seed.v1",
                    "sampleCount": 1,
                    "metrics": {
                        "territory": {"delta": 2},
                        "kills": {"hostileKills": 0},
                        "objectiveSignal": {
                            "initialObservedRoomCount": 2,
                            "finalObservedRoomCount": 2,
                            "initialHostileCreeps": 2,
                            "finalHostileCreeps": 2,
                            "initialHostileStructures": 1,
                            "finalHostileStructures": 1,
                            "initialObjectiveSignalPresent": True,
                            "finalObjectiveSignalPresent": True,
                        },
                    },
                    "multiTierActivationTraces": [
                        {
                            "sampleIndex": 0,
                            "ticksRun": 500,
                            "policyActivationPresent": True,
                            "policyActivation": {
                                "executionAction": "engage-hostiles",
                                "objectiveSignalSource": "tick_log",
                                "targetRoom": "E2S1",
                            },
                        }
                    ],
                }
            ],
            scenario=card["scenario"],
            kpi_summary={},
        )

        self.assertIsNotNone(proof)
        if proof is None:
            self.fail("expected multi-tier activation proof")
        self.assertEqual(proof["status"], "blocked")
        self.assertEqual(proof["criteria"]["territoryScoreMustExceed"], 2)
        self.assertEqual(proof["criteria"]["hostileKillsMustExceed"], 0)
        self.assertTrue(proof["transport"]["objectiveSignalObserved"])
        self.assertEqual(proof["bestObserved"]["territoryScore"], 2.0)
        self.assertEqual(proof["bestObserved"]["hostileKills"], 0.0)
        self.assertEqual(proof["blocker"]["classification"], "SIMULATOR_OBJECTIVE_SIGNAL_NOT_ACTIVATED")
        sample = proof["variants"][0]["activationSamples"][0]
        self.assertTrue(sample["objectiveSignalObserved"])
        self.assertFalse(sample["activationScorePasses"])
        self.assertFalse(sample["passesActivation"])
        trace = proof["variants"][0]["activationTraces"][0]
        self.assertEqual(trace["ticksRun"], 500)
        self.assertEqual(trace["policyActivation"]["executionAction"], "engage-hostiles")
        self.assertEqual(trace["policyActivation"]["targetRoom"], "E2S1")

    def test_multi_tier_activation_proof_reports_missing_samples_separately(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-no-samples",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:25:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_V0_ID,
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
            scenario_id=card_helper.MULTI_TIER_SCENARIO_V0_ID,
            require_multi_tier_scenario=True,
        )
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        start = tick(1, [room("E1S1", energy=100), hostile_fixture_room()])
        simulator_results: dict[str, JsonObject] = {}
        for index, variant_id in enumerate(variant_ids):
            finish = tick(
                2,
                [
                    room("E1S1", energy=150),
                    hostile_fixture_room(hostile_creeps=1 if index == 0 else 2),
                ],
            )
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

    def test_multi_tier_activation_proof_blocks_short_audit_horizon(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-short-audit",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:22:30Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_V0_ID,
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
                            "initialHostileCreeps": 2,
                            "finalHostileCreeps": 1,
                            "initialHostileStructures": 1,
                            "finalHostileStructures": 1,
                            "initialObjectiveSignalPresent": True,
                            "finalObjectiveSignalPresent": True,
                        },
                    },
                }
            ],
            scenario=card["scenario"],
            kpi_summary={},
            audit={"ticks": runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS - 1},
        )

        self.assertIsNotNone(proof)
        if proof is None:
            self.fail("expected multi-tier activation proof")
        self.assertEqual(proof["status"], "blocked")
        self.assertFalse(proof["ok"])
        self.assertEqual(proof["blocker"]["classification"], "SIMULATION_HORIZON_TOO_SHORT")
        self.assertEqual(proof["criteria"]["minimumSimulationTicks"], runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS)
        self.assertNotIn("passingVariants", proof)

    def test_multi_tier_activation_proof_derives_kills_from_observed_hostile_reduction(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-observed-reduction",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:25:30Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_V0_ID,
            require_multi_tier_scenario=True,
        )
        simulator_results: dict[str, JsonObject] = {}
        for variant in card["strategy_variants"]:
            variant_id = variant["id"]
            reduced_hostiles = variant_id == "construction-priority.pg.territory-seed.v1"
            tick_log = [
                tick(1, [room("E1S1", energy=100), hostile_fixture_room()]),
                tick(
                    2,
                    [
                        room("E1S1", energy=150),
                        hostile_fixture_room(hostile_creeps=1 if reduced_hostiles else 2),
                    ],
                ),
            ]
            result = variant_result(variant_id, tick_log)
            result["metrics"] = {"territoryDelta": 2, "hostileKills": 0, "ownLosses": 0}
            simulator_results[variant_id] = result

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="multi-tier-observed-reduction",
                simulator_runner=MockSimulator(simulator_results),
            )

        proof = report["activationProof"]
        self.assertEqual(proof["status"], "passed")
        self.assertEqual(proof["passingVariants"], ["construction-priority.pg.territory-seed.v1"])
        territory_result = next(
            result
            for result in report["variantResults"]
            if result["variantId"] == "construction-priority.pg.territory-seed.v1"
        )
        self.assertEqual(territory_result["metrics"]["kills"]["hostileKills"], 1)
        self.assertEqual(territory_result["multiTierActivationSamples"][0]["hostileKills"], 1)
        self.assertTrue(territory_result["multiTierActivationSamples"][0]["passesActivation"])
        trace = territory_result["multiTierActivationTraces"][0]
        self.assertEqual(trace["metricsSource"], "simulator_policy_activation")
        self.assertEqual(trace["policyActivation"]["objectiveSignalSource"], "tick_log")
        self.assertEqual(trace["policyActivation"]["hostileKillsSource"], "observedEvidence")
        self.assertTrue(trace["observedEvidence"]["hostileCountReduced"])

    def test_multi_tier_activation_proof_passes_with_offline_policy_activation_projection(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-projected-activation",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:26:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_V0_ID,
            require_multi_tier_scenario=True,
        )
        simulator_results: dict[str, JsonObject] = {}
        for variant in card["strategy_variants"]:
            variant_id = variant["id"]
            tick_log = [
                tick(1, [room("E1S1", energy=100)]),
                tick(2, [room("E1S1", energy=100)]),
            ]
            simulator_results[variant_id] = variant_result(variant_id, tick_log)

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="multi-tier-projected-activation",
                simulator_runner=MockSimulator(simulator_results),
            )

        proof = report["activationProof"]
        self.assertEqual(proof["status"], "passed")
        self.assertTrue(proof["ok"])
        self.assertIn("construction-priority.pg.territory-seed.v1", proof["passingVariants"])
        self.assertEqual(proof["audit"]["codeCommit"], card["code_commit"])
        self.assertEqual(proof["audit"]["scenarioId"], card["scenario"]["scenario_id"])
        self.assertEqual(proof["audit"]["activationImplementation"], runner.MULTI_TIER_ACTIVATION_IMPLEMENTATION)
        comparison_key = proof["audit"]["comparisonKey"]
        self.assertIsInstance(comparison_key, str)
        self.assertTrue(comparison_key.strip(), "comparisonKey must not be empty")
        territory_result = next(
            result
            for result in report["variantResults"]
            if result["variantId"] == "construction-priority.pg.territory-seed.v1"
        )
        self.assertEqual(territory_result["multiTierActivationSamples"][0]["hostileKills"], 1)
        self.assertTrue(territory_result["multiTierActivationSamples"][0]["passesActivation"])
        territory_trace = territory_result["multiTierActivationTraces"][0]
        self.assertEqual(territory_trace["metricsSource"], "simulator_policy_activation")
        self.assertEqual(territory_trace["policyActivation"]["objectiveSignalSource"], "offline_shadow_projection")
        self.assertEqual(territory_trace["policyActivation"]["hostileKillsSource"], "projectedEvidence")
        self.assertEqual(territory_trace["projectedEvidence"]["projectedHostileKills"], 1)
        self.assertEqual(
            proof["variants"][1]["activationTraces"][0]["policyActivation"]["targetRoom"],
            "E2S1",
        )
        self.assertEqual(
            territory_result["metrics"]["objectiveSignal"]["finalRooms"],
            ["E1S1", "E2S1"],
        )
        self.assertFalse(report["liveEffect"])
        self.assertFalse(report["officialMmoWrites"])
        self.assertFalse(report["officialMmoWritesAllowed"])

    def test_multi_tier_activation_projection_tolerates_nonfatal_evidence_warnings(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-nonfatal-evidence-warning",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:26:30Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_V0_ID,
            require_multi_tier_scenario=True,
        )
        simulator_results: dict[str, JsonObject] = {}
        for variant in card["strategy_variants"]:
            variant_id = variant["id"]
            result = variant_result(
                variant_id,
                [
                    tick(1, [room("E1S1", spawns=1, creeps=1, rcl=3, energy=300)]),
                    tick(2, [room("E1S1", spawns=1, creeps=1, rcl=3, energy=300)]),
                ],
            )
            result["metrics"] = {"territoryDelta": 0, "hostileKills": 0, "ownLosses": 4}
            result["evidenceErrors"] = ["mongo room evidence failed: no room document returned"]
            simulator_results[variant_id] = result

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="multi-tier-projected-warning",
                simulator_runner=MockSimulator(simulator_results),
            )

        proof = report["activationProof"]
        self.assertEqual(proof["status"], "passed")
        self.assertTrue(proof["ok"])
        self.assertIn("construction-priority.pg.territory-seed.v1", proof["passingVariants"])
        territory_result = next(
            result
            for result in report["variantResults"]
            if result["variantId"] == "construction-priority.pg.territory-seed.v1"
        )
        self.assertEqual(territory_result["metrics"]["kills"]["hostileKills"], 1)
        self.assertEqual(territory_result["metrics"]["kills"]["ownLosses"], 4)
        self.assertTrue(territory_result["multiTierActivationSamples"][0]["passesActivation"])
        territory_trace = territory_result["multiTierActivationTraces"][0]
        self.assertEqual(territory_trace["policyActivation"]["objectiveSignalSource"], "offline_shadow_projection")
        self.assertEqual(territory_trace["policyActivation"]["hostileKillsSource"], "projectedEvidence")
        self.assertEqual(
            territory_trace["evidenceWarnings"],
            ["mongo room evidence failed: no room document returned"],
        )
        self.assertFalse(report["liveEffect"])
        self.assertFalse(report["officialMmoWrites"])
        self.assertFalse(report["officialMmoWritesAllowed"])

    def test_multi_tier_activation_projection_reconstructs_metrics_only_runs(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-projected-metrics",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:27:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_V0_ID,
            require_multi_tier_scenario=True,
        )
        simulator_results: dict[str, JsonObject] = {}
        for variant in card["strategy_variants"]:
            variant_id = variant["id"]
            result = variant_result(
                variant_id,
                [
                    tick(1, [room("E1S1", energy=100)]),
                    tick(2, [room("E1S1", energy=100)]),
                ],
            )
            result["metrics"] = {"territoryDelta": 0, "hostileKills": 0, "ownLosses": 0}
            simulator_results[variant_id] = result

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="multi-tier-projected-metrics",
                simulator_runner=MockSimulator(simulator_results),
            )

        proof = report["activationProof"]
        self.assertEqual(proof["status"], "passed")
        territory_result = next(
            result
            for result in report["variantResults"]
            if result["variantId"] == "construction-priority.pg.territory-seed.v1"
        )
        self.assertEqual(territory_result["metrics"]["kills"]["hostileKills"], 1)
        self.assertEqual(territory_result["metrics"]["objectiveSignal"]["finalRooms"], ["E1S1", "E2S1"])
        self.assertTrue(territory_result["multiTierActivationSamples"][0]["passesActivation"])

    def test_multi_tier_activation_audit_key_includes_code_commit_for_same_scenario_map(self) -> None:
        def run_report(code_commit: str, report_id: str) -> JsonObject:
            card = card_helper.build_card(
                dataset_run_id="rl-training-multitier-audit-same-scenario-map",
                code_commit=code_commit,
                training_approach="policy_gradient",
                created_at="2026-05-18T10:28:00Z",
                scenario_id=card_helper.MULTI_TIER_SCENARIO_ID,
                require_multi_tier_scenario=True,
            )
            simulator_results: dict[str, JsonObject] = {}
            for variant in card["strategy_variants"]:
                variant_id = variant["id"]
                tick_log = [
                    tick(1, [room("E1S1", energy=100)]),
                    tick(2, [room("E1S1", energy=100)]),
                ]
                simulator_results[variant_id] = variant_result(variant_id, tick_log)
            with tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                card_path = root / "card.json"
                write_json(card_path, card)
                return runner.run_training_experiment(
                    card_path,
                    root / "reports",
                    report_id=report_id,
                    simulator_runner=MockSimulator(simulator_results),
                )

        first = run_report("a" * 40, "multi-tier-audit-a")
        second = run_report("b" * 40, "multi-tier-audit-b")

        self.assertEqual(first["scenario"]["evidence"]["map_source_file"], second["scenario"]["evidence"]["map_source_file"])
        self.assertEqual(first["activationProof"]["audit"]["scenarioId"], second["activationProof"]["audit"]["scenarioId"])
        self.assertNotEqual(first["activationProof"]["audit"]["codeCommit"], second["activationProof"]["audit"]["codeCommit"])
        self.assertNotEqual(first["activationProof"]["audit"]["comparisonKey"], second["activationProof"]["audit"]["comparisonKey"])
        self.assertEqual(
            first["activationProof"]["audit"]["strategyVariantFingerprint"],
            second["activationProof"]["audit"]["strategyVariantFingerprint"],
        )

    def test_multi_tier_fixture_loader_rejects_map_source_mismatch(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-map-mismatch",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:28:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_ID,
            require_multi_tier_scenario=True,
        )
        card["simulation"]["map_source_file"] = "scripts/fixtures/rl/not-the-same.map.json"
        config = runner.simulation_config_from_card(card)

        with self.assertRaisesRegex(
            runner.TrainingCardError,
            "multi-tier scenario evidence.map_source_file must match simulation.map_source_file",
        ):
            runner.multi_tier_policy_activation_fixture_room_summaries(card["scenario"], config)

    def test_multi_tier_report_does_not_load_fixture_map_when_existing_payload_is_complete(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-training-multitier-existing-payload",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-18T10:29:00Z",
            scenario_id=card_helper.MULTI_TIER_SCENARIO_ID,
            require_multi_tier_scenario=True,
        )
        missing_map = "scripts/fixtures/rl/missing-multi-tier.map.json"
        card["simulation"]["map_source_file"] = missing_map
        card["scenario"]["evidence"]["map_source_file"] = missing_map
        variants = runner.load_strategy_variants(card)
        simulator_run_variants: list[JsonObject] = []
        for variant in variants:
            run = variant_result(variant.id, [])
            run["policyActivation"] = {
                "type": "screeps-rl-multi-tier-policy-activation",
                "strategyVariantId": variant.id,
                "objectiveSignalObserved": True,
                "objectiveSignalSource": "simulator_payload",
                "safety": {
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                },
            }
            run["metrics"] = {"territoryDelta": 0, "hostileKills": 1, "ownLosses": 0}
            simulator_run_variants.append(run)

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with mock.patch.object(
                runner.simulator_harness,
                "_private_map_fixture_room_summaries",
                side_effect=AssertionError("fixture map should be loaded lazily"),
            ):
                report = runner.build_training_report(
                    card=card,
                    card_path=root / "card.json",
                    variants=variants,
                    config=runner.simulation_config_from_card(card),
                    simulator_runs=[
                        {
                            "type": "screeps-rl-simulator-run",
                            "runId": "existing-payload",
                            "liveEffect": False,
                            "officialMmoWrites": False,
                            "variants": simulator_run_variants,
                        }
                    ],
                    reward_options=runner.reward_options_from_card(card),
                    report_id="multi-tier-existing-payload",
                    generated_at="2026-05-18T10:29:30Z",
                )

        self.assertEqual(report["artifactCount"], len(variants))
        self.assertEqual(report["activationProof"]["fixtureEvidence"]["mapSourceFile"], missing_map)

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

    def test_inline_policy_family_is_preserved_in_report_surfaces(self) -> None:
        card = base_card()
        card["strategy_variants"][0]["policyFamily"] = "top.construction"
        card["strategy_variants"][1]["policy_family"] = "role.worker-task"
        start = tick(1, [room("W1N1", energy=100)])
        baseline = variant_result("baseline", [start, tick(2, [room("W1N1", energy=300, harvested=100)])])
        candidate = variant_result("candidate", [start, tick(2, [room("W1N1", energy=900, harvested=100)])])

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="policy-family-report",
                simulator_runner=MockSimulator({"baseline": baseline, "candidate": candidate}),
            )

        strategy_by_id = {item["id"]: item for item in report["strategyVariants"]}
        result_by_id = {item["variantId"]: item for item in report["variantResults"]}
        ranking_by_id = {item["variantId"]: item for item in report["ranking"]}
        self.assertEqual(strategy_by_id["baseline"]["policyFamily"], "top.construction")
        self.assertEqual(strategy_by_id["candidate"]["policyFamily"], "role.worker-task")
        self.assertEqual(result_by_id["baseline"]["policyFamily"], "top.construction")
        self.assertEqual(result_by_id["candidate"]["policyFamily"], "role.worker-task")
        self.assertEqual(ranking_by_id["baseline"]["policyFamily"], "top.construction")
        self.assertEqual(ranking_by_id["candidate"]["policyFamily"], "role.worker-task")
        self.assertEqual(report["policyFamilies"], ["role.worker-task", "top.construction"])
        self.assertEqual(report["modelFamilies"], ["test-family"])

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
        self.assertEqual(simulator.calls[0]["variant_configs"]["candidate"]["parameters"]["expansion_aggressiveness"], 1)

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
        simulator_results: dict[str, JsonObject] = {}
        for variant_id in variant_ids:
            if variant_id.endswith("territory-seed.v1"):
                simulator_results[variant_id] = variant_result(
                    variant_id,
                    [start, tick(2, [room("W1N1", energy=150), room("W1N2", energy=100)])],
                )
            else:
                simulator_results[variant_id] = variant_result(
                    variant_id,
                    [start, tick(2, [room("W1N1", energy=200)])],
                )
        simulator = MockSimulator(simulator_results)

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                out_dir,
                report_id="policy-gradient-evidence",
                simulator_runner=simulator,
            )
            scorecard_path = Path(report["scorecardArtifactPath"])
            scorecard_path_exists = scorecard_path.exists()
            scorecard_payload = read_json(scorecard_path)

        self.assertEqual(report["experimentCard"]["trainingApproach"], "policy_gradient")
        self.assertEqual(report["policyGradient"]["target_family"], "construction-priority")
        self.assertEqual(report["policyUpdateAlgorithm"], runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM)
        self.assertFalse(report["trueGradient"])
        self.assertEqual(report["runtimeParameterInjection"]["status"], "metadata_only")
        self.assertFalse(report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertIsNotNone(report["scorecardId"])
        self.assertEqual(report["candidateScorecard"]["status"], "materialized")
        self.assertEqual(
            report["candidateScorecard"]["classification"],
            "runtime_parameter_injection_metadata_only_scorecard_materialized",
        )
        self.assertEqual(report["candidateScorecard"]["missingPrerequisite"], "runtime_parameter_injection")
        self.assertTrue(report["candidateScorecard"]["validationScaleComputeBlocked"])
        self.assertTrue(report["candidateScorecard"]["scorecardUsable"])
        self.assertTrue(scorecard_path_exists)
        self.assertEqual(scorecard_payload["runId"], report["scorecardId"])
        self.assertFalse(
            scorecard_payload["overallGate"]["runtimeCandidateGate"]["runtimeParameterInjection"]
        )
        self.assertFalse(report["candidateScorecard"]["overallGate"]["runtimeParameterInjectionProven"])
        self.assertFalse(report["policyGradient"]["runner_support"]["inline_candidates_applied_to_simulator"])
        self.assertFalse(report["policyGradient"]["runner_support"]["runtime_parameter_injection"])
        self.assertEqual(report["policyGradient"]["runner_support"]["candidate_parameter_scope"], "metadata_only")
        self.assertEqual(
            report["policyGradient"]["runner_support"]["policy_update_reward_use"],
            "blocked_until_runtime_parameter_evidence",
        )
        self.assertTrue(report["policyGradient"]["runner_support"]["report_preserves_candidate_parameters"])
        self.assertEqual(report["policyUpdateIterations"], 0)
        self.assertEqual(report["policyUpdate"]["skippedReason"], runner.METADATA_ONLY_POLICY_UPDATE_SKIP_REASON)
        self.assertEqual(
            report["policyUpdate"]["promotionGate"]["status"],
            "blocked_runtime_parameter_injection_missing",
        )
        self.assertFalse(report["policyUpdate"]["promotionGate"]["loopAPromotionEligible"])
        self.assertFalse(report["policyUpdate"]["promotionGate"]["loopBPromotionEligible"])
        self.assertNotIn("policyUpdateArtifactPath", report)
        self.assertEqual(simulator.calls[0]["ticks"], runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS)
        self.assertEqual(simulator.calls[0]["variants"], variant_ids)
        self.assertEqual(
            simulator.calls[0]["variant_configs"]["construction-priority.pg.territory-seed.v1"]["parameters"],
            card["policy_gradient"]["candidate_parameter_vectors"][1]["parameters"],
        )
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

    def test_policy_gradient_materializes_all_candidate_vs_incumbent_scorecards(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-scorecard-set",
            code_commit="b" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T01:25:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
        card["simulation"]["scale_environments"] = 5
        card["simulation"]["min_concurrent_environments"] = 5
        expanded_variants = runner.expand_scale_environment_strategy_variants(
            runner.load_strategy_variants(card),
            5,
        )
        start = tick(1, [room("W1N1", energy=100), hostile_fixture_room()])
        simulator_results: dict[str, JsonObject] = {}
        for variant in expanded_variants:
            variant_id = variant.id
            if "territory-seed" in variant_id:
                simulator_results[variant_id] = variant_result(
                    variant_id,
                    [start, tick(2, [room("W1N1", energy=150), room("W1N2", energy=100, hostile_kills=1)])],
                )
            elif "resource-seed" in variant_id:
                simulator_results[variant_id] = variant_result(
                    variant_id,
                    [start, tick(2, [room("W1N1", energy=2400, harvested=1000), hostile_fixture_room()])],
                )
            elif "risk-aware-seed" in variant_id:
                simulator_results[variant_id] = variant_result(
                    variant_id,
                    [start, tick(2, [room("W1N1", energy=160), room("W1N2", energy=100, hostile_kills=1)])],
                )
            else:
                simulator_results[variant_id] = variant_result(
                    variant_id,
                    [start, tick(2, [room("W1N1", energy=200), hostile_fixture_room()])],
                )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                out_dir,
                report_id="policy-gradient-scorecard-set",
                simulator_runner=MockSimulator(simulator_results),
            )
            scorecard_paths_exist = [
                Path(item["scorecardArtifactPath"]).is_file()
                for item in report["candidateScorecards"]["comparisons"]
            ]

        scorecard_set = report["candidateScorecards"]
        incumbent_ids = set(report["incumbentStrategyIds"])
        candidate_ids = {
            item["variantId"]
            for item in report["ranking"]
            if item["variantId"] not in incumbent_ids
        }
        expected_pairs = {
            (candidate_id, incumbent_id)
            for candidate_id in candidate_ids
            for incumbent_id in incumbent_ids
        }
        actual_pairs = {
            (item["candidateStrategyId"], item["baselineStrategyId"])
            for item in scorecard_set["comparisons"]
        }

        self.assertEqual(scorecard_set["type"], runner.MULTI_CANDIDATE_SCORECARD_SET_TYPE)
        self.assertEqual(scorecard_set["status"], "materialized")
        self.assertEqual(scorecard_set["comparisonCount"], len(expected_pairs))
        self.assertEqual(actual_pairs, expected_pairs)
        self.assertEqual(scorecard_set["materializedScorecardCount"], len(expected_pairs))
        self.assertTrue(scorecard_set["validationScaleComputeBlocked"])
        self.assertIn("runtime_parameter_injection", scorecard_set["missingPrerequisites"])
        self.assertEqual(report["candidateScorecard"]["status"], "materialized")
        self.assertTrue(report["candidateScorecard"]["validationScaleComputeBlocked"])
        self.assertEqual(report["candidateScorecard"]["overallGate"]["status"], "HOLD")
        self.assertTrue(all(scorecard_paths_exist))
        for comparison in scorecard_set["comparisons"]:
            self.assertEqual(comparison["status"], "materialized")
            self.assertEqual(comparison["overallGate"]["status"], "HOLD")

    def test_policy_gradient_scorecard_noop_is_machine_readable_when_pair_missing(self) -> None:
        report: JsonObject = {
            "policyGradient": {"target_family": "construction-priority"},
            "reportId": "scorecard-no-pair",
            "ranking": [],
            "incumbentStrategyIds": [],
            "variantResults": [],
            "warnings": [],
            "runtimeParameterInjection": {
                "status": "metadata_only",
                "runtimeParameterInjection": False,
                "candidateParameterScope": "metadata_only",
                "injectedVariantCount": 0,
            },
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            runner.materialize_candidate_scorecard_artifact(report, Path(temp_dir), [])

        self.assertEqual(report["candidateScorecards"]["status"], "blocked")
        self.assertEqual(report["candidateScorecards"]["missingPrerequisite"], "candidate_baseline_ranking")
        self.assertEqual(report["candidateScorecard"]["status"], "blocked")
        self.assertEqual(report["candidateScorecard"]["classification"], "candidate_baseline_pair_missing")
        self.assertIsNone(report["scorecardId"])
        self.assertIsNone(report["scorecardArtifactPath"])

    def test_policy_gradient_blocked_first_comparison_clears_selected_scorecard_id(self) -> None:
        report: JsonObject = {
            "policyGradient": {"target_family": "construction-priority"},
            "reportId": "scorecard-blocked-first",
            "generatedAt": "2026-05-17T07:00:00Z",
            "ranking": [
                {"variantId": "candidate-a", "rank": 1},
                {"variantId": "candidate-b", "rank": 2},
                {"variantId": "baseline", "rank": 3},
            ],
            "incumbentStrategyIds": ["baseline"],
            "variantResults": [],
            "warnings": [],
            "runtimeParameterInjection": {
                "status": "metadata_only",
                "runtimeParameterInjection": False,
                "candidateParameterScope": "metadata_only",
                "injectedVariantCount": 0,
            },
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            runner.materialize_candidate_scorecard_artifact(report, Path(temp_dir), [])

        scorecard_set = report["candidateScorecards"]
        self.assertEqual(scorecard_set["comparisonCount"], 2)
        self.assertEqual(scorecard_set["comparisons"][0]["candidateStrategyId"], "candidate-a")
        self.assertEqual(scorecard_set["comparisons"][0]["status"], "blocked")
        self.assertEqual(
            scorecard_set["comparisons"][0]["classification"],
            "scorecard_variant_result_missing",
        )
        self.assertIsNone(scorecard_set["comparisons"][0]["scorecardId"])
        self.assertIsNone(scorecard_set["selectedScorecardId"])
        self.assertIsNone(report["scorecardId"])
        self.assertIsNone(report["scorecardArtifactPath"])

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

    def test_policy_update_candidate_rows_require_evaluated_parameters_for_runtime_injection(self) -> None:
        parameter_space = {"knob": {"min": 0, "max": 10}}
        policy_gradient = {
            "runner_support": {
                "runtime_parameter_injection": True,
                "inline_candidates_runtime_injected": True,
                "inline_candidates_applied_to_simulator": True,
                "candidate_parameter_scope": "runtime_injected",
                "simulator_variant_transport": "variant_ids_with_runtime_injected_parameters",
            },
            "candidate_parameter_vectors": [
                {
                    "candidatePolicyId": "candidate",
                    "strategyVariantId": "candidate",
                    "parameters": {"knob": 4.2},
                },
            ],
        }

        rows = runner.policy_update_candidate_rows(
            policy_gradient,
            [
                {
                    "variantId": "candidate",
                    "sampleCount": 1,
                    "parameters": {"knob": 4.2},
                    "reward": {"tuple": [1, 0, 0, 0]},
                }
            ],
            parameter_space,
        )

        self.assertEqual(rows, [])

    def test_policy_update_candidate_rows_reject_runtime_evaluated_parameter_drift(self) -> None:
        parameter_space = {"knob": {"min": 0, "max": 10}}
        policy_gradient = {
            "runner_support": {
                "runtime_parameter_injection": True,
                "inline_candidates_runtime_injected": True,
                "inline_candidates_applied_to_simulator": True,
                "candidate_parameter_scope": "runtime_injected",
                "simulator_variant_transport": "variant_ids_with_runtime_injected_parameters",
            },
            "candidate_parameter_vectors": [
                {
                    "candidatePolicyId": "candidate",
                    "strategyVariantId": "candidate",
                    "parameters": {"knob": 4.2},
                },
            ],
        }

        with self.assertRaisesRegex(runner.TrainingCardError, "drift from evaluated parameters"):
            runner.policy_update_candidate_rows(
                policy_gradient,
                [
                    {
                        "variantId": "candidate",
                        "sampleCount": 1,
                        "evaluatedParameters": {"knob": 5.2},
                        "reward": {"tuple": [1, 0, 0, 0]},
                    }
                ],
                parameter_space,
            )

    def test_policy_gradient_candidate_vector_lookup_keeps_variant_and_policy_ids_separate(self) -> None:
        variants = [
            runner.StrategyVariant(
                id="foo",
                candidate_policy_id="foo-policy",
                family="test-family",
                parameters={"knob": 1},
            ),
            runner.StrategyVariant(
                id="bar",
                candidate_policy_id="bar-policy",
                family="test-family",
                parameters={"knob": 2},
            ),
        ]
        updated = runner.apply_policy_gradient_candidate_vectors_to_variants(
            {
                "policy_gradient": {
                    "candidate_parameter_vectors": [
                        {
                            "candidatePolicyId": "foo",
                            "strategyVariantId": "bar",
                            "parameters": {"knob": 99},
                        },
                        {
                            "candidatePolicyId": "foo-policy",
                            "parameters": {"knob": 11},
                        },
                    ],
                }
            },
            variants,
        )

        updated_by_id = {variant.id: variant for variant in updated}
        self.assertEqual(updated_by_id["foo"].parameters, {"knob": 11})
        self.assertEqual(updated_by_id["foo"].candidate_policy_id, "foo-policy")
        self.assertEqual(updated_by_id["bar"].parameters, {"knob": 99})

    def test_runtime_parameter_report_summary_matches_candidate_policy_only_vectors(self) -> None:
        summary = runner.build_report_runtime_parameter_injection_summary(
            [
                {
                    "variantId": "variant-a",
                    "candidatePolicyId": "candidate-a",
                    "runtimeParameterInjection": {
                        "status": "injected",
                        "runtimeParameterInjection": True,
                        "runtimeParameterConsumption": True,
                        "runtimeParameterConsumptionStatus": "consumed",
                        "candidateParameterScope": "runtime_injected",
                        "parametersSha256": "candidate-sha",
                    },
                },
            ],
            [
                runner.StrategyVariant(
                    id="variant-a",
                    candidate_policy_id="candidate-a",
                    family="test-family",
                    parameters={"knob": 1},
                )
            ],
            {
                "candidate_parameter_vectors": [
                    {
                        "candidatePolicyId": "candidate-a",
                        "parameters": {"knob": 1},
                    }
                ]
            },
        )

        self.assertEqual(summary["status"], "injected")
        self.assertTrue(summary["runtimeParameterInjection"])
        self.assertTrue(summary["runtimeParameterConsumption"])
        self.assertEqual(summary["variantCount"], 1)
        self.assertEqual([row["variantId"] for row in summary["variants"]], ["variant-a"])

    def test_runtime_parameter_report_summary_preserves_sparse_injection_provenance(self) -> None:
        summary = runner.build_report_runtime_parameter_injection_summary(
            [
                {
                    "variantId": "variant-a",
                    "candidatePolicyId": "candidate-a",
                    "sourceStrategyId": "source-a",
                    "family": "test-family",
                    "runtimeParameterInjection": {
                        "status": "partial",
                        "runtimeParameterInjection": False,
                        "candidateParameterScope": "partial_runtime_injection",
                        "reason": "successful simulator attempt did not report consumption",
                    },
                },
            ],
            [
                runner.StrategyVariant(
                    id="variant-a",
                    candidate_policy_id="candidate-a",
                    source_strategy_id="source-a",
                    family="test-family",
                    parameters={"knob": 1},
                )
            ],
        )

        row = summary["variants"][0]
        self.assertEqual(row["candidatePolicyId"], "candidate-a")
        self.assertEqual(row["sourceStrategyId"], "source-a")
        self.assertEqual(row["family"], "test-family")

    def test_policy_update_candidate_rows_accepts_candidate_policy_id_only_vectors(self) -> None:
        parameter_space = {"knob": {"min": 0, "max": 10}}
        rows = runner.policy_update_candidate_rows(
            {
                "runner_support": {
                    "runtime_parameter_injection": True,
                    "inline_candidates_runtime_injected": True,
                    "candidate_parameter_scope": "runtime_injected",
                    "policy_update_reward_use": "eligible_with_evaluated_runtime_parameters",
                    "runtime_parameter_consumption_status": "consumed",
                },
                "candidate_parameter_vectors": [
                    {
                        "candidatePolicyId": "candidate-a",
                        "parameters": {"knob": 4.2},
                    },
                ],
            },
            [
                {
                    "variantId": "variant-a",
                    "candidatePolicyId": "candidate-a",
                    "sampleCount": 1,
                    "evaluatedParameters": {"knob": 4.2},
                    "reward": {"tuple": [1, 0, 0, 0]},
                }
            ],
            parameter_space,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["candidatePolicyId"], "candidate-a")
        self.assertEqual(rows[0]["strategyVariantId"], "candidate-a")
        self.assertEqual(rows[0]["parameters"], {"knob": 4.2})
        self.assertEqual(rows[0]["resultVariantIds"], ["variant-a"])

    def test_runtime_parameter_report_summary_uses_policy_gradient_candidate_ids(self) -> None:
        summary = runner.build_report_runtime_parameter_injection_summary(
            [
                {
                    "variantId": "candidate",
                    "runtimeParameterInjection": {
                        "status": "injected",
                        "runtimeParameterInjection": True,
                        "runtimeParameterConsumption": True,
                        "runtimeParameterConsumptionStatus": "consumed",
                        "candidateParameterScope": "runtime_injected",
                        "parametersSha256": "candidate-sha",
                    },
                },
                {
                    "variantId": "control",
                    "runtimeParameterInjection": {
                        "status": "missing",
                        "runtimeParameterInjection": False,
                        "candidateParameterScope": "metadata_only",
                        "reason": "non-candidate control did not run injected parameters",
                    },
                },
            ],
            [
                runner.StrategyVariant(id="candidate", family="test-family", parameters={"knob": 1}),
                runner.StrategyVariant(id="control", family="test-family", parameters={"knob": 0}),
            ],
            {
                "candidate_parameter_vectors": [
                    {
                        "candidatePolicyId": "candidate-policy",
                        "strategyVariantId": "candidate",
                        "parameters": {"knob": 1},
                    }
                ]
            },
        )

        self.assertEqual(summary["status"], "injected")
        self.assertTrue(summary["runtimeParameterInjection"])
        self.assertTrue(summary["runtimeParameterConsumption"])
        self.assertEqual(summary["consumedVariantCount"], 1)
        self.assertEqual(summary["variantCount"], 1)
        self.assertEqual([row["variantId"] for row in summary["variants"]], ["candidate"])

    def test_runtime_parameter_report_summary_aggregates_attempt_level_injection(self) -> None:
        variant = runner.StrategyVariant(
            id="candidate",
            candidate_policy_id="candidate-policy",
            family="test-family",
            parameters={"knob": 1},
        )

        summary = runner.build_report_runtime_parameter_injection_summary(
            [
                {
                    "variantId": "candidate",
                    "candidatePolicyId": "candidate-policy",
                    "runtimeParameterInjection": {
                        "status": "partial",
                        "runtimeParameterInjection": False,
                        "candidateParameterScope": "partial_runtime_injection",
                        "successfulAttemptCount": 2,
                        "attempts": [
                            {
                                "status": "missing_runtime_parameter_consumption",
                                "runtimeParameterInjection": True,
                            },
                            {
                                "status": "missing_runtime_parameter_consumption",
                                "runtimeParameterInjection": True,
                            },
                        ],
                    },
                }
            ],
            [variant],
            {
                "candidate_parameter_vectors": [
                    {
                        "candidatePolicyId": "candidate-policy",
                        "strategyVariantId": "candidate",
                        "parameters": {"knob": 1},
                    }
                ]
            },
        )

        self.assertEqual(summary["status"], "partial")
        self.assertFalse(summary["runtimeParameterInjection"])
        self.assertEqual(summary["injectedVariantCount"], 1)
        self.assertEqual(summary["variantCount"], 1)
        self.assertTrue(summary["variants"][0]["runtimeParameterInjection"])

    def test_invalid_evaluated_parameters_preserve_runtime_transport_in_rollups(self) -> None:
        variant = runner.StrategyVariant(
            id="candidate",
            candidate_policy_id="candidate-policy",
            family="test-family",
            parameters={"knob": 1},
        )
        invalid_attempt = {
            "variant_id": "candidate",
            "ok": True,
            "runtimeParameterInjection": {
                "status": "injected",
                "runtimeParameterInjection": True,
                "candidateParameterScope": "runtime_injected",
                "parametersSha256": runner.canonical_hash(variant.parameters),
            },
            "runtimeParameterConsumption": {
                "status": "consumed",
                "runtimeParameterConsumption": True,
                "source": "runtime_policy_parameter_consumption",
            },
            "evaluatedParameters": ["not", "an", "object"],
            "evaluatedParametersSource": "runtime_parameter_consumption",
        }

        variant_summary = runner.summarize_variant_runtime_parameter_injection(variant, [invalid_attempt])
        report_summary = runner.build_report_runtime_parameter_injection_summary(
            [{"variantId": "candidate", "runtimeParameterInjection": variant_summary}],
            [variant],
            {
                "candidate_parameter_vectors": [
                    {
                        "candidatePolicyId": "candidate-policy",
                        "strategyVariantId": "candidate",
                        "parameters": {"knob": 1},
                    }
                ]
            },
        )

        self.assertEqual(variant_summary["status"], "injected")
        self.assertTrue(variant_summary["runtimeParameterInjection"])
        self.assertFalse(variant_summary["runtimeParameterConsumption"])
        self.assertEqual(variant_summary["runtimeParameterConsumptionStatus"], "invalid_evaluated_parameters")
        self.assertFalse(variant_summary["policyUpdateEligible"])
        self.assertEqual(report_summary["status"], "injected")
        self.assertTrue(report_summary["runtimeParameterInjection"])
        self.assertFalse(report_summary["runtimeParameterConsumption"])
        self.assertEqual(report_summary["runtimeParameterConsumptionStatus"], "invalid_evaluated_parameters")
        self.assertFalse(report_summary["policyUpdateEligible"])

    def test_candidate_scorecard_readiness_treats_evaluated_parameter_failures_as_consumption_blockers(self) -> None:
        for status in ("missing_evaluated_parameters", "invalid_evaluated_parameters", "mixed"):
            with self.subTest(status=status):
                runtime_parameter_injection = {
                    "status": "injected",
                    "runtimeParameterInjection": True,
                    "runtimeParameterConsumption": False,
                    "runtimeParameterConsumptionStatus": status,
                    "candidateParameterScope": "runtime_injected",
                    "policyUpdateEligible": False,
                    "injectedVariantCount": 1,
                    "consumedVariantCount": 0,
                }
                readiness = runner.build_candidate_scorecard_readiness(
                    {
                        "reportId": f"scorecard-{status}",
                        "ranking": [
                            {"variantId": "candidate", "rank": 1},
                            {"variantId": "baseline", "rank": 2},
                        ],
                        "incumbentStrategyIds": ["baseline"],
                        "runtimeParameterInjection": runtime_parameter_injection,
                        "variantResults": [
                            {
                                "variantId": "candidate",
                                "runtimeParameterInjection": runtime_parameter_injection,
                            }
                        ],
                    }
                )

                self.assertEqual(readiness["status"], "materialized")
                self.assertEqual(
                    readiness["classification"],
                    "runtime_parameter_consumption_missing_scorecard_materialized",
                )
                self.assertTrue(readiness["runtimeParameterInjection"])
                self.assertFalse(readiness["runtimeParameterConsumption"])
                self.assertEqual(readiness["missingPrerequisite"], "runtime_parameter_consumption")
                self.assertIn("runtime policy parameter consumption evidence", readiness["reason"])
                self.assertIn("emit tick-time runtime policy parameter consumption evidence", readiness["nextAction"])

    def test_mixed_evaluated_parameter_failures_keep_scorecard_blocked_on_consumption(self) -> None:
        variant = runner.StrategyVariant(
            id="candidate",
            family="test-family",
            parameters={"knob": 1},
        )
        parameters_sha = runner.canonical_hash(variant.parameters)
        base_attempt = {
            "variant_id": "candidate",
            "ok": True,
            "runtimeParameterInjection": {
                "status": "injected",
                "runtimeParameterInjection": True,
                "candidateParameterScope": "runtime_injected",
                "parametersSha256": parameters_sha,
            },
            "runtimeParameterConsumption": {
                "status": "consumed",
                "runtimeParameterConsumption": True,
                "source": "runtime_policy_parameter_consumption",
            },
        }
        missing_evaluated = copy.deepcopy(base_attempt)
        invalid_evaluated = copy.deepcopy(base_attempt)
        invalid_evaluated["evaluatedParameters"] = ["not", "an", "object"]
        invalid_evaluated["evaluatedParametersSource"] = "runtime_parameter_consumption"

        runtime_parameter_injection = runner.summarize_variant_runtime_parameter_injection(
            variant,
            [missing_evaluated, invalid_evaluated],
        )
        self.assertEqual(runtime_parameter_injection["status"], "injected")
        self.assertTrue(runtime_parameter_injection["runtimeParameterInjection"])
        self.assertFalse(runtime_parameter_injection["runtimeParameterConsumption"])
        self.assertEqual(runtime_parameter_injection["runtimeParameterConsumptionStatus"], "mixed")

        readiness = runner.build_candidate_scorecard_readiness(
            {
                "reportId": "scorecard-mixed-evaluated-parameters",
                "ranking": [
                    {"variantId": "candidate", "rank": 1},
                    {"variantId": "baseline", "rank": 2},
                ],
                "incumbentStrategyIds": ["baseline"],
                "runtimeParameterInjection": runtime_parameter_injection,
                "variantResults": [
                    {
                        "variantId": "candidate",
                        "runtimeParameterInjection": runtime_parameter_injection,
                    }
                ],
            }
        )

        self.assertEqual(readiness["classification"], "runtime_parameter_consumption_missing_scorecard_materialized")
        self.assertEqual(readiness["missingPrerequisite"], "runtime_parameter_consumption")
        self.assertIn("runtime policy parameter consumption evidence", readiness["reason"])

    def test_not_attempted_runtime_parameter_status_counts_as_runtime_attempt(self) -> None:
        variant = runner.StrategyVariant(id="candidate", family="test-family", parameters={"knob": 1})

        self.assertTrue(runner.runtime_parameter_scope_indicates_runtime_attempt({"status": "not_attempted"}))
        summary = runner.summarize_variant_runtime_parameter_injection(
            variant,
            [
                {
                    "ok": False,
                    "runtimeParameterInjection": {
                        "status": "not_attempted",
                        "runtimeParameterInjection": False,
                        "parametersSha256": "candidate-sha",
                        "reason": "resource guard blocked before runtime upload",
                    },
                }
            ],
        )

        self.assertEqual(summary["status"], "not_injected")
        self.assertEqual(summary["candidateParameterScope"], "runtime_injected")
        self.assertIn("resource guard", summary["reason"])

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

    def test_reinforce_gradient_stability_trusts_sufficient_consistent_samples(self) -> None:
        update = runner.build_policy_update(
            policy_gradient=reinforce_stability_policy_gradient(),
            results=reinforce_stability_results([[2, 0, 0, 0] for _index in range(20)]),
            report_id="policy-gradient-stable",
            generated_at="2026-05-21T21:30:00Z",
        )

        stability = update["gradientStability"]
        self.assertEqual(update["iterations"], 1)
        self.assertTrue(update["trueGradient"])
        self.assertTrue(update["gradientStable"])
        self.assertTrue(update["trustedGradientUpdate"])
        self.assertFalse(update["highVariance"])
        self.assertEqual(stability["minimumSamplesPerCandidate"], 20)
        self.assertEqual(stability["sampleCountByCandidate"], {"variant-a": 20, "variant-b": 20})
        self.assertEqual(stability["classification"], "stable")
        self.assertEqual(stability["convergenceLabel"], "trusted_gradient_update")
        self.assertEqual(
            update["policyGradientEstimator"],
            runner.POLICY_GRADIENT_LEXICOGRAPHIC_REINFORCE_ESTIMATOR,
        )
        self.assertEqual(
            update["gradientEstimation"]["gradientReward"],
            runner.POLICY_GRADIENT_LEXICOGRAPHIC_PER_TIER_REWARD,
        )
        self.assertEqual(update["gradientEstimation"]["scalarWeightedSumUse"], "not_used")
        self.assertTrue(update["gradientEstimation"]["lexicographicRankingPreserved"])
        self.assertFalse(update["gradientEstimation"]["scalarWeightedSumAuthorized"])
        self.assertEqual(
            update["gradientEstimation"]["schemeIdentity"]["estimator"],
            runner.POLICY_GRADIENT_LEXICOGRAPHIC_REINFORCE_ESTIMATOR,
        )

        self.assertEqual(
            update["gradientEstimation"]["schemeIdentity"]["gradientReward"],
            runner.POLICY_GRADIENT_LEXICOGRAPHIC_PER_TIER_REWARD,
        )
        self.assertEqual(
            update["gradientEstimation"]["schemeKey"],
            runner.policy_update_gradient_scheme_key(update["gradientEstimation"]["schemeIdentity"]),
        )
        self.assertEqual(update["gradientEstimationSchemeKey"], update["gradientEstimation"]["schemeKey"])
        self.assertEqual(update["gradientComparisonKey"], update["gradientEstimation"]["comparisonKey"])
        self.assertEqual(
            update["gradientStability"]["gradientSchemeKey"],
            update["gradientEstimation"]["schemeKey"],
        )
        self.assertTrue(update["gradientStability"]["gradientSchemeComparable"])
        self.assertEqual(update["gradientMomentum"]["gradientSchemeComparisonStatus"], "current_scheme_only")
        self.assertEqual(
            update["nextCandidatePolicy"]["gradientEstimationSchemeKey"],
            update["gradientEstimation"]["schemeKey"],
        )
        self.assertNotIn("sourceMaxComponentWeight", update["gradientEstimation"])
        self.assertNotIn("scalarRewardScaleFactor", update["gradientEstimation"])
        self.assertEqual(
            update["gradientEstimation"]["selectedRewardTierByParameter"],
            {"territorySignalWeight": "reliability"},
        )
        self.assertEqual(update["gradient"], update["gradientMomentum"]["rawEmaGradient"])
        self.assertEqual(
            runner.round_policy_number(update["gradient"]["territorySignalWeight"]),
            update["gradientMomentum"]["emaGradient"]["territorySignalWeight"],
        )
        self.assertAlmostEqual(float(update["gradient"]["territorySignalWeight"]), 0.016667, places=6)
        self.assertEqual(update["parameterDelta"], {"territorySignalWeight": 0.5})
        self.assertEqual(update["updatedParameters"], {"territorySignalWeight": 6.5})
        self.assertEqual(update["gradientEstimation"]["capNormalizedGradient"], {"territorySignalWeight": 0.016667})
        self.assertEqual(
            runner.round_policy_number(update["gradientEstimation"]["gradient"]["territorySignalWeight"]),
            update["gradientEstimation"]["capNormalizedGradient"]["territorySignalWeight"],
        )
        self.assertTrue(update["gradientMomentum"]["momentumConsistent"])
        self.assertTrue(update["promotionGate"]["loopAPromotionEligible"])
        self.assertTrue(update["promotionGate"]["loopBPromotionEligible"])
        self.assertFalse(update["promotionGate"]["officialMmoWritesAllowed"])
        self.assertTrue(update["nextCandidatePolicy"]["trustedGradientUpdate"])
        self.assertFalse(update["nextCandidatePolicy"]["liveEffect"])

    def test_gradient_stability_records_insufficient_samples_for_four_candidate_validation_plan(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-four-candidate-samples",
            code_commit="1" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T00:25:00Z",
            simulation_repetitions=10,
            simulation_workers=2,
            simulation_scale_environments=2,
            simulation_min_concurrent_environments=2,
        )
        policy_gradient = card["policy_gradient"]
        parameter_space = runner.policy_update_parameter_space(policy_gradient)
        candidates: list[JsonObject] = []
        samples: list[JsonObject] = []
        for candidate in policy_gradient["candidate_parameter_vectors"]:
            row = {
                "candidatePolicyId": candidate["candidatePolicyId"],
                "strategyVariantId": candidate["strategyVariantId"],
                "parameters": candidate["parameters"],
                "returnSampleCount": 10,
            }
            candidates.append(row)
            for _index in range(10):
                samples.append(
                    {
                        "candidatePolicyId": candidate["candidatePolicyId"],
                        "strategyVariantId": candidate["strategyVariantId"],
                        "parameters": candidate["parameters"],
                        "returnTuple": [1, 0, 0, 0],
                    }
                )

        stability = runner.policy_update_gradient_stability_gate(
            policy_gradient=policy_gradient,
            parameter_space=parameter_space,
            candidates=candidates,
            samples=samples,
            anchor_parameters=candidates[0]["parameters"],
            return_baseline=[1, 0, 0, 0],
            gradient={},
            selected_reward_tier_by_parameter={},
        )

        self.assertEqual(stability["classification"], "insufficient_sample_high_variance")
        self.assertEqual(stability["minimumSamplesPerCandidate"], 20)
        self.assertEqual(stability["minimumTotalSamples"], 80)
        self.assertEqual(stability["totalReturnSampleCount"], 40)
        self.assertEqual(set(stability["sampleCountByCandidate"].values()), {10})
        self.assertEqual(len(stability["insufficientCandidates"]), 4)
        self.assertIn("fewer Monte Carlo return samples per candidate", stability["reason"])
        self.assertFalse(stability["trustedGradientUpdate"])

    def test_reinforce_gradient_stability_trusts_same_scheme_previous_gradient(self) -> None:
        policy_gradient = reinforce_stability_policy_gradient()
        policy_gradient["policyUpdate"]["gradient_momentum"] = {
            "ema_decay": 0.8,
            "previous_ema_gradient": {"territorySignalWeight": 0.25},
            "previous_gradient_estimation_scheme": lexicographic_reinforce_gradient_scheme_identity(),
        }

        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=reinforce_stability_results([[2, 0, 0, 0] for _index in range(20)]),
            report_id="policy-gradient-stable-same-scheme",
            generated_at="2026-05-21T21:30:30Z",
        )

        self.assertTrue(update["trustedGradientUpdate"])
        self.assertTrue(update["gradientStability"]["gradientSchemeComparable"])
        self.assertEqual(update["gradientMomentum"]["gradientSchemeComparisonStatus"], "same_scheme")
        self.assertEqual(
            update["gradientMomentum"]["previousGradientSchemeKey"],
            update["gradientEstimation"]["schemeKey"],
        )
        self.assertEqual(update["gradientStability"]["classification"], "stable")
        self.assertTrue(update["promotionGate"]["loopAPromotionEligible"])
        self.assertTrue(update["promotionGate"]["loopBPromotionEligible"])

    def test_reinforce_gradient_stability_trusts_round_trip_momentum_with_null_previous_keys(self) -> None:
        first_update = runner.build_policy_update(
            policy_gradient=reinforce_stability_policy_gradient(),
            results=reinforce_stability_results([[2, 0, 0, 0] for _index in range(20)]),
            report_id="policy-gradient-round-trip-first",
            generated_at="2026-05-22T00:00:00Z",
        )
        first_momentum = first_update["gradientMomentum"]
        self.assertIsNone(first_momentum["previousGradientSchemeKey"])
        self.assertIsNone(first_momentum["previousGradientComparisonKey"])

        policy_gradient = reinforce_stability_policy_gradient()
        policy_gradient["policyUpdate"]["gradient_momentum"] = copy.deepcopy(first_momentum)
        config = runner.policy_update_gradient_momentum_config(policy_gradient)
        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=reinforce_stability_results([[2, 0, 0, 0] for _index in range(20)]),
            report_id="policy-gradient-round-trip-second",
            generated_at="2026-05-22T00:01:00Z",
        )

        self.assertEqual(config["previousGradientSchemeKey"], first_momentum["gradientSchemeKey"])
        self.assertEqual(config["previousGradientComparisonKey"], first_momentum["gradientComparisonKey"])
        self.assertTrue(update["trustedGradientUpdate"])
        self.assertTrue(update["gradientStability"]["gradientSchemeComparable"])
        self.assertEqual(update["gradientMomentum"]["gradientSchemeComparisonStatus"], "same_scheme")
        self.assertTrue(update["gradientMomentum"]["previousGradientPresent"])
        self.assertTrue(update["promotionGate"]["loopAPromotionEligible"])
        self.assertTrue(update["promotionGate"]["loopBPromotionEligible"])

    def test_policy_gradient_scheme_comparison_key_uses_effective_scalar_weights(self) -> None:
        def scheme_for_weights(weights: JsonObject) -> JsonObject:
            policy_gradient = reinforce_stability_policy_gradient()
            policy_gradient["policyUpdate"]["gradient_reward_weights"] = weights
            return runner.policy_update_scalar_gradient_scheme_identity(
                runner.policy_update_scalar_reward_weight_evidence(policy_gradient)
            )

        first = scheme_for_weights(
            {"reliability": 100, "territory": 50, "resources": 25, "kills": 10}
        )
        scaled_equivalent = scheme_for_weights(
            {"reliability": 200, "territory": 100, "resources": 50, "kills": 20}
        )
        different_estimator = scheme_for_weights(
            {"reliability": 100, "territory": 40, "resources": 25, "kills": 10}
        )

        self.assertNotIn("sourceComponentWeights", first)
        self.assertNotIn("sourceMaxComponentWeight", first)
        self.assertEqual(
            first["normalizedWeightsByRewardTier"],
            scaled_equivalent["normalizedWeightsByRewardTier"],
        )
        self.assertEqual(
            runner.policy_update_gradient_scheme_comparison_key(first),
            runner.policy_update_gradient_scheme_comparison_key(scaled_equivalent),
        )
        self.assertNotEqual(
            runner.policy_update_gradient_scheme_comparison_key(first),
            runner.policy_update_gradient_scheme_comparison_key(different_estimator),
        )

    def test_reinforce_gradient_stability_trusts_weight_changes_under_lexicographic_scheme(self) -> None:
        policy_gradient = reinforce_stability_policy_gradient()
        policy_gradient["policyUpdate"]["gradient_reward_weights"] = {
            "reliability": 200,
            "territory": 100,
            "resources": 50,
            "kills": 20,
        }
        policy_gradient["policyUpdate"]["gradient_momentum"] = {
            "ema_decay": 0.8,
            "previous_ema_gradient": {"territorySignalWeight": 0.25},
            "previous_gradient_estimation_scheme": lexicographic_reinforce_gradient_scheme_identity(),
        }

        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=reinforce_stability_results([[2, 0, 0, 0] for _index in range(20)]),
            report_id="policy-gradient-scaled-equivalent-scheme",
            generated_at="2026-05-22T00:10:00Z",
        )

        self.assertTrue(update["trustedGradientUpdate"])
        self.assertTrue(update["gradientStability"]["gradientSchemeComparable"])
        self.assertEqual(update["gradientMomentum"]["gradientSchemeComparisonStatus"], "same_scheme")
        self.assertEqual(
            update["gradientMomentum"]["previousGradientComparisonKey"],
            update["gradientEstimation"]["comparisonKey"],
        )

    def test_reinforce_gradient_stability_blocks_mixed_gradient_estimation_scheme(self) -> None:
        policy_gradient = reinforce_stability_policy_gradient()
        policy_gradient["policyUpdate"]["gradient_momentum"] = {
            "ema_decay": 0.8,
            "previous_ema_gradient": {"territorySignalWeight": 0.25},
            "previous_gradient_estimation_scheme": runner.policy_update_lexicographic_gradient_scheme_identity(),
        }

        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=reinforce_stability_results([[2, 0, 0, 0] for _index in range(20)]),
            report_id="policy-gradient-mixed-scheme",
            generated_at="2026-05-21T21:30:45Z",
        )

        self.assertEqual(update["iterations"], 1)
        self.assertFalse(update["trustedGradientUpdate"])
        self.assertTrue(update["highVariance"])
        self.assertEqual(
            update["gradientStability"]["classification"],
            "gradient_estimation_scheme_mismatch_non_comparable",
        )
        self.assertTrue(update["gradientStability"]["sampleSizeSufficient"])
        self.assertTrue(update["gradientStability"]["directionConsistent"])
        self.assertFalse(update["gradientStability"]["gradientSchemeComparable"])
        self.assertEqual(update["gradientStability"]["gradientSchemeComparisonStatus"], "scheme_mismatch")
        self.assertEqual(update["gradientMomentum"]["gradientSchemeComparisonStatus"], "scheme_mismatch")
        self.assertTrue(update["gradientMomentum"]["configuredPreviousGradientPresent"])
        self.assertFalse(update["gradientMomentum"]["previousGradientPresent"])
        self.assertNotEqual(
            update["gradientMomentum"]["previousGradientSchemeKey"],
            update["gradientEstimation"]["schemeKey"],
        )
        self.assertFalse(update["promotionGate"]["loopAPromotionEligible"])
        self.assertFalse(update["promotionGate"]["loopBPromotionEligible"])
        self.assertIn("gradient_estimation_scheme", update["promotionGate"]["missingPrerequisites"])
        self.assertFalse(update["nextCandidatePolicy"]["trustedGradientUpdate"])

    def test_reinforce_gradient_momentum_round_trip_after_scheme_mismatch_uses_current_scheme(self) -> None:
        mismatched_policy_gradient = reinforce_stability_policy_gradient()
        mismatched_policy_gradient["policyUpdate"]["gradient_momentum"] = {
            "ema_decay": 0.8,
            "previous_ema_gradient": {"territorySignalWeight": 0.25},
            "previous_gradient_estimation_scheme": runner.policy_update_lexicographic_gradient_scheme_identity(),
        }
        mismatch_update = runner.build_policy_update(
            policy_gradient=mismatched_policy_gradient,
            results=reinforce_stability_results([[2, 0, 0, 0] for _index in range(20)]),
            report_id="policy-gradient-mixed-scheme-first",
            generated_at="2026-05-22T00:15:00Z",
        )
        mismatch_momentum = mismatch_update["gradientMomentum"]
        self.assertEqual(mismatch_momentum["gradientSchemeComparisonStatus"], "scheme_mismatch")
        self.assertFalse(mismatch_momentum["previousGradientPresent"])
        self.assertNotEqual(
            mismatch_momentum["previousGradientComparisonKey"],
            mismatch_momentum["gradientComparisonKey"],
        )

        policy_gradient = reinforce_stability_policy_gradient()
        policy_gradient["policyUpdate"]["gradient_momentum"] = copy.deepcopy(mismatch_momentum)
        config = runner.policy_update_gradient_momentum_config(policy_gradient)
        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=reinforce_stability_results([[2, 0, 0, 0] for _index in range(20)]),
            report_id="policy-gradient-mixed-scheme-round-trip",
            generated_at="2026-05-22T00:16:00Z",
        )

        self.assertEqual(config["previousGradientSchemeKey"], mismatch_momentum["gradientSchemeKey"])
        self.assertEqual(config["previousGradientComparisonKey"], mismatch_momentum["gradientComparisonKey"])
        self.assertEqual(config["previousGradientSchemeIdentity"], mismatch_momentum["gradientSchemeIdentity"])
        self.assertTrue(update["trustedGradientUpdate"])
        self.assertEqual(update["gradientMomentum"]["gradientSchemeComparisonStatus"], "same_scheme")
        self.assertTrue(update["gradientMomentum"]["previousGradientPresent"])
        self.assertTrue(update["promotionGate"]["loopAPromotionEligible"])
        self.assertTrue(update["promotionGate"]["loopBPromotionEligible"])

    def test_policy_gradient_scalar_weights_preserve_kills_precision(self) -> None:
        weight_evidence = runner.policy_update_scalar_reward_weight_evidence({})
        weights = weight_evidence["normalizedWeightsByRewardTier"]

        self.assertEqual(weight_evidence["sourceMaxComponentWeight"], 1000000000)
        self.assertEqual(weight_evidence["normalizationCap"], 10000)
        self.assertEqual(weight_evidence["normalizationFactor"], 10000)
        self.assertEqual(weight_evidence["scalarRewardScaleFactor"], 0.00001)
        self.assertEqual(weights["reliability"], 100000)
        self.assertEqual(weights["territory"], 100)
        self.assertEqual(weights["resources"], 0.1)
        self.assertAlmostEqual(weights["kills"], 0.0001)
        self.assertGreater(runner.policy_update_scalar_reward([0, 0, 0, 1], weights), 0)

    def test_policy_gradient_scalar_estimator_preserves_kills_only_signal(self) -> None:
        policy_gradient = {
            "policyUpdate": {"algorithm": runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM},
        }
        estimation = runner.policy_update_scalar_weighted_gradient_estimation(
            policy_gradient=policy_gradient,
            parameter_space={"combatSignalWeight": {"min": 0, "max": 2}},
            anchor_parameters={"combatSignalWeight": 1},
            samples=[
                {
                    "candidate": {"parameters": {"combatSignalWeight": 0}},
                    "returnTuple": [0, 0, 0, 0],
                },
                {
                    "candidate": {"parameters": {"combatSignalWeight": 2}},
                    "returnTuple": [0, 0, 0, 20000],
                },
            ],
        )

        self.assertGreater(estimation["normalizedWeightsByRewardTier"]["kills"], 0)
        self.assertEqual(estimation["sourceMaxComponentWeight"], 1000000000)
        self.assertEqual(estimation["normalizationCap"], 10000)
        self.assertEqual(estimation["normalizationFactor"], 10000)
        self.assertEqual(estimation["scalarRewardScaleFactor"], 0.00001)
        self.assertGreater(estimation["capNormalizedGradient"]["combatSignalWeight"], 0.1)
        self.assertGreater(estimation["gradient"]["combatSignalWeight"], 0)
        self.assertEqual(estimation["gradient"], estimation["capNormalizedGradient"])
        self.assertGreater(estimation["directionByParameter"]["combatSignalWeight"]["positiveContributionCount"], 0)

    def test_authorized_scalar_policy_update_uses_scalar_samples_and_blocks_promotion(self) -> None:
        policy_gradient = reinforce_stability_policy_gradient()
        policy_gradient["rewardModel"] = card_helper.reward_model(scalar_weighted_sum_authorized=True)
        results = reinforce_stability_results([[1, 0, 0, 0] for _index in range(20)])
        for result in results:
            scalar_value = 100 if result["variantId"] == "variant-a" else 101
            result["reward"]["scalarWeightedSum"] = {
                "scalarReward": scalar_value,
                "scalarReturnSamples": [scalar_value for _index in range(result["sampleCount"])],
            }

        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=results,
            report_id="policy-gradient-authorized-scalar",
            generated_at="2026-06-01T16:25:00Z",
        )

        self.assertEqual(update["iterations"], 1)
        self.assertEqual(update["policyGradientEstimator"], runner.POLICY_GRADIENT_SCALAR_ESTIMATOR)
        self.assertTrue(update["scalarWeightedSumAuthorized"])
        self.assertTrue(update["gradientEstimation"]["scalarWeightedSumAuthorized"])
        self.assertEqual(
            update["gradientEstimation"]["scalarWeightedSumUse"],
            runner.SCALAR_WEIGHTED_SUM_AUTHORIZED_USE,
        )
        self.assertIn("activation", update["gradientEstimation"]["normalizedWeightsByRewardTier"])
        self.assertGreater(update["gradientEstimation"]["scalarReturns"][-1], update["gradientEstimation"]["scalarReturns"][0])
        self.assertEqual(update["promotionGate"]["status"], "blocked_loop_b_advantage_gate_pending")
        self.assertFalse(update["promotionGate"]["loopAPromotionEligible"])
        self.assertFalse(update["promotionGate"]["loopBPromotionEligible"])
        self.assertEqual(update["promotionGate"]["loopBAdvantageGate"], "required_before_promotion")
        self.assertFalse(update["promotionGate"]["liveEffect"])
        self.assertFalse(update["promotionGate"]["officialMmoWrites"])

    def test_authorized_scalar_training_report_surfaces_activation_reward_components(self) -> None:
        card = base_card(["baseline", "candidate"])
        card["training_approach"] = "policy_gradient"
        card["reward_model"] = card_helper.reward_model(scalar_weighted_sum_authorized=True)
        card["scenario"] = card_helper.scenario_metadata_block(scenario_id=card_helper.MULTI_TIER_SCENARIO_ID)
        card["simulation"]["room"] = "E1S1"
        card["simulation"]["map_source_file"] = str(card_helper.MULTI_TIER_SIMULATION_MAP_SOURCE_FILE)
        config = runner.simulation_config_from_card(card)
        variants = [
            runner.StrategyVariant(id="baseline", family="test-family", parameters={}, rollout_status="incumbent"),
            runner.StrategyVariant(id="candidate", family="test-family", parameters={}, rollout_status="shadow"),
        ]
        start = tick(1, [room("E1S1", energy=100)])
        end = tick(2, [room("E1S1", energy=100)])
        baseline_run = variant_result("baseline", [start, end])
        candidate_run = variant_result("candidate", [start, end])
        candidate_run["policyActivation"] = {
            "type": "screeps-rl-multi-tier-policy-activation",
            "policyAction": "test-activation",
            "executionAction": "test-activation",
            "objectiveSignalSource": "offline_shadow_projection",
            "activationScore": 22.25,
            "threshold": 10,
            "reason": "deterministic scalar reward activation test",
        }

        report = runner.build_training_report(
            card=card,
            card_path=Path("card.json"),
            variants=variants,
            config=config,
            simulator_runs=[
                {
                    "type": "screeps-rl-simulator-run",
                    "runId": "scalar-activation-report",
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                    "variants": [baseline_run, candidate_run],
                }
            ],
            reward_options=runner.reward_options_from_card(card),
            report_id="scalar-activation-report",
            generated_at="2026-06-01T16:26:00Z",
        )

        candidate = next(item for item in report["variantResults"] if item["variantId"] == "candidate")
        scalar = candidate["reward"]["scalarWeightedSum"]
        self.assertTrue(report["rewardModel"]["scalarWeightedSumAuthorized"])
        self.assertEqual(report["rewardModel"]["scalarWeightedSumUse"], runner.SCALAR_WEIGHTED_SUM_AUTHORIZED_USE)
        self.assertEqual(scalar["activationScore"], 22.25)
        self.assertGreater(scalar["weightedComponentsByRewardTier"]["activation"], 0)
        self.assertEqual(report["scalarWeightedReward"]["variantRewards"][1]["activationScore"], 22.25)
        self.assertEqual(report["conclusionRegistryUpdate"]["sourceIssue"], "#1582")
        self.assertFalse(report["scalarWeightedReward"]["liveEffect"])
        self.assertFalse(report["officialMmoWrites"])

    def test_policy_gradient_scalar_estimator_preserves_large_source_weight_scale(self) -> None:
        policy_gradient = {
            "policyUpdate": {
                "algorithm": runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
                "gradient_reward_weights": {
                    "reliability": 1_000_000_000_000.0,
                    "territory": 1_000_000.0,
                    "resources": 1_000.0,
                    "kills": 1.0,
                },
            },
        }
        estimation = runner.policy_update_scalar_weighted_gradient_estimation(
            policy_gradient=policy_gradient,
            parameter_space={"territorySignalWeight": {"min": 0, "max": 2}},
            anchor_parameters={"territorySignalWeight": 1},
            samples=[
                {
                    "candidate": {"parameters": {"territorySignalWeight": 0}},
                    "returnTuple": [0, 0, 0, 0],
                },
                {
                    "candidate": {"parameters": {"territorySignalWeight": 2}},
                    "returnTuple": [1, 0, 0, 0],
                },
            ],
        )

        self.assertEqual(estimation["sourceMaxComponentWeight"], 1_000_000_000_000)
        self.assertEqual(estimation["normalizationFactor"], 10000)
        self.assertEqual(estimation["scalarRewardScaleFactor"], 0.00000001)
        self.assertEqual(estimation["capNormalizedGradient"], {"territorySignalWeight": 25000000})
        self.assertEqual(estimation["gradient"], {"territorySignalWeight": 25000000})
        direction = estimation["directionByParameter"]["territorySignalWeight"]
        self.assertGreater(direction["contributionSum"], 0)
        self.assertEqual(direction["contributionSum"], direction["capNormalizedContributionSum"])

    def test_reinforce_policy_update_ignores_scalar_weight_scale_for_active_gradient(self) -> None:
        policy_gradient = {
            "targetFamily": "test-family",
            "policyUpdate": {
                "algorithm": runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
                "learning_rate": 0.1,
                "gradient_reward_weights": {
                    "reliability": 1_000_000_000_000.0,
                    "territory": 1_000_000.0,
                    "resources": 1_000.0,
                    "kills": 1.0,
                },
            },
            "runner_support": {
                "runtime_parameter_injection": True,
                "inline_candidates_runtime_injected": True,
                "candidate_parameter_scope": "runtime_injected",
                "simulator_variant_transport": "variant_ids_with_runtime_injected_parameters",
                "policy_update_reward_use": "eligible_with_evaluated_runtime_parameters",
                "runtime_parameter_consumption_status": "consumed",
            },
            "learnableParameters": [{"name": "territorySignalWeight", "min": 0, "max": 2}],
            "candidateParameterVectors": [
                {
                    "candidatePolicyId": "candidate-a",
                    "strategyVariantId": "variant-a",
                    "rolloutStatus": "incumbent",
                    "parameters": {"territorySignalWeight": 1},
                },
                {
                    "candidatePolicyId": "candidate-b",
                    "strategyVariantId": "variant-b",
                    "rolloutStatus": "shadow",
                    "parameters": {"territorySignalWeight": 2},
                },
            ],
        }
        results = [
            {
                "variantId": "variant-a",
                "sampleCount": 1,
                "reward": {"tuple": [0, 0, 0, 0]},
                "evaluatedParameters": {"territorySignalWeight": 1},
            },
            {
                "variantId": "variant-b",
                "sampleCount": 1,
                "reward": {"tuple": [1, 0, 0, 0]},
                "evaluatedParameters": {"territorySignalWeight": 2},
            },
        ]

        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=results,
            report_id="policy-gradient-large-source-weight",
            generated_at="2026-05-22T00:00:00Z",
        )

        self.assertEqual(update["iterations"], 1)
        self.assertEqual(
            update["gradientEstimation"]["estimator"],
            runner.POLICY_GRADIENT_LEXICOGRAPHIC_REINFORCE_ESTIMATOR,
        )
        self.assertNotIn("scalarRewardScaleFactor", update["gradientEstimation"])
        self.assertEqual(update["gradient"], {"territorySignalWeight": 0.125})
        self.assertEqual(update["parameterDelta"], {"territorySignalWeight": 0.025})
        self.assertEqual(update["updatedParameters"], {"territorySignalWeight": 1.025})
        self.assertEqual(
            update["nextCandidatePolicy"]["parameterEvidence"]["parameterDelta"],
            {"territorySignalWeight": 0.025},
        )

    def test_reinforce_lexicographic_gradient_estimator_does_not_let_reliability_weight_mask_lower_tiers(self) -> None:
        policy_gradient = {
            "targetFamily": "test-family",
            "policyUpdate": {
                "algorithm": runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
                "learning_rate": 0.1,
                "gradient_reward_weights": {
                    "reliability": 1_000_000_000_000.0,
                    "territory": 1_000_000.0,
                    "resources": 1_000.0,
                    "kills": 1.0,
                },
                "gradient_stability_gate": {"minimum_samples_per_candidate": 1},
            },
            "runner_support": {
                "runtime_parameter_injection": True,
                "inline_candidates_runtime_injected": True,
                "candidate_parameter_scope": "runtime_injected",
                "simulator_variant_transport": "variant_ids_with_runtime_injected_parameters",
                "policy_update_reward_use": "eligible_with_evaluated_runtime_parameters",
                "runtime_parameter_consumption_status": "consumed",
            },
            "learnableParameters": [
                {"name": "reliabilitySignalWeight", "min": 0, "max": 2},
                {"name": "territorySignalWeight", "min": 0, "max": 2},
                {"name": "resourceSignalWeight", "min": 0, "max": 2},
                {"name": "combatSignalWeight", "min": 0, "max": 2},
            ],
            "candidateParameterVectors": [
                {
                    "candidatePolicyId": "candidate-anchor",
                    "strategyVariantId": "variant-anchor",
                    "rolloutStatus": "incumbent",
                    "parameters": {
                        "reliabilitySignalWeight": 0,
                        "territorySignalWeight": 0,
                        "resourceSignalWeight": 0,
                        "combatSignalWeight": 0,
                    },
                },
                {
                    "candidatePolicyId": "candidate-reliability",
                    "strategyVariantId": "variant-reliability",
                    "rolloutStatus": "shadow",
                    "parameters": {
                        "reliabilitySignalWeight": 1,
                        "territorySignalWeight": 0,
                        "resourceSignalWeight": 0,
                        "combatSignalWeight": 0,
                    },
                },
                {
                    "candidatePolicyId": "candidate-territory",
                    "strategyVariantId": "variant-territory",
                    "rolloutStatus": "shadow",
                    "parameters": {
                        "reliabilitySignalWeight": 0,
                        "territorySignalWeight": 1,
                        "resourceSignalWeight": 0,
                        "combatSignalWeight": 0,
                    },
                },
                {
                    "candidatePolicyId": "candidate-resources",
                    "strategyVariantId": "variant-resources",
                    "rolloutStatus": "shadow",
                    "parameters": {
                        "reliabilitySignalWeight": 0,
                        "territorySignalWeight": 0,
                        "resourceSignalWeight": 1,
                        "combatSignalWeight": 0,
                    },
                },
                {
                    "candidatePolicyId": "candidate-kills",
                    "strategyVariantId": "variant-kills",
                    "rolloutStatus": "shadow",
                    "parameters": {
                        "reliabilitySignalWeight": 0,
                        "territorySignalWeight": 0,
                        "resourceSignalWeight": 0,
                        "combatSignalWeight": 1,
                    },
                },
            ],
        }
        results = [
            {
                "variantId": "variant-anchor",
                "sampleCount": 1,
                "reward": {"tuple": [1, 0, 0, 0]},
                "evaluatedParameters": {
                    "reliabilitySignalWeight": 0,
                    "territorySignalWeight": 0,
                    "resourceSignalWeight": 0,
                    "combatSignalWeight": 0,
                },
            },
            {
                "variantId": "variant-reliability",
                "sampleCount": 1,
                "reward": {"tuple": [2, 0, 0, 0]},
                "evaluatedParameters": {
                    "reliabilitySignalWeight": 1,
                    "territorySignalWeight": 0,
                    "resourceSignalWeight": 0,
                    "combatSignalWeight": 0,
                },
            },
            {
                "variantId": "variant-territory",
                "sampleCount": 1,
                "reward": {"tuple": [1, 5, 0, 0]},
                "evaluatedParameters": {
                    "reliabilitySignalWeight": 0,
                    "territorySignalWeight": 1,
                    "resourceSignalWeight": 0,
                    "combatSignalWeight": 0,
                },
            },
            {
                "variantId": "variant-resources",
                "sampleCount": 1,
                "reward": {"tuple": [1, 0, 7, 0]},
                "evaluatedParameters": {
                    "reliabilitySignalWeight": 0,
                    "territorySignalWeight": 0,
                    "resourceSignalWeight": 1,
                    "combatSignalWeight": 0,
                },
            },
            {
                "variantId": "variant-kills",
                "sampleCount": 1,
                "reward": {"tuple": [1, 0, 0, 11]},
                "evaluatedParameters": {
                    "reliabilitySignalWeight": 0,
                    "territorySignalWeight": 0,
                    "resourceSignalWeight": 0,
                    "combatSignalWeight": 1,
                },
            },
        ]

        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=results,
            report_id="policy-gradient-lexicographic-tier-selection",
            generated_at="2026-05-22T00:02:00Z",
        )

        selected = update["gradientEstimation"]["selectedRewardTierByParameter"]
        per_tier = update["gradientEstimation"]["gradientByRewardTier"]
        self.assertEqual(update["iterations"], 1)
        self.assertEqual(update["policyGradientEstimator"], runner.POLICY_GRADIENT_LEXICOGRAPHIC_REINFORCE_ESTIMATOR)
        self.assertNotEqual(update["policyGradientEstimator"], runner.POLICY_GRADIENT_SCALAR_ESTIMATOR)
        self.assertEqual(
            selected,
            {
                "reliabilitySignalWeight": "reliability",
                "territorySignalWeight": "territory",
                "resourceSignalWeight": "resources",
                "combatSignalWeight": "kills",
            },
        )
        self.assertEqual(per_tier["territorySignalWeight"]["reliability"], 0)
        self.assertGreater(per_tier["territorySignalWeight"]["territory"], 0)
        self.assertEqual(per_tier["resourceSignalWeight"]["reliability"], 0)
        self.assertGreater(per_tier["resourceSignalWeight"]["resources"], 0)
        self.assertEqual(per_tier["combatSignalWeight"]["reliability"], 0)
        self.assertGreater(per_tier["combatSignalWeight"]["kills"], 0)
        self.assertFalse(update["gradientEstimation"]["scalarWeightedSumAuthorized"])
        self.assertEqual(update["gradientEstimation"]["scalarWeightedSumUse"], "not_used")
        self.assertFalse(update["liveEffect"])
        self.assertFalse(update["officialMmoWrites"])
        self.assertFalse(update["officialMmoWritesAllowed"])

    def test_reinforce_policy_update_does_not_move_on_rounded_zero_lexicographic_gradient(self) -> None:
        policy_gradient = {
            "targetFamily": "test-family",
            "policyUpdate": {
                "algorithm": runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
                "learning_rate": 1,
                "bounded_integer_step": True,
                "gradient_reward_weights": {
                    "reliability": 1,
                    "territory": 1,
                    "resources": 1,
                    "kills": 1,
                },
            },
            "runner_support": {
                "runtime_parameter_injection": True,
                "inline_candidates_runtime_injected": True,
                "candidate_parameter_scope": "runtime_injected",
                "simulator_variant_transport": "variant_ids_with_runtime_injected_parameters",
                "policy_update_reward_use": "eligible_with_evaluated_runtime_parameters",
                "runtime_parameter_consumption_status": "consumed",
            },
            "learnableParameters": [{"name": "tinySignalWeight", "min": 0, "max": 10_000_000, "step": 1}],
            "candidateParameterVectors": [
                {
                    "candidatePolicyId": "candidate-a",
                    "strategyVariantId": "variant-a",
                    "rolloutStatus": "incumbent",
                    "parameters": {"tinySignalWeight": 0},
                },
                {
                    "candidatePolicyId": "candidate-b",
                    "strategyVariantId": "variant-b",
                    "rolloutStatus": "shadow",
                    "parameters": {"tinySignalWeight": 10_000_000},
                },
            ],
        }
        results = [
            {
                "variantId": "variant-a",
                "sampleCount": 1,
                "reward": {"tuple": [0, 0, 0, 0]},
                "evaluatedParameters": {"tinySignalWeight": 0},
            },
            {
                "variantId": "variant-b",
                "sampleCount": 1,
                "reward": {"tuple": [0.000001, 0, 0, 0]},
                "evaluatedParameters": {"tinySignalWeight": 10_000_000},
            },
        ]

        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=results,
            report_id="policy-gradient-tiny-signal",
            generated_at="2026-05-22T00:05:00Z",
        )

        raw_tier_gradient = float(
            update["gradientEstimation"]["rawGradientByRewardTier"]["tinySignalWeight"]["reliability"]
        )
        self.assertEqual(update["iterations"], 0)
        self.assertEqual(update["skippedReason"], "bounded_update_no_parameter_change")
        self.assertTrue(update["boundedIntegerStep"])
        self.assertGreater(raw_tier_gradient, 0)
        self.assertLess(raw_tier_gradient, 0.0000005)
        self.assertEqual(runner.round_policy_number(raw_tier_gradient), 0)
        self.assertEqual(update["gradientEstimation"]["selectedRewardTierByParameter"], {"tinySignalWeight": None})
        self.assertEqual(update["rawGradient"], {"tinySignalWeight": 0})
        self.assertEqual(update["gradientEstimation"]["capNormalizedGradient"], {"tinySignalWeight": 0})
        self.assertEqual(update["gradientEstimation"]["directionByParameter"]["tinySignalWeight"]["gradient"], 0)
        self.assertEqual(update["gradient"], update["gradientMomentum"]["rawEmaGradient"])
        self.assertEqual(update["gradientMomentum"]["emaGradient"], {"tinySignalWeight": 0})
        self.assertEqual(update["gradientMomentum"]["directionByParameter"]["tinySignalWeight"]["emaGradient"], 0)
        self.assertEqual(update["gradient"], {"tinySignalWeight": 0})
        self.assertNotIn("parameterDelta", update)
        self.assertNotIn("updatedParameters", update)
        self.assertNotIn("nextCandidatePolicy", update)

    def test_gradient_momentum_config_prefers_raw_ema_round_trip_state(self) -> None:
        raw_previous = 0.00000025
        policy_gradient = {
            "policyUpdate": {
                "gradientMomentum": {
                    "emaDecay": 0.8,
                    "rawEmaGradient": {"tinySignalWeight": raw_previous},
                    "emaGradient": {"tinySignalWeight": 0},
                },
            },
        }

        config = runner.policy_update_gradient_momentum_config(policy_gradient)
        momentum = runner.policy_update_gradient_momentum_evidence(
            policy_gradient=policy_gradient,
            raw_gradient={"tinySignalWeight": raw_previous},
        )

        self.assertAlmostEqual(config["previousEmaGradient"]["tinySignalWeight"], raw_previous, places=12)
        self.assertEqual(momentum["emaGradient"], {"tinySignalWeight": 0})
        self.assertAlmostEqual(momentum["rawEmaGradient"]["tinySignalWeight"], raw_previous, places=12)

    def test_reinforce_gradient_stability_marks_low_sample_update_untrusted(self) -> None:
        update = runner.build_policy_update(
            policy_gradient=reinforce_stability_policy_gradient(),
            results=reinforce_stability_results([[2, 0, 0, 0] for _index in range(5)]),
            report_id="policy-gradient-low-sample",
            generated_at="2026-05-21T21:31:00Z",
        )

        stability = update["gradientStability"]
        self.assertEqual(update["iterations"], 1)
        self.assertTrue(update["trueGradient"])
        self.assertFalse(update["gradientStable"])
        self.assertFalse(update["trustedGradientUpdate"])
        self.assertTrue(update["highVariance"])
        self.assertEqual(update["gradientEstimation"]["capNormalizedGradient"], {"territorySignalWeight": 0.016667})
        self.assertEqual(update["parameterDelta"], {"territorySignalWeight": 0.5})
        self.assertEqual(update["updatedParameters"], {"territorySignalWeight": 6.5})
        self.assertGreater(abs(float(update["gradient"]["territorySignalWeight"])), 0)
        self.assertEqual(stability["classification"], "insufficient_sample_high_variance")
        self.assertEqual(stability["convergenceLabel"], "sample_only_not_convergence")
        self.assertIn("fewer Monte Carlo return samples per candidate", stability["reason"])
        self.assertTrue(stability["sampleOnly"])
        self.assertEqual(stability["insufficientCandidates"][0]["returnSampleCount"], 5)
        self.assertEqual(update["promotionGate"]["status"], "blocked_gradient_stability_untrusted")
        self.assertEqual(update["promotionGate"]["gradientTrustGateReason"], stability["reason"])
        self.assertEqual(update["promotionGate"]["highVarianceReason"], stability["reason"])
        self.assertFalse(update["promotionGate"]["loopAPromotionEligible"])
        self.assertFalse(update["promotionGate"]["loopBPromotionEligible"])
        self.assertIn("gradient_stability", update["promotionGate"]["missingPrerequisites"])
        self.assertFalse(update["nextCandidatePolicy"]["trustedGradientUpdate"])
        self.assertTrue(update["nextCandidatePolicy"]["highVariance"])

    def test_reinforce_gradient_stability_marks_oscillating_direction_untrusted(self) -> None:
        oscillating_returns = [[2, 0, 0, 0] for _index in range(11)] + [[0, 0, 0, 0] for _index in range(9)]
        update = runner.build_policy_update(
            policy_gradient=reinforce_stability_policy_gradient(),
            results=reinforce_stability_results(oscillating_returns),
            report_id="policy-gradient-oscillating",
            generated_at="2026-05-21T21:32:00Z",
        )

        stability = update["gradientStability"]
        direction = stability["directionByParameter"]["territorySignalWeight"]
        self.assertEqual(update["iterations"], 1)
        self.assertTrue(update["trueGradient"])
        self.assertFalse(update["trustedGradientUpdate"])
        self.assertTrue(update["highVariance"])
        self.assertEqual(stability["classification"], "conflicting_direction_high_variance")
        self.assertFalse(direction["directionStable"])
        self.assertEqual(direction["positiveContributionCount"], 11)
        self.assertEqual(direction["negativeContributionCount"], 9)
        self.assertEqual(stability["conflictingParameters"], ["territorySignalWeight"])
        self.assertFalse(update["promotionGate"]["runtimeConsumedPromotionEligible"])
        self.assertFalse(update["promotionGate"]["loopAPromotionEligible"])
        self.assertFalse(update["promotionGate"]["loopBPromotionEligible"])
        self.assertTrue(update["promotionGate"]["runtimeParameterConsumption"])
        self.assertFalse(update["promotionGate"]["liveEffect"])
        self.assertFalse(update["gradientStability"]["officialMmoWritesAllowed"])

    def test_reinforce_too_few_return_samples_marks_update_untrusted(self) -> None:
        update = runner.build_policy_update(
            policy_gradient=reinforce_stability_policy_gradient(),
            results=[
                {
                    "variantId": "variant-a",
                    "sampleCount": 0,
                    "reward": {"tuple": [1, 0, 0, 0]},
                    "evaluatedParameters": {"territorySignalWeight": 6.0},
                },
                {
                    "variantId": "variant-b",
                    "sampleCount": 1,
                    "reward": {"tuple": [2, 0, 0, 0]},
                    "evaluatedParameters": {"territorySignalWeight": 8.0},
                },
            ],
            report_id="policy-gradient-too-few-return-samples",
            generated_at="2026-05-21T21:32:30Z",
        )

        self.assertEqual(update["iterations"], 0)
        self.assertEqual(update["skippedReason"], "fewer_than_two_monte_carlo_return_samples")
        self.assertEqual(update["gradientStability"]["classification"], "insufficient_sample_high_variance")
        self.assertEqual(update["gradientStability"]["totalReturnSampleCount"], 1)
        self.assertFalse(update["trustedGradientUpdate"])
        self.assertTrue(update["highVariance"])
        self.assertTrue(update["parameterEvidence"]["runtimeParameterInjection"])
        self.assertTrue(update["parameterEvidence"]["runtimeParameterConsumption"])
        self.assertFalse(update["parameterEvidence"]["policyUpdateEligible"])
        self.assertTrue(update["promotionGate"]["runtimeParameterConsumption"])
        self.assertFalse(update["promotionGate"]["runtimeConsumedPromotionEligible"])
        self.assertFalse(update["promotionGate"]["loopAPromotionEligible"])
        self.assertFalse(update["promotionGate"]["loopBPromotionEligible"])
        self.assertIn("gradient_stability", update["promotionGate"]["missingPrerequisites"])

    def test_reinforce_gradient_stability_marks_momentum_conflict_untrusted(self) -> None:
        policy_gradient = reinforce_stability_policy_gradient()
        policy_gradient["policyUpdate"]["gradient_momentum"] = {
            "ema_decay": 0.8,
            "previous_ema_gradient": {"territorySignalWeight": 0.25},
            "previous_gradient_estimation_scheme": lexicographic_reinforce_gradient_scheme_identity(),
        }
        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=reinforce_stability_results([[0, 0, 0, 0] for _index in range(20)]),
            report_id="policy-gradient-momentum-conflict",
            generated_at="2026-05-21T21:33:00Z",
        )

        stability = update["gradientStability"]
        momentum = update["gradientMomentum"]
        self.assertEqual(update["iterations"], 1)
        self.assertFalse(update["trustedGradientUpdate"])
        self.assertTrue(update["highVariance"])
        self.assertEqual(stability["classification"], "momentum_conflict_high_variance")
        self.assertFalse(stability["momentumConsistent"])
        self.assertEqual(stability["conflictingMomentumParameters"], ["territorySignalWeight"])
        self.assertFalse(momentum["momentumConsistent"])
        self.assertEqual(momentum["conflictingParameters"], ["territorySignalWeight"])
        self.assertEqual(update["promotionGate"]["status"], "blocked_gradient_stability_untrusted")

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

    def test_rank_weighted_clamped_noop_without_runtime_transport_reports_incomplete_evidence(self) -> None:
        policy_gradient = {
            "targetFamily": "test-family",
            "policyUpdate": {
                "algorithm": runner.RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM,
                "learning_rate": 1,
            },
            "learnableParameters": [{"name": "territorySignalWeight", "min": 0, "max": 30}],
            "candidateParameterVectors": [
                {
                    "candidatePolicyId": "candidate-a",
                    "strategyVariantId": "variant-a",
                    "rolloutStatus": "incumbent",
                    "parameters": {"territorySignalWeight": 30.0},
                },
                {
                    "candidatePolicyId": "candidate-b",
                    "strategyVariantId": "variant-b",
                    "rolloutStatus": "shadow",
                    "parameters": {"territorySignalWeight": 29.0},
                },
            ],
        }
        results = [
            {
                "variantId": "variant-a",
                "sampleCount": 1,
                "reward": {"tuple": [1, 0, 0, 0]},
                "parameters": {"territorySignalWeight": 30.0},
            },
            {
                "variantId": "variant-b",
                "sampleCount": 1,
                "reward": {"tuple": [0, 0, 0, 0]},
                "parameters": {"territorySignalWeight": 29.0},
            },
        ]

        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=results,
            report_id="policy-gradient-clamped-noop",
            generated_at="2026-05-17T03:30:00Z",
        )

        self.assertEqual(update["iterations"], 0)
        self.assertEqual(update["skippedReason"], runner.RUNTIME_PARAMETER_INJECTION_INCOMPLETE_SKIP_REASON)
        self.assertEqual(update["candidateCount"], 2)
        self.assertEqual(update["metadataCandidateCount"], 2)
        self.assertEqual(update["gradient"], {"territorySignalWeight": 1})
        self.assertFalse(update["parameterEvidence"]["runtimeParameterInjection"])
        self.assertFalse(update["parameterEvidence"]["policyUpdateEligible"])
        self.assertNotIn("returnSummary", update)
        self.assertNotIn("nextCandidatePolicy", update)
        self.assertNotIn("updatedParameters", update)
        self.assertNotIn("parameterDelta", update)

    def test_reinforce_clamped_noop_without_runtime_transport_reports_incomplete_evidence(self) -> None:
        policy_gradient = {
            "targetFamily": "test-family",
            "policyUpdate": {
                "algorithm": runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
                "learning_rate": 1,
                "gradient_reward_weights": {
                    "reliability": 1,
                    "territory": 1,
                    "resources": 1,
                    "kills": 1,
                },
            },
            "learnableParameters": [{"name": "territorySignalWeight", "min": 0, "max": 30}],
            "candidateParameterVectors": [
                {
                    "candidatePolicyId": "candidate-a",
                    "strategyVariantId": "variant-a",
                    "rolloutStatus": "incumbent",
                    "parameters": {"territorySignalWeight": 30.0},
                },
                {
                    "candidatePolicyId": "candidate-b",
                    "strategyVariantId": "variant-b",
                    "rolloutStatus": "shadow",
                    "parameters": {"territorySignalWeight": 29.0},
                },
            ],
        }
        results = [
            {
                "variantId": "variant-a",
                "sampleCount": 1,
                "reward": {"tuple": [1, 0, 0, 0]},
                "parameters": {"territorySignalWeight": 30.0},
            },
            {
                "variantId": "variant-b",
                "sampleCount": 1,
                "reward": {"tuple": [0, 0, 0, 0]},
                "parameters": {"territorySignalWeight": 29.0},
            },
        ]

        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=results,
            report_id="policy-gradient-reinforce-clamped-noop",
            generated_at="2026-05-17T03:30:00Z",
        )

        self.assertEqual(update["iterations"], 0)
        self.assertEqual(update["skippedReason"], runner.RUNTIME_PARAMETER_INJECTION_INCOMPLETE_SKIP_REASON)
        self.assertEqual(update["candidateCount"], 2)
        self.assertEqual(update["metadataCandidateCount"], 2)
        self.assertAlmostEqual(float(update["gradient"]["territorySignalWeight"]), 0.008333, places=6)
        self.assertFalse(update["parameterEvidence"]["runtimeParameterInjection"])
        self.assertFalse(update["parameterEvidence"]["policyUpdateEligible"])
        self.assertEqual(update["returnSummary"]["sampleCount"], 2)
        self.assertNotIn("nextCandidatePolicy", update)
        self.assertNotIn("updatedParameters", update)
        self.assertNotIn("parameterDelta", update)

    def test_reinforce_small_gradient_preserves_nonzero_continuous_candidate_delta(self) -> None:
        policy_gradient = {
            "targetFamily": "test-family",
            "policyUpdate": {
                "algorithm": runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
                "learning_rate": 0.25,
                "gradient_reward_weights": {
                    "reliability": 1,
                    "territory": 1,
                    "resources": 1,
                    "kills": 1,
                },
            },
            "runner_support": {
                "runtime_parameter_injection": True,
                "inline_candidates_runtime_injected": True,
                "inline_candidates_applied_to_simulator": True,
                "candidate_parameter_scope": "runtime_injected",
                "simulator_variant_transport": "variant_ids_with_runtime_injected_parameters",
                "policy_update_reward_use": "eligible_with_evaluated_runtime_parameters",
                "runtime_parameter_consumption_status": "consumed",
            },
            "learnableParameters": [{"name": "territorySignalWeight", "min": 0, "max": 30, "step": 1}],
            "candidateParameterVectors": [
                {
                    "candidatePolicyId": "candidate-a",
                    "strategyVariantId": "variant-a",
                    "rolloutStatus": "incumbent",
                    "parameters": {"territorySignalWeight": 6.0},
                },
                {
                    "candidatePolicyId": "candidate-b",
                    "strategyVariantId": "variant-b",
                    "rolloutStatus": "shadow",
                    "parameters": {"territorySignalWeight": 7.0},
                },
            ],
        }
        results = [
            {
                "variantId": "variant-a",
                "sampleCount": 1,
                "reward": {"tuple": [0, 0, 0, 0]},
                "evaluatedParameters": {"territorySignalWeight": 6.0},
            },
            {
                "variantId": "variant-b",
                "sampleCount": 1,
                "reward": {"tuple": [1.02, 0, 0, 0]},
                "evaluatedParameters": {"territorySignalWeight": 7.0},
            },
        ]

        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=results,
            report_id="policy-gradient-small-gradient",
            generated_at="2026-05-17T03:30:00Z",
        )

        self.assertEqual(update["iterations"], 1)
        self.assertEqual(update["learningRate"], 0.25)
        self.assertEqual(update["gradient"], {"territorySignalWeight": 0.0085})
        self.assertEqual(update["parameterDelta"], {"territorySignalWeight": 0.06375})
        self.assertEqual(update["updatedParameters"], {"territorySignalWeight": 6.06375})
        self.assertTrue(update["parameterEvidence"]["policyUpdateEligible"])
        self.assertTrue(update["parameterEvidence"]["runtimeParameterInjection"])
        self.assertEqual(
            update["nextCandidatePolicy"]["parameterEvidence"]["parameterDelta"],
            {"territorySignalWeight": 0.06375},
        )
        self.assertEqual(update["nextCandidatePolicy"]["parameters"], {"territorySignalWeight": 6.06375})
        self.assertFalse(update["liveEffect"])
        self.assertFalse(update["officialMmoWrites"])
        self.assertFalse(update["officialMmoWritesAllowed"])
        self.assertFalse(update["nextCandidatePolicy"]["liveEffect"])
        self.assertFalse(update["nextCandidatePolicy"]["officialMmoWrites"])
        self.assertFalse(update["nextCandidatePolicy"]["officialMmoWritesAllowed"])

    def test_reinforce_bounded_integer_step_emits_one_step_from_clear_scorecard_advantage(self) -> None:
        policy_gradient = {
            "targetFamily": "test-family",
            "policyUpdate": {
                "algorithm": runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
                "learning_rate": 1,
                "bounded_integer_step": True,
                "gradient_reward_weights": {
                    "reliability": 1,
                    "territory": 1,
                    "resources": 1,
                    "kills": 1,
                },
            },
            "runner_support": {
                "runtime_parameter_injection": True,
                "inline_candidates_runtime_injected": True,
                "inline_candidates_applied_to_simulator": True,
                "candidate_parameter_scope": "runtime_injected",
                "simulator_variant_transport": "variant_ids_with_runtime_injected_parameters",
                "policy_update_reward_use": "eligible_with_evaluated_runtime_parameters",
                "runtime_parameter_consumption_status": "consumed",
            },
            "learnableParameters": [{"name": "territorySignalWeight", "min": 0, "max": 30, "step": 1}],
            "candidateParameterVectors": [
                {
                    "candidatePolicyId": "candidate-a",
                    "strategyVariantId": "variant-a",
                    "rolloutStatus": "incumbent",
                    "parameters": {"territorySignalWeight": 6.0},
                },
                {
                    "candidatePolicyId": "candidate-b",
                    "strategyVariantId": "variant-b",
                    "rolloutStatus": "shadow",
                    "parameters": {"territorySignalWeight": 7.0},
                },
            ],
        }
        results = [
            {
                "variantId": "variant-a",
                "sampleCount": 1,
                "reward": {"tuple": [0, 0, 0, 0]},
                "evaluatedParameters": {"territorySignalWeight": 6.0},
            },
            {
                "variantId": "variant-b",
                "sampleCount": 1,
                "reward": {"tuple": [1.02, 0, 0, 0]},
                "evaluatedParameters": {"territorySignalWeight": 7.0},
            },
        ]

        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=results,
            report_id="policy-gradient-bounded-step",
            generated_at="2026-05-17T03:30:00Z",
        )

        self.assertEqual(update["iterations"], 1)
        self.assertTrue(update["boundedIntegerStep"])
        self.assertEqual(update["learningRate"], 1)
        self.assertGreater(float(update["gradient"]["territorySignalWeight"]), 0)
        self.assertEqual(update["parameterDelta"], {"territorySignalWeight": 1})
        self.assertEqual(update["updatedParameters"], {"territorySignalWeight": 7})
        self.assertEqual(update["nextCandidatePolicy"]["parameters"], {"territorySignalWeight": 7})
        self.assertEqual(
            update["nextCandidatePolicy"]["parameterEvidence"]["boundedIntegerStep"],
            True,
        )
        self.assertEqual(
            update["nextCandidatePolicy"]["parameterEvidence"]["parameterDelta"],
            {"territorySignalWeight": 1},
        )

    def test_reinforce_bounded_integer_step_scales_step_count_by_effective_gradient(self) -> None:
        def build_update(learning_rate: float) -> JsonObject:
            policy_gradient = {
                "targetFamily": "test-family",
                "policyUpdate": {
                    "algorithm": runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
                    "learning_rate": learning_rate,
                    "bounded_integer_step": True,
                    "gradient_reward_weights": {
                        "reliability": 1,
                        "territory": 1,
                        "resources": 1,
                        "kills": 1,
                    },
                },
                "runner_support": {
                    "runtime_parameter_injection": True,
                    "inline_candidates_runtime_injected": True,
                    "inline_candidates_applied_to_simulator": True,
                    "candidate_parameter_scope": "runtime_injected",
                    "simulator_variant_transport": "variant_ids_with_runtime_injected_parameters",
                    "policy_update_reward_use": "eligible_with_evaluated_runtime_parameters",
                    "runtime_parameter_consumption_status": "consumed",
                },
                "learnableParameters": [{"name": "territorySignalWeight", "min": 0, "max": 30, "step": 1}],
                "candidateParameterVectors": [
                    {
                        "candidatePolicyId": "candidate-a",
                        "strategyVariantId": "variant-a",
                        "rolloutStatus": "incumbent",
                        "parameters": {"territorySignalWeight": 10.0},
                    },
                    {
                        "candidatePolicyId": "candidate-b",
                        "strategyVariantId": "variant-b",
                        "rolloutStatus": "shadow",
                        "parameters": {"territorySignalWeight": 20.0},
                    },
                ],
            }
            results = [
                {
                    "variantId": "variant-a",
                    "sampleCount": 1,
                    "reward": {"tuple": [0, 0, 0, 0]},
                    "evaluatedParameters": {"territorySignalWeight": 10.0},
                },
                {
                    "variantId": "variant-b",
                    "sampleCount": 1,
                    "reward": {"tuple": [2.4, 0, 0, 0]},
                    "evaluatedParameters": {"territorySignalWeight": 20.0},
                },
            ]
            return runner.build_policy_update(
                policy_gradient=policy_gradient,
                results=results,
                report_id=f"policy-gradient-bounded-step-lr-{learning_rate}",
                generated_at="2026-05-17T03:30:00Z",
            )

        small_update = build_update(0.25)
        large_update = build_update(1)

        self.assertEqual(small_update["iterations"], 1)
        self.assertEqual(large_update["iterations"], 1)
        self.assertTrue(small_update["boundedIntegerStep"])
        self.assertTrue(large_update["boundedIntegerStep"])
        self.assertEqual(small_update["gradient"], large_update["gradient"])
        self.assertAlmostEqual(float(small_update["gradient"]["territorySignalWeight"]), 0.2, places=12)
        self.assertEqual(small_update["parameterDelta"], {"territorySignalWeight": 2})
        self.assertEqual(small_update["updatedParameters"], {"territorySignalWeight": 12})
        self.assertEqual(large_update["parameterDelta"], {"territorySignalWeight": 6})
        self.assertEqual(large_update["updatedParameters"], {"territorySignalWeight": 16})
        self.assertEqual(
            small_update["nextCandidatePolicy"]["parameterEvidence"]["boundedIntegerStep"],
            True,
        )
        self.assertEqual(
            large_update["nextCandidatePolicy"]["parameterEvidence"]["boundedIntegerStep"],
            True,
        )

    def test_reinforce_bounded_integer_step_clamps_at_parameter_bounds(self) -> None:
        policy_gradient = {
            "targetFamily": "test-family",
            "policyUpdate": {
                "algorithm": runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
                "learning_rate": 1,
                "bounded_integer_step": True,
                "gradient_reward_weights": {
                    "reliability": 1,
                    "territory": 1,
                    "resources": 1,
                    "kills": 1,
                },
            },
            "runner_support": {
                "runtime_parameter_injection": True,
                "inline_candidates_runtime_injected": True,
                "inline_candidates_applied_to_simulator": True,
                "candidate_parameter_scope": "runtime_injected",
                "simulator_variant_transport": "variant_ids_with_runtime_injected_parameters",
                "policy_update_reward_use": "eligible_with_evaluated_runtime_parameters",
                "runtime_parameter_consumption_status": "consumed",
            },
            "learnableParameters": [{"name": "territorySignalWeight", "min": 0, "max": 30, "step": 1}],
            "candidateParameterVectors": [
                {
                    "candidatePolicyId": "candidate-a",
                    "strategyVariantId": "variant-a",
                    "rolloutStatus": "incumbent",
                    "parameters": {"territorySignalWeight": 30.0},
                },
                {
                    "candidatePolicyId": "candidate-b",
                    "strategyVariantId": "variant-b",
                    "rolloutStatus": "shadow",
                    "parameters": {"territorySignalWeight": 29.0},
                },
            ],
        }
        results = [
            {
                "variantId": "variant-a",
                "sampleCount": 1,
                "reward": {"tuple": [1, 0, 0, 0]},
                "evaluatedParameters": {"territorySignalWeight": 30.0},
            },
            {
                "variantId": "variant-b",
                "sampleCount": 1,
                "reward": {"tuple": [0, 0, 0, 0]},
                "evaluatedParameters": {"territorySignalWeight": 29.0},
            },
        ]

        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=results,
            report_id="policy-gradient-bounded-step-clamped",
            generated_at="2026-05-17T03:30:00Z",
        )

        self.assertEqual(update["iterations"], 0)
        self.assertEqual(update["skippedReason"], "bounded_update_no_parameter_change")
        self.assertTrue(update["boundedIntegerStep"])
        self.assertTrue(update["parameterEvidence"]["boundedIntegerStep"])
        self.assertEqual(update["parameterEvidence"]["learningRate"], 1)
        self.assertGreater(float(update["gradient"]["territorySignalWeight"]), 0)
        self.assertNotIn("nextCandidatePolicy", update)
        self.assertNotIn("updatedParameters", update)
        self.assertNotIn("parameterDelta", update)

    def test_ready_parameter_evidence_does_not_alias_injection_to_consumption(self) -> None:
        policy_gradient = {
            "runner_support": {
                "runtime_parameter_injection": True,
                "inline_candidates_runtime_injected": True,
                "candidate_parameter_scope": "runtime_injected",
                "simulator_variant_transport": "variant_ids_with_runtime_injected_parameters",
                "policy_update_reward_use": "eligible_with_evaluated_runtime_parameters",
                "runtime_parameter_consumption_status": "missing_runtime_parameter_consumption",
            },
            "candidateParameterVectors": [
                {"strategyVariantId": "variant-a"},
                {"strategyVariantId": "variant-b"},
            ],
        }

        evidence = runner.policy_update_runtime_injection_ready_parameter_evidence(
            policy_gradient,
            [{"strategyVariantId": "variant-a"}, {"strategyVariantId": "variant-b"}],
        )
        gate = runner.policy_update_promotion_gate(evidence, policy_update_generated=True)

        self.assertTrue(evidence["runtimeParameterInjection"])
        self.assertFalse(evidence["runtimeParameterConsumption"])
        self.assertFalse(evidence["policyUpdateEligible"])
        self.assertEqual(
            evidence["eligibilityMode"],
            "blocked_until_runtime_parameter_consumption_evidence",
        )
        self.assertEqual(evidence["runtimeParameterConsumptionStatus"], "missing_runtime_parameter_consumption")
        self.assertEqual(gate["status"], "blocked_runtime_parameter_consumption_missing")
        self.assertFalse(gate["runtimeConsumedPromotionEligible"])
        self.assertFalse(gate["loopAPromotionEligible"])
        self.assertFalse(gate["loopBPromotionEligible"])

    def test_ready_parameter_evidence_accepts_consumed_runtime_status(self) -> None:
        policy_gradient = {
            "runner_support": {
                "runtime_parameter_injection": True,
                "inline_candidates_runtime_injected": True,
                "candidate_parameter_scope": "runtime_injected",
                "simulator_variant_transport": "variant_ids_with_runtime_injected_parameters",
                "policy_update_reward_use": "eligible_with_evaluated_runtime_parameters",
                "runtime_parameter_consumption_status": "consumed",
            },
            "candidateParameterVectors": [
                {"strategyVariantId": "variant-a"},
                {"strategyVariantId": "variant-b"},
            ],
        }

        evidence = runner.policy_update_runtime_injection_ready_parameter_evidence(
            policy_gradient,
            [{"strategyVariantId": "variant-a"}, {"strategyVariantId": "variant-b"}],
        )
        gate = runner.policy_update_promotion_gate(evidence, policy_update_generated=True)

        self.assertTrue(evidence["runtimeParameterInjection"])
        self.assertTrue(evidence["runtimeParameterConsumption"])
        self.assertTrue(evidence["policyUpdateEligible"])
        self.assertEqual(gate["status"], "runtime_consumed_shadow_candidate")
        self.assertTrue(gate["runtimeConsumedPromotionEligible"])
        self.assertTrue(gate["loopAPromotionEligible"])
        self.assertTrue(gate["loopBPromotionEligible"])

    def test_policy_update_promotion_gate_requires_generated_update_for_eligibility(self) -> None:
        policy_gradient = {
            "runner_support": {
                "runtime_parameter_injection": True,
                "inline_candidates_runtime_injected": True,
                "candidate_parameter_scope": "runtime_injected",
                "simulator_variant_transport": "variant_ids_with_runtime_injected_parameters",
                "policy_update_reward_use": "eligible_with_evaluated_runtime_parameters",
                "runtime_parameter_consumption_status": "consumed",
            },
            "candidateParameterVectors": [
                {"strategyVariantId": "variant-a"},
                {"strategyVariantId": "variant-b"},
            ],
        }

        evidence = runner.policy_update_runtime_injection_ready_parameter_evidence(
            policy_gradient,
            [{"strategyVariantId": "variant-a"}, {"strategyVariantId": "variant-b"}],
        )
        gate = runner.policy_update_promotion_gate(
            evidence,
            policy_update_generated=False,
            gradient_stability={"trustedUpdate": True, "gradientStable": True, "highVariance": False},
        )

        self.assertFalse(gate["policyUpdateGenerated"])
        self.assertTrue(gate["runtimeParameterConsumption"])
        self.assertFalse(gate["runtimeConsumedPromotionEligible"])
        self.assertFalse(gate["loopAPromotionEligible"])
        self.assertFalse(gate["loopBPromotionEligible"])

    def test_reinforce_reward_evidence_without_runtime_transport_stays_noop(self) -> None:
        policy_gradient = {
            "targetFamily": "test-family",
            "policyUpdate": {
                "algorithm": runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM,
                "learning_rate": 0.25,
            },
            "learnableParameters": [{"name": "territorySignalWeight", "min": 0, "max": 30, "step": 1}],
            "candidateParameterVectors": [
                {
                    "candidatePolicyId": "candidate-a",
                    "strategyVariantId": "variant-a",
                    "rolloutStatus": "incumbent",
                    "parameters": {"territorySignalWeight": 6.0},
                },
                {
                    "candidatePolicyId": "candidate-b",
                    "strategyVariantId": "variant-b",
                    "rolloutStatus": "shadow",
                    "parameters": {"territorySignalWeight": 7.0},
                },
            ],
        }
        results = [
            {
                "variantId": "variant-a",
                "sampleCount": 1,
                "reward": {"tuple": [0, 0, 0, 0]},
                "evaluatedParameters": {"territorySignalWeight": 6.0},
            },
            {
                "variantId": "variant-b",
                "sampleCount": 1,
                "reward": {"tuple": [1.02, 0, 0, 0]},
                "evaluatedParameters": {"territorySignalWeight": 7.0},
            },
        ]

        update = runner.build_policy_update(
            policy_gradient=policy_gradient,
            results=results,
            report_id="policy-gradient-metadata-reward-only",
            generated_at="2026-05-17T03:30:00Z",
        )

        self.assertEqual(update["iterations"], 0)
        self.assertEqual(update["skippedReason"], runner.RUNTIME_PARAMETER_INJECTION_INCOMPLETE_SKIP_REASON)
        self.assertFalse(update["parameterEvidence"]["policyUpdateEligible"])
        self.assertFalse(update["parameterEvidence"]["runtimeParameterInjection"])
        self.assertNotIn("nextCandidatePolicy", update)
        self.assertNotIn("updatedParameters", update)

    def test_policy_update_bounds_preserve_continuous_values_without_step_quantizing(self) -> None:
        spec = {"min": 0, "max": 30, "step": 1}

        self.assertEqual(runner.bounded_policy_parameter_value(6.06375, spec), 6.06375)
        self.assertEqual(runner.bounded_policy_parameter_value(-0.25, spec), 0)
        self.assertEqual(runner.bounded_policy_parameter_value(30.25, spec), 30)
        self.assertEqual(runner.bounded_policy_parameter_step_value(6.06375, spec), 6)
        self.assertEqual(runner.bounded_policy_parameter_step_value(6.51, spec), 7)
        self.assertEqual(runner.bounded_policy_parameter_step_value(30.25, spec), 30)

    def test_reinforce_metadata_only_parameters_skip_candidate_update_artifact(self) -> None:
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
        card["simulation"]["repetitions"] = 2
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

            self.assertNotIn("STEAM_KEY", os.environ)

        self.assertEqual(len(simulator.calls), 2)
        self.assertTrue(all(call["variants"] == variant_ids for call in simulator.calls))
        self.assertEqual(report["policyUpdateIterations"], 0)
        self.assertEqual(persisted["policyUpdateIterations"], 0)
        self.assertEqual(report["policyUpdateAlgorithm"], runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM)
        self.assertEqual(persisted["policyUpdateAlgorithm"], runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM)
        self.assertFalse(report["trueGradient"])
        self.assertFalse(persisted["trueGradient"])
        self.assertIsNone(report["policyUpdateCandidatePolicyId"])
        self.assertNotIn("policyUpdateArtifactPath", report)
        update = report["policyUpdate"]
        self.assertEqual(update["algorithm"], runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM)
        self.assertEqual(update["skippedReason"], runner.METADATA_ONLY_POLICY_UPDATE_SKIP_REASON)
        self.assertEqual(update["metadataCandidateCount"], len(variant_ids))
        self.assertFalse(update["parameterEvidence"]["runtimeParameterInjection"])
        self.assertFalse(update["parameterEvidence"]["policyUpdateEligible"])

    def test_runtime_injected_reinforce_parameters_create_candidate_update_artifact(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-injected",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T06:25:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
        card["simulation"]["repetitions"] = 1
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
        simulator = MockSimulator(simulator_results, inject_runtime_parameters=True)

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                out_dir,
                report_id="policy-gradient-injected",
                generated_at="2026-05-17T06:30:00Z",
                simulator_runner=simulator,
            )
            persisted = read_json(out_dir / "policy-gradient-injected.json")
            artifact_dir_exists = (out_dir / "policy-candidates").exists()
            artifact_path_exists = Path(report["policyUpdateArtifactPath"]).exists()
            scorecard_path = Path(report["scorecardArtifactPath"])
            scorecard_path_exists = scorecard_path.exists()
            scorecard_payload = read_json(scorecard_path)

        self.assertEqual(report["runtimeParameterInjection"]["status"], "injected")
        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterConsumption"])
        self.assertEqual(report["runtimeParameterInjection"]["runtimeParameterConsumptionStatus"], "consumed")
        self.assertEqual(report["runtimeParameterInjection"]["consumedVariantCount"], len(variant_ids))
        self.assertEqual(report["runtimeParameterInjection"]["injectedVariantCount"], len(variant_ids))
        self.assertTrue(report["runtimeParameterInjection"]["policyUpdateEligible"])
        self.assertIsNotNone(report["scorecardId"])
        self.assertEqual(report["candidateScorecard"]["status"], "materialized")
        self.assertEqual(
            report["candidateScorecard"]["classification"],
            "gradient_stability_untrusted_scorecard_materialized",
        )
        self.assertTrue(report["candidateScorecard"]["runtimeParameterInjection"])
        self.assertTrue(report["candidateScorecard"]["runtimeParameterConsumption"])
        self.assertGreater(report["candidateScorecard"]["injectedVariantCount"], 0)
        self.assertGreater(report["candidateScorecard"]["consumedVariantCount"], 0)
        self.assertTrue(report["candidateScorecard"]["validationScaleComputeBlocked"])
        self.assertTrue(report["candidateScorecard"]["scorecardUsable"])
        self.assertTrue(scorecard_path_exists)
        self.assertEqual(scorecard_payload["runId"], report["scorecardId"])
        self.assertTrue(
            scorecard_payload["overallGate"]["runtimeCandidateGate"]["runtimeParameterInjection"]
        )
        self.assertTrue(report["policyGradient"]["runner_support"]["runtime_parameter_injection"])
        self.assertTrue(report["policyGradient"]["runner_support"]["inline_candidates_applied_to_simulator"])
        self.assertTrue(report["policyGradient"]["runner_support"]["inline_candidates_runtime_injected"])
        self.assertTrue(report["policyGradient"]["runner_support"]["runtime_parameter_consumption"])
        self.assertEqual(report["policyGradient"]["runner_support"]["candidate_parameter_scope"], "runtime_injected")
        self.assertEqual(
            report["policyGradient"]["runner_support"]["runtime_parameter_injected_variant_count"],
            len(variant_ids),
        )
        self.assertEqual(
            report["policyGradient"]["runner_support"]["runtime_parameter_consumed_variant_count"],
            len(variant_ids),
        )
        self.assertEqual(report["policyUpdateIterations"], 1)
        self.assertTrue(report["trueGradient"])
        self.assertTrue(persisted["trueGradient"])
        self.assertFalse(report["gradientStable"])
        self.assertFalse(report["trustedGradientUpdate"])
        self.assertTrue(report["highVariance"])
        self.assertEqual(report["gradientTrustGateReason"], report["gradientStability"]["reason"])
        self.assertEqual(report["highVarianceReason"], report["gradientStability"]["reason"])
        self.assertEqual(report["gradientTrustGateClassification"], "insufficient_sample_high_variance")
        self.assertEqual(
            report["gradientEstimation"]["gradientReward"],
            runner.POLICY_GRADIENT_LEXICOGRAPHIC_PER_TIER_REWARD,
        )
        self.assertIsInstance(report["gradientEstimation"]["schemeIdentity"], dict)
        self.assertEqual(report["gradientEstimationSchemeKey"], report["gradientEstimation"]["schemeKey"])
        self.assertEqual(report["gradientComparisonKey"], report["gradientEstimation"]["comparisonKey"])
        self.assertEqual(report["gradientEstimationScheme"], report["gradientEstimation"]["schemeIdentity"])
        self.assertEqual(
            report["gradientStability"]["gradientSchemeKey"],
            report["gradientEstimation"]["schemeKey"],
        )
        self.assertEqual(report["gradientMomentum"]["type"], runner.GRADIENT_MOMENTUM_EVIDENCE_TYPE)
        self.assertFalse(persisted["trustedGradientUpdate"])
        self.assertEqual(
            persisted["gradientEstimation"]["estimator"],
            runner.POLICY_GRADIENT_LEXICOGRAPHIC_REINFORCE_ESTIMATOR,
        )
        self.assertEqual(persisted["gradientEstimationSchemeKey"], report["gradientEstimation"]["schemeKey"])
        self.assertIsNotNone(report["policyUpdateCandidatePolicyId"])
        self.assertIn("policyUpdateArtifactPath", report)
        self.assertTrue(artifact_dir_exists)
        self.assertTrue(artifact_path_exists)
        self.assertTrue(all(result["runtimeParameterInjection"]["runtimeParameterInjection"] for result in report["variantResults"]))
        self.assertTrue(all(result["runtimeParameterInjection"]["runtimeParameterConsumption"] for result in report["variantResults"]))
        self.assertTrue(
            all(
                result["runtimeParameterInjection"]["runtimeParameterConsumptionStatus"] == "consumed"
                for result in report["variantResults"]
            )
        )
        self.assertTrue(
            all(
                attempt.get("runtimeParameterConsumerVersion")
                == runner.simulator_harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_VERSION
                and attempt.get("consumedParametersSha256") == attempt.get("parametersSha256")
                and isinstance(attempt.get("consumedStrategyVariantId"), str)
                for result in report["variantResults"]
                for attempt in result["runtimeParameterInjection"]["attempts"]
            )
        )
        self.assertTrue(all("evaluatedParameters" in result for result in report["variantResults"]))
        self.assertFalse(report["officialMmoWritesAllowed"])
        self.assertFalse(persisted["officialMmoWritesAllowed"])
        update = report["policyUpdate"]
        self.assertEqual(update["algorithm"], runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM)
        self.assertEqual(update["candidateCount"], len(variant_ids))
        self.assertTrue(update["runtimeParameterConsumption"])
        self.assertEqual(update["consumptionMode"], runner.POLICY_UPDATE_CONSUMPTION_MODE_RUNTIME_CONSUMED)
        self.assertEqual(update["promotionGate"]["status"], "blocked_gradient_stability_untrusted")
        self.assertFalse(update["promotionGate"]["loopAPromotionEligible"])
        self.assertFalse(update["promotionGate"]["loopBPromotionEligible"])
        self.assertFalse(update["nextCandidatePolicy"]["trustedGradientUpdate"])
        self.assertTrue(update["nextCandidatePolicy"]["highVariance"])
        self.assertEqual(
            update["nextCandidatePolicy"]["gradientEstimationSchemeKey"],
            report["gradientEstimation"]["schemeKey"],
        )
        self.assertEqual(
            update["nextCandidatePolicy"]["gradientEstimationScheme"],
            report["gradientEstimation"]["schemeIdentity"],
        )
        self.assertFalse(update["nextCandidatePolicy"]["officialMmoWritesAllowed"])
        self.assertEqual(update["nextCandidatePolicy"]["promotionGate"], update["promotionGate"])
        self.assertFalse(update["liveEffect"])
        self.assertFalse(update["officialMmoWrites"])
        self.assertFalse(update["officialMmoWritesAllowed"])

    def test_scaled_policy_gradient_runtime_injection_uses_card_candidate_parameters(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-scaled-injected",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T06:35:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        expanded_ids = runner.simulator_harness.expand_scale_environment_variants(variant_ids, 5)
        card["simulation"]["workers"] = 5
        card["simulation"]["scale_environments"] = 5
        card["simulation"]["min_concurrent_environments"] = 5
        start = tick(1, [room("W1N1", energy=100)])
        simulator_results: dict[str, JsonObject] = {}
        for variant_id in expanded_ids:
            base_id = runner.simulator_harness.scale_environment_base_variant_id(variant_id)
            if base_id.endswith("territory-seed.v1"):
                simulator_results[variant_id] = variant_result(
                    variant_id,
                    [start, tick(2, [room("W1N1", energy=150), room("W1N2", energy=100)])],
                )
            elif base_id.endswith("resource-seed.v1"):
                simulator_results[variant_id] = variant_result(
                    variant_id,
                    [start, tick(2, [room("W1N1", energy=2400, harvested=1000)])],
                )
            else:
                simulator_results[variant_id] = variant_result(
                    variant_id,
                    [start, tick(2, [room("W1N1", energy=200)])],
                )
        simulator = MockSimulator(simulator_results, inject_runtime_parameters=True)

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                out_dir,
                report_id="policy-gradient-scaled-injected",
                generated_at="2026-05-17T06:40:00Z",
                simulator_runner=simulator,
            )

        self.assertEqual(simulator.calls[0]["variants"], expanded_ids)
        expected_parameters_by_base_id = {
            candidate["strategyVariantId"]: candidate["parameters"]
            for candidate in card["policy_gradient"]["candidate_parameter_vectors"]
        }
        expected_hashes_by_base_id = {
            base_id: runner.canonical_hash(parameters)
            for base_id, parameters in expected_parameters_by_base_id.items()
        }
        expected_source_by_base_id = {
            candidate["strategyVariantId"]: candidate["sourceStrategyId"]
            for candidate in card["policy_gradient"]["candidate_parameter_vectors"]
        }
        observed_hashes_by_base_id: dict[str, str] = {}
        for scaled_variant_id in expanded_ids:
            scaled_config = runner.simulator_harness.strategy_variant_config_by_id(
                scaled_variant_id,
                variant_configs=simulator.calls[0]["variant_configs"],
            )
            base_variant_id = runner.simulator_harness.scale_environment_base_variant_id(scaled_variant_id)
            self.assertIn(base_variant_id, expected_parameters_by_base_id)
            self.assertEqual(scaled_config["parameters"], expected_parameters_by_base_id[base_variant_id])
            self.assertEqual(
                runner.canonical_hash(scaled_config["parameters"]),
                expected_hashes_by_base_id[base_variant_id],
            )
            self.assertEqual(scaled_config["sourceStrategyId"], expected_source_by_base_id[base_variant_id])
            self.assertEqual(scaled_config["scaleEnvironment"]["baseVariantId"], base_variant_id)
            observed_hashes_by_base_id[base_variant_id] = runner.canonical_hash(
                scaled_config["parameters"]
            )
        self.assertEqual(observed_hashes_by_base_id, expected_hashes_by_base_id)
        self.assertEqual(len(set(expected_hashes_by_base_id.values())), len(expected_hashes_by_base_id))
        self.assertEqual(report["runtimeParameterInjection"]["status"], "injected")
        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterConsumption"])
        self.assertEqual(report["runtimeParameterInjection"]["candidateParameterScope"], "runtime_injected")
        self.assertEqual(report["runtimeParameterInjection"]["injectedVariantCount"], len(expanded_ids))
        self.assertEqual(report["runtimeParameterInjection"]["consumedVariantCount"], len(expanded_ids))
        report_rows = {
            row["variantId"]: row
            for row in report["runtimeParameterInjection"]["variants"]
        }
        self.assertTrue(all(row["runtimeParameterConsumption"] for row in report_rows.values()))
        self.assertEqual({row.get("consumedTick") for row in report_rows.values()}, {2})
        self.assertTrue(
            all(isinstance(row.get("consumedParametersSha256"), str) for row in report_rows.values())
        )
        self.assertEqual(
            report_rows["construction-priority.pg.resource-seed.v1.scale-env-03"]["sourceStrategyId"],
            "construction-priority.incumbent.v1",
        )
        resource_result = next(
            item
            for item in report["variantResults"]
            if item["variantId"] == "construction-priority.pg.resource-seed.v1.scale-env-03"
        )
        self.assertEqual(
            resource_result["runtimeParameterInjection"]["sourceStrategyId"],
            "construction-priority.incumbent.v1",
        )
        self.assertTrue(report["runtimeParameterInjection"]["policyUpdateEligible"])
        self.assertEqual(report["policyGradient"]["runner_support"]["candidate_parameter_scope"], "runtime_injected")
        self.assertTrue(report["policyUpdate"]["parameterEvidence"]["runtimeParameterInjection"])
        self.assertTrue(report["policyUpdate"]["parameterEvidence"]["policyUpdateEligible"])
        self.assertEqual(report["policyUpdateIterations"], 1)
        self.assertTrue(report["trueGradient"])
        self.assertFalse(report["policyUpdate"]["liveEffect"])
        self.assertFalse(report["policyUpdate"]["officialMmoWrites"])
        self.assertFalse(report["policyUpdate"]["officialMmoWritesAllowed"])

    def test_policy_gradient_candidate_vectors_feed_private_simulator_prelude(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-prelude-injected",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-22T02:55:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
        target_candidate = card["policy_gradient"]["candidate_parameter_vectors"][1]
        target_variant = next(
            variant
            for variant in card["strategy_variants"]
            if variant["id"] == target_candidate["strategyVariantId"]
        )
        candidate_parameters = copy.deepcopy(target_candidate["parameters"])
        stale_parameters = copy.deepcopy(candidate_parameters)
        stale_parameters["territorySignalWeight"] = candidate_parameters["territorySignalWeight"] - 3
        target_variant["parameters"] = stale_parameters
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        start = tick(1, [room("W1N1", energy=100)])
        simulator = MockSimulator(
            {
                variant_id: variant_result(variant_id, [start, tick(2, [room("W1N1", energy=200)])])
                for variant_id in variant_ids
            },
            inject_runtime_parameters=True,
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="policy-gradient-prelude-injected",
                generated_at="2026-05-22T03:00:00Z",
                simulator_runner=simulator,
            )

        variant_config = simulator.calls[0]["variant_configs"][target_candidate["strategyVariantId"]]
        uploaded_code = simulator.last_uploaded_code_by_variant[target_candidate["strategyVariantId"]]
        candidate_fragment = f'"territorySignalWeight":{candidate_parameters["territorySignalWeight"]}'
        stale_fragment = f'"territorySignalWeight":{stale_parameters["territorySignalWeight"]}'
        self.assertEqual(variant_config["parameters"], candidate_parameters)
        self.assertNotEqual(variant_config["parameters"], stale_parameters)
        self.assertIn(runner.simulator_harness.RUNTIME_PARAMETER_INJECTION_GLOBAL, uploaded_code)
        self.assertIn(candidate_fragment, uploaded_code)
        self.assertNotIn(stale_fragment, uploaded_code)
        self.assertEqual(report["runtimeParameterInjection"]["status"], "injected")
        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterConsumption"])
        self.assertEqual(
            report["policyGradient"]["runner_support"]["policy_update_reward_use"],
            "eligible_with_evaluated_runtime_parameters",
        )

    def test_runtime_injected_reinforce_consumes_js_canonical_numeric_parameters(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-js-canonical-consumed",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-23T02:45:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
        for candidate in card["policy_gradient"]["candidate_parameter_vectors"]:
            candidate["parameters"] = {
                key: float(value) if isinstance(value, int) and not isinstance(value, bool) else value
                for key, value in candidate["parameters"].items()
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
        simulator = MockSimulator(
            simulator_results,
            inject_runtime_parameters=True,
            js_runtime_numeric_canonicalization=True,
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="policy-gradient-js-canonical-consumed",
                generated_at="2026-05-23T02:50:00Z",
                simulator_runner=simulator,
            )

        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterConsumption"])
        self.assertGreater(report["runtimeParameterInjection"]["consumedVariantCount"], 0)
        self.assertEqual(report["runtimeParameterInjection"]["runtimeParameterConsumptionStatus"], "consumed")
        self.assertTrue(report["policyGradient"]["runner_support"]["runtime_parameter_consumption"])
        self.assertTrue(report["policyUpdate"]["runtimeParameterConsumption"])
        self.assertFalse(report["liveEffect"])
        self.assertFalse(report["officialMmoWrites"])
        self.assertFalse(report["officialMmoWritesAllowed"])
        self.assertTrue(
            all(
                result["runtimeParameterInjection"]["runtimeParameterConsumption"]
                for result in report["variantResults"]
            )
        )
        self.assertTrue(
            all(
                result["runtimeParameterInjection"]["evaluatedParameters"]
                == runner.simulator_harness.canonical_runtime_parameter_value(result["parameters"])
                for result in report["variantResults"]
            )
        )

    def test_scorecard_materialization_error_blocks_scorecard_without_crashing(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-scorecard-error",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T06:30:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
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
        simulator = MockSimulator(simulator_results, inject_runtime_parameters=True)

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            write_json(card_path, card)
            with mock.patch.object(
                runner.scorecard_helper,
                "build_scorecard",
                side_effect=runner.scorecard_helper.ScorecardError("fixture scorecard failure"),
            ):
                report = runner.run_training_experiment(
                    card_path,
                    out_dir,
                    report_id="policy-gradient-scorecard-error",
                    generated_at="2026-05-17T06:30:00Z",
                    simulator_runner=simulator,
                )
            persisted = read_json(out_dir / "policy-gradient-scorecard-error.json")

        self.assertEqual(report["candidateScorecard"]["status"], "blocked")
        self.assertEqual(
            report["candidateScorecard"]["classification"],
            "candidate_scorecard_materialization_failed",
        )
        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertTrue(report["candidateScorecard"]["runtimeParameterInjection"])
        self.assertGreater(report["candidateScorecard"]["injectedVariantCount"], 0)
        self.assertEqual(report["candidateScorecard"]["candidateParameterScope"], "runtime_injected")
        self.assertIsNotNone(report["candidateScorecard"]["candidateStrategyId"])
        self.assertIsNotNone(report["candidateScorecard"]["baselineStrategyId"])
        self.assertIsNotNone(report["candidateScorecard"]["candidateRank"])
        self.assertIsNotNone(report["candidateScorecard"]["baselineRank"])
        self.assertIn("materialization", report["candidateScorecard"]["nextAction"])
        self.assertFalse(report["candidateScorecard"]["scorecardUsable"])
        self.assertIsNone(report["scorecardId"])
        self.assertIsNone(report["scorecardArtifactPath"])
        self.assertTrue(
            any("candidate scorecard artifact generation skipped" in warning for warning in report["warnings"])
        )
        self.assertEqual(report["candidateScorecards"]["status"], "blocked")
        self.assertEqual(
            report["candidateScorecards"]["classification"],
            "candidate_scorecard_materialization_failed",
        )
        self.assertEqual(
            report["candidateScorecards"]["blockedComparisonCount"],
            len(report["candidateScorecards"]["comparisons"]),
        )
        self.assertTrue(
            all(item["status"] == "blocked" for item in report["candidateScorecards"]["comparisons"])
        )
        self.assertTrue(
            all(item["scorecardArtifactPath"] is None for item in report["candidateScorecards"]["comparisons"])
        )
        self.assertEqual(persisted["candidateScorecard"]["status"], "blocked")
        self.assertTrue(persisted["candidateScorecard"]["runtimeParameterInjection"])
        self.assertIn("materialization", persisted["candidateScorecard"]["nextAction"])
        self.assertIsNone(persisted["scorecardArtifactPath"])

    def test_runtime_injected_reinforce_without_evaluated_parameters_uses_metadata_fallback_only(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-missing-evaluated",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T06:45:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        start = tick(1, [room("W1N1", energy=100)])
        simulator_results = {
            variant_id: variant_result(variant_id, [start, tick(2, [room("W1N1", energy=200)])])
            for variant_id in variant_ids
        }
        simulator = MockSimulator(
            simulator_results,
            inject_runtime_parameters=True,
            include_evaluated_parameters=False,
            include_runtime_consumption_parameters=False,
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                out_dir,
                report_id="policy-gradient-missing-evaluated",
                generated_at="2026-05-17T06:50:00Z",
                simulator_runner=simulator,
            )

        self.assertEqual(report["runtimeParameterInjection"]["status"], "injected")
        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertFalse(report["runtimeParameterInjection"]["runtimeParameterConsumption"])
        self.assertFalse(report["runtimeParameterInjection"]["policyUpdateEligible"])
        self.assertEqual(report["runtimeParameterInjection"]["candidateParameterScope"], "runtime_injected")
        self.assertEqual(report["runtimeParameterInjection"]["injectedVariantCount"], len(variant_ids))
        self.assertEqual(report["runtimeParameterInjection"]["consumedVariantCount"], 0)
        self.assertEqual(
            report["policyUpdate"]["skippedReason"],
            "bounded_update_no_parameter_change",
        )
        self.assertTrue(report["policyUpdate"]["parameterEvidence"]["runtimeParameterInjection"])
        self.assertTrue(report["policyUpdate"]["parameterEvidence"]["policyUpdateEligible"])
        self.assertEqual(
            report["policyUpdate"]["parameterEvidence"]["eligibilityMode"],
            "runtime_injected_metadata_scorecard_ranking",
        )
        self.assertEqual(
            report["policyGradient"]["runner_support"]["policy_update_reward_use"],
            "runtime_injected_metadata_scorecard_ranking",
        )
        self.assertFalse(report["trueGradient"])
        self.assertIsNotNone(report["gradientEstimation"])
        self.assertNotIn("policyUpdateArtifactPath", report)
        self.assertTrue(
            all("evaluatedParameters" not in result for result in report["variantResults"])
        )
        self.assertTrue(
            all(
                result["runtimeParameterConsumption"].get("runtimeParameterConsumption") is True
                for result in simulator.last_variants
            )
        )
        self.assertTrue(
            all(
                "evaluatedParameters" not in result["runtimeParameterConsumption"]
                for result in simulator.last_variants
            )
        )
        self.assertTrue(
            all(
                "evidence" in result["runtimeParameterConsumption"]
                for result in simulator.last_variants
            )
        )

    def test_runtime_injected_reinforce_without_consumption_probe_still_requires_reward_signal(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-missing-consumption",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T06:55:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
        card["simulation"]["repetitions"] = 1
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        start = tick(1, [room("W1N1", energy=100)])
        simulator_results = {
            variant_id: variant_result(variant_id, [start, tick(2, [room("W1N1", energy=200)])])
            for variant_id in variant_ids
        }
        simulator = MockSimulator(
            simulator_results,
            inject_runtime_parameters=True,
            include_runtime_consumption_evidence=False,
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="policy-gradient-missing-consumption",
                generated_at="2026-05-17T07:00:00Z",
                simulator_runner=simulator,
            )

        self.assertEqual(report["runtimeParameterInjection"]["status"], "injected")
        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertFalse(report["runtimeParameterInjection"]["policyUpdateEligible"])
        self.assertEqual(report["runtimeParameterInjection"]["candidateParameterScope"], "runtime_injected")
        self.assertEqual(report["runtimeParameterInjection"]["injectedVariantCount"], len(variant_ids))
        self.assertFalse(report["runtimeParameterInjection"]["runtimeParameterConsumption"])
        self.assertEqual(report["runtimeParameterInjection"]["consumedVariantCount"], 0)
        self.assertEqual(
            report["runtimeParameterInjection"]["runtimeParameterConsumptionStatus"],
            "missing_runtime_parameter_consumption",
        )
        self.assertIn("not every candidate reported consumption", report["runtimeParameterInjection"]["reason"])
        self.assertTrue(
            all(
                "did not all report consumed runtime policy parameter evidence"
                in result["runtimeParameterInjection"]["reason"]
                for result in report["variantResults"]
            )
        )
        self.assertEqual(report["policyUpdateIterations"], 0)
        self.assertEqual(
            report["policyUpdate"]["skippedReason"],
            "bounded_update_no_parameter_change",
        )
        self.assertFalse(report["trustedGradientUpdate"])
        self.assertTrue(report["policyUpdate"]["parameterEvidence"]["policyUpdateEligible"])
        self.assertTrue(report["policyUpdate"]["parameterEvidence"]["runtimeParameterInjection"])
        self.assertEqual(
            report["policyUpdate"]["parameterEvidence"]["eligibilityMode"],
            "runtime_injected_metadata_scorecard_ranking",
        )
        self.assertEqual(
            report["policyGradient"]["runner_support"]["policy_update_reward_use"],
            "runtime_injected_metadata_scorecard_ranking",
        )
        self.assertIn("gradientEstimation", report["policyUpdate"])
        self.assertTrue(report["policyGradient"]["runner_support"]["inline_candidates_applied_to_simulator"])
        self.assertTrue(report["policyGradient"]["runner_support"]["inline_candidates_runtime_injected"])
        self.assertTrue(report["policyGradient"]["runner_support"]["runtime_parameter_injection"])
        self.assertFalse(report["policyGradient"]["runner_support"]["runtime_parameter_consumption"])
        self.assertFalse(report["policyUpdate"]["promotionGate"]["runtimeParameterConsumption"])
        self.assertFalse(report["policyUpdate"]["promotionGate"]["loopAPromotionEligible"])
        self.assertFalse(report["policyUpdate"]["promotionGate"]["loopBPromotionEligible"])
        self.assertTrue(
            all(
                "consumedParametersSha256" not in attempt
                and "consumedStrategyVariantId" not in attempt
                and "runtimeParameterConsumerVersion" not in attempt
                for result in report["variantResults"]
                for attempt in result["runtimeParameterInjection"]["attempts"]
            )
        )
        self.assertNotIn("policyUpdateArtifactPath", report)
        self.assertFalse(report["liveEffect"])
        self.assertFalse(report["officialMmoWrites"])
        self.assertFalse(report["officialMmoWritesAllowed"])
        self.assertFalse(report["policyUpdate"]["liveEffect"])
        self.assertFalse(report["policyUpdate"]["officialMmoWrites"])
        self.assertFalse(report["policyUpdate"]["officialMmoWritesAllowed"])
        self.assertTrue(all("evaluatedParameters" in result for result in simulator.last_variants))
        self.assertTrue(all("runtimeParameterConsumption" not in result for result in simulator.last_variants))

    def test_direct_game_loop_consumption_evidence_reaches_training_report_and_scorecard(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-direct-consumption",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-25T14:31:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
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
        mismatched_standard_parameters: dict[str, JsonObject] = {}
        for variant in card["strategy_variants"]:
            parameters = copy.deepcopy(variant["parameters"])
            parameters["territorySignalWeight"] = parameters["territorySignalWeight"] + 1
            mismatched_standard_parameters[variant["id"]] = parameters
        simulator = MockSimulator(
            simulator_results,
            inject_runtime_parameters=True,
            include_runtime_consumption_evidence=True,
            include_direct_game_loop_consumption_evidence=True,
            evaluated_parameters_by_variant=mismatched_standard_parameters,
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                out_dir,
                report_id="policy-gradient-direct-consumption",
                generated_at="2026-05-25T14:32:00Z",
                simulator_runner=simulator,
            )
            scorecard_payload = read_json(Path(report["scorecardArtifactPath"]))

        self.assertEqual(report["runtimeParameterInjection"]["status"], "injected")
        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterConsumption"])
        self.assertEqual(report["runtimeParameterInjection"]["runtimeParameterConsumptionStatus"], "consumed")
        self.assertEqual(report["runtimeParameterInjection"]["consumedVariantCount"], len(variant_ids))
        self.assertTrue(report["runtimeParameterInjection"]["policyUpdateEligible"])
        self.assertTrue(report["candidateScorecard"]["runtimeParameterConsumption"])
        self.assertGreater(report["candidateScorecard"]["consumedVariantCount"], 0)
        self.assertTrue(scorecard_payload["overallGate"]["runtimeCandidateGate"]["runtimeParameterConsumption"])
        self.assertEqual(
            scorecard_payload["overallGate"]["runtimeCandidateGate"]["runtimeParameterConsumptionSource"],
            runner.simulator_harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE,
        )
        self.assertTrue(
            all(
                result["runtimeParameterInjection"]["runtimeParameterConsumption"]
                for result in report["variantResults"]
            )
        )
        self.assertTrue(
            all(
                result["runtimeParameterInjection"]["runtimeParameterConsumptionSource"]
                == runner.simulator_harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE
                for result in report["variantResults"]
            )
        )
        self.assertTrue(
            all(
                result["runtimeParameterConsumption"]["fallbackRuntimeParameterConsumptionStatus"] == "invalid"
                for result in simulator.last_variants
            )
        )
        self.assertTrue(
            all(
                result["runtimeParameterConsumption"]["fallbackRuntimeParameterConsumptionSource"]
                == "runtime_policy_parameter_consumption"
                for result in simulator.last_variants
            )
        )
        self.assertTrue(
            all(
                "disagreed"
                in result["runtimeParameterConsumption"]["fallbackRuntimeParameterConsumptionReason"]
                for result in simulator.last_variants
            )
        )
        self.assertFalse(report["officialMmoWrites"])
        self.assertFalse(report["policyUpdate"]["officialMmoWrites"])

    def test_active_code_direct_consumption_reaches_training_report(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-active-code-direct-consumption",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-26T03:10:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
        card["simulation"]["branch"] = "active-code-direct-consumption-test"
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        start = tick(1, [room("W1N1", energy=100)])
        simulator_results = {
            variant_id: variant_result(variant_id, [start, tick(2, [room("W1N1", energy=200)])])
            for variant_id in variant_ids
        }
        simulator = MockSimulator(
            simulator_results,
            inject_runtime_parameters=True,
            include_runtime_consumption_evidence=False,
            include_active_code_direct_consumption_evidence=True,
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="policy-gradient-active-code-direct-consumption",
                generated_at="2026-05-26T03:11:00Z",
                simulator_runner=simulator,
            )
            scorecard_payload = read_json(Path(report["scorecardArtifactPath"]))

        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterConsumption"])
        self.assertEqual(report["runtimeParameterInjection"]["runtimeParameterConsumptionStatus"], "consumed")
        self.assertEqual(report["runtimeParameterInjection"]["consumedVariantCount"], len(variant_ids))
        self.assertTrue(report["policyGradient"]["runner_support"]["runtime_parameter_consumption"])
        self.assertTrue(report["candidateScorecard"]["runtimeParameterConsumption"])
        self.assertGreater(report["candidateScorecard"]["consumedVariantCount"], 0)
        readback_branch = runner.simulator_harness.normalize_private_server_code_branch(
            card["simulation"]["branch"]
        )
        self.assertEqual(simulator.calls[0]["branch"], card["simulation"]["branch"])
        self.assertTrue(
            all(
                result["activeCodeReadback"]["branch"] == readback_branch
                and result["activeCodeReadback"]["activeBranch"] == readback_branch
                for result in simulator.last_variants
            )
        )
        self.assertTrue(scorecard_payload["overallGate"]["runtimeCandidateGate"]["runtimeParameterConsumption"])
        self.assertEqual(
            scorecard_payload["overallGate"]["runtimeCandidateGate"]["runtimeParameterConsumptionSource"],
            runner.simulator_harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE,
        )
        self.assertTrue(
            all(
                row["runtimeParameterConsumption"]
                for row in report["runtimeParameterInjection"]["variants"]
            )
        )
        self.assertTrue(
            all(
                row["runtimeParameterConsumptionSource"]
                == runner.simulator_harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE
                for row in report["runtimeParameterInjection"]["variants"]
            )
        )
        self.assertTrue(
            all(
                result["runtimeParameterConsumption"]["source"]
                == runner.simulator_harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE
                for result in simulator.last_variants
            )
        )
        self.assertTrue(
            all(
                result["activeCodeReadback"]["activeRuntimeParameterInjection"]["parametersSha256"]
                == result["runtimeParameterInjection"]["parametersSha256"]
                for result in simulator.last_variants
            )
        )
        self.assertFalse(report["officialMmoWrites"])
        self.assertFalse(report["policyUpdate"]["officialMmoWritesAllowed"])

    def test_runtime_injected_metadata_ranking_materializes_reinforce_update_without_consumption_probe(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-metadata-ranking",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T07:02:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
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
        simulator = MockSimulator(
            simulator_results,
            inject_runtime_parameters=True,
            include_runtime_consumption_evidence=False,
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                out_dir,
                report_id="policy-gradient-metadata-ranking",
                generated_at="2026-05-17T07:03:00Z",
                simulator_runner=simulator,
            )
            persisted = read_json(out_dir / "policy-gradient-metadata-ranking.json")
            scorecard_payload = read_json(Path(report["scorecardArtifactPath"]))
            artifact_path = Path(report["policyUpdateArtifactPath"])
            artifact = read_json(artifact_path)

        self.assertEqual(report["runtimeParameterInjection"]["status"], "injected")
        self.assertTrue(report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertFalse(report["runtimeParameterInjection"]["policyUpdateEligible"])
        self.assertEqual(report["runtimeParameterInjection"]["candidateParameterScope"], "runtime_injected")
        self.assertEqual(
            report["runtimeParameterInjection"]["runtimeParameterConsumptionStatus"],
            "missing_runtime_parameter_consumption",
        )
        self.assertEqual(report["runtimeParameterInjection"]["injectedVariantCount"], len(variant_ids))
        self.assertFalse(report["runtimeParameterInjection"]["runtimeParameterConsumption"])
        self.assertEqual(report["runtimeParameterInjection"]["consumedVariantCount"], 0)
        self.assertEqual(report["policyUpdateIterations"], 1)
        self.assertEqual(persisted["policyUpdateIterations"], 1)
        self.assertTrue(report["trueGradient"])
        self.assertFalse(report["trustedGradientUpdate"])
        self.assertIsNotNone(report["gradientEstimation"])
        self.assertIsNotNone(report["policyUpdate"]["gradientEstimation"])
        self.assertEqual(
            report["policyGradient"]["runner_support"]["policy_update_reward_use"],
            "runtime_injected_metadata_scorecard_ranking",
        )
        self.assertTrue(report["policyGradient"]["runner_support"]["inline_candidates_applied_to_simulator"])
        self.assertTrue(report["policyGradient"]["runner_support"]["inline_candidates_runtime_injected"])
        self.assertTrue(report["policyGradient"]["runner_support"]["runtime_parameter_injection"])
        self.assertFalse(report["policyGradient"]["runner_support"]["runtime_parameter_consumption"])
        self.assertEqual(report["candidateScorecard"]["status"], "materialized")
        self.assertEqual(
            report["candidateScorecard"]["classification"],
            "runtime_parameter_consumption_missing_scorecard_materialized",
        )
        self.assertTrue(report["candidateScorecard"]["runtimeParameterInjection"])
        self.assertFalse(report["candidateScorecard"]["runtimeParameterConsumption"])
        self.assertEqual(report["candidateScorecard"]["missingPrerequisite"], "runtime_parameter_consumption")
        self.assertEqual(report["candidateScorecard"]["overallGate"]["status"], "HOLD")
        self.assertFalse(report["candidateScorecard"]["overallGate"]["runtimeParameterInjectionProven"])
        self.assertEqual(scorecard_payload["overallGate"]["status"], "HOLD")
        self.assertFalse(
            scorecard_payload["overallGate"]["runtimeCandidateGate"]["runtimeParameterInjection"]
        )
        self.assertTrue(report["candidateScorecard"]["validationScaleComputeBlocked"])
        self.assertTrue(report["candidateScorecard"]["scorecardUsable"])
        self.assertIsNotNone(report["candidateScorecard"]["candidateRank"])
        self.assertIsNotNone(report["candidateScorecard"]["baselineRank"])
        self.assertEqual(report["candidateScorecards"]["status"], "materialized")
        self.assertGreater(len(report["ranking"]), 1)
        self.assertIn("policyUpdateArtifactPath", report)
        update = report["policyUpdate"]
        step_by_parameter = {
            item["name"]: item.get("step", 1)
            for item in report["policyGradient"]["learnable_parameters"]
            if isinstance(item, dict) and isinstance(item.get("name"), str)
        }
        self.assertTrue(update["boundedIntegerStep"])
        self.assertFalse(update["liveEffect"])
        self.assertFalse(update["officialMmoWrites"])
        self.assertFalse(update["officialMmoWritesAllowed"])
        self.assertTrue(update["parameterEvidence"]["runtimeParameterInjection"])
        self.assertTrue(update["parameterEvidence"]["policyUpdateEligible"])
        self.assertEqual(
            update["parameterEvidence"]["eligibilityMode"],
            "runtime_injected_metadata_scorecard_ranking",
        )
        self.assertFalse(update["parameterEvidence"]["runtimeParameterConsumption"])
        self.assertEqual(
            update["consumptionMode"],
            runner.POLICY_UPDATE_CONSUMPTION_MODE_SCORECARD_NON_CONSUMED,
        )
        self.assertEqual(
            update["promotionGate"]["status"],
            "blocked_runtime_parameter_consumption_missing",
        )
        self.assertFalse(update["promotionGate"]["runtimeConsumedPromotionEligible"])
        self.assertFalse(update["promotionGate"]["loopAPromotionEligible"])
        self.assertFalse(update["promotionGate"]["loopBPromotionEligible"])
        self.assertEqual(update["promotionGate"]["missingPrerequisites"], ["runtime_parameter_consumption"])
        self.assertTrue(any(abs(float(value)) > 0 for value in update["parameterDelta"].values()))
        for name, delta in update["parameterDelta"].items():
            step = float(step_by_parameter[name])
            if abs(float(delta)) > 0:
                self.assertAlmostEqual(abs(float(delta)) / step, round(abs(float(delta)) / step), places=9)
        self.assertEqual(artifact["parameters"], update["updatedParameters"])
        self.assertTrue(artifact["parameterEvidence"]["boundedIntegerStep"])
        self.assertEqual(artifact["promotionGate"], update["promotionGate"])
        self.assertEqual(update["nextCandidatePolicy"]["promotionGate"], update["promotionGate"])

    def test_failed_only_runtime_parameter_uploads_do_not_become_injected_evidence(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-failed-only",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T07:05:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        simulator_results: dict[str, JsonObject] = {}
        for variant_id in variant_ids:
            result = variant_result(variant_id, [tick(1, [room("W1N1", energy=100)])])
            result["ok"] = False
            result["error"] = "simulator tick failed after upload"
            simulator_results[variant_id] = result
        simulator = MockSimulator(simulator_results, inject_runtime_parameters=True)

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="policy-gradient-failed-only",
                generated_at="2026-05-17T07:10:00Z",
                simulator_runner=simulator,
            )

        self.assertEqual(report["runtimeParameterInjection"]["status"], "not_injected")
        self.assertFalse(report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertEqual(report["runtimeParameterInjection"]["candidateParameterScope"], "runtime_injected")
        self.assertEqual(report["runtimeParameterInjection"]["injectedVariantCount"], 0)
        self.assertEqual(
            report["policyUpdate"]["skippedReason"],
            runner.RUNTIME_PARAMETER_INJECTION_INCOMPLETE_SKIP_REASON,
        )
        self.assertFalse(report["trueGradient"])

    def test_partial_runtime_parameter_injection_keeps_incomplete_skip_reason(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-partial-injected",
            code_commit="f" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T07:25:00Z",
            simulation_ticks=100,
            simulation_repetitions=1,
        )
        variant_ids = [variant["id"] for variant in card["strategy_variants"]]
        start = tick(1, [room("W1N1", energy=100)])
        simulator_results = {
            variant_id: variant_result(variant_id, [start, tick(2, [room("W1N1", energy=200)])])
            for variant_id in variant_ids
        }
        drifted_variant = card["strategy_variants"][0]
        drifted_parameters = {
            **drifted_variant["parameters"],
            "territorySignalWeight": drifted_variant["parameters"]["territorySignalWeight"] + 1,
        }
        simulator = MockSimulator(
            simulator_results,
            inject_runtime_parameters=True,
            evaluated_parameters_by_variant={drifted_variant["id"]: drifted_parameters},
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            write_json(card_path, card)
            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="policy-gradient-partial-injected",
                generated_at="2026-05-17T07:30:00Z",
                simulator_runner=simulator,
            )

        self.assertEqual(report["runtimeParameterInjection"]["status"], "partial")
        self.assertEqual(report["runtimeParameterInjection"]["candidateParameterScope"], "partial_runtime_injection")
        self.assertFalse(report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertEqual(
            report["policyGradient"]["runner_support"]["candidate_parameter_scope"],
            "partial_runtime_injection",
        )
        self.assertEqual(
            report["policyUpdate"]["skippedReason"],
            runner.RUNTIME_PARAMETER_INJECTION_INCOMPLETE_SKIP_REASON,
        )
        drifted_result = next(result for result in report["variantResults"] if result["variantId"] == drifted_variant["id"])
        self.assertIn("disagreed", drifted_result["runtimeParameterInjection"]["reason"])

    def test_loop_a_metadata_only_parameters_skip_candidate_update_artifact(self) -> None:
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

        self.assertEqual(report["policyUpdateIterations"], 0)
        self.assertEqual(persisted["policyUpdateIterations"], 0)
        self.assertEqual(report["policyUpdateAlgorithm"], runner.TRUE_GRADIENT_POLICY_UPDATE_ALGORITHM)
        self.assertFalse(report["trueGradient"])
        self.assertEqual(report["policyGradient"]["policy_update"]["learning_rate"], 1)
        update = report["policyUpdate"]
        self.assertEqual(update["iterations"], 0)
        self.assertEqual(update["skippedReason"], runner.METADATA_ONLY_POLICY_UPDATE_SKIP_REASON)
        self.assertEqual(update["metadataCandidateCount"], len(variant_ids))
        self.assertFalse(update["liveEffect"])
        self.assertFalse(update["officialMmoWrites"])
        self.assertFalse(update["officialMmoWritesAllowed"])
        self.assertIsNone(report["policyUpdateCandidatePolicyId"])
        self.assertNotIn("policyUpdateArtifactPath", report)

    def test_policy_gradient_metadata_only_parameters_skip_bounded_update_artifact(self) -> None:
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

        self.assertEqual(report["policyUpdateIterations"], 0)
        self.assertEqual(persisted["policyUpdateIterations"], 0)
        self.assertEqual(report["policyUpdateAlgorithm"], runner.RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM)
        self.assertFalse(report["trueGradient"])
        update = report["policyUpdate"]
        self.assertEqual(update["iterations"], 0)
        self.assertEqual(update["algorithm"], runner.RANK_WEIGHTED_FINITE_DIFFERENCE_ALGORITHM)
        self.assertEqual(update["skippedReason"], runner.METADATA_ONLY_POLICY_UPDATE_SKIP_REASON)
        self.assertEqual(update["metadataCandidateCount"], len(variant_ids))
        self.assertFalse(update["liveEffect"])
        self.assertFalse(update["officialMmoWrites"])
        self.assertFalse(update["officialMmoWritesAllowed"])
        self.assertFalse(update["parameterEvidence"]["policyUpdateEligible"])
        self.assertIsNone(report["policyUpdateCandidatePolicyId"])
        self.assertNotIn("policyUpdateArtifactPath", report)

    def test_policy_gradient_metadata_only_skips_card_parameter_drift_update(self) -> None:
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

            report = runner.run_training_experiment(
                card_path,
                root / "reports",
                report_id="policy-gradient-drift",
                simulator_runner=MockSimulator(simulator_results),
            )

        self.assertEqual(report["policyUpdateIterations"], 0)
        self.assertEqual(report["policyUpdate"]["skippedReason"], runner.METADATA_ONLY_POLICY_UPDATE_SKIP_REASON)
        self.assertNotIn("policyUpdateArtifactPath", report)

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

    def test_private_runner_pre_scale_smoke_gate_runs_probe_ticks_before_scale(self) -> None:
        calls: list[JsonObject] = []
        variants = [
            runner.StrategyVariant(
                id="candidate.scale-env-01",
                family="test-family",
                parameters={"knob": 1},
            ),
            runner.StrategyVariant(
                id="candidate.scale-env-02",
                family="test-family",
                parameters={"knob": 1},
            ),
        ]
        config = runner.SimulationConfig(
            ticks=500,
            workers=5,
            repetitions=1,
            host_port_start=24125,
            room="E1S1",
            shard="shardX",
            branch="activeWorld",
            code_path=Path("prod/dist/main.js"),
            map_source_file=Path("maps/map-0b6758af.json"),
            simulator_out_dir=Path("runtime-artifacts/rl-simulator-test"),
            scale_environments=5,
            min_concurrent_environments=5,
        )

        def smoke_variant_result(variant_id: str, variant_configs: JsonObject) -> JsonObject:
            injection = runner.simulator_harness.runtime_parameter_injection_for_variant(
                variant_id,
                variant_configs[variant_id],
            )
            code = runner.simulator_harness.apply_runtime_parameter_injection_to_code(
                f'var marker = "{runner.simulator_harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
                "module.exports.loop = function loop() {};",
                injection,
            )
            injection = runner.simulator_harness.mark_runtime_parameter_injection_uploaded(
                injection,
                code_text=code,
                upload_tick=0,
            )
            evidence = {
                "type": runner.simulator_harness.RUNTIME_PARAMETER_CONSUMPTION_TYPE,
                "consumerMarker": runner.simulator_harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER,
                "consumerVersion": runner.simulator_harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_VERSION,
                "runtimeParameterInjection": True,
                "consumed": True,
                "strategyVariantId": variant_id,
                "parameters": copy.deepcopy(injection["parameters"]),
                "parametersSha256": injection["parametersSha256"],
                "consumedStrategyVariantId": variant_id,
                "consumedParametersSha256": injection["parametersSha256"],
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
                "tick": 1,
            }
            consumption = runner.simulator_harness.runtime_parameter_consumption_check(injection, evidence)
            return {
                "variant_id": variant_id,
                "ok": True,
                "tick_log": [{"tick": 1}],
                "activeCodeReadback": runner.simulator_harness.private_simulator_active_code_readback_summary(
                    code,
                    {"branch": "default", "modules": {"main": code}},
                    branch="default",
                    http_status=200,
                ),
                "runtimeParameterInjection": runner.simulator_harness.apply_runtime_parameter_consumption_to_injection(
                    injection,
                    consumption,
                ),
                "runtimeParameterConsumption": consumption,
            }

        def fake_run_simulator(**kwargs: Any) -> JsonObject:
            calls.append(dict(kwargs))
            if str(kwargs["run_id"]).endswith("-pre-scale-smoke"):
                variant_id = kwargs["variants"][0]
                return {
                    "type": "screeps-rl-simulator-run",
                    "runId": kwargs["run_id"],
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "variants": [smoke_variant_result(variant_id, kwargs["variant_configs"])],
                }
            return {
                "type": "screeps-rl-simulator-run",
                "runId": kwargs["run_id"],
                "liveEffect": False,
                "officialMmoWrites": False,
                "variants": [],
            }

        with mock.patch.object(runner.simulator_harness, "run_simulator", side_effect=fake_run_simulator):
            runs = runner.execute_simulator_runs(
                simulator_runner=runner.simulator_harness.run_simulator,
                variants=variants,
                config=config,
                card={"run_id": "scale-run"},
                report_id="scale-run",
            )

        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["run_id"], "scale-run-pre-scale-smoke")
        self.assertEqual(calls[0]["ticks"], runner.PRE_SCALE_TRAINABILITY_SMOKE_TICKS)
        self.assertEqual(calls[0]["workers"], 1)
        self.assertEqual(calls[0]["variants"], ["candidate.scale-env-01"])
        self.assertEqual(calls[0]["min_concurrent_environments"], 0)
        self.assertEqual(calls[0]["host_port_start"], 24133)
        self.assertEqual(calls[1]["run_id"], "scale-run")
        self.assertEqual(calls[1]["variants"], [variant.id for variant in variants])
        self.assertEqual(calls[1]["min_concurrent_environments"], 5)
        self.assertEqual(calls[1]["host_port_start"], 24125)
        self.assertEqual(runs[0]["runId"], "scale-run")

    def test_private_runner_pre_scale_smoke_gate_rejects_unsafe_smoke_run(self) -> None:
        calls: list[JsonObject] = []
        variants = [
            runner.StrategyVariant(
                id="candidate.scale-env-01",
                family="test-family",
                parameters={"knob": 1},
            )
        ]
        config = runner.SimulationConfig(
            ticks=500,
            workers=5,
            repetitions=1,
            host_port_start=24125,
            room="E1S1",
            shard="shardX",
            branch="activeWorld",
            code_path=Path("prod/dist/main.js"),
            map_source_file=Path("maps/map-0b6758af.json"),
            simulator_out_dir=Path("runtime-artifacts/rl-simulator-test"),
            scale_environments=5,
            min_concurrent_environments=5,
        )

        def fake_run_simulator(**kwargs: Any) -> JsonObject:
            calls.append(dict(kwargs))
            return {
                "type": "screeps-rl-simulator-run",
                "runId": kwargs["run_id"],
                "liveEffect": True,
                "officialMmoWrites": False,
                "variants": [],
            }

        with mock.patch.object(runner.simulator_harness, "run_simulator", side_effect=fake_run_simulator):
            with self.assertRaisesRegex(RuntimeError, "run\\[0\\]\\.liveEffect=true"):
                runner.execute_simulator_runs(
                    simulator_runner=runner.simulator_harness.run_simulator,
                    variants=variants,
                    config=config,
                    card={"run_id": "scale-run"},
                    report_id="scale-run",
                )

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["run_id"], "scale-run-pre-scale-smoke")

    def test_private_runner_pre_scale_smoke_gate_rejects_missing_requested_variant_row(self) -> None:
        code = (
            f'var marker = "{runner.simulator_harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
            "module.exports.loop = function loop() {};"
        )

        with self.assertRaisesRegex(RuntimeError, "produced no variant result"):
            runner.validate_pre_scale_trainability_smoke_gate(
                {
                    "type": "screeps-rl-simulator-run",
                    "runId": "scale-run-pre-scale-smoke",
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "variants": [
                        {
                            "variant_id": "unrelated-success",
                            "ok": True,
                            "tick_log": [{"tick": 1}],
                            "activeCodeReadback": runner.simulator_harness.private_simulator_active_code_readback_summary(
                                code,
                                {"branch": "default", "modules": {"main": code}},
                                branch="default",
                                http_status=200,
                            ),
                            "runtimeParameterInjection": {"runtimeParameterInjection": True},
                            "runtimeParameterConsumption": {"runtimeParameterConsumption": True},
                        }
                    ],
                },
                "candidate.scale-env-01",
            )

    def test_private_runner_pre_scale_smoke_gate_rejects_consumption_without_numeric_tick(self) -> None:
        code = (
            f'var marker = "{runner.simulator_harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
            "module.exports.loop = function loop() {};"
        )

        with self.assertRaisesRegex(RuntimeError, "missing numeric consumedTick"):
            runner.validate_pre_scale_trainability_smoke_gate(
                {
                    "type": "screeps-rl-simulator-run",
                    "runId": "scale-run-pre-scale-smoke",
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "variants": [
                        {
                            "variant_id": "candidate.scale-env-01",
                            "ok": True,
                            "tick_log": [{"tick": 1}],
                            "activeCodeReadback": runner.simulator_harness.private_simulator_active_code_readback_summary(
                                code,
                                {"branch": "default", "modules": {"main": code}},
                                branch="default",
                                http_status=200,
                            ),
                            "runtimeParameterInjection": {"runtimeParameterInjection": True},
                            "runtimeParameterConsumption": {
                                "status": "consumed",
                                "runtimeParameterConsumption": True,
                            },
                        }
                    ],
                },
                "candidate.scale-env-01",
            )

    def test_private_runner_pre_scale_smoke_gate_rejects_non_positive_consumed_tick(self) -> None:
        code = (
            f'var marker = "{runner.simulator_harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
            "module.exports.loop = function loop() {};"
        )

        with self.assertRaisesRegex(RuntimeError, "missing numeric consumedTick"):
            runner.validate_pre_scale_trainability_smoke_gate(
                {
                    "type": "screeps-rl-simulator-run",
                    "runId": "scale-run-pre-scale-smoke",
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "variants": [
                        {
                            "variant_id": "candidate.scale-env-01",
                            "ok": True,
                            "tick_log": [{"tick": 1}],
                            "activeCodeReadback": runner.simulator_harness.private_simulator_active_code_readback_summary(
                                code,
                                {"branch": "default", "modules": {"main": code}},
                                branch="default",
                                http_status=200,
                            ),
                            "runtimeParameterInjection": {"runtimeParameterInjection": True},
                            "runtimeParameterConsumption": {
                                "status": "consumed",
                                "runtimeParameterConsumption": True,
                                "consumedTick": 0,
                            },
                        }
                    ],
                },
                "candidate.scale-env-01",
            )

    def test_private_runner_pre_scale_smoke_gate_rejects_missing_injection_tick(self) -> None:
        code = (
            f'var marker = "{runner.simulator_harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
            "module.exports.loop = function loop() {};"
        )

        with self.assertRaisesRegex(RuntimeError, "missing numeric injection tick"):
            runner.validate_pre_scale_trainability_smoke_gate(
                {
                    "type": "screeps-rl-simulator-run",
                    "runId": "scale-run-pre-scale-smoke",
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "variants": [
                        {
                            "variant_id": "candidate.scale-env-01",
                            "ok": True,
                            "tick_log": [{"tick": 1}],
                            "activeCodeReadback": runner.simulator_harness.private_simulator_active_code_readback_summary(
                                code,
                                {"branch": "default", "modules": {"main": code}},
                                branch="default",
                                http_status=200,
                            ),
                            "runtimeParameterInjection": {"runtimeParameterInjection": True},
                            "runtimeParameterConsumption": {
                                "status": "consumed",
                                "runtimeParameterConsumption": True,
                                "consumedTick": 1,
                            },
                        }
                    ],
                },
                "candidate.scale-env-01",
            )

    def test_private_runner_pre_scale_smoke_gate_rejects_consumption_before_injection_tick(self) -> None:
        code = (
            f'var marker = "{runner.simulator_harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
            "module.exports.loop = function loop() {};"
        )

        with self.assertRaisesRegex(RuntimeError, "did not advance beyond injection tick"):
            runner.validate_pre_scale_trainability_smoke_gate(
                {
                    "type": "screeps-rl-simulator-run",
                    "runId": "scale-run-pre-scale-smoke",
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "variants": [
                        {
                            "variant_id": "candidate.scale-env-01",
                            "ok": True,
                            "tick_log": [{"tick": 7}],
                            "activeCodeReadback": runner.simulator_harness.private_simulator_active_code_readback_summary(
                                code,
                                {"branch": "default", "modules": {"main": code}},
                                branch="default",
                                http_status=200,
                            ),
                            "runtimeParameterInjection": {
                                "runtimeParameterInjection": True,
                                "tick": 7,
                            },
                            "runtimeParameterConsumption": {
                                "status": "consumed",
                                "runtimeParameterConsumption": True,
                                "consumedTick": 7,
                            },
                        }
                    ],
                },
                "candidate.scale-env-01",
            )

    def test_private_runner_pre_scale_smoke_gate_rejects_missing_consumption_before_scale(self) -> None:
        calls: list[JsonObject] = []
        variants = [
            runner.StrategyVariant(
                id="candidate.scale-env-01",
                family="test-family",
                parameters={"knob": 1},
            )
        ]
        config = runner.SimulationConfig(
            ticks=500,
            workers=5,
            repetitions=1,
            host_port_start=24125,
            room="E1S1",
            shard="shardX",
            branch="activeWorld",
            code_path=Path("prod/dist/main.js"),
            map_source_file=Path("maps/map-0b6758af.json"),
            simulator_out_dir=Path("runtime-artifacts/rl-simulator-test"),
            scale_environments=5,
            min_concurrent_environments=5,
        )

        def fake_run_simulator(**kwargs: Any) -> JsonObject:
            calls.append(dict(kwargs))
            variant_id = kwargs["variants"][0]
            injection = runner.simulator_harness.runtime_parameter_injection_for_variant(
                variant_id,
                kwargs["variant_configs"][variant_id],
            )
            code = runner.simulator_harness.apply_runtime_parameter_injection_to_code(
                f'var marker = "{runner.simulator_harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
                "module.exports.loop = function loop() {};",
                injection,
            )
            injection = runner.simulator_harness.mark_runtime_parameter_injection_uploaded(injection, code_text=code)
            return {
                "type": "screeps-rl-simulator-run",
                "runId": kwargs["run_id"],
                "liveEffect": False,
                "officialMmoWrites": False,
                "variants": [
                    {
                        "variant_id": variant_id,
                        "ok": True,
                        "tick_log": [{"tick": 1}],
                        "activeCodeReadback": runner.simulator_harness.private_simulator_active_code_readback_summary(
                            code,
                            {"branch": "default", "modules": {"main": code}},
                            branch="default",
                            http_status=200,
                        ),
                        "runtimeParameterInjection": injection,
                        "runtimeParameterConsumption": runner.simulator_harness.runtime_parameter_consumption_check(
                            injection,
                            None,
                        ),
                    }
                ],
            }

        with mock.patch.object(runner.simulator_harness, "run_simulator", side_effect=fake_run_simulator):
            with self.assertRaisesRegex(RuntimeError, "did not prove runtime parameter consumption"):
                runner.execute_simulator_runs(
                    simulator_runner=runner.simulator_harness.run_simulator,
                    variants=variants,
                    config=config,
                    card={"run_id": "scale-run"},
                    report_id="scale-run",
                )

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["run_id"], "scale-run-pre-scale-smoke")

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
