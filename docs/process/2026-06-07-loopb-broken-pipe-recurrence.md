# Loop B Broken Pipe Recurrence Diagnostic

Issue: #1761
Date: 2026-06-07

## Classification

The recurring `RuntimeError: [Errno 32] Broken pipe` in Loop B is classified as an outer Hermes scheduled-output/final-response transport failure, not as a Screeps runtime failure and not as a repository `scripts/screeps_rl_control_loop_ledgers.py` producer failure.

The failed output `/root/.hermes/cron/output/01609968392a/2026-06-07_21-21-13.md` contains the scheduled prompt followed by:

```text
RuntimeError: [Errno 32] Broken pipe
```

It contains no Loop B domain response. The earlier #1756 failure output at `/root/.hermes/cron/output/01609968392a/2026-06-07_12-38-53.md` has the same shape. By contrast, the prior validation output `/root/.hermes/cron/output/01609968392a/2026-06-07_14-01-12.md` contains a complete `RL Policy Online Advantage Ledger` response and cites `runtime-artifacts/rl-control-loop/20260607T060028Z-policy-advantage.json`.

## Evidence

- Fresh policy artifact still exists around the recurrence: `/root/screeps/runtime-artifacts/rl-control-loop/20260607T130920Z-policy-advantage.json`.
- That artifact reports `onlineUtilityStatus=UNPROVEN`, `deployabilityStatus=BLOCKED`, `githubComment=skipped_no_atomic_issue`, `rewardDecisionId=RD-AUTO-9f33873ce71c`, and `boundedProducer` metadata.
- Runtime survival evidence is healthy: `/root/screeps/runtime-artifacts/screeps-monitor/rl-steward-check-20260607T133515Z/health-gate.json` has `ok=true`, and `alert.json` has `ok=true`, `alert=false`, with 3 owned rooms.
- Fresh console capture `/root/screeps/runtime-artifacts/runtime-summary-console/runtime-summary-console-20260607T133441Z.log` includes nonzero energy evidence at tick `1901813`: E29N55 `energyAvailable=931`, `workerCarriedEnergy=427`; E29N56 `energyAvailable=1300`, `workerCarriedEnergy=890`; E29N57 `energyAvailable=1800`, `workerCarriedEnergy=416`.
- The repository bounded producer already writes artifacts before stdout delivery: `scripts/screeps_rl_control_loop_ledgers.py` calls `write_json_atomic(path, payload)` before emitting the compact stdout summary.
- The shared CLI output helper `scripts/screeps_cli_io.py` bounds JSON-line output and treats `BrokenPipeError`, `ConnectionAbortedError`, and `ConnectionResetError` as closed-receiver delivery failures.
- Existing tests cover closed stdout/flush behavior for the shared control-loop ledger CLI path and bounded policy-advantage stdout output in `scripts/test_screeps_rl_control_loop_ledgers.py`.
- `docs/ops/cron-and-route-registry.md` still describes Loop B `01609968392a` as a DeepSeek scheduled prompt delivered to `discord:#task-queue`, not as a direct repository CLI command. The broken pipe observed here occurs in that outer scheduled model/output path.

## Repository Change Decision

No production or script change is indicated by the inspected evidence. The repository-side bounded producer is already artifact-first and broken-pipe tolerant for its own stdout writes. A repository script cannot catch a `Broken pipe` raised by the scheduler/model final-response transport after the prompt run has left the script boundary.

The failed markdown output must not be consumed as policy-advantage evidence. The machine-readable policy artifact remains the durable evidence surface.

## No-Code Recovery Path

1. Keep #1761 as the active atomic owner. Do not reopen #1756 and do not route progress/evidence to #879, #893, or #1589.
2. Have the controller perform a clean Loop B verification run. Prefer the bounded producer path so the scheduled job emits only the compact JSON summary after the artifact is written:

```bash
cd /root/screeps
python3 scripts/screeps_rl_control_loop_ledgers.py policy-advantage \
  --repo-root /root/screeps \
  --artifact-root /root/screeps/runtime-artifacts \
  --out-dir /root/screeps/runtime-artifacts/rl-control-loop \
  --stdout-bytes 1024
```

3. If the direct bounded producer succeeds but the recurring cron still records `RuntimeError: [Errno 32] Broken pipe`, treat the blocker as external Hermes cron/provider output transport. The cron should be adjusted outside this worktree to call the bounded producer or otherwise clamp final-response delivery to a small artifact pointer.
4. Acceptance evidence for #1761 should be one post-recovery Loop B output that has no `RuntimeError: [Errno 32] Broken pipe` and cites a fresh `runtime-artifacts/rl-control-loop/*-policy-advantage.json` artifact.
5. Preserve the safety classification unless true online KPI evidence appears: offline/private/shadow evidence remains `onlineUtilityStatus=UNPROVEN` and `deployabilityStatus=BLOCKED`; no official MMO writes, deploy, learned-policy live control, Tencent paid compute, or owner ping are part of this recovery.

## Remaining Blocker

The unresolved blocker is outside repository code: recurring job `01609968392a` can still fail while writing or transporting its model final response. The repository-owned artifact path is bounded and recoverable; the controller needs to verify or change the external cron execution/delivery surface.
