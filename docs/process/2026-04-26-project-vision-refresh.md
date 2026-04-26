# Project Vision Refresh

Date: 2026-04-26T06:03:38Z

## Trigger

Owner refreshed the project vision in Discord: in Screeps competition-map play, the bot should obtain enough large territory, enough resources across categories, and enough enemy kills, in that priority order. All roadmap decomposition and priority evaluation should serve the final vision.

## Durable decision

The project vision is now documented as:

1. Territory first: claim, hold, defend, and coordinate a large room footprint.
2. Resources second: turn territory into energy, minerals, infrastructure, logistics, storage, and market-ready value.
3. Kills third: build defense/offense and kill capability only as it supports territorial and economic control.

## Files updated

- `AGENTS.md` now names the project vision in the mission/operating model.
- `docs/ops/project-vision.md` is the canonical project-vision counterpart to Discord `#project-vision`.
- `docs/ops/roadmap.md` now includes a priority contract and task-ranking chain.
- `docs/ops/discord-project-spec.md` now treats `#project-vision` as the place for the final gameplay objective and priority contract.
- `docs/process/active-work-state.md` now references the vision while preserving current P0 agent-operations work.
- `docs/README.md` indexes the new vision document.

## Planning implications

Near-term P0 communication/validation work remains valid because it protects reliable progress toward the gameplay target. The next product-strategy roadmapping pass should classify each domain by its direct contribution to territory, resource scaling, or combat/kill capability, and should prefer tasks that unblock the earliest missing step in:

```text
survive reliably → expand territory → scale resources → defend/attack effectively → optimize kills
```
