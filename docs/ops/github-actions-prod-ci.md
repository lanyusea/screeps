# GitHub Actions production CI

Last updated: 2026-04-26T07:44:52+08:00

This repository uses a pull-request-oriented workflow. Production bot changes under `prod/` must be verified before merge with the same local gate used by continuation workers.

## Workflow

- File: `.github/workflows/prod-ci.yml`
- Name: `prod-ci`
- Triggers:
  - pull requests that touch `prod/**` or the workflow itself
  - pushes to `main` that touch `prod/**` or the workflow itself
  - manual `workflow_dispatch`
- Runner: `ubuntu-latest`
- Node.js: `20`
- Dependency install: `npm install --include=dev --no-audit --no-fund` in `prod/`; the workflow uses stable CI tooling for the TypeScript/Jest/bundle gate and verifies the expected dev dependency tree before typechecking. Private-server runtime validation remains a separate Node 22.9+ concern when testing current `screeps` server packages.

## Required checks

The CI job runs the release-quality production gate:

```bash
cd prod
npm run typecheck
npm test -- --runInBand
npm run build
```

The in-band Jest command matches the local autonomous-worker gate and avoids worker-process nondeterminism in CI.

## Branch protection follow-up

After this workflow is merged to `main`, configure branch protection for `main` so PRs cannot merge unless the `Verify prod TypeScript, Jest, and bundle` job passes. GitHub API or `gh` authentication is still required for Hermes to configure this automatically.

## Notes

- The workflow intentionally does not upload `prod/dist/main.js`; deployment remains a separate human-authorized action.
- The workflow does not read Screeps or Steam secrets.
- If future runtime-monitor or private-smoke scripts become required merge gates, add separate jobs rather than overloading the production TypeScript/Jest/build check.
