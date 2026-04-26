# Scheduler cadence audit at 18:00

- Slice start: 2026-04-26T18:00:26+08:00
- Audit checkpoint: 2026-04-26T18:03:29+08:00
- Repository state before audit: `/root/screeps` on `main`, clean worktree, no open GitHub PRs.
- Change branch: `docs/scheduler-cadence-audit-20260426-1800`

## Safe scheduler metadata inspected

The audit inspected only safe cron/job metadata from `/root/.hermes/cron/jobs.json` and session file timestamps/sizes; it did not print prompts, secrets, or full transcripts.

| Job | ID | Delivery | Last run | Next run | Finding |
| --- | --- | --- | --- | --- | --- |
| Screeps runtime room alert image check | `1c093252ab70` | `discord:#runtime-alerts` | `2026-04-26T17:57:47.786430+08:00` | `2026-04-26T18:02:47.786430+08:00` | Stale: after waiting until `18:03:29+08:00`, the job still had not advanced and no new session file existed after `session_cron_1c093252ab70_20260426_175736.json`. |
| Screeps autonomous continuation worker | `f66ed36d7be0` | `discord:#task-queue` | `2026-04-26T17:53:18.040422+08:00` | `2026-04-26T18:05:16.909759+08:00` | Current continuation session file `session_cron_f66ed36d7be0_20260426_180017.json` exists, but the job metadata had not yet been updated while the run was still active. |
| Screeps runtime room summary images | `befcbb7b2d60` | `discord:#runtime-summary` | `2026-04-26T17:56:36.093896+08:00` | `2026-04-26T18:56:36.093896+08:00` | Not due during this bounded slice; last hourly session exists. |
| Screeps P0 agent operations monitor | `75cedbb77150` | `discord:1497820688843800776` | `2026-04-26T17:59:16.903139+08:00` | `2026-04-26T18:14:16.903139+08:00` | Not due during this bounded slice; last monitor session exists. |

## Classification

The runtime-alert no-alert behavior is not the blocker in this observation: the previous successful runtime-alert session at `17:57:47+08:00` recorded `last_status: ok` and `last_delivery_error: null`. The live blocker remains scheduler cadence/rescheduling: job `1c093252ab70` was enabled, overdue, and still did not create a new session or advance `last_run_at` / `next_run_at` after its due time.

## Operational impact

- `#runtime-alerts` cannot yet be trusted for 5-minute no-alert silence or urgent alert cadence.
- Continue treating Agent OS / visibility as the top P0 gate before private-server smoke reruns or unrelated bot hardening.
- Do not rely on `last_status: ok` alone; compare `next_run_at`, current time, and session-file creation times.

## Recommended next action

Run an operator-level Hermes scheduler/runner inspection or repair for the cron dispatcher itself, then prove job `1c093252ab70` advances across at least two consecutive 5-minute no-alert intervals with final `[SILENT]` responses. If repair is outside repository scope, keep reporting the exact job id, due timestamp, and lack of session-file advancement until the scheduler owner fixes the runner.
