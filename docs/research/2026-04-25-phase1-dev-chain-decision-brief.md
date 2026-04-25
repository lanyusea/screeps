# Screeps Phase 1 Development Chain Decision Brief

Date: 2026-04-25

## Status

This is the current phase-1 conclusion for the Screeps bot development chain. It consolidates official documentation, community tooling, npm metadata, and local environment checks.

## Executive conclusion

Use a **TypeScript-first source tree**, compile/bundle to a **single Screeps-compatible `main.js` artifact**, validate through **unit tests + deterministic tick integration tests + Dockerized private server smoke tests**, and deploy through an **auth-token-backed external upload path**.

Recommended default stack:

1. **Language:** TypeScript
2. **Runtime artifact:** bundled JavaScript `main.js`
3. **Type definitions:** `@types/screeps`
4. **Bundler/deploy base:** Rollup-style workflow, compatible with `screeps-typescript-starter`
5. **Fast tests:** Jest + `screeps-jest`
6. **Tick integration:** `screeps-server-mockup`
7. **Local private server:** Dockerized `screepers/screeps-launcher`
8. **MMO upload:** Screeps auth token + external commit tool/API

## Official facts verified

### 1. Screeps module model

Official docs confirm Screeps code uses a Node-like module model:

- `require()`
- `module.exports`
- a `main` module exporting the tick loop
- embedded lodash support through `require('lodash')`

Source: https://docs.screeps.com/modules.html

Implication: source can be modular, but the final deployment artifact must map cleanly into Screeps modules. For this project, a single bundled `main.js` is simplest for MVP and deployment reliability.

### 2. External code upload

Official docs for external commits state that an auth token must be created in Screeps account settings for external synchronization.

Officially documented paths:

- `grunt-screeps`
- direct HTTP API access to `https://screeps.com/api/user/code`

The upload payload writes a branch and a `modules` object.

Source: https://docs.screeps.com/commit.html

Important detail: older docs show direct API examples using email/password basic auth, but current community API docs state auth tokens are now the correct path.

### 3. Current token-based API behavior

`node-screeps-api` documents that Screeps uses auth tokens from account settings and user/password auth is obsolete.

Useful API call shape:

```js
api.code.set('default', {
  main: 'module.exports.loop = function(){ ... }'
})
```

Source: https://github.com/screepers/node-screeps-api

Implication: for this project, credentials should not be committed. We should use a local ignored config or environment variables for `SCREEPS_TOKEN`, branch, and target server.

## Language and build-chain decision

### Recommendation: TypeScript over plain JavaScript

Use TypeScript from the start.

Reasons:

- Screeps bots become architecture-heavy quickly: rooms, creeps, memory schema, planners, logistics, combat, market, and multi-shard state.
- `@types/screeps` is available and current npm metadata shows version `3.3.8`.
- `screeps-typescript-starter` is a known community baseline and uses Rollup for compile/upload.
- TypeScript helps protect memory schema and module interfaces during long-term autonomous development.

Plain JavaScript remains useful only for tiny in-game-editor experiments or throwaway snippets.

### Recommended project shape

```text
prod/
  package.json
  tsconfig.json
  rollup.config.js
  src/
    main.ts
    kernel/
    colony/
    creeps/
    memory/
    utils/
  test/
  dist/
    main.js
```

`prod/dist/main.js` should be treated as generated build output, not the primary source of truth.

### Build commands to target

Initial scripts should support:

```bash
npm run typecheck
npm run test
npm run build
npm run deploy:private
npm run deploy:main
```

For safety, public MMO deployment should require explicit target selection and should not run as a side effect of watch mode.

## Local testing and private server decision

### Current environment finding

The local environment currently has:

```text
node v18.19.1
npm 9.2.0
```

Current npm metadata for the official `screeps` package shows:

```json
{
  "version": "4.3.0",
  "engines": {
    "node": ">=22.9.0",
    "npm": ">=10.8.2"
  }
}
```

