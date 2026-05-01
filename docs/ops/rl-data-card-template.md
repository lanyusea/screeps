# RL Data Card Template

Use this template for future Screeps RL or strategy-recommendation datasets. Fill it before training, replay validation, or publishing a sanitized dataset sample.

## Dataset Identity

- Dataset name:
- Run ID:
- Owning issue:
- Dataset schema version:
- Bot commit:
- Exporter command:
- Export date:
- Maintainer:

## Intended Use

- Allowed use:
- Disallowed use:
- Learned-policy output surface:
- Raw creep-intent control allowed: no
- Official MMO live influence allowed: no, unless simulator evidence, historical MMO validation, KPI rollout gates, and rollback gates pass.

## Source Artifacts

- Source roots:
- Source artifact count:
- Runtime-summary count:
- Monitor-summary count:
- Simulator trace count:
- Strategy-shadow artifact count:
- First tick:
- Latest tick:
- Shards/rooms:
- Known missing sources:

## Schema Summary

- Scenario manifest:
- Run manifest:
- Source index:
- Tick samples:
- KPI windows:
- Episodes:
- Additional files:

## Observation Fields

List observation fields used by this dataset and whether they came from official MMO artifacts, private simulator traces, monitor summaries, or derived reducers.

| Field | Source | Coverage | Notes |
| --- | --- | --- | --- |
|  |  |  |  |

## Action Labels

Action labels must remain high-level recommendations.

| Surface | Source field | Registry family | Coverage | Live effect |
| --- | --- | --- | --- | --- |
| construction priority | `constructionPriority.nextPrimary` | `construction-priority` |  | no |
| expansion/remote candidate | `territoryRecommendation.next` | `expansion-remote-candidate` |  | no |
| defense posture |  | `defense-posture-repair-threshold` |  | no |

## Reward Contract

Describe reward components in lexicographic order.

1. Reliability and survival floor:
2. Territory:
3. Resources:
4. Enemy kills/combat:
5. Cost penalties:

Scalar reward approved: no

If a scalar is introduced later, explain why later objectives cannot compensate for reliability or territory regressions.

## Train/Eval Split

- Split method:
- Split seed:
- Eval ratio:
- Train count:
- Eval count:
- Leakage checks:

## Validation Plan

- Offline replay checks:
- Private simulator checks:
- Historical MMO validation:
- Out-of-distribution rejection:
- Deterministic validator checks:
- KPI pass/fail gates:
- Rollback gates:

## Biases And Coverage Gaps

- Room/RCL coverage:
- Combat coverage:
- Economy coverage:
- Territory/remote coverage:
- Seasonal or shard-specific assumptions:
- Known stale artifacts:

## Redaction And Retention

- Raw source contents copied: no
- Secret classes excluded:
- Redaction method:
- Storage location:
- Retention period:
- Publication status:
- Review required before commit/publish:

## Safety Decision

- Dataset approved for offline training/replay:
- Dataset approved for official MMO shadow recommendations:
- Dataset approved for live high-level recommendation behind validators:
- Dataset approved for direct official MMO control: no
- Reviewer:
- Decision date:
- Notes:
