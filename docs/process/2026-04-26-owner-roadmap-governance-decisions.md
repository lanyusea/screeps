# Owner roadmap-governance decisions

Time: 2026-04-26T17:55+08

## Context

The owner asked the main agent to self-check whether actual operation matched the required Screeps working model:

1. roadmap/tasks are maintained in GitHub and kept current;
2. the main agent decomposes vision → roadmap → tasks and syncs them to GitHub in the standard format;
3. discovered bugs are registered in GitHub with main-agent priority/scheduling judgment;
4. subagents take GitHub issues/tasks, submit PRs, merge only after review, and update GitHub state;
5. QA acceptance checks must pass before the main agent treats deliverables as complete;
6. work should run normally with P0 monitoring, alerting, and reporting.

The self-check found three policy gaps that required owner decisions: the review gate口径, whether all active PRs must be Project-tracked, and whether P0 scheduler/monitoring health blocks normal work.

## Decisions

### D1 — Automated review口径

All PR review gates use the automated口径. Formal GitHub approving review is not required by default.

A PR may be merged after:

- at least 15 minutes have elapsed after PR creation;
- required checks are green, including `Verify prod TypeScript, Jest, and bundle` when applicable;
- CodeRabbit/Gemini have no blocking findings or explicitly report no feedback;
- all review threads/discussions are resolved or verified as outdated/non-blocking;
- linked issue and PR Project items are current;
- QA/acceptance-check returns `PASS` for meaningful deliverables.

### D2 — All active PRs enter Project `screeps`

Every active agent PR must be added to Project `screeps` and keep at least these fields current until merged or explicitly closed:

- `Status`
- `Priority`
- `Domain`
- `Kind`
- `Evidence`
- `Next action`

A PR or task whose Project item is missing/stale is not complete.

### D3 — P0 health blocks normal work

If P0 monitoring, routing, or scheduler cadence is known unhealthy, normal implementation slices and non-P0 merges are deferred until the main agent repairs or proves the affected P0 automation healthy again.

## Immediate reconciliation performed

- Added/backfilled Project items for missing recent agent PRs: `#46`, `#43`, `#42`, and `#38`.
- Refreshed stale Project fields for `#44` and `#45`.
- Manually triggered P0 monitor job `75cedbb77150` and runtime alert job `1c093252ab70` to start cadence recovery/proof.

## Remaining P0 follow-up

Issue `#27` remains the active P0 control-plane issue until automatic cadence is proven healthy across the P0 monitor and runtime-alert jobs. Normal non-P0 implementation work should remain deferred while this is unresolved.
