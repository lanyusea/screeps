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
        self.assertFalse(report["policyGradient"]["runner_support"]["inline_candidates_applied_to_simulator"])
        self.assertTrue(report["policyGradient"]["runner_support"]["report_preserves_candidate_parameters"])
        self.assertEqual(simulator.calls[0]["ticks"], 100)
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

    def test_policy_gradient_computes_and_persists_bounded_policy_update(self) -> None:
        card = card_helper.build_card(
            dataset_run_id="rl-policy-gradient-update",
            code_commit="d" * 40,
            training_approach="policy_gradient",
            created_at="2026-05-17T03:25:00Z",
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
        update = report["policyUpdate"]
        self.assertEqual(update["iterations"], 1)
        self.assertEqual(update["algorithm"], "rank_weighted_finite_difference_v1")
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
        self.assertFalse(artifact["liveEffect"])
        self.assertFalse(artifact["officialMmoWrites"])
        self.assertFalse(artifact["officialMmoWritesAllowed"])
        self.assertFalse(artifact["safety"]["liveEffect"])
        self.assertFalse(artifact["safety"]["officialMmoWrites"])

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
