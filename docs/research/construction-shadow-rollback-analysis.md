<!-- markdownlint-disable MD013 -->

# Construction-Priority Shadow Rollback Analysis

Status: offline root-cause analysis for GitHub issue #868.
Date: 2026-05-10

## Scope

This analysis is read-only against production behavior. It uses local source code and local runtime artifacts only:

- `prod/src/construction/constructionPriority.ts`
- `prod/src/construction/planner.ts`
- `prod/src/tasks/workerTasks.ts`
- `prod/src/strategy/shadowEvaluator.ts`
- `prod/src/strategy/strategyRegistry.ts`
- `/root/screeps/runtime-artifacts/strategy-shadow/rl-gate-73ebefb81342-shadow.json`
- `/root/screeps/runtime-artifacts/rl-dataset-gates/rl-gate-73ebefb81342/gate_report.json`
- the runtime summary referenced by the shadow artifact for tick 739620

No in-game control, official MMO write, GitHub update, or production source change was performed.

## Evidence Summary

The gate report passed as an offline dataset/shadow gate, not as live strategy control:

- `gate_report.json` has `ok: true`, `mode: "current-bot-behavior"`, `officialMmoWritesAllowed: false`, and `officialMmoWrites: false`.
- Its safety block disables construction intent control, spawn intent control, raw creep intent control, market intent control, memory writes, RawMemory writes, live API calls, and official MMO control.
- The gate had 200 samples from a 3542-runtime-summary dataset and reported `strategy_live_effect_false` and `official_mmo_control_forbidden` as passing checks.
- `rolloutGate.status` was `not_configured` because no baseline KPI was provided to the offline gate.

The shadow report is also explicitly offline:

- `rl-gate-73ebefb81342-shadow.json` has `liveEffect: false`.
- Safety says the input mode was saved local runtime-summary artifacts only, with `liveApiCalls: false`, `memoryWritesAllowed: false`, `rawMemoryWritesAllowed: false`, and `officialMmoWritesAllowed: false`.
- It evaluated 200 of 3542 parsed artifacts, with the warning that the artifact limit was applied.
- Across both shadow model families it reported `rankingDiffCount: 148` and `changedTopCount: 0`.
- For `construction-priority`, `rankingDiffCount` was 74, returned diffs were truncated to 25 samples, and `changedTopCount` was 0. In every returned construction sample, incumbent and candidate both kept `finish extension site` as rank 1.

The rollback event at tick 739620 came from the live KPI monitor:

- The runtime summary referenced by the shadow artifact contains an `rl-rollback` record for `construction-priority.territory-shadow.v1`.
- The rollback reason was: territory dropped 36.4%, from 22893.10 to 14556.82, against a 5.0% threshold.
- The same 36.4% reason was applied to `construction-priority`, `expansion-remote-candidate`, and `defense-posture-repair-threshold`, which indicates a shared KPI regression trigger rather than a construction-specific causal proof.

Tick 739620 live room evidence for `E26S49`:

- RCL 4, controller progress 95914 / 405000, one owned room.
- Energy was full at 300 / 300, but energy buffer health was unhealthy: threshold 500, current 300.
- Worker count was 5.
- Worker tasks were `harvest: 2`, `upgrade: 3`, `build: 0`, `repair: 0`.
- Worker behavior over the sampled window had 44 move ticks, 56 work ticks, and 26 stuck ticks.
- Container transfers and source-container withdrawals were both 0.
- Structures showed `containers: []`, `roadCount: 0`, `pendingRoadSiteCount: 3`, and `roadCoverageRatio: 0`.
- Source logistics showed 2 sources, 0 sources with completed containers, and 2 sources with pending container sites.
- Productive construction backlog was large: `pendingBuildProgress: 44718`, with `buildCarriedEnergy: 0`.
- Territory recommendations were all scouts: 8 scout candidates, 0 reserve/occupy candidates, and every next-action path was blocked by the precondition `reach 650 energy capacity for controller work`.

The current territory score at tick 739620 reconstructs to approximately the rollback's current value:

```text
owned room:              10000
controller level 4:       3200
controller progress:       959.14
best territory candidate:  401
reserve/occupy bonus:        0
total:                   14560.14
```

That is close to the rollback monitor's recent-window average of 14556.82.

## Scoring Model Analysis

Construction priority scoring is implemented in `prod/src/construction/constructionPriority.ts`.

`scoreConstructionCandidate` combines:

- urgency, up to 35 points
- room state, up to 20 points
- expansion prerequisites, up to 20 points
- economic benefit, up to 20 points
- vision weight, up to 15 points
- risk cost, up to 25 points subtracted

It then applies two gates:

- `applySurvivalGate`, which caps non-survival work under survival pressure.
- `applySourceLogisticsEnergyStarvationPriority`, which at RCL 4+ boosts containers by +55, boosts roads by +58, and caps extensions at 45 only when room energy is below 50% of room energy capacity.

The live tick did not satisfy that starvation guard because room energy was 300 / 300. Economically, the room was still constrained: capacity was only 300 at RCL 4, the 500 energy buffer was unhealthy, no source containers were built, and road coverage was 0. The guard therefore missed a logistics-starvation state because it only tests fill ratio, not absolute capacity, missing container coverage, road coverage, or build backlog.

Actual construction planning in `prod/src/construction/planner.ts` is extension-first unless the RCL4 fill-ratio starvation guard trips:

1. spawn if missing
2. if source-logistics starved, containers then roads
3. extensions
4. if not source-logistics starved, roads then containers
5. ramparts, towers, storage