Implication: avoid direct local installation of the official Screeps server in this environment unless Node is upgraded. Prefer Docker for local private server validation.

### Recommended local validation layers

#### Layer 1: static checks

```bash
npm run typecheck
npm run lint
npm run build
```

#### Layer 2: unit tests with Screeps globals mocked

Use Jest + `screeps-jest`.

Good test targets:

- body generation
- spawn queue priority
- creep role decisions
- memory migration
- target scoring
- simple CPU guard behavior

#### Layer 3: deterministic tick integration

Use `screeps-server-mockup`.

Good test targets:

- after N ticks, first harvester is spawned
- source → spawn/controller energy loop works
- controller upgrade loop progresses
- memory wipe recovery
- basic build/repair target selection

#### Layer 4: Dockerized private server smoke test

Use `screepers/screeps-launcher`, preferably via Docker/Docker Compose.

Manual setup likely needed:

- Steam Web API key: https://steamcommunity.com/dev/apikey
- private server `config.yml`
- `screepsmod-auth` for upload/auth flow
- optionally `screepsmod-admin-utils`
- optionally MongoDB/Redis and `screepsmod-mongo`
- one-time `system.resetAllData()` if using Mongo-backed storage

Source: https://github.com/screepers/screeps-launcher

## Deployment decision

### Private server deployment

Use the same bundled `main.js` artifact and push it to the private server through a token/auth-backed tool.

Private-server requirement: `screepsmod-auth` must be installed and configured for private server code upload workflows.

Source: https://github.com/screepers/screeps-typescript-starter

### Public MMO deployment

Use Screeps account auth token and upload to a named branch.

Initial policy:

- Use a non-critical branch first if possible.
- Deploy only after `typecheck`, tests, build, and local smoke checks pass.
- Do not auto-deploy from every local file change to public MMO.
- Record deploys in `#dev-log` and later runtime observations in `#runtime-summary` / `#runtime-alerts`.

## Human manual configuration checklist

The user will eventually need to provide or perform:

1. Screeps account setup.
2. Screeps auth token creation in account settings.
3. Decision on MMO branch naming, e.g. `default`, `main`, `staging`.
4. Initial public spawn placement / shard choice when moving to MMO.
5. Steam Web API key if running private server through launcher.
6. Private server `config.yml` values.
7. Whether to use Docker Compose with MongoDB/Redis for a more realistic local server.
8. Secrets storage method for deployment credentials.

No secrets should be committed to the repository.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---:|---|
| Local private server differs from MMO | Local pass may still fail live | stage deployment, monitor CPU/errors, limit scope |
| Official server package requires newer Node | local install failure | use Docker or upgrade Node only inside controlled environment |
| Auth token leakage | account/security risk | `.gitignore` local secrets, env vars, no token in docs/logs |
| Rollup/plugin ecosystem age | build friction | keep upload adapter isolated behind npm scripts |
| Mock tests overfit fake globals | false confidence | combine mocks with tick integration and private server smoke tests |
| Watch deploy accidentally pushes bad code | live regression | public deploy must be explicit, not automatic watch |

## Final phase-1 recommendation

Proceed with this default development chain:

```text
TypeScript source
→ typecheck/lint/unit tests
→ Rollup bundle to dist/main.js
→ deterministic tick tests with screeps-server-mockup
→ Dockerized screeps-launcher private server smoke test
→ explicit token-backed deploy to selected Screeps branch
→ Discord runtime summary/alerts once live
```

This gives us a scalable bot codebase without prematurely copying Overmind complexity.

## Sources

- https://docs.screeps.com/modules.html
- https://docs.screeps.com/commit.html
- https://github.com/screepers/node-screeps-api
- https://github.com/screeps/grunt-screeps
- https://github.com/screepers/screeps-typescript-starter
- https://github.com/screepers/screeps-launcher
- https://github.com/screepers/screeps-server-mockup
- https://github.com/eduter/screeps-jest
- https://www.npmjs.com/package/@types/screeps
- https://www.npmjs.com/package/screeps
