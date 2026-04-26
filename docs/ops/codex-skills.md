# Codex Skill Playbook for the Screeps Bot

This document translates the most useful repository skills into prompt-ready patterns for Codex. It does not replace `AGENTS.md`; use both together.

## How to use this with Codex

When launching Codex for this repository, include the relevant skill block in the task prompt and keep the task bounded. Example:

```bash
codex exec --full-auto "$(cat <<'PROMPT'
Read AGENTS.md and docs/ops/codex-skills.md.
Use the TDD implementation skill.
Task: <one narrow production change>.
Run verification from prod/: npm run typecheck, npm test -- --runInBand, npm run build.
Commit the verified change with author lanyusea's bot <lanyusea@gmail.com>.
PROMPT
)"
```

For review-only work, use `codex review` or a review prompt and explicitly say: **only report critical issues**.

## Skill 1 — Screeps TDD implementation

Use for any `prod/` behavior change.

1. Read `AGENTS.md`, the relevant existing tests, and the smallest production modules involved.
2. Add or update a failing Jest test that captures the desired Screeps behavior.
3. Implement the minimum TypeScript change to pass the test.
4. Keep tick-loop work bounded and deterministic; avoid broad rewrites.
5. Run from `prod/`:
   - `npm run typecheck`
   - `npm test -- --runInBand`
   - `npm run build`
6. Inspect `git diff`; make sure generated `prod/dist/main.js` only changed because of `npm run build`.
7. Commit only the intended files.

Best fit examples:

- Spawn/economy recovery logic.
- Worker task assignment and fallback behavior.
- Runtime telemetry fields.
- Memory schema migrations.

## Skill 2 — Screeps systematic debugging

Use when a test, build, private-server smoke, or live-runtime behavior fails.

1. Reproduce the failure with the narrowest command first.
2. Capture the exact failing assertion, stack trace, or runtime symptom.
3. Trace from symptom to state transition: `Game`, `Memory`, creep memory, spawn state, room energy, and task queues.
4. Form one hypothesis at a time; patch the smallest code path.
5. Add a regression test before or alongside the fix when possible.
6. Re-run the failing command, then the full verification trio.
7. Commit the fix and include the reproduced failure in the commit body or PR notes.

Critical Screeps debugging traps:

- Jest can pass while `tsc --noEmit` fails if global `*.d.ts` declarations are missing from `tsconfig` includes.
- Screeps upload needs one bundled `main` module; multi-file TypeScript output is not enough.
- Spawn `ERR_BUSY` / energy starvation can become a colony-death loop if recovery is not explicit.
- Never print tokens while debugging official/private-server API calls.

## Skill 3 — Critical-only PR review

Use for Codex review tasks and for interpreting CodeRabbit/Gemini comments.

Report only issues that are likely to cause:

- runtime crash or halted `loop` execution;
- deployment/build/test/bundle failure;
- unrecoverable Screeps economy/spawn/worker state;
- Memory/task-state incompatibility;
- secret leakage or unsafe API behavior;
- wrong branch/shard/room targeting;
- runtime monitor misses or alert spam with operational impact.

Ignore:

- style, naming, formatting;
- preference-only refactors;
- grammar or docs polish;
- speculative architecture;
- small optimizations without runtime risk.

Output format:

```text
[critical] <file>:<line> — <impact>
Fix: <minimal correction>
```

If nothing is critical, output exactly:

```text
No critical issues found.
```

## Skill 4 — Screeps operations/documentation updates

Use for docs, runbooks, and runtime monitor scripts.

1. Keep docs in their established lanes:
   - `docs/ops/` for runbooks, coordination specs, roadmap.
   - `docs/research/` for factual findings.
   - `docs/process/` for blog-ready reasoning trails and recovery notes.
2. If a decision affects live operation, update durable docs and the active-state/process note together.
3. For runtime images, preserve the warm editorial visual direction; avoid generic dark sci-fi dashboards.
4. For Discord-facing status, prefer compact tables, timelines, or rendered visuals over verbose prose.
5. Keep generated runtime artifacts under ignored/local paths unless they are intentional documentation examples.

## Skill 5 — Worktree and PR hygiene

Use for any repository change.

1. Start from the repository root (e.g., `~/screeps`), fetch refs, and create a worktree branch from `origin/main`.
2. Make changes only inside the worktree.
3. Verify syntax/tests appropriate to the change.
4. Commit with a Conventional Commit message.
5. Push the branch and open a PR.
6. If the change creates or updates a PR, the task remains open until the PR is merged to `main` or explicitly closed as superseded with a PR comment. Continue resolving review comments/discussions on the same PR branch until this is true.
7. Do not merge until project gates are satisfied: at least 15 minutes after PR creation, all review comments/discussions resolved, and CI green once configured.

## Recommended skill-to-task mapping

| Task type | Codex skill block |
| --- | --- |
| New bot behavior under `prod/src` | Screeps TDD implementation |
| Failing test/build/private-server smoke | Screeps systematic debugging |
| PR/diff review | Critical-only PR review |
| Monitoring/runbook/doc update | Screeps operations/documentation updates |
| Any branch/PR workflow | Worktree and PR hygiene |

## Prompt guardrails

Include these clauses in most Codex prompts for this project:

- "Read `AGENTS.md` first."
- "Use `docs/ops/codex-skills.md` skill block `<name>`."
- "Keep the change minimal and task-scoped."
- "Run the project verification commands before finishing."
- "Commit the verified change; do not leave unrelated files staged."
- "For review, only report critical issues; otherwise say `No critical issues found.`"
