# Screeps Agent Operating System

Last updated: 2026-04-26T04:56:00+08:00

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
- continuation worker is running at the expected cadence;
- checkpoint job exists;
- job delivery targets are still correct;
- last run status is not failed/stale;
- active-work state is readable and current;
- git working tree is not unsafe for autonomous workers;
- obvious routing contradictions have not reappeared.

If this monitoring detects an abnormal state, it must report to the dedicated P0 operations channel `discord:1497820688843800776` and preserve a durable process note if the issue is non-trivial.

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
4. Give each subagent a single clear task and requested output format.
5. Collect subagent final result and logs/artifacts.
6. Review and verify before accepting.
7. Update durable docs if the result changes state.
8. Fan out summaries to the corresponding Discord channels.
9. Commit/push meaningful docs-only成果 as Hermes; Codex commits production/test/build work.
10. Resume/trigger scheduled continuation only after state is durable and safe.

## Scheduled worker roles

### Continuation worker

Purpose: execute one bounded research/development slice from `docs/process/active-work-state.md`.

Delivery: `discord:#task-queue`.

It should include labelled sections for other channels, but it does not replace main-agent fanout. If it produces significant detail in a final report, the next main-agent/manual review should route the relevant pieces to the typed channels.

### 4-hour checkpoint worker

Purpose: produce a context-recovery summary if a task remains open for 4+ hours.

Delivery: `discord:#task-queue`.

### P0 agent operations monitor

Purpose: monitor the health of the agent operating system itself.

Delivery: dedicated P0 operations channel `discord:1497820688843800776`.

Behavior:

- run frequently enough to catch broken automation quickly;
- report abnormal states to the dedicated P0 operations channel;
- remain concise when healthy;
- never perform implementation work;
- never modify production code;
- if it changes docs, commit/push docs-only成果 as Hermes.

### P0 dedicated monitor channel

- Status: live route updated on 2026-04-26.
- Channel ID: `1497820688843800776`.
- Cron job: `Screeps P0 agent operations monitor` (`75cedbb77150`).
- Delivery target: `discord:1497820688843800776`.
- Purpose: keep P0 health output separate from owner-task/home-channel conversation while still escalating to home if owner action is urgently required.

## Discord routing matrix

| Event | Primary target | Secondary/detail target | Owner interrupt? |
| --- | --- | --- | --- |
| New owner task | home channel | `#task-queue` when accepted | yes, if clarification/blocker needed |
| P0 health anomaly | dedicated P0 operations channel `discord:1497820688843800776` | home only if owner action is urgently required | yes |
| Subagent research result | main agent review first | `#research-notes` | no, unless decision needed |
| Subagent development result | main agent review first | `#dev-log` | no, unless blocker/decision needed |
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
