# RL Reward Decision Log

Status: seed registry for issue #907.

Metric taxonomy link: issue #906.

## Purpose

This log is the durable index for reward Act decisions. It keeps reward model changes explicit, reviewable, and linked to GitHub work rather than implicit in prompts, training intuition, or model defaults.

Machine-readable decision files live under `docs/ops/examples/rl-reward-decisions/` for this first slice because repository-level `runtime-artifacts/` is gitignored and has no tracked convention files.

## Lifecycle

Reward decisions move through exactly these states:

```text
proposed -> owner_review -> approved_for_shadow -> training -> candidate_policy -> validating -> accepted/rejected/rolled_back
```

State meaning:

- `proposed`: documented idea with linked issue and metric taxonomy, not accepted.
- `owner_review`: steward has enough evidence to request owner direction.
- `approved_for_shadow`: owner approved offline/shadow exploration only.
- `training`: training run is executing or queued against the approved decision.
- `candidate_policy`: a concrete candidate policy or reward config exists.
- `validating`: candidate is under offline, simulator, historical, shadow, or rollout validation.
- `accepted`: owner accepted the reward change after evidence and validation.
- `rejected`: evidence, owner review, or validation rejected the change.
- `rolled_back`: an accepted change was reverted or disabled by rollback criteria.

Default state is `proposed`. No seed entry in this file is an accepted reward change.

## Required Fields

Every machine-readable reward decision must include:

- `rewardDecisionId`
- `title`
- `state`
- `linkedGitHubIssue`
- `linkedMetricEvidence`
- `linkedDashboardPanels`
- `problemStatement`
- `hypothesis`
- `currentRewardCoverage`
- `proposedChangeType`
- `component`
- `direction`
- `expectedBehaviorChange`
- `riskAndRegressions`
- `validationWindows`
- `acceptanceCriteria`
- `rollbackCriteria`
- `stewardDecision`
- `ownerDecision`
- `linkedPRs`
- `linkedTrainingRuns`
- `linkedPolicyEvaluations`
- `createdAt`
- `updatedAt`

The JSON template is `docs/ops/templates/rl-reward-decision.template.json`.

## Seed Decision Index

| ID | State | Behavior class | Proposal status | Links |
| --- | --- | --- | --- | --- |
| `RD-0001-defense-construction` | `proposed` | missing or late defense construction | needs metric evidence; not accepted | #907, #906 |
| `RD-0002-worker-load-efficiency` | `proposed` | tiny-load returns such as 2/50 energy | needs metric evidence; not accepted | #907, #906 |
| `RD-0003-stuck-actionless-creeps` | `proposed` | stuck/actionless creeps | needs metric evidence; not accepted | #907, #906 |
| `RD-V3-004-constructionNeglectPenalty` | `proposed` | `build=0` with construction backlog | needs offline/shadow replay plus future #924-compatible scorecard artifact; not accepted | #1024, #907, #906, #924 |
| `RD-0005-expansion-without-spawn` | `proposed` | claim/expansion room with 0 spawns after grace window | needs metric evidence; not accepted | #907, #906 |
| `RD-0006-metric-and-reliability-gates` | `proposed` | CPU, reliability, or missing metrics | needs metric evidence; not accepted | #907, #906 |

## Seed Entries

### RD-0001-defense-construction

- State: `proposed`
- Linked issue: https://github.com/lanyusea/screeps/issues/907
- Linked metric taxonomy: https://github.com/lanyusea/screeps/issues/906
- Problem: owner-observed behavior suggests defense-critical construction may be missing or late.
- Possible Act choice: add or adjust `defense_construction_readiness` as a safety/territory-sensitive reward component.
- Evidence needed: hostile/damage/downgrade context, defense site backlog, rampart/tower/road/site state, build progress, worker availability.
- Acceptance status: not accepted; proposal only.

### RD-0002-worker-load-efficiency

