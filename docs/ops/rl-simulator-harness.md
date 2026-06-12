# RL Simulator Harness Contract

Status: first bounded #414 dry-run slice plus issue #548 Docker-run execution implementation.

Roadmap link: `docs/ops/rl-domain-roadmap.md` L3, Slice B.

Research input: `docs/research/2026-05-01-overmind-rl-architecture-audit.md`.

## Purpose

Issue #414 builds the accelerated self-hosted simulator harness lane for the RL flywheel. The first committed artifact is an offline manifest generator:

```bash
python3 scripts/screeps_rl_simulator_harness.py dry-run \
  --out-dir runtime-artifacts/rl-simulator-harness \
  --workers 4 \
  --rooms-per-worker 4 \
  --throughput-sample worker-0:1200:30
```

The dry-run command does not start Docker, use network access, require secrets, or call the official Screeps API. Its source scanning modes are:

- With no input paths and no `--scan-default-artifacts`, it writes an empty-source planning manifest immediately.
- With no input paths and `--scan-default-artifacts`, it scans the historical default roots: `/root/screeps/runtime-artifacts`, `/root/.hermes/cron/output`, and repo-local `runtime-artifacts`.
- With explicit input paths, it scans only those supplied files or directories for local runtime, dataset, strategy-shadow, and private-smoke metadata; default roots are not added.

It writes:

```text
runtime-artifacts/rl-simulator-harness/<manifest-id>/simulator_harness_manifest.json
```

The output directory is covered by the repository `runtime-artifacts/` ignore rule.

## Run Command

The `run` subcommand executes a real private-server harness for one or more strategy variants.

```bash
python3 scripts/screeps_rl_simulator_harness.py run \
  --run-id rl-sim-$(date -u +%Y%m%dT%H%M%SZ) \
  --out-dir runtime-artifacts/rl-simulator \
  --variants baseline \
  --ticks 100 \
  --workers 2 \
  --room E29N55 \
  --shard shardX \
  --branch activeWorld \
  --code-path prod/dist/main.js \
  --map-source-file /root/screeps/maps/map-0b6758af.json
```

Defaults and behavior:

- Docker images are inherited from the private-smoke launcher:
  - `screepers/screeps-launcher:v1.16.2`
  - `mongo:8.2.7`
  - `redis:7.4.8`
- `STEAM_KEY` must be set in environment (launcher configuration file is mounted from it).
- Spawn is placed at `(20,20)` as `Spawn1`.
- Per variant, the harness resets by stopping Docker and removing volumes, starts a fresh stack, resets world data, imports `/root/screeps/maps/map-0b6758af.json`, restarts Screeps, resumes simulation, uploads code to `/api/user/code`, places spawn, and collects tick-level observations.
- Per variant readbacks include `/api/user/overview`, `/api/game/room-terrain`, and `/api/game/room-overview`.
- `--variants` is optional and defaults to all strategy IDs discovered in `prod/src/strategy/strategyRegistry.ts`.
- Tick metrics are written to:

```text
runtime-artifacts/rl-simulator/<run-id>/run_summary.json
```

Run supports `--workers` for parallel execution. Use `--workers 2` as proof of concept.

Scale runs are resource-guarded before Docker startup. Requests at or above `--workers 3` are checked for available memory plus swap, CPU count, active Docker containers, active `rl-sim-worker-*` containers, active `screeps-private-smoke-*` containers, and estimated native-build pressure. The guard assumes a host reserve plus per-worker private-server stack memory and records the decision in the run artifact. On an approximately 8 GB host, a fresh `--workers 5` run is rejected before containers are started because first-run dependency compilation can otherwise overcommit the host.

For E2 scale validation, preflight the host/window before scheduling a real run:

```bash
python3 scripts/screeps_rl_simulator_harness.py plan-scale \
  --run-id rl-e2-scale-preflight \
  --workers 5 \
  --scale-environments 5 \
  --min-concurrent-environments 5
```

`plan-scale` does not start Docker, require secrets, or contact the official MMO. It writes `runtime-artifacts/rl-simulator/<run-id>/scale_validation_plan.json` and exits non-zero when the requested proof is not currently safe. The plan records the five-environment target, the `>=80%` success criterion (`4/5` environments), active simulator/private-smoke cleanup impact, current and after-cleanup worker capacity, and the memory/swap gap that must be closed before rerunning.

When the host is safe, run the actual proof with the same scale target:

```bash
python3 scripts/screeps_rl_simulator_harness.py run \
  --run-id rl-e2-scale-proof \
  --workers 5 \
  --scale-environments 5 \
  --min-concurrent-environments 5
```

`--scale-environments 5` expands the selected base strategy variants into five unique simulator environment rows. This preserves the `>=5` concurrent-environment requirement even when the default strategy set has only two variants; it does not change live strategy behavior or allow official MMO writes.

Only use the override when the host has been deliberately prepared, for example after warming caches or moving to a larger machine:

```bash
python3 scripts/screeps_rl_simulator_harness.py run ... --workers 5 --allow-unsafe-scale
```

The equivalent environment override is:

```bash
SCREEPS_RL_SIM_ALLOW_UNSAFE_SCALE=1
```

The generated Screeps launcher Compose stack also sets `npm_config_jobs=1`, `NPM_CONFIG_JOBS=1`, `JOBS=1`, and `MAKEFLAGS=-j1`. This bounds first-run `isolated-vm`/`node-gyp` native compilation so a scale run cannot multiply into `workers x node-gyp -j4` compiler jobs. The resource guard still rejects hosts without enough memory headroom because five simultaneous one-job native builds plus five private-server stacks can still be too large for small machines.

