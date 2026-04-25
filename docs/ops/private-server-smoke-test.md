# Private Server Smoke Test Runbook

Date: 2026-04-26
Status: pinned runtime smoke passed through room/map initialization, code upload, spawn placement, and owned bot creeps; an executable prep/plan harness now makes the passing path repeatable without starting Docker by default

## Purpose

Use this runbook to validate the MVP Screeps bot on a real-ish private server before any public MMO deployment. The current unit and deterministic lifecycle tests cover core state transitions, but a private server smoke test is still needed to catch integration failures in the Screeps runtime, room simulation, memory persistence, console output, and upload/auth flow.

## Current environment finding

The current autonomous worker environment has:

- Node.js: `v18.19.1`
- npm: `9.2.0`
- Docker Engine: available, server `29.1.3`
- Docker Compose v2 plugin: available, `Docker Compose version v2.40.3`
- legacy Docker Compose: available, `docker-compose version 1.29.2`

The official `screeps` package README currently lists **Node.js 22 LTS or higher** as a prerequisite for direct npm/private-server installation. Because this worker is on Node 18, the Dockerized launcher remains preferred over mutating the system Node installation.

## Recommended path

Prefer Dockerized `screepers/screeps-launcher` for this validation layer.

Reasons:

1. It avoids mutating the worker's system Node installation.
2. It isolates private-server dependencies.
3. The launcher README explicitly supports Docker and Docker Compose.
4. It can run the server with MongoDB/Redis-backed persistence when needed.

## Inputs and secrets required

Do not commit any secrets to this repository.

Required or likely required:

- Steam Web API key, passed as an environment variable or local untracked config value.
- Private server `config.yml` with secrets redacted from commits.
- Local server admin credentials/password configured through `screepsmod-auth`.
- Local upload target credentials/token if using auth-backed upload tooling.

Optional depending on smoke depth:

- MongoDB/Redis services through Docker Compose.
- `screepsmod-mongo` for Mongo-backed persistence.
- `screepsmod-admin-utils` for server configuration helpers.

## Executable harness

The bounded automation entrypoint is:

```bash
python3 scripts/screeps-private-smoke-harness.py self-test
python3 scripts/screeps-private-smoke-harness.py prepare
python3 scripts/screeps-private-smoke-harness.py plan
```

Behavior:

- `self-test` runs offline unit-style checks for the harness helpers/templates. It does not require Docker, network, or secrets.
- `prepare` creates or updates ignored files under `runtime-artifacts/private-server-smoke/`: `docker-compose.yml`, `config.yml`, `maps/`, `STEAM_KEY.example`, `volumes/`, and `README.md`.
- `prepare --download-map` optionally caches `maps/map-0b6758af.json` when network is available. The map can also be downloaded later by the printed plan.
- `plan` prints the manual continuation commands to start Docker Compose, import the map file through the launcher CLI, restart and resume simulation, register/auth/upload code, place `Spawn1`, and collect redacted observations.
- The harness may check whether `STEAM_KEY` exists in the environment, ignored project runtime files, or local secret storage such as `/root/.secret/.env`, but it does not print or write secret values. The generated launcher config uses `steamKeyFile: STEAM_KEY`; create that ignored file locally before starting Docker.

The repository-level `.gitignore` ignores `runtime-artifacts/`, so generated config, secret placeholders, map cache, runtime token files, and Docker volumes stay untracked.

## Candidate private-server config shape

Use this as a checklist, not as a committed secret-bearing config:

```yaml
steamKeyFile: STEAM_KEY
version: 4.2.21
nodeVersion: Erbium
pinnedPackages:
  ssri: 8.0.1
  cacache: 15.3.0
  passport-steam: 1.0.17
  minipass-fetch: 2.1.2
  express-rate-limit: 6.7.0
  body-parser: 1.20.3
  path-to-regexp: 0.1.12
  psl: 1.10.0
mods:
  - screepsmod-auth
  - screepsmod-admin-utils
  - screepsmod-mongo
serverConfig:
  welcomeText: "Local Screeps MVP smoke server"
  tickRate: 200
  shardName: shardX
  mapFile: /screeps/maps/map-0b6758af.json
```

Notes:

- The launcher README says `STEAM_KEY` can be supplied as an environment variable.
- The launcher default `version: latest` currently resolves to `screeps@4.3.0`, which is incompatible with the launcher's Node.js 12 runtime. A preflight `screeps-launcher apply` run passed with `version: 4.2.21`, whose npm engine metadata is `node >=10.13.0`.
- A follow-up pinned runtime retry showed that current latest mods can still pull Node 18+ transitive dependencies; add `body-parser: 1.20.3` and `path-to-regexp: 0.1.12` to `pinnedPackages` for the Node 12 launcher path.
- With those pins, `screeps@4.2.21` started, `/api/version` returned healthy, local auth registration worked, and code upload/round-trip succeeded.
- Do **not** rely on `serverConfig.map: random_1x1` in this Node 12 launcher path. The installed `screepsmod-admin-utils` import path uses global `fetch()`, which Node 12 does not provide, causing map import to fail and `/stats.totalRooms` to remain `0`.
- Use a pre-downloaded map file instead, e.g. `serverConfig.mapFile: /screeps/maps/map-0b6758af.json`, then call `utils.importMapFile('/screeps/maps/map-0b6758af.json')` through the launcher CLI. This path initialized `totalRooms: 169` in the 2026-04-26 smoke run.
- `screepsmod-mongo` requires MongoDB and Redis to be installed/running.
- If Mongo-backed storage is used, run `system.resetAllData()` once from the launcher CLI, then restart the server.

## Smoke test phases

### Phase 0: preflight

From the repository root:

```bash
cd prod
npm run typecheck
npm test -- --runInBand
npm run build
```

Expected result:

- TypeScript passes.
- Jest passes.
- `prod/dist/main.js` exists and is the artifact under test.

### Phase 1: server startup

With Docker/Compose available in the execution environment:

1. Create an untracked local smoke-test work directory.
2. Add a local `config.yml` with secrets supplied by env/local values only.
3. Start Docker Compose from that directory.
4. Wait until the server and backing services are ready.
5. Open the launcher CLI.
6. If using Mongo-backed storage, run:

```js
system.resetAllData()
```

7. Restart the Screeps service.

Expected result:

- Server listens on the configured HTTP/game port.
- CLI is reachable.
- The Steam client or local API tooling can connect.

### Phase 1.5: map import for pinned Node 12 launcher runtime

For the pinned Dockerized `screeps@4.2.21` path, avoid `serverConfig.map: random_1x1` because the installed admin-utils random import uses global `fetch()` and fails under Node 12.

Use an untracked mounted map file:

```bash
mkdir -p maps
python3 - <<'PY'
import urllib.request
from pathlib import Path
url = 'https://maps.screepspl.us/maps/map-0b6758af.json'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req, timeout=30) as response:
    Path('maps/map-0b6758af.json').write_bytes(response.read())
PY
```

Local `config.yml` shape:

```yaml
serverConfig:
  mapFile: /screeps/maps/map-0b6758af.json
```

After HTTP and CLI readiness:

```js
utils.importMapFile('/screeps/maps/map-0b6758af.json')
```

Then restart the Screeps service and resume simulation:

```js
system.resumeSimulation()
```

Expected result:

- `/stats.totalRooms` is nonzero; the 2026-04-26 smoke observed `169` rooms.
- Local user registration/upload should be done after map import, because map import can clear DB/user/code state.

### Phase 2: code upload/injection

Use the bundled artifact:

```text
prod/dist/main.js
```

Smoke acceptable upload methods, in preferred order:

1. Auth-backed private-server upload via `screepsmod-auth` and an upload adapter.
2. Manual script insertion through CLI or server storage for a local-only smoke.
3. Bot package path configured for the private server if testing bot-package mode.

Expected result:

- The active private-server user has the current `main` module installed.
- `module.exports.loop` is available to the runtime.
- No credentials are written to tracked files or logs.

### Phase 3: room and tick validation

Prepare or select a single owned room with:

- one spawn
- at least one source
- a controller
- no hostile pressure for the first smoke

Observe for several hundred ticks.

Expected behavior:

1. `main.loop` runs without fatal exception.
2. global memory initializes once and persists across ticks.
3. stale creep memory cleanup does not delete active creeps.
4. colony detection recognizes the owned room.
5. worker spawn planning creates/maintains the MVP worker population.
6. workers harvest when empty.
7. workers refill spawn/extensions when full and energy is needed.
8. workers build construction sites when available.
9. workers upgrade the controller when no higher-priority energy sink exists.
10. console output remains readable and does not spam excessive logs.

