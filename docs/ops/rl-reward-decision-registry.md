# RL Reward Decision Registry v3

Canonical PDCA Act-loop registry for RL reward components, weights, penalties, validation criteria, and implementation tracking in the Screeps RL training pipeline.

- **Container issue:** #963
- **Replacement container issue:** #967 (#907 replacement — YAML schema + change-control gate)
- **Previous registry issue:** #959
- **Previous reward-decision issue:** #907, closed after PR #961 merged
- **Historical context:** #879 (quarantined; not an active reward-decision container or progress proxy)
- **Machine-readable schema:** `docs/ops/rl-reward-schema.yaml` (v1, #967)
- **Last updated:** 2026-06-02

## Purpose

Every reward component, weight, penalty, and trigger condition in the RL training pipeline must be an explicit GitHub-managed decision. No hidden reward tuning, prose-only acceptance, or direct reward changes from a Gameplay Evolution Review.

This registry is the PDCA Act container between:

1. Gameplay Evolution Review findings
2. RL Steward reward-decision routing
3. Offline or shadow implementation PRs
4. Validation, acceptance, rejection, or rollback

The v3 registry exists because #907 and PR #961 closed the v2 container, while the 2026-05-12 Gameplay Evolution Review produced new pending Act decisions that still need an open decision workflow.

## Status Workflow

Reward decisions move through exactly these states:

```text
PROPOSED -> APPROVED -> IMPLEMENTED -> VALIDATING -> ACCEPTED
                                            \-> REJECTED
ACCEPTED -> ROLLED_BACK
```

| Status | Meaning |
| --- | --- |
| `PROPOSED` | Finding has evidence, hypothesis, validation criteria, and rollback criteria, but is not approved for implementation. |
| `APPROVED` | Owner or designated steward approved implementation in offline/shadow mode. |
| `IMPLEMENTED` | Code/config/docs landed behind offline/shadow gates and cannot affect live MMO behavior directly. |
| `VALIDATING` | Offline, simulator, historical replay, E1 shadow, or scorecard validation is running. |
| `ACCEPTED` | Validation passed and the reward decision is accepted for the declared pipeline scope. |
| `REJECTED` | Evidence or validation rejected the proposed reward change. |
| `ROLLED_BACK` | An accepted or implemented reward decision was disabled or reverted by rollback criteria. |

Only `ACCEPTED` decisions may become stable reward-shaping defaults. `IMPLEMENTED` and `VALIDATING` decisions remain shadow/offline only unless a later registry update explicitly accepts them.

## Decision Record Schema

Each pending or registered decision record contains:

| Field | Description |
| --- | --- |
| `decision_id` | Stable decision identifier in this registry. |
| `component_id` | Reward component identifier used by docs, config, artifacts, or future code. |
| `status` | One workflow status from this registry. |
| `source` | Gameplay Evolution Review, RL Steward output, issue, PR, or experiment that created the decision. |
| `hypothesis` | Behavior change expected from the reward decision. |
| `current_metric_coverage` | Current runtime, artifact, or dashboard coverage, including gaps. |
| `required_code_changes` | Minimal production, training, telemetry, or artifact changes needed before validation. |
| `validation_criteria` | Measurable criteria required to accept the decision. |
| `rollback_conditions` | Conditions that disable, revert, or reject the decision. |
| `implementation_tracking` | Linked GitHub issue, PR, training run, scorecard, or artifact. |

## Verified Code Paths

The v3 registry references only code paths verified against `prod/src/` on 2026-05-12:

| Path | Verified coverage |
| --- | --- |
| `prod/src/telemetry/runtimeSummary.ts` | Emits `taskCounts`, `workerEfficiency`, `resources.productiveEnergy.pendingBuildProgress`, `resources.productiveEnergy.buildCarriedEnergy`, `resources.energySurplus`, and optional structure/container snapshots. |
| `prod/src/telemetry/behaviorTelemetry.ts` | Records and summarizes per-creep and aggregate `stuckTicks`, `energyAcquisition.harvested`, `energyAcquisition.pickedUp`, and `energyAcquisition.withdrawn`. |
| `prod/src/tasks/workerTasks.ts` | Records `lowLoadReturn` samples with `carriedEnergy`, `freeCapacity`, selected task, target, and reason; source-container acquisition candidates use visible stored energy. |
| `prod/src/rl/workerEfficiency.ts` | Current shadow reward formula is generic `work_ticks/total_ticks + energy_delivered - idle_ticks - range - risk`; exact `workerLoadEfficiency`, `buildAllocationMinimum`, and `stuckPenalty` component identifiers were not found in code. |

## Pending Decisions

Source for the first three pending records: Gameplay Evolution Review output `2026-05-12_17-45-46.md`, section "Game behavior rationality analysis (PDCA #906/#907/#924)" and "Reward decision items for #907".

Source for `RD-V3-004-constructionNeglectPenalty`: issue #1024 and Gameplay Evolution Review 2026-05-14 08:07, following the #907 change-control framework and #924 as the source scorecard contract. A future generated #924-compatible scorecard artifact is still required for #1024 acceptance.

Source for `RD-V3-005-onlineReliabilityRollbackPenalty`: issue #1558 and the 2026-05-31 Loop B policy online advantage rollback evidence. The artifact path is `runtime-artifacts/rl-control-loop/20260531T194800Z-policy-advantage.json`; newer policy advantage reports may reference the same rollback window. Runtime console ticks 1623386-1623404 disabled `construction-priority.territory-shadow.v1` and `expansion-remote.territory-shadow.v1` after reliability dropped about 17.0-18.4% versus the configured 10.0% rollback threshold. The first implementation recommendation is #924 candidate admission/scorecard gating only. Reward shaping and scenario weighting remain future shadow-only follow-ups.

Source for `RD-V3-006-workerTransportEfficiency`: issue #1555, the 2026-06-01 Gameplay Evolution Review low-load transport observation, and the 2026-06-02 Gameplay Evolution Review archive `/root/.hermes/cron/output/c7b3dda8f1ac/2026-06-02_01-21-18.md`. The observed evidence includes transfer-task workers around 0-6/100 carried energy, E29N56 low-load returns at 9/100 and 16/100 with `noReachableEnergy`, and E29N57 spawn-reservation/build-deadlock context. This is enough to register a decision, but not enough to start a reward experiment; #1554 or equivalent telemetry must first separate avoidable micro-hauls from valid starvation, emergency, or dispatch-deadlock cases.

### RD-V3-001-workerLoadEfficiency

| Field | Value |
| --- | --- |
| `decision_id` | `RD-V3-001-workerLoadEfficiency` |
| `component_id` | `worker-load-efficiency` |
| `status` | `PROPOSED` |
| `source` | Gameplay Evolution Review 2026-05-12 17:45:46 Asia/Shanghai; pending item: `workerLoadEfficiency` |
| `hypothesis` | Penalizing avoidable sub-10 energy trips when a container has at least 100 energy will reduce wasted worker travel and increase useful energy delivered per trip without weakening emergency recovery. |
| `current_metric_coverage` | Partial. Runtime summary already exposes `workerEfficiency.lowLoadReturnCount`, emergency versus avoidable low-load returns, low-load samples with carried energy, behavior `energyAcquisition.withdrawn`, and optional container energy snapshots. The exact reward predicate still needs a reliable per-trip join between withdrawn/carried amount and source container fill at decision time, plus a `meanWithdrawnPerTrip` aggregate for validation. |
| `required_code_changes` | Add or derive a shadow reward feature that applies only to non-emergency trips with carried/withdrawn energy below 10 and visible container fill at least 100. Emit enough artifact data to compute mean withdrawn per trip and baseline deltas. Keep `liveEffect=false`. |
| `validation_criteria` | In shadow/eval windows where source containers have at least 100 energy, mean withdrawn per trip exceeds 15 in at least 60% of captures, avoidable low-load return count decreases versus baseline, and worker count plus energy buffer health do not regress. |
| `rollback_conditions` | Disable or reject if worker count drops below 3, energy buffer is unhealthy for 2 consecutive captures, refill starvation increases, or the penalty suppresses valid emergency recovery trips. |
| `implementation_tracking` | Container issue #963; previous registry PR #961; implementation PR TBD; metric taxonomy link #906; previous reward-decision container #907. |

### RD-V3-002-buildAllocationMinimum

| Field | Value |
| --- | --- |
| `decision_id` | `RD-V3-002-buildAllocationMinimum` |
| `component_id` | `build-allocation-minimum` |
| `status` | `PROPOSED` |
| `source` | Gameplay Evolution Review 2026-05-12 17:45:46 Asia/Shanghai; pending item: `buildAllocationMinimum` |
| `hypothesis` | A small positive reward for at least 1 build task when construction backlog exists and energy is healthy will prevent upgrade-only drift during buildable windows. |
| `current_metric_coverage` | Partial. `taskCounts.build` and `energyBufferHealth` are runtime-summary fields. Code also has `resources.productiveEnergy.pendingBuildProgress` and `resources.productiveEnergy.buildCarriedEnergy`, but the reviewed Gameplay Evolution capture treated backlog coverage as missing or unconfirmed. Validation needs console/dashboard extraction to consistently expose backlog and build-energy fields. |
| `required_code_changes` | Add a shadow reward feature for `build_task_count >= 1 && pending_build_progress > 0 && energy_buffer_healthy`. Confirm or extend artifact extraction for `pendingBuildProgress`, `buildCarriedEnergy`, and construction-site count/backlog context. Keep worker-count and emergency energy gates. |
| `validation_criteria` | During captures with backlog greater than 0 and healthy energy, `taskCounts.build > 0` in at least 60% of captures, build-carried energy or built progress is positive, and controller downgrade pressure plus spawn/refill health do not regress versus baseline. |
| `rollback_conditions` | Disable or reject if worker count drops below 3, energy buffer becomes unhealthy for 2 consecutive captures, spawn/refill deficits increase, controller downgrade risk rises, or build allocation starves repairs or emergency survival work. |
| `implementation_tracking` | Container issue #963; previous registry PR #961; implementation PR TBD; metric taxonomy link #906; candidate-vs-baseline scorecard link #924; previous reward-decision container #907. |

### RD-V3-003-verifyStuckPenalty

| Field | Value |
| --- | --- |
| `decision_id` | `RD-V3-003-verifyStuckPenalty` |
| `component_id` | `stuck-penalty` |
| `status` | `PROPOSED` |
| `source` | Gameplay Evolution Review 2026-05-12 17:45:46 Asia/Shanghai; pending item: verify existing `stuckPenalty` |
| `hypothesis` | Ensuring stuck ticks produce a negative reward will reduce repeated pathing/action stalls while preserving valid stationary work such as adjacent building, upgrading, spawning, or harvesting. |
| `current_metric_coverage` | Telemetry coverage exists: `stuckTicks` is recorded per creep and in behavior totals. Reward-code coverage is unverified and likely absent by exact identifier search: `stuckPenalty` and `stuck-penalty` were not found in `prod/src/rl/`. |
| `required_code_changes` | Audit current reward builders and artifacts for any implicit stuck penalty. If absent, implement a shadow/offline penalty keyed from `stuckTicks`, with explicit exceptions for productive stationary actions and tests proving stuck ticks reduce reward. Emit `maxStuckTicks` or `stuckCreepCount` aggregates if scorecards need them. |
| `validation_criteria` | `maxStuckTicks <= 5` in at least 80% of shadow/eval captures, stuck-creep count decreases versus baseline, false-positive stuck penalties remain below 10% of creep captures, and work ticks do not decline materially. |
| `rollback_conditions` | Disable or reject if valid stationary workers are penalized, false-positive rate exceeds 10%, pathing becomes overly conservative, CPU use increases materially, or work/energy-delivery metrics regress. |
| `implementation_tracking` | Container issue #963; previous registry PR #961; implementation PR TBD; metric taxonomy link #906; previous reward-decision container #907. |

### RD-V3-004-constructionNeglectPenalty

| Field | Value |
| --- | --- |
| `decision_id` | `RD-V3-004-constructionNeglectPenalty` |
| `component_id` | `construction-neglect-penalty` |
| `status` | `PROPOSED` |
| `source` | Issue #1024; Gameplay Evolution Review 2026-05-14 08:07; follow-up to #907 with #924 as the source scorecard contract. |
| `hypothesis` | Penalizing `taskCounts.build == 0` when `constructionSiteCount > 0` will reduce construction deadlock learned from upgrade-preferred windows without weakening higher-priority survival gates. |
| `current_metric_coverage` | Partial but sufficient for a shadow decision record. Runtime telemetry exposes `constructionSiteCount`, `taskCounts.build`, `pendingBuildProgress`, `buildCarriedEnergy`, `buildBlockedReason`, and `constructionDeadlockTicks`. Acceptance still requires candidate-vs-baseline scorecard evidence rather than prose intuition. |
| `required_code_changes` | Add or derive an offline/shadow reward feature only: negative reward proportional to `constructionSiteCount` when `constructionSiteCount > 0` and `taskCounts.build == 0`. Preserve `liveEffect=false`, `officialMmoWrites=false`, and `officialMmoWritesAllowed=false`; do not make learned-policy live writes. |
| `validation_criteria` | Historical shadow replay and a future generated #924-compatible candidate-vs-baseline scorecard artifact must cover the same 8-hour horizon. In every room and every non-overlapping 5-minute qualifying window where `constructionSiteCount > 0`, use max `constructionDeadlockTicks` per room/window; the candidate max must stay below 100 in every room/window and must not regress versus baseline. Policy ranking must favor `taskCounts.build > 0` over build-zero candidates, build progress or build-carried energy must improve, and reliability, spawn/refill health, controller downgrade safety, CPU, territory, and resource metrics must not regress. |
| `rollback_conditions` | Disable, reduce, or reject if construction is over-prioritized at the expense of spawn/refill throughput, controller downgrade safety, emergency recovery, valid energy-starvation waiting, reliability, CPU, territory, or resource scorecard dimensions. |
| `implementation_tracking` | Issue #1024; previous reward-decision container #907; metric taxonomy link #906; candidate-vs-baseline scorecard contract #924; construction diagnosis link #1023; decision JSON `docs/ops/examples/rl-reward-decisions/RD-V3-004-constructionNeglectPenalty.json`. #924 closure is not acceptance for #1024; acceptance requires a future generated #924-compatible scorecard artifact for this candidate. |

### RD-V3-005-onlineReliabilityRollbackPenalty

| Field | Value |
| --- | --- |
| `decision_id` | `RD-V3-005-onlineReliabilityRollbackPenalty` |
| `component_id` | `online-reliability-rollback-penalty` |
| `status` | `PROPOSED` |
| `source` | Issue #1558; Loop B policy online advantage report `runtime-artifacts/rl-control-loop/20260531T194800Z-policy-advantage.json`; runtime rollback ticks 1623386-1623404. |
| `hypothesis` | Treating online or shadow reliability regression as a fail-closed admission gate will prevent promotion of candidates that passed offline/shadow utility but drop online reliability above the configured rollback threshold. |
| `current_metric_coverage` | Partial but sufficient for a proposal. The rollback evidence reports candidate-family reliability drops about 17.0-18.4% against a 10.0% threshold for `construction-priority.territory-shadow.v1` and `expansion-remote.territory-shadow.v1`. #924 provides the candidate-vs-baseline scorecard contract. The missing slice is a durable gate that rejects candidate admission when online/shadow reliability drop exceeds the configured threshold or when required reliability data is absent. |
| `required_code_changes` | First implementation should be candidate admission/#924 scorecard gating only: add or derive reliability drop, threshold, and fail-closed status in candidate-vs-baseline comparisons. Do not accept reward shaping or scenario weighting in this decision. Do not run paid Tencent validation while #1536, #1548, or Tencent recurrence gates are blocked. Preserve `liveEffect=false`, `officialMmoWrites=false`, and `officialMmoWritesAllowed=false`. |
| `validation_criteria` | #924 scorecards fail closed when candidate online/shadow reliability drop exceeds the configured rollback threshold, currently 10.0%, or when baseline reliability, candidate reliability, comparison window, or threshold data is missing. The known 2026-05-31 rollback evidence must be rejected by the gate. Validation also requires CPU bucket, loop exception, telemetry freshness, room survival, spawn survival, territory, and resource non-regression, with no official MMO learned-policy writes. |
| `rollback_conditions` | Owner-independent rejection if reliability drop exceeds threshold; if #924 reliability fields or windows are missing; if candidate gains are bought with reliability, CPU, room survival, spawn survival, loop exception, telemetry freshness, territory, or resource regression; if reward shaping/scenario weighting is implemented before admission gating; if paid Tencent compute is required while #1536/#1548/Tencent recurrence gates are blocked; or if any live learned-policy write/control surface is enabled. |
| `implementation_tracking` | Issue #1558; previous reward-decision container #907; candidate-vs-baseline scorecard contract #924; Tencent/compute blockers #1536 and #1548; decision JSON `docs/ops/examples/rl-reward-decisions/RD-V3-005-onlineReliabilityRollbackPenalty.json`; post-gate experiment card TBD after compute gates clear. |

### RD-V3-006-workerTransportEfficiency

| Field | Value |
| --- | --- |
| `decision_id` | `RD-V3-006-workerTransportEfficiency` |
| `component_id` | `worker-transport-efficiency` |
| `status` | `PROPOSED` |
| `source` | Issue #1555; Gameplay Evolution Review 2026-06-01 low-load transfer-task observations; Gameplay Evolution Review 2026-06-02 01:21 archive `c7b3dda8f1ac`. |
| `hypothesis` | A future offline/shadow `worker_transport_efficiency` penalty for avoidable low-load micro-hauls should increase useful delivered energy per trip and reduce wasted transfer/upgrade travel, but only when telemetry proves the low-load trip was avoidable and no emergency, starvation, controller-safety, hostile, or higher-priority gate applies. |
| `current_metric_coverage` | Partial and insufficient for a reward experiment. Runtime summaries expose `workerEfficiency.lowLoadReturnCount`, `avoidableLowLoadReturnCount`, `lowLoadReturnReasons`, carried/free capacity samples, and trip energy summaries. The available E29N56 samples are tagged `noReachableEnergy`, and E29N57 evidence points at spawn-reservation/build-deadlock behavior. Validation still needs a per-trip join across source energy reachability, target saturation, task intent, path distance, room buffer state, spawn reservation state, delivered energy, CPU, and stuck/pathing outcome. |
| `required_code_changes` | No reward implementation yet. First close the #1554 telemetry gap or produce an equivalent artifact that separates avoidable low-load micro-hauls from valid no-reachable-energy, emergency refill, controller-safety, hostile-retreat, and starvation cases. If that gate passes, add only an offline/shadow reward candidate with `liveEffect=false`, `officialMmoWrites=false`, and `officialMmoWritesAllowed=false`. |
| `validation_criteria` | Telemetry readiness requires repeated low-load transport windows over at least 8 hours, reason distribution, carried/free capacity and capacity load factor, source reachability, target saturation, room buffer, spawn-reservation active/idle state, deliveredEnergyPerTrip or returnLoadFactor, CPU bucket, and stuck/pathing evidence. A later #924-compatible scorecard must show avoidable low-load return count decreases and deliveredEnergyPerTrip or returnLoadFactor improves versus baseline, with no regression to spawn/refill latency, controller safety, construction progress, CPU, reliability, territory, or resources. |
| `rollback_conditions` | Reject if telemetry shows most low-load returns are `noReachableEnergy`, emergency refill, controller safety, hostile retreat, or genuine starvation exceptions; if fuller-load behavior delays urgent refill or controller safety; if it improves load factor by increasing path CPU, stuck ticks, pathFindingFailures, or hostile exposure; if #924 scorecard dimensions regress; or if any live learned-policy write/control surface is enabled. |
| `implementation_tracking` | Issue #1555; previous reward-decision container #907; metric taxonomy link #906; candidate-vs-baseline scorecard contract #924; telemetry prerequisite #1554 or equivalent artifact; decision JSON `docs/ops/examples/rl-reward-decisions/RD-V3-006-workerTransportEfficiency.json`. Steward disposition: hold for telemetry, no reward experiment accepted. |

## Registered Components

These are registry entries from v2 or this v3 Act container. `PROPOSED` entries are not accepted reward defaults.

| Component | Decision | Type | Candidate weight | Category | Status | Current scope |
| --- | --- | --- | --- | --- | --- | --- |
| `worker-load-efficiency` | `RD-V3-001-workerLoadEfficiency` | penalty | `-0.1` candidate from v2 | logistics | `PROPOSED` | Pending v3 code and validation. |
| `build-allocation-minimum` | `RD-V3-002-buildAllocationMinimum` | reward | `+0.05` candidate from v2 | resources | `PROPOSED` | Pending v3 code and validation. |
| `stuck-penalty` | `RD-V3-003-verifyStuckPenalty` | penalty | `-0.02` per stuck tick candidate from v2 | reliability | `PROPOSED` | Pending v3 verification and possible implementation. |
| `construction-neglect-penalty` | `RD-V3-004-constructionNeglectPenalty` | penalty | proportional to `constructionSiteCount`, coefficient TBD | resources | `PROPOSED` | Pending offline/shadow replay and future #924-compatible scorecard artifact; no live writes. |
| `online-reliability-rollback-penalty` | `RD-V3-005-onlineReliabilityRollbackPenalty` | gate | fail closed above configured rollback threshold, currently 10.0% reliability drop | reliability | `PROPOSED` | Candidate admission/#924 scorecard gate proposal only; reward shaping and scenario weighting deferred to future shadow-only decisions; no paid Tencent while gates are blocked; no live writes. |
| `worker-transport-efficiency` | `RD-V3-006-workerTransportEfficiency` | penalty | TBD; hold for telemetry | logistics | `PROPOSED` | Telemetry hold only; #1554/equivalent evidence required before any offline/shadow reward experiment; no live writes. |
| `territory-expansion-reward` | TBD | reward | TBD | territory | `PROPOSED` | Placeholder from v2 linked to #958; outside the 2026-05-12 pending Act batch. |

## Integration Points

- **Gameplay Evolution Review (cron `c7b3dda8f1ac`):** Identifies irrational behavior findings and proposes reward decision items.
- **RL Steward:** Converts Gameplay Evolution findings into explicit reward-decision issues, PRs, or validation work.
- **E1 Shadow-Eval Gate (cron `d6cff532edd4`):** Validates proposed or implemented components in shadow mode before acceptance.
- **E4 Training (cron `5c869e7d8a1d`):** Uses only accepted components or explicitly approved offline experiments.
- **#924 Scorecard:** Standardized candidate-vs-baseline evaluation for reward/policy changes. RD-V3-005 proposes adding fail-closed candidate admission when online/shadow reliability drops exceed the configured rollback threshold or required reliability data is missing; until RD-V3-005 is accepted and implemented, this reliability gate is not deployed behavior.
- **#906 Metric Taxonomy:** Owns missing or insufficient telemetry needed to validate reward decisions.

## Related Issues and PRs

- #879 - historical ALL IN RL context only; not an active reward-decision container, queue, or completion proxy
- #906 - Gameplay metric taxonomy and coverage gaps
- #907 - Previous reward-decision container, closed after #961
- #924 - Candidate-vs-baseline scorecard
- #1023 - Construction deadlock diagnosis with 3 identified gates
- #1024 - P1 construction-neglect reward decision for `build=0` with construction sites
- #1536 - Tencent recurrence gate blocker
- #1548 - Tencent validation/compute gate blocker
- #1554 - Telemetry prerequisite for low-load transport attribution and deadlock reason coverage
- #1555 - P1 worker transport efficiency reward decision
- #1558 - P0 reliability rollback reward decision
- #958 - Expansion initiation gap and territory reward placeholder
- #959 - RL reward decision registry v2 issue
- #961 - Merged v2 registry PR
- #963 - RL reward decision registry v3 PDCA Act loop container
