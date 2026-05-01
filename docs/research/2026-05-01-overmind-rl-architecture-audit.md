<!-- markdownlint-disable MD013 MD034 -->

# Overmind-RL Architecture Audit for Hermes Simulator Design

Status: research note for GitHub issue #413.
Date: 2026-05-01

## Scope and source discipline

This note audits `bencbartlett/Overmind-RL` for reusable simulator and training-design ideas for Hermes. The local shell could not clone the repository because outbound DNS resolution for `github.com` was unavailable, so the source was inspected through public GitHub pages and the GitHub connector. The current inspected Overmind-RL commit is `60c32ca1830b977c5286e47f248b36629581e8bd`.

This note only claims facts verified from the linked source paths or cited public docs. The repository includes `screeps_reinforcement_learning.pdf`, but this audit does not rely on PDF-only details because the PDF body was not text-extracted in this environment.

## Safety constraint

**No learned policy may directly control official MMO behavior until simulator evidence, historical MMO validation, and KPI rollout/rollback gates all pass. Initial Hermes outputs must remain offline, shadow-only, or high-level recommendations executed through deterministic validators. No raw creep-intent policy belongs on the official MMO at this stage.**

## Executive summary

Overmind-RL is valuable as an architecture pattern, not as a drop-in dependency. Its reusable core is the split between:

- a Node.js control plane that can reset, step, and inspect many private Screeps rooms;
- a Python training plane that wraps that control plane as Gym/RLlib environments;
- vectorized workers that trade exact official-world fidelity for repeatable high-throughput simulation.

The concrete implementation is old and risky to revive directly. The repository itself warns that it was released four years after the project and may not work with a modern game version. Its backend depends on `screeps` `^3.4.3`, `zerorpc`, custom private-server internals, and `config.json` Steam credentials. Its Python side uses old `gym` and old RLlib APIs such as `ray.rllib.agents.*`, `PolicyEvaluator`, and `VectorEnv`/`BaseEnv` patterns. Current Gym documentation says Gym has been unmaintained since 2022 and points users to Gymnasium; current RLlib docs use Gymnasium, `AlgorithmConfig`, `EnvRunner`, and newer multi-agent APIs.

Hermes should borrow the control-plane shape, deterministic reset discipline, worker vectorization, state/action/reward schema boundaries, and evidence gates. It should not vendor Overmind-RL or route learned outputs into `prod/` behavior until the safety chain is complete.

## Repository layout inspected

Top-level Overmind-RL layout:

| Path | Verified role |
| --- | --- |
| `README.md` | Project summary, three-package architecture, setup warning, and screeps-launcher notes. |
| `screeps-rl-backend/` | Node.js package wrapping private Screeps server control through RPC. |
| `screeps_rl_env/` | Python package exposing Gym/RLlib single-agent, multi-agent, and vectorized environments. |
| `models/` | Training scripts for PPO, IMPALA imports, QMIX/APEX_QMIX branches, callbacks, and rollout experiments. |
| `servers/` | Runtime private-server instance directories used by backend workers. |
| `screeps_reinforcement_learning.pdf` | Linked project paper; linked but not text-inspected here. |

## Backend architecture

`screeps-rl-backend/package.json` defines a Node package named `Overmind-RL` with runtime dependencies on `fs-extra-promise`, `lodash`, `onnxjs`, `screeps` `^3.4.3`, and `zerorpc`. The scripts are test/lint/publish oriented, not a modern reproducible simulator CLI.

The backend entrypoint is `screeps-rl-backend/backend/server.js`. It constructs a `ScreepsEnvironment` from `backend/environment.js`, exposes selected methods over a `zerorpc.Server`, and binds to `tcp://0.0.0.0:${env.commsPort}`. The exposed methods are:

- `attachEnv`
- `listRoomNames`
- `resetTrainingEnvironment`
- `resetRoom`
- `startBackend`
- `startServer`
- `stopServer`
- `tick`
- `getRoomTerrain`
- `getRoomObjects`
- `getAllRoomObjects`
- `getEventLog`
- `getAllEventLogs`
- `sendCommands`

`backend/environment.js` maps a `worker_index` to two port ranges: `serverPort = 21025 + 5 * index` and `commsPort = 22025 + 5 * index`. It creates a `ScreepsServer` with per-worker storage under `servers/server${index}` and supports many vectorized mini-environments by mapping `vector_index` values to checkerboard room names such as `E0S0`, `E2S0`, and `E1S1`.

