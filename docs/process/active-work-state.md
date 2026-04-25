# Active Work State

Last updated: 2026-04-26T05:23:37+08:00

## Current active objective

P0: stabilize and monitor the Screeps agent operating system before continuing normal development. The main agent must preserve owner visibility through the home channel, delegate minimal tasks to subagents/Codex, review subagent conclusions, route summaries to typed Discord channels, and keep scheduled-worker health monitored. Canonical operating contract: `docs/ops/agent-operating-system.md`.

## Completed tasks

### phase1-deploy-chain

- Status: concluded for current research pass
- Conclusion document: `docs/research/2026-04-25-phase1-dev-chain-decision-brief.md`
- Result: TypeScript + `@types/screeps`, bundled `main.js`, Jest + `screeps-jest`, `screeps-server-mockup`, Dockerized `screeps-launcher`, token-backed deploy.

### phase2-architecture

- Status: initial strategy drafted
- Current strategy document: `docs/research/2026-04-25-technical-architecture-strategy.md`
- Result: recommended kernel + memory + light colony wrapper + hybrid role/task architecture, MVP scoped to single-room survival/economy loop.

### mvp-skeleton

- Status: implemented and verified
- Process note: `docs/process/2026-04-26-mvp-skeleton-implementation.md`
- Result: TypeScript/Jest/build skeleton, memory init, dead creep cleanup, kernel, Screeps `loop`, bundled `prod/dist/main.js`.

### mvp-economy-loop

- Status: implemented, verified, reviewed, and stabilized
- Process note: `docs/process/2026-04-26-mvp-economy-loop.md`
- Implemented:
  - owned colony detection
  - worker body builder
  - worker spawn planner
  - role counting by colony
  - worker task selection
  - harvest / transfer / build / upgrade task flow
  - worker task transition logic
  - economy loop integration
  - kernel integration
- Verification:
  - `npm run typecheck`: passed
  - `npm test`: passed, 10 suites / 31 tests before lifecycle validation
  - `npm run build`: passed
- Review: subagent re-review returned `APPROVED / PASS`.

### local-validation-strategy

- Status: deterministic mock lifecycle validation implemented; private-server validation remains future work
- Research note: `docs/research/2026-04-26-local-validation-strategy.md`
- Implemented:
  - `prod/test/mvpEconomyLifecycle.test.ts`
  - lifecycle coverage for spawn planning → harvest assignment → transfer transition → transfer execution
- Verification:
  - `npm run typecheck`: passed
  - `npm test`: passed, 11 suites / 32 tests
  - `npm run build`: passed

### deterministic-integration-hardening

- Status: implemented and verified
- Process note: `docs/process/2026-04-26-deterministic-integration-hardening.md`
- Codex-authored commit: `d4d1bc827a8dc7a2ffba09d03138243baebb1d75` (`test: harden deterministic economy lifecycle`)
- Implemented:
  - same-tick task reselection when a worker's target is missing
  - stale/full transfer target detection so workers fall back to build/upgrade instead of wasting a tick transferring to a full sink
  - deterministic lifecycle coverage for full transfer sink → build fallback → missing build target/no construction → upgrade fallback
- Verification:
  - `npm run typecheck`: passed
  - `npm test -- --runInBand`: passed, 11 suites / 33 tests
  - `npm run build`: passed

### worker-replacement-planning

- Status: implemented and verified
- Process note: `docs/process/2026-04-26-worker-replacement-planning.md`
- Codex-authored commit: `e458ddb12937f0b63a129713b448d5af53aa7f39` (`feat: plan worker replacements before expiry`)
- Implemented:
  - `WORKER_REPLACEMENT_TICKS_TO_LIVE = 100`
  - replacement-age workers no longer count toward steady-state worker capacity
  - deterministic role-count, spawn-planner, and lifecycle tests for replacement planning
- Verification:
  - `npm run typecheck`: passed
  - `npm test -- --runInBand`: passed, 11 suites / 37 tests
  - `npm run build`: passed

### private-server-smoke-prep

- Status: runbook prepared; Docker/Compose now verified in main and delegated-worker contexts; execution is unblocked pending smoke-test setup/secrets
- Ops runbook: `docs/ops/private-server-smoke-test.md`
- Process note: `docs/process/2026-04-26-private-server-smoke-prep.md`
- Findings:
  - current host has Node.js `v18.19.1` and npm `9.2.0`
  - Docker Engine is available: server `29.1.3`
  - Docker Compose v2 plugin is available: `docker compose version` reports `v2.40.3`
  - legacy `docker-compose` is also available: `1.29.2`
  - delegated Hermes subagent context verified the same Docker/Compose availability
  - official `screeps` README currently lists Node.js 22 LTS or higher for direct private-server installation
  - Dockerized `screepers/screeps-launcher` remains the preferred private-server smoke path
- Result: private-server smoke checklist, required inputs/secrets policy, startup/upload/tick-validation phases, failure capture, and exit criteria documented.

## Next active task

### telemetry-mvp

- Status: implemented and verified
- Process note: `docs/process/2026-04-26-telemetry-mvp.md`
- Codex-authored commit: `4ffec6be3134abafdfca888b0270bf458d61148b` (`feat: add runtime telemetry summaries`)
- Implemented:
  - stable `#runtime-summary ` console prefix with JSON payload
  - cadence-limited summaries every 20 ticks when no meaningful event exists
  - immediate spawn-attempt event summaries
  - bounded event reporting with `omittedEventCount`
  - room name, energy available/capacity, worker count, spawn status, task counts, and CPU used/bucket where available
- Verification:
  - `npm run typecheck`: passed
  - `npm test -- --runInBand`: passed, 12 suites / 41 tests
  - `npm run build`: passed

### emergency-worker-recovery

- Status: implemented and verified
- Process note: `docs/process/2026-04-26-emergency-worker-recovery.md`
- Codex-authored commit: `e7cb06eeb9f2e624ce396c15d36919d598955d4d` (`feat: add emergency worker recovery`)
- Implemented:
  - normal worker body selection now waits for the capacity-based normal body for non-emergency replacements
  - zero-active-worker colonies can request a minimal emergency `WORK+CARRY+MOVE` worker when the normal body is unaffordable but 200 energy is available
  - spawn planning avoids impossible emergency body requests below available energy
  - behavior remains compatible with replacement planning, telemetry, and task flow
- Verification:
  - `npm run typecheck`: passed
  - `npm test -- --runInBand`: passed, 12 suites / 44 tests
  - `npm run build`: passed

### spawn-busy-retry-hardening

- Status: implemented and verified
- Process note: `docs/process/2026-04-26-spawn-busy-retry.md`
- Codex-authored commit: `b7f002e` (`feat: retry busy spawn attempts`)
- Implemented:
  - economy loop retries other idle colony spawns when the planned spawn returns `ERR_BUSY`
  - spawn telemetry records each attempted outcome, including busy and retry-success results
  - deterministic Jest coverage for the busy-spawn retry path and emitted runtime-summary events
  - rebuilt `prod/dist/main.js`
- Verification:
  - `npm run typecheck`: passed
  - `npm test -- --runInBand`: passed, 12 suites / 45 tests
  - `npm run build`: passed

### next-runtime-validation

