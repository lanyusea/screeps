#!/usr/bin/env python3
"""Run bounded Screeps RL training on a Tencent Cloud ASG batch worker.

This controller-side tool keeps the ASG at desired=0 by default, scales one
worker for offline/private training, copies a redacted repo bundle and local
STEAM_KEY env file over SSH, collects artifacts, and always attempts to scale
the ASG back to zero. Multi-worker RL scale proof requests are bounded to
multiple concurrent simulator environments on that single paid ASG worker.

No secret values are printed or persisted in controller summaries.
"""
from __future__ import annotations

import argparse
import base64
import copy
import datetime as dt
import json
import math
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

from screeps_rl_experiment_card import (
    CardValidationError,
    DEFAULT_SCENARIO_ID,
    MULTI_TIER_ACTIVE_IMPLEMENTATION_STATUS,
    MULTI_TIER_SCENARIO_ID,
    MULTI_TIER_SIMULATION_MAP_SOURCE_REL,
    SCENARIO_IDS,
    multi_tier_scenario_fixture_summary,
    scenario_supports_multi_tier_policy_comparison,
)
import screeps_rl_scale_gates as scale_gates

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TCCLI = Path("/root/.hermes/hermes-agent/venv/bin/tccli")
DEFAULT_BILLING_GUARD = Path("/root/.hermes/scripts/screeps-tencent-billing-guard.py")
DEFAULT_SECRET_ENV = Path("/root/.secret/.env")
DEFAULT_SSH_KEY = Path("/root/.ssh/id_ed25519")
DEFAULT_KNOWN_HOSTS = Path("/root/.ssh/known_hosts")
DEFAULT_REGION = "ap-singapore"
DEFAULT_ASG_ID = "asg-csw592ro"
DEFAULT_CONTROLLER_IP = "43.128.104.34/32"
DEFAULT_WORKER_USER = "screeps-batch"
DEFAULT_REMOTE_BASE = "/opt/screeps-batch/jobs"
DEFAULT_ARTIFACT_ROOT = Path("runtime-artifacts/tencent-cloud/batch-runs")
MAX_SCALE_PROOF_WORKERS = 16
SCALE_PROOF_SUCCESS_RATE = 0.8
POLICY_GRADIENT_MIN_SIMULATION_TICKS = 500
REWARD_TIER_ORDER = ("reliability", "territory", "resources", "kills")
E1S1_REPEAT_GUARD_TYPE = "screeps-tencent-batch-rl-launch-guard"
E1S1_REPEAT_GUARD_FINAL_STATUS = "skipped_e1s1_repeat_launch_guard"
E1S1_REPEAT_GUARD_MIN_COMPLETED_RUNS = 3
E1S1_REPEAT_GUARD_RECENT_SUMMARY_LIMIT = 20
E1S1_REPEAT_GUARD_DEAD_TERRITORY = 2
E1S1_REPEAT_GUARD_DEAD_KILLS = 0
E1S1_REPEAT_GUARD_NEXT_ACTION = (
    f"use --scenario-id {MULTI_TIER_SCENARIO_ID} --require-multi-tier-scenario after PR #1204; "
    "do not launch another E1S1-only Tencent batch"
)
DEFAULT_SIMULATION_MAP_SOURCE_REL = "maps/map-0b6758af.json"
DEFAULT_SIMULATION_ROOM = "E1S1"
RUN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{2,80}$")
SSH_CONNECT_OPTIONS = (
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=8",
    "-o", "StrictHostKeyChecking=accept-new",
)
KNOWN_HOSTS_CLEANUP_TIMEOUT_SECONDS = 30
HOST_KEY_ALGORITHM_RE = (
    r"(?:ssh-rsa(?:-cert-v01@openssh\.com)?|"
    r"ssh-dss(?:-cert-v01@openssh\.com)?|"
    r"ssh-ed25519(?:-cert-v01@openssh\.com)?|"
    r"ecdsa-sha2-nistp\d+(?:-cert-v01@openssh\.com)?|"
    r"sk-ssh-ed25519(?:@openssh\.com|-cert-v01@openssh\.com)|"
    r"sk-ecdsa-sha2-nistp256(?:@openssh\.com|-cert-v01@openssh\.com))"
)
HOST_KEY_BLOB_RE = re.compile(rf"\b{HOST_KEY_ALGORITHM_RE}\s+[A-Za-z0-9+/=]+")
SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(?:STEAM_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|TENCENTCLOUD_SECRET_KEY|TENCENT_SECRET_KEY)=\S+"
)
BUNDLE_ALLOWLISTED_RUNTIME_FILES = ("maps/map-0b6758af.json",)
BUNDLE_EXCLUDE_DIRS = {".git", "node_modules", "__pycache__", ".codex", ".codex-local-git", ".git-local"}
BUNDLE_EXCLUDE_PREFIXES = (
    "runtime-artifacts/",
    "docs/roadmap-kpi.sqlite",
    "prod/node_modules/",
    "maps/.git/",
)
BUNDLE_SECRET_PATH_PATTERNS = (
    re.compile(r"(^|/)\.env($|[./])"),
    re.compile(r"(^|/)prod/(\.env|screeps\.json)$"),
    re.compile(r"(^|/)[^/]*\.local$"),
    re.compile(r"(^|/)[^/]*(credential|credentials|private[-_]?key|token)[^/]*\.(json|pem|key|txt)$", re.IGNORECASE),
)
POLICY_UPDATE_SAFETY_FIELD_ALIASES = {
    "liveEffect": ("liveEffect", "live_effect"),
    "officialMmoWrites": ("officialMmoWrites", "official_mmo_writes"),
    "officialMmoWritesAllowed": ("officialMmoWritesAllowed", "official_mmo_writes_allowed"),
}
POSITIVE_POLICY_UPDATE_REQUIRED_FALSE_FIELDS = (
    "liveEffect",
    "officialMmoWrites",
    "officialMmoWritesAllowed",
)
RUNTIME_PARAMETER_INJECTION_ALLOWED_STATUS_SCOPES = {
    "injected": "runtime_injected",
    "metadata_only": "metadata_only",
    "not_injected": "runtime_injected",
    "partial": "partial_runtime_injection",
}
MULTI_CANDIDATE_SCORECARD_SET_TYPE = "screeps-rl-multi-candidate-scorecard-set"
CANDIDATE_SCORECARD_SET_STATUSES = {"blocked", "materialized", "partial", "planned", "ready"}
ZERO_ITERATION_POLICY_UPDATE_ALLOWED_KEYS = {
    "algorithm",
    "anchor",
    "candidateCount",
    "candidateRewards",
    "gradient",
    "gradientByRewardTier",
    "gradientEstimation",
    "gradientMomentum",
    "gradientStable",
    "gradientStability",
    "highVariance",
    "iterations",
    "learningRate",
    "liveEffect",
    "metadataCandidateCount",
    "officialMmoWrites",
    "officialMmoWritesAllowed",
    "parameterEvidence",
    "promotionGate",
    "rawGradient",
    "safety",
    "schemaVersion",
    "skippedReason",
    "targetFamily",
    "returnSummary",
    "selectedRewardTierByParameter",
    "type",
    "trueGradient",
    "trustedGradientUpdate",
}
ZERO_ITERATION_POLICY_UPDATE_FORBIDDEN_KEYS = {
    "artifactPath",
    "artifact_path",
    "nextCandidatePolicy",
    "next_candidate_policy",
    "parameterDelta",
    "parameter_delta",
    "policyUpdateArtifactPath",
    "policy_update_artifact_path",
    "updatedParameters",
    "updated_parameters",
}
CLI_EXPLICIT_OPTION_DESTS = {
    "--training-approach": "training_approach",
    "--scenario-id": "scenario_id",
    "--require-multi-tier-scenario": "require_multi_tier_scenario",
    "--ticks": "ticks",
    "--workers": "workers",
    "--scale-environments": "scale_environments",
    "--repetitions": "repetitions",
}
PREFLIGHT_MODE_OPTION_DESTS = frozenset((
    "training_approach",
    "scenario_id",
    "require_multi_tier_scenario",
))


class BatchRunError(RuntimeError):
    """Raised when the Tencent batch run cannot proceed safely."""


@dataclass
class StepRecord:
    name: str
    ok: bool
    started_at: str
    ended_at: str
    returncode: int | None = None
    stdout_tail: str | None = None
    stderr_tail: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass
class Controller:
    args: argparse.Namespace
    run_id: str
    artifact_dir: Path
    scaled_up: bool = False
    instance_id: str | None = None
    public_ip: str | None = None
    private_ip: str | None = None
    steps: list[StepRecord] = field(default_factory=list)
    known_hosts_cleaned_public_ips: set[str] = field(default_factory=set, repr=False)
    started_at: str = field(default_factory=lambda: utc_now_iso())
    finished_at: str | None = None
    final_status: str = "unknown"
    result: dict[str, Any] = field(default_factory=dict)

    @property
    def tccLI(self) -> Path:  # keep misspelling out of external API; internal property only
        return Path(self.args.tccli)

    @property
    def remote_dir(self) -> str:
        return f"{self.args.remote_base.rstrip('/')}/{self.run_id}"

    @property
    def known_hosts_path(self) -> Path:
        return Path(getattr(self.args, "known_hosts_path", DEFAULT_KNOWN_HOSTS)).expanduser()

    @property
    def ssh_target(self) -> str:
        if not self.public_ip:
            raise BatchRunError("public IP is not known yet")
        return f"{self.args.worker_user}@{self.public_ip}"

    def ssh_connect_options(self) -> tuple[str, ...]:
        return (
            *SSH_CONNECT_OPTIONS,
            "-o", f"UserKnownHostsFile={self.known_hosts_path}",
        )

    def record_step(self, name: str, started: float, ok: bool, cp: subprocess.CompletedProcess[str] | None = None, **detail: Any) -> None:
        stdout_tail = tail_text(cp.stdout) if cp is not None else None
        stderr_tail = tail_text(cp.stderr) if cp is not None else None
        self.steps.append(
            StepRecord(
                name=name,
                ok=ok,
                started_at=dt.datetime.fromtimestamp(started, dt.timezone.utc).isoformat().replace("+00:00", "Z"),
                ended_at=utc_now_iso(),
                returncode=cp.returncode if cp is not None else None,
                stdout_tail=stdout_tail,
                stderr_tail=stderr_tail,
                detail=detail,
            )
        )
        self.write_summary(partial=True)

    def write_summary(self, *, partial: bool = False) -> None:
        training_report = self.result.get("trainingReport")
        report_safety = training_report if isinstance(training_report, dict) else {}
        execution = controller_execution_summary(self.args, self.steps, self.result, self.scaled_up, self.instance_id)
        batch_scale = controller_batch_scale_summary(self.args, self.steps, self.result)
        payload = {
            "type": "screeps-tencent-batch-rl-run",
            "schemaVersion": 1,
            "runId": self.run_id,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "partial": partial,
            "finalStatus": self.final_status,
            "controllerProcess": {
                "pid": os.getpid(),
            },
            "region": self.args.region,
            "autoScalingGroupId": self.args.asg_id,
            "workerUser": self.args.worker_user,
            "instanceId": self.instance_id,
            "publicIp": self.public_ip,
            "privateIp": self.private_ip,
            "remoteDir": self.remote_dir,
            "localArtifactDir": str(self.artifact_dir),
            "execution": execution,
            "batchScale": batch_scale,
            "safety": {
                "liveEffect": report_safety.get("liveEffect", False),
                "officialMmoWrites": report_safety.get("officialMmoWrites", False),
                "officialMmoWritesAllowed": report_safety.get("officialMmoWritesAllowed", False),
                "billingGuardBeforeScale": True,
                "scaleDownAttempted": any(step.name == "scale_down" for step in self.steps),
                "sshControllerOnlyExpected": self.args.controller_ip,
                "secretsPrinted": False,
            },
            "inputs": {
                "command": getattr(self.args, "command", None),
                "executionMode": execution["mode"],
                "preflightOnly": execution["preflightOnly"],
                "datasetRunId": self.args.dataset_run_id,
                "experimentCard": str(self.experiment_card_path()),
                "ticks": effective_training_ticks(self.args),
                "workers": self.args.workers,
                "repetitions": self.args.repetitions,
                "trainingApproach": self.args.training_approach,
                "scenarioId": getattr(self.args, "scenario_id", DEFAULT_SCENARIO_ID),
                "requireMultiTierScenario": getattr(self.args, "require_multi_tier_scenario", False),
                "plannedBatchScale": planned_batch_scale_from_args(self.args),
                "executionTimeouts": controller_timeout_summary(self.args),
            },
            "outputs": self.result,
            "steps": [step.__dict__ for step in self.steps],
        }
        self.artifact_dir.mkdir(parents=True, exist_ok=True)
        (self.artifact_dir / "controller-summary.json").write_text(canonical_json(payload), encoding="utf-8")

    def run_cp(
        self,
        name: str,
        cmd: Sequence[str],
        *,
        check: bool = True,
        timeout: int | None = None,
        cwd: Path | None = None,
        input_text: str | None = None,
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        started = time.time()
        cp = subprocess.run(
            list(cmd),
            text=True,
            input=input_text,
            capture_output=True,
            cwd=str(cwd or REPO_ROOT),
            timeout=timeout,
            env=env,
            check=False,
        )
        ok = cp.returncode == 0
        self.record_step(name, started, ok, cp, argv=redacted_argv(cmd))
        if check and not ok:
            raise BatchRunError(f"{name} failed with exit {cp.returncode}: {tail_text(cp.stderr or cp.stdout)}")
        return cp

    def tccli(self, name: str, *params: str, check: bool = True, timeout: int = 90) -> dict[str, Any]:
        cp = self.run_cp(name, [str(self.tccLI), *params, "--output", "json"], check=check, timeout=timeout)
        if not cp.stdout.strip():
            return {}
        try:
            return unwrap_response(json.loads(cp.stdout))
        except json.JSONDecodeError as error:
            raise BatchRunError(f"{name} returned non-JSON output: {error}") from error

    def ssh_cmd(self, name: str, remote_command: str, *, check: bool = True, timeout: int | None = 600) -> subprocess.CompletedProcess[str]:
        self.clear_worker_known_host()
        cmd = [
            "ssh",
            "-i", self.args.ssh_key,
            *self.ssh_connect_options(),
            self.ssh_target,
            remote_command,
        ]
        return self.run_cp(name, cmd, check=check, timeout=timeout)

    def scp_to_worker(self, name: str, local_path: Path, remote_path: str, *, timeout: int = 300) -> None:
        self.clear_worker_known_host()
        self.run_cp(
            name,
            [
                "scp",
                "-i", self.args.ssh_key,
                *self.ssh_connect_options(),
                str(local_path),
                f"{self.ssh_target}:{remote_path}",
            ],
            timeout=timeout,
        )

    def scp_from_worker(self, name: str, remote_path: str, local_path: Path, *, timeout: int = 900) -> None:
        self.clear_worker_known_host()
        local_path.parent.mkdir(parents=True, exist_ok=True)
        self.run_cp(
            name,
            [
                "scp",
                "-i", self.args.ssh_key,
                *self.ssh_connect_options(),
                f"{self.ssh_target}:{remote_path}",
                str(local_path),
            ],
            timeout=timeout,
        )

    def clear_worker_known_host(self) -> bool:
        if not self.public_ip:
            return True
        if self.public_ip in self.known_hosts_cleaned_public_ips:
            return True
        known_hosts = self.known_hosts_path
        cmd = ["ssh-keygen", "-R", self.public_ip, "-f", str(known_hosts)]
        started = time.time()
        try:
            known_hosts.parent.mkdir(parents=True, exist_ok=True)
            known_hosts.touch(exist_ok=True)
            cp = subprocess.run(
                cmd,
                text=True,
                capture_output=True,
                cwd=str(REPO_ROOT),
                timeout=KNOWN_HOSTS_CLEANUP_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            stdout_raw = getattr(error, "stdout", None)
            if stdout_raw is None:
                stdout_raw = getattr(error, "output", None)
            stderr_raw = getattr(error, "stderr", None)
            stdout = decode_subprocess_text(stdout_raw)
            stderr = decode_subprocess_text(stderr_raw)
            stderr = "\n".join(part for part in (f"{type(error).__name__}: {error}", stderr) if part)
            cp = subprocess.CompletedProcess(cmd, 124, stdout, stderr)
        except OSError as error:
            cp = subprocess.CompletedProcess(cmd, 127, "", f"{type(error).__name__}: {error}")
        ok = cp.returncode == 0
        record_cp = subprocess.CompletedProcess(
            cp.args,
            cp.returncode,
            sanitize_known_hosts_cleanup_text(cp.stdout),
            sanitize_known_hosts_cleanup_text(cp.stderr),
        )
        if not ok:
            warnings = self.result.setdefault("knownHostsCleanupWarnings", [])
            if isinstance(warnings, list):
                warnings.append(
                    {
                        "publicIp": self.public_ip,
                        "knownHostsFile": str(known_hosts),
                        "returncode": cp.returncode,
                        "stderrTail": tail_text(record_cp.stderr),
                    }
                )
        self.record_step(
            "clear_worker_known_host",
            started,
            ok,
            record_cp,
            argv=redacted_argv(cmd),
            publicIp=self.public_ip,
            knownHostsFile=str(known_hosts),
            warning=not ok,
        )
        if ok:
            self.known_hosts_cleaned_public_ips.add(self.public_ip)
        return ok

    def experiment_card_path(self) -> Path:
        return self.artifact_dir / "experiment_card.json"

    def scale_proof_spec_path(self) -> Path:
        return self.artifact_dir / "scale_proof_spec.json"

    def launch_guard_path(self) -> Path:
        return self.artifact_dir / "launch_guard.json"

    def run(self) -> None:
        self.artifact_dir.mkdir(parents=True, exist_ok=True)
        validate_static_inputs(self.args, self.run_id)
        if self.check_pre_launch_guard():
            return
        self.ensure_map_present()
        self.ensure_dist_present()
        self.run_billing_guard()
        self.verify_security_group()
        self.generate_experiment_card()
        if self.args.preflight_only:
            self.final_status = "preflight_ok"
            self.finished_at = utc_now_iso()
            self.write_summary()
            return
        try:
            self.scale_up_and_wait()
            self.verify_worker_security()
            self.bootstrap_worker()
            self.transfer_repo_bundle()
            self.transfer_secret_env()
            self.run_remote_training()
            self.collect_remote_artifacts()
            self.verify_remote_training_report()
            self.final_status = "completed"
        except Exception as error:
            self.final_status = "failed"
            self.result.setdefault("error", type(error).__name__ + ": " + str(error))
            raise
        finally:
            self.safe_scale_down()
            self.finished_at = utc_now_iso()
            self.write_summary()

    def check_pre_launch_guard(self) -> bool:
        started = time.time()
        guard = build_e1s1_repeat_launch_guard(
            args=self.args,
            run_id=self.run_id,
            artifact_dir=self.artifact_dir,
        )
        guard_path = self.launch_guard_path()
        guard_path.parent.mkdir(parents=True, exist_ok=True)
        guard_path.write_text(canonical_json(guard), encoding="utf-8")
        evidence = guard["evidence"]
        self.result["launchGuard"] = {
            "path": str(guard_path),
            "status": guard["status"],
            "blocked": guard["blocked"],
            "reason": guard.get("reason"),
            "nextAction": guard.get("nextAction"),
            "evidenceCount": evidence["count"],
            "evidenceThreshold": evidence["threshold"],
        }
        self.record_step(
            "e1s1_repeat_launch_guard",
            started,
            True,
            path=str(guard_path),
            status=guard["status"],
            blocked=guard["blocked"],
            evidenceCount=evidence["count"],
            evidenceThreshold=evidence["threshold"],
        )
        if not guard["blocked"]:
            return False
        self.final_status = E1S1_REPEAT_GUARD_FINAL_STATUS
        self.finished_at = utc_now_iso()
        self.write_summary()
        return True

    def safe_scale_down(self) -> None:
        try:
            self.scale_down()
        except Exception as error:
            self.result["scaleDownError"] = type(error).__name__ + ": " + str(error)
            if self.final_status == "completed":
                self.final_status = "completed_scale_down_failed"

    def ensure_map_present(self) -> None:
        scenario_id = scenario_id_from_args(self.args)
        target = scenario_map_source_path(scenario_id)
        if scenario_id == MULTI_TIER_SCENARIO_ID:
            evidence = multi_tier_launch_fixture_evidence()
            self.record_step(
                "map_preflight",
                time.time(),
                True,
                path=str(target),
                scenarioId=scenario_id,
                roomCount=evidence["roomCount"],
                adjacentRoom=evidence["adjacentRoom"],
                hostileCreepCount=evidence["hostileCreepCount"],
                hostileSpawnCount=evidence["hostileSpawnCount"],
            )
            return
        if target.is_file():
            self.record_step("map_preflight", time.time(), True, path=str(target))
            return
        candidate_roots = [REPO_ROOT / "runtime-artifacts", Path("/root/screeps/runtime-artifacts")]
        candidates = sorted(
            {candidate for root in candidate_roots if root.exists() for candidate in root.glob("**/maps/map-0b6758af.json")},
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not candidates:
            raise BatchRunError("map-0b6758af.json is missing and no runtime artifact source was found")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(candidates[0].read_bytes())
        self.record_step("map_preflight", time.time(), True, path=str(target), source=str(candidates[0]))

    def ensure_dist_present(self) -> None:
        dist = REPO_ROOT / "prod" / "dist" / "main.js"
        if not dist.is_file():
            raise BatchRunError("prod/dist/main.js missing; build before launching worker training")
        self.record_step("dist_preflight", time.time(), True, path=str(dist), bytes=dist.stat().st_size)

    def run_billing_guard(self) -> None:
        guard = Path(self.args.billing_guard)
        if not guard.is_file():
            raise BatchRunError(f"billing guard not found: {guard}")
        cp = self.run_cp("billing_guard", [str(guard), "--enforce"], check=True, timeout=180)
        try:
            payload = json.loads(cp.stdout.strip().splitlines()[-1])
        except Exception as error:
            raise BatchRunError(f"billing guard output was not JSON: {error}") from error
        if payload.get("status") != "ok":
            raise BatchRunError(f"billing guard rejected scale-up: {payload}")
        self.result["billingGuard"] = payload

    def verify_security_group(self) -> None:
        data = self.tccli(
            "describe_security_group",
            "vpc", "DescribeSecurityGroupPolicies",
            "--region", self.args.region,
            "--SecurityGroupId", self.args.security_group_id,
        )
        policies = data.get("SecurityGroupPolicySet", {})
        ingress = policies.get("Ingress") or []
        allowed = validate_controller_only_sg_ssh_ingress(ingress, self.args.controller_ip)
        self.result["securityGroup"] = {"id": self.args.security_group_id, "sshIngress": allowed}

    def generate_experiment_card(self) -> None:
        card = self.experiment_card_path()
        created_at = utc_now_iso()
        scenario_id = scenario_id_from_args(self.args)
        require_multi_tier_scenario = require_multi_tier_scenario_from_args(self.args, scenario_id)
        cmd = [
            sys.executable,
            "scripts/screeps_rl_experiment_card.py",
            "--dataset-run-id", self.args.dataset_run_id,
            "--training-approach", self.args.training_approach,
            "--created-at", created_at,
            "--scenario-id", scenario_id,
            "--output", str(card),
        ]
        if self.args.training_approach == "policy_gradient":
            cmd.append("--loop-a-policy-gradient-supply")
        if require_multi_tier_scenario:
            cmd.append("--require-multi-tier-scenario")
        cp = self.run_cp(
            "generate_experiment_card",
            cmd,
            timeout=60,
        )
        del cp  # step is already recorded
        # Apply bounded-run overrides after generation; keep schema-valid fields.
        payload = json.loads(card.read_text(encoding="utf-8"))
        simulation = payload.setdefault("simulation", {})
        ticks = effective_training_ticks(self.args)
        scale_environments = resolve_scale_environment_count(self.args)
        map_source_file = scenario_map_source_file(scenario_id)
        simulation.update({
            "ticks": ticks,
            "workers": self.args.workers,
            "repetitions": self.args.repetitions,
            "host_port_start": self.args.host_port_start,
            "code_path": "prod/dist/main.js",
            "map_source_file": map_source_file,
            # Keep smoke worker dirs outside the bundled repo. The private smoke
            # harness refuses to write secrets under a non-gitignored in-repo
            # runtime-artifacts path; the remote bundle intentionally excludes
            # .git, so git check-ignore cannot prove safety there.
            "simulator_out_dir": f"{self.remote_dir}/simulator-artifacts",
        })
        scenario = payload.get("scenario")
        if isinstance(scenario, dict):
            evidence = scenario.setdefault("evidence", {})
            if isinstance(evidence, dict):
                evidence["anchor_room"] = simulation.get("room", evidence.get("anchor_room"))
                evidence["map_source_file"] = simulation["map_source_file"]
        if scale_environments is not None:
            simulation.update({
                "scale_environments": scale_environments,
                "min_concurrent_environments": scale_environments,
                "scale_proof_mode": "single_tencent_asg_worker_multi_environment",
            })
        if self.args.variant:
            payload["strategy_variants"] = self.args.variant
        validate_requested_experiment_card_scenario(
            payload,
            requested_scenario_id=scenario_id,
            require_multi_tier_scenario=require_multi_tier_scenario,
        )
        payload["run_id"] = self.run_id
        card.write_text(canonical_json(payload), encoding="utf-8")
        self.run_cp(
            "validate_experiment_card",
            [sys.executable, "scripts/screeps_rl_experiment_card.py", "--validate", "--input", str(card)],
            timeout=60,
        )
        experiment_card_summary = {
            "path": str(card),
            "createdAt": created_at,
            "cardId": payload.get("card_id"),
            "trainingApproach": payload.get("training_approach"),
            "status": payload.get("status"),
            "safety": payload.get("safety"),
            "rewardModel": payload.get("reward_model"),
        }
        card_supply = payload.get("card_supply")
        if isinstance(card_supply, dict):
            experiment_card_summary["cardSupply"] = card_supply
        self.result["experimentCard"] = experiment_card_summary
        if scale_environments is not None:
            self.write_scale_proof_spec(scale_environments=scale_environments, experiment_card=payload)

    def write_scale_proof_spec(self, *, scale_environments: int, experiment_card: dict[str, Any]) -> None:
        started = time.time()
        spec_path = self.scale_proof_spec_path()
        spec = build_scale_proof_spec(
            args=self.args,
            run_id=self.run_id,
            artifact_dir=self.artifact_dir,
            experiment_card_path=self.experiment_card_path(),
            scale_environments=scale_environments,
            experiment_card=experiment_card,
        )
        spec_path.write_text(canonical_json(spec), encoding="utf-8")
        self.result["scaleProofSpec"] = {
            "path": str(spec_path),
            "mode": spec["scaleProof"]["mode"],
            "requestedWorkers": self.args.workers,
            "scaleEnvironments": scale_environments,
            "minimumSuccessfulEnvironments": spec["scaleProof"]["successCriteria"]["minimumSuccessfulEnvironments"],
        }
        self.record_step(
            "write_scale_proof_spec",
            started,
            True,
            path=str(spec_path),
            workers=self.args.workers,
            scaleEnvironments=scale_environments,
        )

    def describe_asg_instances(self) -> list[dict[str, Any]]:
        filters = json.dumps([{"Name": "auto-scaling-group-id", "Values": [self.args.asg_id]}])
        data = self.tccli(
            "describe_asg_instances",
            "as", "DescribeAutoScalingInstances",
            "--region", self.args.region,
            "--Filters", filters,
            "--Limit", "100",
            check=True,
            timeout=90,
        )
        return data.get("AutoScalingInstanceSet") or []

    def describe_cvm_instances(self, instance_ids: Sequence[str]) -> list[dict[str, Any]]:
        if not instance_ids:
            return []
        data = self.tccli(
            "describe_cvm_instances",
            "cvm", "DescribeInstances",
            "--region", self.args.region,
            "--InstanceIds", json.dumps(list(instance_ids)),
            check=True,
            timeout=90,
        )
        return data.get("InstanceSet") or []

    def latest_scale_out_failure(self, *, after_epoch: float) -> dict[str, Any] | None:
        filters = json.dumps([{"Name": "auto-scaling-group-id", "Values": [self.args.asg_id]}])
        data = self.tccli(
            "describe_scaling_activities",
            "as", "DescribeAutoScalingActivities",
            "--region", self.args.region,
            "--Filters", filters,
            "--Limit", "10",
            check=False,
            timeout=90,
        )
        for activity in data.get("ActivitySet") or []:
            if activity.get("ActivityType") != "SCALE_OUT" or activity.get("StatusCode") != "FAILED":
                continue
            activity_epoch = parse_tencent_activity_time(activity.get("StartTime") or activity.get("EndTime"))
            if activity_epoch is None or activity_epoch < after_epoch - 5:
                continue
            return activity
        return None

    def scale_up_and_wait(self) -> None:
        scale_started = time.time()
        self.tccli(
            "scale_up",
            "as", "ModifyDesiredCapacity",
            "--region", self.args.region,
            "--AutoScalingGroupId", self.args.asg_id,
            "--DesiredCapacity", "1",
            timeout=90,
        )
        self.scaled_up = True
        deadline = time.time() + self.args.scale_timeout_seconds
        last_seen: dict[str, Any] = {}
        while time.time() < deadline:
            asg_instances = self.describe_asg_instances()
            last_seen = {"asgInstances": asg_instances}
            ids = [i.get("InstanceId") for i in asg_instances if i.get("InstanceId")]
            cvms = self.describe_cvm_instances(ids)
            last_seen["cvmInstances"] = cvms
            for cvm in cvms:
                public_ips = cvm.get("PublicIpAddresses") or []
                private_ips = cvm.get("PrivateIpAddresses") or []
                if cvm.get("InstanceState") == "RUNNING" and public_ips:
                    self.instance_id = cvm.get("InstanceId")
                    self.public_ip = public_ips[0]
                    self.private_ip = private_ips[0] if private_ips else None
                    self.clear_worker_known_host()
                    if self.wait_for_ssh():
                        self.result["worker"] = {
                            "instanceId": self.instance_id,
                            "publicIp": self.public_ip,
                            "privateIp": self.private_ip,
                            "instanceType": cvm.get("InstanceType"),
                            "state": cvm.get("InstanceState"),
                        }
                        return
            failure = self.latest_scale_out_failure(after_epoch=scale_started)
            if failure and not asg_instances:
                self.result["scaleOutFailure"] = summarize_scale_out_failure(failure)
                raise BatchRunError("ASG scale-out failed before any worker was created: " + json.dumps(self.result["scaleOutFailure"], ensure_ascii=False)[:2000])
            time.sleep(15)
        raise BatchRunError(f"worker did not become reachable before timeout; last_seen={json.dumps(last_seen)[:2000]}")

    def wait_for_ssh(self) -> bool:
        deadline = time.time() + 420
        while time.time() < deadline:
            cp = self.ssh_cmd("ssh_probe", "true", check=False, timeout=30)
            if cp.returncode == 0:
                return True
            time.sleep(10)
        return False

    def verify_worker_security(self) -> None:
        cmd = """
set -euo pipefail
cloud-init status --wait >/dev/null 2>&1 || true
printf 'whoami='; whoami
printf 'ready='; cat /opt/screeps-batch/READY 2>/dev/null || true; printf '\n'
printf 'iptables_filter='
if sudo iptables-save -t filter 2>/dev/null | tr '\n' ';'; then
  :
else
  sudo iptables -S | tr '\n' ';'
fi
printf '\n'
printf 'sshd='; sudo sshd -T 2>/dev/null | egrep '^(passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|permitrootlogin|allowusers) ' | tr '\n' ';'; printf '\n'
""".strip()
        cp = self.ssh_cmd("verify_worker_security", bash_lc(cmd), timeout=180)
        out = cp.stdout
        validate_controller_only_worker_ssh(out, self.args.controller_ip)
        if "passwordauthentication no" not in out.lower():
            raise BatchRunError("worker sshd does not report passwordauthentication no")
        self.result["workerSecurity"] = {"summary": out[-3000:]}

    def bootstrap_worker(self) -> None:
        remote = r"""
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
for i in $(seq 1 60); do
  if sudo fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1; then sleep 5; else break; fi
done
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl jq rsync tar gzip time python3 python3-venv python3-pip docker.io
if ! docker compose version >/dev/null 2>&1; then
  sudo apt-get install -y docker-compose-v2 || sudo apt-get install -y docker-compose-plugin || sudo apt-get install -y docker-compose || true
fi
sudo systemctl enable --now docker
sudo usermod -aG docker "$WORKER_USER" || true
sudo mkdir -p "$REMOTE_DIR" /var/log/screeps-batch
sudo chown -R "$WORKER_USER:$WORKER_USER" "$REMOTE_DIR" /var/log/screeps-batch
python3 --version
docker --version
(docker compose version || docker-compose version)
""".strip()
        env_prefix = " ".join(
            f"{key}={shlex.quote(value)}"
            for key, value in {
                "REMOTE_DIR": self.remote_dir,
                "WORKER_USER": self.args.worker_user,
            }.items()
        )
        self.ssh_cmd(
            "bootstrap_worker",
            env_prefix + " " + bash_lc(remote),
            timeout=self.args.bootstrap_timeout_seconds,
        )

    def transfer_repo_bundle(self) -> None:
        package = self.artifact_dir / "repo-bundle.tar.gz"
        create_repo_bundle(package)
        self.result["repoBundle"] = {"path": str(package), "bytes": package.stat().st_size}
        self.scp_to_worker("upload_repo_bundle", package, f"{self.remote_dir}/repo-bundle.tar.gz", timeout=self.args.transfer_timeout_seconds)
        remote = f"rm -rf {shlex.quote(self.remote_dir)}/repo && mkdir -p {shlex.quote(self.remote_dir)}/repo && tar -xzf {shlex.quote(self.remote_dir)}/repo-bundle.tar.gz -C {shlex.quote(self.remote_dir)}/repo"
        self.ssh_cmd("extract_repo_bundle", remote, timeout=300)
        self.scp_to_worker("upload_experiment_card", self.experiment_card_path(), f"{self.remote_dir}/experiment_card.json", timeout=120)

    def transfer_secret_env(self) -> None:
        secret = Path(self.args.secret_env)
        if not secret.is_file():
            raise BatchRunError(f"secret env file missing: {secret}")
        # Copy by path only; secret values are never read into controller output.
        self.scp_to_worker("upload_secret_env", secret, f"{self.remote_dir}/secret.env", timeout=120)
        self.ssh_cmd("chmod_secret_env", f"chmod 600 {shlex.quote(self.remote_dir)}/secret.env", timeout=60)

    def run_remote_training(self) -> None:
        remote = r"""
set -euo pipefail
cd "$REMOTE_DIR/repo"
set -a
. "$REMOTE_DIR/secret.env"
set +a
export PYTHONPATH="$PWD/scripts"
export npm_config_jobs=1
export SCREEPS_PRIVATE_SMOKE_HOST_PORT_START="$HOST_PORT_START"
mkdir -p runtime-artifacts/rl-training "$REMOTE_DIR/simulator-artifacts"
python3 scripts/screeps_rl_experiment_card.py --validate --input "$REMOTE_DIR/experiment_card.json" > "$REMOTE_DIR/card-validation.json"
/usr/bin/time -v python3 scripts/screeps_rl_training_runner.py \
  --experiment-card "$REMOTE_DIR/experiment_card.json" \
  --out-dir runtime-artifacts/rl-training \
  --report-id "$RUN_ID" \
  --print-report > "$REMOTE_DIR/training-summary.json" 2> "$REMOTE_DIR/training-stderr.log"
python3 - <<'PY' > "$REMOTE_DIR/report-extract.json"
import json, os
run_id=os.environ['RUN_ID']
path=f'runtime-artifacts/rl-training/{run_id}.json'
d=json.load(open(path))
print(json.dumps({
  'reportPath': path,
  'reportId': d.get('reportId'),
  'generatedAt': d.get('generatedAt'),
  'experimentCard': d.get('experimentCard'),
  'artifactCount': d.get('artifactCount'),
  'ranking': d.get('ranking'),
  'changedTopCount': d.get('changedTopCount'),
  'activationProof': d.get('activationProof'),
  'policyUpdateIterations': d.get('policyUpdateIterations'),
  'policyUpdateArtifactPath': d.get('policyUpdateArtifactPath'),
  'policyUpdate': d.get('policyUpdate'),
  'gradientStable': d.get('gradientStable'),
  'trustedGradientUpdate': d.get('trustedGradientUpdate'),
  'highVariance': d.get('highVariance'),
  'gradientEstimation': d.get('gradientEstimation'),
  'gradientMomentum': d.get('gradientMomentum'),
  'gradientStability': d.get('gradientStability'),
  'runtimeParameterInjection': d.get('runtimeParameterInjection'),
  'scorecardId': d.get('scorecardId'),
  'scorecardArtifactPath': d.get('scorecardArtifactPath'),
  'candidateScorecard': d.get('candidateScorecard'),
  'candidateScorecards': d.get('candidateScorecards'),
  'warnings': d.get('warnings'),
  'simulation': d.get('simulation'),
  'scaleValidation': d.get('scaleValidation'),
  'liveEffect': d.get('liveEffect'),
  'officialMmoWrites': d.get('officialMmoWrites'),
  'officialMmoWritesAllowed': d.get('officialMmoWritesAllowed'),
}, indent=2, sort_keys=True))
PY
""".strip()
        env_prefix = " ".join(
            f"{key}={shlex.quote(value)}"
            for key, value in {
                "REMOTE_DIR": self.remote_dir,
                "RUN_ID": self.run_id,
                "HOST_PORT_START": str(self.args.host_port_start),
            }.items()
        )
        self.ssh_cmd("remote_training", env_prefix + " " + bash_lc(remote), timeout=self.args.training_timeout_seconds)

    def collect_remote_artifacts(self) -> None:
        remote_tar = f"{self.remote_dir}/remote-artifacts.tar.gz"
        remote = r"""
set -euo pipefail
cd "$REMOTE_DIR"
if [ ! -s report-extract.json ] && [ -s training-summary.json ]; then
  cp training-summary.json report-extract.json
fi
touch report-extract.json
simulator_summaries=()
if [ -f "simulator-artifacts/$RUN_ID/run_summary.json" ]; then
  simulator_summaries+=("simulator-artifacts/$RUN_ID/run_summary.json")
fi
if [ -f "simulator-artifacts/$RUN_ID/owned_room_scorecard.json" ]; then
  simulator_summaries+=("simulator-artifacts/$RUN_ID/owned_room_scorecard.json")
fi
tar -czf remote-artifacts.tar.gz \
  experiment_card.json card-validation.json training-summary.json training-stderr.log report-extract.json \
  "${simulator_summaries[@]}" \
  -C repo runtime-artifacts/rl-training
""".strip()
        env_prefix = " ".join(
            f"{key}={shlex.quote(value)}"
            for key, value in {"REMOTE_DIR": self.remote_dir, "RUN_ID": self.run_id}.items()
        )
        self.ssh_cmd("pack_remote_artifacts", env_prefix + " " + bash_lc(remote), timeout=600)
        local_tar = self.artifact_dir / "remote-artifacts.tar.gz"
        self.scp_from_worker("download_remote_artifacts", remote_tar, local_tar, timeout=self.args.transfer_timeout_seconds)
        extract_dir = self.artifact_dir / "remote"
        if extract_dir.exists():
            subprocess.run(["rm", "-rf", str(extract_dir)], check=True)
        extract_dir.mkdir(parents=True, exist_ok=True)
        safe_extract_tar(local_tar, extract_dir)
        self.result["remoteArtifacts"] = {"tarball": str(local_tar), "extractDir": str(extract_dir), "bytes": local_tar.stat().st_size}

    def verify_remote_training_report(self) -> None:
        report = remote_training_report_path(self.artifact_dir, self.run_id)
        if not report.is_file():
            raise BatchRunError(f"remote training report missing after collection: {report}")
        data = json.loads(report.read_text(encoding="utf-8"))
        safety_flags = {
            "liveEffect": data.get("liveEffect"),
            "officialMmoWrites": data.get("officialMmoWrites"),
            "officialMmoWritesAllowed": data.get("officialMmoWritesAllowed"),
        }
        unsafe_flags = [name for name, value in safety_flags.items() if value is not False]
        if unsafe_flags:
            raise BatchRunError(f"remote training report safety flags are unsafe: {', '.join(unsafe_flags)}")
        artifact_count = data.get("artifactCount")
        if not isinstance(artifact_count, int) or artifact_count <= 0:
            raise BatchRunError(f"remote training artifactCount invalid: {artifact_count!r}")
        batch_scale = batch_scale_summary_from_training_report(data, artifact_count)
        scale_environments = resolve_scale_environment_count(self.args)
        scale_validation = data.get("scaleValidation")
        if scale_environments is not None:
            validate_scale_proof_result(scale_validation, scale_environments, repetitions=self.args.repetitions)
        runtime_parameter_injection = verified_remote_runtime_parameter_injection(data.get("runtimeParameterInjection"))
        policy_update_fields = verified_remote_policy_update_fields(
            data,
            safety_flags,
            self.artifact_dir,
            runtime_parameter_injection=runtime_parameter_injection,
        )
        candidate_scorecard = verified_remote_candidate_scorecard(
            data.get("candidateScorecard"),
            runtime_parameter_injection=runtime_parameter_injection,
            scorecard_id=data.get("scorecardId"),
            scorecard_artifact_path=data.get("scorecardArtifactPath"),
            artifact_dir=self.artifact_dir,
        )
        candidate_scorecards = verified_remote_candidate_scorecards(
            data.get("candidateScorecards"),
            runtime_parameter_injection=runtime_parameter_injection,
            artifact_dir=self.artifact_dir,
        )
        self.result["trainingReport"] = {
            "path": str(report),
            "reportId": data.get("reportId"),
            "generatedAt": data.get("generatedAt"),
            "experimentCard": data.get("experimentCard"),
            **safety_flags,
            "artifactCount": artifact_count,
            "batchScale": batch_scale,
            "changedTopCount": data.get("changedTopCount"),
            "activationProof": data.get("activationProof"),
            "runtimeParameterInjection": runtime_parameter_injection,
            "scorecardId": data.get("scorecardId"),
            "scorecardArtifactPath": data.get("scorecardArtifactPath"),
            "candidateScorecard": candidate_scorecard,
            "candidateScorecards": candidate_scorecards,
            **policy_update_fields,
            "ranking": data.get("ranking"),
            "warnings": data.get("warnings"),
            "simulation": data.get("simulation"),
            "scaleValidation": scale_validation,
        }

    def describe_asg_group_summary(self) -> dict[str, Any]:
        data = self.tccli(
            "describe_asg_group",
            "as", "DescribeAutoScalingGroups",
            "--region", self.args.region,
            "--AutoScalingGroupIds", json.dumps([self.args.asg_id]),
            timeout=90,
        )
        groups = data.get("AutoScalingGroupSet") or []
        if not groups:
            return {}
        group = groups[0]
        return {
            "DesiredCapacity": group.get("DesiredCapacity"),
            "InstanceCount": group.get("InstanceCount"),
            "InServiceInstanceCount": group.get("InServiceInstanceCount"),
            "InActivityStatus": group.get("InActivityStatus"),
            "AutoScalingGroupStatus": group.get("AutoScalingGroupStatus"),
        }

    def scale_down(self) -> None:
        started = time.time()
        cp: subprocess.CompletedProcess[str] | None = None
        ok = False
        try:
            cp = subprocess.run(
                [str(self.tccLI), "as", "ModifyDesiredCapacity", "--region", self.args.region, "--AutoScalingGroupId", self.args.asg_id, "--DesiredCapacity", "0", "--output", "json"],
                text=True,
                capture_output=True,
                timeout=90,
                check=False,
            )
            last_seen: dict[str, Any] = {}
            if cp.returncode != 0:
                raise BatchRunError(f"scale_down failed with exit {cp.returncode}: {tail_text(cp.stderr or cp.stdout)}")
            deadline = time.time() + self.args.scale_down_timeout_seconds
            while time.time() < deadline:
                try:
                    group = self.describe_asg_group_summary()
                except Exception as error:
                    group = {"error": type(error).__name__ + ": " + str(error)}
                try:
                    instances = self.describe_asg_instances()
                except Exception as error:
                    instances = [{"error": type(error).__name__ + ": " + str(error)}]
                last_seen = {"group": group, "asgInstances": instances}
                group_error = isinstance(group, dict) and "error" in group
                instance_errors = [item for item in instances if isinstance(item, dict) and "error" in item]
                if (
                    not group_error
                    and not instance_errors
                    and not instances
                    and group.get("InstanceCount") in (0, None)
                    and group.get("InActivityStatus") in (None, "NOT_IN_ACTIVITY")
                ):
                    ok = True
                    break
                time.sleep(15)
            self.result["scaleDownLastSeen"] = last_seen
            if not ok:
                summary = tail_text(canonical_json(last_seen), 1200) if last_seen else "no ASG state observed"
                failure_reason = f"scale_down timeout: ASG still has instances/activity or describe errors; last_seen={summary}"
                self.result["scaleDownFailureReason"] = failure_reason
                raise BatchRunError(failure_reason)
        finally:
            self.record_step("scale_down", started, ok, cp, desiredCapacity=0)


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def default_run_id(command: str = "run-single") -> str:
    prefix = "tencent-preflight-" if command == "preflight" else "tencent-single-"
    return prefix + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dt%H%M%sz")


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def tail_text(raw: str | None, limit: int = 3000) -> str:
    if not raw:
        return ""
    text = raw.replace("\r", "")
    return text[-limit:]


def decode_subprocess_text(raw: str | bytes | None) -> str:
    if not raw:
        return ""
    return raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw


def sanitize_known_hosts_cleanup_text(raw: str | bytes | None) -> str:
    if not raw:
        return ""
    text = decode_subprocess_text(raw)
    text = text.replace("\r", "")
    text = HOST_KEY_BLOB_RE.sub("[REDACTED_HOST_KEY]", text)

    def redact_secret(match: re.Match[str]) -> str:
        key, _value = match.group(0).split("=", 1)
        return f"{key}=[REDACTED]"

    return SECRET_ASSIGNMENT_RE.sub(redact_secret, text)


def redacted_argv(argv: Sequence[str]) -> list[str]:
    redacted: list[str] = []
    skip_next = False
    secret_flags = {"--secretId", "--secretKey", "--token"}
    for item in argv:
        if skip_next:
            redacted.append("[REDACTED]")
            skip_next = False
            continue
        redacted.append(item)
        if item in secret_flags:
            skip_next = True
    return redacted


def unwrap_response(data: Any) -> dict[str, Any]:
    if isinstance(data, dict) and isinstance(data.get("Response"), dict):
        return data["Response"]
    if isinstance(data, dict):
        return data
    return {}


def controller_execution_summary(
    args: argparse.Namespace,
    steps: Sequence[StepRecord],
    result: dict[str, Any],
    scaled_up: bool,
    instance_id: str | None,
) -> dict[str, Any]:
    step_names = {step.name for step in steps}
    training_report = result.get("trainingReport")
    training_report_data = training_report if isinstance(training_report, dict) else {}
    training_report_produced = bool(
        training_report_data.get("path")
        or training_report_data.get("reportId")
        or training_report_data.get("artifactCount")
    )
    scale_out_attempted = scaled_up or "scale_up" in step_names or instance_id is not None
    remote_training_attempted = "remote_training" in step_names
    compute_attempted = scale_out_attempted or remote_training_attempted or training_report_produced
    environments_run = training_environments_run(training_report_data)
    preflight_only = bool(getattr(args, "preflight_only", False))
    return {
        "command": getattr(args, "command", None),
        "mode": "preflight" if preflight_only else "compute",
        "preflightOnly": preflight_only,
        "computeAttempted": compute_attempted,
        "scaleOutAttempted": scale_out_attempted,
        "remoteTrainingAttempted": remote_training_attempted,
        "trainingReportProduced": training_report_produced,
        "trainingReportPath": training_report_data.get("path"),
        "trainingReportId": training_report_data.get("reportId"),
        "artifactCount": training_report_data.get("artifactCount"),
        "environmentsRun": environments_run,
    }


def controller_batch_scale_summary(
    args: argparse.Namespace,
    steps: Sequence[StepRecord],
    result: dict[str, Any],
) -> dict[str, Any]:
    training_report = result.get("trainingReport")
    report_data = training_report if isinstance(training_report, dict) else {}
    report_scale = dict_value(report_data.get("batchScale"))
    planned_scale = planned_batch_scale_from_args(args)
    basis = "training_report" if report_scale is not None else "requested_inputs"
    source = report_scale or planned_scale
    environment_rows = scale_gates.non_negative_int(source.get("environmentRows")) or 0
    simulator_ticks = scale_gates.non_negative_int(source.get("simulatorTicks")) or 0
    wall_seconds = remote_training_wall_seconds(steps)
    if wall_seconds is None:
        wall_seconds = scale_gates.non_negative_float(source.get("wallClockSeconds"))
    cost_estimate = cost_estimate_from_result(result)
    if cost_estimate is None:
        cost_estimate = source.get("costEstimate")
    return scale_gates.build_batch_scale_summary(
        environment_rows=environment_rows,
        simulator_ticks=simulator_ticks,
        wall_clock_seconds=wall_seconds,
        asg_active_seconds=asg_active_seconds(steps),
        cost_estimate=cost_estimate,
        basis=basis,
    )


def controller_timeout_summary(args: argparse.Namespace) -> dict[str, int]:
    timeouts = {
        "scaleTimeoutSeconds": max(0, int(getattr(args, "scale_timeout_seconds", 0) or 0)),
        "scaleDownTimeoutSeconds": max(0, int(getattr(args, "scale_down_timeout_seconds", 0) or 0)),
        "bootstrapTimeoutSeconds": max(0, int(getattr(args, "bootstrap_timeout_seconds", 0) or 0)),
        "trainingTimeoutSeconds": max(0, int(getattr(args, "training_timeout_seconds", 0) or 0)),
        "transferTimeoutSeconds": max(0, int(getattr(args, "transfer_timeout_seconds", 0) or 0)),
    }
    timeouts["totalSeconds"] = sum(timeouts.values())
    return timeouts


def planned_batch_scale_from_args(args: argparse.Namespace) -> dict[str, Any]:
    repetitions = max(1, int(getattr(args, "repetitions", 1) or 1))
    environment_count = resolve_scale_environment_count(args)
    if environment_count is None:
        environment_count = max(1, int(getattr(args, "workers", 1) or 1))
    environment_rows = environment_count * repetitions
    return scale_gates.build_batch_scale_summary(
        environment_rows=environment_rows,
        simulator_ticks=environment_rows * effective_training_ticks(args),
        basis="requested_inputs",
    )


def batch_scale_summary_from_training_report(
    data: dict[str, Any],
    artifact_count: int,
) -> dict[str, Any]:
    raw_batch_scale = dict_value(data.get("batchScale"))
    environment_rows = (
        scale_gates.non_negative_int(path_value(raw_batch_scale, "environmentRows"))
        if raw_batch_scale is not None
        else None
    )
    simulator_ticks = (
        scale_gates.non_negative_int(path_value(raw_batch_scale, "simulatorTicks"))
        if raw_batch_scale is not None
        else None
    )
    wall_seconds = (
        scale_gates.non_negative_float(path_value(raw_batch_scale, "wallClockSeconds"))
        if raw_batch_scale is not None
        else None
    )
    if environment_rows is None:
        environment_rows = artifact_count
    if simulator_ticks is None:
        simulator_ticks = training_report_simulator_ticks(data, environment_rows)
    return scale_gates.build_batch_scale_summary(
        environment_rows=environment_rows,
        simulator_ticks=simulator_ticks,
        wall_clock_seconds=wall_seconds,
        basis="training_report",
    )


def training_report_simulator_ticks(data: dict[str, Any], environment_rows: int) -> int:
    total = 0
    for result in list_value(data.get("variantResults")):
        if not isinstance(result, dict):
            continue
        for run in list_value(result.get("runs")):
            if not isinstance(run, dict):
                continue
            total += scale_gates.non_negative_int(run.get("ticksRun", run.get("ticks_run"))) or 0
    if total > 0:
        return total
    ticks_per_row = scale_gates.non_negative_int(path_value(data, "simulation", "ticks")) or 0
    return environment_rows * ticks_per_row


def remote_training_wall_seconds(steps: Sequence[StepRecord]) -> float | None:
    durations = [
        duration
        for step in steps
        if step.name == "remote_training"
        for duration in [step_duration_seconds(step)]
        if duration is not None
    ]
    return sum(durations) if durations else None


def asg_active_seconds(steps: Sequence[StepRecord]) -> float | None:
    starts = [
        value
        for step in steps
        if step.name == "scale_up"
        for value in [parse_iso_epoch(step.started_at)]
        if value is not None
    ]
    ends = [
        value
        for step in steps
        if step.name == "scale_down"
        for value in [parse_iso_epoch(step.ended_at)]
        if value is not None
    ]
    if not starts or not ends:
        return None
    active = max(ends) - min(starts)
    return active if active >= 0 else None


def step_duration_seconds(step: StepRecord) -> float | None:
    started = parse_iso_epoch(step.started_at)
    ended = parse_iso_epoch(step.ended_at)
    if started is None or ended is None:
        return None
    duration = ended - started
    return duration if duration >= 0 else None


def parse_iso_epoch(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def cost_estimate_from_result(result: dict[str, Any]) -> Any | None:
    guard = dict_value(result.get("billingGuard"))
    if guard is None:
        return None
    for path in (
        ("costEstimate",),
        ("cost_estimate",),
        ("estimatedCost",),
        ("estimated_cost",),
        ("estimatedCostUsd",),
        ("estimatedCostCny",),
        ("maxCostUsd",),
        ("max_cost_usd",),
    ):
        value = path_value(guard, *path)
        if value is not None:
            return value
    return None


def training_environments_run(training_report: dict[str, Any]) -> int:
    scale_validation = training_report.get("scaleValidation")
    if isinstance(scale_validation, dict):
        for key in ("totalEnvironments", "successfulEnvironments"):
            value = scale_validation.get(key)
            if isinstance(value, int) and value >= 0:
                return value
    artifact_count = training_report.get("artifactCount")
    if isinstance(artifact_count, int) and artifact_count >= 0:
        return artifact_count
    return 0


def remote_training_report_path(artifact_dir: Path, run_id: str) -> Path:
    return artifact_dir / "remote" / "runtime-artifacts" / "rl-training" / f"{run_id}.json"


def build_e1s1_repeat_launch_guard(
    *,
    args: argparse.Namespace,
    run_id: str,
    artifact_dir: Path,
) -> dict[str, Any]:
    current_launch = e1s1_repeat_guard_current_launch(args)
    evidence_runs = (
        recent_e1s1_dead_tier_evidence(args, artifact_dir)
        if current_launch["isE1S1SingleRoomNoHostile"]
        else []
    )
    blocked = len(evidence_runs) >= E1S1_REPEAT_GUARD_MIN_COMPLETED_RUNS
    reason = None
    if blocked:
        reason = (
            "recent completed 500-tick Tencent E1S1 single-room no-hostile runs "
            "show territory=2 and kills=0 for every reported variant"
        )
    return {
        "type": E1S1_REPEAT_GUARD_TYPE,
        "schemaVersion": 1,
        "runId": run_id,
        "checkedAt": utc_now_iso(),
        "status": "blocked" if blocked else "clear",
        "blocked": blocked,
        "reason": reason,
        "nextAction": E1S1_REPEAT_GUARD_NEXT_ACTION if blocked else None,
        "currentLaunch": current_launch,
        "evidence": {
            "threshold": E1S1_REPEAT_GUARD_MIN_COMPLETED_RUNS,
            "count": len(evidence_runs),
            "recentSummaryLimit": E1S1_REPEAT_GUARD_RECENT_SUMMARY_LIMIT,
            "runs": evidence_runs,
        },
        "safety": {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "secretsPrinted": False,
            "remoteExecutionAttempted": False,
            "scaleOutAttempted": False,
        },
    }


def e1s1_repeat_guard_current_launch(args: argparse.Namespace) -> dict[str, Any]:
    scenario_id = scenario_id_from_args(args)
    current_launch = {
        "scenarioId": scenario_id,
        "isE1S1SingleRoomNoHostile": scenario_id == DEFAULT_SCENARIO_ID,
        "requiredScenarioId": MULTI_TIER_SCENARIO_ID,
        "requireMultiTierScenario": require_multi_tier_scenario_from_args(args, scenario_id),
        "requestedTicks": getattr(args, "ticks", None),
        "effectiveTicks": effective_training_ticks(args),
        "trainingApproach": getattr(args, "training_approach", None),
        "workers": getattr(args, "workers", None),
        "repetitions": getattr(args, "repetitions", None),
        "preflightOnly": bool(getattr(args, "preflight_only", False)),
        "mapSourceFile": scenario_map_source_file(scenario_id),
        "room": scenario_anchor_room(scenario_id),
    }
    if scenario_id == MULTI_TIER_SCENARIO_ID:
        current_launch["fixtureEvidence"] = multi_tier_launch_fixture_evidence()
    return current_launch


def recent_e1s1_dead_tier_evidence(args: argparse.Namespace, artifact_dir: Path) -> list[dict[str, Any]]:
    artifact_root = resolved_artifact_root(args)
    if not artifact_root.is_dir():
        return []
    current_dir = artifact_dir.resolve()
    try:
        summary_paths = sorted(
            artifact_root.glob("*/controller-summary.json"),
            key=lambda path: (path.stat().st_mtime, path.as_posix()),
            reverse=True,
        )
    except OSError:
        return []
    evidence: list[dict[str, Any]] = []
    for summary_path in summary_paths:
        try:
            if summary_path.parent.resolve() == current_dir:
                continue
        except OSError:
            continue
        summary = read_json_object(summary_path)
        item = e1s1_dead_tier_evidence_from_summary(summary, summary_path)
        if item is not None:
            evidence.append(item)
            if len(evidence) >= E1S1_REPEAT_GUARD_RECENT_SUMMARY_LIMIT:
                break
    return evidence


def resolved_artifact_root(args: argparse.Namespace) -> Path:
    return (REPO_ROOT / Path(getattr(args, "artifact_root", DEFAULT_ARTIFACT_ROOT))).resolve()


def read_json_object(path: Path) -> dict[str, Any] | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return raw if isinstance(raw, dict) else None


def e1s1_dead_tier_evidence_from_summary(
    summary: dict[str, Any] | None,
    summary_path: Path,
) -> dict[str, Any] | None:
    if not isinstance(summary, dict):
        return None
    final_status = summary.get("finalStatus")
    if not isinstance(final_status, str) or not final_status.startswith("completed"):
        return None
    run_id = text_value(summary.get("runId")) or summary_path.parent.name
    report, report_path = load_collected_training_report(summary, summary_path.parent, run_id)
    reports = [source for source in (report, dict_value(path_value(summary, "outputs", "trainingReport"))) if source]
    if not summary_matches_e1s1_single_room_no_hostile(summary, reports):
        return None
    ticks = extract_completed_run_ticks(summary, reports)
    if ticks is None or ticks < POLICY_GRADIENT_MIN_SIMULATION_TICKS:
        return None
    metric = extract_dead_tier_metric(reports)
    if metric is None:
        return None
    return {
        "runId": run_id,
        "summaryPath": str(summary_path),
        "reportPath": str(report_path) if report_path is not None else None,
        "finishedAt": text_value(summary.get("finishedAt")),
        "finalStatus": final_status,
        "ticks": ticks,
        "scenarioId": extract_scenario_id(summary, reports),
        "mapSourceFile": extract_map_source_file(reports),
        "territory": metric["territory"],
        "kills": metric["kills"],
        "metricPairCount": metric["metricPairCount"],
    }


def load_collected_training_report(
    summary: dict[str, Any],
    run_dir: Path,
    run_id: str,
) -> tuple[dict[str, Any] | None, Path | None]:
    candidate_paths: list[Path] = [remote_training_report_path(run_dir, run_id)]
    report_path = path_value(summary, "outputs", "trainingReport", "path")
    if isinstance(report_path, str) and report_path:
        raw = Path(report_path)
        candidate_paths.append(raw if raw.is_absolute() else run_dir / raw)
        candidate_paths.append(REPO_ROOT / raw)
    seen: set[Path] = set()
    for path in candidate_paths:
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if not resolved.is_file():
            continue
        payload = read_json_object(resolved)
        if payload is not None:
            return payload, resolved
    return None, None


def summary_matches_e1s1_single_room_no_hostile(
    summary: dict[str, Any],
    reports: Sequence[dict[str, Any]],
) -> bool:
    scenario_id = extract_scenario_id(summary, reports)
    if scenario_id is not None and scenario_id != DEFAULT_SCENARIO_ID:
        return False
    scenario = first_dict(reports, (("scenario",), ("experimentCard", "scenario")))
    if scenario is not None and not scenario_is_e1s1_single_room_no_hostile(scenario):
        return False
    if scenario_id is None and scenario is None:
        return False
    room = extract_training_room(reports)
    if room != "E1S1":
        return False
    map_source_file = extract_map_source_file(reports)
    if map_source_file is None or Path(map_source_file).name != "map-0b6758af.json":
        return False
    return True


def scenario_is_e1s1_single_room_no_hostile(scenario: dict[str, Any]) -> bool:
    scenario_id = text_value(scenario.get("scenario_id")) or text_value(scenario.get("scenarioId"))
    if scenario_id is not None and scenario_id != DEFAULT_SCENARIO_ID:
        return False
    capabilities = scenario.get("capabilities")
    if isinstance(capabilities, dict):
        if capabilities.get("multi_room_capable") is True:
            return False
        if capabilities.get("hostile_combat_signal") is True:
            return False
    evidence = scenario.get("evidence")
    if isinstance(evidence, dict):
        room_count = numeric_value(evidence.get("room_count", evidence.get("roomCount")))
        if room_count is not None and room_count != 1:
            return False
        hostile_fixture = text_value(evidence.get("hostile_fixture")) or text_value(evidence.get("hostileFixture"))
        if hostile_fixture is not None and hostile_fixture.lower() not in {"none", "no-hostile", "no_hostile"}:
            return False
    return scenario_id == DEFAULT_SCENARIO_ID


def extract_scenario_id(summary: dict[str, Any], reports: Sequence[dict[str, Any]]) -> str | None:
    return (
        text_value(path_value(summary, "inputs", "scenarioId"))
        or first_text(reports, (("scenario", "scenario_id"), ("scenario", "scenarioId")))
        or first_text(reports, (("experimentCard", "scenario", "scenario_id"), ("experimentCard", "scenario", "scenarioId")))
    )


def extract_training_room(reports: Sequence[dict[str, Any]]) -> str | None:
    return first_text(
        reports,
        (
            ("simulation", "room"),
            ("source", "initialConditions", "room"),
            ("experimentCard", "simulation", "room"),
            ("scenario", "evidence", "anchor_room"),
            ("scenario", "evidence", "anchorRoom"),
            ("scenario", "evidence", "room"),
            ("experimentCard", "scenario", "evidence", "anchor_room"),
            ("experimentCard", "scenario", "evidence", "anchorRoom"),
            ("experimentCard", "scenario", "evidence", "room"),
        ),
    )


def extract_map_source_file(reports: Sequence[dict[str, Any]]) -> str | None:
    return first_text(
        reports,
        (
            ("simulation", "mapSourceFile"),
            ("simulation", "map_source_file"),
            ("source", "initialConditions", "mapSourceFile"),
            ("experimentCard", "simulation", "mapSourceFile"),
            ("experimentCard", "simulation", "map_source_file"),
            ("scenario", "evidence", "map_source_file"),
            ("scenario", "evidence", "mapSourceFile"),
            ("experimentCard", "scenario", "evidence", "map_source_file"),
            ("experimentCard", "scenario", "evidence", "mapSourceFile"),
        ),
    )


def extract_completed_run_ticks(summary: dict[str, Any], reports: Sequence[dict[str, Any]]) -> int | None:
    raw = (
        path_value(summary, "inputs", "ticks")
        or first_value(reports, (("simulation", "ticks"), ("source", "initialConditions", "ticks")))
    )
    value = numeric_value(raw)
    return int(value) if value is not None and value == int(value) else None


def extract_dead_tier_metric(reports: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    for field in ("variantResults", "ranking"):
        pairs = [
            pair
            for report in reports
            for pair in reward_tuple_metric_pairs(list_value(report.get(field)), report)
        ]
        if not pairs:
            continue
        if not all(dead_tier_pair(pair) for pair in pairs):
            return None
        return {
            "territory": E1S1_REPEAT_GUARD_DEAD_TERRITORY,
            "kills": E1S1_REPEAT_GUARD_DEAD_KILLS,
            "metricPairCount": len(pairs),
        }
    kpi_pairs = [
        (territory, kills)
        for report in reports
        for territory, kills in [(
            numeric_value(path_value(report, "kpiSummary", "territory", "score")),
            numeric_value(path_value(report, "kpiSummary", "kills", "score")),
        )]
        if territory is not None and kills is not None
    ]
    if kpi_pairs and all(dead_tier_pair(pair) for pair in kpi_pairs):
        return {
            "territory": E1S1_REPEAT_GUARD_DEAD_TERRITORY,
            "kills": E1S1_REPEAT_GUARD_DEAD_KILLS,
            "metricPairCount": len(kpi_pairs),
        }
    return None


def reward_tuple_metric_pairs(items: Sequence[Any], report: dict[str, Any]) -> list[tuple[float, float]]:
    component_order = reward_component_order(report)
    pairs: list[tuple[float, float]] = []
    for item in items:
        raw_tuple = reward_tuple_from_item(item)
        pair = reward_tuple_pair(raw_tuple, component_order)
        if pair is not None:
            pairs.append(pair)
    return pairs


def reward_component_order(report: dict[str, Any]) -> tuple[str, ...]:
    raw = path_value(report, "rewardModel", "componentOrder") or path_value(report, "reward_model", "component_order")
    if isinstance(raw, list) and all(isinstance(item, str) for item in raw):
        normalized = tuple(item.strip() for item in raw)
        if "territory" in normalized and "kills" in normalized:
            return normalized
    return REWARD_TIER_ORDER


def reward_tuple_from_item(item: Any) -> Any:
    if isinstance(item, list):
        return item
    if not isinstance(item, dict):
        return None
    for key in ("rewardTuple", "reward_tuple"):
        if key in item:
            return item.get(key)
    reward = item.get("reward")
    if isinstance(reward, dict):
        for key in ("tuple", "rewardTuple", "reward_tuple"):
            if key in reward:
                return reward.get(key)
    return None


def reward_tuple_pair(raw_tuple: Any, component_order: Sequence[str]) -> tuple[float, float] | None:
    if not isinstance(raw_tuple, list):
        return None
    try:
        territory_index = list(component_order).index("territory")
        kills_index = list(component_order).index("kills")
    except ValueError:
        return None
    if len(raw_tuple) <= max(territory_index, kills_index):
        return None
    territory = numeric_value(raw_tuple[territory_index])
    kills = numeric_value(raw_tuple[kills_index])
    if territory is None or kills is None:
        return None
    return territory, kills


def dead_tier_pair(pair: tuple[float, float]) -> bool:
    territory, kills = pair
    return (
        abs(territory - E1S1_REPEAT_GUARD_DEAD_TERRITORY) < 1e-9
        and abs(kills - E1S1_REPEAT_GUARD_DEAD_KILLS) < 1e-9
    )


def path_value(raw: Any, *path: str) -> Any:
    value = raw
    for key in path:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def first_value(reports: Sequence[dict[str, Any]], paths: Sequence[Sequence[str]]) -> Any:
    for report in reports:
        for path in paths:
            value = path_value(report, *path)
            if value is not None:
                return value
    return None


def first_text(reports: Sequence[dict[str, Any]], paths: Sequence[Sequence[str]]) -> str | None:
    return text_value(first_value(reports, paths))


def first_dict(reports: Sequence[dict[str, Any]], paths: Sequence[Sequence[str]]) -> dict[str, Any] | None:
    return dict_value(first_value(reports, paths))


def dict_value(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def list_value(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def text_value(value: Any) -> str | None:
    if isinstance(value, str) and value:
        return value
    return None


def numeric_value(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def port_includes_ssh(port: Any) -> bool:
    if port is None:
        return True
    text = str(port).strip().lower()
    if text in {"", "all", "any", "-1"}:
        return True
    for token in re.split(r"[\s,;]+", text):
        if not token:
            continue
        if token == "22":
            return True
        if "-" in token:
            start, end = token.split("-", 1)
            if start.isdigit() and end.isdigit() and int(start) <= 22 <= int(end):
                return True
    return False


def protocol_includes_tcp(protocol: Any) -> bool:
    text = str(protocol or "").strip().lower()
    return text in {"", "tcp", "all", "any", "-1"}


def rule_action_allows(rule: dict[str, Any]) -> bool:
    action = str(rule.get("Action", "ACCEPT")).strip().upper()
    return action in {"", "ACCEPT", "ALLOW"}


def sg_rule_allows_ssh(rule: dict[str, Any]) -> bool:
    return rule_action_allows(rule) and protocol_includes_tcp(rule.get("Protocol")) and port_includes_ssh(rule.get("Port"))


def sg_rule_sources(rule: dict[str, Any]) -> list[str]:
    sources: list[str] = []
    for key in ("CidrBlock", "Ipv6CidrBlock", "SourceCidrIp", "SourceCidrIpv6"):
        value = rule.get(key)
        if value:
            sources.append(str(value).strip())
    return sources or ["<unspecified>"]


def validate_controller_only_sg_ssh_ingress(ingress: Sequence[Any], controller_ip: str) -> list[dict[str, Any]]:
    ssh_rules = [rule for rule in ingress if isinstance(rule, dict) and sg_rule_allows_ssh(rule)]
    bad = [rule for rule in ssh_rules if set(sg_rule_sources(rule)) != {controller_ip}]
    if bad or len(ssh_rules) != 1:
        raise BatchRunError(f"security group SSH ingress is not controller-only: {ssh_rules}")
    return ssh_rules


def extract_iptables_input_rules(output: str) -> list[str]:
    iptables_line = ""
    for line in output.splitlines():
        if line.startswith("iptables_filter="):
            iptables_line = line.removeprefix("iptables_filter=")
            break
    for line in output.splitlines():
        if line.startswith("iptables="):
            iptables_line = line.removeprefix("iptables=")
            break
    source = iptables_line or output
    return [rule.strip() for rule in re.split(r"[;\n]+", source) if rule.strip()]


def token_value(tokens: Sequence[str], *names: str) -> str | None:
    for index, token in enumerate(tokens[:-1]):
        if token in names:
            return tokens[index + 1]
    return None


def token_index(tokens: Sequence[str], *names: str) -> int | None:
    for index, token in enumerate(tokens[:-1]):
        if token in names:
            return index
    return None


def iptables_jump(tokens: Sequence[str]) -> str | None:
    value = token_value(tokens, "-j", "--jump")
    return value if value else None


def iptables_source(tokens: Sequence[str]) -> str | None:
    return token_value(tokens, "-s", "--source")


def iptables_source_is_negated(tokens: Sequence[str]) -> bool:
    index = token_index(tokens, "-s", "--source")
    return index is not None and index > 0 and tokens[index - 1] == "!"


def iptables_chain_rule_tokens(rule: str) -> tuple[str, list[str]] | None:
    try:
        tokens = shlex.split(rule)
    except ValueError:
        return None
    if len(tokens) < 3 or tokens[0] not in {"-A", "-I"}:
        return None
    return tokens[1], tokens


def iptables_input_rule_tokens(rule: str) -> list[str] | None:
    parsed = iptables_chain_rule_tokens(rule)
    if parsed is None:
        return None
    chain, tokens = parsed
    if chain != "INPUT":
        return None
    return tokens


def iptables_policy(tokens: Sequence[str]) -> str | None:
    if len(tokens) >= 3 and tokens[0] == "-P" and tokens[1] == "INPUT":
        return tokens[2].upper()
    return None


def iptables_save_chain_policy(rule: str) -> tuple[str, str] | None:
    try:
        tokens = shlex.split(rule)
    except ValueError:
        return None
    if len(tokens) >= 2 and tokens[0].startswith(":"):
        return tokens[0][1:], tokens[1].upper()
    return None


def iptables_rule_permits_new_ssh(tokens: Sequence[str]) -> bool:
    if token_value(tokens, "-i", "--in-interface") == "lo":
        return False
    ctstate = token_value(tokens, "--ctstate", "--state")
    if ctstate:
        states = {state.strip().upper() for state in ctstate.split(",")}
        if "NEW" not in states and states & {"ESTABLISHED", "RELATED"}:
            return False
    if not protocol_includes_tcp(token_value(tokens, "-p", "--protocol")):
        return False
    ports = [
        tokens[index + 1]
        for index, token in enumerate(tokens[:-1])
        if token in {"--dport", "--destination-port", "--dports", "--destination-ports"}
    ]
    return any(port_includes_ssh(port) for port in ports) if ports else True


def build_iptables_filter_model(rules: Sequence[str]) -> tuple[dict[str, str], dict[str, list[tuple[str, list[str]]]]]:
    policies: dict[str, str] = {}
    chains: dict[str, list[tuple[str, list[str]]]] = {}
    for rule in rules:
        if rule in {"*filter", "COMMIT"} or rule.startswith("#"):
            continue
        try:
            tokens = shlex.split(rule)
        except ValueError:
            raise BatchRunError(f"worker iptables rule is not parseable: {rule}") from None
        policy = iptables_policy(tokens)
        if policy is not None:
            policies[tokens[1]] = policy
            continue
        save_policy = iptables_save_chain_policy(rule)
        if save_policy is not None:
            chain, chain_policy = save_policy
            chains.setdefault(chain, [])
            if chain_policy != "-":
                policies[chain] = chain_policy
            continue
        parsed = iptables_chain_rule_tokens(rule)
        if parsed is None:
            continue
        chain, rule_tokens = parsed
        chains.setdefault(chain, []).append((rule, rule_tokens))
    return policies, chains


def narrowed_ssh_source_scope(current_scope: str, tokens: Sequence[str], controller_ip: str) -> str:
    if current_scope == "controller":
        return "controller"
    source = iptables_source(tokens)
    if source == controller_ip and not iptables_source_is_negated(tokens):
        return "controller"
    return "broad"


def validate_controller_only_worker_ssh(output: str, controller_ip: str) -> None:
    rules = extract_iptables_input_rules(output)
    if not rules:
        raise BatchRunError("worker iptables output is empty")
    policies, chains = build_iptables_filter_model(rules)
    controller_accepts: list[str] = []
    broad_accepts: list[str] = []
    has_ssh_closure = False

    def visit_chain(chain: str, source_scope: str, stack: tuple[str, ...]) -> None:
        nonlocal has_ssh_closure
        if chain in stack:
            return
        for rule, tokens in chains.get(chain, []):
            if not iptables_rule_permits_new_ssh(tokens):
                continue
            jump = iptables_jump(tokens)
            if not jump:
                continue
            next_scope = narrowed_ssh_source_scope(source_scope, tokens, controller_ip)
            jump_upper = jump.upper()
            if jump_upper == "ACCEPT":
                if next_scope == "controller":
                    controller_accepts.append(rule)
                else:
                    broad_accepts.append(rule)
            elif jump_upper in {"DROP", "REJECT"}:
                if next_scope == "broad":
                    has_ssh_closure = True
            elif jump_upper == "RETURN":
                continue
            elif jump in chains:
                visit_chain(jump, next_scope, (*stack, chain))

    visit_chain("INPUT", "broad", ())
    if policies.get("INPUT") in {"DROP", "REJECT"}:
        has_ssh_closure = True
    if not controller_accepts or broad_accepts or not has_ssh_closure:
        raise BatchRunError(
            "worker SSH ingress is not controller-only: "
            + json.dumps({"controllerAccepts": controller_accepts, "broadAccepts": broad_accepts, "hasSshClosure": has_ssh_closure}, sort_keys=True)
        )


def validate_tar_member(member: tarfile.TarInfo, extract_dir: Path) -> Path:
    if member.issym() or member.islnk() or member.isdev():
        raise BatchRunError(f"refusing unsafe archive member type: {member.name}")
    if not member.isdir() and not member.isfile():
        raise BatchRunError(f"refusing unsupported archive member type: {member.name}")
    member_path = Path(member.name)
    if member_path.is_absolute() or ".." in member_path.parts:
        raise BatchRunError(f"refusing archive traversal entry: {member.name}")
    base = extract_dir.resolve()
    target = (base / member.name).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        raise BatchRunError(f"refusing archive entry outside extraction dir: {member.name}") from None
    return target


def safe_extract_tar(tar_path: Path, extract_dir: Path) -> None:
    with tarfile.open(tar_path, "r:gz") as tar:
        members = tar.getmembers()
        targets = [(member, validate_tar_member(member, extract_dir)) for member in members]
        for member, target in targets:
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            source = tar.extractfile(member)
            if source is None:
                raise BatchRunError(f"archive member is not readable: {member.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with source, target.open("wb") as out:
                shutil.copyfileobj(source, out)


def validated_remote_policy_update(raw: Any, top_level_safety: dict[str, Any]) -> Any:
    unsafe = unsafe_policy_update_safety_flags(raw, "policyUpdate", top_level_safety)
    if unsafe:
        raise BatchRunError("remote policyUpdate safety flags are unsafe: " + "; ".join(unsafe))
    return copy.deepcopy(raw)


def remote_policy_update_gradient_fields(
    data: dict[str, Any],
    policy_update: Any,
) -> dict[str, Any]:
    source = policy_update if isinstance(policy_update, dict) else {}
    fields: dict[str, Any] = {}
    for key in ("gradientStable", "trustedGradientUpdate", "highVariance"):
        value = data.get(key) if key in data else source.get(key)
        if isinstance(value, bool):
            fields[key] = value
    for key in ("gradientEstimation", "gradientMomentum", "gradientStability"):
        value = data.get(key) if isinstance(data.get(key), dict) else source.get(key)
        if isinstance(value, dict):
            fields[key] = copy.deepcopy(value)
    return fields


def verified_remote_policy_update_fields(
    data: dict[str, Any],
    top_level_safety: dict[str, Any],
    artifact_dir: Path,
    *,
    runtime_parameter_injection: dict[str, Any] | None = None,
) -> dict[str, Any]:
    iterations = policy_update_iterations(data.get("policyUpdateIterations"), "policyUpdateIterations")
    safe_policy_update = validated_remote_policy_update(data.get("policyUpdate"), top_level_safety)
    raw_artifact_path = data.get("policyUpdateArtifactPath")
    update_iterations = 0
    if isinstance(safe_policy_update, dict) and "iterations" in safe_policy_update:
        update_iterations = policy_update_iterations(safe_policy_update.get("iterations"), "policyUpdate.iterations")
    if iterations <= 0 and update_iterations <= 0:
        if raw_artifact_path is not None:
            raise BatchRunError("remote policyUpdateArtifactPath is present without positive policyUpdateIterations")
        if safe_policy_update in (None, {}, []):
            return {
                "policyUpdateIterations": iterations,
                "policyUpdateArtifactPath": None,
                "policyUpdate": None,
                **remote_policy_update_gradient_fields(data, safe_policy_update),
            }
        if is_safe_zero_iteration_policy_update(safe_policy_update):
            return {
                "policyUpdateIterations": iterations,
                "policyUpdateArtifactPath": None,
                "policyUpdate": safe_policy_update,
                **remote_policy_update_gradient_fields(data, safe_policy_update),
            }
        raise BatchRunError("remote policyUpdate is present without positive policyUpdateIterations")
    if iterations <= 0:
        raise BatchRunError("remote policyUpdateIterations must be positive when policyUpdate claims an update")

    validate_positive_policy_update(
        safe_policy_update,
        runtime_parameter_injection=runtime_parameter_injection,
    )
    nested_iterations = policy_update_iterations(safe_policy_update.get("iterations"), "policyUpdate.iterations")
    if nested_iterations != iterations:
        raise BatchRunError(
            "remote policyUpdate.iterations disagrees with policyUpdateIterations: "
            f"{nested_iterations} != {iterations}"
        )
    rel_artifact_path = safe_policy_update_artifact_path(raw_artifact_path)
    if "artifactPath" in safe_policy_update:
        nested_artifact_path = safe_policy_update_artifact_path(
            safe_policy_update.get("artifactPath"),
            "policyUpdate.artifactPath",
        )
        if nested_artifact_path != rel_artifact_path:
            raise BatchRunError(
                "remote policyUpdate.artifactPath disagrees with policyUpdateArtifactPath: "
                f"{nested_artifact_path.as_posix()} != {rel_artifact_path.as_posix()}"
            )
    local_artifact_path = collected_remote_policy_update_artifact_path(artifact_dir, rel_artifact_path)
    if not local_artifact_path.is_file():
        raise BatchRunError(f"remote policy update artifact was not collected: {rel_artifact_path.as_posix()}")
    updated_parameters = safe_policy_update.get("updatedParameters")
    if not isinstance(updated_parameters, dict):
        raise BatchRunError("remote policyUpdate.updatedParameters must be an object when policyUpdateIterations is positive")
    validate_collected_policy_update_artifact_parameters(
        local_artifact_path,
        rel_artifact_path,
        updated_parameters,
        safe_policy_update.get("promotionGate"),
    )
    return {
        "policyUpdateIterations": iterations,
        "policyUpdateArtifactPath": rel_artifact_path.as_posix(),
        "policyUpdatePromotionGate": copy.deepcopy(safe_policy_update.get("promotionGate")),
        "policyUpdate": safe_policy_update,
        **remote_policy_update_gradient_fields(data, safe_policy_update),
    }


def verified_remote_runtime_parameter_injection(raw: Any) -> dict[str, Any] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise BatchRunError("remote runtimeParameterInjection must be an object when present")
    require_explicit_false_fields(raw, "runtimeParameterInjection", POSITIVE_POLICY_UPDATE_REQUIRED_FALSE_FIELDS)
    status = required_non_empty_text(raw.get("status"), "runtimeParameterInjection.status")
    runtime_injected = required_bool(raw.get("runtimeParameterInjection"), "runtimeParameterInjection.runtimeParameterInjection")
    policy_update_eligible = required_bool(raw.get("policyUpdateEligible"), "runtimeParameterInjection.policyUpdateEligible")
    scope = required_non_empty_text(raw.get("candidateParameterScope"), "runtimeParameterInjection.candidateParameterScope")
    injected_count = required_non_negative_int(
        raw.get("injectedVariantCount"),
        "runtimeParameterInjection.injectedVariantCount",
    )
    runtime_consumed = None
    if "runtimeParameterConsumption" in raw:
        runtime_consumed = required_bool(
            raw.get("runtimeParameterConsumption"),
            "runtimeParameterInjection.runtimeParameterConsumption",
        )
    consumed_count = None
    if "consumedVariantCount" in raw:
        consumed_count = required_non_negative_int(
            raw.get("consumedVariantCount"),
            "runtimeParameterInjection.consumedVariantCount",
        )
    if "inlineCandidatesRuntimeInjected" in raw:
        required_bool(raw.get("inlineCandidatesRuntimeInjected"), "runtimeParameterInjection.inlineCandidatesRuntimeInjected")
    if "variantCount" in raw:
        required_non_negative_int(raw.get("variantCount"), "runtimeParameterInjection.variantCount")
    expected_scope = RUNTIME_PARAMETER_INJECTION_ALLOWED_STATUS_SCOPES.get(status)
    if expected_scope is None:
        raise BatchRunError(f"remote runtimeParameterInjection.status invalid: {status!r}")
    if scope != expected_scope:
        raise BatchRunError(
            f"remote runtimeParameterInjection {status} status requires {expected_scope} scope"
        )
    if runtime_injected:
        if status != "injected":
            raise BatchRunError("remote runtimeParameterInjection status must be injected when runtime injection is proven")
        if injected_count <= 0:
            raise BatchRunError("remote runtimeParameterInjection injectedVariantCount must be positive when runtime injection is proven")
        if policy_update_eligible and runtime_consumed is False:
            raise BatchRunError("remote runtimeParameterInjection policyUpdateEligible requires runtimeParameterConsumption=true")
        if runtime_consumed is True and consumed_count == 0:
            raise BatchRunError("remote runtimeParameterInjection consumedVariantCount must be positive when consumption is proven")
        if runtime_consumed is False and policy_update_eligible:
            raise BatchRunError("remote runtimeParameterInjection policyUpdateEligible requires consumed runtime parameters")
    elif policy_update_eligible:
        raise BatchRunError("remote runtimeParameterInjection policyUpdateEligible requires runtimeParameterInjection=true")
    elif status == "injected":
        raise BatchRunError("remote runtimeParameterInjection status injected requires runtimeParameterInjection=true")
    elif status == "partial" and injected_count == 0:
        raise BatchRunError("remote runtimeParameterInjection partial status requires positive injectedVariantCount")
    elif status in {"metadata_only", "not_injected"} and injected_count != 0:
        raise BatchRunError(
            f"remote runtimeParameterInjection {status} status requires injectedVariantCount=0"
        )
    return copy.deepcopy(raw)


def verified_remote_candidate_scorecard(
    raw: Any,
    *,
    runtime_parameter_injection: dict[str, Any] | None,
    scorecard_id: Any,
    scorecard_artifact_path: Any,
    artifact_dir: Path,
) -> dict[str, Any] | None:
    if raw is None:
        if scorecard_id is not None:
            raise BatchRunError("remote scorecardId is present without candidateScorecard evidence")
        if scorecard_artifact_path is not None:
            raise BatchRunError("remote scorecardArtifactPath is present without candidateScorecard evidence")
        return None
    if not isinstance(raw, dict):
        raise BatchRunError("remote candidateScorecard must be an object when present")
    unsafe = unsafe_policy_update_safety_flags(
        raw,
        "candidateScorecard",
        {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
    )
    if unsafe:
        raise BatchRunError("remote candidateScorecard safety flags are unsafe: " + "; ".join(unsafe))
    status = required_non_empty_text(raw.get("status"), "candidateScorecard.status")
    runtime_injected = required_bool(raw.get("runtimeParameterInjection"), "candidateScorecard.runtimeParameterInjection")
    validation_blocked = required_bool(
        raw.get("validationScaleComputeBlocked"),
        "candidateScorecard.validationScaleComputeBlocked",
    )
    scorecard_usable = required_bool(raw.get("scorecardUsable"), "candidateScorecard.scorecardUsable")
    injected_count = required_non_negative_int(raw.get("injectedVariantCount"), "candidateScorecard.injectedVariantCount")
    top_level_runtime_injected = (
        runtime_parameter_injection is not None
        and runtime_parameter_injection.get("runtimeParameterInjection") is True
    )
    top_level_status = (
        runtime_parameter_injection.get("status")
        if isinstance(runtime_parameter_injection, dict)
        else None
    )
    top_level_injected_count = (
        runtime_parameter_injection.get("injectedVariantCount", 0)
        if isinstance(runtime_parameter_injection, dict)
        else 0
    )
    top_level_runtime_partially_injected = top_level_status == "partial" and top_level_injected_count > 0
    if status == "ready":
        if not top_level_runtime_injected and not top_level_runtime_partially_injected:
            raise BatchRunError("remote candidateScorecard is ready without runtimeParameterInjection proof")
        if not runtime_injected:
            raise BatchRunError("remote candidateScorecard ready status requires runtimeParameterInjection=true")
        if validation_blocked:
            raise BatchRunError("remote candidateScorecard ready status cannot be validation-scale blocked")
        if not scorecard_usable:
            raise BatchRunError("remote candidateScorecard ready status requires scorecardUsable=true")
        if injected_count <= 0:
            raise BatchRunError("remote candidateScorecard ready status requires positive injectedVariantCount")
        if top_level_runtime_partially_injected and injected_count > top_level_injected_count:
            raise BatchRunError(
                "remote candidateScorecard ready status exceeds top-level runtimeParameterInjection injectedVariantCount"
            )
        nested_scorecard_id = required_non_empty_text(raw.get("scorecardId"), "candidateScorecard.scorecardId")
        top_level_scorecard_id = required_non_empty_text(scorecard_id, "scorecardId")
        if nested_scorecard_id != top_level_scorecard_id:
            raise BatchRunError("remote candidateScorecard.scorecardId disagrees with scorecardId")
        rel_scorecard_artifact_path = safe_candidate_scorecard_artifact_path(scorecard_artifact_path)
        local_scorecard_artifact_path = collected_remote_candidate_scorecard_artifact_path(
            artifact_dir,
            rel_scorecard_artifact_path,
        )
        if not local_scorecard_artifact_path.is_file():
            raise BatchRunError(
                f"remote candidate scorecard artifact was not collected: "
                f"{rel_scorecard_artifact_path.as_posix()}"
            )
    elif status == "materialized":
        classification = raw.get("classification")
        missing_prerequisite = raw.get("missingPrerequisite")
        gradient_blocked = (
            missing_prerequisite == "gradient_stability"
            or classification == "gradient_stability_untrusted_scorecard_materialized"
        )
        if (
            missing_prerequisite == "gradient_stability"
            and classification not in (None, "gradient_stability_untrusted_scorecard_materialized")
        ) or (
            classification == "gradient_stability_untrusted_scorecard_materialized"
            and missing_prerequisite not in (None, "gradient_stability")
        ):
            raise BatchRunError(
                "remote candidateScorecard gradient-stability materialized status has mismatched classification"
            )
        if gradient_blocked:
            if not (top_level_runtime_injected or top_level_runtime_partially_injected) or not runtime_injected:
                raise BatchRunError(
                    "remote candidateScorecard gradient-stability materialized status requires runtimeParameterInjection proof"
                )
            if injected_count <= 0:
                raise BatchRunError(
                    "remote candidateScorecard gradient-stability materialized status requires positive injectedVariantCount"
                )
            if top_level_runtime_partially_injected and injected_count > top_level_injected_count:
                raise BatchRunError(
                    "remote candidateScorecard gradient-stability materialized status exceeds "
                    "top-level runtimeParameterInjection injectedVariantCount"
                )
            if missing_prerequisite != "gradient_stability":
                raise BatchRunError(
                    "remote candidateScorecard gradient-stability materialized status requires gradient_stability prerequisite"
                )
        elif top_level_runtime_injected or runtime_injected:
            raise BatchRunError(
                "remote candidateScorecard materialized status requires incomplete runtimeParameterInjection proof"
            )
        if not gradient_blocked and injected_count != 0:
            raise BatchRunError(
                "remote candidateScorecard materialized status requires injectedVariantCount=0"
            )
        if not validation_blocked:
            raise BatchRunError("remote candidateScorecard materialized status requires validation-scale blocked")
        if not scorecard_usable:
            raise BatchRunError("remote candidateScorecard materialized status requires scorecardUsable=true")
        nested_scorecard_id = required_non_empty_text(raw.get("scorecardId"), "candidateScorecard.scorecardId")
        top_level_scorecard_id = required_non_empty_text(scorecard_id, "scorecardId")
        if nested_scorecard_id != top_level_scorecard_id:
            raise BatchRunError("remote candidateScorecard.scorecardId disagrees with scorecardId")
        rel_scorecard_artifact_path = safe_candidate_scorecard_artifact_path(scorecard_artifact_path)
        local_scorecard_artifact_path = collected_remote_candidate_scorecard_artifact_path(
            artifact_dir,
            rel_scorecard_artifact_path,
        )
        if not local_scorecard_artifact_path.is_file():
            raise BatchRunError(
                f"remote candidate scorecard artifact was not collected: "
                f"{rel_scorecard_artifact_path.as_posix()}"
            )
    elif status == "blocked":
        classification = raw.get("classification")
        materialization_failed = classification == "candidate_scorecard_materialization_failed"
        if runtime_injected and not materialization_failed:
            raise BatchRunError("remote candidateScorecard blocked status requires runtimeParameterInjection=false")
        if top_level_runtime_injected and not materialization_failed:
            raise BatchRunError(
                "remote candidateScorecard blocked status contradicts top-level runtimeParameterInjection proof"
            )
        if top_level_status == "partial" and not materialization_failed:
            if injected_count <= 0:
                raise BatchRunError(
                    "remote candidateScorecard blocked partial injection requires positive injectedVariantCount"
                )
        elif not materialization_failed and injected_count != 0:
            raise BatchRunError("remote candidateScorecard blocked status requires injectedVariantCount=0")
        if not validation_blocked:
            raise BatchRunError("remote candidateScorecard blocked status requires validationScaleComputeBlocked=true")
        if scorecard_usable:
            raise BatchRunError("remote candidateScorecard blocked status requires scorecardUsable=false")
        if scorecard_id is not None:
            raise BatchRunError("remote scorecardId must be null when candidateScorecard is blocked")
        if scorecard_artifact_path is not None:
            raise BatchRunError("remote scorecardArtifactPath must be null when candidateScorecard is blocked")
    else:
        raise BatchRunError(f"remote candidateScorecard.status invalid: {status!r}")
    return copy.deepcopy(raw)


def verified_remote_candidate_scorecards(
    raw: Any,
    *,
    runtime_parameter_injection: dict[str, Any] | None,
    artifact_dir: Path,
) -> dict[str, Any] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise BatchRunError("remote candidateScorecards must be an object when present")
    unsafe = unsafe_policy_update_safety_flags(
        raw,
        "candidateScorecards",
        {
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
        },
    )
    if unsafe:
        raise BatchRunError("remote candidateScorecards safety flags are unsafe: " + "; ".join(unsafe))
    payload_type = required_non_empty_text(raw.get("type"), "candidateScorecards.type")
    if payload_type != MULTI_CANDIDATE_SCORECARD_SET_TYPE:
        raise BatchRunError(f"remote candidateScorecards.type invalid: {payload_type!r}")
    required_non_negative_int(raw.get("schemaVersion"), "candidateScorecards.schemaVersion")
    status = required_non_empty_text(raw.get("status"), "candidateScorecards.status")
    if status not in CANDIDATE_SCORECARD_SET_STATUSES:
        raise BatchRunError(f"remote candidateScorecards.status invalid: {status!r}")
    required_non_empty_text(raw.get("classification"), "candidateScorecards.classification")
    comparisons = raw.get("comparisons")
    if not isinstance(comparisons, list):
        raise BatchRunError("remote candidateScorecards.comparisons must be a list")
    comparison_count = required_non_negative_int(raw.get("comparisonCount"), "candidateScorecards.comparisonCount")
    if comparison_count != len(comparisons):
        raise BatchRunError(
            f"remote candidateScorecards.comparisonCount disagrees with comparisons: "
            f"{comparison_count} != {len(comparisons)}"
        )

    verified_comparisons: list[dict[str, Any]] = []
    seen_pairs: set[tuple[str, str]] = set()
    for index, item in enumerate(comparisons):
        if not isinstance(item, dict):
            raise BatchRunError(f"remote candidateScorecards.comparisons[{index}] must be an object")
        candidate_id = required_non_empty_text(
            item.get("candidateStrategyId"),
            f"candidateScorecards.comparisons[{index}].candidateStrategyId",
        )
        baseline_id = required_non_empty_text(
            item.get("baselineStrategyId"),
            f"candidateScorecards.comparisons[{index}].baselineStrategyId",
        )
        require_optional_non_negative_int(
            item.get("candidateRank"),
            f"candidateScorecards.comparisons[{index}].candidateRank",
        )
        require_optional_non_negative_int(
            item.get("baselineRank"),
            f"candidateScorecards.comparisons[{index}].baselineRank",
        )
        comparison_key = required_non_empty_text(
            item.get("comparisonKey"),
            f"candidateScorecards.comparisons[{index}].comparisonKey",
        )
        expected_comparison_key = f"{candidate_id}::vs::{baseline_id}"
        if comparison_key != expected_comparison_key:
            raise BatchRunError(
                f"remote candidateScorecards.comparisons[{index}].comparisonKey disagrees with strategy ids"
            )
        pair = (candidate_id, baseline_id)
        if pair in seen_pairs:
            raise BatchRunError(
                f"remote candidateScorecards.comparisons[{index}] duplicates comparison {comparison_key!r}"
            )
        seen_pairs.add(pair)
        try:
            verified = verified_remote_candidate_scorecard(
                item,
                runtime_parameter_injection=runtime_parameter_injection,
                scorecard_id=item.get("scorecardId"),
                scorecard_artifact_path=item.get("scorecardArtifactPath"),
                artifact_dir=artifact_dir,
            )
        except BatchRunError as error:
            raise BatchRunError(f"remote candidateScorecards.comparisons[{index}] invalid: {error}") from error
        if verified is None:
            raise BatchRunError(f"remote candidateScorecards.comparisons[{index}] cannot be null")
        verified_comparisons.append(verified)

    candidate_ids = sorted({item["candidateStrategyId"] for item in verified_comparisons})
    baseline_ids = sorted({item["baselineStrategyId"] for item in verified_comparisons})
    candidate_count = required_non_negative_int(raw.get("candidateCount"), "candidateScorecards.candidateCount")
    baseline_count = required_non_negative_int(raw.get("baselineCount"), "candidateScorecards.baselineCount")
    if candidate_count != len(candidate_ids):
        raise BatchRunError(
            f"remote candidateScorecards.candidateCount disagrees with comparisons: "
            f"{candidate_count} != {len(candidate_ids)}"
        )
    if baseline_count != len(baseline_ids):
        raise BatchRunError(
            f"remote candidateScorecards.baselineCount disagrees with comparisons: "
            f"{baseline_count} != {len(baseline_ids)}"
        )
    expected_pairs = {(candidate_id, baseline_id) for candidate_id in candidate_ids for baseline_id in baseline_ids}
    missing_pairs = sorted(expected_pairs - seen_pairs)
    if missing_pairs:
        missing = ", ".join(f"{candidate_id}::vs::{baseline_id}" for candidate_id, baseline_id in missing_pairs)
        raise BatchRunError(
            "remote candidateScorecards.comparisons does not cover the full candidate/baseline matrix: "
            f"missing {missing}"
        )
    if "candidateStrategyIds" in raw and required_text_list(
        raw.get("candidateStrategyIds"),
        "candidateScorecards.candidateStrategyIds",
    ) != candidate_ids:
        raise BatchRunError("remote candidateScorecards.candidateStrategyIds disagree with comparisons")
    if "baselineStrategyIds" in raw and required_text_list(
        raw.get("baselineStrategyIds"),
        "candidateScorecards.baselineStrategyIds",
    ) != baseline_ids:
        raise BatchRunError("remote candidateScorecards.baselineStrategyIds disagree with comparisons")

    materialized_count = sum(
        1 for item in verified_comparisons if text_value(item.get("scorecardArtifactPath")) is not None
    )
    blocked_count = sum(1 for item in verified_comparisons if item.get("status") == "blocked")
    ready_count = sum(1 for item in verified_comparisons if item.get("status") == "ready")
    declared_materialized = required_non_negative_int(
        raw.get("materializedScorecardCount"),
        "candidateScorecards.materializedScorecardCount",
    )
    if declared_materialized != materialized_count:
        raise BatchRunError(
            f"remote candidateScorecards.materializedScorecardCount disagrees with comparisons: "
            f"{declared_materialized} != {materialized_count}"
        )
    if "blockedComparisonCount" in raw:
        declared_blocked = required_non_negative_int(
            raw.get("blockedComparisonCount"),
            "candidateScorecards.blockedComparisonCount",
        )
        if declared_blocked != blocked_count:
            raise BatchRunError(
                f"remote candidateScorecards.blockedComparisonCount disagrees with comparisons: "
                f"{declared_blocked} != {blocked_count}"
            )
    if "readyComparisonCount" in raw:
        declared_ready = required_non_negative_int(
            raw.get("readyComparisonCount"),
            "candidateScorecards.readyComparisonCount",
        )
        if declared_ready != ready_count:
            raise BatchRunError(
                f"remote candidateScorecards.readyComparisonCount disagrees with comparisons: "
                f"{declared_ready} != {ready_count}"
            )

    validation_blocked = required_bool(
        raw.get("validationScaleComputeBlocked"),
        "candidateScorecards.validationScaleComputeBlocked",
    )
    expected_validation_blocked = (
        True
        if not verified_comparisons
        else any(item.get("validationScaleComputeBlocked") is True for item in verified_comparisons)
    )
    if validation_blocked != expected_validation_blocked:
        raise BatchRunError("remote candidateScorecards.validationScaleComputeBlocked disagrees with comparisons")
    scorecard_usable = required_bool(raw.get("scorecardUsable"), "candidateScorecards.scorecardUsable")
    expected_usable = bool(verified_comparisons) and all(
        item.get("scorecardUsable") is True for item in verified_comparisons
    )
    if scorecard_usable != expected_usable:
        raise BatchRunError("remote candidateScorecards.scorecardUsable disagrees with comparisons")
    if not verified_comparisons and status != "blocked":
        raise BatchRunError("remote candidateScorecards with no comparisons must be blocked")
    if verified_comparisons and blocked_count:
        if blocked_count == len(verified_comparisons) and status not in {"blocked", "partial"}:
            raise BatchRunError("remote candidateScorecards fully blocked comparisons require blocked or partial status")
        if blocked_count != len(verified_comparisons) and status != "partial":
            raise BatchRunError("remote candidateScorecards mixed blocked comparisons require partial status")
    elif verified_comparisons and ready_count == len(verified_comparisons):
        if status != "ready":
            raise BatchRunError("remote candidateScorecards ready comparisons require ready status")
    elif verified_comparisons and materialized_count == len(verified_comparisons):
        if status != "materialized":
            raise BatchRunError("remote candidateScorecards materialized comparisons require materialized status")
    if verified_comparisons and "selectedScorecardId" in raw:
        selected = verified_comparisons[0].get("scorecardId")
        if raw.get("selectedScorecardId") != selected:
            raise BatchRunError("remote candidateScorecards.selectedScorecardId disagrees with first comparison")

    verified_payload = copy.deepcopy(raw)
    verified_payload["comparisons"] = verified_comparisons
    return verified_payload


def required_bool(raw: Any, label: str) -> bool:
    if type(raw) is bool:
        return raw
    raise BatchRunError(f"remote {label} must be a boolean")


def required_non_negative_int(raw: Any, label: str) -> int:
    if type(raw) is int and raw >= 0:
        return raw
    raise BatchRunError(f"remote {label} must be a non-negative integer")


def required_non_empty_text(raw: Any, label: str) -> str:
    if isinstance(raw, str) and raw.strip():
        return raw
    raise BatchRunError(f"remote {label} must be a non-empty string")


def require_optional_non_negative_int(raw: Any, label: str) -> int | None:
    if raw is None:
        return None
    return required_non_negative_int(raw, label)


def required_text_list(raw: Any, label: str) -> list[str]:
    if not isinstance(raw, list):
        raise BatchRunError(f"remote {label} must be a list")
    return [required_non_empty_text(item, f"{label}[{index}]") for index, item in enumerate(raw)]


def require_explicit_false_fields(raw: dict[str, Any], label: str, fields: Sequence[str]) -> None:
    for field in fields:
        if raw.get(field) is not False:
            raise BatchRunError(f"remote {label}.{field} must be explicitly false")


def safe_candidate_scorecard_artifact_path(raw: Any) -> Path:
    if not isinstance(raw, str) or not raw.strip():
        raise BatchRunError("remote scorecardArtifactPath must be a non-empty string when candidateScorecard is ready")
    if "\\" in raw:
        raise BatchRunError(f"remote scorecardArtifactPath is unsafe: {raw!r}")
    path = Path(raw)
    if path.is_absolute() or ".." in path.parts:
        raise BatchRunError(f"remote scorecardArtifactPath is unsafe: {raw!r}")
    if (
        len(path.parts) < 4
        or path.parts[0] != "runtime-artifacts"
        or path.parts[1] != "rl-training"
        or path.parts[2] != "candidate-scorecards"
    ):
        raise BatchRunError(f"remote scorecardArtifactPath is outside rl-training candidate scorecards: {raw!r}")
    if path.suffix != ".json":
        raise BatchRunError(f"remote scorecardArtifactPath must be a JSON scorecard artifact: {raw!r}")
    return path


def collected_remote_candidate_scorecard_artifact_path(artifact_dir: Path, rel_artifact_path: Path) -> Path:
    remote_root = (artifact_dir / "remote").resolve()
    local_path = (remote_root / rel_artifact_path).resolve()
    try:
        local_path.relative_to(remote_root)
    except ValueError:
        raise BatchRunError(f"remote scorecardArtifactPath escapes collected artifact dir: {rel_artifact_path}") from None
    return local_path


def policy_update_iterations(raw: Any, label: str) -> int:
    if raw is None:
        return 0
    if type(raw) is int and raw >= 0:
        return raw
    raise BatchRunError(f"remote {label} invalid: {raw!r}")


def validate_positive_policy_update(
    raw: Any,
    *,
    runtime_parameter_injection: dict[str, Any] | None = None,
) -> None:
    if not isinstance(raw, dict):
        raise BatchRunError("remote policyUpdate must be an object when policyUpdateIterations is positive")
    iterations = policy_update_iterations(raw.get("iterations"), "policyUpdate.iterations")
    if iterations <= 0:
        raise BatchRunError("remote policyUpdate.iterations must be positive when policyUpdateIterations is positive")
    next_candidate_policy = raw.get("nextCandidatePolicy")
    if not isinstance(next_candidate_policy, dict):
        raise BatchRunError("remote policyUpdate.nextCandidatePolicy must be an object when policyUpdateIterations is positive")
    require_explicit_false_policy_update_safety_flags(raw, "policyUpdate")
    require_explicit_false_policy_update_safety_flags(next_candidate_policy, "policyUpdate.nextCandidatePolicy")
    validate_positive_policy_update_parameter_change(raw, next_candidate_policy)
    validate_policy_update_promotion_gate(
        raw.get("promotionGate"),
        runtime_parameter_injection=runtime_parameter_injection,
        label="policyUpdate.promotionGate",
    )
    validate_policy_update_promotion_gate(
        next_candidate_policy.get("promotionGate"),
        runtime_parameter_injection=runtime_parameter_injection,
        label="policyUpdate.nextCandidatePolicy.promotionGate",
    )


def validate_positive_policy_update_parameter_change(
    raw: dict[str, Any],
    next_candidate_policy: dict[str, Any],
) -> None:
    updated_parameters = raw.get("updatedParameters")
    if not isinstance(updated_parameters, dict) or not updated_parameters:
        raise BatchRunError("remote policyUpdate.updatedParameters must be a non-empty object when policyUpdateIterations is positive")
    next_parameters = next_candidate_policy.get("parameters")
    if not isinstance(next_parameters, dict) or not next_parameters:
        raise BatchRunError(
            "remote policyUpdate.nextCandidatePolicy.parameters must be a non-empty object when policyUpdateIterations is positive"
        )
    if next_parameters != updated_parameters:
        raise BatchRunError("remote policyUpdate.nextCandidatePolicy.parameters disagree with policyUpdate.updatedParameters")
    validate_policy_update_parameter_values(updated_parameters, "policyUpdate.updatedParameters")
    validate_policy_update_parameter_values(next_parameters, "policyUpdate.nextCandidatePolicy.parameters")
    parameter_delta = raw.get("parameterDelta")
    if not isinstance(parameter_delta, dict) or not parameter_delta:
        raise BatchRunError("remote policyUpdate.parameterDelta must be a non-empty object when policyUpdateIterations is positive")
    changed = False
    for name, delta in parameter_delta.items():
        if name not in updated_parameters:
            raise BatchRunError("remote policyUpdate.parameterDelta contains a parameter absent from updatedParameters")
        if isinstance(delta, bool) or not isinstance(delta, (int, float)) or not math.isfinite(float(delta)):
            raise BatchRunError("remote policyUpdate.parameterDelta values must be finite numbers")
        if abs(float(delta)) > 0:
            changed = True
    if not changed:
        raise BatchRunError("remote policyUpdate.parameterDelta must include at least one non-zero change")


def validate_policy_update_promotion_gate(
    raw: Any,
    *,
    runtime_parameter_injection: dict[str, Any] | None,
    label: str,
) -> None:
    if not isinstance(raw, dict):
        raise BatchRunError(f"remote {label} must be an object when policyUpdateIterations is positive")
    require_explicit_false_policy_update_safety_flags(raw, label)
    status = required_non_empty_text(raw.get("status"), f"{label}.status")
    consumption_mode = required_non_empty_text(raw.get("consumptionMode"), f"{label}.consumptionMode")
    runtime_consumed = required_bool(raw.get("runtimeParameterConsumption"), f"{label}.runtimeParameterConsumption")
    loop_a = required_bool(raw.get("loopAPromotionEligible"), f"{label}.loopAPromotionEligible")
    loop_b = required_bool(raw.get("loopBPromotionEligible"), f"{label}.loopBPromotionEligible")
    runtime_consumed_promotion = required_bool(
        raw.get("runtimeConsumedPromotionEligible"),
        f"{label}.runtimeConsumedPromotionEligible",
    )
    trusted_gradient_update = raw.get("trustedGradientUpdate")
    if trusted_gradient_update is not None:
        trusted_gradient_update = required_bool(trusted_gradient_update, f"{label}.trustedGradientUpdate")
    high_variance = raw.get("highVariance")
    if high_variance is not None:
        high_variance = required_bool(high_variance, f"{label}.highVariance")
    missing_prerequisites = required_text_list(raw.get("missingPrerequisites"), f"{label}.missingPrerequisites")
    required_non_empty_text(raw.get("validationText"), f"{label}.validationText")

    top_level_consumed = False
    if (
        isinstance(runtime_parameter_injection, dict)
        and runtime_parameter_injection.get("runtimeParameterInjection") is True
    ):
        if "runtimeParameterConsumption" not in runtime_parameter_injection:
            raise BatchRunError(
                "remote runtimeParameterInjection.runtimeParameterConsumption must be present when "
                "runtime injection is proven"
            )
        top_level_consumed = (
            required_bool(
                runtime_parameter_injection.get("runtimeParameterConsumption"),
                "runtimeParameterInjection.runtimeParameterConsumption",
            )
            is True
        )
    if top_level_consumed:
        if not runtime_consumed:
            raise BatchRunError(f"remote {label} contradicts consumed runtimeParameterInjection proof")
        if consumption_mode != "runtime_consumed":
            raise BatchRunError(f"remote {label} consumed mode must use runtime_consumed consumptionMode")
        gradient_blocked = (
            trusted_gradient_update is False
            or high_variance is True
            or status == "blocked_gradient_stability_untrusted"
        )
        if gradient_blocked:
            if loop_a or loop_b or runtime_consumed_promotion:
                raise BatchRunError(f"remote {label} untrusted gradient mode must block Loop A/B promotion")
            if "gradient_stability" not in missing_prerequisites:
                raise BatchRunError(f"remote {label} untrusted gradient mode must require gradient_stability")
            if status != "blocked_gradient_stability_untrusted":
                raise BatchRunError(f"remote {label} untrusted gradient mode has unsafe status: {status!r}")
            return
        if missing_prerequisites:
            raise BatchRunError(f"remote {label} consumed mode cannot declare missing prerequisites")
        if not (loop_a and loop_b and runtime_consumed_promotion):
            raise BatchRunError(f"remote {label} consumed mode must keep Loop A/B runtime-consumed gates eligible")
        return

    if runtime_consumed:
        raise BatchRunError(f"remote {label} claims runtime consumption without top-level consumption proof")
    if loop_a or loop_b or runtime_consumed_promotion:
        raise BatchRunError(f"remote {label} non-consumed mode must block Loop A/B promotion")
    if "runtime_parameter_consumption" not in missing_prerequisites:
        raise BatchRunError(f"remote {label} non-consumed mode must require runtime_parameter_consumption")
    if status != "blocked_runtime_parameter_consumption_missing":
        raise BatchRunError(f"remote {label} non-consumed mode has unsafe status: {status!r}")
    if consumption_mode == "runtime_consumed":
        raise BatchRunError(f"remote {label} non-consumed mode cannot use runtime_consumed consumptionMode")


def validate_policy_update_parameter_values(parameters: dict[str, Any], label: str) -> None:
    for value in parameters.values():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise BatchRunError(f"remote {label} values must be finite numbers")


def validate_collected_policy_update_artifact_parameters(
    local_artifact_path: Path,
    rel_artifact_path: Path,
    updated_parameters: dict[str, Any],
    promotion_gate: Any,
) -> None:
    try:
        with local_artifact_path.open(encoding="utf-8") as artifact_file:
            artifact = json.load(artifact_file)
    except OSError as exc:
        raise BatchRunError(f"remote policy update artifact is not readable: {rel_artifact_path.as_posix()}") from exc
    except json.JSONDecodeError as exc:
        raise BatchRunError(f"remote policy update artifact is not valid JSON: {rel_artifact_path.as_posix()}") from exc
    if not isinstance(artifact, dict):
        raise BatchRunError(f"remote policy update artifact must be a JSON object: {rel_artifact_path.as_posix()}")
    artifact_parameters = artifact.get("parameters")
    if not isinstance(artifact_parameters, dict) or not artifact_parameters:
        raise BatchRunError(
            f"remote policy update artifact parameters must be a non-empty object: {rel_artifact_path.as_posix()}"
        )
    validate_policy_update_parameter_values(artifact_parameters, "policyUpdateArtifactPath.parameters")
    if artifact_parameters != updated_parameters:
        raise BatchRunError(
            "remote policy update artifact parameters disagree with policyUpdate.updatedParameters: "
            f"{rel_artifact_path.as_posix()}"
        )
    if promotion_gate is not None and artifact.get("promotionGate") != promotion_gate:
        raise BatchRunError(
            "remote policy update artifact promotionGate disagrees with policyUpdate.promotionGate: "
            f"{rel_artifact_path.as_posix()}"
        )


def require_explicit_false_policy_update_safety_flags(raw: dict[str, Any], label: str) -> None:
    for field in POSITIVE_POLICY_UPDATE_REQUIRED_FALSE_FIELDS:
        if raw.get(field) is not False:
            raise BatchRunError(
                f"remote {label}.{field} must be explicitly false when policyUpdateIterations is positive"
            )


def is_safe_zero_iteration_policy_update(raw: Any) -> bool:
    if not isinstance(raw, dict):
        return False
    if raw.get("iterations") != 0:
        return False
    skipped_reason = raw.get("skippedReason")
    if not isinstance(skipped_reason, str) or not skipped_reason.strip():
        return False
    forbidden_paths = zero_iteration_policy_update_forbidden_paths(raw, "policyUpdate")
    if forbidden_paths:
        raise BatchRunError(
            "remote policyUpdate zero-iteration no-op contains update data: "
            + ", ".join(forbidden_paths)
        )
    unexpected_keys = sorted(
        repr(key)
        for key in raw
        if not isinstance(key, str) or key not in ZERO_ITERATION_POLICY_UPDATE_ALLOWED_KEYS
    )
    if unexpected_keys:
        raise BatchRunError(
            "remote policyUpdate zero-iteration no-op has unexpected fields: "
            + ", ".join(unexpected_keys)
        )
    return True


def zero_iteration_policy_update_forbidden_paths(value: Any, label: str) -> list[str]:
    if isinstance(value, dict):
        paths: list[str] = []
        for key, nested in value.items():
            key_label = f"{label}.{key}"
            if isinstance(key, str) and key in ZERO_ITERATION_POLICY_UPDATE_FORBIDDEN_KEYS:
                paths.append(key_label)
            if isinstance(nested, (dict, list)):
                paths.extend(zero_iteration_policy_update_forbidden_paths(nested, key_label))
        return paths
    if isinstance(value, list):
        paths = []
        for index, item in enumerate(value):
            if isinstance(item, (dict, list)):
                paths.extend(zero_iteration_policy_update_forbidden_paths(item, f"{label}[{index}]"))
        return paths
    return []


def safe_policy_update_artifact_path(raw: Any, label: str = "policyUpdateArtifactPath") -> Path:
    if not isinstance(raw, str) or not raw.strip():
        raise BatchRunError(f"remote {label} must be a non-empty string when policyUpdateIterations is positive")
    if "\\" in raw:
        raise BatchRunError(f"remote {label} is unsafe: {raw!r}")
    path = Path(raw)
    if path.is_absolute() or ".." in path.parts:
        raise BatchRunError(f"remote {label} is unsafe: {raw!r}")
    if (
        len(path.parts) < 4
        or path.parts[0] != "runtime-artifacts"
        or path.parts[1] != "rl-training"
        or path.parts[2] != "policy-candidates"
    ):
        raise BatchRunError(f"remote {label} is outside rl-training policy candidate artifacts: {raw!r}")
    if path.suffix != ".json":
        raise BatchRunError(f"remote {label} must be a JSON policy candidate artifact: {raw!r}")
    return path


def collected_remote_policy_update_artifact_path(artifact_dir: Path, rel_artifact_path: Path) -> Path:
    remote_root = (artifact_dir / "remote").resolve()
    local_path = (remote_root / rel_artifact_path).resolve()
    try:
        local_path.relative_to(remote_root)
    except ValueError:
        raise BatchRunError(f"remote policyUpdateArtifactPath escapes collected artifact dir: {rel_artifact_path}") from None
    return local_path


def unsafe_policy_update_safety_flags(value: Any, label: str, top_level_safety: dict[str, Any]) -> list[str]:
    if isinstance(value, dict):
        unsafe: list[str] = []
        for control, aliases in POLICY_UPDATE_SAFETY_FIELD_ALIASES.items():
            for field in aliases:
                if field in value and value.get(field) is not False and top_level_safety.get(control) is not True:
                    unsafe.append(f"{label}.{field}={policy_update_safety_flag_value(value.get(field))}")
        for key, nested in value.items():
            if isinstance(nested, (dict, list)):
                unsafe.extend(unsafe_policy_update_safety_flags(nested, f"{label}.{key}", top_level_safety))
        return unsafe
    if isinstance(value, list):
        unsafe = []
        for index, item in enumerate(value):
            if isinstance(item, (dict, list)):
                unsafe.extend(unsafe_policy_update_safety_flags(item, f"{label}[{index}]", top_level_safety))
        return unsafe
    return []


def policy_update_safety_flag_value(value: Any) -> str:
    try:
        return json.dumps(value, sort_keys=True, ensure_ascii=True)
    except TypeError:
        return repr(value)


def parse_tencent_activity_time(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def summarize_scale_out_failure(activity: dict[str, Any]) -> dict[str, Any]:
    details = []
    for item in activity.get("DetailedStatusMessageSet") or []:
        if not isinstance(item, dict):
            continue
        details.append({
            "code": item.get("Code"),
            "zone": item.get("Zone"),
            "instanceChargeType": item.get("InstanceChargeType"),
            "subnetId": item.get("SubnetId"),
            "instanceType": item.get("InstanceType"),
            "message": item.get("Message"),
        })
    return {
        "activityId": activity.get("ActivityId"),
        "statusCode": activity.get("StatusCode"),
        "statusMessageSimplified": activity.get("StatusMessageSimplified"),
        "statusMessage": activity.get("StatusMessage"),
        "startTime": activity.get("StartTime"),
        "endTime": activity.get("EndTime"),
        "details": details,
        "ownerActionRequired": any("余额不足" in str(value) for item in details for value in item.values()),
    }


def bash_lc(script: str) -> str:
    encoded = base64.b64encode(script.encode("utf-8")).decode("ascii")
    return "bash -lc " + shlex.quote(f"printf %s {shlex.quote(encoded)} | base64 -d | bash")


def resolve_scale_environment_count(args: argparse.Namespace) -> int | None:
    explicit = getattr(args, "scale_environments", None)
    if explicit is not None:
        return explicit
    workers = getattr(args, "workers", 1)
    return workers if workers > 1 else None


def effective_training_ticks(args: argparse.Namespace) -> int:
    ticks = int(getattr(args, "ticks", 1))
    if getattr(args, "training_approach", None) == "policy_gradient":
        return max(ticks, POLICY_GRADIENT_MIN_SIMULATION_TICKS)
    return ticks


def minimum_successful_environments(environment_count: int) -> int:
    return math.ceil(environment_count * SCALE_PROOF_SUCCESS_RATE)


def scenario_id_from_args(args: argparse.Namespace) -> str:
    return getattr(args, "scenario_id", None) or DEFAULT_SCENARIO_ID


def require_multi_tier_scenario_from_args(args: argparse.Namespace, scenario_id: str | None = None) -> bool:
    resolved_scenario_id = scenario_id or scenario_id_from_args(args)
    return bool(getattr(args, "require_multi_tier_scenario", False)) or resolved_scenario_id == MULTI_TIER_SCENARIO_ID


def scenario_map_source_file(scenario_id: str) -> str:
    return MULTI_TIER_SIMULATION_MAP_SOURCE_REL if scenario_id == MULTI_TIER_SCENARIO_ID else DEFAULT_SIMULATION_MAP_SOURCE_REL


def scenario_anchor_room(scenario_id: str) -> str:
    return DEFAULT_SIMULATION_ROOM


def scenario_map_source_path(scenario_id: str) -> Path:
    return REPO_ROOT / scenario_map_source_file(scenario_id)


def multi_tier_launch_fixture_evidence() -> dict[str, Any]:
    fixture_path = scenario_map_source_path(MULTI_TIER_SCENARIO_ID)
    try:
        summary = multi_tier_scenario_fixture_summary(fixture_path)
    except CardValidationError as error:
        raise BatchRunError(str(error)) from error
    return {
        "implementationStatus": MULTI_TIER_ACTIVE_IMPLEMENTATION_STATUS,
        "anchorRoom": summary["anchorRoom"],
        "adjacentRoom": summary["adjacentRoom"],
        "adjacentRooms": summary["adjacentRooms"],
        "roomCount": summary["roomCount"],
        "hostileFixture": "adjacent_room_hostile_spawn_and_creeps",
        "hostileCreepCount": summary["adjacentHostileCreepCount"],
        "hostileStructureCount": summary["adjacentHostileStructureCount"],
        "hostileSpawnCount": summary["adjacentHostileSpawnCount"],
        "ownAnchorSpawnCount": summary["anchorOwnSpawnCount"],
        "ownAnchorCreepCount": summary["anchorOwnCreepCount"],
        "fixtureSha256": summary["fixtureSha256"],
        "mapSourceFile": scenario_map_source_file(MULTI_TIER_SCENARIO_ID),
    }


def validate_requested_experiment_card_scenario(
    payload: dict[str, Any],
    *,
    requested_scenario_id: str,
    require_multi_tier_scenario: bool,
) -> None:
    scenario = payload.get("scenario")
    if not isinstance(scenario, dict):
        raise BatchRunError("generated experiment card is missing scenario metadata")
    observed_scenario_id = text_value(scenario.get("scenario_id")) or text_value(scenario.get("scenarioId"))
    if observed_scenario_id != requested_scenario_id:
        raise BatchRunError(
            f"generated experiment card scenario mismatch: {observed_scenario_id!r} != {requested_scenario_id!r}"
        )
    if require_multi_tier_scenario and not scenario_supports_multi_tier_policy_comparison(scenario):
        raise BatchRunError("generated experiment card lacks active multi-tier hostile fixture evidence")


def build_scale_proof_spec(
    *,
    args: argparse.Namespace,
    run_id: str,
    artifact_dir: Path,
    experiment_card_path: Path,
    scale_environments: int,
    experiment_card: dict[str, Any],
) -> dict[str, Any]:
    scenario_id = scenario_id_from_args(args)
    fixture_evidence = (
        multi_tier_launch_fixture_evidence()
        if scenario_id == MULTI_TIER_SCENARIO_ID
        else None
    )
    card_simulation_fields: dict[str, Any] = {
        "ticks": effective_training_ticks(args),
        "workers": args.workers,
        "scale_environments": scale_environments,
        "min_concurrent_environments": scale_environments,
        "scenario_id": scenario_id,
        "room": scenario_anchor_room(scenario_id),
        "map_source_file": scenario_map_source_file(scenario_id),
    }
    if fixture_evidence is not None:
        card_simulation_fields["fixtureEvidence"] = fixture_evidence
    return {
        "type": "screeps-tencent-batch-rl-scale-proof-spec",
        "schemaVersion": 1,
        "runId": run_id,
        "artifactDir": str(artifact_dir),
        "experimentCardPath": str(experiment_card_path),
        "experimentCard": {
            "cardId": experiment_card.get("card_id"),
            "trainingApproach": experiment_card.get("training_approach"),
            "status": experiment_card.get("status"),
            "safety": experiment_card.get("safety"),
            "rewardModel": experiment_card.get("reward_model"),
            "cardSupply": experiment_card.get("card_supply"),
            "scenario": experiment_card.get("scenario"),
        },
        "scaleProof": {
            "mode": "single_tencent_asg_worker_multi_environment",
            "requestedWorkers": args.workers,
            "scaleEnvironments": scale_environments,
            "minConcurrentEnvironments": scale_environments,
            "successCriteria": {
                "minimumSuccessRate": SCALE_PROOF_SUCCESS_RATE,
                "minimumSuccessfulEnvironments": minimum_successful_environments(scale_environments),
            },
            "remoteRunnerContract": {
                "trainingRunner": "scripts/screeps_rl_training_runner.py",
                "simulatorHarness": "scripts/screeps_rl_simulator_harness.py",
                "cardSimulationFields": card_simulation_fields,
            },
        },
        "asg": {
            "autoScalingGroupId": args.asg_id,
            "desiredCapacityDuringRun": 1,
            "cleanupDesiredCapacity": 0,
        },
        "safety": {
            "status": "shadow",
            "liveEffect": False,
            "officialMmoWrites": False,
            "officialMmoWritesAllowed": False,
            "billingGuardBeforeScale": True,
            "sshControllerOnlyExpected": args.controller_ip,
            "secretsPrinted": False,
        },
    }


def validate_scale_proof_result(raw: Any, expected_environments: int, *, repetitions: int = 1) -> None:
    if not isinstance(raw, dict):
        raise BatchRunError("remote training report missing scaleValidation for multi-worker proof")
    total = raw.get("totalEnvironments")
    successful = raw.get("successfulEnvironments")
    reported_minimum = raw.get("minimumSuccessfulEnvironments")
    reported_target = raw.get("targetEnvironments")
    reported_repetitions = raw.get("repetitions")
    expected_total = expected_environments * repetitions
    local_minimum = minimum_successful_environments(expected_total)
    if "targetEnvironments" in raw and (
        not isinstance(reported_target, int) or reported_target != expected_environments
    ):
        raise BatchRunError(
            f"scale proof target environment count invalid: {reported_target!r} must equal {expected_environments}"
        )
    if "repetitions" in raw and (
        not isinstance(reported_repetitions, int) or reported_repetitions != repetitions
    ):
        raise BatchRunError(
            f"scale proof repetition count invalid: {reported_repetitions!r} must equal {repetitions}"
        )
    if not isinstance(total, int) or total != expected_total:
        raise BatchRunError(
            f"scale proof environment count invalid: {total!r} must equal {expected_total}"
        )
    if isinstance(reported_minimum, int) and not 0 <= reported_minimum <= total:
        raise BatchRunError(
            f"scale proof minimum success count invalid: {reported_minimum!r} outside 0..{total}"
        )
    minimum = (
        max(local_minimum, reported_minimum)
        if isinstance(reported_minimum, int)
        else local_minimum
    )
    if not isinstance(successful, int) or not 0 <= successful <= total:
        raise BatchRunError(f"scale proof success count invalid: {successful!r} outside 0..{total}")
    if successful < minimum:
        raise BatchRunError(f"scale proof success count invalid: {successful!r} < {minimum}")
    if raw.get("ok") is not True:
        raise BatchRunError("scale proof did not satisfy success criteria")


def validate_static_inputs(args: argparse.Namespace, run_id: str) -> None:
    if not RUN_ID_RE.fullmatch(run_id):
        raise BatchRunError("run id must be lowercase and contain only letters, numbers, dot, underscore, hyphen")
    for path_label, path_text in {
        "tccli": args.tccli,
        "billing guard": args.billing_guard,
        "ssh key": args.ssh_key,
        "secret env": args.secret_env,
    }.items():
        path = Path(path_text)
        if not path.exists():
            raise BatchRunError(f"{path_label} path does not exist: {path}")
    if args.workers < 1 or args.workers > MAX_SCALE_PROOF_WORKERS:
        raise BatchRunError(f"workers must be between 1 and {MAX_SCALE_PROOF_WORKERS}")
    scale_environments = resolve_scale_environment_count(args)
    if scale_environments is not None:
        if scale_environments < 1 or scale_environments > MAX_SCALE_PROOF_WORKERS:
            raise BatchRunError(f"scale environments must be between 1 and {MAX_SCALE_PROOF_WORKERS}")
        if args.workers < scale_environments:
            raise BatchRunError("workers must be at least scale environments for concurrent scale proof")
    if args.repetitions < 1 or args.ticks < 1:
        raise BatchRunError("ticks and repetitions must be positive")
    scenario_id = scenario_id_from_args(args)
    if scenario_id not in SCENARIO_IDS:
        raise BatchRunError(f"scenario id must be one of: {', '.join(SCENARIO_IDS)}")
    if getattr(args, "require_multi_tier_scenario", False) and scenario_id != MULTI_TIER_SCENARIO_ID:
        raise BatchRunError("multi-tier policy comparisons require the multi-tier territory/combat scenario id")
    if getattr(args, "training_approach", None) == "policy_gradient" and scenario_id != MULTI_TIER_SCENARIO_ID:
        raise BatchRunError(
            f"policy_gradient Tencent proof requires --scenario-id {MULTI_TIER_SCENARIO_ID} "
            "--require-multi-tier-scenario"
        )
    if scenario_id == MULTI_TIER_SCENARIO_ID:
        multi_tier_launch_fixture_evidence()
    if not args.controller_ip.endswith("/32"):
        raise BatchRunError("controller IP must be a /32 CIDR")


def apply_cli_scenario_defaults(args: argparse.Namespace) -> argparse.Namespace:
    explicit_options = set(getattr(args, "explicit_cli_options", ()))
    command = getattr(args, "command", None)
    explicit_launch_mode = bool(explicit_options.intersection(PREFLIGHT_MODE_OPTION_DESTS))
    if command in {"preflight", "run-single"} and not explicit_launch_mode:
        args.training_approach = "policy_gradient"
        args.scenario_id = MULTI_TIER_SCENARIO_ID
        args.require_multi_tier_scenario = True
        return args
    if getattr(args, "scenario_id", None) is None:
        if args.training_approach == "policy_gradient" or (
            command == "preflight" and getattr(args, "require_multi_tier_scenario", False)
        ):
            args.scenario_id = MULTI_TIER_SCENARIO_ID
            args.require_multi_tier_scenario = True
        else:
            args.scenario_id = DEFAULT_SCENARIO_ID
    elif args.scenario_id == MULTI_TIER_SCENARIO_ID:
        args.require_multi_tier_scenario = True
    return args


def explicit_cli_option_dests(argv: Sequence[str]) -> set[str]:
    explicit: set[str] = set()
    for token in argv:
        if token == "--":
            break
        for option, dest in CLI_EXPLICIT_OPTION_DESTS.items():
            if token == option or token.startswith(option + "="):
                explicit.add(dest)
    return explicit


def list_tracked_bundle_paths() -> list[str]:
    cp = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        text=False,
        capture_output=True,
        check=False,
    )
    if cp.returncode != 0:
        stderr = cp.stderr.decode("utf-8", errors="replace")
        raise BatchRunError(f"git ls-files failed while building repo bundle: {tail_text(stderr)}")
    return sorted(path.decode("utf-8") for path in cp.stdout.split(b"\0") if path)


def should_include_bundle_relpath(rel: str) -> bool:
    rel_path = Path(rel)
    if rel_path.is_absolute() or ".." in rel_path.parts or not rel:
        raise BatchRunError(f"refusing unsafe bundle path: {rel}")
    parts = set(rel_path.parts)
    if parts & BUNDLE_EXCLUDE_DIRS:
        return False
    if any(rel == prefix.rstrip("/") or rel.startswith(prefix) for prefix in BUNDLE_EXCLUDE_PREFIXES):
        return False
    if any(pattern.search(rel) for pattern in BUNDLE_SECRET_PATH_PATTERNS):
        raise BatchRunError(f"refusing secret-like bundle path: {rel}")
    return True


def iter_repo_bundle_paths() -> list[Path]:
    rel_paths = list_tracked_bundle_paths()
    for rel in BUNDLE_ALLOWLISTED_RUNTIME_FILES:
        if (REPO_ROOT / rel).is_file() and rel not in rel_paths:
            rel_paths.append(rel)
    bundle_paths: list[Path] = []
    for rel in sorted(set(rel_paths)):
        if not should_include_bundle_relpath(rel):
            continue
        path = REPO_ROOT / rel
        if path.is_symlink():
            raise BatchRunError(f"refusing symlink in repo bundle: {rel}")
        if not path.is_file():
            raise BatchRunError(f"bundle manifest path is not a regular file: {rel}")
        bundle_paths.append(path)
    return bundle_paths


def create_repo_bundle(package: Path) -> None:
    package.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(package, "w:gz") as tar:
        for path in iter_repo_bundle_paths():
            rel = path.relative_to(REPO_ROOT).as_posix()
            tar.add(path, arcname=rel, recursive=False)
    if package.stat().st_size <= 0:
        raise BatchRunError("repo bundle is empty")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run bounded Screeps RL training on one Tencent ASG worker.",
        allow_abbrev=False,
    )
    parser.add_argument("command", choices=("run-single", "preflight"))
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--region", default=DEFAULT_REGION)
    parser.add_argument("--asg-id", default=DEFAULT_ASG_ID)
    parser.add_argument("--security-group-id", default="sg-5n5bqvbk")
    parser.add_argument("--controller-ip", default=DEFAULT_CONTROLLER_IP)
    parser.add_argument("--worker-user", default=DEFAULT_WORKER_USER)
    parser.add_argument("--remote-base", default=DEFAULT_REMOTE_BASE)
    parser.add_argument("--tccli", default=str(DEFAULT_TCCLI))
    parser.add_argument("--billing-guard", default=str(DEFAULT_BILLING_GUARD))
    parser.add_argument("--secret-env", default=str(DEFAULT_SECRET_ENV))
    parser.add_argument("--ssh-key", default=str(DEFAULT_SSH_KEY))
    parser.add_argument("--known-hosts-path", default=str(DEFAULT_KNOWN_HOSTS))
    parser.add_argument("--dataset-run-id", default="rl-3d29e8b9397d")
    parser.add_argument("--training-approach", default="bandit", choices=("bandit", "evolutionary", "policy_gradient"))
    parser.add_argument("--ticks", type=int, default=50, help="Simulator ticks; policy_gradient runs are floored to 500.")
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument(
        "--scale-environments",
        type=int,
        default=None,
        help="Unique concurrent simulator environment rows for scale proof. Defaults to --workers when --workers > 1.",
    )
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--host-port-start", type=int, default=24125)
    parser.add_argument(
        "--scenario-id",
        choices=SCENARIO_IDS,
        default=None,
        help=(
            "Scenario to exercise. Defaults to E1S1 for non-policy-gradient smoke runs and "
            f"{MULTI_TIER_SCENARIO_ID} for policy_gradient proof runs."
        ),
    )
    parser.add_argument(
        "--require-multi-tier-scenario",
        action="store_true",
        help="Reject Tencent policy comparison cards unless the scenario has territory and combat signals.",
    )
    parser.add_argument("--variant", action="append", help="Strategy variant id; repeat to override generated card variants.")
    parser.add_argument("--artifact-root", type=Path, default=DEFAULT_ARTIFACT_ROOT)
    parser.add_argument("--scale-timeout-seconds", type=int, default=900)
    parser.add_argument("--scale-down-timeout-seconds", type=int, default=600)
    parser.add_argument("--bootstrap-timeout-seconds", type=int, default=1800)
    parser.add_argument("--training-timeout-seconds", type=int, default=3600)
    parser.add_argument("--transfer-timeout-seconds", type=int, default=1200)
    return parser


def parse_cli_args(argv: list[str] | None = None) -> argparse.Namespace:
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    args = build_parser().parse_args(raw_argv)
    args.explicit_cli_options = explicit_cli_option_dests(raw_argv)
    if args.run_id is None:
        args.run_id = default_run_id(args.command)
    args.preflight_only = args.command == "preflight"
    apply_cli_scenario_defaults(args)
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_cli_args(argv)
    run_id = args.run_id
    artifact_dir = (REPO_ROOT / args.artifact_root / run_id).resolve()
    controller = Controller(args=args, run_id=run_id, artifact_dir=artifact_dir)

    def handle_signal(signum: int, _frame: Any) -> None:
        controller.final_status = f"signal_{signum}"
        controller.safe_scale_down()
        controller.finished_at = utc_now_iso()
        controller.write_summary()
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)
    try:
        controller.run()
    except Exception as error:
        controller.final_status = "failed"
        controller.finished_at = utc_now_iso()
        controller.result["error"] = type(error).__name__ + ": " + str(error)
        controller.write_summary()
        print(json.dumps({"ok": False, "runId": run_id, "artifactDir": str(artifact_dir), "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    if controller.final_status == "completed_scale_down_failed":
        print(
            json.dumps(
                {"ok": False, "runId": run_id, "artifactDir": str(artifact_dir), "status": controller.final_status},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 3
    if controller.final_status == E1S1_REPEAT_GUARD_FINAL_STATUS:
        print(
            json.dumps(
                {
                    "ok": False,
                    "runId": run_id,
                    "artifactDir": str(artifact_dir),
                    "status": controller.final_status,
                    "launchGuard": controller.result.get("launchGuard"),
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 4
    print(json.dumps({"ok": True, "runId": run_id, "artifactDir": str(artifact_dir), "status": controller.final_status}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
