# Screeps Minimal Rules Registry

Last updated: 2026-05-05
Tracking issue: https://github.com/lanyusea/screeps/issues/620

This registry is the canonical compact rules standard for the two-person Screeps project. It intentionally avoids multi-level governance. The goal is to keep autonomous agents from doing the wrong thing while keeping the system small enough to maintain.

## Current target

- Official branch: `main`
- Official shard: `shardX`
- Official room: `E26S49`

References to `E48S28` or `E48S29` are historical/superseded unless a future owner decision explicitly retargets the project.

## Authority order

1. **GitHub live state** is authoritative for active work: Issues, PRs, Milestones, Project `screeps` #3, required checks, and review threads.
2. **`docs/ops` contracts** explain operating rules and recovery procedures.
3. **Cron prompts, skills, memory, generated roadmap data, and reporter state** are derived/cached surfaces. They must not contradict GitHub live state or this registry.
4. **`docs/process` and `docs/research`** are historical/research evidence. They are not the active backlog.

## Minimal taxonomy

### Priority

- `P0` — hard blocker, urgent survival/runtime safety issue, unsafe operation, exact owner-action gate, or autonomous-system health problem.
- `P1` — important active strategic/gameplay/release/RL work.
- `P2` — normal follow-up.
- `P3` — polish or non-blocking cleanup.

`hard P0` is a scheduler preemption class. A `priority:p0` item that has no executable unblock action must be marked held/blocked and must not freeze all lower-priority executable work indefinitely.

### Domain

`Domain` is the only primary roadmap/work-area classification. There is no separate Track field.

Canonical Domain values:

1. `Agent OS`
2. `Change-control`
3. `Runtime monitor`
4. `Release/deploy`
5. `Bot capability`
6. `Combat`
7. `Territory/Economy`
8. `Gameplay Evolution`
9. `RL flywheel`
10. `Docs/process`

`roadmap:*` labels are compatibility/search labels. Project `Domain` is the primary machine-readable grouping for Kanban, reports, and Pages domain progress.

### Kind

`Kind` describes work type only:

- `bug`
- `ops`
- `docs`
- `test`
- `code`
- `review`
- `research`
- `qa`

### Milestone

Milestones are delivery/program gates, not domains. Example: `Combat: Survival / defense gate` and `P1: RL strategy flywheel gate`.

### Vision layer

Vision layer is a report/issue annotation, not a Project field for now:

- automation health
- survival/reliability
- territory
- resources
- enemy kills
- strategy evolution
- foundation blocker

## GitHub completion gate

A meaningful task is not complete until:

1. The linked issue/PR is current in Project `screeps` #3.
2. `Status`, `Evidence`, and `Next action` are accurate.
3. If blocked, the item has both a `blocked` label and a non-empty `Blocked by` field, with a concrete unblock action.
4. PRs use a closing keyword (`Fixes #...`, `Closes #...`, or `Resolves #...`) when they complete a tracked issue.
5. Required checks, automated review findings, review threads, QA gate, and elapsed review window are satisfied before merge.
6. Gameplay/runtime-affecting merged work also satisfies the Deployment Floor: official deploy evidence plus post-deploy observation, or an explicit HELD blocker.

Closed/Done issues are not reopened. Repeated or corrected scope gets a new linked issue.

## Blocked-state rule

An active item is blocked only when all of these are true:

- `blocked` label is present.
- Project `Blocked by` is non-empty.
- `Next action` names the owner/external dependency or concrete unblock step.

Done/closed items should not carry active `Blocked by`; historical blockers belong in `Evidence` or a process note.

## Autonomous recovery authorization

When the official target room (E26S49 on shardX) enters a dead-end state — defined as **owned_spawns=0 AND owned_creeps=0** — the autonomous system is authorized to:

1. Execute destructive respawn: `POST /api/user/respawn`
2. Place spawn at the last-known good position (14,39 for E26S49) or auto-discover valid positions
3. Deploy the last-known-healthy commit (from deploy evidence history, not HEAD)
4. Verify recovery: spawn ≥ 1, creeps ≥ 1, alert=false
5. Resume normal autonomous operation

This authorization is automatic — no owner approval required. The agent MUST act immediately when the dead-end condition is detected, not wait for owner authorization. After recovery, post a concise summary to #decisions and update the P0 incident issue.

The dead-end condition is checked by the runtime alert cron job (`1df5ef0c3835`, `Screeps runtime room alert text check`). When detected with `room_dead` category and `owned_spawns=0 AND owned_creeps=0`, the alert handler must trigger the recovery sequence above, not just report.

Owner @ notification is still required for: rollback decisions when multiple healthy commits exist, manual respawn when automated recovery fails, and non-recovery strategic decisions.

## Rules-change process

1. Create or reuse a GitHub issue.
2. Use a worktree and PR for repo changes.
3. Update this registry and the affected docs/templates/scripts/prompts.
4. Run `scripts/audit-rules-consistency.py`.
5. Update Project evidence and next action.
6. If cron prompts changed, snapshot old job config first and verify with `cronjob list` after update.
7. Archive owner-facing final rules to Discord `#rules` / channel `1499621566164504766` when the standard changes.
