#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import screeps_runtime_kpi_artifact_bridge as bridge


def runtime_line(payload: dict[str, object]) -> str:
    return f"#runtime-summary {json.dumps(payload, sort_keys=True)}\n"


class RuntimeKpiArtifactBridgeTest(unittest.TestCase):
    def test_scans_file_and_reports_source_metadata(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 100,
            "rooms": [{"roomName": "W1N1"}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "console.log"
            path.write_text(f"noise\n{runtime_line(payload)}", encoding="utf-8")

            report = bridge.build_bridge_report([str(path)])

        self.assertEqual(report["source"]["inputPaths"], [str(path)])
        self.assertEqual(report["source"]["scannedFiles"], 1)
        self.assertEqual(report["source"]["matchedFiles"], 1)
        self.assertEqual(report["source"]["runtimeSummaryLines"], 1)
        self.assertEqual(report["source"]["skippedFiles"], [])
        self.assertEqual(report["input"]["runtimeSummaryCount"], 1)
        self.assertEqual(report["territory"]["ownedRooms"]["latest"], ["W1N1"])

    def test_monitor_source_files_are_skipped_by_default_but_can_be_included(self) -> None:
        payload = {
            "type": "runtime-summary",
            "tick": 100,
            "rooms": [{"roomName": "W1N1"}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "runtime-summary-monitor-20260524T084732Z.log"
            path.write_text(runtime_line(payload), encoding="utf-8")

            default_report = bridge.build_bridge_report([str(path)])
            included_report = bridge.build_bridge_report([str(path)], include_monitor_source=True)

        self.assertEqual(default_report["source"]["matchedFiles"], 0)
        self.assertEqual(default_report["source"]["skippedFiles"], [{"path": str(path), "reason": "monitor_source"}])
        self.assertEqual(included_report["source"]["matchedFiles"], 1)
        self.assertEqual(included_report["source"]["runtimeSummaryLines"], 1)
        self.assertEqual(included_report["territory"]["ownedRooms"]["latest"], ["W1N1"])

    def test_ignores_embedded_runtime_summary_markers(self) -> None:
        embedded = {"type": "runtime-summary", "tick": 5, "rooms": [{"roomName": "W9N9"}]}
        accepted = {"type": "runtime-summary", "tick": 10, "rooms": [{"roomName": "W1N1"}]}

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "console.log"
            embedded_json = json.dumps(embedded, sort_keys=True)
            path.write_text(
                f"noise #runtime-summary {embedded_json}\n"
                f'"noise #runtime-summary {embedded_json}"\n'
                f"{runtime_line(accepted)}",
                encoding="utf-8",
            )

            report = bridge.build_bridge_report([str(path)])

        self.assertEqual(report["source"]["matchedFiles"], 1)
        self.assertEqual(report["source"]["runtimeSummaryLines"], 1)
        self.assertEqual(report["input"]["lineCount"], 1)
        self.assertEqual(report["input"]["runtimeSummaryCount"], 1)
        self.assertEqual(report["input"]["malformedRuntimeSummaryCount"], 0)
        self.assertEqual(report["window"], {"firstTick": 10, "latestTick": 10})
        self.assertEqual(report["territory"]["ownedRooms"]["latest"], ["W1N1"])

    def test_recurses_directories_in_deterministic_order(self) -> None:
        first = {"type": "runtime-summary", "tick": 10, "rooms": [{"roomName": "W1N1"}]}
        latest = {"type": "runtime-summary", "tick": 20, "rooms": [{"roomName": "W1N1"}, {"roomName": "W2N2"}]}

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            nested = root / "nested"
            nested.mkdir()
            (root / "a.log").write_text(runtime_line(first), encoding="utf-8")
            (nested / "z.log").write_text(runtime_line(latest), encoding="utf-8")

            report = bridge.build_bridge_report([str(root)])

        self.assertEqual(report["source"]["scannedFiles"], 2)
        self.assertEqual(report["source"]["matchedFiles"], 2)
        self.assertEqual(report["window"], {"firstTick": 10, "latestTick": 20})
        self.assertEqual(report["territory"]["ownedRooms"]["latest"], ["W1N1", "W2N2"])

    def test_skips_binary_and_oversized_files_without_matching_contents(self) -> None:
        payload = {"type": "runtime-summary", "tick": 50, "rooms": [{"roomName": "W1N1"}]}

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "binary.log").write_bytes(b"\0not text")
            (root / "large.log").write_text("x" * 128 + runtime_line(payload), encoding="utf-8")

            report = bridge.build_bridge_report([str(root)], max_file_bytes=64)

        self.assertEqual(report["source"]["scannedFiles"], 2)
        self.assertEqual(report["source"]["matchedFiles"], 0)
        self.assertEqual(report["source"]["runtimeSummaryLines"], 0)
        self.assertEqual({entry["reason"] for entry in report["source"]["skippedFiles"]}, {"binary", "oversized"})
        self.assertEqual(report["input"]["runtimeSummaryCount"], 0)

    def test_no_supplied_paths_uses_defaults_and_exits_zero_without_matches(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            empty_root = Path(temp_dir) / "empty"
            empty_root.mkdir()
            missing_root = Path(temp_dir) / "missing"
            output = io.StringIO()

            with mock.patch.object(bridge, "DEFAULT_INPUT_PATHS", (str(empty_root), str(missing_root))):
                exit_code = bridge.main([], stdout=output)

        report = json.loads(output.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(report["source"]["inputPaths"], [str(empty_root), str(missing_root)])
        self.assertEqual(report["source"]["scannedFiles"], 0)
        self.assertEqual(report["source"]["matchedFiles"], 0)
        self.assertEqual(report["source"]["runtimeSummaryLines"], 0)
        self.assertEqual(report["source"]["skippedFiles"], [{"path": str(missing_root), "reason": "missing"}])
        self.assertEqual(report["input"]["lineCount"], 0)
        self.assertEqual(report["input"]["runtimeSummaryCount"], 0)
        self.assertEqual(report["territory"]["ownedRooms"]["status"], "not instrumented")
        self.assertEqual(report["resources"]["status"], "not instrumented")
        self.assertEqual(report["combat"]["status"], "not instrumented")

    def test_reducer_integration_aggregates_discovered_summary_lines(self) -> None:
        first = {
            "type": "runtime-summary",
            "tick": 10,
            "rooms": [
                {
                    "roomName": "W1N1",
                    "resources": {"storedEnergy": 1, "workerCarriedEnergy": 2, "droppedEnergy": 3, "sourceCount": 1},
                }
            ],
        }
        latest = {
            "type": "runtime-summary",
            "tick": 20,
            "rooms": [
                {
                    "roomName": "W1N1",
                    "resources": {
                        "storedEnergy": 5,
                        "workerCarriedEnergy": 1,
                        "droppedEnergy": 0,
                        "sourceCount": 1,
                        "events": {"harvestedEnergy": 8, "transferredEnergy": 4},
                    },
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "runtime.log"
            path.write_text(f"ignored\n{runtime_line(first)}#runtime-summary {{bad json}}\n{runtime_line(latest)}", encoding="utf-8")

            report = bridge.build_bridge_report([str(path)])

        self.assertEqual(report["source"]["runtimeSummaryLines"], 3)
        self.assertEqual(report["input"]["lineCount"], 3)
        self.assertEqual(report["input"]["runtimeSummaryCount"], 2)
        self.assertEqual(report["input"]["malformedRuntimeSummaryCount"], 1)
        self.assertEqual(report["resources"]["totals"]["latest"]["storedEnergy"], 5)
        self.assertEqual(report["resources"]["totals"]["delta"]["storedEnergy"], 4)
        self.assertEqual(report["resources"]["eventDeltas"], {
            "status": "observed",
            "harvestedEnergy": 8,
            "transferredEnergy": 4,
        })

    def test_runtime_summary_records_carry_inferred_world_id_metadata(self) -> None:
        persistent_payload = {"type": "runtime-summary", "tick": 10, "rooms": [{"roomName": "E29N55"}]}
        seasonal_path_payload = {"type": "runtime-summary", "tick": 20, "rooms": [{"roomName": "E1S1"}]}
        seasonal_payload = {
            "type": "runtime-summary",
            "worldProfile": "seasonal",
            "tick": 30,
            "rooms": [{"roomName": "E2S2"}],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "runtime-artifacts"
            persistent_path = root / "runtime-summary-console" / "runtime-summary-console-20260501T120000Z.log"
            seasonal_path = root / "seasonal" / "runtime-summary-console" / "runtime-summary-console-20260501T130000Z.log"
            explicit_path = root / "runtime-summary-console" / "runtime-summary-console-20260501T140000Z.log"
            persistent_path.parent.mkdir(parents=True)
            seasonal_path.parent.mkdir(parents=True)
            persistent_path.write_text(runtime_line(persistent_payload), encoding="utf-8")
            seasonal_path.write_text(runtime_line(seasonal_path_payload), encoding="utf-8")
            explicit_path.write_text(runtime_line(seasonal_payload), encoding="utf-8")

            scan_result = bridge.collect_runtime_summary_lines([str(root)])

        records_by_tick = {}
        for record in scan_result.records:
            payload = json.loads(record.line.removeprefix("#runtime-summary "))
            records_by_tick[payload["tick"]] = record

        self.assertEqual(records_by_tick[10].world_id, "persistent")
        self.assertEqual(records_by_tick[10].world_id_status, "fallback")
        self.assertEqual(records_by_tick[20].world_id, "seasonal")
        self.assertEqual(records_by_tick[20].world_id_status, "path")
        self.assertEqual(records_by_tick[30].world_id, "seasonal")
        self.assertEqual(records_by_tick[30].world_id_status, "explicit")
        self.assertEqual(scan_result.metadata()["worldIdCounts"], {"persistent": 1, "seasonal": 2})
        self.assertEqual(scan_result.metadata()["worldIdStatusCounts"], {"explicit": 1, "fallback": 1, "path": 1})

    def test_human_format_includes_source_and_reducer_summary(self) -> None:
        payload = {"type": "runtime-summary", "tick": 100, "rooms": [{"roomName": "W1N1"}]}

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "console.log"
            path.write_text(runtime_line(payload), encoding="utf-8")
            output = io.StringIO()

            exit_code = bridge.main([str(path), "--format", "human"], stdout=output)

        self.assertEqual(exit_code, 0)
        rendered = output.getvalue()
        self.assertIn("source: scanned 1 file(s), matched 1, runtime-summary lines 1, skipped 0", rendered)
        self.assertIn("runtime summaries: 1", rendered)


if __name__ == "__main__":
    unittest.main()
