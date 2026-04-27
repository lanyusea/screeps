# Screeps Agent Operating System

Last updated: 2026-04-27T18:55:00+08:00

## Purpose

This document is the structural operating contract for how the main Hermes agent, subagents, scheduled workers, and Discord channels coordinate Screeps work.

This is now a **P0 operating-system priority**: before continuing normal research/development slices, the main agent must ensure that agent communication, task routing, and scheduled monitoring are healthy enough for the owner to observe and steer the project.

## Owner expectations translated into system requirements

### R0 — Home channel is the command and proactive-report surface

The owner can use the Discord home channel to give the main agent tasks. The main agent should also proactively report important operating-system status there, especially:

- agent/cron communication failures;
- missing updates from scheduled workers;
- task execution blocked by routing/tooling/auth problems;
- summaries that require owner attention;
- health-monitor anomalies.

The home channel is not the place for every raw research/dev detail. It is the owner-facing command and escalation surface.

### R1 — Main agent delegates tasks to subagents

The main agent decomposes work into minimal research/development tasks. A subagent task should be narrowly scoped and have explicit exit criteria.

For `prod/` code changes, the implementer boundary still applies: production/test/build code must be changed by Codex CLI, while Hermes orchestrates and verifies.

### R2 — Subagent conclusions return to the main agent

A subagent result is not accepted until the main agent reviews it. The main agent must decide whether the result changes:

- decisions;
- roadmap;
- task queue;
- research facts;
- dev/test/build state;
- runtime status;
- blockers.

### R2a — Dedicated QA acceptance gate for deliverables

For any meaningful deliverable, the main agent must provide a QA/acceptance-check agent with explicit deliverables, common acceptance criteria, and task-specific acceptance criteria before treating the work as complete.

Use the QA gate for:

- production, test, build, deployment, runtime-monitor, cron, or configuration changes;
- PR merge readiness and post-merge completion checks;
- GitHub Issue, Milestone, or Project state changes;
- roadmap next-point percentage changes;
- long-running task completion claims;
- cross-file documentation/process updates that change the operating contract.

The QA agent verifies evidence. It does not own roadmap priority, cross-channel routing, or final project-management decisions. The main agent remains accountable for accepting or rejecting the QA result and for deciding the next roadmap move.

QA checks must cover, when relevant:

- code/documentation changes match the requested deliverables;
- verification commands, CI, smoke tests, generated artifacts, or redacted runtime reports support the completion claim;
- PRs are pushed, reviewed, merged, or explicitly closed as superseded according to project gates;
- GitHub Issues, Milestones, and Project `screeps` fields reflect the final state;
- process/roadmap docs match GitHub source-of-truth state;
- no secrets or unsafe local paths were exposed;
- Discord/channel reporting requirements were satisfied or explicitly marked not applicable.

QA output must be evidence-based and use this verdict model:

- `PASS` — all common and task-specific acceptance criteria are satisfied, with evidence listed.
- `REQUEST_CHANGES` — at least one required criterion is not satisfied, with concrete required fixes.

### R3 — Main agent owns channel-appropriate summary fanout

After reviewing subagent outputs, the main agent must post the distilled, channel-appropriate information:

- `#decisions` — final decisions, decision requests, direction-changing tradeoffs;
- `#roadmap` — phase/milestone/priority changes;
- `#task-queue` — active tasks, blockers, done criteria, next task;
- `#research-notes` — factual findings, sources, experiments;
- `#dev-log` — implementation, verification, files, tests, commits;
- `#runtime-summary` — routine runtime state;
- `#runtime-alerts` — urgent runtime or deployment problems.

Main-agent fanout is mandatory for significant subagent outcomes.

### R4 — Subagent process details are available in detail channels, but subagents stay narrow

A subagent should be one minimal research/development task. It should not try to own cross-channel reporting.

Allowed detail-reporting modes:

1. **Delegated subagent mode** — the subagent returns a final result to the main agent. The main agent posts relevant details to `#research-notes` or `#dev-log`.
2. **Spawned/long-running agent mode** — if a spawned agent has messaging ability and a single obvious detail channel, it may post low-level progress only to that channel, e.g. research worker → `#research-notes`, development worker → `#dev-log`. The main agent still owns summaries, decisions, roadmap, and task queue updates.

