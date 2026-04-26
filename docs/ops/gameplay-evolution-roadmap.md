# Screeps Gameplay Evolution Roadmap

> This is the专项 plan for turning the project vision into a recurring game-result → postmortem analysis → roadmap/task-update loop.

Date: 2026-04-27

## Problem statement

The current project has useful engineering foundations: TypeScript/Jest build, private-server smoke harness, official-client room monitor, runtime summaries, GitHub Issues/Milestones/Project, PR gates, and scheduler visibility. However, the mainline has been biased toward infrastructure completion. The missing product loop is:

```text
actual game result → evidence-backed review → strategy/code roadmap update → Codex task execution → release → observe next result
```

Without this loop, the bot can keep improving peripheral systems while not measurably advancing the ordered game vision:

1. hold and expand enough territory;
2. convert territory into enough resource scale;
3. produce meaningful defensive/offensive enemy kills.

## Operating principles

1. **Game outcomes drive the roadmap.** Infrastructure work is valuable only when it improves the evidence loop, release safety, or bot capability.
2. **Main Hermes agent remains the authority.** Gameplay-review agents provide evidence and recommendations; the main agent accepts/rejects and updates GitHub.
3. **GitHub is the source of truth.** Any accepted work item must become or update a GitHub Issue, Milestone, and Project `screeps` item.
4. **Codex owns production code.** Any `prod/` code change must be delegated to Codex and verified with typecheck/test/build.
5. **Scheduled reviews and tactical emergencies are separate paths.** The 12-hour loop must not delay an urgent response to attacks or collapse.
6. **Release is a gameplay decision, not just a build artifact.** A release candidate must have expected KPI movement and observation requirements.

## Agent model

### Main Hermes Agent — P0 owner and decision authority

Responsibilities:

- Review gameplay-agent conclusions.
- Decide whether each conclusion becomes roadmap input, deeper research, a Codex task, a release candidate, or a deferral.
- Maintain Issues/Milestones/Project fields: `Status`, `Priority`, `Domain`, `Kind`, `Evidence`, `Next action`, `Blocked by`, and `Next-point %` where relevant.
- Fan out concise summaries to Discord typed channels.
- Run or request QA/acceptance before accepting completion.

### Gameplay Evolution Agent — 12-hour strategic reviewer

Cadence: every 12 hours, plus manual invocation after major releases or major incidents.

Inputs:

- runtime-summary images and JSON outputs;
- runtime-alert history;
- official-client room snapshot state;
- in-game `#runtime-summary` telemetry;
- private-server smoke reports;
- recent merged PRs/deploys;
- open GitHub roadmap issues and Project fields.

Required output:

```markdown
# Gameplay Evolution Review

## Scope
- Time window:
- Shard / room:
- Code version / commit:
- Evidence reviewed:

## KPI summary
- Territory:
- Resource/economy:
- Combat/enemy damage:
- Reliability guardrails:

## Outcome classification
- Expansion win / Economic win / Combat win / Stall / Regression:
- Confidence:

## Dominant bottleneck
- Evidence:
- Why it blocks the vision priority chain:

## Recommended roadmap changes
| Rank | Action | Type | GitHub target | Expected KPI movement | Rollback/stop condition |
| --- | --- | --- | --- | --- | --- |

## Emergency concern
- Tactical response needed: yes/no
- Reason:

## Release recommendation
- Hold / observe / release candidate / emergency hotfix:
```

### Tactical Emergency Response Agent — incident-only analyst

Trigger examples:

- hostile creep in owned room;
- owned structure HP decrease or critical owned structure disappearance;
- spawn destroyed or unable to recover;
- no workers plus no feasible emergency spawn path;
- controller downgrade risk;
- loop exceptions or telemetry silence after deploy;
- runtime monitor unable to render/alert during a live incident.

Required first response target: 10–20 minutes after trigger.

Required output:

```markdown
# Tactical Emergency Report

## Incident classification
- Severity:
- Trigger:
- First observed:
- Room / shard:
- Evidence:

## Current risk
- What can be lost:
- Estimated urgency:
- Current bot response:

## Immediate recommendation
- Observe / open issue / Codex hotfix / rollback / owner action:
- Minimal scope:
- Verification required:

## Follow-up
- Postmortem needed:
- Roadmap implication:
```

### QA / Acceptance Agent

Returns only `PASS` or `REQUEST_CHANGES` with evidence. It verifies:

- code/docs diff matches accepted plan;
- typecheck/tests/build or relevant script checks passed;
- PR/review/15-minute gates are satisfied when merging;
- issue/PR/Project fields are current;
- no secrets or unsafe runtime artifacts were exposed;
- Discord/reporting requirements are met;
- release/incident gates are not skipped.

## KPI and evidence schema

### North-star outcome KPIs

| Vision layer | KPI | First implementation target |
| --- | --- | --- |
| Territory | owned rooms, reserved/remote rooms, room gain/loss, RCL progress | external monitor + in-game telemetry summary fields |
| Resources | total stored energy/resources, harvest/collection deltas, GCL/RCL deltas, spawn utilization | in-game counters plus 12h window reducer |
| Enemy kills | hostile creeps/structures destroyed, own losses, net combat value | `Room.getEventLog()` where visible plus monitor hostiles/damage observations |

### Guardrails

- CPU used/bucket, exceptions, resets, telemetry silence.
- Spawn/worker recovery state.
- Controller downgrade risk.
- Runtime-alert false-positive and false-negative evidence.

