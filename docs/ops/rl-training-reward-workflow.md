# RL Training Reward Workflow

Status: first bounded workflow artifact for issue #416.

Roadmap link: `docs/ops/rl-domain-roadmap.md` L4, Slice C.

Inputs:

- `docs/research/2026-04-29-screeps-rl-self-evolving-strategy-paper.md`
- `docs/research/2026-05-01-overmind-rl-architecture-audit.md`
- `docs/ops/rl-dataset-pipeline.md`
- `docs/ops/rl-simulator-harness.md`
- `scripts/screeps_rl_dataset_export.py`
- `scripts/screeps_strategy_shadow_report.py`
- `scripts/screeps_rl_simulator_harness.py`

## Purpose

This slice chooses the initial training and reward workflow for Screeps strategy iteration without creating any live control path. The artifact produced here is an offline experiment card:

```bash
python3 scripts/screeps_rl_experiment_card.py generate \
  runtime-artifacts/rl-datasets/<run-id>/run_manifest.json \
  runtime-artifacts/strategy-shadow/<report-id>.json \
  runtime-artifacts/rl-simulator-harness/<manifest-id>/simulator_harness_manifest.json \
  --out-dir runtime-artifacts/rl-experiment-cards \
  --card-id <card-id>
```

The output is local derived metadata:

```text
runtime-artifacts/rl-experiment-cards/<card-id>/
  experiment_card.json
  experiment_card.md
```

`runtime-artifacts/` is ignored. The helper is stdlib-only, deterministic for the same inputs, and can validate generated cards:

```bash
python3 scripts/screeps_rl_experiment_card.py validate \
  runtime-artifacts/rl-experiment-cards/<card-id>/experiment_card.json
python3 scripts/screeps_rl_experiment_card.py self-test
```

## Safety Boundary

no learned or tuned policy may directly control official MMO creep intents, spawn intents, construction intents, market orders, Memory writes, or RawMemory commands until simulator evidence, historical official-MMO validation, private/shadow safety gate, KPI rollout gates, and rollback gates pass. Initial outputs remain offline/shadow/high-level recommendations only.

The experiment card must preserve:

```json
{
  "liveEffect": false,
  "officialMmoWrites": false,
  "officialMmoWritesAllowed": false
}
```

The validator rejects generated cards with live effects, official MMO writes, official MMO write allowance, network requirement, live secret requirement, Memory writes, RawMemory writes, raw creep intent control, or creep/spawn/market intent authority.

## Framework Comparison

| Stack | Implementation cost | Vectorized env support | Checkpointing | Distributed/parallel training | TypeScript Screeps integration | First-use decision |
| --- | --- | --- | --- | --- | --- | --- |
| Contextual bandit/evolutionary tuning | Low | Does not require a Gym env; batch datasets and simulator scenarios can be parallelized | Candidate weight vectors, registry version, reward card, dataset/shadow/simulator evidence | Cron batches or multiprocessing first; population-style search later | Emits bounded strategy weights or high-level recommendations for deterministic validators | Recommended first stack |
| Gymnasium-style wrappers | Medium | Good once #414 exposes reset/step/observe; supports local vectorized envs | Wrapper config, seeds, scenario manifest, reward card, and downstream algorithm checkpoint | Local vectorized workers first; can feed SB3 or RLlib later | Needs a typed adapter from Python actions to TypeScript recommendation validators | Build after simulator adapter exists |
| RLlib-style distributed training | High | Strong fit for many private-server workers and multi-agent/vectorized scenarios | Ray checkpoints plus exact scenario/dataset/reward manifests | Native distributed workers and env runners | Requires hardened local control API and strict high-level action schema | Defer until throughput/determinism evidence is real |
| Stable-Baselines-style local training | Medium | Good single-host VecEnv baseline, weaker cluster story | Model zip/checkpoints plus exact wrapper, seed, reward card, and manifests | Local/vectorized only by default | Requires same Gymnasium adapter and high-level recommendation output | Useful smoke baseline after wrapper exists |
| Conservative heuristic/baseline path | Very low | Not required; evaluate incumbent and fixed candidate weights over saved evidence | Bot commit, strategy registry entry, card ID, dataset run ID, report IDs | Cron/offline report batches | Already matches deterministic strategy surfaces | Required baseline and rollback target |

## Recommended First Stack

Use the conservative heuristic baseline plus contextual-bandit/evolutionary tuning over bounded high-level strategy knobs.

Initial candidate surfaces:

- construction priority preset or bounded weight vector;
- remote target ranking;
- expansion candidate ranking;
- defense posture preset;
- strategy-family selector for offline/shadow comparison.

Why this is first:

- It consumes the existing dataset exporter, strategy-shadow reports, and simulator dry-run manifests now.
- It does not need a live Gym/RLlib/SB3 dependency before #414 has a real reset/step/observe adapter.
- It can checkpoint candidates as JSON/registry entries and compare them with the incumbent.
- It keeps integration with the TypeScript bot at the strategy-validator layer, not at raw intent control.

