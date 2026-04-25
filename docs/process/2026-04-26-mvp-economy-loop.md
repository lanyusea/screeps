# MVP Economy Loop Implementation Process Note

Date: 2026-04-26

## What changed

The `prod/` bot moved beyond the initial skeleton into the first single-room economy-loop base.

Implemented:

- owned colony detection
- worker body builder
- worker spawn planner
- worker role counting by colony
- worker task selection
- worker task runner
- transfer/refill task for spawn/extension energy sinks
- task lifecycle transitions
- economy loop integration
- kernel integration

## TDD record

### Body builder

RED:

- Added tests for `buildWorkerBody()` before `prod/src/spawn/bodyBuilder.ts` existed.
- Initial failure: missing module.

GREEN:

- Implemented a `[work, carry, move]` worker pattern that scales with available energy and caps under 50 body parts.

### Colony registry

RED:

- Added tests for `getOwnedColonies()` before implementation existed.

GREEN:

- Implemented owned room detection using `room.controller?.my` and spawn grouping by room.

### Spawn planner

RED:

- Added tests for worker spawn planning, target worker count, and busy spawn behavior.

GREEN:

- Implemented `planSpawn()` for worker creeps with deterministic names and memory `{ role: 'worker', colony: roomName }`.

### Role counting

RED:

- Added tests for counting creeps by `memory.role` and `memory.colony`.

GREEN:

- Implemented `countCreepsByRole()`.

### Worker task selection

RED:

- Added tests for harvest/build/upgrade task selection.
- Later added transfer/refill tests after reviewer found missing spawn energy refill behavior.

GREEN:

- Implemented task selection:
  - harvest when empty
  - transfer to spawn/extension energy sinks when carrying energy
  - build construction sites next
  - upgrade controller fallback

### Worker runner

RED:

- Added tests for assigning tasks, executing harvest/transfer, clearing invalid targets, and task transitions.
- Reviewer found the first implementation could get stuck on harvest/spending tasks.

GREEN:

- Implemented task lifecycle transitions:
  - full worker on harvest switches to a spending/refill task
  - empty worker on spending task switches back to harvest
  - invalid target clears task
  - `ERR_NOT_IN_RANGE` triggers `moveTo`

### Economy loop and kernel integration

RED:

- Added tests for `runEconomy()` before implementation existed.
- Updated kernel tests to require `runEconomy()` to run once per tick.

GREEN:

- Implemented `runEconomy()` and wired it into `Kernel.run()`.

## Review record

Initial subagent review found blockers:

1. Workers could get stuck on harvest forever.
2. Workers could get stuck trying to spend energy when empty.
3. No transfer/refill behavior existed for spawn energy.

Fixes were implemented and re-reviewed.

Final review result:

- `APPROVED / PASS`
- Typecheck: pass
- Tests: pass, 10 suites / 31 tests
- Build: pass

Non-blocking follow-up from review:

- Later handle stale/full transfer targets and terminal return codes such as `ERR_FULL` more explicitly.

## Verification

Final verification command:

```bash
cd prod
npm run typecheck
npm test
npm run build
```

Result:

- `typecheck`: passed
- `test`: passed, 10 suites / 31 tests
- `build`: passed, `dist/main.js` generated

## Next step

Prepare deterministic integration or private-server smoke validation:

1. Add a simple simulated multi-tick test strategy, or
2. Add Dockerized private server configuration docs/scripts, then
3. Run the bot in a private server and observe whether the first room can spawn/refill/harvest/upgrade/build without fatal exceptions.
