#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

import screeps_official_deploy as deploy


class FakeTransport:
    def __init__(self, responses: list[deploy.HttpResult]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    def __call__(self, **kwargs: Any) -> deploy.HttpResult:
        self.calls.append(kwargs)
        if not self.responses:
            raise AssertionError("unexpected HTTP call")
        return self.responses.pop(0)


class OfficialDeployTest(unittest.TestCase):
    def write_artifact(self, directory: Path, body: str = "module.exports.loop = function () { return 1; };\n") -> Path:
        artifact = directory / "main.js"
        artifact.write_text(body, encoding="utf-8")
        return artifact

    def config(
        self,
        artifact: Path,
        *,
        api_url: str = "https://screeps.com",
        branch: str = "main",
        shard: str = "shardX",
        room: str = "E19S57",
        deploy_mode: bool = False,
        activate_world: bool = False,
        confirm: str | None = None,
        evidence_dir: Path | None = None,
        evidence_path: Path | None = None,
        repo_root: Path | None = None,
    ) -> deploy.DeployConfig:
        return deploy.DeployConfig(
            api_url=api_url,
            branch=branch,
            shard=shard,
            room=room,
            artifact_path=artifact,
            deploy=deploy_mode,
            activate_world=activate_world,
            confirm=confirm,
            evidence_path=evidence_path,
            evidence_dir=evidence_dir or artifact.parent / "evidence",
            repo_root=repo_root or artifact.parent,
        )

    def deploy_target(self, **overrides: str) -> dict[str, str]:
        target = {
            "apiUrl": "https://screeps.com",
            "branch": "main",
            "shard": "shardX",
            "room": "E19S57",
        }
        target.update(overrides)
        return target

    def write_deploy_evidence(
        self,
        evidence_dir: Path,
        run_id: str,
        commit: str,
        *,
        deploy_ok: bool = True,
        health_ok: bool = True,
        timestamp: str = "2026-05-01T00:00:00Z",
        target: dict[str, str] | None = None,
    ) -> tuple[Path, Path]:
        deploy_path = evidence_dir / f"official-screeps-deploy-{run_id}.json"
        health_path = evidence_dir / f"postdeploy-health-gate-{run_id}.json"
        deploy_path.write_text(
            json.dumps(
                {
                    "ok": deploy_ok,
                    "mode": "deploy",
                    "timestampUtc": timestamp,
                    "git": {"commit": commit, "branch": "main", "dirty": False},
                    "target": target or self.deploy_target(),
                },
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        health_path.write_text(json.dumps({"ok": health_ok, "reasons": []}, sort_keys=True), encoding="utf-8")
        return deploy_path, health_path

    def test_build_code_payload_uses_main_module(self) -> None:
        payload = deploy.build_code_payload("main", "module text")

        self.assertEqual(payload, {"branch": "main", "modules": {"main": "module text"}})

    def test_redacts_sensitive_values_and_module_contents(self) -> None:
        sentinel = "redaction-marker"
        redacted = deploy.redact(
            {
                "headers": {"X-Token": sentinel},
                "modules": {"main": "module.exports.loop = function () { return 1; };"},
                "message": f"safe prefix {sentinel} safe suffix",
            },
            [sentinel],
        )
        encoded = json.dumps(redacted, sort_keys=True)

        self.assertNotIn(sentinel, encoded)
        self.assertNotIn("module.exports.loop", encoded)
        self.assertEqual(redacted["headers"]["X-Token"], "[REDACTED]")
        self.assertTrue(redacted["modules"]["main"]["redacted"])
        self.assertIn("sha256", redacted["modules"]["main"])

    def test_redacts_code_like_api_error_text(self) -> None:
        redacted = deploy.redact({"message": "API echoed module.exports.loop = function () {};"})

        self.assertNotIn("module.exports", json.dumps(redacted))
        self.assertIn("[REDACTED_CODE", redacted["message"])

    def test_normalize_api_url_requires_official_https_origin(self) -> None:
        self.assertEqual(deploy.normalize_api_url("https://screeps.com/"), "https://screeps.com")
        self.assertEqual(deploy.normalize_api_url("https://screeps.com/season/"), "https://screeps.com/season")
        with self.assertRaisesRegex(deploy.DeployError, "https://screeps.com"):
            deploy.normalize_api_url("http://localhost:21025/")
        with self.assertRaisesRegex(deploy.DeployError, "https://screeps.com"):
            deploy.normalize_api_url("https://example.com")
        with self.assertRaisesRegex(deploy.DeployError, "world root, not an API root"):
            deploy.normalize_api_url("https://screeps.com/api")
        with self.assertRaisesRegex(deploy.DeployError, "world root, not an API root"):
            deploy.normalize_api_url("https://screeps.com/season/api")
        with self.assertRaisesRegex(deploy.DeployError, "credentials"):
            deploy.normalize_api_url("https://token@screeps.com/season")
        with self.assertRaisesRegex(deploy.DeployError, "query strings or fragments"):
            deploy.normalize_api_url("https://screeps.com/season?x=1")
        with self.assertRaisesRegex(deploy.DeployError, "invalid path prefixes"):
            deploy.normalize_api_url("https://screeps.com/season/extra")

    def test_artifact_metadata_reports_hash_and_size(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data = b"abc"
            path = Path(tmp) / "main.js"
            path.write_bytes(data)

            read, metadata = deploy.read_artifact(path)

        self.assertEqual(read, data)
        self.assertEqual(metadata["sizeBytes"], 3)
        self.assertEqual(metadata["sha256"], hashlib.sha256(data).hexdigest())

    def test_dry_run_does_not_require_token_or_http(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact = self.write_artifact(Path(tmp))
            cfg = self.config(artifact, activate_world=True)

            evidence = deploy.run_deploy(cfg, env={}, transport=lambda **_kwargs: self.fail("no HTTP expected"))

        encoded = json.dumps(evidence, sort_keys=True)
        self.assertTrue(evidence["ok"])
        self.assertEqual(evidence["mode"], "dry-run")
        self.assertEqual(evidence["verification"]["dryRun"]["status"], "passed")
        self.assertIn("/api/user/code", encoded)
        self.assertNotIn("SCREEPS_AUTH_TOKEN", encoded)
        self.assertNotIn("module.exports.loop", encoded)

    def test_dry_run_can_target_seasonal_world_without_http(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact = self.write_artifact(Path(tmp))
            cfg = self.config(
                artifact,
                api_url="https://screeps.com/season",
                branch="seasonal-smoke",
                shard="shardSeason",
                room="W1N1",
                activate_world=True,
            )

            evidence = deploy.run_deploy(cfg, env={}, transport=lambda **_kwargs: self.fail("no HTTP expected"))

        self.assertTrue(evidence["ok"])
        self.assertEqual(evidence["mode"], "dry-run")
        self.assertEqual(evidence["target"]["apiUrl"], "https://screeps.com/season")
        self.assertEqual(evidence["target"]["world"], "seasonal")
        self.assertEqual(evidence["target"]["worldRoot"], "https://screeps.com/season")
        self.assertEqual(evidence["target"]["branch"], "seasonal-smoke")
        self.assertEqual(evidence["target"]["shard"], "shardSeason")
        self.assertEqual(evidence["requests"][2]["payload"]["branch"], "seasonal-smoke")

    def test_dry_run_allows_plaintext_local_api_url_without_http(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact = self.write_artifact(Path(tmp))
            cfg = self.config(artifact, api_url="http://localhost:21025")

            evidence = deploy.run_deploy(cfg, env={}, transport=lambda **_kwargs: self.fail("no HTTP expected"))

        self.assertTrue(evidence["ok"])
        self.assertEqual(evidence["mode"], "dry-run")
        self.assertEqual(evidence["target"]["apiUrl"], "http://localhost:21025")

    def test_deploy_rejects_plaintext_api_url_before_authenticated_requests(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact = self.write_artifact(Path(tmp))
            cfg = self.config(
                artifact,
                api_url="http://localhost:21025",
                deploy_mode=True,
                confirm="deploy main to shardX/E19S57",
            )

            with self.assertRaisesRegex(deploy.DeployError, "https://screeps.com"):
                deploy.run_deploy(
                    cfg,
                    env={deploy.AUTH_TOKEN_ENV: "fixture-value"},
                    transport=lambda **_kwargs: self.fail("no HTTP expected"),
                )

    def test_deploy_rejects_seasonal_api_url_before_authenticated_requests(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact = self.write_artifact(Path(tmp))
            cfg = self.config(
                artifact,
                api_url="https://screeps.com/season",
                branch="seasonal-smoke",
                shard="shardSeason",
                room="W1N1",
                deploy_mode=True,
                confirm="deploy seasonal-smoke to shardSeason/W1N1",
            )

            with self.assertRaisesRegex(
                deploy.DeployError,
                "Seasonal live deploy is not enabled.*dry-run only.*isolation",
            ):
                deploy.run_deploy(
                    cfg,
                    env={deploy.AUTH_TOKEN_ENV: "fixture-value"},
                    transport=lambda **_kwargs: self.fail("no HTTP expected"),
                )

    def test_deploy_requests_expected_endpoints_and_verifies_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_body = "module.exports.loop = function () { return 1; };\n"
            artifact = self.write_artifact(Path(tmp), artifact_body)
            expected_hash = hashlib.sha256(artifact_body.encode("utf-8")).hexdigest()
            responses = [
                deploy.HttpResult(200, {"ok": 1, "list": [{"branch": "default", "activeWorld": True}]}, {}),
                deploy.HttpResult(200, {"ok": 1}, {}),
                deploy.HttpResult(
                    200,
                    {"ok": 1, "list": [{"branch": "default", "activeWorld": True}, {"branch": "main"}]},
                    {},
                ),
                deploy.HttpResult(200, {"ok": 1, "timestamp": 123}, {}),
                deploy.HttpResult(200, {"ok": 1, "modules": {"main": artifact_body}}, {}),
                deploy.HttpResult(200, {"ok": 1}, {}),
                deploy.HttpResult(
                    200,
                    {"ok": 1, "list": [{"branch": "default"}, {"branch": "main", "activeWorld": True}]},
                    {},
                ),
                deploy.HttpResult(200, {"ok": 1, "modules": {"main": artifact_body}}, {}),
            ]
            fake = FakeTransport(responses)
            cfg = self.config(
                artifact,
                deploy_mode=True,
                activate_world=True,
                confirm="deploy main to shardX/E19S57",
            )

            evidence = deploy.run_deploy(cfg, env={deploy.AUTH_TOKEN_ENV: "fixture-value"}, transport=fake)

        self.assertTrue(evidence["ok"])
        self.assertEqual(evidence["verification"]["branchCode"]["status"], "matched")
        self.assertEqual(evidence["verification"]["branchCode"]["remote"]["sha256"], expected_hash)
        self.assertEqual(evidence["verification"]["activeWorld"]["status"], "matched")
        self.assertEqual(
            [(call["method"], call["path"], call["params"]) for call in fake.calls],
            [
                ("GET", "/api/user/branches", None),
                ("POST", "/api/user/clone-branch", None),
                ("GET", "/api/user/branches", None),
                ("POST", "/api/user/code", None),
                ("GET", "/api/user/code", {"branch": "main"}),
                ("POST", "/api/user/set-active-branch", None),
                ("GET", "/api/user/branches", None),
                ("GET", "/api/user/code", {"branch": "$activeWorld"}),
            ],
        )
        self.assertEqual(fake.calls[1]["payload"], {"branch": "default", "newName": "main"})
        self.assertEqual(fake.calls[3]["payload"]["modules"]["main"], artifact_body)
        self.assertEqual(fake.calls[0]["headers"], {"X-Token": "fixture-value"})
        encoded_evidence = json.dumps(evidence, sort_keys=True)
        self.assertNotIn("fixture-value", encoded_evidence)
        self.assertNotIn(artifact_body, encoded_evidence)

    def test_api_failures_redact_token_value_from_error_text(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact = self.write_artifact(Path(tmp), "module.exports.loop = function () { return 1; };\n")
            fake = FakeTransport(
                [
                    deploy.HttpResult(
                        500,
                        {"ok": 0, "message": "upstream echoed fixture-value in a non-standard field"},
                        {},
                    )
                ]
            )
            cfg = self.config(artifact, deploy_mode=True, confirm="deploy main to shardX/E19S57")

            with self.assertRaisesRegex(deploy.DeployError, "list branches failed") as raised:
                deploy.run_deploy(cfg, env={deploy.AUTH_TOKEN_ENV: "fixture-value"}, transport=fake)

        self.assertNotIn("fixture-value", str(raised.exception))
        self.assertIn("[REDACTED]", str(raised.exception))

    def test_upload_failure_redacts_token_value_from_error_text(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact = self.write_artifact(Path(tmp), "module.exports.loop = function () { return 1; };\n")
            fake = FakeTransport(
                [
                    deploy.HttpResult(200, {"ok": 1, "list": [{"branch": "main", "activeWorld": True}]}, {}),
                    deploy.HttpResult(200, {"ok": 1, "list": [{"branch": "main", "activeWorld": True}]}, {}),
                    deploy.HttpResult(500, {"ok": 0, "message": "upload rejected for fixture-value"}, {}),
                ]
            )
            cfg = self.config(artifact, deploy_mode=True, confirm="deploy main to shardX/E19S57")

            with self.assertRaisesRegex(deploy.DeployError, "upload code failed") as raised:
                deploy.run_deploy(cfg, env={deploy.AUTH_TOKEN_ENV: "fixture-value"}, transport=fake)

        self.assertNotIn("fixture-value", str(raised.exception))
        self.assertIn("[REDACTED]", str(raised.exception))

    def test_transport_failures_redact_token_value_from_error_text(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact = self.write_artifact(Path(tmp), "module.exports.loop = function () { return 1; };\n")

            def failing_transport(**_kwargs: Any) -> deploy.HttpResult:
                raise deploy.DeployError("request failed after echoing fixture-value")

            cfg = self.config(artifact, deploy_mode=True, confirm="deploy main to shardX/E19S57")

            with self.assertRaisesRegex(deploy.DeployError, "request failed") as raised:
                deploy.run_deploy(cfg, env={deploy.AUTH_TOKEN_ENV: "fixture-value"}, transport=failing_transport)

        self.assertNotIn("fixture-value", str(raised.exception))
        self.assertIn("[REDACTED]", str(raised.exception))

    def test_remote_hash_mismatch_fails_without_printing_remote_code(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact = self.write_artifact(Path(tmp), "module.exports.loop = function () { return 1; };\n")
            fake = FakeTransport(
                [
                    deploy.HttpResult(200, {"ok": 1, "list": [{"branch": "main", "activeWorld": True}]}, {}),
                    deploy.HttpResult(200, {"ok": 1, "list": [{"branch": "main", "activeWorld": True}]}, {}),
                    deploy.HttpResult(200, {"ok": 1, "timestamp": 123}, {}),
                    deploy.HttpResult(200, {"ok": 1, "modules": {"main": "module.exports.loop = function () { return 2; };\n"}}, {}),
                ]
            )
            cfg = self.config(artifact, deploy_mode=True, confirm="deploy main to shardX/E19S57")

            with self.assertRaisesRegex(deploy.DeployError, "hash verification failed") as raised:
                deploy.run_deploy(cfg, env={deploy.AUTH_TOKEN_ENV: "fixture-value"}, transport=fake)

        self.assertNotIn("return 2", str(raised.exception))

    def test_health_gate_auto_rollback_triggers_only_room_survival_failures(self) -> None:
        self.assertTrue(
            deploy.health_gate_triggers_auto_rollback({"ok": False, "reasons": [{"kind": "postdeploy_room_dead"}]})
        )
        self.assertTrue(
            deploy.health_gate_triggers_auto_rollback({"ok": False, "reasons": [{"kind": "postdeploy_no_owned_spawn"}]})
        )
        self.assertTrue(
            deploy.health_gate_triggers_auto_rollback(
                {"ok": False, "reasons": [{"kind": "postdeploy_active_alert", "source": {"kind": "room_dead"}}]}
            )
        )
        self.assertFalse(
            deploy.health_gate_triggers_auto_rollback({"ok": False, "reasons": [{"kind": "postdeploy_summary_failed"}]})
        )
        self.assertFalse(deploy.health_gate_triggers_auto_rollback({"ok": True, "reasons": [{"kind": "room_dead"}]}))

    def test_auto_rollback_recovery_targets_use_triggering_reason_rooms(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact = self.write_artifact(Path(tmp))
            cfg = self.config(artifact)

            targets = deploy.auto_rollback_recovery_targets(
                cfg,
                {
                    "ok": False,
                    "reasons": [
                        {"kind": "postdeploy_room_dead", "room": "shardX/E29N58"},
                        {"kind": "postdeploy_no_owned_spawn", "room": "E29N59"},
                        {"kind": "postdeploy_room_dead"},
                        {
                            "kind": "postdeploy_active_alert",
                            "room": "E29N60",
                            "source": {"kind": "room_dead"},
                        },
                        {"kind": "postdeploy_summary_failed", "room": "E1N1"},
                        {"kind": "postdeploy_room_dead", "room": "shardX/E29N58"},
                    ],
                },
            )

        self.assertEqual(
            targets,
            [
                ("shardX", "E29N58"),
                ("shardX", "E29N59"),
                ("shardX", "E19S57"),
                ("shardX", "E29N60"),
            ],
        )

    def test_auto_rollback_recovery_targets_fall_back_to_configured_room(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact = self.write_artifact(Path(tmp))
            cfg = self.config(artifact)

            targets = deploy.auto_rollback_recovery_targets(
                cfg,
                {"ok": False, "reasons": [{"kind": "postdeploy_room_dead"}]},
            )

        self.assertEqual(targets, [("shardX", "E19S57")])

    def test_previous_evidence_lookup_finds_last_healthy_deploy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence_dir = Path(tmp)
            self.write_deploy_evidence(
                evidence_dir,
                "1",
                "1111111111111111111111111111111111111111",
                timestamp="2026-05-01T00:00:00Z",
            )
            self.write_deploy_evidence(
                evidence_dir,
                "2",
                "2222222222222222222222222222222222222222",
                health_ok=False,
                timestamp="2026-05-02T00:00:00Z",
            )
            latest_deploy, latest_health = self.write_deploy_evidence(
                evidence_dir,
                "3",
                "3333333333333333333333333333333333333333",
                timestamp="2026-05-03T00:00:00Z",
            )

            previous = deploy.find_previous_healthy_deploy(
                evidence_dir,
                target=self.deploy_target(),
                current_commit="bad",
            )

        self.assertEqual(previous.commit, "3333333333333333333333333333333333333333")
        self.assertEqual(previous.deploy_path, latest_deploy)
        self.assertEqual(previous.health_gate_path, latest_health)

    def test_previous_evidence_lookup_filters_by_target(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence_dir = Path(tmp)
            self.write_deploy_evidence(
                evidence_dir,
                "matching-target",
                "1111111111111111111111111111111111111111",
                timestamp="2026-05-01T00:00:00Z",
            )
            self.write_deploy_evidence(
                evidence_dir,
                "wrong-api",
                "2222222222222222222222222222222222222222",
                timestamp="2026-05-02T00:00:00Z",
                target=self.deploy_target(apiUrl="https://screeps.example"),
            )
            self.write_deploy_evidence(
                evidence_dir,
                "wrong-branch",
                "3333333333333333333333333333333333333333",
                timestamp="2026-05-03T00:00:00Z",
                target=self.deploy_target(branch="other"),
            )
            self.write_deploy_evidence(
                evidence_dir,
                "wrong-shard",
                "4444444444444444444444444444444444444444",
                timestamp="2026-05-04T00:00:00Z",
                target=self.deploy_target(shard="shard0"),
            )
            self.write_deploy_evidence(
                evidence_dir,
                "wrong-room",
                "5555555555555555555555555555555555555555",
                timestamp="2026-05-05T00:00:00Z",
                target=self.deploy_target(room="W1N1"),
            )

            previous = deploy.find_previous_healthy_deploy(
                evidence_dir,
                target=self.deploy_target(),
                current_commit="bad",
            )

        self.assertEqual(previous.commit, "1111111111111111111111111111111111111111")

    def test_previous_evidence_lookup_handles_missing_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(deploy.DeployError, "no previous healthy deploy evidence"):
                deploy.find_previous_healthy_deploy(Path(tmp), target=self.deploy_target(), current_commit="bad")

    def test_postdeploy_health_gate_uses_paired_deploy_evidence_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            artifact = self.write_artifact(repo_root)
            evidence_dir = repo_root / "runtime-artifacts" / "official-screeps-deploy"
            deploy_path = evidence_dir / "official-screeps-deploy-rollback.json"
            cfg = self.config(
                artifact,
                evidence_dir=evidence_dir,
                evidence_path=deploy_path,
                repo_root=repo_root,
            )
            commands: list[list[str]] = []

            def command_runner(command: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
                commands.append(command)
                return subprocess.CompletedProcess(command, 0, stdout='{"ok": true}\n', stderr="")

            health_gate = deploy.run_postdeploy_health_gate(cfg, env={}, runner=command_runner)
            paired_path = evidence_dir / "postdeploy-health-gate-rollback.json"
            expected_out_dir = repo_root / "runtime-artifacts" / "screeps-monitor"
            expected_runtime_summary_dir = repo_root / "runtime-artifacts" / "runtime-summary-console"
            expected_capture_status_path = evidence_dir / "postdeploy-runtime-summary-console-status.json"

            self.assertTrue(health_gate["ok"])
            self.assertTrue(paired_path.exists())
            self.assertFalse((evidence_dir / "postdeploy-health-gate.json").exists())
            self.assertEqual(
                commands[0][1:3],
                [str(repo_root / "scripts" / "screeps_runtime_summary_console_capture.py"), "--live-official-console"],
            )
            self.assertIn("--out-dir", commands[0])
            capture_out_dir_index = commands[0].index("--out-dir")
            self.assertEqual(commands[0][capture_out_dir_index + 1], str(expected_runtime_summary_dir))
            self.assertIn("--status-file", commands[0])
            capture_status_index = commands[0].index("--status-file")
            self.assertEqual(commands[0][capture_status_index + 1], str(expected_capture_status_path))
            self.assertIn("--live-timeout-seconds", commands[0])
            self.assertEqual(commands[1][1:3], [str(repo_root / "scripts" / "screeps-runtime-monitor.py"), "summary"])
            self.assertIn("--out-dir", commands[1])
            summary_out_dir_index = commands[1].index("--out-dir")
            self.assertEqual(commands[1][summary_out_dir_index + 1], str(expected_out_dir))
            self.assertIn("--runtime-summary-out-dir", commands[1])
            summary_runtime_dir_index = commands[1].index("--runtime-summary-out-dir")
            self.assertEqual(commands[1][summary_runtime_dir_index + 1], str(expected_runtime_summary_dir))
            self.assertNotIn("--room", commands[1])
            self.assertEqual(commands[2][1:3], [str(repo_root / "scripts" / "screeps-runtime-monitor.py"), "alert"])
            self.assertIn("--out-dir", commands[2])
            alert_out_dir_index = commands[2].index("--out-dir")
            self.assertEqual(commands[2][alert_out_dir_index + 1], str(expected_out_dir))
            self.assertIn("--runtime-summary-dir", commands[2])
            alert_runtime_dir_index = commands[2].index("--runtime-summary-dir")
            self.assertEqual(commands[2][alert_runtime_dir_index + 1], str(expected_runtime_summary_dir))
            self.assertNotIn("--room", commands[2])
            self.assertIn("--force-alert-image", commands[2])
            self.assertEqual(commands[3][1:3], [str(repo_root / "scripts" / "screeps-runtime-monitor.py"), "health-gate"])
            self.assertIn("--console-capture-status", commands[3])
            health_status_index = commands[3].index("--console-capture-status")
            self.assertEqual(commands[3][health_status_index + 1], str(expected_capture_status_path))

    def test_postdeploy_health_gate_uses_default_path_without_deploy_evidence_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            artifact = self.write_artifact(repo_root)
            evidence_dir = repo_root / "runtime-artifacts" / "official-screeps-deploy"
            cfg = self.config(artifact, evidence_dir=evidence_dir, repo_root=repo_root)

            def command_runner(command: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
                return subprocess.CompletedProcess(command, 0, stdout='{"ok": true}\n', stderr="")

            health_gate = deploy.run_postdeploy_health_gate(cfg, env={}, runner=command_runner)
            default_path = evidence_dir / "postdeploy-health-gate.json"

            self.assertTrue(health_gate["ok"])
            self.assertTrue(default_path.exists())

    def test_official_deploy_workflow_installs_websockets_before_deploy_upload_and_live_capture(self) -> None:
        workflow = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "official-screeps-deploy.yml"
        text = workflow.read_text(encoding="utf-8")
        install_step_marker = "      - name: Install live console dependency"
        install_marker = 'python3 -m pip install --disable-pip-version-check "websockets>=12,<16"'
        deploy_upload_marker = "            --deploy"
        capture_marker = "python3 scripts/screeps_runtime_summary_console_capture.py"

        self.assertIn(install_step_marker, text)
        self.assertIn(install_marker, text)
        self.assertIn(deploy_upload_marker, text)
        self.assertIn(capture_marker, text)
        install_step_index = text.index(install_step_marker)
        install_index = text.index(install_marker)
        self.assertLess(install_step_index, install_index)
        self.assertIn("if: ${{ inputs.mode == 'deploy' }}", text[install_step_index:install_index])
        self.assertLess(install_index, text.index(deploy_upload_marker))
        self.assertLess(install_index, text.index(capture_marker))

    def test_official_deploy_workflow_archives_and_passes_live_capture_status(self) -> None:
        workflow = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "official-screeps-deploy.yml"
        text = workflow.read_text(encoding="utf-8")
        capture_status_marker = '--status-file "$EVIDENCE_DIR/postdeploy-runtime-summary-console-status.json"'
        health_gate_status_marker = (
            '--console-capture-status "$EVIDENCE_DIR/postdeploy-runtime-summary-console-status.json"'
        )

        self.assertIn(capture_status_marker, text)
        self.assertIn(health_gate_status_marker, text)
        self.assertLess(text.index(capture_status_marker), text.index(health_gate_status_marker))
        self.assertIn("runtime-artifacts/official-screeps-deploy/", text)
        self.assertIn("runtime-artifacts/runtime-summary-console/", text)

    def test_recovery_summary_reader_scopes_single_target_and_collects_all_for_multiple_targets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            artifact = self.write_artifact(repo_root)
            evidence_dir = repo_root / "runtime-artifacts" / "official-screeps-deploy"
            cfg = self.config(artifact, evidence_dir=evidence_dir, repo_root=repo_root)
            commands: list[list[str]] = []

            def command_runner(command: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
                commands.append(command)
                return subprocess.CompletedProcess(command, 0, stdout='{"ok": true}\n', stderr="")

            single_reader = deploy.make_runtime_summary_reader(
                cfg,
                target_rooms=[("shardX", "E29N58")],
                env={},
                runner=command_runner,
            )
            single_reader()

            self.assertIn("--room", commands[0])
            self.assertIn("shardX/E29N58", commands[0])
            self.assertNotIn("shardX/E19S57", commands[0])

            commands.clear()
            multi_reader = deploy.make_runtime_summary_reader(
                cfg,
                target_rooms=[("shardX", "E19S57"), ("shardX", "E29N58")],
                env={},
                runner=command_runner,
            )
            multi_reader()

            self.assertNotIn("--room", commands[0])

    def test_recovery_verification_requires_spawn_and_owned_creep(self) -> None:
        recovered = deploy.recovery_status_from_payload(
            {
                "ok": True,
                "room_summaries": [
                    {
                        "room": "shardX/E19S57",
                        "owned_spawns": 1,
                        "owned_creeps": 1,
                    }
                ],
            },
            "shardX",
            "E19S57",
        )
        missing = deploy.recovery_status_from_payload(
            {
                "ok": True,
                "room_summaries": [
                    {
                        "room": "shardX/E19S57",
                        "owned_spawns": 1,
                        "owned_creeps": 0,
                    }
                ],
            },
            "shardX",
            "E19S57",
        )

        self.assertTrue(recovered["ok"])
        self.assertFalse(missing["ok"])

    def test_auto_rollback_deploys_previous_healthy_commit_and_creates_issue(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            evidence_dir = repo_root / "runtime-artifacts" / "official-screeps-deploy"
            evidence_dir.mkdir(parents=True)
            prod_dist = repo_root / "prod" / "dist"
            prod_dist.mkdir(parents=True)
            artifact_body = "module.exports.loop = function () { return 1; };\n"
            artifact = self.write_artifact(prod_dist, artifact_body)
            self.write_deploy_evidence(
                evidence_dir,
                "healthy",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                timestamp="2026-05-01T00:00:00Z",
            )
            self.write_deploy_evidence(
                evidence_dir,
                "wrong-target",
                "cccccccccccccccccccccccccccccccccccccccc",
                timestamp="2026-05-02T00:00:00Z",
                target=self.deploy_target(branch="other"),
            )
            cfg = self.config(
                artifact,
                deploy_mode=True,
                activate_world=False,
                confirm="deploy main to shardX/E19S57",
                evidence_dir=evidence_dir,
                repo_root=repo_root,
            )
            responses = [
                deploy.HttpResult(200, {"ok": 1, "list": [{"branch": "main", "activeWorld": True}]}, {}),
                deploy.HttpResult(200, {"ok": 1, "list": [{"branch": "main", "activeWorld": True}]}, {}),
                deploy.HttpResult(200, {"ok": 1, "timestamp": 123}, {}),
                deploy.HttpResult(200, {"ok": 1, "modules": {"main": artifact_body}}, {}),
            ]
            fake = FakeTransport(responses)
            commands: list[list[str]] = []
            issues: list[dict[str, Any]] = []

            def command_runner(command: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
                commands.append(command)
                return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

            def issue_creator(title: str, body: str, labels: list[str], root: Path) -> dict[str, Any]:
                issues.append({"title": title, "body": body, "labels": labels, "root": root})
                return {"created": True, "url": "https://github.com/lanyusea/screeps/issues/5999"}

            summary = deploy.execute_auto_rollback(
                cfg,
                {
                    "git": {"commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
                    "target": self.deploy_target(),
                },
                {"ok": False, "reasons": [{"kind": "postdeploy_room_dead"}]},
                env={deploy.AUTH_TOKEN_ENV: "fixture-value"},
                transport=fake,
                command_runner=command_runner,
                recovery_reader=lambda: {
                    "ok": True,
                    "room_summaries": [{"room": "shardX/E19S57", "owned_spawns": 1, "owned_creeps": 1}],
                },
                issue_creator=issue_creator,
                sleeper=lambda _seconds: None,
            )
            rollback_deploy_written = (evidence_dir / "auto-rollback-deploy.json").exists()

        self.assertTrue(summary["ok"])
        self.assertEqual(summary["rollbackCommit"], "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        self.assertIn(["git", "checkout", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "--", *deploy.ROLLBACK_SOURCE_PATHS], commands)
        self.assertIn(["npm", "run", "build"], commands)
        self.assertEqual(issues[0]["title"], deploy.ROLLBACK_ISSUE_TITLE)
        self.assertEqual(issues[0]["labels"], ["priority:p0"])
        self.assertTrue(rollback_deploy_written)

    def test_auto_rollback_escalates_when_triggering_secondary_room_does_not_recover(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            evidence_dir = repo_root / "runtime-artifacts" / "official-screeps-deploy"
            evidence_dir.mkdir(parents=True)
            prod_dist = repo_root / "prod" / "dist"
            prod_dist.mkdir(parents=True)
            artifact_body = "module.exports.loop = function () { return 1; };\n"
            artifact = self.write_artifact(prod_dist, artifact_body)
            self.write_deploy_evidence(
                evidence_dir,
                "healthy",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                timestamp="2026-05-01T00:00:00Z",
            )
            cfg = self.config(
                artifact,
                deploy_mode=True,
                activate_world=False,
                confirm="deploy main to shardX/E19S57",
                evidence_dir=evidence_dir,
                repo_root=repo_root,
            )
            responses = [
                deploy.HttpResult(200, {"ok": 1, "list": [{"branch": "main", "activeWorld": True}]}, {}),
                deploy.HttpResult(200, {"ok": 1, "list": [{"branch": "main", "activeWorld": True}]}, {}),
                deploy.HttpResult(200, {"ok": 1, "timestamp": 123}, {}),
                deploy.HttpResult(200, {"ok": 1, "modules": {"main": artifact_body}}, {}),
            ]
            fake = FakeTransport(responses)
            commands: list[list[str]] = []
            monotonic_values = iter([0.0, 301.0])

            def command_runner(command: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
                commands.append(command)
                return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

            with self.assertRaisesRegex(deploy.DeployError, "AUTO-ROLLBACK ESCALATION") as raised:
                deploy.execute_auto_rollback(
                    cfg,
                    {
                        "git": {"commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
                        "target": self.deploy_target(),
                    },
                    {"ok": False, "reasons": [{"kind": "postdeploy_room_dead", "room": "shardX/E29N58"}]},
                    env={deploy.AUTH_TOKEN_ENV: "fixture-value"},
                    transport=fake,
                    command_runner=command_runner,
                    recovery_reader=lambda: {
                        "ok": True,
                        "room_summaries": [
                            {"room": "shardX/E19S57", "owned_spawns": 1, "owned_creeps": 1},
                            {"room": "shardX/E29N58", "owned_spawns": 0, "owned_creeps": 0},
                        ],
                    },
                    issue_creator=lambda *_args: self.fail("no issue expected before recovery is verified"),
                    sleeper=lambda _seconds: None,
                    monotonic=lambda: next(monotonic_values),
                )

        self.assertIn("E29N58", str(raised.exception))
        self.assertIn(["git", "checkout", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "--", *deploy.ROLLBACK_SOURCE_PATHS], commands)
        self.assertIn(["npm", "run", "build"], commands)

    def test_auto_rollback_escalates_when_previous_evidence_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact = self.write_artifact(Path(tmp))
            cfg = self.config(
                artifact,
                deploy_mode=True,
                confirm="deploy main to shardX/E19S57",
                evidence_dir=Path(tmp) / "evidence",
            )

            with self.assertRaisesRegex(deploy.DeployError, "AUTO-ROLLBACK ESCALATION"):
                deploy.execute_auto_rollback(
                    cfg,
                    {
                        "git": {"commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
                        "target": self.deploy_target(),
                    },
                    {"ok": False, "reasons": [{"kind": "postdeploy_room_dead"}]},
                    env={deploy.AUTH_TOKEN_ENV: "fixture-value"},
                    command_runner=lambda *args, **kwargs: self.fail("no commands expected"),
                    recovery_reader=lambda: self.fail("no recovery check expected"),
                    issue_creator=lambda *_args: self.fail("no issue expected"),
                )


if __name__ == "__main__":
    unittest.main()
