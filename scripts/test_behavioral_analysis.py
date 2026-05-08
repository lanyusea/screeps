#!/usr/bin/env python3
from __future__ import annotations

import html
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("screeps-behavioral-analysis.py")
SPEC = importlib.util.spec_from_file_location("screeps_behavioral_analysis", MODULE_PATH)
assert SPEC is not None
analysis = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = analysis
SPEC.loader.exec_module(analysis)


def runtime_line(payload: dict[str, object], *, escaped: bool = False) -> str:
    text = json.dumps(payload, sort_keys=True)
    if escaped:
        text = html.escape(text, quote=True)
    return f"#runtime-summary {text}\n"


class BehavioralAnalysisTest(unittest.TestCase):
    def test_parses_html_escaped_runtime_summary_lines(self) -> None:
        payload = {"type": "runtime-summary", "tick": 10, "rooms": [{"roomName": "W1N1"}]}

        parsed = analysis.parse_runtime_summary_line(runtime_line(payload, escaped=True))

        self.assertEqual(parsed, payload)

    def test_build_report_detects_critical_inefficiencies_from_runtime_history(self) -> None:
        first = {
            "type": "runtime-summary",
            "tick": 100,
            "rooms": [
                {
                    "roomName": "W1N1",
                    "energyAvailable": 300,
                    "energyCapacity": 300,
                    "workerCount": 2,
                    "spawnStatus": [{"name": "Spawn1", "status": "idle"}],
                    "taskCounts": {"harvest": 0, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 2},
                    "controller": {"level": 3, "progress": 1000, "progressTotal": 45000},
                    "resources": {
                        "storedEnergy": 300,
                        "workerCarriedEnergy": 100,
                        "harvestedThisTick": 0,
                        "droppedEnergy": 0,
                        "sourceCount": 2,
                        "productiveEnergy": {
                            "assignedWorkerCount": 0,
                            "assignedCarriedEnergy": 0,
                            "buildCarriedEnergy": 0,
                            "repairCarriedEnergy": 0,
                            "upgradeCarriedEnergy": 0,
                            "pendingBuildProgress": 900,
                            "repairBacklogHits": 0,
                            "controllerProgressRemaining": 44000,
                        },
                        "energySurplus": {
                            "surplus": True,
                            "spawnExtensionsFull": True,
                            "containersFull": True,
                            "durableFreeCapacity": 0,
                        },
                    },
                    "constructionPriority": {
                        "candidates": [],
                        "nextPrimary": {"buildItem": "finish extension site", "urgency": "high"},
                    },
                    "survival": {"workerCapacity": 2, "workerTarget": 4},
                }
            ],
        }
        latest = json.loads(json.dumps(first))
        latest["tick"] = 200

        samples = [
            analysis.ArtifactSample(Path("first.log"), first, 1.0),
            analysis.ArtifactSample(Path("latest.log"), latest, 2.0),
        ]

        report = analysis.build_report(samples, [], dict(analysis.DEFAULT_THRESHOLDS))
        finding_ids = {finding["id"] for finding in report["findings"]}

        self.assertEqual(report["status"], "critical")
        self.assertIn("idle-workers:W1N1:unassigned", finding_ids)
        self.assertIn("energy-wastage:W1N1:full-sinks", finding_ids)
        self.assertIn("stalled-construction:W1N1:no-progress", finding_ids)
        self.assertIn("under-utilized-spawn:W1N1:worker-deficit", finding_ids)

    def test_monitor_summary_supplies_fallback_room_counts(self) -> None:
        runtime_payload = {
            "type": "runtime-summary",
            "tick": 300,
            "rooms": [
                {
                    "roomName": "W2N2",
                    "resources": {"sourceCount": 2},
                    "taskCounts": {},
                }
            ],
        }
        monitor_payload = {
            "mode": "summary",
            "ok": True,
            "summary": {"creeps": 1, "hostiles": 0, "objects": 20, "room_count": 1},
            "room_summaries": [
                {
                    "room": "shardX/W2N2",
                    "name": "W2N2",
                    "owned_creeps": 1,
                    "owned_spawns": 1,
                    "structures": 7,
                    "tick": 300,
                }
            ],
        }

        report = analysis.build_report(
            [analysis.ArtifactSample(Path("runtime.log"), runtime_payload, 1.0)],
            [analysis.ArtifactSample(Path("summary.json"), monitor_payload, 2.0)],
            dict(analysis.DEFAULT_THRESHOLDS),
        )

        room = report["rooms"][0]
        self.assertEqual(room["metrics"]["workerCount"], 1.0)
        self.assertEqual(room["metrics"]["spawnCount"], 1)
        self.assertEqual(room["metrics"]["structureCount"], 7)
        self.assertEqual(room["baseline"]["monitor"]["sampleCount"], 1)

    def test_detects_role_imbalance_from_task_counts(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 400,
            "rooms": [
                {
                    "roomName": "W4N4",
                    "energyAvailable": 800,
                    "energyCapacity": 800,
                    "workerCount": 4,
                    "taskCounts": {"harvest": 0, "transfer": 3, "build": 0, "repair": 0, "upgrade": 0, "none": 1},
                    "controller": {"level": 4, "progress": 100, "progressTotal": 100000},
                    "resources": {
                        "storedEnergy": 800,
                        "workerCarriedEnergy": 0,
                        "harvestedThisTick": 0,
                        "droppedEnergy": 0,
                        "sourceCount": 2,
                        "productiveEnergy": {
                            "assignedWorkerCount": 0,
                            "pendingBuildProgress": 0,
                            "controllerProgressRemaining": 99900,
                        },
                        "energySurplus": {
                            "spawnExtensionsFull": True,
                            "containersFull": True,
                            "durableFreeCapacity": 0,
                        },
                    },
                }
            ],
        }

        report = analysis.build_report(
            [analysis.ArtifactSample(Path("runtime.log"), payload, 1.0)],
            [],
            dict(analysis.DEFAULT_THRESHOLDS),
        )
        finding_ids = {finding["id"] for finding in report["findings"]}

        self.assertIn("role-imbalance:W4N4:hauler-heavy", finding_ids)
        self.assertIn("role-imbalance:W4N4:no-upgrade-pressure", finding_ids)

    def test_threshold_override_rejects_unknown_threshold(self) -> None:
        output = io.StringIO()
        errors = io.StringIO()

        exit_code = analysis.main(["--threshold", "missing=1"], stdout=output, stderr=errors)

        self.assertEqual(exit_code, 2)
        self.assertIn("unknown threshold", errors.getvalue())

    def test_cli_writes_json_and_markdown_and_check_fails_on_critical_and_no_data(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            runtime_dir = root / "runtime-summary-console"
            monitor_dir = root / "screeps-monitor"
            output_dir = root / "behavioral-analysis"
            runtime_dir.mkdir()
            monitor_dir.mkdir()
            payload = {
                "type": "runtime-summary",
                "tick": 500,
                "rooms": [
                    {
                        "roomName": "W3N3",
                        "energyAvailable": 300,
                        "energyCapacity": 300,
                        "workerCount": 1,
                        "spawnStatus": [{"status": "idle"}],
                        "taskCounts": {"harvest": 0, "transfer": 0, "build": 0, "repair": 0, "upgrade": 0, "none": 1},
                        "controller": {"level": 2, "progress": 1, "progressTotal": 45000},
                        "resources": {
                            "storedEnergy": 300,
                            "workerCarriedEnergy": 50,
                            "harvestedThisTick": 0,
                            "droppedEnergy": 0,
                            "sourceCount": 1,
                            "productiveEnergy": {
                                "assignedWorkerCount": 0,
                                "pendingBuildProgress": 0,
                                "controllerProgressRemaining": 44999,
                            },
                            "energySurplus": {
                                "spawnExtensionsFull": True,
                                "containersFull": True,
                                "durableFreeCapacity": 0,
                            },
                        },
                        "survival": {"workerCapacity": 1, "workerTarget": 2},
                    }
                ],
            }
            (runtime_dir / "runtime-summary-console-1.log").write_text(runtime_line(payload), encoding="utf-8")
            stdout = io.StringIO()

            exit_code = analysis.main(
                [
                    "--runtime-summary-dir",
                    str(runtime_dir),
                    "--monitor-dir",
                    str(monitor_dir),
                    "--output-dir",
                    str(output_dir),
                    "--check",
                ],
                stdout=stdout,
            )

            self.assertEqual(exit_code, 1)
            command_output = json.loads(stdout.getvalue())
            report_path = Path(command_output["report"])
            summary_path = Path(command_output["summary"])
            self.assertTrue(report_path.exists())
            self.assertTrue(summary_path.exists())
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "critical")
            self.assertIn("Screeps Behavioral Analysis", summary_path.read_text(encoding="utf-8"))

            empty_runtime_dir = root / "empty-runtime-summary-console"
            empty_monitor_dir = root / "empty-screeps-monitor"
            empty_output_dir = root / "empty-behavioral-analysis"
            empty_runtime_dir.mkdir()
            empty_monitor_dir.mkdir()
            stdout = io.StringIO()

            exit_code = analysis.main(
                [
                    "--runtime-summary-dir",
                    str(empty_runtime_dir),
                    "--monitor-dir",
                    str(empty_monitor_dir),
                    "--output-dir",
                    str(empty_output_dir),
                    "--check",
                ],
                stdout=stdout,
            )

            self.assertEqual(exit_code, 1)
            command_output = json.loads(stdout.getvalue())
            self.assertFalse(command_output["ok"])
            report_path = Path(command_output["report"])
            summary_path = Path(command_output["summary"])
            report = json.loads(report_path.read_text(encoding="utf-8"))
            summary = summary_path.read_text(encoding="utf-8")
            self.assertEqual(report["status"], "no-data")
            self.assertIn("No input data was available; analysis coverage is incomplete.", summary)
            self.assertNotIn("No inefficiencies detected.", summary)


if __name__ == "__main__":
    unittest.main()
