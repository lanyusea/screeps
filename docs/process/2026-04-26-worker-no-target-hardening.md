# Worker no-target fallback hardening

Date: 2026-04-26T07:11:23+08:00

## Objective

Add deterministic Jest coverage for real-runtime edge cases surfaced by private-server validation planning: worker rooms may temporarily have no accessible source, no energy sink, no construction site, or no owned controller. The worker loop must not throw, retain invalid tasks, or attempt actions against stale targets in those states.

## Codex-authored code/test change

Codex CLI implemented and committed the production/test slice in worktree `/root/screeps-worktrees/runtime-risk-hardening-20260426`.

- Commit: `12a2c4a test: harden worker no-target fallbacks`
- Changed files:
  - `prod/test/workerTasks.test.ts`
  - `prod/test/workerRunner.test.ts`

## Coverage added

- `selectWorkerTask` returns `null` without throwing when a zero-energy worker has no sources.
- `selectWorkerTask` returns `null` without throwing when an energy-carrying worker has no energy sinks, construction sites, or owned controller.
- `runWorker` leaves no task assigned and does not throw in both no-target task-selection cases.
- `runWorker` clears stale `transfer`, `build`, and `upgrade` tasks in a controllerless/no-target room without calling `transfer`, `build`, `upgradeController`, or `moveTo`.

No production source change was required; the existing worker task selection and stale-target handling already matched the desired behavior. The slice makes that runtime safety contract explicit and regression-tested.

## Verification

Run from `prod/` after the Codex commit:

```text
npm run typecheck
npm test -- --runInBand
npm run build
```

Result: passed.

- Jest: 12 suites passed, 66 tests passed.
- Build: `prod/dist/main.js` built successfully and remained functionally unchanged because only tests changed.

## Follow-up

Continue the priority queue with one of:

1. merge/reconcile the private-server smoke harness branch once review/CI gates allow it;
2. run one more live-token runtime-monitor smoke and schedule `#runtime-summary` / `[SILENT]` no-alert `#runtime-alerts` jobs;
3. add further deterministic hardening only when runtime observation exposes concrete risks.
