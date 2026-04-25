# Overmind Architecture Patterns for Screeps Bot Design

Date: 2026-04-25

## Purpose

Use Overmind as the main reference implementation for a maintainable, CPU-conscious Screeps bot. This note extracts architecture patterns we can reuse, plus patterns we should avoid copying too literally.

## Sources consulted

- Overmind project page: https://bencbartlett.com/projects/overmind/
- Overmind README: https://raw.githubusercontent.com/bencbartlett/overmind/master/README.md
- Screeps #1: Overlord overload: https://bencbartlett.com/blog/screeps-1-overlord-overload/
- Screeps #4: Hauling is (NP-)hard: https://bencbartlett.com/blog/screeps-4-hauling-is-np-hard/
- Screeps #5: Evolution: https://bencbartlett.com/blog/screeps-5-evolution/
- Screeps #6: Verifiably refreshed: https://bencbartlett.com/blog/screeps-6-verifiably-refreshed/

## 1. Overmind's hierarchy, from top to bottom

Overmind is intentionally layered. The top-level `Overmind` object instantiates colonies and directives, colonies group the room economy, and specialized child systems handle execution.

### Core hierarchy

- `Overmind`
  - global coordinator
  - instantiates colonies and directives
  - owns the main tick lifecycle
- `Colony`
  - groups owned rooms and outposts into one economic unit
  - instantiates hive clusters, logistics networks, and overlords
- `HiveCluster`
  - groups related structures/components with shared functionality
  - represents a physical sub-system inside a colony
- `Directive`
  - flag-driven intent marker
  - conditional attachment point for overlords
  - used for territory, military, operational, and planning signals
- `Overlord`
  - operational controller for a specific goal
  - owns task execution for a localized problem such as mining, building, guarding, or bootstrapping
- `Overseer`
  - scheduler and sentinel
  - runs directives and overlords by priority
  - places new directives in response to stimuli
- `Task`
  - reusable action abstraction
  - can be chained and parented
- `Zerg`
  - creep wrapper contextualized by task and overlord
  - ties raw game creeps to higher-level intent

## 2. Tick lifecycle: split planning from action

Overmind evolved toward a CPU-aware loop that separates expensive instantiation, request collection, and state-changing execution.

### Main phases

1. `build()`
   - full instantiation path
   - recursively constructs the AI object graph
   - refreshes caches and object references
   - run occasionally, not every tick
2. `refresh()`
   - cheaper in-between-tick update path
   - updates references in place while keeping script objects alive
   - introduced to reduce garbage collection and instantiation cost
3. `init()` / request collection
   - gathers requests before any state-changing work happens
   - examples include spawn requests, transport requests, link requests, and repair requests
4. `run()`
   - performs state-changing actions
   - directs creeps, distributes resources, updates directives, handles trade, and gathers intel

### Reusable lesson

Do not blur planning and execution. The architecture works because it creates explicit seams between:

- expensive world-model construction
- request aggregation
- final action resolution

That separation is especially valuable in Screeps because CPU spikes and garbage collection penalties are gameplay constraints, not just engineering inconveniences.

## 3. Task and role model: prefer contextual behavior over rigid roles

A key Overmind pattern is that roles are not the primary unit of organization. The bot moved away from a rigid role script model and toward task-oriented execution.

### What changed conceptually

- old pattern: one creep = one hard-coded role
- Overmind pattern: one creep = a wrapper (`Zerg`) with a current `Task`, controlled by an `Overlord`
- tasks can be parented and chained, letting a creep finish one sub-action and continue with the next without re-planning from scratch
- role names may still exist as labels, but they are not the main architecture boundary

### Why this is useful

This makes behavior:

- easier to compose
- easier to reuse across room layouts and colony states
- easier to retarget when priorities change
- less brittle than a large switch statement of role scripts

### Reusable pattern for our bot

Use a task model when the same creep body can serve multiple purposes. Keep role names as human-readable categories if needed, but let the task graph drive decisions.

## 4. Logistics: model hauling as request routing, not as a simple hauler role

Overmind's logistics work is the most reusable design reference for our bot.

### What Overmind converged toward

- logistics were not treated as a single greedy hauler loop
- transport became a request/fulfillment problem
- requests can originate from multiple systems and can have multiple viable dropoff targets
- the system compares transporters and requests by expected resource transport rate (`dq/dt`), not just by distance
- buffer structures matter because a creep may improve throughput by picking up or dropping off through storage, links, terminals, or other intermediate nodes

### Important design implications

- hauling is a routing problem, not just a pathfinding problem
- the best transporter is not always the closest transporter
- the best dropoff is not always the first valid dropoff
- a request can be prioritized, delayed, or routed through a buffer based on global efficiency

### Transport patterns worth reusing

- request groups for shared supply targets
- specialized request objects with metadata like priority and effective amount
- multi-leg movement handled through chained tasks
- one general transporter class that can satisfy many request types
- room-level maintenance logic that only activates when it matters

### Patterns to avoid copying too literally

- rigid `hauler` vs `supplier` splits when both bodies are effectively similar
- greedy local decisions that ignore the room's broader resource graph
- requiring a unique flag or explicit role for every small logistics job
- over-optimizing for one room layout if the colony is likely to evolve

## 5. Directive-driven intent: use flags as external signals, but keep them sparse

Directives are one of Overmind's strongest ideas: they turn map flags into machine-readable intent.

### What they are good for

- colony expansion and territory claims
- military operations
- recovery and bootstrap behavior
- resource and energy routing exceptions
- room planning / layout guidance

### What to reuse

Use directives for high-level intent that should survive across ticks and be visible to the player.
They are especially good for:

- exceptions
- manual overrides
- strategic goals
- room-level mode changes

### What to avoid

Do not require a flag for every routine behavior. Overmind explicitly backed away from a world where flags were the sole instantiation mechanism, partly because that creates awkward ergonomics and unnecessary dependence on limited map markers.

## 6. CPU and memory pattern: cache aggressively, reconstruct selectively

The later Overmind architecture is a good example of adapting software architecture to Screeps performance constraints.

### Reusable ideas

- keep expensive object graphs persistent when possible
- refresh in place rather than rebuilding everything every tick
- cache expensive room/object scans
- only re-run full construction periodically
- favor predictable update paths over repeated deep instantiation

### Why it matters

In Screeps, CPU and garbage collection are part of the strategy space. A clean architecture is not just maintainable; it directly increases survivability and scalability.

## 7. What we should reuse for our bot

### Strong candidates to adopt

- top-down hierarchy with explicit ownership boundaries
- directive-driven strategic intent
- task chaining for creep behavior
- request-based logistics
- cache / refresh separation in the tick loop
- scheduler or overseer layer for priorities
- human-readable design vocabulary that matches the bot's control hierarchy

### Strong candidates to avoid

- role explosion
- one-off scripts for each room condition
- greedy hauling logic that cannot scale to a multi-room economy
- overusing flags as a substitute for architecture
- coupling logistics to a single base layout
- rebuilding everything every tick

## 8. Implications for our Screeps bot

If we follow Overmind's strongest patterns, our bot should be organized around:

- strategic intent from Discord + directives
- colony-level orchestration
- local execution by task-aware creeps
- logistics as a request network
- phase-separated tick processing
- explicit priority scheduling for responses to danger and economy shifts

This gives us a path toward a bot that can grow from a single-room start into a multi-room operation without turning into an unreadable collection of role scripts.