The backend reset model has two levels:

- `resetTrainingEnvironment()` clears the whole world database, adds users `Agent1` and `Agent2`, adds an inactive spectator account, creates all requested rooms, populates each room with creeps, and starts the server.
- `resetRoom(roomName, creepConfig)` deletes room creeps and tombstones, then recreates either a default two-creep setup or a provided list of creep configs.

The step model is explicit:

1. Python writes serialized action commands for a user through `sendCommands`.
2. `sendCommands` writes those commands into RawMemory segment `70` for that user.
3. Python calls `tick()`.
4. The backend advances the Screeps server exactly one tick.
5. Python reads terrain, room objects, and event logs for observations and rewards.

This is a good control-loop shape for Hermes, but RawMemory segment coupling is too brittle for the official bot. Hermes should expose a typed simulation-only command channel and keep official MMO outputs high-level and validator-gated.

## Private server mockup

The backend imports `ScreepsServer` and `TerrainMatrix` from `screeps-rl-backend/backend/serverMockup/src/main.js`. The mockup wraps internal Screeps packages:

- `serverMockup/src/screepsServer.js` starts storage, runner, processor, and optional backend child processes, calls `driver.notifyTickStarted()`, queues users and rooms, calls `@screeps/engine/src/processor/global`, commits DB bulk writes, increments game time, and notifies rooms done.
- `serverMockup/src/world.js` directly mutates private-server storage. It can reset all collections, set room terrain, add room objects, delete creeps, read event logs, insert headless bots, preserve tombstones, and stub plausible rooms from asset data.

This direct DB/control-plane access is exactly why Overmind-RL can reset and step quickly. It is also the main portability risk: Hermes should put this behind a narrow adapter so private-server internals can change without leaking through the training API.

## Python environment architecture

`screeps_rl_env/setup.py` installs a Python package named `Overmind-RL` with dependencies including `numpy`, `scipy`, `torch`, `tensorflow`, `gym`, `ray`, `tqdm`, `zerorpc`, `opencv-python-headless`, `lz4`, `setproctitle`, `pydash`, and `h5py`.

`screeps_rl_env/screeps_rl_env/interface.py` is the Python RPC client. It starts `node ../../screeps-rl-backend/backend/server.js <worker_index>` through `Popen`, connects with `zerorpc.Client`, and wraps the backend methods as Python calls:

- `add_env(vector_index)`
- `reset()`
- `reset_room(room, creep_config)`
- `tick()` / `run(ticks)`
- `get_room_state(room)`
- `get_all_room_states()`
- `send_action(actions, username)`
- `send_all_actions(all_actions)`
- `close()`

`screeps_rl_env/screeps_rl_env/env.py` implements a single-agent `gym.Env`. It uses a placeholder observation space of `MultiDiscrete([50, 50, 50, 50])`, a discrete eight-direction movement action space, and the default `ApproachProcessor`. `step()` sends one command, ticks the backend, reads room state, and returns observation/reward/done/info.

`screeps_rl_env/screeps_rl_env/env_vectorized.py` implements an RLlib `VectorEnv` wrapper. It shares one `ScreepsInterface` across multiple room mini-environments, sends all actions in one batch, ticks once, then processes all room states.

`screeps_rl_env/screeps_rl_env/env_multiagent.py` implements an RLlib `MultiAgentEnv`. It serializes configured `CreepAgent` objects into the backend reset payload, rebuilds object ownership mappings after reset, and routes per-agent action dictionaries to per-player command dictionaries.

`screeps_rl_env/screeps_rl_env/env_multiagent_vectorized.py` implements an RLlib `BaseEnv` wrapper for many multi-agent rooms per backend worker. It batches actions across rooms, ticks once, reads all room states, reports throughput every 100 worker ticks, and supports RLlib agent grouping through `GroupedAgentsWrapper`.

## State, actions, and rewards in Overmind-RL

The single-agent `ApproachProcessor` reduces state to positions of one `Agent1` creep and one `Agent2` creep. It maps an action to `["move", direction]` and rewards closeness to the enemy creep.

The multi-agent `ApproachMultiAgentProcessor` returns a tuple of creep positions and maps each agent action to a raw movement direction.

