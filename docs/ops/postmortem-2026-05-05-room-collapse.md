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

### 5. Why the owner wasn't notified (ESCALATION gap)

When the room collapsed — a P0 survival incident — the system:
- Created Issue #592 on GitHub ✓
- Did NOT send a Discord @ notification to the owner ✗
- The user discovered the failure hours later by logging in and seeing the dead room

This violates the operating contract: "Exact blockers/P0 owner-action gates require immediate Discord @; GitHub-only comments insufficient" (from memory). The deployment health gate failed, the room was dead, and the only action was a silent GitHub issue.

**Classification**: Escalation gap — P0 survival incidents must trigger immediate owner @ notification on Discord, not just GitHub issue creation.

### 6. Why the continuation worker didn't escalate immediately (DECISION gap)

The continuation worker at 10:28 CST (its last run before being paused at 10:32) correctly detected `postdeploy_room_dead` but wrote:
> "If room recovers spawn naturally, mark deployment floor SATISFIED. If still degraded next cycle, investigate rollback."

This was dangerously optimistic. The health gate had already confirmed 0 spawns, 0 creeps, 3 structures — there is no "natural recovery" from that state in Screeps. The worker should have:
1. Immediately paused itself (not wait 4 minutes for external action)
2. Posted an emergency @ to the owner
3. Triggered the alert escalation path

**Classification**: Decision gap — the autonomous scheduler's post-deploy assessment did not correctly classify a room_dead health gate failure as a P0 survival emergency requiring immediate owner escalation.

### 7. Why the deploy was automatic for a major economy change (GOVERNANCE gap)

The continuation worker merged PR #588 (link energy distribution, 847 new lines in linkManager.ts) and immediately triggered official deploy. There was no gate requiring:
- Private smoke test for economy/spawn-affecting changes
- Owner review for major code changes
- Staged rollout (deploy, observe 10+ ticks, then merge next PR)

The current merge→deploy pipeline treats all gameplay PRs equally, whether they add a telemetry field or rewrite the energy distribution system.

**Classification**: Governance gap — economy/spawn code changes have no elevated deploy gate vs. cosmetic/telemetry changes.

### 8. Why the runtime alert chose silence over escalation (TRIAGE gap)

The runtime alert cron at 11:47 CST correctly detected `room_dead:shardX/E26S49` but:
- Applied debounce (300s) and suppressed the alert as a repeat
- Tactical response classified it as non-emergency (no hostiles, no damage) → returned `[SILENT]`
- The rule "alert suppressed → [SILENT]" is correct for avoiding spam, but the FIRST detection of room_dead should have been treated as a P0 emergency regardless of cause

**Classification**: Triage gap — `room_dead` should always be classified as `severity:critical, emergency:true` regardless of hostile presence, triggering immediate escalation.

## Mechanism Fixes Required

| # | Fix | Mechanism | Status |
|---|-----|-----------|--------|
| 1 | Autonomous respawn when room is dead and no other recovery path exists | rules-registry.md + autonomous scheduler contract | ✅ PR #595 |
| 2 | Pre-deploy private smoke gate for economy/spawn-affecting changes | Deploy pipeline gate: economy code → private smoke → health gate → official deploy | ⬜ #598 |
| 3 | Spawn-survival integration test | Add test: tick loop 200+ ticks, verify spawn never starves with links active | ⬜ #598 |
| 4 | Deploy health gate → auto-rollback | After post-deploy room_dead detected, auto-revert to previous healthy SHA | ⬜ #599 |
| 5 | Bootstrap/survival mode in bot code | Overmind-inspired colony mode: BOOTSTRAP suppresses non-essential work and prioritizes spawn energy | ⬜ #600 |
| 6 | Energy telemetry (#583) | `storedEnergy`, `workerCarriedEnergy`, `harvestedThisTick` in runtime-summary | ⏳ PR #594 (CI green) |
| 7 | Economy change private smoke required | Merge gate: economy/spawn PRs must include private smoke evidence or explicit hold | ⬜ #63 (updated) |
| 8 | P0 survival incident → immediate Discord @ owner | Alert cron + continuation worker: room_dead triggers @ in #decisions, not silent GitHub issue | ⬜ #598 (linked) |
| 9 | Continuation worker: room_dead → immediate self-pause + escalate | scheduler contract: post-deploy health gate FAIL with room_dead = P0 emergency, pause and @ owner | ⬜ #598 (linked) |
| 10 | Runtime alert: room_dead = emergency regardless of hostiles | Tactical response classifier: room_dead severity=critical, emergency=true, never suppressed | ⬜ #598 (linked) |

## Concrete Next Actions

1. **Done**: Merge #583 (energy telemetry) → PR #594 CI green, waiting elapsed window
2. **Done**: Autonomous respawn rule in PR #595
3. **Done**: Issues #598 (spawn-survival test), #599 (auto-rollback), #600 (bootstrap mode) created
4. **Now**: Merge #594 and #595 after elapsed window
5. **This cycle**: Dispatch Codex for #598 (spawn-survival test) — highest-impact single fix
6. **Post-recovery**: Enforce private smoke for economy PRs via #63
7. **Alert fix**: Update tactical-response to classify room_dead as emergency (part of #598 scope)
