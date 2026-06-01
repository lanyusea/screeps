<!-- markdownlint-disable MD013 MD024 MD034 -->

# Screeps RL Flywheel Strategy Paper

Status: historical RL strategy paper; strategy content remains useful, but active project management is superseded by `docs/ops/rl-progress-management-v2.md`.
Date: 2026-05-19  
Scope: Screeps: World official MMO bot, private/offline simulator training, Tencent batch compute, scorecard-gated rollout, and online-feedback-driven self-iteration.  
For current authoritative tracking, use Project `screeps` atomic Issues/PRs with `Domain = RL flywheel`; #879 is historical context only and #1589 is migration-only.
Supersedes as the strategy foundation: `docs/research/2026-04-29-screeps-rl-self-evolving-strategy-paper.md`; superseded for active PM by `docs/ops/rl-progress-management-v2.md`.

## Abstract

This paper specifies the current Hermes Screeps RL flywheel as an engineered self-evolution system rather than a loose research direction. Screeps is a persistent, partially observable MMO RTS where the player deploys code instead of issuing manual commands. That makes reinforcement learning attractive because strategy quality can be evaluated over long windows, but dangerous because live mistakes can lose rooms, waste CPU, corrupt persistent `Memory`, or optimize a proxy metric that conflicts with the project vision.

The Hermes approach is therefore **not** direct online RL over official MMO creep intents. The flywheel trains and evaluates bounded high-level strategy policies offline/private first. A candidate may only move toward official MMO influence after passing staged gates: data quality, experiment-card safety, runtime candidate-parameter injection, scale-first private training, candidate-vs-baseline scorecard, safe canary/rollback, and online feedback ingestion. The reward model is lexicographic: reliability is a hard floor, then territory, then resources, then kills. Later objectives cannot compensate for earlier-objective regressions.

The system is currently partially built but not closed. It has E1 dataset gates, Loop A training ledgers, Loop B policy-advantage ledgers, a private/Tencent training runner, SQLite metrics, dashboard scripts, reward/scorecard/rollout contracts, and active runtime-parameter injection work. It does **not** yet have a proven online self-iteration loop: #1229 must land, #1236 must prevent smoke batches from masquerading as scale-first training, #1237 must restore owner-facing Grafana/observability, #1238 must produce a real #924-compatible scorecard, #1239 must wire safe canary/rollback, and #1240 must close the online feedback-to-reward/scenario/policy Act loop.

## 1. Problem definition

### 1.1 Screeps as a learning environment

Screeps: World is a persistent RTS programming environment. The bot's exported `loop` runs on every game tick, updates a partially observed world, and stores durable state in `Memory`/`RawMemory`. Official MMO state cannot be reset, opponents are non-stationary, visibility is partial, and strategic decisions can take thousands of ticks to reveal consequences.

For this project, the official operating target is the `main` branch on shard `shardX`, with the currently owner-approved room context recorded in `AGENTS.md`. The durable project vision is ordered:

1. **Reliability prerequisite:** do not crash, lose spawn recovery, corrupt memory, or run unsafe official writes.
2. **Territory:** claim, hold, defend, and coordinate a sufficiently large footprint of rooms.
3. **Resources:** convert territory into energy, minerals, infrastructure, logistics, and market-capable value.
4. **Kills/combat:** destroy hostiles and win fights only after territory and economy foundations are protected.

RL is a mechanism for strategic self-improvement. It is not allowed to override this ordered game vision.

### 1.2 Why direct online RL is prohibited initially

Direct online RL over official MMO creep intents is unsafe because:

- official MMO mistakes are irreversible on the training timescale;
- a bad policy can lose rooms, trigger controller downgrade, or strand creeps;
- CPU and bucket usage are part of gameplay and can be exhausted by exploratory behavior;
- persistent `Memory` and `RawMemory` can be corrupted by unvalidated controllers;
- data is non-stationary because opponents and the bot's own code change asynchronously;
- live rewards are sparse, delayed, and easy to mis-specify.

