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


class BrokenStdout(io.StringIO):
    def write(self, text: str) -> int:
        raise BrokenPipeError()


class RuntimeSummaryConsoleCaptureTest(unittest.TestCase):
    def test_filters_only_exact_runtime_telemetry_lines(self) -> None:
        lines = [
            "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":1}\n",
            "#runtime-summary {&#x22;type&#x22;:&#x22;runtime-summary&#x22;,&#x22;tick&#x22;:6}\n",
            "#cpu-summary {\"used\":6.5,\"bucket\":9000,\"pressure\":\"normal\"}\n",
            "#cpu-summary {&#x22;used&#x22;:7.5,&#x22;bucket&#x22;:8000}\n",
            "noise #runtime-summary {\"type\":\"runtime-summary\",\"tick\":2}\n",
            "noise #cpu-summary {\"bucket\":0}\n",
            "\"#runtime-summary {\\\"type\\\":\\\"runtime-summary\\\",\\\"tick\\\":3}\"\n",
            "\"#cpu-summary {\\\"bucket\\\":0}\"\n",
            " #runtime-summary {\"type\":\"runtime-summary\",\"tick\":4}\n",
            " #cpu-summary {\"bucket\":0}\n",
            "#runtime-summary {bad json}\n",
            "#cpu-summary {bad json}\n",
            "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":5}",
        ]

        accepted = list(capture.iter_runtime_summary_lines(lines))

        self.assertEqual(
            accepted,
            [
                "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":1}\n",
                "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":6}\n",
                "#cpu-summary {\"used\":6.5,\"bucket\":9000,\"pressure\":\"normal\"}\n",
                "#cpu-summary {\"used\":7.5,\"bucket\":8000}\n",
                "#runtime-summary {bad json}\n",
                "#cpu-summary {bad json}\n",
                "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":5}\n",
            ],
        )

    def test_persists_compact_cpu_summary_lines_to_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            input_path = root / "console.log"
            out_dir = root / "runtime-artifacts" / "runtime-summary-console"
            input_path.write_text(
                "noise before\n"
                "#cpu-summary {\"used\":30.14,\"limit\":70,\"bucket\":0,\"pressure\":\"critical\"}\n"
                "noise #cpu-summary {\"bucket\":9999}\n"
                "#cpu-summary {bad json}\n"
                " #cpu-summary {\"bucket\":10}\n",
                encoding="utf-8",
            )

            result = capture.persist_runtime_summary_artifact(
                input_paths=[str(input_path)],
                out_dir=out_dir,
                artifact_name="capture.log",
            )

            self.assertEqual(result.input_paths, [str(input_path)])
            self.assertEqual(result.input_line_count, 5)
            self.assertEqual(result.persisted_line_count, 2)
            self.assertEqual(result.runtime_summary_line_count, 0)
            self.assertEqual(result.cpu_summary_line_count, 2)
            self.assertEqual(result.capture_status, capture.CAPTURE_STATUS_CPU_ONLY)
            self.assertEqual(result.skipped_line_count, 3)
            self.assertEqual(result.output_path, out_dir / "capture.log")
            self.assertEqual(
                result.output_path.read_text(encoding="utf-8").splitlines(),
                [
                    "#cpu-summary {\"used\":30.14,\"limit\":70,\"bucket\":0,\"pressure\":\"critical\"}",
                    "#cpu-summary {bad json}",
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
            self.assertEqual(result.runtime_summary_line_count, 2)
            self.assertEqual(result.cpu_summary_line_count, 0)
            self.assertEqual(result.capture_status, capture.CAPTURE_STATUS_CLEAN_RUNTIME_SUMMARY)
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
        with mock.patch.dict(capture.os.environ, {}, clear=True):
            args = capture.build_parser().parse_args([])
        self.assertEqual(args.world_profile, "persistent")
        self.assertEqual(Path(args.out_dir), expected)
        self.assertEqual(args.api_url, capture.DEFAULT_API_URL)

        env_override = Path("/tmp/runtime-summary-console-env")
        with mock.patch.dict(capture.os.environ, {capture.OUT_DIR_ENV: str(env_override)}):
            self.assertEqual(Path(capture.build_parser().parse_args([]).out_dir), env_override)

        cli_override = Path("/tmp/runtime-summary-console-cli")
        with mock.patch.dict(capture.os.environ, {capture.OUT_DIR_ENV: str(env_override)}):
            self.assertEqual(
                Path(capture.build_parser().parse_args(["--out-dir", str(cli_override)]).out_dir),
                cli_override,
            )

    def test_seasonal_profile_isolates_console_capture_defaults(self) -> None:
        with mock.patch.dict(capture.os.environ, {}, clear=True):
            args = capture.build_parser().parse_args(["--world-profile", "seasonal"])

        self.assertEqual(args.world_profile, "seasonal")
        self.assertEqual(
            Path(args.out_dir),
            Path("/root/screeps/runtime-artifacts/seasonal/runtime-summary-console"),
        )
        self.assertEqual(args.api_url, "https://screeps.com/season")

    def test_profile_env_and_explicit_overrides_win_for_console_capture(self) -> None:
        with mock.patch.dict(
            capture.os.environ,
            {
                "SCREEPS_WORLD_PROFILE": "seasonal",
                capture.OUT_DIR_ENV: "/tmp/runtime-summary-console-env",
                capture.API_URL_ENV: "https://example.invalid/custom",
            },
            clear=True,
        ):
            env_args = capture.build_parser().parse_args([])
            cli_args = capture.build_parser().parse_args(
                [
                    "--out-dir",
                    "/tmp/runtime-summary-console-cli",
                    "--api-url",
                    "https://example.invalid/cli",
                ]
            )

        self.assertEqual(env_args.world_profile, "seasonal")
        self.assertEqual(Path(env_args.out_dir), Path("/tmp/runtime-summary-console-env"))
        self.assertEqual(env_args.api_url, "https://example.invalid/custom")
        self.assertEqual(Path(cli_args.out_dir), Path("/tmp/runtime-summary-console-cli"))
        self.assertEqual(cli_args.api_url, "https://example.invalid/cli")

    def test_invalid_console_capture_world_profile_is_rejected(self) -> None:
        with mock.patch.dict(capture.os.environ, {}, clear=True):
            with self.assertRaises(SystemExit):
                capture.build_parser().parse_args(["--world-profile", "invalid"])

        with mock.patch.dict(capture.os.environ, {"SCREEPS_WORLD_PROFILE": "invalid"}, clear=True):
            with self.assertRaises(SystemExit):
                capture.build_parser().parse_args([])

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
        self.assertEqual(report["captureStatus"], capture.CAPTURE_STATUS_CLEAN_RUNTIME_SUMMARY)
        self.assertTrue(report["captureOk"])
        self.assertEqual(report["runtimeSummaryLineCount"], 1)
        self.assertEqual(report["cpuSummaryLineCount"], 0)
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
                                    "#cpu-summary {\"used\":30.14,\"limit\":70,\"bucket\":0,\"pressure\":\"critical\"}",
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
            self.assertEqual(result.input_line_count, 6)
            self.assertEqual(result.persisted_line_count, 4)
            self.assertEqual(result.skipped_line_count, 2)
            self.assertEqual(result.output_path, out_dir / "live.log")
            self.assertEqual(
                result.output_path.read_text(encoding="utf-8").splitlines(),
                [
                    "#runtime-summary {\"type\":\"runtime-summary\",\"tick\":101}",
                    "#cpu-summary {\"used\":30.14,\"limit\":70,\"bucket\":0,\"pressure\":\"critical\"}",
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
            status_path = Path(temp_dir) / "runtime-artifacts" / "runtime-summary-console" / capture.DEFAULT_STATUS_ARTIFACT_NAME
            status = json.loads(status_path.read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 0)
        self.assertEqual(error.getvalue(), "")
        self.assertEqual(report["captureStatus"], capture.CAPTURE_STATUS_CLEAN_RUNTIME_SUMMARY)
        self.assertEqual(report["statusPath"], str(status_path))
        self.assertEqual(report["persistedLineCount"], 1)
        self.assertEqual(report["requestedChannels"], ["console", "console:shardX"])
        self.assertEqual(report["websocketUrl"], "wss://screeps.com/socket/websocket")
        self.assertEqual(status["type"], "screeps-runtime-summary-console-capture-status")
        self.assertEqual(status["schemaVersion"], capture.STATUS_SCHEMA_VERSION)
        self.assertEqual(status["processStatus"], "completed")
        self.assertEqual(status["exitCode"], 0)
        self.assertEqual(status["captureStatus"], capture.CAPTURE_STATUS_CLEAN_RUNTIME_SUMMARY)
        self.assertTrue(status["captureOk"])
        self.assertEqual(status["runtimeSummaryLineCount"], 1)
        self.assertEqual(status["cpuSummaryLineCount"], 0)
        self.assertEqual(status["statusPath"], str(status_path))
        self.assertIn("outer_cron_finalization", status["finalizationHint"])
        self.assertEqual(websocket.sent, [f"auth {secret}", "subscribe console", "subscribe console:shardX"])
        self.assertNotIn(secret, output.getvalue())
        self.assertNotIn("#runtime-summary", output.getvalue())

    def test_cli_status_line_reports_cpu_only_live_capture_and_writes_sidecar(self) -> None:
        secret = "SECRET_TOKEN_VALUE"
        websocket = FakeWebSocket(
            [
                "auth ok",
                json.dumps(
                    [
                        "console",
                        {
                            "messages": {
                                "log": [
                                    "#cpu-summary {&#x22;used&#x22;:13.1,&#x22;bucket&#x22;:1775}",
                                    "noise",
                                ]
                            }
                        },
                    ]
                ),
            ]
        )
        websockets_module = FakeWebsocketsModule(websocket)

        with tempfile.TemporaryDirectory() as temp_dir:
            out_dir = Path(temp_dir) / "runtime-artifacts" / "runtime-summary-console"
            output = io.StringIO()
            error = io.StringIO()
            with (
                mock.patch.dict(capture.os.environ, {capture.AUTH_TOKEN_ENV: secret}),
                mock.patch.object(capture, "import_websockets_module", return_value=websockets_module),
            ):
                exit_code = capture.main(
                    [
                        "--live-official-console",
                        "--out-dir",
                        str(out_dir),
                        "--artifact-name",
                        "live-cpu.log",
                        "--format",
                        "status-line",
                        "--live-timeout-seconds",
                        "4",
                        "--live-max-messages",
                        "1",
                    ],
                    stdout=output,
                    stderr=error,
                )

            status_path = out_dir / capture.DEFAULT_STATUS_ARTIFACT_NAME
            status = json.loads(status_path.read_text(encoding="utf-8"))
            artifact_text = (out_dir / "live-cpu.log").read_text(encoding="utf-8").strip()

        self.assertEqual(exit_code, 0)
        self.assertEqual(error.getvalue(), "")
        self.assertEqual(
            output.getvalue().strip(),
            (
                "CAPTURE_STATUS status=cpu_only runtime=0 cpu=1 persisted=1 input=2 "
                "messages=1 output=live-cpu.log status_file=runtime-summary-console-status.json"
            ),
        )
        self.assertEqual(status["captureStatus"], capture.CAPTURE_STATUS_CPU_ONLY)
        self.assertFalse(status["captureOk"])
        self.assertEqual(status["runtimeSummaryLineCount"], 0)
        self.assertEqual(status["cpuSummaryLineCount"], 1)
        self.assertEqual(artifact_text, "#cpu-summary {\"used\":13.1,\"bucket\":1775}")
        self.assertNotIn(secret, json.dumps(status, sort_keys=True))

    def test_live_official_console_timeout_without_messages_writes_no_messages_status(self) -> None:
        secret = "SECRET_TOKEN_VALUE"
        websocket = FakeWebSocket(["auth ok"])
        websockets_module = FakeWebsocketsModule(websocket)

        with tempfile.TemporaryDirectory() as temp_dir:
            out_dir = Path(temp_dir) / "runtime-artifacts" / "runtime-summary-console"
            output = io.StringIO()
            error = io.StringIO()
            with (
                mock.patch.dict(capture.os.environ, {capture.AUTH_TOKEN_ENV: secret}),
                mock.patch.object(capture, "import_websockets_module", return_value=websockets_module),
            ):
                exit_code = capture.main(
                    [
                        "--live-official-console",
                        "--out-dir",
                        str(out_dir),
                        "--artifact-name",
                        "empty.log",
                        "--live-timeout-seconds",
                        "4",
                        "--live-max-messages",
                        "10",
                    ],
                    stdout=output,
                    stderr=error,
                )

            report = json.loads(output.getvalue())
            status_path = out_dir / capture.DEFAULT_STATUS_ARTIFACT_NAME
            status = json.loads(status_path.read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 0)
        self.assertEqual(error.getvalue(), "")
        self.assertEqual(report["captureStatus"], capture.CAPTURE_STATUS_NO_MESSAGES)
        self.assertFalse(report["captureOk"])
        self.assertEqual(report["inputLineCount"], 0)
        self.assertEqual(report["persistedLineCount"], 0)
        self.assertEqual(report["outputPath"], None)
        self.assertEqual(report["receivedMessageCount"], 0)
        self.assertEqual(status["processStatus"], "completed")
        self.assertEqual(status["captureStatus"], capture.CAPTURE_STATUS_NO_MESSAGES)
        self.assertFalse(status["captureOk"])
        self.assertFalse((out_dir / "empty.log").exists())

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
            self.assertEqual(result.capture_status, capture.CAPTURE_STATUS_NO_RUNTIME_TELEMETRY)

    def test_live_official_console_missing_websockets_package_reports_sanitized_error(self) -> None:
        secret = "SECRET_TOKEN_VALUE"
        with tempfile.TemporaryDirectory() as temp_dir:
            out_dir = Path(temp_dir) / "runtime-artifacts" / "runtime-summary-console"
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
                        str(out_dir),
                        "--live-timeout-seconds",
                        "1",
                        "--live-max-messages",
                        "1",
                    ],
                    stdout=output,
                    stderr=error,
                )

            status_path = out_dir / capture.DEFAULT_STATUS_ARTIFACT_NAME
            status = json.loads(status_path.read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 1)
        self.assertEqual(output.getvalue(), "")
        self.assertIn("websockets", error.getvalue())
        self.assertNotIn(secret, error.getvalue())
        self.assertEqual(status["processStatus"], "capture_error")
        self.assertEqual(status["exitCode"], 1)
        self.assertEqual(status["captureStatus"], capture.CAPTURE_STATUS_ERROR)
        self.assertIn("websockets", status["error"])
        self.assertNotIn(secret, json.dumps(status, sort_keys=True))

    def test_cli_broken_stdout_still_leaves_completed_status_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            status_path = Path(temp_dir) / "capture-status.json"
            error = io.StringIO()
            exit_code = capture.main(
                [
                    "--status-file",
                    str(status_path),
                    "--out-dir",
                    str(Path(temp_dir) / "runtime-artifacts" / "runtime-summary-console"),
                    "--artifact-name",
                    "stdin.log",
                ],
                stdin=io.StringIO("#runtime-summary {\"type\":\"runtime-summary\",\"tick\":1}\n"),
                stdout=BrokenStdout(),
                stderr=error,
            )
            status = json.loads(status_path.read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 0)
        self.assertEqual(error.getvalue(), "")
        self.assertEqual(status["processStatus"], "completed")
        self.assertEqual(status["captureStatus"], capture.CAPTURE_STATUS_CLEAN_RUNTIME_SUMMARY)
        self.assertEqual(status["exitCode"], 0)


if __name__ == "__main__":
    unittest.main()
