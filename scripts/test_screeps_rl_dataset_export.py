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


def active_runtime_payload(tick: int, *, room_name: str = "E29N55", rcl: int = 4) -> dict[str, object]:
    return {
        "type": "runtime-summary",
        "tick": tick,
        "rooms": [
            {
                "roomName": room_name,
                "energyAvailable": 300,
                "workerCount": 4,
                "spawnStatus": [{"name": "Spawn1", "status": "idle"}],
                "taskCounts": {"harvest": 1, "upgrade": 1, "none": 0},
                "controller": {"level": rcl, "progress": 1000, "ticksToDowngrade": 10000},
                "resources": {"storedEnergy": 500, "workerCarriedEnergy": 25},
                "combat": {"hostileCreepCount": 0, "hostileStructureCount": 0},
            }
        ],
    }


def dead_state_runtime_payload(tick: int, *, room_name: str = "E29N55") -> dict[str, object]:
    return {
        "type": "runtime-summary",
        "source": "screeps-runtime-monitor",
        "tick": tick,
        "rooms": [
            {
                "roomName": room_name,
                "rclLevel": 1,
                "taskCounts": {"harvest": 0, "upgrade": 0, "build": 0, "none": 0},
                "controller": {"level": 1, "progress": 0, "progressTotal": 0},
                "resources": {"storedEnergy": 2430, "workerCarriedEnergy": 0},
                "workerAssignmentEvidence": {"workerCount": 0, "visibleCreepCount": 0},
                "combat": {"hostileCreepCount": 0, "hostileStructureCount": 0},
            }
        ],
    }


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
                        "harvestedThisTick": 80,
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
        self.assertEqual(
            [label["policyFamily"] for label in row["actionLabels"]],
            ["top.construction", "top.remote-expansion"],
        )
        self.assertEqual(row["observation"]["resources"]["harvestedThisTick"], 80)
        self.assertEqual(row["reward"]["components"]["resources"]["harvestedThisTick"], 80)
        self.assertEqual(row["reward"]["components"]["resources"]["harvestedEnergy"], 80)
        self.assertEqual(run_manifest["strategy"]["decisionSurfacesObserved"], [
            "construction-priority",
            "expansion-remote-candidate",
        ])
        self.assertFalse(run_manifest["strategy"]["liveEffect"])
        self.assertEqual(
            [lane["policyFamily"] for lane in run_manifest["rolePolicyLanes"]["initialLanes"]],
            ["role.worker-task", "role.source-harvester", "role.defender-micro"],
        )
        self.assertEqual(run_manifest["rolePolicyMetadata"]["rolePolicyFamilies"], [])
        self.assertEqual(kpi_windows["input"]["runtimeSummaryCount"], 1)
        self.assertEqual(kpi_windows["resources"]["totals"]["latest"]["storedEnergy"], 420)
        self.assertEqual(kpi_windows["resources"]["totals"]["latest"]["harvestedThisTick"], 80)

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

    def test_default_export_reruns_exclude_prior_datasets_from_scan(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 11,
            "rooms": [{"roomName": "W1N1", "resources": {"storedEnergy": 2}}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            runtime_root = root / "runtime-artifacts"
            runtime_root.mkdir()
            artifact = runtime_root / "runtime.log"
            artifact.write_text(runtime_line(payload), encoding="utf-8")
            out_dir = runtime_root / "rl-datasets"

            with mock.patch.object(exporter, "DEFAULT_INPUT_PATHS", (str(runtime_root),)):
                first = exporter.build_dataset([], out_dir, bot_commit="b" * 40)
                second = exporter.build_dataset([], out_dir, bot_commit="b" * 40)

        self.assertEqual(first["runId"], second["runId"])
        self.assertEqual(first["sourceArtifactCount"], 1)
        self.assertEqual(second["sourceArtifactCount"], 1)
        self.assertEqual(first["runtimeSummaryArtifactCount"], 1)
        self.assertEqual(second["runtimeSummaryArtifactCount"], 1)

    def test_console_capture_only_flag_is_accepted(self) -> None:
        args = exporter.build_parser().parse_args(["--console-capture-only"])

        self.assertTrue(args.console_capture_only)
        self.assertEqual(args.paths, [])

    def test_default_input_paths_are_unchanged_without_console_capture_only(self) -> None:
        self.assertEqual(
            exporter.DEFAULT_INPUT_PATHS,
            (
                "/root/screeps/runtime-artifacts",
                "/root/.hermes/cron/output",
                "runtime-artifacts",
            ),
        )

        args = exporter.build_parser().parse_args([])
        stderr = io.StringIO()

        self.assertEqual(exporter.resolve_cli_input_paths(args, stderr), [])
        self.assertEqual(stderr.getvalue(), "")

    def test_console_capture_only_overrides_positional_paths_with_warning(self) -> None:
        args = exporter.build_parser().parse_args(["/tmp/ignored", "--console-capture-only"])
        stderr = io.StringIO()

        self.assertEqual(exporter.resolve_cli_input_paths(args, stderr), list(exporter.CONSOLE_CAPTURE_INPUT_PATHS))
        self.assertIn("--console-capture-only ignores positional input paths", stderr.getvalue())

    def test_console_capture_only_run_completes_with_sample_limit_flags(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 120,
            "rooms": [{"roomName": "E26S49", "resources": {"storedEnergy": 154, "workerCarriedEnergy": 25}}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            console_root = root / "runtime-summary-console"
            console_root.mkdir()
            artifact = console_root / "runtime.log"
            artifact.write_text(runtime_line(payload), encoding="utf-8")
            out_dir = root / "datasets"
            stdout = io.StringIO()

            with mock.patch.object(exporter, "CONSOLE_CAPTURE_INPUT_PATHS", (str(console_root),)):
                exit_code = exporter.main(
                    [
                        "--console-capture-only",
                        "--sample-limit",
                        "5",
                        "--max-file-bytes",
                        "1048576",
                        "--out-dir",
                        str(out_dir),
                        "--run-id",
                        "console-capture-run",
                        "--bot-commit",
                        "1" * 40,
                    ],
                    stdout=stdout,
                    stderr=io.StringIO(),
                )

            summary = json.loads(stdout.getvalue())

        self.assertEqual(exit_code, 0)
        self.assertEqual(summary["sampleCount"], 1)
        self.assertEqual(summary["runtimeSummaryArtifactCount"], 1)

    def test_console_capture_only_defaults_to_recent_source_window(self) -> None:
        old_payload = {
            "type": "runtime-summary",
            "tick": 119,
            "rooms": [{"roomName": "E26S49", "resources": {"storedEnergy": 10}}],
        }
        current_payload = {
            "type": "runtime-summary",
            "tick": 120,
            "rooms": [{"roomName": "E29N55", "resources": {"storedEnergy": 250}}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            console_root = root / "runtime-summary-console"
            console_root.mkdir()
            old_artifact = console_root / "runtime-summary-console-20260510T173515Z.log"
            current_artifact = console_root / "runtime-summary-console-20260603T150458Z.log"
            old_artifact.write_text(runtime_line(old_payload), encoding="utf-8")
            current_artifact.write_text(runtime_line(current_payload), encoding="utf-8")
            os.utime(old_artifact, (0, 0))
            out_dir = root / "datasets"
            stdout = io.StringIO()

            with mock.patch.object(exporter, "CONSOLE_CAPTURE_INPUT_PATHS", (str(console_root),)):
                exit_code = exporter.main(
                    [
                        "--console-capture-only",
                        "--out-dir",
                        str(out_dir),
                        "--run-id",
                        "recent-console-capture-run",
                        "--bot-commit",
                        "1" * 40,
                    ],
                    stdout=stdout,
                    stderr=io.StringIO(),
                )

            summary = json.loads(stdout.getvalue())
            rows = read_ndjson(out_dir / "recent-console-capture-run" / "ticks.ndjson")
            source_index = read_json(out_dir / "recent-console-capture-run" / "source_index.json")
            run_manifest = read_json(out_dir / "recent-console-capture-run" / "run_manifest.json")

        self.assertEqual(exit_code, 0)
        self.assertEqual(summary["sampleCount"], 1)
        self.assertEqual(summary["runtimeSummaryArtifactCount"], 1)
        self.assertEqual(summary["skippedFileReasons"], {"older_than_max_age": 1})
        self.assertEqual(summary["sourceMaxAgeHours"], exporter.CONSOLE_CAPTURE_MAX_AGE_HOURS)
        self.assertEqual(rows[0]["observation"]["roomName"], "E29N55")
        self.assertEqual(source_index["sourceMaxAgeHours"], exporter.CONSOLE_CAPTURE_MAX_AGE_HOURS)
        self.assertEqual(source_index["skippedFileReasons"], {"older_than_max_age": 1})
        self.assertEqual(run_manifest["source"]["sourceMaxAgeHours"], exporter.CONSOLE_CAPTURE_MAX_AGE_HOURS)
        self.assertEqual(run_manifest["source"]["skippedFileReasons"], {"older_than_max_age": 1})

    def test_duplicate_input_roots_are_scanned_once(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 121,
            "rooms": [{"roomName": "E29N55", "resources": {"storedEnergy": 250}}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-summary-console"
            artifact_root.mkdir()
            artifact = artifact_root / "runtime-summary-console-20260521T025000Z.log"
            artifact.write_text(runtime_line(payload), encoding="utf-8")
            out_dir = root / "datasets"

            summary = exporter.build_dataset(
                [str(artifact_root), str(artifact_root)],
                out_dir,
                run_id="deduped-input-root-run",
                bot_commit="2" * 40,
                eval_ratio_value=0,
                created_at="2026-05-21T03:03:07Z",
                home_room="E29N55",
            )
            source_index = read_json(out_dir / "deduped-input-root-run" / "source_index.json")

        self.assertEqual(summary["sampleCount"], 1)
        self.assertEqual(summary["runtimeSummaryArtifactCount"], 1)
        self.assertEqual(source_index["scannedFiles"], 1)
        self.assertEqual(source_index["inputPaths"], [str(artifact_root)])

    def test_stale_non_current_console_capture_sample_is_filtered_with_evidence(self) -> None:
        stale_payload = {
            "type": "runtime-summary",
            "tick": 786180,
            "rooms": [{"roomName": "E26S48", "resources": {"storedEnergy": 0}}],
        }
        current_payload = {
            "type": "runtime-summary",
            "tick": 1056600,
            "rooms": [{"roomName": "E29N55", "resources": {"storedEnergy": 250}}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            stale_artifact = root / "runtime-summary-console-20260510T173515Z.log"
            current_artifact = root / "runtime-summary-console-20260521T025000Z.log"
            stale_artifact.write_text(runtime_line(stale_payload), encoding="utf-8")
            current_artifact.write_text(runtime_line(current_payload), encoding="utf-8")
            out_dir = root / "datasets"

            summary = exporter.build_dataset(
                [str(stale_artifact), str(current_artifact)],
                out_dir,
                run_id="stale-filter-run",
                bot_commit="1" * 40,
                eval_ratio_value=0,
                created_at="2026-05-21T03:03:07Z",
                home_room="E29N55",
            )
            rows = read_ndjson(out_dir / "stale-filter-run" / "ticks.ndjson")
            source_index = read_json(out_dir / "stale-filter-run" / "source_index.json")
            run_manifest = read_json(out_dir / "stale-filter-run" / "run_manifest.json")

        self.assertEqual(summary["sampleCount"], 1)
        self.assertEqual(summary["runtimeSummaryArtifactCount"], 1)
        self.assertEqual(summary["skippedSampleCount"], 1)
        self.assertEqual(
            summary["skippedSampleReasons"],
            {exporter.STALE_NON_CURRENT_CONSOLE_CAPTURE_SKIP_REASON: 1},
        )
        self.assertEqual(rows[0]["observation"]["roomName"], "E29N55")
        skipped_sample = source_index["skippedSamples"][0]
        self.assertEqual(skipped_sample["reason"], exporter.STALE_NON_CURRENT_CONSOLE_CAPTURE_SKIP_REASON)
        self.assertEqual(skipped_sample["roomName"], "E26S48")
        self.assertEqual(skipped_sample["homeRoom"], "E29N55")
        self.assertGreater(skipped_sample["sourceAgeHours"], 24)
        self.assertEqual(run_manifest["source"]["skippedSampleCount"], 1)

    def test_malformed_created_at_uses_console_capture_reference_for_stale_filter(self) -> None:
        stale_payload = {
            "type": "runtime-summary",
            "tick": 786180,
            "rooms": [{"roomName": "E26S48", "resources": {"storedEnergy": 0}}],
        }
        current_payload = {
            "type": "runtime-summary",
            "tick": 1056600,
            "rooms": [{"roomName": "E29N55", "resources": {"storedEnergy": 250}}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            stale_artifact = root / "runtime-summary-console-20260510T173515Z.log"
            current_artifact = root / "runtime-summary-console-20260521T025000Z.log"
            stale_artifact.write_text(runtime_line(stale_payload), encoding="utf-8")
            current_artifact.write_text(runtime_line(current_payload), encoding="utf-8")
            out_dir = root / "datasets"

            summary = exporter.build_dataset(
                [str(stale_artifact), str(current_artifact)],
                out_dir,
                run_id="stale-filter-invalid-created-at-run",
                bot_commit="1" * 40,
                eval_ratio_value=0,
                created_at="INVALID_TIMESTAMP",
                home_room="E29N55",
            )
            rows = read_ndjson(out_dir / "stale-filter-invalid-created-at-run" / "ticks.ndjson")
            source_index = read_json(out_dir / "stale-filter-invalid-created-at-run" / "source_index.json")
            run_manifest = read_json(out_dir / "stale-filter-invalid-created-at-run" / "run_manifest.json")

        self.assertEqual(summary["sampleCount"], 1)
        self.assertEqual(summary["skippedSampleCount"], 1)
        self.assertEqual(
            summary["skippedSampleReasons"],
            {exporter.STALE_NON_CURRENT_CONSOLE_CAPTURE_SKIP_REASON: 1},
        )
        self.assertEqual(rows[0]["observation"]["roomName"], "E29N55")
        skipped_sample = source_index["skippedSamples"][0]
        self.assertEqual(skipped_sample["reason"], exporter.STALE_NON_CURRENT_CONSOLE_CAPTURE_SKIP_REASON)
        self.assertEqual(skipped_sample["roomName"], "E26S48")
        self.assertEqual(skipped_sample["homeRoom"], "E29N55")
        self.assertGreater(skipped_sample["sourceAgeHours"], 24)
        self.assertEqual(skipped_sample["sourceWindowReferenceAt"], "2026-05-21T02:50:00Z")
        self.assertEqual(run_manifest["source"]["skippedSampleCount"], 1)

    def test_fresh_current_home_console_capture_sample_remains_eligible(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 1056600,
            "rooms": [{"roomName": "E29N55", "resources": {"storedEnergy": 250}}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime-summary-console-20260521T025000Z.log"
            artifact.write_text(runtime_line(payload), encoding="utf-8")
            out_dir = root / "datasets"

            summary = exporter.build_dataset(
                [str(artifact)],
                out_dir,
                run_id="fresh-home-run",
                bot_commit="2" * 40,
                eval_ratio_value=0,
                created_at="2026-05-21T03:03:07Z",
                home_room="E29N55",
            )
            rows = read_ndjson(out_dir / "fresh-home-run" / "ticks.ndjson")

        self.assertEqual(summary["sampleCount"], 1)
        self.assertEqual(summary["skippedSampleCount"], 0)
        self.assertEqual(summary["deadStateQuarantine"]["quarantined_dead_state_samples"], 0)
        self.assertEqual(summary["deadStateQuarantine"]["zero_creep_samples"], 0)
        self.assertEqual(summary["deadStateQuarantine"]["rcl1_samples"], 0)
        self.assertTrue(summary["deadStateQuarantine"]["samples_remain_eligible_for_training"])
        self.assertEqual(rows[0]["observation"]["roomName"], "E29N55")

    def test_dead_state_runtime_samples_are_quarantined_with_counts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            stable_artifact = root / "runtime-summary-console-20260624T115900Z.log"
            dead_artifact = root / "runtime-summary-console-20260624T131214Z.log"
            stable_artifact.write_text(runtime_line(active_runtime_payload(2558700, rcl=4)), encoding="utf-8")
            dead_artifact.write_text(runtime_line(dead_state_runtime_payload(2560700)), encoding="utf-8")
            out_dir = root / "datasets"

            summary = exporter.build_dataset(
                [str(stable_artifact), str(dead_artifact)],
                out_dir,
                run_id="dead-state-quarantine-run",
                bot_commit="5" * 40,
                eval_ratio_value=0,
                created_at="2026-06-24T16:30:00Z",
                home_room="E29N55",
            )
            rows = read_ndjson(out_dir / "dead-state-quarantine-run" / "ticks.ndjson")
            source_index = read_json(out_dir / "dead-state-quarantine-run" / "source_index.json")
            run_manifest = read_json(out_dir / "dead-state-quarantine-run" / "run_manifest.json")

        quarantine = summary["deadStateQuarantine"]
        self.assertEqual(summary["sampleCount"], 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["observation"]["controller"]["level"], 4)
        self.assertEqual(summary["skippedSampleCount"], 1)
        self.assertEqual(summary["skippedSampleReasons"], {exporter.DEAD_STATE_RUNTIME_SAMPLE_SKIP_REASON: 1})
        self.assertEqual(quarantine["quarantined_dead_state_samples"], 1)
        self.assertEqual(quarantine["zero_creep_samples"], 1)
        self.assertEqual(quarantine["rcl1_samples"], 1)
        self.assertEqual(quarantine["source_time_range"]["min"], "2026-06-24T11:59:00Z")
        self.assertEqual(quarantine["source_time_range"]["max"], "2026-06-24T13:12:14Z")
        self.assertEqual(quarantine["training_eligibility"], "eligible_samples_remain_after_quarantine")
        self.assertTrue(quarantine["samples_remain_eligible_for_training"])
        skipped_sample = source_index["skippedSamples"][0]
        self.assertEqual(skipped_sample["reason"], exporter.DEAD_STATE_RUNTIME_SAMPLE_SKIP_REASON)
        self.assertEqual(
            skipped_sample["deadStateReasons"],
            [
                exporter.DEAD_STATE_ZERO_CREEP_REASON,
                exporter.DEAD_STATE_RCL1_AFTER_STABLE_REASON,
            ],
        )
        self.assertFalse(skipped_sample["samplesEligibleForTraining"])
        self.assertEqual(run_manifest["source"]["deadStateQuarantine"], quarantine)

    def test_dead_state_quarantine_uses_source_timestamp_before_path_order(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            stable_artifact = root / "z-stable" / "runtime-summary-console-20260624T115900Z.log"
            dead_artifact = root / "a-dead" / "runtime-summary-console-20260624T131214Z.log"
            stable_artifact.parent.mkdir(parents=True)
            dead_artifact.parent.mkdir(parents=True)
            stable_artifact.write_text(runtime_line(active_runtime_payload(2558700, rcl=4)), encoding="utf-8")
            dead_artifact.write_text(runtime_line(active_runtime_payload(2560700, rcl=1)), encoding="utf-8")
            out_dir = root / "datasets"

            summary = exporter.build_dataset(
                [str(root)],
                out_dir,
                run_id="dead-state-chronological-run",
                bot_commit="8" * 40,
                eval_ratio_value=0,
                created_at="2026-06-24T16:30:00Z",
                home_room="E29N55",
            )
            rows = read_ndjson(out_dir / "dead-state-chronological-run" / "ticks.ndjson")
            source_index = read_json(out_dir / "dead-state-chronological-run" / "source_index.json")

        quarantine = summary["deadStateQuarantine"]
        self.assertEqual(summary["sampleCount"], 1)
        self.assertEqual(rows[0]["observation"]["controller"]["level"], 4)
        self.assertEqual(summary["skippedSampleCount"], 1)
        self.assertEqual(quarantine["quarantined_dead_state_samples"], 1)
        self.assertEqual(quarantine["zero_creep_samples"], 0)
        self.assertEqual(quarantine["rcl1_samples"], 1)
        skipped_sample = source_index["skippedSamples"][0]
        self.assertEqual(
            skipped_sample["deadStateReasons"],
            [exporter.DEAD_STATE_RCL1_AFTER_STABLE_REASON],
        )
        self.assertEqual(skipped_sample["priorMaxRcl"], 4)

    def test_dead_state_runtime_samples_can_be_kept_for_recovery_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            stable_artifact = root / "runtime-summary-console-20260624T115900Z.log"
            dead_artifact = root / "runtime-summary-console-20260624T131214Z.log"
            stable_artifact.write_text(runtime_line(active_runtime_payload(2558700, rcl=4)), encoding="utf-8")
            dead_artifact.write_text(runtime_line(dead_state_runtime_payload(2560700)), encoding="utf-8")
            out_dir = root / "datasets"

            summary = exporter.build_dataset(
                [str(stable_artifact), str(dead_artifact)],
                out_dir,
                run_id="dead-state-recovery-run",
                bot_commit="6" * 40,
                eval_ratio_value=0,
                created_at="2026-06-24T16:30:00Z",
                home_room="E29N55",
                allow_recovery_dead_state_samples=True,
            )
            rows = read_ndjson(out_dir / "dead-state-recovery-run" / "ticks.ndjson")

        quarantine = summary["deadStateQuarantine"]
        self.assertEqual(summary["sampleCount"], 2)
        self.assertEqual(len(rows), 2)
        self.assertEqual(summary["skippedSampleCount"], 0)
        self.assertTrue(quarantine["recovery_mode"])
        self.assertEqual(quarantine["quarantined_dead_state_samples"], 0)
        self.assertEqual(quarantine["zero_creep_samples"], 1)
        self.assertEqual(quarantine["rcl1_samples"], 1)
        self.assertEqual(quarantine["training_eligibility"], "recovery_mode_dataset")
        dead_state_rows = [
            row
            for row in rows
            if row["observation"]["controller"]["level"] == exporter.COLLAPSED_ROOM_RCL_LEVEL
        ]
        self.assertEqual(len(dead_state_rows), 1)
        self.assertEqual(
            dead_state_rows[0][exporter.DEAD_STATE_SAMPLE_MARKER]["reasons"],
            [
                exporter.DEAD_STATE_ZERO_CREEP_REASON,
                exporter.DEAD_STATE_RCL1_AFTER_STABLE_REASON,
            ],
        )

    def test_owned_room_count_collapse_quarantines_current_window_samples(self) -> None:
        prior_payload = active_runtime_payload(2558700, room_name="E29N55", rcl=6)
        prior_payload["rooms"].append(
            {
                "roomName": "E29N56",
                "energyAvailable": 300,
                "workerCount": 2,
                "spawnStatus": [{"name": "Spawn2", "status": "idle"}],
                "taskCounts": {"harvest": 1, "upgrade": 0, "none": 0},
                "controller": {"level": 4, "progress": 1000, "ticksToDowngrade": 10000},
                "resources": {"storedEnergy": 300, "workerCarriedEnergy": 0},
                "combat": {"hostileCreepCount": 0, "hostileStructureCount": 0},
            }
        )
        current_payload = active_runtime_payload(2560700, room_name="E29N55", rcl=3)

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            prior_artifact = root / "runtime-summary-console-20260624T115900Z.log"
            current_artifact = root / "runtime-summary-console-20260624T131214Z.log"
            prior_artifact.write_text(runtime_line(prior_payload), encoding="utf-8")
            current_artifact.write_text(runtime_line(current_payload), encoding="utf-8")
            out_dir = root / "datasets"

            summary = exporter.build_dataset(
                [str(prior_artifact), str(current_artifact)],
                out_dir,
                run_id="owned-room-collapse-run",
                bot_commit="7" * 40,
                eval_ratio_value=0,
                created_at="2026-06-24T16:30:00Z",
                home_room="E29N55",
            )
            rows = read_ndjson(out_dir / "owned-room-collapse-run" / "ticks.ndjson")
            source_index = read_json(out_dir / "owned-room-collapse-run" / "source_index.json")

        quarantine = summary["deadStateQuarantine"]
        self.assertEqual(summary["sampleCount"], 2)
        self.assertEqual({row["observation"]["roomName"] for row in rows}, {"E29N55", "E29N56"})
        self.assertEqual(summary["skippedSampleReasons"], {exporter.DEAD_STATE_RUNTIME_SAMPLE_SKIP_REASON: 1})
        self.assertEqual(quarantine["quarantined_dead_state_samples"], 1)
        self.assertEqual(quarantine["owned_room_collapse_samples"], 1)
        self.assertIn(
            exporter.DEAD_STATE_OWNED_ROOM_COLLAPSE_REASON,
            source_index["skippedSamples"][0]["deadStateReasons"],
        )

    def test_stale_skipped_samples_are_summarized_without_full_source_index_log(self) -> None:
        current_payload = {
            "type": "runtime-summary",
            "tick": 1056600,
            "rooms": [{"roomName": "E29N55", "resources": {"storedEnergy": 250}}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            for index in range(exporter.SKIPPED_SAMPLE_LOG_LIMIT + 5):
                stale_payload = {
                    "type": "runtime-summary",
                    "tick": 786180 + index,
                    "rooms": [{"roomName": f"E26S{index % 10}", "resources": {"storedEnergy": 0}}],
                }
                stale_artifact = root / f"runtime-summary-console-20260510T1735{index % 60:02d}Z-{index}.log"
                stale_artifact.write_text(runtime_line(stale_payload), encoding="utf-8")

            current_artifact = root / "runtime-summary-console-20260521T025000Z.log"
            current_artifact.write_text(runtime_line(current_payload), encoding="utf-8")
            out_dir = root / "datasets"

            summary = exporter.build_dataset(
                [str(root)],
                out_dir,
                run_id="bounded-skipped-source-index-run",
                bot_commit="3" * 40,
                sample_limit=1,
                eval_ratio_value=0,
                created_at="2026-05-21T03:03:07Z",
                home_room="E29N55",
            )
            rows = read_ndjson(out_dir / "bounded-skipped-source-index-run" / "ticks.ndjson")
            source_index = read_json(out_dir / "bounded-skipped-source-index-run" / "source_index.json")
            run_manifest = read_json(out_dir / "bounded-skipped-source-index-run" / "run_manifest.json")

        skipped_count = exporter.SKIPPED_SAMPLE_LOG_LIMIT + 5
        self.assertEqual(summary["sampleCount"], 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["observation"]["roomName"], "E29N55")
        self.assertEqual(source_index["skippedSampleCount"], skipped_count)
        self.assertEqual(len(source_index["skippedSamples"]), exporter.SKIPPED_SAMPLE_LOG_LIMIT)
        self.assertEqual(source_index["skippedSamplesTruncated"], 5)
        self.assertEqual(run_manifest["source"]["skippedSampleCount"], skipped_count)
        self.assertEqual(len(run_manifest["source"]["skippedSamples"]), exporter.SKIPPED_SAMPLE_LOG_LIMIT)

    def test_skipped_files_are_summarized_without_full_source_index_log(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 1056600,
            "rooms": [{"roomName": "E29N55", "resources": {"storedEnergy": 250}}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "runtime-summary-console-20260521T025000Z.log"
            artifact.write_text(runtime_line(payload), encoding="utf-8")
            skipped_count = exporter.SKIPPED_FILE_LOG_LIMIT + 7
            for index in range(skipped_count):
                (root / f"binary-{index:03d}.log").write_bytes(b"\0")
            out_dir = root / "datasets"

            summary = exporter.build_dataset(
                [str(root)],
                out_dir,
                run_id="bounded-skipped-files-run",
                bot_commit="4" * 40,
                eval_ratio_value=0,
                created_at="2026-05-21T03:03:07Z",
                home_room="E29N55",
            )
            source_index = read_json(out_dir / "bounded-skipped-files-run" / "source_index.json")

        self.assertEqual(summary["sampleCount"], 1)
        self.assertEqual(summary["skippedFileCount"], skipped_count)
        self.assertEqual(source_index["skippedFileCount"], skipped_count)
        self.assertEqual(source_index["skippedFileReasons"], {"binary": skipped_count})
        self.assertEqual(len(source_index["skippedFiles"]), exporter.SKIPPED_FILE_LOG_LIMIT)
        self.assertEqual(source_index["skippedFilesTruncated"], 7)

    def test_generated_rl_dataset_source_index_directory_is_not_rescanned(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 1056600,
            "rooms": [{"roomName": "E29N55", "resources": {"storedEnergy": 250}}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact_root = root / "runtime-artifacts"
            generated_dataset_dir = artifact_root / "rl-datasets" / "old-run"
            generated_dataset_dir.mkdir(parents=True)
            generated_source_index = generated_dataset_dir / "source_index.json"
            generated_source_index.write_text(
                json.dumps(
                    {
                        "type": "screeps-rl-source-index",
                        "skippedSamples": [
                            {
                                "reason": exporter.STALE_NON_CURRENT_CONSOLE_CAPTURE_SKIP_REASON,
                                "path": f"runtime-summary-console-20260510T0000{index:02d}Z.log",
                                "roomName": "E26S49",
                            }
                            for index in range(60)
                        ],
                    },
                    sort_keys=True,
                ),
                encoding="utf-8",
            )
            runtime_artifact = artifact_root / "runtime-summary-console-20260521T025000Z.log"
            runtime_artifact.write_text(runtime_line(payload), encoding="utf-8")
            out_dir = artifact_root / "rl-datasets-new"
            original_scan_file = exporter.scan_file
            scanned_paths: list[Path] = []

            def tracking_scan_file(path: Path, *args: object, **kwargs: object) -> None:
                scanned_paths.append(path)
                original_scan_file(path, *args, **kwargs)

            with mock.patch.object(exporter, "scan_file", side_effect=tracking_scan_file):
                summary = exporter.build_dataset(
                    [str(artifact_root)],
                    out_dir,
                    run_id="skip-generated-source-index-run",
                    bot_commit="4" * 40,
                    eval_ratio_value=0,
                    created_at="2026-05-21T03:03:07Z",
                    home_room="E29N55",
                )

        self.assertEqual(summary["sampleCount"], 1)
        self.assertNotIn(generated_source_index, scanned_paths)

    def test_incomplete_postdeploy_monitor_summary_json_is_filtered_from_samples(self) -> None:
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
            artifact = root / "postdeploy-observation-20260517T140626Z.json"
            artifact.write_text(json.dumps(monitor_payload, sort_keys=True), encoding="utf-8")
            out_dir = root / "datasets"

            summary = exporter.build_dataset([str(artifact)], out_dir, run_id="monitor-run", bot_commit="c" * 40)
            rows = read_ndjson(out_dir / "monitor-run" / "ticks.ndjson")
            source_index = read_json(out_dir / "monitor-run" / "source_index.json")

        self.assertEqual(summary["sampleCount"], 0)
        self.assertEqual(summary["runtimeSummaryArtifactCount"], 0)
        self.assertEqual(len(rows), 0)
        self.assertEqual(source_index["matchedArtifactCount"], 0)
        self.assertEqual(source_index["skippedFiles"][0]["reason"], "incomplete_derived_runtime_summary")
        self.assertEqual(source_index["skippedFiles"][0]["artifactKind"], "monitor-summary-json")

    def test_incomplete_postdeploy_runtime_summary_json_is_filtered_by_basename(self) -> None:
        runtime_payload = {
            "type": "runtime-summary",
            "tick": 123,
            "rooms": [
                {
                    "roomName": "E29N55",
                    "workerCount": 9,
                    "spawnStatus": [{"name": "Spawn1", "status": "idle"}],
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = root / "postdeploy-observation-20260517T140626Z.json"
            artifact.write_text(json.dumps(runtime_payload, sort_keys=True), encoding="utf-8")
            out_dir = root / "datasets"

            summary = exporter.build_dataset([str(artifact)], out_dir, run_id="postdeploy-run", bot_commit="d" * 40)
            rows = read_ndjson(out_dir / "postdeploy-run" / "ticks.ndjson")
            source_index = read_json(out_dir / "postdeploy-run" / "source_index.json")

        self.assertEqual(summary["sampleCount"], 0)
        self.assertEqual(summary["runtimeSummaryArtifactCount"], 0)
        self.assertEqual(len(rows), 0)
        self.assertEqual(source_index["matchedArtifactCount"], 0)
        self.assertEqual(source_index["skippedFiles"][0]["reason"], "incomplete_derived_runtime_summary")
        self.assertEqual(source_index["skippedFiles"][0]["artifactKind"], "runtime-summary-json")

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
                    "rankingContextCount": 3,
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
        self.assertEqual(shadow_metadata["rankingContextCount"], 3)
        self.assertEqual(shadow_metadata["rankingDiffCount"], 2)
        self.assertEqual(shadow_metadata["changedTopCount"], 1)
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

    def test_secret_leak_detection_preserves_existing_run_directory(self) -> None:
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
            run_dir.mkdir(parents=True)
            sentinel = run_dir / "sentinel.txt"
            sentinel.write_text("keep me\n", encoding="utf-8")

            with mock.patch.dict(os.environ, {"SCREEPS_AUTH_TOKEN": secret}):
                with mock.patch.object(exporter, "render_dataset_card", return_value=f"leak: {secret}\n"):
                    with self.assertRaisesRegex(RuntimeError, "dataset_card\\.md"):
                        exporter.build_dataset(
                            [str(artifact)],
                            out_dir,
                            run_id="leak-run",
                            bot_commit="f" * 40,
                        )

            self.assertTrue(run_dir.exists())
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep me\n")
            self.assertEqual(sorted(path.name for path in run_dir.iterdir()), ["sentinel.txt"])


if __name__ == "__main__":
    unittest.main()
