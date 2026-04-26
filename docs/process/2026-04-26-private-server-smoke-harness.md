# Private Server Smoke Harness

Date: 2026-04-26T11:01:39+08:00

## Context

The prior pinned Dockerized private-server smoke proved the manual path:

- `screepers/screeps-launcher`
- `screeps@4.2.21`
- launcher `nodeVersion: Erbium`
- pinned `body-parser: 1.20.3` and `path-to-regexp: 0.1.12`
- pre-downloaded `map-0b6758af.json`
- map import through `utils.importMapFile('/screeps/maps/map-0b6758af.json')`
- local smoke user registration, bundled code upload, `Spawn1` placement in `E1S1`, `/stats` polling, and redacted observation capture

This slice turned that path into a committed local harness without changing production bot behavior.

## Implementation

Added:

- `scripts/screeps-private-smoke.py`

The harness supports:

```bash
python3 scripts/screeps-private-smoke.py self-test
python3 scripts/screeps-private-smoke.py run --dry-run
python3 scripts/screeps-private-smoke.py run
```

Self-test is offline and validates config generation, Docker Compose shape, redaction, request shaping, live required-env checks, and stats criteria.

Live run mode:

- creates/uses an ignored work directory, defaulting to `runtime-artifacts/screeps-private-smoke`;
- writes secret-free `config.yml` using `steamKeyFile: STEAM_KEY`;
- writes Docker Compose for launcher, Mongo, and Redis;
- writes the actual Steam key only into the ignored work directory;
- downloads or copies the pinned map file;
- starts the local stack, imports the map, restarts/resumes simulation, registers/signs in a local smoke user, uploads `prod/dist/main.js`, places the spawn, polls `/stats`, and writes a redacted JSON report.

Redaction coverage avoids printing or reporting `STEAM_KEY`, passwords, auth tokens, authorization headers, token headers, and uploaded code contents. Reports use code byte counts and SHA-256 digests instead.

No cron jobs were created.

## Verification

Offline harness verification:

```text
python3 scripts/screeps-private-smoke.py self-test
# passed, 6 tests
```

Dry-run verification:

```text
python3 scripts/screeps-private-smoke.py run --dry-run --work-dir /tmp/screeps-private-smoke-harness-dry-run-2
# ok: true; generated secret-free config/report and redacted request shapes
```

Production verification from the controller session also passed after installing worktree dependencies with `npm ci`:

```text
cd prod && npm run typecheck
# passed
cd prod && npm test -- --runInBand
# passed, 12 suites / 68 tests
cd prod && npm run build
# passed
```

## Follow-up

1. Run the harness live from a clean ignored work directory with `STEAM_KEY` present.
2. Attach the redacted live report to the next process note.
3. Wire scheduler/runtime monitor wrappers only after the fresh live harness run confirms the pinned path remains stable.
