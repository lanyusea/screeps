#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
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
        controller_ip=CONTROLLER_IP,
        dataset_run_id="dataset-test",
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

    def test_worker_iptables_guard_requires_ssh_closure_when_default_policy_accepts(self) -> None:
        output = f"iptables=-P INPUT ACCEPT;-A INPUT -p tcp -s {CONTROLLER_IP} --dport 22 -j ACCEPT;\n"

        with self.assertRaisesRegex(runner.BatchRunError, "controller-only"):
            runner.validate_controller_only_worker_ssh(output, CONTROLLER_IP)

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
