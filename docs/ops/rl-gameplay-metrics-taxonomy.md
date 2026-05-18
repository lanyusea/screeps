# RL Gameplay Metrics Taxonomy

Status: first PDCA Check landing slice for issue #906.

This taxonomy turns local runtime/RL artifacts into a durable SQLite metric store for Gameplay Evolution. The store is intentionally offline-only: it reads saved artifacts, stores derived metrics and concise evidence paths, and never copies raw console logs, raw secrets, or full artifact bodies.

Default store:

```text
runtime-artifacts/rl-metrics/rl_metrics.sqlite
```

Primary ingestor:

```text
python3 scripts/screeps_rl_metrics_ingestor.py init
python3 scripts/screeps_rl_metrics_ingestor.py ingest-artifacts
python3 scripts/screeps_rl_metrics_ingestor.py summarize
```

Live dashboard runbook:

```text
docs/ops/rl-live-dashboard-runbook.md
```

Default source roots:

```text
runtime-artifacts/runtime-summary-console
runtime-artifacts/rl-dataset-gates
runtime-artifacts/rl-control-loop
runtime-artifacts/rl-training
```

## Schema Contract

The ingestor owns these tables:

| Table | Purpose |
| --- | --- |
| `metric_definitions` | Durable taxonomy: category, metric name, purpose, sources, direction, interpretation, missing-coverage behavior, promotion rule. |
| `metric_observations` | Derived numeric/text observations by tick, room, shard, metric, source artifact path, and bounded evidence JSON. |
| `gameplay_behavior_findings` | Behavior defects detected from available metrics, with severity, recommendation, and promotion state. |
| `metric_coverage_gaps` | Explicit missing instrumentation/source coverage instead of silent false negatives. |
| `rl_dataset_gate_metrics` | Dataset/evaluation gate pass/fail and quality counters. |
| `rl_training_execution_metrics` | Training report sample/reward metrics by variant. |
| `rl_policy_advantage_metrics` | Candidate-vs-incumbent territory/resources/kills advantage metrics. |
| `metric_iteration_decisions` | Ingested RL control-loop or rollout/iteration decisions and blocking reasons. |

## Metric Categories

| Category | Goal | Irrational behavior covered |
| --- | --- | --- |
| Survival/ownership | Keep claimed rooms alive and spawn-capable. | Claimed expansion rooms with 0 spawns after grace. |
| Resource economy | Keep energy telemetry visible and energy flow useful. | Missing energy telemetry, low-load worker returns. |
| Construction/infrastructure | Ensure build backlog turns into build work/progress. | `build=0` or `buildCarriedEnergy=0` while backlog exists. |
| Creep efficiency | Detect idle/stuck/actionless creeps and poor load factor. | Long stuck windows; 2/50-style returns. |
| Defense readiness | Ensure threat/backlog drives towers/ramparts/defense construction. | Missing/late tower/rampart/defense infra while threatened. |
| Gameplay behavior | Detect bad priority allocation. | Upgrade dominance while capacity/defense/construction backlog exists. |
| CPU/reliability | Keep runtime evidence trustworthy. | Loop exceptions, telemetry silence, CPU gaps. |
| RL dataset/training/policy | Keep offline learning gates measurable. | Dataset gate rejections, missing training/policy advantage evidence. |
| Metric coverage | Make blind spots actionable. | Missing source roots, missing fields, unreadable files. |

## Metric Definitions

