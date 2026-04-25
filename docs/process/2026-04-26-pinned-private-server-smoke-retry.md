# Pinned Private Server Smoke Retry

Date: 2026-04-26T04:48:10+08:00
Status: partial progress; server startup, auth registration, and code upload reached; room/tick bot validation still pending

## Objective

Retry the Dockerized private-server smoke using the previously verified launcher pin `version: 4.2.21` before falling back to a Node.js 22.9+ private-server image/toolchain.

## Preconditions verified

From `prod/`:

- `npm run typecheck`: passed.
- `npm test -- --runInBand`: passed, 12 suites / 45 tests.
- `npm run build`: passed, generated `prod/dist/main.js` at 11.3kb.

Host/local checks:

- Docker Compose v2 was available.
- No running Docker containers were listed before the smoke slice.
- Local secret presence was checked without printing values: `STEAM_KEY` present and `SCREEPS_AUTH_TOKEN` present.
- Safe selectors remained `SCREEPS_BRANCH=main`, `SCREEPS_API_URL=https://screeps.com`, `SCREEPS_SHARD=shardX`, and `SCREEPS_ROOM=E48S28`.

## Smoke work directory

Used an untracked local work directory:

```text
/tmp/screeps-private-smoke-pinned
```

No secret-bearing files were written into the repository. The Steam key was copied only into the untracked smoke directory as `STEAM_KEY` for `steamKeyFile` consumption by the launcher container.

## Config shape tested

The retry used:

```yaml
steamKeyFile: STEAM_KEY
version: 4.2.21
nodeVersion: Erbium
pinnedPackages:
  ssri: 8.0.1
  cacache: 15.3.0
  passport-steam: 1.0.17
  minipass-fetch: 2.1.2
  express-rate-limit: 6.7.0
  body-parser: 1.20.3
  path-to-regexp: 0.1.12
  psl: 1.10.0
mods:
  - screepsmod-mongo
  - screepsmod-auth
  - screepsmod-admin-utils
bots:
  mvpbot: ./bots/mvpbot
localMods: ./mods
serverConfig:
  welcomeText: "Local Screeps MVP pinned smoke server"
  tickRate: 200
  shardName: shardX
  map: random_1x1
```

`prod/dist/main.js` was copied into the local bot package at `bots/mvpbot/main.js`.

## Results

### Passed

- `docker compose create && docker compose start` started Mongo, Redis, and the Screeps launcher container.
- The launcher installed and started `screeps@4.2.21`; the prior `screeps@4.3.0` / Node `12.22.12` engine mismatch did not recur.
- The private server became HTTP-healthy on `127.0.0.1:21025`.
- `GET /api/version` returned `ok: 1`, protocol `14`, shard list containing `shardX`, and feature flags for `screepsmod-mongo`, `screepsmod-auth`, and `screepsmod-admin-utils`.
- `/stats` showed the engine ticking at ~200 ms ticks; observed game times advanced past 1000 ticks during the smoke attempt.
- A local smoke user was registered through `/api/register/submit`.
- Password auth through `/api/auth/signin` succeeded; token value was not printed.
- Uploading the current bundled artifact through `POST /api/user/code` with Basic auth succeeded.
- `GET /api/user/code?branch=default` with token headers verified a round-trip `main` module length of 11591 bytes.

### New issue found and worked around

Including the latest `screepsmod-auth`, `screepsmod-admin-utils`, and `screepsmod-mongo` initially failed dependency installation even with `screeps@4.2.21` because a transitive `body-parser@2.2.2` dependency requires Node `>=18`, while the launcher image runtime is Node `12.22.12`.

Adding Yarn resolution pins for `body-parser: 1.20.3` and `path-to-regexp: 0.1.12` allowed `screeps-launcher apply` to pass and the server to start.

### Still pending / incomplete

- `system.resetAllData()` / `utils.importMap('random_1x1')` through `screeps-launcher cli` did not yield a confirmed map import in this run.
- `/stats` continued to show `totalRooms: 0` and `ownedRooms: 0` after attempted CLI commands, so no owned-room spawn/tick behavior could be validated yet.
- The bot artifact was uploaded successfully, but it did not run in an owned room because no room/spawn existed in the private server state.

## Cleanup

Stopped and removed the smoke containers/network with:

```bash
docker compose down --remove-orphans
```

The untracked local work directory remains available at `/tmp/screeps-private-smoke-pinned` for quick continuation, but it is not a repository artifact and must continue to be treated as secret-bearing local state.

## Next recommendation

Continue private-server-first validation with the now-working install/start/upload baseline:

1. Reuse or recreate the pinned smoke directory with the added `body-parser`/`path-to-regexp` pins.
2. Resolve the map/room initialization path for `screeps@4.2.21` + `screepsmod-admin-utils` (CLI import, direct DB initialization, or another documented private-server room setup path).
3. Place or create an owned room/spawn for the local smoke user.
4. Observe runtime summaries and room behavior for several hundred ticks.
5. If room initialization remains blocked, then fall back to a Node.js 22.9+ image/toolchain for the current `screeps@4.3.0` line.