Therefore the first production-grade learning surface is not raw actions. It is **bounded high-level strategy parameters** validated by deterministic bot code. Examples include construction-priority weights, expansion/remote scoring presets, defense posture presets, and policy version selection. The learned system may propose; deterministic production validators decide whether anything can influence official MMO behavior.

## 2. System thesis

The system should become a persistent, observable, self-iterating loop:

```text
Official/private data
  -> E1 dataset and quality gates
  -> safe experiment card
  -> offline/private/Tencent training
  -> candidate policy parameters
  -> runtime-injected simulator validation
  -> candidate-vs-baseline scorecard
  -> safe shadow/canary/rollback gate
  -> official MMO observation
  -> reward/scenario/policy Act decision
  -> next experiment card
```

The loop succeeds only when it can run without the owner repeatedly prompting it to notice missing steps. GitHub Issues/Project manage construction work; SQLite/Grafana/dashboard surfaces process and metric state; runtime artifacts preserve the evidence chain; scorecards gate any improvement claim.

## 3. Current implementation map

### 3.1 Implemented control-plane components

| Component | Primary artifact | Current role |
| --- | --- | --- |
| RL domain roadmap | `docs/ops/rl-domain-roadmap.md` | Domain contract and roadmap gate source. |
| Strategy/reward workflow | `docs/ops/rl-training-reward-workflow.md` | Experiment-card, reward, training, and promotion workflow. |
| Reward decision registry | `docs/ops/rl-reward-decision-registry.md`, `docs/ops/rl-reward-registry.yaml`, `docs/ops/rl-reward-schema.yaml` | Explicit reward-change governance. |
| Gameplay metric taxonomy | `docs/ops/rl-gameplay-metrics-taxonomy.md` | Metric definitions and promotion rules. |
| Rollout/rollback workflow | `docs/ops/rl-rollout-rollback.md`, `scripts/screeps_rl_rollout_manager.py` | Dry-run rollout and rollback evidence helper. |
| Live dashboard runbook | `docs/ops/rl-live-dashboard-runbook.md` | Local dashboard/SQLite runbook. Needs #1237 live owner-facing surface. |
| Tencent batch runbook | `docs/ops/tencent-batch-rl-runbook.md` | ASG/COS/controller operating details. |
| E1 gates | runtime artifacts under `runtime-artifacts/rl-dataset-gates/` and `runtime-artifacts/rl-control-loop/gate-data/` | Dataset acceptance and data-quality gating. |
| Loop A ledger | `runtime-artifacts/rl-control-loop/*-training-ledger.json` | Proves whether training ran; counts env/ticks/policy updates/anomalies. |
| Loop B ledger | `runtime-artifacts/rl-control-loop/*-policy-advantage.json` | Proves whether candidate policy has online advantage. |
| SQLite metrics | `runtime-artifacts/rl-metrics/rl_metrics.sqlite` | Long-term metrics substrate for dashboards. |
| Dashboard scripts | `scripts/screeps_rl_dashboard.py`, `scripts/screeps_rl_live_dashboard.py`, `scripts/screeps_rl_metrics_ingestor.py` | HTML/live-service/SQLite summary surfaces. |

### 3.2 Implemented training and validation scripts

| Script | Purpose |
| --- | --- |
| `scripts/screeps_rl_experiment_card.py` | Generate and validate offline/shadow experiment cards with safety fields and reward model. |
| `scripts/screeps_rl_training_runner.py` | Execute simulator/private training from an experiment card, produce training reports and candidate evidence. |
| `scripts/screeps_rl_simulator_harness.py` | Orchestrate private-server simulator workers and scenario runs. |
| `scripts/screeps_tencent_batch_rl_runner.py` | Launch bounded Tencent ASG batch compute, transfer artifacts, enforce scale-down/safety. |
| `scripts/screeps_rl_mmo_validator.py` | Historical official-MMO validation helper before rollout. |
| `scripts/screeps_rl_rollout_manager.py` | Rollout dry-run, rollback-check, and post-rollout comparison records. |
| `scripts/screeps_rl_metrics_ingestor.py` | Ingest runtime/RL artifacts into SQLite metrics tables. |

