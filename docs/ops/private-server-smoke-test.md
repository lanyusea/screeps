# Private Server Smoke Test Runbook

Date: 2026-04-26
Status: prepared; not executed in the current environment

## Purpose

Use this runbook to validate the MVP Screeps bot on a real-ish private server before any public MMO deployment. The current unit and deterministic lifecycle tests cover core state transitions, but a private server smoke test is still needed to catch integration failures in the Screeps runtime, room simulation, memory persistence, console output, and upload/auth flow.

## Current environment finding

The current autonomous worker environment has:

- Node.js: `v18.19.1`
- npm: `9.2.0`
- Docker CLI: not installed (`docker: command not found`)
- Docker Compose: not available because Docker is not installed

The official `screeps` package README currently lists **Node.js 22 LTS or higher** as a prerequisite for direct npm/private-server installation. Because this worker is on Node 18 and has no Docker, the smoke test cannot be executed here without environment changes.

## Recommended path

Prefer Dockerized `screepers/screeps-launcher` for this validation layer once Docker/Compose is available.

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

## Candidate private-server config shape

Use this as a checklist, not as a committed secret-bearing config:

```yaml
steamKey: ${STEAM_KEY}
mods:
  - screepsmod-auth
  - screepsmod-admin-utils
  - screepsmod-mongo
serverConfig:
  welcomeText: "Local Screeps MVP smoke server"
```

Notes:

- The launcher README says `STEAM_KEY` can be supplied as an environment variable.
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

Once Docker is available in the execution environment:

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

## Current blocker

This worker cannot execute the Dockerized smoke today because Docker is not installed. Direct npm install of the official private server is also not preferred on this host because the official package currently requires Node 22+, while this host has Node 18.

Next executable options:

1. Provide an environment with Docker/Compose and rerun this smoke runbook.
2. Upgrade or isolate Node 22+ in a disposable environment for direct server testing.
3. Continue improving deterministic integration tests while private-server runtime support is unavailable.

## Sources checked

- `https://github.com/screepers/screeps-launcher` README: Docker/Compose path, `config.yml`, `screepsmod-auth`, `screepsmod-admin-utils`, `screepsmod-mongo`, `screeps-launcher cli`, `system.resetAllData()`.
- `https://github.com/screeps/screeps` README: official private-server Node.js 22 LTS prerequisite and server module model.
- Existing project notes: `docs/research/2026-04-25-phase1-dev-chain-decision-brief.md` and `docs/research/2026-04-26-local-validation-strategy.md`.