The `CombatMultiAgentProcessor` is more instructive for Hermes schema design. It defines observation features per creep:

- `xy`
- `dxdy`
- `hits`
- `hits_frac`
- `attack_potential`
- `ranged_attack_potential`
- `heal_potential`

It maps actions either to `approachHostiles` / `avoidHostiles` commands or to a `maneuver` command. Its reward combines distance penalties, damage dealt from event logs, enemy death rewards, allied death penalties, and a victory reward. The event helper in `processors_multiagent/processor.py` parses Screeps event constants for attacks, heals, and object destruction.

For Hermes, this confirms that event-backed reward construction is feasible, but Overmind-RL's reward is combat-micro oriented. Hermes needs a higher-level lexicographic reward contract: reliability floor, territory, resources, then kills.

## Vectorized and remote worker model

Overmind-RL vectorizes at two layers:

- RLlib workers get a `worker_index`; each starts one Node backend process on a deterministic port range.
- Each backend worker hosts multiple mini-environments as separate rooms addressed by `vector_index`.

`models/train.py` registers `screeps` and `screeps_vectorized` environments and runs PPO through Ray Tune with `num_workers: 6` and `ScreepsVectorEnv(..., num_envs=20)`.

`models/train_multiagent_vectorized.py` exposes a fuller multi-agent path. It accepts `--num_workers` and `--num_envs_per_worker`, defaults to four workers and five envs per worker, enables `remote_worker_envs`, configures controlled and bot creeps, and can run `PPO`, `QMIX`, or `APEX_QMIX` style experiments.

The useful lesson is the throughput strategy: target aggregate tick speed through isolated worker processes and multiple rooms per process, not by changing game rules. Hermes issue #414 should preserve this: measure official 1x baseline versus local aggregate simulated ticks/sec and document bottlenecks if 100x is not reached.

## Current viability and obsolete pieces

Overmind-RL should be treated as a historical prototype:

- The README explicitly warns that the project was released years after implementation and may not work with modern Screeps.
- The backend pins old server expectations through `screeps` `^3.4.3`, internal `@screeps/*` module paths, `zerorpc`, and direct private-server database manipulation.
- The README setup notes an old `isolated-vm` issue requiring Python 2.7 for installation in that environment. That is a major reproducibility smell, not a Hermes direction.
- Official Screeps community-server docs now require community servers to be version `4.0.0` or higher for listing. This does not prove Hermes local tests must use exactly that version, but it is a concrete warning that `screeps` `3.4.3` is behind current community-server expectations.
- Gym's own documentation says Gym has been unmaintained since 2022 and recommends Gymnasium as the maintained drop-in replacement.
- Current RLlib docs show modern use of Gymnasium, `PPOConfig`, `EnvRunner`, and current multi-agent/custom-environment APIs. Overmind-RL imports older interfaces such as `ray.rllib.agents.ppo.PPOTrainer`, `ray.rllib.evaluation.PolicyEvaluator`, and `VectorEnv`/`BaseEnv` patterns that should be reevaluated before reuse.
- `zerorpc` is an avoidable dependency for a new Hermes harness. A simple HTTP, WebSocket, gRPC, or local IPC protocol with JSON/MessagePack schemas would be easier to maintain and test.
- The backend reads Steam-related config from `config.json`. Any Hermes simulator must keep credentials out of source, logs, datasets, and PR artifacts.

## Node and Screeps compatibility risks

Risk areas to isolate in Hermes:

1. **Private-server internals.** Overmind-RL calls internal modules such as `@screeps/backend/lib/cli/map` and `@screeps/engine/src/processor/global`. These are not stable public APIs.
2. **Version drift.** Server constants, event log shape, tombstones, power creeps, market behavior, shards, rooms, and CPU semantics may differ across private-server versions and official MMO behavior.
3. **Node/native dependencies.** Screeps private servers have historically depended on Node, native packages, and isolated VM behavior. Hermes should containerize the simulator and record exact Node/npm/package versions per run.
4. **Process cleanup.** The backend starts child processes and has imperfect kill/close paths. Hermes workers need health checks, hard timeouts, per-run directories, and cleanup verification.
5. **Secrets.** Steam keys or auth tokens must be injected only through local ignored environment files or secret stores and must never enter dataset rows.
6. **Memory channel coupling.** RawMemory segment commands are acceptable inside a private test harness but unsafe as a general official-MMO control seam.

