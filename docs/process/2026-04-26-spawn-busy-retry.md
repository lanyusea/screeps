# Spawn Busy Retry Hardening

Date: 2026-04-26T04:05:34+08:00

## Context

Private-server smoke validation remains blocked by the current `screepers/screeps-launcher` path resolving a `screeps@4.3.0` runtime that requires Node.js `>=22.9.0` while the launcher container provides Node.js `12.22.12`. To continue reducing runtime risk before private-server validation, this slice added deterministic coverage and a minimal behavior hardening for spawn retry handling.

## Codex-authored change

Commit: `b7f002e` (`feat: retry busy spawn attempts`)

Implemented:

- When the planned spawn returns `ERR_BUSY`, the economy loop now retries other idle spawns in the same colony instead of losing the spawn opportunity for the tick.
- Spawn telemetry records each attempted spawn outcome, including the initial busy result and the successful retry result.
- Deterministic Jest coverage was added for the busy-spawn retry path and emitted runtime-summary events.
- `prod/dist/main.js` was rebuilt.

## Verification

Executed by Hermes after Codex returned:

- `cd prod && npm run typecheck`: passed
- `cd prod && npm test -- --runInBand`: passed, 12 suites / 45 tests
- `cd prod && npm run build`: passed

## Notes

The initial Codex `--full-auto` implementation could not commit because the sandbox mounted `.git` read-only. Per the Codex workflow, Hermes re-ran a narrow Codex `--yolo` commit-only task that staged exactly:

- `prod/src/economy/economyLoop.ts`
- `prod/test/economyLoop.test.ts`
- `prod/dist/main.js`

The final Codex-authored commit was created successfully with author `lanyusea's bot <lanyusea@gmail.com>`.

An untracked `.codex` entry remains in the worktree and was intentionally not staged or committed.

## Next step

Private-server-first validation remains the deployment gate. Candidate next work remains either resolving the launcher/private-server Node runtime mismatch or continuing small deterministic hardening slices while the private-server path is blocked.
