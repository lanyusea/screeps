# Runtime Room Monitor

Date: 2026-04-26T05:11:22+08:00

## Purpose

The runtime room monitor renders live Screeps room-state images from official-client API data and supports two Discord operations channels:

- `#runtime-summary` (`1497588267057680385`): periodic room snapshots every 1 hour.
- `#runtime-alerts` (`1497588512436785284`): red-emphasis alert snapshots when hostiles or damage are detected.

The image style follows the approved warm neutral editorial direction: no large title, a large left map, narrow dense right-side status column, thin lines, and off-white/gray palette with red reserved for alerts.

## Script

Main command:

```bash
python3 scripts/screeps-runtime-monitor.py summary
python3 scripts/screeps-runtime-monitor.py alert
```

The script outputs JSON only and never prints auth tokens.

Default artifact directory:

```text
/root/screeps/runtime-artifacts/screeps-monitor
```

This path is ignored by git.

## Environment

Required:

```bash
SCREEPS_AUTH_TOKEN=<token>       # never print or commit
```

Optional:

```bash
SCREEPS_API_URL=https://screeps.com
SCREEPS_SHARD=shardX
SCREEPS_ROOM=E48S28
SCREEPS_OWNER=lanyusea
SCREEPS_MONITOR_STATE_FILE=/root/.hermes/screeps-runtime-monitor/state.json
SCREEPS_ALERT_DEBOUNCE_SECONDS=300
```

In local Hermes runs, these are normally sourced from `/root/.secret/.env` without displaying values.

## Summary mode

```bash
set -a; . /root/.secret/.env; set +a
python3 scripts/screeps-runtime-monitor.py summary --out-dir /root/screeps/runtime-artifacts/screeps-monitor
```

Behavior:

1. Discover owned rooms through `GET /api/user/overview`.
2. Fetch terrain with `GET /api/game/room-terrain?encoded=1`.
3. Connect to `wss://screeps.com/socket/websocket`.
4. Authenticate with `auth <token>`.
5. Subscribe to `room:<shard>/<room>`.
6. Render one PNG per owned room.
7. Print JSON including absolute image paths.

For targeted smoke tests:

```bash
python3 scripts/screeps-runtime-monitor.py summary --room shardX/E48S28
```

## Alert mode

```bash
set -a; . /root/.secret/.env; set +a
python3 scripts/screeps-runtime-monitor.py alert --out-dir /root/screeps/runtime-artifacts/screeps-monitor
```

Alert rules:

- hostile creep visible
- owned/damageable structure hit points decrease since previous baseline
- previously observed critical owned structure disappears

First run establishes a baseline and returns no alert unless hostiles are already visible.

Debounce:

- default: 300 seconds
- configured by `SCREEPS_ALERT_DEBOUNCE_SECONDS`
- identical alert signatures are suppressed during the debounce window

State file:

```text
/root/.hermes/screeps-runtime-monitor/state.json
```

The state file is local-only and not committed.

Testing alert rendering without creating a real alert:

```bash
SCREEPS_MONITOR_STATE_FILE=/tmp/screeps-monitor-alert-smoke-state.json \
python3 scripts/screeps-runtime-monitor.py alert --room shardX/E48S28 --force-alert-image
```

`--force-alert-image` renders a red-emphasis image but keeps `alert: false` unless a real alert exists.

## Verification

Offline pure-function tests:

```bash
python3 scripts/screeps-runtime-monitor.py self-test
```

## Runtime KPI console capture

The room monitor renders official room summary and alert images; runtime KPI console summaries are persisted by the capture utility. When a Hermes worker or manual operator has raw Screeps console text, use the offline path:

```bash
python3 scripts/screeps_runtime_summary_console_capture.py saved-console.log
```

For a bounded official-client websocket capture, load `SCREEPS_AUTH_TOKEN` from the local secret environment and run live mode. `SCREEPS_API_URL` defaults to `https://screeps.com`; `SCREEPS_CONSOLE_CHANNELS` or repeated `--console-channel` values can override the default requested channel list, which includes `console`.

```bash
python3 scripts/screeps_runtime_summary_console_capture.py --live-official-console --live-timeout-seconds 20 --live-max-messages 50
```

The default output directory is:

```text
/root/screeps/runtime-artifacts/runtime-summary-console
```

Only lines starting exactly `#runtime-summary ` are written. Embedded, quoted, timestamp-prefixed, or noisy markers are skipped. The command output reports counts, output path, and requested websocket channels without printing tokens, headers, or raw artifact contents. Do not add cron jobs from this runbook step.

Live smoke:

```bash
set -a; . /root/.secret/.env; set +a
python3 scripts/screeps-runtime-monitor.py summary --room shardX/E48S28 --out-dir /root/screeps/runtime-artifacts/screeps-monitor-smoke
SCREEPS_MONITOR_STATE_FILE=/tmp/screeps-monitor-alert-smoke-state.json \
  python3 scripts/screeps-runtime-monitor.py alert --room shardX/E48S28 --out-dir /root/screeps/runtime-artifacts/screeps-monitor-smoke
```

## Scheduled delivery design

Use Hermes cron jobs rather than putting Discord tokens in the repo.

### Hourly summary job

- schedule: every 1 hour
- target: `discord:#runtime-summary`
- command: run summary mode and include generated `MEDIA:` image paths in the final cron response

### Alert job

- schedule: every 5 minutes, or always-on websocket process in a future version
- target: `discord:#runtime-alerts`
- behavior: run alert mode; if `alert: true`, final cron response includes alert text plus `MEDIA:` image paths; if no alert, final response is exactly `[SILENT]` so the scheduler suppresses delivery

This design avoids posting “no alert” messages repeatedly while still enabling image-based alert delivery.

## Safety notes

- Never print or commit `SCREEPS_AUTH_TOKEN`.
- Do not commit runtime artifacts under `runtime-artifacts/`.
- The official-client API endpoints are undocumented but allowed by Screeps auth-token documentation; monitor breakage should be treated as an operational alert.
- The websocket room event used here is the first fresh event from a new connection. Later websocket events can be partial patches, so a long-lived future monitor must maintain an object cache.
