# P0 Visibility Repair — 2026-04-26

## Trigger

The owner reported that all Screeps project updates had become invisible across Discord channels. This was treated as a P0 agent-operating-system incident, above normal feature development.

## Impact

- Typed channels appeared stale even while work was still active.
- `#task-queue` did not receive a timely continuation final report because the continuation worker had a long-running non-final session.
- `#dev-log` and `#research-notes` fanout reporters returned `[SILENT]` because they only considered finalized continuation output and did not inspect the active continuation session.
- Runtime summary/alert jobs had stale `next_run_at` / last-run evidence during the incident, which made owner-visible runtime confidence worse.

## Evidence

Audit time: `2026-04-26T14:30+08:00`.

Key live findings:

- `Screeps autonomous continuation worker` (`f66ed36d7be0`) was enabled and targeted `discord:#task-queue`, but latest finalized output was `2026-04-26_12-44-29.md` while a newer session `session_cron_f66ed36d7be0_20260426_132642.json` was still non-final and had `last_updated` around `14:31`.
- The active continuation session was doing real work on PR #16 (`fix/private-smoke-steam-key-perms-20260426`): HTTP CLI path, live private-server smoke rerun, permission hardening, and verification.
- `Screeps dev-log fanout reporter` and `Screeps research-notes fanout reporter` last returned `[SILENT]`, because they did not treat the active non-final continuation session as reportable work.
- `Screeps runtime room summary images` last visible final output before manual repair was from `11:56`, despite a 60-minute cadence.
- `Screeps runtime room alert image check` returned `[SILENT]` for no-alert, which is correct in steady state, but during a visibility incident it needed an explicit manual delivery check.

## Immediate repairs performed

1. Sent a P0 manual incident notice to `#task-queue`.
2. Sent current-state/manual recovery reports to:
   - `#agent-monitor`
   - `#dev-log`
   - `#research-notes`
   - `#roadmap`
   - `#decisions`
   - `#runtime-summary`
   - `#runtime-alerts`
3. Ran a live runtime monitor manual check without printing secrets:
   - Summary: `shardX/E48S28`, tick `119721`, `3` creeps, `2` structures, `0` hostiles, `8` objects.
   - Alert: `alert=false`, no warnings, no suppressed alert.
   - Rendered image: `/root/screeps/runtime-artifacts/manual-p0-visibility-20260426/summary-shardX-E48S28.png`.
4. Updated the live continuation worker prompt so future slices are bounded and must final-report visible checkpoints instead of silently running for hours.
5. Updated the live dev-log and research-notes fanout reporter prompts so they inspect active continuation session JSON files and report in-progress work instead of returning `[SILENT]` only because finalized output has not landed.
6. Updated the live P0 monitor prompt so it may repair/resume/trigger stale scheduled jobs and reports ACTIVE-LONG-RUN status when a non-final but fresh continuation session exists.
7. Removed `workdir=/root/screeps` from scheduled Screeps cron jobs (continuation worker, P0 monitor, runtime summary/alert, dev-log, research-notes, roadmap, 6h report, and 4h checkpoint) so no due workdir job can serialize the whole cron tick ahead of reporting. Prompts use absolute `/root/screeps` paths instead.
8. Preserved PR #16 state by committing and pushing the docs-only follow-up `46c68f8 docs: record smoke harness permission hardening` after Codex-authored code commit `28677d6 fix: harden smoke harness file permissions`.

## Root cause

The system had a design gap between autonomous long-running work and typed-channel visibility:

- The continuation worker only delivered final responses.
- Fanout reporters depended mainly on finalized continuation output/state files.
- A long active session could update tool outputs and PR state for a long time without producing a final response.
- Reporters then saw no finalized delta and returned `[SILENT]`, hiding real progress from Discord.

This was not a single delivery-target typo; it was a routing/observability contract bug.

## Durable rule change

For Screeps scheduled work, a report is required whenever a task is active and visible state changed, even if the underlying implementation slice has not finalized.

Specifically:

- Continuation worker slices must be bounded and checkpoint visibly before long debug/private-server work continues.
- `#dev-log` and `#research-notes` reporters must inspect active session JSON (`~/.hermes/sessions/session_cron_f66ed36d7be0_*.json`) in addition to finalized cron outputs.
- P0 monitor must distinguish `ACTIVE-LONG-RUN` from stopped/failed, but it must still report it because owner visibility is degraded until the long run finalizes.
- Scheduled Screeps cron jobs must not share a serialized `/root/screeps` cron workdir. Use absolute paths in prompts and leave job `workdir` unset unless repository context injection is strictly required and the job is known not to block reporting.
- `[SILENT]` is valid only when there is truly no new finalized or active-session information relevant to that channel.

## Follow-up checks

- Re-list cron jobs after prompt updates and verify all expected delivery targets remain correct.
- Run/observe dev-log and research-notes fanout after the prompt update.
- Continue PR #16 review/merge gate after CodeRabbit finishes; do not let it stay open without visible checkpoints.
- Merge this documentation through PR rather than direct `main` commit, per project rules.
