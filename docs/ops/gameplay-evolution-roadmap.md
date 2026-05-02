# Screeps Gameplay Evolution Roadmap

> This is the专项 plan for turning the project vision into a recurring game-result → postmortem analysis → roadmap/task-update loop.
>
> RL strategy evolution is governed by [`rl-domain-roadmap.md`](./rl-domain-roadmap.md). Treat the RL flywheel as a standing P1 domain, not an ad-hoc research thread.

Date: 2026-04-29

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

1. **P0 automation health is the only priority class above gameplay.** Anything that blocks the autonomous system from operating, reporting, merging, or safely recovering is `P0` until cleared.
2. **Game outcomes drive the roadmap.** Once P0 automation health is clear, work that directly advances the ordered game vision has priority over non-blocking foundation work: territory first, resource scale second, enemy kills third.
3. **Infrastructure must justify itself as an unblocker.** Foundation work outranks a gameplay task only when it is currently blocking that gameplay task's evidence, implementation, release, or safe rollback path.
4. **No roadmap line may be abandoned.** Gameplay development tracks and foundation/operations tracks must both keep active or queued worker coverage. The main agent may allocate more worker capacity to higher-priority gameplay items, but a non-blocked track cannot be left idle.
5. **Main Hermes agent remains the authority.** Gameplay-review agents provide evidence and recommendations; the main agent accepts/rejects and updates GitHub.
6. **GitHub is the source of truth.** Any accepted work item must become or update a GitHub Issue, Milestone, and Project `screeps` item.
7. **Codex owns production code.** Any `prod/` code change must be delegated to Codex and verified with typecheck/test/build.
8. **Scheduled reviews and tactical emergencies are separate paths.** The 8-hour loop must not delay an urgent response to attacks or collapse.
9. **Release is a gameplay decision, not just a build artifact.** A release candidate must have expected KPI movement and observation requirements.
10. **The strategy model itself must evolve.** The review loop must judge whether the current scoring model, decision rules, and task-generation contract remain valid. If not, it should propose model changes, research tasks, or controlled experiments.
11. **RL is the long-term self-evolution path, not an immediate production shortcut.** Reinforcement-learning-driven strategy iteration requires autoresearch, a formal paper, offline/private-server evaluation, and explicit safety gates before influencing official MMO behavior.

## Reporting weight contract

Routine roadmap snapshots, 4-hour checkpoints, and the six-hour development report must make the project vision visible instead of treating it as background context:

- Start with current game-result KPI status whenever data exists; if a KPI is missing, state `not instrumented` and link the build item that will instrument it.
- For every active/queued item, identify the served vision layer: `P0 automation health`, `territory`, `resources`, `enemy kills`, or `foundation blocker`.
- In the six-hour report, the roadmap progress section must spend more weight on territory/resource/combat KPI movement and the delivery state of their enabling build items than on generic process activity.
- Foundation updates should be concise unless they block the earliest unmet gameplay KPI.
- Each report must name stalled domains and the next worker/delegation action so parallel coverage remains auditable.

## Agent model

### Main Hermes Agent — P0 owner and decision authority

Responsibilities:

- Review gameplay-agent conclusions.
- Decide whether each conclusion becomes roadmap input, deeper research, a Codex task, a release candidate, or a deferral.
- Maintain Issues/Milestones/Project fields: `Status`, `Priority`, `Domain`, `Kind`, `Evidence`, `Next action`, `Blocked by`, and `Next-point %` where relevant.
- Fan out concise summaries to Discord typed channels.
- Run or request QA/acceptance before accepting completion.

### Gameplay Evolution Agent — 8-hour strategic reviewer

Cadence: every 8 hours, plus manual invocation after major releases or major incidents.

Inputs:

- runtime-summary images and JSON outputs;
- runtime-alert history;
- official-client room snapshot state;
- in-game `#runtime-summary` telemetry;
- private-server smoke reports;
- recent merged PRs/deploys;
- open GitHub roadmap issues and Project fields.

Preferred persisted-artifact feeder for KPI evidence:

```bash
python3 scripts/screeps_runtime_kpi_artifact_bridge.py > runtime-kpi-report.json
```

When a worker has raw Screeps console output rather than a saved artifact, persist the exact runtime-summary lines first:

