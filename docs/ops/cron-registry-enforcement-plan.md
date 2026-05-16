# Cron Registry Enforcement and Cron Optimization Plan

Tracking issue: https://github.com/lanyusea/screeps/issues/1122
Owner decision: 2026-05-16 — keep the cron registry as **方案 1**, an enforced expected-state contract.

## Goal

Make Screeps/Hermes cron operation auditable, recoverable, and self-checking. The registry must not be passive prose. It must define the expected recurring cron surface, and live monitors/schedulers must compare live `cronjob list` / `~/.hermes/cron/jobs.json` against that expected state.

## Scope

This plan covers all current Screeps/Hermes cron optimization goals:

1. **Expected-state baseline** — keep `docs/ops/cron-and-route-registry.md` as the durable contract for expected recurring jobs, delivery routes, cadence, model/provider, repeat policy, and workdir.
2. **Machine verification** — provide a script that compares the registry against live Hermes cron metadata.
3. **Prompt/monitor enforcement** — P0 monitor and scheduler must use the registry diff before declaring cron health or dispatching non-urgent work.
4. **Backup and rollback** — every live cron mutation requires a pre-change snapshot of `~/.hermes/cron/jobs.json`, relevant docs, and git state.
5. **Safe maintenance** — pause only the jobs that can race with the migration or prompt updates, and always mirror the pause in GitHub Project Evidence / Next action.
6. **Drift cleanup** — remove stale one-shot/debug jobs; classify local/system jobs explicitly instead of letting them look like unexpected drift.
7. **Cadence and route sanity** — preserve urgent alert cadence; keep summary/report/ledger jobs staggered; do not merge jobs with different urgency or delivery contracts.
8. **Provider/model correctness** — registry must state provider+model together, because cron creation can otherwise pin incompatible providers.
9. **Workdir serialization hygiene** — only jobs that need repo context should use `/root/screeps` workdir; simple local/script jobs should avoid unnecessary repo workdir serialization.
10. **Final acceptance** — after changes, live cron metadata must match registry, high-risk jobs must be resumed, and at least one post-change monitor/scheduler validation signal must be recorded.

## Non-goals

- No production Screeps bot behavior change under `prod/`.
- No secrets, auth tokens, or private env contents in docs, comments, logs, or committed files.
- No broad consolidation of alert + summary jobs; urgency and delivery semantics stay separate.
- No recursive cron creation from a cron-run session.

## Source-of-truth hierarchy

| Layer | Role |
| --- | --- |
| GitHub Issues / Project `screeps` | Source of truth for task state, blockers, evidence, and next action. |
| Live Hermes cron metadata | Source of truth for what is currently scheduled/enabled/running. |
| `docs/ops/cron-and-route-registry.md` | Expected-state contract for recurring jobs/routes/cadence. |
| `scripts/check_cron_registry.py` | Machine diff between live state and expected contract. |
| Old cron outputs / reporter state files | Historical cache only; never authoritative. |

## Phase plan

### Phase 0 — Safety snapshot and claim

1. Refresh current time, git status, open PRs, active OS processes, and live cron metadata.
2. Claim #1122 in Project `screeps` as `In progress` with exact Evidence / Next action.
3. Create rollback snapshot containing:
   - `~/.hermes/cron/jobs.json`
   - `docs/ops/cron-and-route-registry.md`
   - `docs/ops/agent-operating-system.md`
   - `docs/ops/rules-registry.md`
   - `AGENTS.md`
   - safe cron metadata without prompt bodies
   - git HEAD/status/worktree list
4. Run the private Hermes state backup, verify the backup repo is clean and pushed.
5. Only after backup, pause high-risk orchestrators that can race with the migration.

Current Phase 0 evidence for this run:

- Local snapshot: `/root/.hermes/backups/screeps-cron-registry-20260516T041847Z/`
- `jobs.json` snapshot SHA256: `6efea5855e2505966967aa881e0a8c830e279ab5a566ec166779d184142f8dca`
- Hermes-state backup commit: `b8a242c`
- Paused during migration: `f66ed36d7be0`, `75cedbb77150`

### Phase 1 — Registry normalization

1. Replace passive “Active cron jobs” prose with an expected recurring job contract.
2. Include every current always-on recurring job:
   - continuation/scheduler
   - P0 monitor
   - runtime summary/alert
   - typed fanouts/reports
   - gameplay review + archive
   - RL steward and ledgers
   - owner-decision fanout
   - console capture
   - Hermes state backup
3. Put one-shot/transient jobs in an explicit transient/retired section, not the recurring contract.
4. Define repeat policy as `forever`, `high-horizon`, or `once` instead of copying the live consumed-count string.
5. Define workdir expectations explicitly: `/root/screeps` only where repo context/serialization is needed; `-` where no workdir should be required.

### Phase 2 — Machine verification

1. Add `scripts/check_cron_registry.py`.
2. Default behavior prints a safe summary and exits 0 so it can be used as cron context.
3. `--strict` exits nonzero on drift and is used for acceptance checks.
4. Detect at least:
   - expected job missing
   - unexpected live job
   - disabled/paused expected job
   - schedule mismatch
   - delivery mismatch
   - provider/model mismatch
   - workdir mismatch
   - repeat policy mismatch
5. Store the command in docs and require P0 monitor/scheduler to consult it.

### Phase 3 — Live cron cleanup and prompt/context enforcement

1. Remove stale one-shot jobs only after rollback snapshot exists.
2. Attach or require registry-diff context for the P0 monitor and scheduler.
3. Preserve canonical cadence unless there is a separate owner decision:
   - runtime alert: frequent and silent on no-alert
   - runtime summary: hourly visual/report
   - continuation worker: bounded dispatcher cadence
   - RL ledgers: 6h staggered cadence
4. Re-run `cronjob list` after every live cron mutation.
5. Update Project Evidence / Next action with the mutation and rollback path.

### Phase 4 — Validation

Acceptance requires all of these:

1. `python3 scripts/check_cron_registry.py --strict` passes against live `~/.hermes/cron/jobs.json`.
2. High-risk paused jobs are resumed and show `enabled=true`, `state=scheduled`, future `next_run_at`, and no delivery error.
3. No stale one-shot/debug cron remains unless explicitly listed as active transient with expiry and tracking issue.
4. P0 monitor/scheduler have registry-diff context available or an explicit prompt requirement to run the diff.
5. Repository verification passes:
   - `python3 -m py_compile scripts/check_cron_registry.py`
   - `git diff --check`
6. GitHub #1122 and the PR Project items show current Status, Evidence, and Next action.
7. A final acceptance report includes backup path, changed files, live cron diff result, paused/resumed jobs, removed stale jobs, and remaining risks.

### Phase 5 — Rollback

If a live cron mutation breaks scheduling or delivery:

1. Pause only the affected job(s).
2. Restore `~/.hermes/cron/jobs.json` from the local snapshot if required.
3. Re-run `cronjob list` and compare safe metadata to the snapshot.
4. Revert repo docs/script through the PR branch or a follow-up revert PR.
5. Update #1122 Project Evidence / Next action with rollback status.
6. Resume only after the expected-state diff is clean or the residual drift is intentionally documented.

## Final delivery format

The final report must include:

```text
Cron optimization acceptance:
- registry decision: kept/enforced
- backup: <path + jobs.json sha256 + hermes-state commit>
- docs/script PR: <PR URL/state>
- live mutations: <paused/resumed/removed/updated job ids>
- registry diff: PASS/FAIL + counts
- scheduler/P0 monitor state: <enabled/state/next_run_at>
- remaining risk: <none or explicit issue>
```
