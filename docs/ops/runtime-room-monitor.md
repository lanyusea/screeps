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
python3 scripts/screeps-runtime-monitor.py tactical-response
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
SCREEPS_ROOM=E26S49
SCREEPS_OWNER=lanyusea
SCREEPS_MONITOR_STATE_FILE=/root/.hermes/screeps-runtime-monitor/state.json
SCREEPS_ALERT_DEBOUNCE_SECONDS=300
```

In local Hermes runs, source these from the local secret environment without displaying values.

## Summary mode

```bash
# Load SCREEPS_AUTH_TOKEN into the environment without printing it.
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
python3 scripts/screeps-runtime-monitor.py summary --room shardX/E26S49
```

## Alert mode

```bash
# Load SCREEPS_AUTH_TOKEN into the environment without printing it.
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
python3 scripts/screeps-runtime-monitor.py alert --room shardX/E26S49 --force-alert-image
```

`--force-alert-image` renders a red-emphasis image but keeps `alert: false` unless a real alert exists.

## Tactical response bridge

The tactical bridge is an offline API mode that consumes the JSON emitted by `alert` mode and returns a bounded machine-readable next-action payload. It does not call Screeps APIs, does not create cron jobs, and does not send Discord messages directly.

It also accepts redacted private-smoke report JSON from `scripts/screeps-private-smoke.py run`. Clean successful smoke reports stay silent, while failed phases and missing runtime evidence are promoted into alert categories:

- failed private-smoke phase: `private_smoke_failure`
- `/stats` timeout with no usable samples: `telemetry_silence`
- `/stats` samples that never satisfy owned-room/creep criteria: `runtime_deadlock`
- missing spawn or worker evidence in the Mongo room summary: `spawn_collapse`

Pipe usage:

```bash
python3 scripts/screeps-runtime-monitor.py alert --room shardX/E26S49 \
  | python3 scripts/screeps-runtime-monitor.py tactical-response
```

File usage:

```bash
python3 scripts/screeps-runtime-monitor.py tactical-response --input runtime-alert.json
python3 scripts/screeps-runtime-monitor.py tactical-response --input private-smoke-report.json
```

No-alert dry run:

```bash
printf '%s\n' '{"ok":true,"mode":"alert","alert":false,"reasons":[],"rooms":["shardX/E26S49"],"warnings":[]}' \
  | python3 scripts/screeps-runtime-monitor.py tactical-response
```

Expected no-alert fields:

```json
{
  "emergency": false,
  "silent": true,
  "severity": "none",
  "categories": [],
  "scheduler": {
    "should_post": false,
    "recommended_output": "[SILENT]"
  }
}
```

High-priority dry run:

```bash
printf '%s\n' '{"ok":true,"mode":"alert","alert":true,"reasons":[{"kind":"hostile_creep","room":"shardX/E26S49","object_id":"hostile-1","owner":"Invader","x":20,"y":21,"message":"hostile creep visible: Invader at 20,21"}],"rooms":["shardX/E26S49"]}' \
  | python3 scripts/screeps-runtime-monitor.py tactical-response
