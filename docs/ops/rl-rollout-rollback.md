# RL Rollout And Rollback Workflow

Status: implemented KPI-gated rollout/rollback decision helper for issue #551; safe canary/rollback artifact contract wired for issue #1239.

Roadmap link: `docs/ops/rl-domain-roadmap.md` L6, KPI rollout/rollback.

Primary artifacts:

- `scripts/screeps_rl_rollout_manager.py`
- `scripts/test_screeps_rl_rollout_manager.py`
- `docs/ops/rl-training-reward-workflow.md`

## Purpose

The rollout manager is the live-safety boundary for RL flywheel candidates. It compares pre/post deploy KPI windows, emits deterministic JSON decision records, and describes rollback triggers. It does not upload code, change Screeps branches, run git revert, or write official MMO state.

Use it after a candidate has already passed the offline, simulator, historical, and manual-review gates. The default answer is reject unless every required KPI is observed and within contract.

## Scorecard Gate Prerequisite

Before a canary or rollback claim for a runtime-injected candidate, preserve the #924-compatible
scorecard produced by `scripts/screeps_rl_scorecard.py`:

```bash
python3 scripts/screeps_rl_scorecard.py \
  --candidate runtime-artifacts/rl-training/<run-or-candidate-bundle>/ \
  --baseline runtime-artifacts/rl-control-loop/baselines/<incumbent-bundle>/ \
  --output runtime-artifacts/rl-control-loop/scorecards/<candidate-id>.json
```

The rollout lane may continue only when the scorecard is not `INCONCLUSIVE`, has no
`safetyRegressions`, and its `runtimeCandidateGate.runtimeParameterInjection` is `true`. `PASS` is
the only positive promotion status. `HOLD` and `MIXED` remain offline evidence records, and
`ROLLBACK_REQUIRED` means candidate influence must stop before any further rollout work.

## Safe Canary Contract

Every contract, dry-run, rollback-check, and compare artifact now carries a `safeCanary` or `canaryContract` block. This block records the official-MMO safety state before any canary influence:

- incumbent baseline ref;
- candidate ID and candidate deploy ref;
- rollback ref;
- live influence state: `none`, `shadow`, `canary`, `active`, or `rolled_back`;
- allowed live influence surface: `none`, `recommendation_only`, or `bounded_high_level_strategy_knobs`;
- forbidden surfaces: raw creep intents, spawn intents, construction intents, `Memory`/`RawMemory` writes, market orders, and direct official MMO writes;
- bounded high-level strategy knob min/max limits;
- deterministic validator/veto requirements;
- pre/post sample requirements;
- rollback thresholds.

For `canary`, `active`, or `rolled_back` state, missing incumbent baseline, candidate ID, candidate deploy, or rollback refs fail validation. A forbidden live influence surface also fails validation. Training and evaluation remain artifact-only: learned/tuned candidates must not issue raw intents, Memory/RawMemory writes, market orders, or official MMO writes.

## Pre-Canary Readiness Plan

Before the controller launches any bounded official-MMO canary dry-run, create a planning-only readiness record:

