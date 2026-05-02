# Worker Efficiency Conservative RL Fine-Tune

Status: bounded implementation slice for issue #509.

## Purpose

This pipeline fine-tunes a conservative offline worker micro policy against the current heuristic worker baseline. The learned policy is limited to worker task and target selection labels:

- harvest source selection;
- transfer target selection;
- build target selection;
- repair target selection;
- upgrade target selection.

It does not control movement, spawn decisions, construction planning, territory planning, Memory writes, RawMemory writes, market actions, or official MMO APIs.

## Command

Install production dependencies first, then generate the local artifact:

```bash
npm --prefix prod ci
node scripts/screeps_rl_worker_efficiency_train.js --sample-count 100000
```

Outputs are written under the ignored local path:

```text
rl_data/worker-efficiency/<policy-id>/
  policy.json
  evaluation_report.json
  evaluation_report.md
```

## Algorithm

The first implementation uses `conservative-tabular-cql.v1`, a deterministic CQL-style tabular learner over scenario buckets and worker action keys. The trainer starts from the behavioral-cloning-compatible heuristic label, estimates reward-labeled action values from offline samples, subtracts a support-sensitive conservative penalty, and only selects a learned action when its lower-confidence score clears the heuristic baseline by the configured margin.

Reward shape:

```text
primary:   work_ticks / total_ticks
secondary: energy_delivered
penalty:   idle_ticks + range + risk
```

## Safety Gates

Generated artifacts preserve:

```json
{
  "liveEffect": false,
  "officialMmoWrites": false,
  "movementControl": false,
  "spawnControl": false,
  "constructionControl": false,
  "territoryControl": false,
  "memoryWrites": false,
  "rawMemoryWrites": false
}
```

The selector has heuristic safety floors for hostile visibility, emergency spawn refill, and controller downgrade guard contexts. Live influence remains disallowed until simulator evidence, historical validation, KPI rollout gates, and rollback gates pass.
