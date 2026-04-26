# GitHub Roadmap Management Contract

GitHub is the source of truth for active Screeps roadmap management. Repository docs explain the vision, decisions, runbooks, and process history; they do not replace live GitHub Issues, Milestones, and the `screeps` Project.

This document complements `docs/ops/github-issue-management.md`. The issue-management contract owns issue/PR templates and defect-tracking rules. This roadmap-management contract owns milestone/project usage so the two workflows do not conflict.

## Authority model

1. **Issue = atomic work item.** Any roadmap target, blocker, known defect, or follow-up that needs action must have a GitHub issue.
2. **Milestone = roadmap gate.** Every open roadmap issue must belong to exactly one active roadmap milestone.
3. **Project = execution board.** The user project `screeps` (`https://github.com/users/lanyusea/projects/3`) tracks cross-milestone status, priority, domain, blockers, evidence, next action, and linked PRs.
4. **PR = implementation proof.** PRs that complete a known issue must use GitHub closing keywords such as `Fixes #123`, `Closes #123`, or `Resolves #123`.
5. **Docs = explanation and recovery.** Keep durable decisions, runbooks, status snapshots, and postmortems in `docs/`, but do not treat local markdown as the authoritative active backlog.

Operational invariant:

```text
Any roadmap goal without a GitHub issue is not actionable.
Any open roadmap issue without a milestone is not planned.
Any active roadmap issue missing from Project screeps is a management defect.
Any agent task whose GitHub issue/PR/Project state is not current is not complete.
```

## Agent task completion gate

This gate applies to Hermes main-agent tasks, Codex coding tasks, delegated subagent tasks, scheduled/cron workers, and any future automated agent that touches this project.

Before an agent reports a task complete, it must update the corresponding GitHub source-of-truth item:

1. **Start / claim work** — set the issue or PR item in Project `screeps` to `In progress` when actual work starts, or `In review` when the work has moved to a PR/review gate.
2. **Track every active PR** — every PR opened by an agent must be added to Project `screeps` while active. At minimum, maintain `Status`, `Priority`, `Domain`, `Kind`, `Evidence`, and `Next action` until the PR is merged or explicitly closed as superseded.
3. **Maintain next action** — keep `Next action` accurate enough that another agent can resume without reading local chat history.
4. **Record evidence** — keep `Evidence` current with PR URL, commit, CI/check result, runtime artifact, redacted report, process note, or decision note.
5. **Record blockers** — if progress is blocked, add the `blocked` label, fill `Blocked by`, and set `Next action` to the unblock step.
6. **Close only after GitHub is current** — when the task is actually complete, update the issue/PR Project item to `Done` or ensure the linked PR closes the issue, then verify the Project item reflects the final status.

A task is **not done** if its code/docs/tests are complete but its GitHub issue, PR, or Project item still shows stale status, stale evidence, or stale next action. The final report for any agent task should mention the GitHub issue/PR numbers whose state was updated.

## Review and merge gate

The owner decision on 2026-04-26 is to use the automated review口径 for this repository. A formal GitHub approving review is **not** required unless a later owner decision changes this contract.

A PR may be merged only after all of these are true:

1. The PR has waited at least 15 minutes after creation.
2. Required checks are green, including `Verify prod TypeScript, Jest, and bundle` when applicable.
3. Automated review signals have no blocking findings: CodeRabbit/Gemini are successful, have no critical unresolved feedback, or explicitly report no feedback.
4. All GitHub review threads/discussions are resolved or verified as outdated/non-blocking.
5. The linked issue and PR Project items have current `Status`, `Evidence`, and `Next action` fields.
6. A QA/acceptance-check pass returns `PASS` for meaningful deliverables.

If P0 monitoring/routing/scheduler health is known unhealthy, normal implementation and non-P0 merges are deferred until the P0 issue is repaired or the main agent has evidence that the affected automation is healthy again.

## Labels

Use both the generic `roadmap` label and the specific domain label on active roadmap issues.

Current generic labels:

- `roadmap` — issue participates in GitHub milestone/project roadmap management.
- `blocked` — issue is blocked by another milestone, issue, PR, external dependency, or owner action.

Current roadmap domain labels:

- `roadmap:p0-change-control`
- `roadmap:p0-agent-ops`
- `roadmap:phase-a-docs-sync`
- `roadmap:phase-b-spawn-lifecycle`
- `roadmap:phase-c-telemetry`
- `roadmap:phase-d-private-smoke`
- `roadmap:phase-e-mmo-deploy`

Priority/kind labels remain as documented in `docs/ops/github-issue-management.md`.

## Active roadmap milestones

Open roadmap issues are grouped into these GitHub Milestones:

| Milestone | Purpose | Current issue mapping |
| --- | --- | --- |
| `P0: Change-control / CI / branch protection gate` | issue/PR linkage, branch protection, required checks, agent GitHub-status completion gate, and governance | `#22`, `#26`, `#36`, `#39` |
| `P0: Agent OS / Discord visibility gate` | scheduler, continuation, checkpoint, Discord routing, P0 monitor, and owner-visible reports | `#27` |
| `Phase B: Bot capability hardening gate` | spawn lifecycle, worker recovery, deterministic tests, and economy deadlock hardening | `#30`, `#31` |
| `Phase C: Runtime telemetry / monitor gate` | runtime summary/alert scheduling, no-alert silence, monitor evidence, and alert-level telemetry | `#29`, `#32` |
| `Phase D: Private-server smoke release gate` | clean private-server smoke reruns and redacted runtime validation reports | `#23`, `#28` |
| `Phase E: Official MMO deployment gate` | official Screeps MMO deployment readiness, gated by private-smoke and monitor proof | `#33` |

When adding a new roadmap issue, choose the nearest milestone. If no current milestone fits, create a new milestone before treating the issue as active roadmap work.

## Project `screeps` fields

Project URL: `https://github.com/users/lanyusea/projects/3`

Configured fields:

| Field | Use |
| --- | --- |
| `Status` | `Backlog`, `Ready`, `In progress`, `In review`, `Done`. Use `blocked` label plus `Blocked by` for blocked work because the current default status field has no `Blocked` option. |
| `Priority` | `P0`, `P1`, `P2`. Mirrors `priority:*` labels for Project sorting. |
| `Domain` | `Change-control`, `Agent OS`, `Bot capability`, `Runtime monitor`, `Private smoke`, `Official MMO`, `Docs/process`. |
| `Kind` | `bug`, `ops`, `docs`, `test`, `code`, `review`. |
| `Blocked by` | One-line blocker reference: issue, PR, milestone, external dependency, or owner action. |
| `Evidence` | Minimal closure evidence: PR, CI/checks, runtime artifact, redacted smoke report, monitor proof, or decision note. |
| `Next action` | One concrete next move, not a long plan. |
| `Next-point %` | Main-agent reviewed progress estimate used by roadmap snapshots and six-hour reports. Change only with verified evidence. |

Built-in fields such as `Milestone`, `Labels`, `Linked pull requests`, `Repository`, `Assignees`, and `Reviewers` should remain visible in the primary views.

## Recommended Project views

The GitHub CLI can configure fields and item values, but saved Project views may still need UI setup. Use these views as the stable operating contract:

1. **Roadmap Gates**
   - Layout: table.
   - Group by: `Milestone`.
   - Sort by: `Priority`, then `Status`.
   - Fields: Title, Status, Priority, Domain, Milestone, Next action, Evidence, Linked pull requests.

2. **Now / Blocked**
   - Filter: active statuses (`In progress`, `In review`) plus issues with `label:blocked`.
   - Purpose: first recovery view when the main agent resumes.

3. **P0 Control Plane**
   - Filter: `Priority = P0` or labels `roadmap:p0-change-control`, `roadmap:p0-agent-ops`.
   - Purpose: prevent governance and visibility regressions from being buried under feature work.

4. **Engineering Queue**
   - Filter: `Domain = Bot capability` or `Kind = test/code/bug`.
   - Purpose: queue Codex-owned implementation/testing slices separately from ops/docs tasks.

5. **Review / Merge Gate**
   - Filter: open PRs and issues with linked PRs.
   - Purpose: ensure PR-producing tasks are not considered complete until merged or explicitly closed as superseded.

## Current conflict-avoidance rule

The issue-management workflow was implemented by PR `#34` for issue `#22`. Do not duplicate or fork its files unless intentionally changing issue/PR templates:

- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/ISSUE_TEMPLATE/known_problem.yml`
- `.github/pull_request_template.md`
- `docs/ops/github-issue-management.md`

Roadmap-management updates should normally touch this file, `docs/ops/roadmap.md`, or process notes instead. If a future change needs both issue-template policy and roadmap/project policy, link both the issue-management issue and the roadmap-management issue in the PR body.

## Maintenance checklist

When creating or triaging roadmap work:

1. Create or update the issue using the issue-management contract.
2. Add labels: `roadmap`, one specific `roadmap:*`, one `priority:*`, and one `kind:*`.
3. Assign the correct milestone.
4. Add it to Project `screeps` if automation has not already done so.
5. Set Project fields: `Status`, `Priority`, `Domain`, `Kind`, `Evidence`, `Next action`, and `Next-point %` when applicable.
6. If blocked, add `blocked` and fill `Blocked by`.
7. Link implementation PRs with closing keywords and keep PR items visible in the Project until merged/closed.
8. Reflect durable decisions or recovery context in docs/process notes only after GitHub source-of-truth state is correct.
9. Before any agent reports completion, verify its issue/PR/Project item state is current. If the Project item still has stale `Status`, `Evidence`, `Next action`, or blocker fields, the task is not complete.

## Verification commands

Use these commands from `/root/screeps` or a repo worktree:

```bash
# Milestone distribution
gh api repos/lanyusea/screeps/milestones --paginate \
  --jq '.[] | {number,title,state,open_issues,closed_issues,html_url}'

# Open roadmap issues missing milestones should return nothing
gh issue list --state open --limit 100 --json number,title,labels,milestone \
  --jq '.[] | select(([.labels[].name] | index("roadmap")) and (.milestone == null))'

# Project field/item audit
gh project field-list 3 --owner lanyusea --format json
gh project item-list 3 --owner lanyusea --limit 100 --format json
```
