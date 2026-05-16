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
        billing_guard="/bin/billing-guard",
        bootstrap_timeout_seconds=1,
        controller_ip=CONTROLLER_IP,
        dataset_run_id="dataset-test",
        host_port_start=24125,
        preflight_only=False,
        region="ap-singapore",
        remote_base="/opt/screeps-batch/jobs",
        repetitions=1,
        scale_down_timeout_seconds=1,
        scale_environments=None,
        scale_timeout_seconds=1,
        secret_env="/tmp/secret.env",
        security_group_id="sg-test",
        ssh_key="/tmp/id_ed25519",
        tccli="/bin/tccli",
        ticks=1,
        training_approach="bandit",
        training_timeout_seconds=1,
        transfer_timeout_seconds=1,
        variant=None,
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


def generated_experiment_card() -> dict[str, object]:
    return {
        "card_id": "rl-exp-dataset-test-000000000000",
        "dataset_run_id": "dataset-test",
        "code_commit": "0" * 40,
        "created_at": "2026-05-17T00:00:00Z",
        "status": "shadow",
        "training_approach": "bandit",
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "safety": {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "ood_rejection": True,
            "conservative_actions_only": True,
        },
        "reward_model": {
            "type": "lexicographic",
            "component_order": ["reliability", "territory", "resources", "kills"],
            "component_weights": {
                "alpha_reliability": 1000000000,
                "beta_territory": 1000000,
                "gamma_resources": 1000,
                "delta_kills": 1,
            },
            "scalar_weighted_sum_authorized": False,
        },
        "simulation": {
            "ticks": 50,
            "workers": 1,
            "repetitions": 1,
            "room": "E1S1",
            "shard": "shardX",
            "branch": "$activeWorld",
            "code_path": "prod/dist/main.js",
            "map_source_file": "maps/map-0b6758af.json",
            "simulator_out_dir": "runtime-artifacts/rl-simulator",
        },
        "strategy_variants": ["construction-priority.incumbent.v1"],
    }


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

    def test_verify_remote_training_report_rejects_any_unsafe_flag(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(
                json.dumps(
                    {
                        "reportId": "run-test",
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": True,
                        "artifactCount": 1,
                    }
                ),
                encoding="utf-8",
            )
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            with self.assertRaisesRegex(runner.BatchRunError, "officialMmoWritesAllowed"):
                controller.verify_remote_training_report()

    def test_verify_remote_training_report_records_safety_flags_in_summary(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(
                json.dumps(
                    {
                        "reportId": "run-test",
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                        "artifactCount": 1,
                    }
                ),
                encoding="utf-8",
            )
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)
            controller.verify_remote_training_report()
            controller.write_summary()

            summary = json.loads((root / "controller-summary.json").read_text(encoding="utf-8"))
            self.assertEqual(
                summary["safety"],
                {
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                    "billingGuardBeforeScale": True,
                    "scaleDownAttempted": False,
                    "sshControllerOnlyExpected": CONTROLLER_IP,
                    "secretsPrinted": False,
                },
            )

    def test_static_validation_accepts_bounded_multi_worker_scale_proof(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            args = controller_args()
            args.tccli = str(root / "tccli")
            args.billing_guard = str(root / "billing-guard.py")
            args.ssh_key = str(root / "id_ed25519")
            args.secret_env = str(root / ".env")
            args.workers = 5
            for path in (args.tccli, args.billing_guard, args.ssh_key, args.secret_env):
                write_text(Path(path))

            runner.validate_static_inputs(args, "run-test")

            args.scale_environments = 6
            with self.assertRaisesRegex(runner.BatchRunError, "workers must be at least scale environments"):
                runner.validate_static_inputs(args, "run-test")

            args.scale_environments = None
            args.workers = runner.MAX_SCALE_PROOF_WORKERS + 1
            with self.assertRaisesRegex(runner.BatchRunError, "workers must be between"):
                runner.validate_static_inputs(args, "run-test")

    def test_generate_experiment_card_writes_multi_environment_scale_proof_spec(self) -> None:
        args = controller_args()
        args.workers = 5
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)

            def fake_run_cp(name: str, cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                if name == "generate_experiment_card":
                    output = Path(cmd[cmd.index("--output") + 1])
                    output.write_text(json.dumps(generated_experiment_card()), encoding="utf-8")
                return subprocess.CompletedProcess(cmd, 0, "{}", "")

            with mock.patch.object(controller, "run_cp", side_effect=fake_run_cp):
                controller.generate_experiment_card()

            card = json.loads((root / "experiment_card.json").read_text(encoding="utf-8"))
            spec = json.loads((root / "scale_proof_spec.json").read_text(encoding="utf-8"))

        self.assertEqual(card["status"], "shadow")
        self.assertFalse(card["liveEffect"])
        self.assertFalse(card["officialMmoWrites"])
        self.assertFalse(card["officialMmoWritesAllowed"])
        self.assertEqual(card["simulation"]["workers"], 5)
        self.assertEqual(card["simulation"]["scale_environments"], 5)
        self.assertEqual(card["simulation"]["min_concurrent_environments"], 5)
        self.assertEqual(spec["scaleProof"]["mode"], "single_tencent_asg_worker_multi_environment")
        self.assertEqual(spec["scaleProof"]["successCriteria"]["minimumSuccessfulEnvironments"], 4)
        self.assertEqual(spec["asg"]["desiredCapacityDuringRun"], 1)
        self.assertEqual(spec["asg"]["cleanupDesiredCapacity"], 0)
        self.assertTrue(spec["safety"]["billingGuardBeforeScale"])
        self.assertFalse(spec["safety"]["officialMmoWritesAllowed"])
        self.assertEqual(controller.steps[-1].name, "write_scale_proof_spec")

    def test_verify_remote_training_report_requires_scale_proof_success_for_workers_five(self) -> None:
        args = controller_args()
        args.workers = 5
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(
                json.dumps(
                    {
                        "reportId": "run-test",
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                        "artifactCount": 5,
                        "scaleValidation": {
                            "ok": False,
                            "totalEnvironments": 5,
                            "successfulEnvironments": 3,
                            "minimumSuccessfulEnvironments": 4,
                        },
                    }
                ),
                encoding="utf-8",
            )
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)

            with self.assertRaisesRegex(runner.BatchRunError, "scale proof success count"):
                controller.verify_remote_training_report()

            data = json.loads(report.read_text(encoding="utf-8"))
            data["scaleValidation"]["ok"] = True
            data["scaleValidation"]["successfulEnvironments"] = 4
            report.write_text(json.dumps(data), encoding="utf-8")
            controller.verify_remote_training_report()

        self.assertEqual(controller.result["trainingReport"]["scaleValidation"]["successfulEnvironments"], 4)

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

    def test_scale_down_raises_after_recording_timeout_with_instances_present(self) -> None:
        args = controller_args()
        args.scale_down_timeout_seconds = 1
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))

            with (
                mock.patch.object(
                    runner.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess(["tccli"], 0, "{}", ""),
                ),
                mock.patch.object(
                    controller,
                    "describe_asg_group_summary",
                    return_value={
                        "DesiredCapacity": 0,
                        "InstanceCount": 1,
                        "InServiceInstanceCount": 1,
                        "InActivityStatus": "IN_ACTIVITY",
                    },
                ),
                mock.patch.object(controller, "describe_asg_instances", return_value=[{"InstanceId": "ins-test"}]),
                mock.patch.object(runner.time, "time", side_effect=[100.0, 100.0, 100.0, 101.1]),
                mock.patch.object(runner.time, "sleep", return_value=None),
            ):
                with self.assertRaisesRegex(runner.BatchRunError, "scale_down timeout"):
                    controller.scale_down()

        self.assertEqual(controller.steps[-1].name, "scale_down")
        self.assertFalse(controller.steps[-1].ok)
        self.assertEqual(controller.steps[-1].detail["desiredCapacity"], 0)
        self.assertEqual(controller.result["scaleDownLastSeen"]["asgInstances"], [{"InstanceId": "ins-test"}])

    def test_scale_down_records_success_after_asg_reaches_zero(self) -> None:
        args = controller_args()
        args.scale_down_timeout_seconds = 1
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))

            with (
                mock.patch.object(
                    runner.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess(["tccli"], 0, "{}", ""),
                ),
                mock.patch.object(
                    controller,
                    "describe_asg_group_summary",
                    return_value={
                        "DesiredCapacity": 0,
                        "InstanceCount": 0,
                        "InServiceInstanceCount": 0,
                        "InActivityStatus": "NOT_IN_ACTIVITY",
                    },
                ),
                mock.patch.object(controller, "describe_asg_instances", return_value=[]),
                mock.patch.object(runner.time, "time", side_effect=[100.0, 100.0, 100.0]),
            ):
                controller.scale_down()

        self.assertEqual(controller.steps[-1].name, "scale_down")
        self.assertTrue(controller.steps[-1].ok)

    def test_controller_run_marks_completed_scale_down_failed_when_cleanup_times_out(self) -> None:
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

        with tempfile.TemporaryDirectory() as temp_dir:
            controller = FakeController(args=controller_args(), run_id="run-test", artifact_dir=Path(temp_dir))
            with (
                mock.patch.object(runner, "validate_static_inputs", return_value=None),
                mock.patch.object(
                    runner.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess(["tccli"], 0, "{}", ""),
                ),
                mock.patch.object(
                    controller,
                    "describe_asg_group_summary",
                    return_value={
                        "DesiredCapacity": 0,
                        "InstanceCount": 1,
                        "InServiceInstanceCount": 1,
                        "InActivityStatus": "IN_ACTIVITY",
                    },
                ),
                mock.patch.object(controller, "describe_asg_instances", return_value=[{"InstanceId": "ins-test"}]),
                mock.patch.object(runner.time, "time", side_effect=[100.0, 100.0, 100.0, 101.1]),
                mock.patch.object(runner.time, "sleep", return_value=None),
            ):
                controller.run()

            summary = json.loads((Path(temp_dir) / "controller-summary.json").read_text(encoding="utf-8"))
        self.assertEqual(controller.final_status, "completed_scale_down_failed")
        self.assertEqual(summary["finalStatus"], "completed_scale_down_failed")
        self.assertIn("scale_down timeout", controller.result["scaleDownError"])
        self.assertEqual(summary["steps"][-1]["name"], "scale_down")
        self.assertFalse(summary["steps"][-1]["ok"])

    def test_controller_run_scales_down_after_multi_worker_training_failure(self) -> None:
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
                raise runner.BatchRunError("training failed")

            def scale_down(self) -> None:
                self.record_step("scale_down", 100.0, True, desiredCapacity=0)

        args = controller_args()
        args.workers = 5
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = FakeController(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            with mock.patch.object(runner, "validate_static_inputs", return_value=None):
                with self.assertRaisesRegex(runner.BatchRunError, "training failed"):
                    controller.run()
            summary = json.loads((Path(temp_dir) / "controller-summary.json").read_text(encoding="utf-8"))

        self.assertEqual(controller.final_status, "failed")
        self.assertEqual(summary["finalStatus"], "failed")
        self.assertTrue(summary["safety"]["scaleDownAttempted"])
        self.assertEqual(summary["steps"][-1]["name"], "scale_down")
        self.assertEqual(summary["steps"][-1]["detail"]["desiredCapacity"], 0)

    def test_main_exits_nonzero_when_controller_cleanup_failed(self) -> None:
        class FakeController:
            def __init__(self, args: argparse.Namespace, run_id: str, artifact_dir: Path) -> None:
                self.args = args
                self.run_id = run_id
                self.artifact_dir = artifact_dir
                self.final_status = "unknown"

            def run(self) -> None:
                self.final_status = "completed_scale_down_failed"

        stdout = io.StringIO()
        stderr = io.StringIO()
        with (
            tempfile.TemporaryDirectory() as temp_dir,
            mock.patch.object(runner, "Controller", FakeController),
            mock.patch.object(runner.sys, "stdout", stdout),
            mock.patch.object(runner.sys, "stderr", stderr),
        ):
            exit_code = runner.main(["run-single", "--run-id", "run-test", "--artifact-root", temp_dir])

        self.assertNotEqual(exit_code, 0)
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn('"ok": true', stderr.getvalue())
        payload = json.loads(stderr.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["status"], "completed_scale_down_failed")

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

        with tempfile.TemporaryDirectory() as temp_dir:
            controller = FakeController(args=controller_args(), run_id="run-test", artifact_dir=Path(temp_dir) / "run-test")

            failure = controller.latest_scale_out_failure(
                after_epoch=runner.parse_tencent_activity_time("2026-05-17T00:00:30Z") or 0
            )

            self.assertIsNotNone(failure)
            self.assertEqual(failure.get("ActivityId"), "new")


if __name__ == "__main__":
    unittest.main()
