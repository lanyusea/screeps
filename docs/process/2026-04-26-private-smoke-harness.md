# Private Smoke Harness

Date: 2026-04-26

## What changed

Added `scripts/screeps-private-smoke-harness.py` as the durable entrypoint for the pinned private-server smoke path.

The harness supports:

- `self-test`: offline checks for templates, pins, command coverage, and secret redaction behavior;
- `prepare`: creation/update of ignored runtime files under `runtime-artifacts/private-server-smoke/`;
- `plan`: exact manual continuation commands for Docker Compose startup, launcher CLI map import, restart/resume, local auth/code upload, spawn placement, and redacted observation capture.

Generated runtime files include `docker-compose.yml`, `config.yml`, `maps/`, `STEAM_KEY.example`, `volumes/`, and a local README/next-steps note. The generated config pins the validated launcher path: `screeps@4.2.21`, `nodeVersion: Erbium`, the known Node 12-compatible transitive package versions, the auth/admin-utils/mongo mods, and `serverConfig.mapFile: /screeps/maps/map-0b6758af.json`.

Follow-up review hardening addressed automated PR feedback by exporting the read `SMOKE_PASSWORD` before the embedded upload helper runs, resolving the uploaded bundle path from an absolute repository path instead of assuming the default runtime directory depth, creating `.smoke-token` with `0600` permissions from the start, adding optional `DEBUG=1` tracebacks for unexpected harness exceptions, and adding function docstrings for review tooling.

## Safety boundaries

- The harness does not start Docker by default.
- `self-test` requires no Docker, no network, and no secrets.
- `prepare` does not write an environment-provided `STEAM_KEY` to disk.
- The harness may report whether a Steam key is present, including safe source paths such as `/root/.secret/.env`, but it must not print the value.
- Runtime config, placeholder files, optional map cache, transient token files, and Docker volumes live under ignored `runtime-artifacts/private-server-smoke/`.
- Production Screeps code under `prod/` was not changed.

## Verification

Ran:

```text
python3 scripts/screeps-private-smoke-harness.py self-test
python3 scripts/screeps-private-smoke-harness.py prepare --no-plan
git check-ignore runtime-artifacts/private-server-smoke/config.yml runtime-artifacts/private-server-smoke/STEAM_KEY.example runtime-artifacts/private-server-smoke/maps/README.md runtime-artifacts/private-server-smoke/volumes/mongo
```

Results:

- harness self-test passed, 37 checks;
- prepare created/updated the expected ignored runtime workspace without starting Docker;
- generated runtime config, placeholder, map note, and volume paths are covered by `.gitignore`;
- local `/root/.secret/.env` Steam-key presence is detected as a safe source path without printing the key;
- no secret values were printed or committed.

Full repository verification for this coding/docs slice is still the standard:

```text
python3 scripts/screeps-private-smoke-harness.py self-test
cd prod && npm run typecheck && npm test -- --runInBand && npm run build
```

Final verification completed:

- `python3 -m py_compile scripts/screeps-private-smoke-harness.py`: passed;
- `python3 scripts/screeps-private-smoke-harness.py self-test`: passed, 37 checks;
- `python3 scripts/screeps-private-smoke-harness.py prepare --no-plan`: passed; reported Steam key present via `/root/.secret/.env` without printing the value;
- `python3 scripts/screeps-private-smoke-harness.py prepare --download-map --no-plan`: passed; cached ignored `map-0b6758af.json`;
- `python3 scripts/screeps-private-smoke-harness.py --runtime-dir runtime-artifacts/private-server-smoke-review prepare --no-plan`: passed; generated only ignored review workspace files;
- `git check-ignore` for generated runtime config, map cache, secret/token placeholders, Docker volumes, and `node_modules`: passed;
- `cd prod && npm run typecheck`: passed;
- `cd prod && npm test -- --runInBand`: passed, 12 suites / 59 tests;
- `cd prod && npm run build`: passed, rebuilt `dist/main.js` at 11.3kb with no tracked diff.

Dependency note: `prod/node_modules` was absent in this worktree. A plain `npm ci` hit a sandbox-sensitive esbuild postinstall `EPERM`; `npm ci --ignore-scripts` installed the locked dependency tree, and the requested typecheck/test/build commands then passed.

## Follow-up

1. Run the harness-generated plan end-to-end from a fresh ignored workspace with local secrets available.
2. Capture `/stats`, user overview, room overview/status, Mongo room-object summaries, and launcher log scans with tokens/passwords redacted.
3. If the end-to-end run remains healthy, promote the harness plan from "manual continuation" toward a narrower live command that can execute selected non-secret steps automatically.
4. Continue the separate runtime-monitor scheduling path only after one more live-token monitor smoke.
