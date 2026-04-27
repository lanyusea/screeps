#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
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
        deploy_mode: bool = False,
        activate_world: bool = False,
        confirm: str | None = None,
        repo_root: Path | None = None,
    ) -> deploy.DeployConfig:
        return deploy.DeployConfig(
            api_url=api_url,
            branch="main",
            shard="shardX",
            room="E48S28",
            artifact_path=artifact,
            deploy=deploy_mode,
            activate_world=activate_world,
            confirm=confirm,
            repo_root=repo_root or artifact.parent,
        )

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
        with self.assertRaisesRegex(deploy.DeployError, "https://screeps.com"):
            deploy.normalize_api_url("http://localhost:21025/")
        with self.assertRaisesRegex(deploy.DeployError, "https://screeps.com"):
            deploy.normalize_api_url("ftp://screeps.com")

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
                confirm="deploy main to shardX/E48S28",
            )

            with self.assertRaisesRegex(deploy.DeployError, "https://screeps.com"):
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
                confirm="deploy main to shardX/E48S28",
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
            cfg = self.config(artifact, deploy_mode=True, confirm="deploy main to shardX/E48S28")

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
            cfg = self.config(artifact, deploy_mode=True, confirm="deploy main to shardX/E48S28")

            with self.assertRaisesRegex(deploy.DeployError, "upload code failed") as raised:
                deploy.run_deploy(cfg, env={deploy.AUTH_TOKEN_ENV: "fixture-value"}, transport=fake)

        self.assertNotIn("fixture-value", str(raised.exception))
        self.assertIn("[REDACTED]", str(raised.exception))

    def test_transport_failures_redact_token_value_from_error_text(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact = self.write_artifact(Path(tmp), "module.exports.loop = function () { return 1; };\n")

            def failing_transport(**_kwargs: Any) -> deploy.HttpResult:
                raise deploy.DeployError("request failed after echoing fixture-value")

            cfg = self.config(artifact, deploy_mode=True, confirm="deploy main to shardX/E48S28")

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
            cfg = self.config(artifact, deploy_mode=True, confirm="deploy main to shardX/E48S28")

            with self.assertRaisesRegex(deploy.DeployError, "hash verification failed") as raised:
                deploy.run_deploy(cfg, env={deploy.AUTH_TOKEN_ENV: "fixture-value"}, transport=fake)

        self.assertNotIn("return 2", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
