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
import screeps_runtime_summary_console_capture as capture


class RuntimeSummaryConsoleCaptureTest(unittest.TestCase):
    def test_filters_only_exact_runtime_summary_lines(self) -> None:
        lines = [
            "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":1}\n",
            "noise #runtime-summary {\"type\":\"runtime-summary\",\"tick\":2}\n",
            "\"#runtime-summary {\\\"type\\\":\\\"runtime-summary\\\",\\\"tick\\\":3}\"\n",
            " #runtime-summary {\"type\":\"runtime-summary\",\"tick\":4}\n",
            "#runtime-summary {bad json}\n",
            "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":5}",
        ]

        accepted = list(capture.iter_runtime_summary_lines(lines))

        self.assertEqual(
            accepted,
            [
                "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":1}\n",
                "#runtime-summary {bad json}\n",
                "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":5}\n",
            ],
        )

    def test_persists_matching_console_lines_to_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            input_path = root / "console.log"
            out_dir = root / "runtime-artifacts" / "runtime-summary-console"
            input_path.write_text(
                "noise before\n"
                "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":10,\"rooms\":[{\"roomName\":\"W1N1\"}]}\n"
                "noise #runtime-summary {\"type\":\"runtime-summary\",\"tick\":11}\n"
                "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":20,\"rooms\":[{\"roomName\":\"W1N1\"}]}\n",
                encoding="utf-8",
            )

            result = capture.persist_runtime_summary_artifact(
                input_paths=[str(input_path)],
                out_dir=out_dir,
                artifact_name="capture.log",
            )

            self.assertEqual(result.input_paths, [str(input_path)])
            self.assertEqual(result.input_line_count, 4)
            self.assertEqual(result.persisted_line_count, 2)
            self.assertEqual(result.skipped_line_count, 2)
            self.assertEqual(result.output_path, out_dir / "capture.log")
            self.assertEqual(
                result.output_path.read_text(encoding="utf-8").splitlines(),
                [
                    "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":10,\"rooms\":[{\"roomName\":\"W1N1\"}]}",
                    "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":20,\"rooms\":[{\"roomName\":\"W1N1\"}]}",
                ],
            )

            report = bridge.build_bridge_report([str(out_dir)])

        self.assertEqual(report["source"]["runtimeSummaryLines"], 2)
        self.assertEqual(report["input"]["runtimeSummaryCount"], 2)
        self.assertEqual(report["window"], {"firstTick": 10, "latestTick": 20})

    def test_default_out_dir_matches_bridge_default_runtime_artifacts_tree(self) -> None:
        expected = Path("/root/screeps/runtime-artifacts/runtime-summary-console")

        self.assertEqual(capture.DEFAULT_OUT_DIR, expected)
        self.assertIn(str(expected.parent), bridge.DEFAULT_INPUT_PATHS)
        self.assertEqual(Path(capture.build_parser().parse_args([]).out_dir), expected)

        env_override = Path("/tmp/runtime-summary-console-env")
        with mock.patch.dict(capture.os.environ, {capture.OUT_DIR_ENV: str(env_override)}):
            self.assertEqual(Path(capture.build_parser().parse_args([]).out_dir), env_override)

        cli_override = Path("/tmp/runtime-summary-console-cli")
        with mock.patch.dict(capture.os.environ, {capture.OUT_DIR_ENV: str(env_override)}):
            self.assertEqual(
                Path(capture.build_parser().parse_args(["--out-dir", str(cli_override)]).out_dir),
                cli_override,
            )

    def test_does_not_write_artifact_when_no_summary_lines_match(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            out_dir = Path(temp_dir) / "runtime-artifacts" / "runtime-summary-console"

            result = capture.persist_runtime_summary_artifact(
                input_paths=[],
                out_dir=out_dir,
                artifact_name="empty.log",
                stdin=io.StringIO("noise\nquoted '#runtime-summary {}'\n"),
            )

            self.assertEqual(result.persisted_line_count, 0)
            self.assertEqual(result.output_path, None)
            self.assertFalse(out_dir.exists())

    def test_temp_path_collision_does_not_drop_capture(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            out_dir = Path(temp_dir) / "runtime-artifacts" / "runtime-summary-console"
            output_path = out_dir / "capture.log"
            vulnerable_temp_path = out_dir / ".capture.log.tmp"
            captured_artifact = "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":1}\n"
            original_open = Path.open

            def open_with_temp_collision(path: Path, *args: object, **kwargs: object) -> object:
                mode = args[0] if args else kwargs.get("mode", "r")
                if path == vulnerable_temp_path and mode == "x":
                    vulnerable_temp_path.write_text("competing temp\n", encoding="utf-8")
                    raise FileExistsError(vulnerable_temp_path)
                return original_open(path, *args, **kwargs)

            with mock.patch.object(Path, "open", open_with_temp_collision):
                result = capture.persist_runtime_summary_artifact(
                    input_paths=[],
                    out_dir=out_dir,
                    artifact_name="capture.log",
                    stdin=io.StringIO(captured_artifact),
                )

            self.assertEqual(result.output_path, output_path)
            self.assertEqual(output_path.read_text(encoding="utf-8"), captured_artifact)

    def test_does_not_overwrite_artifact_created_before_publish(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            out_dir = Path(temp_dir) / "runtime-artifacts" / "runtime-summary-console"
            output_path = out_dir / "capture.log"
            competing_artifact = "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":999}\n"
            captured_artifact = "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":1}\n"
            original_link = capture.os.link
            state = {"raced": False}

            def link_with_publish_race(src: object, dst: object, *args: object, **kwargs: object) -> object:
                destination = Path(dst)
                if destination == output_path and not state["raced"]:
                    state["raced"] = True
                    output_path.write_text(competing_artifact, encoding="utf-8")
                    raise FileExistsError(output_path)
                return original_link(src, dst, *args, **kwargs)

            with mock.patch.object(capture.os, "link", link_with_publish_race):
                result = capture.persist_runtime_summary_artifact(
                    input_paths=[],
                    out_dir=out_dir,
                    artifact_name="capture.log",
                    stdin=io.StringIO(captured_artifact),
                )

            self.assertEqual(output_path.read_text(encoding="utf-8"), competing_artifact)
            self.assertEqual(result.output_path, out_dir / "capture-2.log")
            self.assertEqual(result.output_path.read_text(encoding="utf-8"), captured_artifact)
            self.assertEqual(list(out_dir.glob(".capture.log.*")), [])

    def test_cli_emits_counts_without_artifact_contents(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output = io.StringIO()
            exit_code = capture.main(
                [
                    "--out-dir",
                    str(Path(temp_dir) / "runtime-artifacts" / "runtime-summary-console"),
                    "--artifact-name",
                    "stdin.log",
                ],
                stdin=io.StringIO("#runtime-summary {\"type\":\"runtime-summary\",\"tick\":1}\n"),
                stdout=output,
            )

            report = json.loads(output.getvalue())

        self.assertEqual(exit_code, 0)
        self.assertEqual(report["persistedLineCount"], 1)
        self.assertEqual(report["skippedLineCount"], 0)
        self.assertEqual(report["inputPaths"], ["-"])
        self.assertTrue(report["outputPath"].endswith("stdin.log"))
        self.assertNotIn("#runtime-summary", output.getvalue())


if __name__ == "__main__":
    unittest.main()
