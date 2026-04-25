# Official MMO Link Validation

Date: 2026-04-26T04:11:53+08:00

## Context

The owner requested a temporary official Screeps: World deployment to validate the external deployment chain and occupy the initial room. This is an explicit exception for link validation only; it does **not** remove the normal private-server-first validation requirement for future release-quality deployments.

## Preconditions checked

- Local public MMO auth token was present; token value was not printed.
- Safe selectors before correction: branch `main`, API URL `https://screeps.com`, room `E48S28`.
- The earlier local shard spelling `sharedX` was rejected by the official API as `invalid shard`.
- Official overview listed `shardX`, and `E48S28` on `shardX` returned status `normal` with no owner before placement.

## Artifact verification

Executed from `prod/` before upload:

- `npm run typecheck`: passed
- `npm test -- --runInBand`: passed, 12 suites / 45 tests
- `npm run build`: passed, generated `prod/dist/main.js`

## Deployment actions

1. Read official code branches through `https://screeps.com/api/user/branches`; existing branches did not include `main`.
2. Created official code branch `main` through `POST /api/user/clone-branch`.
3. Uploaded current `prod/dist/main.js` as module `main` through `POST /api/user/code`.
4. Set branch `main` as `activeWorld` through `POST /api/user/set-active-branch`.
5. Verified `GET /api/user/code?branch=main` and `GET /api/user/code?branch=$activeWorld` both matched the local bundle SHA-256.
6. Placed initial spawn through `POST /api/game/place-spawn`:
   - shard: `shardX`
   - room: `E48S28`
   - spawn name: `Spawn1`
   - position: `(25,23)`

## Post-deployment verification

- `GET /api/user/world-status`: `normal`
- `GET /api/user/overview`: `shardX.rooms` includes `E48S28`
- `GET /api/game/room-overview?room=E48S28&shard=shardX`: owner username `lanyusea`
- `GET /api/user/branches`: `main.activeWorld=true`

## Follow-up

- Local untracked secret selector was corrected to `SCREEPS_SHARD=shardX`.
- Durable docs were updated to distinguish the verified official shard name from the earlier invalid `sharedX` spelling.
- Continue treating private-server smoke validation as required before future release-quality official deployments.
- Next runtime work should monitor whether the uploaded MVP starts producing expected `#runtime-summary ` console output and whether `Spawn1` begins producing workers once ticks run.
