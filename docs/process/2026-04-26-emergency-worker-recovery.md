# Emergency Worker Recovery Implementation

Date: 2026-04-26T03:21:40+08:00

## Context

The autonomous continuation worker rechecked the current active state and found `telemetry-mvp` already completed. Docker and Compose were available, but the Dockerized private-server smoke test remained blocked because the cron environment did not provide `STEAM_KEY`; no secret-bearing config was created or committed.

Runtime environment checks:

- `docker version`: Docker Engine server `29.1.3`
- `docker compose version`: `Docker Compose version v2.40.3`
- `docker ps`: Docker daemon reachable; no running containers
- Secret preflight: `STEAM_KEY` missing, `SCREEPS_EMAIL` missing, `SCREEPS_PASSWORD` present but not sufficient for the launcher smoke path by itself

Because the smoke runbook still lacked safe local private-server credentials/config, the worker advanced the next deterministic runtime-hardening slice from the roadmap: zero-creep / low-energy emergency recovery.

## Codex-authored implementation

Codex CLI authored and committed the production/test/build changes from `/root/screeps`.

Commit:

- `e7cb06e feat: add emergency worker recovery`

Changed files:

- `prod/src/spawn/bodyBuilder.ts`
- `prod/src/spawn/spawnPlanner.ts`
- `prod/test/spawnPlanner.test.ts`
- `prod/dist/main.js`

Implemented behavior:

- Normal worker body selection now considers room energy capacity and waits for the normal body when non-emergency replacement workers are needed.
- If a colony has zero active workers and cannot yet afford the normal capacity-based worker body, spawn planning may request the minimum emergency worker body (`WORK+CARRY+MOVE`) once 200 energy is available.
- Spawn planning returns no request below the emergency body's cost, avoiding impossible spawn attempts.
- Existing target-worker, busy-spawn, replacement, telemetry, and task-flow behavior remains compatible.

## TDD and verification

Codex followed a test-first cycle for the spawn-planning behavior. The targeted RED run initially failed because the current planner used available energy and immediately downshifted to the 200-energy body for replacements; Codex then adjusted body selection so only zero-worker emergency recovery may use the basic emergency body.

Final verification run by the main Hermes agent after Codex implementation:

```text
cd prod && npm run typecheck
cd prod && npm test -- --runInBand
cd prod && npm run build
```

Result:

- Typecheck: passed
- Tests: passed, 12 suites / 44 tests
- Build: passed, `prod/dist/main.js` generated

## Commit note

The first Codex implementation run verified the changes but could not write the git commit because of a Codex sandbox/remount issue. The main agent removed the transient untracked `.codex` artifact, then invoked a narrow Codex `--yolo` commit-only task that staged exactly the four intended files and created the commit, preserving Codex authorship for `prod/` changes.

## Next recommended slice

Private-server smoke remains the preferred next validation step once safe local launcher credentials/config are available. If `STEAM_KEY` remains unavailable in the next cron run, continue deterministic runtime hardening that reduces first-smoke risk, such as:

1. adding lifecycle coverage around emergency-worker spawn execution through recovery to normal worker planning, or
2. adding bounded runtime alerts for unrecoverable spawn failures once concrete failure modes are observed.
