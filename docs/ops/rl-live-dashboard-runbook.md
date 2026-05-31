# RL Live Dashboard Runbook

Status: issue #1474 real-Grafana contract for the #879 RL evidence loop. This supersedes the one-time #1184 local foundation and the closed #1237/#1381/#1388/#1464 chain without reopening those issues.

This runbook has two explicitly separate surfaces:

- Actual Grafana: a Grafana service on `127.0.0.1:3000`, provisioned from `docs/ops/grafana/`, using the `frser-sqlite-datasource` plugin against `runtime-artifacts/rl-metrics/rl_metrics.sqlite`. This is the #1474 selected self-actionable contract.
- Python dashboard-equivalent: the dependency-light local live service on `127.0.0.1:8765`. It remains a fallback/supporting surface and does not satisfy actual Grafana acceptance by itself.

The canonical roadmap surface is GitHub Pages at https://lanyusea.github.io/screeps/; the static HTML artifact is supporting evidence, not a Discord roadmap attachment.

## Actual Grafana Operator Commands

Provisioning files:

```text
docs/ops/grafana/provisioning/datasources/screeps-rl-sqlite.yaml
docs/ops/grafana/provisioning/dashboards/screeps-rl-dashboards.yaml
docs/ops/grafana/screeps-rl-gameplay-metrics.json
```

The tracked dashboard JSON includes the frser SQLite target metadata required for rendered panels: `rawQueryText` mirrors `queryText`, every target declares `queryType`, and time-series targets declare `timeColumns: ["time"]`.

The Grafana SQLite datasource plugin is required:

```text
frser-sqlite-datasource
```

Print the Docker command without starting a container:

```bash
npm run rl-grafana:print-command
```

Start or restore actual Grafana locally:

```bash
npm run rl-grafana:run
```

This command is the durable local supervisor path. It uses a detached Docker container named `screeps-rl-grafana` with Docker restart policy `unless-stopped`; rerunning it starts the existing named container if it is present but stopped. The exposed port remains bound to `127.0.0.1` by default and must not be changed to a non-local address without explicit owner approval.

Default Grafana URL:

```text
http://127.0.0.1:3000/
```

Dashboard path:

```text
http://127.0.0.1:3000/d/screeps-rl-gameplay-metrics/screeps-rl-gameplay-metrics
```

Validate tracked provisioning and dashboard JSON without requiring Docker/Grafana:

```bash
npm run rl-grafana:validate:provisioning
```

Validate the live Grafana service, datasource, and dashboard reachability:

```bash
npm run rl-grafana:validate
```

When no Grafana service is listening, the full validator reports `NOT_RUNNING`; that is not a passing acceptance result. Actual Grafana acceptance requires `npm run rl-grafana:validate` to report `PASS` against a service on `127.0.0.1:3000`.

## Python Dashboard-Equivalent Operator Commands

Metrics database:

```text
runtime-artifacts/rl-metrics/rl_metrics.sqlite
```

Refresh the SQLite store through the bounded live-dashboard refresh wrapper:

```bash
npm run rl-metrics-refresh
```

The npm refresh command uses the live-dashboard bounded refresh path. With no explicit paths it ingests the newest files from each default runtime/RL source root so a large artifact corpus cannot make routine dashboard refresh unbounded. For full one-off audits, run the ingestor directly with explicit paths:

```bash
python3 scripts/screeps_rl_metrics_ingestor.py ingest-artifacts \
  runtime-artifacts/runtime-summary-console \
  runtime-artifacts/rl-dataset-gates \
  runtime-artifacts/rl-control-loop \
  runtime-artifacts/rl-training
```

Start the live dashboard. The npm command refreshes once before serving and then refreshes SQLite every 300 seconds while the process is running:

```bash
npm run rl-dashboard-live
```

Default dashboard URL:

```text
http://127.0.0.1:8765/
```

Machine-readable summary:

```text
http://127.0.0.1:8765/api/summary
```

Health check:

```bash
npm run rl-dashboard-live:health
```

Equivalent direct check:

```bash
python3 scripts/screeps_rl_live_dashboard.py healthcheck --url http://127.0.0.1:8765/healthz
```

Expected healthy output includes JSON with `"ok": true` and `"message": "OK"`. During startup refresh the service should still answer `/healthz` with a degraded JSON payload instead of refusing the connection. The command checks the running local dashboard, so start `npm run rl-dashboard-live` first.

