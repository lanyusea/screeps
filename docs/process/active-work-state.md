# Active Work State

Last updated: 2026-04-27T15:18:00+08:00

## Current active objective

P0 agent operating-system health is repaired/watch-only in the current cron window: `/root/.hermes/cron/jobs.json` shows the continuation worker, P0 monitor, runtime summary, runtime alert, typed fanouts, 6h report, and Gameplay Evolution Review enabled with `workdir: null`, current `last_run_at`, and non-overdue `next_run_at` values at slice start. Normal development may proceed while routine P0 monitor watch continues. The active gameplay priority remains #29: PR #65's runtime KPI telemetry, PR #67's reducer, PR #68's persisted-artifact bridge, and PR #70's Pages/KPI report are merged on `main`. A 2026-04-27 default artifact scan still found `0` persisted `#runtime-summary ` lines, so the current Codex slice adds an offline persistence primitive for raw console captures; the next #29 step is live official-console wiring that feeds real in-game summary lines into ignored artifacts, then verifies a nonzero bridge scan before wiring the 12h Gameplay Evolution and roadmap jobs to consume them. #61's durable finding-to-Codex bridge is done/watch. The competition-map vision ordering remains territory first, resource scale second, enemy kills third; foundation work outranks that order only when it blocks evidence, implementation, release, or rollback. Canonical operating contract: `docs/ops/agent-operating-system.md`. Vision contract: `docs/ops/project-vision.md`. Owner decisions on 2026-04-26: use the automated review口径 with no formal GitHub approval requirement, add every active agent PR to Project `screeps`, and let known P0 monitoring/routing/scheduler health block normal development and non-P0 merges until repaired/proven healthy.

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

### transfer-result-race-hardening

- Status: implemented, verified, PR-reviewed, and merged to `main`
- Process note: `docs/process/2026-04-26-transfer-result-hardening.md`
- Merge follow-up note: `docs/process/2026-04-26-pr9-merge-follow-up.md`
- Conflict refresh note: `docs/process/2026-04-26-pr9-conflict-refresh.md`
- Pull request: https://github.com/lanyusea/screeps/pull/9 (merged 2026-04-26T02:43:07Z as `b7e5c94`)
- Codex-authored commit: `a95afdc` (`test: handle full transfer result race`)
- Codex-authored review-fix commit: `83eb0d5` (`fix: use screeps err full constant`)
- Implemented:
  - transfer task execution now treats `ERR_FULL` as a same-tick stale-target signal
  - full-carry workers clear the stale transfer task and immediately reselect through existing worker task priority
  - deterministic Jest coverage proves a full target race falls back to build without moving toward the full sink
  - rebuilt `prod/dist/main.js`
- Verification:
  - `npm run typecheck`: passed
  - `npm test -- --runInBand`: passed, 12 suites / 68 tests after merge to `main`
  - `npm run build`: passed

### worker-no-target-hardening

- Status: implemented and verified on `origin/main`
- Process note: `docs/process/2026-04-26-worker-no-target-hardening.md`
- Codex-authored commit: `12a2c4a` (`test: harden worker no-target fallbacks`) plus review follow-up coverage for stale harvest worker tasks
- Implemented:
  - `selectWorkerTask` returns `null` without throwing when a worker has no sources
  - `selectWorkerTask` returns `null` without throwing when an energy-carrying worker has no energy sinks, construction sites, or owned controller
  - `runWorker` leaves no task assigned in both no-target task-selection cases
  - `runWorker` clears stale harvest, transfer, build, and upgrade tasks without executing missing targets
- Verification:
  - `npm run typecheck`: passed
  - `npm test -- --runInBand`: passed, 12 suites / 67 tests
  - `npm run build`: passed

### next-runtime-validation

