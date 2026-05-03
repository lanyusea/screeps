# Screeps RL Training Approaches

Date: 2026-05-03

Scope: compare training approaches for Screeps strategy optimization behind the offline/shadow safety boundary. The target decision surfaces are high-level strategy choices such as expansion target ranking, room reservation priority, construction priority ordering, and bounded strategy weight vectors. Raw creep intents, spawn intents, construction intents, market orders, `Memory`, `RawMemory`, and official MMO writes remain out of scope.

## Decision Summary

Start with contextual bandit or simple evolutionary tuning over bounded strategy knobs. Defer policy-gradient training until the simulator can provide many resettable, deterministic episodes and historical validation has enough coverage to detect unsafe exploration and OOD recommendations.

The common reward contract is lexicographic:

```text
reliability -> territory -> resources -> kills
```

Scalar training scores may exist inside an experiment only if the card proves later objectives cannot compensate for earlier failures.

## Contextual Bandit

Representative methods:

- LinUCB over contextual feature vectors and discrete actions.
- Thompson sampling over candidate strategy presets.
- Conservative offline bandit selection from saved shadow reports.

Useful action surfaces:

- which room to expand, reserve, or scout next;
- construction priority preset or bounded ordering adjustment;
- defense posture preset;
- remote target ranking among known candidates.

Signal requirements:

- Per decision context: room count, RCL distribution, controller downgrade risk, owned creep count, spawn state, energy, hostile density, source coverage, and CPU bucket.
- Per action: high-level candidate ID, current incumbent score, candidate score, preconditions, risks, and expected KPI movement.
- Per review window: lexicographic reward components and a conservative accept/reject label.

Sample complexity estimate:

- Tens to hundreds of logged decisions can rank a small set of discrete presets if contexts are stable and rewards are windowed.
- Hundreds to low thousands of contexts are needed before per-room/RCL segmentation is meaningful.
- It is still sparse for rare combat and expansion events, so confidence bounds must stay conservative.

Safety characteristics:

- Strong first fit because it can run offline and choose only among bounded high-level actions.
- Exploration can be disabled on the official MMO; offline replay and shadow reports provide candidate evidence.
- Model output is interpretable as action scores, uncertainty, and support counts.

Screeps-specific challenges:

- Rewards are delayed across many ticks, so the bandit frame must aggregate over review windows instead of pretending every tick has immediate feedback.
- Context drift is common as rooms change RCL, controller progress, roads, sources, and hostile pressure.
- Logged actions are biased toward incumbent behavior; OOD rejection is mandatory.

Recommended first experiment shape:

- Use `scripts/screeps_rl_dataset_export.py` plus strategy-shadow reports as the context/action/reward table.
- Train a conservative bandit over two strategy families: construction priority and expansion/remote ranking.
- Compare incumbent weights against one mild perturbation: territory +10%, resources -10%.
- Emit only an experiment card and an offline recommendation: keep incumbent unless shadow evidence shows one full 8h positive KPI cycle.

## Evolutionary Tuning

Representative methods:

- CMA-ES over continuous strategy parameter vectors.
- Simple genetic algorithm over bounded strategy registry knobs.
- Population search with deterministic seed and simulator scenario manifests.

Useful action surfaces:

- expansion scoring weights;
- construction priority scoring weights;
- defense posture thresholds;
- source/remote preference weights.

Signal requirements:

- Scenario manifests with fixed seeds, bot commit, map fixture, room target, and reset metadata.
- Candidate vector registry: parameter names, bounds, mutation policy, parent IDs, and rollback target.
- Episode-level KPI summary: reliability pass/fail, territory delta, resources delta, kills/losses, wall-clock throughput, and determinism status.

Sample complexity estimate:

- Simple GA smoke: 10-50 variants across a handful of short private-server scenarios can reveal obvious regressions.
- CMA-ES or stable population search: hundreds of variants and repeated seeds are likely needed for a reliable improvement signal.
- Noise from stochastic room state means each promising vector should be replayed several times before promotion.

Safety characteristics:

- Good fit for non-differentiable Screeps mechanics because it does not require gradients.
- Naturally parallel across private-server workers.
- Safe when all candidates are offline vectors and production validators remain final gate.

Screeps-specific challenges:

- Simulator reset fidelity matters; a vector can exploit a narrow private scenario and fail in the official MMO.
- Reward noise is high because small timing differences affect spawn queues, controller progress, roads, and hostile interactions.
- The search can find brittle values at knob bounds unless mutation and selection are constrained.

Recommended first experiment shape:

- Use a tiny population: incumbent plus 4-8 bounded perturbations.
- Keep mutations to strategy registry knobs already documented in `prod/src/strategy/strategyRegistry.ts`.
- Evaluate with the private-server harness once reset/step evidence is available; before that, record only dry experiment cards and shadow-replay comparisons.
- Promote nothing beyond manual review without historical validation and 8h positive KPI shadow evidence.

## Policy Gradient

Representative methods:

- PPO or SAC through an RLlib-style distributed environment.
- PPO through a Stable-Baselines-style local vectorized environment.
- Later hierarchical policy over high-level recommendation actions.

Useful action surfaces:

- Observation-to-action policies over high-level actions after a Gymnasium-style adapter exists.
- Hierarchical decisions such as `construction_preset`, `remote_target`, `expansion_candidate`, `defense_posture`, or `weight_vector`.

Signal requirements:

- Resettable simulator environment with `reset`, `step`, `observe`, and deterministic artifact export.
- Observation schema stable across room phases: creeps, structures, controller, resources, terrain, hostiles, CPU, memory summaries, and event logs.
- Action schema with deterministic validators and conservative rejection.
- Long-window rewards with reliability and territory gates.

Sample complexity estimate:

- Tens of thousands of simulator steps are enough only for adapter smoke tests.
- Millions of room ticks are a realistic lower bound for nontrivial high-level behavior.
- Thousands of ticks can separate action from outcome, so credit assignment remains difficult even with dense auxiliary signals.

Safety characteristics:

- Highest potential for long-horizon sequential behavior, but highest operational risk.
- Exploration safety on the official MMO is unacceptable without offline gates, historical validation, OOD rejection, and manual review.
- Raw control policies must remain disallowed; any learned output must be high-level and validator-gated.

Screeps-specific challenges:

- Partial observability, persistent world state, CPU limits, spawn queues, and long RCL horizons make reward attribution hard.
- A policy can overfit private-server physics, fixture maps, or weak enemy coverage.
- Bad exploration can lose the last room or corrupt persistent state if it ever bypasses gates.

Recommended first experiment shape:

- Do not start with PPO/SAC as the issue #549 baseline.
- First build a Gymnasium-style wrapper smoke after the simulator harness proves deterministic reset and throughput.
- Train only against private fixtures, high-level actions, and conservative validators.
- Treat any policy-gradient artifact as research evidence until it passes historical validation and an 8h positive KPI shadow cycle.

## Recommended Path

1. Generate experiment cards with `scripts/screeps_rl_experiment_card.py`.
2. Use contextual bandit scoring for the first dry baseline because it is sample-efficient, interpretable, and easy to keep shadow-only.
3. Add evolutionary tuning when private-server scenarios are repeatable enough to compare small populations.
4. Defer policy gradient until the simulator environment has reset/step/observe, vectorized throughput, and enough historical data to reject unsafe OOD recommendations.