- Status: pinned private-server smoke unblocked for room/map initialization and bot tick validation; executable safe-by-default prep/plan harness added
- Process note: `docs/process/2026-04-26-private-server-smoke-attempt.md`
- Version-pin research note: `docs/process/2026-04-26-private-server-version-pin-research.md`
- Pinned runtime retry note: `docs/process/2026-04-26-pinned-private-server-smoke-retry.md`
- Parallel throughput/smoke note: `docs/process/2026-04-26-parallel-throughput-and-private-smoke.md`
- Longer observation note: `docs/process/2026-04-26-private-server-long-observation.md`
- Harness process note: `docs/process/2026-04-26-private-smoke-harness.md`
- Current recommendation: private-server-first validation remains the release-quality path. Dockerized `screepers/screeps-launcher` with explicit `version: 4.2.21`, launcher Node `12.22.12`, and transitive dependency resolutions (`body-parser: 1.20.3`, `path-to-regexp: 0.1.12`) can initialize rooms when the map import avoids the Node 12 global-`fetch` path by using a pre-downloaded map file plus `utils.importMapFile('/screeps/maps/map-0b6758af.json')`. A follow-up observation reached private `gametime: 5267`, `totalRooms: 169`, `ownedRooms: 1`, one RCL 2 room, and three live bot-created workers without post-restart log exceptions.
- Local secret storage has public MMO token plus `STEAM_KEY`; safe selectors are `SCREEPS_BRANCH=main`, `SCREEPS_API_URL=https://screeps.com`, `SCREEPS_SHARD=shardX`, and `SCREEPS_ROOM=E48S28`. Private-server URL/username selectors are not yet defined locally.
- Harness slice:
  - script: `scripts/screeps-private-smoke-harness.py`
  - commands: `self-test`, `prepare`, and `plan`
  - generated ignored workspace: `runtime-artifacts/private-server-smoke/`
  - safety boundary: no Docker start by default, no required network for `self-test`, no secret value printing, no automatic environment secret materialization
  - generated config: `version: 4.2.21`, `nodeVersion: Erbium`, the validated transitive pins, `screepsmod-auth` / `screepsmod-admin-utils` / `screepsmod-mongo`, and `serverConfig.mapFile: /screeps/maps/map-0b6758af.json`
- Temporary owner-approved official MMO link validation completed on 2026-04-26: created official code branch `main`, uploaded current `prod/dist/main.js`, set `main` as `activeWorld`, placed `Spawn1` at `E48S28` `(25,23)` on `shardX`, and verified official world status `normal` with room owner `lanyusea`. This does not remove the private-server-first validation requirement for future release-quality deployments.
- Durable roadmap: `docs/ops/roadmap.md`
- Latest verification:
  - `python3 scripts/screeps-private-smoke-harness.py self-test`: passed, 33 checks
  - `python3 scripts/screeps-private-smoke-harness.py prepare --no-plan`: passed; generated only ignored runtime files
  - `git check-ignore`: confirmed generated private-smoke config, placeholder, map note, and volume paths are covered by `runtime-artifacts/`
  - `cd prod && npm run typecheck`: passed
  - `cd prod && npm test -- --runInBand`: passed, 12 suites / 59 tests
  - `cd prod && npm run build`: passed
  - Docker Compose startup with default `version: latest`: Mongo/Redis reached healthy; Screeps container restarted with default `screeps@4.3.0` engine mismatch (`>=22.9.0` required, `12.22.12` provided)
  - Dockerized launcher install preflight: `screeps-launcher apply` passed with explicit `version: 4.2.21`, `nodeVersion: Erbium`, and pinned package resolutions
  - Pinned Dockerized runtime smoke: pre-downloaded `map-0b6758af.json`, imported with `utils.importMapFile`, restarted/resumed simulation, registered local smoke user, uploaded `prod/dist/main.js`, placed `Spawn1` at `E1S1` `(20,20)`, and observed `/stats` with `totalRooms: 169`, `ownedRooms: 1`, `activeUsers: 1`, plus owned `worker-E1S1-*` creeps in Mongo
  - Longer pinned runtime observation: private `gametime: 5267`, one RCL 2 owned room, three live bot-created workers, average tick time about 200 ms, and no current post-restart `Unhandled`/`TypeError`/`ReferenceError`/`Error:` hits in launcher logs
  - Runtime monitor self-test: `python3 scripts/screeps-runtime-monitor.py self-test` passed, 8 tests
- Candidate next outputs:
  1. run the harness-generated pinned private-server smoke plan end to end from a fresh ignored workspace and capture redacted observations
  2. run one more live-token runtime-monitor smoke, then schedule `#runtime-summary` / `[SILENT]` no-alert `#runtime-alerts` jobs
  3. continue deterministic Jest hardening for risks found during longer real-runtime observation
- Verification target if code changes are made:
  - `cd prod && npm run typecheck`
  - `cd prod && npm test -- --runInBand`
  - `cd prod && npm run build`
