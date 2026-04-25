# Screeps Technical Architecture Strategy

Date: 2026-04-25

## Status

Initial phase-2 architecture strategy, based on phase-1 development-chain conclusions and reference patterns from mature Screeps bots such as Overmind.

This is a design direction, not yet production code.

## Architecture thesis

The bot should be designed as a **small, inspectable strategic kernel** rather than a direct copy of a mature mega-bot.

For MVP, we should build a reliable room-centered economy loop first, then layer in planning, logistics, defense, expansion, market, and multi-shard systems only after the core loop is measurable and stable.

## Design principles

1. **Tick budget is a first-class resource**
   - Every module must assume limited CPU.
   - Heavy computation should be cached, amortized, or skipped under bucket pressure.

2. **Room/colony is the main operational unit**
   - Screeps state is spatial.
   - Most practical decisions should be scoped around owned rooms and their remotes.

3. **Memory schema must be explicit and migratable**
   - Screeps `Memory` persists across ticks and code deploys.
   - Bad memory migrations can break the whole bot.

4. **Intent production should be separated from intent execution**
   - Strategy decides what should happen.
   - Executors issue creep/spawn/structure actions.

5. **Prefer measurable MVP behavior over architecture completeness**
   - The first bot should survive and upgrade, not implement every possible subsystem.

6. **Borrow Overmind patterns, do not clone Overmind**
   - Use hierarchy, task abstraction, and logistics concepts as inspiration.
   - Avoid importing the full complexity before our own constraints are known.

## Proposed top-level runtime loop

```text
main.loop
  ├─ boot/global reset handling
  ├─ memory migration and validation
  ├─ telemetry start
  ├─ world scan/cache refresh
  ├─ room/colony planning
  ├─ spawn planning
  ├─ creep task assignment
  ├─ creep action execution
  ├─ structure action execution
  ├─ cleanup/dead creep memory collection
  └─ telemetry flush / alert generation
```

## Proposed module boundaries

### 1. Kernel

Purpose: owns the tick lifecycle and guards CPU/runtime stability.

Responsibilities:

- `main.loop`
- global reset detection
- CPU guardrails
- phase ordering
- error isolation
- emergency fallback mode

Example files:

```text
prod/src/main.ts
prod/src/kernel/Kernel.ts
prod/src/kernel/phase.ts
prod/src/kernel/cpu.ts
prod/src/kernel/errors.ts
```

### 2. Memory

Purpose: define and migrate persistent state.

Responsibilities:

- memory versioning
- schema initialization
- dead creep cleanup
- room memory initialization
- global bot settings

Example files:

```text
prod/src/memory/schema.ts
prod/src/memory/migrations.ts
prod/src/memory/cleanup.ts
```

### 3. Colony / Room model

Purpose: convert raw `Game.rooms` into owned-room operational objects.

Responsibilities:

- room state snapshot
- source/spawn/controller/structure summary
- energy availability
- build/repair/upgrade priorities
- remote room attachments later

Example files:

```text
prod/src/colony/Colony.ts
prod/src/colony/colonyRegistry.ts
prod/src/colony/roomSnapshot.ts
```

### 4. Spawn planner

Purpose: decide what creeps are needed and enqueue spawn requests.

Responsibilities:

- body generation by available energy
- minimum survival creep set
- role counts by colony state
- spawn priority queue
- replacement timing

MVP creep roles:

- `harvester`
- `hauler` or combined early `worker`
- `upgrader`
- `builder`

Example files:

```text
prod/src/spawn/spawnPlanner.ts
prod/src/spawn/bodyBuilder.ts
prod/src/spawn/spawnQueue.ts
```

### 5. Task system

Purpose: make creep behavior explicit and testable.

Responsibilities:

- task assignment
- task serialization in creep memory
- simple task lifecycle
- target validation
- fallback reassignment

MVP tasks:

- harvest
- transfer
- withdraw
- upgrade
- build
- repair
- idle/recycle later

Example files:

```text
prod/src/tasks/Task.ts
prod/src/tasks/taskFactory.ts
prod/src/tasks/creepTaskRunner.ts
```

### 6. Creep executors

Purpose: execute current creep task using Screeps API calls.

Responsibilities:

- move-to-target
- action result handling
- stuck detection later
- simple role fallback behavior

Example files:

```text
prod/src/creeps/creepRunner.ts
prod/src/creeps/movement.ts
prod/src/creeps/roles.ts
```

### 7. Logistics

Purpose: evolve from role-based hauling into request-based resource movement.

MVP: simple energy source/sink selection.

