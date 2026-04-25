# Parallel Throughput Increase and Private Smoke Breakthrough

Last updated: 2026-04-26T05:15:00+08:00

## Trigger

The owner asked to increase parallelism and throughput because the current Codex $200 plan has ample unused quota.

## Operating changes made

- Tightened the autonomous continuation worker cadence from 10 minutes to 5 minutes during active development/P0 periods.
- Added/restored a P0 agent operations monitor cadence of 15 minutes for cron/routing/git/active-state health.
- Preserved the production-code boundary: `prod/` changes are implemented and committed by Codex CLI; Hermes orchestrates, verifies, documents, and pushes.
- Used independent worktrees for parallel Codex tasks to avoid dirtying or racing the main worktree.

## Parallel work launched

### Research subagent: private-server room/map initialization

Result: the remaining `totalRooms: 0` blocker was traced to `screepsmod-admin-utils` map import under launcher Node 12. The installed mod path uses global `fetch()` for `serverConfig.map: random_1x1`, but Node 12 has no global `fetch`, so the random-map import fails before creating rooms.

Fast fix: pre-download a map JSON and import it from the mounted filesystem with:

```js
utils.importMapFile('/screeps/maps/map-0b6758af.json')
```

This avoids the Node 12 `fetch` path.

### Codex worktree: body builder invariants

Branch/worktree: `codex/body-builder-invariants`

Codex-authored commit merged to `main`:

- `7d2a04d test: harden body builder invariants`

Implemented tests:

- official Screeps cost coverage for all body part constants;
- emergency worker boundary at 199/200 energy;
- generated worker bodies are complete `WORK/CARRY/MOVE` patterns;
- generated bodies are affordable and never exceed 50 parts.

### Codex worktree: worker runner stale target/build/upgrade coverage

Branch/worktree: `codex/worker-runner-stale-targets`

Codex-authored commit merged to `main`:

- `4706868 test: harden worker runner task execution`

Implemented tests:

- build task executes `creep.build` and moves on `ERR_NOT_IN_RANGE`;
- upgrade task executes `creep.upgradeController` and moves on `ERR_NOT_IN_RANGE`;
- stale/missing build and upgrade targets are cleared/reassigned without calling stale actions.

Verification after merging both Codex commits:

```text
cd prod && npm run typecheck      # passed
cd prod && npm test -- --runInBand # passed, 12 suites / 59 tests
cd prod && npm run build          # passed
```

## Private-server smoke result

The pinned Dockerized private-server path advanced beyond the previous blocker.

Run details:

- Workdir: `/tmp/screeps-private-smoke-pinned`
- Config changed locally/untracked from `serverConfig.map: random_1x1` to `serverConfig.mapFile: /screeps/maps/map-0b6758af.json`
- Map downloaded from `https://maps.screepspl.us/maps/map-0b6758af.json`
- `docker compose up -d` started Mongo, Redis, and Screeps server.
- `utils.importMapFile('/screeps/maps/map-0b6758af.json')` returned: `Map imported! Restart the server and use system.resumeSimulation() to unpause ticks`
- After restart and `system.resumeSimulation()`, `/stats` reported `totalRooms: 169`.
- Registered local smoke user, uploaded current `prod/dist/main.js`, and placed `Spawn1` in `E1S1` at `(20,20)` using token auth with both `X-Username` and `X-Token` headers.

Observed validation:

```text
/api/user/overview: rooms ["E1S1"]
/api/game/room-overview?room=E1S1&shard=shardX: owner username "smoke"
/api/game/room-status?room=E1S1&shard=shardX: status "normal"
/stats: totalRooms 169, ownedRooms 1, activeUsers 1
Mongo room objects: owned spawn Spawn1 plus worker creeps named worker-E1S1-*
```

This validates that the pinned Dockerized private server can now initialize rooms, accept code upload, place a spawn, tick the uploaded bot, and produce owned creeps.

## Runtime monitor artifact from continuation worker

The continuation worker also produced an external runtime monitor script and warm editorial smoke artifacts:

- `scripts/screeps-runtime-monitor.py`
- `runtime-artifacts/screeps-monitor-smoke/summary-shardX-E48S28.{svg,png}`
- `runtime-artifacts/screeps-monitor-smoke/alert-shardX-E48S28.{svg,png}`

Verification:

```text
python3 scripts/screeps-runtime-monitor.py self-test # passed, 8 tests
```

Vision review of the summary PNG found it readable, not cropped, and aligned with the preferred warm neutral editorial design-board style, with only minor small-text/legend-padding issues.

## Remaining follow-up

1. Promote the private-server smoke fix into the durable runbook/config instructions.
2. Decide whether to turn the runtime monitor script into a scheduled runtime-summary/runtime-alerts job after one more live-token smoke run.
3. Clean up temporary worktrees once branches are no longer needed.