- State: `proposed`
- Linked issue: https://github.com/lanyusea/screeps/issues/907
- Linked metric taxonomy: https://github.com/lanyusea/screeps/issues/906
- Problem: owner-observed tiny-load returns such as 2/50 energy may waste worker trips and slow economy.
- Possible Act choice: add or adjust `worker_load_efficiency` so useful delivery per trip improves after higher-priority floors pass.
- Evidence needed: carry utilization distribution, transfer target saturation, source/drop distance, delivered energy per trip, CPU impact.
- Acceptance status: not accepted; proposal only.

### RD-0003-stuck-actionless-creeps

- State: `proposed`
- Linked issue: https://github.com/lanyusea/screeps/issues/907
- Linked metric taxonomy: https://github.com/lanyusea/screeps/issues/906
- Problem: owner-observed stuck/actionless creeps may indicate task assignment, pathing, or action-result failure.
- Possible Act choice: add or adjust `creep_action_liveness`, and escalate to a hard gate when repeated actionlessness threatens reliability.
- Evidence needed: idle/actionless ticks, repeated position evidence, action result codes, task memory, target validity, CPU bucket.
- Acceptance status: not accepted; proposal only.

### RD-V3-004-constructionNeglectPenalty

- State: `proposed`
- Linked issue: https://github.com/lanyusea/screeps/issues/1024
- Change-control reference: https://github.com/lanyusea/screeps/issues/907
- Linked metric taxonomy: https://github.com/lanyusea/screeps/issues/906
- Linked scorecard gate: https://github.com/lanyusea/screeps/issues/924
- Problem: `build=0` while construction backlog exists can block territory and resource progression; issue #1024 records `build=0` with `constructionSiteCount=10` across ticks 917318-918948 and frozen `pendingBuildProgress` near 13200.
- Possible Act choice: add a shadow/offline `construction_neglect_penalty` when `constructionSiteCount > 0` and `taskCounts.build == 0`, with negative reward proportional to construction site count.
- Evidence needed: historical shadow replay, construction-deadlock tick counts, build assignment distribution, build progress or build-carried energy, spawn/refill health, controller downgrade safety, and a future generated #924-compatible candidate-vs-baseline scorecard artifact. Issue #924 is the source scorecard contract; its closure is not acceptance for #1024.
- Safety flags: `liveEffect:false`, `officialMmoWrites:false`, and `officialMmoWritesAllowed:false`; this decision does not authorize learned-policy live writes.
- Acceptance status: not accepted; proposal only.

### RD-0005-expansion-without-spawn

- State: `proposed`
- Linked issue: https://github.com/lanyusea/screeps/issues/907
- Linked metric taxonomy: https://github.com/lanyusea/screeps/issues/906
- Problem: a claimed or expansion room with 0 spawns after a grace window is not durable territory.
- Possible Act choice: add or adjust `expansion_viability` so territory reward counts only survived expansion.
- Evidence needed: claim timestamp, grace window, spawn/site state, local workers, bootstrap energy path, hostile pressure.
- Acceptance status: not accepted; proposal only.

### RD-0006-metric-and-reliability-gates

- State: `proposed`
- Linked issue: https://github.com/lanyusea/screeps/issues/907
- Linked metric taxonomy: https://github.com/lanyusea/screeps/issues/906
- Problem: CPU, reliability, or missing metric data can make reward changes unsafe or impossible to validate.
- Possible Act choice: hard gate training, candidate promotion, or rollout until telemetry and reliability floors are satisfied.
- Evidence needed: runtime summary freshness, malformed count, CPU bucket/window data, validator output, missing-field report.
- Acceptance status: not accepted; proposal only.

## Update Rules

- Add one row here for every reward decision JSON.
- Keep `state`, linked PRs, training runs, policy evaluations, and owner/steward decisions synchronized with the decision JSON.
- Mark rejected and rolled-back decisions as durable evidence; do not delete them.
- Do not mark a decision `accepted` unless validation evidence and owner decision are linked.
- Do not use this log to authorize official MMO writes. It records reward governance only.