Run the task-level live acceptance guard before claiming the owner-facing surface is Done:

```bash
npm run rl-dashboard-live:acceptance
```

Equivalent direct check:

```bash
python3 scripts/screeps_rl_live_dashboard.py acceptance --url http://127.0.0.1:8765/
```

The acceptance command must PASS against the running service. It retries while startup refresh is explicitly in progress, then checks `/healthz` and `/api/summary`, requires `dashboardUrl`, `db.path`, SQLite table counts and `db.latestObservedAt`, `refresh.lastRefreshOk=true`, `refresh.lastRefreshAt`, and visible E1 gate, Loop A, Loop B, Tencent utilization, scorecard, safety, and Project gate sections. If the service is not listening, it fails with a clear `live dashboard service is not running/reachable` message.

For a one-shot foreground start with an explicit cadence:

```bash
python3 scripts/screeps_rl_live_dashboard.py serve \
  --refresh-on-start \
  --auto-refresh-seconds 300
```

The live server precomputes and caches generated `/api/summary` and HTML summary data, preserves the last usable summary only while a refresh is in progress, rebuilds a fresh primed summary from the refreshed SQLite/artifacts after each successful refresh, and invalidates stale or in-progress cache data if that post-refresh rebuild fails. The default summary inspects the newest 25 files per targeted source group and exposes truncation metadata in `artifactEvidenceScan` plus `tencentBatch.truncated`, so capped scans are visible instead of silent. The standard local service therefore keeps health checks and summary reads fast while still refreshing SQLite on start and every 300 seconds while running.

Trigger a local refresh through the running service only after starting it with `--enable-refresh-endpoint`:

```bash
curl -fsS -X POST http://127.0.0.1:8765/refresh
```

## Python Dashboard-Equivalent Coverage

The live page and `/api/summary` cover:

| Area | Source |
| --- | --- |
| E1 gate acceptance | Latest dataset gate artifact discovered by `scripts/screeps_rl_dashboard.py`. |
| Loop A env/ticks/episodes | Simulator run summaries or training-ledger aggregate fields. |
| Loop B online utility | Policy online advantage ledger status and candidate/baseline fields. |
| Loop B scorecard | Latest `runtime-artifacts/rl-control-loop/scorecards/*.json`. |
| Tencent batch utilization | Latest controller summaries under `runtime-artifacts/tencent-cloud/batch-runs/`. |
| Safety flags | Tencent run safety flags, required scorecard evidence, scorecard safety regressions, and card-supply status. |
| SQLite freshness | Required table presence, row counts, and latest observation timestamp from `rl_metrics.sqlite`. |
| #879 flywheel stages | Explicit construction-landed, training-running, online-proven, and self-iterating states. |
| Project gates | Local evidence status for #879, #1032, #1229, #1233, and #1234. |
| #924 scorecard | Latest scorecard status, required actions, missing evidence, safety regressions, candidate, and baseline. |

Owner evidence for #879 can be copied from `/api/summary` and from `npm run rl-dashboard-live:acceptance` PASS output:

```text
dashboardUrl
db.path
db.latestObservedAt
db.tables
refresh.lastRefreshOk
refresh.lastRefreshAt
```

The same fields are visible on the HTML dashboard under Metrics Store and SQLite Table Counts.

The static HTML dashboard remains available through:

```bash
npm run rl-dashboard
```

That writes:

```text
runtime-artifacts/rl-dashboard.html
```

Use this static command when refreshing local RL evidence for the GitHub Pages roadmap. Do not schedule or attach a Discord roadmap update for this artifact.

## Actual Grafana Coverage And #879 Evidence

The actual Grafana dashboard is provisioned from `docs/ops/grafana/screeps-rl-gameplay-metrics.json` and is grounded in the SQLite tables created by `scripts/screeps_rl_metrics_ingestor.py`. Its starter panels cover:

| Area | SQLite table/query source |
| --- | --- |
| Runtime metric history and refresh proof | `metric_observations`, including `source.rl_metrics_refresh.completed`. |
| Room economy, construction, pathing, and worker efficiency | `runtime_room_metrics`. |
| Gameplay findings | `gameplay_behavior_findings`. |
| Coverage gaps | `metric_coverage_gaps`. |
| E1 dataset gates | `rl_dataset_gate_metrics`. |
| Loop A training execution | `rl_training_execution_metrics`. |
| Loop B policy advantage | `rl_policy_advantage_metrics`. |
| #879 iteration decisions | `metric_iteration_decisions`. |

