# P0 scheduler cadence regression checkpoint — 2026-04-26 21:56 +08:00

## Bounded slice

- Start: `2026-04-26T21:43:19+08:00`
- Final audit checkpoint: `2026-04-26T21:56:02+08:00`
- Scope: one bounded continuation-worker slice; no cron jobs were created, modified, paused, resumed, or removed.
- Repository state at start: `/root/screeps` on `main`, clean.
- Open PRs at start: none (`gh pr list --state open` returned `[]`).

## Safe scheduler metadata inspected

The audit inspected only cron metadata and session-file timestamps/sizes for the Screeps job family. Prompts, secrets, and full transcripts were not printed.

### Initial metadata at `2026-04-26T21:44:01+08:00`

- `f66ed36d7be0` — `Screeps autonomous continuation worker`: `last_run_at=2026-04-26T20:09:20.283870+08:00`, `next_run_at=2026-04-26T21:48:07.421441+08:00`, delivery `discord:#task-queue`, `last_status=ok`, `last_delivery_error=null`. A current session file existed for this run: `session_cron_f66ed36d7be0_20260426_214307.json`.
- `75cedbb77150` — `Screeps P0 agent operations monitor`: `last_run_at=2026-04-26T21:38:34.170213+08:00`, `next_run_at=2026-04-26T21:53:34.170213+08:00`, delivery `discord:1497820688843800776`, `last_status=ok`, `last_delivery_error=null`.
- `1c093252ab70` — `Screeps runtime room alert image check`: `last_run_at=2026-04-26T21:43:17.392900+08:00`, `next_run_at=2026-04-26T21:48:17.392900+08:00`, delivery `discord:#runtime-alerts`, `last_status=ok`, `last_delivery_error=null`.
- Typed fanouts were also enabled with healthy last-status/delivery metadata: runtime-summary `befcbb7b2d60`, dev-log `d3bf35c278d5`, research-notes `3c0d20aa2e45`, roadmap `92ca290f7996`.

### First overdue checkpoint at `2026-04-26T21:50:51+08:00`

- Continuation worker `f66ed36d7be0` was overdue since `21:48:07`; no new session beyond the active `session_cron_f66ed36d7be0_20260426_214307.json`.
- Runtime alert `1c093252ab70` was overdue since `21:48:17`; no new session beyond `session_cron_1c093252ab70_20260426_214307.json`.
- Delivery metadata still showed `last_status=ok` and `last_delivery_error=null`, so this did not implicate Discord delivery or the alert command itself.

### Second overdue checkpoint at `2026-04-26T21:56:02+08:00`

- Continuation worker `f66ed36d7be0`: still `last_run_at=20:09:20`, `next_run_at=21:48:07`; no new completed metadata while the current session remained active.
- Runtime alert `1c093252ab70`: still `last_run_at=21:43:17`, `next_run_at=21:48:17`; no new session after `session_cron_1c093252ab70_20260426_214307.json`.
- P0 monitor `75cedbb77150`: became overdue at `21:53:34`; no new session after `session_cron_75cedbb77150_20260426_213645.json`.
- Roadmap fanout `92ca290f7996`: became overdue at `21:52:22`; no new session after `session_cron_92ca290f7996_20260426_213157.json`.
- Dev-log fanout `d3bf35c278d5`: became overdue at `21:55:45`; no new session after `session_cron_d3bf35c278d5_20260426_213422.json`.

## Classification

This is a renewed P0 scheduler dispatcher/cadence regression after the earlier `21:03` recovery checkpoint. Several unrelated enabled jobs became overdue simultaneously while retaining healthy `last_status` and `last_delivery_error` fields. The evidence points away from a single job prompt, the runtime monitor command, no-alert `[SILENT]` behavior, or Discord delivery routing, and back toward scheduler dispatch/rescheduling/finalization health.

## Recommended next action

Keep normal bot hardening and private-server follow-up paused until the scheduler runner/cadence defect is operator-inspected or repaired. After repair, require evidence that at least these jobs advance on schedule across two consecutive intervals:

1. runtime-alert `1c093252ab70` returns/records no-alert `[SILENT]` behavior without stale `next_run_at`;
2. P0 monitor `75cedbb77150` refreshes `last_run_at` and writes a new session/output artifact;
3. typed fanouts such as roadmap/dev-log advance after their due times.