- Reporting channels in non-cron/manual context: `#task-queue`, `#dev-log`, and `#roadmap` as appropriate; final owner decisions go to `#decisions`.
- Subagent completion rule: after every subagent completes, main agent must review the result and report relevant task status, dev/test details, roadmap impact, research findings, or decision items to the corresponding Discord channel(s).
- 4-hour summary due only if a new task is started and remains active after 4 hours.

## Reporting rule

If any task remains open for more than 4 hours without a final conclusion, publish or deliver a structured summary every 4 hours and append durable process notes under `docs/process/`.

## Current context checkpoint

- Main and delegated Hermes model configured to `gpt-5.5`.
- Discord channel process reporting was designed for interactive/autonomous visibility, but this cron invocation explicitly requires final-response-only delivery and forbids using `send_message` directly.
- Canonical Discord spec updated in `docs/ops/discord-project-spec.md`.
- 4-hour checkpoint cron created: `Screeps 4h active-task progress summary`.
- 30-minute continuation cron created, tightened to 10 minutes, and then to 5 minutes during P0/active-development periods: `Screeps autonomous continuation worker`.
- Continuation worker delivery corrected from local-only output to Discord delivery after observing a successful run that did not appear in channels.
- Discord visibility root-cause postmortem recorded in `docs/process/2026-04-26-discord-visibility-root-cause-postmortem.md`: scheduled Screeps continuation/checkpoint jobs should deliver to the named project channel `discord:#task-queue`; global/home notifications may use home channel `1497537021378564200`; avoid sending global notices to thread `1497579848594493560`.
- Background terminal process completion notifications can bypass normal `send_message`/cron delivery routing and return to the invoking thread; future global/public long-running shell tasks should avoid `notify_on_complete=true` and instead poll/wait then report through the intended channel/cron delivery path.
- Coding boundary clarified: future production/test/build code changes under `prod/` must be implemented via OpenAI Codex CLI, while Hermes orchestrates, verifies, documents, reports, and pushes.
- Commit behavior clarified: Codex must commit after each completed coding task; documentation-only changes may be committed by Hermes directly.
- Git identity configured globally and local history rewritten to `lanyusea's bot <lanyusea@gmail.com>`; local rewrite succeeded, remote force push was blocked by platform smart approval and still needs an approved force-push path if remote history rewrite is still desired.
- Initial `prod/` MVP skeleton implemented and verified.
- First `prod/` MVP economy loop base implemented, verified, reviewed, and stabilized.
- Deterministic mock lifecycle validation added and passing.
- Deterministic integration hardening implemented by Codex and verified: stale/missing worker targets now reselect in the same tick, full transfer targets fall back to build/upgrade, and test count is now 33.
- Private-server smoke prep runbook added; Docker/Compose availability was rechecked and fixed. Main and delegated-worker contexts now have Docker Engine `29.1.3`, Docker Compose v2 `v2.40.3`, and legacy `docker-compose` `1.29.2`.
- Roadmap refreshed in `docs/ops/roadmap.md`; `docs/README.md` index updated; `docs/ops/discord-project-spec.md` now explicitly requires main-agent review and channel-appropriate reporting after every subagent completion.
- Worker replacement planning hardening implemented by Codex and verified: replacement-age workers no longer satisfy steady-state capacity, deterministic tests now cover replacement planning, and test count is now 37.
- Telemetry MVP implemented and verified: stable `#runtime-summary ` JSON console summaries now emit on spawn events or every 20 ticks, including room energy, worker count, spawn status, task counts, and CPU used/bucket.
- Spawn busy retry hardening implemented by Codex and verified: if a planned spawn returns `ERR_BUSY`, the economy loop retries other idle colony spawns in the same tick and telemetry records each attempt; deterministic test count is now 45.
- Private-server version-pin research completed: launcher source/config inspection confirmed `version: latest` becomes `screeps: *`; npm metadata identified `screeps@4.2.21` as Node 12-compatible; Dockerized `screeps-launcher apply` passed with `version: 4.2.21`; the follow-up pinned runtime retry started the server and uploaded code after adding `body-parser: 1.20.3` / `path-to-regexp: 0.1.12` resolutions, but room/map initialization remained unresolved (`totalRooms: 0`).
