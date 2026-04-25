# Production CI workflow slice

Date: 2026-04-26
Branch: `chore/add-prod-ci`

## Context

The roadmap now requires repository changes to move through worktrees and pull requests rather than direct commits to `main`. The next missing gate was CI for the production Screeps bot so PRs can be checked consistently before merge.

## Work performed

Added `.github/workflows/prod-ci.yml` with a narrow production verification job:

1. check out the repository;
2. set up Node.js 22.9.0;
3. install `prod/` dependencies with `npm ci --no-audit --no-fund`;
4. run `npm run typecheck`;
5. run `npm test -- --runInBand`;
6. run `npm run build`.

Added `docs/ops/github-actions-prod-ci.md` to document the trigger conditions, local equivalent commands, branch-protection follow-up, and non-goals such as deployment or secret access.

Updated:

- `docs/README.md`
- `docs/ops/roadmap.md`
- `docs/process/active-work-state.md`

## Verification

Local verification used the existing production gate from `prod/`:

```bash
npm run typecheck
npm test -- --runInBand
npm run build
```

Results on this slice:

- Typecheck: passed
- Jest: passed, 12 suites / 59 tests
- Build: passed
- GitHub Actions first run: failed in `npm ci` with npm's `Exit handler never called`; workflow follow-up pinned Node to `22.9.0`, removed setup-node npm caching, and uses `npm ci --no-audit --no-fund` before rerunning CI.

## Follow-up

- Push branch `chore/add-prod-ci`.
- Create a PR once GitHub API/CLI auth is available, or manually open the compare URL.
- After the workflow merges to `main`, configure branch protection so `main` requires the production CI job before merge.
