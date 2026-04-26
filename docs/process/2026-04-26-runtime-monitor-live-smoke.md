# Runtime monitor live-token smoke

Date: 2026-04-26
Branch: `docs/runtime-monitor-live-smoke-20260426`

## Goal

Run one bounded live-token smoke of the existing external runtime monitor after the private-server validation path was unblocked, without printing secrets and without creating recursive cron jobs from the continuation worker.

## Preconditions checked

- Main worktree was clean before the slice.
- Local secret/config was sourced from the existing ignored environment path without printing token values.
- Safe selectors observed by the monitor path:
  - `SCREEPS_API_URL=https://screeps.com`
  - `SCREEPS_SHARD=shardX`
  - `SCREEPS_ROOM=E48S28`

## Commands run

From `/root/screeps`:

```bash
python3 scripts/screeps-runtime-monitor.py self-test
python3 scripts/screeps-runtime-monitor.py summary --format json
python3 scripts/screeps-runtime-monitor.py alert --format json
```

## Results

- Offline monitor self-test passed: 8 tests.
- Live `summary` command succeeded and rendered `/root/screeps/runtime-artifacts/screeps-monitor/summary-shardX-E48S28.png`.
- Live summary payload reported:
  - room: `shardX/E48S28`
  - tick: `108687`
  - creeps: `3`
  - hostiles: `0`
  - objects: `8`
  - structures: `2`
  - warnings: none
- Live `alert` command succeeded with no alert:
  - `alert: false`
  - reasons: none
  - suppressed: false
  - warnings: none
  - state file: `/root/.hermes/screeps-runtime-monitor/state.json`

## Interpretation

The runtime monitor is ready for scheduled delivery from a dedicated runtime-summary/runtime-alerts job: summary should deliver the rendered PNG to `discord:#runtime-summary`; the alert scheduler/wrapper should inspect the JSON payload and make the scheduled job's final response exactly `[SILENT]` when `alert=false`, while delivering images/text to `discord:#runtime-alerts` only for real anomalies. The monitor script itself currently emits JSON for `--format json`; quiet no-alert delivery is a scheduler/wrapper responsibility unless a future script flag adds that behavior directly.

This continuation worker intentionally did **not** create or modify cron jobs, because the scheduled-worker prompt forbids recursive cron creation.

## Follow-up

1. In a separate scheduler-management slice, configure or verify the existing runtime-summary/runtime-alert jobs rather than doing it from this continuation worker.
2. Keep generated monitor artifacts under ignored `runtime-artifacts/` and monitor state under `/root/.hermes/screeps-runtime-monitor/`.
3. Continue using private-server-first validation before future release-quality MMO deployments.
