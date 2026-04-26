# Goal-oriented PM, percentage roadmap, and 6h reporting

Date: 2026-04-26

## Owner correction

The owner clarified that the Screeps operating model must be goal-oriented project management, not only process scheduling:

1. Every roadmap domain should advance concurrently, with subagents working under main-agent management.
2. Roadmap snapshots must show each domain's next-point completion percentage so progress is visible at a glance.
3. Every 6 hours, a development report must be sent to Discord target `discord:1497587260835758222:1497833662241181746` with:
   - past 6 hours completed;
   - overall roadmap progress explanation;
   - next 6 hours plan.
4. When a roadmap goal is achieved, or the next roadmap goal needs clarification, the main agent should proactively ask the owner rather than silently continuing process work.

## Mechanism changes made

- Created scheduled job `Screeps 6h development report` (`dfcaf65d7ea7`) with schedule `every 360m`, delivery target `discord:1497587260835758222:1497833662241181746`, and a prompt requiring the three owner-requested sections.
- Updated the live roadmap visual reporter prompt (`92ca290f7996`) to require next-point completion percentages on every domain card and to use format version `roadmap-visual-percent-v4`.
- Updated `/root/.hermes/scripts/render-screeps-roadmap.js` so the roadmap image includes percentage bars on all six domain cards.
- Render verification passed: `/tmp/screeps-roadmap-snapshot.png` is a non-empty 1800x1450 PNG.
- Ran six parallel domain-audit subagents in two batches to establish current domain progress and next delegated tasks.

## Six-domain audit baseline

| Domain | Current estimate | Next milestone | Next delegated task |
| --- | ---: | --- | --- |
| Agent OS / visibility | 88% | Scheduler reliability and no-stall visibility | Audit why due cron jobs can show past `next_run_at` while enabled; determine if long workdir-serialized jobs block scheduled reporting. |
| Engineering governance | 75% | Enforceable main branch protection / required checks | Inspect/apply branch protection or rulesets compatible with current CI; document enforced gate. |
| Private-server validation | 85% | Fresh live harness run and redacted report | Run `scripts/screeps-private-smoke.py run` from clean ignored workdir with local secrets, archive redacted report. |
| Runtime Monitor | 85% | Reliable scheduled summary images + no-alert silence | Verify scheduler cadence for runtime summary/alert jobs and fix/report lag source. |
| Bot Capability | 80% | Runtime-driven deterministic hardening | After private smoke report, convert observed runtime failures into Codex-owned tests/fixes. |
| Official MMO | 50% | Release-quality deploy gate evidence | Do not treat temporary MMO link validation as release-quality until private-server gate and monitor evidence are complete. |

## PM operating contract going forward

The main agent owns the roadmap, not only cron/process health. In every active cycle it should:

1. Keep all six roadmap domains represented by an active or queued delegated task.
2. Review subagent outputs and decide whether each domain's percentage changes.
3. Convert results into roadmap updates, 6h reports, and next delegated tasks.
4. Prefer outcome evidence: merged PRs, passing verification, redacted live reports, rendered artifacts, and scheduler-health proof.
5. Escalate to the owner when a domain target is complete and the next target is ambiguous, or when a human-owned decision blocks progress.

## Immediate caveat

The first domain audits found scheduler-health concerns: several jobs appeared enabled with old/past `next_run_at` values. That is now a P0 PM item because it directly affects visibility and concurrent domain progress.
