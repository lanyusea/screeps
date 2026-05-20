#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import io
import json
import os
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
import screeps_rl_experiment_card as card_helper


CONTROLLER_IP = "43.128.104.34/32"
READY_RUNTIME_SCORECARD_PATH = (
    "runtime-artifacts/rl-training/candidate-scorecards/run-test/rl-scorecard-run-test.json"
)


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
        scenario_id=runner.DEFAULT_SCENARIO_ID,
        require_multi_tier_scenario=False,
        known_hosts_path="/tmp/known_hosts",
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


def write_ready_runtime_scorecard_artifact(root: Path) -> None:
    write_text(root / "remote" / READY_RUNTIME_SCORECARD_PATH, "{}\n")


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
        "scenario": {
            "type": "screeps-rl-training-scenario",
            "scenario_id": runner.DEFAULT_SCENARIO_ID,
            "scenario_tier": "single_room_smoke",
            "label": "E1S1 single-room no-hostile smoke scenario",
            "capabilities": {
                "multi_room_capable": False,
                "adjacent_room_territory_signal": False,
                "hostile_combat_signal": False,
                "multi_tier_policy_comparison": False,
            },
            "suitability": {
                "multi_tier_policy_comparison": False,
                "territory_combat_differentiation": False,
                "classification": "not_suitable_for_territory_combat_differentiation",
                "reasons": ["single-room", "no-hostile"],
            },
            "evidence": {
                "anchor_room": "E1S1",
                "room_count": 1,
                "hostile_fixture": "none",
                "map_source_file": "maps/map-0b6758af.json",
            },
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
                "ood_rejection": True,
                "conservative_actions_only": True,
            },
        },
        "strategy_variants": ["construction-priority.incumbent.v1"],
    }