Subagents must not independently update `#decisions`, `#roadmap`, or `#task-queue` as authoritative state unless explicitly instructed by the main agent.

### R5 — Internal operations monitoring is highest priority

The main agent must maintain an internal operations monitor that checks:

- scheduled jobs exist and are enabled;
- continuation worker is running at the expected cadence, or is intentionally paused for maintenance/migration with that pause mirrored in GitHub Project `Status`, `Evidence`, and `Next action`;
- checkpoint job exists;
- job delivery targets are still correct;
- last run status is not failed/stale;
- active-work state is readable and current;
- git working tree is not unsafe for autonomous workers;
- obvious routing contradictions have not reappeared.

If this monitoring detects an abnormal state, it must report to the dedicated P0 operations channel `discord:1497820688843800776` and preserve a durable process note if the issue is non-trivial. An intentionally paused continuation worker is healthy only when the pause is mirrored in Project metadata: `Status`, `Evidence`, and `Next action`, plus `blocked`/`Blocked by` when the pause is caused by an external blocker. If those artifacts are missing or stale, the monitor must escalate to the P0 operations channel and create/refresh durable process evidence.

Owner decision on 2026-04-26: P0 monitoring/routing/scheduler health blocks normal development and non-P0 merges. If P0 health is known unhealthy, the main agent must repair or prove the P0 monitor and affected scheduled jobs before starting unrelated implementation slices. This repair requirement excludes intentionally paused maintenance/migration states only when the Project metadata conditions above are current; otherwise the pause is treated as an abnormal P0 state.

## Priority model

| Priority | Meaning | Examples |
| --- | --- | --- |
| P0 | Agent operating system health and owner visibility | cron stopped, wrong deliver target, subagent result not reviewed, Discord routing conflict |
| P1 | Runtime safety and deployment correctness | private-server smoke blocker, official MMO runtime alert, failed deploy |
| P2 | Active implementation/research slices | bot behavior, tests, local validation, API research |
| P3 | Polish/documentation cleanup | diagrams, non-blocking doc refinements |

P0 overrides normal development. If P0 is unhealthy, the main agent should pause or defer new implementation slices until the operating system is corrected.

## Main-agent workflow

For every meaningful task:

1. Read current active state and git status.
2. If P0 health is unknown, run an operations health check first.
3. Decompose into minimal subagent/Codex tasks if useful.
4. Define the deliverables, common acceptance criteria, and task-specific acceptance criteria before implementation/review starts.
5. Give each subagent a single clear task and requested output format.
6. Collect subagent final result and logs/artifacts.
7. Run a QA/acceptance-check pass for meaningful deliverables before accepting completion.
8. Review QA evidence and either request changes or accept the result.
9. Update durable docs if the result changes state.
10. Fan out summaries to the corresponding Discord channels.
11. Commit/push meaningful docs-only changes as Hermes; Codex commits production/test/build work.
12. Resume/trigger scheduled continuation only after state is durable and safe.

## Scheduled worker roles

### Continuation worker / autonomous scheduler

Purpose: act as the autonomous scheduler/dispatcher for roadmap execution, not as a single-task worker. Each run must reconcile GitHub state, active agent state, open PRs, and safe capacity; then it should start, monitor, QA-route, or close as many non-conflicting executable tasks as the current capacity and gates allow.

Delivery: `discord:#task-queue`.

The scheduler remains bounded: it must not wait on long-running Codex/QA processes, sleep through review windows, or perform unbounded implementation inside the cron run. It should dispatch independent agents, record their state, and let the next scheduler run reconcile progress.

#### Scheduler phase goals

The scheduler runs these phases in order on every invocation:

1. **Reconcile state.** Inspect `cronjob list`, background processes, `/root/.hermes/screeps-agent-registry.json` when present, git worktrees, open PRs, open roadmap issues, and GitHub Project `screeps` fields. Repair stale GitHub state before dispatching new work.
2. **Close ready loops.** If a PR has completed QA, green required checks, resolved/outdated review threads, and the >=15 minute automated review gate, merge it, fast-forward `/root/screeps`, and set the linked issue/PR Project items to `Done` with evidence.
3. **Handle completed dev agents.** For each finished dev/Codex process, verify commit/authorship, run required checks, push, create or update the PR, add the PR to Project `screeps`, set issue/PR status to `In review`, and dispatch on-demand QA.
4. **Handle QA results.** If QA returns `PASS`, update the PR/issue Evidence and move the PR to merge-gate watch. If QA returns `REQUEST_CHANGES`, dispatch a review-fix dev/Codex agent and record the blocker.
5. **Maximize safe parallelism.** Claim executable `Ready` issues up to capacity, preferring P0 blockers first, then game-goal work in the order territory > resources > kills, then non-blocking foundation. Default assumption: different roadmap submodules are non-conflicting and should run in parallel via separate worktrees unless a concrete file/runtime/resource conflict is observed.
6. **Refresh owner-visible state.** Update Issue/Project `Evidence` and `Next action`, write concise scheduler checkpoint output, and trigger/allow typed reporters to refresh roadmap/task views from GitHub state.

#### Parallelism and conflict policy

Default capacity targets:

| Lane | Default cap | Notes |
| --- | ---: | --- |
| Active dev/Codex agents | 4 | May include code and docs workers. Do not exceed if PR review backlog is unhealthy. |
| Active QA agents | 2 | QA is on-demand and short-lived; never persistent. |
| Open PRs waiting for review/merge gate | 6 | If exceeded, drain PRs before dispatching lower-priority new work. |
| Same roadmap submodule | 1 by default | Allow more only when file scopes are explicitly disjoint. |

Conflict rules:

- Different roadmap domains/submodules are presumed independent.
- Worktrees are mandatory for every repo mutation; use `/root/screeps-worktrees/<topic>`.
- File-scope overlap blocks parallel dispatch only when concrete paths collide, for example two tasks both editing `prod/src/spawn*`, the same generated artifact, the same cron prompt, or the same deploy/runbook file.
- Generated artifacts such as Pages output, bundled `prod/dist/main.js`, and committed SQLite artifacts should be serialized unless the task owns that artifact.
- If a conflict is uncertain, dispatch the higher-priority task and leave the other `Ready` with `Next action` explaining the dependency.

#### Claim, registry, and GitHub state protocol

Before starting a dev or QA agent, the scheduler must claim the issue/PR by updating GitHub Project `screeps`:

- Issue `Status`: `Ready` -> `In progress` for dev, or PR `Status`: `In review` for review/QA.
- `Evidence`: include scheduler run timestamp, worktree, branch, process/session id if known, file scope, and current verification state.
- `Next action`: include the exact next scheduler action, not a vague summary.

The local registry is a runtime cache, not the source of truth. Preferred path:

```text
/root/.hermes/screeps-agent-registry.json
```

Each entry should record at least:

```json
{
  "issue": 78,
  "pr": null,
  "kind": "dev|qa|review-fix|merge-watch",
  "domain": "Agent OS",
  "worktree": "/root/screeps-worktrees/autonomous-scheduler-78",
  "branch": "docs/autonomous-scheduler-78",
  "process_session": "proc_xxx",
  "file_scope": ["docs/ops/agent-operating-system.md"],
  "state": "running|finished|failed|qa_pending|merge_gate|done",
  "claimed_at": "ISO-8601 timestamp",
  "last_seen": "ISO-8601 timestamp"
}
```

Every run must reconcile registry and GitHub:

- Registry running + process missing -> inspect worktree/PR and classify finished, failed, or stale.
- GitHub `In progress` + no registry/process -> recover from worktree/branch/PR evidence or mark blocked with exact reason.
- PR merged + issue not Done -> update issue and PR Project fields immediately.
- Registry says done + GitHub stale -> fix GitHub before final report.

#### Dev-agent and Codex dispatch rules

- Documentation-only tasks may be implemented by a docs dev agent/Hermes in a worktree, but still require PR, QA, Project updates, and review gate.
- Production/test/build code, scripts, workflow/config behavior, generated runtime behavior, and review-fix code changes must be implemented by Codex CLI in the task worktree.
- Each task prompt must include issue link, priority reason, file scope, acceptance criteria, verification commands, commit requirements, no-secret rule, and Project update requirements.
- The scheduler should start agents in background and stop; it should not wait for long-running completion inside the same cron run.

#### On-demand QA trigger

QA is not a standing worker. Trigger it when a PR or dev result is ready for acceptance:

