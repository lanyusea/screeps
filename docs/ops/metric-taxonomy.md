# Metric Taxonomy

Status: runtime-summary console capture schema v2 for issue #960.

This document describes the room-level `#runtime-summary` payload consumed by the KPI reducer, RL metrics SQLite ingestor, dashboard, and Gameplay Evolution review loop. The v2 schema is additive: older artifacts without these fields remain valid and historical SQLite columns stay `NULL` when a field was not present.

## Console Capture Payload

Top-level payload:

| Field | Source | Type | Interpretation | Coverage |
| --- | --- | --- | --- | --- |
| `type` | monitor payload constant | string | Must be `runtime-summary`; identifies reducer-compatible lines. | INSTRUMENTED |
| `tick` | room snapshot `gameTime`/overview time | integer or null | Latest game tick represented by the payload. | INSTRUMENTED |
| `source` | monitor payload constant | string | Producer identity for audit/debugging. | INSTRUMENTED |
| `rooms` | collected room snapshots | array | Per-room gameplay metrics. | INSTRUMENTED |
| `cpu.used` | snapshot `info.cpu.used`/`info.cpuUsed` when available | number or null | CPU used for the tick/window. | INSTRUMENTED |
| `cpu.bucket` | snapshot `info.cpu.bucket`/`info.cpuBucket` when available | number or null | Screeps CPU bucket reserve. | INSTRUMENTED |
| `reliability.loopExceptionCount` | in-bot runtime summary only | number | Tick-loop exception count. | MISSING |
| `reliability.telemetrySilenceTicks` | in-bot runtime summary only | number | Runtime telemetry silence window. | MISSING |

Per-room payload:

| Field | Source | Type | Interpretation | Coverage |
| --- | --- | --- | --- | --- |
| `roomName` | room ref | string | Screeps room name without shard. | INSTRUMENTED |
| `shard` | room ref | string | Screeps shard name. | INSTRUMENTED |
| `pendingBuildProgress` | owned construction sites, sum of `progressTotal - progress` | number | Remaining construction work in the room. `0` means no owned construction backlog is visible. | INSTRUMENTED |
| `buildCarriedEnergy` | owned creeps with build role/task, `carry.energy` or store fallback | number | Energy builders can currently spend on construction. `0` with backlog suggests builder starvation or misassignment. | INSTRUMENTED |
| `constructionSiteCount` | owned construction site objects | number | Active owned construction sites. | INSTRUMENTED |
| `cpuUsed` | snapshot CPU info copied to room metrics | number or null | CPU used this tick/window when the API snapshot exposes it. | INSTRUMENTED |
| `cpuBucket` | snapshot CPU info copied to room metrics | number or null | CPU bucket when the API snapshot exposes it. | INSTRUMENTED |
| `rclLevel` | room controller `level` | number or null | Room controller level. `null` means no controller was visible. | INSTRUMENTED |
| `storedEnergy` | structures with store/energy, excluding confirmed foreign-owned structures | number | Energy held in spawn/extension/container/storage-like structures. | INSTRUMENTED |
| `controller.level` | controller object `level` | number or null | Existing nested RCL field. | INSTRUMENTED |
| `controller.progress` | controller object `progress` | number or null | Current controller upgrade progress. | INSTRUMENTED |
| `controller.progressTotal` | controller object `progressTotal` | number or null | Progress required for next RCL. | INSTRUMENTED |
| `controller.ticksToDowngrade` | controller object `ticksToDowngrade` | number or null | Downgrade safety window. | INSTRUMENTED |
| `resources.storedEnergy` | same value as room `storedEnergy` | number | Durable room energy reserve for existing resource dashboards. | INSTRUMENTED |
| `resources.workerCarriedEnergy` | owned creep stores/carry | number | Energy currently carried by owned creeps. | INSTRUMENTED |
| `resources.droppedEnergy` | dropped energy resource objects | number | Visible dropped energy in room. | INSTRUMENTED |
| `resources.sourceCount` | source objects | number | Visible energy source count. | INSTRUMENTED |
| `resources.productiveEnergy.pendingBuildProgress` | same value as room `pendingBuildProgress` | number | Existing productive-energy namespace for construction analysis. | INSTRUMENTED |
| `resources.productiveEnergy.buildCarriedEnergy` | same value as room `buildCarriedEnergy` | number | Builder energy under productive-energy namespace. | INSTRUMENTED |
| `resources.productiveEnergy.constructionSiteCount` | same value as room `constructionSiteCount` | number | Construction site count under productive-energy namespace. | INSTRUMENTED |
| `resources.productiveEnergy.buildBlockedReason` | backlog/energy/assignment classifier | string | One of `energy_buffer_blocked`, `no_construction_sites`, or `worker_assignment_gap` when construction is blocked or absent. | INSTRUMENTED |
| `structures.extensionCount` | completed extension structures | number | Completed extension count used to identify spawn-only capacity stalls. | INSTRUMENTED |
| `structures.extensionCapacityContribution` | completed extension store capacities | number | Energy capacity contributed by extensions only. | INSTRUMENTED |
| `behavior.totals.pathFindingFailures` | stuck no-work behavior summary | number | Inferred pathing failure ticks from `stuckTicks > 0` and `workTicks = 0`. | INSTRUMENTED |
| `behavior.totals.destinationBlocked` | stuck no-work behavior summary | number | Count of creeps with an inferred blocked destination in the window. | INSTRUMENTED |
| `workerLoadEfficiency.tripEnergyMean` | worker efficiency telemetry | number | Mean carried energy for recent worker return/load samples. | INSTRUMENTED |
| `workerLoadEfficiency.tripEnergyMin` | worker efficiency telemetry | number | Minimum carried energy for recent worker return/load samples. | INSTRUMENTED |
| `resources.harvestedThisTick` | in-bot runtime summary event accounting | number | Energy harvested during the tick/window. | MISSING |
| `resources.events.harvestedEnergy` | in-bot runtime summary event accounting | number | Window harvest delta for reducer event summaries. | MISSING |
| `resources.events.transferredEnergy` | in-bot runtime summary event accounting | number | Window transfer delta for reducer event summaries. | MISSING |
| `combat.hostileCreepCount` | hostile creep objects | number | Visible hostile creeps. | INSTRUMENTED |
| `combat.hostileStructureCount` | confirmed foreign-owned structures | number | Visible hostile structures. | INSTRUMENTED |
| `combat.events.attackCount` | in-bot combat event accounting | number | Attack action count in the tick/window. | MISSING |
| `combat.events.attackDamage` | in-bot combat event accounting | number | Attack damage dealt in the tick/window. | MISSING |
| `combat.events.objectDestroyedCount` | in-bot combat event accounting | number | Destroyed object count in the tick/window. | MISSING |
| `combat.events.creepDestroyedCount` | in-bot combat event accounting | number | Destroyed creep count in the tick/window. | MISSING |