```bash
python3 scripts/screeps_runtime_summary_console_capture.py saved-console.log
```

For a bounded live official-client console capture, load `SCREEPS_AUTH_TOKEN` from the local secret environment and run:

```bash
python3 scripts/screeps_runtime_summary_console_capture.py --live-official-console --live-timeout-seconds 20 --live-max-messages 50
```

This writes only lines that start exactly `#runtime-summary ` under `/root/screeps/runtime-artifacts/runtime-summary-console/` by default, so the artifact bridge can consume them on its next scan. `SCREEPS_API_URL` defaults to `https://screeps.com`; `SCREEPS_CONSOLE_CHANNELS` or repeated `--console-channel` values can override the default requested channel list, which includes `console`. Command output reports counts, output path, and requested channels without printing tokens, headers, or raw artifact contents.

With no paths, the bridge scans safe local artifact roots such as `/root/screeps/runtime-artifacts` and `/root/.hermes/cron/output`, tolerates missing directories, skips binary/oversized files, and attaches source counts without file contents. Pass explicit files or directories to bound a review window:

```bash
python3 scripts/screeps_runtime_kpi_artifact_bridge.py /path/to/runtime-artifacts > runtime-kpi-report.json
```

Use `--format human` for a compact reviewer-facing readout. If a worker has only one raw saved console log and does not need artifact discovery, use the reducer fallback:

```bash
python3 scripts/screeps_runtime_kpi_reducer.py saved-runtime-summary.log > runtime-kpi-report.json
```

The reducer also accepts `-` for stdin. Both JSON outputs are deterministic and mark missing KPI sections as `not instrumented`.

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

## Strategy model self-evolution

The 8-hour review must evaluate three levels of strategy state:

1. **Parameter tuning** — numeric thresholds, weights, and urgency cutoffs inside an accepted model.
2. **Model revision** — adding/removing features or changing the scoring formula when evidence shows the current model misses important Screeps outcomes.
3. **Research-driven evolution** — opening formal research/paper tasks when the required model change is not obvious or may require reinforcement learning, offline evaluation, or private-server experimentation.

A strategy-model change may be accepted only when it states:

- the gameplay failure or opportunity it addresses;
- the affected vision layer: territory, resources, kills, or reliability prerequisite;
- the current model behavior and why it is insufficient;
- the proposed model change or research question;
- expected KPI movement and safety/rollback conditions;
- whether it is a heuristic update, experiment, autoresearch task, or RL-roadmap item.

### Expansion recommendation model

Each review must score visible/current candidate rooms and name the next room to occupy, reserve, or scout when evidence is sufficient. A 0-100 score should include controller state, distance and route safety, source/mineral/economic value, owner/reservation/hostile risk, logistics and construction cost, current-room ability to support expansion, and contribution to territory before resources before kills. If evidence is insufficient, the review must name the next observation/scout task instead of guessing.

### Construction priority model

Construction scoring is intentionally broader than a fixed checklist. The review should combine good Screeps practice with current evidence and optimize for winning game outcomes. A 0-100 construction priority score should consider:

- survival and recovery urgency: spawn availability, worker recovery, controller downgrade, tower/rampart/repair threats;
- energy throughput: extensions, containers, links, roads, dropped-resource salvage, spawn refill latency, harvest/haul bottlenecks;
- expansion enablement: roads to exits/remotes, remote containers, reserver/claimer logistics, forward defense, room-claim prerequisites;
- RCL progression and unlock timing: when a build accelerates extensions, towers, storage, terminal, labs, observer, power spawn, or nuker readiness;
- defense and loss avoidance: towers, ramparts, walls, safe-mode readiness, repair triage, hostile path exposure;
- CPU/pathing efficiency: whether a build reduces repeated movement, search, repair churn, or creep body inefficiency;
- opportunity cost: energy locked in construction vs upgrading/spawning/repairing, build time, worker travel, and risk of abandoned construction sites;
- strategic layer served: territory first, resources second, kills third, with reliability as a prerequisite guardrail.

The output must name the next primary construction item when evidence supports one. If not, it must name the missing instrumentation or scout/monitor task.

### RL self-evolution research track