| Metric | Category | Purpose | Source artifact(s) | Directionality | Interpretation | Missing coverage behavior | Promotion rule |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `source.runtime_summary_console.present` | Metric coverage | Confirm saved runtime-summary artifacts exist. | `runtime-artifacts/runtime-summary-console` | Higher is better | `1` means the Check loop has runtime samples. | Insert `missing_source_root` gap. | Missing for two steward windows promotes runtime capture work. |
| `source.rl_dataset_gates.present` | Metric coverage | Confirm RL dataset/evaluation gate artifacts exist. | `runtime-artifacts/rl-dataset-gates` | Higher is better | Required to explain policy gate decisions. | Insert `missing_source_root` gap. | Repeated absence promotes RL pipeline evidence work. |
| `source.rl_control_loop.present` | Metric coverage | Confirm RL iteration/control decisions exist. | `runtime-artifacts/rl-control-loop` | Higher is better | Required to close PDCA Act decisions. | Insert `missing_source_root` gap. | Repeated absence promotes control-loop observability work. |
| `source.rl_training.present` | Metric coverage | Confirm RL training reports exist. | `runtime-artifacts/rl-training` | Higher is better | Required for policy advantage panels. | Insert `missing_source_root` gap. | Repeated absence during active RL work promotes experiment evidence issue. |
| `survival.owned_rooms` | Survival/ownership | Count visible claimed rooms. | Runtime-summary JSON/log lines. | Higher is better | Drops imply territory loss or visibility loss. | Gap if room ownership fields are absent. | Severe drop promotes P0 recovery; missing data promotes telemetry work. |
| `survival.owned_spawns` | Survival/ownership | Count spawn infrastructure per room. | `spawnStatus`, `structures.spawn`, spawn count fields. | Higher until target met | Claimed room with 0 spawns is survival risk. | Gap if spawn telemetry absent. | Critical when claimed room has 0 spawns after grace. |
| `survival.claimed_room_without_spawn_age_ticks` | Survival/ownership | Measure no-spawn claimed room age. | Claim age and controller fields. | Lower is better | Above grace means expansion is not self-sustaining. | Gap if claim age is missing. | Critical after `1500` ticks without spawn. |
| `economy.energy_available` | Resource economy | Track spawn/extension energy. | `energyAvailable`, `energy.available`. | Contextual | Low can be normal after spending; dangerous in recovery. | Energy telemetry gap. | Repeated absence promotes energy telemetry work. |
| `economy.stored_energy` | Resource economy | Track durable reserves. | `resources.storedEnergy`, storage fields. | Higher is better | Persistent low/0 values indicate starvation or missing visibility. | Energy telemetry gap. | Repeated starvation promotes economy recovery work. |
| `economy.worker_carried_energy` | Resource economy | Track carried worker energy. | `resources.workerCarriedEnergy`. | Contextual | Carried energy with no sink work indicates assignment imbalance. | Energy telemetry gap. | Repeated absence promotes worker energy telemetry work. |
| `economy.energy_telemetry` | Metric coverage | Boolean coverage marker for energy fields. | Any available energy field. | Higher is better | Gap means economy behavior cannot be judged safely. | Insert `missing_energy_fields`. | Repeated gap promotes telemetry construction issue. |
| `creep.worker_count` | Creep efficiency | Count visible owned workers/creeps. | `workerCount`, `ownedCreeps`, `creeps`. | Higher until target met | Explains energy/construction deadlocks. | Worker telemetry gap. | Critical during recovery if no workers and spawn can act. |
| `creep.low_load_return_count` | Creep efficiency | Count low-load returns. | Low-load/worker-efficiency fields. | Lower is better | Nonzero values mean travel/CPU waste. | `missing_low_load_return_fields`. | Repeated nonzero values promote logistics issue. |
| `creep.return_load_factor` | Creep efficiency | Track return energy divided by carry capacity. | Return energy/capacity or load-factor fields. | Higher is better | `<=0.10` outside emergency is irrational. | Low-load telemetry gap. | Repeated low factor promotes logistics issue. |
| `creep.worker_load_trip_energy_mean` | Creep efficiency | Track mean carried energy on worker trips. | `workerLoadEfficiency.tripEnergyMean`. | Higher is better | `<10` energy/trip indicates severe logistics waste. | Low-load telemetry gap. | Repeated low mean promotes logistics issue. |
| `creep.worker_load_trip_energy_min` | Creep efficiency | Track minimum carried energy on worker trips. | `workerLoadEfficiency.tripEnergyMin`. | Higher is better | Identifies the worst low-yield trips. | Low-load telemetry gap. | Repeated low minimum promotes logistics issue. |
| `creep.idle_count` | Creep efficiency | Count idle/actionless workers or idle ticks. | Behavior fields. | Lower is better | High values indicate missing targets or blocked pathing. | Stuck/actionless gap. | Critical if long windows repeat. |
| `creep.stuck_ticks` | Creep efficiency | Track stuck/actionless windows. | `stuckTicks`, `actionlessTicks`, stuck count fields. | Lower is better | Long windows waste CPU and block work. | `missing_stuck_actionless_fields`. | Critical when `>=50` ticks repeats or blocks survival work. |
| `creep.path_finding_failures` | Creep efficiency | Count inferred pathing failure ticks. | `behavior.totals.pathFindingFailures`. | Lower is better | Nonzero means stuck ticks occurred with no work ticks. | Stuck/actionless gap. | Repeated nonzero values promote pathing work. |
| `creep.destination_blocked` | Creep efficiency | Count inferred blocked destinations. | `behavior.totals.destinationBlocked`. | Lower is better | Nonzero separates blocked targets from generic idle time. | Stuck/actionless gap. | Repeated nonzero values promote target/path recovery. |
| `construction.backlog_progress` | Construction/infrastructure | Track remaining construction backlog. | Productive-energy/construction priority fields. | Lower when work should progress | Backlog with no progress means construction stalled. | Construction telemetry gap. | Repeated backlog with zero build promotes construction issue. |
| `construction.build_task_count` | Construction/infrastructure | Track workers assigned to build. | `taskCounts.build`. | Contextual | `0` while backlog exists is stalled construction. | Task assignment gap. | Repeated `0` with backlog promotes construction issue. |
| `construction.built_progress` | Construction/infrastructure | Track actual build progress. | Build progress fields. | Higher when backlog exists | `0` with backlog means no effective build work. | `missing_build_progress`. | Repeated `0` or gap with backlog promotes behavior/telemetry issue. |
| `construction.build_carried_energy` | Construction/infrastructure | Track energy carried/used by builders. | `buildCarriedEnergy` fields. | Higher when backlog exists | `0` with backlog confirms builder starvation/misassignment. | `missing_build_carried_energy`. | Repeated `0` or gap with backlog promotes construction issue. |
| `construction.build_blocked_reason` | Construction/infrastructure | Explain stalled construction backlog. | `resources.productiveEnergy.buildBlockedReason`. | Categorical | Distinguishes `energy_buffer_blocked`, `no_construction_sites`, and `worker_assignment_gap`. | `missing_build_blocked_reason`. | Repeated `worker_assignment_gap` promotes construction assignment work. |
| `economy.extension_count` | Resource economy | Track completed extensions. | `structures.extensionCount`. | Higher until RCL cap | `0` at RCL2+ explains spawn-only energy capacity. | Extension telemetry gap. | Repeated zero/absence promotes extension construction work. |
| `economy.extension_capacity_contribution` | Resource economy | Track extension capacity separate from spawn capacity. | `structures.extensionCapacityContribution`. | Higher until RCL cap | `0` means extensions are not contributing capacity. | Extension capacity gap. | Repeated zero at RCL2+ promotes extension construction work. |
| `construction.defense_backlog` | Defense readiness | Track tower/rampart/defense backlog. | Defense fields and construction priority text. | Lower is better when threatened | Defense backlog with no builders is survival risk. | Defense construction gap. | Critical with hostile/threat evidence. |
| `defense.hostile_creep_count` | Defense readiness | Count visible hostiles. | `combat.hostileCreepCount`. | Lower is better | Nonzero requires defense readiness. | Combat telemetry gap. | Missing during incidents promotes combat telemetry work. |
| `defense.tower_count` | Defense readiness | Count tower infrastructure. | `structures.tower`, tower count fields. | Higher until target met | `0` during threat/backlog means missing defense infra. | Defense infra gap. | Critical with hostiles or high-urgency defense backlog. |
| `defense.rampart_count` | Defense readiness | Count rampart infrastructure. | `structures.rampart`, rampart count fields. | Higher until target met | `0` during rampart backlog means late fortification. | Defense infra gap. | Critical with hostiles or high-urgency defense backlog. |
| `behavior.upgrade_dominance_ratio` | Gameplay behavior | Fraction of workers assigned to upgrade. | `taskCounts.upgrade` and worker count. | Lower when backlog exists | High upgrade ratio with urgent backlog is misprioritized progress. | Task/backlog gap. | Repeated `>=0.60` with backlog promotes prioritization issue. |
| `cpu.bucket` | CPU/reliability | Track CPU bucket resilience. | `cpu.bucket`. | Higher is better | Low bucket can mask policy quality. | CPU telemetry gap. | Repeated low/missing values promote reliability work. |
| `cpu.used` | CPU/reliability | Track CPU used. | `cpu.used`. | Lower for equal outcome | Spikes may correlate with pathing/stuck behavior. | CPU telemetry gap. | Repeated missing values promote CPU instrumentation work. |
| `reliability.loop_exception_count` | CPU/reliability | Count tick-loop exceptions. | `reliability.loopExceptionCount`. | Lower is better | Any nonzero value invalidates behavior evidence. | Reliability telemetry gap. | Nonzero promotes P0 runtime correctness issue. |
| `reliability.telemetry_silence_ticks` | CPU/reliability | Track telemetry silence. | `reliability.telemetrySilenceTicks`. | Lower is better | Silence means the Check loop may be blind. | Reliability telemetry gap. | Repeated silence promotes monitor/capture issue. |
| `rl.dataset_gate.status` | RL dataset/training/policy | Persist gate pass/fail. | RL dataset gate report/summary JSON. | Pass is better | Failing gates block policy advancement. | Source-root gap. | Repeated failures promote RL dataset quality issue. |
| `rl.training.execution_sample_count` | RL dataset/training/policy | Track simulator samples by variant. | RL training reports. | Higher until target met | `0` samples make comparisons unusable. | Training coverage gap. | Repeated `0`/missing promotes simulator/training issue. |
| `rl.policy.advantage_territory` | RL dataset/training/policy | Candidate territory reward advantage. | RL training ranking/reward tuples. | Higher is better | First lexicographic objective. | Policy comparison gap. | Negative/repeated missing value blocks rollout and feeds iteration. |
| `rl.policy.advantage_resources` | RL dataset/training/policy | Candidate resource reward advantage after territory tie. | RL training ranking/reward tuples. | Higher is better | Matters only after territory is not worse. | Policy comparison gap. | Negative value feeds reward/strategy iteration. |
| `rl.policy.advantage_kills` | RL dataset/training/policy | Candidate kill reward advantage after territory/resources. | RL training ranking/reward tuples. | Higher is better | Third lexicographic objective. | Policy comparison gap. | Negative value feeds combat-policy iteration. |

