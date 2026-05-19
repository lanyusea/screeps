# RL Domain Roadmap And Operating Contract

Status: P1 domain refresh for issue #430.
Owner correction: RL strategy evolution must stop being a single-point research track. It is a standing P1 domain with an integrated roadmap, active cadence, and landing gates.

## Goal

Build a safe strategy-change flywheel for Screeps:

```text
runtime data -> offline/shadow evaluation -> accelerated simulator/training
  -> historical official-MMO validation -> KPI-gated rollout/rollback
  -> online feedback ingestion -> next strategy revision
```

This domain exists to change game strategy, not merely to produce papers. The paper, registry, Overmind-RL audit, and first dataset exporter are foundation inputs; they are not the endpoint.

Canonical current strategy paper: `docs/research/2026-05-19-screeps-rl-flywheel-strategy-paper.md`. The older `docs/research/2026-04-29-screeps-rl-self-evolving-strategy-paper.md` remains the research foundation, but the 2026-05-19 paper is the operational source of truth for active #879 flywheel design, safety gates, observability, scale thresholds, and maintenance expectations.

## Safety boundary

No learned or tuned policy may directly control official MMO creep intents, spawn intents, construction intents, market orders, Memory writes, or RawMemory commands until all gates pass:

1. simulator evidence;
2. historical official-MMO validation;
3. private/shadow safety gate;
4. KPI rollout gate;
5. rollback gate.

Until then, outputs are offline/shadow/high-level recommendation only: construction priority, remote/expansion target, defense posture, bounded scoring weights, or experiment report.

## Roadmap lanes

| Lane | Purpose | GitHub source | Landing artifact | Cadence |
| --- | --- | --- | --- | --- |
| L0 Domain governance | Keep RL visible, P1, and non-fragmented | #430, #412 | this contract, Project fields, recurring reports | refresh every RL steward run |
| L1 Data substrate | Convert saved runtime/monitor artifacts into train/eval-ready samples | #409, #415 | `runtime-artifacts/rl-datasets/<run-id>/` with card/manifests | export after new artifact windows and before experiments |
| L2 Shadow evaluator automation | Run passive strategy comparisons over saved artifacts | #409, #417 | bounded strategy-shadow reports indexed by dataset exporter | scheduled/offline; must become recurring |
| L3 Simulator harness | Self-hosted accelerated parallel environment | #414, #413 | resettable scenario runner and throughput report toward 100x aggregate official tick speed | implementation lane until usable |
| L4 Training/reward framework | Select RL/bandit/evolutionary method and tune objective safely | #416, #266, #549 | experiment config, reward card, private-simulator training report | per experiment |
| L5 Historical validation | Test candidates against official-MMO historical windows before rollout | #417 | pass/fail validation report with OOD/reliability rejection | before any live influence |
| L6 KPI rollout/rollback | Deploy only gated high-level strategy changes, monitor, and revert on degradation | #418 | rollout decision, rollback plan, post-rollout KPI report | per candidate release |

## Implementation status

- L4: Training framework — implemented 2026-05-03 — `scripts/screeps_rl_training_runner.py` runs JSON/YAML experiment cards through the private simulator harness, computes lexicographic territory/resources/kills rewards with expansion-survival penalties, emits shadow-compatible JSON reports, and is covered by `scripts/test_screeps_rl_training_runner.py`. Supporting artifacts: `scripts/screeps_rl_experiment_card.py`, `docs/ops/rl-training-reward-workflow.md`, `docs/research/2026-05-03-rl-training-approaches.md`.
- 2026-05-19 PM reset: #879 is no longer allowed to behave as a loose umbrella. It now requires product-stage evidence for runtime candidate injection, 8c16g-scale utilization, #924 scorecard, owner-facing Grafana/SQLite observability, safe canary/rollback, online feedback-to-Act, autonomous cadence, and canonical strategy-paper maintenance.

## 2026-05-19 #879 product-stage gates