Deferred stacks:

- Gymnasium wrappers are the next interface once #414 can reset and step private scenarios.
- Stable-Baselines-style local training is useful for small local baselines after the wrapper exists.
- RLlib-style distributed training is appropriate only after vectorized private workers, scenario determinism, and historical validation are demonstrated.

## Reward Contract

The reward contract is lexicographic, not scalar-first:

```text
reliability/survival floor -> territory -> resources -> kills
```

The first experiment card keeps `scalarReward: null`. A later scalar may exist inside a specific experiment only if it preserves this order and cannot let later objectives compensate for earlier failures.

### Reliability And Survival Floor

Hard reject if a candidate causes or hides:

- loop crash, uncaught exception, global reset regression, or telemetry silence;
- Memory or RawMemory corruption;
- spawn recovery failure, worker death spiral, or controller downgrade emergency;
- unsafe CPU bucket collapse;
- any live-effect path to official MMO writes.

Reliability is evaluated before territory, resources, or kills. A candidate with better expansion score but worse reliability is rejected.

### Territory

Territory is the first optimization layer after survival. Reward components include:

- owned rooms held or gained;
- reservation uptime and remote viability;
- controller progress and reduced downgrade risk;
- safe expansion and remote target quality.

Hard reject if a candidate risks room loss, reservation collapse, downgrade regression, or unsafe expansion. Resource or combat gains cannot compensate for territory regression.

### Resources

Resources are optimized only after reliability and territory pass. Components include:

- net harvested energy and useful stored resources;
- RCL/GCL progress;
- spawn and logistics throughput;
- sustainable remote income.

Resource gains are invalid if they depend on reliability, survival, or territory regressions.

### Kills

Kills and combat outcomes are optimized last. Components include:

- hostile value destroyed;
- hostile objectives denied;
- own losses avoided;
- combat alert noise reduced.

Kills never compensate for lost rooms, unreliable runtime, broken economy, or unsafe CPU cost.

## Rejection And OOD Policy

Default decision is reject or defer. The candidate can advance only when evidence is in-distribution for the relevant context.

Reject or defer when:

- dataset coverage does not include comparable room phase, threat level, controller state, or resource state;
- the strategy-shadow report shows changed top recommendations without clear KPI support;
- simulator evidence is missing or non-deterministic for the candidate context;
- #417 historical official-MMO validation is missing;
- reliability or territory floor gates are uncertain.

The experiment card records OOD rejection as a first-class gate instead of allowing an optimistic scalar score.

## Stop Criteria

Stop an experiment and keep the incumbent when any of these occur:

- loop exception, global reset increase, or telemetry silence;
- Memory/RawMemory mutation path or official write path detected;
- CPU bucket collapse;
- spawn recovery, controller downgrade, room, or reservation regression;
- candidate result cannot reproduce deterministic simulator evidence;
- OOD context without conservative confidence;
- validator cannot explain why a recommendation is safe.

## Candidate Promotion Gates

Candidate evidence must advance in this order:

1. Dataset gate: dataset run ID, bot commit, dataset card, no raw secrets.
2. Shadow gate: strategy-shadow report, candidate-vs-incumbent diff, `liveEffect:false`.
3. Simulator gate: resettable/private scenario evidence, determinism, throughput report.
4. Historical official-MMO validation gate: #417 validation report and OOD/reliability rejection.
5. Private/shadow safety gate: recommendation-only run and deterministic validator decisions.
6. KPI rollout gate: owner-visible KPI plan and bounded rollout scope.
7. Rollback gate: rollback trigger, incumbent strategy ID, and post-window ingestion plan.

This #416 artifact cannot promote a candidate to live influence by itself. It only chooses the first offline training/reward path and prepares the next #266 decision.

## Experiment Card Contract

`scripts/screeps_rl_experiment_card.py` scans local metadata only. It does not copy raw runtime-summary lines, raw dataset rows, raw ranking diff bodies, or configured secret values.

Generated cards include:

- framework decision and recommended first stack;
- dataset/shadow/simulator metadata references;
- explicit reward components and lexicographic semantics;
- OOD rejection policy;
- stop criteria;
- promotion gates;
- safety flags and forbidden official MMO output surfaces.

The helper rejects unsafe input manifests when they contain `liveEffect:true`, official MMO write allowance, network requirement, live secret requirement, Memory/RawMemory write allowance, or raw creep intent control. The validator applies the same safety posture to generated cards.

## Verification

Local checks:

```bash
python3 -m py_compile scripts/screeps_rl_experiment_card.py scripts/test_screeps_rl_experiment_card.py
python3 -m unittest scripts/test_screeps_rl_experiment_card.py
python3 scripts/screeps_rl_experiment_card.py self-test
```

The self-test uses temporary local fixtures only and preserves `liveEffect:false` and `officialMmoWrites:false`.
