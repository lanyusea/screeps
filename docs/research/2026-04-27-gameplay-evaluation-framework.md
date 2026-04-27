# Screeps Gameplay Evaluation Framework Research

Date: 2026-04-27

## Purpose

This note grounds the gameplay-evolution roadmap in observable Screeps mechanics and community practice. It exists to avoid speculative metric design: every recurring review must connect game results to code-roadmap changes with evidence.

## Source base

- Official Screeps API: https://docs.screeps.com/api/
- Official Expansion Rank: https://screeps.com/a/#!/rank/world
- Official Power Rank: https://screeps.com/a/#!/rank/power
- ScreepsPlus hosted Grafana/statistics ecosystem: https://screepspl.us/
- TooAngel bot statistics implementation: https://github.com/TooAngel/screeps/blob/master/src/brain_stats.js
- TooAngel Grafana dashboards: https://github.com/TooAngel/screeps/tree/master/grafana/main/db
- Overmind bot: https://github.com/bencbartlett/Overmind
- Overmind statistics module: https://github.com/bencbartlett/Overmind/blob/master/src/stats/stats.ts
- Overmind Grafana dashboard example: https://github.com/bencbartlett/Overmind/blob/master/assets/Grafana%20Dashboards/Overmind.json

## Defensible KPI hierarchy

The project vision orders goals as **territory first, resources second, enemy kills third**. Metrics should preserve that order rather than optimizing a single easy number.

### 1. Territory dominance

Primary indicators:

- Owned rooms at the end of the review window.
- Net owned-room gain/loss during the window.
- Reserved / remote rooms held and their uptime.
- Controller level and controller progress per room.
- Controller downgrade risk.

Why this is defensible:

- Room control and controller progress are first-class Screeps concepts (`StructureController`, room ownership/reservation, GCL progress).
- The official Expansion Rank is based on controller-upgrade control points, making controller progress an externally recognized territory-expansion signal.

### 2. Resource and economy scale

Primary indicators:

- Total stored energy and economically useful resource holdings.
- GCL progress delta over the window.
- RCL progress delta per owned room.
- Energy income / harvest / collection per tick or per window.
- Spawn utilization, queue pressure, energy-capacity growth.
- Remote mining uptime and haul reliability.

Why this is defensible:

- Mature community dashboards repeatedly track CPU, GCL/RCL, room energy, storage/terminal contents, creep counts by role, spawning pressure, and economic flow.
- Screeps exposes these directly through room, controller, store, market, and CPU APIs.

### 3. Combat effectiveness / enemy kills

Primary indicators:

- Hostile creeps/structures destroyed, ideally event-backed.
- Enemy economic damage or value destroyed, not just raw kill count.
- Hostile attack events, own losses, and net combat outcome.
- Defensive readiness: rampart/barrier health, tower energy, safe-mode usage, spawn survival.

Why this is defensible:

- `Room.getEventLog()` and event constants such as `EVENT_ATTACK`, `EVENT_OBJECT_DESTROYED`, `EVENT_ATTACK_CONTROLLER`, and `EVENT_UPGRADE_CONTROLLER` provide event-backed observations.
- Raw kill count alone is insufficient; it must be interpreted in service of territory and economy.

### 4. Guardrail reliability metrics

These guard against a bot that looks successful briefly but is unstable:

- CPU used, CPU bucket min/median/end, heap/memory if available.
- Runtime exceptions, global resets, telemetry silence.
- Spawn/worker death spirals.
- Downgrade-risk controllers.
- Alert false positives / false negatives.
- Time-to-recovery after hostile contact or creep loss.

## Anti-metrics

Do not optimize these in isolation:

- Raw creep count: rewards inefficient bodies and CPU waste.
- Raw kills: can reward killing cheap creeps while losing territory/economy.
- GCL alone: can overfit to peaceful upgrading instead of territorial dominance.
- Stored energy alone: can reward hoarding instead of conversion into control, defense, or expansion.
- High CPU usage: useful work per CPU and bucket safety matter more.
- Single incident anecdotes: use rolling windows and event/stat evidence.

## 12-hour review classification

Each 12-hour review should classify the window as one or more of:

- **Expansion win**: net territory gain or improved room-control readiness without reliability regression.
- **Economic win**: stronger energy/resource/GCL/RCL trend without territory loss.
- **Combat win**: enemy loss/objective success exceeds own loss and supports territory/economy.
- **Stall**: no meaningful KPI movement, with no clear planned reason.
- **Regression**: room loss, economy contraction, CPU/runtime failure, repeated recovery failure, or missed alert.

## Bottleneck-to-roadmap mapping

| Observed result | Likely roadmap/code area |
| --- | --- |
| Room count flat while storage/energy is high | Expansion planner, claim logic, scout/claim candidate scoring |
| New rooms collapse | Bootstrap logic, early defense, emergency spawn, logistics |
| High CPU with weak growth | Pathfinding/cache/profiling, tick scheduler, intent pruning |
| Energy income low | Harvest assignment, remote mining, hauling, dropped-resource collection |
| RCL progress low despite available energy | Upgrader allocation, controller logistics, construction/repair priority |
| Spawn queues high | Spawn scheduling, body composition, room specialization |
| Lost rooms during attacks | Threat detection, tower logic, rampart maintenance, safe-mode policy |
| Many kills but no territory/economy gain | Target selection, attack objective design, retreat/hold criteria |
| Strong economy but no combat capability | Boost pipeline, squad coordination, scouting and target selection |
| Alert missing or spammy | Runtime monitor detection, debounce signatures, image/report clarity |

## Review output requirements

Accepted review conclusions must include:

1. Time window and evidence sources.
2. KPI deltas and confidence level.
3. Dominant bottleneck.
4. Hypothesis for the next code or ops change.
5. Expected KPI movement in the next window.
6. Rollback/stop condition.
7. GitHub issue/project update or explicit reason no task is created.

## Current project gap found by audit

The repo already has a live room monitor and in-game runtime summary, but it does **not** yet expose enough cumulative vision KPIs:

- controlled/reserved/remote-room footprint;
- controller/RCL progress deltas;
- resource harvest/collection/storage deltas;
- combat events and enemy kill/destroy outcomes;
- outcome classification that feeds GitHub task creation.

Therefore the first roadmap slice should not be another generic infrastructure task. It should install the evaluation loop and KPI schema that makes future bot-code priorities evidence-driven.
