# RL Policy-Family Flywheel

Status: canonical policy-family routing contract for the RL flywheel. Active work is selected from Project `screeps` atomic issues with `Domain = RL flywheel`; #879 is historical context only, and #1589 is migration-only while the no-umbrella contract lands.

## No-New-Cron Rule

Policy-family routing does not create new cron jobs, Discord thread jobs, or parallel registries. Existing runtime artifact collection, E1 dataset labeling, Gameplay Evolution review, Act-loop planning, Loop A training, Loop B online advantage review, RL steward cadence, continuation worker, scorecard, canary, and feedback jobs remain the execution surfaces.

The routing layer is metadata only. It must not change official MMO behavior, make official writes, alter rewards without a #907-style decision, or claim rollout/policy improvement without scorecard and canary evidence.

## Flow

```text
runtime artifacts
  -> E1 labels with policy-family metadata
  -> Gameplay Evolution / Act route
  -> Loop A training ledger by family
  -> Loop B online advantage by family
  -> RL steward chooses the next family, gate, or blocker
  -> continuation worker keeps GitHub Issue/PR/Project execution unchanged
  -> scorecard, canary, and feedback gates remain mandatory
```

The Act route may carry `policyFamily`, `topAgent`, `rolePolicy`, and nested `route` or `routing` metadata. Downstream artifacts should preserve those fields alongside the existing classification, parameter-surface, reward-decision, scenario, and experiment-card data.

## Initial Families

Top-level policy families:

- `top.bootstrap`
- `top.economy`
- `top.construction`
- `top.upgrade`
- `top.defense`
- `top.remote-expansion`
- `top.offense`

Role and lower-level policy families:

- `role.worker-task`
- `role.source-harvester`
- `role.tower-action`
- `role.hauler-routing`
- `role.builder-repair`
- `role.upgrader-budget`
- `role.defender-micro`
- `role.attacker-micro`

`top.offense` and `role.attacker-micro` stay offline/private-only until later owner-approved gates explicitly permit broader use.

## MVP Surface

The first durable slice is plumbing, not a behavior rollout.

- `top.construction` bridges the existing `construction-priority` candidate stream into the top-level hierarchy.
- `role.worker-task`, `role.source-harvester`, and `role.defender-micro` are the initial role-policy lanes for later dataset, training, scorecard, and canary work.
- `role.tower-action` is recognized as a route fallback for tower-action policy-surface findings, but it does not authorize live tower behavior changes.
- Top-level `construction-priority` or `top.construction` canary evidence remains high-level policy evidence only. It must not be counted as role-policy completion for worker-task, source-harvester, or defender-micro lanes.

When explicit route fields are absent, the only initial fallback mappings are:

| Parameter surface | Policy family |
| --- | --- |
| `construction-priority` | `top.construction` |
| `worker-task` | `role.worker-task` |
| `source-harvester` | `role.source-harvester` |
| `harvester` | `role.source-harvester` |
| `defender-micro` | `role.defender-micro` |
| `defender` | `role.defender-micro` |
| `tower-action` | `role.tower-action` |

All other parameter surfaces keep the existing `parameterSurface` behavior without inventing a policy-family route.

## Gates

Reward, scorecard, canary, and feedback gates remain mandatory for every policy family:

- Reward changes still require the #907 decision registry and evidence before training use.
- Training output remains offline/shadow/private until candidate-vs-baseline scorecard evidence exists.
- Canary and rollback evidence are required before any official MMO influence.
- Feedback ingestion must link the finding, decision/card, training report, scorecard, and rollout feedback state before a family can be treated as self-iterating.