## Official MMO mismatch risks

A resettable private simulator is necessary but not authoritative. Overmind-RL scenarios are mostly small-room movement/combat setups with synthetic creeps and direct DB insertion. That mismatches official MMO learning in several ways:

- Official rooms are persistent, partially observed, and non-resettable.
- Other players are non-stationary and can change behavior asynchronously.
- Official strategy value depends on CPU bucket, spawn queues, construction timing, market/terminal flows, controller downgrade risk, GCL/RCL progress, and memory migrations.
- Directly inserted creeps bypass spawn economics, body-production timing, energy starvation, and bootstrap failure modes.
- Empty or generated terrain does not capture real room topology, exits, source placement, keeper rooms, highways, portals, and hostile infrastructure.
- Combat reward can improve while territory or economy regresses, which violates the Hermes project vision.

The simulator must therefore be calibrated against official telemetry and historical MMO artifacts before it is trusted for rollout decisions.

## Hermes adaptation plan

### Simulator control API

Build a small versioned control API with explicit methods:

- `health()`: worker status, package versions, active scenario, current tick, process IDs.
- `loadScenario(manifest)`: load a deterministic scenario without ticking.
- `reset(seed, botBundle, memorySnapshot, strategyVersion)`: atomically reset world state and return initial observation metadata.
- `step(actions, maxTicks = 1)`: apply typed simulation actions or high-level recommendations, advance ticks, and return observation plus events.
- `observe(selector)`: read room objects, terrain, event logs, memory summaries, CPU stats, and KPI reducer state.
- `artifact(runId)`: export scenario config, seed, bot commit, strategy version, observations, actions, rewards, logs, and KPI output.
- `close()`: stop all child processes and verify no worker-owned process remains.

The API should be protocol-neutral at first. JSON over local HTTP or stdio is enough if schemas are stable. Do not expose official MMO credentials or official write APIs through this control plane.

### Deterministic scenario reset model

Each scenario should be a manifest with:

- `scenario_id`, `scenario_version`, and owning issue.
- private-server package versions, Node version, and container image digest.
- world seed and RNG seed stream IDs.
- terrain fixtures, room status, exits, sources, controllers, minerals, structures, construction sites, hostile objects, market/terminal fixtures when relevant.
- player definitions, bot bundle commit, strategy registry version, feature flags, and initial Memory/RawMemory fixtures.
- allowed action surface and deterministic validators.
- KPI reducer version and pass/fail gates.

Scenario reset must be idempotent. Running the same manifest, seed, bot commit, and strategy version should produce the same initial state and comparable tick trace, except where the scenario explicitly declares randomized fields.

### Vectorized workers and 100x target

Use Overmind-RL's worker-index plus vector-index idea, but make throughput an artifact:

- one orchestrator starts `N` isolated worker processes;
- each worker hosts `M` scenario rooms or one heavier multi-room scenario;
- each worker reports `simulated_room_ticks_per_second`, wall-clock time, CPU/memory, and failure counts;
- aggregate target is about 100x official tick speed through parallelism;
- if 100x is not reached, #414 should report bottlenecks and next scaling path instead of weakening game mechanics.

### State schema

Hermes state should start at strategy level, not raw pixels or every creep intent:

- reliability: loop exceptions, global resets, CPU used, bucket, memory schema, telemetry freshness;
- territory: owned rooms, reserved/remotes, room statuses, controller level/progress/downgrade, claim/reserve opportunities;
- economy: sources, harvest/haul/build/upgrade rates, spawn queue, body mix, storage/terminal/resources, construction progress;
- defense/combat: hostiles, towers, ramparts, safe mode, event-log attacks/heals/destroyed objects, own losses;
- topology: exits, terrain features, path costs, room adjacency, source/remote distances;
- context: bot commit, strategy version, feature flags, scenario or official artifact ID.

### Action schema

Initial learned outputs should be typed high-level recommendations only:

- `construction_preset(room, preset_id, confidence, evidence_refs)`
- `remote_target(room, remote_room, mode, confidence, stop_condition)`
- `expansion_candidate(target_room, score_components, confidence)`
- `defense_posture(room, posture_id, duration, confidence)`
- `weight_vector(scope, bounded_weights, ttl, confidence)`

