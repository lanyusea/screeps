# Runtime Monitor Implementation

Date: 2026-04-26T05:11:22+08:00

## Context

The owner approved the warm neutral editorial room snapshot style and requested a formal runtime monitor:

- hourly images to `#runtime-summary`
- red-emphasis alert images to `#runtime-alerts` when hostile/damage events are detected

The earlier image prototypes under `docs/process/` proved the official-client API rendering path. This slice turned that proof of concept into a cron-friendly script.

## Implementation

Added:

- `scripts/screeps-runtime-monitor.py`
- `docs/ops/runtime-room-monitor.md`
- `.gitignore` entries for runtime artifacts and Codex scratch files

The monitor supports:

```bash
python3 scripts/screeps-runtime-monitor.py summary
python3 scripts/screeps-runtime-monitor.py alert
python3 scripts/screeps-runtime-monitor.py self-test
```

Summary mode discovers owned rooms, fetches terrain, subscribes to the official-client room websocket, renders one warm editorial PNG per room, and outputs JSON with absolute image paths.

Alert mode maintains a local baseline at `/root/.hermes/screeps-runtime-monitor/state.json` by default and detects:

- hostile creeps
- structure hit-point drops
- missing critical owned structures after baseline

It debounces identical alert signatures for 300 seconds by default and renders red-emphasis alert images only when an alert is emitted, unless `--force-alert-image` is used for tests.

## Verification performed

Offline self-test:

```bash
python3 scripts/screeps-runtime-monitor.py self-test
```

Result:

- 8 tests passed
- covered terrain decoding/counting, baseline/no-alert behavior, hostile alert, damage alert, critical missing alert, debounce suppression, and safe JSON secret rejection

Live summary smoke:

```bash
set -a; . /root/.secret/.env; set +a
python3 scripts/screeps-runtime-monitor.py summary --room shardX/E48S28 --out-dir /root/screeps/runtime-artifacts/screeps-monitor-smoke
```

Result:

- `ok: true`
- generated `/root/screeps/runtime-artifacts/screeps-monitor-smoke/summary-shardX-E48S28.png`
- no token values printed

Live alert baseline smoke:

```bash
SCREEPS_MONITOR_STATE_FILE=/tmp/screeps-monitor-alert-smoke-state.json \
python3 scripts/screeps-runtime-monitor.py alert --room shardX/E48S28 --out-dir /root/screeps/runtime-artifacts/screeps-monitor-smoke
```

Result:

- `ok: true`
- `alert: false`
- baseline updated
- no token values printed

Forced alert-render smoke:

```bash
SCREEPS_MONITOR_STATE_FILE=/tmp/screeps-monitor-alert-smoke-state.json \
python3 scripts/screeps-runtime-monitor.py alert --room shardX/E48S28 --force-alert-image --out-dir /root/screeps/runtime-artifacts/screeps-monitor-smoke
```

Result:

- `ok: true`
- `alert: false`
- generated `/root/screeps/runtime-artifacts/screeps-monitor-smoke/alert-shardX-E48S28.png`
- red emphasis was visually verified without claiming a real alert

Vision checks confirmed both summary and forced-alert images preserve the approved visual direction and have no obvious cropping/overlap.

## Scheduling follow-up

After code verification, create two Hermes cron jobs:

1. Hourly summary job delivered to `discord:#runtime-summary`, final response includes `MEDIA:` paths.
2. Frequent alert check job delivered to `discord:#runtime-alerts`; it returns `[SILENT]` on no-alert runs and includes `MEDIA:` paths only when `alert: true`, avoiding no-alert spam.

## Notes

The first production version is cron-friendly rather than a true always-on websocket daemon. That is acceptable for hourly summaries and near-term alert checks. A future always-on monitor can reuse the same rendering and alert state logic while maintaining an incremental websocket object cache.
