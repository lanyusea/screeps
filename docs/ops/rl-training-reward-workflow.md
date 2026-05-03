# RL Training Reward Workflow

Status: implemented training framework and reward workflow for issue #549.

Roadmap link: `docs/ops/rl-domain-roadmap.md` L4, Slice C.

Primary artifacts:

- `scripts/screeps_rl_experiment_card.py`
- `docs/research/2026-05-03-rl-training-approaches.md`
- `scripts/screeps_rl_dataset_export.py`
- `scripts/screeps_strategy_shadow_report.py`
- `scripts/screeps_rl_simulator_harness.py`

## Purpose

The RL training lane sits between the private-server simulator harness and historical validation. It may create offline experiment cards, candidate weight vectors, and shadow recommendations. It must not create an official MMO control path.

Use the helper to link a dataset run and bot commit:

```bash
python3 scripts/screeps_rl_experiment_card.py \
  --dataset-run-id <run-id> \
  --code-commit <commit-sha> \
  --training-approach bandit
```

Dry-run generation is allowed for pipeline checks:

```bash
python3 scripts/screeps_rl_experiment_card.py --dry-run --dataset-run-id rl-000000000000
```

Validate an existing card:

```bash
python3 scripts/screeps_rl_experiment_card.py --validate --input runtime-artifacts/rl-experiment-cards/<card>.json
python3 scripts/screeps_rl_experiment_card.py self-test
```

The card is deterministic JSON. `card_id` is derived from `dataset_run_id` plus the first 12 hex characters of `code_commit`. Output goes to stdout unless `--output <path>` is provided.

## Experiment Card Contract

Every experiment card records exactly the offline decision surface:

- `card_id`
- `dataset_run_id`
- `code_commit`
- `training_approach`: `bandit`, `evolutionary`, or `policy_gradient`
- `reward_model`: lexicographic component order and dominance weights
- `safety`
- `created_at`
- `status`: always `shadow`

The safety block must preserve:

```json
{
  "liveEffect": false,
  "officialMmoWrites": false,
  "officialMmoWritesAllowed": false,
  "ood_rejection": true,
  "conservative_actions_only": true
}
```

Validation fails if `liveEffect`, `officialMmoWrites`, or `officialMmoWritesAllowed` is anything except `false`.

## Reward Definition

The reward function is lexicographic. The expression below is documentation for dominance order, not permission to let a later component compensate for an earlier failure:

```text
R = α·R_reliability + β·R_territory + γ·R_resources + δ·R_kills
where α ≫ β ≫ γ ≫ δ
```

Interpretation:

- `R_reliability` dominates every other component.
- `R_territory` is evaluated only after reliability passes.
- `R_resources` is evaluated only after reliability and territory pass.
- `R_kills` is last and cannot justify losses in reliability, territory, or economy.

The experiment card encodes dominance weights as:

```json
{
  "alpha_reliability": 1000000000,
  "beta_territory": 1000000,
  "gamma_resources": 1000,
  "delta_kills": 1
}
```

These are guardrail weights for auditability. They are not a scalar weighted-sum approval.

## Reward Components

`R_reliability`:

- owned spawns remain `owned_spawns > 0`;
- owned creeps remain `owned_creeps >= 3`;
- no controller downgrade risk window is introduced or hidden;
- no loop exceptions, uncaught errors, telemetry silence, memory corruption, or CPU bucket collapse.

`R_territory`:

- owned room count delta;
- RCL progression and controller progress;
- controller reservation uptime for remote rooms;
- safe expansion, reserve, and remote target quality.

`R_resources`:

- stored energy plus carried energy delta;
- source utilization and harvested energy;
- useful transfer/logistics throughput;
- GCL progress and sustainable economy conversion.

`R_kills`:

- hostile creep destruction delta;
- hostile structure destruction delta;
- hostile objective denial;
- own creep, structure, and room-loss penalties.

## OOD And Conservative Rejection

Default decision is reject. A learned recommendation advances only when it is in-distribution, conservative, and accepted by deterministic production validators.

Hard rejection rules:

- Any learned policy recommendation that would reduce `owned_creeps` below `3` is automatically rejected.
- Any action that would abandon or downgrade the last owned controller is rejected.
- Any candidate with `liveEffect:true`, official MMO writes, Memory writes, RawMemory writes, raw creep intent authority, spawn intent authority, construction intent authority, or market intent authority is rejected.
- The production bot's deterministic validators in `prod/src/` are always the final gate before any later high-level live recommendation path.

