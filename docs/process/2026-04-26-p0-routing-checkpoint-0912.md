# P0 Routing Checkpoint — 2026-04-26 09:12 +08:00

## Trigger

The 4-hour checkpoint worker ran while P0 agent operating-system health remains the top active objective. Although the most recent active-state update is less than four hours old, the checkpoint found a durable documentation contradiction in older routing notes that could confuse future autonomous workers.

## Verified state

- Current cron invocation explicitly auto-delivers this final response to `discord:#task-queue`; this worker must not call `send_message` directly.
- Canonical operating contract remains `docs/ops/agent-operating-system.md`.
- Current active state says scheduled Screeps continuation/checkpoint jobs should deliver to the named project channel `discord:#task-queue`, with labelled subsections for typed-channel context.
- Git working tree was clean before this documentation checkpoint.
- Local OS crontab did not list Screeps jobs; only the platform-provided scheduled invocation is directly evidenced from this run. Do not infer Hermes scheduler health from system `crontab` alone.

## P0 finding

`docs/process/2026-04-26-background-process-notification-routing.md` still contained superseded text saying the continuation and 4-hour checkpoint workers were updated to deliver to numeric home channel `discord:1497537021378564200`. That conflicts with the later postmortem and current prompt/active-state contract that scheduled Screeps project progress lands in `discord:#task-queue`.

## Action taken

- Added this checkpoint note.
- Marked the stale background-process routing note as superseded where it discusses scheduled-worker delivery, while preserving its still-valid warning that terminal background `notify_on_complete` notifications bypass normal cron/send-message routing.

## Current objective

P0 remains: stabilize and monitor the Screeps agent operating system, especially cron/routing/subagent summary flow, before treating normal development as fully autonomous.

## Development state recovered for next worker

- Private-server-first validation remains required for release quality.
- Pinned Dockerized runtime path is currently the main runtime validation lane: `screeps@4.2.21`, launcher Node `12.22.12`, and transitive dependency resolutions for `body-parser: 1.20.3` and `path-to-regexp: 0.1.12`.
- Map initialization succeeds when using a pre-downloaded map file and `utils.importMapFile('/screeps/maps/map-0b6758af.json')`, avoiding the Node 12 global-`fetch` path.
- Last recorded private observation reached private `gametime: 5267`, `totalRooms: 169`, `ownedRooms: 1`, an RCL 2 room, and three live bot-created workers without current post-restart launcher log exceptions.
- Official MMO safe selectors remain: branch `main`, shard `shardX`, room `E48S28`.

## Next actions

1. Treat `docs/ops/agent-operating-system.md` plus the later Discord visibility postmortem as authoritative over older routing notes.
2. Continue P0 health monitoring without modifying cron jobs from this checkpoint worker.
3. Once routing health is stable, resume the next runtime task: automate pinned private-server smoke harness and redacted observation capture.
