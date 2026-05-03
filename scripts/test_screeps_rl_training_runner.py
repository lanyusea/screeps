#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_training_runner as runner


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
            "component_order": ["territory", "resources", "kills"],
            "component_weights": {
                "territory": 1000000,
                "resources": 1000,
                "kills": 1,
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


class RlTrainingRunnerTest(unittest.TestCase):
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
        self.assertGreater(report["variantResults"][0]["reward"]["tuple"][1], report["variantResults"][1]["reward"]["tuple"][1])
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
        self.assertEqual(metrics["rewardTuple"][0], -1)

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
        self.assertEqual(report["ranking"][0]["rewardTuple"][0], 0)
        self.assertEqual(report["statisticalComparison"]["pairwise"][0]["firstDifferingTier"], "resources")

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
        self.assertEqual(candidate_result["reward"]["samples"], [])
        self.assertEqual([item["variantId"] for item in report["ranking"]], ["baseline"])
        self.assertNotIn("candidate", report["statisticalComparison"]["componentMeans"])
        self.assertTrue(any("excluded 1 failed simulator run" in warning for warning in report["warnings"]))

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
        self.assertEqual(persisted["candidateStrategyIds"], ["baseline", "candidate"])
        self.assertEqual(persisted["incumbentStrategyIds"], ["baseline"])
        self.assertIn("modelReports", persisted)
        self.assertIn("kpiSummary", persisted)
        self.assertIn("statisticalComparison", persisted)
        self.assertTrue(str(report["reportPath"]).endswith("reports/format-check.json"))
        self.assertEqual(simulator.calls[0]["ticks"], 2)
        self.assertEqual(simulator.calls[0]["variants"], ["baseline", "candidate"])

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

    def test_unsafe_simulator_flags_fail_before_report_is_persisted(self) -> None:
        start = tick(1, [room("W1N1", energy=100)])
        baseline = variant_result("baseline", [start, tick(2, [room("W1N1", energy=200)])])
        candidate = variant_result("candidate", [start, tick(2, [room("W1N1", energy=250)])])

        class UnsafeSimulator(MockSimulator):
            def __call__(self, **kwargs: Any) -> JsonObject:
                result = super().__call__(**kwargs)
                result["liveEffect"] = True
                return result

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            card_path = root / "card.json"
            out_dir = root / "reports"
            write_json(card_path, base_card())
            with self.assertRaisesRegex(RuntimeError, "liveEffect=true"):
                runner.run_training_experiment(
                    card_path,
                    out_dir,
                    report_id="unsafe-flags",
                    simulator_runner=UnsafeSimulator({"baseline": baseline, "candidate": candidate}),
                )

            self.assertFalse((out_dir / "unsafe-flags.json").exists())


if __name__ == "__main__":
    unittest.main()
