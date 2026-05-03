# RL Rollout And Rollback Workflow

Status: implemented KPI-gated rollout/rollback decision helper for issue #551.

Roadmap link: `docs/ops/rl-domain-roadmap.md` L6, KPI rollout/rollback.

Primary artifacts:

- `scripts/screeps_rl_rollout_manager.py`
- `scripts/test_screeps_rl_rollout_manager.py`
- `docs/ops/rl-training-reward-workflow.md`

## Purpose

The rollout manager is the live-safety boundary for RL flywheel candidates. It compares pre/post deploy KPI windows, emits deterministic JSON decision records, and describes rollback triggers. It does not upload code, change Screeps branches, run git revert, or write official MMO state.

Use it after a candidate has already passed the offline, simulator, historical, and manual-review gates. The default answer is reject unless every required KPI is observed and within contract.

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
  --output runtime-artifacts/rl-rollout/<candidate>/decision.json
```

Decision values:

- `rollout_approved`: every KPI passed and both windows met the observation contract.
- `rollout_rejected`: at least one KPI or observation requirement failed.

The record includes:

- the full gate contract;
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
  --previous-deploy-ref <previous-approved-ref> \
  --current-deploy-ref <candidate-ref> \
  --output runtime-artifacts/rl-rollout/<candidate>/rollback-check.json
```

The trigger fires when, within the 8 hour observation window, any contracted KPI has measured degradation greater than its threshold or reliability drops below `0.98`.

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
```