```

Expected emergency fields:

```json
{
  "emergency": true,
  "silent": false,
  "severity": "high",
  "categories": ["hostiles"],
  "scheduler": {
    "should_post": true,
    "recommended_output": "TACTICAL_EMERGENCY_REPORT"
  }
}
```

### Trigger categories

| Category | Source signal | Severity | Default decision |
| --- | --- | --- | --- |
| `hostiles` | `hostile_creep` or hostile text in alert reason | high | observe or owner action after live-room inspection |
| `owned_structure_damage` | owned damageable structure HP decreased | high; critical when critical storage/spawn/tower/terminal is at or below 25% HP | open issue or Codex hotfix |
| `owned_structure_disappearance` | previously observed critical owned structure disappeared | critical | Codex hotfix or rollback decision |
| `spawn_collapse` | spawn missing/destroyed/collapsed/no recovery signal | critical | Codex hotfix or owner action |
| `downgrade_risk` | controller downgrade signal | high; critical at 2000 ticks or less | owner action or Codex hotfix |
| `telemetry_silence` | `alert` payload has `ok:false`, runtime-summary silence, loop exception, or telemetry silence signal | critical | rollback or monitor fix |
| `runtime_exception` | loop/runtime exception signal | critical | Codex hotfix or rollback decision |
| `runtime_deadlock` | private-smoke stats exist but never reach owned-room/creep success criteria | critical | Codex hotfix or rollback decision |
| `resource_crisis` | runtime resource crisis signal | high | owner action or Codex hotfix |
| `private_smoke_failure` | private-smoke phase failure, upload/roundtrip failure, or unclassified smoke failure | high | main-agent triage |
| `monitor_integrity` | monitor miss/spam signal | high | monitor fix |
| `unknown_runtime_alert` | emitted alert reason that does not match a known category | high | main-agent triage |

### Tactical Emergency Report template

Use this shape when the bridge returns `"emergency": true`:

```text
Tactical Emergency Report
- Source: alert artifact path or scheduler run id
- Room/shard: <room>
- Severity/categories: <severity> / <categories>
- Evidence: alert JSON, image paths, recent runtime-summary lines, latest deploy SHA
- Decision: observe | open issue | Codex hotfix | rollback | owner action
- Gate: no-secret check, GitHub state current, Codex owns prod edits, verification complete, post-release monitor checked
- Next action: <single concrete owner/action>
```

### Main-agent decision matrix

| Bridge result | Main-agent action |
| --- | --- |
| `emergency:false`, `silent:true` | Scheduler wrapper returns exactly `[SILENT]`; no Discord alert is posted. |
| `severity:high`, category `hostiles` only | Inspect the live room and next alert check; open/update an incident only if the hostile persists, damage follows, or manual defense is required. |
| `severity:high`, structure or downgrade category | Open/update the incident issue when confirmed; choose Codex hotfix if bot behavior can change the outcome. |
| `severity:critical`, spawn/structure/downgrade category | Start the emergency hotfix gate or request owner action when live manual intervention is faster than code. |
| `severity:critical`, `telemetry_silence` | Restore telemetry first; rollback only when the latest deploy plausibly caused loop exceptions or runtime-summary silence. |
| `monitor_integrity` | Fix monitor/debounce/wrapper behavior; do not modify live cron configuration from this script. |

### No-secret guarantees

- The bridge reads alert JSON from stdin or `--input` and emits JSON only.
- It does not require `SCREEPS_AUTH_TOKEN` and does not call live APIs.
- It does not print raw auth headers or raw input. Copied messages are shortened and redacted for token/password/secret/header patterns and local secret-path patterns.
- It never schedules cron jobs and never sends Discord messages directly. The scheduler wrapper decides whether to post or return `[SILENT]` from the `scheduler` object.

### Scheduler and QA gate

PASS:

- `python3 scripts/screeps-runtime-monitor.py tactical-response` returns `emergency:false`, `silent:true`, and `scheduler.recommended_output:"[SILENT]"` for the no-alert dry run.
- The hostile dry run returns `emergency:true`, `severity:"high"`, `categories:["hostiles"]`, and non-empty `next_actions`.
- Offline verification passes: `python3 -m py_compile scripts/screeps-runtime-monitor.py scripts/test_screeps_runtime_monitor_tactical_response.py`, `python3 scripts/screeps-runtime-monitor.py self-test`, and `python3 -m unittest scripts/test_screeps_runtime_monitor_tactical_response.py`.
- `git diff --check` is clean.
- No cron files or live scheduler configuration changed.

REQUEST_CHANGES:

- No-alert JSON can trigger a Discord-visible alert instead of `[SILENT]`.
- Emergency output lacks severity, categories, or next actions.
- Tests require live Screeps credentials.
- Output includes tokens, auth headers, passwords, or local secret paths.
- The change creates or modifies cron jobs.

## Verification

Offline pure-function tests:

```bash
python3 scripts/screeps-runtime-monitor.py self-test
python3 -m unittest scripts/test_screeps_runtime_monitor_tactical_response.py
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
# Load SCREEPS_AUTH_TOKEN into the environment without printing it.
python3 scripts/screeps-runtime-monitor.py summary --room shardX/E26S49 --out-dir /root/screeps/runtime-artifacts/screeps-monitor-smoke
SCREEPS_MONITOR_STATE_FILE=/tmp/screeps-monitor-alert-smoke-state.json \
  python3 scripts/screeps-runtime-monitor.py alert --room shardX/E26S49 --out-dir /root/screeps/runtime-artifacts/screeps-monitor-smoke
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
