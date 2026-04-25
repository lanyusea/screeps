# Screeps: World Mechanics and API Constraints

Date: 2026-04-25

## Scope

This note records current, source-backed facts about how **Screeps: World** works and which official API constraints matter for bot development.

Primary sources consulted:

- https://wiki.screepspl.us/Getting_Started/
- https://docs.screeps.com/api/
- https://docs.screeps.com/game-loop.html
- https://docs.screeps.com/cpu-limit.html
- https://docs.screeps.com/control.html
- https://docs.screeps.com/modules.html

## 1) Gameplay model: you write code, the code plays the game

- Screeps is a persistent MMO strategy game where your colony is controlled by script.
- The in-game tutorial teaches both console use and editing/running code for automation.
- You start by choosing an available room on a shard and manually placing the first Spawn.
- Progression is built around harvesting energy, upgrading the room controller, and expanding to more rooms.

## 2) World and server model

- The persistent world is the main Screeps: World server, and it runs year-round without regular reset.
- The current persistent world is split into **four shards**.
- Each shard has its own map and runs independently.
- Shards are linked by portals, but inter-shard movement and data transfer are non-trivial.
- The official docs also describe a seasonal world server when available, but the persistent MMO is the default long-lived environment.

## 3) Tick model and runtime semantics

- Screeps uses a real-time, tick-based loop.
- `Game.time` is the global tick counter.
- The `main` module runs every tick; the next tick begins only after all players' `main` modules finish.
- Game-state changes are applied at the start of the next tick, not immediately when a command is issued.
- Because of that, actions in the same tick see the state from the beginning of the tick.
- Conflicting planned actions are resolved by predefined priorities.
- Global runtime variables do **not** persist between ticks.
- Console commands follow the same tick rules as code executed from `main`.

## 4) CPU model and execution limits

### Base limit and tick limit

- `Game.cpu.limit` is the assigned CPU limit for the current shard.
- The official docs say the account starts at **20 CPU** on the public server unless CPU Unlock is active.
- With CPU Unlock active, CPU limit scales with GCL by **+10 CPU per GCL level** until it reaches **300 CPU**.
- `Game.cpu.tickLimit` is the amount of CPU available on the current tick, including bucket carryover.
- `Game.cpu.getUsed()` reports the CPU used since the beginning of the current tick.
- `Game.cpu.getUsed()` always returns `0` in Simulation mode.

### Bucket

- `Game.cpu.bucket` stores unused CPU.
- The bucket can accumulate up to **10,000 CPU**.
- If the bucket has stored CPU, a tick can exceed the base limit using up to **500 CPU** per tick from the bucket.
- When the bucket is full, `Game.cpu.tickLimit` reaches **500**.
- `Game.cpu.tickLimit` never drops below `Game.cpu.limit`.

### Shard CPU allocation

- `Game.cpu.shardLimits` stores per-shard CPU assignments.
- `Game.cpu.setShardLimits(limits)` reallocates CPU between shards.
- The allocation method can be used only once every **12 hours**.
- Invalid shard-limit objects are rejected.

### Unlocking and pixel generation

- `Game.cpu.unlock()` spends a `cpuUnlock` resource to unlock full CPU for **24 hours**.
- If the account is not currently unlocked, it can take up to **5 minutes** before the unlock is applied.
- `Game.cpu.generatePixel()` converts **10,000 bucket CPU** into **1 pixel** resource.

## 5) Persistent state and cross-shard storage

### `Memory`

- `Memory` is a global plain object for arbitrary persistent data.
- It can be accessed through the API and the in-game Memory UI.

### `RawMemory`

- `RawMemory` exposes the raw serialized memory string.
- It is the basis for custom serialization/deserialization instead of built-in JSON handling.
- `RawMemory.get()` returns the raw string.
- `RawMemory.set(value)` replaces the raw memory string.
- `RawMemory.setActiveSegments(ids)` requests memory segments for the next tick.
- A segment ID must be between **0 and 99**.
- At most **10 segments** can be active at the same time.
- `RawMemory.segments` contains active segments available this tick.
- Each memory segment is capped at **100 KB**.
- `RawMemory.setActiveForeignSegment(username, [id])` requests a public segment from another user.
- Only **one foreign segment** can be active at a time.
- `RawMemory.setPublicSegments(ids)` marks your segments as public.
- `RawMemory.setDefaultPublicSegment(id)` sets the fallback public segment.
- `RawMemory.interShardSegment` is deprecated.
- It is a shared 100 KB string that is not safe for concurrent shard writes.

### `InterShardMemory`

- `InterShardMemory` is the official interface for cross-shard communication.
- Each shard can have its own **100 KB** string of inter-shard data.
- A shard may write only to its own data; other shards' data is read-only.
- This data is separate from `Memory`.

## 6) Room controller and progression constraints

- A room must be controlled before you can build most facilities in it.
- Neutral controllers can be claimed by creeps with the `CLAIM` body part.
- In the first room, the controller is owned by you by default.
- A newly seized controller initially allows **one Spawn**.
- Additional spawns, roads, and extensions depend on Room Controller Level (RCL).
- RCL advances by spending energy via `Creep.upgradeController`.
- Room controllers have downgrade timers if they are not upgraded often enough.
- `attackController` can be used to reduce another player's controller downgrade timer.
- GCL and RCL are linked in the sense that upgrading controllers also advances GCL.
- Once gained, GCL is permanent even if all rooms are later lost.
- To control 3 rooms, you need GCL 3.

## 7) Build and module model

- The official module system uses Node.js-like `require` and `module.exports` syntax.
- The docs also mention an embedded `lodash` module.
- Official docs explicitly document support for binary modules and WebAssembly-based workflows.

## 8) Development constraints that matter

- The bot must be designed around the tick loop, not around immediate synchronous state changes.
- CPU budgeting is a first-class design concern.
- Persistent state should be intentionally split between `Memory`, `RawMemory`, and `InterShardMemory` depending on scope.
- Cross-shard behavior should be treated as a separate subsystem, not as a simple extension of normal memory.
- RCL gates what structures can be built, so expansion planning must account for controller level.
- CPU Unlock materially changes growth strategy because it raises the usable CPU ceiling with GCL.

## Open questions

1. What source-language/build pipeline should we standardize on for this repo: plain JS, TypeScript, or a mixed build step?
2. How should we partition state between `Memory`, `RawMemory` segments, and `InterShardMemory` in the first bot architecture?
3. What should be our initial shard strategy, given shard independence and portal-based inter-shard travel?
4. Which public-server deployment path should be considered canonical for this project?
5. What minimum metrics should be surfaced to Discord first: CPU, bucket, controller status, spawn queue, or error alerts?
6. Do we want to optimize for one-shard stability first, or design cross-shard features early?

## Blog-ready takeaways

- Screeps is best understood as a **distributed systems problem with a game skin**.
- The tick model strongly rewards phase-based code architecture.
- CPU, bucket, and controller progression form a single planning loop.
- Cross-shard communication is deliberately constrained, so architecture decisions matter early.

## Sources

- Screeps Getting Started: https://wiki.screepspl.us/Getting_Started/
- Official API Reference: https://docs.screeps.com/api/
- Game Loop: https://docs.screeps.com/game-loop.html
- CPU Limit: https://docs.screeps.com/cpu-limit.html
- Control: https://docs.screeps.com/control.html
- Modules: https://docs.screeps.com/modules.html