These gates are the active roadmap mapping for the current RL flywheel reset. A gate is not Done because foundation code exists; it is Done only when its evidence artifact is current and linked from the corresponding GitHub Project item.

| Gate | Issue | Domain | Required evidence | Blocks |
| --- | --- | --- | --- | --- |
| G0 Product stage ownership | #1235 | RL flywheel | This roadmap names every product gate, #879 Project fields point to leaf blockers, and steward reports distinguish construction/training/online/self-iteration state | #879 closure |
| G1 Runtime candidate injection | #1228/#1229 | RL flywheel | Candidate policy parameters are consumed by offline/private runtime and affect behavior, not merely metadata | #1032, #1238 |
| G2 Scale-first utilization | #1236 | RL flywheel | Tencent/private runs report env rows, simulator ticks, wall time, ASG active time, batch class, utilization, cost, and scale-down proof | #1032 |
| G3 Candidate scorecard | #1238 | RL flywheel | A #924-compatible candidate-vs-baseline scorecard exists for the runtime-injected candidate and is not `INCONCLUSIVE` for any improvement claim | #1239 |
| G4 Owner-facing observability | #1237 | RL flywheel | Grafana or equivalent dashboard exposes SQLite freshness, E1, Loop A, Loop B, Tencent utilization, scorecard, safety, feedback, and blockers | #879 owner visibility |
| G5 Safe canary/rollback | #1239 | RL flywheel | Bounded live influence surface, baseline/candidate/rollback refs, rollout-manager dry-run/rollback-check/compare artifacts | official MMO influence |
| G6 Feedback-to-Act loop | #1240 | RL flywheel | Online/gameplay finding is traced to reward/scenario/policy decision, experiment-card delta, training run, and scorecard outcome | self-iteration |
| G7 Canonical strategy maintenance | #1241 | RL flywheel | `docs/research/2026-05-19-screeps-rl-flywheel-strategy-paper.md` is published and future strategy changes update it or explicitly state why not | agent continuity |

Smoke-scale evidence cannot close scale-first training work. The current `5 workers x 5 repetitions x 500 ticks = 25 env rows / 12,500 simulator ticks` shape remains valid smoke/validation proof only; #1236 owns the minimum acceptable 8c16g utilization ladder.

## Current issue map

Completed foundation:

- #262 — full RL/self-evolving strategy research paper.
- #265 — passive strategy registry and shadow evaluator foundation.
- #413 — Overmind-RL architecture audit; reuse RPC-controlled backend, Gym/RLlib-style env, vectorized remote instances as design inputs.
- #415 — first bounded RL dataset export slice.

Active/next P1 roadmap:

- #430 — domain refresh and system roadmap.
- #412 — parent flywheel epic; should represent the integrated system, not a loose bucket.
- #409 — dataset/evaluation gate; bridge from artifacts to executable experiments.
- #414 — accelerated self-hosted simulator harness.
- #416 — training framework and reward workflow.
- #549 — real RL training runner implementation with lexicographic reward and private-simulator orchestration.
- #417 — historical official-MMO validation.
- #418 — KPI-gated rollout, rollback, online feedback ingestion.
- #266 — offline RL / hierarchical recommendation prototype; must wait for enough L1-L5 evidence and must remain offline-only initially.

Active #879 product-closure roadmap:

- #879 — execution umbrella; remains open until the product-stage flywheel repeats without owner prompting.
- #1032 — scale-first training campaign; cannot close from smoke-only batches.
- #1228/#1229 — runtime parameter injection for candidate policy consumption.
- #1231 — Loop A must consume fresh accepted E1 gates, not stale gate windows.
- #1232 — small policy gradients must not be rounded away.
- #1233 — steward/autonomous Tencent compute cadence after runtime injection and safety blockers clear.
- #1234 — metadata-only zero-iteration/no-op candidate updates must be accepted when safe, not false-fail successful compute.
- #1235 — productize #879 closure gates and stage ownership.
- #1236 — enforce 8c16g scale-first utilization gates and batch classification.
- #1237 — restore owner-facing Grafana/SQLite observability.
- #1238 — produce runtime-injected #924 candidate scorecard.
- #1239 — wire safe RL candidate canary and rollback path for official MMO.
- #1240 — close online feedback to reward/scenario/policy iteration loop.
- #1241 — publish and maintain the canonical Screeps RL strategy paper.