Actual builder site selection in `prod/src/tasks/workerTasks.ts` uses `getConstructionSiteImpactPriority`:

- generic extension: 100
- tower: 92
- protected rampart: 90
- critical road: 80
- source container: 70
- generic road: 55
- generic container: 45
- during RCL4 fill-ratio starvation, source container becomes 108 and critical road becomes 106

At tick 739620 the guard was inactive, so generic extension priority remained above source-container and road logistics.

The construction-priority telemetry at tick 739620 quantified that same ordering:

- 10 `finish extension site` candidates scored 55, high urgency.
- `build extension capacity` scored 49, high urgency.
- 2 `finish container site` candidates scored 31, low urgency.
- 3 `finish road site` candidates scored 26, low urgency.
- `build source containers` scored 25, low urgency.
- `build source/controller roads` scored 20, low urgency.

The tradeoff was therefore roughly:

- existing extension site vs existing container site: 55 vs 31, or 1.77x.
- existing extension site vs existing road site: 55 vs 26, or 2.12x.
- planned extension vs planned source container: 49 vs 25, or 1.96x.
- planned extension vs planned source/controller road: 49 vs 20, or 2.45x.

The shadow strategy layer is in `prod/src/strategy/strategyRegistry.ts` and `prod/src/strategy/shadowEvaluator.ts`. It replays emitted runtime-summary candidates; it does not directly create construction sites or select worker build targets.

The incumbent construction-priority strategy defaults are:

- `baseScoreWeight: 1`
- `territorySignalWeight: 6`
- `resourceSignalWeight: 4`
- `killSignalWeight: 6`
- `riskPenalty: 4`

The territory-shadow candidate defaults are:

- `baseScoreWeight: 1`
- `territorySignalWeight: 22`
- `resourceSignalWeight: 3`
- `killSignalWeight: 5`
- `riskPenalty: 4`

The shadow evaluator classifies signals from text in `buildItem`, expected KPI movement, preconditions, and risk. That text-only classifier moved territory-labeled items upward but did not improve local source logistics. In the returned construction diff samples:

- `build remote road/container logistics` moved from rank 21 to 14.
- `build rampart defense` moved from rank 20 to 15.
- `build source containers` moved from rank 19 to 21.
- `finish container site` moved from rank 18 to 20.
- `finish road site` moved from rank 15 to 18.
- The top item stayed `finish extension site`.

## Root Cause Conclusion

The shadow construction strategy did not directly cause the 36.4% territory score drop. Both the gate and shadow report mark the strategy evaluation as offline-only, with `liveEffect: false` and official MMO writes disabled. The construction shadow report also shows zero changed top construction choices.

The rollback was caused by the live KPI monitor detecting that the current live room state had fallen below its saved territory baseline. The proximate territory-score reason was that `E26S49` remained at 300 energy capacity at RCL 4, so territory recommendations could only scout and were blocked from controller work by the 650-energy precondition. With no reserve/occupy candidates, no remote-room contribution, and only one owned room, the reconstructed territory score was about 14560, matching the rollback monitor's current average.

Extension-first construction ordering likely contributed to the live economy bottleneck, but the artifact does not prove the shadow strategy caused that ordering. The live state had 10 extension sites, 2 pending source-container sites, 3 pending road sites, no completed containers, no roads, 0 road coverage, no build tasks, no source-container withdrawals, and 26 stuck ticks in a 100 worker-tick behavior sample. That is consistent with extension backlog starving source-container and road logistics, which slowed the energy-capacity path needed for territory work.

The main defect is a guard mismatch: source-logistics priority only activates when `energyAvailable < 0.5 * energyCapacity`. At 300 / 300 the room looked non-starved to the guard even though it was strategically starved: RCL 4, absolute capacity only 300, energy buffer unhealthy, no completed source containers, no roads, and a large build backlog.

## Recommended Adjustments

Do not treat this rollback as proof that `construction-priority.territory-shadow.v1` had live causal impact. It should remain disabled or shadow-only until validation separates live KPI regressions from counterfactual shadow rankings.

For the shadow weights, the current candidate is too territory-heavy for a construction model:

- Reduce `territorySignalWeight` from 22 toward 10-14.
- Raise `resourceSignalWeight` from 3 toward 6-8.
- Raise `riskPenalty` from 4 toward 5-6 while construction backlog or missing logistics are visible.
- Keep `baseScoreWeight` at 1 so the existing production scorer remains the anchor.

Weights alone are not enough. Existing source-container sites are emitted as generic `finish container site`, so the text classifier cannot reliably distinguish source logistics from generic container work. Add explicit logistics features before promotion, such as source-container coverage, road coverage, energy buffer health, construction backlog, and source-logistics-deficit flags.

For the production construction scorer/planner, preserve extension priority but add a logistics floor independent of the fill-ratio guard:

- At RCL 4+, if source containers are missing or only pending, source-container construction should outrank additional extension backlog until at least one source lane is complete.
- If road coverage is 0 or workers show high stuck/move ratios, critical source/controller road work should outrank additional extension backlog.
- The existing energy-starvation impact values, source container 108 and critical road 106 over extension 100, are reasonable; the trigger should also include absolute capacity and logistics coverage, not only `energyAvailable / energyCapacity`.
- A safe target ordering for this room state is: finish one source container, finish critical source/controller roads, then resume extension capacity, while preserving extension priority once logistics are no longer blocking throughput.

## Safety Note

This document is offline analysis only. No production source, production tests, Screeps Memory, RawMemory, market, spawn, creep, construction, GitHub issue, PR, or Project state was changed.