- Status: pinned private-server smoke harness live rerun passed, PR #16 merged to `main`, and post-merge cleanup completed
- Process note: `docs/process/2026-04-26-private-server-smoke-attempt.md`
- Version-pin research note: `docs/process/2026-04-26-private-server-version-pin-research.md`
- Pinned runtime retry note: `docs/process/2026-04-26-pinned-private-server-smoke-retry.md`
- Parallel throughput/smoke note: `docs/process/2026-04-26-parallel-throughput-and-private-smoke.md`
- Longer observation note: `docs/process/2026-04-26-private-server-long-observation.md`
- Harness note: `docs/process/2026-04-26-private-server-smoke-harness.md`
- Harness live rerun note: `docs/process/2026-04-26-private-smoke-harness-live-rerun.md`
- Current recommendation: private-server-first validation remains the release-quality path. Dockerized `screepers/screeps-launcher` with explicit `version: 4.2.21`, launcher Node `12.22.12`, and transitive dependency resolutions (`body-parser: 1.20.3`, `path-to-regexp: 0.1.12`) can initialize rooms when the map import avoids the Node 12 global-`fetch` path by using a pre-downloaded map file plus `utils.importMapFile('/screeps/maps/map-0b6758af.json')`. A follow-up observation reached private `gametime: 5267`, `totalRooms: 169`, `ownedRooms: 1`, one RCL 2 room, and three live bot-created workers without post-restart log exceptions.
- Harness status: PR #12 `scripts/screeps-private-smoke.py` is ready for a fresh live run; see `docs/process/2026-04-26-private-server-smoke-harness.md` for full details.
  - Modes: offline `self-test`, secret-free `dry-run`, and live `run`.
  - Hardening: unsafe workdir rejection before secret writes, stable password requirement for no-reset server reuse, empty no-reset password rejection, transient `/stats` retry, non-200/unusable `/stats` failure capture, room-specific spawn evidence for `already playing`, required user/room overview success probes, bounded Mongo summaries, docstrings, and expanded self-test coverage.
  - Pins: `screepers/screeps-launcher:v1.16.2`, `mongo:8.2.7`, `redis:7.4.8`, plus the Node-12-compatible `screeps@4.2.21` dependency pins.
  - Latest Codex commit: `d8c9197` (`fix: capture smoke harness report metadata`).
- Local secret storage has public MMO token plus `STEAM_KEY`; safe selectors are `SCREEPS_BRANCH=main`, `SCREEPS_API_URL=https://screeps.com`, `SCREEPS_SHARD=shardX`, and `SCREEPS_ROOM=E48S28`. Private-server URL/username selectors are not yet defined locally.
- Temporary owner-approved official MMO link validation completed on 2026-04-26: created official code branch `main`, uploaded current `prod/dist/main.js`, set `main` as `activeWorld`, placed `Spawn1` at `E48S28` `(25,23)` on `shardX`, and verified official world status `normal` with room owner `lanyusea`. This does not remove the private-server-first validation requirement for future release-quality deployments.
- Durable roadmap: `docs/ops/roadmap.md`
- Latest verification:
  - `cd prod && npm run typecheck`: passed
  - `cd prod && npm test -- --runInBand`: passed, 12 suites / 68 tests after refreshed PR #9 was merged with the latest no-target and stale-task fallback coverage from `origin/main`
  - `cd prod && npm run build`: passed
  - Docker Compose startup with default `version: latest`: Mongo/Redis reached healthy; Screeps container restarted with default `screeps@4.3.0` engine mismatch (`>=22.9.0` required, `12.22.12` provided)
  - Dockerized launcher install preflight: `screeps-launcher apply` passed with explicit `version: 4.2.21`, `nodeVersion: Erbium`, and pinned package resolutions
  - Pinned Dockerized runtime smoke: pre-downloaded `map-0b6758af.json`, imported with `utils.importMapFile`, restarted/resumed simulation, registered local smoke user, uploaded `prod/dist/main.js`, placed `Spawn1` at `E1S1` `(20,20)`, and observed `/stats` with `totalRooms: 169`, `ownedRooms: 1`, `activeUsers: 1`, plus owned `worker-E1S1-*` creeps in Mongo
  - Longer pinned runtime observation: private `gametime: 5267`, one RCL 2 owned room, three live bot-created workers, average tick time about 200 ms, and no current post-restart `Unhandled`/`TypeError`/`ReferenceError`/`Error:` hits in launcher logs
  - Runtime monitor self-test: `python3 scripts/screeps-runtime-monitor.py self-test` passed, 8 tests
  - Private smoke harness self-test: `python3 scripts/screeps-private-smoke.py self-test` passed, 30 tests after PR #16 permission-review fix
  - Private smoke harness dry-run: `python3 scripts/screeps-private-smoke.py dry-run` passed and wrote a redacted report without Docker, network, secrets, or a live server
  - Private smoke harness secure live rerun on alternate local ports `21125/21126`: passed with redacted report `/root/screeps/runtime-artifacts/screeps-private-smoke-live-20260426T0633Z/private-smoke-report-20260426T063440Z.json`; reached `gametime: 31`, `totalRooms: 169`, one owned room, one bot-created worker, code upload/roundtrip success, and Mongo spawn/creep evidence
  - Current prod verification after harness live-rerun fixes: `npm run typecheck`, `npm test -- --runInBand` (12 suites / 68 tests), and `npm run build` all passed in `prod/`