### Task-generation rule

A gameplay finding may become a development task only if it states:

- evidence window;
- KPI delta;
- hypothesis;
- target code/ops area;
- expected KPI movement;
- acceptance evidence;
- rollback/stop condition.

## Roadmap decomposition

### Track 1 — Vision KPI telemetry and reducer

Goal: make the bot and monitor emit enough cumulative data for a 12-hour review.

Initial tasks:

1. Extend runtime telemetry schema with territory/economy/combat KPI fields.
2. Add deterministic tests for KPI aggregation where feasible.
3. Add an external reducer that compares the current window to the prior 12-hour baseline.
4. Render or publish a concise KPI board for routine review.

Acceptance:

- Review report can list territory/resource/combat/reliability deltas without manual guessing.
- Missing fields are explicitly marked `not instrumented`, not silently omitted.

### Track 2 — 12-hour gameplay review worker

Goal: schedule a recurring analysis loop that recommends roadmap changes.

Initial tasks:

1. Create a self-contained cron prompt for `Screeps Gameplay Evolution Review`.
2. Run one manual dry run against current evidence.
3. Main agent accepts/rejects the dry-run output.
4. Enable every-12-hour cadence after dry-run success.

Acceptance:

- The worker reports the time window, evidence, KPI classification, bottleneck, recommended actions, emergency flag, and release recommendation.
- The main agent updates GitHub for every accepted action.

### Track 3 — Gameplay roadmap/task bridge

Goal: make review conclusions automatically become schedulable work without falling through cracks.

Initial tasks:

1. Define issue templates/body structure for gameplay findings.
2. Add Project field updates for accepted findings.
3. Maintain priority order: territory > resources > enemy kills, with reliability as a prerequisite guardrail.
4. Dispatch Codex tasks only after the GitHub issue is clear and accepted.

Acceptance:

- Every accepted gameplay finding has a GitHub issue or a comment updating an existing issue.
- Every active issue has milestone, Project status, priority, domain, kind, evidence, and next action.

### Track 4 — Tactical emergency response

Goal: avoid waiting 12 hours when an attack or collapse requires immediate action.

Initial tasks:

1. Document runtime-alert triggers that should launch emergency triage.
2. Add a bounded tactical-agent prompt/report template.
3. Define emergency hotfix gates.
4. Add post-incident postmortem requirements.

Acceptance:

- Hostile/damage/spawn-collapse signals have a visible triage path.
- Emergency hotfixes still require issue/project update, Codex implementation for `prod/`, typecheck/test/build, QA, and post-release monitor evidence.

### Track 5 — Gameplay release gate and cadence

Goal: ensure release decisions are based on gameplay risk and expected outcomes.

Normal releases:

- Prefer at most one meaningful gameplay release per 12-hour review cycle.
- Require accepted roadmap issue, Codex implementation, typecheck/test/build, PR gate, QA `PASS`, and risk-appropriate runtime/private validation.
- Require the next 12-hour review to evaluate expected KPI movement.

Emergency hotfixes:

- May happen immediately for survival/defense/deploy-safety incidents.
- May not skip no-secrets, GitHub state, Codex-for-prod, typecheck/test/build, main-agent review, QA, and monitor verification.

Acceptance:

- Release recommendation is present in each gameplay review.
- Emergency exceptions record why waiting for normal cadence would risk room loss or runtime failure.

## First GitHub issue set

This专项 is tracked by GitHub issues instead of local-only TODOs:

1. **#59 — P1: Gameplay Evolution专项：vision-driven game-result review to roadmap/task loop**
   - Domain: Docs/process
   - Kind: ops
   - Status: In progress
2. **#60 — P1: Phase C: 12h gameplay evolution review loop is not automated**
   - Domain: Agent OS
   - Kind: ops
3. **#61 — P1: Phase B: gameplay findings do not yet bridge into Codex task pipeline**
   - Domain: Bot capability
   - Kind: ops
4. **#62 — P1: Phase C: tactical emergency response is not wired to runtime alerts**
   - Domain: Runtime monitor
   - Kind: ops
5. **#63 — P1: Phase E: gameplay release cadence and emergency hotfix gate are not enforced**
   - Domain: Official MMO
   - Kind: ops

Existing issue **#29** remains the immediate KPI telemetry bridge; it is cross-linked from #59 and should receive the first Codex implementation slice for resource/kills/territory fields where appropriate.

## Implementation order

1. Land this docs/ops/research plan and GitHub issue setup.
2. Update or create GitHub issues and Project fields.
3. Run a manual gameplay-review dry run using current evidence.
4. Enable a 12-hour review job only after dry-run output is useful.
5. Dispatch Codex for KPI telemetry implementation under `prod/`.
6. Add reducer/reporting automation.
7. Wire tactical emergency response from runtime-alert outputs.
8. Update release gate docs and enforce via Project status / release checklist.

## Definition of done for the专项

- [ ] KPI framework exists and is source-backed.
- [ ] Runtime telemetry/monitor can provide territory/resource/combat/reliability deltas.
- [ ] 12-hour gameplay review job runs and produces an accepted report.
- [ ] Accepted findings update GitHub Issues/Milestones/Project before implementation.
- [ ] Codex receives concrete production-code tasks with acceptance criteria.
- [ ] Tactical emergency path handles attacks/collapse without waiting for cadence.
- [ ] Release gates distinguish normal gameplay releases from emergency hotfixes.
- [ ] QA verifies docs, GitHub state, scheduler state, and no-secret safety.
