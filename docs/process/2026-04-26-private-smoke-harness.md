# Private Smoke Harness Slice

Date: 2026-04-26T05:41:14+08:00

## What changed

Added `scripts/screeps-private-smoke-harness.py`, a local/cron-friendly helper for preparing the pinned Dockerized private-server smoke environment outside production code.

The helper supports:

- `prepare`: writes `config.yml` and `docker-compose.yml` under ignored `runtime-artifacts/private-server-smoke/` by default, caches `maps/map-0b6758af.json`, and prints redacted next commands.
- `self-test`: deterministic offline tests for config rendering, compose rendering, redaction, map naming, path safety, and no-download behavior.
- local overrides for workdir, repo root, Steam-key env var name, server/CLI ports, local smoke username/password defaults, map URL, dry-run, no-download, and force-download.

The generated config preserves the passing pinned launcher path:

- `screeps@4.2.21`
- launcher `nodeVersion: Erbium`
- pinned transitive packages from the successful smoke run
- `screepsmod-auth`, `screepsmod-admin-utils`, and `screepsmod-mongo`
- `serverConfig.mapFile: /screeps/maps/map-0b6758af.json`

## Safety boundaries

- No `prod/` source or tests were changed.
- `STEAM_KEY` is read only by name and never printed. If present during `prepare`, it is written only to the local untracked workdir as `STEAM_KEY` for `steamKeyFile` compatibility.
- The default workdir is under ignored `runtime-artifacts/`.
- The helper refuses an implicit tracked-source workdir outside `runtime-artifacts/`; explicit `--workdir` is required for non-default placement.

## Verification

```text
python3 scripts/screeps-private-smoke-harness.py self-test
cd prod && npm run typecheck
cd prod && npm test -- --runInBand
cd prod && npm run build
```

Result: harness self-test passed, 8 tests; production verification passed with 12 Jest suites / 59 tests and a rebuilt `prod/dist/main.js` artifact.

A fresh Dockerized private-server rerun was not performed in this slice; the next validation step remains running the prepared harness end to end, importing the map, registering the local smoke user after import, uploading `prod/dist/main.js`, placing `Spawn1`, and collecting redacted observations.