- PR #16 completion:
  - Merged: <https://github.com/lanyusea/screeps/pull/16> at `2026-04-26T06:38:25Z`
  - Merge commit: `b82d977a76f4f971c11dc0e1ca2cc010812a2315` (`fix: harden private smoke harness live run`)
  - Post-merge cleanup: `/root/screeps` fast-forwarded to `b82d977`; local feature worktree/branch and remote feature branch removed; secure rerun stack stopped; the only remaining `screeps-private-smoke` containers are the intentional `screeps-private-smoke-pinned-*` observation stack.
- PR #37 completion:
  - Merged: <https://github.com/lanyusea/screeps/pull/37> at `2026-04-26T07:20:02Z` after the required 15-minute wait.
  - Merge commit: `c999a8fd1496dcb5f8c72e42e897051b4707cd2a` (`docs: record GitHub roadmap management contract`).
  - Review/check state: CodeRabbit status passed; Gemini Code Assist had no feedback; GitHub GraphQL review-thread query returned no unresolved live threads.
  - Post-merge cleanup: `/root/screeps` fast-forwarded to `c999a8f`; local PR worktree removed; local squash-merged branch force-deleted; remote PR branch deleted.
  - Process note: `docs/process/2026-04-26-pr37-roadmap-management-merge.md`.
- Candidate next outputs:
  1. wire the now live-smoked runtime monitor through dedicated `#runtime-summary` jobs and an alert scheduler/wrapper that converts `alert=false` JSON into a final `[SILENT]` response for `#runtime-alerts`, without creating cron jobs from the continuation worker
  2. observe several additional private-smoke rerun windows to ensure the harness path is stable across fresh data resets
  3. continue deterministic Jest hardening for risks found during longer real-runtime observation
- Latest deterministic hardening slice on `main`: PR #9 transfer-result race hardening merged as `b7e5c94` on 2026-04-26T02:43:07Z after CI/CodeRabbit were green and review feedback was addressed.
  - It includes Codex commit `a95afdc` plus review-fix commit `83eb0d5`, uses the Screeps global `ERR_FULL` constant, and verifies stale transfer tasks are cleared/reselected without moving toward a full target.
  - Post-merge local verification passed typecheck, 12 suites / 68 tests, and build.
  - Process notes: `docs/process/2026-04-26-transfer-result-hardening.md`, `docs/process/2026-04-26-pr9-conflict-refresh.md`, and `docs/process/2026-04-26-pr9-merge-follow-up.md`.
- PR #7 conflict refresh note from `origin/main`: `docs/process/2026-04-26-pr7-conflict-refresh.md`; Codex merge commit `6a54b8d` brought `test/runtime-risk-hardening-20260426` up to `origin/main`, preserved latest CI/P0/runtime-monitor docs, passed prod verification with 12 suites / 67 tests, and pushed the branch. GitHub Actions `prod-ci` passed; CodeRabbit status was pending immediately after push.
- Runtime monitor live-token smoke: `docs/process/2026-04-26-runtime-monitor-live-smoke.md`; `self-test` passed (8 tests), live summary rendered `runtime-artifacts/screeps-monitor/summary-shardX-E48S28.png` in the first pass and `runtime-artifacts/screeps-monitor-live-smoke-20260426/summary-shardX-E48S28.png` in the 09:32 repeat pass; live alert returned `alert: false` with no warnings at official ticks `108687` and `109202` for `shardX/E48S28`; repeat prod verification passed typecheck, 12 suites / 59 tests, and build.
### runtime-kpi-reducer