Every action must be validated by deterministic code that can reject it for survival, CPU, downgrade, spawn, energy, threat, or coverage reasons. Raw creep movement, attack, transfer, harvest, and spawn intents remain out of scope for official control.

### Reward schema

Use a lexicographic reward contract:

1. reliability and survival floor: no loop crash, no Memory corruption, no spawn/worker death spiral, no unsafe CPU bucket collapse;
2. territory: owned rooms held/gained, reservation uptime, controller progress, downgrade risk reduced;
3. resources: net harvest, useful storage, RCL/GCL progress, spawn/logistics throughput, remote income;
4. kills/combat: hostile value destroyed, objective success, own losses avoided;
5. cost penalties: CPU, excess deaths, abandoned construction, unsafe expansion attempts, alert noise.

Scalar rewards may be used inside an experiment only after passing earlier lexicographic gates. Later metrics must not compensate for territory or reliability regressions.

### Offline dataset format

Use immutable run artifacts plus columnar/indexed training exports:

- `scenario_manifest.json`: deterministic scenario definition.
- `run_manifest.json`: run ID, bot commit, strategy version, worker version, seed, start/end ticks, package versions.
- `ticks.ndjson.zst`: one row per simulated or official tick with observation summary, action/recommendation label, validator result, event deltas, and artifact links.
- `kpi_windows.parquet`: reduced KPI windows for training/evaluation joins.
- `episodes.parquet`: episode-level outcome rows with pass/fail gates, reward components, and rollback notes.
- `dataset_card.md`: source windows, train/eval split, known bias, coverage, redaction, retention, and allowed use.

The same schema should ingest official MMO runtime summaries and simulator traces so #417 can compare candidates against historical official windows.

### Historical MMO replay validation

Before any rollout, evaluate candidates on saved official observations:

- reconstruct state from runtime summaries, room snapshots, event logs, strategy registry versions, and KPI reducer output;
- run candidate policy in replay/shadow mode to produce recommendations only;
- compare candidate recommendations to incumbent actions and later KPI outcomes;
- mark out-of-distribution contexts and reject uncertain recommendations by default;
- require PASS evidence that reliability and territory gates are not harmed before private canary or official shadowing.

### KPI-gated rollout and rollback

Rollout order:

1. offline replay only;
2. private deterministic scenario pass;
3. private randomized/stress scenario pass;
4. official MMO shadow recommendations with no live effect;
5. bounded low-frequency recommendation behind deterministic validators;
6. possible bounded knob selection only after owner-reviewed evidence.

Rollback gates should be explicit: runtime exceptions, telemetry silence, CPU bucket collapse, controller downgrade risk, spawn recovery regression, lost room/reservation, or lexicographic KPI regression switches strategy registry state back to incumbent and stores the failed window as training data.

### Online feedback ingestion

Every candidate and rollout window should write:

- strategy version and recommendation IDs;
- validator accept/reject reasons;
- post-window KPI deltas;
- alerts and manual interventions;
- rollback status;
- dataset-card update notes.

This closes the loop without letting the model mutate official behavior directly.

## Follow-up implementation slices

| Issue | Slice |
| --- | --- |
| #414 | Build the accelerated self-hosted simulator harness. Start with one deterministic resettable scenario, a `reset/step/observe/artifact` API, worker health checks, and throughput reporting toward the 100x aggregate target. |
| #415 | Define and implement the dataset pipeline. Produce `scenario_manifest`, `run_manifest`, `ticks`, KPI window, episode, and dataset-card artifacts from existing runtime summaries or one simulator run. |
| #416 | Choose the first training stack and reward workflow. Compare Gymnasium plus RLlib, simpler bandit/evolutionary tuning, and any Stable-Baselines-style path against vectorization, checkpointing, and TypeScript integration needs. |
| #417 | Implement historical MMO replay validation. Score candidate recommendations against saved official observations and reject any reliability or territory regression before rollout. |
| #418 | Wire KPI-gated rollout and online feedback ingestion. Keep outputs shadow/high-level, store validator decisions, and make rollback paths explicit before any live influence. |
| #409 | Make the immediate dataset/evaluation gate executable. Inventory current artifacts, define the first dataset card, and specify the next offline-only #266 task. |
| #266 | Prototype offline RL or hierarchical strategy recommendations only after #414 through #418 create simulator, dataset, validation, and rollout gates. Outputs remain construction/remote/expansion/defense recommendations, not raw creep intents. |

