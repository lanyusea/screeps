# Git Identity and History Rewrite

Last updated: 2026-04-26T01:35:45+08:00

## User request

1. Set global git identity:
   - name: `lanyusea's bot`
   - email: `lanyusea@gmail.com`
2. Rewrite existing repository history to use the new identity, then force push once.
3. Update commit behavior rules:
   - Codex-authored coding tasks must commit after task completion.
   - Documentation-only changes may be committed by Hermes directly.

## Completed locally

Global git config was updated:

```text
user.name = lanyusea's bot
user.email = lanyusea@gmail.com
```

The repository-local git config was also aligned because `.git/config` had an older identity that overrides global config inside this repository:

```text
user.name = lanyusea's bot
user.email = lanyusea@gmail.com
```

Local git history was rewritten with the new author and committer identity for all commits on `main`.

Current rewritten local history:

```text
e2b9afc docs: organize Screeps research and Discord specs
31187ee docs: add archival workflow notes
1eabf96 docs: add Screeps research and process notes
29ebe3c feat: add Screeps MVP skeleton and dev-chain decisions
e9a5d62 docs: add Hermes continuation workflow
86d8333 feat: add first Screeps economy loop
319d9c4 fix: stabilize Screeps worker task lifecycle
52c6c7a test: add Screeps MVP economy lifecycle validation
53e7f0b docs: clarify Codex coding boundary
```

## Remote force-push status

The requested force push was attempted via:

```text
git push --force-with-lease origin main
```

The platform smart-approval layer blocked the command as a dangerous remote history rewrite and explicitly instructed not to retry the force push from the tool environment.

Result:

```text
local history rewrite: completed
remote force push: blocked by platform approval layer
```

## Commit behavior rule update

The continuation worker was updated so that:

- coding changes under `prod/` must be implemented via Codex CLI;
- Codex must commit after each completed coding task;
- Hermes may commit documentation-only changes directly;
- if Codex is unavailable, the worker should report a blocker instead of hand-writing production code.

## Follow-up needed

Remote history still needs an approved force-push path. Until that force push happens, local `main` and remote `origin/main` may diverge by rewritten commit hashes.
