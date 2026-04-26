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
python3 scripts/screeps-private-smoke.py dry-run
python3 scripts/screeps-private-smoke.py run --dry-run
python3 scripts/screeps-private-smoke.py run
```

Self-test is offline and validates config generation, Docker Compose shape, redaction, request shaping, live required-env checks, and stats criteria.

Live run mode:

- creates/uses an ignored work directory, defaulting to `runtime-artifacts/screeps-private-smoke`, and rejects repo-local workdirs that are not gitignored before writing secret-bearing files;
- writes secret-free `config.yml` using `steamKeyFile: STEAM_KEY`;
- writes Docker Compose with pinned images `screepers/screeps-launcher:v1.16.2`, `mongo:8.2.7`, and `redis:7.4.8`;
- writes the actual Steam key only into the ignored work directory;
- downloads or copies the pinned map file;
- starts the local stack, imports the map, restarts/resumes simulation, registers/signs in a local smoke user, uploads `prod/dist/main.js`, places the spawn, polls `/stats`, and writes a redacted JSON report;
- requires a caller-supplied `SCREEPS_PRIVATE_SMOKE_PASSWORD` when reusing existing server data without reset;
- keeps `/stats` polling alive through transient HTTP failures until the configured deadline;
- requires room-specific Mongo evidence for the configured spawn when spawn placement reports that the smoke user is already playing;
- signs in with the configured smoke email (`cfg.email`) rather than assuming the username and email are identical.

Redaction coverage avoids printing or reporting `STEAM_KEY`, passwords, auth tokens, authorization headers, token headers, and uploaded code contents. Reports use code byte counts and SHA-256 digests instead.

No cron jobs were created.

## Verification

Offline harness verification:

```text
python3 scripts/screeps-private-smoke.py self-test
# passed, 13 tests
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

Review follow-up on PR #12:

```text
cad16f9 fix: pin smoke harness images and signin email
```

This addressed the latest CodeRabbit review by pinning the harness's Docker image references and fixing sign-in payload construction. Controller verification after the follow-up commit passed:

```text
python3 -m py_compile scripts/screeps-private-smoke.py
python3 scripts/screeps-private-smoke.py self-test
# passed, 13 tests
python3 scripts/screeps-private-smoke.py dry-run
# ok: true; redacted request shapes use the configured email
cd prod && npm run typecheck
# passed
cd prod && npm test -- --runInBand
# passed, 12 suites / 68 tests
cd prod && npm run build
# passed
```

Second review-hardening follow-up on PR #12:

```text
2469fb2 fix: harden private smoke harness responses
```

This addressed the remaining open review threads by accepting standard `/api/user/code` success payloads such as `{ "ok": 1 }`, rejecting empty no-reset passwords before live reuse, restricting `SCREEPS_PRIVATE_SMOKE_MAP_URL` to `http`/`https`, carrying non-200 or unusable `/stats` responses into `last_error`, and failing live smoke if authenticated user/room overview probes return non-200 or unusable payloads. Offline harness self-test coverage expanded to 19 tests.

Controller verification after this follow-up commit passed:

```text
python3 -m py_compile scripts/screeps-private-smoke.py
python3 scripts/screeps-private-smoke.py self-test
# passed, 19 tests
python3 scripts/screeps-private-smoke.py dry-run
# ok: true; redacted request shapes remained secret-free
cd prod && npm run typecheck
# passed
cd prod && npm test -- --runInBand
# passed, 12 suites / 68 tests
cd prod && npm run build
# passed
```

Third review-hardening follow-up on PR #12:

```text
d8c9197 fix: capture smoke harness report metadata
```

This addressed the latest CodeRabbit review by ensuring live and dry-run persisted JSON reports include `report_path`, rejecting non-file bot bundle paths before live smoke execution, and carrying non-200 `/api/version` readiness responses into a redacted `last_error` summary. Offline harness self-test coverage expanded to 22 tests.

Controller verification after this follow-up commit passed:

```text
python3 -m py_compile scripts/screeps-private-smoke.py
python3 scripts/screeps-private-smoke.py self-test
# passed, 22 tests
python3 scripts/screeps-private-smoke.py dry-run
# ok: true; redacted report persisted report_path metadata
cd prod && npm run typecheck
# passed
cd prod && npm test -- --runInBand
# passed, 12 suites / 68 tests
cd prod && npm run build
# passed
```

## Follow-up

1. Wait for PR #12 review state to refresh after `d8c9197`; if accepted, merge the harness through the PR gate.
2. Run the harness live from a clean ignored work directory with `STEAM_KEY` present.
3. Attach the redacted live report to the next process note.
4. Wire scheduler/runtime monitor wrappers only after the fresh live harness run confirms the pinned path remains stable.