### 3.3 Current live evidence snapshot

As of the 2026-05-19 PM reset:

- Tencent batch artifacts: 54 remote training reports were found.
- Safety scan: no report had `liveEffect=true`; no report had `officialMmoWrites=true`.
- Aggregate recent training evidence: 1303 successful env rows, 27 failed env rows, 355,500 simulator ticks, 1303 artifacts, 216 model reports, and 9 known policy-update iterations.
- Latest Loop A window: `RUN_WITH_ANOMALY`, 99 completed environments, 1 failed environment, 49,500 simulator ticks, 2 policy-update iterations.
- Latest Loop B state: `MIXED`, not `POSITIVE` and not rollout-ready.
- Current Tencent per-batch default: `5 workers x 5 repetitions x 500 ticks = 25 env rows / 12,500 ticks`, which is smoke scale only, not validation scale or scale-first 8c16g training.
- SQLite metrics database exists and is populated, but no owner-facing Grafana/live dashboard service was running at the time of audit.

## 4. Project-management correction

### 4.1 The previous failure mode

The project had many useful construction items, but #879 became an umbrella with no product-grade closure contract. Agents could say that infrastructure existed or that a smoke batch ran, while the real product goal remained unclosed:

```text
RL flywheel上线到游戏中 -> 持续闭环改进 -> 算法自进化
```

The failure was not lack of issues. The failure was missing stage ownership and acceptance artifacts for the whole loop.

### 4.2 Superseding rule: no new umbrella

The 2026-05-19 correction still treated #879 as the product closure surface. The newer correction in `docs/ops/rl-progress-management-v2.md` is stricter: **no issue may be the RL flywheel garbage bin**. Active status comes from Project `screeps` atomic issues with `Domain = RL flywheel`; #879 is historical and #1589 is only a bounded migration ticket.

The old product gates map to atomic owners instead of one umbrella:

| Gate | Atomic owner | Required evidence |
| --- | --- | --- |
| Runtime/live canary | #1583 | Bounded high-level canary, rollback dry-run, health gate, post-rollout KPI evidence. |
| Role-scoped policy families | #1585 | Separate worker/harvester/defender data, training, scorecards, and gates. |
| Fresh candidate differentiation | #1588 | Fresh Loop A candidate-vs-baseline differentiation or a concrete blocker. |
| Objective activation proof | #1566 | Trusted objective/scalar evidence before paid validation. |
| Conclusion registry hygiene | #1543 | Stale/open conclusions routed to atomic issues or closed with evidence. |
| Scale / compute cadence | #1032/#1233 | Validation-scale rows/ticks/utilization/cost/scale-down evidence and safe autonomous cadence. |
| Owner-facing observability | #1576 and dashboard issues | Grafana/dashboard freshness and acceptance evidence. |
| Reward decisions | #1555 and decision issues | Explicit decision record and scorecard impact. |

### 4.3 Definition of Done for an atomic RL issue

An RL issue can only be Done when its own acceptance criteria are met:

1. **The deliverable is named.** A role lane, canary, scorecard, dashboard, reward decision, or compute cadence item is closed by its own evidence, not by a broad flywheel claim.
2. **Candidate parameters are real when claimed.** A trained/tuned candidate is injected into offline/private runtime and produces behavior evidence, not only metadata.
3. **Training scale is honest.** Smoke runs remain smoke; scale-first claims require explicit env rows, simulator ticks, utilization, cost, and scale-down proof on the scale/cadence issue.
4. **Scorecard is real.** A candidate-vs-baseline scorecard exists and is not `INCONCLUSIVE` for any claimed improvement.
5. **Safety is preserved.** Training/evaluation artifacts keep `liveEffect=false`, `officialMmoWrites=false`, and `officialMmoWritesAllowed=false` until a separate bounded rollout gate approves limited influence.
6. **Canary/rollback is wired before live influence.** Any live influence is bounded, logged, reversible, and protected by rollout-manager rollback checks.
7. **Feedback changes the next experiment.** At least one online/gameplay finding is traced into a reward/scenario/policy decision and a next experiment card.
8. **Observability is owner-facing when claimed.** The owner can see gate freshness, training scale, policy advantage, scorecard, safety, utilization, and blockers in Grafana or an equivalent live dashboard.
9. **Project fields are current.** The issue/PR Project item has `Status`, `Evidence`, `Next action`, and `Blocked by` consistent with the latest proof.

