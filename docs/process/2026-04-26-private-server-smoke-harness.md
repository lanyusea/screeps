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

## Verification

Commands run from the worktree:

```bash
python3 scripts/screeps-private-smoke.py self-test
python3 scripts/screeps-private-smoke.py plan --work-dir /tmp/screeps-private-smoke-harness-check --repo-root /root/screeps-worktrees/automate-private-smoke-20260426
```

Results:

- `self-test`: passed, 8 checks.
- `plan`: passed; rendered `docker-compose.yml`, `config.yml`, and redacted summary in `/tmp/screeps-private-smoke-harness-check` without starting Docker.

No `prod/` files were changed, so the production TypeScript/Jest/build verification gate was not required for this docs/ops-script-only slice.

## Remaining follow-up

Run the full local smoke once a suitable runtime window is available:

```bash
cd /root/screeps
cd prod && npm run typecheck && npm test -- --runInBand && npm run build
cd /root/screeps
python3 scripts/screeps-private-smoke.py run --work-dir /tmp/screeps-private-smoke-harness
```

If the full run exposes runtime issues, convert the observed failure into deterministic Jest hardening or a harness fix in a new worktree/PR slice.