Later:

- logistics requests
- priorities
- hauler matching
- storage/terminal/lab support

Example files:

```text
prod/src/logistics/energyRequests.ts
prod/src/logistics/sinkSourceSelectors.ts
```

### 8. Construction and room planning

Purpose: choose build/repair priorities now; eventually plan bases.

MVP:

- build existing construction sites by priority
- repair only critical structures / roads above threshold

Later:

- base layout planner
- road planner
- extension placement
- tower/rampart planning

Example files:

```text
prod/src/planning/construction.ts
prod/src/planning/repair.ts
prod/src/planning/baseLayout.ts
```

### 9. Defense

Purpose: keep early rooms safe enough before expansion.

MVP:

- hostile detection
- tower attack/heal/repair basic priority
- alert emission to `#runtime-alerts` later

Later:

- safe mode logic
- defender spawn
- rampart defense

Example files:

```text
prod/src/defense/hostiles.ts
prod/src/defense/towers.ts
prod/src/defense/alerts.ts
```

### 10. Telemetry / reporting

Purpose: make runtime observable in Discord and logs.

MVP:

- console summaries
- CPU used/bucket
- creep counts
- spawn queue
- room energy/controller progress

Later:

- external log scraper or API-based monitor
- `#runtime-summary` periodic reporting
- `#runtime-alerts` event-driven alerts

Example files:

```text
prod/src/telemetry/metrics.ts
prod/src/telemetry/summary.ts
prod/src/telemetry/alerts.ts
```

## MVP boundary

The first runnable MVP should do only this:

1. Initialize memory safely.
2. Detect owned room and spawn.
3. Spawn enough creeps to avoid economic death.
4. Harvest sources.
5. Transfer energy to spawn/extensions.
6. Upgrade controller.
7. Build selected construction sites.
8. Recover from creep death and memory cleanup.
9. Emit basic console telemetry.
10. Pass unit tests and at least one deterministic tick integration test.

Explicitly out of MVP:

- multi-room empire logic
- remote mining
- market
- labs
- power creeps
- combat strategy
- multi-shard routing
- automatic base layout beyond minimal construction priorities

## Decision topics to validate next

### Topic A: MVP creep model

Options:

1. role-based creeps first
2. task-based creeps first
3. hybrid: simple roles backed by serializable tasks

Recommendation: hybrid. It is simple enough for MVP but avoids painting us into a role-only architecture.

### Topic B: first logistics model

Options:

1. fixed role responsibilities
2. source/sink selector
3. full request broker

Recommendation: source/sink selector now; request broker later.

### Topic C: room abstraction depth

Options:

1. direct `Game.rooms` access everywhere
2. light `Colony` wrapper
3. Overmind-like deep hierarchy

Recommendation: light `Colony` wrapper now; deeper hierarchy only after multi-room complexity appears.

### Topic D: deployment target order

Options:

1. deploy directly to MMO
2. unit tests then MMO
3. unit tests + tick integration + private server + staged MMO

Recommendation: option 3.

## Initial implementation roadmap

### Milestone 0: project skeleton

- create `prod/package.json`
- create TS/Rollup/Jest config
- create minimal `src/main.ts`
- add typecheck/test/build scripts

Exit criteria: `npm run build` creates deployable `dist/main.js`.

### Milestone 1: memory + kernel

- memory schema
- migration version
- main loop ordering
- CPU guard
- dead creep cleanup

Exit criteria: unit tests for memory initialization and cleanup pass.

### Milestone 2: first room economy

- detect owned colony
- spawn planner
- body builder
- simple creep task runner
- harvest/transfer/upgrade/build tasks

Exit criteria: deterministic integration test proves first room can progress for N ticks.

### Milestone 3: local private server smoke

- Dockerized private server config docs
- deploy to private server
- verify first spawn/economy loop manually

Exit criteria: bot runs for several hundred ticks without fatal exception.

### Milestone 4: staged MMO deployment

- configure token-backed branch upload
- deploy low-scope branch
- monitor CPU/errors/room progress

Exit criteria: bot survives initial live run and emits useful telemetry.

## Architecture decision snapshot

Current recommended decisions:

```text
Language: TypeScript
Build: Rollup-style single main.js bundle
Testing: Jest + screeps-jest + screeps-server-mockup
Local server: Dockerized screeps-launcher
Architecture: kernel + light colony wrapper + hybrid role/task creep model
MVP scope: single-room survival/economy/upgrade/build loop
```

These are ready to be promoted to `#decisions` once the implementation skeleton validates the build/test/deploy path.
