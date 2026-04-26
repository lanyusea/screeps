# Scheduler alert gap audit

Date: 2026-04-26

## Context

The continuation worker's current priority backlog says to keep PR #16 closed, then verify scheduled reporting delivery and stale `next_run_at` behavior before returning to private-server or deterministic bot hardening.

At the start of this bounded slice, `/root/screeps` was clean on `main`, open PR list was empty, and PR #16 was already merged. This allowed a P0 visibility audit without racing an active PR branch.

## Evidence collected

Command source: direct inspection of `/root/.hermes/cron/jobs.json` and latest `/root/.hermes/sessions/session_cron_*` files at approximately `2026-04-26T16:35:36+08:00`.

Healthy findings:

- All expected Screeps jobs were enabled and in `scheduled` state.
- All expected Screeps jobs had `workdir: null`, avoiding the known scheduler serialization risk from repository workdirs.
- Continuation worker delivery was `discord:#task-queue`.
- P0 operations monitor delivery was `discord:1497820688843800776`.
- Runtime summary delivery was `discord:#runtime-summary`.
- Runtime alert delivery was `discord:#runtime-alerts`.
- Dev-log, roadmap, and research fanout deliveries were respectively `discord:#dev-log`, `discord:#roadmap`, and `discord:#research-notes`.
- Six-hour development report delivery was `discord:1497587260835758222:1497833662241181746`.
- `last_status` was `ok` and `last_delivery_error` was `null` for the inspected jobs.

Abnormal / needs follow-up:

- `Screeps runtime room alert image check` (`1c093252ab70`) is configured for every 5 minutes, but at `2026-04-26T16:35:36+08:00` its `last_run_at` was `2026-04-26T16:04:43.914467+08:00`, about 31 minutes old.
- The same job's `next_run_at` was `2026-04-26T16:34:47.303553+08:00`, already slightly overdue at inspection time. This is the current concrete evidence for the suspected stale/delayed `next_run_at` behavior.
- The P0 operations monitor (`75cedbb77150`) is configured for every 15 minutes but was about 39 minutes old at inspection time, with `next_run_at` still in the future at `2026-04-26T16:44:47+08:00`. This is less urgent than the alert gap but supports continued scheduler-cadence scrutiny.

No secrets were inspected or printed.

## Current conclusion

The high-level delivery configuration is correct, but runtime-alert cadence is not yet proven reliable. The next bounded slice should inspect whether the overdue alert job actually fired after `16:34:47`, compare newest `session_cron_1c093252ab70_*` and cron output files, then decide whether this is only a transient scheduler delay or a recurring stale-`next_run_at` defect requiring live cron repair outside the continuation worker.

## Recommended next action

1. Re-check `/root/.hermes/cron/jobs.json` after the current continuation slice exits.
2. Confirm whether `1c093252ab70` advanced `last_run_at` and wrote a new session/output after `2026-04-26T16:34:47+08:00`.
3. If it did not advance, report the exact repair need through the P0 monitor path; do not silently proceed to private-server smoke or bot hardening.
4. If it did advance and no alert/error occurred, record the cadence proof and continue to the next roadmap point: fresh private-smoke harness rerun or runtime-monitor scheduling evidence.
