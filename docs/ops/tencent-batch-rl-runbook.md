# Tencent batch RL runner runbook

This runbook records the current bounded Tencent Cloud batch path for Screeps RL training.

## Scope

- Controller: `/root/screeps` Lighthouse host.
- ASG: `asg-csw592ro` (`screeps-rl-batch-spot-8c16g-public`).
- Region: `ap-singapore`.
- Default capacity: `min=0`, `desired=0`, `max=1` until single-worker validation passes.
- Worker SSH: `screeps-batch` user, SSH key only, security group ingress `tcp/22` from controller public IP `43.128.104.34/32` only, plus worker iptables host firewall.
- Safety: all RL training cards/reports remain shadow/offline with `liveEffect:false`, `officialMmoWrites:false`, `officialMmoWritesAllowed:false`.

## Controller tool

The bounded controller runner lives at:

```bash
scripts/screeps_tencent_batch_rl_runner.py
```

Preflight, without creating a worker:

```bash
cd /root/screeps
python3 scripts/screeps_tencent_batch_rl_runner.py preflight \
  --run-id tencent-single-preflight-$(date -u +%Y%m%dt%H%M%Sz | tr 'TZ' 'tz')
```

Single-worker validation run:

```bash
cd /root/screeps
python3 scripts/screeps_tencent_batch_rl_runner.py run-single \
  --run-id tencent-single-$(date -u +%Y%m%dt%H%M%Sz | tr 'TZ' 'tz') \
  --ticks 50 --workers 1 --repetitions 1
```

The runner writes controller evidence under:

```text
runtime-artifacts/tencent-cloud/batch-runs/<run-id>/controller-summary.json
```

If a worker is created successfully, remote artifacts are collected back into:

```text
runtime-artifacts/tencent-cloud/batch-runs/<run-id>/remote/
```

## Guardrails

Before every scale-up the runner:

1. Executes `/root/.hermes/scripts/screeps-tencent-billing-guard.py --enforce` and requires `status=ok`.
2. Verifies the worker security group has exactly one SSH ingress rule: `tcp/22` from `43.128.104.34/32`.
3. Generates and validates a training-runner-compliant experiment card with reliability-first lexicographic reward order.
4. Sets ASG desired capacity to `1` only after the above pass.
5. Attempts ASG desired capacity `0` in `finally` and on SIGINT/SIGTERM.

On the worker it verifies:

- cloud-init completed or is non-blocking;
- `/opt/screeps-batch/READY` exists;
- iptables permits SSH only from the controller CIDR;
- `sshd -T` reports password auth disabled.

Secrets are copied only as a file path (`/root/.secret/.env` -> worker job dir) and are not printed in controller summaries.

## Current blocker discovered on 2026-05-17

The first `run-single` attempt did **not** create a worker. Tencent ASG scale-out activities failed before instance creation with:

```text
账户余额不足，无法购买云主机。
```

Other non-primary details in the same activity also show some candidate AZ/type/image incompatibilities (`S3.2XLARGE16` invalid in `ap-singapore-4`, `S2.2XLARGE16` image mismatch, `SA5.2XLARGE16` disk incompatibility, `SA2.2XLARGE16` spot capacity shortage), but the owner-action blocker is account balance / purchase enablement.

Because no CVM was created, no paid worker runtime accumulated beyond failed purchase attempts. The controller forced ASG desired capacity back to `0` and verified `InstanceCount=0`.

## COS readiness

Current controller state:

- `coscmd` is installed in the Hermes venv.
- No `/root/.cos.conf` or coscli config is present.
- The first bounded runner intentionally uses SSH/SCP artifact transfer to avoid creating a new COS bucket or storage spend before the first worker proof.

For multi-worker scale-out after the single-worker validation report, replace SSH artifact return with a private COS bucket/prefix and a custom policy scoped to:

```text
jobs/
code/
artifacts/
logs/
markers/
```

Do not leave broad `QcloudCOSFullAccess` as the long-term steady state.

## Resource-sizing evidence to collect after balance is fixed

The single-worker report must include:

- ASG activity ID and worker instance ID;
- bootstrap wall time and package transfer size;
- remote training wall time (`/usr/bin/time -v` stderr);
- training report artifact count, ranking, warnings, safety flags;
- total Tencent bill before/after or latest bill guard artifact;
- whether Docker/native dependency warm-up dominates runtime.

Use that evidence before recommending `max>1` or 16c/32g workers.
