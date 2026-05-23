# RL Live Dashboard Runbook

Status: issue #1237 live observability surface for the #879 RL evidence loop. This supersedes the one-time #1184 local foundation without reopening it.

This repository keeps the Grafana JSON dashboard in `docs/ops/grafana/`, but the owner-facing operational surface is the dependency-light local live service. The static HTML artifact remains the roadmap fanout attachment surface. Neither path requires a Grafana SQLite plugin, external network access, or secrets.

## Operator Commands

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
http://127.0.0.1:8790/
```

Machine-readable summary:

```text
http://127.0.0.1:8790/api/summary
```

Health check:

```bash
npm run rl-dashboard-live:health
```

Equivalent direct check:

```bash
python3 scripts/screeps_rl_live_dashboard.py healthcheck --url http://127.0.0.1:8790/healthz
```

Expected healthy output includes JSON with `"ok": true` and `"message": "OK"`. The command checks the running local dashboard, so start `npm run rl-dashboard-live` first.

For a one-shot foreground start with an explicit cadence:

```bash
python3 scripts/screeps_rl_live_dashboard.py serve \
  --refresh-on-start \
  --auto-refresh-seconds 300
```

The live server precomputes and caches generated `/api/summary` and HTML summary data, invalidates that cache after each refresh, and bounds newest-artifact evidence scans. The standard local service therefore keeps health checks and summary reads fast while still refreshing SQLite on start and every 300 seconds while running.

Trigger a local refresh through the running service only after starting it with `--enable-refresh-endpoint`:

```bash
curl -fsS -X POST http://127.0.0.1:8790/refresh
```

## Dashboard Coverage

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

Owner evidence for #879 can be copied from `/api/summary`:

```text
dashboardUrl
db.path
db.latestObservedAt
db.tables
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

Roadmap fanout job `92ca290f7996` must run this static command before rendering/sending the roadmap update and attach the generated HTML artifact together with the roadmap image.

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
