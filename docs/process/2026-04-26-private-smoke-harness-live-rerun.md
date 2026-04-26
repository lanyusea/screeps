# Private smoke harness live rerun

Date: 2026-04-26
Branch: `fix/private-smoke-steam-key-perms-20260426`
Pull request: <https://github.com/lanyusea/screeps/pull/16>

## Objective

Run the merged private-server smoke harness live from a fresh ignored workdir and fix any harness automation issues that prevented the pinned Dockerized path from being reusable.

## Findings and fixes

The first live rerun attempt used the default local ports and failed because an older pinned smoke stack was still bound to `127.0.0.1:21025-21026`. Follow-up live reruns used alternate local ports `21125/21126` to avoid disturbing the older observation stack.

The harness then exposed three automation issues:

1. `screeps-launcher` could not read the generated `STEAM_KEY` file through the bind mount when it was written with mode `0600`.
   - Codex commit: `b7e05fd fix: make smoke steam key container-readable`.
   - Fix: generated ignored `STEAM_KEY` is mode `0644`; reports and logs still redact secret values.

2. `screeps-launcher` could not install Node into the bind-mounted workdir because the container user did not have write permission.
   - Codex commit: `342d766 fix: make smoke workdir container-writable`.
   - Fix: live preparation makes only the harness-generated, already-safe ignored workdir/subdirectories container-writable with sticky directory permissions.

3. `docker compose exec -T screeps screeps-launcher cli` panicked in go-prompt because the launcher CLI expects a TTY.
   - Codex commit: `a27532f fix: run smoke cli through http endpoint`.
   - Fix: the harness now uses the generated local HTTP CLI endpoint at `http://<host>:<cli_port>/cli` for `system.resetAllData()`, `utils.importMapFile(...)`, and `system.resumeSimulation()`.

## Verification

Controller verification after each Codex fix passed:

```bash
python3 -m py_compile scripts/screeps-private-smoke.py
python3 scripts/screeps-private-smoke.py self-test
SCREEPS_PRIVATE_SMOKE_WORKDIR=/tmp/screeps-private-smoke-dry-run-verify-controller-cli python3 scripts/screeps-private-smoke.py dry-run
cd prod && npm run typecheck && npm test -- --runInBand && npm run build
```

Latest offline result after the HTTP CLI fix:

- Private smoke self-test: 27 tests passed.
- Prod Jest: 12 suites / 68 tests passed.
- Prod build succeeded and regenerated `prod/dist/main.js` from the existing source.

## Live smoke result

Command shape, with secret values sourced locally but not printed:

```bash
SCREEPS_PRIVATE_SMOKE_HTTP_PORT=21125 \
SCREEPS_PRIVATE_SMOKE_CLI_PORT=21126 \
python3 scripts/screeps-private-smoke.py run \
  --work-dir /root/screeps/runtime-artifacts/screeps-private-smoke-live-20260426T0616Z \
  --stats-timeout 420 \
  --poll-interval 5 \
  --min-creeps 1
```

Result: `ok: true`.

Redacted report path:

- `/root/screeps/runtime-artifacts/screeps-private-smoke-live-20260426T0616Z/private-smoke-report-20260426T061745Z.json`

Key observations:

- Dockerized pinned launcher started with `screepers/screeps-launcher:v1.16.2`, `screeps@4.2.21`, launcher Node `Erbium`, Mongo `8.2.7`, and Redis `7.4.8`.
- HTTP readiness succeeded on alternate local server URL `http://127.0.0.1:21125`.
- HTTP CLI reset/import/resume succeeded:
  - `system.resetAllData()` returned `undefined`.
  - `utils.importMapFile('/screeps/maps/map-0b6758af.json')` returned `Map imported! Restart the server and use system.resumeSimulation() to unpause ticks`.
  - `system.resumeSimulation()` returned `OK`.
- The harness registered the local `smoke` user, signed in, uploaded the current `prod/dist/main.js`, and verified the code round-trip hash matched the local artifact.
- Spawn placement succeeded for `Spawn1` in `E1S1` at `(20,20)`.
- `/stats` reached `gametime: 30`, `totalRooms: 169`, `ownedRooms: 1`, `activeUsers: 1`, and one smoke-user creep.
- Mongo summary found one owned spawn and one bot-created `WORK/CARRY/MOVE` worker, `worker-E1S1-5`, in `E1S1`.

## Current status

PR #16 remains open and must be merged or explicitly closed as obsolete before this task is complete. The 15-minute merge wait from PR creation has elapsed; remaining gates are PR checks/review-thread state and mergeability.
