#!/usr/bin/env python3
from __future__ import annotations

import asyncio
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


class FakeWebSocket:
    def __init__(self, messages: list[object]) -> None:
        self.messages = list(messages)
        self.sent: list[str] = []

    async def send(self, message: str) -> None:
        self.sent.append(message)

    async def recv(self) -> object:
        if not self.messages:
            raise asyncio.TimeoutError()
        message = self.messages.pop(0)
        if isinstance(message, BaseException):
            raise message
        return message


class FakeWebsocketConnection:
    def __init__(self, websocket: FakeWebSocket) -> None:
        self.websocket = websocket

    async def __aenter__(self) -> FakeWebSocket:
        return self.websocket

    async def __aexit__(self, *args: object) -> None:
        return None


class FakeWebsocketsModule:
    def __init__(self, websocket: FakeWebSocket) -> None:
        self.websocket = websocket
        self.connect_calls: list[dict[str, object]] = []

    def connect(self, uri: str, **kwargs: object) -> FakeWebsocketConnection:
        self.connect_calls.append({"uri": uri, **kwargs})
        return FakeWebsocketConnection(self.websocket)


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

    def test_live_official_console_authenticates_subscribes_and_persists_exact_prefix_lines(self) -> None:
        secret = "SECRET_TOKEN_VALUE"
        websocket = FakeWebSocket(
            [
                b"auth ok",
                json.dumps(
                    [
                        "console",
                        {
                            "messages": {
                                "log": [
                                    "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":101}",
                                    "noise #runtime-summary {\"type\":\"runtime-summary\",\"tick\":999}",
                                ],
                                "results": [
                                    "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":102}\nignored result"
                                ],
                            },
                        },
                    ]
                ),
                json.dumps(
                    [
                        "console:shardX",
                        {"data": ["#runtime-summary {\"type\":\"runtime-summary\",\"tick\":103}"]},
                    ]
                ),
                json.dumps(
                    [
                        "other",
                        {"messages": {"log": ["#runtime-summary {\"type\":\"runtime-summary\",\"tick\":999}"]}},
                    ]
                ),
            ]
        )
        websockets_module = FakeWebsocketsModule(websocket)
        ctx = capture.LiveConsoleContext(
            base_http="https://screeps.com",
            token=secret,
            channels=["console", "console:shardX"],
            timeout_seconds=5.0,
            max_messages=2,
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            out_dir = Path(temp_dir) / "runtime-artifacts" / "runtime-summary-console"

            result = capture.persist_live_official_console_artifact(
                ctx=ctx,
                out_dir=out_dir,
                artifact_name="live.log",
                websockets_module=websockets_module,
            )

            self.assertEqual(result.input_paths, ["live-official-console"])
            self.assertEqual(result.input_line_count, 5)
            self.assertEqual(result.persisted_line_count, 3)
            self.assertEqual(result.skipped_line_count, 2)
            self.assertEqual(result.output_path, out_dir / "live.log")
            self.assertEqual(
                result.output_path.read_text(encoding="utf-8").splitlines(),
                [
                    "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":101}",
                    "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":102}",
                    "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":103}",
                ],
            )

        self.assertEqual(
            websocket.sent,
            [
                f"auth {secret}",
                "subscribe console",
                "subscribe console:shardX",
            ],
        )
        self.assertEqual(
            websockets_module.connect_calls,
            [{"uri": "wss://screeps.com/socket/websocket", "open_timeout": 5.0}],
        )
        self.assertEqual(len(websocket.messages), 1)
        metadata = result.metadata()
        metadata_text = json.dumps(metadata, sort_keys=True)
        self.assertEqual(metadata["source"], "live-official-console")
        self.assertEqual(metadata["requestedChannels"], ["console", "console:shardX"])
        self.assertEqual(metadata["receivedMessageCount"], 2)
        self.assertNotIn(secret, metadata_text)
        self.assertNotIn("#runtime-summary", metadata_text)

    def test_cli_live_official_console_reports_channels_without_secrets_or_artifact_contents(self) -> None:
        secret = "VERY_SECRET_TOKEN_VALUE"
        websocket = FakeWebSocket(
            [
                "auth ok",
                json.dumps(
                    [
                        "console",
                        {"messages": {"log": ["#runtime-summary {\"type\":\"runtime-summary\",\"tick\":201}"]}},
                    ]
                ),
            ]
        )
        websockets_module = FakeWebsocketsModule(websocket)

        with tempfile.TemporaryDirectory() as temp_dir:
            output = io.StringIO()
            error = io.StringIO()
            with (
                mock.patch.dict(
                    capture.os.environ,
                    {
                        capture.AUTH_TOKEN_ENV: secret,
                        capture.API_URL_ENV: "https://screeps.com",
                        capture.CONSOLE_CHANNELS_ENV: "console,console:shardX",
                    },
                ),
                mock.patch.object(capture, "import_websockets_module", return_value=websockets_module),
            ):
                exit_code = capture.main(
                    [
                        "--live-official-console",
                        "--out-dir",
                        str(Path(temp_dir) / "runtime-artifacts" / "runtime-summary-console"),
                        "--artifact-name",
                        "live.log",
                        "--live-timeout-seconds",
                        "4",
                        "--live-max-messages",
                        "1",
                    ],
                    stdout=output,
                    stderr=error,
                )

            report = json.loads(output.getvalue())

        self.assertEqual(exit_code, 0)
        self.assertEqual(error.getvalue(), "")
        self.assertEqual(report["persistedLineCount"], 1)
        self.assertEqual(report["requestedChannels"], ["console", "console:shardX"])
        self.assertEqual(report["websocketUrl"], "wss://screeps.com/socket/websocket")
        self.assertEqual(websocket.sent, [f"auth {secret}", "subscribe console", "subscribe console:shardX"])
        self.assertNotIn(secret, output.getvalue())
        self.assertNotIn("#runtime-summary", output.getvalue())

    def test_live_official_console_timeout_without_match_does_not_write_artifact(self) -> None:
        websocket = FakeWebSocket(
            [
                "auth ok",
                json.dumps(["console", {"messages": {"log": ["noise only"]}}]),
                asyncio.TimeoutError(),
            ]
        )
        websockets_module = FakeWebsocketsModule(websocket)
        ctx = capture.LiveConsoleContext(
            base_http="https://screeps.com",
            token="SECRET_TOKEN_VALUE",
            channels=["console"],
            timeout_seconds=5.0,
            max_messages=10,
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            out_dir = Path(temp_dir) / "runtime-artifacts" / "runtime-summary-console"

            result = capture.persist_live_official_console_artifact(
                ctx=ctx,
                out_dir=out_dir,
                artifact_name="empty.log",
                websockets_module=websockets_module,
            )

            self.assertEqual(result.input_line_count, 1)
            self.assertEqual(result.persisted_line_count, 0)
            self.assertEqual(result.skipped_line_count, 1)
            self.assertEqual(result.output_path, None)
            self.assertFalse(out_dir.exists())
            self.assertEqual(result.metadata()["receivedMessageCount"], 1)

    def test_live_official_console_missing_websockets_package_reports_sanitized_error(self) -> None:
        secret = "SECRET_TOKEN_VALUE"
        with tempfile.TemporaryDirectory() as temp_dir:
            output = io.StringIO()
            error = io.StringIO()
            with (
                mock.patch.dict(capture.os.environ, {capture.AUTH_TOKEN_ENV: secret}),
                mock.patch.object(
                    capture,
                    "import_websockets_module",
                    side_effect=RuntimeError("Python package 'websockets' is required for --live-official-console"),
                ),
            ):
                exit_code = capture.main(
                    [
                        "--live-official-console",
                        "--out-dir",
                        str(Path(temp_dir) / "runtime-artifacts" / "runtime-summary-console"),
                        "--live-timeout-seconds",
                        "1",
                        "--live-max-messages",
                        "1",
                    ],
                    stdout=output,
                    stderr=error,
                )

        self.assertEqual(exit_code, 1)
        self.assertEqual(output.getvalue(), "")
        self.assertIn("websockets", error.getvalue())
        self.assertNotIn(secret, error.getvalue())


if __name__ == "__main__":
    unittest.main()