## Data contract

Default input roots:

```text
/root/screeps/runtime-artifacts
/root/.hermes/cron/output
runtime-artifacts
```

Accepted input classes:

- exact-prefix `#runtime-summary` console artifacts;
- JSON runtime-summary artifacts;
- runtime monitor summary JSON;
- room snapshot artifacts from runtime summary/alert lanes;
- strategy-shadow replay reports as bounded metadata;
- strategy registry metadata from `prod/src/strategy/strategyRegistry.ts`.

A tick sample must expose:

- observation: tick, room, shard, energy, workers/tasks, spawn state, controller, resources, combat, CPU, reliability, monitor counters;
- action labels: high-level offline labels such as `construction-priority` and `expansion-remote-candidate`, always `liveEffect: false`;
- reward components: reliability, territory, resources, kills; scalar reward remains `null` until an experiment card explicitly preserves this order.

Generated datasets stay local derived artifacts by default:

```text
runtime-artifacts/rl-datasets/<run-id>/
  scenario_manifest.json
  run_manifest.json
  source_index.json
  ticks.ndjson
  kpi_windows.json
  episodes.json
  dataset_card.md
```

## Cadence contract

Existing cadence:

- continuation worker: every 20 minutes, overall task dispatch;
- research-notes reporter: every 30 minutes; every non-silent report must include RL progress;
- runtime alert/image check: every 15 minutes, one runtime artifact source;
- runtime room summary: hourly, one runtime artifact source;
- Gameplay Evolution review: every 8 hours;
- RL flywheel steward: every 6 hours.

Required correction:

- RL flywheel steward must always choose at least one executable RL lane unless a hard P0 fully saturates capacity.
- Shadow evaluator automation is not complete while it is manual/test-only. The next executable lane is to create a recurring/offline job that consumes saved runtime-summary/room-snapshot artifacts, runs active registry candidates, stores bounded strategy-shadow reports, and feeds those reports into the dataset/historical-validation path.
- Reports must distinguish `no new RL evidence` from `RL lane blocked`; silent omission is not allowed.

## Gate model

A strategy candidate can advance only in this order:

1. **Dataset gate** — input artifacts have source index, dataset card, train/eval split, and no raw secret/raw artifact copy.
2. **Shadow gate** — candidate changes ranking or recommendations in explainable ways, without live effects.
3. **Simulator gate** — candidate improves in resettable/parallel scenarios with throughput and determinism evidence.
4. **Historical gate** — candidate passes official-MMO historical windows and OOD/reliability rejection.
5. **Private/shadow live gate** — candidate runs as recommendation-only or private-shadow without official MMO control.
6. **Rollout gate** — limited high-level strategy rollout with rollback trigger and owner-visible KPI plan.
7. **Feedback gate** — post-rollout data is ingested into the next dataset/experiment window.

Productized #879 closure adds these stronger management requirements:

- A candidate cannot leave training if #1229 runtime-parameter injection has not proven that policy parameters are consumed by the evaluated runtime.
- #1032 cannot close from smoke-only batches; #1236 scale class must be validation, normal-scale, or large-campaign according to explicit env-row/tick thresholds.
- A rollout claim requires #1238 scorecard evidence, not only Loop A training evidence or a merged code PR.
- Owner-visible observability is a gate: #1237 must expose Grafana or equivalent SQLite-backed dashboard state before #879 can claim a mature flywheel.
- Official MMO live influence requires #1239 canary/rollback artifacts and remains limited to bounded high-level strategy knobs.
- Self-iteration requires #1240 to trace at least one online/gameplay finding through reward/scenario/policy decision, experiment-card delta, training, and scorecard outcome.

