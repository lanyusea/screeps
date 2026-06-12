# Screeps Minimal Rules Registry

Last updated: 2026-06-12
Tracking issue: https://github.com/lanyusea/screeps/issues/620

This registry is the canonical compact rules standard for the two-person Screeps project. It intentionally avoids multi-level governance. The goal is to keep autonomous agents from doing the wrong thing while keeping the system small enough to maintain.

## Current target

- Official branch: `main`
- Official shard: `shardX`
- Official room: `E29N55`
- Official spawn: `Spawn1` at `(17,24)`
- Official room candidates, in order: active `E29N55`, then fallback/audit candidates `W3N9`, `E19S57`, `E26S49`, `E17S59`

References to `W3N9`, `E24S49`, `E19S55`, `E22S49`, `E48S28`, `E48S29`, `E26S49`, `E17S59`, or `E19S57` are historical incident/fallback or superseded rooms unless a future owner decision explicitly retargets the project.

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
10. `Seasonal World`
11. `Docs/process`

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
4. The `Universal task Done gate` states the task type, expected observable outcome / named deliverable, non-goals or owner-accepted substitutes, required verification evidence, Project `Evidence` / `Next action` / `Blocked by` state, post-merge/deploy/runtime proof, and named deliverable proof.
5. Any named surface in the task contract is proven literally: Grafana, GitHub Pages, Discord route, deployed service, public URL, specific monitor, dashboard, report, or equivalent concrete deliverable require evidence of that surface unless Project `Evidence` records an owner-accepted substitute.
6. Acceptance-first PR bodies may use a closing keyword (`Fixes #...`, `Closes #...`, or `Resolves #...`) only when they complete a tracked issue and include the Issue closure gate; commit messages must not contain GitHub closing keywords for tracked issues.
7. Required checks, automated review findings or recorded reliability bypass, review threads, QA gate, and elapsed review window are satisfied before merge.
8. Gameplay/runtime-affecting merged work also satisfies the Deployment Floor: official deploy evidence plus post-deploy observation, or an explicit HELD blocker.

Closed/Done issues are not reopened. Repeated or corrected scope gets a new linked issue.

## Automated review feedback triage

CodeRabbit may run with the assertive/aggressive profile to increase review coverage. This does not make every bot finding mandatory. For every active automated PR review body, top-level comment, or review thread:

1. The controller must give Codex the exact finding, PR head SHA, current diff, relevant file context, and this registry/`AGENTS.md` review policy.
2. Codex must classify the finding before any edit: `FIX`, `RESOLVE_FALSE_POSITIVE`, `RESOLVE_STALE_OR_OUTDATED`, `ADVISORY_ONLY`, or `OWNER_DECISION`.
3. Only `FIX` items that meet the project's critical review threshold get code changes, and those changes must be committed by Codex on the PR branch with normal verification.
4. False-positive, stale/outdated, and advisory findings should be resolved with concise evidence through GitHub review-thread/comment resolution instead of code churn.
5. Per owner decision `1514861910908993646`, CodeRabbit/Gemini review may be skipped when that reviewer is unreliable, unavailable, rate-limited, skipped, stale, stuck pending without substantive output, or otherwise non-substantive for the exact PR head. The controller must record the bypass in PR/Project evidence: reviewer, exact head SHA, why the review is unreliable, required-check status, GraphQL review-thread state, and QA/controller judgment that the project critical-only review threshold is still satisfied.
6. A review bypass does **not** waive required checks, unresolved active review threads, Project state, QA, or the elapsed review window. A PR is not merge-ready while a credible active automated finding remains untriaged/unresolved, or while unresolved active review threads remain.

## Blocked-state rule

An active item is blocked only when all of these are true:

- `blocked` label is present.
- Project `Blocked by` is non-empty.
- `Next action` names the owner/external dependency or concrete unblock step.

Done/closed items should not carry active `Blocked by`; historical blockers belong in `Evidence` or a process note.

## Autonomous recovery authorization

When the official target room (`E29N55` on `shardX`) enters a dead-end state — defined as **owned_spawns=0 AND owned_creeps=0** — the autonomous system is authorized to:

1. Execute destructive respawn: `POST /api/user/respawn`
2. Place spawn at the last-known good position (`Spawn1` at `(17,24)` for E29N55) or auto-discover valid positions
3. Deploy the last-known-healthy commit (from deploy evidence history, not HEAD)
4. Verify recovery: spawn ≥ 1, creeps ≥ 1, alert=false
5. Resume normal autonomous operation

The respawn-room retry sequence is active `E29N55`, then fallback/audit candidates `W3N9`, `E19S57`, `E26S49`, and `E17S59`. If a candidate cannot respawn because it is respawn-prohibited, unavailable, or `/api/game/place-spawn` rejects it as unavailable, skip that candidate and try the next one. During the 2026-05-13 recovery, `E17S59` and `E26S49` were prohibited and `E19S57` succeeded. During the 2026-05-14 recovery, the predefined list was exhausted (`E17S59`/`E19S57` prohibited and `E26S49` busy), then owner-selected previous-room `W3N9` succeeded with `Spawn1` at `(35,23)`. W3N9 is now retained only as historical/fallback evidence, not as the active official target.

This authorization is automatic — no owner approval required. The agent MUST act immediately when the dead-end condition is detected, not wait for owner authorization. After recovery, post a concise summary to #decisions and update the P0 incident issue.

The dead-end condition is checked by the runtime alert cron job (`1df5ef0c3835`, `Screeps runtime room alert text check`). When detected with `room_dead` category and `owned_spawns=0 AND owned_creeps=0`, the alert handler must trigger the recovery sequence above, not just report.

Owner @ notification is still required for: rollback decisions when multiple healthy commits exist, manual respawn when automated recovery fails, and non-recovery strategic decisions.

## Seasonal World current-season smoke rule

Seasonal World work is isolated, explicit opt-in smoke work only unless a future owner decision expands the scope. Seasonal commands must use the Seasonal world root (`https://screeps.com/season`), Seasonal selectors, and isolated artifact/state/cache paths from `docs/ops/screeps-world-profiles.md`.

Seasonal work does not inherit persistent MMO autonomous recovery, respawn, or spawn-placement authorization. No destructive Seasonal recovery action is authorized unless the owner explicitly approves it for Seasonal.

Seasonal Discord reporting must use the Seasonal route set in `docs/ops/cron-and-route-registry.md` (`1504888618651488407`, `1504888933832589362`, `1504889127227621507`, `1504889233670930442`, `1504889421655314512`). Do not mix Seasonal roadmap/task/dev/runtime/alert content into persistent MMO channels except for short cross-links. Pin-message setup replies and memories are not authoritative if they conflict with the registry.

## Rules-change process

1. Create or reuse a GitHub issue.
2. Use a worktree and PR for repo changes.
3. Update this registry and the affected docs/templates/scripts/prompts.
4. Run `scripts/audit-rules-consistency.py`.
5. Update Project evidence and next action.
6. If cron prompts changed, snapshot old job config first and verify with `cronjob list` after update.
7. Archive owner-facing final rules to Discord `#rules` / channel `1499621566164504766` when the standard changes.