```bash
python3 scripts/screeps_rl_rollout_manager.py canary-plan \
  --baseline runtime-artifacts/rl-control-loop/baselines/<incumbent-kpi-window>.json \
  --candidate-id <candidate-id> \
  --deploy-ref <candidate-policy-or-bundle-ref> \
  --scorecard-ref runtime-artifacts/rl-control-loop/scorecards/<candidate-id>.json \
  --incumbent-baseline-ref <incumbent-ref> \
  --rollback-ref <rollback-ref> \
  --active-world-ref main \
  --active-world-status matched_main \
  --official-deploy-head 14df4ae442fb68e1273aa69c182daa0328e2d868 \
  --official-deploy-run-id 27530460405 \
  --deploy-artifact runtime-artifacts/official-screeps-deploy/official-screeps-deploy-27530460405.json \
  --postdeploy-summary-artifact runtime-artifacts/official-screeps-deploy/postdeploy-summary-27530460405.json \
  --postdeploy-health-gate-artifact runtime-artifacts/official-screeps-deploy/postdeploy-health-gate-27530460405.json \
  --postdeploy-alert-artifact runtime-artifacts/official-screeps-deploy/postdeploy-alert-27530460405.json \
  --health-gate-ok true \
  --postdeploy-alert false \
  --construction-acceptance-status pass \
  --owned-spawns 1 \
  --owned-creeps 5 \
  --cpu-baseline-status <pass|hold|fail> \
  --cpu-baseline-ref runtime-artifacts/rl-control-loop/<cpu-baseline-evidence>.json \
  --conclusion-registry-ref runtime-artifacts/rl-control-loop/conclusion-registry.json \
  --conclusion-summary ACTIONED=1,VALIDATING=1,CLOSED=2 \
  --conclusion RL-CONC-20260612-004=VALIDATING \
  --conclusion RL-CONC-20260610-002=ACTIONED \
  --output runtime-artifacts/rl-control-loop/canary-plans/<candidate-id>.json
```

The output type is `screeps-rl-bounded-live-canary-plan`. It binds the candidate, scorecard, incumbent KPI window, rollback ref, postdeploy health/construction evidence, CPU gate, and current Loop A/Loop B conclusion state before a canary action exists. `readiness.status` is `ready` only when all referenced gates pass; otherwise it is `hold` with machine-readable `blockingReasons`.

This command is deliberately inert. It does not train, launch Tencent paid compute, scale ASGs, deploy code, write official MMO state, or start the live canary. Passing `--paid-compute-allowed` or `--official-mmo-write-allowed` records an unsafe requested state and blocks readiness.

## Gate Contract

The contract is available as machine-readable JSON:

```bash
python3 scripts/screeps_rl_rollout_manager.py contract
```

Observation requirements:

- Pre-deploy KPI window: at least `8` hours and `8` runtime-summary samples.
- Post-deploy KPI window: at least `8` hours and `8` runtime-summary samples.
- Missing duration or sample counts fail the dry-run gate.

Required KPI non-regression metrics:

| KPI | Source | Allowed degradation | Extra floor |
| --- | --- | ---: | ---: |
| Territory | owned room count | `0` rooms | none |
| Resources | resource score | smaller of `500` energy-equivalent points or `5%` | none |
| Kills | hostile kill score | `1` hostile kill score point | none |
| Reliability | runtime reliability score | `0.02` | post score must be at least `0.98` |

Metric direction is always higher-is-better. A metric fails when the post value is missing, the pre value is missing, degradation is greater than the allowed threshold, or reliability falls below the floor.

Resource score is normalized from explicit fixture data when present:

```json
{
  "metrics": {
    "resources": {
      "score": 10400
    }
  }
}
```

For existing `runtime-kpi-report` reducer output, the manager computes resource score as:

```text
storedEnergy + workerCarriedEnergy + harvestedEnergy + transferredEnergy
```

Reliability should be provided explicitly for rollout-grade fixture data. When a reducer report is used, reliability is derived from `runtimeSummaryCount / (runtimeSummaryCount + malformedRuntimeSummaryCount)`.

## Dry-Run Decision

Dry-run mode produces a `screeps-rl-rollout-decision` JSON record:

```bash
python3 scripts/screeps_rl_rollout_manager.py dry-run \
  --pre runtime-artifacts/rl-rollout/<candidate>/pre.json \
  --post runtime-artifacts/rl-rollout/<candidate>/post.json \
  --candidate-id <candidate-id> \
  --deploy-ref <commit-or-bundle-ref> \
  --incumbent-baseline-ref <baseline-ref> \
  --rollback-ref <previous-approved-ref> \
  --live-influence-state canary \
  --live-influence-surface bounded_high_level_strategy_knobs \
  --output runtime-artifacts/rl-rollout/<candidate>/decision.json
```

Decision values:

