#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import io
import json
import shlex
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from typing import Callable
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import screeps_tencent_batch_rl_runner as runner


CONTROLLER_IP = "43.128.104.34/32"


def add_file(tar: tarfile.TarFile, name: str, content: bytes = b"ok") -> None:
    info = tarfile.TarInfo(name)
    info.size = len(content)
    tar.addfile(info, io.BytesIO(content))


def add_special(tar: tarfile.TarFile, name: str, member_type: bytes, linkname: str = "") -> None:
    info = tarfile.TarInfo(name)
    info.type = member_type
    info.linkname = linkname
    tar.addfile(info)


def write_tar(path: Path, callback: Callable[[tarfile.TarFile], None]) -> None:
    with tarfile.open(path, "w:gz") as tar:
        callback(tar)


def controller_args() -> argparse.Namespace:
    return argparse.Namespace(
        asg_id="asg-test",
        bootstrap_timeout_seconds=1,
        controller_ip=CONTROLLER_IP,
        dataset_run_id="dataset-test",
        preflight_only=False,
        region="ap-singapore",
        remote_base="/opt/screeps-batch/jobs",
        repetitions=1,
        scale_down_timeout_seconds=1,
        tccli="/bin/tccli",
        ticks=1,
        training_approach="bandit",
        worker_user="screeps-batch",
        workers=1,
    )


