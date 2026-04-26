# Scheduler cadence audit at 18:32

Timebox: started 2026-04-26T18:30:05+08:00; audit checkpoint recorded at 2026-04-26T18:32:15+08:00.

## Scope

This bounded continuation slice followed the P0 visibility priority before any private-server or bot hardening work:

- inspected `/root/screeps` git state and open PRs;
- read `docs/process/active-work-state.md` and `docs/ops/roadmap.md`;
- inspected `/root/.hermes/cron/jobs.json` directly without using or modifying cron jobs;
- inspected latest cron sessions and final outputs for the continuation worker, P0 monitor, runtime summary, and runtime alert jobs.

No secrets were printed. No production code changed.

## Verified repository state

- Main worktree `/root/screeps` was clean on `main`.
- `git fetch` advanced local `main` / `origin/main` to `0343354 docs: record scheduler cadence audit (#49)`.
- `gh pr list --state open` returned no open pull requests.
- All inspected scheduled Screeps jobs had `workdir: null`, expected delivery targets, `last_status: ok`, and no `last_delivery_error`.

## Scheduler findings

At `2026-04-26T18:30:49+08:00`, `jobs.json` showed:

- continuation `f66ed36d7be0`: `last_run_at=18:24:55`, `next_run_at=18:34:55`; cadence is delayed for an every-5m job because an active continuation session started at `18:29:55` and is this bounded slice.
- runtime alert `1c093252ab70`: `last_run_at=17:57:47`, `next_run_at=18:30:55`; due within seconds.
- P0 monitor `75cedbb77150`: `last_run_at=17:59:16`, `next_run_at=18:40:55`; this is a ~41m gap for an every-15m job.
- dev-log fanout `d3bf35c278d5`: `last_run_at=17:23:30`, `next_run_at=18:45:55`; this is an ~82m gap for an every-20m job.
- research fanout `3c0d20aa2e45`: `last_run_at=17:24:03`, `next_run_at=18:45:55`; this is an ~82m gap for an every-20m job.
- roadmap fanout `92ca290f7996`: `last_run_at=17:23:31`, `next_run_at=18:45:55`; this is an ~82m gap for an every-20m job.

A follow-up check at `2026-04-26T18:32:15+08:00` found runtime alert still had not run after its `18:30:55` due time:

- runtime alert `1c093252ab70`: `last_run_at=17:57:47`, `next_run_at=18:30:55`, `overdue_s=80`, `repeat.completed=16`, newest session still `session_cron_1c093252ab70_20260426_175736.json`.

This reconfirms that the remaining P0 blocker is the Hermes cron scheduler cadence/rescheduling path, not the runtime-alert monitor command itself. The latest runtime-alert final output at `17:57:47` was `[SILENT]`, so no-alert behavior remains proven when the job actually runs.

## Required next action

Keep normal private-server/bot hardening paused until a scheduler-level repair or operator intervention proves:

1. runtime alert `1c093252ab70` advances across at least two every-5m no-alert intervals;
2. P0 monitor `75cedbb77150` advances every ~15m;
3. dev-log, research-notes, and roadmap fanout jobs advance every ~20m;
4. `next_run_at` values are not being pushed far past their configured interval while jobs remain `state=scheduled` and `last_status=ok`.

Because this continuation worker is not allowed to create or modify cron jobs recursively, this slice records the evidence and reports the blocker visibly rather than attempting scheduler mutation.
