# KPI persistence wiring checkpoint

Date: 2026-04-27

## Slice summary

This bounded continuation slice selected issue #29 because P0 cron/monitor health was current, no open pull requests needed draining, and the highest active game-vision blocker is still territory/resource/combat KPI visibility for Gameplay Evolution and roadmap reporting.

PRs #65, #67, #68, and #70 are now merged on `main`, so the in-game runtime KPI payload, reducer, persisted-artifact bridge, and static Pages report generator all exist. The remaining #29 gap is not another reducer/report page primitive; it is capturing real in-game `#runtime-summary ` console lines into persisted artifacts that the bridge can reduce.

## Evidence reviewed

- `/root/screeps` was clean on `main` at `c21f1bb` (`feat: add Codex-authored Pages roadmap report (#70)`).
- `gh pr list --repo lanyusea/screeps --state open` returned no open PRs.
- Project `screeps` still had #29 and #59 `In progress`; #28/#30/#31/#62/#63 were Ready queued or blocked as expected.
- `/root/.hermes/cron/jobs.json` showed the continuation worker, P0 monitor, runtime summary, runtime alert, typed fanouts, 6h report, and Gameplay Evolution Review enabled with `workdir: null` and recent `last_run_at` / non-overdue `next_run_at` values.
- Default artifact bridge scan returned zero persisted runtime-summary lines:

```text
source: scanned 71528 file(s), matched 0, runtime-summary lines 0, skipped 1643
runtime summaries: 0 (ignored 0, malformed 0)
ticks: unknown..unknown
territory: not instrumented
controllers: not instrumented
resources: not instrumented
combat: not instrumented
```

- A dry Pages generator run succeeded and wrote `/tmp/screeps-pages-check/index.html`, `/tmp/screeps-pages-check/roadmap-data.json`, and `/tmp/screeps-roadmap-kpi-check.sqlite`, but the KPI rows remained mostly uninstrumented because no real runtime-summary lines were available. `enemy_kills` correctly remained `NULL`, `instrumented=0`, and source `future ownership-aware combat reducer`.

## Exact next Codex prompt

Use this prompt for the next #29 implementation slice if it touches runtime-monitor/reporting scripts. Keep it in a worktree and preserve the Codex author boundary for implementation code.

```text
Read AGENTS.md and docs/ops/codex-skills.md. Use Skill 4 (Screeps operations/documentation updates) and Skill 5 (Worktree and PR hygiene). Keep the change minimal and task-scoped.

Task: implement the next #29 persisted KPI evidence bridge. The current reducer/page stack exists, but a default scan finds zero real `#runtime-summary ` lines. Add a safe, testable artifact persistence path that captures real in-game Screeps console summary lines into ignored local artifacts so `scripts/screeps_runtime_kpi_artifact_bridge.py` and `scripts/generate-roadmap-page.py` can consume territory/resource/combat KPI evidence.

Context:
- Repo: /root/screeps (run in a topic worktree, not main).
- Official target selectors from AGENTS.md: branch main, shard shardX, room E48S28. Do not print tokens or module contents.
- Existing scripts:
  - scripts/screeps-runtime-monitor.py handles official room summary/alert images.
  - scripts/screeps_runtime_kpi_reducer.py reduces saved `#runtime-summary ` lines.
  - scripts/screeps_runtime_kpi_artifact_bridge.py scans `/root/screeps/runtime-artifacts` and `/root/.hermes/cron/output` for lines that start exactly with `#runtime-summary `.
  - scripts/generate-roadmap-page.py already invokes the artifact bridge and writes KPI rows.
- Current evidence: default bridge scan found 0 matched files / 0 runtime-summary lines, so Pages/Gameplay Evolution still report territory/resource/combat as not instrumented despite merged telemetry/reducer infrastructure.

Requirements:
1. Investigate the smallest safe persistence point. Prefer extending an existing script/wrapper over creating a broad new service.
2. Add deterministic tests for any parser/persistence function. Tests must not require network or secrets.
3. Persist only lines starting exactly `#runtime-summary `; skip embedded/quoted/noisy markers; preserve no secrets.
4. Output artifacts under an ignored local path such as `runtime-artifacts/runtime-summary-console/` by default, with CLI flags/env vars for input/output paths where useful.
5. Do not create or schedule cron jobs in this implementation. The next Hermes worker will update live job prompts after the PR is merged.
6. If live official console capture requires a token/websocket endpoint and is too large for this slice, implement the offline/CLI persistence primitive plus docs/runbook instructions, and clearly report the remaining live wiring step.
7. Update relevant docs/process/runbook text so #29's next action is unambiguous.
8. Run verification before committing:
   - git diff --check
   - python3 -m py_compile scripts/screeps_runtime_kpi_reducer.py scripts/screeps_runtime_kpi_artifact_bridge.py scripts/generate-roadmap-page.py and any new/changed script/tests
   - python3 -m unittest scripts/test_screeps_runtime_kpi_reducer.py scripts/test_screeps_runtime_kpi_artifact_bridge.py and any new tests
   - python3 scripts/generate-roadmap-page.py --repo . --docs-dir /tmp/screeps-pages-check --db /tmp/screeps-roadmap-kpi-check.sqlite
   - verify no WAL/SHM sidecars exist for the temp DB
9. Commit the verified change with author `lanyusea's bot <lanyusea@gmail.com>` and a conventional commit message. Stage only intended files; exclude `runtime-artifacts/`, `.codex`, `__pycache__`, and temporary generated files.
```

## Next worker gate

The next worker should not spend the slice on another static report/reducer layer unless it first proves a real persisted `#runtime-summary ` source exists. If no source exists, run the Codex prompt above or create a narrower Codex issue/PR for the persistence primitive.
