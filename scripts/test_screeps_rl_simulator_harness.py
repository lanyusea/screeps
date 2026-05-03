#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_simulator_harness as harness


def runtime_line(payload: dict[str, object]) -> str:
    return f"#runtime-summary {json.dumps(payload, sort_keys=True)}\n"


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


class RlSimulatorHarnessTest(unittest.TestCase):
    def test_builds_manifest_from_local_metadata_without_raw_logs_or_secrets(self) -> None:
        secret = "supersecret123456"
        runtime_payload = {
            "type": "runtime-summary",
            "tick": 321,
            "token": secret,
            "rooms": [
                {
                    "roomName": "E26S49",
                    "workerCount": 4,
                    "resources": {"storedEnergy": 500},
                    "constructionPriority": {
                        "nextPrimary": {
                            "buildItem": "build extension capacity",
                            "room": "E26S49",
                            "score": 70,
                        }
                    },
                }
            ],
        }
        shadow_report = {
            "type": "screeps-strategy-shadow-report",
            "reportId": "shadow-local",
            "enabled": True,
            "liveEffect": False,
            "artifactCount": 1,
            "modelReportCount": 1,
            "modelFamilies": ["construction-priority"],
            "candidateStrategyIds": ["construction-priority.territory-shadow.v1"],
            "incumbentStrategyIds": ["construction-priority.incumbent.v1"],
            "rankingDiffCount": 2,
            "changedTopCount": 1,
            "modelReports": [
                {
                    "family": "construction-priority",
                    "candidateStrategyId": "construction-priority.territory-shadow.v1",
                    "incumbentStrategyId": "construction-priority.incumbent.v1",
                    "rankingDiffs": [{"changedTop": True}, {"changedTop": False}],
                }
            ],
            "warnings": ["raw warning should not be copied by generated metadata"],
        }
        run_manifest = {
            "type": "screeps-rl-dataset-run",
            "schemaVersion": 1,
            "runId": "dataset-run",
            "botCommit": "a" * 40,
            "source": {
                "sourceArtifactCount": 1,
                "matchedArtifactCount": 1,
                "strategyShadowReportCount": 1,
            },
            "strategy": {
                "decisionSurfacesObserved": ["construction-priority"],
                "liveEffect": False,
            },
            "split": {"seed": "screeps-rl-v1", "counts": {"train": 1}},
            "sampleCount": 1,
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            runtime_path = root / "runtime.log"
            shadow_path = root / "shadow.json"
            dataset_path = root / "run_manifest.json"
            out_dir = root / "out"
            runtime_path.write_text(runtime_line(runtime_payload), encoding="utf-8")
            shadow_path.write_text(json.dumps(shadow_report, sort_keys=True), encoding="utf-8")
            dataset_path.write_text(json.dumps(run_manifest, sort_keys=True), encoding="utf-8")

            with mock.patch.dict(os.environ, {"SCREEPS_AUTH_TOKEN": secret}):
                first_summary = harness.build_harness_manifest(
                    [str(runtime_path), str(shadow_path), str(dataset_path)],
                    out_dir,
                    manifest_id="manifest-test",
                    bot_commit="b" * 40,
                    workers=2,
                    rooms_per_worker=3,
                    official_tick_seconds=3.0,
                    target_speedup=100.0,
                    throughput_samples=[
                        harness.ThroughputSample("worker-0", 600, 30.0),
                        harness.ThroughputSample("worker-1", 600, 30.0),
                    ],
                )
                manifest_path = out_dir / "manifest-test" / "simulator_harness_manifest.json"
                first_text = manifest_path.read_text(encoding="utf-8")
                second_summary = harness.build_harness_manifest(
                    [str(runtime_path), str(shadow_path), str(dataset_path)],
                    out_dir,
                    manifest_id="manifest-test",
                    bot_commit="b" * 40,
                    workers=2,
                    rooms_per_worker=3,
                    official_tick_seconds=3.0,
                    target_speedup=100.0,
                    throughput_samples=[
                        harness.ThroughputSample("worker-0", 600, 30.0),
                        harness.ThroughputSample("worker-1", 600, 30.0),
                    ],
                )
                second_text = manifest_path.read_text(encoding="utf-8")

        manifest = json.loads(first_text)
        self.assertEqual(first_summary, second_summary)
        self.assertEqual(first_text, second_text)
        self.assertTrue(first_summary["ok"])
        self.assertFalse(first_summary["liveEffect"])
        self.assertFalse(first_summary["officialMmoWrites"])
        self.assertFalse(manifest["safety"]["liveEffect"])
        self.assertFalse(manifest["safety"]["officialMmoWrites"])
        self.assertFalse(manifest["safety"]["networkRequired"])
        self.assertFalse(manifest["safety"]["liveSecretsRequired"])
        self.assertEqual(manifest["sources"]["runtimeArtifactCount"], 1)
        self.assertEqual(manifest["scenario"]["datasetRunCount"], 1)
        self.assertGreaterEqual(manifest["scenario"]["strategyShadowReportCount"], 1)
        self.assertEqual(manifest["strategyShadow"]["generatedReports"][0]["reportId"], "shadow-local")
        self.assertEqual(manifest["datasets"]["runManifests"][0]["runId"], "dataset-run")
        self.assertEqual(manifest["throughput"]["evidenceMode"], "sampled-dry-run-input")
        self.assertEqual(manifest["throughput"]["aggregate"]["aggregateRoomTicksPerSecond"], 40.0)
        self.assertEqual(manifest["throughput"]["aggregate"]["speedupVsOfficial"], 120.0)
        self.assertTrue(manifest["throughput"]["aggregate"]["targetMet"])
        self.assertNotIn(secret, first_text)
        self.assertNotIn("#runtime-summary", first_text)
        self.assertNotIn("raw warning should not be copied", first_text)

    def test_dry_run_manifest_allows_nullable_local_metadata_ids(self) -> None:
        partial_metadata = [
            {"type": "screeps-rl-dataset-run", "sampleCount": 1},
            {"type": "screeps-rl-dataset-run", "runId": "dataset-run", "sampleCount": 2},
            {"type": "screeps-rl-historical-artifact-replay", "sourceMode": "local"},
            {"type": "screeps-rl-historical-artifact-replay", "runId": "scenario-run", "sourceMode": "local"},
            {"type": "screeps-rl-offline-dataset", "sampleCount": 3},
            {"type": "screeps-rl-offline-dataset", "runId": "export-run", "sampleCount": 4},
            {
                "type": "screeps-strategy-shadow-report",
                "enabled": True,
                "liveEffect": False,
                "modelReports": [],
            },
            {
                "type": "screeps-strategy-shadow-report",
                "reportId": "shadow-report",
                "enabled": True,
                "liveEffect": False,
                "modelReports": [],
            },
            {"ok": True, "dry_run": True, "ports": {"host": {"http": 21025}}, "smoke": {"room": "W1N1"}},
            {
                "ok": True,
                "dry_run": True,
                "work_dir": "/tmp/screeps-private-smoke",
                "ports": {"host": {"http": 21026}},
                "smoke": {"room": "W1N2"},
            },
        ]

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            metadata_path = root / "partial_metadata.json"
            out_dir = root / "out"
            metadata_path.write_text(json.dumps(partial_metadata, sort_keys=True), encoding="utf-8")

            summary = harness.build_harness_manifest(
                [str(metadata_path)],
                out_dir,
                manifest_id="nullable-metadata-test",
                bot_commit="e" * 40,
            )
            manifest = read_json(out_dir / "nullable-metadata-test" / "simulator_harness_manifest.json")

        self.assertTrue(summary["ok"])
        self.assertEqual([item["runId"] for item in manifest["datasets"]["runManifests"]], [None, "dataset-run"])
        self.assertEqual(
            [item["runId"] for item in manifest["datasets"]["scenarioManifests"]],
            [None, "scenario-run"],
        )
        self.assertEqual([item["runId"] for item in manifest["datasets"]["exportSummaries"]], [None, "export-run"])
        self.assertEqual(
            [item["reportId"] for item in manifest["strategyShadow"]["generatedReports"]],
            [None, "shadow-report"],
        )
        self.assertEqual([item["workDir"] for item in manifest["privateSmoke"]], [None, "/tmp/screeps-private-smoke"])

    def test_estimated_worker_rate_records_target_comparison(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            runtime_path = root / "runtime.log"
            runtime_path.write_text(
                runtime_line({"type": "runtime-summary", "tick": 1, "rooms": [{"roomName": "W1N1"}]}),
                encoding="utf-8",
            )

            summary = harness.build_harness_manifest(
                [str(runtime_path)],
                root / "out",
                manifest_id="estimate-test",
                bot_commit="c" * 40,
                workers=5,
                rooms_per_worker=2,
                target_speedup=100.0,
                official_tick_seconds=2.5,
                estimated_worker_room_ticks_per_second=10.0,
            )
            manifest = read_json(root / "out" / "estimate-test" / "simulator_harness_manifest.json")

        self.assertEqual(summary["throughput"]["evidenceMode"], "estimated-from-worker-rate")
        self.assertEqual(manifest["throughput"]["aggregate"]["aggregateRoomTicksPerSecond"], 50.0)
        self.assertEqual(manifest["throughput"]["aggregate"]["speedupVsOfficial"], 125.0)
        self.assertTrue(manifest["throughput"]["aggregate"]["targetMet"])
        self.assertEqual(manifest["workers"]["plannedParallelRoomCount"], 10)

    def test_cli_dry_run_and_self_test_are_offline_and_secret_free(self) -> None:
        secret = "dryrunsecret123456"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            runtime_path = root / "runtime.log"
            out_dir = root / "out"
            runtime_path.write_text(
                runtime_line(
                    {
                        "type": "runtime-summary",
                        "tick": 2,
                        "token": secret,
                        "rooms": [{"roomName": "W2N2"}],
                    }
                ),
                encoding="utf-8",
            )
            output = io.StringIO()

            with mock.patch.dict(os.environ, {"SCREEPS_AUTH_TOKEN": secret}):
                exit_code = harness.main(
                    [
                        "dry-run",
                        str(runtime_path),
                        "--out-dir",
                        str(out_dir),
                        "--manifest-id",
                        "cli-test",
                        "--bot-commit",
                        "d" * 40,
                        "--throughput-sample",
                        "worker-0:300:10",
                    ],
                    stdout=output,
                )
                manifest_text = (out_dir / "cli-test" / "simulator_harness_manifest.json").read_text(
                    encoding="utf-8"
                )

        self.assertEqual(exit_code, 0)
        self.assertNotIn(secret, output.getvalue())
        self.assertNotIn(secret, manifest_text)
        self.assertNotIn("#runtime-summary", output.getvalue())
        self.assertNotIn("#runtime-summary", manifest_text)

        self_test_output = io.StringIO()
        self.assertEqual(harness.main(["self-test"], stdout=self_test_output), 0)
        self.assertIn('"officialMmoWrites": false', self_test_output.getvalue())

    def test_zero_room_tick_throughput_sample_cannot_write_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            runtime_path = root / "runtime.log"
            out_dir = root / "out"
            runtime_path.write_text(
                runtime_line({"type": "runtime-summary", "tick": 3, "rooms": [{"roomName": "W3N3"}]}),
                encoding="utf-8",
            )

            with mock.patch("sys.stderr", new=io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    harness.main(
                        [
                            "dry-run",
                            str(runtime_path),
                            "--out-dir",
                            str(out_dir),
                            "--manifest-id",
                            "zero-room-ticks",
                            "--bot-commit",
                            "f" * 40,
                            "--throughput-sample",
                            "worker:0:10",
                        ],
                    )

            self.assertEqual(raised.exception.code, 2)
            self.assertFalse((out_dir / "zero-room-ticks" / "simulator_harness_manifest.json").exists())

    def test_throughput_sample_parser_rejects_invalid_shapes(self) -> None:
        valid = harness.parse_throughput_sample("worker-7:1200:30.5:1")
        self.assertEqual(valid.worker_id, "worker-7")
        self.assertEqual(valid.room_ticks, 1200)
        self.assertEqual(valid.wall_seconds, 30.5)
        self.assertEqual(valid.failure_count, 1)

        for sample in ("worker:1", ":1:1", "worker:-1:1", "worker:0:1", "worker:1:0", "worker:1:1:-1"):
            with self.subTest(sample=sample):
                with self.assertRaises(argparse.ArgumentTypeError):
                    harness.parse_throughput_sample(sample)

    def test_build_scenario_config_is_stable_and_records_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            code_path = root / "main.js"
            map_path = root / "map.json"
            code_path.write_text("module.exports.loop = function() {};", encoding="utf-8")
            map_path.write_text("{\"ok\":true}", encoding="utf-8")

            scenario = harness.build_scenario_config(
                "run-1",
                "baseline",
                room="E26S49",
                shard="shardX",
                branch="activeWorld",
                ticks=100,
                code_path=code_path,
                map_source_file=map_path,
            )

        self.assertEqual(scenario["type"], "screeps-rl-sim-run-scenario")
        self.assertEqual(scenario["runId"], "run-1")
        self.assertEqual(scenario["variantId"], "baseline")
        self.assertEqual(scenario["activeWorldBranch"], "activeWorld")
        self.assertEqual(scenario["room"], "E26S49")
        self.assertEqual(scenario["shard"], "shardX")
        self.assertEqual(scenario["tickPlan"]["ticks"], 100)
        self.assertEqual(scenario["spawn"], {"name": "Spawn1", "x": 20, "y": 20})
        self.assertEqual(scenario["codeArtifact"]["path"], str(root / "main.js"))
        self.assertEqual(scenario["mapArtifact"]["sourcePath"], str(root / "map.json"))
        self.assertIsInstance(scenario["codeArtifact"]["sha256"], str)
        self.assertIsInstance(scenario["mapArtifact"]["sha256"], str)

    def test_validate_run_artifact_checks_schema(self) -> None:
        valid_variant = {
            "variant_id": "baseline",
            "variant_run_id": "run-1-baseline",
            "worker_id": 0,
            "ticks_requested": 2,
            "ticks_run": 2,
            "wall_clock_seconds": 0.5,
            "ticks_per_second": 4.0,
            "tick_log": [
                {
                    "tick": 1,
                    "shard": "shardX",
                    "room": "E26S49",
                    "rooms": {"E26S49": {"room": "E26S49", "controller": {"level": 1, "progress": 0, "progressTotal": 300}, "energy": 300, "creeps": 0, "structures": {}}},
                    "overview": {"roomCount": 1, "rooms": []},
                    "terrain": {"bytes": 0},
                },
            ],
            "live_effect": False,
            "official_mmo_writes": False,
            "ok": True,
        }
        artifact = {
            "type": harness.RUN_SUMMARY_TYPE,
            "runId": "validate-run",
            "harness_version": harness.HARNESS_VERSION,
            "safety": {"liveEffect": False},
            "live_effect": False,
            "official_mmo_writes": False,
            "official_mmo_writes_allowed": False,
            "variants": [valid_variant],
        }

        self.assertTrue(harness.validate_run_artifact(artifact))

        invalid = dict(artifact)
        invalid["official_mmo_writes"] = True
        with self.assertRaises(ValueError):
            harness.validate_run_artifact(invalid)

    def test_build_run_artifact_uses_elapsed_wall_clock_for_parallel_summary(self) -> None:
        variants = [
            {"variant_id": "a", "wall_clock_seconds": 10.0, "ticks_run": 2},
            {"variant_id": "b", "wall_clock_seconds": 12.0, "ticks_run": 2},
        ]

        artifact = harness.build_run_artifact(
            "parallel-run",
            ticks=2,
            workers=2,
            variant_results=variants,
            branch="activeWorld",
            wall_clock_seconds=13.4567,
        )
        fallback = harness.build_run_artifact(
            "parallel-run",
            ticks=2,
            workers=2,
            variant_results=variants,
            branch="activeWorld",
        )

        self.assertEqual(artifact["wallClockSeconds"], 13.457)
        self.assertEqual(fallback["wallClockSeconds"], 12.0)
        self.assertEqual(artifact["wallClockSummary"]["maxSeconds"], 12.0)

    def test_require_launcher_cli_success_fails_on_false_ok_result(self) -> None:
        class FakeSmoke:
            def run_launcher_cli(self, compose: list[str], cfg: object, expression: str) -> dict[str, object]:
                return {"ok": False, "error": f"rejected {expression}"}

        with self.assertRaisesRegex(RuntimeError, "reset simulator data failed"):
            harness._require_launcher_cli_success(
                FakeSmoke(),
                ["docker", "compose"],
                object(),
                "system.resetAllData()",
                "reset simulator data",
            )

    def test_require_launcher_cli_success_fails_on_missing_ok_result(self) -> None:
        class FakeSmoke:
            def run_launcher_cli(self, compose: list[str], cfg: object, expression: str) -> dict[str, object]:
                return {"result": f"accepted {expression}"}

        with self.assertRaisesRegex(RuntimeError, "resume simulator failed"):
            harness._require_launcher_cli_success(
                FakeSmoke(),
                ["docker", "compose"],
                object(),
                "system.resumeSimulation()",
                "resume simulator",
            )

    def test_run_id_rejects_dots_even_without_path_separators(self) -> None:
        with self.assertRaisesRegex(argparse.ArgumentTypeError, "letters, numbers"):
            harness.parse_run_id_token("run.1")

    def test_build_tick_entry_includes_all_visible_room_summaries(self) -> None:
        overview = {
            "shards": {
                "shardX": {
                    "rooms": ["E26S49", "E26S50"],
                    "gametime": 12,
                    "gametimes": [12],
                }
            }
        }
        room_overviews = {
            "E26S49": {
                "room": "E26S49",
                "roomData": {
                    "controller": {"level": 1},
                    "objects": [{"type": "spawn"}],
                    "creeps": 2,
                    "energy": 300,
                },
            },
            "E26S50": {
                "room": "E26S50",
                "roomData": {
                    "controller": {"level": 2},
                    "objects": [{"type": "spawn"}],
                    "creeps": 1,
                    "energy": 200,
                },
            },
        }

        tick_entry = harness._build_tick_entry(
            "shardX",
            "E26S49",
            12,
            overview,
            {"terrain": [{"room": "E26S49", "terrain": "0" * 2500}]},
            room_overviews,
        )

        self.assertEqual(sorted(tick_entry["rooms"]), ["E26S49", "E26S50"])
        self.assertEqual(tick_entry["rooms"]["E26S49"]["structures"]["spawn"], 1)
        self.assertEqual(tick_entry["rooms"]["E26S50"]["controller"]["level"], 2)

    def test_run_variant_initializes_frozen_smoke_config_with_http_server_url(self) -> None:
        captured_server_urls: list[str] = []

        class FrozenSmokeConfig:
            def __init__(self, **kwargs: object) -> None:
                object.__setattr__(self, "_frozen", False)
                for key, value in kwargs.items():
                    object.__setattr__(self, key, value)
                object.__setattr__(self, "_frozen", True)

            def __setattr__(self, key: str, value: object) -> None:
                if getattr(self, "_frozen", False):
                    raise AttributeError(f"cannot assign to frozen field {key}")
                object.__setattr__(self, key, value)

        class FakeSmoke:
            SmokeConfig = FrozenSmokeConfig

            def required_env_errors(self, cfg: FrozenSmokeConfig) -> list[str]:
                captured_server_urls.append(str(cfg.server_url))
                return ["stop before side effects"]

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            code_path = root / "main.js"
            map_path = root / "map.json"
            code_path.write_text("module.exports.loop = function() {};", encoding="utf-8")
            map_path.write_text("{\"ok\": true}", encoding="utf-8")

            with mock.patch("screeps_rl_simulator_harness._load_private_smoke_module", return_value=FakeSmoke()):
                result = harness._run_variant(
                    0,
                    "baseline",
                    run_id="frozen-config",
                    ticks=1,
                    room="E26S49",
                    shard="shardX",
                    branch="activeWorld",
                    code_path=code_path,
                    map_source_file=map_path,
                    out_dir=root / "out",
                )

        self.assertEqual(captured_server_urls, ["http://127.0.0.1:21025"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "stop before side effects")

    def test_run_variants_passes_worker_index_and_records_elapsed_wall_clock(self) -> None:
        calls: list[tuple[int, str]] = []

        def fake_run_variant(worker_index: int, variant_id: str, **kwargs: object) -> dict[str, object]:
            calls.append((worker_index, variant_id))
            return {
                "variant_id": variant_id,
                "worker_id": worker_index,
                "ticks_run": 1,
                "wall_clock_seconds": 10.0 + worker_index,
                "tick_log": [],
                "ok": True,
            }

        with mock.patch("screeps_rl_simulator_harness._run_variant", side_effect=fake_run_variant):
            with mock.patch("screeps_rl_simulator_harness.time.monotonic", side_effect=[100.0, 101.25]):
                artifact, results = harness.run_variants(
                    variants=["a", "b"],
                    ticks=1,
                    workers=2,
                    room="E26S49",
                    shard="shardX",
                    branch="activeWorld",
                    code_path=Path("main.js"),
                    map_source_file=Path("map.json"),
                    out_dir=Path("out"),
                    run_id="parallel-run",
                )

        self.assertEqual(sorted(calls), [(0, "a"), (1, "b")])
        self.assertEqual([item["variant_id"] for item in results], ["a", "b"])
        self.assertEqual(artifact["wallClockSeconds"], 1.25)

    def test_run_simulator_writes_schema_validated_and_redacted_artifact(self) -> None:
        mock_variant = {
            "variant_id": "baseline",
            "ticks_requested": 3,
            "ticks_run": 3,
            "wall_clock_seconds": 1.2,
            "ticks_per_second": 2.5,
            "tick_log": [],
            "live_effect": False,
            "official_mmo_writes": False,
        }
        run_artifact = {
            "type": harness.RUN_SUMMARY_TYPE,
            "runId": "run-validate",
            "harness_version": harness.HARNESS_VERSION,
            "safety": {"liveEffect": False},
            "live_effect": False,
            "official_mmo_writes": False,
            "official_mmo_writes_allowed": False,
            "variants": [mock_variant],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            code_path = root / "main.js"
            map_path = root / "map.json"
            code_path.write_text("module.exports.loop = function() {};", encoding="utf-8")
            map_path.write_text("{\"ok\": true}", encoding="utf-8")
            out_dir = root / "runtime-artifacts"
            output_data: dict[str, object] | None = None
            with mock.patch.dict(os.environ, {"STEAM_KEY": "super-secret-key"}):
                with mock.patch("screeps_rl_simulator_harness.run_variants", return_value=(run_artifact, [mock_variant])):
                    summary = harness.run_simulator(
                        ticks=3,
                        workers=1,
                        variants=["baseline"],
                        out_dir=out_dir,
                        run_id="run-validate",
                        code_path=code_path,
                        map_source_file=map_path,
                    )
                    output_path = out_dir / "run-validate" / "run_summary.json"
                    output_data = json.loads(output_path.read_text(encoding="utf-8"))
                    self.assertTrue(output_path.exists())

        self.assertEqual(summary["runId"], "run-validate")
        self.assertIsNotNone(output_data)
        self.assertEqual(output_data["runId"], "run-validate")
        self.assertEqual(output_data["variants"][0]["variant_id"], "baseline")
        self.assertFalse(output_data["official_mmo_writes"])
        self.assertFalse(output_data["live_effect"])
        self.assertNotIn("super-secret-key", json.dumps(output_data))

    def test_run_simulator_rejects_unsafe_run_id_before_writing_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            code_path = root / "main.js"
            map_path = root / "map.json"
            code_path.write_text("module.exports.loop = function() {};", encoding="utf-8")
            map_path.write_text("{\"ok\": true}", encoding="utf-8")
            out_dir = root / "runtime-artifacts"

            with mock.patch.dict(os.environ, {"STEAM_KEY": "super-secret-key"}):
                with mock.patch("screeps_rl_simulator_harness.run_variants") as run_variants:
                    with self.assertRaisesRegex(RuntimeError, "letters, numbers"):
                        harness.run_simulator(
                            ticks=1,
                            workers=1,
                            variants=["baseline"],
                            out_dir=out_dir,
                            run_id="../outside",
                            code_path=code_path,
                            map_source_file=map_path,
                        )

        run_variants.assert_not_called()
        self.assertFalse((root / "outside" / "run_summary.json").exists())

    def test_run_command_exits_nonzero_when_any_variant_failed(self) -> None:
        failed_summary = {
            "type": harness.RUN_SUMMARY_TYPE,
            "runId": "failed-run",
            "variants": [{"variant_id": "baseline", "ok": False, "error": "boom"}],
        }
        output = io.StringIO()

        with mock.patch("screeps_rl_simulator_harness.discover_strategy_variants", return_value=["baseline"]):
            with mock.patch("screeps_rl_simulator_harness.run_simulator", return_value=failed_summary):
                exit_code = harness.main(["run", "--variants", "baseline"], stdout=output)

        self.assertEqual(exit_code, 1)
        self.assertIn('"ok": false', output.getvalue())


if __name__ == "__main__":
    unittest.main()