def training_report_with_ready_runtime_scorecard() -> dict[str, object]:
    return {
        "reportId": "run-test",
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "artifactCount": 1,
        "runtimeParameterInjection": {
            "status": "injected",
            "runtimeParameterInjection": True,
            "policyUpdateEligible": True,
            "candidateParameterScope": "runtime_injected",
            "injectedVariantCount": 1,
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
        "scorecardId": "rl-scorecard-run-test",
        "scorecardArtifactPath": READY_RUNTIME_SCORECARD_PATH,
        "candidateScorecard": {
            "status": "ready",
            "scorecardId": "rl-scorecard-run-test",
            "runtimeParameterInjection": True,
            "injectedVariantCount": 1,
            "validationScaleComputeBlocked": False,
            "scorecardUsable": True,
        },
    }


def write_tencent_guard_summary(
    artifact_root: Path,
    run_id: str,
    *,
    scenario_id: str = runner.DEFAULT_SCENARIO_ID,
    ticks: int = 500,
    final_status: str = "completed",
    territory_kills: tuple[tuple[float, float], ...] = ((2, 0), (2, 0)),
    room: str = "E1S1",
    map_source_file: str = "maps/map-0b6758af.json",
) -> Path:
    run_dir = artifact_root / run_id
    report_path = runner.remote_training_report_path(run_dir, run_id)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    card = generated_experiment_card()
    scenario = card["scenario"]
    assert isinstance(scenario, dict)
    if scenario_id == runner.MULTI_TIER_SCENARIO_ID:
        scenario = dict(scenario)
        scenario["scenario_id"] = runner.MULTI_TIER_SCENARIO_ID
        scenario["capabilities"] = {
            "multi_room_capable": True,
            "adjacent_room_territory_signal": True,
            "hostile_combat_signal": True,
            "multi_tier_policy_comparison": True,
        }
        scenario["suitability"] = {
            "multi_tier_policy_comparison": True,
            "territory_combat_differentiation": True,
            "classification": "suitable_for_multi_tier_policy_comparison",
            "reasons": [],
        }
    ranking = [
        {
            "variantId": f"variant-{index}",
            "rewardTuple": [1, territory, 0, kills],
        }
        for index, (territory, kills) in enumerate(territory_kills)
    ]
    variant_results = [
        {
            "variantId": item["variantId"],
            "reward": {"tuple": item["rewardTuple"]},
        }
        for item in ranking
    ]
    report = {
        "type": "screeps-rl-training-report",
        "reportId": run_id,
        "liveEffect": False,
        "officialMmoWrites": False,
        "officialMmoWritesAllowed": False,
        "artifactCount": len(variant_results),
        "rewardModel": {"componentOrder": ["reliability", "territory", "resources", "kills"]},
        "scenario": scenario,
        "simulation": {
            "ticks": ticks,
            "room": room,
            "mapSourceFile": map_source_file,
        },
        "source": {
            "initialConditions": {
                "ticks": ticks,
                "room": room,
                "mapSourceFile": map_source_file,
            }
        },
        "variantResults": variant_results,
        "ranking": ranking,
        "kpiSummary": {
            "territory": {"score": ranking[0]["rewardTuple"][1]},
            "kills": {"score": ranking[0]["rewardTuple"][3]},
        },
    }
    report_path.write_text(json.dumps(report), encoding="utf-8")
    summary = {
        "type": "screeps-tencent-batch-rl-run",
        "schemaVersion": 1,
        "runId": run_id,
        "finishedAt": "2026-05-18T00:00:00Z",
        "finalStatus": final_status,
        "inputs": {
            "ticks": ticks,
            "scenarioId": scenario_id,
            "trainingApproach": "policy_gradient",
        },
        "outputs": {
            "trainingReport": {
                "path": str(report_path),
                "reportId": run_id,
                "ranking": ranking,
                "simulation": report["simulation"],
            }
        },
    }
    summary_path = run_dir / "controller-summary.json"
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    return summary_path


def strip_tencent_guard_location_evidence(summary_path: Path) -> None:
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    training_report = summary["outputs"]["trainingReport"]
    report_path = Path(training_report["path"])
    report = json.loads(report_path.read_text(encoding="utf-8"))
    for container in (
        report.get("simulation"),
        runner.path_value(report, "source", "initialConditions"),
        training_report.get("simulation"),
    ):
        if isinstance(container, dict):
            for key in ("room", "mapSourceFile", "map_source_file"):
                container.pop(key, None)
    for scenario in (
        report.get("scenario"),
        runner.path_value(report, "experimentCard", "scenario"),
    ):
        evidence = runner.path_value(scenario, "evidence")
        if isinstance(evidence, dict):
            for key in ("anchor_room", "anchorRoom", "room", "map_source_file", "mapSourceFile"):
                evidence.pop(key, None)
    report_path.write_text(json.dumps(report), encoding="utf-8")
    summary_path.write_text(json.dumps(summary), encoding="utf-8")


class TencentBatchRlRunnerTest(unittest.TestCase):
    def run_stubbed_preflight(
        self,
        args: argparse.Namespace,
        artifact_dir: Path,
    ) -> tuple[list[str], runner.Controller, dict[str, object], dict[str, object]]:
        events: list[str] = []

        class FakeController(runner.Controller):
            def ensure_map_present(self) -> None:
                events.append("map")

            def ensure_dist_present(self) -> None:
                events.append("dist")

            def run_billing_guard(self) -> None:
                events.append("billing")

            def verify_security_group(self) -> None:
                events.append("security_group")

            def generate_experiment_card(self) -> None:
                events.append("experiment_card")

            def scale_up_and_wait(self) -> None:
                events.append("scale_up")

        controller = FakeController(args=args, run_id=args.run_id, artifact_dir=artifact_dir)
        with mock.patch.object(runner, "validate_static_inputs", return_value=None):
            controller.run()
        guard = json.loads((artifact_dir / "launch_guard.json").read_text(encoding="utf-8"))
        summary = json.loads((artifact_dir / "controller-summary.json").read_text(encoding="utf-8"))
        return events, controller, guard, summary

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

    def test_verified_remote_policy_update_accepts_empty_zero_iteration_update(self) -> None:
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        cases = (
            {},
            {"policyUpdateIterations": 0},
            {"policyUpdate": None},
            {"policyUpdate": {}},
            {"policyUpdate": []},
            {"policyUpdateIterations": 0, "policyUpdate": None},
            {"policyUpdateIterations": 0, "policyUpdate": {}},
            {"policyUpdateIterations": 0, "policyUpdate": []},
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            for data in cases:
                with self.subTest(data=data):
                    self.assertEqual(
                        runner.verified_remote_policy_update_fields(data, top_level_safety, Path(temp_dir)),
                        {
                            "policyUpdateIterations": 0,
                            "policyUpdateArtifactPath": None,
                            "policyUpdate": None,
                        },
                    )

    def test_verified_remote_policy_update_accepts_structured_zero_iteration_noop_update(self) -> None:
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        policy_update = {
            "type": "screeps-rl-policy-update",
            "schemaVersion": 1,
            "iterations": 0,
            "algorithm": "rank_weighted_finite_difference_v1",
            "targetFamily": "test-family",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
                "officialMmoControl": False,
            },
            "skippedReason": "no_nonzero_reward_advantage",
            "candidateCount": 2,
            "anchor": {
                "candidatePolicyId": "candidate-a",
                "strategyVariantId": "variant-a",
                "rolloutStatus": "incumbent",
                "rewardTuple": [1, 0, 0, 0],
                "sampleCount": 1,
                "parameters": {"territorySignalWeight": 1.0},
            },
            "candidateRewards": [
                {
                    "candidatePolicyId": "candidate-a",
                    "strategyVariantId": "variant-a",
                    "rolloutStatus": "incumbent",
                    "rewardTuple": [1, 0, 0, 0],
                    "sampleCount": 1,
                    "parameters": {"territorySignalWeight": 1.0},
                },
                {
                    "candidatePolicyId": "candidate-b",
                    "strategyVariantId": "variant-b",
                    "rolloutStatus": "shadow",
                    "rewardTuple": [1, 0, 0, 0],
                    "sampleCount": 1,
                    "parameters": {"territorySignalWeight": 2.0},
                },
            ],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            self.assertEqual(
                runner.verified_remote_policy_update_fields(
                    {"policyUpdateIterations": 0, "policyUpdate": policy_update},
                    top_level_safety,
                    Path(temp_dir),
                ),
                {
                    "policyUpdateIterations": 0,
                    "policyUpdateArtifactPath": None,
                    "policyUpdate": policy_update,
                },
            )

    def test_verified_remote_policy_update_accepts_metadata_only_zero_iteration_noop_update(self) -> None:
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        policy_update = {
            "type": "screeps-rl-policy-update",
            "schemaVersion": 1,
            "iterations": 0,
            "algorithm": "true_gradient_reinforce_v1",
            "targetFamily": "multi-tier-territory-combat",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            },
            "skippedReason": "candidate_parameters_metadata_only",
            "candidateCount": 0,
            "metadataCandidateCount": 5,
            "parameterEvidence": {
                "candidateParameterScope": "metadata_only",
                "runtimeParameterInjection": False,
                "policyUpdateEligible": False,
                "reason": "candidate vectors were metadata only",
            },
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            self.assertEqual(
                runner.verified_remote_policy_update_fields(
                    {"policyUpdateIterations": 0, "policyUpdate": policy_update},
                    top_level_safety,
                    Path(temp_dir),
                ),
                {
                    "policyUpdateIterations": 0,
                    "policyUpdateArtifactPath": None,
                    "policyUpdate": policy_update,
                },
            )

    def test_verified_remote_policy_update_rejects_non_empty_zero_iteration_update(self) -> None:
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        cases = (
            (
                {"policyUpdate": {"nextCandidatePolicy": {}}},
                "policyUpdate is present without positive policyUpdateIterations",
            ),
            (
                {"policyUpdateIterations": 0, "policyUpdate": {"nextCandidatePolicy": {}}},
                "policyUpdate is present without positive policyUpdateIterations",
            ),
            (
                {"policyUpdateIterations": 0, "policyUpdate": {"iterations": 0}},
                "policyUpdate is present without positive policyUpdateIterations",
            ),
            (
                {"policyUpdateIterations": 0, "policyUpdate": [{"iterations": 0}]},
                "policyUpdate is present without positive policyUpdateIterations",
            ),
            (
                {
                    "policyUpdateIterations": 0,
                    "policyUpdate": {
                        "iterations": 0,
                        "skippedReason": "no_nonzero_reward_advantage",
                        "nextCandidatePolicy": {},
                    },
                },
                "zero-iteration no-op contains update data",
            ),
            (
                {
                    "policyUpdateIterations": 0,
                    "policyUpdate": {
                        "iterations": 0,
                        "skippedReason": "bounded_update_no_parameter_change",
                        "updatedParameters": {"territorySignalWeight": 2},
                    },
                },
                "zero-iteration no-op contains update data",
            ),
            (
                {
                    "policyUpdateIterations": 0,
                    "policyUpdate": {
                        "iterations": 0,
                        "skippedReason": "no_nonzero_reward_advantage",
                        "metadataCandidateCount": 5,
                        "parameterEvidence": {
                            "candidateParameterScope": "metadata_only",
                            "runtimeParameterInjection": False,
                            "policyUpdateEligible": False,
                        },
                        "unexpectedField": True,
                    },
                },
                "zero-iteration no-op has unexpected fields",
            ),
            (
                {"policyUpdate": {"iterations": -1}},
                "policyUpdate.iterations invalid",
            ),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            for data, expected_error in cases:
                with self.subTest(data=data), self.assertRaisesRegex(runner.BatchRunError, expected_error):
                    runner.verified_remote_policy_update_fields(data, top_level_safety, Path(temp_dir))

    def test_verified_remote_policy_update_rejects_artifact_path_without_positive_iterations(self) -> None:
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        cases = (
            {"policyUpdateArtifactPath": artifact_path},
            {"policyUpdateIterations": 0, "policyUpdateArtifactPath": artifact_path},
            {"policyUpdateIterations": 0, "policyUpdate": {}, "policyUpdateArtifactPath": artifact_path},
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            for data in cases:
                with self.subTest(data=data), self.assertRaisesRegex(
                    runner.BatchRunError,
                    "policyUpdateArtifactPath is present without positive policyUpdateIterations",
                ):
                    runner.verified_remote_policy_update_fields(data, top_level_safety, Path(temp_dir))

    def test_verified_remote_policy_update_accepts_positive_update_with_collected_artifact(self) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }
        policy_update = {
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
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_text(root / "remote" / artifact_path, "{}\n")

            self.assertEqual(
                runner.verified_remote_policy_update_fields(
                    {
                        "policyUpdateIterations": 1,
                        "policyUpdateArtifactPath": artifact_path,
                        "policyUpdate": policy_update,
                    },
                    top_level_safety,
                    root,
                ),
                {
                    "policyUpdateIterations": 1,
                    "policyUpdateArtifactPath": artifact_path,
                    "policyUpdate": policy_update,
                },
            )

    def test_verified_remote_policy_update_rejects_positive_update_without_explicit_policy_update_safety_flags(self) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }

        def valid_policy_update() -> dict[str, object]:
            return {
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
            }

        missing_live_effect = valid_policy_update()
        missing_live_effect.pop("liveEffect")
        non_false_writes_allowed = valid_policy_update()
        non_false_writes_allowed["officialMmoWritesAllowed"] = None
        cases = (
            (missing_live_effect, "policyUpdate.liveEffect"),
            (non_false_writes_allowed, "policyUpdate.officialMmoWritesAllowed"),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_text(root / "remote" / artifact_path, "{}\n")
            for policy_update, expected_error in cases:
                with self.subTest(expected_error=expected_error), self.assertRaisesRegex(
                    runner.BatchRunError,
                    re.escape(expected_error),
                ):
                    runner.verified_remote_policy_update_fields(
                        {
                            "policyUpdateIterations": 1,
                            "policyUpdateArtifactPath": artifact_path,
                            "policyUpdate": policy_update,
                        },
                        top_level_safety,
                        root,
                    )

    def test_verified_remote_policy_update_rejects_positive_update_without_explicit_next_candidate_safety_flags(self) -> None:
        artifact_path = "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json"
        top_level_safety = {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        }

        def valid_policy_update() -> dict[str, object]:
            return {
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
            }

        missing_writes = valid_policy_update()
        next_candidate = missing_writes["nextCandidatePolicy"]
        assert isinstance(next_candidate, dict)
        next_candidate.pop("officialMmoWrites")
        non_false_live_effect = valid_policy_update()
        next_candidate = non_false_live_effect["nextCandidatePolicy"]
        assert isinstance(next_candidate, dict)
        next_candidate["liveEffect"] = None
        cases = (
            (missing_writes, "policyUpdate.nextCandidatePolicy.officialMmoWrites"),
            (non_false_live_effect, "policyUpdate.nextCandidatePolicy.liveEffect"),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_text(root / "remote" / artifact_path, "{}\n")
            for policy_update, expected_error in cases:
                with self.subTest(expected_error=expected_error), self.assertRaisesRegex(
                    runner.BatchRunError,
                    re.escape(expected_error),
                ):
                    runner.verified_remote_policy_update_fields(
                        {
                            "policyUpdateIterations": 1,
                            "policyUpdateArtifactPath": artifact_path,
                            "policyUpdate": policy_update,
                        },
                        top_level_safety,
                        root,
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
                        "generatedAt": "2026-05-19T12:38:23Z",
                        "experimentCard": {"codeCommit": "a" * 40},
                        "activationProof": {
                            "status": "passed",
                            "ok": True,
                            "audit": {
                                "comparisonKey": "activation-key",
                                "codeCommit": "a" * 40,
                            },
                        },
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                        "artifactCount": 1,
                        "runtimeParameterInjection": {
                            "type": "screeps-rl-runtime-parameter-injection",
                            "status": "injected",
                            "runtimeParameterInjection": True,
                            "policyUpdateEligible": True,
                            "candidateParameterScope": "runtime_injected",
                            "injectedVariantCount": 1,
                            "liveEffect": False,
                            "officialMmoWrites": False,
                            "officialMmoWritesAllowed": False,
                        },
                        "scorecardId": "rl-scorecard-run-test",
                        "scorecardArtifactPath": READY_RUNTIME_SCORECARD_PATH,
                        "candidateScorecard": {
                            "status": "ready",
                            "classification": "runtime_injected_candidate_scorecard_ready",
                            "scorecardId": "rl-scorecard-run-test",
                            "runtimeParameterInjection": True,
                            "injectedVariantCount": 1,
                            "validationScaleComputeBlocked": False,
                            "scorecardUsable": True,
                        },
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
            write_ready_runtime_scorecard_artifact(root)
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
            self.assertEqual(summary["outputs"]["trainingReport"]["generatedAt"], "2026-05-19T12:38:23Z")
            self.assertEqual(summary["outputs"]["trainingReport"]["experimentCard"]["codeCommit"], "a" * 40)
            self.assertEqual(
                summary["outputs"]["trainingReport"]["activationProof"]["audit"]["comparisonKey"],
                "activation-key",
            )
            self.assertTrue(
                summary["outputs"]["trainingReport"]["runtimeParameterInjection"]["runtimeParameterInjection"]
            )
            self.assertEqual(summary["outputs"]["trainingReport"]["runtimeParameterInjection"]["injectedVariantCount"], 1)
            self.assertEqual(summary["outputs"]["trainingReport"]["scorecardId"], "rl-scorecard-run-test")
            self.assertEqual(summary["outputs"]["trainingReport"]["candidateScorecard"]["status"], "ready")
            self.assertFalse(
                summary["outputs"]["trainingReport"]["candidateScorecard"]["validationScaleComputeBlocked"]
            )
            self.assertEqual(
                summary["outputs"]["trainingReport"]["policyUpdateArtifactPath"],
                "runtime-artifacts/rl-training/policy-candidates/run-test-next-policy.json",
            )
            self.assertFalse(summary["outputs"]["trainingReport"]["policyUpdate"]["liveEffect"])
            self.assertEqual(summary["outputs"]["trainingReport"]["batchScale"]["batchClass"], "smoke")
            self.assertFalse(summary["outputs"]["trainingReport"]["batchScale"]["scaleFirstEligible"])
            self.assertEqual(summary["batchScale"]["batchClass"], "smoke")

    def test_verify_remote_training_report_rejects_orphaned_scorecard_evidence(self) -> None:
        cases = (
            (
                {"scorecardId": "rl-scorecard-run-test"},
                "scorecardId is present without candidateScorecard evidence",
            ),
            (
                {"scorecardArtifactPath": READY_RUNTIME_SCORECARD_PATH},
                "scorecardArtifactPath is present without candidateScorecard evidence",
            ),
        )
        for patch, expected_error in cases:
            with self.subTest(expected_error=expected_error), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                data = {
                    "reportId": "run-test",
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                    "artifactCount": 1,
                    **patch,
                }
                report = runner.remote_training_report_path(root, "run-test")
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(json.dumps(data), encoding="utf-8")
                controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

                with self.assertRaisesRegex(runner.BatchRunError, expected_error):
                    controller.verify_remote_training_report()

    def test_verify_remote_training_report_rejects_ready_scorecard_without_collected_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(training_report_with_ready_runtime_scorecard()), encoding="utf-8")
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            with self.assertRaisesRegex(
                runner.BatchRunError,
                "candidate scorecard artifact was not collected",
            ):
                controller.verify_remote_training_report()

    def test_verify_remote_training_report_rejects_malformed_runtime_parameter_injection_evidence(self) -> None:
        def injection_patch(
            *,
            status: str,
            runtime_parameter_injection: bool,
            policy_update_eligible: bool,
            candidate_parameter_scope: str,
            injected_variant_count: int,
        ) -> dict[str, object]:
            return {
                "runtimeParameterInjection": {
                    "status": status,
                    "runtimeParameterInjection": runtime_parameter_injection,
                    "policyUpdateEligible": policy_update_eligible,
                    "candidateParameterScope": candidate_parameter_scope,
                    "injectedVariantCount": injected_variant_count,
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                }
            }

        cases = (
            ("string evidence", {"runtimeParameterInjection": "false"}, "runtimeParameterInjection must be an object"),
            (
                "missing eligibility",
                {
                    "runtimeParameterInjection": {
                        "status": "injected",
                        "runtimeParameterInjection": True,
                        "candidateParameterScope": "runtime_injected",
                        "injectedVariantCount": 1,
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                    }
                },
                "policyUpdateEligible",
            ),
            (
                "string boolean",
                {
                    "runtimeParameterInjection": {
                        "status": "injected",
                        "runtimeParameterInjection": "true",
                        "policyUpdateEligible": True,
                        "candidateParameterScope": "runtime_injected",
                        "injectedVariantCount": 1,
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                    }
                },
                "runtimeParameterInjection.runtimeParameterInjection must be a boolean",
            ),
            (
                "unknown false status",
                injection_patch(
                    status="garbage",
                    runtime_parameter_injection=False,
                    policy_update_eligible=False,
                    candidate_parameter_scope="metadata_only",
                    injected_variant_count=0,
                ),
                "runtimeParameterInjection.status invalid",
            ),
            (
                "metadata scope mismatch",
                injection_patch(
                    status="metadata_only",
                    runtime_parameter_injection=False,
                    policy_update_eligible=False,
                    candidate_parameter_scope="runtime_injected",
                    injected_variant_count=0,
                ),
                "metadata_only status requires metadata_only scope",
            ),
            (
                "not injected scope mismatch",
                injection_patch(
                    status="not_injected",
                    runtime_parameter_injection=False,
                    policy_update_eligible=False,
                    candidate_parameter_scope="metadata_only",
                    injected_variant_count=0,
                ),
                "not_injected status requires runtime_injected scope",
            ),
            (
                "metadata positive injected count",
                injection_patch(
                    status="metadata_only",
                    runtime_parameter_injection=False,
                    policy_update_eligible=False,
                    candidate_parameter_scope="metadata_only",
                    injected_variant_count=1,
                ),
                "metadata_only status requires injectedVariantCount=0",
            ),
            (
                "partial zero injected count",
                injection_patch(
                    status="partial",
                    runtime_parameter_injection=False,
                    policy_update_eligible=False,
                    candidate_parameter_scope="partial_runtime_injection",
                    injected_variant_count=0,
                ),
                "partial status requires positive injectedVariantCount",
            ),
        )
        for name, patch, expected_error in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                data = training_report_with_ready_runtime_scorecard()
                data.update(patch)
                report = runner.remote_training_report_path(root, "run-test")
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(json.dumps(data), encoding="utf-8")
                controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

                with self.assertRaisesRegex(runner.BatchRunError, expected_error):
                    controller.verify_remote_training_report()

    def test_verify_remote_training_report_accepts_materialization_failure_with_runtime_injection_proof(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["scorecardId"] = None
            data["scorecardArtifactPath"] = None
            data["candidateScorecard"] = {
                "status": "blocked",
                "classification": "candidate_scorecard_materialization_failed",
                "scorecardId": None,
                "runtimeParameterInjection": True,
                "injectedVariantCount": 1,
                "candidateParameterScope": "runtime_injected",
                "candidateStrategyId": "candidate",
                "baselineStrategyId": "baseline",
                "candidateRank": 1,
                "baselineRank": 2,
                "missingPrerequisite": "candidate_scorecard_artifact",
                "validationScaleComputeBlocked": True,
                "scorecardUsable": False,
            }
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            controller.verify_remote_training_report()

        verified = controller.result["trainingReport"]["candidateScorecard"]
        self.assertEqual(verified["classification"], "candidate_scorecard_materialization_failed")
        self.assertTrue(verified["runtimeParameterInjection"])
        self.assertEqual(verified["candidateParameterScope"], "runtime_injected")
        self.assertEqual(verified["candidateStrategyId"], "candidate")

    def test_verify_remote_training_report_rejects_materialization_failure_without_nested_injection_proof(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["scorecardId"] = None
            data["scorecardArtifactPath"] = None
            data["candidateScorecard"] = {
                "status": "blocked",
                "classification": "candidate_scorecard_materialization_failed",
                "scorecardId": None,
                "runtimeParameterInjection": False,
                "injectedVariantCount": 1,
                "candidateParameterScope": "runtime_injected",
                "candidateStrategyId": "candidate",
                "baselineStrategyId": "baseline",
                "candidateRank": 1,
                "baselineRank": 2,
                "missingPrerequisite": "candidate_scorecard_artifact",
                "validationScaleComputeBlocked": True,
                "scorecardUsable": False,
            }
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            with self.assertRaisesRegex(
                runner.BatchRunError,
                "materialization failure requires runtimeParameterInjection proof",
            ):
                controller.verify_remote_training_report()

    def test_verify_remote_training_report_accepts_blocked_partial_runtime_injection_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = training_report_with_ready_runtime_scorecard()
            data["runtimeParameterInjection"] = {
                "status": "partial",
                "runtimeParameterInjection": False,
                "policyUpdateEligible": False,
                "candidateParameterScope": "partial_runtime_injection",
                "injectedVariantCount": 1,
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            }
            data["scorecardId"] = None
            data["scorecardArtifactPath"] = None
            data["candidateScorecard"] = {
                "status": "blocked",
                "classification": "runtime_parameter_injection_validation_blocked",
                "scorecardId": None,
                "runtimeParameterInjection": False,
                "injectedVariantCount": 1,
                "validationScaleComputeBlocked": True,
                "scorecardUsable": False,
            }
            report = runner.remote_training_report_path(root, "run-test")
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps(data), encoding="utf-8")
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

            controller.verify_remote_training_report()

        training_report = controller.result["trainingReport"]
        self.assertEqual(training_report["runtimeParameterInjection"]["status"], "partial")
        self.assertEqual(training_report["runtimeParameterInjection"]["injectedVariantCount"], 1)
        self.assertEqual(training_report["candidateScorecard"]["status"], "blocked")
        self.assertFalse(training_report["candidateScorecard"]["runtimeParameterInjection"])
        self.assertEqual(training_report["candidateScorecard"]["injectedVariantCount"], 1)
        self.assertTrue(training_report["candidateScorecard"]["validationScaleComputeBlocked"])
        self.assertFalse(training_report["candidateScorecard"]["scorecardUsable"])
        self.assertIsNone(training_report["scorecardId"])
        self.assertIsNone(training_report["scorecardArtifactPath"])

    def test_verify_remote_training_report_rejects_inconsistent_candidate_scorecard_evidence(self) -> None:
        cases = (
            (
                "string evidence",
                {"candidateScorecard": "ready"},
                "candidateScorecard must be an object",
            ),
            (
                "ready blocked",
                {
                    "candidateScorecard": {
                        "status": "ready",
                        "scorecardId": "rl-scorecard-run-test",
                        "runtimeParameterInjection": True,
                        "injectedVariantCount": 1,
                        "validationScaleComputeBlocked": True,
                        "scorecardUsable": True,
                    }
                },
                "ready status cannot be validation-scale blocked",
            ),
            (
                "ready without runtime proof",
                {
                    "runtimeParameterInjection": {
                        "status": "metadata_only",
                        "runtimeParameterInjection": False,
                        "policyUpdateEligible": False,
                        "candidateParameterScope": "metadata_only",
                        "injectedVariantCount": 0,
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                    },
                },
                "ready without runtimeParameterInjection proof",
            ),
            (
                "blocked contradicts top-level runtime proof",
                {
                    "scorecardId": None,
                    "scorecardArtifactPath": None,
                    "candidateScorecard": {
                        "status": "blocked",
                        "classification": "runtime_parameter_injection_validation_blocked",
                        "scorecardId": None,
                        "runtimeParameterInjection": False,
                        "injectedVariantCount": 0,
                        "validationScaleComputeBlocked": True,
                        "scorecardUsable": False,
                    },
                },
                "blocked status contradicts top-level runtimeParameterInjection proof",
            ),
            (
                "blocked without materialization failure has injected count",
                {
                    "runtimeParameterInjection": {
                        "status": "metadata_only",
                        "runtimeParameterInjection": False,
                        "policyUpdateEligible": False,
                        "candidateParameterScope": "metadata_only",
                        "injectedVariantCount": 0,
                        "liveEffect": False,
                        "officialMmoWrites": False,
                        "officialMmoWritesAllowed": False,
                    },
                    "scorecardId": None,
                    "scorecardArtifactPath": None,
                    "candidateScorecard": {
                        "status": "blocked",
                        "classification": "runtime_parameter_injection_metadata_only",
                        "scorecardId": None,
                        "runtimeParameterInjection": False,
                        "injectedVariantCount": 1,
                        "validationScaleComputeBlocked": True,
                        "scorecardUsable": False,
                    },
                },
                "blocked status requires injectedVariantCount=0",
            ),
        )
        for name, patch, expected_error in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                data = training_report_with_ready_runtime_scorecard()
                data.update(patch)
                report = runner.remote_training_report_path(root, "run-test")
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(json.dumps(data), encoding="utf-8")
                controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)

                with self.assertRaisesRegex(runner.BatchRunError, expected_error):
                    controller.verify_remote_training_report()

    def test_verify_remote_training_report_records_smoke_batch_scale_from_simulator_ticks(self) -> None:
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
                        "simulation": {"ticks": 500},
                        "variantResults": [
                            {"variantId": f"variant-{index}", "runs": [{"ticksRun": 500, "ok": True}]}
                            for index in range(5)
                        ],
                    }
                ),
                encoding="utf-8",
            )
            controller = runner.Controller(args=controller_args(), run_id="run-test", artifact_dir=root)
            controller.verify_remote_training_report()
            controller.write_summary()

            summary = json.loads((root / "controller-summary.json").read_text(encoding="utf-8"))

        batch_scale = summary["outputs"]["trainingReport"]["batchScale"]
        self.assertEqual(batch_scale["batchClass"], "smoke")
        self.assertEqual(batch_scale["environmentRows"], 5)
        self.assertEqual(batch_scale["simulatorTicks"], 2500)
        self.assertFalse(batch_scale["scaleFirstEligible"])
        self.assertEqual(summary["batchScale"]["batchClass"], "smoke")
        self.assertEqual(summary["batchScale"]["basis"], "training_report")

    def test_controller_run_accepts_metadata_only_zero_iteration_update_and_preserves_completed_evidence(self) -> None:
        policy_update = {
            "type": "screeps-rl-policy-update",
            "schemaVersion": 1,
            "iterations": 0,
            "algorithm": "true_gradient_reinforce_v1",
            "targetFamily": "multi-tier-territory-combat",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
            },
            "skippedReason": "candidate_parameters_metadata_only",
            "candidateCount": 0,
            "metadataCandidateCount": 5,
            "parameterEvidence": {
                "candidateParameterScope": "metadata_only",
                "runtimeParameterInjection": False,
                "policyUpdateEligible": False,
                "reason": "candidate vectors were metadata only",
            },
        }

        class FakeController(runner.Controller):
            def check_pre_launch_guard(self) -> bool:
                return False

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
                self.instance_id = "ins-test"

            def verify_worker_security(self) -> None:
                pass

            def bootstrap_worker(self) -> None:
                pass

            def transfer_repo_bundle(self) -> None:
                pass

            def transfer_secret_env(self) -> None:
                pass

            def run_remote_training(self) -> None:
                self.record_step("remote_training", 100.0, True, reportId=self.run_id)

            def collect_remote_artifacts(self) -> None:
                report = runner.remote_training_report_path(self.artifact_dir, self.run_id)
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(
                    json.dumps(
                        {
                            "reportId": self.run_id,
                            "generatedAt": "2026-05-20T03:51:09Z",
                            "liveEffect": False,
                            "officialMmoWrites": False,
                            "officialMmoWritesAllowed": False,
                            "artifactCount": 25,
                            "simulation": {"ticks": 500},
                            "scaleValidation": {
                                "ok": True,
                                "targetEnvironments": 5,
                                "minimumSuccessfulEnvironments": 20,
                                "totalEnvironments": 25,
                                "successfulEnvironments": 25,
                                "repetitions": 5,
                            },
                            "runtimeParameterInjection": {
                                "type": "screeps-rl-runtime-parameter-injection",
                                "status": "metadata_only",
                                "runtimeParameterInjection": False,
                                "policyUpdateEligible": False,
                                "candidateParameterScope": "metadata_only",
                                "injectedVariantCount": 0,
                                "reason": "candidate vectors were metadata only",
                                "liveEffect": False,
                                "officialMmoWrites": False,
                                "officialMmoWritesAllowed": False,
                            },
                            "scorecardId": None,
                            "scorecardArtifactPath": None,
                            "candidateScorecard": {
                                "status": "blocked",
                                "classification": "runtime_parameter_injection_metadata_only",
                                "scorecardId": None,
                                "runtimeParameterInjection": False,
                                "injectedVariantCount": 0,
                                "missingPrerequisite": "runtime_parameter_injection",
                                "validationScaleComputeBlocked": True,
                                "scorecardUsable": False,
                            },
                            "policyUpdateIterations": 0,
                            "policyUpdate": policy_update,
                        }
                    ),
                    encoding="utf-8",
                )

            def scale_down(self) -> None:
                self.record_step("scale_down", 101.0, True, desiredCapacity=0)

        args = controller_args()
        args.training_approach = "policy_gradient"
        args.scenario_id = runner.MULTI_TIER_SCENARIO_ID
        args.ticks = 500
        args.workers = 5
        args.repetitions = 5
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            args.artifact_root = artifact_root
            controller = FakeController(
                args=args,
                run_id="tencent-pg-metadata-only",
                artifact_dir=artifact_root / "tencent-pg-metadata-only",
            )
            with mock.patch.object(runner, "validate_static_inputs", return_value=None):
                controller.run()
            summary = json.loads(
                (artifact_root / "tencent-pg-metadata-only" / "controller-summary.json").read_text(
                    encoding="utf-8",
                )
            )

        training_report = summary["outputs"]["trainingReport"]
        self.assertEqual(summary["finalStatus"], "completed")
        self.assertEqual(summary["execution"]["artifactCount"], 25)
        self.assertEqual(summary["execution"]["environmentsRun"], 25)
        self.assertEqual(summary["batchScale"]["environmentRows"], 25)
        self.assertEqual(summary["batchScale"]["simulatorTicks"], 12500)
        self.assertEqual(training_report["artifactCount"], 25)
        self.assertEqual(training_report["policyUpdateIterations"], 0)
        self.assertIsNone(training_report["policyUpdateArtifactPath"])
        self.assertFalse(training_report["runtimeParameterInjection"]["runtimeParameterInjection"])
        self.assertEqual(training_report["runtimeParameterInjection"]["injectedVariantCount"], 0)
        self.assertIsNone(training_report["scorecardId"])
        self.assertEqual(training_report["candidateScorecard"]["status"], "blocked")
        self.assertTrue(training_report["candidateScorecard"]["validationScaleComputeBlocked"])
        self.assertFalse(training_report["candidateScorecard"]["scorecardUsable"])
        self.assertEqual(training_report["policyUpdate"]["metadataCandidateCount"], 5)
        self.assertFalse(training_report["policyUpdate"]["parameterEvidence"]["policyUpdateEligible"])
        self.assertNotIn("nextCandidatePolicy", training_report["policyUpdate"])

    def test_e1s1_repeat_launch_guard_blocks_after_three_dead_tier_runs(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for run_id in ("tencent-pg-1", "tencent-pg-2", "tencent-pg-3"):
                write_tencent_guard_summary(artifact_root, run_id)
            args = controller_args()
            args.artifact_root = artifact_root
            args.training_approach = "policy_gradient"
            args.ticks = 500

            guard = runner.build_e1s1_repeat_launch_guard(
                args=args,
                run_id="new-run",
                artifact_dir=artifact_root / "new-run",
            )

        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["status"], "blocked")
        self.assertEqual(guard["evidence"]["count"], 3)
        self.assertIn("multi-tier", guard["nextAction"])
        self.assertFalse(guard["safety"]["scaleOutAttempted"])
        self.assertEqual({item["territory"] for item in guard["evidence"]["runs"]}, {2})
        self.assertEqual({item["kills"] for item in guard["evidence"]["runs"]}, {0})

    def test_e1s1_repeat_launch_guard_scans_past_recent_irrelevant_summaries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            valid_paths = [
                write_tencent_guard_summary(artifact_root, f"tencent-pg-valid-{index}") for index in range(3)
            ]
            noisy_paths = [
                write_tencent_guard_summary(artifact_root, f"tencent-pg-preflight-{index}", final_status="preflight_ok")
                for index in range(runner.E1S1_REPEAT_GUARD_RECENT_SUMMARY_LIMIT)
            ]
            for index, summary_path in enumerate(valid_paths):
                timestamp = 1_700_000_000 + index
                os.utime(summary_path, (timestamp, timestamp))
            for index, summary_path in enumerate(noisy_paths):
                timestamp = 1_700_000_100 + index
                os.utime(summary_path, (timestamp, timestamp))
            args = controller_args()
            args.artifact_root = artifact_root
            args.training_approach = "policy_gradient"
            args.ticks = 500

            guard = runner.build_e1s1_repeat_launch_guard(
                args=args,
                run_id="new-run",
                artifact_dir=artifact_root / "new-run",
            )

        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["evidence"]["count"], 3)
        self.assertEqual(
            {item["runId"] for item in guard["evidence"]["runs"]},
            {"tencent-pg-valid-0", "tencent-pg-valid-1", "tencent-pg-valid-2"},
        )

    def test_e1s1_repeat_launch_guard_requires_explicit_room_and_map_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for run_id in ("tencent-pg-1", "tencent-pg-2", "tencent-pg-3"):
                strip_tencent_guard_location_evidence(write_tencent_guard_summary(artifact_root, run_id))
            args = controller_args()
            args.artifact_root = artifact_root
            args.training_approach = "policy_gradient"
            args.ticks = 500

            guard = runner.build_e1s1_repeat_launch_guard(
                args=args,
                run_id="new-run",
                artifact_dir=artifact_root / "new-run",
            )

        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["status"], "clear")
        self.assertEqual(guard["evidence"]["count"], 0)

    def test_e1s1_repeat_launch_guard_allows_insufficient_dead_tier_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            write_tencent_guard_summary(artifact_root, "tencent-pg-1")
            write_tencent_guard_summary(artifact_root, "tencent-pg-2")
            write_tencent_guard_summary(
                artifact_root,
                "tencent-pg-with-kills",
                territory_kills=((2, 0), (2, 1)),
            )
            args = controller_args()
            args.artifact_root = artifact_root
            args.training_approach = "policy_gradient"
            args.ticks = 500

            guard = runner.build_e1s1_repeat_launch_guard(
                args=args,
                run_id="new-run",
                artifact_dir=artifact_root / "new-run",
            )

        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["status"], "clear")
        self.assertEqual(guard["evidence"]["count"], 2)
        self.assertIsNone(guard["nextAction"])

    def test_e1s1_repeat_launch_guard_allows_non_e1s1_launch(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for run_id in ("tencent-pg-1", "tencent-pg-2", "tencent-pg-3"):
                write_tencent_guard_summary(artifact_root, run_id)
            args = controller_args()
            args.artifact_root = artifact_root
            args.scenario_id = runner.MULTI_TIER_SCENARIO_ID
            args.require_multi_tier_scenario = True
            args.training_approach = "policy_gradient"
            args.ticks = 500

            guard = runner.build_e1s1_repeat_launch_guard(
                args=args,
                run_id="new-run",
                artifact_dir=artifact_root / "new-run",
            )

        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["currentLaunch"]["scenarioId"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(guard["currentLaunch"]["requireMultiTierScenario"])
        self.assertEqual(guard["currentLaunch"]["mapSourceFile"], runner.MULTI_TIER_SIMULATION_MAP_SOURCE_REL)
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["adjacentRoom"], "E2S1")
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["hostileCreepCount"], 2)
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["hostileSpawnCount"], 1)
        self.assertEqual(guard["evidence"]["count"], 0)

    def test_no_arg_preflight_defaults_to_multi_tier_policy_gradient_without_repeat_guard(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for run_id in ("tencent-pg-1", "tencent-pg-2", "tencent-pg-3"):
                write_tencent_guard_summary(artifact_root, run_id)
            args = runner.parse_cli_args([
                "preflight",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
            ])
            artifact_dir = artifact_root / "new-run"

            events, controller, guard, summary = self.run_stubbed_preflight(args, artifact_dir)

        self.assertEqual(args.training_approach, "policy_gradient")
        self.assertEqual(args.scenario_id, runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(args.require_multi_tier_scenario)
        self.assertFalse(args.run_id.startswith("tencent-single-"))
        self.assertEqual(controller.final_status, "preflight_ok")
        self.assertEqual(summary["finalStatus"], "preflight_ok")
        self.assertEqual(summary["execution"]["command"], "preflight")
        self.assertEqual(summary["execution"]["mode"], "preflight")
        self.assertTrue(summary["execution"]["preflightOnly"])
        self.assertFalse(summary["execution"]["computeAttempted"])
        self.assertFalse(summary["execution"]["scaleOutAttempted"])
        self.assertFalse(summary["execution"]["remoteTrainingAttempted"])
        self.assertFalse(summary["execution"]["trainingReportProduced"])
        self.assertEqual(summary["execution"]["environmentsRun"], 0)
        self.assertEqual(summary["inputs"]["command"], "preflight")
        self.assertTrue(summary["inputs"]["preflightOnly"])
        self.assertEqual(summary["inputs"]["trainingApproach"], "policy_gradient")
        self.assertEqual(summary["inputs"]["scenarioId"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(summary["inputs"]["requireMultiTierScenario"])
        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["status"], "clear")
        self.assertFalse(guard["currentLaunch"]["isE1S1SingleRoomNoHostile"])
        self.assertEqual(guard["currentLaunch"]["scenarioId"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertEqual(guard["currentLaunch"]["effectiveTicks"], runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS)
        self.assertEqual(guard["evidence"]["count"], 0)
        self.assertIn("experiment_card", events)
        self.assertNotIn("scale_up", events)

    def test_no_arg_run_single_defaults_to_multi_tier_policy_gradient_compute_mode(self) -> None:
        args = runner.parse_cli_args(["run-single"])

        self.assertEqual(args.command, "run-single")
        self.assertFalse(args.preflight_only)
        self.assertTrue(args.run_id.startswith("tencent-single-"))
        self.assertEqual(args.training_approach, "policy_gradient")
        self.assertEqual(args.scenario_id, runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(args.require_multi_tier_scenario)
        self.assertEqual(runner.effective_training_ticks(args), runner.POLICY_GRADIENT_MIN_SIMULATION_TICKS)

    def test_preflight_command_uses_preflight_run_id_prefix(self) -> None:
        args = runner.parse_cli_args(["preflight"])

        self.assertEqual(args.command, "preflight")
        self.assertTrue(args.preflight_only)
        self.assertTrue(args.run_id.startswith("tencent-preflight-"))
        self.assertFalse(args.run_id.startswith("tencent-single-"))

    def test_cli_rejects_abbreviated_training_approach_option(self) -> None:
        with mock.patch("sys.stderr", new=io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                runner.parse_cli_args(["preflight", "--training-app", "bandit"])

        self.assertNotEqual(raised.exception.code, 0)

    def test_explicit_cli_option_dests_stops_at_option_separator(self) -> None:
        self.assertEqual(
            runner.explicit_cli_option_dests([
                "preflight",
                "--training-approach=bandit",
                "--",
                "--scenario-id",
                runner.DEFAULT_SCENARIO_ID,
            ]),
            {"training_approach"},
        )
        self.assertEqual(
            runner.explicit_cli_option_dests([
                "preflight",
                "--",
                "--training-approach",
                "bandit",
                f"--scenario-id={runner.DEFAULT_SCENARIO_ID}",
            ]),
            set(),
        )

    def test_explicit_e1s1_bandit_preflight_still_triggers_repeat_guard(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for run_id in ("tencent-pg-1", "tencent-pg-2", "tencent-pg-3"):
                write_tencent_guard_summary(artifact_root, run_id)
            args = runner.parse_cli_args([
                "preflight",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "bandit",
                "--scenario-id",
                runner.DEFAULT_SCENARIO_ID,
            ])
            artifact_dir = artifact_root / "new-run"

            events, controller, guard, summary = self.run_stubbed_preflight(args, artifact_dir)

        self.assertEqual(args.training_approach, "bandit")
        self.assertEqual(args.scenario_id, runner.DEFAULT_SCENARIO_ID)
        self.assertEqual(events, [])
        self.assertEqual(controller.final_status, runner.E1S1_REPEAT_GUARD_FINAL_STATUS)
        self.assertEqual(summary["finalStatus"], runner.E1S1_REPEAT_GUARD_FINAL_STATUS)
        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["currentLaunch"]["scenarioId"], runner.DEFAULT_SCENARIO_ID)
        self.assertTrue(guard["currentLaunch"]["isE1S1SingleRoomNoHostile"])
        self.assertEqual(guard["currentLaunch"]["trainingApproach"], "bandit")
        self.assertEqual(guard["evidence"]["count"], 3)

    def test_explicit_multi_tier_preflight_includes_fixture_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            args = runner.parse_cli_args([
                "preflight",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
            ])
            artifact_dir = artifact_root / "new-run"

            events, controller, guard, summary = self.run_stubbed_preflight(args, artifact_dir)

        self.assertEqual(controller.final_status, "preflight_ok")
        self.assertEqual(summary["inputs"]["scenarioId"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(summary["inputs"]["requireMultiTierScenario"])
        self.assertEqual(summary["execution"]["mode"], "preflight")
        self.assertFalse(summary["execution"]["computeAttempted"])
        self.assertFalse(summary["execution"]["trainingReportProduced"])
        self.assertFalse(guard["blocked"])
        self.assertEqual(guard["currentLaunch"]["scenarioId"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(guard["currentLaunch"]["requireMultiTierScenario"])
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["adjacentRoom"], "E2S1")
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["hostileCreepCount"], 2)
        self.assertEqual(guard["currentLaunch"]["fixtureEvidence"]["hostileSpawnCount"], 1)
        self.assertIn("experiment_card", events)
        self.assertNotIn("scale_up", events)
        self.assertNotIn("bootstrap", events)
        self.assertNotIn("remote_training", events)

    def test_preflight_repeat_launch_guard_writes_skip_artifact_without_remote_side_effects(self) -> None:
        events: list[str] = []

        class FakeController(runner.Controller):
            def ensure_map_present(self) -> None:
                events.append("map")

            def ensure_dist_present(self) -> None:
                events.append("dist")

            def run_billing_guard(self) -> None:
                events.append("billing")

            def verify_security_group(self) -> None:
                events.append("security_group")

            def generate_experiment_card(self) -> None:
                events.append("experiment_card")

            def scale_up_and_wait(self) -> None:
                events.append("scale_up")

        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            for run_id in ("tencent-pg-1", "tencent-pg-2", "tencent-pg-3"):
                write_tencent_guard_summary(artifact_root, run_id)
            args = controller_args()
            args.artifact_root = artifact_root
            args.preflight_only = True
            args.training_approach = "policy_gradient"
            args.ticks = 500
            artifact_dir = artifact_root / "new-run"
            controller = FakeController(args=args, run_id="new-run", artifact_dir=artifact_dir)

            with mock.patch.object(runner, "validate_static_inputs", return_value=None):
                controller.run()

            guard = json.loads((artifact_dir / "launch_guard.json").read_text(encoding="utf-8"))
            summary = json.loads((artifact_dir / "controller-summary.json").read_text(encoding="utf-8"))

        self.assertEqual(events, [])
        self.assertTrue(guard["blocked"])
        self.assertEqual(guard["status"], "blocked")
        self.assertEqual(controller.final_status, runner.E1S1_REPEAT_GUARD_FINAL_STATUS)
        self.assertEqual(summary["finalStatus"], runner.E1S1_REPEAT_GUARD_FINAL_STATUS)
        self.assertFalse(summary["safety"]["scaleDownAttempted"])
        self.assertEqual(summary["outputs"]["launchGuard"]["status"], "blocked")
        self.assertEqual(summary["execution"]["mode"], "preflight")
        self.assertFalse(summary["execution"]["computeAttempted"])
        self.assertFalse(summary["execution"]["scaleOutAttempted"])

    def test_multi_tier_run_single_proceeds_past_preflight_into_mocked_compute_path(self) -> None:
        events: list[str] = []

        class FakeController(runner.Controller):
            def ensure_map_present(self) -> None:
                events.append("map")

            def ensure_dist_present(self) -> None:
                events.append("dist")

            def run_billing_guard(self) -> None:
                events.append("billing")

            def verify_security_group(self) -> None:
                events.append("security_group")

            def generate_experiment_card(self) -> None:
                events.append("experiment_card")

            def scale_up_and_wait(self) -> None:
                events.append("scale_up")
                self.scaled_up = True
                self.instance_id = "ins-test"
                self.public_ip = "203.0.113.10"
                self.record_step("scale_up", 100.0, True, desiredCapacity=1)

            def verify_worker_security(self) -> None:
                events.append("worker_security")

            def bootstrap_worker(self) -> None:
                events.append("bootstrap")

            def transfer_repo_bundle(self) -> None:
                events.append("repo_bundle")

            def transfer_secret_env(self) -> None:
                events.append("secret_env")

            def run_remote_training(self) -> None:
                events.append("remote_training")
                self.record_step("remote_training", 101.0, True, reportId=self.run_id)

            def collect_remote_artifacts(self) -> None:
                events.append("collect_artifacts")

            def verify_remote_training_report(self) -> None:
                events.append("verify_training_report")
                self.result["trainingReport"] = {
                    "path": str(self.artifact_dir / "remote" / "runtime-artifacts" / "rl-training" / f"{self.run_id}.json"),
                    "reportId": self.run_id,
                    "liveEffect": False,
                    "officialMmoWrites": False,
                    "officialMmoWritesAllowed": False,
                    "artifactCount": 5,
                    "scaleValidation": {
                        "ok": True,
                        "totalEnvironments": 5,
                        "successfulEnvironments": 5,
                        "minimumSuccessfulEnvironments": 4,
                    },
                }

            def scale_down(self) -> None:
                events.append("scale_down")
                self.record_step("scale_down", 102.0, True, desiredCapacity=0)

        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_root = Path(temp_dir) / "batch-runs"
            args = runner.parse_cli_args([
                "run-single",
                "--run-id",
                "new-run",
                "--artifact-root",
                str(artifact_root),
                "--training-approach",
                "policy_gradient",
                "--scenario-id",
                runner.MULTI_TIER_SCENARIO_ID,
                "--ticks",
                "500",
                "--workers",
                "1",
            ])
            artifact_dir = artifact_root / "new-run"
            controller = FakeController(args=args, run_id=args.run_id, artifact_dir=artifact_dir)

            with mock.patch.object(runner, "validate_static_inputs", return_value=None):
                controller.run()

            guard = json.loads((artifact_dir / "launch_guard.json").read_text(encoding="utf-8"))
            summary = json.loads((artifact_dir / "controller-summary.json").read_text(encoding="utf-8"))

        self.assertFalse(args.preflight_only)
        self.assertFalse(guard["blocked"])
        self.assertEqual(controller.final_status, "completed")
        self.assertEqual(summary["finalStatus"], "completed")
        self.assertNotEqual(summary["finalStatus"], "preflight_ok")
        self.assertEqual(summary["inputs"]["command"], "run-single")
        self.assertFalse(summary["inputs"]["preflightOnly"])
        self.assertEqual(summary["inputs"]["scenarioId"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertEqual(summary["execution"]["command"], "run-single")
        self.assertEqual(summary["execution"]["mode"], "compute")
        self.assertFalse(summary["execution"]["preflightOnly"])
        self.assertTrue(summary["execution"]["computeAttempted"])
        self.assertTrue(summary["execution"]["scaleOutAttempted"])
        self.assertTrue(summary["execution"]["remoteTrainingAttempted"])
        self.assertTrue(summary["execution"]["trainingReportProduced"])
        self.assertEqual(summary["execution"]["trainingReportId"], "new-run")
        self.assertEqual(summary["execution"]["artifactCount"], 5)
        self.assertEqual(summary["execution"]["environmentsRun"], 5)
        self.assertEqual(summary["instanceId"], "ins-test")
        self.assertIn("scale_up", events)
        self.assertIn("bootstrap", events)
        self.assertIn("remote_training", events)
        self.assertIn("verify_training_report", events)
        self.assertLess(events.index("experiment_card"), events.index("scale_up"))

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

            args.workers = 1
            args.require_multi_tier_scenario = True
            args.scenario_id = runner.DEFAULT_SCENARIO_ID
            with self.assertRaisesRegex(runner.BatchRunError, "multi-tier policy comparisons require"):
                runner.validate_static_inputs(args, "run-test")

            args.scenario_id = runner.MULTI_TIER_SCENARIO_ID
            runner.validate_static_inputs(args, "run-test")

            args.training_approach = "policy_gradient"
            args.scenario_id = runner.DEFAULT_SCENARIO_ID
            args.require_multi_tier_scenario = False
            with self.assertRaisesRegex(runner.BatchRunError, "policy_gradient Tencent proof requires"):
                runner.validate_static_inputs(args, "run-test")

            args.scenario_id = runner.MULTI_TIER_SCENARIO_ID
            args.require_multi_tier_scenario = True
            runner.validate_static_inputs(args, "run-test")

    def test_policy_gradient_cli_defaults_to_multi_tier_required_scenario(self) -> None:
        args = runner.build_parser().parse_args([
            "preflight",
            "--training-approach",
            "policy_gradient",
        ])

        runner.apply_cli_scenario_defaults(args)

        self.assertEqual(args.scenario_id, runner.MULTI_TIER_SCENARIO_ID)
        self.assertTrue(args.require_multi_tier_scenario)

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
        self.assertEqual(card["scenario"]["evidence"]["map_source_file"], "maps/map-0b6758af.json")
        self.assertEqual(spec["scaleProof"]["mode"], "single_tencent_asg_worker_multi_environment")
        self.assertEqual(spec["scaleProof"]["successCriteria"]["minimumSuccessfulEnvironments"], 4)
        self.assertEqual(spec["experimentCard"]["scenario"]["scenario_id"], runner.DEFAULT_SCENARIO_ID)
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
            observed_cmds: list[list[str]] = []

            def fake_run_cp(name: str, cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                observed_cmds.append(cmd)
                if name == "generate_experiment_card":
                    output = Path(cmd[cmd.index("--output") + 1])
                    payload = generated_experiment_card()
                    payload["training_approach"] = "policy_gradient"
                    if "--loop-a-policy-gradient-supply" in cmd:
                        payload["card_supply"] = {
                            "type": "screeps-rl-loop-a-card-supply",
                            "consumer": "loop-a-policy-gradient",
                            "state": "available",
                            "available_for_training": True,
                            "dataset_run_id": payload["dataset_run_id"],
                            "training_approach": payload["training_approach"],
                            "created_at": payload["created_at"],
                            "status_field": "status",
                            "safety_status": "shadow",
                            "consumed_at": None,
                            "consumed_by_report_id": None,
                        }
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
        self.assertIn("--loop-a-policy-gradient-supply", observed_cmds[0])
        self.assertEqual(card["card_supply"]["type"], "screeps-rl-loop-a-card-supply")
        self.assertEqual(card["card_supply"]["consumer"], "loop-a-policy-gradient")
        self.assertTrue(card["card_supply"]["available_for_training"])
        self.assertEqual(card["simulation"]["ticks"], 500)
        self.assertEqual(card["simulation"]["workers"], 5)
        self.assertEqual(card["simulation"]["repetitions"], 5)
        self.assertFalse(card["officialMmoWrites"])
        self.assertFalse(card["officialMmoWritesAllowed"])
        self.assertEqual(controller.result["experimentCard"]["trainingApproach"], "policy_gradient")
        self.assertEqual(controller.result["experimentCard"]["cardSupply"]["state"], "available")
        self.assertEqual(spec["experimentCard"]["cardSupply"]["state"], "available")
        self.assertEqual(spec["scaleProof"]["remoteRunnerContract"]["cardSimulationFields"]["ticks"], 500)

    def test_generate_experiment_card_passes_multi_tier_scenario_request(self) -> None:
        args = controller_args()
        args.training_approach = "policy_gradient"
        args.workers = 5
        args.scenario_id = runner.MULTI_TIER_SCENARIO_ID
        args.require_multi_tier_scenario = True
        observed_cmds: list[list[str]] = []
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root)

            def fake_run_cp(name: str, cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                observed_cmds.append(cmd)
                if name == "generate_experiment_card":
                    output = Path(cmd[cmd.index("--output") + 1])
                    payload = card_helper.build_card(
                        dataset_run_id="dataset-test",
                        code_commit="a" * 40,
                        training_approach="policy_gradient",
                        created_at="2026-05-18T10:18:00Z",
                        scenario_id=runner.MULTI_TIER_SCENARIO_ID,
                        require_multi_tier_scenario=True,
                    )
                    output.write_text(json.dumps(payload), encoding="utf-8")
                return subprocess.CompletedProcess(cmd, 0, "{}", "")

            with mock.patch.object(controller, "run_cp", side_effect=fake_run_cp):
                controller.generate_experiment_card()

            card = json.loads((root / "experiment_card.json").read_text(encoding="utf-8"))
            spec = json.loads((root / "scale_proof_spec.json").read_text(encoding="utf-8"))

        generate_cmd = observed_cmds[0]
        self.assertEqual(generate_cmd[generate_cmd.index("--scenario-id") + 1], runner.MULTI_TIER_SCENARIO_ID)
        self.assertIn("--require-multi-tier-scenario", generate_cmd)
        self.assertEqual(card["scenario"]["scenario_id"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertEqual(card["policy_gradient"]["policy_update"]["algorithm"], "reinforce_v1")
        self.assertEqual(card["policy_gradient"]["policy_update"]["learning_rate"], 1)
        self.assertTrue(card["scenario"]["capabilities"]["hostile_combat_signal"])
        self.assertEqual(card["scenario"]["evidence"]["adjacent_room"], "E2S1")
        self.assertEqual(card["scenario"]["evidence"]["hostile_creep_count"], 2)
        self.assertEqual(card["scenario"]["evidence"]["hostile_spawn_count"], 1)
        self.assertEqual(card["simulation"]["map_source_file"], runner.MULTI_TIER_SIMULATION_MAP_SOURCE_REL)
        self.assertEqual(card["scenario"]["evidence"]["map_source_file"], runner.MULTI_TIER_SIMULATION_MAP_SOURCE_REL)
        self.assertEqual(spec["experimentCard"]["scenario"]["scenario_id"], runner.MULTI_TIER_SCENARIO_ID)
        self.assertEqual(
            spec["scaleProof"]["remoteRunnerContract"]["cardSimulationFields"]["map_source_file"],
            runner.MULTI_TIER_SIMULATION_MAP_SOURCE_REL,
        )
        self.assertEqual(
            spec["scaleProof"]["remoteRunnerContract"]["cardSimulationFields"]["fixtureEvidence"]["hostileSpawnCount"],
            1,
        )
        self.assertFalse(card["safety"]["officialMmoWritesAllowed"])

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
        self.assertNotIn("203.0.113.10", controller.known_hosts_cleaned_public_ips)
        self.assertEqual(controller.result["knownHostsCleanupWarnings"][0]["returncode"], 255)
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
            timeout_stdout = (
                b"line=203.0.113.10 ssh-ed25519-cert-v01@openssh.com "
                b"AAAAC3NzaC1lZDI1NTE5LWNlcnQtimeoutkey\n"
                b"STEAM_KEY=timeout-steam-secret\n"
            )
            timeout_stderr = b"TOKEN=timeout-token-secret\ntimed out\n"
            with mock.patch.object(
                runner.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired(["ssh-keygen"], 30, output=timeout_stdout, stderr=timeout_stderr),
            ):
                controller.scale_up_and_wait()

        clear_steps = [step for step in controller.steps if step.name == "clear_worker_known_host"]
        self.assertEqual(len(clear_steps), 1)
        self.assertFalse(clear_steps[0].ok)
        self.assertEqual(clear_steps[0].returncode, 124)
        self.assertIn("TimeoutExpired", clear_steps[0].stderr_tail or "")
        self.assertNotIn("203.0.113.10", controller.known_hosts_cleaned_public_ips)
        self.assertEqual(controller.result["knownHostsCleanupWarnings"][0]["returncode"], 124)
        self.assertEqual(controller.result["worker"]["publicIp"], "203.0.113.10")
        combined = json.dumps(
            {
                "steps": [step.__dict__ for step in controller.steps],
                "result": controller.result,
            },
            sort_keys=True,
        )
        self.assertIn("[REDACTED_HOST_KEY]", combined)
        self.assertIn("STEAM_KEY=[REDACTED]", combined)
        self.assertIn("TOKEN=[REDACTED]", combined)
        self.assertNotIn("AAAAC3NzaC1lZDI1NTE5LWNlcnQtimeoutkey", combined)
        self.assertNotIn("ssh-ed25519-cert-v01@openssh.com", combined)
        self.assertNotIn("timeout-steam-secret", combined)
        self.assertNotIn("timeout-token-secret", combined)

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

    def test_ssh_and_scp_commands_auto_cleanup_and_use_consistent_known_hosts_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            parsed = runner.parse_cli_args(["preflight", "--known-hosts-path", args.known_hosts_path])
            self.assertEqual(parsed.known_hosts_path, args.known_hosts_path)
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"
            events: list[tuple[str, list[str]]] = []
            cleanup_commands: list[list[str]] = []
            commands: list[list[str]] = []

            def capture_subprocess_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
                events.append(("cleanup", cmd))
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
                events.append(("command", cmd))
                commands.append(cmd)
                return subprocess.CompletedProcess(cmd, 0, "", "")

            with (
                mock.patch.object(runner.subprocess, "run", side_effect=capture_subprocess_run),
                mock.patch.object(controller, "run_cp", side_effect=capture_run_cp),
            ):
                controller.ssh_cmd("ssh_probe", "true")
                controller.scp_to_worker("upload", Path(temp_dir) / "local.txt", "/remote/local.txt")
                controller.scp_from_worker("download", "/remote/out.txt", Path(temp_dir) / "out" / "out.txt")

        self.assertEqual(cleanup_commands, [["ssh-keygen", "-R", "203.0.113.10", "-f", args.known_hosts_path]])
        self.assertEqual([event[0] for event in events], ["cleanup", "command", "command", "command"])
        for cmd in commands:
            with self.subTest(command=cmd[0]):
                self.assertIn("BatchMode=yes", cmd)
                self.assertIn("StrictHostKeyChecking=accept-new", cmd)
                self.assertIn(f"UserKnownHostsFile={args.known_hosts_path}", cmd)

    def test_known_host_cleanup_warning_redacts_secret_and_host_key_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            args = controller_args()
            args.known_hosts_path = str(Path(temp_dir) / "known_hosts")
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=Path(temp_dir))
            controller.public_ip = "203.0.113.10"
            stdout = (
                "line=203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIhostkey comment\n"
                "line=203.0.113.10 ssh-rsa-cert-v01@openssh.com AAAAB3NzaC1yc2EtY2VydCcertkey comment\n"
                "STEAM_KEY=steam-secret\n"
            )
            stderr = (
                "TOKEN=token-secret\n"
                "ecdsa-sha2-nistp256-cert-v01@openssh.com AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYtY2VydCcertkey\n"
                "sk-ssh-ed25519-cert-v01@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5LWNlcnQcertkey\n"
            )

            with mock.patch.object(
                runner.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(["ssh-keygen"], 255, stdout, stderr),
            ):
                controller.clear_worker_known_host()

            combined = json.dumps(
                {
                    "steps": [step.__dict__ for step in controller.steps],
                    "result": controller.result,
                },
                sort_keys=True,
            )

        self.assertIn("[REDACTED_HOST_KEY]", combined)
        self.assertIn("STEAM_KEY=[REDACTED]", combined)
        self.assertIn("TOKEN=[REDACTED]", combined)
        self.assertNotIn("AAAA", combined)
        self.assertNotIn("-cert-v01@openssh.com", combined)
        self.assertNotIn("steam-secret", combined)
        self.assertNotIn("token-secret", combined)

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
            artifact_root = Path(temp_dir) / "batch-runs"
            args = controller_args()
            args.artifact_root = artifact_root
            controller = FakeController(args=args, run_id="run-test", artifact_dir=artifact_root / "run-test")
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
                mock.patch.object(runner.time, "time", side_effect=[100.0, 100.0, 100.0, 100.0, 101.1]),
                mock.patch.object(runner.time, "sleep", return_value=None),
            ):
                controller.run()

            summary = json.loads((artifact_root / "run-test" / "controller-summary.json").read_text(encoding="utf-8"))
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
            artifact_root = Path(temp_dir) / "batch-runs"
            args.artifact_root = artifact_root
            controller = FakeController(args=args, run_id="run-test", artifact_dir=artifact_root / "run-test")
            with mock.patch.object(runner, "validate_static_inputs", return_value=None):
                with self.assertRaisesRegex(runner.BatchRunError, "training failed"):
                    controller.run()
            summary = json.loads((artifact_root / "run-test" / "controller-summary.json").read_text(encoding="utf-8"))

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

    def test_multi_tier_map_preflight_validates_fixture_without_e1s1_map(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fixture_path = root / runner.MULTI_TIER_SIMULATION_MAP_SOURCE_REL
            fixture_path.parent.mkdir(parents=True)
            fixture_path.write_text(
                card_helper.MULTI_TIER_SIMULATION_MAP_SOURCE_FILE.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            args = controller_args()
            args.scenario_id = runner.MULTI_TIER_SCENARIO_ID
            args.require_multi_tier_scenario = True
            controller = runner.Controller(args=args, run_id="run-test", artifact_dir=root / "artifacts")

            with mock.patch.object(runner, "REPO_ROOT", root):
                controller.ensure_map_present()

            self.assertEqual(controller.steps[0].detail["path"], str(fixture_path))
            self.assertEqual(controller.steps[0].detail["scenarioId"], runner.MULTI_TIER_SCENARIO_ID)
            self.assertEqual(controller.steps[0].detail["adjacentRoom"], "E2S1")
            self.assertEqual(controller.steps[0].detail["hostileCreepCount"], 2)
            self.assertFalse((root / "maps" / "map-0b6758af.json").exists())

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
