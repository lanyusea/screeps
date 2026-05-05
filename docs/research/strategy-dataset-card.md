# Strategy Recommendation Dataset Card

## Purpose

This first issue #266 slice defines an offline JSONL dataset for high-level Screeps strategy recommendation. It is intended for replay analysis, incumbent heuristic baselines, and future offline RL experiments. It is not approved to control live Screeps MMO behavior.

## Source Windows

- Extractor: `scripts/extract-strategy-dataset.py`
- Default artifact scan roots: the existing runtime artifact scanner defaults from `scripts/screeps_rl_dataset_export.py`, including local `runtime-artifacts`, `/root/screeps/runtime-artifacts`, and cron output when present.
- Source artifact types: `#runtime-summary` lines and JSON runtime summary documents discovered in local artifacts.
- Windowing: per-room chronological windows, default size 3 runtime summaries. If fewer than 3 summaries exist for a room, the extractor may emit one partial window.
- Raw artifact text is not copied into the dataset. Rows retain source path display names, line numbers, source SHA-256, tick, and selected numeric/label fields.

## Strategy Versions

- Registry source: `prod/src/strategy/strategyRegistry.ts`
- Current incumbent families represented as labels:
  - `construction-priority.incumbent.v1`
  - `expansion-remote.incumbent.v1`
  - `defense-repair.incumbent.v1`
- Shadow candidates remain metadata only. Dataset rows label observed incumbent decisions and do not mark shadow candidates as live actions.

## Observation Features

Each JSONL row stores a room-state feature snapshot from the latest summary in the source window:

- RCL: controller level.
- Creeps: worker count, total count when available, task counts.
- Energy: available energy, capacity, stored energy, carried energy, dropped energy.
- Hostiles: hostile creep and hostile structure counts.
- Territory: observed owned-room count, source count, remote candidate count, expansion candidate count, and next high-level territory target when present.

## Action Labels

Labels are high-level strategy surfaces only:

- `strategyPreset`: joined incumbent strategy IDs selected from the registry for the observed decision surfaces.
- `expansionTarget`: target room when the observed territory action is `claim` or `occupy`.
- `remoteTarget`: target room when the observed territory action is `reserve` or `scout`.
- `constructionPriority`: observed `constructionPriority.nextPrimary.buildItem`.
- `defensePosture`: `passive`, `alert`, or `active` from hostile pressure.

No row contains low-level creep intents, spawn commands, or direct construction placement actions as policy outputs.

## Reward Construction

Rows use a component reward label, not an approved scalar objective:

- Territory: controller level delta across the window, owned-room observation, controller non-degradation, and downgrade guard.
- Resources: stored energy delta and latest energy capacity.
- Kills/defense: latest hostile pressure and matching defense posture.

A row is emitted only when the heuristic success filter passes: at least one high-level label exists, the controller did not degrade, downgrade risk is not critical, worker survival is observed, and hostile pressure is either absent or paired with active defense posture.

## Known Bias

- Artifacts are local and opportunistic, so they overrepresent rooms and ticks where telemetry was enabled and saved.
- Labels come from incumbent behavior, not expert human review or a trained optimum.
- Early-game rooms may dominate because the current official target has historically focused on bootstrap and survival.
- Hostile and combat labels depend on visibility; unseen adjacent-room risk is underrepresented.
- Successful windows are filtered with conservative heuristics, which can exclude valid recovery states with incomplete telemetry.

## Train/Eval Split

- Method: deterministic SHA-256 threshold on `splitSeed:sampleId`.
- Default eval ratio: `0.2`.
- Default split seed: `screeps-strategy-recommendation-v1`.
- Splits are stable for a fixed source set, window size, registry version, and sample ID construction.

## Safety

The dataset and recommender are shadow-mode only. Learned or heuristic recommendations must pass simulator evidence, historical MMO validation, KPI rollout gates, and rollback gates before any future live influence is considered.
