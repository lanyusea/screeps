# Screeps Phase 1 Research Brief

> Scope: initial research pass for the Screeps: World coding project.
> Source references: official Screeps wiki/docs and the Overmind project.

## 1. What Screeps is, operationally

Screeps is a persistent MMO strategy game where we write code that controls our colony in a live world.
The game is not manually played in the usual sense; the code runs every tick and makes decisions for creeps, structures, expansion, defense, logistics, and market behavior.

### Key gameplay facts already confirmed

- The persistent world (MMO) is the primary server and runs year-round.
- The world is split into 4 shards, each with its own map and independent runtime.
- Shards are connected through portals, but cross-shard logic is non-trivial.
- Starting the game means choosing a room on a shard and manually placing the first Spawn.
- The in-game tutorial teaches console usage and code editing/running for automation.
- Progression centers around harvesting energy, upgrading the room controller, and claiming additional rooms.

## 2. Official API / code model findings

### Language and module model

The official docs use JavaScript-style code examples and Node-like module syntax.
The docs explicitly state that scripts can be organized with `require` and `module.exports`.
They also mention embedded `lodash` support via `require('lodash')`.

### Runtime model and important APIs

The API surface confirms the main objects we will need to build around:

- `Game`: global game state, creeps, rooms, flags, market, shard, GCL/GPL, etc.
- `Game.cpu`: CPU limit, tick limit, bucket, shard limits, heap statistics, pixel generation.
- `Memory` / `RawMemory`: persistent state and raw string-level memory access.
- `InterShardMemory`: cross-shard message/data sharing.
- `PathFinder`: multi-room pathfinding with custom costs.
- `Game.map`: room routes, exits, distance, terrain, room availability/status.
- `Room`, `RoomPosition`, `Creep`, `Structure*`: core object models for behavior and control.

### Important practical constraints

- `Game.cpu.getUsed()` reports CPU usage during a tick; in Simulation mode it always returns 0.
- `Game.cpu.setShardLimits()` exists but has a 12-hour cooldown.
- `Game.cpu.generatePixel()` converts 10,000 bucket CPU into 1 pixel resource.
- `RawMemory.setActiveSegments()` can request up to 10 memory segments at a time.
- A memory segment can be up to 100 KB.
- `InterShardMemory` is separate from `Memory` and is the correct mechanism for cross-shard data sharing.

## 3. Local development / deployment chain findings

### Official / community-supported development patterns

From the Overmind project README, a mature Screeps codebase can be built and deployed with:

- `npm install`
- `npm run compile`
- `npm run push-main` for public server deployment
- `npm run push-pserver` for private server deployment

Overmind uses `rollup` to bundle TypeScript into a single `main.js` file.
That gives us a very strong hint for a production-ready workflow:

1. Write source code in TypeScript.
2. Compile/bundle to a single production bundle.
3. Deploy to either public or private server with a scripted push command.

### Private server / local testing options

The Screeps wiki confirms that the private server can run locally or on a dedicated host.
The current community-preferred options are:

- `screepers/screeps-launcher`
- `jomik/screeps-server` (Docker-oriented)

The launcher README confirms a practical local workflow:

- use `config.yml` to define mods and bots
- run the launcher directly or via Docker Compose
- use `screeps-launcher cli` for server administration
- initialize the DB with `system.resetAllData()` when using mongo

### Why this matters for us

This means we can build a real local loop:

- edit source code locally
- compile to production bundle
- run against a private server / simulation environment
- inspect logs and behavior
- iterate before pushing to the official MMO world

## 4. Manual configuration items identified so far

Likely human-owned decisions / setup items:

- Screeps account / shard selection for the main bot
- Initial room choice and spawn placement
- Server access credentials / API credentials for deployment
- `screeps.json` or equivalent deployment config
- Private server config (`config.yml`), including mods and bots
- Whether to use Mongo/Redis in local server setup
- Whether to use Docker or a direct launcher install
- Monitoring endpoints / alerting destinations

## 5. Discord operations: initial recommendation

We should treat Discord as the command-and-control surface for the project.

Recommended channel split:

- `#decisions` — final architecture and strategy decisions
- `#research` — source findings, links, and notes
- `#dev-log` — development progress and implementation notes
- `#deploy` — deployment notices and release records
- `#runtime-alerts` — crashes, CPU spikes, memory issues, abnormal behavior
- `#combat-or-ops` — tactical or operational alerts during live play
- `#experiments` — A/B tests, prototype results, failed ideas

Recommended bot outputs:

- tick summaries
- CPU/bucket/memory summaries
- spawn / death / respawn events
- room-level status changes
- deployment success/failure
- exception and stack trace alerts

## 6. Current interpretation of Overmind as a reference architecture

Overmind is a mature Screeps bot built in TypeScript and bundled with rollup.
The architecture is heavily hierarchical:

- `Overmind` at the top
- `Colony` for grouped room ownership
- `HiveCluster` for related structure/function groups
- `Directive` for flag-based conditional behaviors
- `Overlord` for specific operational goals
- `Overseer` for priority scheduling and directive tracking
- `Task` for general action-to-target-until-condition abstractions
- `Zerg` for creep wrappers contextualized by task/overlord

The tick loop was also intentionally split into phases (`build()`, `init()`, `run()`) to separate caching/instantiation, request collection, and state-changing actions.
The logistics article adds another important lesson: complex hauling is treated as a routing / request-satisfaction problem, with `TransportRequestGroup`, `miningGroup`, and specialized hauler/supplier logic being evolved into a more flexible transport model.

This is important because it suggests a robust pattern for us:

- separate strategic orchestration from execution
- make creep control task-oriented rather than purely role-oriented
- use a priority-driven scheduler
- treat flags/directives as external intent markers
- model logistics as request routing rather than one-off role scripts

## 7. Initial conclusions

### What seems clear already

- Screeps is fundamentally a JS/TS coding game.
- We should expect to work in a Node-style module ecosystem.
- Local private-server testing is viable and should be part of the workflow.
- Overmind provides a strong reference for large-scale bot architecture.
- Discord should be designed as an operations and decision hub, not just a chat room.

### What still needs deeper verification

- The exact best-practice public deployment method for our target account
- The exact current private-server install path we should standardize on
- Which language choice is best for our project: pure JS or TS with build step
- How to design our own module boundaries without overfitting to Overmind
- Which metrics and alerts should be pushed to Discord first

## 8. Recommended next research tasks

1. Verify the exact public deployment workflow for our account and preferred tooling.
2. Decide the source language and build pipeline (likely TypeScript + bundle output).
3. Lock the local testing environment choice (launcher vs Dockerized private server).
4. Draft Discord channel and bot requirements in detail.
5. Move into phase 2: architecture options and module decomposition.

## Sources consulted

- https://wiki.screepspl.us/Getting_Started/
- https://docs.screeps.com/api/
- https://docs.screeps.com/modules.html
- https://bencbartlett.com/projects/overmind/
- https://raw.githubusercontent.com/bencbartlett/overmind/master/README.md
- https://raw.githubusercontent.com/screepers/screeps-launcher/master/README.md
- https://raw.githubusercontent.com/jomik/screeps-server/master/README.md