## First three landing slices

### Slice A — scheduled shadow-eval report generation

Target issues: #409, #417.

Deliverables:

- script or cron-compatible command to collect recent saved artifacts;
- run `evaluateStrategyShadowReplay` over active registry candidates;
- write bounded report files under `runtime-artifacts/strategy-shadow/` or an equivalent ignored local artifact path;
- update dataset exporter to index these reports when present;
- research-notes summary showing report count, changed-top count, candidate families, and blockers.

Verification:

- unit/fixture coverage;
- run on at least one saved artifact window;
- `liveEffect: false` preserved;
- no raw secrets or raw log copying.

### Slice B — simulator harness design-to-smoke

Target issue: #414.

Deliverables:

- documented adapter design from Overmind-RL audit to current repo;
- dry-run manifest generator and contract: `scripts/screeps_rl_simulator_harness.py` and `docs/ops/rl-simulator-harness.md`;
- local/private Screeps server scenario definition;
- reset/seed contract;
- tick-throughput measurement;
- target plan toward 100x aggregate throughput via parallel workers.

Verification:

- smoke run with deterministic reset evidence;
- throughput report;
- no official MMO writes.

### Slice C — reward/training experiment card

Target issues: #416, #266.

Deliverables:

- compare contextual bandit, evolutionary tuning, RLlib/SB3-style policy training;
- define initial reward as lexicographic components, not an unsafe scalar shortcut;
- specify OOD/conservative rejection;
- produce one offline high-level recommendation baseline.
- durable workflow: `docs/ops/rl-training-reward-workflow.md`;
- executable offline experiment-card helper: `scripts/screeps_rl_experiment_card.py`.
- executable training runner: `scripts/screeps_rl_training_runner.py`;
- unit coverage for lexicographic reward, expansion survival, card loading, ranking, and JSON report shape.

Verification:

- experiment card links dataset run ID and code commit;
- generated/validated cards preserve `liveEffect:false`, `officialMmoWrites:false`, and `officialMmoWritesAllowed:false`;
- training runner reports preserve `liveEffect:false`, `officialMmoWrites:false`, and `officialMmoWritesAllowed:false`;
- expansion rooms count as territory only when they survive with spawns and creeps at the end of simulation;
- candidate cannot advance without #417 historical validation.

## Reporting format

Every RL progress report should include:

```text
RL progress:
- lane: <L1/L2/...>
- issue: #<number>
- last artifact/evidence: <dataset run/report/PR/commit or none>
- blocker: <none or exact blocker>
- next action: <one executable action>
- safety state: offline/shadow/private/historical/rollout
```

## Definition of done for this refresh

#430 is complete only when:

- this roadmap is merged to `main`;
- #412 Evidence/Next action point to this integrated contract;
- #409/#417 identify scheduled shadow-eval as the next landing slice;
- the RL flywheel steward prompt is updated to enforce lane selection and report format;
- #task-queue and #research-notes receive the refresh summary.

2026-05-19 #879 reset is complete only when:

- #1235 records the stage-gate contract in this roadmap and #879 Project fields point at the active leaf blockers;
- #1241 publishes the canonical strategy paper and future RL strategy changes must update it or justify why it remains current;
- #1237 provides owner-facing Grafana/SQLite/dashboard evidence, not just local static artifacts;
- #1236 classifies training scale and prevents 5x5x500 smoke evidence from closing scale-first work;
- #1238 produces a runtime-injected #924 scorecard;
- #1239 proves canary/rollback readiness before any official MMO influence;
- #1240 proves at least one online feedback-to-Act iteration;
- #879 remains open until the whole train/evaluate/scorecard/rollout/feedback cycle repeats without owner prompting.