- Status: merged to `main`
- Process note: `docs/process/2026-04-27-runtime-kpi-reducer.md`
- Pull request: https://github.com/lanyusea/screeps/pull/67
- Codex-authored commit: `80a571f` (`feat: add runtime KPI reducer`)
- Implemented:
  - `scripts/screeps_runtime_kpi_reducer.py` parses saved `#runtime-summary` JSON lines from files or stdin.
  - Deterministic JSON report aggregates territory/owned rooms, controller state, resource latest/deltas/events, and combat latest/deltas/events, with explicit `not instrumented` / `not observed` markers.
  - `--format human` emits a compact review-readable summary.
  - `scripts/test_screeps_runtime_kpi_reducer.py` adds deterministic local coverage for observed, missing, malformed, file/stdin, and human-rendering cases.
  - Gameplay Evolution roadmap and finding-to-Codex bridge now document the saved-log reducer command.
- Verification:
  - `git diff --check`: passed
  - `python3 -m py_compile scripts/screeps_runtime_kpi_reducer.py scripts/test_screeps_runtime_kpi_reducer.py`: passed
  - `python3 -m unittest scripts/test_screeps_runtime_kpi_reducer.py`: passed, 5 tests
  - No `prod/` files changed; prod typecheck/test/build not required for this slice.
- Merge evidence:
  - Merge commit on current branch: `f32cdc3` (`feat: add runtime KPI reducer (#67)`).
  - Follow-up remains active under #29: wire persisted runtime-summary logs/reducer output into 12h Gameplay Evolution / roadmap reporting.

### runtime-kpi-artifact-bridge

- Status: merged to `main`; offline console persistence primitive added in current #29 slice, live official-console wiring still pending
- Process notes: `docs/process/2026-04-27-runtime-kpi-artifact-bridge.md`, `docs/process/2026-04-27-kpi-persistence-wiring-checkpoint.md`
- Pull request: https://github.com/lanyusea/screeps/pull/68
- Implemented:
  - `scripts/screeps_runtime_kpi_artifact_bridge.py` scans files/directories for persisted `#runtime-summary ` lines, defaults to `/root/screeps/runtime-artifacts` and `/root/.hermes/cron/output`, tolerates missing dirs, and skips binary/oversized files.
  - `scripts/screeps_runtime_summary_console_capture.py` reads stdin or saved console logs, writes only exact-prefix `#runtime-summary ` lines under `runtime-artifacts/runtime-summary-console/`, and emits counts/paths without artifact contents.
  - JSON output remains deterministic and adds source metadata without artifact contents: input paths, scanned files, matched files, runtime-summary line count, and skipped file paths/reasons.
  - `--format human` emits a concise source/reducer summary.
  - `scripts/test_screeps_runtime_kpi_artifact_bridge.py` covers file scanning, recursive directory scans, binary/oversized skips, default no-match/no-input behavior, reducer integration, and human output.
  - Gameplay Evolution roadmap and finding-to-Codex bridge now prefer the artifact feeder before raw saved-log reducer fallback.
- Verification:
  - PR #68 merged at 2026-04-27T05:09:10Z as `da20ac4` after prod-ci SUCCESS, CodeRabbit SUCCESS, Gemini no feedback, and resolved GraphQL review thread.
  - 2026-04-27 default bridge check: scanned `71528` files, matched `0`, runtime-summary lines `0`, skipped `1643`; territory/resources/combat remain not instrumented until real in-game summary lines are persisted.
  - 2026-04-27 Pages generator dry run wrote `/tmp/screeps-pages-check/index.html`, `/tmp/screeps-pages-check/roadmap-data.json`, and `/tmp/screeps-roadmap-kpi-check.sqlite`; `enemy_kills` stayed `NULL`, `instrumented=0`, source `future ownership-aware combat reducer`.
- Remaining next step:
  - Wire a live official-console capture source or Hermes job prompt to `python3 scripts/screeps_runtime_summary_console_capture.py`, then prove `python3 scripts/screeps_runtime_kpi_artifact_bridge.py --format human` finds nonzero real `#runtime-summary ` lines. Only after that proof should a worker wire the bridge into the 12h Gameplay Evolution Review and roadmap KPI snapshot job prompts. Keep #29 active until that wiring is merged and observed.

## General production verification reminder

- Verification target if future `prod/` code changes are made:
  - `cd prod && npm run typecheck`
  - `cd prod && npm test -- --runInBand`
  - `cd prod && npm run build`

### worktree-pr-ci-gate

