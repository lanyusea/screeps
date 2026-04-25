# Process Note: Why Overmind's Architecture Matters

Date: 2026-04-25

## What I researched

I used Overmind as the reference implementation for large-scale Screeps bot design, focusing on:

- the hierarchy (`Overmind` / `Colony` / `HiveCluster` / `Directive` / `Overlord` / `Overseer` / `Task` / `Zerg`)
- the tick phases and cache strategy
- the task/role model
- logistics and hauling patterns
- what we should reuse versus avoid

## What stood out

Overmind is not just a strong bot; it is a useful design language.

The big lesson is that Screeps rewards architecture, not just tactics:

- the bot needs a clear control hierarchy
- long-lived intent should be separate from immediate execution
- creeps should be task-aware, not hard-coded role scripts
- logistics should be modeled as routing and request matching
- the tick loop should be phase-separated so CPU-heavy work is bounded

## Why these patterns matter

### 1. Hierarchy makes the bot understandable

The Overmind layering gives us a clean mental model for a large codebase.
If we mirror that structure, our bot can stay readable when it grows past the startup phase and starts handling multiple rooms, threats, and economy states.

### 2. Task chaining reduces brittleness

Overmind's task model is attractive because it lets a creep complete one job and move into the next without a full reclassification of its role.
That is exactly the kind of flexibility we want for transporters, builders, and emergency responders.

### 3. Logistics becomes an optimization problem

The hauling writeup reframes transport as a request-routing problem instead of a simple "closest creep picks up energy" loop.
That matters because Screeps logistics breaks down once the colony has multiple dropoffs, multiple supply sources, and multiple priorities.

### 4. Tick phases are a CPU discipline tool

The build/refresh/run separation is valuable because it forces expensive world modeling into a controlled phase.
That is a strong fit for Screeps, where CPU budget is part of the competitive game loop.

## Reusable design angles for our bot

- keep directives/flags for strategic intent and exceptions
- use an overseer-style scheduler for priority handling
- let overlord-style controllers own a domain, not a single action
- make tasks composable and chainable
- keep logistics request-driven and buffer-aware
- prefer refreshable caches over repeated deep reconstruction

## What to avoid

- role sprawl
- greedy transport heuristics that only work in one base layout
- turning flags into the only configuration surface
- rebuilding the whole AI every tick
- adding special-case scripts for every room condition

## Blog-ready angles preserved here

This research supports several future blog themes:

1. **Screeps as systems engineering**
   - The interesting part is not creep movement; it is designing the control plane.

2. **From roles to orchestration**
   - Why Overmind moved from role scripts to overlords, tasks, and directives.

3. **Why logistics is the hardest clean architecture problem in Screeps**
   - Transport is really routing, prioritization, and allocation under CPU limits.

4. **Tick phases as a performance pattern**
   - How a game AI benefits from build/refresh/run boundaries.

5. **Discord as the operator surface**
   - The next writeup can connect bot architecture to the project's channel structure and operational workflow.

## Takeaway for the project

The main reason these patterns matter is that they let us build a bot that can scale without becoming chaotic.
Overmind is useful not because we should clone it line by line, but because it shows how to structure a Screeps AI as a living system: hierarchy, intent, execution, and logistics all separated cleanly enough to evolve over time.
