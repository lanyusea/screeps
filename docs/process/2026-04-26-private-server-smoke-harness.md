# Pinned Private Server Smoke Harness Automation

Date: 2026-04-26

## Summary

Added a tracked local automation harness for the pinned Dockerized Screeps private-server smoke path. The script is `scripts/screeps-private-smoke.py` and is designed to make the previously manual `screeps-launcher`/map-import/local-user/code-upload/spawn-placement flow repeatable while keeping secrets out of git and routine cron output.

## Implemented

- `self-test` mode for offline pure-function/rendering/redaction checks.
- `plan` / `--dry-run` mode that renders local harness files in an untracked marked work directory without starting Docker or using secrets.
- `run` mode that can:
  - render Docker Compose and launcher config for `screepers/screeps-launcher`, Mongo, and Redis;
  - pin `screeps@4.2.21`, Node `Erbium`, and the known transitive package versions;
  - download/cache `map-0b6758af.json`;
  - start Docker Compose;
  - wait for `/api/version` readiness;
  - run launcher CLI map import and simulation resume commands;
  - register a local `smoke` user, upload `prod/dist/main.js`, place `Spawn1` in `E1S1`, and poll `/stats`;
  - emit a redacted `artifacts/summary.json`.
- `down` mode to stop the local Compose stack without deleting the work directory.
- Runbook update in `docs/ops/private-server-smoke-test.md` with script usage and safety behavior.

## Review hardening

The PR review follow-up hardened the automation path before merge:

- redaction now catches common secret-key spellings and separators including `steamKey`, `steam_key`, `steam-key`, `X-Token`, `x_token`, `authorization`, `password`, and `token`;
- generated Docker Compose output quotes the host `prod/dist` bind mount path;
- the Docker Compose template now pins `screepers/screeps-launcher:v1.16.2` instead of the mutable `latest` tag;
- Compose command selection verifies `docker compose version` before using the v2 plugin and falls back to legacy `docker-compose` when needed;
- `run` fails fast if `system.resetAllData()`, `utils.importMapFile(...)`, `docker compose restart screeps`, or `system.resumeSimulation()` fails;
- `run` also fails when register/upload/spawn API responses do not report success, or when `/stats` polling never returns a usable runtime sample;
- after run-summary initialization, failures still write a redacted `artifacts/summary.json` with status, phase, and bounded command details;
- `down` now propagates a non-zero exit status when Compose cleanup fails.

## Verification

Commands run from the worktree:

```bash
python3 scripts/screeps-private-smoke.py self-test
python3 scripts/screeps-private-smoke.py plan --work-dir /tmp/screeps-private-smoke-harness-check --repo-root /root/screeps-worktrees/automate-private-smoke-20260426
```

Results after review hardening:

- `self-test`: passed, 36 checks.
- `plan`: passed; rendered `docker-compose.yml`, `config.yml`, and redacted summary in `/tmp/screeps-private-smoke-harness-check` without starting Docker.

No `prod/` files changed in the harness hardening itself, but the PR update still reran the production TypeScript/Jest/build gate successfully:

- `cd prod && npm run typecheck`: passed
- `cd prod && npm test -- --runInBand`: passed, 12 suites / 59 tests
- `cd prod && npm run build`: passed

## 2026-04-26 cron re-verification

A continuation slice rechecked PR #6 after automated review comments arrived:

- Confirmed PR: https://github.com/lanyusea/screeps/pull/6
- Resolved CodeRabbit's duplicate `docs/README.md` process-index entry comment.
- Re-ran harness offline checks from `/root/screeps-worktrees/automate-private-smoke-20260426`:
  - `python3 scripts/screeps-private-smoke.py self-test`: passed, 26 checks.
  - `python3 scripts/screeps-private-smoke.py plan --work-dir /tmp/screeps-private-smoke-harness-cron-verify --repo-root /root/screeps-worktrees/automate-private-smoke-20260426`: passed and rendered redacted local files without starting Docker.
- Re-ran production gate from the same worktree:
  - `cd prod && npm run typecheck`: passed.
  - `cd prod && npm test -- --runInBand`: passed, 12 suites / 59 tests.
  - `cd prod && npm run build`: passed.

## 2026-04-26 reconcile verification

Codex reconciled PR #6 with current `origin/main` state after PR #7 landed, preserving the smoke harness while adding the main-branch worker no-target hardening tests and process notes.

- Addressed current pre-merge feedback by adding targeted docstrings, pinning the launcher image tag, validating API success payloads, requiring at least one usable `/stats` sample, and checking the Docker Compose v2 plugin before falling back to `docker-compose`.
- `python3 scripts/screeps-private-smoke.py self-test`: passed, 36 checks.
- Full production verification is recorded in `docs/process/active-work-state.md` for this reconcile pass.

## Remaining follow-up

Run the full local smoke once a suitable runtime window is available:

```bash
cd /root/screeps
cd prod && npm run typecheck && npm test -- --runInBand && npm run build
cd /root/screeps
python3 scripts/screeps-private-smoke.py run --work-dir /tmp/screeps-private-smoke-harness
```

If the full run exposes runtime issues, convert the observed failure into deterministic Jest hardening or a harness fix in a new worktree/PR slice.
