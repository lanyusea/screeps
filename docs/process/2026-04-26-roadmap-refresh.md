# Roadmap refresh and subagent reporting rule

Date: 2026-04-26

## Objective

Refresh the current Screeps roadmap state and make explicit that after each subagent completes, the main agent must review, summarize, and report the result or decision items to the appropriate Discord project channel.

## Trigger

The owner requested: refresh the current roadmap information, and each time a subagent completes a task, the main agent should assess whether to summarize and report status or decision items to the corresponding channel.

## Work performed

1. Loaded the Screeps research/planning workflow skill.
2. Listed Discord delivery targets to confirm available project channels.
3. Inspected current active state and recent process docs.
4. Delegated a repository audit to a subagent.
5. Reviewed the subagent result before accepting it.
6. Reported the subagent completion summary to `#task-queue`.
7. Created `docs/ops/roadmap.md` as the durable roadmap counterpart to Discord `#roadmap`.
8. Updated `docs/README.md` to include newer docs and the roadmap.
9. Updated `docs/ops/discord-project-spec.md` to encode the main-agent/subagent completion reporting rule.

## Subagent audit result accepted by main agent

The subagent found:

- repository branch: `main`;
- working tree: clean except a pre-existing untracked `.codex` path observed later by main-agent git status;
- latest relevant commits include deterministic integration hardening docs and production test hardening;
- verification passed:
  - `npm run typecheck`;
  - `npm test -- --runInBand`, 11 suites / 33 tests;
  - `npm run build`;
- private-server smoke remains blocked by local environment: no Docker/Compose and host Node.js below the current official direct-install requirement.

## Roadmap state after refresh

Completed milestones:

1. Discord/docs coordination structure.
2. Phase 1 game/dev-chain research.
3. Phase 2 architecture strategy.
4. MVP production skeleton.
5. MVP economy loop.
6. Deterministic local validation and hardening.
7. Private-server smoke runbook preparation.

Next recommended phases:

1. Finish roadmap/docs synchronization and reporting.
2. Early telemetry/logging MVP through Codex CLI.
3. Private-server smoke execution after Docker/Compose or Node.js 22+ disposable environment is available.
4. Staged MMO deployment after private smoke, unless owner explicitly overrides.

## Reporting rule added

Whenever a subagent finishes, main agent must:

1. review and assess the result before accepting it;
2. decide which project surface changed;
3. report to corresponding channels:
   - `#task-queue` for task status, blockers, done criteria, next tasks;
   - `#dev-log` for implementation/test/build/file/commit details;
   - `#roadmap` for phase/milestone/priority/blocker changes;
   - `#research-notes` for factual findings;
   - `#decisions` for owner decisions or direction-changing tradeoffs;
   - `#runtime-summary` and `#runtime-alerts` once a runtime exists;
4. avoid owner-interrupting messages except for final decision requests;
5. persist complex or long-running context under `docs/process/`.

## Decision items

1. Private-server path: provide Docker/Compose, provide Node.js 22+ disposable environment, or continue deterministic-only validation.
2. Next code priority: recommended spawn lifecycle / worker replacement hardening.
3. MMO deployment gate: recommended to require private-server smoke before live MMO deployment unless explicitly overridden.

## Notes

- This was a documentation/process refresh only; no `prod/` code was edited.
- The untracked `.codex` path should remain excluded from documentation commits unless intentionally needed.
