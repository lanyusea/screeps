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

    def test_throughput_sample_parser_rejects_invalid_shapes(self) -> None:
        valid = harness.parse_throughput_sample("worker-7:1200:30.5:1")
        self.assertEqual(valid.worker_id, "worker-7")
        self.assertEqual(valid.room_ticks, 1200)
        self.assertEqual(valid.wall_seconds, 30.5)
        self.assertEqual(valid.failure_count, 1)

        for sample in ("worker:1", ":1:1", "worker:-1:1", "worker:1:0", "worker:1:1:-1"):
            with self.subTest(sample=sample):
                with self.assertRaises(argparse.ArgumentTypeError):
                    harness.parse_throughput_sample(sample)


if __name__ == "__main__":
    unittest.main()
