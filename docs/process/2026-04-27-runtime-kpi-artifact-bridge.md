# Runtime KPI artifact bridge checkpoint

Date: 2026-04-27

## Slice

Added a bounded persisted-artifact feeder for issue #29:

```bash
python3 scripts/screeps_runtime_kpi_artifact_bridge.py > runtime-kpi-report.json
```

The bridge scans local artifact roots for `#runtime-summary ` lines, defaults to `/root/screeps/runtime-artifacts` and `/root/.hermes/cron/output`, tolerates missing directories, skips binary and oversized files, and feeds only discovered summary lines into `scripts/screeps_runtime_kpi_reducer.py`.

It emits deterministic JSON by default with reducer KPI output plus source metadata: input paths, scanned file count, matched file count, runtime-summary line count, and skipped file paths/reasons. `--format human` emits a short reviewer-facing summary. No live APIs, secrets, cron changes, or `prod/` files are involved.

## Served vision layer

Foundation blocker for the Gameplay Evolution loop. This makes territory, resource, and combat KPI evidence available from persisted runtime artifacts before the 12-hour review and roadmap/reporting jobs are wired to consume it.

## Verification

```bash
git diff --check
python3 -m py_compile scripts/screeps_runtime_kpi_reducer.py scripts/screeps_runtime_kpi_artifact_bridge.py scripts/test_screeps_runtime_kpi_reducer.py scripts/test_screeps_runtime_kpi_artifact_bridge.py
python3 -m unittest scripts/test_screeps_runtime_kpi_reducer.py scripts/test_screeps_runtime_kpi_artifact_bridge.py
```

## Remaining next step

First feed real console output into `scripts/screeps_runtime_summary_console_capture.py` so `/root/screeps/runtime-artifacts/runtime-summary-console/` contains nonzero exact-prefix `#runtime-summary ` lines. After `python3 scripts/screeps_runtime_kpi_artifact_bridge.py --format human` proves the persisted source is live, wire the bridge command into the 12h Gameplay Evolution Review prompt and roadmap KPI snapshot job prompts in a later scheduler-management slice. Do not create or schedule cron jobs in this bridge slice.
