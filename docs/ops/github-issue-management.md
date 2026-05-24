# GitHub Issue and PR Management Contract

All known project problems must be tracked in GitHub Issues instead of local-only notes so they remain visible, searchable, and linkable from fixes.

## Issue requirements

Every problem issue must use this title format:

```text
<优先级>:<roadmap>:<具体问题>
```

Examples:

```text
P0:Phase D:私服 smoke harness clean rerun 未完成
P1:Phase C:runtime-summary 定时投递尚未验证
```

Every issue body must include:

1. **问题描述** — what is wrong, impact, and why it matters to the roadmap/vision.
2. **问题日志** — redacted logs, command output, linked docs, PRs, commits, screenshots, or monitor payloads. Never include secrets.
3. **问题复现方式说明** — exact reproduction steps or, if not yet deterministically reproducible, the observation entry point and expected vs actual behavior.

## Roadmap category labels

Use exactly one roadmap label whenever practical:

- `roadmap:p0-change-control`
- `roadmap:p0-agent-ops`
- `roadmap:phase-a-docs-sync`
- `roadmap:phase-b-spawn-lifecycle`
- `roadmap:phase-c-telemetry`
- `roadmap:phase-d-private-smoke`
- `roadmap:phase-e-mmo-deploy`

Also apply a priority label (`priority:p0`, `priority:p1`, `priority:p2`) and kind label (`kind:bug`, `kind:ops`, `kind:docs`, `kind:test`) where applicable.

## PR requirements

Use acceptance-first issue closure. A PR may use a GitHub closing keyword only when the PR satisfies every original acceptance criterion for that issue at merge time:

```text
Fixes #123
Closes #123
Resolves #123
```

If a PR touches multiple tracked problems, list every issue. Use closing keywords only for the issues that are complete at merge time. For enabling work, post-merge validation, owner-action blockers, live service/process proof, successors, or partial fixes, use non-closing wording such as:

```text
Related to issue 123
```

Do not write negated close-keyword phrases such as `does not close #123`, `not close #123`, `must not close #123`, or `without closing #123`. GitHub can still interpret the keyword plus issue reference as an auto-close instruction. Reword those cases as related/non-closing linkage.

Commit messages must not contain GitHub closing keywords for tracked issues. Commit messages cannot carry the PR `Issue closure gate` evidence, so intentional closure must happen in the PR body with the gate, or not at all.

Any PR body with an intentional closing keyword must include an `Issue closure gate` section. For each closed issue, the section must include a checked line with issue-specific evidence that all original acceptance criteria are satisfied and that no post-merge/runtime/owner-action/successor/partial-fix blocker remains. Any unchecked checkbox line left in that section blocks validation, including the generic no-remaining-blocker line.

The normal project PR gates still apply: worktree branch, no direct `main` edits, at least 15 minutes after PR creation before merge, all discussions resolved, automated review口径 satisfied (CodeRabbit/Gemini no blocking findings; formal GitHub approval is not required), and green required checks once configured. Every active agent PR must be added to Project `screeps` and keep `Status`, `Evidence`, and `Next action` current until it is merged or explicitly closed.

Before any agent reports a task complete, it must update the corresponding GitHub issue/PR/Project item status. At minimum, refresh `Status`, `Evidence`, and `Next action`; if blocked, update `blocked` / `Blocked by`. A task with stale GitHub state is not complete even if the local code/docs/tests are done.