- `rollout_approved`: every KPI passed and both windows met the observation contract.
- `rollout_rejected`: at least one KPI or observation requirement failed.

The record includes:

- the full gate contract;
- the safe canary contract and validation status;
- normalized pre/post metrics;
- per-KPI deltas, degradation, thresholds, and reasons;
- rollback trigger specification;
- feedback-ingestion status for the next RL dataset window.

Dry-run output is evidence only. It does not authorize an automatic live deploy by itself.

## Post-Rollout Comparison

Use comparison mode after a deploy window closes:

```bash
python3 scripts/screeps_rl_rollout_manager.py compare \
  --pre runtime-artifacts/rl-rollout/<candidate>/pre.json \
  --post runtime-artifacts/rl-rollout/<candidate>/post.json \
  --candidate-id <candidate-id> \
  --deploy-ref <candidate-ref> \
  --incumbent-baseline-ref <baseline-ref> \
  --rollback-ref <previous-approved-ref> \
  --live-influence-state canary \
  --live-influence-surface bounded_high_level_strategy_knobs \
  --output runtime-artifacts/rl-rollout/<candidate>/post-rollout-comparison.json
```

The output type is `screeps-rl-post-rollout-kpi-comparison`. It is the compact record to feed back into the RL dataset pipeline as rollout outcome metadata. Approved outcomes can be tagged `rl-rollout-feedback`; rejected outcomes stay attached to the candidate as negative evidence.

## Rollback Trigger

Rollback checks may run before the full post window closes. They compare the approved baseline against the current candidate window without requiring the full 8 hours to elapse:

```bash
python3 scripts/screeps_rl_rollout_manager.py rollback-check \
  --baseline runtime-artifacts/rl-rollout/<candidate>/baseline.json \
  --current runtime-artifacts/rl-rollout/<candidate>/current.json \
  --candidate-id <candidate-id> \
  --incumbent-baseline-ref <baseline-ref> \
  --previous-deploy-ref <previous-approved-ref> \
  --current-deploy-ref <candidate-ref> \
  --output runtime-artifacts/rl-rollout/<candidate>/rollback-check.json
```

The trigger fires when, within the 8 hour observation window, any contracted KPI has measured degradation greater than its threshold or reliability drops below `0.98`. Rollback-check also fails safe with `decision:auto_revert` when required baseline/candidate/rollback refs are missing or when baseline/current sample windows are missing.

Rollback action specification:

1. Restore the previous approved deploy reference.
2. Stop candidate influence.
3. Preserve the rollback check JSON for feedback ingestion.
4. Treat the candidate as failed live evidence until a new offline/historical package supersedes it.

The helper emits `decision:auto_revert` when the trigger fires. The controller or deploy workflow owns the actual revert operation.

## Fixture Contract

All modes accept JSON fixture data. The most direct fixture shape is:

```json
{
  "type": "screeps-rl-kpi-window",
  "window": {
    "durationHours": 8,
    "sampleCount": 8
  },
  "metrics": {
    "territory": {
      "ownedRooms": 2
    },
    "resources": {
      "score": 10000
    },
    "kills": {
      "score": 3
    },
    "reliability": {
      "score": 0.995
    }
  }
}
```

Reducer-style `runtime-kpi-report` fixtures are also accepted for territory, resources, kills, observation duration, sample count, and derived reliability.

## Safety Rules

- Default decision is reject.
- Missing required KPI data fails dry-run approval.
- Missing observation duration or sample count fails dry-run approval.
- Rollback checks can trigger before the full observation window closes.
- Kills cannot compensate for resource, territory, or reliability degradation.
- Resources cannot compensate for territory or reliability degradation.
- The manager does not perform live writes. It creates evidence records for the controller to act on.

## Verification

Local checks:

```bash
python3 -m py_compile scripts/screeps_rl_rollout_manager.py
python3 -m py_compile scripts/test_screeps_rl_rollout_manager.py
python3 scripts/test_screeps_rl_rollout_manager.py
git diff --check
```