No broad issue, including #879 or #1589, can satisfy this checklist for another issue.

## 5. Data architecture

### 5.1 Source artifacts

The flywheel consumes durable local artifacts, not chat prose:

- in-game `#runtime-summary` console captures;
- runtime monitor summary/alert artifacts;
- official deploy evidence;
- room snapshots and runtime summaries;
- E1 dataset gate reports;
- private simulator run summaries;
- Tencent controller summaries and remote training reports;
- Loop A and Loop B JSON ledgers;
- scorecards and rollout-manager records;
- GitHub issue/PR/project evidence.

### 5.2 Dataset gate

The E1 gate decides whether runtime evidence is usable for training/evaluation. A valid sample window should expose:

- tick/window metadata;
- room/shard identity;
- spawn/creep/task counts;
- controller/RCL/progress;
- energy/storage/worker-carried metrics;
- construction/infrastructure state;
- hostile/combat evidence;
- CPU/reliability fields where available;
- code/deploy/strategy version when known.

Rejected samples are not wasted. Rejection distributions identify telemetry, scenario, or gameplay gaps.

### 5.3 SQLite metrics substrate

The SQLite store is the durable structured observation surface. Current expected tables include:

- `rl_dataset_gate_metrics`;
- `rl_training_execution_metrics`;
- `rl_policy_advantage_metrics`;
- `runtime_room_metrics`;
- `metric_observations`;
- `metric_coverage_gaps`;
- `gameplay_behavior_findings`;
- `metric_iteration_decisions`.

SQLite is not merely archive storage. It is the source for Grafana/dashboard trend panels and for repeated/severe metric-gap promotion into GitHub construction issues.

### 5.4 Observability contract

The owner-facing dashboard must answer:

1. Is the data fresh?
2. Did training actually run?
3. Was the batch smoke, validation, normal-scale, or large-campaign?
4. Which candidate policy was evaluated?
5. Is online utility `UNPROVEN`, `MIXED`, `POSITIVE`, `NEGATIVE`, or `ROLLBACK_REQUIRED`?
6. Does a scorecard exist?
7. Are safety flags intact?
8. Are Tencent ASG workers currently scaled down?
9. Which GitHub issue blocks the next gate?

#1237 owns restoring this as a live owner-facing Grafana/SQLite surface rather than a static-only artifact.

## 6. Experiment card contract

An experiment card is the executable specification for a training/evaluation run. It must include:

- `card_id`;
- `dataset_run_id` and `gate_id`;
- `code_commit`;
- `status: "shadow"`;
- `training_approach`: currently `policy_gradient`, `bandit`, or `evolutionary` depending on lane;
- `simulation`: room, shard, code path, map source, worker count, repetitions, ticks, simulator output path;
- `scenario`: for current policy-gradient work, `multi-tier-territory-combat-v0` with active hostile/adjacent-room fixture evidence;
- `strategy_variants` or candidate policy parameters;
- `reward_model` preserving lexicographic order;
- `safety` with all live/official write flags false.

Required safety block:

```json
{
  "liveEffect": false,
  "officialMmoWrites": false,
  "officialMmoWritesAllowed": false,
  "conservative_actions_only": true,
  "ood_rejection": true
}
```

The card generator and training runner should reject missing or unsafe fields. A card that merely looks safe in prose is invalid.

## 7. Policy design

### 7.1 Safe action surface

The first learned/tuned policy surface is high-level and bounded:

