# MVP Skeleton Implementation Process Note

Date: 2026-04-26

## What changed

The project moved from research/design into the first runnable production-code skeleton under `prod/`.

Implemented:

- TypeScript project configuration
- Jest test runner
- build command using esbuild to produce a single bundled `dist/main.js`
- memory schema initialization
- dead creep memory cleanup
- small kernel tick loop
- Screeps-compatible exported `loop`
- `prod/README.md`

## TDD record

### Memory initialization

RED:

- Wrote `prod/test/memory.test.ts` before `prod/src/memory/schema.ts` existed.
- Initial test failed because `../src/memory/schema` was missing.

GREEN:

- Implemented `initializeMemory()`.
- Verified memory tests passed.

### Dead creep memory cleanup

RED:

- Added test for removing dead creep memory before export existed.
- Test failed because `cleanupDeadCreepMemory` was not exported.

GREEN:

- Implemented `cleanupDeadCreepMemory()`.
- Verified memory tests and typecheck passed.

### Kernel

RED:

- Wrote `prod/test/kernel.test.ts` before `Kernel` existed.
- Test failed because `../src/kernel/Kernel` was missing.

GREEN:

- Implemented `Kernel.run()` with injected memory dependencies.
- Verified kernel tests and typecheck passed.

### Main loop

RED:

- Wrote `prod/test/main.test.ts` before `src/main.ts` existed.
- Test failed because `../src/main` was missing.

GREEN:

- Implemented exported `loop()` connected to kernel.
- Verified main tests and typecheck passed.

## Verification

Final verification command:

```bash
cd prod
npm run typecheck
npm test
npm run build
test -f dist/main.js
grep -q "module.exports" dist/main.js
```

Result:

- `typecheck`: passed
- `test`: passed, 3 suites, 8 tests
- `build`: passed, `dist/main.js` generated

## Notable implementation choice

The initial `tsc` build emitted multiple files, which is less convenient for Screeps deployment. The build was changed to use `esbuild` bundling so `prod/dist/main.js` is a single CommonJS output.

## Next step

Implement the first MVP economy loop:

1. room/colony detection
2. body builder
3. spawn planner
4. minimal task model
5. first harvest/transfer/upgrade/build flow