## Finding Rules

The first ingestor slice detects these behavior findings when the required fields exist:

| Finding category | Trigger | Severity |
| --- | --- | --- |
| `missing-late-defense-construction` | Threat or defense backlog exists and tower/rampart infrastructure is missing. | Critical with hostiles, warning with backlog only. |
| `low-load-return` | Low-load return count is nonzero or return load factor is `<=0.10`, e.g. `2/50`. | Warning unless later policy raises it during emergency windows. |
| `stuck-actionless` | Stuck/actionless window is `>=50` ticks, or path-finding failure counters are nonzero in repeated windows. | Critical for long windows; warning for first pathing failure window. |
| `stalled-construction` | Construction backlog exists and build task/progress/build-carried energy are all `0` or missing, with `buildBlockedReason` explaining the blocker when emitted. | Critical when high-urgency/defense, otherwise warning. |
| `upgrade-dominant-backlog` | Upgrade tasks are `>=60%` of workers while construction/defense/threat backlog exists. | Warning. |
| `claimed-expansion-zero-spawn` | Claimed room has 0 spawns after `1500` claim-age ticks. | Critical. |
| `runtime-reliability` | Loop exception count is nonzero. | Critical. |
| `rl-gate-rejection` | Dataset gate fails or rejects samples. | Warning, blocks policy advancement. |

When fields are missing, the ingestor writes `metric_coverage_gaps` instead of pretending the behavior is healthy. This is deliberate: missing coverage is itself a Check finding.

## Promotion To GitHub Construction Issues

Codex does not update GitHub for this task, but the taxonomy defines when the controller or Gameplay Evolution should promote findings:

1. **Immediate promotion:** any critical survival/runtime correctness finding, including claimed room with 0 spawns after grace, nonzero loop exceptions, hostiles with missing defense infra, or severe defense construction stall.
2. **Repeated promotion:** same `category + room_name` appears in two or more consecutive steward windows, or appears in three windows within 24 hours.
3. **Coverage promotion:** a coverage gap for a required category appears in two consecutive steward windows and blocks interpretation of a P0/P1 behavior.
4. **RL gate promotion:** dataset/training/policy metrics fail or are missing during an active RL experiment window, blocking rollout or iteration.
5. **Issue body minimum evidence:** metric name, room, tick/window if known, concise source artifact path, bounded evidence JSON, expected behavior, and the smallest implementation surface likely to fix it.

Promotion should create construction issues, not raw alert spam. One issue should aggregate repeated evidence for the same root behavior unless the blast radius or owning module differs.