- Status: CI workflow/runbook branch prepared and pushed for PR creation
- Process note: `docs/process/2026-04-26-prod-ci-workflow.md`
- Branch: `chore/add-prod-ci`
- Implemented:
  - `.github/workflows/prod-ci.yml` for PR/push/manual verification of `prod` typecheck, in-band Jest, build, and `dist/main.js` artifact existence on Node.js 20 CI tooling
  - `docs/ops/github-actions-prod-ci.md` runbook documenting triggers, required checks, and branch-protection follow-up
  - docs index and roadmap references for the new CI gate
- Verification:
  - `cd prod && npm run typecheck`: passed
  - `cd prod && npm test -- --runInBand`: passed, 12 suites / 59 tests
  - `cd prod && npm run build`: passed
- Follow-up:
  - create PR for `chore/add-prod-ci` after GitHub token/CLI access is available, or use the compare URL from the continuation report
  - once merged, configure `main` branch protection to require the CI job before merge

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
- P0 checkpoint on 2026-04-26T09:12:32+08:00 recorded `docs/process/2026-04-26-p0-routing-checkpoint-0912.md` and marked the older background-process routing note as superseded for scheduled-worker delivery. Current scheduled Screeps continuation/checkpoint target remains `discord:#task-queue`; home channel `1497537021378564200` is for global/home notifications, not routine scheduled project-progress delivery.
- P0 scheduler cadence follow-up on 2026-04-26T17:03:00+08:00 recorded `docs/process/2026-04-26-scheduler-cadence-followup.md`: runtime-alert job `1c093252ab70` still did not advance after its overdue `next_run_at`, no new alert session appeared after `16:04`, and the latest successful alert run did prove no-alert `[SILENT]` behavior. Treat this as a scheduler runner/cadence blocker before private-server smoke or unrelated bot hardening.
- P0 scheduler cadence audit on 2026-04-26T18:00:26+08:00 recorded `docs/process/2026-04-26-scheduler-cadence-audit-1800.md`: runtime-alert job `1c093252ab70` last ran at `17:57:47+08:00`, became due at `18:02:47+08:00`, and still had not created a new session or advanced metadata by `18:03:29+08:00`. Delivery target and last-status fields remained healthy, so the active blocker is still cron dispatcher cadence/rescheduling rather than monitor command behavior.
- P0 scheduler cadence audit on 2026-04-26T18:32:15+08:00 recorded `docs/process/2026-04-26-scheduler-cadence-audit-1832.md`: after main advanced to `0343354` and open PRs were clear, `jobs.json` still showed far-future `next_run_at` values for P0 monitor and typed fanout jobs, and runtime-alert job `1c093252ab70` remained overdue 80 seconds after its `18:30:55+08:00` due time with no new session beyond `session_cron_1c093252ab70_20260426_175736.json`. Latest alert output remains healthy `[SILENT]` when run, so the active blocker is scheduler cadence/rescheduling rather than monitor command behavior.
- P0 scheduler cadence audit on 2026-04-26T19:24:08+08:00 recorded `docs/process/2026-04-26-scheduler-cadence-audit-1924.md`: runtime-alert job `1c093252ab70` had fresh successful `[SILENT]` runs at 19:05 and 19:17, but did not advance after its `19:22:06+08:00` due time by the 19:24 checkpoint; continuation job metadata was also stale relative to `19:21:50+08:00`, while P0 monitor and typed fanout jobs had recovered one fresh run. Classification remains intermittent scheduler dispatcher/cadence health, not monitor no-alert behavior or Discord delivery routing.
- P0 scheduler cadence audit on 2026-04-26T19:48:19+08:00 recorded `docs/process/2026-04-26-scheduler-cadence-audit-1948.md`: runtime-alert job `1c093252ab70` was due at `19:48:49+08:00` and still had not advanced by `19:50:38+08:00`, with no new session after `session_cron_1c093252ab70_20260426_194332.json`; `last_status` and delivery metadata stayed healthy, while the continuation worker session was active. Classification remains intermittent scheduler dispatcher/cadence health, not runtime monitor command behavior, `[SILENT]` behavior, or Discord delivery routing.

- P0 scheduler/finalization checkpoint on 2026-04-26T20:45:00+08:00 recorded `docs/process/2026-04-26-p0-cron-session-finalization-gap.md`: runtime-alert and typed fanout jobs recovered automatic sessions/output, but P0 monitor automatic session `session_cron_75cedbb77150_20260426_204342.json` advanced scheduling without refreshing `last_run_at` or writing a new output artifact. Keep continuation worker paused and do not resume normal development until P0 monitor finalization is proven healthy.

