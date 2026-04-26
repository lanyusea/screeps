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
- `run` fails fast if `system.resetAllData()`, `utils.importMapFile(...)`, `docker compose restart screeps`, or `system.resumeSimulation()` fails;
- after run-summary initialization, failures still write a redacted `artifacts/summary.json` with status, phase, and bounded command details;
- `down` now propagates a non-zero exit status when Compose cleanup fails.

## Verification

Commands run from the worktree:

```bash
python3 scripts/screeps-private-smoke.py self-test
python3 scripts/screeps-private-smoke.py plan --work-dir /tmp/screeps-private-smoke-harness-check --repo-root /root/screeps-worktrees/automate-private-smoke-20260426
```

Results after review hardening:

- `self-test`: passed, 26 checks.
- `plan`: passed; rendered `docker-compose.yml`, `config.yml`, and redacted summary in `/tmp/screeps-private-smoke-harness-check` without starting Docker.

No `prod/` files changed in the harness hardening itself, but the PR update still reran the production TypeScript/Jest/build gate successfully:

- `cd prod && npm run typecheck`: passed
- `cd prod && npm test -- --runInBand`: passed, 12 suites / 59 tests
- `cd prod && npm run build`: passed

## Remaining follow-up

Run the full local smoke once a suitable runtime window is available:

```bash
cd /root/screeps
cd prod && npm run typecheck && npm test -- --runInBand && npm run build
cd /root/screeps
python3 scripts/screeps-private-smoke.py run --work-dir /tmp/screeps-private-smoke-harness
```

If the full run exposes runtime issues, convert the observed failure into deterministic Jest hardening or a harness fix in a new worktree/PR slice.