def run_git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def write_text(path: Path, text: str = "ok\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def decode_remote_bash_lc(remote_command: str) -> str:
    tokens = shlex.split(remote_command)
    script_arg = tokens[tokens.index("-lc") + 1]
    script_tokens = shlex.split(script_arg)
    return base64.b64decode(script_tokens[2]).decode("utf-8")


class TencentBatchRlRunnerTest(unittest.TestCase):
    def test_security_group_guard_accepts_single_controller_ssh_rule(self) -> None:
        ingress = [
            {"Action": "ACCEPT", "Protocol": "TCP", "Port": "22", "CidrBlock": CONTROLLER_IP},
            {"Action": "DROP", "Protocol": "ALL", "Port": "ALL", "CidrBlock": "0.0.0.0/0"},
        ]

        self.assertEqual(runner.validate_controller_only_sg_ssh_ingress(ingress, CONTROLLER_IP), [ingress[0]])

    def test_security_group_guard_rejects_all_protocol_broad_ssh(self) -> None:
        ingress = [
            {"Action": "ACCEPT", "Protocol": "TCP", "Port": "22", "CidrBlock": CONTROLLER_IP},
            {"Action": "ACCEPT", "Protocol": "ALL", "Port": "ALL", "CidrBlock": "0.0.0.0/0"},
        ]

        with self.assertRaisesRegex(runner.BatchRunError, "controller-only"):
            runner.validate_controller_only_sg_ssh_ingress(ingress, CONTROLLER_IP)

    def test_worker_iptables_guard_accepts_controller_rule_with_ssh_drop_closure(self) -> None:
        output = (
            "iptables=-P INPUT ACCEPT;"
            "-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT;"
            f"-A INPUT -p tcp -s {CONTROLLER_IP} --dport 22 -j ACCEPT;"
            "-A INPUT -p tcp --dport 22 -j DROP;\n"
            "sshd=passwordauthentication no;"
        )

        runner.validate_controller_only_worker_ssh(output, CONTROLLER_IP)

    def test_worker_iptables_guard_rejects_broad_ssh_accept(self) -> None:
        output = (
            "iptables=-P INPUT DROP;"
            f"-A INPUT -p tcp -s {CONTROLLER_IP} --dport 22 -j ACCEPT;"
            "-A INPUT -p tcp --dport 22 -j ACCEPT;\n"
            "sshd=passwordauthentication no;"
        )

        with self.assertRaisesRegex(runner.BatchRunError, "controller-only"):
            runner.validate_controller_only_worker_ssh(output, CONTROLLER_IP)

    def test_worker_iptables_guard_rejects_broad_ssh_accept_in_jumped_chain(self) -> None:
        output = (
            "iptables_filter=*filter;"
            ":INPUT DROP [0:0];"
            ":ufw-user-input - [0:0];"
            "-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT;"
            "-A INPUT -j ufw-user-input;"
            f"-A ufw-user-input -p tcp -s {CONTROLLER_IP} --dport 22 -j ACCEPT;"
            "-A ufw-user-input -p tcp --dport 22 -j ACCEPT;"
            "COMMIT;\n"
            "sshd=passwordauthentication no;"
        )

        with self.assertRaisesRegex(runner.BatchRunError, "controller-only"):
            runner.validate_controller_only_worker_ssh(output, CONTROLLER_IP)

    def test_worker_iptables_guard_accepts_controller_only_full_ruleset(self) -> None:
        output = (
            "iptables_filter=*filter;"
            ":INPUT DROP [0:0];"
            ":ufw-user-input - [0:0];"
            "-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT;"
            "-A INPUT -j ufw-user-input;"
            f"-A ufw-user-input -p tcp -s {CONTROLLER_IP} --dport 22 -j ACCEPT;"
            "-A ufw-user-input -p tcp --dport 22 -j DROP;"
            "COMMIT;\n"
            "sshd=passwordauthentication no;"
        )

        runner.validate_controller_only_worker_ssh(output, CONTROLLER_IP)

    def test_worker_iptables_guard_requires_ssh_closure_when_default_policy_accepts(self) -> None:
        output = f"iptables=-P INPUT ACCEPT;-A INPUT -p tcp -s {CONTROLLER_IP} --dport 22 -j ACCEPT;\n"

        with self.assertRaisesRegex(runner.BatchRunError, "controller-only"):
            runner.validate_controller_only_worker_ssh(output, CONTROLLER_IP)

    def test_repo_bundle_uses_tracked_manifest_plus_required_map(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_git(["init", "-q"], root)
            write_text(root / ".gitignore", ".env\n*.local\nprod/.env\n")
            write_text(root / "scripts" / "tracked.py")
            write_text(root / "prod" / "dist" / "main.js", "bundle\n")
            write_text(root / "maps" / "map-0b6758af.json", "{}\n")
            write_text(root / ".env", "TOKEN=secret\n")
            write_text(root / "prod" / ".env", "TOKEN=secret\n")
            write_text(root / "scratch.local", "TOKEN=secret\n")
            write_text(root / "credential.json", '{"token":"secret"}\n')
            run_git(["add", ".gitignore", "scripts/tracked.py", "prod/dist/main.js"], root)

            package = root / "out" / "repo-bundle.tar.gz"
            with mock.patch.object(runner, "REPO_ROOT", root):
                runner.create_repo_bundle(package)

            with tarfile.open(package, "r:gz") as tar:
                names = set(tar.getnames())
            self.assertIn(".gitignore", names)
            self.assertIn("scripts/tracked.py", names)
            self.assertIn("prod/dist/main.js", names)
            self.assertIn("maps/map-0b6758af.json", names)
            self.assertNotIn(".env", names)
            self.assertNotIn("prod/.env", names)
            self.assertNotIn("scratch.local", names)
            self.assertNotIn("credential.json", names)

    def test_repo_bundle_rejects_tracked_secret_like_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            run_git(["init", "-q"], root)
            write_text(root / ".gitignore")
            write_text(root / "ops-credentials.json", '{"token":"secret"}\n')
            run_git(["add", ".gitignore", "ops-credentials.json"], root)

            with mock.patch.object(runner, "REPO_ROOT", root):
                with self.assertRaisesRegex(runner.BatchRunError, "secret-like"):
                    runner.create_repo_bundle(root / "repo-bundle.tar.gz")

    def test_safe_extract_tar_extracts_regular_artifact_layout(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            tar_path = root / "remote-artifacts.tar.gz"
            write_tar(tar_path, lambda tar: add_file(tar, "runtime-artifacts/rl-training/run-1.json", b"{}"))

            extract_dir = root / "remote"
            runner.safe_extract_tar(tar_path, extract_dir)

            self.assertEqual((extract_dir / "runtime-artifacts" / "rl-training" / "run-1.json").read_text(encoding="utf-8"), "{}")
            self.assertEqual(
                runner.remote_training_report_path(root, "run-1"),
                root / "remote" / "runtime-artifacts" / "rl-training" / "run-1.json",
            )

    def test_safe_extract_tar_rejects_traversal_and_special_entries(self) -> None:
        cases = [
            ("../escape", lambda tar: add_file(tar, "../escape")),
            ("/tmp/escape", lambda tar: add_file(tar, "/tmp/escape")),
            ("symlink", lambda tar: add_special(tar, "link", tarfile.SYMTYPE, "/tmp/escape")),
            ("hardlink", lambda tar: add_special(tar, "hard", tarfile.LNKTYPE, "/tmp/escape")),
            ("fifo", lambda tar: add_special(tar, "fifo", tarfile.FIFOTYPE)),
        ]
        for name, callback in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                tar_path = root / "remote-artifacts.tar.gz"
                write_tar(tar_path, callback)

                with self.assertRaises(runner.BatchRunError):
                    runner.safe_extract_tar(tar_path, root / "remote")

    def test_scale_down_raises_after_recording_failed_modify_desired_capacity(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=Path(temp_dir))

            with mock.patch.object(
                runner.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(["tccli"], 1, "", "permission denied"),
            ):
                with self.assertRaisesRegex(runner.BatchRunError, "scale_down failed"):
                    controller.scale_down()

        self.assertEqual(controller.steps[-1].name, "scale_down")
        self.assertFalse(controller.steps[-1].ok)

    def test_controller_run_marks_completed_when_scale_down_fails_after_success(self) -> None:
        class FakeController(runner.Controller):
            def ensure_map_present(self) -> None:
                pass

            def ensure_dist_present(self) -> None:
                pass

            def run_billing_guard(self) -> None:
                pass

            def verify_security_group(self) -> None:
                pass

            def generate_experiment_card(self) -> None:
                pass

            def scale_up_and_wait(self) -> None:
                self.scaled_up = True

            def verify_worker_security(self) -> None:
                pass

            def bootstrap_worker(self) -> None:
                pass

            def transfer_repo_bundle(self) -> None:
                pass

            def transfer_secret_env(self) -> None:
                pass

            def run_remote_training(self) -> None:
                pass

            def collect_remote_artifacts(self) -> None:
                pass

            def verify_remote_training_report(self) -> None:
                pass

            def scale_down(self) -> None:
                raise runner.BatchRunError("scale down denied")

        with tempfile.TemporaryDirectory() as temp_dir:
            controller = FakeController(args=controller_args(), run_id="run-test", artifact_dir=Path(temp_dir))
            with mock.patch.object(runner, "validate_static_inputs", return_value=None):
                controller.run()

            summary = json.loads((Path(temp_dir) / "controller-summary.json").read_text(encoding="utf-8"))
        self.assertEqual(controller.final_status, "completed_scale_down_failed")
        self.assertEqual(summary["finalStatus"], "completed_scale_down_failed")
        self.assertIn("scale down denied", controller.result["scaleDownError"])

    def test_bootstrap_worker_uses_configured_worker_user(self) -> None:
        args = controller_args()
        args.worker_user = "custom-worker"
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            with mock.patch.object(controller, "ssh_cmd") as ssh_cmd:
                controller.bootstrap_worker()

        remote_command = ssh_cmd.call_args.args[1]
        command_tokens = shlex.split(remote_command)
        script = decode_remote_bash_lc(remote_command)
        self.assertIn("WORKER_USER=custom-worker", command_tokens)
        self.assertIn('sudo usermod -aG docker "$WORKER_USER" || true', script)
        self.assertIn('sudo chown -R "$WORKER_USER:$WORKER_USER"', script)
        self.assertNotIn("sudo usermod -aG docker screeps-batch", script)

    def test_preflight_step_details_are_flat(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_text(root / "maps" / "map-0b6758af.json", "{}\n")
            write_text(root / "prod" / "dist" / "main.js", "bundle\n")
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root / "artifacts")

            with mock.patch.object(runner, "REPO_ROOT", root):
                controller.ensure_map_present()
                controller.ensure_dist_present()

        self.assertEqual(controller.steps[0].detail["path"], str(root / "maps" / "map-0b6758af.json"))
        self.assertEqual(controller.steps[1].detail["path"], str(root / "prod" / "dist" / "main.js"))
        self.assertNotIn("detail", controller.steps[0].detail)
        self.assertNotIn("detail", controller.steps[1].detail)

    def test_latest_scale_out_failure_ignores_failures_before_run_start(self) -> None:
        class FakeController(runner.Controller):
            def tccli(self, name: str, *params: str, check: bool = True, timeout: int = 90) -> dict[str, object]:
                return {
                    "ActivitySet": [
                        {
                            "ActivityId": "old",
                            "ActivityType": "SCALE_OUT",
                            "StatusCode": "FAILED",
                            "StartTime": "2026-05-17T00:00:00Z",
                        },
                        {
                            "ActivityId": "new",
                            "ActivityType": "SCALE_OUT",
                            "StatusCode": "FAILED",
                            "StartTime": "2026-05-17T00:01:00Z",
                        },
                    ]
                }

        controller = FakeController(args=controller_args(), run_id="run-test", artifact_dir=Path("/tmp/run-test"))

        failure = controller.latest_scale_out_failure(after_epoch=runner.parse_tencent_activity_time("2026-05-17T00:00:30Z") or 0)

        self.assertIsNotNone(failure)
        self.assertEqual(failure.get("ActivityId"), "new")


if __name__ == "__main__":
    unittest.main()