## SQLite Persistence

The historical store is `runtime-artifacts/rl-metrics/rl_metrics.sqlite`. The room-metric fields are persisted in `runtime_room_metrics`:

| Column | Capture field | NULL behavior |
| --- | --- | --- |
| `pending_build_progress` | `pendingBuildProgress` | `NULL` for old rows or unreadable values. |
| `build_carried_energy` | `buildCarriedEnergy` | `NULL` for old rows or unreadable values. |
| `build_blocked_reason` | `resources.productiveEnergy.buildBlockedReason` | `NULL` for old rows, active building, or unreadable values. |
| `construction_site_count` | `constructionSiteCount` | `NULL` for old rows or unreadable values. |
| `extension_count` | `structures.extensionCount` | `NULL` for old rows or unreadable values. |
| `extension_capacity_contribution` | `structures.extensionCapacityContribution` | `NULL` for old rows or unreadable values. |
| `path_finding_failures` | `behavior.totals.pathFindingFailures` | `NULL` for old rows or missing behavior telemetry. |
| `destination_blocked` | `behavior.totals.destinationBlocked` | `NULL` for old rows or missing behavior telemetry. |
| `worker_load_trip_energy_mean` | `workerLoadEfficiency.tripEnergyMean` | `NULL` for old rows or missing worker-load telemetry. |
| `worker_load_trip_energy_min` | `workerLoadEfficiency.tripEnergyMin` | `NULL` for old rows or missing worker-load telemetry. |
| `cpu_used` | `cpuUsed` | `NULL` when CPU data is not exposed by the snapshot. |
| `cpu_bucket` | `cpuBucket` | `NULL` when CPU data is not exposed by the snapshot. |
| `rcl_level` | `rclLevel` | `NULL` when no controller is visible. |
| `stored_energy` | `storedEnergy` | `NULL` for historical rows before v2. |

The ingestor also emits metric observations for dashboard queries where useful: `construction.pending_build_progress`, `construction.build_carried_energy`, `construction.site_count`, `territory.rcl_level`, `cpu.used`, `cpu.bucket`, and `economy.stored_energy`.

## Coverage Gap Workflow

1. Gap: a missing field, missing source root, or ambiguous behavior signal is recorded as `metric_coverage_gaps` or marked `MISSING` in this taxonomy.
2. Issue: the controller opens or refreshes a GitHub issue with the smallest implementation surface needed to close the gap.
3. Implementation: code changes add instrumentation without removing older fields or invalidating historical artifacts.
4. Verification: run script compilation/tests, ingest a representative artifact, and confirm the reducer/SQLite summary exposes the field.
5. Close: after the field is observed in live or fixture evidence and the automated review gate is satisfied, close the issue and update this taxonomy from `MISSING` to `INSTRUMENTED`.
