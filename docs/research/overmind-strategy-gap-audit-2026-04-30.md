# Overmind strategy gap audit — 2026-04-30

## Context

Owner feedback: current strategy has made avoidable low-level mistakes. I reviewed `bencbartlett/Overmind` at commit `5eca49a0d988a1f810a11b9c73d4d8961efca889` and compared it to the current production bot on `main` (`67c0c9e`, PR #357).

Current official runtime evidence immediately before this audit:

- `runtime-artifacts/official-screeps-deploy/postdeploy-summary.json`: `shardX/E46S43`, tick `305088`, one owned spawn and one owned creep.
- Open P0 issue #359: official post-deploy survival gate previously found no owned spawn or creeps.
- Current production bot has a compact economy loop with one generalized `worker` role plus `scout`/`claimer` territory roles.

## What Overmind does that matters here

This audit intentionally ignores mature-bot complexity that is not yet appropriate. The relevant patterns are small and tactical:

1. **Explicit lifecycle and emergency modes.**
   - `ColonyStage` distinguishes `Larva`, `Pupa`, `Adult`.
   - `DEFCON` and `bootstrapping` are first-class colony state.
   - `Overseer.handleBootstrapping` creates a bootstrap directive when normal hatchery/queen spawning cannot recover.
   - `BootstrappingOverlord` first restores mining/filling, not expansion or vanity work.

2. **Priority queue, not ad-hoc spawn decisions.**
   - `priorities_overlords.ts` reserves priority `0` for catastrophic bootstrap, then core refill/queen, then defense, then colonization, then owned-room mining/work/transport, then upgrading, scouting, remote rooms.
   - The important lesson is not the exact numbers; it is the hard separation of survival/core throughput from opportunistic strategy.

3. **Colony component boundaries.**
   - Overmind has Hatchery, CommandCenter, UpgradeSite, RoadLogistics, LogisticsNetwork, RoomPlanner, and per-directive Overlords.
   - Even if we keep a small codebase, we need comparable *interfaces*: spawn recovery, energy acquisition/delivery, construction, controller safety, territory/remote operations, defense.

4. **Recovery is a mode, not a side effect.**
   - Bootstrap miners/fillers are created when room energy is insufficient for normal recovery.
   - Normal spawning can be suppressed while bootstrap is active, preventing strategic work from starving survival.

5. **Remote/territory work is gated by home throughput.**
   - Overmind's priorities place colonization before routine owned-room economy, but after emergency/core/defense; remote room mining/reservation is much later and can restart one room at a time.
   - For our current one-spawn/one-creep room, territory expansion must never spend the last functional energy loop.

## Current low-level strategic errors / risks

### P0 — No explicit bootstrap state machine

Current `prod/src/spawn/spawnPlanner.ts` has emergency worker body selection when `roleCounts.worker === 0`, but recovery is only a local spawn-body fallback. It does not create an observable colony-wide recovery mode with clear gates, telemetry, and suppression of non-survival work.

Risk: a room with one spawn/one creep can still spend scarce creep ticks on construction/remote/controller-pressure decisions while the local energy loop is not yet stable.

### P0 — Single generalized worker is overloaded

`prod/src/tasks/workerTasks.ts` encodes a long linear priority chain for harvesting, filling spawn/extensions, building, repairing, upgrading, and territory controller work. It has many local preemption fixes, but no role-level contract like Overmind's miner/filler/worker/transporter split.

Risk: each new tactical patch can fix one symptom while introducing another, because the same creep oscillates between mining, delivery, building, upgrading, and territory pressure.

### P0 — Spawn priority is implicit and fragile

`planSpawn` currently orders worker recovery, then territory intent, then worker recovery again. This is better than before, but it is not a general priority queue with survival/core/defense/territory tiers.

Risk: adding a new strategic feature can accidentally compete with emergency recovery unless every contributor remembers all implicit ordering constraints.

### P1 — No home-room survival KPI gate before territory actions

The project vision prioritizes territory, but Overmind shows territory/remote directives are only safe when home throughput is stable enough to recover. Current territory logic has follow-up worker demand, but lacks an explicit gate such as `homeStableForTerritory = spawn present && miner/filler/worker floor met && controller safe && energy refill SLA met`.

Risk: strategy appears to pursue territory while actually reducing long-term territory by killing the seed colony.

### P1 — Runtime monitor is not yet a strategic feedback loop

Runtime summaries exist, but strategy code does not consume a small set of hard health states: `BOOTSTRAP`, `LOCAL_STABLE`, `REMOTE_READY`, `DEFENSE`, `EXPAND_READY`.

Risk: agents keep adding ranking/evaluation machinery while the bot lacks the simple phase gates that avoid elementary MMO failures.

## Strategy changes to implement

### Immediate tactical correction

Implement a small Overmind-inspired colony mode layer, without importing Overmind architecture wholesale:

```text
BOOTSTRAP:
  Enter when: no spawn/creep, no workers, or worker capacity below survival floor; or spawn/extensions cannot be reliably refilled.
  Allowed spawn intents: emergency miner/worker, filler/refiller.
  Allowed creep tasks: local harvest/pickup/withdraw -> spawn/extensions/tower -> controller downgrade guard.
  Suppressed: territory/remote/scout/claimer, non-critical roads, vanity construction, surplus repair.

LOCAL_STABLE:
  Enter when: spawn exists, worker capacity floor met, spawn/extension refill can continue, controller downgrade guard is healthy.
  Allowed: early extension/container/road construction, bounded upgrading.

REMOTE_READY / TERRITORY_READY:
  Enter only after LOCAL_STABLE plus reserve energy/worker headroom.
  Allowed: scout/claim/reserve/remote logistics.

DEFENSE:
  Overrides remote/territory; local survival and tower/refill first.
```

### First code slice for Codex

Create a P0 production-code PR that:

1. Adds a deterministic `colonyMode`/`survivalState` helper with tests.
2. Refactors `planSpawn` so all spawn intents pass through explicit priority tiers: emergency bootstrap → local refill/survival → controller downgrade guard → defense → territory.
3. Makes `workerTasks` consult the same mode so `BOOTSTRAP` suppresses territory, non-critical construction, surplus repairs, and routine upgrading.
4. Emits runtime telemetry for the active mode and suppression reason.

### Second code slice

Split generalized worker behavior enough to remove oscillation while staying small:

- not a full Overmind role rewrite;
- add task contracts for `localEnergy` vs `productiveWork` vs `territoryControl`;
- ensure at least one local energy carrier/miner-equivalent remains in the home room before remote/territory work can claim a creep.

### Third code slice

Turn runtime monitor failures into GitHub-tracked strategic blockers:

- any official MMO observation with zero owned spawn or zero owned creeps creates/updates a P0 issue and blocks lower-priority gameplay PR merge/deploy claims;
- current issue #359 remains the evidence anchor until fixed by code + deploy + observation.

## Non-goals

- Do not port Overmind wholesale.
- Do not add obfuscated/assimilation code, global prototype-heavy patterns, or a large role framework now.
- Do not chase RL/strategy-ranking machinery until bootstrap/local stability is hard-gated.

## Source evidence inspected

- Overmind `src/main.ts`: global reset/build-refresh/init-run phases.
- Overmind `src/Colony.ts`: `ColonyStage`, `DEFCON`, utility/hive cluster registration.
- Overmind `src/Overseer.ts`: directives, bootstrap, defense, outpost checks.
- Overmind `src/priorities/priorities_overlords.ts`: emergency/core/defense/colonization/owned-room/upgrading/remote priority bands.
- Overmind `src/overlords/situational/bootstrap.ts`: catastrophic recovery miner/filler behavior.
- Overmind `src/hiveClusters/hatchery.ts`: central spawn queue and hatchery energy request logic.
- Current bot `prod/src/spawn/spawnPlanner.ts`, `prod/src/economy/economyLoop.ts`, `prod/src/tasks/workerTasks.ts`, `prod/src/colony/colonyRegistry.ts`.
