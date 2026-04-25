# Private Server Smoke Attempt

Date: 2026-04-26

## Summary

Attempted the Dockerized `screepers/screeps-launcher` private-server smoke path using an untracked work directory at `/tmp/screeps-private-smoke` and the current bundled bot artifact from `prod/dist/main.js`.

This advanced the private-server milestone from runbook-only preparation to an executable startup attempt, but the smoke did not reach tick/runtime validation. The current blocker is upstream launcher/runtime version drift: the launcher container installs Node.js `12.22.12`, while the latest `screeps@4.3.0` package now requires Node.js `>=22.9.0`.

## Preconditions verified

From `prod/`:

- `npm run typecheck`: passed
- `npm test -- --runInBand`: passed, 12 suites / 44 tests
- `npm run build`: passed, generated `dist/main.js` at 10.9kb

Host Docker preflight:

- Docker Engine server: `29.1.3`
- Docker Compose plugin: `v2.40.3`
- Mongo and Redis service containers started and became healthy during the attempt.

Local secret/config presence was checked without printing secret values:

- `SCREEPS_AUTH_TOKEN`: present
- `STEAM_KEY`: present
- safe selectors: `SCREEPS_BRANCH=main`, `SCREEPS_API_URL=https://screeps.com`, `SCREEPS_SHARD=sharedX`, `SCREEPS_ROOM=E48S28`
- private server URL/username selectors are not yet defined locally.

## Attempted smoke setup

Created untracked files under `/tmp/screeps-private-smoke`:

- `docker-compose.yml` using `screepers/screeps-launcher`, `mongo:8`, and `redis:7`
- `config.yml` with `screepsmod-mongo`, `screepsmod-auth`, `screepsmod-admin-utils`, local welcome text/tick rate, and `/root/screeps/prod/dist` mounted read-only as `/bot`

No secret-bearing files were written into the repository.

## Result

`docker compose up -d` successfully pulled images, created volumes/network, and started Mongo/Redis. The Screeps container entered a restart loop before serving a stable private server.

Relevant redacted/secret-free failure:

```text
error screeps@4.3.0: The engine "node" is incompatible with this module. Expected version ">=22.9.0". Got "12.22.12"
error Found incompatible module.
```

The earlier runbook warning that direct npm install on the host needs Node 22+ also applies to the current launcher image path when it resolves `screeps@latest` to `4.3.0` inside Node 12.

## Cleanup

Stopped and removed the smoke containers/network with:

```bash
docker compose down
```

Named Docker volumes from the attempt may remain available for future cleanup/retry, but no long-running smoke container was left active.

## Next options

1. Research and pin a launcher/server combination compatible with the current Docker image Node version, if an older `screeps` package is acceptable for smoke validation.
2. Build or select a private-server image/toolchain that runs Node.js 22.9+ before installing current `screeps@4.3.0`.
3. If private-server tooling remains blocked, continue bounded deterministic validation under Jest while preserving the policy that official MMO deployment waits for a successful private-server or explicitly approved alternative validation path.