Issue #232 tracks the formal autoresearch paper required before RL implementation. The first paper must define Screeps state/action/reward choices, offline/private-server evaluation, safety gates, and a staged roadmap from heuristic scoring to shadow evaluation to reinforcement-learning-assisted strategy iteration. RL reward functions must remain subordinate to the project vision: territory > resources > enemy kills.

## KPI and evidence schema

### North-star outcome KPIs

| Vision layer | KPI | First implementation target |
| --- | --- | --- |
| Territory | owned rooms, reserved/remote rooms, room gain/loss, RCL progress | external monitor + in-game telemetry summary fields |
| Resources | total stored energy/resources, harvest/collection deltas, GCL/RCL deltas, spawn utilization | in-game counters plus 8h window reducer |
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

Goal: make the bot and monitor emit enough cumulative data for an 8-hour review.

Initial tasks:

1. Extend runtime telemetry schema with territory/economy/combat KPI fields.
2. Add deterministic tests for KPI aggregation where feasible.
3. Add an external reducer that consumes saved `#runtime-summary` logs and emits territory/resource/combat KPI evidence.
4. Render or publish a concise KPI board for routine review.

Acceptance:

- Review report can list territory/resource/combat/reliability deltas without manual guessing.
- Missing fields are explicitly marked `not instrumented`, not silently omitted.

### Track 2 — 8-hour gameplay review worker

Goal: schedule a recurring analysis loop that recommends roadmap changes.

Initial tasks:

1. Create a self-contained cron prompt for `Screeps Gameplay Evolution Review`.
2. Run one manual dry run against current evidence.
3. Main agent accepts/rejects the dry-run output.
4. Enable every-8-hour cadence after dry-run success.

Acceptance:

- The worker reports the time window, evidence, KPI classification, bottleneck, recommended actions, emergency flag, and release recommendation.
- The main agent updates GitHub for every accepted action.

### Track 3 — Gameplay roadmap/task bridge

Goal: make review conclusions automatically become schedulable work without falling through cracks.

Runbook: `docs/ops/gameplay-finding-to-codex-bridge.md`.

Initial tasks:

1. Define issue templates/body structure for gameplay findings.
2. Add Project field updates for accepted findings.
3. Maintain priority order: territory > resources > enemy kills, with reliability as a prerequisite guardrail.
4. Dispatch Codex tasks only after the GitHub issue is clear and accepted.

Acceptance:

- Every accepted gameplay finding has a GitHub issue or a comment updating an existing issue.
- Every active issue has milestone, Project status, priority, domain, kind, evidence, and next action.
- Every Codex prompt generated from a finding states the evidence window, expected KPI movement, acceptance evidence, and rollback/stop condition.

### Track 4 — Tactical emergency response

Goal: avoid waiting 8 hours when an attack or collapse requires immediate action.

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

- Prefer at most one meaningful gameplay release per 8-hour review cycle.
- Require accepted roadmap issue, Codex implementation, typecheck/test/build, PR gate, QA `PASS`, and risk-appropriate runtime/private validation.
- Require the next 8-hour review to evaluate expected KPI movement.

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
2. **#60 — P1: Phase C: 8h gameplay evolution review loop is not automated**
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
4. Enable an 8-hour review job only after dry-run output is useful.
5. Dispatch Codex for KPI telemetry implementation under `prod/`.
6. Complete #232 autoresearch and formal paper before any RL implementation task.
7. Add reducer/reporting automation.
8. Wire tactical emergency response from runtime-alert outputs.
9. Update release gate docs and enforce via Project status / release checklist.

## Definition of done for the专项

- [ ] KPI framework exists and is source-backed.
- [ ] Strategy-model self-evolution requirements are in the 8-hour review contract.
- [ ] RL-driven self-evolution has a formal autoresearch paper before implementation.
- [ ] Runtime telemetry/monitor can provide territory/resource/combat/reliability deltas.
- [ ] 8-hour gameplay review job runs and produces an accepted report.
- [ ] Accepted findings update GitHub Issues/Milestones/Project before implementation.
- [ ] Codex receives concrete production-code tasks with acceptance criteria.
- [ ] Tactical emergency path handles attacks/collapse without waiting for cadence.
- [ ] Release gates distinguish normal gameplay releases from emergency hotfixes.
- [ ] QA verifies docs, GitHub state, scheduler state, and no-secret safety.
