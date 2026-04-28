# Screeps Project Vision

Last updated: 2026-04-29T02:00:00+08:00

This document is the durable counterpart to the Discord `#project-vision` channel. It is the north star for roadmap decomposition, priority evaluation, and trade-off decisions.

## Final objective

In Screeps competition-map play, build a bot that achieves, in strict priority order:

1. **Enough large territory** — claim, hold, defend, and operate a large footprint of rooms.
2. **Enough resources across categories** — convert territory into durable energy, minerals, commodities, infrastructure, and logistical throughput.
3. **Enough enemy kills** — develop combat capability that removes threats and wins fights, but only after the bot can expand and sustain itself.
4. **Self-evolving strategy capability** — continuously evaluate whether the current strategy model, scoring functions, and task-generation rules are still improving the first three objectives; evolve the model through evidence-backed research, controlled experiments, and eventually reinforcement-learning-driven iteration without violating the territory → resources → kills priority order.

The priority order is intentional: territory comes before resource volume, and resource volume comes before kill count. Combat matters, but it should serve expansion, defense, and economic control rather than become an isolated optimization target. Strategy self-evolution is a capability layer, not a separate victory condition: learned policies, scoring-model changes, and experiments are accepted only when they improve or protect the ordered gameplay vision.

## Roadmap evaluation contract

Every roadmap item must answer how it advances at least one layer of the vision:

- **Territory:** Does this help us safely claim, reserve, scout, path through, defend, or coordinate more rooms?
- **Resources:** Does this improve energy/mineral extraction, logistics, storage, market readiness, build/repair throughput, or CPU efficiency that scales with room count?
- **Kills:** Does this improve threat detection, tower/rampart defense, squad control, target selection, or post-economy offensive capability?
- **Strategy evolution:** Does this improve how the bot chooses between territory/resource/combat strategies over time, with measurable evidence and a rollback-safe experiment path?

When two tasks compete for priority, prefer the task that unlocks the earliest bottleneck in this chain:

```text
survive reliably → expand territory → scale resources → defend/attack effectively → optimize kills
```

## Practical implications for current planning

- Early bot work should still focus on survivability, validation, runtime visibility, and recovery because those are prerequisites for holding territory.
- The next strategic jump after stable single-room operation is not “more features” generically; it is the minimum system that can evaluate expansion candidates, claim/reserve rooms, and maintain remote logistics safely.
- Resource systems should be designed as territory multipliers: hauling, storage, roads, repairs, remote mining, minerals, and market behavior should be ranked by how much they increase sustainable controlled footprint.
- Military work should start with defense and threat telemetry, then progress to coordinated combat only when the economy can replace losses and support sustained operations.
- Roadmap snapshots should show each domain's contribution to territory/resources/kills, plus next-point completion percentage, so progress remains tied to the final objective rather than local implementation churn.
- The Gameplay Evolution loop must evaluate the strategy model itself, not only tune numeric thresholds. When evidence shows a scoring model is stale, misweighted, or missing a decision class, the loop should create a research or implementation task to revise the model.
- The long-term strategy-evolution target is reinforcement-learning-assisted iteration, but only after autoresearch and formal paper review define a safe offline/private-server evaluation pipeline. Unvalidated learned policies must not directly control the official MMO bot.

## Non-goals

- Do not optimize for elegant architecture unless it accelerates the territory/resources/kills chain.
- Do not chase kill count before expansion and resource foundations can sustain combat losses.
- Do not treat private-server or CI infrastructure as the final goal; they are release gates that protect progress toward the gameplay vision.
- Do not treat reinforcement learning as a shortcut around evidence. RL work must begin as research and offline evaluation, then pass controlled validation before any official MMO influence.
