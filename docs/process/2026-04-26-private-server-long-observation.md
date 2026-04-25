# Pinned Private-Server Longer Observation

Date: 2026-04-26T05:23:37+08:00

## Context

This continuation slice followed the earlier pinned Dockerized private-server breakthrough. The goal was to keep the existing `/tmp/screeps-private-smoke-pinned` runtime under observation long enough to confirm that the map-file import path was not merely a startup-only success and that the uploaded MVP bot could continue ticking in an owned room.

No production code was changed in this slice.

## Runtime observed

Environment:

- Docker Compose project: `/tmp/screeps-private-smoke-pinned`
- Screeps container: `screeps-private-smoke-pinned-screeps-1`
- Backing services: `mongo:8`, `redis:7`
- Server package path: Dockerized `screepers/screeps-launcher:latest` with pinned `screeps@4.2.21`
- Map path: `serverConfig.mapFile: /screeps/maps/map-0b6758af.json`
- Map import path: `utils.importMapFile('/screeps/maps/map-0b6758af.json')`
- Smoke room: `E1S1` on private `shardX`

Observed `/stats` values during this slice:

```text
gametime: 5267
totalRooms: 169
activeRooms: 1
ownedRooms: 1
activeUsers: 1
user: smoke
GCL: 7344
RCL distribution: one level-2 room
creeps: 3 for the smoke user
tick average: ~199.82 ms
```

Mongo room-object inspection for `E1S1` showed:

- owned controller at level 2 with progress toward level 3;
- owned `Spawn1` at `(20,20)` with full energy and full hits;
- two sources and one mineral from the imported map;
- three living bot-created workers named `worker-E1S1-*`, each with `WORK/CARRY/MOVE` body parts and carried energy.

Log scan after the latest container start markers found no `Unhandled`, `TypeError`, `ReferenceError`, `Error:`, or `#runtime-summary` hits in `runner.log`, `processor_*.log`, `main.log`, or `backend.log`. Earlier known warnings from the failed `random_1x1` path remain in the historical log files before the successful restart and should not be treated as current failures.

## Verification

Repository verification was rerun after observation:

```text
cd prod && npm run typecheck      # passed
cd prod && npm test -- --runInBand # passed, 12 suites / 59 tests
cd prod && npm run build          # passed
```

`git status --short --branch` remained clean after the build.

## Conclusion

The pinned Dockerized private-server path is now validated beyond initial startup:

1. the Node 12 launcher can run pinned `screeps@4.2.21` with the documented transitive dependency pins;
2. `utils.importMapFile` with a mounted map JSON initializes a non-empty world and avoids the Node 12 missing-`fetch` failure from `random_1x1`;
3. the uploaded bundled bot runs for thousands of private-server ticks;
4. the bot claims/operates one room, reaches RCL 2, maintains live workers, and continues ticking without current post-restart log exceptions.

Private-server-first validation should remain the release-quality gate, but the active blocker has moved from "room/map initialization" to "capture/automate longer observation and runtime telemetry/reporting".

## Follow-up candidates

1. Turn the current manual smoke procedure into an executable local smoke harness that can start the pinned runtime, import the map file, upload `prod/dist/main.js`, place/verify a spawn, and collect redacted observations.
2. Wire `scripts/screeps-runtime-monitor.py` into scheduled `#runtime-summary` / `#runtime-alerts` jobs after one more live-token/monitor smoke run.
3. Add deterministic coverage or runtime telemetry assertions for issues discovered during longer real-runtime observation, if any appear.
