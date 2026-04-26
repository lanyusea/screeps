# Production CI workflow slice

Date: 2026-04-26
Branch: `chore/add-prod-ci`

## Context

The roadmap now requires repository changes to move through worktrees and pull requests rather than direct commits to `main`. The next missing gate was CI for the production Screeps bot so PRs can be checked consistently before merge.

## Work performed

Added `.github/workflows/prod-ci.yml` with a narrow production verification job:

1. check out the repository;
2. set up Node.js 20 for stable CI tooling;
3. install `prod/` dependencies with `npm install --include=dev --no-audit --no-fund`;
4. verify the expected dev dependency tree;
5. run `npm run typecheck`;
6. run `npm test -- --runInBand`;
7. run `npm run build`.

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
- GitHub Actions first three runs: exposed CI install instability. Node 22/`npm ci` and Node 20/`npm ci` both produced npm's `Exit handler never called`; one run continued with an incomplete dependency tree and typecheck failed. The workflow now uses `npm install --include=dev --no-audit --no-fund` plus an explicit `npm ls` dependency-tree check before typechecking.

## Follow-up

- Push branch `chore/add-prod-ci`.
- Create a PR once GitHub API/CLI auth is available, or manually open the compare URL.
- After the workflow merges to `main`, configure branch protection so `main` requires the production CI job before merge.
