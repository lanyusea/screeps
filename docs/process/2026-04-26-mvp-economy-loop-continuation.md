# MVP Economy Loop Continuation Process Note

Date: 2026-04-26
Slice timestamp: 2026-04-26T01:13:08+08:00

## Objective

Continue the pending `mvp-economy-loop` task with one bounded autonomous implementation slice.

## Starting state

The working tree already contained uncommitted economy-loop files and tests for:

- colony detection
- worker body building
- spawn planning
- role counting
- economy-loop integration
- worker task selection
- worker task execution

Before editing, the full Jest suite had one failing test:

- `selectWorkerTask` did not yet select a `transfer` task for a spawn/extension needing energy.

A new RED test was added for execution behavior:

- `runWorker` should call `creep.transfer(target, RESOURCE_ENERGY)` and move toward the target when transfer returns `ERR_NOT_IN_RANGE`.

## TDD record

### RED

Commands:

```bash
cd prod
npm test -- --runInBand
npm test -- workerRunner.test.ts --runInBand
```

Observed failures:

- `workerTasks.test.ts` expected `{ type: 'transfer', targetId: 'spawn1' }` but received `null`.
- `workerRunner.test.ts` expected `creep.transfer(spawn, 'energy')`, but `transfer` had zero calls.

### GREEN

Implemented the minimal production behavior needed to pass the tests:

- `selectWorkerTask` now prioritizes spawn/extension energy sinks before build/upgrade tasks when a worker has carried energy.
- `runWorker` now executes serialized `transfer` tasks with `creep.transfer(target, RESOURCE_ENERGY)` and reuses the existing move-on-`ERR_NOT_IN_RANGE` behavior.
- `tsconfig.json` now includes `src/**/*.d.ts` so the project-level Screeps memory/task type augmentations are checked by `tsc`.

### Verification

Command:

```bash
cd prod
npm run typecheck && npm test -- --runInBand && npm run build
```

Result:

- `typecheck`: passed
- `test`: passed, 10 suites / 28 tests
- `build`: passed, `dist/main.js` generated

## Notes

This slice completes the missing transfer step in the first worker economy loop path:

1. empty worker harvests source
2. worker with energy transfers to spawn/extensions first
3. if no energy sink exists, worker builds construction sites
4. if no construction site exists, worker upgrades the controller

## Next task

Continue `mvp-economy-loop` with another bounded TDD slice. Good next candidates:

- clear completed/invalid worker tasks after successful transfer/build/upgrade/harvest state changes, or
- add a deterministic tick-style integration test for spawn + worker task selection across multiple simulated ticks.