If the guard rejects a run, or if the run harness fails before producing normal results, the harness attempts exact-run cleanup only for container names matching `rl-sim-worker-<run-id>-*` and writes redacted failure artifacts under:

```text
runtime-artifacts/rl-simulator/<run-id>/run_summary.json
runtime-artifacts/rl-simulator/<run-id>/resource_guard_failure.json
```

## Safety Boundary

The manifest must preserve these flags:

```json
{
  "liveEffect": false,
  "officialMmoWrites": false,
  "officialMmoWritesAllowed": false,
  "networkRequired": false,
  "dockerRequired": false,
  "liveSecretsRequired": false,
  "rawCreepIntentControl": false
}
```

No learned or tuned policy may directly control official MMO creep intents, spawn intents, construction intents, market orders, Memory writes, RawMemory commands, or official API writes until the roadmap gates pass: simulator evidence, historical official-MMO validation, private/shadow safety gate, KPI rollout gate, and rollback gate.

Run artifacts must keep the same safety boundary with equivalent snake-case and camel-case keys:

```json
{
  "live_effect": false,
  "official_mmo_writes": false,
  "official_mmo_writes_allowed": false,
  "liveEffect": false,
  "officialMmoWrites": false,
  "officialMmoWritesAllowed": false
}
```

Steam keys and tokens are never printed. All run artifacts are redacted using configured secret values and the local code-redaction helper.

## Source Metadata Contract

`scripts/screeps_rl_simulator_harness.py` reuses the RL dataset export scanner. It records source metadata only:

- redacted input paths;
- file size and SHA-256;
- parsed runtime artifact count, tick, room names, and room count;
- bounded strategy-shadow report metadata;
- RL dataset run, scenario, and source-index summary fields;
- private-smoke report status and port metadata when present;
- skipped file reasons.

It must not copy raw `#runtime-summary` lines, raw logs, raw dataset rows, raw strategy-shadow ranking bodies, or configured secret values.

## Adapter Contract

The eventual private simulator adapter is versioned as `screeps-rl-sim-adapter.v1alpha1`. It may use local stdio or loopback HTTP, but it must not expose official MMO write APIs.

Required methods:

- `health`: worker status, package versions, active scenario, tick, process IDs, and failure counters.
- `loadScenario`: load a deterministic scenario manifest without ticking.
- `reset`: atomically reset world state from seed, bot bundle, memory snapshot, and strategy version.
- `step`: advance bounded private-server ticks with typed offline recommendations.
- `observe`: read room objects, terrain, event logs, memory summaries, CPU stats, and KPI reducers.
- `artifact`: export scenario config, seed, observations, actions, rewards, logs, KPI output, and throughput.
- `close`: stop worker-owned processes and verify cleanup.

Initial actions stay high-level only: `construction_preset`, `remote_target`, `expansion_candidate`, `defense_posture`, and `weight_vector`.

## Seed And Reset Contract

The dry-run manifest derives `scenarioSeed`, stream IDs, `resetId`, and `idempotenceKey` from canonical local metadata:

- base seed;
- bot commit;
- source file hashes and runtime artifact refs;
- dataset and strategy-shadow metadata;
- worker and room target;
- throughput sample or estimate.

A future reset is valid only when the same scenario manifest, seed, bot commit, strategy version, memory fixture digest, private-server package versions, and container image digest produce the same initial observation metadata. The first slice records this contract but sets `currentSliceExecutesSimulator: false`.

## Parallel Worker Contract

The target plan follows the Overmind-RL audit lesson: scale through isolated worker processes and vectorized rooms, not by weakening Screeps mechanics.

Manifest fields:

- `plannedWorkerCount`: private-server worker processes.
- `plannedRoomsPerWorker`: vectorized scenario rooms per worker.
- `plannedParallelRoomCount`: aggregate room slots.
- `workerIndexSeedPolicy`: derive worker streams from scenario seed plus worker index.
- `healthRequired`: process, control API, scenario, failure count, and room tick liveness checks.

## Throughput Contract

The target is approximately 100x official tick speed in aggregate. The manifest converts this to room ticks per second using:

```text
targetAggregateRoomTicksPerSecond = targetSpeedupVsOfficial / officialTickSecondsBaseline
```

Throughput evidence may be:

- `sampled-dry-run-input`: repeated `--throughput-sample worker:roomTicks:wallSeconds[:failures]` values.
- `estimated-from-worker-rate`: `--estimate-worker-room-ticks-per-second` times planned workers.
- `not-measured`: target metadata only.

Samples are treated as parallel worker windows, so aggregate throughput is total room ticks divided by the maximum worker wall-clock seconds. If the target is missed, the manifest records the gap; #414 follow-up work should report bottlenecks and scale workers or rooms per worker rather than changing game rules.

## Run Artifact Schema (minimum)

Run artifacts written by `run` must include:

- `type: screeps-rl-simulator-run`
- `harness_version`
- `timestamp`
- `live_effect: false`
- `official_mmo_writes: false`
- `official_mmo_writes_allowed: false`
- `variants` array with each item including:
  - `variant_id`
  - `ticks_requested`
  - `ticks_run`
  - `wall_clock_seconds`
  - `ticks_per_second`
  - `tick_log` list where each entry includes at least `tick`
- `safety` block.

## Verification

Local offline checks:

```bash
python3 -m py_compile scripts/screeps_rl_simulator_harness.py scripts/test_screeps_rl_simulator_harness.py
python3 -m pytest scripts/test_screeps_rl_simulator_harness.py -q
python3 scripts/screeps_rl_simulator_harness.py self-test
```

The self-test creates temporary local artifacts only and preserves `liveEffect:false` and `officialMmoWrites:false`.
