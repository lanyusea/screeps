# RL Live Dashboard Runbook

Status: issue #1184 live observability surface for the #879 RL evidence loop.

This repository keeps the Grafana JSON dashboard in `docs/ops/grafana/`, but the checked-in live surface is a dependency-light local service so it does not require a Grafana SQLite plugin, external network access, or secrets.

## Operator Commands

Metrics database:

```text
runtime-artifacts/rl-metrics/rl_metrics.sqlite
```

Refresh the SQLite store with the existing ingestor:

```bash
npm run rl-metrics-refresh
```

Start the live dashboard and refresh once before serving:

```bash
npm run rl-dashboard-live -- --refresh-on-start
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

Trigger a local refresh through the running service:

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
| Safety flags | Tencent run safety flags, scorecard safety regressions, and card-supply status. |
| SQLite freshness | Required table presence, row counts, and latest observation timestamp from `rl_metrics.sqlite`. |

The static HTML dashboard remains available through:

```bash
npm run rl-dashboard
```

That writes:

```text
runtime-artifacts/rl-dashboard.html
```

## Health Semantics

`/healthz` returns HTTP 200 only when:

- `runtime-artifacts/rl-metrics/rl_metrics.sqlite` exists;
- all required ingestor tables exist;
- SQLite can be opened and queried.

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
| Safety status is `BLOCKED` | A Tencent safety flag was not false or scorecard safety regressions exist. | Treat as a rollout blocker; inspect the listed unsafe flag before generating new training evidence. |
