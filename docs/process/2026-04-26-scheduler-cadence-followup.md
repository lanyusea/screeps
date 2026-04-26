# Scheduler cadence follow-up

Date: 2026-04-26

## Bounded slice

This continuation worker started at `2026-04-26T17:00:07+08:00` with a target runtime of 25 minutes and absolute maximum of 45 minutes. The slice was limited to verifying the P0 scheduler/reporting gap identified in `docs/process/2026-04-26-scheduler-alert-gap-audit.md`; no cron jobs were created or modified.

## Repository and PR state

- `/root/screeps` was clean on `main` at slice start.
- `gh pr list --state open` returned an empty list, so there was no active PR loop to close before investigating the visibility issue.
- Investigation and documentation were performed from worktree `/root/screeps-worktrees/scheduler-cadence-followup-20260426` on branch `docs/scheduler-cadence-followup-20260426`.

## Evidence collected

Safe metadata from `/root/.hermes/cron/jobs.json` and `/root/.hermes/sessions` was inspected without printing job prompts, command bodies, env values, or secrets.

At `2026-04-26T17:00:54+08:00`:

- `Screeps runtime room alert image check` (`1c093252ab70`) was still enabled with `last_status: ok` and no delivery error, but its `last_run_at` remained `2026-04-26T16:04:43.914467+08:00`.
- The same alert job's `next_run_at` was `2026-04-26T17:00:29.431092+08:00`, already overdue by inspection time.
- The newest alert job session files remained:
  - `session_cron_1c093252ab70_20260426_145657.json`
  - `session_cron_1c093252ab70_20260426_155756.json`
  - `session_cron_1c093252ab70_20260426_160432.json`
- The latest alert session returned valid monitor JSON with `alert: false`, `ok: true`, no warnings, and final response `[SILENT]`, so the monitor command and no-alert silence behavior worked when the scheduler actually ran it.
- `Screeps runtime room summary images` (`befcbb7b2d60`) had run recently at `2026-04-26T16:55:50.158902+08:00`, rendered `summary-shardX-E48S28.png`, and delivered a normal runtime summary.

After an additional 90-second wait, at `2026-04-26T17:03:00+08:00`:

- The alert job still had not advanced: `last_run_at` remained `2026-04-26T16:04:43.914467+08:00` and `next_run_at` remained the overdue `2026-04-26T17:00:29.431092+08:00`.
- No new `session_cron_1c093252ab70_*` files appeared after `2026-04-26T16:04:32`.
- The P0 operations monitor (`75cedbb77150`) was also stale relative to its 15-minute interval: `last_run_at` remained `2026-04-26T15:56:56.619704+08:00`, although its `next_run_at` was still in the future at `2026-04-26T17:10:29.431092+08:00`.

## Conclusion

The earlier suspected scheduler cadence gap is still reproducible. Runtime alert delivery configuration is correct and the alert monitor itself returns proper `[SILENT]` output when no alert exists, but the scheduler did not launch the every-5-minute runtime-alert job for nearly an hour and did not consume an overdue `next_run_at` during this bounded slice.

This is now a P0 visibility blocker for runtime-alert reliability, not a Screeps monitor script bug. The continuation worker should not proceed to private-server smoke or unrelated bot hardening until the scheduler runner/cadence issue is repaired or explicitly accepted.

## Recommended next action

1. Inspect the Hermes scheduler runner/gateway logs and scheduler state transitions for job `1c093252ab70` around `2026-04-26T16:04` through `17:03`.
2. Verify whether jobs that return final `[SILENT]` are being rescheduled correctly, because the runtime-summary job continued to run while the alert job stopped advancing.
3. Repair or restart the scheduler runner from an operator-controlled context if needed; this continuation worker intentionally did not create, delete, or mutate cron jobs.
4. After repair, require fresh proof that `1c093252ab70` advances `last_run_at` and `next_run_at` across at least two consecutive intervals while returning `[SILENT]` for no-alert output.
