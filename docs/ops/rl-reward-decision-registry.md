# RL Reward Decision Registry v3

Canonical PDCA Act-loop registry for RL reward components, weights, penalties, validation criteria, and implementation tracking in the Screeps RL training pipeline.

- **Container issue:** #963
- **Previous registry issue:** #959
- **Previous reward-decision issue:** #907, closed after PR #961 merged
- **Umbrella:** #879 (ALL IN RL)
- **Last updated:** 2026-05-12

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

Source for all three pending records: Gameplay Evolution Review output `2026-05-12_17-45-46.md`, section "Game behavior rationality analysis (PDCA #906/#907/#924)" and "Reward decision items for #907".

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

## Registered Components

These are registry entries from v2 or this v3 Act container. `PROPOSED` entries are not accepted reward defaults.

| Component | Decision | Type | Candidate weight | Category | Status | Current scope |
| --- | --- | --- | --- | --- | --- | --- |
| `worker-load-efficiency` | `RD-V3-001-workerLoadEfficiency` | penalty | `-0.1` candidate from v2 | logistics | `PROPOSED` | Pending v3 code and validation. |
| `build-allocation-minimum` | `RD-V3-002-buildAllocationMinimum` | reward | `+0.05` candidate from v2 | resources | `PROPOSED` | Pending v3 code and validation. |
| `stuck-penalty` | `RD-V3-003-verifyStuckPenalty` | penalty | `-0.02` per stuck tick candidate from v2 | reliability | `PROPOSED` | Pending v3 verification and possible implementation. |
| `territory-expansion-reward` | TBD | reward | TBD | territory | `PROPOSED` | Placeholder from v2 linked to #958; outside the 2026-05-12 pending Act batch. |

## Integration Points

- **Gameplay Evolution Review (cron `c7b3dda8f1ac`):** Identifies irrational behavior findings and proposes reward decision items.
- **RL Steward:** Converts Gameplay Evolution findings into explicit reward-decision issues, PRs, or validation work.
- **E1 Shadow-Eval Gate (cron `d6cff532edd4`):** Validates proposed or implemented components in shadow mode before acceptance.
- **E4 Training (cron `5c869e7d8a1d`):** Uses only accepted components or explicitly approved offline experiments.
- **#924 Scorecard:** Standardized candidate-vs-baseline evaluation for reward/policy changes.
- **#906 Metric Taxonomy:** Owns missing or insufficient telemetry needed to validate reward decisions.

## Related Issues and PRs

- #879 - ALL IN RL umbrella
- #906 - Gameplay metric taxonomy and coverage gaps
- #907 - Previous reward-decision container, closed after #961
- #924 - Candidate-vs-baseline scorecard
- #958 - Expansion initiation gap and territory reward placeholder
- #959 - RL reward decision registry v2 issue
- #961 - Merged v2 registry PR
- #963 - RL reward decision registry v3 PDCA Act loop container