#879 evidence is honest only when it states which surface was checked:

- Python fallback evidence: `http://127.0.0.1:8765/`, `/api/summary`, `/healthz`, and `npm run rl-dashboard-live:acceptance`.
- Actual Grafana evidence: `http://127.0.0.1:3000/`, the dashboard path, `frser-sqlite-datasource` provisioning, `runtime-artifacts/rl-metrics/rl_metrics.sqlite` datasource path, and `npm run rl-grafana:validate` `PASS`.

A Python dashboard-equivalent health or acceptance PASS must not be described as actual Grafana service/panel evidence.


## Historical #1381 Closure Gate

Issue #1381 was a false-completion repair for closed #1184/#1237/#1350. Keep this as a historical guardrail only; #1474 work must not reopen #1381 or the closed predecessor chain. Do **not** close it on a code merge, a runbook update, `npm run rl-metrics-refresh`, static HTML generation, or SQLite file existence alone. Closure required all of the following live evidence in #879/#1381 Project Evidence:

1. A running dashboard process/listener at the owner-facing URL (`http://127.0.0.1:8765/` by default).
2. `npm run rl-dashboard-live:health` output showing `/healthz` with `ok=true`.
3. `npm run rl-dashboard-live:acceptance` output with `ok=true` / `message=PASS`.
4. `/api/summary` evidence including `dashboardUrl`, `db.path`, `db.tables`, `db.latestObservedAt`, `refresh.lastRefreshOk=true`, and `refresh.lastRefreshAt`.
5. Visible dashboard/API sections for E1 gate, Loop A, Loop B, Tencent utilization, scorecard, safety, and Project gates.
6. The #879 Project item Evidence and Next action fields updated with the health/acceptance timestamp, DB counts/freshness, and remaining RL flywheel blocker if any.

A one-time foreground proof is acceptable for local QA, but durable owner-facing operation must include an explicit process owner/launch recipe or service handoff before the work is considered operationally complete.

### Optional persistent launch recipe

Do not install this automatically from the repo. If the owner approves a user service, use this as the operator-managed template:

```ini
[Unit]
Description=Screeps RL live dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/screeps
ExecStart=/usr/bin/npm run rl-dashboard-live
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

After starting any persistent service, rerun both health and acceptance commands and record the exact output in Project Evidence.

## Health Semantics

`/healthz` returns HTTP 200 only when:

- `runtime-artifacts/rl-metrics/rl_metrics.sqlite` exists;
- all required ingestor tables exist;
- SQLite can be opened and queried.
- when the service is in auto-refresh mode, at least one successful refresh has completed.

It returns HTTP 503 with JSON failure details when the database is missing, unreadable, or schema-incomplete. Missing E1/Loop A/Loop B/Tencent evidence is shown as dashboard data quality rather than process health, because the server can be healthy while the RL pipeline is blocked.

## Failure Modes

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| `/healthz` reports `metrics database missing` | Ingestor has not been run in this worktree. | Run `npm run rl-metrics-refresh` or restart with `--refresh-on-start`. |
| `/healthz` reports schema incomplete | Old or corrupt `rl_metrics.sqlite`. | Move the stale DB aside and run `npm run rl-metrics-refresh`. |
| E1 gate is `N/A` or `BLOCKED` | No current gate artifact under `runtime-artifacts/rl-dataset-gates` or `rl-control-loop`. | Re-run the shadow-eval/gate producer and refresh metrics. |
| Loop A env/ticks/episodes are missing | No simulator run summaries and no training ledger aggregate. | Re-run the training execution ledger or simulator harness, then refresh. |
| Loop B online utility is `N/A` or `UNPROVEN` | Policy advantage ledger has not proven candidate utility. | Re-run the policy online advantage ledger after fresh Loop A evidence. |
| Scorecard is `N/A` | No scorecard JSON has been generated. | Run the scorecard producer for the candidate/baseline bundle. |
| Tencent latest run is active or scale-down is false | Controller summary was partial or did not record final cleanup. | Inspect the latest `controller-summary.json` and verify ASG desired capacity outside this dashboard. |
| Safety status is `BLOCKED` | Tencent controller evidence or scorecard evidence is missing, a Tencent safety flag was not false, or scorecard safety regressions exist. | Treat as a rollout blocker; inspect the listed unsafe flag before generating new training evidence. |