| Policy surface | Example parameters | Why safe enough for first candidates |
| --- | --- | --- |
| Construction priority | extension/container/tower/rampart/road/storage weights | Deterministic builder still validates site availability, RCL, energy, and safety. |
| Expansion/remote scoring | distance, source count, hostile risk, reservation/claim priority | Deterministic expansion code can enforce GCL, room safety, and no-new-room constraints when applicable. |
| Defense posture | tower/rampart/repair urgency, threat response preset | Emergency defense logic remains deterministic and can veto. |
| Spawn/economy mix | worker/upgrader/builder ratios within bounds | Spawn planner validates energy and recovery constraints. |
| Policy version selection | choose among reviewed strategy versions | Rollback is version switch, not free-form action. |

Direct tick-level creep action control remains out of scope.

### 7.2 Runtime candidate injection

A candidate is not real if it only exists in metadata. Runtime injection must prove that policy parameters are passed into the simulator/bot evaluation path and can change decisions. #1228/#1229 owns this requirement.

Required evidence after #1229:

- candidate parameter set recorded in experiment card/training report;
- runtime harness consumes the candidate set;
- behavior/ranking/score differs when parameters differ;
- tests prevent object-reuse or state-contamination bugs;
- scorecard uses the same candidate identity that training used.

### 7.3 Policy identity

Every candidate should have a stable identity:

```text
<family>.<approach>.<run-id>.<hash>.v<version>
```

It should link:

- source issue/PR;
- experiment card;
- training report;
- model/parameter artifact;
- scorecard;
- rollout/canary status;
- rollback outcome if applicable.

## 8. Reward design

### 8.1 Lexicographic order

The reward contract is:

```text
Reliability gate -> Territory -> Resources -> Kills
```

Reliability is a hard floor. Once reliability passes, territory is optimized first. Resources only matter when territory is non-regressing. Kills only matter after territory and resources are acceptable.

This prevents unsafe compensation, such as a candidate losing territory but collecting more short-term energy or kills.

### 8.2 Components

Reliability:

- no loop exceptions;
- no telemetry silence;
- no spawn recovery deadlock;
- no controller downgrade risk;
- CPU/bucket stays safe when available;
- safety flags remain false for training/evaluation.

Territory:

- owned room count and survival;
- controller/RCL progress;
- claim/reserve success;
- remote uptime;
- room-loss avoidance;
- expansion room survival with spawn and owned creep at end of simulation.

Resources:

- harvested/collected energy;
- stored energy delta;
- carried energy and logistics throughput;
- infrastructure progress;
- sustainable remote income.

Kills/combat:

- hostile creep/structure kills;
- own losses;
- hostile damage denied;
- tower/rampart readiness;
- objective defense success.

### 8.3 Reward decision governance

Reward changes are not hidden prompt edits. They must be GitHub-managed decisions with:

- metric evidence;
- gameplay hypothesis;
- affected component and version;
- expected KPI movement;
- validation window;
- rollback criteria;
- linked candidate/training run;
- scorecard requirement.

#907 is the foundation. #1240 owns the recurring Act loop that turns online findings into reward/scenario/policy changes.

## 9. Training framework

This training framework design separates data admission, execution proof, policy advantage proof, and compute utilization so the project can debug each loop stage independently instead of treating "training ran" as one opaque status.

### 9.1 E1 — data and shadow gate

E1 produces dataset/gate artifacts from runtime summaries and related evidence. It answers whether the input data is current, safe, and sufficiently structured.

Output examples:

- gate status;
- accepted/rejected sample counts;
- rejection reasons;
- dataset run ID;
- safety flags;
- changed-top or ranking evidence when available.

### 9.2 Loop A — training execution ledger

Loop A is a metrics producer. It must prove whether training ran and report:

- data groups traversed;
- environment requested/started/completed/failed counts;
- simulator ticks requested/run;
- episodes;
- policy update iterations;
- training report IDs;
- artifacts/model reports;
- anomalies and next capability action.

