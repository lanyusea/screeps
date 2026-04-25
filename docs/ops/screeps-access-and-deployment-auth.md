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

For private-server validation we expect a Dockerized launcher/private-server path. The current environment already has Docker Engine and Docker Compose available, while direct npm installation is less attractive because the official `screeps` package currently expects Node.js 22+ and this host has Node 18.

Likely private-server inputs:

- Steam Web API key as `STEAM_KEY` or equivalent.
- Local `config.yml` with secrets redacted from commits.
- `screepsmod-auth` for local account/auth behavior.
- Optional MongoDB/Redis-backed persistence depending on smoke-test depth.

## Minimal authorization plan

1. Build/test locally without any Screeps token.
2. Run private-server smoke when local/private-server secrets are available.
3. Add a deploy script that reads token/config from untracked local env only.
4. User creates Screeps auth token in account settings.
5. User installs token into local secret storage, not Discord.
6. We verify deploy with a harmless branch or limited release branch before touching the live active branch.
7. After deployment is stable, document the exact command and keep secrets out of committed files.

## Confirmed public MMO decisions

- Auth token: present in local secret storage; do not paste or commit it.
- Deployment branch: `main`.
- First public room: `E48S28`.
- Shard: user wrote `sharedX`; treat as pending exact shard spelling until verified as `shard0`, `shard1`, `shard2`, `shard3`, or another valid Screeps shard name.

## Open decisions

- Should first public deployment go to a disposable/test branch before active play, or deploy directly to `main` now that `main` is confirmed?
- Whether private-server auth should use username/password, token, or direct local storage injection for the first smoke test.
