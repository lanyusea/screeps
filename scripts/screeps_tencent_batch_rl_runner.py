#!/usr/bin/env python3
"""Run bounded Screeps RL training on a Tencent Cloud ASG batch worker.

This controller-side tool keeps the ASG at desired=0 by default, scales one
worker for a single offline/private training job, copies a redacted repo bundle
and local STEAM_KEY env file over SSH, collects artifacts, and always attempts to
scale the ASG back to zero.

No secret values are printed or persisted in controller summaries.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TCCLI = Path("/root/.hermes/hermes-agent/venv/bin/tccli")
DEFAULT_BILLING_GUARD = Path("/root/.hermes/scripts/screeps-tencent-billing-guard.py")
DEFAULT_SECRET_ENV = Path("/root/.secret/.env")
DEFAULT_SSH_KEY = Path("/root/.ssh/id_ed25519")
DEFAULT_REGION = "ap-singapore"
DEFAULT_ASG_ID = "asg-csw592ro"
DEFAULT_CONTROLLER_IP = "43.128.104.34/32"
DEFAULT_WORKER_USER = "screeps-batch"
DEFAULT_REMOTE_BASE = "/opt/screeps-batch/jobs"
DEFAULT_ARTIFACT_ROOT = Path("runtime-artifacts/tencent-cloud/batch-runs")
RUN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{2,80}$")
SSH_CONNECT_OPTIONS = (
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=8",
    "-o", "StrictHostKeyChecking=accept-new",
)


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
    def ssh_target(self) -> str:
        if not self.public_ip:
            raise BatchRunError("public IP is not known yet")
        return f"{self.args.worker_user}@{self.public_ip}"

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
        payload = {
            "type": "screeps-tencent-batch-rl-run",
            "schemaVersion": 1,
            "runId": self.run_id,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "partial": partial,
            "finalStatus": self.final_status,
            "region": self.args.region,
            "autoScalingGroupId": self.args.asg_id,
            "workerUser": self.args.worker_user,
            "instanceId": self.instance_id,
            "publicIp": self.public_ip,
            "privateIp": self.private_ip,
            "remoteDir": self.remote_dir,
            "localArtifactDir": str(self.artifact_dir),
            "safety": {
                "liveEffect": False,
                "officialMmoWrites": False,
                "officialMmoWritesAllowed": False,
                "billingGuardBeforeScale": True,
                "scaleDownAttempted": any(step.name == "scale_down" for step in self.steps),
                "sshControllerOnlyExpected": self.args.controller_ip,
                "secretsPrinted": False,
            },
            "inputs": {
                "datasetRunId": self.args.dataset_run_id,
                "experimentCard": str(self.experiment_card_path()),
                "ticks": self.args.ticks,
                "workers": self.args.workers,
                "repetitions": self.args.repetitions,
                "trainingApproach": self.args.training_approach,
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
        cmd = [
            "ssh",
            "-i", self.args.ssh_key,
            *SSH_CONNECT_OPTIONS,
            self.ssh_target,
            remote_command,
        ]
        return self.run_cp(name, cmd, check=check, timeout=timeout)

    def scp_to_worker(self, name: str, local_path: Path, remote_path: str, *, timeout: int = 300) -> None:
        self.run_cp(
            name,
            [
                "scp",
                "-i", self.args.ssh_key,
                *SSH_CONNECT_OPTIONS,
                str(local_path),
                f"{self.ssh_target}:{remote_path}",
            ],
            timeout=timeout,
        )

    def scp_from_worker(self, name: str, remote_path: str, local_path: Path, *, timeout: int = 900) -> None:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        self.run_cp(
            name,
            [
                "scp",
                "-i", self.args.ssh_key,
                *SSH_CONNECT_OPTIONS,
                f"{self.ssh_target}:{remote_path}",
                str(local_path),
            ],
            timeout=timeout,
        )

    def experiment_card_path(self) -> Path:
        return self.artifact_dir / "experiment_card.json"

    def run(self) -> None:
        self.artifact_dir.mkdir(parents=True, exist_ok=True)
        validate_static_inputs(self.args, self.run_id)
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
        finally:
            self.scale_down()
        self.finished_at = utc_now_iso()
        self.write_summary()

    def ensure_map_present(self) -> None:
        target = REPO_ROOT / "maps" / "map-0b6758af.json"
        if target.is_file():
            self.record_step("map_preflight", time.time(), True, detail={"path": str(target)})
            return
        candidates = sorted((REPO_ROOT / "runtime-artifacts").glob("**/maps/map-0b6758af.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not candidates:
            raise BatchRunError("map-0b6758af.json is missing and no runtime artifact source was found")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(candidates[0].read_bytes())
        self.record_step("map_preflight", time.time(), True, detail={"path": str(target), "source": str(candidates[0])})

    def ensure_dist_present(self) -> None:
        dist = REPO_ROOT / "prod" / "dist" / "main.js"
        if not dist.is_file():
            raise BatchRunError("prod/dist/main.js missing; build before launching worker training")
        self.record_step("dist_preflight", time.time(), True, detail={"path": str(dist), "bytes": dist.stat().st_size})

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
        allowed = [p for p in ingress if str(p.get("Protocol", "")).lower() == "tcp" and str(p.get("Port")) == "22"]
        bad = [p for p in allowed if p.get("CidrBlock") != self.args.controller_ip]
        if bad or len(allowed) != 1:
            raise BatchRunError(f"security group SSH ingress is not controller-only: {allowed}")
        self.result["securityGroup"] = {"id": self.args.security_group_id, "sshIngress": allowed}

    def generate_experiment_card(self) -> None:
        card = self.experiment_card_path()
        created_at = utc_now_iso()
        cp = self.run_cp(
            "generate_experiment_card",
            [
                sys.executable,
                "scripts/screeps_rl_experiment_card.py",
                "--dataset-run-id", self.args.dataset_run_id,
                "--training-approach", self.args.training_approach,
                "--created-at", created_at,
                "--output", str(card),
            ],
            timeout=60,
        )
        del cp  # step is already recorded
        # Apply bounded-run overrides after generation; keep schema-valid fields.
        payload = json.loads(card.read_text(encoding="utf-8"))
        simulation = payload.setdefault("simulation", {})
        simulation.update({
            "ticks": self.args.ticks,
            "workers": self.args.workers,
            "repetitions": self.args.repetitions,
            "host_port_start": self.args.host_port_start,
            "code_path": "prod/dist/main.js",
            "map_source_file": "maps/map-0b6758af.json",
            "simulator_out_dir": "runtime-artifacts/rl-simulator",
        })
        if self.args.variant:
            payload["strategy_variants"] = self.args.variant
        payload["run_id"] = self.run_id
        card.write_text(canonical_json(payload), encoding="utf-8")
        self.run_cp(
            "validate_experiment_card",
            [sys.executable, "scripts/screeps_rl_experiment_card.py", "--validate", "--input", str(card)],
            timeout=60,
        )
        self.result["experimentCard"] = {"path": str(card), "createdAt": created_at, "cardId": payload.get("card_id")}

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

    def latest_scale_out_failure(self) -> dict[str, Any] | None:
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
            if activity.get("ActivityType") == "SCALE_OUT" and activity.get("StatusCode") == "FAILED":
                return activity
        return None

    def scale_up_and_wait(self) -> None:
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
                    if self.wait_for_ssh():
                        self.result["worker"] = {
                            "instanceId": self.instance_id,
                            "publicIp": self.public_ip,
                            "privateIp": self.private_ip,
                            "instanceType": cvm.get("InstanceType"),
                            "state": cvm.get("InstanceState"),
                        }
                        return
            failure = self.latest_scale_out_failure()
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
printf 'iptables='; sudo iptables -S INPUT | tr '\n' ';'; printf '\n'
printf 'sshd='; sudo sshd -T 2>/dev/null | egrep '^(passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|permitrootlogin|allowusers) ' | tr '\n' ';'; printf '\n'
""".strip()
        cp = self.ssh_cmd("verify_worker_security", bash_lc(cmd), timeout=180)
        out = cp.stdout
        if f"-s {self.args.controller_ip}" not in out and self.args.controller_ip not in out:
            raise BatchRunError("worker iptables does not show controller-only SSH source")
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
sudo usermod -aG docker screeps-batch || true
sudo mkdir -p "$REMOTE_DIR" /var/log/screeps-batch
sudo chown -R screeps-batch:screeps-batch "$REMOTE_DIR" /var/log/screeps-batch
python3 --version
docker --version
(docker compose version || docker-compose version)
""".strip()
        self.ssh_cmd(
            "bootstrap_worker",
            "REMOTE_DIR=" + shlex.quote(self.remote_dir) + " " + bash_lc(remote),
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
mkdir -p runtime-artifacts/rl-training runtime-artifacts/rl-simulator
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
  'artifactCount': d.get('artifactCount'),
  'ranking': d.get('ranking'),
  'changedTopCount': d.get('changedTopCount'),
  'warnings': d.get('warnings'),
  'simulation': d.get('simulation'),
  'liveEffect': d.get('liveEffect'),
  'officialMmoWrites': d.get('officialMmoWrites'),
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
tar -czf remote-artifacts.tar.gz \
  experiment_card.json card-validation.json training-summary.json training-stderr.log report-extract.json \
  -C repo runtime-artifacts/rl-training runtime-artifacts/rl-simulator
""".strip()
        self.ssh_cmd("pack_remote_artifacts", "REMOTE_DIR=" + shlex.quote(self.remote_dir) + " " + bash_lc(remote), timeout=600)
        local_tar = self.artifact_dir / "remote-artifacts.tar.gz"
        self.scp_from_worker("download_remote_artifacts", remote_tar, local_tar, timeout=self.args.transfer_timeout_seconds)
        extract_dir = self.artifact_dir / "remote"
        if extract_dir.exists():
            subprocess.run(["rm", "-rf", str(extract_dir)], check=True)
        extract_dir.mkdir(parents=True, exist_ok=True)
        with tarfile.open(local_tar, "r:gz") as tar:
            tar.extractall(extract_dir)
        self.result["remoteArtifacts"] = {"tarball": str(local_tar), "extractDir": str(extract_dir), "bytes": local_tar.stat().st_size}

    def verify_remote_training_report(self) -> None:
        report = self.artifact_dir / "remote" / "repo" / "runtime-artifacts" / "rl-training" / f"{self.run_id}.json"
        if not report.is_file():
            raise BatchRunError(f"remote training report missing after collection: {report}")
        data = json.loads(report.read_text(encoding="utf-8"))
        if data.get("liveEffect") is not False or data.get("officialMmoWrites") is not False:
            raise BatchRunError("remote training report safety flags are unsafe")
        artifact_count = data.get("artifactCount")
        if not isinstance(artifact_count, int) or artifact_count <= 0:
            raise BatchRunError(f"remote training artifactCount invalid: {artifact_count!r}")
        self.result["trainingReport"] = {
            "path": str(report),
            "reportId": data.get("reportId"),
            "artifactCount": artifact_count,
            "changedTopCount": data.get("changedTopCount"),
            "ranking": data.get("ranking"),
            "warnings": data.get("warnings"),
            "simulation": data.get("simulation"),
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
            ok = cp.returncode == 0
            if ok:
                deadline = time.time() + self.args.scale_down_timeout_seconds
                while time.time() < deadline:
                    try:
                        instances = self.describe_asg_instances()
                    except Exception:
                        instances = []
                    if not instances:
                        break
                    time.sleep(15)
        finally:
            self.record_step("scale_down", started, ok, cp, desiredCapacity=0)


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def default_run_id() -> str:
    return "tencent-single-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dt%H%M%sz")


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def tail_text(raw: str | None, limit: int = 3000) -> str:
    if not raw:
        return ""
    text = raw.replace("\r", "")
    return text[-limit:]


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
    if args.workers != 1:
        raise BatchRunError("this bounded validation runner only supports --workers 1")
    if args.repetitions < 1 or args.ticks < 1:
        raise BatchRunError("ticks and repetitions must be positive")
    if not args.controller_ip.endswith("/32"):
        raise BatchRunError("controller IP must be a /32 CIDR")