## References and code paths inspected

Overmind-RL repository and files:

- Repository root: https://github.com/bencbartlett/Overmind-RL
- Inspected commit: https://github.com/bencbartlett/Overmind-RL/commit/60c32ca1830b977c5286e47f248b36629581e8bd
- `README.md`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/README.md
- `screeps-rl-backend/package.json`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps-rl-backend/package.json
- `screeps-rl-backend/backend/server.js`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps-rl-backend/backend/server.js
- `screeps-rl-backend/backend/environment.js`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps-rl-backend/backend/environment.js
- `screeps-rl-backend/backend/serverMockup/src/main.js`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps-rl-backend/backend/serverMockup/src/main.js
- `screeps-rl-backend/backend/serverMockup/src/screepsServer.js`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps-rl-backend/backend/serverMockup/src/screepsServer.js
- `screeps-rl-backend/backend/serverMockup/src/world.js`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps-rl-backend/backend/serverMockup/src/world.js
- `screeps-rl-backend/backend/serverMockup/examples/test.js`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps-rl-backend/backend/serverMockup/examples/test.js
- `screeps-rl-backend/config.example.json`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps-rl-backend/config.example.json
- `screeps_rl_env/setup.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps_rl_env/setup.py
- `screeps_rl_env/screeps_rl_env/interface.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps_rl_env/screeps_rl_env/interface.py
- `screeps_rl_env/screeps_rl_env/env.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps_rl_env/screeps_rl_env/env.py
- `screeps_rl_env/screeps_rl_env/env_vectorized.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps_rl_env/screeps_rl_env/env_vectorized.py
- `screeps_rl_env/screeps_rl_env/env_multiagent.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps_rl_env/screeps_rl_env/env_multiagent.py
- `screeps_rl_env/screeps_rl_env/env_multiagent_vectorized.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps_rl_env/screeps_rl_env/env_multiagent_vectorized.py
- `screeps_rl_env/screeps_rl_env/creep_agent.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps_rl_env/screeps_rl_env/creep_agent.py
- `screeps_rl_env/screeps_rl_env/processors/processor.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps_rl_env/screeps_rl_env/processors/processor.py
- `screeps_rl_env/screeps_rl_env/processors/approach.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps_rl_env/screeps_rl_env/processors/approach.py
- `screeps_rl_env/screeps_rl_env/processors_multiagent/processor.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps_rl_env/screeps_rl_env/processors_multiagent/processor.py
- `screeps_rl_env/screeps_rl_env/processors_multiagent/approach.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps_rl_env/screeps_rl_env/processors_multiagent/approach.py
- `screeps_rl_env/screeps_rl_env/processors_multiagent/combat.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/screeps_rl_env/screeps_rl_env/processors_multiagent/combat.py
- `models/train.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/models/train.py
- `models/train_multiagent.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/models/train_multiagent.py
- `models/train_multiagent_vectorized.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/models/train_multiagent_vectorized.py
- `models/rollout_train.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/models/rollout_train.py
- `models/logger.py`: https://github.com/bencbartlett/Overmind-RL/blob/60c32ca1830b977c5286e47f248b36629581e8bd/models/logger.py

Current ecosystem references used for viability checks:

- Gym documentation and Gymnasium migration notice: https://www.gymlibrary.dev/
- Gymnasium documentation: https://gymnasium.farama.org/
- Current RLlib documentation: https://docs.ray.io/en/latest/rllib/index.html
- Screeps community-server documentation: https://docs.screeps.com/community-servers.html
- Screeps server-side architecture documentation: https://docs.screeps.com/architecture.html
- `screepers/screeps-launcher`: https://github.com/screepers/screeps-launcher

Hermes issue references inspected:

- #413: https://github.com/lanyusea/screeps/issues/413
- #414: https://github.com/lanyusea/screeps/issues/414
- #415: https://github.com/lanyusea/screeps/issues/415
- #416: https://github.com/lanyusea/screeps/issues/416
- #417: https://github.com/lanyusea/screeps/issues/417
- #418: https://github.com/lanyusea/screeps/issues/418
- #409: https://github.com/lanyusea/screeps/issues/409
- #266: https://github.com/lanyusea/screeps/issues/266
