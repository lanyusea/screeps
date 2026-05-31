# Screeps RL Grafana Contract

This directory is the durable local Grafana contract for the RL flywheel metrics surface. It is separate from the Python dashboard-equivalent on `127.0.0.1:8765`.

## Files

| Path | Purpose |
| --- | --- |
| `screeps-rl-gameplay-metrics.json` | Starter Grafana dashboard for the SQLite RL metrics store. |
| `provisioning/datasources/screeps-rl-sqlite.yaml` | Grafana datasource provisioning for `runtime-artifacts/rl-metrics/rl_metrics.sqlite` through the `frser-sqlite-datasource` plugin. |
| `provisioning/dashboards/screeps-rl-dashboards.yaml` | Grafana dashboard provisioning for the tracked dashboard JSON. |

The datasource UID is `screeps-rl-metrics-sqlite`; the dashboard UID is `screeps-rl-gameplay-metrics`.

Dashboard targets must keep the frser SQLite fields `rawQueryText`, `queryType`, and, for time-series panels, `timeColumns: ["time"]`; the validator fails when those tracked fields drift.

## Local Run

Print the Docker command without starting Grafana:

```bash
npm run rl-grafana:print-command
```

Start or restore actual Grafana on `127.0.0.1:3000`:

```bash
npm run rl-grafana:run
```

The runner is durable by default: it creates a detached Docker container named `screeps-rl-grafana` with `--restart unless-stopped`, or starts the existing named container and refreshes its restart policy. The port binding remains loopback-only unless an operator explicitly passes the non-local override.

The default image is `grafana/grafana-oss:11.5.2`; pass `-- --image <image>` to the npm command if the operator intentionally validates a different Grafana image.

The runner mounts:

- `docs/ops/grafana/provisioning` at `/etc/grafana/provisioning`;
- `docs/ops/grafana` at `/var/lib/grafana/dashboards/screeps`;
- `runtime-artifacts/rl-metrics/rl_metrics.sqlite` at `/var/lib/grafana/rl-metrics/rl_metrics.sqlite`.

The container installs the `frser-sqlite-datasource` plugin through `GF_INSTALL_PLUGINS`. The host database file must exist before starting the container:

```text
runtime-artifacts/rl-metrics/rl_metrics.sqlite
```

Dashboard path after startup:

```text
http://127.0.0.1:3000/d/screeps-rl-gameplay-metrics/screeps-rl-gameplay-metrics
```

## Validation

Validate provisioning and dashboard JSON without requiring a running Grafana service:

```bash
npm run rl-grafana:validate:provisioning
```

Run the full contract check against local Grafana:

```bash
npm run rl-grafana:validate
```

If Grafana is absent, the full validator reports `NOT_RUNNING` instead of `PASS`. That result is intentional: static provisioning correctness is not actual Grafana service evidence.
