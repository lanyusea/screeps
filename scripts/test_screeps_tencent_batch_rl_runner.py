#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import io
import json
import re
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

    def test_safe_policy_update_artifact_path_accepts_candidate_json(self) -> None:
        artifact_path = runner.safe_policy_update_artifact_path(
            "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        )

        self.assertEqual(
            artifact_path,
            Path("runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"),
        )

    def test_safe_policy_update_artifact_path_rejects_non_candidate_or_unsafe_paths(self) -> None:
        cases = (
            ("runtime-artifacts/rl-training/run-test.json", "outside rl-training policy candidate artifacts"),
            ("runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.txt", "JSON policy candidate"),
            ("/runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json", "unsafe"),
            ("runtime-artifacts/rl-training/policy-candidates/../run-test-next-policy.json", "unsafe"),
            ("runtime-artifacts\\rl-training\\policy-candidates\\run-test-next-policy.json", "unsafe"),
        )
        for raw, expected_error in cases:
            with self.subTest(raw=raw), self.assertRaisesRegex(runner.BatchRunError, expected_error):
                runner.safe_policy_update_artifact_path(raw)

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

    def test_verify_remote_training_report_rejects_unsafe_nested_policy_update_flags(self) -> None:
        unsafe_updates = [
            ("policyUpdate.liveEffect=true", {"iterations": 1, "liveEffect": True}),
            ("policyUpdate.liveEffect=\"true\"", {"iterations": 1, "liveEffect": "true"}),
            (
                "policyUpdate.nextCandidatePolicy.official_mmo_writes_allowed=true",
                {
                    "iterations": 1,
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                    "nextCandidatePolicy": {"official_mmo_writes_allowed": True},
                },
            ),
            (
                "policyUpdate.nextCandidatePolicy.official_mmo_writes_allowed=1",
                {
                    "iterations": 1,
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                    "nextCandidatePolicy": {"official_mmo_writes_allowed": 1},
                },
            ),
            (
                "policyUpdate.nextCandidatePolicy.liveEffect=null",
                {
                    "iterations": 1,
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                    "nextCandidatePolicy": {"liveEffect": None},
                },
            ),
        ]
        for expected_error, policy_update in unsafe_updates:
            with self.subTest(expected_error=expected_error), tempfile.TemporaryDirectory() as temp_dir:
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
                            "policyUpdate": policy_update,
                        }
                    ),
                    encoding="utf-8",
                )
                controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

                with self.assertRaisesRegex(runner.BatchRunError, re.escape(expected_error)):
                    controller.verify_remote_training_report()

    def test_verify_remote_training_report_rejects_positive_policy_update_without_artifact(self) -> None:
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
                        "policyUpdateIterations": 1,
                        "policyUpdateArtifactPath": "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json",
                        "policyUpdate": {
                            "iterations": 1,
                            "liveEffect": False,
                            "officialMmoWrites": False,
                            "officialMmoWritesAllowed": False,
                            "nextCandidatePolicy": {
                                "liveEffect": False,
                                "officialMmoWrites": False,
                                "officialMmoWritesAllowed": False,
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            with self.assertRaisesRegex(runner.BatchRunError, "policy update artifact was not collected"):
                controller.verify_remote_training_report()

    def test_verified_remote_policy_update_rejects_contradictory_duplicate_metadata(self) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        cases = (
            (
                {
                    "policyUpdateIterations": 5,
                    "policyUpdateArtifactPath": artifact_path,
                    "policyUpdate": {
                        "iterations": 1,
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                        "artifactPath": artifact_path,
                        "nextCandidatePolicy": {
                            "liveEffect": False,
                            "officialMmoWrites": False,
                            "officialMmoWritesAllowed": False,
                        },
                    },
                },
                "policyUpdate.iterations disagrees",
            ),
            (
                {
                    "policyUpdateIterations": 1,
                    "policyUpdateArtifactPath": artifact_path,
                    "policyUpdate": {
                        "iterations": 1,
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                        "artifactPath": "runtime-artifacts/rl-training/policy-candidates/other-next-policy.json",
                        "nextCandidatePolicy": {
                            "liveEffect": False,
                            "officialMmoWrites": False,
                            "officialMmoWritesAllowed": False,
                        },
                    },
                },
                "policyUpdate.artifactPath disagrees",
            ),
        )
        for data, expected_error in cases:
            with self.subTest(expected_error=expected_error), tempfile.TemporaryDirectory() as temp_dir:
                with self.assertRaisesRegex(runner.BatchRunError, expected_error):
                    runner.verified_remote_policy_update_fields(data, top_level_safety, Path(temp_dir))

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
                        "policyUpdateIterations": 1,
                        "policyUpdateArtifactPath": "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json",
                        "policyUpdate": {
                            "iterations": 1,
                            "liveEffect": False,
                            "officialMmoWrites": False,
                            "officialMmoWritesAllowed": False,
                            "nextCandidatePolicy": {
                                "liveEffect": False,
                                "officialMmoWrites": False,
                                "officialMmoWritesAllowed": False,
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )
            write_text(root / "remote" / "runtime-artifacts" / "rl-training" / "policy-candidates" / "run-test-next-policy.json", "{}\n")
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
            self.assertEqual(summary["outputs"]["trainingReport"]["policyUpdateIterations"], 1)
            self.assertEqual(
                summary["outputs"]["trainingReport"]["policyUpdateArtifactPath"],
                "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json",
            )
            self.assertFalse(summary["outputs"]["trainingReport"]["policyUpdate"]["liveEffect"])

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

    def test_generate_policy_gradient_experiment_card_floors_tencent_ticks_to_long_horizon(self) -> None:
        args = controller_args()
        args.training_approach = "policy_gradient"
        args.ticks = 200
        args.workers = 5
        args.repetitions = 5
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)

            def fake_run_cp(name: str, cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                if name == "generate_experiment_card":
                    output = Path(cmd[cmd.index("--output") + 1])
                    payload = generated_experiment_card()
                    payload["training_approach"] = "policy_gradient"
                    payload["simulation"]["ticks"] = 100
                    payload["simulation"]["workers"] = 1
                    payload["simulation"]["repetitions"] = 1
                    output.write_text(json.dumps(payload), encoding="utf-8")
                return subprocess.CompletedProcess(cmd, 0, "{}", "")

            with mock.patch.object(controller, "run_cp", side_effect=fake_run_cp):
                controller.generate_experiment_card()

            card = json.loads((root / "experiment_card.json").read_text(encoding="utf-8"))
            spec = json.loads((root / "scale_proof_spec.json").read_text(encoding="utf-8"))

        self.assertEqual(card["training_approach"], "policy_gradient")
        self.assertEqual(card["simulation"]["ticks"], 500)
        self.assertEqual(card["simulation"]["workers"], 5)
        self.assertEqual(card["simulation"]["repetitions"], 5)
        self.assertFalse(card["officialMmoWrites"])
        self.assertFalse(card["officialMmoWritesAllowed"])
        self.assertEqual(spec["scaleProof"]["remoteRunnerContract"]["cardSimulationFields"]["ticks"], 500)

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
            data["scaleValidation"]["minimumSuccessfulEnvironments"] = 1
            report.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaisesRegex(runner.BatchRunError, "scale proof success count"):
                controller.verify_remote_training_report()

            data["scaleValidation"]["ok"] = True
            data["scaleValidation"]["successfulEnvironments"] = 4
            report.write_text(json.dumps(data), encoding="utf-8")
            controller.verify_remote_training_report()

        self.assertEqual(controller.result["trainingReport"]["scaleValidation"]["successfulEnvironments"], 4)

    def test_verify_remote_training_report_accepts_repeated_scale_proof_totals(self) -> None:
        args = controller_args()
        args.workers = 5
        args.repetitions = 5
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            data = {
                "reportId": "run-test",
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
                "artifactCount": 25,
                "scaleValidation": {
                    "ok": True,
                    "targetEnvironments": 5,
                    "minimumSuccessfulEnvironments": 4,
                    "totalEnvironments": 25,
                    "successfulEnvironments": 24,
                    "failedEnvironments": 1,
                    "repetitions": 5,
                },
            }
            report.write_text(json.dumps(data), encoding="utf-8")
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)

            controller.verify_remote_training_report()

            data["scaleValidation"]["totalEnvironments"] = 24
            report.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaisesRegex(runner.BatchRunError, "scale proof environment count"):
                controller.verify_remote_training_report()

        self.assertEqual(controller.result["trainingReport"]["scaleValidation"]["successfulEnvironments"], 24)

    def test_scale_proof_result_rejects_malformed_remote_counts(self) -> None:
        valid = {
            "ok": True,
            "totalEnvironments": 5,
            "successfulEnvironments": 4,
            "minimumSuccessfulEnvironments": 4,
        }
        runner.validate_scale_proof_result(valid, 5)

        cases = [
            (
                "inflated-total",
                {"totalEnvironments": 9, "successfulEnvironments": 9},
                "scale proof environment count",
            ),
            (
                "successes-above-total",
                {"successfulEnvironments": 6},
                "scale proof success count",
            ),
            (
                "minimum-above-total",
                {"minimumSuccessfulEnvironments": 6},
                "scale proof minimum success count",
            ),
            (
                "minimum-below-zero",
                {"minimumSuccessfulEnvironments": -1},
                "scale proof minimum success count",
            ),
        ]
        for name, updates, pattern in cases:
            with self.subTest(name=name):
                malformed = {**valid, **updates}
                with self.assertRaisesRegex(runner.BatchRunError, pattern):
                    runner.validate_scale_proof_result(malformed, 5)

    def test_scale_up_clears_known_host_once_before_first_ssh_probe(self) -> None:
        args = controller_args()
        args.scale_timeout_seconds = 5
        events: list[tuple[str, object]] = []

        class FakeController(runner.Controller):
            def tccli(self, name: str, *params: str, check: bool = True, timeout: int = 90) -> dict[str, object]:
                return {}

            def describe_asg_instances(self) -> list[dict[str, object]]:
                return [{"InstanceId": "ins-test"}]

            def describe_cvm_instances(self, instance_ids: list[str]) -> list[dict[str, object]]:
                return [
                    {
                        "InstanceId": "ins-test",
                        "InstanceState": "RUNNING",
                        "PublicIpAddresses": ["203.0.113.10"],
                        "PrivateIpAddresses": ["10.0.0.10"],
                        "InstanceType": "S5.SMALL1",
                    }
                ]

            def latest_scale_out_failure(self, *, after_epoch: float) -> dict[str, object] | None:
                return None

            def wait_for_ssh(self) -> bool:
                events.append(("wait_for_ssh", {"public_ip": self.public_ip, "steps": [step.name for step in self.steps]}))
                return len([event for event in events if event[0] == "wait_for_ssh"]) >= 2

        with tempfile.TemporaryDirectory() as temp_dir:
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            controller = FakeController(args=args, run_id="run-test", artifact_dir=Path(temp_dir))

            def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                events.append(("clear_known_host", {"cmd": cmd, "public_ip": controller.public_ip}))
                return subprocess.CompletedProcess(cmd, 0, "removed\n", "")

            with (
                mock.patch.object(runner.subprocess, "run", side_effect=fake_run),
                mock.patch.object(runner.time, "sleep", return_value=None),
            ):
                controller.scale_up_and_wait()

        self.assertEqual([event[0] for event in events], ["clear_known_host", "wait_for_ssh", "wait_for_ssh"])
        clear_event = events[0][1]
        self.assertIsInstance(clear_event, dict)
        self.assertEqual(clear_event["public_ip"], "203.0.113.10")
        self.assertEqual(clear_event["cmd"], ["ssh-keygen", "-R", "203.0.113.10", "-f", args.known_hosts_path])
        first_probe_event = events[1][1]
        self.assertIsInstance(first_probe_event, dict)
        self.assertEqual(first_probe_event["public_ip"], "203.0.113.10")
        self.assertIn("clear_worker_known_host", first_probe_event["steps"])
        self.assertEqual([step.name for step in controller.steps].count("clear_worker_known_host"), 1)

    def test_scale_up_known_host_cleanup_failure_does_not_raise(self) -> None:
        args = controller_args()

        class FakeController(runner.Controller):
            def tccli(self, name: str, *params: str, check: bool = True, timeout: int = 90) -> dict[str, object]:
                return {}

            def describe_asg_instances(self) -> list[dict[str, object]]:
                return [{"InstanceId": "ins-test"}]

            def describe_cvm_instances(self, instance_ids: list[str]) -> list[dict[str, object]]:
                return [
                    {
                        "InstanceId": "ins-test",
                        "InstanceState": "RUNNING",
                        "PublicIpAddresses": ["203.0.113.10"],
                        "PrivateIpAddresses": [],
                    }
                ]

            def latest_scale_out_failure(self, *, after_epoch: float) -> dict[str, object] | None:
                return None

            def wait_for_ssh(self) -> bool:
                return True

        with tempfile.TemporaryDirectory() as temp_dir:
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            controller = FakeController(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            with mock.patch.object(
                runner.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(["ssh-keygen"], 255, "", "host not found\n"),
            ):
                controller.scale_up_and_wait()

        clear_steps = [step for step in controller.steps if step.name == "clear_worker_known_host"]
        self.assertEqual(len(clear_steps), 1)
        self.assertFalse(clear_steps[0].ok)
        self.assertEqual(controller.result["worker"]["publicIp"], "203.0.113.10")

    def test_scale_up_known_host_cleanup_timeout_does_not_raise_or_mark_cleaned(self) -> None:
        args = controller_args()

        class FakeController(runner.Controller):
            def tccli(self, name: str, *params: str, check: bool = True, timeout: int = 90) -> dict[str, object]:
                return {}

            def describe_asg_instances(self) -> list[dict[str, object]]:
                return [{"InstanceId": "ins-test"}]

            def describe_cvm_instances(self, instance_ids: list[str]) -> list[dict[str, object]]:
                return [
                    {
                        "InstanceId": "ins-test",
                        "InstanceState": "RUNNING",
                        "PublicIpAddresses": ["203.0.113.10"],
                        "PrivateIpAddresses": [],
                    }
                ]

            def latest_scale_out_failure(self, *, after_epoch: float) -> dict[str, object] | None:
                return None

            def wait_for_ssh(self) -> bool:
                return True

        with tempfile.TemporaryDirectory() as temp_dir:
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            controller = FakeController(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            with mock.patch.object(
                runner.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired(["ssh-keygen"], 30, output="", stderr="timed out\n"),
            ):
                controller.scale_up_and_wait()

        clear_steps = [step for step in controller.steps if step.name == "clear_worker_known_host"]
        self.assertEqual(len(clear_steps), 1)
        self.assertFalse(clear_steps[0].ok)
        self.assertEqual(clear_steps[0].returncode, 124)
        self.assertIn("TimeoutExpired", clear_steps[0].stderr_tail or "")
        self.assertNotIn("203.0.113.10", controller.known_hosts_cleaned_public_ips)
        self.assertEqual(controller.result["worker"]["publicIp"], "203.0.113.10")

    def test_scale_up_retries_failed_known_host_cleanup_for_same_ip(self) -> None:
        args = controller_args()
        args.scale_timeout_seconds = 5
        events: list[tuple[str, object]] = []

        class FakeController(runner.Controller):
            def tccli(self, name: str, *params: str, check: bool = True, timeout: int = 90) -> dict[str, object]:
                return {}

            def describe_asg_instances(self) -> list[dict[str, object]]:
                return [{"InstanceId": "ins-test"}]

            def describe_cvm_instances(self, instance_ids: list[str]) -> list[dict[str, object]]:
                return [
                    {
                        "InstanceId": "ins-test",
                        "InstanceState": "RUNNING",
                        "PublicIpAddresses": ["203.0.113.10"],
                        "PrivateIpAddresses": ["10.0.0.10"],
                        "InstanceType": "S5.SMALL1",
                    }
                ]

            def latest_scale_out_failure(self, *, after_epoch: float) -> dict[str, object] | None:
                return None

            def wait_for_ssh(self) -> bool:
                events.append(("wait_for_ssh", {"public_ip": self.public_ip}))
                return len([event for event in events if event[0] == "wait_for_ssh"]) >= 2

        with tempfile.TemporaryDirectory() as temp_dir:
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            controller = FakeController(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            cleanup_results = [
                subprocess.CompletedProcess(["ssh-keygen"], 255, "", "permission denied\n"),
                subprocess.CompletedProcess(["ssh-keygen"], 0, "removed\n", ""),
            ]

            def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                events.append(("clear_known_host", {"cmd": cmd, "public_ip": controller.public_ip}))
                result = cleanup_results.pop(0)
                return subprocess.CompletedProcess(cmd, result.returncode, result.stdout, result.stderr)

            with (
                mock.patch.object(runner.subprocess, "run", side_effect=fake_run),
                mock.patch.object(runner.time, "sleep", return_value=None),
            ):
                controller.scale_up_and_wait()

        self.assertEqual(
            [event[0] for event in events],
            ["clear_known_host", "wait_for_ssh", "clear_known_host", "wait_for_ssh"],
        )
        cleanup_events = [event[1] for event in events if event[0] == "clear_known_host"]
        self.assertEqual(len(cleanup_events), 2)
        for cleanup_event in cleanup_events:
            self.assertIsInstance(cleanup_event, dict)
            self.assertEqual(cleanup_event["public_ip"], "203.0.113.10")
            self.assertEqual(cleanup_event["cmd"], ["ssh-keygen", "-R", "203.0.113.10", "-f", args.known_hosts_path])
        clear_steps = [step for step in controller.steps if step.name == "clear_worker_known_host"]
        self.assertEqual([step.ok for step in clear_steps], [False, True])
        self.assertIn("203.0.113.10", controller.known_hosts_cleaned_public_ips)
        self.assertEqual(controller.result["worker"]["publicIp"], "203.0.113.10")

    def test_clear_known_host_skips_when_public_ip_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=Path(temp_dir))
            with mock.patch.object(runner.subprocess, "run") as run:
                controller.clear_worker_known_host()

        run.assert_not_called()
        self.assertFalse([step for step in controller.steps if step.name == "clear_worker_known_host"])

    def test_ssh_and_scp_commands_keep_accept_new_host_key_option(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"
            cleanup_commands: list[list[str]] = []
            commands: list[list[str]] = []

            def capture_subprocess_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                cleanup_commands.append(cmd)
                return subprocess.CompletedProcess(cmd, 0, "", "")

            def capture_run_cp(
                name: str,
                cmd: list[str],
                *,
                check: bool = True,
                timeout: int | None = None,
                cwd: Path | None = None,
                input_text: str | None = None,
                env: dict[str, str] | None = None,
            ) -> subprocess.CompletedProcess[str]:
                commands.append(cmd)
                return subprocess.CompletedProcess(cmd, 0, "", "")

            with (
                mock.patch.object(runner.subprocess, "run", side_effect=capture_subprocess_run),
                mock.patch.object(controller, "run_cp", side_effect=capture_run_cp),
            ):
                controller.clear_worker_known_host()
                controller.ssh_cmd("ssh_probe", "true")
                controller.scp_to_worker("upload", Path(temp_dir) / "local.txt", "/remote/local.txt")
                controller.scp_from_worker("download", "/remote/out.txt", Path(temp_dir) / "out" / "out.txt")

        self.assertEqual(cleanup_commands, [["ssh-keygen", "-R", "203.0.113.10", "-f", args.known_hosts_path]])
        for cmd in commands:
            with self.subTest(command=cmd[0]):
                self.assertIn("BatchMode=yes", cmd)
                self.assertIn("StrictHostKeyChecking=accept-new", cmd)
                self.assertIn(f"UserKnownHostsFile={args.known_hosts_path}", cmd)

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
