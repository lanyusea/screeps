# Runtime KPI reducer checkpoint

Date: 2026-04-27

## Context

PR #65 added additive `#runtime-summary` fields for room controller, resource, and combat state. Issue #29 needed the next bridge slice to consume those fields from saved logs so Gameplay Evolution reviews can show territory/resource/combat evidence instead of `not instrumented`.

## Change

Added `scripts/screeps_runtime_kpi_reducer.py` and deterministic local tests. The reducer reads one or more saved log files and/or stdin, ignores non-summary lines and malformed prefixed JSON safely, and emits deterministic JSON by default.

It aggregates:

- owned-room latest count plus gained/lost room delta;
- per-room controller RCL, progress, progress total, and ticks-to-downgrade latest values plus numeric deltas;
- resource latest stored energy, worker-carried energy, dropped energy, source count, and harvest/transfer event deltas;
- combat latest hostile creep/structure counts and attack/destroyed event deltas.

Missing KPI sections are explicitly marked `not instrumented`; absent event samples are marked `not observed`.

## Reviewer command

```bash
python3 scripts/screeps_runtime_kpi_reducer.py saved-runtime-summary.log > runtime-kpi-report.json
```

Use `-` for stdin and `--format human` for a compact text view. This command uses only saved logs; it does not call Screeps, Discord, or GitHub APIs.

## Verification

- `python3 -m py_compile scripts/screeps_runtime_kpi_reducer.py scripts/test_screeps_runtime_kpi_reducer.py`
- `python3 -m unittest scripts/test_screeps_runtime_kpi_reducer.py`
- `git diff --check`

## Follow-up

The next renderer/reporting worker can feed `runtime-kpi-report.json` into Gameplay Evolution review output or a KPI board without re-parsing raw console logs.
