# RL Act-Loop Feedback Runbook

Status: first offline planning surface for issue #1240.

Primary artifacts:

- `scripts/screeps_rl_act_loop_planner.py`
- `scripts/test_screeps_rl_act_loop_planner.py`
- `scripts/fixtures/rl/act-loop-mixed-unproven-policy-advantage.json`
- `docs/ops/rl-policy-family-flywheel.md`
- `docs/ops/rl-reward-decision-registry.md`
- `docs/ops/rl-training-reward-workflow.md`

## Purpose

The Act loop converts Loop B, policy-advantage, scorecard, or Gameplay Evolution findings into a structured next step:

```text
online/gameplay finding -> reward/scenario/policy hypothesis -> GitHub-managed decision -> experiment card delta -> training run -> scorecard -> rollout/feedback
```

Foundation issues #906, #907, and #924 are source contracts only. Their closure is not completion evidence for #1240. A current finding still needs an explicit decision, card delta, training artifact, scorecard, and rollout/feedback state.

## Planner Contract

Generate a deterministic offline plan:

```bash
python3 scripts/screeps_rl_act_loop_planner.py \
  runtime-artifacts/rl-control-loop/policy-advantage.json \
  --source-artifact runtime-artifacts/rl-control-loop/policy-advantage.json \
  --output runtime-artifacts/rl-control-loop/act-loop-plan.json
```

The planner only reads JSON and writes JSON. It does not call GitHub, Screeps official APIs, private servers, Tencent compute, cron, deploy, or `prod/` runtime code.

Each plan emits:

- `finding`: stable finding id, title, source artifact, evidence window, primary `classification`, secondary classifications, metric evidence, policy-family route metadata, and missing scenario capabilities when present.
- `nextRewardDecision`: a #907-style reward decision record route when the finding is a `reward_gap`.
- `nextScenarioDelta`: a private/shadow scenario or fixture delta when the finding is a `scenario_gap`.
- `nextPolicyDelta`: a named policy parameter surface with explicit bounds when the finding is a `policy_parameterization_gap`.
- `nextExperimentCardDelta`: the card-helper-compatible shadow training delta that consumes reward/scenario/policy changes.
- `feedbackIngestion`: current state for finding -> decision -> card -> training -> scorecard -> rollout feedback.
- `decision`, `status`, and `blockingReasons`: fields that the SQLite/Grafana ingestion path can count through `metric_iteration_decisions`.

Policy-family routing follows `docs/ops/rl-policy-family-flywheel.md`: no new cron lanes, flexible `policyFamily` / `topAgent` / `rolePolicy` fields, and fallback only from known `parameterSurface` names such as `construction-priority -> top.construction`.

Allowed classifications:

| Classification | Steward route |
| --- | --- |
| `data_quality` | Fix evidence, telemetry, compute, or artifact coverage before changing training. |
| `scenario_gap` | Create or select a private/shadow scenario delta, then update the experiment card. |
| `reward_gap` | Create or update a #907-style decision record before any reward training use. |
| `policy_parameterization_gap` | Name the policy surface and bounds, then update the experiment card. |
| `runtime_bug` | Route to a construction issue; do not disguise runtime fixes as reward tuning. |
| `rollout_regression` | Preserve rollback evidence before any new training card changes. |

## Steward Consumption

Loop B and RL steward prompts should consume the structured fields directly:

1. If `nextRewardDecision` is present, create or update the reward decision record first. Required fields are metric evidence, hypothesis, validation window, rollback condition, and candidate linkage.
2. If `nextScenarioDelta` is present, apply it as an experiment-card delta or open a bounded construction issue for the missing fixture. Do not leave it as prose-only advice.
3. If `nextPolicyDelta` is present, preserve `parameterSurface` and every bound in the experiment card or construction issue. Unbounded policy suggestions remain blocked.
4. If `nextExperimentCardDelta` is present, generate or update a shadow/offline card with `scripts/screeps_rl_experiment_card.py`, then validate it before training.
5. After training, update `feedbackIngestion.training`; after scorecard generation, update `feedbackIngestion.scorecard`; after rollout/rollback comparison, update `feedbackIngestion.rolloutFeedback`.

All generated cards and decisions must keep:

```json
{
  "liveEffect": false,
  "officialMmoWrites": false,
  "officialMmoWritesAllowed": false
}
```

## Example

The fixture `scripts/fixtures/rl/act-loop-mixed-unproven-policy-advantage.json` represents a MIXED/UNPROVEN Loop B policy-advantage finding. It is classified as `scenario_gap` with a secondary `policy_parameterization_gap`, producing:

- `nextScenarioDelta.targetScenarioId = "multi-tier-territory-combat-v0"`
- `nextPolicyDelta.parameterSurface = "construction-priority"` with bounded weights
- `nextExperimentCardDelta.trainingApproach = "policy_gradient"`
- no `nextRewardDecision`, because the evidence does not justify reward tuning yet

## Verification

Local checks for planner changes:

```bash
python3 -m py_compile scripts/screeps_rl_act_loop_planner.py scripts/test_screeps_rl_act_loop_planner.py
python3 -m unittest scripts/test_screeps_rl_act_loop_planner.py -v
git diff --check
```