- after a dev/Codex agent has committed and controller verification has passed;
- after a review-fix commit has been pushed;
- before merge when the only remaining question is acceptance/readiness;
- after merge for a lightweight state reconciliation check when the task materially changes roadmap/process/deploy state.

QA output must be exactly one of:

```text
PASS
<evidence bullets>
```

or

```text
REQUEST_CHANGES
<blocking findings and required fixes>
```

The scheduler must not treat a deliverable as complete without QA `PASS`, current GitHub Project fields, and satisfied PR gates.

It should include labelled sections for other channels, but it does not replace main-agent fanout. If it produces significant detail in a final report, the next main-agent/manual review should route the relevant pieces to the typed channels.

### 4-hour checkpoint worker

Purpose: produce a context-recovery summary if a task remains open for 4+ hours.

Delivery: `discord:#task-queue`.

### P0 agent operations monitor

Purpose: monitor the health of the agent operating system itself.

Delivery: dedicated P0 operations channel `discord:1497820688843800776`.

Behavior:

- run frequently enough to catch broken automation quickly;
- monitor continuation, checkpoint, runtime, and typed-channel reporter jobs;
- report abnormal states to the dedicated P0 operations channel;
- remain concise when healthy;
- never perform implementation work;
- never modify production code;
- if it changes docs, commit/push docs-only changes as Hermes.

### P0 dedicated monitor channel

- Status: live route updated on 2026-04-26.
- Channel ID: `1497820688843800776`.
- Cron job: `Screeps P0 agent operations monitor` (`75cedbb77150`).
- Delivery target: `discord:1497820688843800776`.
- Purpose: keep P0 health output separate from owner-task/home-channel conversation while still escalating to home if owner action is urgently required.

### Typed-channel fanout reporters

Purpose: prevent typed channels from going stale when the continuation worker only delivers one final response to `#task-queue`.

Configured reporters:

- `Screeps dev-log fanout reporter` → `discord:#dev-log`, every 20m;
- `Screeps roadmap fanout reporter` → `discord:#roadmap`, every 20m;
- `Screeps research-notes fanout reporter` → `discord:#research-notes`, every 20m.

Behavior:

- read recent continuation output, active-state docs, roadmap, process/research docs, and git log/status;
- compare against per-channel state under `~/.hermes/screeps-reporters/`;
- report only new channel-relevant changes;
- return exactly `[SILENT]` when there is nothing new;
- never implement code or create/modify cron jobs.

These reporters are not authoritative decision-makers. They are narrow visibility bridges. The main agent remains accountable for reviewing subagent conclusions and routing final decisions, roadmap changes, blockers, and owner-facing escalations.

## Discord routing matrix

| Event | Primary target | Secondary/detail target | Owner interrupt? |
| --- | --- | --- | --- |
| New owner task | home channel | `#task-queue` when accepted | yes, if clarification/blocker needed |
| P0 health anomaly | `discord:1497820688843800776` | home only if owner action is urgently required | yes |
| Subagent research result | main agent review first | `#research-notes` | no, unless decision needed |
| Subagent development result | main agent review first, then QA gate when deliverable-significant | `#dev-log` | no, unless blocker/decision needed |
| QA acceptance result | main agent review first | `#task-queue` for PASS/REQUEST_CHANGES; `#dev-log` for verification evidence | no, unless blocker/decision needed |
| Decision needed/finalized | `#decisions` | home if owner action needed | yes |
| Roadmap/priorities changed | `#roadmap` | home only if major | maybe |
| Active task/blocker | `#task-queue` | home if owner action needed | maybe |
| Routine runtime status | `#runtime-summary` | none | no |
| Urgent runtime/deploy alert | `#runtime-alerts` | home channel | yes |

## Anti-regression rules

- Do not conflate home-channel owner notifications with scheduled project-progress delivery.
- Do not let a continuation worker silently run only to local output.
- Do not assume a cron `ok` status means the owner saw the message; verify the deliver target.
- Do not treat subagent output as accepted until the main agent reviews it.
- Do not let subagents own cross-channel summary/decision routing.
- Do not resume normal implementation work while P0 routing/monitoring is known broken.
- Do not mark meaningful deliverables complete without a QA/acceptance-check verdict that cites evidence against both common and task-specific criteria.
