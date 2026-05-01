#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import screeps_rl_dataset_export as exporter


def runtime_line(payload: dict[str, object]) -> str:
    return f"#runtime-summary {json.dumps(payload, sort_keys=True)}\n"


def read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def read_ndjson(path: Path) -> list[dict[str, object]]:
    text = path.read_text(encoding="utf-8")
    return [json.loads(line) for line in text.splitlines() if line]


class RlDatasetExportTest(unittest.TestCase):
    def test_exports_runtime_summary_rows_with_high_level_labels(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 200,
            "rooms": [
                {
                    "roomName": "E26S49",
                    "energyAvailable": 350,
                    "energyCapacity": 550,
                    "workerCount": 4,
                    "spawnStatus": [{"name": "Spawn1", "status": "idle"}],
                    "controller": {
                        "level": 3,
                        "progress": 12000,
                        "progressTotal": 135000,
                        "ticksToDowngrade": 8000,
                    },
                    "resources": {
                        "storedEnergy": 420,
                        "workerCarriedEnergy": 120,
                        "droppedEnergy": 30,
                        "sourceCount": 2,
                        "events": {"harvestedEnergy": 80, "transferredEnergy": 65},
                    },
                    "combat": {
                        "hostileCreepCount": 0,
                        "hostileStructureCount": 0,
                        "events": {
                            "attackCount": 0,
                            "attackDamage": 0,
                            "objectDestroyedCount": 0,
                            "creepDestroyedCount": 0,
                        },
                    },
                    "constructionPriority": {
                        "nextPrimary": {
                            "buildItem": "build extension capacity",
                            "room": "E26S49",
                            "score": 70,
                            "urgency": "high",
                            "preconditions": [],
                            "expectedKpiMovement": ["raises spawn energy capacity"],
                            "risk": ["adds build backlog"],
                        }
                    },
                    "territoryRecommendation": {
                        "next": {
                            "roomName": "E48S27",
                            "action": "reserve",
                            "score": 850,
                            "evidenceStatus": "sufficient",
                            "source": "configured",
                            "preconditions": [],
                            "risks": [],
                            "routeDistance": 2,
                            "sourceCount": 2,
                        }
                    },
                }
            ],
            "cpu": {"used": 5.2, "bucket": 9000},
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            artifact.write_text(runtime_line(payload), encoding="utf-8")
            out_dir = root / "datasets"

            summary = exporter.build_dataset(
                [str(artifact)],
                out_dir,
                run_id="test-run",
                bot_commit="a" * 40,
                eval_ratio_value=0,
            )

            run_dir = out_dir / "test-run"
            rows = read_ndjson(run_dir / "ticks.ndjson")
            run_manifest = read_json(run_dir / "run_manifest.json")
            kpi_windows = read_json(run_dir / "kpi_windows.json")

        self.assertEqual(summary["sampleCount"], 1)
        self.assertEqual(summary["runtimeSummaryArtifactCount"], 1)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["observation"]["roomName"], "E26S49")
        self.assertEqual(row["observation"]["controller"]["level"], 3)
        self.assertEqual(row["observation"]["spawn"], {"idleCount": 1, "spawningCount": 0, "total": 1})
        self.assertEqual(row["split"]["name"], "train")
        self.assertFalse(row["safety"]["liveEffect"])
        self.assertEqual(
            [label["surface"] for label in row["actionLabels"]],
            ["construction-priority", "expansion-remote-candidate"],
        )
        self.assertEqual(row["reward"]["components"]["resources"]["harvestedEnergy"], 80)
        self.assertEqual(run_manifest["strategy"]["decisionSurfacesObserved"], [
            "construction-priority",
            "expansion-remote-candidate",
        ])
        self.assertFalse(run_manifest["strategy"]["liveEffect"])
        self.assertEqual(kpi_windows["input"]["runtimeSummaryCount"], 1)
        self.assertEqual(kpi_windows["resources"]["totals"]["latest"]["storedEnergy"], 420)

    def test_export_is_reproducible_for_same_inputs(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 10,
            "rooms": [{"roomName": "W1N1", "resources": {"storedEnergy": 1}}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            artifact.write_text(runtime_line(payload), encoding="utf-8")
            out_a = root / "a"
            out_b = root / "b"

            first = exporter.build_dataset([str(artifact)], out_a, bot_commit="b" * 40)
            second = exporter.build_dataset([str(artifact)], out_b, bot_commit="b" * 40)

            run_a = out_a / first["runId"]
            run_b = out_b / second["runId"]
            file_names = sorted(path.name for path in run_a.iterdir())

            self.assertEqual(first["runId"], second["runId"])
            self.assertEqual(file_names, sorted(path.name for path in run_b.iterdir()))
            for name in file_names:
                self.assertEqual((run_a / name).read_text(encoding="utf-8"), (run_b / name).read_text(encoding="utf-8"))

    def test_monitor_summary_json_is_converted_to_sample(self) -> None:
        monitor_payload = {
            "ok": True,
            "mode": "summary",
            "room_summaries": [
                {
                    "room": "shardX/E26S49",
                    "tick": 123,
                    "objects": 10,
                    "structures": 4,
                    "owned_creeps": 3,
                    "owned_spawns": 1,
                    "hostiles": 2,
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "monitor.json"
            artifact.write_text(json.dumps(monitor_payload, sort_keys=True), encoding="utf-8")
            out_dir = root / "datasets"

            exporter.build_dataset([str(artifact)], out_dir, run_id="monitor-run", bot_commit="c" * 40)
            rows = read_ndjson(out_dir / "monitor-run" / "ticks.ndjson")

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["source"]["artifactKind"], "monitor-summary-json")
        self.assertEqual(row["observation"]["roomName"], "E26S49")
        self.assertEqual(row["observation"]["shard"], "shardX")
        self.assertEqual(row["observation"]["workers"]["count"], 3)
        self.assertEqual(row["observation"]["combat"]["hostileCreepCount"], 2)
        self.assertEqual(row["observation"]["monitor"]["ownedSpawnCount"], 1)

    def test_strategy_shadow_report_metadata_is_indexed_without_raw_report_copy(self) -> None:
        runtime_payload = {
            "type": "runtime-summary",
            "tick": 42,
            "rooms": [{"roomName": "W1N1", "resources": {"storedEnergy": 3}}],
        }
        shadow_report = {
            "enabled": True,
            "artifactCount": 1,
            "modelReports": [
                {
                    "incumbentStrategyId": "construction-priority.incumbent.v1",
                    "candidateStrategyId": "construction-priority.territory-shadow.v1",
                    "family": "construction-priority",
                    "rankingDiffs": [{"changedTop": True}, {"changedTop": False}],
                }
            ],
            "warnings": ["do not copy this raw warning"],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            runtime_artifact = root / "runtime.log"
            shadow_artifact = root / "shadow.json"
            runtime_artifact.write_text(runtime_line(runtime_payload), encoding="utf-8")
            shadow_artifact.write_text(json.dumps(shadow_report, sort_keys=True), encoding="utf-8")
            out_dir = root / "datasets"

            summary = exporter.build_dataset(
                [str(runtime_artifact), str(shadow_artifact)],
                out_dir,
                run_id="shadow-run",
                bot_commit="e" * 40,
            )
            source_index = read_json(out_dir / "shadow-run" / "source_index.json")
            run_manifest = read_json(out_dir / "shadow-run" / "run_manifest.json")

        self.assertEqual(summary["strategyShadowReportCount"], 1)
        self.assertEqual(source_index["strategyShadowReportCount"], 1)
        shadow_metadata = run_manifest["strategy"]["shadowReports"][0]
        self.assertEqual(shadow_metadata["families"], ["construction-priority"])
        self.assertEqual(shadow_metadata["rankingDiffCount"], 2)
        self.assertNotIn("warnings", shadow_metadata)

    def test_cli_output_and_dataset_do_not_include_configured_secret_or_raw_artifact_line(self) -> None:
        secret = "supersecret123456"
        payload = {
            "type": "runtime-summary",
            "tick": 5,
            "token": secret,
            "rooms": [{"roomName": "W1N1", "resources": {"storedEnergy": 3}}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            artifact.write_text(runtime_line(payload), encoding="utf-8")
            out_dir = root / "datasets"
            output = io.StringIO()

            with mock.patch.dict(os.environ, {"SCREEPS_AUTH_TOKEN": secret}):
                exit_code = exporter.main(
                    [
                        str(artifact),
                        "--out-dir",
                        str(out_dir),
                        "--run-id",
                        "secret-run",
                        "--bot-commit",
                        "d" * 40,
                    ],
                    stdout=output,
                )

            run_dir = out_dir / "secret-run"
            exported_text = "\n".join(path.read_text(encoding="utf-8") for path in sorted(run_dir.iterdir()))

        self.assertEqual(exit_code, 0)
        self.assertNotIn(secret, output.getvalue())
        self.assertNotIn(secret, exported_text)
        self.assertNotIn("#runtime-summary", output.getvalue())
        self.assertNotIn("#runtime-summary", exported_text)

    def test_secret_leak_detection_removes_generated_run_directory(self) -> None:
        secret = "leaked-secret-123456"
        payload = {
            "type": "runtime-summary",
            "tick": 7,
            "rooms": [{"roomName": "W1N1", "resources": {"storedEnergy": 3}}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime.log"
            artifact.write_text(runtime_line(payload), encoding="utf-8")
            out_dir = root / "datasets"
            run_dir = out_dir / "leak-run"

            with mock.patch.dict(os.environ, {"SCREEPS_AUTH_TOKEN": secret}):
                with mock.patch.object(exporter, "render_dataset_card", return_value=f"leak: {secret}\n"):
                    with self.assertRaisesRegex(RuntimeError, "dataset_card\\.md"):
                        exporter.build_dataset(
                            [str(artifact)],
                            out_dir,
                            run_id="leak-run",
                            bot_commit="f" * 40,
                        )

            self.assertFalse(run_dir.exists())


if __name__ == "__main__":
    unittest.main()
