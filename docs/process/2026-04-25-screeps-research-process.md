# Screeps Research Process Note

Date: 2026-04-25

## What I changed

I turned the official Screeps getting-started, API, game-loop, CPU, control, and modules docs into two artifacts:

- a factual research note for long-term reference
- a blog-ready process note that preserves the reasoning trail

## Why I framed the research this way

Screeps can look like a simple scripting game at first, but the official docs make it clear that the important constraints are system-level:

- tick timing, not instant state changes
- CPU budgeting, not unlimited script execution
- shard isolation, not one shared world state
- controller level gating, not freeform building
- persistent memory with multiple storage surfaces, not one generic save file

That means the useful research output is not just "what the game is," but "what architecture the game forces on you."

## Reasoning trail

1. Start with the onboarding docs to understand the gameplay loop.
2. Confirm the runtime model from the game-loop docs.
3. Verify CPU behavior, bucket rollover, and unlock rules.
4. Check persistence APIs and the boundaries between `Memory`, `RawMemory`, and `InterShardMemory`.
5. Verify controller/RCL progression so the bot architecture can align with actual build unlocks.
6. Note module support and the official Node-like loading model.

## What stood out

- The tick model is explicit: code runs, then the tick resolves, then the next state appears.
- `Game.cpu.tickLimit` plus the bucket make CPU planning a resource-smoothing problem.
- `InterShardMemory` is the official cross-shard channel, while `RawMemory.interShardSegment` is deprecated.
- The controller system is not just progression flavor; it is the hard gate for room infrastructure.
- The docs now make binary modules / WebAssembly part of the official story, which widens implementation options.

## Blog-worthy angles

### 1. Screeps as a distributed systems exercise
The game is really about building a reliable autonomous system under hard runtime limits.

### 2. The tick loop is the architecture
Because state only updates on the next tick, phase-based code is not a style preference; it is the natural design shape.

### 3. CPU is the real currency
Bucket management, shard allocation, and unlock timing all influence strategy more than raw code size.

### 4. Memory design is an architecture decision
Choosing between `Memory`, `RawMemory` segments, and `InterShardMemory` is part of the bot’s core design, not an implementation detail.

### 5. Progression is a control-systems problem
GCL, RCL, and room ownership create a closed loop between expansion, CPU growth, and infrastructure unlocks.

## Notes for a future blog post

A good post outline could be:

1. What Screeps is
2. Why the tick model changes how you write code
3. How CPU and bucket shape bot architecture
4. Why shard and memory boundaries matter
5. How controller progression defines the early-game roadmap
6. What a sustainable Screeps codebase looks like

## What I would do next

- Draft an architecture note for the first bot pass.
- Decide the source/build pipeline.
- Define the first Discord alerts and status summaries.
- Separate early-game, mid-game, and cross-shard concerns into different documents.

## Files created from this research pass

- `docs/research/2026-04-25-screeps-world-mechanics-and-api-constraints.md`
- `docs/process/2026-04-25-screeps-research-process.md`
