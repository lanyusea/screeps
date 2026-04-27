# Gameplay finding to Codex task bridge

This runbook converts accepted Gameplay Evolution Review findings into GitHub-tracked work that Codex can implement safely. It exists for issue #61 and is part of the Gameplay Evolution loop.

## Priority contract

When P0 automation health is clear, choose findings in this order:

1. **Territory/control** — owned rooms, reserved/remote rooms, room gain/loss, controller progress, downgrade risk.
2. **Resource/economy scale** — stored resources, harvest/collection deltas, spawn utilization, remote uptime, GCL/RCL deltas.
3. **Enemy kills/combat value** — hostile creeps/structures destroyed, own losses, net combat outcome.
4. **Foundation/ops** — only outranks the gameplay ordering when it blocks evidence, implementation, release, or rollback for one of the gameplay layers.

## Intake rule

A Gameplay Evolution finding is actionable only when it contains all of these fields. If any field is missing, update the existing issue or add a review comment asking the next worker to fill the gap before dispatching Codex.

```markdown
## Gameplay finding intake
- Evidence window:
- Shard / room:
- Code version / deployed commit:
- Served vision layer: territory | resources | enemy kills | foundation blocker
- KPI delta observed:
- Reliability guardrails observed:
- Hypothesis:
- Target area: prod | scripts | docs/ops | GitHub/Project | cron/runtime monitor
- Expected KPI movement:
- Acceptance evidence:
- Rollback / stop condition:
- No-secret considerations:
```

## Main-agent decision states

The main Hermes agent must classify each finding before work starts:

- **Accept** — create or update a GitHub issue and Project item, then dispatch the next bounded worker/Codex task.
- **Defer** — update Evidence and Next action with the missing prerequisite or later review window.
- **Reject** — add a concise issue/comment explanation when the finding is unsupported, lower priority, duplicated, or unsafe.
- **Escalate** — use the tactical emergency response path when the finding indicates room loss, attack, spawn collapse, controller downgrade risk, deploy breakage, or telemetry silence.

## Runtime KPI evidence feeder

Use the persisted-artifact bridge first when a Gameplay Evolution Review, roadmap snapshot, or accepted finding needs territory/resource/combat KPI evidence:

```bash
python3 scripts/screeps_runtime_kpi_artifact_bridge.py > runtime-kpi-report.json
```

If a worker has raw Screeps console output but no persisted artifact yet, capture exact in-game summary lines first:

```bash
python3 scripts/screeps_runtime_summary_console_capture.py saved-console.log
```

For a bounded live official-client console capture, load `SCREEPS_AUTH_TOKEN` from the local secret environment and run:

```bash
python3 scripts/screeps_runtime_summary_console_capture.py --live-official-console --live-timeout-seconds 20 --live-max-messages 50
```

The capture utility writes only lines starting exactly `#runtime-summary ` to `/root/screeps/runtime-artifacts/runtime-summary-console/` by default, or to paths set with `--out-dir`, `--out-file`, or `SCREEPS_RUNTIME_SUMMARY_CONSOLE_OUT_DIR`. `SCREEPS_API_URL` defaults to `https://screeps.com`; `SCREEPS_CONSOLE_CHANNELS` or repeated `--console-channel` values can override the default requested channel list, which includes `console`. Command output reports counts, output path, and requested channels without printing tokens, headers, or raw artifact contents.

With explicit review-window roots:

```bash
python3 scripts/screeps_runtime_kpi_artifact_bridge.py /path/to/runtime-artifacts /path/to/cron-output > runtime-kpi-report.json
```

The bridge scans files/directories for `#runtime-summary ` lines, skips binary and oversized files, tolerates missing default roots, and includes source metadata without artifact contents. Use `--format human` for quick review text.

If artifact discovery is unnecessary and a worker has a single raw saved console log, use the reducer fallback:

```bash
python3 scripts/screeps_runtime_kpi_reducer.py saved-runtime-summary.log > runtime-kpi-report.json
```

## GitHub source-of-truth update checklist

Before implementation begins:

1. Create a new issue or update the most specific existing issue.
2. Ensure the issue has a roadmap label, priority label, kind label, milestone, and Project `screeps` item.
3. Set Project fields:
   - `Status`: `In progress` when the current worker owns the next implementation slice; otherwise `Ready`.
   - `Priority`: `P0`, `P1`, or `P2`.
   - `Domain`: the owner of the result, not merely the file path.
   - `Kind`: `code`, `test`, `ops`, `docs`, `bug`, or `review`.
   - `Evidence`: the accepted finding, reviewed artifacts, and current repo/cron/PR state.
   - `Next action`: one bounded worker action.
   - `Blocked by`: only when the next action cannot be executed safely.
   - `Next-point %`: move only with verified evidence.
4. If implementation will create a PR, add the PR to Project `screeps` immediately after creation and keep it `In review` until merged or closed.

## Issue body template for accepted findings

```markdown
## Accepted Gameplay Evolution finding
- Evidence window:
- Served vision layer:
- KPI delta observed:
- Hypothesis:
- Expected KPI movement:
- Rollback / stop condition:

## Implementation target
- Scope:
- Files / subsystems expected:
- Codex required for `prod/`: yes/no
- Verification:

## Acceptance criteria
- [ ] GitHub issue and Project fields are current.
- [ ] Implementation preserves no-secret policy.
- [ ] If `prod/` changes, Codex authors the code commit and `npm run typecheck`, `npm test -- --runInBand`, and `npm run build` pass from `prod/`.
- [ ] PR is in Project `screeps` and passes the automated review gate.
- [ ] Runtime/private/monitor evidence is attached when release or gameplay KPI movement is claimed.
```

## Codex prompt template

Use this only after the issue is accepted and Project state is current. Keep it self-contained and bounded.

```text
Repository: /root/screeps-worktrees/<topic>
Branch: <branch>
Issue: #<number> <title>
Author commits as: lanyusea's bot <lanyusea@gmail.com>

Implement exactly this accepted Gameplay Evolution finding.

Served vision layer: <territory/resources/enemy kills/foundation blocker>
Evidence window: <time range and artifacts>
Current KPI delta: <observed delta or not instrumented>
Hypothesis: <why this change should improve the KPI>
Expected KPI movement: <specific observable movement>
Rollback / stop condition: <condition>

Scope:
- <files/subsystems>

Requirements:
- Production/test/build code under prod/ must be implemented by Codex in this worktree.
- Keep the change small and additive; do not remove existing telemetry or behavior unless the issue explicitly says so.
- Guard optional Screeps APIs/constants so Jest, private-server, and official contexts do not crash.
- Do not print, commit, or expose secrets.
- Update generated build artifacts only by running the proper build command.

Verification to run before committing:
- git diff --check
- cd prod && npm run typecheck
- cd prod && npm test -- --runInBand
- cd prod && npm run build

Commit the verified change before returning. Stage exactly the intended files and exclude transient `.codex`, runtime artifacts, logs, and local secret/config files.
```

## QA acceptance checklist

A finding-to-Codex task is not accepted until the main agent verifies:

- the issue and PR Project items have current `Status`, `Evidence`, and `Next action`;
- the implementation matches the accepted finding and does not expand into unrelated work;
- verification commands passed or failures are documented as blockers;
- no secret material appears in diffs, logs, PR bodies, issue comments, or final reports;
- PR gate state is checked: elapsed window, CI, CodeRabbit/Gemini comments, review threads, and mergeability;
- after merge, the linked issue/Project item is updated with merge evidence and the next review/monitor observation step.

## First application after PR #65

PR #65 landed the first additive in-game KPI telemetry bridge for #29/#61. The next accepted finding should be transformed with this runbook into one of these bounded tasks:

1. **#29 reducer/artifact feeder follow-up** — consume the new `controller`, `resources`, and `combat` runtime-summary fields so review reports and roadmap snapshots can show territory/resource/combat deltas instead of `not instrumented`. The preferred persisted-artifact feeder is:

   ```bash
   python3 scripts/screeps_runtime_kpi_artifact_bridge.py > runtime-kpi-report.json
   ```

2. **#61 bridge hardening** — convert the next 12-hour Gameplay Evolution recommendation into a concrete issue with expected KPI movement, acceptance evidence, and rollback/stop condition.
3. **#30/#31 bot-capability tests** — if the next worker slot is free before reducer work is ready, dispatch Codex to harden spawn lifecycle or emergency recovery coverage.
