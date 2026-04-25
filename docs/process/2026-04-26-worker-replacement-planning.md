# Worker replacement planning hardening

Date: 2026-04-26

## Objective

Execute the next recommended deterministic coding slice after roadmap refresh: harden worker replacement planning so the MVP economy plans a replacement before an existing worker expires.

## Coding boundary

Production/test/build changes under `prod/` must be authored/committed through OpenAI Codex CLI. Hermes verified the existing working tree, then used a narrow Codex commit-only prompt to inspect, stage, and commit exactly the intended production files.

## Implementation summary

Codex committed:

- `d883e80f4ea068419f616096c326a9d2632bc695` — `test: harden worker replacement planning`

Changed files:

- `prod/src/creeps/roleCounts.ts`
  - introduced `WORKER_REPLACEMENT_TICKS_TO_LIVE = 100`;
  - exports `RoleCounts` from the role-counting module;
  - excludes same-colony workers at or below replacement threshold from steady-state worker capacity.
- `prod/src/spawn/spawnPlanner.ts`
  - imports `RoleCounts` from `roleCounts` so worker replacement accounting owns the role-count type.
- `prod/test/roleCounts.test.ts`
  - covers replacement-age exclusion, other-colony exclusion, unassigned creep exclusion, and workers without lifetime in mocks.
- `prod/test/spawnPlanner.test.ts`
  - covers planning one replacement when replacement-aware worker capacity is below target;
  - covers no overbuild when replacement-aware worker capacity is at target.
- `prod/test/mvpEconomyLifecycle.test.ts`
  - covers end-to-end economy loop behavior that plans a replacement for an expiring colony worker without counting unrelated workers.
- `prod/dist/main.js`
  - regenerated bundle.

## Verification

Hermes ran the full preferred verification after the production changes were present:

- `cd prod && npm run typecheck` — passed
- `cd prod && npm test -- --runInBand` — passed, 11 suites / 37 tests
- `cd prod && npm run build` — passed

## Reporting

Main-agent follow-up after Codex completion:

- report implementation/verification/commit to `#dev-log`;
- report task completion and next recommended task to `#task-queue`;
- report roadmap impact to `#roadmap`;
- no new owner decision is required for this slice.

## Next candidates

1. Early telemetry/logging MVP through Codex CLI.
2. Continue private-server smoke only after Docker/Compose or Node.js 22+ disposable environment is available.
3. Keep MMO deployment gated behind private-server smoke unless the owner explicitly overrides.
