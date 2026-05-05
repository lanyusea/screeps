# P0 Incident Postmortem: Room E26S49 Collapse (2026-05-05)

## Incident Summary

On 2026-05-05 10:25 CST, deploy commit `e87059d` (link energy distribution #587/#588) collapsed room E26S49. The room went from healthy (1 spawn, 6 creeps) to dead (0 spawns, 0 creeps, 3 structures) within ~30 minutes. Recovery required destructive respawn + rollback deploy.

## Root Cause Chain

### 1. What broke: linkManager.ts energy starvation (CODING + DESIGN)

The `e87059d` commit added an 847-line `linkManager.ts` refactor that implemented link-based energy distribution from source-harvester rooms. The core logic routes energy through links to storage/spawn, but a path in the distribution logic starved the spawn of energy:

- The link distribution likely consumed or redirected energy that should have been available for spawn refill
- Without energy reaching the spawn, workers couldn't be replaced as they expired
- Once the last worker died, the room had no recovery path — no creeps to harvest, no energy to spawn

**Classification**: Design (the distribution algorithm didn't have a spawn energy floor) + Coding (the starvation path wasn't caught by tests)

### 2. Why it wasn't caught before merge (TESTING + REVIEW gap)

- **Tests passed**: The PR had 414 new test lines in `linkManager.test.ts` — but tests verified link routing correctness in isolation, not the end-to-end "does the spawn still get energy when links are active" scenario
- **Code review didn't catch it**: CodeRabbit found 6 threads, all resolved — none identified the spawn starvation risk
- **No integration test**: No test validates that the full tick loop (harvest → link → storage → spawn → worker replacement) continues functioning
- **No private smoke**: The link distribution change was deployed directly to official MMO without private-server smoke testing

**Classification**: Testing gap (no end-to-end spawn survival test) + Process gap (no pre-deploy smoke for economy changes)

### 3. Why it was merged (PROCESS gap)

- CodeRabbit review threads were resolved (6/6)
- CI checks were green
- Elapsed window was satisfied
- But the review focused on code correctness, not on "will this kill the room" — the review gate doesn't have a spawn-survival acceptance test

**Classification**: Process gap — merge gate checks code quality but doesn't validate gameplay survival

### 4. Why no automatic fallback after failure (RECOVERY gap)

After deploy, the health gate correctly detected the room was dead (postdeploy_no_owned_spawn, postdeploy_room_dead). But:
- **No automated rollback**: The system can detect room death but can't automatically revert to the previous healthy deploy
- **No autonomous respawn**: The rules required owner authorization for destructive respawn, so the agent waited instead of acting
- **No bootstrap/survival mode**: The bot code has no emergency mode — once spawn energy is starved, there's no code path to recover
- **No energy telemetry (#583)**: `storedEnergy` emitted 0, so the energy crisis was invisible to monitors

**Classification**: Process gap (no autonomous recovery authorization) + Design gap (no bootstrap mode) + Telemetry gap (#583)

## Mechanism Fixes Required

| # | Fix | Mechanism | Status |
|---|-----|-----------|--------|
| 1 | Autonomous respawn when room is dead and no other recovery path exists | Update rules-registry.md + autonomous scheduler contract | ⬜ TODO |
| 2 | Pre-deploy private smoke gate for economy/spawn-affecting changes | Add to deploy script: economy changes → private smoke → health gate → official deploy | ⬜ TODO (existing #28) |
| 3 | Spawn-survival integration test | Add test: tick loop 100+ ticks, verify spawn never starves with links active | ⬜ TODO |
| 4 | Deploy health gate → auto-rollback | After post-deploy room_dead detected, auto-revert to previous healthy SHA | ⬜ TODO |
| 5 | Bootstrap/survival mode in bot code | Overmind-inspired colony mode: BOOTSTRAP suppresses non-essential work and prioritizes spawn energy | ⬜ TODO |
| 6 | Energy telemetry (#583) | Already implemented, PR #594 pending merge | ⏳ In review |
| 7 | Economy change private smoke required | Merge gate: economy/spawn PRs must include private smoke evidence or explicit hold | ⬜ TODO (#63) |

## Concrete Next Actions

1. **Immediate**: Merge #594 (energy telemetry) → deploy → verify non-zero energy values
2. **This cycle**: Create P0 issue for autonomous respawn authorization rule
3. **This cycle**: Create P1 issue for spawn-survival integration test
4. **This cycle**: Create P1 issue for Overmind-inspired bootstrap/survival mode
5. **Post-recovery**: Enforce private smoke for economy PRs via #63 release/hotfix gate
