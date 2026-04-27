# 2026-04-27 Autonomous Scheduler Migration Plan

> **For Hermes:** This is the main-agent implementation plan for issue #78. The current continuation worker is paused while this migration is applied directly by the main agent.

**Goal:** Upgrade the Screeps autonomous continuation worker from a bounded single-slice executor into a scheduler/dispatcher that maximizes safe parallelism, dispatches independent development agents, triggers on-demand QA, and keeps GitHub Project state authoritative.

**Architecture:** GitHub Issues/Project remain the source of truth. A local registry under `/root/.hermes/screeps-agent-registry.json` acts only as runtime cache for active dev/QA/merge-watch sessions. The scheduler cron run reconciles state, dispatches background agents up to capacity, and exits without long waits.

**Tech Stack:** Hermes cron scheduler, GitHub CLI/Projects, git worktrees, Codex CLI, on-demand delegated QA agents, Discord typed-channel reporters.

---

## Phase 1 — Freeze and inventory

**Objective:** Prevent concurrent continuation-worker mutations while the scheduler contract changes.

**Completed actions:**

- Paused `Screeps autonomous continuation worker` (`f66ed36d7be0`) at 2026-04-27T18:50+08.
- Confirmed active Codex sessions from #30/#75 had exited.
- Confirmed open PR backlog: PR #77 remains open and PR #76 had merged into current main.
- Created GitHub issue #78 and Project item `PVTI_lAHOACo3ic4BVvO4zgrG_Ns`.
- Created worktree `/root/screeps-worktrees/autonomous-scheduler-78` on branch `docs/autonomous-scheduler-78`.

## Phase 2 — Durable operating contract

**Objective:** Make the scheduler behavior durable in repo docs before changing live cron behavior.

**Files:**

- Modify: `docs/ops/agent-operating-system.md`
- Create: `docs/process/2026-04-27-autonomous-scheduler-migration-plan.md`

**Acceptance criteria:**

- The continuation worker section describes scheduler/dispatcher behavior rather than one bounded development slice.
- The doc states max-parallel defaults, conflict assumptions, registry/cache behavior, GitHub claim protocol, dev/Codex dispatch rules, and on-demand QA trigger rules.
- The plan records phased goals and implementation evidence for recovery.

## Phase 3 — Live continuation prompt migration

**Objective:** Replace the live continuation worker prompt with scheduler-mode instructions.

**Live job:** `Screeps autonomous continuation worker` (`f66ed36d7be0`)

**Acceptance criteria:**

- Prompt says the worker is an autonomous scheduler/dispatcher.
- Prompt requires each run to reconcile GitHub Project/registry/process/worktree/PR state.
- Prompt requires dispatching safe Ready tasks up to capacity, not merely listing queued coverage.
- Prompt requires on-demand QA after controller verification and before completion.
- Prompt keeps the same safety constraints: no recursive cron creation, no secrets, no main edits, Codex for production/test/build/script/workflow behavior, no long sleeps.
- Prompt final report includes scheduler inventory, dispatch decisions, active agents, QA state, GitHub updates, and next scheduler action.

## Phase 4 — GitHub state reconciliation

**Objective:** Ensure GitHub state is complete enough to support automated dispatch.

**Acceptance criteria:**

- Issue #78 is `In progress`, P0, Agent OS, ops, with Evidence and Next action.
- Open PRs and active issues have enough Evidence/Next action for the scheduler to resume without chat context.
- If any tracked item is blocked, it also has explicit `blocked` status and `Blocked by` linkage before resume.
- The paused continuation worker state is explicitly recorded as an intentional migration pause, not abnormal delivery failure; if the pause is caused by an external blocker, the same `blocked` / `Blocked by` metadata is populated.

## Phase 5 — Verification and PR

**Objective:** Make the durable change reviewable and keep live scheduler state safe.

**Verification commands:**

```bash
git diff --check
git status --short --branch
gh issue view 78 --repo lanyusea/screeps --json number,title,projectItems
cronjob list  # via Hermes tool, verify f66ed36d7be0 paused until prompt update is complete
```

**PR gate:**

- Push `docs/autonomous-scheduler-78`.
- Open PR linked with `Fixes #78`.
- Add PR to Project `screeps` as `In review`.
- Run QA acceptance against docs + live prompt + GitHub state.
- Resume continuation worker only after the live prompt has been updated and verified.

## Scheduler policy summary

- Maximum safe parallelism is the default, not an exception.
- Different roadmap submodules are presumed independent unless a concrete conflict is identified.
- Every repo mutation uses a worktree.
- Code/script/workflow behavior changes are Codex-owned; docs-only contract changes may be Hermes-owned.
- QA is on-demand per deliverable/PR, not a standing cron worker.
- GitHub Project state is the dispatch source of truth; local registry is only a runtime cache.