def create_repo_bundle(package: Path) -> None:
    package.parent.mkdir(parents=True, exist_ok=True)
    exclude_dirs = {".git", "node_modules", "__pycache__", ".codex", ".codex-local-git", ".git-local"}
    exclude_prefixes = {
        "runtime-artifacts/",
        "docs/roadmap-kpi.sqlite",
        "prod/node_modules",
        "maps/.git",
    }
    with tarfile.open(package, "w:gz") as tar:
        for path in REPO_ROOT.rglob("*"):
            rel = path.relative_to(REPO_ROOT).as_posix()
            parts = set(path.relative_to(REPO_ROOT).parts)
            if parts & exclude_dirs:
                continue
            if any(rel == prefix.rstrip("/") or rel.startswith(prefix) for prefix in exclude_prefixes):
                continue
            tar.add(path, arcname=rel, recursive=False)
    if package.stat().st_size <= 0:
        raise BatchRunError("repo bundle is empty")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a bounded Screeps RL training job on one Tencent ASG worker.")
    parser.add_argument("command", choices=("run-single", "preflight"))
    parser.add_argument("--run-id", default=default_run_id())
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
    parser.add_argument("--dataset-run-id", default="rl-3d29e8b9397d")
    parser.add_argument("--training-approach", default="bandit", choices=("bandit", "evolutionary", "policy_gradient"))
    parser.add_argument("--ticks", type=int, default=50)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--host-port-start", type=int, default=24125)
    parser.add_argument("--variant", action="append", help="Strategy variant id; repeat to override generated card variants.")
    parser.add_argument("--artifact-root", type=Path, default=DEFAULT_ARTIFACT_ROOT)
    parser.add_argument("--scale-timeout-seconds", type=int, default=900)
    parser.add_argument("--scale-down-timeout-seconds", type=int, default=600)
    parser.add_argument("--bootstrap-timeout-seconds", type=int, default=1800)
    parser.add_argument("--training-timeout-seconds", type=int, default=3600)
    parser.add_argument("--transfer-timeout-seconds", type=int, default=1200)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    args.preflight_only = args.command == "preflight"
    run_id = args.run_id
    artifact_dir = (REPO_ROOT / args.artifact_root / run_id).resolve()
    controller = Controller(args=args, run_id=run_id, artifact_dir=artifact_dir)

    def handle_signal(signum: int, _frame: Any) -> None:
        controller.final_status = f"signal_{signum}"
        try:
            controller.scale_down()
        finally:
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
    print(json.dumps({"ok": True, "runId": run_id, "artifactDir": str(artifact_dir), "status": controller.final_status}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