It must not call smoke-scale runs large training. #1236 adds the batch classification gate.

### 9.3 Loop B — policy advantage ledger

Loop B is also a metrics producer. It must prove whether a candidate policy has useful advantage. It reports:

- candidate policy ID;
- baseline identity;
- online utility status;
- metric advantages/regressions;
- scorecard availability;
- next experiment card delta;
- reward/scenario/policy feedback.

Loop B status `MIXED` is not success. It means the pipeline has signals but no positive online proof.

### 9.4 Private and Tencent training

Training can run locally/private or on Tencent ASG batch workers.

Tencent batch principles:

- ASG desired=0 when idle;
- spot/竞价 resources preferred;
- billing guard below the owner threshold;
- artifacts returned to local/COS-equivalent storage;
- safety flags false;
- scale-down proof after every paid run;
- no official MMO writes from training.

### 9.5 Current policy-gradient lane

Current policy-gradient work uses a multi-tier territory/combat scenario and candidate construction-priority parameters. Known active blockers:

- #1229: runtime injection must prove candidate params are consumed;
- #1232: small nonzero gradients must not disappear due to integer step rounding;
- #1234: zero-iteration metadata-only no-op policy updates must be accepted when safe rather than false-failing a successful compute run;
- #1231: Loop A must not consume stale gates when fresher accepted gates exist.

## 10. Simulation scale and utilization

### 10.1 Why 5x5x500 is smoke

The formula:

```text
5 workers x 5 repetitions x 500 ticks = 25 env rows / 12,500 simulator ticks
```

means five parallel worker slots, five repetitions each, and 500 simulator ticks per environment row. It is useful to prove worker startup, artifact return, and safety. It is not sufficient to exploit an 8c16g batch worker for scale-first RL.

### 10.2 Scale ladder

The production scale ladder enforced by #1236 is:

| Class | Minimum size | Purpose |
| --- | --- | --- |
| Smoke | <50 env rows or <50k ticks | Prove runner/safety/artifact path. |
| Validation | >=200 env rows and >=200k ticks | Prove post-fix runtime injection and scorecard readiness. |
| Normal scale-first | >=400 env rows and >=400k ticks | Produce meaningful candidate evaluation data. |
| Large campaign | >=800 env rows and >=1.6M ticks | Mine failure distribution and drive strategy iteration. |

Recommended 8c16g ramp after blockers clear:

```text
8 workers x 25 repetitions x 1000 ticks = 200 env rows / 200,000 ticks
8 workers x 50 repetitions x 1000 ticks = 400 env rows / 400,000 ticks
8 workers x 100 repetitions x 2000 ticks = 800 env rows / 1,600,000 ticks
```

Worker count should rise only after a resource guard; repetitions and ticks should rise first when safe.

### 10.3 Utilization evidence

Every paid batch report should include:

- run ID;
- ASG ID and instance type;
- started/finished time;
- active wall time;
- desired/instance count at cleanup;
- env rows and success rate;
- simulator ticks;
- artifact/model report counts;
- policy update iterations;
- batch class;
- estimated cost;
- safety flags.

## 11. Scorecard and promotion

#924 is the scorecard contract source. A current candidate still needs a concrete scorecard artifact.

### 11.1 Required scorecard contents

A scorecard must include:

- candidate policy ID;
- incumbent/baseline ID;
- training report IDs;
- scenario and dataset IDs;
- reliability outcome;
- territory outcome;
- resource outcome;
- kills/combat outcome;
- OOD/conservative status;
- scorecard decision: `PASS`, `HOLD`, `MIXED`, `ROLLBACK_REQUIRED`, or `INCONCLUSIVE`;
- missing-data list;
- linked GitHub issues/PRs.

### 11.2 Promotion rule

No candidate may be described as improved unless the scorecard supports it. Missing scorecard means unknown, not success. Merge of a training PR is not policy improvement evidence.

#1238 owns the first runtime-injected candidate scorecard after #1229.

## 12. Rollout, canary, and rollback

The initial official MMO live surface must be conservative:

1. recommendation-only or shadow first;
2. bounded high-level knob canary only after scorecard gate;
3. deterministic validators can veto;
4. pre-window and post-window are recorded;
5. rollback ref exists before canary;
6. rollback check can fire before the full observation window closes;
7. canary outcome is fed back into the next dataset window.

#1239 owns the productized path from candidate to official MMO canary/rollback evidence. The existing rollout manager is a helper; the issue closes only when it is wired into the actual candidate lifecycle.

## 13. Online feedback and self-iteration

A flywheel is not self-iterating unless online feedback changes the next training job. The Act loop is:

```text
Loop B / Gameplay Evolution finding
  -> classify root cause
  -> reward/scenario/policy decision
  -> GitHub issue or reward decision artifact
  -> experiment card delta
  -> training run
  -> scorecard
  -> rollout or rejection
```

Root-cause classes:

- data-quality gap;
- scenario gap;
- reward gap;
- policy-parameterization gap;
- runtime/injection bug;
- rollout regression;
- observability gap.

#1240 owns the recurring mechanism. #906/#907 are foundation contracts, not proof that Act is running continuously.

### 13.1 Data backflow contract

Data backflow is the operational path by which online and private evidence becomes the next training input. The minimum record for each backflow event is:

- source evidence: runtime summary, Loop B finding, gameplay review, scorecard, or rollout comparison;
- classification: data-quality gap, scenario gap, reward gap, policy-parameterization gap, runtime bug, rollout regression, or observability gap;
- decision artifact: reward decision, scenario delta, policy-parameter delta, or construction issue;
- experiment-card delta: exact dataset/gate/scenario/policy change to run next;
- verification path: Loop A run, Loop B result, scorecard status, and rollout/rollback outcome when applicable.

The dashboard should expose this chain as finding -> decision -> card -> training -> scorecard so a future agent can see whether feedback truly changed the next iteration.

## 14. Observability and Grafana

The owner must be able to see the process operate. The dashboard is part of the product, not optional polish.

Required views:

1. **Overview:** current gate state, candidate, blocker, next action.
2. **E1 data:** latest gate freshness, accepted/rejected samples, rejection reasons.
3. **Loop A training:** env rows, ticks, episodes, policy updates, anomalies, batch class.
4. **Loop B advantage:** utility status, metric deltas, candidate/baseline identity.
5. **Tencent utilization:** active time, scale-down proof, cost, utilization target, and smoke/validation/normal-scale/large-campaign classification.
6. **Scorecard:** current decision and missing evidence.
7. **Safety:** live/official write flags, OOD/conservative status.
8. **Feedback Act:** finding -> decision -> card -> training -> scorecard trace.
9. **Project state:** atomic Project `screeps` items with `Domain = RL flywheel`, `Status`, `Evidence`, `Next action`, and `Blocked by`.

Historical status: SQLite exists and is populated; this 2026-05-19 paper no longer owns active PM routing. Use `docs/ops/rl-progress-management-v2.md` plus live Project `Domain = RL flywheel` Issues/PRs for current state.

## 15. Safety policy

Hard rules:

- training/evaluation must preserve `liveEffect=false`, `officialMmoWrites=false`, and `officialMmoWritesAllowed=false`;
- no learned policy can write official MMO state before canary approval;
- no raw creep/spawn/construction/market intent authority for learned policies;
- Memory/RawMemory writes remain deterministic production-code responsibility;
- scorecards must treat missing data as unknown, not success;
- closed Done issues are not reopened for corrected scope;
- reward changes require explicit GitHub-managed decisions;
- deployment/rollout claims require evidence from the latest current state, not stale artifacts.

## 16. Maintenance contract

This paper is historical/context-only for active PM. It remains useful strategy background, but the authoritative current routing contract is `docs/ops/rl-progress-management-v2.md` plus live Project `screeps` Issues/PRs with `Domain = RL flywheel`. PRs that change reward policy, policy surfaces, experiment cards, Tencent batch shape, scorecards, observability, or live influence should update the current contract/runbooks when they affect active routing; update this paper only when preserving historical strategy context requires it.

