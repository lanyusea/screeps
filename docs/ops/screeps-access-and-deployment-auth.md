# Screeps Access and Deployment Authorization

Date: 2026-04-26

## Short answer

For the public Screeps: World MMO, the bot does **not** need your Screeps password. It needs an external synchronization auth token created from your Screeps account settings, plus your one-time in-game choices such as shard/room/spawn placement.

For local/private-server testing, the bot may need a Steam Web API key and local private-server credentials/configuration, but those should stay in untracked environment files or local secret storage.

## Public MMO login/deployment model

Official Screeps external deployment uses an auth-token-backed code synchronization flow.

Relevant official docs:

- `https://docs.screeps.com/commit.html`
- `https://screeps.com/a/#!/account/auth-tokens`
- `https://docs.screeps.com/commit.html#Using-direct-API-access`

The documented code API endpoint is:

- `https://screeps.com/api/user/code`

The deploy artifact is the bundled JavaScript module set, normally our generated `prod/dist/main.js` or equivalent.

Current safe deploy procedure: `docs/ops/official-mmo-deploy.md`.

## What the user needs to provide

### Required for public MMO deployment

1. A Screeps account with an active world position.
2. An auth token generated in Screeps account settings.
3. The target branch name, usually `default` or a project-specific branch.
4. The target shard/room decision and initial spawn placement, which may require manual action in the Screeps client.

### Do not provide over Discord

Do **not** paste the auth token, password, Steam key, or other secrets into Discord.

Preferred handoff options:

1. Put secrets in a local untracked file on the worker host, e.g. `.env.screeps.local` or a deployment config ignored by git.
2. Export secrets as environment variables in the execution environment.
3. Use a secrets manager if one is available.

## Suggested environment variables

Current public MMO deployment target confirmed by user:

```bash
SCREEPS_AUTH_TOKEN=***
SCREEPS_BRANCH=main
SCREEPS_API_URL=https://screeps.com
SCREEPS_SHARD=shardX
SCREEPS_ROOM=E46S43
```

For private-server smoke tests:

```bash
STEAM_KEY=...
SCREEPS_PRIVATE_SERVER_URL=http://localhost:21025
SCREEPS_PRIVATE_USERNAME=...
SCREEPS_PRIVATE_PASSWORD=...
```

Exact names can be adjusted to the deploy tool we choose, but the principle is stable: secrets stay outside git and outside Discord.

## Local/private-server authorization model

User decision: local development must validate on a private server first. If private-server debugging passes, deploy the same verified artifact to the official Screeps: World MMO and monitor runtime summaries/alerts.

For private-server validation we expect a Dockerized launcher/private-server path. The current environment already has Docker Engine and Docker Compose available, while direct npm installation is less attractive because the official `screeps` package currently expects Node.js 22+ and this host has Node 18.

Verified local secret state on 2026-04-26:

- `SCREEPS_AUTH_TOKEN`: present, value not printed.
- `STEAM_KEY`: present, value not printed.
- `SCREEPS_BRANCH=main`.
- `SCREEPS_API_URL=https://screeps.com`.
- `SCREEPS_SHARD=shardX`.
- `SCREEPS_ROOM=E46S43`.

Likely private-server inputs:

- Steam Web API key as `STEAM_KEY` or equivalent.
- Local `config.yml` with secrets redacted from commits.
- `screepsmod-auth` for local account/auth behavior.
- Optional MongoDB/Redis-backed persistence depending on smoke-test depth.

## Minimal authorization plan

1. Build/test locally without any Screeps token.
2. Run private-server smoke when local/private-server secrets are available.
3. Use `scripts/screeps_official_deploy.py --dry-run` to verify artifact metadata without reading a token.
4. User creates Screeps auth token in account settings.
5. User installs token into local secret storage or GitHub environment secret `SCREEPS_AUTH_TOKEN`, not Discord.
6. Run the gated live deploy command only with exact confirmation and record the emitted evidence JSON.
7. After deployment, run the runtime monitor and console capture checks from `docs/ops/official-mmo-deploy.md`.

## Confirmed public MMO decisions

- Auth token: present in local secret storage; do not paste or commit it.
- Deployment branch: `main`.
- First public room: `E46S43`.
- Shard: `shardX`, verified against the official API. The earlier `sharedX` spelling is invalid for official API calls.

## Open decisions

- Whether private-server auth should use username/password, token, or direct local storage injection for the first smoke test.

## Temporary official MMO link validation

On 2026-04-26, the owner explicitly approved a temporary official MMO deployment to validate the upload/placement chain and occupy the initial room while preserving the normal private-server-first policy for future release-quality deployments.

Result:

- Created official code branch `main`.
- Uploaded the current bundled `prod/dist/main.js` as module `main`.
- Set `main` as `activeWorld`.
- Placed `Spawn1` in `E46S43` on `shardX` at `(25,23)`.
- Verified world status `normal`, user overview includes `shardX.rooms=[E46S43]`, and room owner is `lanyusea`.
