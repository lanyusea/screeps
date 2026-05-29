#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from collections import UserDict
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_simulator_harness as harness

NODE_BIN = shutil.which("node")


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
        self.assertEqual(harness.normalize_private_server_code_branch("$activeWorld"), "default")
        self.assertEqual(harness.normalize_private_server_code_branch("activeWorld"), "default")
        self.assertEqual(harness.normalize_private_server_code_branch("$activeSim"), "default")
        self.assertEqual(harness.normalize_private_server_code_branch("activeSim"), "default")
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
                state = self._state(str(cfg.server_url))
                state["uploaded_branch"] = cfg.branch
                state["uploaded_code_text"] = code
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
                _ = args
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
                    if method == "GET":
                        return Result(
                            200,
                            {
                                "ok": 1,
                                "branch": state.get("uploaded_branch"),
                                "modules": {"main": state.get("uploaded_code_text")},
                            },
                        )
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

    def test_build_tick_entry_extracts_runtime_consumption_from_object_memory(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)

        tick_entry = harness._build_tick_entry(
            "shardX",
            "E1S1",
            42,
            {"ok": 1, "rooms": ["E1S1"], "gametime": 42},
            {"terrain": [{"room": "E1S1", "terrain": "0" * 2500}]},
            {
                "E1S1": {
                    "room": "E1S1",
                    "roomData": {
                        "user": {"id": "user-1", "username": "rl-sim"},
                        "controller": {"level": 1, "my": True},
                        "objects": [
                            {
                                "type": "creep",
                                "user": "user-1",
                                "memory": {
                                    "role": "worker",
                                    "rlRuntimePolicyParameters": evidence,
                                },
                            }
                        ],
                    },
                }
            },
        )

        room_summary = tick_entry["rooms"]["E1S1"]
        self.assertEqual(
            room_summary["runtimeParameterConsumption"]["consumedParametersSha256"],
            injection["parametersSha256"],
        )
        direct_evidence = harness.direct_game_loop_runtime_parameter_consumption_evidence(
            injection,
            [tick_entry],
        )
        self.assertIsNotNone(direct_evidence)
        assert direct_evidence is not None
        consumption = harness.runtime_parameter_consumption_check(injection, direct_evidence)
        self.assertEqual(consumption["status"], "consumed")
        self.assertTrue(consumption["runtimeParameterConsumption"])
        self.assertEqual(
            consumption["source"],
            harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE,
        )

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

    def test_multi_tier_policy_activation_records_intent_without_mutating_tick_metrics(self) -> None:
        fixture_summaries = {
            "E1S1": {
                "room": "E1S1",
                "owned": True,
                "controller": {"level": 1, "my": True, "owner": "rl-sim"},
                "combat": {"hostileCreeps": 0, "hostileStructures": 0, "ownCreeps": 1, "ownStructures": 1},
            },
            "E2S1": {
                "room": "E2S1",
                "owned": False,
                "controller": {"level": 0, "my": False},
                "combat": {"hostileCreeps": 2, "hostileStructures": 1, "ownCreeps": 0, "ownStructures": 0},
            },
        }
        initial_tick = {"tick": 1, "rooms": copy.deepcopy(fixture_summaries)}
        final_tick = copy.deepcopy(initial_tick)
        final_tick["tick"] = 2
        final_tick["rooms"]["E2S1"]["combat"]["hostileCreeps"] = 1
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

        before_activation = copy.deepcopy(tick_log)
        activation = harness.build_multi_tier_policy_activation_evidence(
            tick_log,
            strategy_variant,
            fixture_summaries,
            anchor_room="E1S1",
        )
        metrics = harness.build_variant_metrics(tick_log)

        self.assertIsNotNone(activation)
        assert activation is not None
        self.assertEqual(activation["policyAction"], "claim-adjacent-controller")
        self.assertEqual(activation["executionAction"], "engage-hostiles")
        self.assertEqual(activation["targetRoom"], "E2S1")
        self.assertTrue(activation["objectiveSignalObserved"])
        self.assertEqual(activation["objectiveSignalSource"], "tick_log")
        self.assertTrue(activation["observedEvidence"]["hostileCountReduced"])
        self.assertEqual(tick_log, before_activation)
        self.assertEqual(tick_log[-1]["rooms"]["E2S1"]["combat"]["hostileCreeps"], 1)
        self.assertEqual(metrics["combat"]["hostileKills"], 1)
        self.assertNotIn("rlPolicyActivation", tick_log[-1])
        self.assertEqual(activation["safety"]["liveEffect"], False)
        self.assertEqual(activation["safety"]["officialMmoWrites"], False)

    def test_multi_tier_policy_activation_records_structure_only_blocker(self) -> None:
        fixture_summaries = {
            "E1S1": {
                "room": "E1S1",
                "owned": True,
                "controller": {"level": 1, "my": True, "owner": "rl-sim"},
                "combat": {"hostileCreeps": 0, "hostileStructures": 0, "ownCreeps": 1, "ownStructures": 1},
            },
            "E2S1": {
                "room": "E2S1",
                "owned": False,
                "controller": {"level": 0, "my": False},
                "combat": {"hostileCreeps": 0, "hostileStructures": 1, "ownCreeps": 0, "ownStructures": 0},
            },
        }
        tick_log = [{"tick": 1, "rooms": copy.deepcopy(fixture_summaries)}]
        tick_log.append(copy.deepcopy(tick_log[0]))
        tick_log[-1]["tick"] = 2
        tick_log[-1]["rooms"]["E2S1"]["combat"]["hostileStructures"] = 0
        strategy_variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }

        before_activation = copy.deepcopy(tick_log)
        activation = harness.build_multi_tier_policy_activation_evidence(
            tick_log,
            strategy_variant,
            fixture_summaries,
            anchor_room="E1S1",
        )
        metrics = harness.build_variant_metrics(tick_log)

        self.assertIsNotNone(activation)
        assert activation is not None
        self.assertEqual(activation["executionAction"], "engage-hostiles")
        self.assertEqual(activation["targetRoom"], "E2S1")
        self.assertTrue(activation["observedEvidence"]["hostileCountReduced"])
        self.assertEqual(tick_log, before_activation)
        self.assertEqual(metrics["combat"]["hostileKills"], 1)

    def test_multi_tier_policy_activation_records_peaceful_adjacent_claim(self) -> None:
        fixture_summaries = {
            "E1S1": {
                "room": "E1S1",
                "owned": True,
                "controller": {"level": 1, "my": True, "owner": "rl-sim"},
                "combat": {"hostileCreeps": 0, "hostileStructures": 0, "ownCreeps": 1, "ownStructures": 1},
            },
            "E2S1": {
                "room": "E2S1",
                "owned": False,
                "controller": {"level": 0, "my": False},
                "combat": {"hostileCreeps": 0, "hostileStructures": 0, "ownCreeps": 0, "ownStructures": 0},
            },
        }
        tick_log = [{"tick": 1, "rooms": copy.deepcopy(fixture_summaries)}]
        tick_log.append(copy.deepcopy(tick_log[0]))
        tick_log[-1]["tick"] = 2
        tick_log[-1]["rooms"]["E2S1"]["owned"] = True
        tick_log[-1]["rooms"]["E2S1"]["controller"] = {"level": 1, "my": True, "owner": "rl-sim"}
        strategy_variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }

        before_activation = copy.deepcopy(tick_log)
        activation = harness.build_multi_tier_policy_activation_evidence(
            tick_log,
            strategy_variant,
            fixture_summaries,
            anchor_room="E1S1",
        )

        self.assertIsNotNone(activation)
        assert activation is not None
        self.assertEqual(activation["executionAction"], "claim-controller")
        self.assertEqual(activation["reason"], "visible_adjacent_controller")
        self.assertFalse(activation["objective"]["objectiveSignalPresent"])
        self.assertTrue(activation["observedEvidence"]["controllerClaimed"])
        self.assertFalse(activation["observedEvidence"]["fixtureGeneratedRoomState"])
        self.assertEqual(tick_log, before_activation)

    def test_multi_tier_policy_activation_requires_adjacent_target(self) -> None:
        fixture_summaries = {
            "E1S1": {
                "room": "E1S1",
                "owned": True,
                "controller": {"level": 1, "my": True, "owner": "rl-sim"},
                "combat": {"hostileCreeps": 0, "hostileStructures": 0, "ownCreeps": 1, "ownStructures": 1},
            },
            "E2S1": {
                "room": "E2S1",
                "owned": False,
                "controller": {"level": 0, "my": False},
                "combat": {"hostileCreeps": 1, "hostileStructures": 0, "ownCreeps": 0, "ownStructures": 0},
            },
            "E5S1": {
                "room": "E5S1",
                "owned": False,
                "controller": {"level": 0, "my": False},
                "combat": {"hostileCreeps": 9, "hostileStructures": 0, "ownCreeps": 0, "ownStructures": 0},
            },
        }
        tick_log = [{"tick": 1, "rooms": copy.deepcopy(fixture_summaries)}]
        tick_log.append(copy.deepcopy(tick_log[0]))
        tick_log[-1]["tick"] = 2
        tick_log[-1]["rooms"]["E2S1"]["combat"]["hostileCreeps"] = 0
        strategy_variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }

        activation = harness.build_multi_tier_policy_activation_evidence(
            tick_log,
            strategy_variant,
            fixture_summaries,
            anchor_room="E1S1",
        )
        far_only = {room: copy.deepcopy(summary) for room, summary in fixture_summaries.items() if room != "E2S1"}

        self.assertIsNotNone(activation)
        assert activation is not None
        self.assertEqual(activation["targetRoom"], "E2S1")
        self.assertIsNone(
            harness.build_multi_tier_policy_activation_evidence(
                tick_log,
                strategy_variant,
                far_only,
                anchor_room="E1S1",
            )
        )

    def test_multi_tier_policy_activation_rejects_fixture_generated_or_failed_runs(self) -> None:
        fixture_path = Path("scripts/fixtures/rl/multi-tier-territory-combat-v0.map.json")
        fixture_summaries = harness._private_map_fixture_room_summaries(fixture_path)
        tick_log = [
            {"tick": 1, "rooms": {"E1S1": {"owned": True, "controller": {"level": 1, "my": True}}}},
            {"tick": 2, "rooms": {"E1S1": {"owned": True, "controller": {"level": 1, "my": True}}}},
        ]
        for tick_entry in tick_log:
            harness._merge_fixture_room_summaries_into_tick(tick_entry, fixture_summaries)
        strategy_variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }

        self.assertIsNone(
            harness.build_multi_tier_policy_activation_evidence(
                tick_log,
                strategy_variant,
                fixture_summaries,
                anchor_room="E1S1",
            )
        )
        observed_tick_log = [{"tick": 1, "rooms": copy.deepcopy(fixture_summaries)}]
        observed_tick_log.append(copy.deepcopy(observed_tick_log[0]))
        observed_tick_log[-1]["tick"] = 2
        observed_tick_log[-1]["rooms"]["E2S1"]["combat"]["hostileCreeps"] = 1
        self.assertIsNone(
            harness.build_multi_tier_policy_activation_evidence(
                observed_tick_log,
                strategy_variant,
                fixture_summaries,
                anchor_room="E1S1",
                run_errors=["cleanup failed"],
            )
        )
        static_tick_log = [{"tick": 1, "rooms": copy.deepcopy(fixture_summaries)}]
        static_tick_log.append(copy.deepcopy(static_tick_log[0]))
        static_tick_log[-1]["tick"] = 2
        self.assertIsNone(
            harness.build_multi_tier_policy_activation_evidence(
                static_tick_log,
                strategy_variant,
                fixture_summaries,
                anchor_room="E1S1",
            )
        )

    def test_multi_tier_policy_activation_uses_later_real_target_snapshots_after_fixture_fallback(self) -> None:
        fixture_path = Path("scripts/fixtures/rl/multi-tier-territory-combat-v0.map.json")
        fixture_summaries = harness._private_map_fixture_room_summaries(fixture_path)
        fallback_tick = {
            "tick": 1,
            "rooms": {"E1S1": {"owned": True, "controller": {"level": 1, "my": True}}},
        }
        harness._merge_fixture_room_summaries_into_tick(fallback_tick, fixture_summaries)
        real_initial_tick = {"tick": 2, "rooms": copy.deepcopy(fixture_summaries)}
        real_final_tick = copy.deepcopy(real_initial_tick)
        real_final_tick["tick"] = 3
        real_final_tick["rooms"]["E2S1"]["combat"]["hostileCreeps"] = 1
        tick_log = [fallback_tick, real_initial_tick, real_final_tick]
        strategy_variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }

        activation = harness.build_multi_tier_policy_activation_evidence(
            tick_log,
            strategy_variant,
            fixture_summaries,
            anchor_room="E1S1",
        )

        self.assertIsNotNone(activation)
        assert activation is not None
        self.assertEqual(activation["targetRoom"], "E2S1")
        self.assertEqual(activation["observedEvidence"]["observedTickCount"], 2)
        self.assertEqual(activation["observedEvidence"]["initialTick"], 2)
        self.assertEqual(activation["observedEvidence"]["finalTick"], 3)
        self.assertTrue(activation["observedEvidence"]["hostileCountReduced"])
        self.assertFalse(activation["observedEvidence"]["fixtureGeneratedRoomState"])

    def test_multi_tier_policy_activation_projects_offline_hostile_engagement_metrics(self) -> None:
        fixture_path = Path("scripts/fixtures/rl/multi-tier-territory-combat-v0.map.json")
        fixture_summaries = harness._private_map_fixture_room_summaries(fixture_path)
        tick_log = [{"tick": 1, "rooms": {"E1S1": {"owned": True, "controller": {"level": 1, "my": True}}}}]
        tick_log.append(copy.deepcopy(tick_log[0]))
        tick_log[-1]["tick"] = 2
        for tick_entry in tick_log:
            harness._merge_fixture_room_summaries_into_tick(tick_entry, fixture_summaries)
        strategy_variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }

        before_tick_log = copy.deepcopy(tick_log)
        base_metrics = harness.build_variant_metrics(tick_log)
        activation = harness.build_multi_tier_policy_activation_evidence(
            tick_log,
            strategy_variant,
            fixture_summaries,
            anchor_room="E1S1",
            allow_offline_projection=True,
        )
        projected_metrics = harness.project_multi_tier_policy_activation_metrics(base_metrics, activation)

        self.assertIsNotNone(activation)
        assert activation is not None
        self.assertEqual(activation["executionAction"], "engage-hostiles")
        self.assertEqual(activation["objectiveSignalSource"], "offline_shadow_projection")
        self.assertEqual(activation["projectedEvidence"]["projectedHostileKills"], 1)
        self.assertEqual(projected_metrics["hostileKills"], 1)
        self.assertEqual(projected_metrics["combat"]["hostileKills"], 1)
        self.assertEqual(projected_metrics["combatDelta"], 1)
        self.assertEqual(projected_metrics["policyActivation"]["targetRoom"], "E2S1")
        self.assertEqual(projected_metrics["policyActivation"]["hostileKillsSource"], "projectedEvidence")
        self.assertEqual(tick_log, before_tick_log)
        self.assertEqual(base_metrics["hostileKills"], 0)
        self.assertFalse(activation["safety"]["liveEffect"])
        self.assertFalse(activation["safety"]["officialMmoWrites"])
        self.assertFalse(activation["safety"]["officialMmoWritesAllowed"])

    def test_runtime_parameter_injection_carries_multi_tier_objective_target(self) -> None:
        fixture_path = Path("scripts/fixtures/rl/multi-tier-territory-combat-v0.map.json")
        fixture_summaries = harness._private_map_fixture_room_summaries(fixture_path)
        injection = harness.runtime_parameter_injection_for_variant(
            "construction-priority.pg.territory-seed.v1",
            {
                "id": "construction-priority.pg.territory-seed.v1",
                "family": "construction-priority",
                "parameters": {
                    "baseScoreWeight": 1,
                    "territorySignalWeight": 22,
                    "resourceSignalWeight": 3,
                    "killSignalWeight": 5,
                    "riskPenalty": 4,
                },
            },
        )

        attached = harness.attach_runtime_parameter_objective_target(
            injection,
            fixture_summaries,
            anchor_room="E1S1",
        )

        self.assertEqual(attached["objectiveTargetRoom"], "E2S1")
        self.assertEqual(attached["objectiveAnchorRoom"], "E1S1")
        self.assertEqual(attached["objectiveHostileCreepCount"], 2)
        self.assertEqual(attached["objectiveHostileStructureCount"], 1)
        self.assertEqual(attached["objectiveSignalSource"], "multi_tier_map_fixture")
        self.assertEqual(attached["parametersSha256"], injection["parametersSha256"])
        self.assertFalse(attached["liveEffect"])
        self.assertFalse(attached["officialMmoWrites"])
        self.assertFalse(attached["officialMmoWritesAllowed"])

    def test_runtime_parameter_injection_uses_strategy_aware_multi_tier_target(self) -> None:
        fixture_path = Path("scripts/fixtures/rl/multi-tier-territory-combat-v1.map.json")
        fixture_summaries = harness._private_map_fixture_room_summaries(fixture_path)
        strategy_variant = {
            "id": "construction-priority.pg.risk-aware-seed.v1",
            "family": "construction-priority",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 18,
                "resourceSignalWeight": 5,
                "killSignalWeight": 6,
                "riskPenalty": 10,
            },
        }
        injection = harness.runtime_parameter_injection_for_variant(
            strategy_variant["id"],
            strategy_variant,
        )
        activation = harness.select_multi_tier_policy_activation(
            strategy_variant,
            fixture_summaries,
            anchor_room="E1S1",
        )

        attached = harness.attach_runtime_parameter_objective_target(
            injection,
            fixture_summaries,
            anchor_room="E1S1",
        )

        self.assertIsNotNone(activation)
        assert activation is not None
        self.assertEqual(activation["targetRoom"], "E1S2")
        self.assertEqual(activation["executionAction"], "claim-controller")
        self.assertEqual(attached["objectiveTargetRoom"], activation["targetRoom"])
        self.assertEqual(attached["objectiveAnchorRoom"], "E1S1")
        self.assertEqual(attached["objectiveHostileCreepCount"], 0)
        self.assertEqual(attached["objectiveHostileStructureCount"], 0)
        self.assertEqual(attached["objectiveSignalSource"], "multi_tier_map_fixture")

    def test_multi_tier_policy_activation_projection_preserves_explicit_zero_metrics(self) -> None:
        activation = {
            "type": "screeps-rl-multi-tier-policy-activation",
            "strategyVariantId": "candidate",
            "executionAction": "engage-hostiles",
            "objectiveSignalSource": "offline_shadow_projection",
            "targetRoom": "E2S1",
            "projectedEvidence": {
                "targetRoom": "E2S1",
                "projectedHostileKills": 1,
            },
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            },
        }
        metrics = {
            "hostileKills": 0,
            "ownLosses": 0,
            "combat": {
                "hostileKills": 4,
                "ownLosses": 3,
            },
        }

        projected = harness.project_multi_tier_policy_activation_metrics(metrics, activation)

        self.assertEqual(projected["hostileKills"], 1)
        self.assertEqual(projected["ownLosses"], 0)
        self.assertEqual(projected["combat"]["hostileKills"], 1)
        self.assertEqual(projected["combat"]["ownLosses"], 0)
        self.assertEqual(projected["combatDelta"], 1)

    def test_multi_tier_policy_activation_observed_reduction_overrides_explicit_zero_metrics(self) -> None:
        activation = {
            "type": "screeps-rl-multi-tier-policy-activation",
            "strategyVariantId": "candidate",
            "executionAction": "engage-hostiles",
            "objectiveSignalSource": "tick_log",
            "targetRoom": "E2S1",
            "observedEvidence": {
                "targetRoom": "E2S1",
                "initialHostileCount": 3,
                "finalHostileCount": 2,
                "hostileCountReduced": True,
            },
            "projectedEvidence": {
                "targetRoom": "E2S1",
                "initialHostileCount": 3,
                "finalHostileCount": 3,
                "projectedHostileKills": 0,
                "hostileCountReduced": False,
            },
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            },
        }
        metrics = {
            "hostileKills": 0,
            "ownLosses": 0,
            "combat": {
                "hostileKills": 0,
                "ownLosses": 0,
            },
            "finalRoomStates": {
                "E2S1": {
                    "combat": {
                        "hostileCreeps": 99,
                    },
                },
            },
        }

        projected = harness.project_multi_tier_policy_activation_metrics(metrics, activation)

        self.assertEqual(projected["hostileKills"], 1)
        self.assertEqual(projected["combat"]["hostileKills"], 1)
        self.assertEqual(projected["combatDelta"], 1)
        self.assertEqual(projected["policyActivation"]["observedHostileKills"], 1)
        self.assertEqual(projected["policyActivation"]["hostileKillsSource"], "observedEvidence")
        self.assertEqual(projected["finalRoomStates"]["E2S1"]["combat"]["hostileCreeps"], 2)

    def test_multi_tier_policy_activation_preserves_observed_territory_without_kills(self) -> None:
        activation = {
            "type": "screeps-rl-multi-tier-policy-activation",
            "strategyVariantId": "candidate",
            "executionAction": "claim-controller",
            "objectiveSignalSource": "tick_log",
            "targetRoom": "E2S1",
            "observedEvidence": {
                "targetRoom": "E2S1",
                "controllerClaimed": True,
                "ownPresenceIncreased": True,
            },
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            },
        }
        metrics = {
            "territoryDelta": 0,
            "territory": {
                "initialOwnedRoomCount": 1,
                "finalOwnedRoomCount": 1,
                "ownedRoomDelta": 0,
                "controllerLevelDelta": 0,
            },
            "hostileKills": 0,
            "ownLosses": 0,
            "combatDelta": 0,
            "finalRooms": {"ownedRoomCount": 1},
            "finalRoomStates": {
                "E1S1": {
                    "owned": True,
                    "controller": {"level": 1, "my": True},
                    "ownedCreeps": 2,
                    "ownStructures": 1,
                },
                "E2S1": {
                    "owned": False,
                    "controller": {"level": 0, "my": False},
                    "ownedCreeps": 0,
                    "ownStructures": 0,
                },
            },
        }

        projected = harness.project_multi_tier_policy_activation_metrics(metrics, activation)

        self.assertEqual(projected["territoryDelta"], 2)
        self.assertEqual(projected["territory"]["ownedRoomDelta"], 1)
        self.assertEqual(projected["territory"]["controllerLevelDelta"], 1)
        self.assertEqual(projected["territory"]["finalOwnedRoomCount"], 2)
        self.assertEqual(projected["policyActivation"]["territoryDeltaSource"], "observedEvidence")
        self.assertEqual(projected["policyActivation"]["observedTerritoryDelta"], 2)
        self.assertNotIn("projectedTerritoryDelta", projected["policyActivation"])
        final_target = projected["finalRoomStates"]["E2S1"]
        self.assertTrue(final_target["owned"])
        self.assertTrue(final_target["controller"]["my"])
        self.assertEqual(final_target["controller"]["level"], 1)
        self.assertEqual(final_target["ownedCreeps"], 0)
        self.assertEqual(final_target["ownStructures"], 0)
        self.assertEqual(projected["finalRooms"]["ownedRoomCount"], 2)
        self.assertEqual(projected["finalRooms"]["controllerLevelTotal"], 2)
        self.assertEqual(projected["finalRooms"]["ownCreeps"], 2)
        self.assertEqual(projected["finalRooms"]["ownStructures"], 1)

    def test_multi_tier_policy_activation_preserves_presence_without_claiming_room(self) -> None:
        tick_log = [
            {
                "tick": 1,
                "rooms": {
                    "E2S1": {
                        "owned": False,
                        "controller": {"level": 0, "my": False},
                        "ownedCreeps": 0,
                        "ownStructures": 0,
                    },
                },
            },
            {
                "tick": 2,
                "rooms": {
                    "E2S1": {
                        "owned": False,
                        "controller": {"level": 0, "my": False},
                        "ownedCreeps": 1,
                        "ownCreepRoles": {"worker": 1},
                        "ownStructures": 0,
                    },
                },
            },
        ]
        observed = harness._multi_tier_policy_activation_observed_evidence(tick_log, "E2S1")

        self.assertIsNotNone(observed)
        assert observed is not None
        self.assertFalse(observed["controllerClaimed"])
        self.assertTrue(observed["ownPresenceIncreased"])

        activation = {
            "type": "screeps-rl-multi-tier-policy-activation",
            "strategyVariantId": "candidate",
            "executionAction": "claim-controller",
            "objectiveSignalSource": "tick_log",
            "targetRoom": "E2S1",
            "observedEvidence": observed,
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            },
        }
        metrics = {
            "territoryDelta": 0,
            "territory": {
                "initialOwnedRoomCount": 1,
                "finalOwnedRoomCount": 1,
                "ownedRoomDelta": 0,
                "controllerLevelDelta": 0,
            },
            "finalRooms": {"ownedRoomCount": 1},
            "finalRoomStates": {
                "E1S1": {
                    "owned": True,
                    "controller": {"level": 1, "my": True},
                    "ownedCreeps": 1,
                    "ownStructures": 1,
                },
                "E2S1": copy.deepcopy(tick_log[-1]["rooms"]["E2S1"]),
            },
        }

        projected = harness.project_multi_tier_policy_activation_metrics(metrics, activation)

        self.assertEqual(projected["territoryDelta"], 1)
        self.assertEqual(projected["territory"]["ownedRoomDelta"], 0)
        self.assertEqual(projected["territory"]["controllerLevelDelta"], 0)
        self.assertEqual(projected["territory"]["finalOwnedRoomCount"], 1)
        self.assertEqual(projected["policyActivation"]["territoryDeltaSource"], "observedEvidence")
        self.assertEqual(projected["policyActivation"]["observedTerritoryDelta"], 1)
        final_target = projected["finalRoomStates"]["E2S1"]
        self.assertFalse(final_target["owned"])
        self.assertFalse(final_target["controller"]["my"])
        self.assertEqual(projected["finalRooms"]["ownedRoomCount"], 1)

        scorecard = harness.build_variant_owned_room_scorecard(
            {"variant_id": "candidate", "variant_run_id": "presence-only", "tick_log": [tick_log[-1]]}
        )
        self.assertEqual(scorecard["ownedRoomCount"], 0)
        self.assertEqual(scorecard["ownedRooms"], [])

    def test_multi_tier_policy_activation_projected_claim_refreshes_final_rooms_without_phantom_assets(self) -> None:
        activation = {
            "type": "screeps-rl-multi-tier-policy-activation",
            "strategyVariantId": "candidate",
            "executionAction": "claim-controller",
            "objectiveSignalSource": "offline_shadow_projection",
            "targetRoom": "E2S1",
            "projectedEvidence": {
                "targetRoom": "E2S1",
                "projectedTerritoryDelta": 2,
                "projectedOwnedRoomDelta": 1,
                "projectedControllerLevelDelta": 1,
                "controllerClaimed": True,
                "ownPresenceIncreased": True,
            },
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            },
        }
        metrics = {
            "territoryDelta": 0,
            "territory": {
                "initialOwnedRoomCount": 1,
                "finalOwnedRoomCount": 1,
                "ownedRoomDelta": 0,
                "controllerLevelDelta": 0,
            },
            "hostileKills": 0,
            "ownLosses": 0,
            "combatDelta": 0,
            "finalRooms": {"ownedRoomCount": 1},
            "finalRoomStates": {
                "E1S1": {
                    "owned": True,
                    "controller": {"level": 1, "my": True},
                    "ownedCreeps": 1,
                    "ownStructures": 1,
                },
                "E2S1": {
                    "owned": False,
                    "controller": {"level": 0, "my": False},
                },
            },
        }

        projected = harness.project_multi_tier_policy_activation_metrics(metrics, activation)

        final_target = projected["finalRoomStates"]["E2S1"]
        self.assertTrue(final_target["owned"])
        self.assertTrue(final_target["controller"]["my"])
        self.assertEqual(final_target["controller"]["level"], 1)
        self.assertNotIn("ownedCreeps", final_target)
        self.assertNotIn("ownStructures", final_target)
        self.assertEqual(projected["finalRooms"]["ownedRoomCount"], 2)
        self.assertEqual(projected["finalRooms"]["ownCreeps"], 1)
        self.assertEqual(projected["finalRooms"]["ownStructures"], 1)
        self.assertEqual(projected["policyActivation"]["territoryDeltaSource"], "projectedEvidence")
        self.assertEqual(projected["policyActivation"]["projectedTerritoryDelta"], 2)

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

        activation = harness.build_multi_tier_policy_activation_evidence(
            tick_log,
            strategy_variant,
            fixture_summaries,
            anchor_room="E1S1",
        )

        self.assertIsNone(activation)
        self.assertNotIn("rlPolicyActivation", tick_log[-1])
        self.assertEqual(harness.build_variant_metrics(tick_log)["combat"]["hostileKills"], 0)

    def test_v1_fixture_projects_distinct_territory_and_combat_activation(self) -> None:
        fixture_path = Path("scripts/fixtures/rl/multi-tier-territory-combat-v1.map.json")
        fixture_summaries = harness._private_map_fixture_room_summaries(fixture_path)
        tick_log = [
            {"tick": 1, "rooms": {"E1S1": copy.deepcopy(fixture_summaries["E1S1"])}},
            {"tick": 2, "rooms": {"E1S1": copy.deepcopy(fixture_summaries["E1S1"])}},
        ]
        for tick_entry in tick_log:
            harness._merge_fixture_room_summaries_into_tick(tick_entry, fixture_summaries)
        territory_seed = {
            "id": "construction-priority.pg.territory-seed.v1",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }
        risk_aware_seed = {
            "id": "construction-priority.pg.risk-aware-seed.v1",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 18,
                "resourceSignalWeight": 5,
                "killSignalWeight": 6,
                "riskPenalty": 10,
            },
        }

        combat_activation = harness.build_multi_tier_policy_activation_evidence(
            copy.deepcopy(tick_log),
            territory_seed,
            fixture_summaries,
            anchor_room="E1S1",
            allow_offline_projection=True,
        )
        territory_activation = harness.build_multi_tier_policy_activation_evidence(
            copy.deepcopy(tick_log),
            risk_aware_seed,
            fixture_summaries,
            anchor_room="E1S1",
            allow_offline_projection=True,
        )
        combat_metrics = harness.project_multi_tier_policy_activation_metrics(
            harness.build_variant_metrics(tick_log),
            combat_activation,
        )
        territory_metrics = harness.project_multi_tier_policy_activation_metrics(
            harness.build_variant_metrics(tick_log),
            territory_activation,
        )

        self.assertIsNotNone(combat_activation)
        self.assertIsNotNone(territory_activation)
        assert combat_activation is not None
        assert territory_activation is not None
        self.assertEqual(combat_activation["targetRoom"], "E1S0")
        self.assertEqual(combat_activation["executionAction"], "engage-hostiles")
        self.assertEqual(territory_activation["targetRoom"], "E1S2")
        self.assertEqual(territory_activation["executionAction"], "claim-controller")
        self.assertEqual(combat_metrics["combatDelta"], 1)
        self.assertEqual(combat_metrics["territoryDelta"], 0)
        self.assertEqual(territory_metrics["territoryDelta"], 2)
        self.assertEqual(territory_metrics["combatDelta"], 0)
        self.assertTrue(territory_metrics["finalRoomStates"]["E1S2"]["controller"]["my"])
        self.assertEqual(territory_metrics["policyActivation"]["projectedTerritoryDelta"], 2)

    def test_v1_activation_defaults_missing_or_null_combat_weights_to_zero(self) -> None:
        fixture_path = Path("scripts/fixtures/rl/multi-tier-territory-combat-v1.map.json")
        fixture_summaries = harness._private_map_fixture_room_summaries(fixture_path)
        tick_log = [
            {"tick": 1, "rooms": {"E1S1": copy.deepcopy(fixture_summaries["E1S1"])}},
            {"tick": 2, "rooms": {"E1S1": copy.deepcopy(fixture_summaries["E1S1"])}},
        ]
        for tick_entry in tick_log:
            harness._merge_fixture_room_summaries_into_tick(tick_entry, fixture_summaries)

        variants = {
            "missing": {
                "id": "construction-priority.pg.missing-combat-weights.v1",
                "parameters": {
                    "baseScoreWeight": 1,
                    "territorySignalWeight": 22,
                },
            },
            "null": {
                "id": "construction-priority.pg.null-combat-weights.v1",
                "parameters": {
                    "baseScoreWeight": 1,
                    "territorySignalWeight": 22,
                    "killSignalWeight": None,
                    "riskPenalty": None,
                },
            },
        }

        for label, variant in variants.items():
            with self.subTest(label=label):
                activation = harness.build_multi_tier_policy_activation_evidence(
                    copy.deepcopy(tick_log),
                    variant,
                    fixture_summaries,
                    anchor_room="E1S1",
                    allow_offline_projection=True,
                )

                self.assertIsNotNone(activation)
                assert activation is not None
                self.assertEqual(activation["targetRoom"], "E1S2")
                self.assertEqual(activation["executionAction"], "claim-controller")
                self.assertEqual(activation["parameters"]["killSignalWeight"], 0.0)
                self.assertEqual(activation["parameters"]["riskPenalty"], 0.0)

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

    def test_inline_scale_environment_variant_config_preserves_runtime_parameters(self) -> None:
        base_variant_id = "construction-priority.pg.territory-seed.v1"
        scale_variant_id = f"{base_variant_id}.scale-env-01"
        parameters = {
            "baseScoreWeight": 1,
            "territorySignalWeight": 22,
            "resourceSignalWeight": 3,
            "killSignalWeight": 5,
            "riskPenalty": 4,
        }

        config = harness.strategy_variant_config_by_id(
            scale_variant_id,
            variant_configs={
                scale_variant_id: {
                    "id": scale_variant_id,
                    "title": "Policy-gradient territory seed scale environment 1",
                    "candidatePolicyId": "construction-priority.pg.territory-seed.v1",
                    "family": "construction-priority",
                    "parameterEvidence": {
                        "sourceStrategyId": "construction-priority.territory-shadow.v1",
                    },
                    "parameters": parameters,
                }
            },
        )
        injection = harness.runtime_parameter_injection_for_variant(scale_variant_id, config)

        self.assertEqual(config["sourceVariantId"], base_variant_id)
        self.assertEqual(config["scaleEnvironment"]["environmentIndex"], 1)
        self.assertEqual(config["parameters"], parameters)
        self.assertEqual(config["defaultValues"], parameters)
        self.assertEqual(injection["status"], "prepared")
        self.assertEqual(injection["candidateParameterScope"], "runtime_injected")
        self.assertEqual(injection["sourceStrategyId"], "construction-priority.territory-shadow.v1")
        self.assertEqual(
            injection["parameterEvidence"]["sourceStrategyId"],
            "construction-priority.territory-shadow.v1",
        )
        self.assertEqual(injection["parameters"], parameters)
        self.assertNotIn("reason", injection)
        self.assertFalse(injection["liveEffect"])
        self.assertFalse(injection["officialMmoWrites"])
        self.assertFalse(injection["officialMmoWritesAllowed"])

    def test_runtime_parameter_injection_preserves_metadata_aliases_and_mapping_evidence(self) -> None:
        parameters = {
            "baseScoreWeight": 1,
            "territorySignalWeight": 22,
            "resourceSignalWeight": 3,
            "killSignalWeight": 5,
            "riskPenalty": 4,
        }
        expected_policy_id = "construction-priority.pg.territory-seed.v1"
        expected_source_id = "construction-priority.territory-shadow.v1"
        cases = [
            (
                "snake-case aliases",
                {
                    "candidate_policy_id": expected_policy_id,
                    "parameter_evidence": {
                        "source_strategy_id": expected_source_id,
                        "sampleCount": 3,
                    },
                },
            ),
            (
                "mapping evidence",
                {
                    "candidatePolicyId": expected_policy_id,
                    "parameterEvidence": UserDict(
                        {
                            "sourceStrategyId": expected_source_id,
                            "sampleCount": 3,
                        }
                    ),
                },
            ),
        ]

        for label, metadata in cases:
            with self.subTest(label=label):
                variant = {
                    "id": expected_policy_id,
                    "family": "construction-priority",
                    "parameters": parameters,
                    **metadata,
                }
                injection = harness.runtime_parameter_injection_for_variant(variant["id"], variant)

                self.assertEqual(injection["candidatePolicyId"], expected_policy_id)
                self.assertEqual(injection["sourceStrategyId"], expected_source_id)
                self.assertIsInstance(injection["parameterEvidence"], dict)
                self.assertEqual(injection["parameterEvidence"]["sampleCount"], 3)
                json.dumps(injection["parameterEvidence"])

    def test_runtime_parameter_injection_changes_private_runtime_code_input(self) -> None:
        base_code = (
            '"use strict";\n'
            f'var runtimePolicyConsumer = "{harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
            "function consumeRuntimePolicyParameters() {\n"
            f"  return globalThis[{json.dumps(harness.RUNTIME_PARAMETER_INJECTION_GLOBAL)}].parameters;\n"
            "}\n"
            "module.exports.loop = function loop() { return consumeRuntimePolicyParameters(); };\n"
        )
        base_variant = {
            "id": "construction-priority.pg.incumbent-seed.v1",
            "candidatePolicyId": "construction-priority.pg.incumbent-seed.v1",
            "family": "construction-priority",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 6,
                "resourceSignalWeight": 4,
                "killSignalWeight": 6,
                "riskPenalty": 4,
            },
        }
        territory_variant = {
            **base_variant,
            "id": "construction-priority.pg.territory-seed.v1",
            "candidatePolicyId": "construction-priority.pg.territory-seed.v1",
            "parameters": {
                **base_variant["parameters"],
                "territorySignalWeight": 22,
            },
        }

        base_injection = harness.runtime_parameter_injection_for_variant(base_variant["id"], base_variant)
        territory_injection = harness.runtime_parameter_injection_for_variant(territory_variant["id"], territory_variant)
        base_upload = harness.apply_runtime_parameter_injection_to_code(base_code, base_injection)
        territory_upload = harness.apply_runtime_parameter_injection_to_code(base_code, territory_injection)
        base_injection = harness.mark_runtime_parameter_injection_uploaded(base_injection, code_text=base_upload)
        territory_injection = harness.mark_runtime_parameter_injection_uploaded(
            territory_injection,
            code_text=territory_upload,
        )

        self.assertNotEqual(base_upload, territory_upload)
        self.assertTrue(base_upload.startswith('"use strict";\n'))
        self.assertIn(harness.RUNTIME_PARAMETER_INJECTION_GLOBAL, base_upload)
        self.assertIn(f"var {harness.RUNTIME_PARAMETER_INJECTION_GLOBAL} =", base_upload)
        self.assertIn(f"var payload = {harness.RUNTIME_PARAMETER_INJECTION_GLOBAL};", base_upload)
        self.assertIn("function addRoot(root)", base_upload)
        self.assertIn("typeof globalThis !== 'undefined'", base_upload)
        self.assertIn("typeof global !== 'undefined'", base_upload)
        self.assertIn("typeof self !== 'undefined'", base_upload)
        self.assertIn("addRoot(this)", base_upload)
        self.assertIn('"territorySignalWeight":6', base_upload)
        self.assertNotIn('"territorySignalWeight":22', base_upload)
        self.assertIn('"territorySignalWeight":22', territory_upload)
        self.assertFalse(base_injection["liveEffect"])
        self.assertFalse(base_injection["officialMmoWrites"])
        self.assertFalse(base_injection["officialMmoWritesAllowed"])
        self.assertTrue(base_injection["runtimeParameterInjection"])
        self.assertTrue(territory_injection["runtimeParameterInjection"])
        self.assertNotIn("STEAM_KEY", base_upload)

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            code_path = root / "main.js"
            map_path = root / "map.json"
            code_path.write_text(base_code, encoding="utf-8")
            map_path.write_text("{}", encoding="utf-8")
            base_scenario = harness.build_scenario_config(
                "run",
                base_variant["id"],
                room="E1S1",
                shard="shardX",
                branch="$activeWorld",
                ticks=2,
                code_path=code_path,
                map_source_file=map_path,
                code_payload_text=base_upload,
                runtime_parameter_injection=base_injection,
            )
            territory_scenario = harness.build_scenario_config(
                "run",
                territory_variant["id"],
                room="E1S1",
                shard="shardX",
                branch="$activeWorld",
                ticks=2,
                code_path=code_path,
                map_source_file=map_path,
                code_payload_text=territory_upload,
                runtime_parameter_injection=territory_injection,
            )

        self.assertNotEqual(
            base_scenario["codeArtifact"]["sha256"],
            territory_scenario["codeArtifact"]["sha256"],
        )
        self.assertEqual(
            territory_scenario["runtimeParameterInjection"]["parameters"]["territorySignalWeight"],
            22,
        )
        self.assertEqual(base_scenario["runtimeParameterInjection"]["parameters"]["territorySignalWeight"], 6)
        self.assertNotEqual(base_scenario["runtimeParameterInjection"]["parameters"]["territorySignalWeight"], 22)
        self.assertEqual(
            base_scenario["codeArtifact"]["sha256"],
            hashlib.sha256(base_upload.encode("utf-8")).hexdigest(),
        )
        self.assertFalse(territory_scenario["runtimeParameterInjection"]["safety"]["officialMmoWritesAllowed"])

    def test_runtime_parameter_injection_preserves_strict_directive_after_bundle_prefixes(self) -> None:
        variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "family": "construction-priority",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }
        injection = harness.runtime_parameter_injection_for_variant(variant["id"], variant)
        code_cases = [
            (
                "\ufeff// generated bundle\n"
                "'use strict'\n"
                f'var runtimePolicyConsumer = "{harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
                "module.exports.loop = function loop() { return 1; };\n"
            ),
            (
                "/* generated bundle */\n"
                '  "use strict"\n'
                f'var runtimePolicyConsumer = "{harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
                "module.exports.loop = function loop() { return 1; };\n"
            ),
        ]

        for code_text in code_cases:
            with self.subTest(code_text=code_text[:24]):
                upload = harness.apply_runtime_parameter_injection_to_code(code_text, injection)

                self.assertLess(upload.index("use strict"), upload.index("private-simulator"))
                self.assertIn(harness.RUNTIME_PARAMETER_INJECTION_GLOBAL, upload)

    def test_runtime_parameter_injection_upload_requires_runtime_consumer(self) -> None:
        base_code = '"use strict";\nmodule.exports.loop = function loop() { return 1; };\n'
        variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "family": "construction-priority",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }

        injection = harness.runtime_parameter_injection_for_variant(variant["id"], variant)
        upload = harness.apply_runtime_parameter_injection_to_code(base_code, injection)
        uploaded = harness.mark_runtime_parameter_injection_uploaded(injection, code_text=upload)

        self.assertEqual(uploaded["status"], "failed")
        self.assertFalse(uploaded["runtimeParameterInjection"])
        self.assertFalse(uploaded["inlineCandidatesRuntimeInjected"])
        self.assertFalse(uploaded["runtimeParameterConsumerObserved"])
        self.assertIn("consumer marker", uploaded["reason"])
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            code_path = root / "main.js"
            map_path = root / "map.json"
            code_path.write_text(base_code, encoding="utf-8")
            map_path.write_text("{}", encoding="utf-8")
            scenario = harness.build_scenario_config(
                "run",
                variant["id"],
                room="E1S1",
                shard="shardX",
                branch="$activeWorld",
                ticks=2,
                code_path=code_path,
                map_source_file=map_path,
                code_payload_text=harness.runtime_parameter_injection_uploaded_code_text(upload, uploaded),
                runtime_parameter_injection=uploaded,
            )

        self.assertIsNone(harness.runtime_parameter_injection_uploaded_code_text(upload, uploaded))
        self.assertNotIn("payloadSource", scenario["codeArtifact"])
        self.assertEqual(scenario["codeArtifact"]["sha256"], hashlib.sha256(base_code.encode("utf-8")).hexdigest())

    @unittest.skipUnless(NODE_BIN is not None, "node is required to execute the injected bundle prelude")
    def test_runtime_parameter_injection_prelude_materializes_consumer_global_evidence(self) -> None:
        assert NODE_BIN is not None
        variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "candidatePolicyId": "construction-priority.pg.territory-seed.v1",
            "family": "construction-priority",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }
        injection = harness.runtime_parameter_injection_for_variant(variant["id"], variant)
        evidence = self.runtime_parameter_consumption_evidence(injection)
        evidence_json = json.dumps(evidence, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        base_code = (
            '"use strict";\n'
            f'var runtimePolicyConsumer = "{harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
            "module.exports.loop = function loop() {\n"
            f"  globalThis[{json.dumps(harness.RUNTIME_PARAMETER_CONSUMPTION_GLOBAL)}] = {evidence_json};\n"
            "};\n"
        )
        uploaded_code = harness.apply_runtime_parameter_injection_to_code(base_code, injection)
        uploaded = harness.mark_runtime_parameter_injection_uploaded(injection, code_text=uploaded_code)
        self.assertTrue(uploaded["runtimeParameterInjection"])

        script = (
            "const hostConsole = console;\n"
            "const logs = [];\n"
            "globalThis.Memory = {};\n"
            "globalThis.Game = {time: 77};\n"
            "globalThis.console = {log: line => logs.push(String(line))};\n"
            f"{uploaded_code}\n"
            "module.exports.loop();\n"
            "hostConsole.log(JSON.stringify({memory: globalThis.Memory.rlRuntimePolicyParameters, logs}));\n"
        )
        result = subprocess.run(
            [NODE_BIN, "-e", script],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )

        payload = json.loads(result.stdout)
        self.assertEqual(payload["memory"]["type"], harness.RUNTIME_PARAMETER_CONSUMPTION_TYPE)
        self.assertTrue(payload["memory"]["runtimeParameterInjection"])
        self.assertTrue(payload["memory"]["consumed"])
        self.assertEqual(payload["memory"]["tick"], 77)
        self.assertEqual(payload["memory"]["consumedStrategyVariantId"], injection["strategyVariantId"])
        self.assertEqual(payload["memory"]["consumedParametersSha256"], injection["parametersSha256"])
        self.assertEqual(len(payload["logs"]), 1)
        extracted = harness.runtime_parameter_consumption_evidence_from_console_output(
            "\n".join(payload["logs"]),
            injection=uploaded,
        )
        self.assertIsNotNone(extracted)
        consumption = harness.runtime_parameter_consumption_check(uploaded, extracted)
        self.assertTrue(consumption["runtimeParameterConsumption"])
        self.assertEqual(consumption["status"], "consumed")

    @unittest.skipUnless(NODE_BIN is not None, "node is required to execute the injected bundle prelude")
    def test_runtime_parameter_injection_prelude_mirrors_consumption_to_object_memory(self) -> None:
        assert NODE_BIN is not None
        variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "candidatePolicyId": "construction-priority.pg.territory-seed.v1",
            "family": "construction-priority",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }
        injection = harness.runtime_parameter_injection_for_variant(variant["id"], variant)
        evidence = self.runtime_parameter_consumption_evidence(injection)
        evidence_json = json.dumps(evidence, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        base_code = (
            '"use strict";\n'
            f'var runtimePolicyConsumer = "{harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
            "module.exports.loop = function loop() {\n"
            f"  globalThis[{json.dumps(harness.RUNTIME_PARAMETER_CONSUMPTION_GLOBAL)}] = {evidence_json};\n"
            "};\n"
        )
        uploaded_code = harness.apply_runtime_parameter_injection_to_code(base_code, injection)
        uploaded = harness.mark_runtime_parameter_injection_uploaded(injection, code_text=uploaded_code)
        self.assertTrue(uploaded["runtimeParameterInjection"])

        script = (
            "const hostConsole = console;\n"
            "const logs = [];\n"
            "globalThis.Memory = {creeps: {Worker1: {role: 'worker'}}, spawns: {Spawn1: {}}};\n"
            "globalThis.Game = {\n"
            "  time: 77,\n"
            "  creeps: {Worker1: {memory: globalThis.Memory.creeps.Worker1}},\n"
            "  spawns: {Spawn1: {memory: globalThis.Memory.spawns.Spawn1}}\n"
            "};\n"
            "globalThis.console = {log: line => logs.push(String(line))};\n"
            f"{uploaded_code}\n"
            "module.exports.loop();\n"
            "hostConsole.log(JSON.stringify({\n"
            "  creep: globalThis.Memory.creeps.Worker1.rlRuntimePolicyParameters,\n"
            "  spawn: globalThis.Memory.spawns.Spawn1.rlRuntimePolicyParameters,\n"
            "  logs\n"
            "}));\n"
        )
        result = subprocess.run(
            [NODE_BIN, "-e", script],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )

        payload = json.loads(result.stdout)
        self.assertTrue(payload["creep"]["consumed"])
        self.assertTrue(payload["spawn"]["consumed"])
        self.assertEqual(payload["creep"]["tick"], 77)
        self.assertEqual(payload["creep"]["consumedParametersSha256"], injection["parametersSha256"])

    @unittest.skipUnless(NODE_BIN is not None, "node is required to execute the injected bundle prelude")
    def test_runtime_parameter_injection_wraps_default_export_for_tick_consumption_evidence(self) -> None:
        assert NODE_BIN is not None
        variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "candidatePolicyId": "construction-priority.pg.territory-seed.v1",
            "family": "construction-priority",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }
        injection = harness.runtime_parameter_injection_for_variant(variant["id"], variant)
        evidence = self.runtime_parameter_consumption_evidence(injection)
        evidence_json = json.dumps(evidence, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        base_code = (
            '"use strict";\n'
            f'var runtimePolicyConsumer = "{harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
            f"var {harness.RUNTIME_PARAMETER_CONSUMPTION_GLOBAL};\n"
            "module.exports.default = {\n"
            "  loop: function loop() {\n"
            f"    {harness.RUNTIME_PARAMETER_CONSUMPTION_GLOBAL} = {evidence_json};\n"
            "  }\n"
            "};\n"
        )
        uploaded_code = harness.apply_runtime_parameter_injection_to_code(base_code, injection)
        uploaded = harness.mark_runtime_parameter_injection_uploaded(injection, code_text=uploaded_code)
        self.assertTrue(uploaded["runtimeParameterInjection"])

        script = (
            "const hostConsole = console;\n"
            "const logs = [];\n"
            "globalThis.Memory = {};\n"
            "globalThis.Game = {time: 88};\n"
            "globalThis.console = {log: line => logs.push(String(line))};\n"
            f"{uploaded_code}\n"
            "module.exports.default.loop();\n"
            "module.exports.default.loop();\n"
            "hostConsole.log(JSON.stringify({memory: globalThis.Memory.rlRuntimePolicyParameters, logs}));\n"
        )
        result = subprocess.run(
            [NODE_BIN, "-e", script],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )

        payload = json.loads(result.stdout)
        self.assertEqual(payload["memory"]["type"], harness.RUNTIME_PARAMETER_CONSUMPTION_TYPE)
        self.assertTrue(payload["memory"]["runtimeParameterInjection"])
        self.assertTrue(payload["memory"]["consumed"])
        self.assertEqual(payload["memory"]["tick"], 88)
        self.assertEqual(payload["memory"]["consumedStrategyVariantId"], injection["strategyVariantId"])
        self.assertEqual(payload["memory"]["consumedParametersSha256"], injection["parametersSha256"])
        self.assertEqual(
            len(payload["logs"]),
            1,
            "dedupe should suppress repeated identical materialization evidence",
        )
        extracted = harness.runtime_parameter_consumption_evidence_from_console_output(
            "\n".join(payload["logs"]),
            injection=uploaded,
        )
        self.assertIsNotNone(extracted)
        consumption = harness.runtime_parameter_consumption_check(uploaded, extracted)
        self.assertTrue(consumption["runtimeParameterConsumption"])
        self.assertEqual(consumption["status"], "consumed")

    @unittest.skipUnless(NODE_BIN is not None, "node is required to execute the injected bundle prelude")
    def test_runtime_parameter_injection_wraps_callable_exports_for_tick_consumption_evidence(self) -> None:
        assert NODE_BIN is not None
        variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "candidatePolicyId": "construction-priority.pg.territory-seed.v1",
            "family": "construction-priority",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }

        for export_form in ("module.exports", "module.exports.default"):
            with self.subTest(export_form=export_form):
                injection = harness.runtime_parameter_injection_for_variant(variant["id"], variant)
                evidence = self.runtime_parameter_consumption_evidence(injection)
                evidence_json = json.dumps(evidence, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
                export_assignment = (
                    "module.exports = function loop() {\n"
                    if export_form == "module.exports"
                    else "module.exports.default = function loop() {\n"
                )
                invocation = (
                    "module.exports();\n"
                    if export_form == "module.exports"
                    else "module.exports.default();\n"
                )
                base_code = (
                    '"use strict";\n'
                    f'var runtimePolicyConsumer = "{harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
                    f"var {harness.RUNTIME_PARAMETER_CONSUMPTION_GLOBAL};\n"
                    f"{export_assignment}"
                    f"  {harness.RUNTIME_PARAMETER_CONSUMPTION_GLOBAL} = {evidence_json};\n"
                    "};\n"
                )
                uploaded_code = harness.apply_runtime_parameter_injection_to_code(base_code, injection)
                uploaded = harness.mark_runtime_parameter_injection_uploaded(injection, code_text=uploaded_code)
                self.assertTrue(uploaded["runtimeParameterInjection"])

                script = (
                    "const hostConsole = console;\n"
                    "const logs = [];\n"
                    "globalThis.Memory = {};\n"
                    "globalThis.Game = {time: 89};\n"
                    "globalThis.console = {log: line => logs.push(String(line))};\n"
                    f"{uploaded_code}\n"
                    f"{invocation}"
                    f"{invocation}"
                    "hostConsole.log(JSON.stringify({memory: globalThis.Memory.rlRuntimePolicyParameters, logs}));\n"
                )
                result = subprocess.run(
                    [NODE_BIN, "-e", script],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )

                payload = json.loads(result.stdout)
                self.assertEqual(payload["memory"]["type"], harness.RUNTIME_PARAMETER_CONSUMPTION_TYPE)
                self.assertTrue(payload["memory"]["runtimeParameterInjection"])
                self.assertTrue(payload["memory"]["consumed"])
                self.assertEqual(payload["memory"]["tick"], 89)
                self.assertEqual(payload["memory"]["consumedStrategyVariantId"], injection["strategyVariantId"])
                self.assertEqual(payload["memory"]["consumedParametersSha256"], injection["parametersSha256"])
                self.assertEqual(
                    len(payload["logs"]),
                    1,
                    "dedupe should suppress repeated identical materialization evidence",
                )
                extracted = harness.runtime_parameter_consumption_evidence_from_console_output(
                    "\n".join(payload["logs"]),
                    injection=uploaded,
                )
                self.assertIsNotNone(extracted)
                consumption = harness.runtime_parameter_consumption_check(uploaded, extracted)
                self.assertTrue(consumption["runtimeParameterConsumption"])
                self.assertEqual(consumption["status"], "consumed")

    @unittest.skipUnless(NODE_BIN is not None, "node is required to execute the injected bundle prelude")
    def test_runtime_parameter_injection_rewraps_replaced_loop_exports(self) -> None:
        assert NODE_BIN is not None
        variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "candidatePolicyId": "construction-priority.pg.territory-seed.v1",
            "family": "construction-priority",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }

        for export_form in (
            "module.exports.loop",
            "module.exports.default.loop",
            "module.exports",
            "module.exports.default",
        ):
            with self.subTest(export_form=export_form):
                injection = harness.runtime_parameter_injection_for_variant(variant["id"], variant)
                evidence = self.runtime_parameter_consumption_evidence(injection)
                evidence_json = json.dumps(evidence, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
                if export_form.endswith(".loop"):
                    container_assignment = (
                        "module.exports = {\n"
                        if export_form == "module.exports.loop"
                        else "module.exports.default = {\n"
                    )
                    base_code = (
                        '"use strict";\n'
                        f'var runtimePolicyConsumer = "{harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
                        f"var {harness.RUNTIME_PARAMETER_CONSUMPTION_GLOBAL};\n"
                        f"{container_assignment}"
                        "  loop: function firstLoop() {\n"
                        f"    {harness.RUNTIME_PARAMETER_CONSUMPTION_GLOBAL} = {evidence_json};\n"
                        f"    {export_form} = function secondLoop() {{\n"
                        f"      {harness.RUNTIME_PARAMETER_CONSUMPTION_GLOBAL} = {evidence_json};\n"
                        "    };\n"
                        "  }\n"
                        "};\n"
                    )
                else:
                    base_code = (
                        '"use strict";\n'
                        f'var runtimePolicyConsumer = "{harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
                        f"var {harness.RUNTIME_PARAMETER_CONSUMPTION_GLOBAL};\n"
                        f"{export_form} = function firstLoop() {{\n"
                        f"  {harness.RUNTIME_PARAMETER_CONSUMPTION_GLOBAL} = {evidence_json};\n"
                        f"  {export_form} = function secondLoop() {{\n"
                        f"    {harness.RUNTIME_PARAMETER_CONSUMPTION_GLOBAL} = {evidence_json};\n"
                        "  };\n"
                        "};\n"
                    )
                uploaded_code = harness.apply_runtime_parameter_injection_to_code(base_code, injection)
                uploaded = harness.mark_runtime_parameter_injection_uploaded(injection, code_text=uploaded_code)
                self.assertTrue(uploaded["runtimeParameterInjection"])

                invocation = f"{export_form}();\n"
                script = (
                    "const hostConsole = console;\n"
                    "const logs = [];\n"
                    "globalThis.Memory = {};\n"
                    "globalThis.Game = {time: 90};\n"
                    "globalThis.console = {log: line => logs.push(String(line))};\n"
                    f"{uploaded_code}\n"
                    f"{invocation}"
                    "globalThis.Game.time = 91;\n"
                    f"{invocation}"
                    "hostConsole.log(JSON.stringify({memory: globalThis.Memory.rlRuntimePolicyParameters, logs}));\n"
                )
                result = subprocess.run(
                    [NODE_BIN, "-e", script],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )

                payload = json.loads(result.stdout)
                self.assertEqual(payload["memory"]["type"], harness.RUNTIME_PARAMETER_CONSUMPTION_TYPE)
                self.assertTrue(payload["memory"]["runtimeParameterInjection"])
                self.assertTrue(payload["memory"]["consumed"])
                self.assertEqual(payload["memory"]["tick"], 91)
                self.assertEqual(payload["memory"]["consumedStrategyVariantId"], injection["strategyVariantId"])
                self.assertEqual(payload["memory"]["consumedParametersSha256"], injection["parametersSha256"])
                self.assertEqual(
                    len(payload["logs"]),
                    2,
                    "replaced loop exports should be wrapped before the next invocation",
                )
                logged_ticks = []
                for line in payload["logs"]:
                    logged = harness.runtime_parameter_consumption_payload_from_console_line(line)
                    self.assertIsNotNone(logged)
                    if logged is not None:
                        logged_ticks.append(logged["tick"])
                self.assertEqual(logged_ticks, [90, 91])
                extracted = harness.runtime_parameter_consumption_evidence_from_console_output(
                    "\n".join(payload["logs"]),
                    injection=uploaded,
                )
                self.assertIsNotNone(extracted)
                consumption = harness.runtime_parameter_consumption_check(uploaded, extracted)
                self.assertTrue(consumption["runtimeParameterConsumption"])
                self.assertEqual(consumption["status"], "consumed")

    @unittest.skipUnless(NODE_BIN is not None, "node is required to execute the injected bundle prelude")
    def test_runtime_parameter_injection_prelude_does_not_fabricate_memory(self) -> None:
        assert NODE_BIN is not None
        variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "candidatePolicyId": "construction-priority.pg.territory-seed.v1",
            "family": "construction-priority",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }
        injection = harness.runtime_parameter_injection_for_variant(variant["id"], variant)
        evidence = self.runtime_parameter_consumption_evidence(injection)
        evidence_json = json.dumps(evidence, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        base_code = (
            '"use strict";\n'
            f'var runtimePolicyConsumer = "{harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
            "module.exports.loop = function loop() {\n"
            f"  globalThis[{json.dumps(harness.RUNTIME_PARAMETER_CONSUMPTION_GLOBAL)}] = {evidence_json};\n"
            "};\n"
        )
        uploaded_code = harness.apply_runtime_parameter_injection_to_code(base_code, injection)
        uploaded = harness.mark_runtime_parameter_injection_uploaded(injection, code_text=uploaded_code)
        self.assertTrue(uploaded["runtimeParameterInjection"])

        script = (
            "const hostConsole = console;\n"
            "const logs = [];\n"
            "delete globalThis.Memory;\n"
            "globalThis.Game = {time: 77};\n"
            "globalThis.console = {log: line => logs.push(String(line))};\n"
            f"{uploaded_code}\n"
            "module.exports.loop();\n"
            "hostConsole.log(JSON.stringify({\n"
            "  hasMemory: Object.prototype.hasOwnProperty.call(globalThis, 'Memory'),\n"
            "  memoryType: typeof globalThis.Memory,\n"
            "  logs\n"
            "}));\n"
        )
        result = subprocess.run(
            [NODE_BIN, "-e", script],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )

        payload = json.loads(result.stdout)
        self.assertFalse(payload["hasMemory"])
        self.assertEqual(payload["memoryType"], "undefined")
        self.assertEqual(len(payload["logs"]), 1)
        extracted = harness.runtime_parameter_consumption_evidence_from_console_output(
            "\n".join(payload["logs"]),
            injection=uploaded,
        )
        self.assertIsNotNone(extracted)
        consumption = harness.runtime_parameter_consumption_check(uploaded, extracted)
        self.assertTrue(consumption["runtimeParameterConsumption"])
        self.assertEqual(consumption["status"], "consumed")

    def test_runtime_parameter_consumption_required_for_evaluated_parameters(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()

        consumption = harness.runtime_parameter_consumption_check(injection, None)
        updated = harness.apply_runtime_parameter_consumption_to_injection(injection, consumption)

        self.assertEqual(consumption["status"], "missing")
        self.assertFalse(consumption["runtimeParameterConsumption"])
        self.assertFalse(updated["runtimeParameterConsumption"])
        self.assertEqual(updated["runtimeParameterConsumptionStatus"], "missing")
        self.assertIn("did not expose", consumption["reason"])
        self.assertNotIn("consumerVersion", consumption)
        self.assertNotIn("runtimeParameterConsumerVersion", updated)
        self.assertNotIn("consumedParametersSha256", updated)
        self.assertNotIn("consumedStrategyVariantId", updated)

    def test_runtime_parameter_consumption_accepts_matching_memory_evidence(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        evidence["tick"] = 123

        consumption = harness.runtime_parameter_consumption_check(injection, evidence)
        updated = harness.apply_runtime_parameter_consumption_to_injection(injection, consumption)

        self.assertEqual(consumption["status"], "consumed")
        self.assertTrue(consumption["runtimeParameterConsumption"])
        self.assertEqual(consumption["consumerVersion"], harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_VERSION)
        self.assertEqual(consumption["evaluatedParameters"], injection["parameters"])
        self.assertEqual(consumption["evaluatedParametersSha256"], injection["parametersSha256"])
        self.assertEqual(consumption["consumedParametersSha256"], injection["parametersSha256"])
        self.assertEqual(consumption["consumedStrategyVariantId"], injection["strategyVariantId"])
        self.assertEqual(consumption["consumedTick"], 123)
        self.assertTrue(updated["runtimeParameterConsumption"])
        self.assertEqual(updated["runtimeParameterConsumptionStatus"], "consumed")
        self.assertEqual(updated["runtimeParameterConsumerVersion"], harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_VERSION)
        self.assertEqual(updated["consumedParametersSha256"], injection["parametersSha256"])
        self.assertEqual(updated["consumedTick"], 123)

    def test_runtime_parameter_consumption_accepts_javascript_numeric_canonicalization(self) -> None:
        variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "candidatePolicyId": "construction-priority.pg.territory-seed.v1",
            "family": "construction-priority",
            "parameters": {
                "baseScoreWeight": 1.0,
                "territorySignalWeight": 22.0,
                "resourceSignalWeight": 3.0,
                "killSignalWeight": 5.0,
                "riskPenalty": 4.0,
            },
        }
        base_code = (
            '"use strict";\n'
            f'var runtimePolicyConsumer = "{harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
            "module.exports.loop = function loop() { return 1; };\n"
        )
        injection = harness.runtime_parameter_injection_for_variant(variant["id"], variant)
        upload = harness.apply_runtime_parameter_injection_to_code(base_code, injection)
        injection = harness.mark_runtime_parameter_injection_uploaded(injection, code_text=upload)
        evidence = self.runtime_parameter_consumption_evidence(injection)
        evidence["parameters"] = {
            "baseScoreWeight": 1,
            "territorySignalWeight": 22,
            "resourceSignalWeight": 3,
            "killSignalWeight": 5,
            "riskPenalty": 4,
        }

        consumption = harness.runtime_parameter_consumption_check(injection, evidence)

        self.assertEqual(injection["parameters"], evidence["parameters"])
        self.assertEqual(consumption["status"], "consumed")
        self.assertTrue(consumption["runtimeParameterConsumption"])
        self.assertEqual(consumption["evaluatedParametersSha256"], injection["parametersSha256"])
        self.assertFalse(consumption["liveEffect"])
        self.assertFalse(consumption["officialMmoWrites"])
        self.assertFalse(consumption["officialMmoWritesAllowed"])

    def test_runtime_parameter_canonicalization_preserves_tiny_floats_and_mixed_keys(self) -> None:
        parameters = {
            "tinyNonZeroWeight": 1e-10,
            "integralWeight": 4.0,
            "nested": [{"tinyNonZeroWeight": -1e-10, "integralWeight": 5.0, 7: "ignored"}],
            3: "ignored",
        }

        canonical = harness.canonical_runtime_parameter_value(parameters)
        parameters_hash = harness.runtime_parameter_parameters_hash(parameters)

        self.assertEqual(canonical["tinyNonZeroWeight"], 1e-10)
        self.assertNotEqual(canonical["tinyNonZeroWeight"], 0)
        self.assertIs(type(canonical["integralWeight"]), int)
        self.assertEqual(canonical["integralWeight"], 4)
        self.assertEqual(canonical["nested"][0]["tinyNonZeroWeight"], -1e-10)
        self.assertNotEqual(canonical["nested"][0]["tinyNonZeroWeight"], 0)
        self.assertIs(type(canonical["nested"][0]["integralWeight"]), int)
        self.assertEqual(canonical["nested"][0]["integralWeight"], 5)
        self.assertNotIn(3, canonical)
        self.assertNotIn(7, canonical["nested"][0])
        self.assertIsInstance(parameters_hash, str)

    def test_runtime_parameter_consumption_rejects_parameter_drift(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        evidence["parameters"] = {
            **evidence["parameters"],
            "territorySignalWeight": evidence["parameters"]["territorySignalWeight"] + 1,
        }

        consumption = harness.runtime_parameter_consumption_check(injection, evidence)

        self.assertEqual(consumption["status"], "invalid")
        self.assertFalse(consumption["runtimeParameterConsumption"])
        self.assertIn("disagreed", consumption["reason"])
        self.assertNotEqual(consumption["evaluatedParametersSha256"], injection["parametersSha256"])

    def test_runtime_parameter_consumption_rejects_consumer_version_mismatch(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        evidence["consumerVersion"] = "runtime-policy-v0"

        consumption = harness.runtime_parameter_consumption_check(injection, evidence)
        updated = harness.apply_runtime_parameter_consumption_to_injection(injection, consumption)

        self.assertEqual(consumption["status"], "invalid")
        self.assertFalse(consumption["runtimeParameterConsumption"])
        self.assertIn("consumer version", consumption["reason"])
        self.assertNotIn("consumerVersion", consumption)
        self.assertNotIn("runtimeParameterConsumerVersion", updated)
        self.assertNotIn("consumedParametersSha256", updated)
        self.assertNotIn("consumedStrategyVariantId", updated)

    def test_runtime_parameter_consumption_extracts_memory_payload(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        payload = {
            "ok": 1,
            "data": json.dumps({
                "rlRuntimePolicyParameters": evidence,
            }, sort_keys=True),
        }

        extracted = harness.find_runtime_parameter_consumption_evidence(payload)

        self.assertEqual(extracted, evidence)

    def test_runtime_parameter_consumption_extracts_shard_wrapped_memory_payload(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        for shard_key in ("shardX", "SHARDX"):
            with self.subTest(shard_key=shard_key):
                payload = {
                    "ok": 1,
                    "data": json.dumps(
                        {
                            "$activeWorld": {
                                shard_key: json.dumps(
                                    {
                                        "Memory": {
                                            "rlRuntimePolicyParameters": evidence,
                                        }
                                    },
                                    sort_keys=True,
                                )
                            }
                        },
                        sort_keys=True,
                    ),
                }

                extracted = harness.find_runtime_parameter_consumption_evidence(
                    payload,
                    injection=injection,
                )
                consumption = harness.runtime_parameter_consumption_check(injection, extracted)

                self.assertEqual(extracted, evidence)
                self.assertEqual(consumption["status"], "consumed")
                self.assertEqual(
                    consumption["consumedStrategyVariantId"],
                    injection["strategyVariantId"],
                )
                self.assertEqual(consumption["consumedParametersSha256"], injection["parametersSha256"])

    def test_runtime_parameter_consumption_extracts_default_branch_wrapped_memory_payload(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        payload = {
            "ok": 1,
            "data": json.dumps(
                {
                    "$activeWorld": {
                        "default": {
                            "shardX": json.dumps(
                                {
                                    "rlRuntimePolicyParameters": evidence,
                                },
                                sort_keys=True,
                            )
                        }
                    }
                },
                sort_keys=True,
            ),
        }

        extracted = harness.find_runtime_parameter_consumption_evidence(
            payload,
            injection=injection,
        )
        consumption = harness.runtime_parameter_consumption_check(injection, extracted)

        self.assertEqual(extracted, evidence)
        self.assertEqual(consumption["status"], "consumed")
        self.assertTrue(consumption["runtimeParameterConsumption"])
        self.assertEqual(consumption["evaluatedParameters"], injection["parameters"])

    def test_console_runtime_parameter_consumption_collector_reads_tick_time_evidence(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        matching = self.runtime_parameter_consumption_evidence(injection)
        stale = self.runtime_parameter_consumption_evidence(injection)
        stale["candidatePolicyId"] = "stale-policy"
        log_output = "\n".join(
            [
                "screeps-1  | booted",
                f"screeps-1  | {harness.RUNTIME_PARAMETER_CONSUMPTION_LOG_PREFIX}"
                f"{json.dumps(matching, sort_keys=True)}",
                f"screeps-1  | {harness.RUNTIME_PARAMETER_CONSUMPTION_LOG_PREFIX}"
                f"{json.dumps(stale, sort_keys=True)}",
            ]
        )

        class FakeSmoke:
            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = command, cfg, timeout, output_limit
                return {"returncode": 0, "output_excerpt": log_output}

        extracted = harness._collect_console_runtime_parameter_consumption_evidence(
            FakeSmoke(),
            ["docker", "compose"],
            object(),
            None,
            injection,
        )

        self.assertEqual(extracted, matching)

    def test_console_runtime_parameter_consumption_non_consumed_evidence_fails_closed(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        evidence["consumed"] = False
        log_output = (
            f"{harness.RUNTIME_PARAMETER_CONSUMPTION_LOG_PREFIX}"
            f"{json.dumps(evidence, sort_keys=True)}"
        )

        extracted = harness.runtime_parameter_consumption_evidence_from_console_output(
            log_output,
            injection=injection,
        )
        consumption = harness.runtime_parameter_consumption_check(injection, extracted)

        self.assertIsNotNone(extracted)
        self.assertEqual(consumption["status"], "invalid")
        self.assertFalse(consumption["runtimeParameterConsumption"])
        self.assertIn("did not mark the payload consumed", consumption["reason"])

    def test_http_runtime_parameter_consumption_collector_falls_back_to_full_memory(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)

        class Result:
            def __init__(self, payload: object) -> None:
                self.status = 200
                self.payload = payload

        class FakeConfig:
            server_url = "http://sim.local"
            shard = "shardX"

        class FakeSmoke:
            calls: list[dict[str, object]] = []

            def token_headers(self, token: str) -> dict[str, str]:
                return {"X-Token": token}

            def http_json(
                self,
                method: str,
                base_url: str,
                path: str,
                *,
                headers: dict[str, str],
                params: dict[str, object],
                timeout: int,
            ) -> Result:
                _ = method, base_url, path, headers, timeout
                self.calls.append(dict(params))
                if params.get("path") == "rlRuntimePolicyParameters":
                    return Result({"ok": 1, "data": None})
                return Result({
                    "ok": 1,
                    "data": json.dumps({"rlRuntimePolicyParameters": evidence}, sort_keys=True),
                })

        smoke = FakeSmoke()

        extracted = harness._collect_http_runtime_parameter_consumption_evidence(
            smoke,
            None,
            FakeConfig(),
            "token",
            injection,
        )

        self.assertEqual(extracted, evidence)
        self.assertEqual(
            smoke.calls,
            [
                {"path": "rlRuntimePolicyParameters", "shard": "shardX"},
                {"path": "rlRuntimePolicyParameters"},
                {"shard": "shardX"},
            ],
        )

    def test_http_runtime_parameter_consumption_collection_materializes_shard_memory_evidence(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        shard_memory = {
            "$activeWorld": {
                "shardX": json.dumps(
                    {
                        "rlRuntimePolicyParameters": evidence,
                    },
                    sort_keys=True,
                )
            }
        }

        class Result:
            def __init__(self, payload: object) -> None:
                self.status = 200
                self.payload = payload

        class FakeConfig:
            server_url = "http://sim.local"
            shard = "shardX"

        class FakeSmoke:
            calls: list[dict[str, object]] = []

            def token_headers(self, token: str) -> dict[str, str]:
                return {"X-Token": token}

            def http_json(
                self,
                method: str,
                base_url: str,
                path: str,
                *,
                headers: dict[str, str],
                params: dict[str, object],
                timeout: int,
            ) -> Result:
                _ = method, base_url, path, headers, params, timeout
                self.calls.append(dict(params))
                return Result({"ok": 1, "data": json.dumps(shard_memory, sort_keys=True)})

        smoke = FakeSmoke()

        extracted, errors = harness.collect_runtime_parameter_consumption_evidence(
            smoke,
            None,
            FakeConfig(),
            "token",
            injection,
        )
        consumption = harness.runtime_parameter_consumption_check(injection, extracted)
        updated = harness.apply_runtime_parameter_consumption_to_injection(injection, consumption)
        summary = harness._run_runtime_parameter_injection_summary([
            {
                "variant_id": injection["strategyVariantId"],
                "runtimeParameterInjection": updated,
            }
        ])

        expected = copy.deepcopy(evidence)
        expected["source"] = "Memory.rlRuntimePolicyParameters"
        self.assertEqual(extracted, expected)
        self.assertEqual(errors, [])
        self.assertEqual(smoke.calls, [{"path": "rlRuntimePolicyParameters", "shard": "shardX"}])
        self.assertTrue(consumption["runtimeParameterConsumption"])
        self.assertEqual(consumption["source"], "Memory.rlRuntimePolicyParameters")
        self.assertTrue(summary["runtimeParameterConsumption"])
        self.assertEqual(summary["consumedVariantCount"], 1)
        self.assertEqual(summary["runtimeParameterConsumptionStatus"], "consumed")

    def test_http_runtime_parameter_consumption_collection_materializes_default_branch_memory_evidence(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        branch_wrapped_memory = {
            "$activeWorld": {
                "default": {
                    "shardX": json.dumps(
                        {
                            "rlRuntimePolicyParameters": evidence,
                        },
                        sort_keys=True,
                    )
                }
            }
        }

        class Result:
            def __init__(self, payload: object) -> None:
                self.status = 200
                self.payload = payload

        class FakeConfig:
            server_url = "http://sim.local"
            shard = "shardX"

        class FakeSmoke:
            def token_headers(self, token: str) -> dict[str, str]:
                return {"X-Token": token}

            def http_json(
                self,
                method: str,
                base_url: str,
                path: str,
                *,
                headers: dict[str, str],
                params: dict[str, object],
                timeout: int,
            ) -> Result:
                _ = method, base_url, path, headers, params, timeout
                return Result({"ok": 1, "data": json.dumps(branch_wrapped_memory, sort_keys=True)})

        extracted, errors = harness.collect_runtime_parameter_consumption_evidence(
            FakeSmoke(),
            None,
            FakeConfig(),
            "token",
            injection,
        )
        consumption = harness.runtime_parameter_consumption_check(injection, extracted)
        updated = harness.apply_runtime_parameter_consumption_to_injection(injection, consumption)
        summary = harness._run_runtime_parameter_injection_summary([
            {
                "variant_id": injection["strategyVariantId"],
                "runtimeParameterInjection": updated,
            }
        ])

        expected = copy.deepcopy(evidence)
        expected["source"] = "Memory.rlRuntimePolicyParameters"
        self.assertEqual(extracted, expected)
        self.assertEqual(errors, [])
        self.assertTrue(summary["runtimeParameterConsumption"])
        self.assertEqual(summary["consumedVariantCount"], 1)
        self.assertEqual(summary["runtimeParameterConsumptionStatus"], "consumed")

    def test_http_runtime_parameter_consumption_collector_continues_after_probe_failures(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)

        class Result:
            def __init__(self, status: int, payload: object) -> None:
                self.status = status
                self.payload = payload

        class FakeConfig:
            server_url = "http://sim.local"
            shard = "shardX"

        class ProbeTransportError(RuntimeError):
            pass

        class FakeSmoke:
            calls: list[dict[str, object]] = []

            def token_headers(self, token: str) -> dict[str, str]:
                return {"X-Token": token}

            def http_json(
                self,
                method: str,
                base_url: str,
                path: str,
                *,
                headers: dict[str, str],
                params: dict[str, object],
                timeout: int,
            ) -> Result:
                _ = method, base_url, path, headers, timeout
                self.calls.append(dict(params))
                if len(self.calls) == 1:
                    raise ProbeTransportError("probe endpoint timed out")
                if len(self.calls) == 2:
                    return Result(503, {"ok": 0})
                return Result(200, {
                    "ok": 1,
                    "data": json.dumps({"rlRuntimePolicyParameters": evidence}, sort_keys=True),
                })

        smoke = FakeSmoke()

        extracted = harness._collect_http_runtime_parameter_consumption_evidence(
            smoke,
            None,
            FakeConfig(),
            "token",
            injection,
        )

        self.assertEqual(extracted, evidence)
        self.assertEqual(
            smoke.calls,
            [
                {"path": "rlRuntimePolicyParameters", "shard": "shardX"},
                {"path": "rlRuntimePolicyParameters"},
                {"shard": "shardX"},
            ],
        )

    def test_http_runtime_parameter_consumption_collector_uses_bounded_probe_timeout(self) -> None:
        class Result:
            status = 404
            payload: object = {"ok": 0}

        class FakeConfig:
            server_url = "http://sim.local"
            shard = "shardX"

        class FakeSmoke:
            timeouts: list[int] = []

            def token_headers(self, token: str) -> dict[str, str]:
                return {"X-Token": token}

            def http_json(
                self,
                method: str,
                base_url: str,
                path: str,
                *,
                headers: dict[str, str],
                params: dict[str, object],
                timeout: int,
            ) -> Result:
                _ = method, base_url, path, headers, params
                self.timeouts.append(timeout)
                return Result()

        smoke = FakeSmoke()

        extracted = harness._collect_http_runtime_parameter_consumption_evidence(
            smoke,
            None,
            FakeConfig(),
            "token",
        )

        self.assertIsNone(extracted)
        self.assertEqual(smoke.timeouts, [harness.RUN_API_TIMEOUT_SECONDS] * 4)
        self.assertLess(max(smoke.timeouts), harness.RUN_PHASE_TIMEOUT_SECONDS)
        self.assertLess(sum(smoke.timeouts), harness.RUN_PHASE_TIMEOUT_SECONDS)

    def test_runtime_parameter_consumption_prefers_matching_evidence(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        stale = self.runtime_parameter_consumption_evidence(injection)
        stale["strategyVariantId"] = "stale-variant"
        stale["candidatePolicyId"] = "stale-policy"
        matching = self.runtime_parameter_consumption_evidence(injection)
        payload = {
            "ok": True,
            "candidates": [
                {"source": "users.memory.rlRuntimePolicyParameters", "value": stale},
                {"source": "memory.rlRuntimePolicyParameters", "value": matching},
            ],
        }

        extracted = harness.find_runtime_parameter_consumption_evidence(payload, injection=injection)

        self.assertEqual(extracted, matching)

    def test_runtime_parameter_consumption_owner_filter_requires_configured_owner(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        ownerless = self.runtime_parameter_consumption_evidence(injection)
        current_user = self.runtime_parameter_consumption_evidence(injection)
        current_user["user"] = "bot"
        other_user = self.runtime_parameter_consumption_evidence(injection)
        other_user["user"] = "other-bot"

        self.assertFalse(harness.runtime_parameter_record_matches_username(ownerless, "bot"))
        self.assertTrue(harness.runtime_parameter_record_matches_username(current_user, "bot"))
        self.assertFalse(harness.runtime_parameter_record_matches_username(other_user, "bot"))
        self.assertIsNone(
            harness.find_runtime_parameter_consumption_evidence(
                {"ok": True, "candidates": [{"source": "redis.memory:unknown", "value": ownerless}]},
                injection=injection,
                owner_username="bot",
            )
        )
        self.assertEqual(
            harness.find_runtime_parameter_consumption_evidence(
                {"ok": True, "candidates": [{"source": "redis.memory:bot", "value": ownerless}]},
                injection=injection,
                owner_username="bot",
            ),
            ownerless,
        )
        self.assertEqual(
            harness.find_runtime_parameter_consumption_evidence(
                {
                    "ok": True,
                    "candidates": [
                        {
                            "source": "redis.memory:opaque",
                            "ownerUsername": "bot",
                            "value": ownerless,
                        }
                    ],
                },
                injection=injection,
                owner_username="bot",
            ),
            ownerless,
        )
        self.assertIsNone(
            harness.find_runtime_parameter_consumption_evidence(
                {"ok": True, "candidates": [{"source": "redis.memory:bot2", "value": ownerless}]},
                injection=injection,
                owner_username="bot",
            )
        )
        self.assertIsNone(
            harness.find_runtime_parameter_consumption_evidence(
                {
                    "ok": True,
                    "candidates": [
                        {
                            "source": "redis.memory:opaque",
                            "ownerUsername": "other-bot",
                            "value": ownerless,
                        }
                    ],
                },
                injection=injection,
                owner_username="bot",
            )
        )
        self.assertEqual(
            harness.find_runtime_parameter_consumption_evidence(
                {"ok": True, "candidates": [{"source": "redis.memory:bot", "value": current_user}]},
                injection=injection,
                owner_username="bot",
            ),
            current_user,
        )
        self.assertIsNone(
            harness.find_runtime_parameter_consumption_evidence(
                {"ok": True, "candidates": [{"source": "redis.memory:other", "value": other_user}]},
                injection=injection,
                owner_username="bot",
            )
        )

    def test_ownerless_redis_runtime_consumption_requires_target_scoped_source(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        ownerless = self.runtime_parameter_consumption_evidence(injection)

        cases: list[tuple[str, dict[str, object], harness.JsonObject | None]] = [
            (
                "unscoped-memory-key",
                {"source": "redis.memory:unknown.rlRuntimePolicyParameters", "value": ownerless},
                None,
            ),
            (
                "other-user-memory-key",
                {"source": "redis.memory:other.rlRuntimePolicyParameters", "value": ownerless},
                None,
            ),
            (
                "username-prefix-only",
                {"source": "redis.memory:bot2.rlRuntimePolicyParameters", "value": ownerless},
                None,
            ),
            (
                "target-user-memory-key",
                {"source": "redis.memory:bot.rlRuntimePolicyParameters", "value": ownerless},
                ownerless,
            ),
            (
                "target-user-wrapper",
                {
                    "source": "redis.memory:opaque.rlRuntimePolicyParameters",
                    "ownerUsername": "bot",
                    "value": ownerless,
                },
                ownerless,
            ),
        ]

        for name, candidate, expected in cases:
            with self.subTest(name=name):
                extracted = harness.find_runtime_parameter_consumption_evidence(
                    {"ok": True, "candidates": [candidate]},
                    injection=injection,
                    owner_username="bot",
                )

                self.assertEqual(extracted, expected)

    def test_runtime_parameter_consumption_collection_skips_stale_redis_for_valid_mongo(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        stale = self.runtime_parameter_consumption_evidence(injection)
        stale["strategyVariantId"] = "stale-variant"
        matching = self.runtime_parameter_consumption_evidence(injection)

        with (
            mock.patch.object(
                harness,
                "_collect_http_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
            mock.patch.object(
                harness,
                "_collect_redis_runtime_parameter_consumption_evidence",
                return_value=stale,
            ),
            mock.patch.object(
                harness,
                "_collect_mongo_runtime_parameter_consumption_evidence",
                return_value=matching,
            ),
        ):
            evidence, errors = harness.collect_runtime_parameter_consumption_evidence(
                object(),
                ["docker", "compose"],
                object(),
                None,
                injection,
            )

        expected = copy.deepcopy(matching)
        expected["source"] = "mongo.Memory.rlRuntimePolicyParameters"
        self.assertEqual(evidence, expected)
        self.assertEqual(len(errors), 1)
        self.assertIn(
            "redis.Memory.rlRuntimePolicyParameters returned non-matching runtime parameter consumption evidence",
            errors[0],
        )
        self.assertIn("strategyVariantId disagreed", errors[0])

    def test_runtime_parameter_consumption_collection_accepts_console_tick_evidence(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)

        with (
            mock.patch.object(
                harness,
                "_collect_http_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
            mock.patch.object(
                harness,
                "_collect_console_runtime_parameter_consumption_evidence",
                return_value=evidence,
            ),
            mock.patch.object(
                harness,
                "_collect_redis_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
            mock.patch.object(
                harness,
                "_collect_mongo_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
        ):
            extracted, errors = harness.collect_runtime_parameter_consumption_evidence(
                object(),
                ["docker", "compose"],
                object(),
                None,
                injection,
            )

        expected = copy.deepcopy(evidence)
        expected["source"] = "console.runtimePolicyParameterConsumption"
        self.assertEqual(extracted, expected)
        self.assertEqual(errors, [])

    def test_runtime_parameter_consumption_collection_retries_after_tick_race(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        calls = 0

        def fake_collect(*args: object, **kwargs: object) -> tuple[dict[str, object] | None, list[str]]:
            _ = args, kwargs
            nonlocal calls
            calls += 1
            if calls == 1:
                return None, []
            return evidence, []

        with mock.patch.object(
            harness,
            "collect_runtime_parameter_consumption_evidence",
            side_effect=fake_collect,
        ):
            with mock.patch.object(harness.time, "sleep", return_value=None) as sleep:
                extracted, errors = harness.collect_runtime_parameter_consumption_evidence_with_retries(
                    object(),
                    ["compose"],
                    object(),
                    "token",
                    injection,
                    max_attempts=3,
                    retry_seconds=0.25,
                )

        self.assertIs(extracted, evidence)
        self.assertEqual(errors, [])
        self.assertEqual(calls, 2)
        sleep.assert_called_once_with(0.25)

    def test_runtime_parameter_consumption_collection_retries_fail_closed_on_invalid_evidence(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        stale = self.runtime_parameter_consumption_evidence(injection)
        stale["parameters"] = {
            **stale["parameters"],
            "territorySignalWeight": stale["parameters"]["territorySignalWeight"] + 1,
        }
        fast_only_attempts: list[bool] = []

        def fake_collect(*args: object, **kwargs: object) -> tuple[dict[str, object] | None, list[str]]:
            _ = args
            fast_only_attempts.append(bool(kwargs.get("fast_only")))
            return stale, ["stale runtime parameter evidence"]

        with mock.patch.object(
            harness,
            "collect_runtime_parameter_consumption_evidence",
            side_effect=fake_collect,
        ):
            with mock.patch.object(harness.time, "sleep", return_value=None):
                extracted, errors = harness.collect_runtime_parameter_consumption_evidence_with_retries(
                    object(),
                    ["compose"],
                    object(),
                    "token",
                    injection,
                    max_attempts=2,
                    retry_seconds=0.25,
                )

        self.assertIsNone(extracted)
        self.assertEqual(fast_only_attempts, [False, True])
        self.assertIn("attempt 1: stale runtime parameter evidence", errors)
        self.assertIn("attempt 2: stale runtime parameter evidence", errors)
        self.assertTrue(
            any(
                "runtime parameter consumption evidence invalid: runtime policy parameter evidence parameters disagreed"
                in error
                for error in errors
            )
        )
        self.assertIn("no runtime parameter consumption evidence after 2 probe attempt(s)", errors[-1])

    def test_runtime_parameter_consumption_collection_retries_only_fast_sources(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()

        with (
            mock.patch.object(
                harness,
                "_collect_http_runtime_parameter_consumption_evidence",
                return_value=None,
            ) as http_collect,
            mock.patch.object(
                harness,
                "_collect_console_runtime_parameter_consumption_evidence",
                return_value=None,
            ) as console_collect,
            mock.patch.object(
                harness,
                "_collect_mongo_console_runtime_parameter_consumption_evidence",
                return_value=None,
            ) as mongo_console_collect,
            mock.patch.object(
                harness,
                "_collect_redis_runtime_parameter_consumption_evidence",
                return_value=None,
            ) as redis_collect,
            mock.patch.object(
                harness,
                "_collect_mongo_runtime_parameter_consumption_evidence",
                return_value=None,
            ) as mongo_collect,
            mock.patch.object(harness.time, "sleep", return_value=None),
        ):
            extracted, errors = harness.collect_runtime_parameter_consumption_evidence_with_retries(
                object(),
                ["compose"],
                object(),
                "token",
                injection,
                max_attempts=2,
                retry_seconds=0.25,
            )

        self.assertIsNone(extracted)
        self.assertEqual(http_collect.call_count, 2)
        self.assertEqual(console_collect.call_count, 1)
        self.assertEqual(mongo_console_collect.call_count, 1)
        self.assertEqual(redis_collect.call_count, 1)
        self.assertEqual(mongo_collect.call_count, 1)
        self.assertIn("retried Memory.rlRuntimePolicyParameters", errors[-1])

    def test_runtime_parameter_consumption_collection_retry_diagnostic_lists_sources(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()

        with mock.patch.object(
            harness,
            "collect_runtime_parameter_consumption_evidence",
            return_value=(None, []),
        ):
            with mock.patch.object(harness.time, "sleep", return_value=None):
                extracted, errors = harness.collect_runtime_parameter_consumption_evidence_with_retries(
                    object(),
                    ["compose"],
                    object(),
                    "token",
                    injection,
                    max_attempts=2,
                    retry_seconds=0.25,
                )

        self.assertIsNone(extracted)
        self.assertIn("no runtime parameter consumption evidence after 2 probe attempt(s)", errors[-1])
        self.assertIn("Memory.rlRuntimePolicyParameters", errors[-1])
        self.assertIn("mongo.Memory.rlRuntimePolicyParameters", errors[-1])

    def test_runtime_parameter_consumption_collection_accepts_mongo_console_tick_evidence(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        line = harness.RUNTIME_PARAMETER_CONSUMPTION_LOG_PREFIX + json.dumps(evidence, sort_keys=True)

        class FakeConfig:
            mongo_db = "screeps"
            username = "bot"
            shard = "shardX"

        class FakeSmoke:
            command: list[str] | None = None

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                self.command = command
                if "logs" in command:
                    return {"returncode": 0, "output_excerpt": "private server logs without Screeps console output"}
                if "mongosh" in command:
                    return {
                        "returncode": 0,
                        "output_excerpt": json.dumps({
                            "ok": True,
                            "lines": ["noise", line],
                            "collectionNames": ["users.console"],
                        }),
                    }
                raise AssertionError(command)

        with (
            mock.patch.object(
                harness,
                "_collect_http_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
            mock.patch.object(
                harness,
                "_collect_redis_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
            mock.patch.object(
                harness,
                "_collect_mongo_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
        ):
            extracted, errors = harness.collect_runtime_parameter_consumption_evidence(
                FakeSmoke(),
                ["docker", "compose"],
                FakeConfig(),
                None,
                injection,
            )

        expected = copy.deepcopy(evidence)
        expected["source"] = "mongo.console.runtimePolicyParameterConsumption"
        self.assertEqual(extracted, expected)
        self.assertEqual(errors, [])

        consumption = harness.runtime_parameter_consumption_check(injection, extracted)
        updated = harness.apply_runtime_parameter_consumption_to_injection(injection, consumption)
        summary = harness._run_runtime_parameter_injection_summary([
            {
                "variant_id": "construction-priority.pg.territory-seed.v1",
                "runtimeParameterInjection": updated,
            }
        ])

        self.assertTrue(summary["runtimeParameterConsumption"])
        self.assertEqual(summary["consumedVariantCount"], 1)
        self.assertEqual(summary["runtimeParameterConsumptionStatus"], "consumed")

    def test_mongo_console_runtime_parameter_consumption_collector_bounds_payload_before_output_limit(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        line = harness.RUNTIME_PARAMETER_CONSUMPTION_LOG_PREFIX + json.dumps(evidence, sort_keys=True)
        unbounded_payload = json.dumps({
            "ok": True,
            "lines": ["x" * 4000 for _ in range(200)],
            "scannedCollections": 24,
            "scannedDocuments": 200,
            "collectionNames": ["users.console"],
        })

        class FakeConfig:
            mongo_db = "screeps"
            username = "bot"
            shard = "shardX"

        captured: dict[str, object] = {}

        class FakeSmoke:
            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout
                captured["eval_script"] = command[-1]
                captured["output_limit"] = output_limit
                return {
                    "returncode": 0,
                    "output_excerpt": json.dumps({
                        "ok": True,
                        "lines": [line],
                        "collectionNames": ["users.console"],
                    }),
                }

        extracted = harness._collect_mongo_console_runtime_parameter_consumption_evidence(
            FakeSmoke(),
            ["docker", "compose"],
            FakeConfig(),
            None,
            injection,
        )

        self.assertEqual(extracted, evidence)
        self.assertGreater(len(unbounded_payload), harness.MONGO_CONSOLE_RUNTIME_PARAMETER_OUTPUT_LIMIT)
        self.assertEqual(captured["output_limit"], harness.MONGO_CONSOLE_RUNTIME_PARAMETER_OUTPUT_LIMIT)
        self.assertLess(
            harness.MONGO_CONSOLE_RUNTIME_PARAMETER_PAYLOAD_LIMIT,
            harness.MONGO_CONSOLE_RUNTIME_PARAMETER_OUTPUT_LIMIT,
        )
        eval_script = str(captured["eval_script"])
        self.assertIn(
            f"const payloadLimit = {harness.MONGO_CONSOLE_RUNTIME_PARAMETER_PAYLOAD_LIMIT};",
            eval_script,
        )
        self.assertIn("while (jsonText.length > payloadLimit && lines.length > 0)", eval_script)
        self.assertIn("lines.pop();", eval_script)
        self.assertIn("print(jsonText);", eval_script)

    def test_mongo_console_runtime_parameter_consumption_collector_falls_back_per_collection(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()

        class FakeConfig:
            mongo_db = "screeps"
            username = "bot"
            shard = "shardX"

        captured: dict[str, object] = {}

        class FakeSmoke:
            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                captured["eval_script"] = command[-1]
                return {
                    "returncode": 0,
                    "output_excerpt": json.dumps({
                        "ok": True,
                        "lines": [],
                        "collectionNames": ["users.console", "rooms.log"],
                    }),
                }

        extracted = harness._collect_mongo_console_runtime_parameter_consumption_evidence(
            FakeSmoke(),
            ["docker", "compose"],
            FakeConfig(),
            None,
            injection,
        )

        self.assertIsNone(extracted)
        eval_script = str(captured["eval_script"])
        self.assertIn("const beforeLineCount = lines.length;", eval_script)
        self.assertIn("return lines.length > beforeLineCount;", eval_script)
        self.assertIn("let collectionAddedLines = false;", eval_script)
        self.assertIn(
            "collectionAddedLines = scanCollection(collectionName, {$or: userClauses}) || collectionAddedLines;",
            eval_script,
        )
        self.assertIn("if (!collectionAddedLines && lines.length < candidateLimit)", eval_script)
        self.assertNotIn("if (lines.length === 0)", eval_script)

    def test_runtime_parameter_consumption_collection_records_mongo_console_probe_error(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()

        class FakeConfig:
            mongo_db = "screeps"
            username = "bot"
            shard = "shardX"

        class FakeSmoke:
            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                if "logs" in command:
                    return {"returncode": 0, "output_excerpt": "private server logs without Screeps console output"}
                if "mongosh" in command:
                    return {"returncode": 17, "output_excerpt": "mongosh console query failed"}
                raise AssertionError(command)

        with (
            mock.patch.object(
                harness,
                "_collect_http_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
            mock.patch.object(
                harness,
                "_collect_redis_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
            mock.patch.object(
                harness,
                "_collect_mongo_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
        ):
            evidence, errors = harness.collect_runtime_parameter_consumption_evidence(
                FakeSmoke(),
                ["docker", "compose"],
                FakeConfig(),
                None,
                injection,
            )

        self.assertIsNone(evidence)
        self.assertEqual(len(errors), 1)
        self.assertIn("mongo.console.runtimePolicyParameterConsumption failed", errors[0])
        self.assertIn("mongo console runtime-parameter probe failed: exit=17", errors[0])
        self.assertIn("mongosh console query failed", errors[0])

    def test_runtime_parameter_consumption_collection_records_mongo_console_malformed_json(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()

        class FakeConfig:
            mongo_db = "screeps"
            username = "bot"
            shard = "shardX"

        class FakeSmoke:
            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                if "logs" in command:
                    return {"returncode": 0, "output_excerpt": "private server logs without Screeps console output"}
                if "mongosh" in command:
                    return {"returncode": 0, "output_excerpt": "not-json"}
                raise AssertionError(command)

        with (
            mock.patch.object(
                harness,
                "_collect_http_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
            mock.patch.object(
                harness,
                "_collect_redis_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
            mock.patch.object(
                harness,
                "_collect_mongo_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
        ):
            evidence, errors = harness.collect_runtime_parameter_consumption_evidence(
                FakeSmoke(),
                ["docker", "compose"],
                FakeConfig(),
                None,
                injection,
            )

        self.assertIsNone(evidence)
        self.assertEqual(len(errors), 1)
        self.assertIn("mongo.console.runtimePolicyParameterConsumption failed", errors[0])
        self.assertIn("mongo console runtime-parameter probe returned malformed JSON", errors[0])
        self.assertIn("not-json", errors[0])

    def test_runtime_parameter_consumption_collection_records_console_probe_error(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()

        class FakeSmoke:
            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = command, cfg, timeout, output_limit
                return {"returncode": 17, "output_excerpt": "compose logs failed"}

        with (
            mock.patch.object(
                harness,
                "_collect_http_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
            mock.patch.object(
                harness,
                "_collect_redis_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
            mock.patch.object(
                harness,
                "_collect_mongo_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
        ):
            evidence, errors = harness.collect_runtime_parameter_consumption_evidence(
                FakeSmoke(),
                ["docker", "compose"],
                object(),
                None,
                injection,
            )

        self.assertIsNone(evidence)
        self.assertEqual(len(errors), 1)
        self.assertIn("console.runtimePolicyParameterConsumption failed", errors[0])
        self.assertIn("console runtime-parameter probe failed: exit=17", errors[0])
        self.assertIn("compose logs failed", errors[0])

    def test_runtime_parameter_consumption_collection_surfaces_invalid_only_evidence(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        stale = self.runtime_parameter_consumption_evidence(injection)
        stale["parameters"] = {
            **stale["parameters"],
            "territorySignalWeight": stale["parameters"]["territorySignalWeight"] + 1,
        }

        with (
            mock.patch.object(
                harness,
                "_collect_http_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
            mock.patch.object(
                harness,
                "_collect_redis_runtime_parameter_consumption_evidence",
                return_value=stale,
            ),
            mock.patch.object(
                harness,
                "_collect_mongo_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
        ):
            evidence, errors = harness.collect_runtime_parameter_consumption_evidence(
                object(),
                ["docker", "compose"],
                object(),
                None,
                injection,
            )

        self.assertIsNotNone(evidence)
        if evidence is None:
            self.fail("expected invalid runtime parameter consumption evidence")
        self.assertEqual(evidence["source"], "redis.Memory.rlRuntimePolicyParameters")
        self.assertEqual(len(errors), 1)
        self.assertIn("parameters disagreed", errors[0])

        consumption = harness.runtime_parameter_consumption_check(
            injection,
            evidence,
            source_errors=errors,
        )

        self.assertEqual(consumption["status"], "invalid")
        self.assertFalse(consumption["runtimeParameterConsumption"])
        self.assertEqual(consumption["source"], "redis.Memory.rlRuntimePolicyParameters")
        self.assertIn("parameters disagreed", consumption["reason"])

    def test_runtime_parameter_consumption_collection_records_redis_probe_error(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()

        with (
            mock.patch.object(
                harness,
                "_collect_http_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
            mock.patch.object(
                harness,
                "_collect_redis_runtime_parameter_consumption_evidence",
                side_effect=RuntimeError("redis runtime-parameter probe returned malformed JSON: not-json"),
            ),
            mock.patch.object(
                harness,
                "_collect_mongo_runtime_parameter_consumption_evidence",
                return_value=None,
            ),
        ):
            evidence, errors = harness.collect_runtime_parameter_consumption_evidence(
                object(),
                ["docker", "compose"],
                object(),
                None,
                injection,
            )

        self.assertIsNone(evidence)
        self.assertEqual(len(errors), 1)
        self.assertIn("redis.Memory.rlRuntimePolicyParameters failed", errors[0])
        self.assertIn("malformed JSON", errors[0])

        consumption = harness.runtime_parameter_consumption_check(
            injection,
            evidence,
            source_errors=errors,
        )

        self.assertEqual(consumption["status"], "missing")
        self.assertFalse(consumption["runtimeParameterConsumption"])
        self.assertIn("redis.Memory.rlRuntimePolicyParameters failed", consumption["reason"])

    def test_redis_runtime_parameter_consumption_collector_reads_private_memory(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        evidence["user"] = "bot"

        class FakeConfig:
            shard = "shardX"
            username = "bot"

        class FakeSmoke:
            command: list[str] | None = None

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                self.command = command
                return {
                    "returncode": 0,
                    "output_excerpt": json.dumps({
                        "ok": True,
                        "candidates": [
                            {
                                "source": "redis.memory:user.rlRuntimePolicyParameters",
                                "value": evidence,
                            }
                        ],
                    }),
                }

        smoke = FakeSmoke()

        extracted = harness._collect_redis_runtime_parameter_consumption_evidence(
            smoke,
            ["docker", "compose"],
            FakeConfig(),
            None,
            injection,
        )

        self.assertEqual(extracted, evidence)
        self.assertIsNotNone(smoke.command)
        command = smoke.command if smoke.command is not None else []
        self.assertEqual(command[:2], ["docker", "compose"])
        self.assertIn("exec", command)
        self.assertIn("redis", command)
        self.assertIn("redis-cli", command)
        eval_script = command[-3]
        self.assertIn("SCAN", eval_script)
        self.assertIn("*memory*", eval_script)
        self.assertIn("*Memory*", eval_script)
        self.assertIn("redisGlobLiteral", eval_script)
        self.assertIn('"*memory*" .. escapedUsername .. "*"', eval_script)
        self.assertIn('"*" .. escapedUsername .. "*Memory*"', eval_script)
        self.assertIn("scanMemoryPattern(pattern, false)", eval_script)
        self.assertIn("if #candidates == 0 then", eval_script)
        self.assertEqual(command[-2:], ["0", "bot"])
        self.assertIn("pcall(cjson.decode, value)", eval_script)
        self.assertIn('decoded.type == "screeps-rl-runtime-policy-parameter-consumption"', eval_script)
        self.assertIn("decoded.rlRuntimePolicyParameters", eval_script)
        self.assertIn("expectedUsername = tostring(ARGV[1] or \"\")", eval_script)
        self.assertIn("hasDifferentExplicitOwner", eval_script)
        self.assertIn("scalarOwnerUsername(value.user)", eval_script)
        self.assertIn("keyMatchesExpectedUsername(keyText)", eval_script)
        self.assertIn("candidateMatchesExpectedOwner", eval_script)
        self.assertIn("candidate.ownerUsername = expectedUsername", eval_script)
        self.assertNotIn("KEYS", eval_script)
        self.assertNotIn('table.insert(candidates, {source = "redis." .. keyText, value = value})', eval_script)

    def test_redis_runtime_parameter_consumption_collector_reads_hash_backed_memory(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        evidence["user"] = "bot"

        class FakeConfig:
            shard = "shardX"
            username = "bot"

        class FakeSmoke:
            command: list[str] | None = None
            output_excerpt: str | None = None

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                self.command = command
                eval_script = command[-3]
                candidates: list[dict[str, object]] = []
                bounded_hash_scan_supported = all(
                    token in eval_script
                    for token in (
                        'keyType == "hash"',
                        "scanHashMemoryFields",
                        "hscanCountLimit = 32",
                        "maxHashHscanCalls = 8",
                        "maxHashFields = 256",
                        "scannedCount",
                        "hashScanStats.scannedFields",
                        "hashScanStats.skippedFields",
                        'redis.call("HSCAN", key, hashCursor, "COUNT", hscanCountLimit)',
                        "candidateLimitReached()",
                    )
                )
                if bounded_hash_scan_supported:
                    simulated_more_than_limit_fields = [
                        {
                            "source": f"redis.memory:bot.rlRuntimePolicyParameters.{index}",
                            "value": evidence,
                        }
                        for index in range(40)
                    ]
                    candidates.extend(simulated_more_than_limit_fields[:32])
                self.output_excerpt = json.dumps({
                    "ok": True,
                    "candidates": candidates,
                    "candidateLimitReached": len(candidates) >= 32,
                    "hashScanStats": {
                        "scannedFields": len(candidates),
                        "skippedFields": 40 - len(candidates),
                    },
                })
                return {
                    "returncode": 0,
                    "output_excerpt": self.output_excerpt,
                }

        smoke = FakeSmoke()

        extracted = harness._collect_redis_runtime_parameter_consumption_evidence(
            smoke,
            ["docker", "compose"],
            FakeConfig(),
            None,
            injection,
        )

        self.assertEqual(extracted, evidence)
        self.assertIsNotNone(smoke.command)
        eval_script = smoke.command[-3] if smoke.command is not None else ""
        self.assertIn("scanHashMemoryFields", eval_script)
        self.assertIn("hashFieldMayContainRuntimePolicyParameters", eval_script)
        self.assertIn("HSCAN", eval_script)
        self.assertIn("local hscanCountLimit = 32", eval_script)
        self.assertIn("local maxHashHscanCalls = 8", eval_script)
        self.assertIn("local maxHashFields = 256", eval_script)
        self.assertIn('redis.call("HSCAN", key, hashCursor, "COUNT", hscanCountLimit)', eval_script)
        self.assertIn('while hscanCallCount == 0 or hashCursor ~= "0" do', eval_script)
        self.assertIn("if scannedCount >= maxHashFields then", eval_script)
        self.assertIn("if candidateLimitReached() then", eval_script)
        self.assertIn("hashScanBudgetExhausted = true", eval_script)
        self.assertIn("hashScanStats.scannedFields", eval_script)
        self.assertIn("hashScanStats.skippedFields", eval_script)
        self.assertIn("candidateLimitReached = candidateLimitReached()", eval_script)
        self.assertIn("hashScanStats = hashScanStats", eval_script)
        self.assertIsNotNone(smoke.output_excerpt)
        output = json.loads(smoke.output_excerpt or "{}")
        self.assertLessEqual(len(output["candidates"]), 32)
        self.assertEqual(output["hashScanStats"]["scannedFields"], 32)
        self.assertEqual(output["hashScanStats"]["skippedFields"], 8)

    def test_redis_runtime_parameter_consumption_collector_filters_hash_fields_before_decode(self) -> None:
        class FakeConfig:
            shard = "shardX"
            username = "bot"

        class FakeSmoke:
            command: list[str] | None = None

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                self.command = command
                return {"returncode": 0, "output_excerpt": json.dumps({"ok": True, "candidates": []})}

        smoke = FakeSmoke()

        extracted = harness._collect_redis_runtime_parameter_consumption_evidence(
            smoke,
            ["docker", "compose"],
            FakeConfig(),
            None,
        )

        self.assertIsNone(extracted)
        self.assertIsNotNone(smoke.command)
        eval_script = smoke.command[-3] if smoke.command is not None else ""
        self.assertIn('string.find(keyLower, "runtime", 1, true) ~= nil', eval_script)
        self.assertIn('or keyText == "data"', eval_script)
        self.assertIn('or keyText == "value"', eval_script)
        self.assertIn("fieldMatchesExpectedUsername = keyMatchesExpectedUsername(fieldText)", eval_script)
        self.assertIn(
            "if hashFieldMayContainRuntimePolicyParameters(fieldText) or fieldMatchesExpectedUsername then",
            eval_script,
        )
        self.assertNotIn('string.find(fieldLower, "memory"', eval_script)
        self.assertNotIn("keyMayContainMemory", eval_script)
        self.assertNotIn("or ownerMatched or fieldOwnerMatched", eval_script)

    def test_redis_runtime_parameter_consumption_collector_reads_shard_hash_memory_fields(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)

        class FakeConfig:
            shard = "shardX"
            username = "bot"

        class FakeSmoke:
            command: list[str] | None = None
            output_excerpt: str | None = None

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                self.command = command
                eval_script = command[-3]
                supports_shard_hash_memory = (
                    "hashFieldMayContainRuntimePolicyParameters(fieldText)" in eval_script
                    and 'string.match(keyText, "^[Ss]hard[%w_-]+$") ~= nil' in eval_script
                    and 'keyText == "$activeWorld"' in eval_script
                )
                candidates = []
                if supports_shard_hash_memory:
                    candidates.append({
                        "source": "redis.memory:bot.shardX.rlRuntimePolicyParameters",
                        "value": evidence,
                    })
                self.output_excerpt = json.dumps({"ok": True, "candidates": candidates})
                return {"returncode": 0, "output_excerpt": self.output_excerpt}

        smoke = FakeSmoke()

        extracted = harness._collect_redis_runtime_parameter_consumption_evidence(
            smoke,
            ["docker", "compose"],
            FakeConfig(),
            None,
            injection,
        )

        self.assertEqual(extracted, evidence)
        self.assertIsNotNone(smoke.command)
        eval_script = smoke.command[-3] if smoke.command is not None else ""
        self.assertIn('keyText == "$activeWorld"', eval_script)
        self.assertIn('string.match(keyText, "^[Ss]hard[%w_-]+$") ~= nil', eval_script)

    def test_redis_runtime_parameter_consumption_collector_reads_shard_string_memory_containers(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)

        class FakeConfig:
            shard = "shardX"
            username = "bot"

        class FakeSmoke:
            command: list[str] | None = None
            output_excerpt: str | None = None

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                self.command = command
                eval_script = command[-3]
                supports_shard_containers = (
                    "runtimePolicyParameterContainerKey(key)" in eval_script
                    and "pushRuntimePolicyParameterEvidence(source .. \".\" .. key" in eval_script
                    and 'string.match(keyText, "^[Ss]hard[%w_-]+$") ~= nil' in eval_script
                    and 'keyText == "default"' in eval_script
                )
                candidates = []
                if supports_shard_containers:
                    candidates.append({
                        "source": "redis.memory:bot.data.default.shardX.rlRuntimePolicyParameters",
                        "value": evidence,
                    })
                self.output_excerpt = json.dumps({"ok": True, "candidates": candidates})
                return {"returncode": 0, "output_excerpt": self.output_excerpt}

        smoke = FakeSmoke()

        extracted = harness._collect_redis_runtime_parameter_consumption_evidence(
            smoke,
            ["docker", "compose"],
            FakeConfig(),
            None,
            injection,
        )

        self.assertEqual(extracted, evidence)
        self.assertIsNotNone(smoke.command)
        eval_script = smoke.command[-3] if smoke.command is not None else ""
        self.assertIn("runtimePolicyParameterContainerKey(key)", eval_script)
        self.assertIn("pushRuntimePolicyParameterEvidence(source .. \".\" .. key", eval_script)
        self.assertIn('keyText == "default"', eval_script)

    def test_redis_runtime_parameter_consumption_collector_requires_configured_username(self) -> None:
        class FakeConfig:
            shard = "shardX"

        class FakeSmoke:
            called = False

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = command, cfg, timeout, output_limit
                self.called = True
                return {"returncode": 0, "output_excerpt": "{}"}

        smoke = FakeSmoke()

        extracted = harness._collect_redis_runtime_parameter_consumption_evidence(
            smoke,
            ["docker", "compose"],
            FakeConfig(),
            None,
        )

        self.assertIsNone(extracted)
        self.assertFalse(smoke.called)

    def test_redis_runtime_parameter_consumption_collector_returns_minimal_policy_subobjects(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)

        class FakeConfig:
            shard = "shardX"
            username = "bot"

        class FakeSmoke:
            command: list[str] | None = None
            output_excerpt: str | None = None

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout
                self.command = command
                eval_script = command[-3]
                raw_memory = {
                    "creeps": {
                        "Worker1": {
                            "memory": {
                                "role": "worker",
                                "largeUnrelatedState": "x" * output_limit,
                            },
                        },
                    },
                    "rooms": {"E1S1": {"largeUnrelatedState": "y" * output_limit}},
                    "rlRuntimePolicyParameters": evidence,
                }
                candidates: list[dict[str, object]] = []
                if (
                    "pcall(cjson.decode, value)" in eval_script
                    and "decoded.rlRuntimePolicyParameters" in eval_script
                    and "genericScanRan = genericScanRan" in eval_script
                ):
                    candidates.append({
                        "source": "redis.memory:bot.rlRuntimePolicyParameters",
                        "ownerUsername": "bot",
                        "value": raw_memory["rlRuntimePolicyParameters"],
                    })
                self.output_excerpt = json.dumps({"ok": True, "candidates": candidates})
                return {"returncode": 0, "output_excerpt": self.output_excerpt}

        smoke = FakeSmoke()

        extracted = harness._collect_redis_runtime_parameter_consumption_evidence(
            smoke,
            ["docker", "compose"],
            FakeConfig(),
            None,
            injection,
        )

        self.assertEqual(extracted, evidence)
        self.assertIsNotNone(smoke.command)
        self.assertIsNotNone(smoke.output_excerpt)
        output_excerpt = smoke.output_excerpt or ""
        self.assertLess(len(output_excerpt), 200000)
        self.assertNotIn("largeUnrelatedState", output_excerpt)
        self.assertNotIn("Worker1", output_excerpt)
        eval_script = smoke.command[-3] if smoke.command is not None else ""
        self.assertIn("pcall(cjson.decode, value)", eval_script)
        self.assertIn("decoded.rlRuntimePolicyParameters", eval_script)
        self.assertIn("scanPatterns = {", eval_script)
        self.assertIn("if #candidates == 0 then", eval_script)
        self.assertNotIn('table.insert(candidates, {source = "redis." .. keyText, value = value})', eval_script)

    def test_redis_runtime_parameter_consumption_collector_extracts_nested_memory_evidence(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        evidence["ownerUsername"] = "bot"

        class FakeConfig:
            shard = "shardX"
            username = "bot"

        class FakeSmoke:
            command: list[str] | None = None
            output_excerpt: str | None = None

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout
                self.command = command
                eval_script = command[-3]
                nested_prefilter_supported = all(
                    token in eval_script
                    for token in (
                        "pushRuntimePolicyParameterEvidence",
                        "runtimeParameterConsumption",
                        "runtimePolicyParameterConsumption",
                        "__SCREEPS_RL_RUNTIME_POLICY_PARAMETER_CONSUMPTION__",
                        "candidateLimit = 32",
                        "candidateMaxDepth = 6",
                    )
                )
                raw_memory = {
                    "creeps": {
                        "Worker1": {
                            "memory": {
                                "role": "worker",
                                "largeUnrelatedState": "x" * output_limit,
                            },
                        },
                    },
                    "runtimeParameterConsumption": evidence,
                }
                candidates = []
                if nested_prefilter_supported:
                    candidates.append({
                        "source": "redis.memory:user.runtimeParameterConsumption",
                        "value": raw_memory["runtimeParameterConsumption"],
                    })
                self.output_excerpt = json.dumps({"ok": True, "candidates": candidates})
                return {"returncode": 0, "output_excerpt": self.output_excerpt}

        smoke = FakeSmoke()

        extracted = harness._collect_redis_runtime_parameter_consumption_evidence(
            smoke,
            ["docker", "compose"],
            FakeConfig(),
            None,
            injection,
        )

        self.assertEqual(extracted, evidence)
        self.assertIsNotNone(smoke.command)
        self.assertIsNotNone(smoke.output_excerpt)
        eval_script = smoke.command[-3] if smoke.command is not None else ""
        output_excerpt = smoke.output_excerpt or ""
        self.assertLess(len(output_excerpt), 200000)
        self.assertNotIn("largeUnrelatedState", output_excerpt)
        self.assertIn("nestedRuntimePolicyParameterKeys", eval_script)
        self.assertIn("decoded.candidates", eval_script)
        self.assertNotIn('table.insert(candidates, {source = "redis." .. keyText, value = value})', eval_script)
        self.assertNotIn('source = source .. ".memory", value = decoded.memory', eval_script)
        self.assertNotIn('source = source .. ".data", value = decoded.data', eval_script)

    def test_redis_runtime_parameter_consumption_collector_reads_direct_consumption_evidence(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)
        evidence["owner"] = "bot"

        class FakeConfig:
            shard = "shardX"
            username = "bot"

        class FakeSmoke:
            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = command, cfg, timeout, output_limit
                return {
                    "returncode": 0,
                    "output_excerpt": json.dumps({
                        "ok": True,
                        "candidates": [{"source": "redis.Memory:user", "value": evidence}],
                    }),
                }

        extracted = harness._collect_redis_runtime_parameter_consumption_evidence(
            FakeSmoke(),
            ["docker", "compose"],
            FakeConfig(),
            None,
            injection,
        )

        self.assertEqual(extracted, evidence)

    def test_redis_runtime_parameter_consumption_collector_filters_explicit_other_owner(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        ownerless = self.runtime_parameter_consumption_evidence(injection)
        current_user = self.runtime_parameter_consumption_evidence(injection)
        current_user["user"] = "bot"
        nested_current_user = self.runtime_parameter_consumption_evidence(injection)
        nested_current_user["user"] = {"username": "bot"}
        other_user = self.runtime_parameter_consumption_evidence(injection)
        other_user["user"] = "other-bot"

        class FakeConfig:
            shard = "shardX"
            username = "bot"

        class FakeSmoke:
            command: list[str] | None = None

            def __init__(self, candidates: list[dict[str, object]]) -> None:
                self.candidates = candidates

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                self.command = command
                return {
                    "returncode": 0,
                    "output_excerpt": json.dumps({"ok": True, "candidates": self.candidates}),
                }

        cases: list[tuple[str, list[dict[str, object]], harness.JsonObject | None]] = [
            (
                "other-user-only",
                [{"source": "redis.memory:other.rlRuntimePolicyParameters", "value": other_user}],
                None,
            ),
            (
                "current-user",
                [{"source": "redis.memory:bot.rlRuntimePolicyParameters", "value": current_user}],
                current_user,
            ),
            (
                "nested-current-user",
                [{"source": "redis.memory:bot.rlRuntimePolicyParameters", "value": nested_current_user}],
                nested_current_user,
            ),
            (
                "ownerless",
                [{"source": "redis.memory:unknown.rlRuntimePolicyParameters", "value": ownerless}],
                None,
            ),
            (
                "ownerless-scoped-key",
                [{"source": "redis.memory:bot.rlRuntimePolicyParameters", "value": ownerless}],
                ownerless,
            ),
            (
                "ownerless-key-token-prefix-only",
                [{"source": "redis.memory:bot2.rlRuntimePolicyParameters", "value": ownerless}],
                None,
            ),
            (
                "skip-other-user-then-accept-current-user",
                [
                    {"source": "redis.memory:other.rlRuntimePolicyParameters", "value": other_user},
                    {"source": "redis.memory:bot.rlRuntimePolicyParameters", "value": current_user},
                ],
                current_user,
            ),
        ]

        for name, candidates, expected in cases:
            with self.subTest(name=name):
                smoke = FakeSmoke(candidates)
                extracted = harness._collect_redis_runtime_parameter_consumption_evidence(
                    smoke,
                    ["docker", "compose"],
                    FakeConfig(),
                    None,
                    injection,
                )

                self.assertEqual(extracted, expected)
                self.assertIsNotNone(smoke.command)
                command = smoke.command if smoke.command is not None else []
                self.assertEqual(command[-2:], ["0", "bot"])

    def test_redis_runtime_parameter_consumption_collector_scans_generic_after_stale_target_hit(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        stale = self.runtime_parameter_consumption_evidence(injection)
        stale["owner"] = "bot"
        stale["strategyVariantId"] = "stale-variant"
        matching = self.runtime_parameter_consumption_evidence(injection)
        matching["owner"] = "bot"

        class FakeConfig:
            shard = "shardX"
            username = "bot"

        class FakeSmoke:
            commands: list[list[str]]

            def __init__(self) -> None:
                self.commands = []

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                self.commands.append(command)
                if command[-1] == "generic":
                    return {
                        "returncode": 0,
                        "output_excerpt": json.dumps({
                            "ok": True,
                            "genericScanRan": True,
                            "candidates": [{"source": "redis.Memory", "value": matching}],
                        }),
                    }
                return {
                    "returncode": 0,
                    "output_excerpt": json.dumps({
                        "ok": True,
                        "genericScanRan": False,
                        "candidates": [
                            {"source": "redis.memory:bot.rlRuntimePolicyParameters", "value": stale}
                        ],
                    }),
                }

        smoke = FakeSmoke()

        extracted = harness._collect_redis_runtime_parameter_consumption_evidence(
            smoke,
            ["docker", "compose"],
            FakeConfig(),
            None,
            injection,
        )

        self.assertEqual(extracted, matching)
        self.assertEqual(len(smoke.commands), 2)
        self.assertEqual(smoke.commands[0][-2:], ["0", "bot"])
        self.assertEqual(smoke.commands[1][-3:], ["0", "bot", "generic"])
        eval_script = smoke.commands[0][smoke.commands[0].index("EVAL") + 1]
        self.assertIn('scanMode == "generic"', eval_script)
        self.assertIn("skipExpectedUsernameKeys", eval_script)
        self.assertIn("genericScanRan", eval_script)

    def test_redis_runtime_parameter_consumption_collector_scans_generic_after_lua_scan_stop(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        stale = self.runtime_parameter_consumption_evidence(injection)
        stale["owner"] = "bot"
        stale["strategyVariantId"] = "stale-variant"
        matching = self.runtime_parameter_consumption_evidence(injection)
        matching["owner"] = "bot"

        class FakeConfig:
            shard = "shardX"
            username = "bot"

        class FakeSmoke:
            commands: list[list[str]]

            def __init__(self, stop_flag: str) -> None:
                self.commands = []
                self.stop_flag = stop_flag

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                self.commands.append(command)
                if command[-1] == "generic":
                    return {
                        "returncode": 0,
                        "output_excerpt": json.dumps({
                            "ok": True,
                            "genericScanRan": True,
                            "candidates": [{"source": "redis.Memory", "value": matching}],
                        }),
                    }
                return {
                    "returncode": 0,
                    "output_excerpt": json.dumps({
                        "ok": True,
                        "genericScanRan": False,
                        "candidateLimitReached": self.stop_flag == "candidateLimitReached",
                        "hashScanBudgetExhausted": self.stop_flag == "hashScanBudgetExhausted",
                        "hashScanStats": {"scannedFields": 256, "skippedFields": 1},
                        "candidates": [
                            {"source": "redis.memory:bot.rlRuntimePolicyParameters", "value": stale}
                        ],
                    }),
                }

        for stop_flag in ("candidateLimitReached", "hashScanBudgetExhausted"):
            with self.subTest(stop_flag=stop_flag):
                smoke = FakeSmoke(stop_flag)

                extracted = harness._collect_redis_runtime_parameter_consumption_evidence(
                    smoke,
                    ["docker", "compose"],
                    FakeConfig(),
                    None,
                    injection,
                )

                self.assertEqual(extracted, matching)
                self.assertEqual(len(smoke.commands), 2)
                self.assertEqual(smoke.commands[0][-2:], ["0", "bot"])
                self.assertEqual(smoke.commands[1][-3:], ["0", "bot", "generic"])

    def test_redis_runtime_parameter_consumption_collector_limits_generic_after_noisy_lua_scan_stop(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        stale_candidates = []
        for index in range(32):
            stale = self.runtime_parameter_consumption_evidence(injection)
            stale["owner"] = "bot"
            stale["strategyVariantId"] = f"stale-variant-{index}"
            stale_candidates.append({
                "source": f"redis.memory:bot.rlRuntimePolicyParameters.{index}",
                "value": stale,
            })

        class FakeConfig:
            shard = "shardX"
            username = "bot"

        class FakeSmoke:
            commands: list[list[str]]

            def __init__(self, stop_flag: str) -> None:
                self.commands = []
                self.stop_flag = stop_flag

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                self.commands.append(command)
                if command[-1] == "generic":
                    return {
                        "returncode": 0,
                        "output_excerpt": json.dumps({
                            "ok": True,
                            "genericScanRan": True,
                            "candidateLimitReached": True,
                            "hashScanBudgetExhausted": False,
                            "candidates": [],
                        }),
                    }
                return {
                    "returncode": 0,
                    "output_excerpt": json.dumps({
                        "ok": True,
                        "genericScanRan": False,
                        "candidateLimitReached": self.stop_flag == "candidateLimitReached",
                        "hashScanBudgetExhausted": self.stop_flag == "hashScanBudgetExhausted",
                        "hashScanStats": {"scannedFields": 256, "skippedFields": 1024},
                        "candidates": stale_candidates,
                    }),
                }

        for stop_flag in ("candidateLimitReached", "hashScanBudgetExhausted"):
            with self.subTest(stop_flag=stop_flag):
                smoke = FakeSmoke(stop_flag)

                extracted = harness._collect_redis_runtime_parameter_consumption_evidence(
                    smoke,
                    ["docker", "compose"],
                    FakeConfig(),
                    None,
                    injection,
                )

                self.assertEqual(extracted, stale_candidates[0]["value"])
                self.assertEqual(len(smoke.commands), 2)
                self.assertEqual(smoke.commands[0][-2:], ["0", "bot"])
                self.assertEqual(smoke.commands[1][-3:], ["0", "bot", "generic"])
                eval_script = smoke.commands[1][smoke.commands[1].index("EVAL") + 1]
                self.assertIn("local candidateLimit = 32", eval_script)
                self.assertIn("local maxHashHscanCalls = 8", eval_script)
                self.assertIn("local maxHashFields = 256", eval_script)
                self.assertIn('scanMode == "generic"', eval_script)

    def test_redis_runtime_parameter_consumption_collector_fails_closed_without_proof(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()

        class FakeConfig:
            shard = "shardX"
            username = "bot"

        class FakeSmoke:
            def __init__(self, output_excerpt: object) -> None:
                self.output_excerpt = output_excerpt

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = command, cfg, timeout, output_limit
                return {"returncode": 0, "output_excerpt": self.output_excerpt}

        for output_excerpt in (
            json.dumps({
                "ok": True,
                "candidates": [{"source": "redis.memory:user", "value": {"notRuntimeEvidence": True}}],
            }),
        ):
            with self.subTest(output_excerpt=output_excerpt):
                extracted = harness._collect_redis_runtime_parameter_consumption_evidence(
                    FakeSmoke(output_excerpt),
                    ["docker", "compose"],
                    FakeConfig(),
                    None,
                    injection,
                )
                consumption = harness.runtime_parameter_consumption_check(injection, extracted)

                self.assertIsNone(extracted)
                self.assertEqual(consumption["status"], "missing")
                self.assertFalse(consumption["runtimeParameterConsumption"])

    def test_redis_runtime_parameter_consumption_collector_raises_on_probe_failure(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()

        class FakeConfig:
            shard = "shardX"
            username = "bot"

        class FakeSmoke:
            def __init__(self, returncode: int, output_excerpt: object) -> None:
                self.returncode = returncode
                self.output_excerpt = output_excerpt

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = command, cfg, timeout, output_limit
                return {"returncode": self.returncode, "output_excerpt": self.output_excerpt}

        cases = [
            ("nonzero-exit", 1, "ERR Lua execution failed", "redis runtime-parameter probe failed"),
            ("malformed-json", 0, "not-json", "redis runtime-parameter probe returned malformed JSON"),
        ]

        for name, returncode, output_excerpt, expected_error in cases:
            with self.subTest(name=name):
                with self.assertRaisesRegex(RuntimeError, expected_error):
                    harness._collect_redis_runtime_parameter_consumption_evidence(
                        FakeSmoke(returncode, output_excerpt),
                        ["docker", "compose"],
                        FakeConfig(),
                        None,
                        injection,
                    )

    def test_mongo_runtime_parameter_consumption_collector_keeps_output_small(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)

        class FakeConfig:
            mongo_db = "screeps"
            username = "bot"
            shard = "shardX"

        class FakeSmoke:
            command: list[str] | None = None

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                self.command = command
                return {
                    "returncode": 0,
                    "output_excerpt": json.dumps({
                        "ok": True,
                        "candidates": [{"source": "users.memory.rlRuntimePolicyParameters", "value": evidence}],
                    }),
                }

        smoke = FakeSmoke()

        extracted = harness._collect_mongo_runtime_parameter_consumption_evidence(
            smoke,
            ["docker", "compose"],
            FakeConfig(),
            None,
        )

        self.assertEqual(extracted, evidence)
        self.assertIsNotNone(smoke.command)
        eval_script = smoke.command[-1] if smoke.command is not None else ""
        self.assertNotIn("pushCandidate('users.memory', user.memory)", eval_script)
        self.assertNotIn("pushCandidate(collectionName, record)", eval_script)
        self.assertIn("rlRuntimePolicyParameters", eval_script)

    def test_mongo_runtime_parameter_consumption_collector_reads_shard_memory_containers(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)

        class FakeConfig:
            mongo_db = "screeps"
            username = "bot"
            shard = "shardX"

        class FakeSmoke:
            command: list[str] | None = None
            output_excerpt: str | None = None

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                self.command = command
                eval_script = command[-1]
                supports_shard_containers = (
                    "/^shard[\\w-]*$/i.test(key)" in eval_script
                    and "key === '$activeWorld'" in eval_script
                    and "key === 'default'" in eval_script
                    and "pushRuntimePolicyParameterCandidate(source + '.' + key, nested, depth + 1)" in eval_script
                )
                candidates = []
                if supports_shard_containers:
                    candidates.append({
                        "source": "users.memory.data.default.shardX.rlRuntimePolicyParameters",
                        "value": evidence,
                    })
                self.output_excerpt = json.dumps({"ok": True, "candidates": candidates})
                return {"returncode": 0, "output_excerpt": self.output_excerpt}

        smoke = FakeSmoke()

        extracted = harness._collect_mongo_runtime_parameter_consumption_evidence(
            smoke,
            ["docker", "compose"],
            FakeConfig(),
            None,
            injection,
        )

        self.assertEqual(extracted, evidence)
        self.assertIsNotNone(smoke.command)
        eval_script = smoke.command[-1] if smoke.command is not None else ""
        self.assertIn("/^shard[\\w-]*$/i.test(key)", eval_script)
        self.assertIn("key === '$activeWorld'", eval_script)
        self.assertIn("key === 'default'", eval_script)

    def test_mongo_runtime_parameter_consumption_collector_dedupes_predefined_keys(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        matching = self.runtime_parameter_consumption_evidence(injection)
        stale = self.runtime_parameter_consumption_evidence(injection)
        stale["parameters"] = {
            **stale["parameters"],
            "territorySignalWeight": stale["parameters"]["territorySignalWeight"] + 1,
        }

        class FakeConfig:
            mongo_db = "screeps"
            username = "bot"
            shard = "shardX"

        class FakeSmoke:
            command: list[str] | None = None

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                self.command = command
                eval_script = command[-1]
                has_predefined_key_guard = (
                    "const predefinedKeys = new Set([" in eval_script
                    and "!predefinedKeys.has(key) && fieldMayContainRuntimePolicyParameters(key)" in eval_script
                )
                candidates = [
                    {
                        "source": f"users.memory.data.rlRuntimePolicyParameters.{index}",
                        "value": stale,
                    }
                    for index in range(32)
                ]
                if has_predefined_key_guard:
                    candidates = [
                        *candidates[:31],
                        {"source": "users.memory.runtimeEvidence", "value": matching},
                    ]
                return {"returncode": 0, "output_excerpt": json.dumps({"ok": True, "candidates": candidates})}

        smoke = FakeSmoke()

        extracted = harness._collect_mongo_runtime_parameter_consumption_evidence(
            smoke,
            ["docker", "compose"],
            FakeConfig(),
            None,
            injection,
        )

        self.assertEqual(extracted, matching)
        self.assertIsNotNone(smoke.command)
        eval_script = smoke.command[-1] if smoke.command is not None else ""
        self.assertIn("const predefinedKeys = new Set([", eval_script)
        self.assertIn("!predefinedKeys.has(key) && fieldMayContainRuntimePolicyParameters(key)", eval_script)

    def test_mongo_runtime_parameter_consumption_collector_traverses_array_payloads(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = self.runtime_parameter_consumption_evidence(injection)

        class FakeConfig:
            mongo_db = "screeps"
            username = "bot"
            shard = "shardX"

        class FakeSmoke:
            command: list[str] | None = None

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
                output_limit: int,
            ) -> dict[str, object]:
                _ = cfg, timeout, output_limit
                self.command = command
                eval_script = command[-1]
                supports_array_payloads = (
                    "Array.isArray(parsed)" in eval_script
                    and "source + '[' + index + ']'" in eval_script
                )
                candidates = []
                if supports_array_payloads:
                    candidates.append({"source": "users.memory[0]", "value": evidence})
                return {"returncode": 0, "output_excerpt": json.dumps({"ok": True, "candidates": candidates})}

        smoke = FakeSmoke()

        extracted = harness._collect_mongo_runtime_parameter_consumption_evidence(
            smoke,
            ["docker", "compose"],
            FakeConfig(),
            None,
            injection,
        )

        self.assertEqual(extracted, evidence)
        self.assertIsNotNone(smoke.command)
        eval_script = smoke.command[-1] if smoke.command is not None else ""
        self.assertIn("Array.isArray(parsed)", eval_script)
        self.assertIn("source + '[' + index + ']'", eval_script)

    def test_runtime_parameter_summary_separates_upload_from_consumption(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        consumption = harness.runtime_parameter_consumption_check(injection, None)
        updated = harness.apply_runtime_parameter_consumption_to_injection(injection, consumption)

        summary = harness._run_runtime_parameter_injection_summary([
            {
                "variant_id": "construction-priority.pg.territory-seed.v1",
                "runtimeParameterInjection": updated,
            }
        ])

        self.assertEqual(summary["status"], "injected")
        self.assertTrue(summary["runtimeParameterInjection"])
        self.assertFalse(summary["runtimeParameterConsumption"])
        self.assertEqual(summary["runtimeParameterConsumptionStatus"], "missing")
        self.assertEqual(summary["injectedVariantCount"], 1)
        self.assertEqual(summary["consumedVariantCount"], 0)
        self.assertFalse(summary["variants"][0]["runtimeParameterConsumption"])

    def test_runtime_parameter_summary_consumption_boolean_is_existential(self) -> None:
        consumed_injection = self.uploaded_runtime_parameter_injection()
        missing_injection = self.uploaded_runtime_parameter_injection()
        consumed = harness.apply_runtime_parameter_consumption_to_injection(
            consumed_injection,
            harness.runtime_parameter_consumption_check(
                consumed_injection,
                self.runtime_parameter_consumption_evidence(consumed_injection),
            ),
        )
        missing = harness.apply_runtime_parameter_consumption_to_injection(
            missing_injection,
            harness.runtime_parameter_consumption_check(missing_injection, None),
        )

        summary = harness._run_runtime_parameter_injection_summary([
            {
                "variant_id": "construction-priority.pg.territory-seed.v1",
                "runtimeParameterInjection": consumed,
            },
            {
                "variant_id": "construction-priority.pg.territory-seed.v2",
                "runtimeParameterInjection": missing,
            },
        ])

        self.assertTrue(summary["runtimeParameterConsumption"])
        self.assertEqual(summary["runtimeParameterConsumptionStatus"], "partial")
        self.assertEqual(summary["consumedVariantCount"], 1)
        self.assertEqual(summary["variantCount"], 2)
        self.assertEqual(summary["variants"][0]["runtimeParameterConsumerVersion"], harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_VERSION)
        self.assertEqual(summary["variants"][0]["consumedParametersSha256"], consumed_injection["parametersSha256"])
        self.assertEqual(summary["variants"][0]["consumedStrategyVariantId"], consumed_injection["strategyVariantId"])
        self.assertFalse(summary["variants"][1]["runtimeParameterConsumption"])
        self.assertEqual(summary["variants"][1]["runtimeParameterConsumptionStatus"], "missing")
        self.assertNotIn("runtimeParameterConsumerVersion", summary["variants"][1])
        self.assertNotIn("consumedParametersSha256", summary["variants"][1])
        self.assertNotIn("consumedStrategyVariantId", summary["variants"][1])

    def test_active_code_readback_summary_compares_uploaded_main_by_hash(self) -> None:
        uploaded = "module.exports.loop = function loop() { return 1; };\n"

        matched = harness.private_simulator_active_code_readback_summary(
            uploaded,
            {"branch": "default", "modules": {"main": uploaded}},
            branch="default",
            http_status=200,
        )
        mismatched = harness.private_simulator_active_code_readback_summary(
            uploaded,
            {"branch": "default", "modules": {"main": uploaded + "// stale\n"}},
            branch="default",
            http_status=200,
        )
        branch_mismatched = harness.private_simulator_active_code_readback_summary(
            uploaded,
            {"branch": "stale-branch", "modules": {"main": uploaded}},
            branch="default",
            http_status=200,
        )
        branchless_matched = harness.private_simulator_active_code_readback_summary(
            uploaded,
            {"modules": {"main": uploaded}},
            branch="default",
            http_status=200,
        )
        branchless_mismatched = harness.private_simulator_active_code_readback_summary(
            uploaded,
            {"modules": {"main": uploaded + "// stale\n"}},
            branch="default",
            http_status=200,
        )

        self.assertEqual(matched["status"], "matched")
        self.assertTrue(matched["activeCodeMatchesUploaded"])
        self.assertEqual(matched["uploadedCodeSha256"], matched["activeCodeSha256"])
        self.assertEqual(mismatched["status"], "mismatch")
        self.assertFalse(mismatched["activeCodeMatchesUploaded"])
        self.assertEqual(branch_mismatched["status"], "branch-mismatch")
        self.assertFalse(branch_mismatched["activeCodeMatchesUploaded"])
        self.assertEqual(branchless_matched["status"], "matched")
        self.assertTrue(branchless_matched["activeCodeMatchesUploaded"])
        self.assertNotIn("activeBranch", branchless_matched)
        self.assertEqual(branchless_mismatched["status"], "mismatch")
        self.assertFalse(branchless_mismatched["activeCodeMatchesUploaded"])
        self.assertIn(
            "active private-server code hash verification failed",
            harness.private_simulator_active_code_readback_error(mismatched) or "",
        )

    def test_active_code_readback_poll_accepts_branchless_matching_payload(self) -> None:
        uploaded = "module.exports.loop = function loop() { return 1; };\n"

        class Cfg:
            server_url = "http://127.0.0.1:21000"

        class Result:
            status = 200
            payload = {"ok": 1, "modules": {"main": uploaded}}
            headers: dict[str, str] = {}

        class FakeSmoke:
            def __init__(self) -> None:
                self.http_calls = 0

            def token_headers(self, token: str) -> dict[str, str]:
                return {"X-Token": token}

            def update_token_from_headers(self, token: str, headers: dict[str, str]) -> str:
                _ = headers
                return token

            def http_json(self, *_args: object, **_kwargs: object) -> Result:
                self.http_calls += 1
                return Result()

        smoke = FakeSmoke()
        with tempfile.TemporaryDirectory() as temp_dir:
            token, readback = harness._poll_private_simulator_active_code_readback(
                smoke,
                Cfg(),
                "token",
                uploaded,
                branch="default",
                output_path=Path(temp_dir) / "active_code_readback.json",
            )

        self.assertEqual(token, "token")
        self.assertEqual(smoke.http_calls, 1)
        self.assertEqual(readback["status"], "matched")
        self.assertTrue(readback["activeCodeMatchesUploaded"])
        self.assertNotIn("activeBranch", readback)

    def test_active_code_readback_poll_retries_transport_error_with_diagnostics(self) -> None:
        uploaded = "module.exports.loop = function loop() { return 1; };\n"
        writes: list[harness.JsonObject] = []

        class Cfg:
            server_url = "http://127.0.0.1:21000"

        class Result:
            def __init__(self) -> None:
                self.status = 200
                self.payload = {"branch": "default", "modules": {"main": uploaded}}
                self.headers = {"X-Token": "next-token"}

        class FakeSmoke:
            def __init__(self) -> None:
                self.http_calls = 0
                self.update_calls = 0

            def token_headers(self, token: str) -> dict[str, str]:
                return {"X-Token": token}

            def update_token_from_headers(self, token: str, headers: dict[str, str]) -> str:
                self.update_calls += 1
                self.updated_headers = headers
                return f"{token}-rotated"

            def http_json(self, *_args: object, **_kwargs: object) -> Result:
                self.http_calls += 1
                if self.http_calls == 1:
                    raise TimeoutError("readback timed out")
                return Result()

        def capture_write(path: Path, payload: harness.JsonObject) -> None:
            _ = path
            writes.append(copy.deepcopy(payload))

        smoke = FakeSmoke()
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "active_code_readback.json"
            with mock.patch.object(harness, "write_json_atomic", side_effect=capture_write):
                with mock.patch.object(harness.time, "sleep", return_value=None) as sleep:
                    token, readback = harness._poll_private_simulator_active_code_readback(
                        smoke,
                        Cfg(),
                        "token",
                        uploaded,
                        branch="default",
                        output_path=output_path,
                    )

        self.assertEqual(token, "token-rotated")
        self.assertEqual(smoke.http_calls, 2)
        self.assertEqual(smoke.update_calls, 1)
        sleep.assert_called_once_with(harness.RUN_TICK_POLL_SECONDS)
        self.assertEqual(len(writes), 2)
        self.assertEqual(writes[0]["status"], "transport-error")
        self.assertEqual(writes[0]["attempt"], 1)
        self.assertEqual(writes[0]["maxAttempts"], harness.ACTIVE_CODE_READBACK_MAX_ATTEMPTS)
        self.assertEqual(writes[0]["exceptionType"], "TimeoutError")
        self.assertIn("readback timed out", writes[0]["error"])
        self.assertNotIn("httpStatus", writes[0])
        self.assertEqual(readback["status"], "matched")
        self.assertEqual(readback["attempt"], 2)

    def test_runtime_parameter_trainability_smoke_gate_blocks_missing_consumption(self) -> None:
        code = "module.exports.loop = function loop() {};"
        injection = self.uploaded_runtime_parameter_injection()
        readback = harness.private_simulator_active_code_readback_summary(
            code,
            {"branch": "default", "modules": {"main": code}},
            branch="default",
            http_status=200,
        )
        missing = harness.runtime_parameter_consumption_check(injection, None)
        unticked_consumed = harness.runtime_parameter_consumption_check(
            injection,
            self.runtime_parameter_consumption_evidence(injection),
        )
        consumed_evidence = self.runtime_parameter_consumption_evidence(injection)
        consumed_evidence["tick"] = 1
        consumed = harness.runtime_parameter_consumption_check(
            injection,
            consumed_evidence,
        )
        injection_before_consumption_tick = copy.deepcopy(injection)
        injection_before_consumption_tick["tick"] = 0
        injection_at_tick = copy.deepcopy(injection)
        injection_at_tick["tick"] = 1
        stale_tick_consumption = copy.deepcopy(consumed)
        stale_tick_consumption["consumedTick"] = 1

        self.assertIn(
            "runtime-parameter trainability smoke gate failed",
            harness.runtime_parameter_trainability_smoke_gate_error(
                runtime_parameter_injection=injection,
                runtime_parameter_consumption=missing,
                ticks_run=1,
                active_code_readback=readback,
            )
            or "",
        )
        self.assertIn(
            "missing positive consumedTick",
            harness.runtime_parameter_trainability_smoke_gate_error(
                runtime_parameter_injection=injection,
                runtime_parameter_consumption=unticked_consumed,
                ticks_run=1,
                active_code_readback=readback,
            )
            or "",
        )
        self.assertIn(
            "missing numeric injection tick",
            harness.runtime_parameter_trainability_smoke_gate_error(
                runtime_parameter_injection=injection,
                runtime_parameter_consumption=consumed,
                ticks_run=1,
                active_code_readback=readback,
            )
            or "",
        )
        self.assertIn(
            "did not advance beyond injection tick",
            harness.runtime_parameter_trainability_smoke_gate_error(
                runtime_parameter_injection=injection_at_tick,
                runtime_parameter_consumption=stale_tick_consumption,
                ticks_run=1,
                active_code_readback=readback,
            )
            or "",
        )
        self.assertIsNone(
            harness.runtime_parameter_trainability_smoke_gate_error(
                runtime_parameter_injection=injection_before_consumption_tick,
                runtime_parameter_consumption=consumed,
                ticks_run=1,
                active_code_readback=readback,
            )
        )

    def test_direct_game_loop_runtime_parameter_consumption_evidence_validates(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = harness.direct_game_loop_runtime_parameter_consumption_evidence(
            injection,
            [
                {"tick": 19},
                {
                    "tick": 20,
                    "rooms": {"W1N1": {"creeps": 1}},
                    "runtimeParameterConsumption": True,
                    "consumedParametersSha256": injection["parametersSha256"],
                    "consumedStrategyVariantId": injection["strategyVariantId"],
                },
            ],
        )

        self.assertIsNotNone(evidence)
        assert evidence is not None
        self.assertEqual(evidence["source"], harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE)
        self.assertTrue(evidence["directRuntimeEvaluation"])
        self.assertEqual(evidence["tick"], 20)
        consumption = harness.runtime_parameter_consumption_check(injection, evidence)
        self.assertTrue(consumption["runtimeParameterConsumption"])
        self.assertEqual(consumption["status"], "consumed")
        self.assertEqual(consumption["evaluatedParameters"], injection["parameters"])
        self.assertEqual(consumption["source"], harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE)
        self.assertFalse(consumption["officialMmoWrites"])

    def test_direct_game_loop_runtime_parameter_consumption_without_runtime_signal_fails_closed(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = harness.direct_game_loop_runtime_parameter_consumption_evidence(
            injection,
            [{"tick": 20, "rooms": {"W1N1": {"creeps": 1}}}],
        )

        self.assertIsNotNone(evidence)
        assert evidence is not None
        self.assertEqual(evidence["source"], harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE)
        self.assertTrue(evidence["directRuntimeEvaluation"])
        self.assertFalse(evidence["consumed"])
        self.assertEqual(evidence["tick"], 20)
        self.assertNotIn("parameters", evidence)
        self.assertNotIn("consumedParametersSha256", evidence)
        consumption = harness.runtime_parameter_consumption_check(injection, evidence)
        self.assertFalse(consumption["runtimeParameterConsumption"])
        self.assertEqual(consumption["status"], "invalid")
        self.assertEqual(consumption["source"], harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE)
        self.assertIn("did not mark the payload consumed", consumption["reason"])

    def test_direct_game_loop_runtime_parameter_consumption_preserves_false_signal(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = harness.direct_game_loop_runtime_parameter_consumption_evidence(
            injection,
            [
                {
                    "tick": 20,
                    "runtimeParameterConsumption": False,
                    "consumedParametersSha256": injection["parametersSha256"],
                    "consumedStrategyVariantId": injection["strategyVariantId"],
                }
            ],
        )

        self.assertIsNotNone(evidence)
        assert evidence is not None
        self.assertFalse(evidence["consumed"])
        consumption = harness.runtime_parameter_consumption_check(injection, evidence)
        self.assertFalse(consumption["runtimeParameterConsumption"])
        self.assertEqual(consumption["status"], "invalid")
        self.assertEqual(consumption["source"], harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE)

    def test_direct_game_loop_fallback_accepts_active_code_backed_runtime_parameters(self) -> None:
        injection, uploaded_code = self.uploaded_runtime_parameter_injection_with_code(upload_tick=18)
        readback = harness.private_simulator_active_code_readback_summary(
            uploaded_code,
            {"branch": "default", "modules": {"main": uploaded_code}},
            branch="default",
            http_status=200,
        )
        missing_consumption = harness.runtime_parameter_consumption_check(
            injection,
            None,
            source_errors=[
                "no runtime parameter consumption evidence after 3 probe attempt(s)",
                "checked Memory.rlRuntimePolicyParameters, console.runtimePolicyParameterConsumption, mongo.console",
            ],
        )

        consumption = harness.runtime_parameter_consumption_with_direct_game_loop_fallback(
            injection,
            missing_consumption,
            [
                {"tick": 19, "rooms": {"W1N1": {"creeps": 1}}},
                {"tick": 20, "rooms": {"W1N1": {"creeps": 2}}},
            ],
            active_code_readback=readback,
        )

        active_injection = readback["activeRuntimeParameterInjection"]
        self.assertEqual(active_injection["strategyVariantId"], injection["strategyVariantId"])
        self.assertEqual(active_injection["parametersSha256"], injection["parametersSha256"])
        self.assertEqual(active_injection["parametersSha256FromParameters"], injection["parametersSha256"])
        self.assertEqual(consumption["status"], "consumed")
        self.assertTrue(consumption["runtimeParameterConsumption"])
        self.assertEqual(consumption["source"], harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE)
        self.assertEqual(consumption["consumedTick"], 20)
        self.assertEqual(consumption["evaluatedParameters"], injection["parameters"])
        self.assertEqual(consumption["consumedParametersSha256"], injection["parametersSha256"])
        self.assertEqual(consumption["consumedStrategyVariantId"], injection["strategyVariantId"])
        self.assertEqual(consumption["fallbackRuntimeParameterConsumptionStatus"], "missing")
        self.assertFalse(consumption["officialMmoWrites"])
        self.assertIsNone(
            harness.runtime_parameter_trainability_smoke_gate_error(
                runtime_parameter_injection=harness.apply_runtime_parameter_consumption_to_injection(
                    injection,
                    consumption,
                ),
                runtime_parameter_consumption=consumption,
                ticks_run=2,
                active_code_readback=readback,
            )
        )

    def test_direct_game_loop_active_code_path_fails_closed_for_invalid_proof_inputs(self) -> None:
        injection, uploaded_code = self.uploaded_runtime_parameter_injection_with_code(upload_tick=18)
        readback = harness.private_simulator_active_code_readback_summary(
            uploaded_code,
            {"branch": "default", "modules": {"main": uploaded_code}},
            branch="default",
            http_status=200,
        )

        cases = []
        missing_parameters = copy.deepcopy(injection)
        missing_parameters.pop("parameters", None)
        cases.append(("missing_parameters", missing_parameters, readback, [{"tick": 20, "rooms": {"W1N1": {}}}]))
        mismatched_hash = copy.deepcopy(injection)
        mismatched_hash["parametersSha256"] = "0" * 64
        cases.append(("mismatched_hash", mismatched_hash, readback, [{"tick": 20, "rooms": {"W1N1": {}}}]))
        wrong_variant = copy.deepcopy(injection)
        wrong_variant["strategyVariantId"] = "construction-priority.pg.wrong-seed.v1"
        cases.append(("wrong_variant", wrong_variant, readback, [{"tick": 20, "rooms": {"W1N1": {}}}]))
        unsafe_injection = copy.deepcopy(injection)
        unsafe_injection["officialMmoWritesAllowed"] = True
        cases.append(("unsafe_injection", unsafe_injection, readback, [{"tick": 20, "rooms": {"W1N1": {}}}]))
        unsafe_readback = copy.deepcopy(readback)
        unsafe_readback["liveEffect"] = True
        cases.append(("unsafe_readback", injection, unsafe_readback, [{"tick": 20, "rooms": {"W1N1": {}}}]))
        unsafe_tick = [{"tick": 20, "officialMmoWritesAllowed": True, "rooms": {"W1N1": {}}}]
        cases.append(("unsafe_tick", injection, readback, unsafe_tick))

        for name, candidate_injection, candidate_readback, tick_log in cases:
            with self.subTest(name=name):
                missing = harness.runtime_parameter_consumption_check(candidate_injection, None)
                consumption = harness.runtime_parameter_consumption_with_direct_game_loop_fallback(
                    candidate_injection,
                    missing,
                    tick_log,
                    active_code_readback=candidate_readback,
                )

                self.assertFalse(consumption["runtimeParameterConsumption"])
                self.assertNotEqual(
                    consumption.get("source"),
                    harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE,
                )

    def test_direct_game_loop_active_code_path_fails_closed_for_tuple_wrapped_unsafe_flags(self) -> None:
        injection, uploaded_code = self.uploaded_runtime_parameter_injection_with_code(upload_tick=18)
        readback = harness.private_simulator_active_code_readback_summary(
            uploaded_code,
            {"branch": "default", "modules": {"main": uploaded_code}},
            branch="default",
            http_status=200,
        )
        missing = harness.runtime_parameter_consumption_check(injection, None)

        consumption = harness.runtime_parameter_consumption_with_direct_game_loop_fallback(
            injection,
            missing,
            [
                {"tick": 19, "rooms": {"W1N1": {"creeps": 1}}},
                {
                    "tick": 20,
                    "rooms": {"W1N1": ({"officialMmoWritesAllowed": True},)},
                },
            ],
            active_code_readback=readback,
        )

        self.assertFalse(consumption["runtimeParameterConsumption"])
        self.assertNotEqual(
            consumption.get("source"),
            harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE,
        )
        self.assertEqual(consumption["directRuntimeEvaluationStatus"], "invalid")

    def test_direct_game_loop_active_code_path_preserves_explicit_false_consumed_signal(self) -> None:
        injection, uploaded_code = self.uploaded_runtime_parameter_injection_with_code(upload_tick=18)
        readback = harness.private_simulator_active_code_readback_summary(
            uploaded_code,
            {"branch": "default", "modules": {"main": uploaded_code}},
            branch="default",
            http_status=200,
        )
        missing = harness.runtime_parameter_consumption_check(injection, None)

        consumption = harness.runtime_parameter_consumption_with_direct_game_loop_fallback(
            injection,
            missing,
            [
                {
                    "tick": 20,
                    "runtimeParameterConsumption": False,
                    "consumedParametersSha256": injection["parametersSha256"],
                    "consumedStrategyVariantId": injection["strategyVariantId"],
                }
            ],
            active_code_readback=readback,
        )

        self.assertFalse(consumption["runtimeParameterConsumption"])
        self.assertEqual(consumption["status"], "missing")
        self.assertEqual(consumption["directRuntimeEvaluationStatus"], "invalid")
        self.assertIn("did not mark the payload consumed", consumption["directRuntimeEvaluationReason"])

    def test_direct_game_loop_runtime_parameter_consumption_skips_non_numeric_trailing_ticks(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        evidence = harness.direct_game_loop_runtime_parameter_consumption_evidence(
            injection,
            [
                {
                    "tick": 20,
                    "runtimeParameterConsumption": True,
                    "consumedParametersSha256": injection["parametersSha256"],
                    "consumedStrategyVariantId": injection["strategyVariantId"],
                },
                {"tick": "bad", "rooms": {"W1N1": {"creeps": 1}}},
            ],
        )

        self.assertIsNotNone(evidence)
        assert evidence is not None
        self.assertEqual(evidence["source"], harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE)
        self.assertTrue(evidence["directRuntimeEvaluation"])
        self.assertEqual(evidence["tick"], 20)
        consumption = harness.runtime_parameter_consumption_check(injection, evidence)
        self.assertEqual(consumption["status"], "consumed")
        self.assertEqual(consumption["evaluatedParameters"], injection["parameters"])

    def test_direct_game_loop_runtime_parameter_consumption_requires_observed_tick(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()

        self.assertIsNone(
            harness.direct_game_loop_runtime_parameter_consumption_evidence(
                injection,
                [{"rooms": {"W1N1": {"creeps": 1}}}],
            )
        )

    def test_direct_game_loop_fallback_preserves_invalid_standard_consumption_without_runtime_signal(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        invalid_evidence = self.runtime_parameter_consumption_evidence(injection)
        invalid_evidence["parameters"] = {
            **invalid_evidence["parameters"],
            "territorySignalWeight": invalid_evidence["parameters"]["territorySignalWeight"] + 1,
        }
        invalid_consumption = harness.runtime_parameter_consumption_check(injection, invalid_evidence)

        consumption = harness.runtime_parameter_consumption_with_direct_game_loop_fallback(
            injection,
            invalid_consumption,
            [{"tick": 20, "rooms": {"W1N1": {"creeps": 1}}}],
        )

        self.assertEqual(consumption["status"], "invalid")
        self.assertFalse(consumption["runtimeParameterConsumption"])
        self.assertIn("disagreed", consumption["reason"])
        self.assertNotEqual(consumption.get("source"), harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE)

    def test_direct_game_loop_fallback_preserves_missing_collector_failure_without_runtime_signal(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        missing_consumption = harness.runtime_parameter_consumption_check(
            injection,
            None,
            source_errors=["redis evidence unavailable"],
        )

        consumption = harness.runtime_parameter_consumption_with_direct_game_loop_fallback(
            injection,
            missing_consumption,
            [{"tick": 20, "rooms": {"W1N1": {"creeps": 1}}}],
        )

        self.assertEqual(consumption["status"], "missing")
        self.assertFalse(consumption["runtimeParameterConsumption"])
        self.assertIn("redis evidence unavailable", consumption["reason"])
        self.assertNotEqual(consumption.get("source"), harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE)
        self.assertTrue(consumption["directRuntimeEvaluation"])
        self.assertEqual(consumption["consumptionMode"], "direct_simulator_game_loop")
        self.assertEqual(consumption["directRuntimeEvaluationStatus"], "invalid")
        self.assertIn("did not mark the payload consumed", consumption["directRuntimeEvaluationReason"])

    def test_direct_game_loop_fallback_preserves_missing_failure_for_unconsumed_tick_memory(self) -> None:
        injection = self.uploaded_runtime_parameter_injection()
        unconsumed_evidence = self.runtime_parameter_consumption_evidence(injection)
        unconsumed_evidence["consumed"] = False
        tick_entry = harness._build_tick_entry(
            "shardX",
            "E1S1",
            20,
            {"ok": 1, "rooms": ["E1S1"], "gametime": 20},
            {"terrain": [{"room": "E1S1", "terrain": "0" * 2500}]},
            {
                "E1S1": {
                    "room": "E1S1",
                    "roomData": {
                        "user": {"id": "user-1", "username": "rl-sim"},
                        "controller": {"level": 1, "my": True},
                        "objects": [
                            {
                                "type": "creep",
                                "user": "user-1",
                                "memory": {
                                    "role": "worker",
                                    "rlRuntimePolicyParameters": unconsumed_evidence,
                                },
                            }
                        ],
                    },
                }
            },
        )
        missing_consumption = harness.runtime_parameter_consumption_check(
            injection,
            None,
            source_errors=["redis evidence unavailable"],
        )

        self.assertFalse(
            tick_entry["rooms"]["E1S1"]["runtimeParameterConsumption"]["consumed"],
        )
        consumption = harness.runtime_parameter_consumption_with_direct_game_loop_fallback(
            injection,
            missing_consumption,
            [tick_entry],
        )

        self.assertEqual(consumption["status"], "missing")
        self.assertFalse(consumption["runtimeParameterConsumption"])
        self.assertIn("redis evidence unavailable", consumption["reason"])
        self.assertNotEqual(consumption.get("source"), harness.RUNTIME_PARAMETER_DIRECT_GAME_LOOP_CONSUMPTION_SOURCE)
        self.assertTrue(consumption["directRuntimeEvaluation"])
        self.assertEqual(consumption["directRuntimeEvaluationStatus"], "invalid")
        self.assertIn("did not mark the payload consumed", consumption["directRuntimeEvaluationReason"])

    def uploaded_runtime_parameter_injection_with_code(
        self,
        *,
        upload_tick: int | None = None,
    ) -> tuple[harness.JsonObject, str]:
        base_code = (
            '"use strict";\n'
            f'var runtimePolicyConsumer = "{harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
            "module.exports.loop = function loop() { return 1; };\n"
        )
        variant = {
            "id": "construction-priority.pg.territory-seed.v1",
            "candidatePolicyId": "construction-priority.pg.territory-seed.v1",
            "family": "construction-priority",
            "parameters": {
                "baseScoreWeight": 1,
                "territorySignalWeight": 22,
                "resourceSignalWeight": 3,
                "killSignalWeight": 5,
                "riskPenalty": 4,
            },
        }
        injection = harness.runtime_parameter_injection_for_variant(variant["id"], variant)
        upload = harness.apply_runtime_parameter_injection_to_code(base_code, injection)
        uploaded = harness.mark_runtime_parameter_injection_uploaded(
            injection,
            code_text=upload,
            upload_tick=upload_tick,
        )
        return uploaded, upload

    def uploaded_runtime_parameter_injection(self) -> harness.JsonObject:
        uploaded, _upload = self.uploaded_runtime_parameter_injection_with_code()
        return uploaded

    def runtime_parameter_consumption_evidence(self, injection: harness.JsonObject) -> harness.JsonObject:
        return {
            "type": harness.RUNTIME_PARAMETER_CONSUMPTION_TYPE,
            "consumerMarker": harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER,
            "consumerVersion": harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_VERSION,
            "runtimeParameterInjection": True,
            "consumed": True,
            "strategyVariantId": injection["strategyVariantId"],
            "candidatePolicyId": injection["candidatePolicyId"],
            "family": injection["family"],
            "parameters": copy.deepcopy(injection["parameters"]),
            "parametersSha256": injection["parametersSha256"],
            "consumedStrategyVariantId": injection["strategyVariantId"],
            "consumedParametersSha256": injection["parametersSha256"],
            "appliedStrategyIds": [injection["strategyVariantId"]],
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }

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

    def test_place_spawn_parser_recognizes_room_busy_payload_shapes(self) -> None:
        class Result:
            def __init__(self, payload: object) -> None:
                self.status = 200
                self.payload = payload

        self.assertEqual(harness._place_spawn_response_kind(Result({"ok": 1})), "ok")
        self.assertEqual(
            harness._place_spawn_response_kind(Result({"error": "already playing"})),
            "already_playing",
        )
        self.assertEqual(
            harness._place_spawn_response_kind(Result({"error": "room busy"})),
            "room_busy",
        )
        self.assertEqual(
            harness._place_spawn_response_kind(Result({"ok": True, "payload": '{"error": "room busy"}'})),
            "room_busy",
        )

    def test_place_spawn_retry_recovers_from_room_busy(self) -> None:
        class Result:
            def __init__(self, payload: object, token: str) -> None:
                self.status = 200
                self.payload = payload
                self.headers = {"X-Token": token}

        class FakeSmoke:
            def __init__(self) -> None:
                self.calls = 0

            def build_spawn_payload(self, cfg: argparse.Namespace) -> dict[str, object]:
                return {"room": cfg.room, "name": "Spawn1", "x": 20, "y": 20}

            def token_headers(self, token: str) -> dict[str, str]:
                return {"X-Token": token}

            def update_token_from_headers(self, token: str, headers: dict[str, str]) -> str:
                return headers.get("X-Token", token)

            def http_json(self, method: str, base_url: str, path: str, *args: object, **kwargs: object) -> Result:
                _ = method, base_url, path, args, kwargs
                self.calls += 1
                if self.calls == 1:
                    return Result({"error": "room busy"}, "busy-token")
                return Result({"ok": 1}, "placed-token")

        smoke = FakeSmoke()
        cfg = argparse.Namespace(server_url="http://127.0.0.1", room="E1S1")

        with (
            mock.patch.object(harness.time, "sleep", return_value=None) as sleep,
            mock.patch.object(harness, "_debug_worker_phase") as debug_phase,
        ):
            token, summary = harness._place_spawn_with_retry(
                smoke,
                cfg,
                "initial-token",
                worker_index=0,
                variant_id="variant-a",
                max_attempts=3,
                retry_seconds=0.25,
            )

        self.assertEqual(token, "placed-token")
        self.assertEqual(smoke.calls, 2)
        sleep.assert_called_once_with(0.25)
        debug_phase.assert_called_once()
        self.assertEqual(summary["classification"], "ok")
        self.assertTrue(summary["retry"]["recovered"])
        self.assertEqual(summary["retry"]["attempts"][0]["classification"], "room_busy")
        self.assertEqual(summary["retry"]["attempts"][1]["classification"], "ok")
        self.assertNotIn("retry", summary["retry"]["attempts"][1])

        serializable_summary = {"placeSpawn": summary}
        encoded = json.dumps(serializable_summary, sort_keys=True)
        self.assertIn('"recovered": true', encoded)
        harness.assert_no_secret_leak(serializable_summary, [])
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "summary.json"
            harness.write_json_atomic(output_path, serializable_summary)
            written = read_json(output_path)
        self.assertEqual(written["placeSpawn"]["retry"]["attempts"][1]["classification"], "ok")

    def test_place_spawn_retry_reports_persistent_room_busy_with_no_rerun_guidance(self) -> None:
        class Result:
            status = 200
            payload = {"error": "room busy"}
            headers: dict[str, str] = {}

        class FakeSmoke:
            def __init__(self) -> None:
                self.calls = 0

            def build_spawn_payload(self, cfg: argparse.Namespace) -> dict[str, object]:
                return {"room": cfg.room, "name": "Spawn1", "x": 20, "y": 20}

            def token_headers(self, token: str) -> dict[str, str]:
                return {"X-Token": token}

            def update_token_from_headers(self, token: str, headers: dict[str, str]) -> str:
                _ = headers
                return token

            def http_json(self, method: str, base_url: str, path: str, *args: object, **kwargs: object) -> Result:
                _ = method, base_url, path, args, kwargs
                self.calls += 1
                return Result()

        smoke = FakeSmoke()
        cfg = argparse.Namespace(server_url="http://127.0.0.1", room="E1S1")

        with (
            mock.patch.object(harness.time, "sleep", return_value=None) as sleep,
            mock.patch.object(harness, "_debug_worker_phase"),
        ):
            with self.assertRaisesRegex(RuntimeError, "place-spawn room busy after 3 attempt") as caught:
                harness._place_spawn_with_retry(
                    smoke,
                    cfg,
                    "token",
                    worker_index=0,
                    variant_id="variant-a",
                    max_attempts=3,
                    retry_seconds=0.25,
                )

        self.assertIn("do not rerun paid validation unchanged", str(caught.exception))
        self.assertEqual(smoke.calls, 3)
        self.assertEqual(sleep.call_count, 2)

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

    def test_runtime_parameter_injection_tick_capture_retries_missing_initial_clock(self) -> None:
        class Result:
            def __init__(self, payload: object, headers: dict[str, str] | None = None) -> None:
                self.payload = payload
                self.headers = headers or {}

        class FakeSmoke:
            def __init__(self) -> None:
                self.overview_calls = 0
                self.stats_calls = 0

            def token_headers(self, token: str) -> dict[str, str]:
                return {"X-Token": token}

            def update_token_from_headers(self, token: str, headers: dict[str, str]) -> str:
                return headers.get("X-Token", token)

            def http_json(self, method: str, base_url: str, path: str, **kwargs: object) -> Result:
                _ = method, base_url, kwargs
                if path == "/api/user/overview":
                    self.overview_calls += 1
                    return Result(
                        {"ok": 1, "rooms": ["E1S1"], "gametimes": []},
                        {"X-Token": f"overview-{self.overview_calls}"},
                    )
                if path == "/stats":
                    self.stats_calls += 1
                    if self.stats_calls == 1:
                        return Result({"ok": 1}, {"X-Token": "stats-empty"})
                    return Result({"gametime": "37"}, {"X-Token": "stats-37"})
                raise AssertionError(path)

        smoke = FakeSmoke()
        with mock.patch.object(harness.time, "sleep", return_value=None) as sleep:
            token, tick = harness._capture_runtime_parameter_injection_tick(
                argparse.Namespace(server_url="http://127.0.0.1"),
                smoke,
                "token",
                "shardX",
                {"ok": 1, "rooms": ["E1S1"], "gametimes": []},
                max_attempts=3,
            )

        self.assertEqual(token, "stats-37")
        self.assertEqual(tick, 37)
        self.assertEqual(smoke.stats_calls, 2)
        self.assertEqual(smoke.overview_calls, 1)
        sleep.assert_called_once_with(harness.RUN_TICK_POLL_SECONDS)

    def test_runtime_parameter_injection_tick_capture_fails_after_bounded_missing_clock(self) -> None:
        class Result:
            def __init__(self, payload: object) -> None:
                self.payload = payload
                self.headers: dict[str, str] = {}

        class FakeSmoke:
            def __init__(self) -> None:
                self.overview_calls = 0
                self.stats_calls = 0

            def token_headers(self, token: str) -> dict[str, str]:
                return {"X-Token": token}

            def update_token_from_headers(self, token: str, headers: dict[str, str]) -> str:
                _ = headers
                return token

            def http_json(self, method: str, base_url: str, path: str, **kwargs: object) -> Result:
                _ = method, base_url, kwargs
                if path == "/api/user/overview":
                    self.overview_calls += 1
                    return Result({"ok": 1, "rooms": ["E1S1"], "gametimes": []})
                if path == "/stats":
                    self.stats_calls += 1
                    return Result({"ok": 1})
                raise AssertionError(path)

        smoke = FakeSmoke()
        with mock.patch.object(harness.time, "sleep", return_value=None) as sleep:
            with self.assertRaisesRegex(RuntimeError, "failed to capture numeric injection tick"):
                harness._capture_runtime_parameter_injection_tick(
                    argparse.Namespace(server_url="http://127.0.0.1"),
                    smoke,
                    "token",
                    "shardX",
                    {"ok": 1, "rooms": ["E1S1"], "gametimes": []},
                    max_attempts=2,
                )

        self.assertEqual(smoke.stats_calls, 2)
        self.assertEqual(smoke.overview_calls, 1)
        sleep.assert_called_once_with(harness.RUN_TICK_POLL_SECONDS)

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
        self.assertEqual(captured_branches, ["default"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "stop before side effects")
        self.assertIsNone(result["launcherRepairMod"])

    def test_compose_setup_retry_recovers_transient_image_pull_failure(self) -> None:
        class FakeSmoke:
            def __init__(self) -> None:
                self.commands: list[list[str]] = []
                self.results = [
                    {
                        "returncode": 1,
                        "elapsed_seconds": 0.4,
                        "output_excerpt": "failed to pull layer: unexpected EOF",
                    },
                    {"returncode": 0, "elapsed_seconds": 0.2, "output_excerpt": ""},
                ]

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
            ) -> dict[str, object]:
                _ = cfg, timeout
                self.commands.append(command)
                return self.results.pop(0)

            def require_success(self, result: dict[str, object]) -> dict[str, object]:
                if result.get("returncode") != 0:
                    raise AssertionError("failed setup attempts must be classified before require_success")
                return result

        smoke = FakeSmoke()
        with mock.patch.object(harness.time, "sleep", return_value=None) as sleep:
            result = harness._run_compose_setup_command_with_retry(
                smoke,
                object(),
                ["compose", "pull"],
                "docker compose pull",
                timeout=123,
            )

        self.assertEqual(smoke.commands, [["compose", "pull"], ["compose", "pull"]])
        sleep.assert_called_once_with(harness.RUN_COMPOSE_SETUP_RETRY_BACKOFF_SECONDS)
        self.assertEqual(result["returncode"], 0)
        self.assertTrue(result["setupRetry"]["recovered"])
        self.assertEqual(len(result["setupRetry"]["attempts"]), 2)

    def test_compose_setup_retry_recovers_interrupted_pull_progress(self) -> None:
        class FakeSmoke:
            def __init__(self) -> None:
                self.commands: list[list[str]] = []
                self.results = [
                    {
                        "returncode": 2,
                        "elapsed_seconds": 64.967,
                        "output_excerpt": (
                            " mongo Pulling \n"
                            " screeps Pulling \n"
                            " redis Pulling \n"
                            " 3892befd2c3f Pulling fs layer \n"
                            " 32ab8bed435e Download complete \n"
                            " 3892befd2c3f Downloading"
                        ),
                    },
                    {"returncode": 0, "elapsed_seconds": 0.2, "output_excerpt": ""},
                ]

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
            ) -> dict[str, object]:
                _ = cfg, timeout
                self.commands.append(command)
                return self.results.pop(0)

            def require_success(self, result: dict[str, object]) -> dict[str, object]:
                if result.get("returncode") != 0:
                    raise AssertionError("failed setup attempts must be classified before require_success")
                return result

        smoke = FakeSmoke()
        with mock.patch.object(harness.time, "sleep", return_value=None) as sleep:
            result = harness._run_compose_setup_command_with_retry(
                smoke,
                object(),
                ["compose", "pull"],
                "docker compose pull",
                timeout=123,
            )

        self.assertEqual(smoke.commands, [["compose", "pull"], ["compose", "pull"]])
        sleep.assert_called_once_with(harness.RUN_COMPOSE_SETUP_RETRY_BACKOFF_SECONDS)
        self.assertEqual(result["returncode"], 0)
        self.assertTrue(result["setupRetry"]["recovered"])
        self.assertTrue(result["setupRetry"]["attempts"][0]["retryable"])

    def test_compose_setup_progress_failure_stays_retryable_after_bounded_attempts(self) -> None:
        class FakeSmoke:
            def __init__(self) -> None:
                self.commands: list[list[str]] = []

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
            ) -> dict[str, object]:
                _ = cfg, timeout
                self.commands.append(command)
                return {
                    "returncode": 2,
                    "elapsed_seconds": 65.0,
                    "output_excerpt": "screeps Pulling\n3892befd2c3f Pulling fs layer\n3892befd2c3f Downloading",
                }

        smoke = FakeSmoke()
        with mock.patch.object(harness.time, "sleep", return_value=None) as sleep:
            with self.assertRaisesRegex(RuntimeError, "retryable_setup_failure"):
                harness._run_compose_setup_command_with_retry(
                    smoke,
                    object(),
                    ["compose", "pull"],
                    "docker compose pull",
                    timeout=123,
                )

        self.assertEqual(len(smoke.commands), harness.RUN_COMPOSE_SETUP_MAX_ATTEMPTS)
        self.assertEqual(sleep.call_count, harness.RUN_COMPOSE_SETUP_MAX_ATTEMPTS - 1)

    def test_compose_setup_progress_with_disk_failure_is_not_retryable(self) -> None:
        for message in ("no space left on device", "disk quota exceeded", "read-only file system"):
            with self.subTest(message=message):
                result = {
                    "returncode": 2,
                    "elapsed_seconds": 65.0,
                    "output_excerpt": f"screeps Pulling\n3892befd2c3f Pulling fs layer\n{message}",
                }

                self.assertFalse(harness._is_retryable_compose_setup_failure(result))

        class FakeSmoke:
            def __init__(self) -> None:
                self.commands: list[list[str]] = []

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
            ) -> dict[str, object]:
                _ = cfg, timeout
                self.commands.append(command)
                return {
                    "returncode": 2,
                    "elapsed_seconds": 65.0,
                    "output_excerpt": (
                        "screeps Pulling\n"
                        "3892befd2c3f Pulling fs layer\n"
                        "failed to register layer: no space left on device"
                    ),
                }

        smoke = FakeSmoke()
        with mock.patch.object(harness.time, "sleep", return_value=None) as sleep:
            with self.assertRaisesRegex(RuntimeError, "docker compose pull failed"):
                harness._run_compose_setup_command_with_retry(
                    smoke,
                    object(),
                    ["compose", "pull"],
                    "docker compose pull",
                    timeout=123,
                )

        self.assertEqual(smoke.commands, [["compose", "pull"]])
        sleep.assert_not_called()

    def test_compose_setup_retry_recovers_transient_run_command_exception(self) -> None:
        class FakeSmoke:
            def __init__(self) -> None:
                self.calls = 0

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
            ) -> dict[str, object]:
                _ = command, cfg, timeout
                self.calls += 1
                if self.calls == 1:
                    raise TimeoutError("context deadline exceeded while pulling image")
                return {"returncode": 0, "elapsed_seconds": 0.2, "output_excerpt": ""}

            def require_success(self, result: dict[str, object]) -> dict[str, object]:
                if result.get("returncode") != 0:
                    raise AssertionError("only the recovered setup result should be required to succeed")
                return result

        smoke = FakeSmoke()
        with mock.patch.object(harness.time, "sleep", return_value=None) as sleep:
            result = harness._run_compose_setup_command_with_retry(
                smoke,
                object(),
                ["compose", "pull"],
                "docker compose pull",
                timeout=123,
            )

        self.assertEqual(smoke.calls, 2)
        sleep.assert_called_once_with(harness.RUN_COMPOSE_SETUP_RETRY_BACKOFF_SECONDS)
        self.assertTrue(result["setupRetry"]["recovered"])
        self.assertEqual(result["setupRetry"]["attempts"][0]["exceptionType"], "TimeoutError")
        self.assertTrue(result["setupRetry"]["attempts"][0]["retryable"])

    def test_compose_setup_retry_recovers_plain_timeout_expired_exception(self) -> None:
        class FakeSmoke:
            def __init__(self) -> None:
                self.calls = 0

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
            ) -> dict[str, object]:
                _ = cfg, timeout
                self.calls += 1
                if self.calls == 1:
                    raise subprocess.TimeoutExpired(command, 900)
                return {"returncode": 0, "elapsed_seconds": 0.2, "output_excerpt": ""}

            def require_success(self, result: dict[str, object]) -> dict[str, object]:
                if result.get("returncode") != 0:
                    raise AssertionError("only the recovered setup result should be required to succeed")
                return result

        smoke = FakeSmoke()
        with mock.patch.object(harness.time, "sleep", return_value=None) as sleep:
            result = harness._run_compose_setup_command_with_retry(
                smoke,
                object(),
                ["compose", "pull"],
                "docker compose pull",
                timeout=123,
            )

        attempts = result["setupRetry"]["attempts"]
        self.assertEqual(smoke.calls, 2)
        sleep.assert_called_once_with(harness.RUN_COMPOSE_SETUP_RETRY_BACKOFF_SECONDS)
        self.assertEqual(attempts[0]["exceptionType"], "TimeoutExpired")
        self.assertIn("timed out after 900 seconds", attempts[0]["outputExcerpt"])
        self.assertTrue(attempts[0]["retryable"])

    def test_compose_setup_retry_does_not_retry_non_transient_pull_failure(self) -> None:
        class FakeSmoke:
            def __init__(self) -> None:
                self.commands: list[list[str]] = []

            def run_command(
                self,
                command: list[str],
                cfg: object,
                *,
                timeout: int,
            ) -> dict[str, object]:
                _ = cfg, timeout
                self.commands.append(command)
                return {
                    "returncode": 1,
                    "elapsed_seconds": 0.1,
                    "output_excerpt": "screeps Pulling\nmanifest for screeps/private-server:missing not found",
                }

        smoke = FakeSmoke()
        with mock.patch.object(harness.time, "sleep", return_value=None) as sleep:
            with self.assertRaisesRegex(RuntimeError, "docker compose pull failed"):
                harness._run_compose_setup_command_with_retry(
                    smoke,
                    object(),
                    ["compose", "pull"],
                    "docker compose pull",
                    timeout=123,
                )

        self.assertEqual(smoke.commands, [["compose", "pull"]])
        sleep.assert_not_called()

    def test_run_variant_logs_recovered_up_retry_evidence(self) -> None:
        class FakeSmokeConfig:
            def __init__(self, **kwargs: object) -> None:
                for key, value in kwargs.items():
                    setattr(self, key, value)

            @property
            def map_path(self) -> Path:
                return self.work_dir / "maps" / "map-0b6758af.json"

        class FakeSmoke:
            SmokeConfig = FakeSmokeConfig

            def __init__(self) -> None:
                self.up_attempts = 0

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
                return None

            def prepare_map(self, cfg: FakeSmokeConfig) -> None:
                return None

            def run_command(
                self,
                command: list[str],
                cfg: FakeSmokeConfig,
                *,
                timeout: int,
            ) -> dict[str, object]:
                _ = cfg, timeout
                if command[-2:] == ["up", "-d"]:
                    self.up_attempts += 1
                    if self.up_attempts == 1:
                        return {
                            "returncode": 1,
                            "elapsed_seconds": 0.4,
                            "output_excerpt": "failed to pull layer: unexpected EOF",
                        }
                return {"returncode": 0, "elapsed_seconds": 0.2, "output_excerpt": ""}

        stderr = io.StringIO()
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            code_path = root / "main.js"
            map_path = root / "map.json"
            code_path.write_text("module.exports.loop = function() {};", encoding="utf-8")
            map_path.write_text("{\"ok\": true}", encoding="utf-8")

            with (
                mock.patch("screeps_rl_simulator_harness._load_private_smoke_module", return_value=FakeSmoke()),
                mock.patch.object(harness.time, "sleep", return_value=None),
                mock.patch("screeps_rl_simulator_harness._wait_for_http_with_smoke", side_effect=RuntimeError("stop after up debug")),
                mock.patch("sys.stderr", stderr),
            ):
                result = harness._run_variant(
                    0,
                    "baseline",
                    run_id="up-retry-log",
                    ticks=1,
                    room="E1S1",
                    shard="shardX",
                    branch="activeWorld",
                    code_path=code_path,
                    map_source_file=map_path,
                    out_dir=root / "out",
                )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "stop after up debug")
        self.assertIn('phase="after docker compose up"', stderr.getvalue())
        self.assertIn("setupRetry=", stderr.getvalue())

    def test_run_variant_active_world_alias_uploads_executable_branch_for_runtime_consumption(self) -> None:
        variant_id = "construction-priority.pg.territory-seed.v1"
        parameters = {
            "baseScoreWeight": 1,
            "territorySignalWeight": 22,
            "resourceSignalWeight": 3,
            "killSignalWeight": 5,
            "riskPenalty": 4,
        }

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
                self.uploaded_branch: str | None = None
                self.uploaded_code_text: str | None = None
                self.code_readback_count = 0
                self.runtime_payload: dict[str, object] | None = None
                self.gametime = 0
                self.room = "E1S1"
                self.username = "rl-sim"

            def host_port_unavailable_reason(self, host: str, port: int) -> str | None:
                _ = host, port
                return None

            def required_env_errors(self, cfg: FakeSmokeConfig) -> list[str]:
                self.room = str(cfg.room)
                self.username = str(cfg.username)
                return []

            def assert_safe_work_dir(self, work_dir: Path) -> None:
                _ = work_dir

            def preflight_host_ports(self, cfg: FakeSmokeConfig) -> dict[str, object]:
                _ = cfg
                return {"checks": [{"available": True}]}

            def find_compose_command(self) -> list[str]:
                return ["compose"]

            def prepare_work_dir(self, cfg: FakeSmokeConfig) -> None:
                _ = cfg

            def build_launcher_config(self, cfg: FakeSmokeConfig) -> str:
                _ = cfg
                return "serverConfig:\n  shardName: shardX\n  mapFile: /screeps/maps/map-0b6758af.json\n"

            def write_generated_text(self, work_dir: Path, path: Path, text: str) -> None:
                _ = work_dir, path, text

            def prepare_map(self, cfg: FakeSmokeConfig) -> None:
                _ = cfg

            def run_command(
                self,
                command: list[str],
                cfg: FakeSmokeConfig,
                *,
                timeout: int,
                output_limit: int | None = None,
            ) -> dict[str, object]:
                _ = command, cfg, timeout, output_limit
                return {"returncode": 0, "elapsed_seconds": 0.0, "output_excerpt": ""}

            def run_launcher_cli(self, compose: list[str], cfg: FakeSmokeConfig, expression: str) -> dict[str, object]:
                _ = compose, cfg, expression
                return {"status": 200, "response_excerpt": "undefined\n"}

            def wait_for_http(self, cfg: FakeSmokeConfig, timeout: int) -> dict[str, object]:
                _ = cfg, timeout
                return {"ok": True}

            def token_headers(self, token: str | None) -> dict[str, str]:
                return {"X-Token": token or ""}

            def update_token_from_headers(self, token: str, headers: dict[str, str]) -> str:
                _ = headers
                return token

            def build_register_payload(self, cfg: FakeSmokeConfig) -> dict[str, object]:
                return {"username": cfg.username, "email": cfg.email, "password": cfg.password}

            def build_signin_payload(self, cfg: FakeSmokeConfig) -> dict[str, object]:
                return {"email": cfg.email, "password": cfg.password}

            def build_code_payload(self, cfg: FakeSmokeConfig, code: str) -> dict[str, object]:
                self.uploaded_branch = str(cfg.branch)
                self.uploaded_code_text = code
                prefix = f"var {harness.RUNTIME_PARAMETER_INJECTION_GLOBAL} = "
                start = code.find(prefix)
                if start >= 0:
                    end = code.find(";\n", start)
                    self.runtime_payload = json.loads(code[start + len(prefix):end])
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

            def runtime_consumption_evidence(self) -> dict[str, object] | None:
                if self.uploaded_branch != "default" or self.runtime_payload is None:
                    return None
                payload = self.runtime_payload
                return {
                    "type": harness.RUNTIME_PARAMETER_CONSUMPTION_TYPE,
                    "consumerMarker": harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER,
                    "consumerVersion": harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_VERSION,
                    "runtimeParameterInjection": True,
                    "consumed": True,
                    "strategyVariantId": payload.get("strategyVariantId"),
                    "candidatePolicyId": payload.get("candidatePolicyId"),
                    "family": payload.get("family"),
                    "parameters": copy.deepcopy(payload.get("parameters")),
                    "parametersSha256": payload.get("parametersSha256"),
                    "consumedStrategyVariantId": payload.get("strategyVariantId"),
                    "consumedParametersSha256": payload.get("parametersSha256"),
                    "appliedStrategyIds": [payload.get("sourceStrategyId")],
                    "tick": self.gametime,
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                }

            def http_json(self, method: str, base_url: str, path: str, *args: object, **kwargs: object) -> Result:
                _ = base_url, args
                if path == "/api/game/room-terrain":
                    return Result(200, {"terrain": [{"room": self.room, "terrain": "0" * 2500}]})
                if path == "/api/register/submit":
                    return Result(200, {"ok": 1})
                if path == "/api/auth/signin":
                    return Result(200, {"ok": 1, "token": "token"})
                if path == "/api/user/code":
                    if method == "GET":
                        self.code_readback_count += 1
                        main_code = self.uploaded_code_text
                        if self.code_readback_count == 1 and isinstance(main_code, str):
                            main_code = f"{main_code}\n// stale readback"
                        return Result(
                            200,
                            {
                                "ok": 1,
                                "branch": self.uploaded_branch,
                                "modules": {"main": main_code},
                            },
                        )
                    return Result(200, {"ok": 1})
                if path == "/api/game/place-spawn":
                    return Result(200, {"ok": 1})
                if path == "/api/user/overview":
                    return Result(200, {"ok": 1, "rooms": [self.room], "gametime": self.gametime})
                if path == "/stats":
                    self.gametime += 1
                    return Result(200, {"gametime": self.gametime})
                if path == "/api/game/room-overview":
                    requested_room = self.room
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
                                "user": {"id": "user-1", "username": self.username},
                                "controller": {
                                    "level": 1,
                                    "my": True,
                                    "owner": {"username": self.username},
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
                if path == "/api/user/memory":
                    evidence = self.runtime_consumption_evidence()
                    data = json.dumps({"rlRuntimePolicyParameters": evidence}, sort_keys=True) if evidence else None
                    return Result(200, {"ok": 1, "data": data})
                raise AssertionError(path)

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            code_path = root / "main.js"
            map_path = root / "map.json"
            code_path.write_text(
                '"use strict";\n'
                f'var runtimePolicyConsumer = "{harness.RUNTIME_PARAMETER_INJECTION_CONSUMER_MARKER}";\n'
                "module.exports.loop = function loop() { return 1; };\n",
                encoding="utf-8",
            )
            map_path.write_text("{\"ok\": true}", encoding="utf-8")
            fake_smoke = FakeSmoke()
            with mock.patch("screeps_rl_simulator_harness._load_private_smoke_module", return_value=fake_smoke):
                with mock.patch.object(harness.time, "sleep", return_value=None):
                    result = harness._run_variant(
                        0,
                        variant_id,
                        run_id="runtime-consumption",
                        ticks=1,
                        room="E1S1",
                        shard="shardX",
                        branch="activeWorld",
                        code_path=code_path,
                        map_source_file=map_path,
                        out_dir=root / "out",
                        variant_configs={
                            variant_id: {
                                "id": variant_id,
                                "candidatePolicyId": variant_id,
                                "sourceStrategyId": "construction-priority.territory-shadow.v1",
                                "family": "construction-priority",
                                "parameters": parameters,
                            }
                        },
                    )

        self.assertEqual(fake_smoke.uploaded_branch, "default")
        self.assertEqual(fake_smoke.code_readback_count, 2)
        self.assertTrue(result["ok"])
        self.assertEqual(result["scenario"]["activeWorldBranch"], "default")
        self.assertTrue(result["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertTrue(result["runtimeParameterInjection"]["runtimeParameterConsumption"])
        self.assertEqual(result["runtimeParameterInjection"]["runtimeParameterConsumptionStatus"], "consumed")
        self.assertIsInstance(result["runtimeParameterInjection"].get("tick"), int)
        self.assertTrue(result["activeCodeReadback"]["activeCodeMatchesUploaded"])
        self.assertEqual(result["activeCodeReadback"]["status"], "matched")
        self.assertEqual(result["activeCodeReadback"]["attempt"], 2)
        self.assertTrue(result["runtimeParameterConsumption"]["runtimeParameterConsumption"])
        self.assertGreater(
            result["runtimeParameterConsumption"]["consumedTick"],
            result["runtimeParameterInjection"]["tick"],
        )
        self.assertEqual(result["runtimeParameterConsumption"]["source"], "Memory.rlRuntimePolicyParameters")
        self.assertEqual(result["runtimeParameterConsumption"]["evaluatedParameters"], parameters)
        self.assertEqual(
            result["runtimeParameterConsumption"]["consumedStrategyVariantId"],
            variant_id,
        )

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
        variant_id = "construction-priority.pg.territory-seed.v1"
        variant_configs = {
            variant_id: {
                "id": variant_id,
                "title": "inline candidate that failed setup",
                "parameters": {
                    "baseScoreWeight": 1,
                    "territorySignalWeight": 31,
                    "resourceSignalWeight": 2,
                    "killSignalWeight": 5,
                    "riskPenalty": 4,
                },
            }
        }

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
                            variants=[variant_id],
                            out_dir=out_dir,
                            run_id="missing-steam-key",
                            code_path=root / "main.js",
                            map_source_file=root / "map.json",
                            variant_configs=variant_configs,
                        )
                    failure_text = (out_dir / "missing-steam-key" / "setup_failure.json").read_text(encoding="utf-8")
                    summary = read_json(out_dir / "missing-steam-key" / "run_summary.json")

        run_variants.assert_not_called()
        self.assertIn("STEAM_KEY environment variable is required", failure_text)
        self.assertNotIn(unrelated_secret, failure_text)
        strategy_variant = summary["variants"][0]["strategyVariant"]
        self.assertEqual(strategy_variant["label"], "inline candidate that failed setup")
        self.assertEqual(strategy_variant["parameters"]["territorySignalWeight"], 31)

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
        variant_configs = {
            variant_id: {
                "id": variant_id,
                "title": f"{variant_id} guarded candidate",
                "parameters": {
                    "baseScoreWeight": 1,
                    "territorySignalWeight": 24,
                    "resourceSignalWeight": 3,
                    "killSignalWeight": 4,
                    "riskPenalty": 2,
                },
            }
            for variant_id in variants
        }

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
                                    variant_configs=variant_configs,
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
        self.assertEqual(summary["runtimeParameterInjection"]["status"], "not_injected")
        self.assertEqual(summary["runtimeParameterInjection"]["candidateParameterScope"], "runtime_injected")
        self.assertEqual(summary["runtimeParameterInjection"]["runtimeParameterConsumptionStatus"], "not_attempted")
        first_variant_injection = summary["variants"][0]["runtimeParameterInjection"]
        self.assertEqual(first_variant_injection["status"], "not_attempted")
        self.assertFalse(first_variant_injection["runtimeParameterInjection"])
        self.assertFalse(first_variant_injection["runtimeParameterConsumption"])
        self.assertEqual(first_variant_injection["runtimeParameterConsumptionStatus"], "not_attempted")
        self.assertEqual(first_variant_injection["candidateParameterScope"], "runtime_injected")
        self.assertIsInstance(first_variant_injection["parametersSha256"], str)
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
        variant_configs = {
            "baseline": {
                "id": "baseline",
                "title": "inline failure candidate",
                "parameters": {
                    "baseScoreWeight": 1,
                    "territorySignalWeight": 29,
                    "resourceSignalWeight": 3,
                    "killSignalWeight": 4,
                    "riskPenalty": 2,
                },
            }
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
                    variant_configs=variant_configs,
                )
                failure_path = out_dir / run_id / filename
                failure = read_json(failure_path)
                summary = read_json(out_dir / run_id / "run_summary.json")

                self.assertEqual(failure["type"], failure_type)
                self.assertEqual(failure["phase"], phase)
                self.assertEqual(artifact["failureArtifactPath"], str(failure_path))
                self.assertEqual(summary["failureArtifactPath"], str(failure_path))
                self.assertEqual(summary["variants"][0]["strategyVariant"]["label"], "inline failure candidate")
                self.assertEqual(summary["variants"][0]["strategyVariant"]["parameters"]["territorySignalWeight"], 29)
                runtime_summary = summary["runtimeParameterInjection"]
                self.assertEqual(runtime_summary["status"], "not_injected")
                self.assertEqual(runtime_summary["candidateParameterScope"], "runtime_injected")
                self.assertEqual(runtime_summary["runtimeParameterConsumptionStatus"], "not_attempted")
                variant_injection = summary["variants"][0]["runtimeParameterInjection"]
                self.assertEqual(variant_injection["status"], "not_attempted")
                self.assertFalse(variant_injection["runtimeParameterInjection"])
                self.assertFalse(variant_injection["runtimeParameterConsumption"])
                self.assertEqual(variant_injection["runtimeParameterConsumptionStatus"], "not_attempted")
                self.assertEqual(variant_injection["candidateParameterScope"], "runtime_injected")
                self.assertIsInstance(variant_injection["parametersSha256"], str)
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
