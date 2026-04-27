# Finding-to-Codex bridge checkpoint

Date: 2026-04-27T11:08+08:00

## Context

P0 automation health was checked first. `/root/.hermes/cron/jobs.json` showed the Screeps continuation worker, P0 monitor, runtime summary, runtime alert, typed fanouts, six-hour report, and Gameplay Evolution Review enabled, using `workdir: null`, and scheduled with current `last_run_at` / `next_run_at` values. No open PRs were present, so the bounded slice selected #61 in support of #29.

## Change

Added `docs/ops/gameplay-finding-to-codex-bridge.md` as the durable bridge from accepted Gameplay Evolution findings to GitHub issue / Project state / Codex prompts.

The runbook defines:

- required finding intake fields;
- main-agent accept/defer/reject/escalate states;
- Project `screeps` source-of-truth update checklist;
- accepted-finding issue body template;
- bounded Codex prompt template for `prod/` work;
- QA acceptance checklist;
- first application after PR #65.

Updated `docs/ops/gameplay-evolution-roadmap.md`, `docs/ops/roadmap.md`, and `docs/process/active-work-state.md` so the next worker can use this bridge instead of reconstructing the #61 workflow from chat history.

## Verification

- `git diff --check`
- Markdown link/path existence check for the new runbook and updated references
- GitHub open PR/issue/Project inspection before editing
- Cron metadata inspection before editing

## Follow-up

Next #29 worker should consume the newly merged runtime-summary `controller`, `resources`, and `combat` fields in the runtime reducer/roadmap/reporting layer so territory/resource/combat deltas appear in review outputs instead of `not instrumented`.
