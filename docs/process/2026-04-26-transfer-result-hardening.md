# Transfer Result Race Hardening

Date: 2026-04-26T08:46:46+08:00
Branch: `test/transfer-result-hardening-20260426`
Pull request: https://github.com/lanyusea/screeps/pull/9

## Objective

Add one deterministic runtime-risk hardening slice for the worker task runner. The targeted race is a transfer sink becoming full after the existing target precheck but before `creep.transfer` executes.

## Implementation

Codex implemented and committed the `prod/` changes using a test-first workflow:

- added a focused Jest test in `prod/test/workerRunner.test.ts` that first failed against the previous behavior;
- updated `prod/src/creeps/workerRunner.ts` so `ERR_FULL` from a transfer execution clears the stale transfer task and immediately reselects a worker task in the same tick;
- rebuilt `prod/dist/main.js`.

The resulting behavior keeps a full-carry worker from wasting a tick moving toward or retrying a transfer target that became full due to a same-tick runtime race, and allows existing task selection to fall back to build/upgrade/no-task.

## Commits

- Codex-authored code commit: `a95afdc` (`test: handle full transfer result race`)

## Verification

Hermes re-ran the required verification after the Codex commit:

- `cd prod && npm run typecheck`: passed
- `cd prod && npm test -- --runInBand`: passed, 12 suites / 60 tests
- `cd prod && npm run build`: passed

## Notes

The first Codex implementation run completed and verified the code but could not commit under `--full-auto` because the worktree git metadata was outside the sandbox. A narrow Codex `--yolo` commit-only run then staged exactly `prod/src/creeps/workerRunner.ts`, `prod/test/workerRunner.test.ts`, and `prod/dist/main.js`, and created the real commit with author `lanyusea's bot <lanyusea@gmail.com>`.