## 17. Historical roadmap at the time of this paper

The immediate ordering below is preserved as historical context from the 2026-05-19 reset. Do not use this section as the active queue; translate any still-valid item into the smallest open Project `Domain = RL flywheel` issue/PR.

Historical ordering:

1. Finish #1229 runtime candidate-parameter injection.
2. Land #1235/#1241 documentation and stage-gate contract.
3. Implement #1236 scale utilization classification and stop counting smoke as campaign training.
4. Restore #1237 owner-facing Grafana/SQLite dashboard.
5. Resolve #1233 autonomous compute cadence and #1234 no-op false-fail.
6. Run a validation-scale or better runtime-injected compute batch.
7. Generate #1238 #924-compatible candidate scorecard.
8. If scorecard permits, wire #1239 safe canary/rollback.
9. Trace first online finding through #1240 into a reward/scenario/policy update and new experiment card.
10. Historical 2026-05-19 note: #879 was then left open until the loop repeated without owner prompting; this is superseded by `docs/ops/rl-progress-management-v2.md`, which forbids #879 as an active queue or completion proxy.

## 18. Why this design is advanced and robust

The design combines several strengths:

- **Safety-first RL:** official MMO writes are separated from training/evaluation.
- **Lexicographic objectives:** the bot cannot trade territory or reliability for later-objective vanity metrics.
- **Bounded policy surfaces:** learning optimizes strategic knobs instead of unsafe raw actions.
- **Artifact-backed PM:** every claim is tied to JSON/SQLite/GitHub evidence.
- **Scale-first training:** private/Tencent compute can run many failures safely and mine the distribution for bottlenecks.
- **Scorecard promotion:** no model narrative can bypass candidate-vs-baseline evidence.
- **Observable operations:** Grafana/SQLite/dashboard makes the flywheel inspectable.
- **Closed-loop Act:** online findings become reward/scenario/policy changes rather than prose recommendations.

The current project has most of the foundation. The remaining work is to make the loop productized, visible, and repeated.

## References and local source map

- Project vision: `docs/ops/project-vision.md`.
- RL domain roadmap: `docs/ops/rl-domain-roadmap.md`.
- Prior research foundation: `docs/research/2026-04-29-screeps-rl-self-evolving-strategy-paper.md`.
- Training/reward workflow: `docs/ops/rl-training-reward-workflow.md`.
- Reward model: `docs/ops/rl-reward-model.md`.
- Reward registry: `docs/ops/rl-reward-decision-registry.md`, `docs/ops/rl-reward-registry.yaml`, `docs/ops/rl-reward-schema.yaml`.
- Gameplay metrics: `docs/ops/rl-gameplay-metrics-taxonomy.md`.
- Live dashboard: `docs/ops/rl-live-dashboard-runbook.md`, `scripts/screeps_rl_live_dashboard.py`, `scripts/screeps_rl_dashboard.py`, `scripts/screeps_rl_metrics_ingestor.py`.
- Tencent batch: `docs/ops/tencent-batch-rl-runbook.md`, `scripts/screeps_tencent_batch_rl_runner.py`.
- Experiment card: `scripts/screeps_rl_experiment_card.py`.
- Training runner: `scripts/screeps_rl_training_runner.py`.
- Simulator harness: `scripts/screeps_rl_simulator_harness.py`.
- Historical validator: `scripts/screeps_rl_mmo_validator.py`.
- Rollout manager: `scripts/screeps_rl_rollout_manager.py`, `docs/ops/rl-rollout-rollback.md`.
- Historical 2026-05-19 issue map: #879, #1032, #1228/#1229, #1231, #1232, #1233, #1234, #1235, #1236, #1237, #1238, #1239, #1240, #1241. Current active ownership must be read from Project `screeps` atomic Issues/PRs with `Domain = RL flywheel`, excluding #879 and excluding #1589 except during its bounded PM-contract migration.