OOD detection:

- Track current game state dimensions: room count, RCL distribution, and hostile density.
- Compare each dimension against every training scenario distribution.
- If the current state differs from all training scenarios by more than `2σ` in any dimension, flag as OOD and reject all learned recommendations.
- If a dimension lacks enough training support to estimate `σ`, treat it as OOD for promotion decisions.

Shadow evidence gate:

- Shadow evaluation must show at least one full 8h Gameplay Evolution review cycle with positive KPI delta before any recommendation reaches `consider for manual review`.
- Positive KPI delta must respect lexicographic order: reliability non-regression first, then territory, then resources, then kills.
- Missing historical validation from the #417 lane blocks promotion beyond offline/shadow analysis.

## Baseline Experiment

The dry baseline proves the end-to-end shape without claiming real training.

Variant A is the incumbent registry baseline from `prod/src/strategy/strategyRegistry.ts`:

| Surface | base | territory | resources | kills | risk |
| --- | ---: | ---: | ---: | ---: | ---: |
| `construction-priority.incumbent.v1` | 1.0 | 6.0 | 4.0 | 6.0 | 4.0 |
| `expansion-remote.incumbent.v1` | 1.0 | 8.0 | 5.0 | 2.0 | 10.0 |

Variant B is the trivial perturbation for the dry baseline:

| Surface | base | territory | resources | kills | risk |
| --- | ---: | ---: | ---: | ---: | ---: |
| `construction-priority.perturb-territory-plus10.v0` | 1.0 | 6.6 | 3.6 | 6.0 | 4.0 |
| `expansion-remote.perturb-territory-plus10.v0` | 1.0 | 8.8 | 4.5 | 2.0 | 10.0 |

Dry result:

- Training approach: `bandit`.
- Dataset run ID: `rl-000000000000`.
- Recommendation: keep Variant A as incumbent; Variant B is a shadow-only candidate for future replay because no 8h positive KPI delta or historical validation exists yet.
- Safety state: `shadow`, `liveEffect:false`, `officialMmoWrites:false`, `officialMmoWritesAllowed:false`.

Sample experiment card:

```json
{
  "card_id": "rl-exp-rl-000000000000-371161645c28",
  "code_commit": "371161645c28b694d9de5808fbf7223c99b10cf0",
  "created_at": "2026-05-03T00:00:00Z",
  "dataset_run_id": "rl-000000000000",
  "reward_model": {
    "component_order": [
      "reliability",
      "territory",
      "resources",
      "kills"
    ],
    "component_weights": {
      "alpha_reliability": 1000000000,
      "beta_territory": 1000000,
      "delta_kills": 1,
      "gamma_resources": 1000
    },
    "formula": "R = alpha*R_reliability + beta*R_territory + gamma*R_resources + delta*R_kills; alpha >> beta >> gamma >> delta",
    "scalar_weighted_sum_authorized": false,
    "type": "lexicographic"
  },
  "safety": {
    "conservative_actions_only": true,
    "liveEffect": false,
    "officialMmoWrites": false,
    "officialMmoWritesAllowed": false,
    "ood_rejection": true
  },
  "status": "shadow",
  "training_approach": "bandit"
}
```

## Promotion Gates

Candidate evidence must advance in this order:

1. Dataset gate: dataset run ID, source index, data card, split metadata, and no raw secrets.
2. Experiment-card gate: code commit, training approach, lexicographic reward model, and safety fields validated.
3. Shadow gate: incumbent-vs-candidate report with `liveEffect:false` and bounded ranking/KPI evidence.
4. Simulator gate: resettable private-server evidence with determinism and throughput metadata.
5. Historical gate: official-MMO historical validation with OOD and reliability rejection.
6. Manual-review gate: at least one full 8h positive KPI shadow cycle and an explainable recommendation.
7. Rollout gate: bounded high-level strategy rollout plan with rollback trigger and post-window ingestion.

This workflow cannot promote a candidate to live influence by itself.

## Verification

Local checks:

```bash
python3 -m py_compile scripts/screeps_rl_experiment_card.py
python3 scripts/screeps_rl_experiment_card.py self-test
python3 scripts/screeps_rl_experiment_card.py --dry-run --dataset-run-id rl-000000000000
python3 scripts/screeps_rl_experiment_card.py --dry-run --dataset-run-id rl-000000000000 --output /tmp/test-card.json
python3 scripts/screeps_rl_experiment_card.py --validate --input /tmp/test-card.json
```