### Phase 4: failure capture

If the smoke fails, record:

- command used
- environment versions
- redacted config shape
- tick number or observed phase
- exception stack or console message
- room state summary
- whether the failure is bot logic, upload/deploy, server config, or environment setup

Write findings under `docs/process/` and keep any secret-bearing reproduction files untracked.

## Exit criteria

The private-server smoke milestone is complete when:

- preflight verification passes (`typecheck`, Jest, build),
- the private server starts and accepts local connection,
- `prod/dist/main.js` is loaded for a test user,
- the bot runs for several hundred ticks without fatal exceptions,
- first-room MVP economy behavior is observed at least through spawn/harvest/refill/upgrade or build,
- failures and manual setup steps are documented with secrets redacted.

## Current status

The prior Docker/Compose blocker has been resolved in both the main Hermes context and a delegated subagent context.

A pinned runtime smoke on 2026-04-26 advanced through the previous blockers:

- `screeps@4.2.21` installed and started under the Dockerized launcher with the transitive dependency pins above.
- HTTP `/api/version` and launcher CLI were reachable.
- The random-map path failed because `screepsmod-admin-utils` uses global `fetch()` under Node 12.
- Switching to pre-downloaded `map-0b6758af.json` plus `utils.importMapFile('/screeps/maps/map-0b6758af.json')` initialized `/stats.totalRooms: 169`.
- A local smoke user was registered after map import.
- `prod/dist/main.js` uploaded and round-tripped through `/api/user/code`.
- `Spawn1` was placed at `E1S1` `(20,20)` using token auth with both `X-Username` and `X-Token` headers.
- `/api/user/overview` showed owned room `E1S1`; `/api/game/room-overview` showed owner `smoke`; `/stats` showed `ownedRooms: 1` and `activeUsers: 1`.
- Mongo object inspection showed owned `Spawn1` and bot-created worker creeps named `worker-E1S1-*`.
- A longer follow-up observation reached private `gametime: 5267`, one RCL 2 owned room, three live bot-created workers, and average tick time near 200 ms.
- A post-restart log scan found no current `Unhandled`, `TypeError`, `ReferenceError`, or `Error:` hits in `runner.log`, `processor_*.log`, `main.log`, or `backend.log`; earlier random-map/global-`fetch` warnings remain in historical pre-fix log lines only.

Pinned retry note: `docs/process/2026-04-26-pinned-private-server-smoke-retry.md`
Parallel smoke note: `docs/process/2026-04-26-parallel-throughput-and-private-smoke.md`
Longer observation note: `docs/process/2026-04-26-private-server-long-observation.md`

Next executable options:

1. Private-server-first validation remains required for local development before official MMO deployment.
2. Run the new harness-generated plan end to end from a fresh ignored workspace and record the redacted observations.
3. Turn the runtime monitor script into scheduled `#runtime-summary` / `[SILENT]` no-alert `#runtime-alerts` reporting after one more live-token smoke.
4. If this pinned runtime later exposes simulation incompatibilities, fall back to selecting/building a Node.js 22.9+ private-server image/toolchain for current `screeps@4.3.0`.
5. Use local, untracked config/secrets only. Verified secret prerequisites include `SCREEPS_AUTH_TOKEN` and `STEAM_KEY` in local secret storage; values must not be printed or committed.
6. Continue deterministic coding work in parallel Codex worktrees where tasks are independent.

## Sources checked

- `https://github.com/screepers/screeps-launcher` README: Docker/Compose path, `config.yml`, `screepsmod-auth`, `screepsmod-admin-utils`, `screepsmod-mongo`, `screeps-launcher cli`, `system.resetAllData()`.
- `https://github.com/screepers/screeps-launcher` source: `version` defaults to `latest`, `nodeVersion` defaults to `Erbium`, and launcher package generation writes the configured `version` as the `screeps` dependency.
- `https://github.com/screeps/screeps` README: official private-server Node.js 22 LTS prerequisite and server module model.
- npm metadata: `screeps@4.3.0` requires `node >=22.9.0`; `screeps@4.2.21` requires `node >=10.13.0`.
- Existing project notes: `docs/research/2026-04-25-phase1-dev-chain-decision-brief.md` and `docs/research/2026-04-26-local-validation-strategy.md`.
