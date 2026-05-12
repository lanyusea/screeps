# RL Reward Decision Registry

Canonical registry of RL reward components, weights, penalties, and change-control decisions for the Screeps RL training pipeline.

**Source issue:** #959 (replaces #907)  
**Umbrella:** #879 (ALL IN RL)  
**Last updated:** 2026-05-12

## Purpose

Every reward component, weight, penalty, and trigger condition in the RL training pipeline must be an explicit GitHub-managed decision. No hidden reward tuning or prose-only acceptance. This registry is the single source of truth for:

- What reward components exist
- Their type, weight, trigger condition, and validation criteria
- Their change history (every change is a PR with evidence)
- Rollback conditions per component

## Registry Schema

Each reward component record contains:

| Field | Description |
|-------|-------------|
| `id` | Unique component identifier (kebab-case) |
| `type` | `reward` or `penalty` |
| `weight` | Scalar multiplier applied to the component |
| `category` | `territory`, `resources`, `combat`, `reliability`, `logistics` |
| `trigger` | Human-readable trigger condition |
| `formula` | Mathematical formulation (pseudocode) |
| `evidence_source` | Gameplay Evolution Review finding or shadow-eval data |
| `validation` | How to verify this component is working correctly |
| `rollback_condition` | When to disable or revert this component |
| `status` | `proposed`, `active`, `disabled`, `deprecated` |
| `introduced` | Date/PR when first registered |
| `last_modified` | Date/PR of most recent change |

## Registered Components

### 1. workerLoadEfficiency

| Field | Value |
|-------|-------|
| `id` | `workerLoadEfficiency` |
| `type` | `penalty` |
| `weight` | `-0.1` |
| `category` | `logistics` |
| `trigger` | Per-trip: worker withdraws energy and carried amount < 10 when container/storage fill ≥ 100 |
| `formula` | `if carried_energy < 10 AND source_fill >= 100: penalty = -0.1 * (1 - carried_energy/10)` |
| `evidence_source` | Gameplay Evolution Review 2026-05-12: tick 854540, all 4 workers withdraw 1 energy; mean trip energy < 10 across window |
| `validation` | Mean withdrawn-per-trip > 15 in ≥ 60% of shadow-eval captures |
| `rollback_condition` | Disable if worker count < 3 or energy buffer unhealthy for 2+ consecutive captures |
| `status` | `proposed` |
| `introduced` | 2026-05-12 (#959) |
| `last_modified` | 2026-05-12 (#959) |

### 2. buildAllocationMinimum

| Field | Value |
|-------|-------|
| `id` | `buildAllocationMinimum` |
| `type` | `reward` |
| `weight` | `+0.05` |
| `category` | `resources` |
| `trigger` | Per-tick: ≥ 1 worker assigned to build task when construction backlog > 0 AND energy buffer healthy |
| `formula` | `if build_task_count >= 1 AND pending_build_progress > 0 AND energy_buffer_healthy: reward = +0.05` |
| `evidence_source` | Gameplay Evolution Review 2026-05-12: tick 854540, upgrade=4, build=0 at 550/550 energy; build=0 in 3 of 7 captures |
| `validation` | build > 0 in ≥ 60% of captures where backlog > 0 and energy healthy |
| `rollback_condition` | Disable if worker count < 3; revert to upgrade-only if energy buffer unhealthy for 2+ consecutive captures |
| `status` | `proposed` |
| `introduced` | 2026-05-12 (#959) |
| `last_modified` | 2026-05-12 (#959) |

### 3. stuckPenalty

| Field | Value |
|-------|-------|
| `id` | `stuckPenalty` |
| `type` | `penalty` |
| `weight` | `-0.02` per stuck tick |
| `category` | `reliability` |
| `trigger` | Per-creep: creep has not moved or changed position for > 5 consecutive ticks |
| `formula` | `penalty = -0.02 * (stuck_ticks - 5) for stuck_ticks > 5` |
| `evidence_source` | Gameplay Evolution Review 2026-05-12: stuckTicks 5-12 across multiple captures (e.g. worker-E24S49-854124: 11 ticks) |
| `validation` | maxStuckTicks ≤ 5 per capture in ≥ 80% of shadow-eval captures |
| `rollback_condition` | Disable if false-positive stuck detection exceeds 10% of creep captures (e.g. creeps stationary during spawn/upgrade at controller) |
| `status` | `proposed` |
| `introduced` | 2026-05-12 (#959) |
| `last_modified` | 2026-05-12 (#959) |

### 4. territoryExpansionReward (placeholder)

| Field | Value |
|-------|-------|
| `id` | `territoryExpansionReward` |
| `type` | `reward` |
| `weight` | TBD |
| `category` | `territory` |
| `trigger` | Room claimed or reserved; new spawn placed in expansion room |
| `formula` | TBD |
| `evidence_source` | Project vision: territory > resources > kills. #958 (expansion initiation gap) |
| `validation` | TBD after expansion capability is instrumented |
| `rollback_condition` | TBD |
| `status` | `proposed` |
| `introduced` | 2026-05-12 (#959) |
| `last_modified` | 2026-05-12 (#959) |

## Change-Control Workflow

1. **Proposal:** Any agent or review identifies a reward component change (new component, weight adjustment, trigger modification, deprecation).
2. **Issue:** Create or reference a GitHub issue with `roadmap:rl-flywheel` label. Include: component id, proposed change, evidence, hypothesis, validation criteria, rollback condition.
3. **PR:** Implement the registry update in a topic branch. Update this file with the new/modified component record. Set status to `proposed` for new components.
4. **Review:** PR goes through normal review gates (CodeRabbit/Gemini, >=15 min, green checks).
5. **Merge:** After merge, the component is registered and available for E1 shadow-eval consumption.
6. **Shadow Validation:** E1 gate evaluates the component in shadow mode. If validation criteria pass for 2+ consecutive gates, promote status to `active`.
7. **Rollback:** If validation fails or rollback condition triggers, create a revert PR setting status to `disabled` or `deprecated`.

## Integration Points

- **E1 Shadow-Eval Gate (cron `d6cff532edd4`):** Reads active reward components for shadow evaluation.
- **E4 Training (cron `5c869e7d8a1d`):** Uses active components for reward shaping during training.
- **#924 Scorecard:** Standardized candidate-vs-baseline evaluation references registered components.
- **Gameplay Evolution Review (cron `c7b3dda8f1ac`):** Identifies new reward needs and validates existing component performance.

## Related Issues

- #879 — ALL IN RL umbrella
- #924 — Candidate-vs-baseline scorecard
- #960 — RL gameplay metrics monitoring v2
- #958 — Expansion initiation gap (territory reward placeholder)