- P0 scheduler recovery checkpoint on 2026-04-26T21:03:00+08:00 recorded `docs/process/2026-04-26-p0-scheduler-recovery.md`: P0 monitor, runtime-alert, roadmap/dev-log/research fanouts, and 6h report all advanced automatic `last_run_at`/output artifacts after the earlier finalization gap. The continuation worker may be resumed, while future stale metadata/output mismatches remain P0 regressions.
- P0 scheduler cadence regression checkpoint on 2026-04-26T21:56:02+08:00 recorded `docs/process/2026-04-26-scheduler-cadence-regression-2156.md`: after a short recovery window, multiple enabled jobs again became overdue without new sessions or `last_run_at` advancement: continuation `f66ed36d7be0` after `21:48:07`, runtime-alert `1c093252ab70` after `21:48:17`, P0 monitor `75cedbb77150` after `21:53:34`, roadmap fanout `92ca290f7996` after `21:52:22`, and dev-log fanout `d3bf35c278d5` after `21:55:45`. `last_status=ok` and `last_delivery_error=null` stayed healthy, so classify this as renewed scheduler dispatcher/cadence regression rather than Discord delivery, no-alert behavior, or runtime-monitor command failure. Pause normal development until operator inspection/repair and two consecutive healthy intervals are proven.
- P0 scheduler recovery checkpoint on 2026-04-26T22:59:17+08:00 recorded `docs/process/2026-04-26-p0-scheduler-recovery-2259.md`: the 4h checkpoint, P0 operations monitor, and runtime-alert job all advanced/finalized inside the bounded observation window; runtime-alert sessions at 22:41, 22:47, 22:53, and 22:59 all finalized exactly `[SILENT]`.
- P0 scheduler repair completion checkpoint on 2026-04-26T23:20:41+08:00 recorded `docs/process/2026-04-26-p0-repair-completion-2320.md`: the 4h checkpoint, runtime-alert, P0 monitor, typed fanouts, and resumed bounded continuation worker all produced fresh finalized output artifacts after prompt/cadence repair. Classification is repaired for the current operating window; normal development may resume while the P0 monitor continues routine watch for future stale metadata/output regressions.
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


## Goal-oriented six-domain PM contract

Owner correction on 2026-04-26: the main agent is responsible for project management outcomes, not only process scheduling. Every active planning/reporting cycle must keep all six roadmap domains advancing concurrently through delegated subagent/Codex tasks:

1. Agent OS / visibility — current estimate 100%; current P0 scheduler/visibility incident repaired in `docs/process/2026-04-26-p0-repair-completion-2320.md`; next delegated task: routine P0 monitor watch only, and reopen/escalate if a future job shows stale `next_run_at`, missing finalized output, delivery errors, or workdir serialization risk.
2. Engineering governance — current estimate 95%; completed in this slice: PR #45 merged after the 15-minute gate and repository ruleset `default` now applies to `~DEFAULT_BRANCH`, blocks deletion/non-fast-forward, requires PRs with resolved threads, and requires the strict `Verify prod TypeScript, Jest, and bundle` check on `main`; next delegated task: observe the next PR to confirm the ruleset blocks unsafe direct/unchecked changes in practice.
3. Private-server validation — current estimate 85%; next delegated task: fresh live `scripts/screeps-private-smoke.py run` from a clean ignored workdir and redacted report.
4. Runtime Monitor — current estimate 85%; next delegated task: verify scheduled summary/alert cadence and no-alert silence.
5. Bot Capability — current estimate 80%; next delegated task: convert real private-smoke/runtime observations into deterministic Codex-owned hardening.
6. Official MMO — current estimate 50%; next delegated task: keep the temporary official link validation subordinate to the private-server release gate and monitoring evidence.

Roadmap snapshots must include each domain's next-point completion percentage. A six-hour development report job (`dfcaf65d7ea7`) sends to `discord:1497587260835758222:1497833662241181746` with exactly: past six hours completed, overall roadmap progress, and next six hours plan.

If a roadmap target is achieved or the next target requires clarification, the main agent should proactively ask the owner rather than silently continuing process-only work.
