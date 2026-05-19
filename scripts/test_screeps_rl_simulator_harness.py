#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import io
import json
import math
import os
import sys
import tempfile
import threading
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
    def test_safe_compose_project_name_normalizes_timestamp_run_ids(self) -> None:
        name = harness._safe_compose_project_name(
            "rl-sim-worker-rl-sim-run-mainagent2-20260512T183509Z-00"
        )

        self.assertEqual(name, "rl-sim-worker-rl-sim-run-mainagent2-20260512t183509z-00")
        self.assertRegex(name, r"^[a-z0-9][a-z0-9_-]*$")
        self.assertNotIn("T", name)
        self.assertEqual(harness._safe_compose_project_name("Run.With.Dots"), "run-with-dots")

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
        self.assertEqual(manifest["botCommit"], "b" * 40)
        self.assertEqual(manifest["owningIssue"], "#879")
        self.assertEqual(manifest["strategyVariants"]["configuredVariantCount"], 2)
        self.assertEqual(
            manifest["strategyVariants"]["defaultVariantIds"],
            [
                "construction-priority.incumbent.v1",
                "construction-priority.container-prioritized-shadow.v1",
            ],
        )
        self.assertFalse(manifest["safety"]["liveEffect"])
        self.assertFalse(manifest["safety"]["officialMmoWrites"])
        self.assertFalse(manifest["safety"]["networkRequired"])
        self.assertFalse(manifest["safety"]["liveSecretsRequired"])
        self.assertEqual(manifest["sources"]["runtimeArtifactCount"], 1)
        self.assertEqual(manifest["scenario"]["datasetRunCount"], 1)
        self.assertGreaterEqual(manifest["scenario"]["strategyShadowReportCount"], 1)
        self.assertEqual(manifest["strategyShadow"]["generatedReports"][0]["reportId"], "shadow-local")
        self.assertEqual(manifest["datasets"]["runManifests"][0]["runId"], "dataset-run")
        self.assertEqual(manifest["simulatorRuns"]["completedRunCount"], 0)
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

    def test_harness_manifest_scan_excludes_generated_dependency_trees(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            out_dir = root / "out"
            empty_scan = harness.dataset_export.ScanResult(input_paths=[])

            with mock.patch(
                "screeps_rl_simulator_harness.dataset_export.collect_artifact_records",
                return_value=empty_scan,
            ) as collect:
                harness.build_harness_manifest(
                    [],
                    out_dir,
                    manifest_id="scan-excludes-test",
                    bot_commit="a" * 40,
                )

        kwargs = collect.call_args.kwargs
        self.assertIn("node_modules", kwargs["excluded_directory_names"])
        self.assertIn(".git", kwargs["excluded_directory_names"])
        self.assertIn(".png", kwargs["binary_file_extensions"])

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

    def test_default_strategy_variants_are_configured_for_construction_priority(self) -> None:
        variants = harness.normalize_variants([], harness.available_strategy_variants(["construction-priority.incumbent.v1"]))
        configs = harness.resolve_strategy_variant_configs(variants)

        self.assertEqual(
            variants,
            [
                "construction-priority.incumbent.v1",
                "construction-priority.container-prioritized-shadow.v1",
            ],
        )
        self.assertEqual([config["family"] for config in configs], ["construction-priority", "construction-priority"])
        self.assertEqual(configs[1]["rolloutStatus"], "shadow")
        self.assertGreater(configs[1]["defaultValues"]["resourceSignalWeight"], configs[0]["defaultValues"]["resourceSignalWeight"])

    def test_scale_environment_expansion_keeps_unique_rows_backed_by_base_variants(self) -> None:
        base_variants = [
            "construction-priority.incumbent.v1",
            "construction-priority.container-prioritized-shadow.v1",
        ]

        expanded = harness.expand_scale_environment_variants(base_variants, 5)
        configs = harness.resolve_strategy_variant_configs(expanded)

        self.assertEqual(len(expanded), 5)
        self.assertEqual(len(set(expanded)), 5)
        self.assertEqual(expanded[0], "construction-priority.incumbent.v1.scale-env-01")
        self.assertEqual(expanded[1], "construction-priority.container-prioritized-shadow.v1.scale-env-02")
        self.assertEqual(configs[0]["sourceVariantId"], "construction-priority.incumbent.v1")
        self.assertEqual(configs[0]["scaleEnvironment"]["environmentIndex"], 1)
        self.assertEqual(configs[1]["sourceVariantId"], "construction-priority.container-prioritized-shadow.v1")
        self.assertFalse(configs[0]["safety"]["liveEffect"])
        self.assertFalse(configs[0]["safety"]["officialMmoWrites"])

    def test_private_server_active_branch_aliases_are_normalized(self) -> None:
        self.assertEqual(harness.normalize_private_server_code_branch("activeWorld"), "$activeWorld")
        self.assertEqual(harness.normalize_private_server_code_branch("activeSim"), "$activeSim")
        self.assertEqual(harness.normalize_private_server_code_branch("default"), "default")

    def test_resolve_bot_commit_falls_back_when_git_detection_is_unknown(self) -> None:
        with mock.patch("screeps_rl_simulator_harness.dataset_export.git_commit", return_value="unknown"):
            self.assertEqual(harness.resolve_bot_commit(), harness.DEFAULT_BOT_COMMIT)

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

    def test_require_launcher_cli_success_accepts_successful_http_status_result(self) -> None:
        class FakeSmoke:
            def run_launcher_cli(self, compose: list[str], cfg: object, expression: str) -> dict[str, object]:
                return {"status": 200, "response_excerpt": "undefined\n"}

        result = harness._require_launcher_cli_success(
            FakeSmoke(),
            ["docker", "compose"],
            object(),
            "system.resetAllData()",
            "reset simulator data",
        )

        self.assertEqual(result["status"], 200)

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

    def test_install_simulator_repair_mod_writes_launcher_compatibility_mod(self) -> None:
        writes: list[tuple[Path, str]] = []

        class FakeSmoke:
            def write_generated_text(self, work_dir: Path, path: Path, text: str) -> None:
                writes.append((path.relative_to(work_dir), text))

        with tempfile.TemporaryDirectory() as temp_dir:
            cfg = argparse.Namespace(work_dir=Path(temp_dir))
            mod_path = harness._install_simulator_repair_mod(FakeSmoke(), cfg)

        self.assertEqual(mod_path.name, harness.SIMULATOR_REPAIR_MOD_FILENAME)
        self.assertEqual(writes[0][0], Path("mods") / harness.SIMULATOR_REPAIR_MOD_FILENAME)
        self.assertIn("env.keys.TERRAIN_DATA", writes[0][1])
        self.assertIn("env.keys.ACCESSIBLE_ROOMS", writes[0][1])
        self.assertIn("storage._connect", writes[0][1])
        self.assertIn("__rlSimulatorHarnessRepairInstalled", writes[0][1])
        self.assertIn("return '[]';", writes[0][1])
        self.assertIn("bodyParser.json({ limit: '8mb' })", writes[0][1])

    def test_launcher_config_auto_map_import_is_removed_for_explicit_import_phase(self) -> None:
        config = """serverConfig:
  welcomeText: "Local"
  tickRate: 200
  shardName: shardX
  mapFile: /screeps/maps/map-0b6758af.json
cli:
  host: 127.0.0.1
"""

        updated = harness._strip_launcher_auto_map_import(config)

        self.assertIn("shardName: shardX", updated)
        self.assertNotIn("mapFile:", updated)

    def test_debug_worker_phase_broken_stderr_pipe_is_nonfatal(self) -> None:
        class BrokenPipeStderr:
            def __init__(self) -> None:
                self.write_attempts = 0

            def write(self, text: str) -> int:
                self.write_attempts += 1
                raise BrokenPipeError(32, "Broken pipe")

            def flush(self) -> None:
                return None

        broken_stderr = BrokenPipeStderr()
        harness._WORKER_PHASE_DEBUG_DISABLED = False
        try:
            with mock.patch("sys.stderr", broken_stderr):
                harness._debug_worker_phase(2, "variant-a", "before startup", port=21125)
                harness._debug_worker_phase(2, "variant-a", "after startup", port=21125)
        finally:
            harness._WORKER_PHASE_DEBUG_DISABLED = False

        self.assertEqual(broken_stderr.write_attempts, 1)

    def test_run_variants_completes_scale_runs_when_worker_phase_stderr_pipe_breaks(self) -> None:
        class BrokenPipeStderr:
            def __init__(self) -> None:
                self.write_attempts = 0

            def write(self, text: str) -> int:
                self.write_attempts += 1
                raise BrokenPipeError(32, "Broken pipe")

            def flush(self) -> None:
                return None

        class FakeSmokeConfig:
            def __init__(self, **kwargs: object) -> None:
                for key, value in kwargs.items():
                    setattr(self, key, value)

            @property
            def config_path(self) -> Path:
                return self.work_dir / "config.yml"

            @property
            def map_path(self) -> Path:
                return self.work_dir / "maps" / "map-0b6758af.json"

        class Result:
            def __init__(self, status: int, payload: object) -> None:
                self.status = status
                self.payload = payload
                self.headers: dict[str, str] = {}

        class FakeSmoke:
            SmokeConfig = FakeSmokeConfig
            DEFAULT_MAP_URL = ""

            def __init__(self) -> None:
                self._lock = threading.Lock()
                self._state_by_url: dict[str, dict[str, object]] = {}

            def _state(self, base_url: str) -> dict[str, object]:
                with self._lock:
                    return self._state_by_url.setdefault(
                        base_url,
                        {"gametime": 0, "room": "E1S1", "username": "rl-sim"},
                    )

            def host_port_unavailable_reason(self, host: str, port: int) -> str | None:
                _ = host, port
                return None

            def required_env_errors(self, cfg: FakeSmokeConfig) -> list[str]:
                with self._lock:
                    self._state_by_url[str(cfg.server_url)] = {
                        "gametime": 0,
                        "room": cfg.room,
                        "username": cfg.username,
                    }
                return []

            def assert_safe_work_dir(self, work_dir: Path) -> None:
                _ = work_dir
                return None

            def preflight_host_ports(self, cfg: FakeSmokeConfig) -> dict[str, object]:
                _ = cfg
                return {"checks": [{"available": True}]}

            def find_compose_command(self) -> list[str]:
                return ["compose"]

            def prepare_work_dir(self, cfg: FakeSmokeConfig) -> None:
                _ = cfg
                return None

            def build_launcher_config(self, cfg: FakeSmokeConfig) -> str:
                _ = cfg
                return "serverConfig:\n  shardName: shardX\n  mapFile: /screeps/maps/map-0b6758af.json\n"

            def write_generated_text(self, work_dir: Path, path: Path, text: str) -> None:
                _ = work_dir, path, text
                return None

            def prepare_map(self, cfg: FakeSmokeConfig) -> None:
                _ = cfg
                return None

            def run_command(self, command: list[str], cfg: FakeSmokeConfig, timeout: int) -> dict[str, object]:
                _ = command, cfg, timeout
                return {"returncode": 0, "elapsed_seconds": 0.0}

            def wait_for_http(self, cfg: FakeSmokeConfig, timeout: int) -> dict[str, object]:
                _ = cfg, timeout
                return {"ok": True}

            def run_launcher_cli(self, compose: list[str], cfg: FakeSmokeConfig, expression: str) -> dict[str, object]:
                _ = compose, cfg, expression
                return {"status": 200, "response_excerpt": "undefined\n"}

            def token_headers(self, token: str) -> dict[str, str]:
                return {"X-Token": token}

            def update_token_from_headers(self, token: str, headers: dict[str, str]) -> str:
                _ = headers
                return token

            def build_register_payload(self, cfg: FakeSmokeConfig) -> dict[str, object]:
                return {"username": cfg.username, "email": cfg.email, "password": cfg.password}

            def build_signin_payload(self, cfg: FakeSmokeConfig) -> dict[str, object]:
                return {"email": cfg.email, "password": cfg.password}

            def build_code_payload(self, cfg: FakeSmokeConfig, code: str) -> dict[str, object]:
                return {"branch": cfg.branch, "modules": {"main": code}}

            def build_spawn_payload(self, cfg: FakeSmokeConfig) -> dict[str, object]:
                return {"room": cfg.room, "name": cfg.spawn_name, "x": cfg.spawn_x, "y": cfg.spawn_y}

            def api_dict_succeeded(self, result: Result) -> bool:
                return isinstance(result.payload, dict) and result.payload.get("ok") in (1, True)

            def upload_code_succeeded(self, result: Result) -> bool:
                return self.api_dict_succeeded(result)

            def collect_mongo_summary(self, compose: list[str], cfg: FakeSmokeConfig) -> dict[str, object]:
                _ = compose
                return {
                    "ok": True,
                    "summary": {
                        "room": cfg.room,
                        "user": {"id": "user-1", "username": cfg.username},
                        "controller": {"level": 1, "my": True, "owner": {"username": cfg.username}},
                        "spawns": [{"name": cfg.spawn_name, "user": "user-1", "store": {"energy": 300}}],
                        "creeps": [{"name": "worker-1", "user": "user-1", "memory": {"role": "worker"}}],
                        "ownStructureCounts": {"spawn": 1},
                        "creepCounts": {"worker": 1},
                        "ownCreeps": 1,
                        "ownStructures": 1,
                        "storedEnergy": 300,
                        "energyCapacity": 300,
                    },
                }

            def http_json(self, method: str, base_url: str, path: str, *args: object, **kwargs: object) -> Result:
                _ = method, args
                state = self._state(base_url)
                room = str(state["room"])
                username = str(state["username"])
                if path == "/api/game/room-terrain":
                    return Result(200, {"terrain": [{"room": room, "terrain": "0" * 2500}]})
                if path == "/api/register/submit":
                    return Result(200, {"ok": 1})
                if path == "/api/auth/signin":
                    return Result(200, {"ok": 1, "token": f"token-{base_url.rsplit(':', 1)[-1]}"})
                if path == "/api/user/code":
                    return Result(200, {"ok": 1})
                if path == "/api/game/place-spawn":
                    return Result(200, {"ok": 1})
                if path == "/api/user/overview":
                    return Result(200, {"ok": 1, "rooms": [room], "gametime": state["gametime"]})
                if path == "/stats":
                    with self._lock:
                        state["gametime"] = int(state["gametime"]) + 1
                        gametime = state["gametime"]
                    return Result(200, {"gametime": gametime})
                if path == "/api/game/room-overview":
                    requested_room = room
                    params = kwargs.get("params")
                    if isinstance(params, dict) and isinstance(params.get("room"), str):
                        requested_room = params["room"]
                    return Result(
                        200,
                        {
                            "ok": 1,
                            "room": requested_room,
                            "roomData": {
                                "room": requested_room,
                                "user": {"id": "user-1", "username": username},
                                "controller": {
                                    "level": 1,
                                    "my": True,
                                    "owner": {"username": username},
                                },
                                "objects": [
                                    {"type": "spawn", "user": "user-1", "store": {"energy": 300}},
                                    {"type": "creep", "user": "user-1", "memory": {"role": "worker"}},
                                ],
                                "creeps": 1,
                                "energy": 300,
                            },
                        },
                    )
                raise AssertionError(path)

        def run_scale_case(environment_count: int) -> tuple[dict[str, object], list[dict[str, object]], BrokenPipeStderr]:
            with tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                code_path = root / "main.js"
                map_path = root / "map.json"
                code_path.write_text("module.exports.loop = function() {};", encoding="utf-8")
                map_path.write_text("{\"ok\": true}", encoding="utf-8")
                fake_smoke = FakeSmoke()
                broken_stderr = BrokenPipeStderr()
                harness._WORKER_PHASE_DEBUG_DISABLED = False
                try:
                    with mock.patch("screeps_rl_simulator_harness._load_private_smoke_module", return_value=fake_smoke):
                        with mock.patch("sys.stderr", broken_stderr):
                            artifact, results = harness.run_variants(
                                variants=[f"scale-env-{index}" for index in range(environment_count)],
                                ticks=200,
                                workers=environment_count,
                                host_port_start=24125,
                                room="E1S1",
                                shard="shardX",
                                branch="activeWorld",
                                code_path=code_path,
                                map_source_file=map_path,
                                out_dir=root / "out",
                                run_id=f"scale-{environment_count}",
                                bot_commit="0" * 40,
                            )
                finally:
                    harness._WORKER_PHASE_DEBUG_DISABLED = False
            return artifact, results, broken_stderr

        for environment_count in (5, 10):
            with self.subTest(environment_count=environment_count):
                artifact, results, broken_stderr = run_scale_case(environment_count)
                successful = [result for result in results if result.get("ok") is True]
                self.assertGreaterEqual(len(successful), math.ceil(environment_count * 0.8))
                self.assertEqual(len(successful), environment_count)
                self.assertTrue(all(result.get("ticks_run") == 200 for result in successful))
                self.assertEqual(artifact["total_environments"], environment_count)
                self.assertEqual(artifact["successful"], environment_count)
                self.assertEqual(artifact["failed"], 0)
                self.assertEqual(artifact["total_ticks"], environment_count * 200)
                self.assertGreaterEqual(broken_stderr.write_attempts, 1)

    def test_default_sim_room_matches_bundled_private_map(self) -> None:
        self.assertEqual(harness.DEFAULT_SIM_ROOM, "E1S1")

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

    def test_build_tick_entry_accepts_private_server_flat_overview(self) -> None:
        overview = {"ok": 1, "rooms": ["E1S1"], "gametimes": [], "stats": {}, "totals": {}}

        tick_entry = harness._build_tick_entry(
            "shardX",
            "E1S1",
            42,
            overview,
            {"terrain": [{"room": "E1S1", "terrain": "0" * 2500}]},
            {
                "E1S1": {
                    "room": "E1S1",
                    "roomData": {
                        "controller": {"level": 1},
                        "objects": [{"type": "spawn"}],
                        "creeps": 1,
                        "energy": 300,
                    },
                }
            },
        )

        self.assertEqual(tick_entry["overview"]["rooms"], ["E1S1"])
        self.assertEqual(tick_entry["overview"]["roomCount"], 1)
        self.assertEqual(tick_entry["rooms"]["E1S1"]["structures"]["spawn"], 1)

    def test_multi_tier_fixture_rooms_merge_into_tick_when_private_api_lacks_visibility(self) -> None:
        fixture_path = Path("scripts/fixtures/rl/multi-tier-territory-combat-v0.map.json")
        fixture_summaries = harness._private_map_fixture_room_summaries(fixture_path)
        tick_entry = harness._build_tick_entry(
            "shardX",
            "E1S1",
            43,
            {"ok": 1, "rooms": ["E1S1"]},
            {"terrain": [{"room": "E1S1", "terrain": "0" * 2500}]},
            {
                "E1S1": {
                    "room": "E1S1",
                    "roomData": {
                        "user": {"id": "user-1", "username": "rl-sim"},
                        "objects": [
                            {"type": "spawn", "user": "user-1", "store": {"energy": 300}},
                            {"type": "creep", "user": "user-1", "memory": {"role": "worker"}},
                        ],
                    },
                }
            },
            ["E1S1", "E2S1"],
        )

        merged = harness._merge_fixture_room_summaries_into_tick(tick_entry, fixture_summaries)

        self.assertIn("E2S1", merged)
        self.assertIn("map-fixture", tick_entry["roomStateSources"])
        self.assertEqual(tick_entry["rooms"]["E2S1"]["combat"]["hostileCreeps"], 2)
        self.assertEqual(tick_entry["rooms"]["E2S1"]["combat"]["hostileStructures"], 1)
        self.assertFalse(tick_entry["rooms"]["E2S1"]["owned"])
        metrics = harness.build_variant_metrics([tick_entry])
        self.assertEqual(metrics["finalRooms"]["roomCount"], 2)
        self.assertEqual(metrics["combat"]["peakHostileCreeps"], 2)

    def test_multi_tier_policy_activation_engages_hostile_blocker_for_territory_candidate(self) -> None:
        fixture_path = Path("scripts/fixtures/rl/multi-tier-territory-combat-v0.map.json")
        fixture_summaries = harness._private_map_fixture_room_summaries(fixture_path)
        initial_tick = {
            "tick": 1,
            "rooms": {
                "E1S1": {
                    "roomName": "E1S1",
                    "owned": True,
                    "controller": {"level": 1, "my": True, "owner": "rl-sim"},
                    "ownedCreeps": 1,
                    "combat": {"hostileCreeps": 0, "hostileStructures": 0, "ownCreeps": 1, "ownStructures": 1},
                }
            },
        }
        harness._merge_fixture_room_summaries_into_tick(initial_tick, fixture_summaries)
        final_tick = copy.deepcopy(initial_tick)
        final_tick["tick"] = 2
        tick_log = [initial_tick, final_tick]
        strategy_variant = harness.strategy_variant_config_by_id(
            "construction-priority.pg.territory-seed.v1",
            variant_configs={
                "construction-priority.pg.territory-seed.v1": {
                    "id": "construction-priority.pg.territory-seed.v1",
                    "title": "territory seed",
                    "parameters": {
                        "baseScoreWeight": 1,
                        "territorySignalWeight": 22,
                        "resourceSignalWeight": 3,
                        "killSignalWeight": 5,
                        "riskPenalty": 4,
                    },
                }
            },
        )

        activation = harness.apply_multi_tier_policy_activation(tick_log, strategy_variant, fixture_summaries)
        metrics = harness.build_variant_metrics(tick_log)

        self.assertIsNotNone(activation)
        assert activation is not None
        self.assertEqual(activation["policyAction"], "claim-adjacent-controller")
        self.assertEqual(activation["executionAction"], "engage-hostiles")
        self.assertEqual(activation["targetRoom"], "E2S1")
        self.assertEqual(tick_log[-1]["rooms"]["E2S1"]["combat"]["hostileCreeps"], 1)
        self.assertEqual(metrics["combat"]["hostileKills"], 1)
        self.assertEqual(tick_log[-1]["rlPolicyActivation"]["safety"]["officialMmoWrites"], False)

    def test_multi_tier_policy_activation_stays_inactive_for_low_territory_candidate(self) -> None:
        fixture_path = Path("scripts/fixtures/rl/multi-tier-territory-combat-v0.map.json")
        fixture_summaries = harness._private_map_fixture_room_summaries(fixture_path)
        initial_tick = {"tick": 1, "rooms": {"E1S1": {"owned": True, "controller": {"level": 1, "my": True}}}}
        harness._merge_fixture_room_summaries_into_tick(initial_tick, fixture_summaries)
        final_tick = copy.deepcopy(initial_tick)
        final_tick["tick"] = 2
        tick_log = [initial_tick, final_tick]
        strategy_variant = {
            "id": "construction-priority.pg.resource-seed.v1",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 10,
                "resourceSignalWeight": 18,
                "killSignalWeight": 4,
                "riskPenalty": 4,
            },
        }

        activation = harness.apply_multi_tier_policy_activation(tick_log, strategy_variant, fixture_summaries)

        self.assertIsNone(activation)
        self.assertNotIn("rlPolicyActivation", tick_log[-1])
        self.assertEqual(harness.build_variant_metrics(tick_log)["combat"]["hostileKills"], 0)

    def test_inline_strategy_variant_config_overrides_registry_fallback(self) -> None:
        config = harness.strategy_variant_config_by_id(
            "construction-priority.pg.territory-seed.v1",
            variant_configs={
                "construction-priority.pg.territory-seed.v1": {
                    "id": "construction-priority.pg.territory-seed.v1",
                    "title": "Policy-gradient territory seed",
                    "parameters": {
                        "baseScoreWeight": 1,
                        "territorySignalWeight": 22,
                        "resourceSignalWeight": 3,
                        "killSignalWeight": 5,
                        "riskPenalty": 4,
                    },
                }
            },
        )

        self.assertEqual(config["label"], "Policy-gradient territory seed")
        self.assertEqual(config["parameters"]["territorySignalWeight"], 22)
        self.assertEqual(config["defaultValues"]["territorySignalWeight"], 22)
        self.assertFalse(config["safety"]["liveEffect"])
        self.assertFalse(config["safety"]["officialMmoWrites"])

    def test_fetch_room_overviews_rotates_token_when_optional_room_fetch_raises(self) -> None:
        class Result:
            def __init__(self, payload: object, headers: dict[str, str] | None = None) -> None:
                self.payload = payload
                self.headers = headers or {}

        class OptionalRoomError(RuntimeError):
            def __init__(self) -> None:
                super().__init__("optional room unavailable")
                self.headers = {"X-Token": "token-from-optional-error"}

        class FakeSmoke:
            def token_headers(self, token: str) -> dict[str, str]:
                return {"X-Token": token}

            def update_token_from_headers(self, token: str, headers: dict[str, str]) -> str:
                for key, value in headers.items():
                    if key.lower() == "x-token":
                        return value
                return token

            def api_dict_succeeded(self, result: Result) -> bool:
                return isinstance(result.payload, dict) and result.payload.get("ok") == 1

            def http_json(self, method: str, base_url: str, path: str, **kwargs: object) -> Result:
                _ = method, base_url, path
                params = kwargs.get("params")
                room_name = params.get("room") if isinstance(params, dict) else None
                if room_name == "E2S1":
                    raise OptionalRoomError()
                return Result(
                    {"ok": 1, "room": room_name, "roomData": {}},
                    {"X-Token": "token-after-required-room"},
                )

        token, payloads = harness._fetch_room_overviews(
            argparse.Namespace(server_url="http://127.0.0.1"),
            FakeSmoke(),
            "initial-token",
            ["E1S1"],
            "shardX",
            optional_rooms=["E2S1"],
        )

        self.assertEqual(token, "token-from-optional-error")
        self.assertEqual(sorted(payloads), ["E1S1"])

    def test_build_tick_entry_normalizes_private_object_maps_into_owned_scorecard_fields(self) -> None:
        tick_entry = harness._build_tick_entry(
            "shardX",
            "E1S1",
            43,
            {"ok": 1, "rooms": ["E1S1"]},
            {"terrain": [{"room": "E1S1", "terrain": "0" * 2500}]},
            {
                "E1S1": {
                    "room": "E1S1",
                    "roomData": {
                        "user": {"id": "user-1", "username": "rl-sim"},
                        "objects": {
                            "controller1": {
                                "type": "controller",
                                "user": "user-1",
                                "level": 2,
                                "progress": 12,
                                "progressTotal": 45000,
                            },
                            "spawn1": {
                                "type": "spawn",
                                "user": "user-1",
                                "store": {"energy": 220, "capacity": 300},
                            },
                            "extension1": {
                                "type": "extension",
                                "user": "user-1",
                                "store": {"energy": 30, "capacity": 50},
                            },
                            "worker1": {
                                "type": "creep",
                                "user": "user-1",
                                "name": "worker-E1S1-43",
                                "memory": {"role": "worker"},
                                "carry": {"energy": 10},
                            },
                        },
                    },
                }
            },
        )

        room = tick_entry["rooms"]["E1S1"]
        self.assertTrue(room["owned"])
        self.assertEqual(room["controller"]["level"], 2)
        self.assertEqual(room["controller"]["owner"], "user-1")
        self.assertEqual(room["structureCounts"], {"extension": 1, "spawn": 1})
        self.assertEqual(room["ownStructures"], 2)
        self.assertEqual(room["ownedCreeps"], 1)
        self.assertEqual(room["ownCreepRoles"], {"worker": 1})
        self.assertEqual(room["storedEnergy"], 250)
        self.assertEqual(room["energyCapacity"], 350)

        variant = {"variant_id": "baseline", "variant_run_id": "run-baseline", "tick_log": [tick_entry]}
        scorecard = harness.build_variant_owned_room_scorecard(variant)

        self.assertEqual(scorecard["ownedRoomCount"], 1)
        self.assertEqual(scorecard["ownedRooms"][0]["roomName"], "E1S1")
        self.assertEqual(scorecard["ownedRooms"][0]["rcl"], 2)
        self.assertEqual(scorecard["ownedRooms"][0]["structureCounts"], {"extension": 1, "spawn": 1})
        self.assertEqual(scorecard["ownedRooms"][0]["creepCounts"], {"worker": 1})

    def test_untrusted_room_objects_do_not_count_as_owned_scorecard_evidence(self) -> None:
        tick_entry = harness._build_tick_entry(
            "shardX",
            "E1S1",
            43,
            {"ok": 1, "rooms": ["E1S1"]},
            {"terrain": [{"room": "E1S1", "terrain": "0" * 2500}]},
            {
                "E1S1": {
                    "room": "E1S1",
                    "roomData": {
                        "objects": {
                            "controller1": {
                                "type": "controller",
                                "user": "enemy-user",
                                "level": 2,
                                "progress": 12,
                                "progressTotal": 45000,
                            },
                            "spawn1": {
                                "type": "spawn",
                                "user": "enemy-user",
                                "store": {"energy": 220, "capacity": 300},
                            },
                            "worker1": {
                                "type": "creep",
                                "user": "enemy-user",
                                "name": "worker-E1S1-43",
                                "memory": {"role": "worker"},
                            },
                        },
                    },
                }
            },
        )

        room = tick_entry["rooms"]["E1S1"]
        self.assertFalse(room["owned"])
        self.assertEqual(room["ownStructures"], 0)
        self.assertEqual(room["ownedCreeps"], 0)
        self.assertEqual(room["ownCreepRoles"], {})
        self.assertEqual(room["storedEnergy"], 0)
        self.assertIsNone(room["energyCapacity"])

        variant = {"variant_id": "baseline", "variant_run_id": "run-baseline", "tick_log": [tick_entry]}
        scorecard = harness.build_variant_owned_room_scorecard(variant)

        self.assertEqual(scorecard["ownedRoomCount"], 0)
        self.assertEqual(scorecard["ownedRooms"], [])

    def test_mongo_room_summary_merges_into_empty_http_tick_entry(self) -> None:
        tick_entry = harness._build_tick_entry(
            "shardX",
            "E1S1",
            44,
            {"ok": 1, "rooms": ["E1S1"]},
            {"terrain": [{"room": "E1S1", "terrain": "0" * 2500}]},
            {"E1S1": {"room": "E1S1", "roomData": {}}},
        )
        mongo_summary = {
            "ok": True,
            "summary": {
                "room": "E1S1",
                "user": {"username": "rl-sim", "id": "user-1"},
                "controller": {
                    "level": 1,
                    "progress": 5,
                    "progressTotal": 300,
                    "user": "user-1",
                    "my": True,
                    "owner": {"username": "rl-sim"},
                },
                "structureCounts": {"spawn": 1},
                "ownStructureCounts": {"spawn": 1},
                "ownStructures": 1,
                "creepCounts": {"worker": 2},
                "ownCreeps": 2,
                "storedEnergy": 280,
                "energyCapacityAvailable": 300,
                "objects": [
                    {"type": "spawn", "user": "user-1", "store": {"energy": 280, "capacity": 300}},
                    {"type": "creep", "user": "user-1", "memory": {"role": "worker"}},
                    {"type": "creep", "user": "user-1", "memory": {"role": "worker"}},
                    {"type": "controller", "user": "user-1", "level": 1, "progress": 5, "progressTotal": 300},
                ],
            },
        }

        self.assertTrue(harness._merge_mongo_room_summary_into_tick(tick_entry, mongo_summary))

        room = tick_entry["rooms"]["E1S1"]
        self.assertTrue(room["owned"])
        self.assertEqual(room["controller"]["owner"], "rl-sim")
        self.assertEqual(room["ownStructures"], 1)
        self.assertEqual(room["ownedCreeps"], 2)
        self.assertEqual(room["ownCreepRoles"], {"worker": 2})
        self.assertEqual(room["energyCapacity"], 300)
        self.assertIn("mongo-room-objects", tick_entry["roomStateSources"])

    def test_failed_mongo_room_summary_exposes_collection_error(self) -> None:
        tick_entry = harness._build_tick_entry(
            "shardX",
            "E1S1",
            44,
            {"ok": 1, "rooms": ["E1S1"]},
            {"terrain": [{"room": "E1S1", "terrain": "0" * 2500}]},
            {"E1S1": {"room": "E1S1", "roomData": {}}},
        )
        mongo_summary = {"ok": False, "error": "could not parse mongosh summary"}

        self.assertFalse(harness._merge_mongo_room_summary_into_tick(tick_entry, mongo_summary))
        self.assertEqual(harness._mongo_room_summary_error(mongo_summary), "could not parse mongosh summary")

    def test_run_one_tick_uses_stats_gametime_when_private_overview_has_no_shard_clock(self) -> None:
        class Result:
            def __init__(self, payload: object) -> None:
                self.payload = payload
                self.headers: dict[str, str] = {}

        class FakeSmoke:
            def token_headers(self, token: str) -> dict[str, str]:
                return {"X-Token": token}

            def update_token_from_headers(self, token: str, headers: dict[str, str]) -> str:
                return token

            def api_dict_succeeded(self, result: Result) -> bool:
                return isinstance(result.payload, dict) and result.payload.get("ok", 1) == 1

            def http_json(self, method: str, base_url: str, path: str, **kwargs: object) -> Result:
                _ = method, base_url, kwargs
                if path == "/api/user/overview":
                    return Result({"ok": 1, "rooms": ["E1S1"], "gametimes": []})
                if path == "/stats":
                    return Result({"gametime": 42})
                if path == "/api/game/room-terrain":
                    return Result({"terrain": [{"room": "E1S1", "terrain": "0" * 2500}]})
                if path == "/api/game/room-overview":
                    return Result({
                        "ok": 1,
                        "room": "E1S1",
                        "roomData": {
                            "controller": {"level": 1},
                            "objects": [{"type": "spawn"}],
                            "creeps": 1,
                            "energy": 300,
                        },
                    })
                raise AssertionError(path)

        token, observed_tick, tick_entry = harness._run_one_tick(
            argparse.Namespace(server_url="http://127.0.0.1"),
            FakeSmoke(),
            "token",
            "E1S1",
            "shardX",
            previous_tick=41,
            timeout_seconds=0.1,
        )

        self.assertEqual(token, "token")
        self.assertEqual(observed_tick, 42)
        self.assertEqual(tick_entry["tick"], 42)
        self.assertEqual(tick_entry["rooms"]["E1S1"]["creeps"], 1)

    def test_run_one_tick_prefers_stats_gametime_over_stale_private_overview(self) -> None:
        class Result:
            def __init__(self, payload: object) -> None:
                self.payload = payload
                self.headers: dict[str, str] = {}

        class FakeSmoke:
            def token_headers(self, token: str) -> dict[str, str]:
                return {"X-Token": token}

            def update_token_from_headers(self, token: str, headers: dict[str, str]) -> str:
                return token

            def api_dict_succeeded(self, result: Result) -> bool:
                return isinstance(result.payload, dict) and result.payload.get("ok", 1) == 1

            def http_json(self, method: str, base_url: str, path: str, **kwargs: object) -> Result:
                _ = method, base_url, kwargs
                if path == "/api/user/overview":
                    return Result({"ok": 1, "rooms": ["E1S1"], "gametime": 999})
                if path == "/stats":
                    return Result({"gametime": 42})
                if path == "/api/game/room-terrain":
                    return Result({"terrain": [{"room": "E1S1", "terrain": "0" * 2500}]})
                if path == "/api/game/room-overview":
                    return Result({
                        "ok": 1,
                        "room": "E1S1",
                        "roomData": {
                            "controller": {"level": 1},
                            "objects": [{"type": "spawn"}],
                            "creeps": 1,
                            "energy": 300,
                        },
                    })
                raise AssertionError(path)

        _token, observed_tick, tick_entry = harness._run_one_tick(
            argparse.Namespace(server_url="http://127.0.0.1"),
            FakeSmoke(),
            "token",
            "E1S1",
            "shardX",
            previous_tick=41,
            timeout_seconds=0.1,
        )

        self.assertEqual(observed_tick, 42)
        self.assertEqual(tick_entry["tick"], 42)

    def test_build_variant_metrics_reduces_territory_resources_and_combat(self) -> None:
        tick_log = [
            {
                "tick": 1,
                "rooms": {
                    "E26S49": {
                        "controller": {"level": 1},
                        "energy": 300,
                        "structures": {"spawn": 1},
                        "combat": {"hostileCreeps": 2, "ownCreeps": 3},
                    }
                },
            },
            {
                "tick": 5,
                "rooms": {
                    "E26S49": {
                        "controller": {"level": 2},
                        "energy": 550,
                        "structures": {"spawn": 1, "container": 1},
                        "combat": {"hostileCreeps": 0, "ownCreeps": 2},
                    }
                },
            },
        ]

        metrics = harness.build_variant_metrics(tick_log)

        self.assertEqual(metrics["territory"]["controllerLevelDelta"], 1)
        self.assertEqual(metrics["resources"]["energyDelta"], 250)
        self.assertEqual(metrics["combat"]["hostileKills"], 2)
        self.assertEqual(metrics["combat"]["ownLosses"], 1)
        self.assertEqual(metrics["combatDelta"], 1)
        self.assertEqual(metrics["finalRooms"]["structures"]["container"], 1)

    def test_run_variant_initializes_frozen_smoke_config_with_http_server_url(self) -> None:
        captured_server_urls: list[str] = []
        captured_branches: list[str] = []

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
                captured_branches.append(str(cfg.branch))
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

        self.assertEqual(captured_server_urls, ["http://127.0.0.1:21125"])
        self.assertEqual(captured_branches, ["$activeWorld"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "stop before side effects")
        self.assertIsNone(result["launcherRepairMod"])

    def test_run_variant_uses_private_smoke_map_url_when_default_map_file_is_missing(self) -> None:
        captured_map_sources: list[object] = []
        captured_map_urls: list[str] = []

        class FakeSmokeConfig:
            def __init__(self, **kwargs: object) -> None:
                for key, value in kwargs.items():
                    setattr(self, key, value)

        class FakeSmoke:
            SmokeConfig = FakeSmokeConfig
            DEFAULT_MAP_URL = "https://maps.example.invalid/map.json"

            def required_env_errors(self, cfg: FakeSmokeConfig) -> list[str]:
                captured_map_sources.append(cfg.map_source_file)
                captured_map_urls.append(str(cfg.map_url))
                return ["stop before side effects"]

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            missing_default_map = root / "missing-map.json"

            with mock.patch("screeps_rl_simulator_harness.DEFAULT_MAP_SOURCE_FILE", missing_default_map):
                with mock.patch("screeps_rl_simulator_harness._load_private_smoke_module", return_value=FakeSmoke()):
                    result = harness._run_variant(
                        0,
                        "baseline",
                        run_id="missing-default-map",
                        ticks=1,
                        room="E1S1",
                        shard="shardX",
                        branch="activeWorld",
                        code_path=root / "main.js",
                        map_source_file=missing_default_map,
                        out_dir=root / "out",
                    )

        self.assertIsNone(captured_map_sources[0])
        self.assertEqual(captured_map_urls, ["https://maps.example.invalid/map.json"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "stop before side effects")

    def test_resolve_smoke_map_source_rejects_nondefault_missing_map_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            missing = Path(temp_dir) / "explicit-missing-map.json"

            with self.assertRaisesRegex(RuntimeError, "map source file is not a file"):
                harness._resolve_smoke_map_source_file(missing)

    def test_select_run_ports_skips_occupied_default_pair(self) -> None:
        class FakeSmoke:
            def host_port_unavailable_reason(self, host: str, port: int) -> str | None:
                if port in {harness.RUN_HTTP_START, harness.RUN_CLI_START}:
                    return "address already in use"
                return None

        self.assertEqual(
            harness._select_run_ports(
                FakeSmoke(),
                "127.0.0.1",
                worker_index=0,
                worker_count=1,
            ),
            (
                harness.RUN_HTTP_START + harness.RUN_HTTP_PORT_STEP,
                harness.RUN_CLI_START + harness.RUN_HTTP_PORT_STEP,
            ),
        )

    def test_select_run_ports_keeps_parallel_worker_fallbacks_disjoint(self) -> None:
        class FakeSmoke:
            def host_port_unavailable_reason(self, host: str, port: int) -> str | None:
                if port == harness.RUN_HTTP_START:
                    return "address already in use"
                return None

        smoke = FakeSmoke()

        self.assertEqual(
            harness._select_run_ports(
                smoke,
                "127.0.0.1",
                worker_index=0,
                worker_count=2,
            ),
            harness._build_run_ports(2),
        )
        self.assertEqual(
            harness._select_run_ports(
                smoke,
                "127.0.0.1",
                worker_index=1,
                worker_count=2,
            ),
            harness._build_run_ports(1),
        )

    def test_select_run_ports_starts_from_configured_host_port_start(self) -> None:
        observed_ports: list[int] = []

        class FakeSmoke:
            def host_port_unavailable_reason(self, host: str, port: int) -> str | None:
                observed_ports.append(port)
                return None

        self.assertEqual(
            harness._select_run_ports(
                FakeSmoke(),
                "127.0.0.1",
                worker_index=0,
                worker_count=1,
                host_port_start=23125,
            ),
            (23125, 23126),
        )
        self.assertEqual(observed_ports, [23125, 23126])

    def test_run_variant_installs_repair_mod_before_compose_start(self) -> None:
        events: list[str] = []
        run_command_calls = 0

        class FakeSmokeConfig:
            def __init__(self, **kwargs: object) -> None:
                for key, value in kwargs.items():
                    setattr(self, key, value)

        class FakeSmoke:
            SmokeConfig = FakeSmokeConfig

            def required_env_errors(self, cfg: FakeSmokeConfig) -> list[str]:
                return []

            def assert_safe_work_dir(self, work_dir: Path) -> None:
                return None

            def preflight_host_ports(self, cfg: FakeSmokeConfig) -> dict[str, object]:
                return {"checks": [{"available": True}]}

            def find_compose_command(self) -> list[str]:
                return ["compose"]

            def prepare_work_dir(self, cfg: FakeSmokeConfig) -> None:
                events.append("prepare_work_dir")

            def write_generated_text(self, work_dir: Path, path: Path, text: str) -> None:
                events.append(f"write_mod:{path.name}")

            def prepare_map(self, cfg: FakeSmokeConfig) -> None:
                events.append("prepare_map")

            def run_command(self, command: list[str], cfg: FakeSmokeConfig, timeout: int) -> dict[str, object]:
                nonlocal run_command_calls
                run_command_calls += 1
                events.append(f"run_command:{command[-2:]}")
                if run_command_calls == 1:
                    raise RuntimeError("stop after mod install")
                return {"returncode": 0}

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
                    run_id="mod-install",
                    ticks=1,
                    room="E26S49",
                    shard="shardX",
                    branch="activeWorld",
                    code_path=code_path,
                    map_source_file=map_path,
                    out_dir=root / "out",
                )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "stop after mod install")
        self.assertEqual(
            events[:4],
            [
                "prepare_work_dir",
                f"write_mod:{harness.SIMULATOR_REPAIR_MOD_FILENAME}",
                "prepare_map",
                "run_command:['down', '-v']",
            ],
        )
        self.assertTrue(str(result["launcherRepairMod"]).endswith(harness.SIMULATOR_REPAIR_MOD_FILENAME))

    def test_run_variant_reads_fixture_summary_from_prepared_default_map(self) -> None:
        run_command_calls = 0

        class FakeSmokeConfig:
            def __init__(self, **kwargs: object) -> None:
                for key, value in kwargs.items():
                    setattr(self, key, value)

            @property
            def map_path(self) -> Path:
                return self.work_dir / "maps" / "map-0b6758af.json"

        class FakeSmoke:
            SmokeConfig = FakeSmokeConfig
            DEFAULT_MAP_URL = "https://example.invalid/default-map.json"

            def required_env_errors(self, cfg: FakeSmokeConfig) -> list[str]:
                return []

            def assert_safe_work_dir(self, work_dir: Path) -> None:
                return None

            def preflight_host_ports(self, cfg: FakeSmokeConfig) -> dict[str, object]:
                return {"checks": [{"available": True}]}

            def find_compose_command(self) -> list[str]:
                return ["compose"]

            def prepare_work_dir(self, cfg: FakeSmokeConfig) -> None:
                return None

            def write_generated_text(self, work_dir: Path, path: Path, text: str) -> None:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding="utf-8")

            def prepare_map(self, cfg: FakeSmokeConfig) -> None:
                cfg.map_path.parent.mkdir(parents=True, exist_ok=True)
                cfg.map_path.write_text(
                    json.dumps(
                        {
                            "type": harness.PRIVATE_MAP_FIXTURE_TYPE,
                            "owner": {"id": "owner-1", "username": "rl-sim"},
                            "rooms": [
                                {
                                    "room": "E1S1",
                                    "objects": [
                                        {"type": "controller", "level": 1, "user": "owner-1"},
                                        {"type": "spawn", "user": "owner-1"},
                                        {"type": "creep", "user": "owner-1"},
                                    ],
                                },
                                {
                                    "room": "E2S1",
                                    "objects": [
                                        {
                                            "type": "controller",
                                            "level": 2,
                                            "my": False,
                                            "user": "invader",
                                            "owner": {"username": "Invader"},
                                        },
                                        {"type": "creep", "user": "invader"},
                                        {"type": "spawn", "user": "invader"},
                                    ],
                                },
                            ],
                        }
                    ),
                    encoding="utf-8",
                )

            def run_command(self, command: list[str], cfg: FakeSmokeConfig, timeout: int) -> dict[str, object]:
                _ = command, cfg, timeout
                nonlocal run_command_calls
                run_command_calls += 1
                if run_command_calls == 1:
                    raise RuntimeError("stop after prepared fixture parse")
                return {"returncode": 0}

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            code_path = root / "main.js"
            default_map_path = root / "maps" / "map-0b6758af.json"
            expected_prepared_map = (
                root
                / "out"
                / "prepared-fixture"
                / "workers"
                / "rl-sim-worker-prepared-fixture-00"
                / "maps"
                / "map-0b6758af.json"
            )
            code_path.write_text("module.exports.loop = function() {};", encoding="utf-8")
            default_map_path.parent.mkdir(parents=True, exist_ok=True)
            default_map_path.write_text("{\"terrain\": []}", encoding="utf-8")

            with mock.patch("screeps_rl_simulator_harness.DEFAULT_MAP_SOURCE_FILE", default_map_path):
                with mock.patch("screeps_rl_simulator_harness._load_private_smoke_module", return_value=FakeSmoke()):
                    result = harness._run_variant(
                        0,
                        "baseline",
                        run_id="prepared-fixture",
                        ticks=1,
                        room="E1S1",
                        shard="shardX",
                        branch="activeWorld",
                        code_path=code_path,
                        map_source_file=default_map_path,
                        out_dir=root / "out",
                    )

        self.assertFalse(result["ok"])
        self.assertEqual(result["scenario"]["mapArtifact"]["sourcePath"], str(expected_prepared_map))
        self.assertEqual(result["scenarioFixture"]["roomCount"], 2)
        self.assertEqual(result["scenarioFixture"]["ownedRoomCount"], 1)
        self.assertTrue(result["scenarioFixture"]["objectiveSignalPresent"])

    def test_run_variant_preserves_explicit_source_fixture_summary(self) -> None:
        run_command_calls = 0
        fixture_path = Path("scripts/fixtures/rl/multi-tier-territory-combat-v0.map.json")

        class FakeSmokeConfig:
            def __init__(self, **kwargs: object) -> None:
                for key, value in kwargs.items():
                    setattr(self, key, value)

            @property
            def map_path(self) -> Path:
                return self.work_dir / "maps" / "map-0b6758af.json"

        class FakeSmoke:
            SmokeConfig = FakeSmokeConfig

            def required_env_errors(self, cfg: FakeSmokeConfig) -> list[str]:
                return []

            def assert_safe_work_dir(self, work_dir: Path) -> None:
                return None

            def preflight_host_ports(self, cfg: FakeSmokeConfig) -> dict[str, object]:
                return {"checks": [{"available": True}]}

            def find_compose_command(self) -> list[str]:
                return ["compose"]

            def prepare_work_dir(self, cfg: FakeSmokeConfig) -> None:
                return None

            def write_generated_text(self, work_dir: Path, path: Path, text: str) -> None:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding="utf-8")

            def prepare_map(self, cfg: FakeSmokeConfig) -> None:
                cfg.map_path.parent.mkdir(parents=True, exist_ok=True)
                cfg.map_path.write_text(
                    json.dumps(
                        {
                            "type": harness.PRIVATE_MAP_FIXTURE_TYPE,
                            "owner": {"id": "owner-1", "username": "rl-sim"},
                            "rooms": [
                                {
                                    "room": "W1N1",
                                    "objects": [
                                        {"type": "controller", "level": 1, "user": "owner-1"},
                                        {"type": "spawn", "user": "owner-1"},
                                    ],
                                }
                            ],
                        }
                    ),
                    encoding="utf-8",
                )

            def run_command(self, command: list[str], cfg: FakeSmokeConfig, timeout: int) -> dict[str, object]:
                _ = command, cfg, timeout
                nonlocal run_command_calls
                run_command_calls += 1
                if run_command_calls == 1:
                    raise RuntimeError("stop after explicit fixture parse")
                return {"returncode": 0}

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            code_path = root / "main.js"
            code_path.write_text("module.exports.loop = function() {};", encoding="utf-8")

            with mock.patch("screeps_rl_simulator_harness._load_private_smoke_module", return_value=FakeSmoke()):
                result = harness._run_variant(
                    0,
                    "baseline",
                    run_id="explicit-fixture",
                    ticks=1,
                    room="E1S1",
                    shard="shardX",
                    branch="activeWorld",
                    code_path=code_path,
                    map_source_file=fixture_path,
                    out_dir=root / "out",
                )

        self.assertFalse(result["ok"])
        self.assertEqual(result["scenario"]["mapArtifact"]["sourcePath"], str(fixture_path))
        self.assertEqual(result["scenarioFixture"]["rooms"], ["E1S1", "E2S1"])
        self.assertEqual(result["scenarioFixture"]["hostileCreeps"], 2)
        self.assertEqual(result["scenarioFixture"]["hostileStructures"], 1)
        self.assertTrue(result["scenarioFixture"]["objectiveSignalPresent"])

    def test_run_variant_rewrites_launcher_config_before_compose_start(self) -> None:
        events: list[str] = []

        class FakeSmokeConfig:
            def __init__(self, **kwargs: object) -> None:
                for key, value in kwargs.items():
                    setattr(self, key, value)

            @property
            def config_path(self) -> Path:
                return self.work_dir / "config.yml"

            @property
            def map_path(self) -> Path:
                return self.work_dir / "maps" / "map-0b6758af.json"

        class FakeSmoke:
            SmokeConfig = FakeSmokeConfig

            def required_env_errors(self, cfg: FakeSmokeConfig) -> list[str]:
                return []

            def assert_safe_work_dir(self, work_dir: Path) -> None:
                return None

            def preflight_host_ports(self, cfg: FakeSmokeConfig) -> dict[str, object]:
                return {"checks": [{"available": True}]}

            def find_compose_command(self) -> list[str]:
                return ["compose"]

            def prepare_work_dir(self, cfg: FakeSmokeConfig) -> None:
                events.append("prepare_work_dir")

            def build_launcher_config(self, cfg: FakeSmokeConfig) -> str:
                _ = cfg
                return "serverConfig:\n  shardName: shardX\n  mapFile: /screeps/maps/map-0b6758af.json\n"

            def write_generated_text(self, work_dir: Path, path: Path, text: str) -> None:
                _ = work_dir
                if path.name == "config.yml":
                    events.append(f"rewrite_config:{'mapFile:' in text}")
                else:
                    events.append(f"write_mod:{path.name}")

            def prepare_map(self, cfg: FakeSmokeConfig) -> None:
                events.append("prepare_map")

            def run_command(self, command: list[str], cfg: FakeSmokeConfig, timeout: int) -> dict[str, object]:
                _ = cfg, timeout
                events.append(f"run_command:{command[-2:]}")
                raise RuntimeError("stop after config rewrite")

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
                    run_id="config-rewrite",
                    ticks=1,
                    room="E1S1",
                    shard="shardX",
                    branch="activeWorld",
                    code_path=code_path,
                    map_source_file=map_path,
                    out_dir=root / "out",
                )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "stop after config rewrite")
        self.assertEqual(
            events[:5],
            [
                "prepare_work_dir",
                "rewrite_config:False",
                f"write_mod:{harness.SIMULATOR_REPAIR_MOD_FILENAME}",
                "prepare_map",
                "run_command:['down', '-v']",
            ],
        )
        self.assertTrue(result["launcherAutoMapImportDisabled"])

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

    def test_run_variants_retries_broken_pipe_with_fresh_worker_lifecycle(self) -> None:
        calls: list[dict[str, object]] = []

        def fake_run_variant(worker_index: int, variant_id: str, **kwargs: object) -> dict[str, object]:
            calls.append({"worker_index": worker_index, "variant_id": variant_id, **kwargs})
            if len(calls) == 1:
                return {
                    "variant_id": variant_id,
                    "worker_id": worker_index,
                    "variant_run_id": f"{kwargs['run_id']}-{variant_id}",
                    "ticks_run": 0,
                    "wall_clock_seconds": 0.1,
                    "tick_log": [],
                    "ok": False,
                    "error": "[Errno 32] Broken pipe",
                    "errors": ["[Errno 32] Broken pipe"],
                }
            return {
                "variant_id": variant_id,
                "worker_id": worker_index,
                "variant_run_id": f"{kwargs['run_id']}-{variant_id}",
                "ticks_run": 1,
                "wall_clock_seconds": 0.2,
                "tick_log": [{"tick": 1}],
                "ok": True,
            }

        with mock.patch("screeps_rl_simulator_harness._run_variant", side_effect=fake_run_variant):
            with mock.patch("screeps_rl_simulator_harness.cleanup_exact_run_worker_containers") as cleanup:
                with mock.patch("screeps_rl_simulator_harness.time.sleep") as sleep:
                    artifact, results = harness.run_variants(
                        variants=["baseline"],
                        ticks=1,
                        workers=1,
                        host_port_start=24125,
                        room="E1S1",
                        shard="shardX",
                        branch="activeWorld",
                        code_path=Path("main.js"),
                        map_source_file=Path("map.json"),
                        out_dir=Path("out"),
                        run_id="bp-run",
                        bot_commit="0" * 40,
                    )

        self.assertEqual([call["run_id"] for call in calls], ["bp-run", "bp-run-bp-retry-1"])
        self.assertEqual([call["host_port_start"] for call in calls], [24125, 24127])
        cleanup.assert_called_once_with("bp-run", worker_index=0)
        sleep.assert_called_once_with(harness.RUN_BROKEN_PIPE_RETRY_BACKOFF_SECONDS)
        self.assertTrue(results[0]["ok"])
        self.assertTrue(results[0]["brokenPipeRecovery"]["recovered"])
        self.assertEqual(results[0]["brokenPipeRecovery"]["attempts"], 2)
        self.assertEqual(artifact["successful"], 1)
        self.assertEqual(artifact["failed"], 0)

    def test_run_simulator_writes_schema_validated_and_redacted_artifact(self) -> None:
        mock_variant = {
            "variant_id": "baseline",
            "variant_run_id": "run-validate-baseline",
            "ticks_requested": 3,
            "ticks_run": 3,
            "wall_clock_seconds": 1.2,
            "ticks_per_second": 2.5,
            "tick_log": [
                {
                    "tick": 1,
                    "rooms": {
                        "E1S1": {
                            "roomName": "E1S1",
                            "owned": True,
                            "controller": {"level": 1, "progress": 0, "progressTotal": 300, "my": True, "owner": "rl-sim"},
                            "storedEnergy": 300,
                            "energyCapacity": 300,
                            "ownStructureCounts": {"spawn": 1},
                            "ownStructures": 1,
                            "ownedCreeps": 1,
                            "ownCreepRoles": {"worker": 1},
                        }
                    },
                }
            ],
            "live_effect": False,
            "official_mmo_writes": False,
            "ok": True,
        }
        run_artifact = {
            "type": harness.RUN_SUMMARY_TYPE,
            "runId": "run-validate",
            "harness_version": harness.HARNESS_VERSION,
            "botCommit": harness.DEFAULT_BOT_COMMIT,
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
                    self.assertTrue((out_dir / "run-validate" / "owned_room_scorecard.json").exists())

        self.assertEqual(summary["runId"], "run-validate")
        self.assertIsNotNone(output_data)
        self.assertEqual(output_data["runId"], "run-validate")
        self.assertEqual(output_data["botCommit"], harness.DEFAULT_BOT_COMMIT)
        self.assertEqual(output_data["variants"][0]["variant_id"], "baseline")
        self.assertEqual(output_data["ownedRoomScorecard"]["ownedRoomCount"], 1)
        self.assertEqual(output_data["ownedRoomScorecard"]["ownedRooms"][0]["roomName"], "E1S1")
        self.assertEqual(output_data["ownedRoomScorecard"]["ownedRooms"][0]["creepCounts"], {"worker": 1})
        self.assertFalse(output_data["official_mmo_writes"])
        self.assertFalse(output_data["live_effect"])
        self.assertNotIn("super-secret-key", json.dumps(output_data))

    def test_run_simulator_loads_steam_key_from_configured_env_file(self) -> None:
        file_secret = "harness-file-secret-token-123456"
        mock_variant = {
            "variant_id": "baseline",
            "variant_run_id": "env-file-load-baseline",
            "ticks_requested": 1,
            "ticks_run": 1,
            "wall_clock_seconds": 0.1,
            "tick_log": [],
            "live_effect": False,
            "official_mmo_writes": False,
            "ok": True,
        }
        run_artifact = {
            "type": harness.RUN_SUMMARY_TYPE,
            "runId": "env-file-load",
            "harness_version": harness.HARNESS_VERSION,
            "botCommit": harness.DEFAULT_BOT_COMMIT,
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
            env_file = root / "local.env"
            code_path.write_text("module.exports.loop = function() {};", encoding="utf-8")
            map_path.write_text("{\"ok\": true}", encoding="utf-8")
            env_file.write_text(f"export STEAM_KEY='{file_secret}' # local only\n", encoding="utf-8")
            out_dir = root / "runtime-artifacts"

            with mock.patch.dict(os.environ, {harness.STEAM_KEY_ENV_FILE_ENV: str(env_file)}, clear=True):
                with mock.patch("screeps_rl_simulator_harness.run_variants", return_value=(run_artifact, [mock_variant])):
                    summary = harness.run_simulator(
                        ticks=1,
                        workers=1,
                        variants=["baseline"],
                        out_dir=out_dir,
                        run_id="env-file-load",
                        code_path=code_path,
                        map_source_file=map_path,
                    )
                    output_text = (out_dir / "env-file-load" / "run_summary.json").read_text(encoding="utf-8")
                    self.assertEqual(os.environ.get("STEAM_KEY"), file_secret)

        self.assertEqual(summary["runId"], "env-file-load")
        self.assertNotIn(file_secret, output_text)

    def test_run_simulator_loads_whitespace_steam_key_from_configured_env_file(self) -> None:
        file_secret = "harness-file-secret-token-123456"
        mock_variant = {
            "variant_id": "baseline",
            "variant_run_id": "whitespace-env-file-load-baseline",
            "ticks_requested": 1,
            "ticks_run": 1,
            "wall_clock_seconds": 0.1,
            "tick_log": [],
            "live_effect": False,
            "official_mmo_writes": False,
            "ok": True,
        }
        run_artifact = {
            "type": harness.RUN_SUMMARY_TYPE,
            "runId": "whitespace-env-file-load",
            "harness_version": harness.HARNESS_VERSION,
            "botCommit": harness.DEFAULT_BOT_COMMIT,
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
            env_file = root / "local.env"
            code_path.write_text("module.exports.loop = function() {};", encoding="utf-8")
            map_path.write_text("{\"ok\": true}", encoding="utf-8")
            env_file.write_text(f"STEAM_KEY={file_secret}\n", encoding="utf-8")
            out_dir = root / "runtime-artifacts"

            with mock.patch.dict(
                os.environ,
                {"STEAM_KEY": " \t  ", harness.STEAM_KEY_ENV_FILE_ENV: str(env_file)},
                clear=True,
            ):
                with mock.patch(
                    "screeps_rl_simulator_harness.run_variants",
                    return_value=(run_artifact, [mock_variant]),
                ):
                    summary = harness.run_simulator(
                        ticks=1,
                        workers=1,
                        variants=["baseline"],
                        out_dir=out_dir,
                        run_id="whitespace-env-file-load",
                        code_path=code_path,
                        map_source_file=map_path,
                    )
                    output_text = (out_dir / "whitespace-env-file-load" / "run_summary.json").read_text(
                        encoding="utf-8"
                    )
                    self.assertEqual(os.environ.get("STEAM_KEY"), file_secret)

        self.assertEqual(summary["runId"], "whitespace-env-file-load")
        self.assertNotIn(file_secret, output_text)

    def test_run_simulator_does_not_overwrite_existing_steam_key_from_env_file(self) -> None:
        env_secret = "harness-env-secret-token-123456"
        file_secret = "harness-file-secret-token-123456"

        with tempfile.TemporaryDirectory() as temp_dir:
            env_file = Path(temp_dir) / "local.env"
            env_file.write_text(f"STEAM_KEY={file_secret}\n", encoding="utf-8")

            with mock.patch.dict(
                os.environ,
                {"STEAM_KEY": env_secret, harness.STEAM_KEY_ENV_FILE_ENV: str(env_file)},
                clear=True,
            ):
                harness.ensure_steam_key_for_simulator_run()
                self.assertEqual(os.environ.get("STEAM_KEY"), env_secret)

    def test_run_simulator_missing_steam_key_fails_closed_without_secret_leak(self) -> None:
        unrelated_secret = "unrelated-secret-token-123456"

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            env_file = root / "local.env"
            out_dir = root / "runtime-artifacts"
            env_file.write_text(f"OTHER_SECRET={unrelated_secret}\n", encoding="utf-8")

            with mock.patch.dict(os.environ, {harness.STEAM_KEY_ENV_FILE_ENV: str(env_file)}, clear=True):
                with mock.patch("screeps_rl_simulator_harness.run_variants") as run_variants:
                    with self.assertRaisesRegex(RuntimeError, "STEAM_KEY environment variable is required"):
                        harness.run_simulator(
                            ticks=1,
                            workers=1,
                            variants=["baseline"],
                            out_dir=out_dir,
                            run_id="missing-steam-key",
                            code_path=root / "main.js",
                            map_source_file=root / "map.json",
                        )
                    failure_text = (out_dir / "missing-steam-key" / "setup_failure.json").read_text(encoding="utf-8")

        run_variants.assert_not_called()
        self.assertIn("STEAM_KEY environment variable is required", failure_text)
        self.assertNotIn(unrelated_secret, failure_text)

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

    def test_resource_guard_rejects_workers_5_on_8gb_host_and_writes_deterministic_failure(self) -> None:
        snapshot = {
            "memoryTotalMiB": 8192,
            "memoryAvailableMiB": 8192,
            "swapFreeMiB": 0,
            "memoryAndSwapAvailableMiB": 8192,
            "cpuCount": 4,
            "dockerAvailable": True,
            "activeDockerContainerCount": 0,
            "activeRlSimulatorContainerCount": 0,
            "activePrivateSmokeContainerCount": 0,
            "activeSimulatorContainerCount": 0,
            "activeRlSimulatorContainers": [],
            "activePrivateSmokeContainers": [],
        }
        cleanup = {
            "ok": True,
            "runId": "guard-reject",
            "targetNamePrefix": "rl-sim-worker-guard-reject-",
            "matchedContainers": [],
            "removedContainers": [],
            "command": None,
            "returncode": None,
            "outputExcerpt": None,
            "errors": [],
        }
        variants = [f"scale-env-{index}" for index in range(5)]

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            out_dir = root / "runtime-artifacts"
            failure_path = out_dir / "guard-reject" / "resource_guard_failure.json"
            failure_texts: list[str] = []
            summary_text = ""
            with mock.patch("screeps_rl_simulator_harness.collect_resource_guard_host_snapshot", return_value=snapshot):
                with mock.patch("screeps_rl_simulator_harness.cleanup_exact_run_worker_containers", return_value=cleanup):
                    with mock.patch("screeps_rl_simulator_harness.run_variants") as run_variants:
                        for _ in range(2):
                            with self.assertRaisesRegex(RuntimeError, "resource guard rejected"):
                                harness.run_simulator(
                                    ticks=1,
                                    workers=5,
                                    variants=variants,
                                    out_dir=out_dir,
                                    run_id="guard-reject",
                                    code_path=root / "main.js",
                                    map_source_file=root / "map.json",
                                )
                            failure_texts.append(failure_path.read_text(encoding="utf-8"))
                            summary_text = (out_dir / "guard-reject" / "run_summary.json").read_text(encoding="utf-8")
                            self.assertFalse((out_dir / "guard-reject" / "run_failure.json").exists())
                            self.assertFalse((out_dir / "guard-reject" / "setup_failure.json").exists())

        run_variants.assert_not_called()
        self.assertEqual(failure_texts[0], failure_texts[1])
        failure = json.loads(failure_texts[0])
        summary = json.loads(summary_text)
        self.assertEqual(failure["type"], harness.RUN_RESOURCE_GUARD_FAILURE_TYPE)
        self.assertFalse(failure["ok"])
        self.assertEqual(summary["failurePhase"], "resource-guard")
        self.assertEqual(summary["failureArtifactPath"], str(failure_path))
        self.assertEqual(failure["resourceGuard"]["decision"], "rejected")
        self.assertEqual(failure["resourceGuard"]["requestedWorkers"], 5)
        self.assertEqual(failure["resourceGuard"]["effectiveWorkers"], 5)
        self.assertEqual(failure["resourceGuard"]["guardedWorkerEstimate"], 5)
        self.assertIn("requires", failure["resourceGuard"]["reasons"][0])
        self.assertEqual(failure["cleanup"]["matchedContainers"], [])
        two_variant_decision = harness.build_resource_guard_decision(
            run_id="guard-reject-two-variants",
            workers=5,
            variants=variants[:2],
            host_snapshot=snapshot,
        )
        self.assertFalse(two_variant_decision["ok"])
        self.assertEqual(two_variant_decision["effectiveWorkers"], 2)
        self.assertEqual(two_variant_decision["guardedWorkerEstimate"], 5)

    def test_resource_guard_scale_plan_reports_cleanup_and_memory_gap_for_five_environments(self) -> None:
        snapshot = {
            "memoryTotalMiB": 8192,
            "memoryAvailableMiB": 6822,
            "swapFreeMiB": 0,
            "memoryAndSwapAvailableMiB": 6822,
            "cpuCount": 4,
            "dockerAvailable": True,
            "activeDockerContainerCount": 3,
            "activeRlSimulatorContainerCount": 0,
            "activePrivateSmokeContainerCount": 3,
            "activeSimulatorContainerCount": 3,
            "activeRlSimulatorContainers": [],
            "activePrivateSmokeContainers": [
                "screeps-private-smoke-a-screeps-1",
                "screeps-private-smoke-b-mongo-1",
                "screeps-private-smoke-c-redis-1",
            ],
        }
        variants = harness.expand_scale_environment_variants(
            [
                "construction-priority.incumbent.v1",
                "construction-priority.container-prioritized-shadow.v1",
            ],
            5,
        )

        decision = harness.build_resource_guard_decision(
            run_id="scale-plan",
            workers=5,
            variants=variants,
            host_snapshot=snapshot,
            min_concurrent_environments=5,
        )

        self.assertFalse(decision["ok"])
        plan = decision["scaleValidation"]
        self.assertEqual(plan["minConcurrentEnvironments"], 5)
        self.assertTrue(plan["targetConcurrencyMet"])
        self.assertEqual(plan["successCriteria"]["minimumSuccessfulEnvironments"], 4)
        self.assertEqual(plan["memory"]["requiredNowMiB"], 17236)
        self.assertEqual(plan["memory"]["requiredAfterCleanupMiB"], 13036)
        self.assertEqual(plan["memory"]["additionalAfterCleanupMiB"], 6214)
        self.assertEqual(plan["memory"]["estimatedCleanupReliefMiB"], 4200)
        self.assertEqual(plan["capacity"]["afterCleanupMaxWorkers"], 2)
        self.assertIn("stop 3 active rl-sim/private-smoke Docker container", plan["recommendations"][0])
        self.assertIn("prepare at least 13036 MiB", plan["recommendations"][1])

    def test_resource_guard_rejects_when_effective_environment_count_misses_scale_target(self) -> None:
        snapshot = {
            "memoryTotalMiB": 32768,
            "memoryAvailableMiB": 32768,
            "swapFreeMiB": 0,
            "memoryAndSwapAvailableMiB": 32768,
            "cpuCount": 16,
            "dockerAvailable": True,
            "activeDockerContainerCount": 0,
            "activeRlSimulatorContainerCount": 0,
            "activePrivateSmokeContainerCount": 0,
            "activeSimulatorContainerCount": 0,
            "activeRlSimulatorContainers": [],
            "activePrivateSmokeContainers": [],
        }

        decision = harness.build_resource_guard_decision(
            run_id="scale-target-miss",
            workers=5,
            variants=[
                "construction-priority.incumbent.v1",
                "construction-priority.container-prioritized-shadow.v1",
            ],
            host_snapshot=snapshot,
            min_concurrent_environments=5,
        )

        self.assertFalse(decision["ok"])
        self.assertEqual(decision["effectiveWorkers"], 2)
        self.assertFalse(decision["scaleValidation"]["targetConcurrencyMet"])
        self.assertIn("minConcurrentEnvironments=5", decision["reasons"][0])
        self.assertIn("--scale-environments 5", decision["scaleValidation"]["recommendations"][0])

    def test_run_failure_artifacts_use_phase_specific_paths_and_types(self) -> None:
        cleanup = {
            "ok": True,
            "runId": "non-guard-failure",
            "targetNamePrefix": "rl-sim-worker-non-guard-failure-",
            "matchedContainers": [],
            "removedContainers": [],
            "command": None,
            "returncode": None,
            "outputExcerpt": None,
            "errors": [],
        }
        resource_guard = {
            "type": "screeps-rl-simulator-resource-guard",
            "schemaVersion": harness.SCHEMA_VERSION,
            "ok": True,
            "decision": "allowed",
            "reasons": [],
            "warnings": [],
        }

        cases = [
            ("required-env", "setup-failure", "setup_failure.json", harness.RUN_SETUP_FAILURE_TYPE),
            ("run-variants", "runtime-failure", "run_failure.json", harness.RUN_FAILURE_TYPE),
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            out_dir = root / "runtime-artifacts"
            for phase, run_id, filename, failure_type in cases:
                artifact = harness.write_run_failure_artifacts(
                    run_id=run_id,
                    out_dir=out_dir,
                    ticks=1,
                    workers=1,
                    variants=["baseline"],
                    branch="activeWorld",
                    room="E1S1",
                    shard="shardX",
                    code_path=root / "main.js",
                    map_source_file=root / "map.json",
                    bot_commit=harness.DEFAULT_BOT_COMMIT,
                    phase=phase,
                    error=f"{phase} failed",
                    resource_guard=resource_guard,
                    cleanup=cleanup,
                )
                failure_path = out_dir / run_id / filename
                failure = read_json(failure_path)
                summary = read_json(out_dir / run_id / "run_summary.json")

                self.assertEqual(failure["type"], failure_type)
                self.assertEqual(failure["phase"], phase)
                self.assertEqual(artifact["failureArtifactPath"], str(failure_path))
                self.assertEqual(summary["failureArtifactPath"], str(failure_path))
                self.assertFalse((out_dir / run_id / "resource_guard_failure.json").exists())

    def test_resource_guard_override_allows_unsafe_scale_with_env(self) -> None:
        snapshot = {
            "memoryTotalMiB": 8192,
            "memoryAvailableMiB": 8192,
            "swapFreeMiB": 0,
            "memoryAndSwapAvailableMiB": 8192,
            "cpuCount": 4,
            "dockerAvailable": True,
            "activeDockerContainerCount": 0,
            "activeRlSimulatorContainerCount": 0,
            "activePrivateSmokeContainerCount": 0,
            "activeSimulatorContainerCount": 0,
            "activeRlSimulatorContainers": [],
            "activePrivateSmokeContainers": [],
        }

        with mock.patch.dict(os.environ, {harness.RUN_RESOURCE_GUARD_ALLOW_UNSAFE_ENV: "1"}):
            decision = harness.build_resource_guard_decision(
                run_id="guard-override",
                workers=5,
                variants=[f"scale-env-{index}" for index in range(5)],
                host_snapshot=snapshot,
            )

        self.assertTrue(decision["ok"])
        self.assertEqual(decision["decision"], "allowed-with-override")
        self.assertTrue(decision["override"]["enabled"])
        self.assertIn(f"env:{harness.RUN_RESOURCE_GUARD_ALLOW_UNSAFE_ENV}", decision["override"]["sources"])

    def test_exact_run_cleanup_targets_only_matching_worker_containers(self) -> None:
        commands: list[list[str]] = []

        class Result:
            returncode = 0
            stdout = "removed\n"
            stderr = ""

        def fake_runner(command: list[str], **kwargs: object) -> Result:
            _ = kwargs
            commands.append(command)
            return Result()

        cleanup = harness.cleanup_exact_run_worker_containers(
            "run-1",
            container_names=[
                "rl-sim-worker-run-1-00-screeps-1",
                "/rl-sim-worker-run-1-01-mongo-1",
                "rl-sim-worker-run-10-00-screeps-1",
                "rl-sim-worker-run-1-extra-00-screeps-1",
                "rl-sim-worker-run-2-00-screeps-1",
                "screeps-private-smoke-abcdef12-screeps-1",
            ],
            docker_binary="/usr/bin/docker",
            runner=fake_runner,
        )

        self.assertTrue(cleanup["ok"])
        self.assertEqual(
            cleanup["matchedContainers"],
            [
                "rl-sim-worker-run-1-00-screeps-1",
                "rl-sim-worker-run-1-01-mongo-1",
            ],
        )
        self.assertEqual(
            commands,
            [
                [
                    "/usr/bin/docker",
                    "rm",
                    "-f",
                    "rl-sim-worker-run-1-00-screeps-1",
                    "rl-sim-worker-run-1-01-mongo-1",
                ]
            ],
        )

    def test_exact_run_cleanup_can_target_one_worker_index(self) -> None:
        commands: list[list[str]] = []

        class Result:
            returncode = 0
            stdout = "removed\n"
            stderr = ""

        def fake_runner(command: list[str], **kwargs: object) -> Result:
            _ = kwargs
            commands.append(command)
            return Result()

        cleanup = harness.cleanup_exact_run_worker_containers(
            "run-1",
            worker_index=1,
            container_names=[
                "rl-sim-worker-run-1-00-screeps-1",
                "/rl-sim-worker-run-1-01-mongo-1",
                "rl-sim-worker-run-1-01-redis-1",
                "rl-sim-worker-run-10-01-screeps-1",
            ],
            docker_binary="/usr/bin/docker",
            runner=fake_runner,
        )

        self.assertTrue(cleanup["ok"])
        self.assertEqual(cleanup["workerIndex"], 1)
        self.assertEqual(cleanup["targetNamePrefix"], "rl-sim-worker-run-1-01-")
        self.assertEqual(
            cleanup["matchedContainers"],
            [
                "rl-sim-worker-run-1-01-mongo-1",
                "rl-sim-worker-run-1-01-redis-1",
            ],
        )
        self.assertEqual(
            commands,
            [
                [
                    "/usr/bin/docker",
                    "rm",
                    "-f",
                    "rl-sim-worker-run-1-01-mongo-1",
                    "rl-sim-worker-run-1-01-redis-1",
                ]
            ],
        )

    def test_exact_run_cleanup_preserves_trailing_underscore_before_worker_suffix(self) -> None:
        commands: list[list[str]] = []

        class Result:
            returncode = 0
            stdout = "removed\n"
            stderr = ""

        def fake_runner(command: list[str], **kwargs: object) -> Result:
            _ = kwargs
            commands.append(command)
            return Result()

        cleanup = harness.cleanup_exact_run_worker_containers(
            "trial_",
            container_names=[
                "rl-sim-worker-trial_-00-screeps-1",
                "/rl-sim-worker-trial_-01-mongo-1",
                "rl-sim-worker-trial-00-screeps-1",
                "rl-sim-worker-trial_-extra-00-screeps-1",
            ],
            docker_binary="/usr/bin/docker",
            runner=fake_runner,
        )

        self.assertTrue(cleanup["ok"])
        self.assertEqual(cleanup["targetNamePrefix"], "rl-sim-worker-trial_-")
        self.assertEqual(
            cleanup["matchedContainers"],
            [
                "rl-sim-worker-trial_-00-screeps-1",
                "rl-sim-worker-trial_-01-mongo-1",
            ],
        )
        self.assertEqual(
            commands,
            [
                [
                    "/usr/bin/docker",
                    "rm",
                    "-f",
                    "rl-sim-worker-trial_-00-screeps-1",
                    "rl-sim-worker-trial_-01-mongo-1",
                ]
            ],
        )

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

    def test_run_command_parses_host_port_start(self) -> None:
        captured_kwargs: dict[str, object] = {}

        def fake_run_simulator(**kwargs: object) -> dict[str, object]:
            captured_kwargs.update(kwargs)
            return {
                "type": harness.RUN_SUMMARY_TYPE,
                "runId": "host-port-start",
                "variants": [{"variant_id": "baseline", "ok": True}],
            }

        output = io.StringIO()

        with mock.patch("screeps_rl_simulator_harness.discover_strategy_variants", return_value=["baseline"]):
            with mock.patch("screeps_rl_simulator_harness.run_simulator", side_effect=fake_run_simulator):
                exit_code = harness.main(
                    ["run", "--variants", "baseline", "--host-port-start", "23125"],
                    stdout=output,
                )

        self.assertEqual(exit_code, 0)
        self.assertEqual(captured_kwargs["host_port_start"], 23125)

    def test_run_command_uses_host_port_start_env_fallback(self) -> None:
        captured_kwargs: dict[str, object] = {}

        def fake_run_simulator(**kwargs: object) -> dict[str, object]:
            captured_kwargs.update(kwargs)
            return {
                "type": harness.RUN_SUMMARY_TYPE,
                "runId": "host-port-start-env",
                "variants": [{"variant_id": "baseline", "ok": True}],
            }

        output = io.StringIO()

        with mock.patch.dict(os.environ, {harness.RUN_HOST_PORT_START_ENV: "23125"}):
            with mock.patch("screeps_rl_simulator_harness.discover_strategy_variants", return_value=["baseline"]):
                with mock.patch("screeps_rl_simulator_harness.run_simulator", side_effect=fake_run_simulator):
                    exit_code = harness.main(["run", "--variants", "baseline"], stdout=output)

        self.assertEqual(exit_code, 0)
        self.assertEqual(captured_kwargs["host_port_start"], 23125)

    def test_run_command_passes_allow_unsafe_scale_flag(self) -> None:
        captured_kwargs: dict[str, object] = {}

        def fake_run_simulator(**kwargs: object) -> dict[str, object]:
            captured_kwargs.update(kwargs)
            return {
                "type": harness.RUN_SUMMARY_TYPE,
                "runId": "allow-unsafe-scale",
                "variants": [{"variant_id": "baseline", "ok": True}],
            }

        output = io.StringIO()

        with mock.patch("screeps_rl_simulator_harness.discover_strategy_variants", return_value=["baseline"]):
            with mock.patch("screeps_rl_simulator_harness.run_simulator", side_effect=fake_run_simulator):
                exit_code = harness.main(
                    ["run", "--variants", "baseline", "--allow-unsafe-scale"],
                    stdout=output,
                )

        self.assertEqual(exit_code, 0)
        self.assertIs(captured_kwargs["allow_unsafe_scale"], True)

    def test_run_command_expands_scale_environments_and_enforces_minimum(self) -> None:
        captured_kwargs: dict[str, object] = {}

        def fake_run_simulator(**kwargs: object) -> dict[str, object]:
            captured_kwargs.update(kwargs)
            return {
                "type": harness.RUN_SUMMARY_TYPE,
                "runId": "scale-env-run",
                "variants": [{"variant_id": "baseline.scale-env-01", "ok": True}],
            }

        output = io.StringIO()

        with mock.patch("screeps_rl_simulator_harness.discover_strategy_variants", return_value=["baseline"]):
            with mock.patch("screeps_rl_simulator_harness.run_simulator", side_effect=fake_run_simulator):
                exit_code = harness.main(
                    ["run", "--variants", "baseline", "--workers", "5", "--scale-environments", "5"],
                    stdout=output,
                )

        self.assertEqual(exit_code, 0)
        self.assertEqual(captured_kwargs["workers"], 5)
        self.assertEqual(captured_kwargs["min_concurrent_environments"], 5)
        self.assertEqual(len(captured_kwargs["variants"]), 5)
        self.assertEqual(captured_kwargs["variants"][0], "baseline.scale-env-01")

    def test_plan_scale_command_writes_preflight_artifact_and_returns_nonzero_when_rejected(self) -> None:
        snapshot = {
            "memoryTotalMiB": 8192,
            "memoryAvailableMiB": 6822,
            "swapFreeMiB": 0,
            "memoryAndSwapAvailableMiB": 6822,
            "cpuCount": 4,
            "dockerAvailable": True,
            "activeDockerContainerCount": 3,
            "activeRlSimulatorContainerCount": 0,
            "activePrivateSmokeContainerCount": 3,
            "activeSimulatorContainerCount": 3,
            "activeRlSimulatorContainers": [],
            "activePrivateSmokeContainers": ["screeps-private-smoke-a-screeps-1"],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            output = io.StringIO()
            out_dir = Path(temp_dir) / "runtime-artifacts"
            with mock.patch("screeps_rl_simulator_harness.discover_strategy_variants", return_value=["baseline"]):
                with mock.patch(
                    "screeps_rl_simulator_harness.collect_resource_guard_host_snapshot",
                    return_value=snapshot,
                ):
                    exit_code = harness.main(
                        ["plan-scale", "--run-id", "scale-plan", "--out-dir", str(out_dir)],
                        stdout=output,
                    )
            artifact = read_json(out_dir / "scale-plan" / "scale_validation_plan.json")
            stdout_report = json.loads(output.getvalue())

        self.assertEqual(exit_code, 1)
        self.assertFalse(artifact["ok"])
        self.assertEqual(artifact["variantCount"], 5)
        self.assertEqual(artifact["resourceGuard"]["effectiveWorkers"], 5)
        self.assertEqual(artifact["scaleValidation"]["successCriteria"]["minimumSuccessfulEnvironments"], 4)
        self.assertEqual(stdout_report["planArtifactPath"], str(out_dir / "scale-plan" / "scale_validation_plan.json"))

    def test_plan_scale_command_returns_nonzero_when_override_allows_unsafe_scale(self) -> None:
        snapshot = {
            "memoryTotalMiB": 8192,
            "memoryAvailableMiB": 6822,
            "swapFreeMiB": 0,
            "memoryAndSwapAvailableMiB": 6822,
            "cpuCount": 4,
            "dockerAvailable": True,
            "activeDockerContainerCount": 3,
            "activeRlSimulatorContainerCount": 0,
            "activePrivateSmokeContainerCount": 3,
            "activeSimulatorContainerCount": 3,
            "activeRlSimulatorContainers": [],
            "activePrivateSmokeContainers": ["screeps-private-smoke-a-screeps-1"],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            output = io.StringIO()
            out_dir = Path(temp_dir) / "runtime-artifacts"
            with mock.patch("screeps_rl_simulator_harness.discover_strategy_variants", return_value=["baseline"]):
                with mock.patch(
                    "screeps_rl_simulator_harness.collect_resource_guard_host_snapshot",
                    return_value=snapshot,
                ):
                    exit_code = harness.main(
                        [
                            "plan-scale",
                            "--run-id",
                            "scale-plan-override",
                            "--out-dir",
                            str(out_dir),
                            "--allow-unsafe-scale",
                        ],
                        stdout=output,
                    )
            artifact = read_json(out_dir / "scale-plan-override" / "scale_validation_plan.json")
            stdout_report = json.loads(output.getvalue())

        self.assertEqual(exit_code, 1)
        self.assertTrue(artifact["ok"])
        self.assertEqual(artifact["decision"], "allowed-with-override")
        self.assertEqual(artifact["resourceGuard"]["decision"], "allowed-with-override")
        self.assertIn("cli:--allow-unsafe-scale", artifact["resourceGuard"]["override"]["sources"])
        self.assertEqual(stdout_report["decision"], "allowed-with-override")


if __name__ == "__main__":
    unittest.main()
